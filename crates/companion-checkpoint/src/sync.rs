use crate::CheckpointJobPublishBundle;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use companion_config::CheckpointSyncConfig;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest as Sha2Digest, Sha256};
use sha3::Keccak256;

pub const MEMORY_CHECKPOINTS_LATEST_KEY: &str = "memory-checkpoints/latest.json";
const STREAM_DATA_VERSION: u64 = 1;
const REMOTE_ENVELOPE_TYPE: &str = "ghast-kv-encrypted";
const REMOTE_ENVELOPE_VERSION: u64 = 1;
const REMOTE_ENCRYPTION_SCOPE: &str = "memory-sync";
const REMOTE_ENCRYPTION_ALGO: &str = "AES-GCM";
const REMOTE_ENCRYPTION_AAD_VERSION: u64 = 1;
const REMOTE_ENCRYPTION_DERIVED_KDF: &str = "HKDF-SHA256";
const REMOTE_ENCRYPTION_LEGACY_KDF: &str = "SHA-256";
const REMOTE_ENCRYPTION_DERIVED_INFO: &str = "ghast-memory-encryption-v1";
const REMOTE_ENCRYPTION_DERIVED_SALT: &str = "ghast-memory-encryption-salt-v1";
const REMOTE_ENCRYPTION_DOMAIN: &str = "ghast-memory-sync-v1";
const REMOTE_ENCRYPTION_IV_BYTES: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEncryptedKvEnvelope {
    #[serde(rename = "type")]
    pub envelope_type: String,
    pub version: u64,
    pub scope: String,
    pub algorithm: String,
    pub aad_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf: Option<String>,
    pub iv: String,
    pub ciphertext: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCheckpointWrite {
    pub step_id: String,
    pub stage: String,
    pub storage_key: String,
    pub encrypted_payload: String,
    pub encoded_stream_data: Vec<u8>,
    pub tags: Vec<u8>,
    pub normalized_stream_id: String,
}

pub fn build_checkpoint_step_id(stage: &str, storage_key: &str) -> String {
    format!("{}::{}", stage.trim(), storage_key.trim())
}

pub fn normalize_private_key_hex(private_key: &str) -> Result<String> {
    let trimmed = private_key.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Missing private key for memory sync encryption");
    }
    let normalized = if trimmed.starts_with("0x") {
        trimmed.to_string()
    } else {
        format!("0x{trimmed}")
    };
    let hex_body = normalized.trim_start_matches("0x");
    if hex_body.len() != 64 || !hex_body.chars().all(|value| value.is_ascii_hexdigit()) {
        anyhow::bail!("Invalid private key format for memory sync encryption");
    }
    Ok(format!("0x{}", hex_body.to_ascii_lowercase()))
}

pub fn normalize_remote_stream_id(stream_id: &str) -> Result<String> {
    let trimmed = stream_id.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Missing streamId");
    }

    let candidate = trimmed.trim_start_matches("0x");
    if candidate.len() % 2 == 0
        && !candidate.is_empty()
        && candidate.chars().all(|value| value.is_ascii_hexdigit())
    {
        let bytes = hex::decode(candidate)?;
        if bytes.len() == 32 {
            return Ok(format!("0x{}", hex::encode(bytes)));
        }
        if bytes.len() < 32 {
            let mut padded = vec![0_u8; 32 - bytes.len()];
            padded.extend_from_slice(&bytes);
            return Ok(format!("0x{}", hex::encode(padded)));
        }
        anyhow::bail!("streamId too long ({} bytes)", bytes.len());
    }

    if trimmed.starts_with("0x")
        && trimmed.len() == 42
        && trimmed[2..].chars().all(|value| value.is_ascii_hexdigit())
    {
        let address_bytes = hex::decode(&trimmed[2..])?;
        let mut padded = vec![0_u8; 12];
        padded.extend_from_slice(&address_bytes);
        return Ok(format!("0x{}", hex::encode(padded)));
    }

    let mut hasher = Keccak256::new();
    hasher.update(trimmed.as_bytes());
    Ok(format!("0x{}", hex::encode(hasher.finalize())))
}

pub fn build_remote_encryption_aad(stream_id: &str, key: &str) -> Vec<u8> {
    format!(
        "{REMOTE_ENVELOPE_TYPE}|v{REMOTE_ENVELOPE_VERSION}|scope={REMOTE_ENCRYPTION_SCOPE}|aad={REMOTE_ENCRYPTION_AAD_VERSION}|stream={stream_id}|key={key}"
    )
    .into_bytes()
}

pub fn derive_remote_data_key_hkdf(private_key: &str) -> Result<[u8; 32]> {
    let normalized = normalize_private_key_hex(private_key)?;
    let key_bytes = hex::decode(normalized.trim_start_matches("0x"))?;
    let hkdf = Hkdf::<Sha256>::new(Some(REMOTE_ENCRYPTION_DERIVED_SALT.as_bytes()), &key_bytes);
    let mut output = [0_u8; 32];
    hkdf.expand(REMOTE_ENCRYPTION_DERIVED_INFO.as_bytes(), &mut output)
        .map_err(|_| anyhow!("failed to derive remote HKDF key"))?;
    Ok(output)
}

pub fn derive_remote_data_key_legacy(private_key: &str) -> Result<[u8; 32]> {
    let normalized = normalize_private_key_hex(private_key)?;
    let mut digest = Sha256::new();
    digest.update(format!("{REMOTE_ENCRYPTION_DOMAIN}|{normalized}").as_bytes());
    Ok(digest.finalize().into())
}

pub fn encrypt_remote_payload(
    plaintext: &str,
    private_key: &str,
    stream_id: &str,
    key: &str,
    created_at: u64,
    iv_bytes: Option<[u8; REMOTE_ENCRYPTION_IV_BYTES]>,
) -> Result<RemoteEncryptedKvEnvelope> {
    let iv_bytes = iv_bytes.unwrap_or_else(rand::random);
    let cipher = Aes256Gcm::new_from_slice(&derive_remote_data_key_hkdf(private_key)?)
        .map_err(|_| anyhow!("failed to initialize AES-GCM"))?;
    let nonce = Nonce::from_slice(&iv_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: &build_remote_encryption_aad(stream_id, key),
            },
        )
        .map_err(|_| anyhow!("failed to encrypt remote payload"))?;

    Ok(RemoteEncryptedKvEnvelope {
        envelope_type: REMOTE_ENVELOPE_TYPE.to_string(),
        version: REMOTE_ENVELOPE_VERSION,
        scope: REMOTE_ENCRYPTION_SCOPE.to_string(),
        algorithm: REMOTE_ENCRYPTION_ALGO.to_string(),
        aad_version: REMOTE_ENCRYPTION_AAD_VERSION,
        kdf: Some(REMOTE_ENCRYPTION_DERIVED_KDF.to_string()),
        iv: BASE64_STANDARD.encode(iv_bytes),
        ciphertext: BASE64_STANDARD.encode(ciphertext),
        created_at,
    })
}

pub fn decrypt_remote_payload(
    envelope: &RemoteEncryptedKvEnvelope,
    private_key: &str,
    stream_id: &str,
    key: &str,
) -> Result<String> {
    validate_remote_envelope(envelope)?;
    let iv = BASE64_STANDARD
        .decode(&envelope.iv)
        .map_err(|error| anyhow!("invalid encrypted payload iv: {error}"))?;
    let ciphertext = BASE64_STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|error| anyhow!("invalid encrypted payload ciphertext: {error}"))?;
    let nonce = Nonce::from_slice(&iv);
    let aad = build_remote_encryption_aad(stream_id, key);

    let decrypt = |material: [u8; 32]| -> Result<String> {
        let cipher = Aes256Gcm::new_from_slice(&material)
            .map_err(|_| anyhow!("failed to initialize AES-GCM"))?;
        let plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ciphertext.as_ref(),
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow!("failed to decrypt remote payload"))?;
        String::from_utf8(plaintext).map_err(|error| anyhow!(error))
    };

    match envelope.kdf.as_deref() {
        Some(REMOTE_ENCRYPTION_DERIVED_KDF) => decrypt(derive_remote_data_key_hkdf(private_key)?),
        Some(REMOTE_ENCRYPTION_LEGACY_KDF) => decrypt(derive_remote_data_key_legacy(private_key)?),
        Some(other) => anyhow::bail!("unsupported remote payload kdf: {other}"),
        None => decrypt(derive_remote_data_key_hkdf(private_key)?)
            .or_else(|_| decrypt(derive_remote_data_key_legacy(private_key)?)),
    }
}

pub fn encode_single_stream_write(stream_id: &str, key: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
    if key.is_empty() {
        anyhow::bail!("errKeyIsEmpty");
    }
    if key.len() > 0x00ff_ffff {
        anyhow::bail!("errKeyTooLarge");
    }

    let stream_bytes = hex::decode(stream_id.trim_start_matches("0x"))?;
    if stream_bytes.len() != 32 {
        anyhow::bail!("stream id must be exactly 32 bytes");
    }

    let mut encoded = Vec::with_capacity(8 + 4 + 4 + 32 + 3 + key.len() + 8 + payload.len() + 4);
    encoded.extend_from_slice(&STREAM_DATA_VERSION.to_be_bytes());
    encoded.extend_from_slice(&0_u32.to_be_bytes());
    encoded.extend_from_slice(&1_u32.to_be_bytes());
    encoded.extend_from_slice(&stream_bytes);
    encoded.extend_from_slice(&(key.len() as u32).to_be_bytes()[1..]);
    encoded.extend_from_slice(key);
    encoded.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    encoded.extend_from_slice(payload);
    encoded.extend_from_slice(&0_u32.to_be_bytes());
    Ok(encoded)
}

pub fn build_stream_tags(stream_ids: &[String]) -> Result<Vec<u8>> {
    let mut digest = Sha256::new();
    digest.update(b"STREAM");
    let stream_domain = digest.finalize();
    let mut tags = Vec::with_capacity((stream_ids.len() + 1) * 32);
    tags.extend_from_slice(&stream_domain);
    for stream_id in stream_ids {
        let normalized = normalize_remote_stream_id(stream_id)?;
        tags.extend_from_slice(&hex::decode(normalized.trim_start_matches("0x"))?);
    }
    Ok(tags)
}

pub fn prepare_checkpoint_write(
    config: &CheckpointSyncConfig,
    stage: &str,
    storage_key: &str,
    payload: &str,
    created_at: u64,
) -> Result<PreparedCheckpointWrite> {
    let normalized_stream_id = normalize_remote_stream_id(&config.stream_id)?;
    let envelope = encrypt_remote_payload(
        payload,
        &config.private_key,
        &normalized_stream_id,
        storage_key,
        created_at,
        None,
    )?;
    let encrypted_payload = serde_json::to_string(&envelope)
        .map_err(|error| anyhow!("failed to encode envelope: {error}"))?;
    let encoded_stream_data = encode_single_stream_write(
        &normalized_stream_id,
        storage_key.as_bytes(),
        encrypted_payload.as_bytes(),
    )?;
    let tags = build_stream_tags(&[normalized_stream_id.clone()])?;

    Ok(PreparedCheckpointWrite {
        step_id: build_checkpoint_step_id(stage, storage_key),
        stage: stage.trim().to_string(),
        storage_key: storage_key.trim().to_string(),
        encrypted_payload,
        encoded_stream_data,
        tags,
        normalized_stream_id,
    })
}

pub fn build_checkpoint_write_plan(
    config: &CheckpointSyncConfig,
    bundle: &CheckpointJobPublishBundle,
) -> Result<Vec<PreparedCheckpointWrite>> {
    let mut writes = Vec::new();
    let presealed_keys = bundle
        .local_ack_plan
        .remote_storage_keys
        .iter()
        .map(|value| value.trim().to_string())
        .collect::<std::collections::HashSet<_>>();

    let artifacts = bundle
        .manifest
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    for artifact in artifacts {
        let required = artifact
            .get("required")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !required {
            continue;
        }
        let storage_key = artifact
            .get("storageKey")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("checkpoint manifest artifact is missing storageKey"))?;
        let payload = bundle.artifact_payloads.get(storage_key);
        if payload.is_none() && presealed_keys.contains(storage_key) {
            continue;
        }
        let payload = payload.ok_or_else(|| anyhow!("missing_checkpoint_payload:{storage_key}"))?;
        writes.push(prepare_checkpoint_write(
            config,
            "publish_artifacts",
            storage_key,
            payload,
            bundle.committed_at,
        )?);
    }

    let history_key = bundle
        .history
        .get("lastHistoryKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("checkpoint history is missing lastHistoryKey"))?;
    writes.push(prepare_checkpoint_write(
        config,
        "write_history",
        history_key,
        &bundle.history_payload,
        bundle.committed_at,
    )?);

    let manifest_key = bundle
        .latest_pointer
        .get("manifestKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("checkpoint latestPointer is missing manifestKey"))?;
    writes.push(prepare_checkpoint_write(
        config,
        "write_manifest",
        manifest_key,
        &bundle.manifest_payload,
        bundle.committed_at,
    )?);

    writes.push(prepare_checkpoint_write(
        config,
        "write_latest_pointer",
        MEMORY_CHECKPOINTS_LATEST_KEY,
        &bundle.latest_pointer_payload,
        bundle.committed_at,
    )?);

    Ok(writes)
}

fn validate_remote_envelope(envelope: &RemoteEncryptedKvEnvelope) -> Result<()> {
    if envelope.envelope_type != REMOTE_ENVELOPE_TYPE
        || envelope.version != REMOTE_ENVELOPE_VERSION
        || envelope.scope != REMOTE_ENCRYPTION_SCOPE
        || envelope.algorithm != REMOTE_ENCRYPTION_ALGO
        || envelope.aad_version != REMOTE_ENCRYPTION_AAD_VERSION
    {
        anyhow::bail!("invalid remote encrypted payload envelope");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CheckpointJobLocalAckPlan;
    use serde_json::json;
    use std::collections::BTreeMap;

    const TEST_PRIVATE_KEY: &str =
        "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1";

    fn test_sync_config() -> CheckpointSyncConfig {
        CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: TEST_PRIVATE_KEY.to_string(),
            kv_rpc: Some("https://kv-rpc-galileo.0g.ai".to_string()),
        }
    }

    fn make_bundle() -> CheckpointJobPublishBundle {
        let generation = "2026-03-12T08-00-00.000Z";
        let committed_at = 1_773_312_000_000_u64;
        let artifact_storage_key =
            format!("memory-checkpoints/generations/{generation}/artifacts/context-nodes.json");
        CheckpointJobPublishBundle {
            generation: generation.to_string(),
            committed_at,
            coverage_day: "2026-03-12".to_string(),
            latest_pointer: json!({
                "version": 1,
                "generation": generation,
                "committedAt": committed_at,
                "manifestKey": format!("memory-checkpoints/generations/{generation}/manifest.json"),
            }),
            latest_pointer_payload: "{}".to_string(),
            history: json!({
                "version": 1,
                "generation": generation,
                "lastHistoryKey": format!("memory-checkpoints/generations/{generation}/history.json"),
            }),
            history_payload: "{\"history\":true}".to_string(),
            manifest: json!({
                "version": 1,
                "generation": generation,
                "latestPointerKey": MEMORY_CHECKPOINTS_LATEST_KEY,
                "artifacts": [
                    {
                        "storageKey": artifact_storage_key,
                        "required": true,
                    },
                    {
                        "storageKey": format!("session-archives/{generation}/messages.jsonl"),
                        "required": true,
                    },
                    {
                        "storageKey": format!("memory-checkpoints/generations/{generation}/artifacts/optional.json"),
                        "required": false,
                    }
                ],
            }),
            manifest_payload: "{\"manifest\":true}".to_string(),
            artifact_payloads: BTreeMap::from([(
                artifact_storage_key,
                "{\"nodes\":true}".to_string(),
            )]),
            local_ack_plan: CheckpointJobLocalAckPlan {
                remote_storage_keys: vec![format!("session-archives/{generation}/messages.jsonl")],
                generation: generation.to_string(),
                committed_at,
            },
        }
    }

    fn parse_single_write(encoded: &[u8]) -> (u64, u32, u32, Vec<u8>, Vec<u8>, u64, Vec<u8>, u32) {
        let version = u64::from_be_bytes(encoded[0..8].try_into().unwrap());
        let reads = u32::from_be_bytes(encoded[8..12].try_into().unwrap());
        let writes = u32::from_be_bytes(encoded[12..16].try_into().unwrap());
        let stream_id = encoded[16..48].to_vec();
        let key_len = u32::from_be_bytes([0, encoded[48], encoded[49], encoded[50]]) as usize;
        let key_start = 51;
        let key_end = key_start + key_len;
        let key = encoded[key_start..key_end].to_vec();
        let value_len = u64::from_be_bytes(encoded[key_end..key_end + 8].try_into().unwrap());
        let value_start = key_end + 8;
        let value_end = value_start + value_len as usize;
        let value = encoded[value_start..value_end].to_vec();
        let controls = u32::from_be_bytes(encoded[value_end..value_end + 4].try_into().unwrap());
        (
            version, reads, writes, stream_id, key, value_len, value, controls,
        )
    }

    #[test]
    fn normalize_remote_stream_id_handles_hex_address_and_text() {
        assert_eq!(
            normalize_remote_stream_id("0x1234").unwrap(),
            "0x0000000000000000000000000000000000000000000000000000000000001234"
        );
        assert_eq!(
            normalize_remote_stream_id("0x1111111111111111111111111111111111111111").unwrap(),
            "0x0000000000000000000000001111111111111111111111111111111111111111"
        );
        assert_eq!(
            normalize_remote_stream_id("stream-a").unwrap(),
            "0xcc1b51e350f3a9ab0bf37adbbab7b84fe5eea8629aaa0f2fc6464391e67a91e2"
        );
    }

    #[test]
    fn encrypt_remote_payload_round_trips() {
        let stream_id = normalize_remote_stream_id("stream-a").unwrap();
        let envelope = encrypt_remote_payload(
            "remote success value",
            TEST_PRIVATE_KEY,
            &stream_id,
            "user.md",
            1_700_000_000_000,
            Some([7_u8; REMOTE_ENCRYPTION_IV_BYTES]),
        )
        .unwrap();
        let decrypted =
            decrypt_remote_payload(&envelope, TEST_PRIVATE_KEY, &stream_id, "user.md").unwrap();
        assert_eq!(decrypted, "remote success value");
        assert_eq!(envelope.kdf.as_deref(), Some(REMOTE_ENCRYPTION_DERIVED_KDF));
    }

    #[test]
    fn decrypt_remote_payload_supports_legacy_kdf() {
        let stream_id = normalize_remote_stream_id("stream-a").unwrap();
        let iv = [3_u8; REMOTE_ENCRYPTION_IV_BYTES];
        let cipher =
            Aes256Gcm::new_from_slice(&derive_remote_data_key_legacy(TEST_PRIVATE_KEY).unwrap())
                .unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: b"legacy payload",
                    aad: &build_remote_encryption_aad(&stream_id, "legacy.md"),
                },
            )
            .unwrap();
        let envelope = RemoteEncryptedKvEnvelope {
            envelope_type: REMOTE_ENVELOPE_TYPE.to_string(),
            version: REMOTE_ENVELOPE_VERSION,
            scope: REMOTE_ENCRYPTION_SCOPE.to_string(),
            algorithm: REMOTE_ENCRYPTION_ALGO.to_string(),
            aad_version: REMOTE_ENCRYPTION_AAD_VERSION,
            kdf: Some(REMOTE_ENCRYPTION_LEGACY_KDF.to_string()),
            iv: BASE64_STANDARD.encode(iv),
            ciphertext: BASE64_STANDARD.encode(ciphertext),
            created_at: 1_700_000_000_000,
        };
        let decrypted =
            decrypt_remote_payload(&envelope, TEST_PRIVATE_KEY, &stream_id, "legacy.md").unwrap();
        assert_eq!(decrypted, "legacy payload");
    }

    #[test]
    fn encode_single_stream_write_matches_expected_layout() {
        let stream_id = normalize_remote_stream_id("stream-b").unwrap();
        let encoded = encode_single_stream_write(&stream_id, b"user.md", b"payload-json").unwrap();
        let (version, reads, writes, parsed_stream_id, key, value_len, value, controls) =
            parse_single_write(&encoded);
        assert_eq!(version, STREAM_DATA_VERSION);
        assert_eq!(reads, 0);
        assert_eq!(writes, 1);
        assert_eq!(controls, 0);
        assert_eq!(format!("0x{}", hex::encode(parsed_stream_id)), stream_id);
        assert_eq!(key, b"user.md");
        assert_eq!(value_len, 12);
        assert_eq!(value, b"payload-json");
    }

    #[test]
    fn build_checkpoint_write_plan_orders_required_writes() {
        let bundle = make_bundle();
        let writes = build_checkpoint_write_plan(&test_sync_config(), &bundle).unwrap();
        let steps = writes
            .iter()
            .map(|entry| {
                (
                    entry.step_id.as_str(),
                    entry.stage.as_str(),
                    entry.storage_key.as_str(),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(steps.len(), 4);
        assert_eq!(
            steps[0].0,
            build_checkpoint_step_id("publish_artifacts", steps[0].2)
        );
        assert_eq!(steps[0].1, "publish_artifacts");
        assert!(steps[0].2.contains("/artifacts/context-nodes.json"));
        assert_eq!(
            steps[1].0,
            build_checkpoint_step_id("write_history", steps[1].2)
        );
        assert_eq!(steps[1].1, "write_history");
        assert!(steps[1].2.ends_with("/history.json"));
        assert_eq!(
            steps[2].0,
            build_checkpoint_step_id("write_manifest", steps[2].2)
        );
        assert_eq!(steps[2].1, "write_manifest");
        assert!(steps[2].2.ends_with("/manifest.json"));
        assert_eq!(
            steps[3],
            (
                build_checkpoint_step_id("write_latest_pointer", MEMORY_CHECKPOINTS_LATEST_KEY)
                    .as_str(),
                "write_latest_pointer",
                MEMORY_CHECKPOINTS_LATEST_KEY,
            )
        );
    }
}
