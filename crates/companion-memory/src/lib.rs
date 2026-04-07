use anyhow::{anyhow, Context, Result};
use companion_config::get_config_dir;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

const MEMORY_CHECKPOINTS_LATEST_KEY: &str = "memory-checkpoints/latest.json";
const SHADOW_AUTHORITY: &str = "extension_primary";
const SHADOW_VERSION: u64 = 1;
const SHADOW_REFRESH_PUBLISH_SOURCE: &str = "shadow_refresh";
const DEFAULT_REFRESH_SLA_HOURS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowVerificationMeta {
    pub state: String,
    pub verified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowFreshnessMeta {
    pub state: String,
    pub shadowed_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEnvelope {
    pub version: u64,
    pub authority: String,
    pub generation: String,
    pub previous_generation: Option<String>,
    pub committed_at: u64,
    pub latest_pointer: Value,
    pub latest_pointer_payload: String,
    pub history: Value,
    pub history_payload: String,
    pub manifest: Value,
    pub manifest_payload: String,
    pub artifact_payloads: BTreeMap<String, String>,
    pub verification: ShadowVerificationMeta,
    pub freshness: ShadowFreshnessMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowStatus {
    pub version: u64,
    pub authority: String,
    pub mirrored_generation: Option<String>,
    pub mirrored_committed_at: Option<u64>,
    pub verification: ShadowVerificationMeta,
    pub freshness: ShadowFreshnessMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowRefreshState {
    pub available: bool,
    pub state: String,
    pub freshness_owner: String,
    pub freshness_sla_hours: u64,
    pub last_attempt_at: Option<u64>,
    pub last_outcome: Option<String>,
    pub last_error: Option<String>,
    pub last_source_generation: Option<String>,
    pub last_source_committed_at: Option<u64>,
    pub last_published_generation: Option<String>,
    pub last_published_at: Option<u64>,
    pub last_publish_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShadowRefreshResult {
    pub published: bool,
    pub reason: Option<String>,
    pub publish_source: Option<String>,
    pub state: ShadowRefreshState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ShadowStoreSnapshot {
    envelope: Option<ShadowEnvelope>,
    shadowed_at: Option<u64>,
}

#[derive(Debug, Default)]
struct ShadowStoreInner {
    loaded: bool,
    snapshot: ShadowStoreSnapshot,
}

#[derive(Debug, Clone)]
pub struct ShadowStore {
    inner: Arc<Mutex<ShadowStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RefreshStoreSnapshot {
    state: Option<String>,
    freshness_owner: Option<String>,
    last_attempt_at: Option<u64>,
    last_outcome: Option<String>,
    last_error: Option<String>,
    last_source_generation: Option<String>,
    last_source_committed_at: Option<u64>,
    last_published_generation: Option<String>,
    last_published_at: Option<u64>,
    last_publish_source: Option<String>,
}

#[derive(Debug, Default)]
struct RefreshStoreInner {
    loaded: bool,
    snapshot: RefreshStoreSnapshot,
}

#[derive(Debug, Clone)]
pub struct ShadowRefreshManager {
    inner: Arc<Mutex<RefreshStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
    available: bool,
    freshness_sla_hours: u64,
}

impl ShadowStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(ShadowStoreInner::default())),
            primary_path: config_dir.join("memory-shadow.json"),
            backup_path: config_dir.join("memory-shadow.json.bak"),
        }
    }

    pub fn ingest_value(&self, input: Value, shadowed_at: Option<u64>) -> Result<ShadowStatus> {
        let envelope = validate_shadow_contract_value(input)?;
        let shadowed_at = shadowed_at
            .filter(|value| *value > 0)
            .unwrap_or_else(now_millis);
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = ShadowStoreSnapshot {
            envelope: Some(envelope.clone()),
            shadowed_at: Some(shadowed_at),
        };
        persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(status_from_snapshot(&inner.snapshot))
    }

    pub fn get_envelope(&self) -> Result<Option<ShadowEnvelope>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner.snapshot.envelope.clone())
    }

    pub fn get_status(&self) -> Result<ShadowStatus> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(status_from_snapshot(&inner.snapshot))
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = ShadowStoreSnapshot::default();
        persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut ShadowStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_json(&self.primary_path, &self.backup_path)?;
        inner.loaded = true;
        Ok(())
    }
}

impl ShadowRefreshManager {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        Self::new_unavailable_in(config_dir, DEFAULT_REFRESH_SLA_HOURS)
    }

    pub fn new_unavailable_in<P: Into<PathBuf>>(config_dir: P, freshness_sla_hours: u64) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(RefreshStoreInner::default())),
            primary_path: config_dir.join("memory-shadow-refresh.json"),
            backup_path: config_dir.join("memory-shadow-refresh.json.bak"),
            available: false,
            freshness_sla_hours,
        }
    }

    pub fn get_state(&self, envelope: Option<&ShadowEnvelope>) -> Result<ShadowRefreshState> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(derive_refresh_state(
            envelope,
            &inner.snapshot,
            self.available,
            now_millis(),
            self.freshness_sla_hours,
        ))
    }

    pub fn refresh(
        &self,
        envelope: Option<&ShadowEnvelope>,
        force: bool,
    ) -> Result<ShadowRefreshResult> {
        let attempt_at = now_millis();
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let current_state = derive_refresh_state(
            envelope,
            &inner.snapshot,
            self.available,
            attempt_at,
            self.freshness_sla_hours,
        );

        if envelope.is_none() {
            patch_refresh_snapshot(
                &mut inner.snapshot,
                json!({
                    "state": "empty",
                    "freshnessOwner": "none",
                    "lastAttemptAt": attempt_at,
                    "lastOutcome": "skipped",
                    "lastError": Value::Null,
                    "lastSourceGeneration": Value::Null,
                    "lastSourceCommittedAt": Value::Null,
                }),
            );
            persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)?;
            return Ok(ShadowRefreshResult {
                published: false,
                reason: Some("no_shadow_checkpoint".to_string()),
                publish_source: None,
                state: derive_refresh_state(
                    None,
                    &inner.snapshot,
                    self.available,
                    attempt_at,
                    self.freshness_sla_hours,
                ),
            });
        }

        let envelope = envelope.unwrap();
        if !force && current_state.state == "shadow_refresh_fresh" {
            patch_refresh_snapshot(
                &mut inner.snapshot,
                json!({
                    "lastAttemptAt": attempt_at,
                    "lastOutcome": "skipped",
                    "lastError": Value::Null,
                }),
            );
            persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)?;
            return Ok(ShadowRefreshResult {
                published: false,
                reason: Some("shadow_refresh_fresh".to_string()),
                publish_source: None,
                state: derive_refresh_state(
                    Some(envelope),
                    &inner.snapshot,
                    self.available,
                    attempt_at,
                    self.freshness_sla_hours,
                ),
            });
        }

        if !force && current_state.state == "primary_fresh" {
            patch_refresh_snapshot(
                &mut inner.snapshot,
                json!({
                    "lastAttemptAt": attempt_at,
                    "lastOutcome": "skipped",
                    "lastError": Value::Null,
                    "lastSourceGeneration": envelope.generation,
                    "lastSourceCommittedAt": envelope.committed_at,
                }),
            );
            persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)?;
            return Ok(ShadowRefreshResult {
                published: false,
                reason: Some("primary_fresh".to_string()),
                publish_source: None,
                state: derive_refresh_state(
                    Some(envelope),
                    &inner.snapshot,
                    self.available,
                    attempt_at,
                    self.freshness_sla_hours,
                ),
            });
        }

        patch_refresh_snapshot(
            &mut inner.snapshot,
            json!({
                "state": "publisher_unavailable",
                "freshnessOwner": "none",
                "lastAttemptAt": attempt_at,
                "lastOutcome": "failed",
                "lastError": "shadow_refresh_publisher_unavailable",
                "lastSourceGeneration": envelope.generation,
                "lastSourceCommittedAt": envelope.committed_at,
            }),
        );
        persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(ShadowRefreshResult {
            published: false,
            reason: Some("publisher_unavailable".to_string()),
            publish_source: None,
            state: derive_refresh_state(
                Some(envelope),
                &inner.snapshot,
                self.available,
                attempt_at,
                self.freshness_sla_hours,
            ),
        })
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = RefreshStoreSnapshot::default();
        persist_json(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut RefreshStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_json(&self.primary_path, &self.backup_path)?;
        inner.loaded = true;
        Ok(())
    }
}

fn status_from_snapshot(snapshot: &ShadowStoreSnapshot) -> ShadowStatus {
    let Some(envelope) = snapshot.envelope.as_ref() else {
        return empty_shadow_status();
    };
    ShadowStatus {
        version: SHADOW_VERSION,
        authority: SHADOW_AUTHORITY.to_string(),
        mirrored_generation: Some(envelope.generation.clone()),
        mirrored_committed_at: Some(envelope.committed_at),
        verification: envelope.verification.clone(),
        freshness: ShadowFreshnessMeta {
            state: if snapshot.shadowed_at.is_some() {
                "fresh".to_string()
            } else {
                envelope.freshness.state.clone()
            },
            shadowed_at: snapshot.shadowed_at.or(envelope.freshness.shadowed_at),
        },
    }
}

fn empty_shadow_status() -> ShadowStatus {
    ShadowStatus {
        version: SHADOW_VERSION,
        authority: SHADOW_AUTHORITY.to_string(),
        mirrored_generation: None,
        mirrored_committed_at: None,
        verification: ShadowVerificationMeta {
            state: "unknown".to_string(),
            verified_at: None,
        },
        freshness: ShadowFreshnessMeta {
            state: "unknown".to_string(),
            shadowed_at: None,
        },
    }
}

fn derive_refresh_state(
    envelope: Option<&ShadowEnvelope>,
    snapshot: &RefreshStoreSnapshot,
    available: bool,
    now_ts: u64,
    freshness_sla_hours: u64,
) -> ShadowRefreshState {
    let base = ShadowRefreshState {
        available,
        state: "empty".to_string(),
        freshness_owner: "none".to_string(),
        freshness_sla_hours,
        last_attempt_at: snapshot.last_attempt_at,
        last_outcome: snapshot.last_outcome.clone(),
        last_error: snapshot.last_error.clone(),
        last_source_generation: snapshot.last_source_generation.clone(),
        last_source_committed_at: snapshot.last_source_committed_at,
        last_published_generation: snapshot.last_published_generation.clone(),
        last_published_at: snapshot.last_published_at,
        last_publish_source: snapshot.last_publish_source.clone(),
    };

    let Some(envelope) = envelope else {
        return base;
    };

    if is_shadow_refresh_fresh(snapshot, envelope, now_ts, freshness_sla_hours) {
        return ShadowRefreshState {
            state: "shadow_refresh_fresh".to_string(),
            freshness_owner: SHADOW_REFRESH_PUBLISH_SOURCE.to_string(),
            ..base
        };
    }

    if is_primary_fresh(envelope, now_ts, freshness_sla_hours) {
        return ShadowRefreshState {
            state: "primary_fresh".to_string(),
            freshness_owner: SHADOW_AUTHORITY.to_string(),
            ..base
        };
    }

    if !available {
        return ShadowRefreshState {
            state: "publisher_unavailable".to_string(),
            freshness_owner: "none".to_string(),
            ..base
        };
    }

    if snapshot.last_outcome.as_deref() == Some("failed")
        && snapshot.last_source_generation.as_deref() == Some(envelope.generation.as_str())
    {
        return ShadowRefreshState {
            state: "failed".to_string(),
            freshness_owner: "none".to_string(),
            ..base
        };
    }

    ShadowRefreshState {
        state: "stale".to_string(),
        freshness_owner: "none".to_string(),
        ..base
    }
}

fn is_shadow_refresh_fresh(
    snapshot: &RefreshStoreSnapshot,
    envelope: &ShadowEnvelope,
    now_ts: u64,
    freshness_sla_hours: u64,
) -> bool {
    let Some(last_published_at) = snapshot.last_published_at else {
        return false;
    };
    if snapshot.last_publish_source.as_deref() != Some(SHADOW_REFRESH_PUBLISH_SOURCE) {
        return false;
    }
    if snapshot.last_source_generation.as_deref() != Some(envelope.generation.as_str()) {
        return false;
    }
    now_ts.saturating_sub(last_published_at) < freshness_sla_hours * 60 * 60 * 1000
}

fn is_primary_fresh(envelope: &ShadowEnvelope, now_ts: u64, freshness_sla_hours: u64) -> bool {
    now_ts.saturating_sub(envelope.committed_at) < freshness_sla_hours * 60 * 60 * 1000
}

fn patch_refresh_snapshot(snapshot: &mut RefreshStoreSnapshot, patch: Value) {
    let record = patch.as_object().cloned().unwrap_or_default();
    for (key, value) in record {
        match key.as_str() {
            "state" => snapshot.state = value.as_str().map(ToString::to_string),
            "freshnessOwner" => snapshot.freshness_owner = value.as_str().map(ToString::to_string),
            "lastAttemptAt" => snapshot.last_attempt_at = value_as_u64_or_null(&value),
            "lastOutcome" => snapshot.last_outcome = value.as_str().map(ToString::to_string),
            "lastError" => snapshot.last_error = value.as_str().map(ToString::to_string),
            "lastSourceGeneration" => {
                snapshot.last_source_generation = value.as_str().map(ToString::to_string)
            }
            "lastSourceCommittedAt" => {
                snapshot.last_source_committed_at = value_as_u64_or_null(&value)
            }
            "lastPublishedGeneration" => {
                snapshot.last_published_generation = value.as_str().map(ToString::to_string)
            }
            "lastPublishedAt" => snapshot.last_published_at = value_as_u64_or_null(&value),
            "lastPublishSource" => {
                snapshot.last_publish_source = value.as_str().map(ToString::to_string)
            }
            _ => {}
        }
    }
}

fn value_as_u64_or_null(value: &Value) -> Option<u64> {
    if value.is_null() {
        None
    } else {
        as_timestamp(value, "value").ok()
    }
}

fn load_json<T>(primary_path: &Path, backup_path: &Path) -> Result<T>
where
    T: for<'de> Deserialize<'de> + Default,
{
    match read_json::<T>(primary_path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => Ok(read_json::<T>(backup_path)?.unwrap_or_default()),
        Err(primary_error) => match read_json::<T>(backup_path) {
            Ok(Some(snapshot)) => Ok(snapshot),
            Ok(None) => Ok(T::default()),
            Err(_) => {
                eprintln!(
                    "Failed to read snapshot ({}); starting fresh.",
                    primary_error
                );
                Ok(T::default())
            }
        },
    }
}

fn read_json<T>(path: &Path) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read snapshot: {}", path.display()))?;
    let parsed = serde_json::from_str::<T>(&raw)
        .with_context(|| format!("Failed to parse snapshot: {}", path.display()))?;
    Ok(Some(parsed))
}

fn persist_json<T>(primary_path: &Path, backup_path: &Path, snapshot: &T) -> Result<()>
where
    T: Serialize,
{
    if let Some(parent) = primary_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create snapshot dir: {}", parent.display()))?;
    }
    let temp_dir = primary_path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(temp_dir).with_context(|| {
        format!(
            "Failed to create temp snapshot near {}",
            primary_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut temp, snapshot).context("Failed to encode snapshot")?;
    use std::io::Write;
    temp.write_all(b"\n")
        .context("Failed to finalize snapshot")?;
    temp.flush().context("Failed to flush snapshot")?;

    if primary_path.exists() {
        if backup_path.exists() {
            let _ = fs::remove_file(backup_path);
        }
        fs::copy(primary_path, backup_path).with_context(|| {
            format!("Failed to write backup snapshot: {}", backup_path.display())
        })?;
    }

    temp.persist(primary_path)
        .map_err(|error| anyhow!(error.error))
        .with_context(|| format!("Failed to persist snapshot: {}", primary_path.display()))?;
    Ok(())
}

pub fn validate_shadow_contract_value(input: Value) -> Result<ShadowEnvelope> {
    let record = as_object(&input, "Shadow envelope")?;
    if as_u64_field(record, "version")? != SHADOW_VERSION {
        anyhow::bail!("Shadow envelope version must equal 1.");
    }
    let authority = as_non_empty_string(record.get("authority"), "authority")?;
    if authority != SHADOW_AUTHORITY {
        anyhow::bail!("Shadow envelope authority must be extension_primary.");
    }

    let generation = as_non_empty_string(record.get("generation"), "generation")?;
    let previous_generation =
        as_optional_string(record.get("previousGeneration"), "previousGeneration")?;
    let committed_at = as_timestamp(
        record.get("committedAt").unwrap_or(&Value::Null),
        "committedAt",
    )?;

    let latest_pointer =
        normalize_latest_pointer(record.get("latestPointer").unwrap_or(&Value::Null))?;
    let history = normalize_history(record.get("history").unwrap_or(&Value::Null))?;
    let manifest = normalize_manifest(record.get("manifest").unwrap_or(&Value::Null))?;
    let latest_pointer_payload =
        as_non_empty_string(record.get("latestPointerPayload"), "latestPointerPayload")?;
    let history_payload = as_non_empty_string(record.get("historyPayload"), "historyPayload")?;
    let manifest_payload = as_non_empty_string(record.get("manifestPayload"), "manifestPayload")?;
    let latest_pointer_from_payload = normalize_payload_json(
        &latest_pointer_payload,
        normalize_latest_pointer,
        "latestPointerPayload",
    )?;
    let history_from_payload =
        normalize_payload_json(&history_payload, normalize_history, "historyPayload")?;
    let manifest_from_payload =
        normalize_payload_json(&manifest_payload, normalize_manifest, "manifestPayload")?;

    if latest_pointer.get("generation").and_then(Value::as_str) != Some(generation.as_str())
        || latest_pointer.get("committedAt").and_then(Value::as_u64) != Some(committed_at)
    {
        anyhow::bail!("latestPointer must match envelope generation and committedAt.");
    }

    let expected_previous_generation = optional_string_to_value(previous_generation.clone());

    if history.get("generation").and_then(Value::as_str) != Some(generation.as_str())
        || history.get("previousGeneration") != Some(&expected_previous_generation)
        || history.get("committedAt").and_then(Value::as_u64) != Some(committed_at)
        || history.get("manifestKey") != latest_pointer.get("manifestKey")
    {
        anyhow::bail!("history must match the committed checkpoint chain.");
    }

    if manifest.get("generation").and_then(Value::as_str) != Some(generation.as_str())
        || manifest.get("previousGeneration") != Some(&expected_previous_generation)
        || manifest.get("committedAt").and_then(Value::as_u64) != Some(committed_at)
        || manifest.get("latestPointerKey").and_then(Value::as_str)
            != Some(MEMORY_CHECKPOINTS_LATEST_KEY)
    {
        anyhow::bail!("manifest must match the committed checkpoint chain.");
    }

    if latest_pointer != latest_pointer_from_payload
        || history != history_from_payload
        || manifest != manifest_from_payload
    {
        anyhow::bail!(
            "manifestPayload/historyPayload/latestPointerPayload must match the normalized chain."
        );
    }

    let artifact_payloads = normalize_artifact_payloads(
        record.get("artifactPayloads").unwrap_or(&Value::Null),
        &manifest,
    )?;
    let verification = normalize_verification_meta(record.get("verification"))?;
    let freshness = normalize_freshness_meta(record.get("freshness"))?;

    Ok(ShadowEnvelope {
        version: SHADOW_VERSION,
        authority: SHADOW_AUTHORITY.to_string(),
        generation,
        previous_generation,
        committed_at,
        latest_pointer,
        latest_pointer_payload,
        history,
        history_payload,
        manifest,
        manifest_payload,
        artifact_payloads,
        verification,
        freshness,
    })
}

fn normalize_payload_json<F>(raw: &str, normalize: F, label: &str) -> Result<Value>
where
    F: Fn(&Value) -> Result<Value>,
{
    let parsed = serde_json::from_str::<Value>(raw)
        .with_context(|| format!("{label} must be valid JSON matching the normalized payload."))?;
    normalize(&parsed)
}

fn normalize_verification_meta(value: Option<&Value>) -> Result<ShadowVerificationMeta> {
    let record = value.and_then(Value::as_object);
    let state = match record
        .and_then(|item| item.get("state"))
        .and_then(Value::as_str)
    {
        Some("verified") | Some("failed") | Some("unknown") => record
            .unwrap()
            .get("state")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string(),
        _ => "unknown".to_string(),
    };
    let verified_at = match record.and_then(|item| item.get("verifiedAt")) {
        Some(value) if !value.is_null() => Some(as_timestamp(value, "verification.verifiedAt")?),
        _ => None,
    };
    Ok(ShadowVerificationMeta { state, verified_at })
}

fn normalize_freshness_meta(value: Option<&Value>) -> Result<ShadowFreshnessMeta> {
    let record = value.and_then(Value::as_object);
    let state = match record
        .and_then(|item| item.get("state"))
        .and_then(Value::as_str)
    {
        Some("fresh") | Some("stale") | Some("unknown") => record
            .unwrap()
            .get("state")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string(),
        _ => "unknown".to_string(),
    };
    let shadowed_at = match record.and_then(|item| item.get("shadowedAt")) {
        Some(value) if !value.is_null() => Some(as_timestamp(value, "freshness.shadowedAt")?),
        _ => None,
    };
    Ok(ShadowFreshnessMeta { state, shadowed_at })
}

fn normalize_latest_pointer(value: &Value) -> Result<Value> {
    let record = as_object(value, "latestPointer")?;
    if as_u64_field(record, "version")? != SHADOW_VERSION {
        anyhow::bail!("latestPointer.version must equal 1.");
    }
    let generation = as_non_empty_string(record.get("generation"), "latestPointer.generation")?;
    let committed_at = as_timestamp(
        record.get("committedAt").unwrap_or(&Value::Null),
        "latestPointer.committedAt",
    )?;
    let manifest_key = as_non_empty_string(record.get("manifestKey"), "latestPointer.manifestKey")?;
    let mut normalized = Map::new();
    normalized.insert("version".to_string(), Value::from(1));
    normalized.insert("generation".to_string(), Value::String(generation));
    normalized.insert("committedAt".to_string(), Value::from(committed_at));
    normalized.insert("manifestKey".to_string(), Value::String(manifest_key));
    if let Ok(Some(memory_identity_id)) = as_optional_string(
        record.get("memoryIdentityId"),
        "latestPointer.memoryIdentityId",
    ) {
        normalized.insert(
            "memoryIdentityId".to_string(),
            Value::String(memory_identity_id),
        );
    }
    Ok(Value::Object(normalized))
}

fn normalize_history(value: &Value) -> Result<Value> {
    let record = as_object(value, "history")?;
    if as_u64_field(record, "version")? != SHADOW_VERSION {
        anyhow::bail!("history.version must equal 1.");
    }
    let generation = as_non_empty_string(record.get("generation"), "history.generation")?;
    let previous_generation = as_optional_string(
        record.get("previousGeneration"),
        "history.previousGeneration",
    )?;
    let coverage_day = as_non_empty_string(record.get("coverageDay"), "history.coverageDay")?;
    let committed_at = as_timestamp(
        record.get("committedAt").unwrap_or(&Value::Null),
        "history.committedAt",
    )?;
    let manifest_key = as_non_empty_string(record.get("manifestKey"), "history.manifestKey")?;
    let artifact_count = as_non_negative_integer(
        record.get("artifactCount").unwrap_or(&Value::Null),
        "history.artifactCount",
    )?;
    let required_artifact_count = as_non_negative_integer(
        record.get("requiredArtifactCount").unwrap_or(&Value::Null),
        "history.requiredArtifactCount",
    )?;
    let last_history_key =
        as_non_empty_string(record.get("lastHistoryKey"), "history.lastHistoryKey")?;
    let mut normalized = Map::new();
    normalized.insert("version".to_string(), Value::from(1));
    normalized.insert("generation".to_string(), Value::String(generation));
    normalized.insert(
        "previousGeneration".to_string(),
        optional_string_to_value(previous_generation),
    );
    normalized.insert("coverageDay".to_string(), Value::String(coverage_day));
    normalized.insert("committedAt".to_string(), Value::from(committed_at));
    normalized.insert("manifestKey".to_string(), Value::String(manifest_key));
    normalized.insert("artifactCount".to_string(), Value::from(artifact_count));
    normalized.insert(
        "requiredArtifactCount".to_string(),
        Value::from(required_artifact_count),
    );
    normalized.insert(
        "lastHistoryKey".to_string(),
        Value::String(last_history_key),
    );
    if let Ok(Some(memory_identity_id)) =
        as_optional_string(record.get("memoryIdentityId"), "history.memoryIdentityId")
    {
        normalized.insert(
            "memoryIdentityId".to_string(),
            Value::String(memory_identity_id),
        );
    }
    Ok(Value::Object(normalized))
}

fn normalize_manifest(value: &Value) -> Result<Value> {
    let record = as_object(value, "manifest")?;
    if as_u64_field(record, "version")? != SHADOW_VERSION {
        anyhow::bail!("manifest must be a v1 object with artifacts.");
    }
    let artifacts = record
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("manifest must be a v1 object with artifacts."))?
        .iter()
        .enumerate()
        .map(|(index, item)| normalize_manifest_artifact(item, index))
        .collect::<Result<Vec<_>>>()?;
    let generation = as_non_empty_string(record.get("generation"), "manifest.generation")?;
    let previous_generation = as_optional_string(
        record.get("previousGeneration"),
        "manifest.previousGeneration",
    )?;
    let committed_at = as_timestamp(
        record.get("committedAt").unwrap_or(&Value::Null),
        "manifest.committedAt",
    )?;
    let generated_at = as_timestamp(
        record.get("generatedAt").unwrap_or(&Value::Null),
        "manifest.generatedAt",
    )?;
    let latest_pointer_key =
        as_non_empty_string(record.get("latestPointerKey"), "manifest.latestPointerKey")?;
    let overall_hash = as_non_empty_string(record.get("overallHash"), "manifest.overallHash")?;
    let node_count = as_non_negative_integer(
        record.get("nodeCount").unwrap_or(&Value::Null),
        "manifest.nodeCount",
    )?;
    let core_doc_count = as_non_negative_integer(
        record.get("coreDocCount").unwrap_or(&Value::Null),
        "manifest.coreDocCount",
    )?;
    let daily_log_count = as_non_negative_integer(
        record.get("dailyLogCount").unwrap_or(&Value::Null),
        "manifest.dailyLogCount",
    )?;
    let structured_context_count = as_non_negative_integer(
        record.get("structuredContextCount").unwrap_or(&Value::Null),
        "manifest.structuredContextCount",
    )?;
    let mut normalized = Map::new();
    normalized.insert("version".to_string(), Value::from(1));
    normalized.insert("generatedAt".to_string(), Value::from(generated_at));
    normalized.insert("committedAt".to_string(), Value::from(committed_at));
    normalized.insert("generation".to_string(), Value::String(generation));
    normalized.insert(
        "previousGeneration".to_string(),
        optional_string_to_value(previous_generation),
    );
    normalized.insert(
        "latestPointerKey".to_string(),
        Value::String(latest_pointer_key),
    );
    normalized.insert("overallHash".to_string(), Value::String(overall_hash));
    normalized.insert("nodeCount".to_string(), Value::from(node_count));
    normalized.insert("coreDocCount".to_string(), Value::from(core_doc_count));
    normalized.insert("dailyLogCount".to_string(), Value::from(daily_log_count));
    normalized.insert(
        "structuredContextCount".to_string(),
        Value::from(structured_context_count),
    );
    if let Ok(Some(memory_identity_id)) =
        as_optional_string(record.get("memoryIdentityId"), "manifest.memoryIdentityId")
    {
        normalized.insert(
            "memoryIdentityId".to_string(),
            Value::String(memory_identity_id),
        );
    }
    normalized.insert("artifacts".to_string(), Value::Array(artifacts));
    Ok(Value::Object(normalized))
}

fn normalize_manifest_artifact(value: &Value, index: usize) -> Result<Value> {
    let record = as_object(value, &format!("manifest.artifacts[{index}]"))?;
    let kind = as_non_empty_string(
        record.get("kind"),
        &format!("manifest.artifacts[{index}].kind"),
    )?;
    if !matches!(
        kind.as_str(),
        "context_snapshot" | "core_doc" | "daily_log" | "derived_meta"
    ) {
        anyhow::bail!("manifest.artifacts[{index}].kind is not supported.");
    }
    let key = as_non_empty_string(
        record.get("key"),
        &format!("manifest.artifacts[{index}].key"),
    )?;
    let label = as_non_empty_string(
        record.get("label"),
        &format!("manifest.artifacts[{index}].label"),
    )?;
    let updated_at = as_non_negative_integer(
        record.get("updatedAt").unwrap_or(&Value::Null),
        &format!("manifest.artifacts[{index}].updatedAt"),
    )?;
    let checksum = as_non_empty_string(
        record.get("checksum"),
        &format!("manifest.artifacts[{index}].checksum"),
    )?;
    let storage_key = as_non_empty_string(
        record.get("storageKey"),
        &format!("manifest.artifacts[{index}].storageKey"),
    )?;
    let required = record
        .get("required")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("manifest.artifacts[{index}].required must be a boolean."))?;
    let mut normalized = Map::new();
    normalized.insert("key".to_string(), Value::String(key));
    normalized.insert("label".to_string(), Value::String(label));
    normalized.insert("kind".to_string(), Value::String(kind));
    normalized.insert("updatedAt".to_string(), Value::from(updated_at));
    normalized.insert("checksum".to_string(), Value::String(checksum));
    normalized.insert("storageKey".to_string(), Value::String(storage_key));
    normalized.insert("required".to_string(), Value::Bool(required));

    for (field, label) in [
        ("count", format!("manifest.artifacts[{index}].count")),
        ("bytes", format!("manifest.artifacts[{index}].bytes")),
        (
            "shardIndex",
            format!("manifest.artifacts[{index}].shardIndex"),
        ),
        (
            "shardCount",
            format!("manifest.artifacts[{index}].shardCount"),
        ),
    ] {
        if let Some(value) = record.get(field) {
            normalized.insert(
                field.to_string(),
                Value::from(as_non_negative_integer(value, &label)?),
            );
        }
    }
    if let Some(group_checksum) = record.get("groupChecksum") {
        normalized.insert(
            "groupChecksum".to_string(),
            Value::String(as_non_empty_string(
                Some(group_checksum),
                &format!("manifest.artifacts[{index}].groupChecksum"),
            )?),
        );
    }
    Ok(Value::Object(normalized))
}

fn normalize_artifact_payloads(
    value: &Value,
    manifest: &Value,
) -> Result<BTreeMap<String, String>> {
    let record = as_object(value, "artifactPayloads")?;
    let mut normalized = BTreeMap::new();
    for (storage_key, payload) in record {
        let storage_key = as_non_empty_string(
            Some(&Value::String(storage_key.clone())),
            "artifactPayloads key",
        )?;
        let payload = as_non_empty_string(Some(payload), "artifactPayloads value")?;
        normalized.insert(storage_key, payload);
    }
    let artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("manifest must be a v1 object with artifacts."))?;
    for artifact in artifacts {
        let required = artifact
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !required {
            continue;
        }
        let storage_key = artifact
            .get("storageKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if normalized.contains_key(storage_key) || storage_key.starts_with("session-archives/") {
            continue;
        }
        anyhow::bail!(
            "artifactPayloads missing required payload for {}.",
            storage_key
        );
    }
    Ok(normalized)
}

fn as_object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| anyhow!("{label} must be an object."))
}

fn as_u64_field(record: &Map<String, Value>, field: &str) -> Result<u64> {
    as_timestamp(record.get(field).unwrap_or(&Value::Null), field)
}

fn as_non_empty_string(value: Option<&Value>, label: &str) -> Result<String> {
    let Some(value) = value else {
        anyhow::bail!("{label} must be a non-empty string.");
    };
    let Some(raw) = value.as_str() else {
        anyhow::bail!("{label} must be a non-empty string.");
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("{label} must be a non-empty string.");
    }
    Ok(trimmed.to_string())
}

fn as_optional_string(value: Option<&Value>, label: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                anyhow::bail!("{label} must be a non-empty string.");
            }
            Ok(Some(trimmed.to_string()))
        }
        Some(_) => anyhow::bail!("{label} must be a non-empty string."),
    }
}

fn as_timestamp(value: &Value, label: &str) -> Result<u64> {
    match value {
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                if value > 0 {
                    return Ok(value);
                }
            }
            if let Some(value) = number.as_f64() {
                if value.is_finite() && value > 0.0 {
                    return Ok(value.floor() as u64);
                }
            }
            anyhow::bail!("{label} must be a positive timestamp.")
        }
        _ => anyhow::bail!("{label} must be a positive timestamp."),
    }
}

fn as_non_negative_integer(value: &Value, label: &str) -> Result<u64> {
    match value {
        Value::Number(number) => {
            if let Some(value) = number.as_u64() {
                return Ok(value);
            }
            if let Some(value) = number.as_f64() {
                if value.is_finite() && value >= 0.0 {
                    return Ok(value.floor() as u64);
                }
            }
            anyhow::bail!("{label} must be a non-negative number.")
        }
        _ => anyhow::bail!("{label} must be a non-negative number."),
    }
}

fn optional_string_to_value(value: Option<String>) -> Value {
    match value {
        Some(value) => Value::String(value),
        None => Value::Null,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_shadow_envelope() -> Value {
        make_shadow_envelope_with_committed_at(1700000005000_u64)
    }

    fn make_shadow_envelope_with_committed_at(committed_at: u64) -> Value {
        let latest_pointer = json!({
            "version": 1,
            "generation": "2026-03-13T00-00-00.000Z",
            "committedAt": committed_at,
            "manifestKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/manifest.json",
        });
        let history = json!({
            "version": 1,
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "coverageDay": "2026-03-13",
            "committedAt": committed_at,
            "manifestKey": latest_pointer["manifestKey"].clone(),
            "artifactCount": 2,
            "requiredArtifactCount": 2,
            "lastHistoryKey": "memory-checkpoints/history/2026-03-13T00-00-00.000Z.json",
        });
        let manifest = json!({
            "version": 1,
            "generatedAt": committed_at.saturating_sub(5000),
            "committedAt": committed_at,
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "latestPointerKey": "memory-checkpoints/latest.json",
            "overallHash": "overall-hash",
            "nodeCount": 1,
            "coreDocCount": 0,
            "dailyLogCount": 0,
            "structuredContextCount": 1,
            "artifacts": [
                {
                    "key": "context-nodes.json",
                    "label": "Context Snapshot",
                    "kind": "context_snapshot",
                    "updatedAt": 1700000000000_u64,
                    "checksum": "ctx-checksum",
                    "count": 1,
                    "bytes": 128,
                    "storageKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json",
                    "required": true,
                },
                {
                    "key": "memory-index.json",
                    "label": "memory-index.json",
                    "kind": "derived_meta",
                    "updatedAt": 1700000005000_u64,
                    "checksum": "memory-index-checksum",
                    "bytes": 32,
                    "storageKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json",
                    "required": true,
                }
            ]
        });
        json!({
            "version": 1,
            "authority": "extension_primary",
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "committedAt": committed_at,
            "latestPointer": latest_pointer,
            "latestPointerPayload": latest_pointer.to_string(),
            "history": history,
            "historyPayload": history.to_string(),
            "manifest": manifest,
            "manifestPayload": manifest.to_string(),
            "artifactPayloads": {
                "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json": "{\"nodes\":true}",
                "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json": "[{\"id\":\"mem-1\"}]"
            }
        })
    }

    #[test]
    fn shadow_store_persists_envelope_and_status() {
        let temp_dir = TempDir::new().unwrap();
        let store = ShadowStore::new_in(temp_dir.path());
        let status = store
            .ingest_value(make_shadow_envelope(), Some(1700000009000_u64))
            .unwrap();
        assert_eq!(
            status.mirrored_generation.as_deref(),
            Some("2026-03-13T00-00-00.000Z")
        );
        assert_eq!(status.mirrored_committed_at, Some(1700000005000_u64));
        assert_eq!(status.freshness.state, "fresh");
        assert_eq!(status.freshness.shadowed_at, Some(1700000009000_u64));

        let reloaded = ShadowStore::new_in(temp_dir.path());
        let envelope = reloaded.get_envelope().unwrap().unwrap();
        let reloaded_status = reloaded.get_status().unwrap();
        assert_eq!(envelope.generation, "2026-03-13T00-00-00.000Z");
        assert_eq!(
            reloaded_status.mirrored_generation.as_deref(),
            Some("2026-03-13T00-00-00.000Z")
        );
    }

    #[test]
    fn shadow_store_falls_back_to_backup_when_primary_is_corrupted() {
        let temp_dir = TempDir::new().unwrap();
        let store = ShadowStore::new_in(temp_dir.path());
        store
            .ingest_value(make_shadow_envelope(), Some(1700000009000_u64))
            .unwrap();

        let primary = temp_dir.path().join("memory-shadow.json");
        let backup = temp_dir.path().join("memory-shadow.json.bak");
        let payload = fs::read_to_string(&primary).unwrap();
        fs::write(&backup, payload).unwrap();
        fs::write(&primary, "{ invalid json").unwrap();

        let reloaded = ShadowStore::new_in(temp_dir.path());
        let status = reloaded.get_status().unwrap();
        assert_eq!(
            status.mirrored_generation.as_deref(),
            Some("2026-03-13T00-00-00.000Z")
        );
        assert_eq!(status.freshness.shadowed_at, Some(1700000009000_u64));
    }

    #[test]
    fn shadow_store_returns_empty_placeholder_before_ingest() {
        let temp_dir = TempDir::new().unwrap();
        let store = ShadowStore::new_in(temp_dir.path());
        assert_eq!(store.get_status().unwrap(), empty_shadow_status());
    }

    #[test]
    fn shadow_refresh_returns_no_shadow_checkpoint_without_envelope() {
        let temp_dir = TempDir::new().unwrap();
        let manager = ShadowRefreshManager::new_in(temp_dir.path());
        let result = manager.refresh(None, false).unwrap();
        assert!(!result.published);
        assert_eq!(result.reason.as_deref(), Some("no_shadow_checkpoint"));
    }

    #[test]
    fn shadow_refresh_skips_when_primary_is_still_fresh() {
        let temp_dir = TempDir::new().unwrap();
        let manager = ShadowRefreshManager::new_in(temp_dir.path());
        let envelope =
            validate_shadow_contract_value(make_shadow_envelope_with_committed_at(now_millis()))
                .unwrap();
        let result = manager.refresh(Some(&envelope), false).unwrap();
        assert!(!result.published);
        assert_eq!(result.reason.as_deref(), Some("primary_fresh"));
        assert_eq!(result.state.state, "primary_fresh");
    }
}
