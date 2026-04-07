use crate::{
    build_checkpoint_job_result, CheckpointJobExecution, CheckpointJobResult,
    PreparedCheckpointWrite,
};
use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use companion_config::CheckpointSyncConfig;
use ethers::abi::AbiParser;
use ethers::contract::Contract;
use ethers::middleware::SignerMiddleware;
use ethers::providers::{Http, Middleware, Provider};
use ethers::signers::{LocalWallet, Signer};
use ethers::types::{Address, Bytes, H256, U256};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{sleep, Instant};

const ZERO_G_CHUNK_SIZE: usize = 256;
const ZERO_G_SEGMENT_MAX_CHUNKS: usize = 1024;
const ZERO_G_SEGMENT_SIZE: usize = ZERO_G_CHUNK_SIZE * ZERO_G_SEGMENT_MAX_CHUNKS;
const ZERO_G_FLOW_GAS_LIMIT: u64 = 1_200_000;
const ZERO_G_INDEXER_TIMEOUT_SECS: u64 = 12;
const ZERO_G_NODE_TIMEOUT_SECS: u64 = 12;
const ZERO_G_TX_WAIT_TIMEOUT_SECS: u64 = 90;
const ZERO_G_FINALIZE_WAIT_TIMEOUT_SECS: u64 = 120;
const ZERO_G_POLL_INTERVAL_MS: u64 = 1_000;
const ZERO_G_VERIFY_RETRY_DELAYS_MS: [u64; 6] = [0, 250, 500, 1_000, 2_000, 4_000];
const ZERO_G_DOWNLOAD_SEGMENT_CHUNK_SIZE: usize = 256;
const ZERO_G_MAX_DOWNLOAD_SEGMENTS: usize = (4 * 1024 * 1024) / ZERO_G_CHUNK_SIZE;
const ZERO_G_DUPLICATE_ROOT_ERROR: &str = "already uploaded and finalized";
const ZERO_G_DUPLICATE_SEGMENT_ERROR: &str =
    "segment has already been uploaded or is being uploaded";

#[derive(Clone, Debug)]
struct ZeroGNetworkConfig {
    chain_name: String,
    chain_id: u64,
    chain_rpc: String,
    indexer_rpc: String,
    flow_contract: Address,
    kv_rpc: Option<String>,
    pointer_registry: Option<Address>,
}

#[derive(Clone, Debug, Default)]
struct ZeroGNetworkOverrides {
    chain_name: Option<String>,
    chain_id: Option<u64>,
    chain_rpc: Option<String>,
    indexer_rpc: Option<String>,
    flow_contract: Option<Address>,
    pointer_registry: Option<Address>,
}

#[derive(Clone, Debug)]
struct SubmissionNodeData {
    root: [u8; 32],
    height: u32,
}

#[derive(Clone, Debug)]
struct MerkleProofData {
    lemma: Vec<[u8; 32]>,
    path: Vec<bool>,
}

#[derive(Clone, Debug)]
struct MerkleTreeData {
    layers: Vec<Vec<[u8; 32]>>,
}

#[derive(Clone, Debug)]
struct UploadSegmentData {
    root: [u8; 32],
    data: Vec<u8>,
    index: u64,
    proof: MerkleProofData,
    file_size: u64,
}

#[derive(Clone, Debug)]
struct ZeroGUploadPlan {
    raw_data: Vec<u8>,
    root: [u8; 32],
    padded_size: usize,
    submission_nodes: Vec<SubmissionNodeData>,
    segment_tree: MerkleTreeData,
}

#[derive(Debug, Deserialize)]
struct JsonRpcEnvelope<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct IndexerShardedNodes {
    #[serde(default)]
    trusted: Vec<IndexerNode>,
    #[serde(default)]
    discovered: Vec<IndexerNode>,
}

#[derive(Debug, Deserialize)]
struct IndexerNode {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ZgsFileInfo {
    tx: ZgsTransaction,
    finalized: bool,
}

#[derive(Debug, Deserialize)]
struct ZgsTransaction {
    seq: u64,
}

pub fn zero_g_executor_supported(config: &CheckpointSyncConfig) -> bool {
    resolve_zero_g_network(config).is_ok()
}

pub fn zero_g_executor_support_reason(config: &CheckpointSyncConfig) -> &'static str {
    match resolve_zero_g_network(config) {
        Ok(_) => "ready",
        Err(error) => {
            if error
                .to_string()
                .contains("memory_checkpoint_jobs_require_pointer_registry")
            {
                "missing_pointer_registry"
            } else {
                "unsupported_config"
            }
        }
    }
}

pub async fn execute_zero_g_checkpoint_job(
    config: CheckpointSyncConfig,
    execution: CheckpointJobExecution,
) -> Result<CheckpointJobResult> {
    let writes = crate::build_checkpoint_write_plan(&config, &execution.publish_bundle)?;
    for write in writes {
        if execution
            .resume_state
            .completed_steps
            .iter()
            .any(|step| step == &write.step_id)
        {
            continue;
        }
        write_zero_g_checkpoint_entry(&config, &write).await?;
        execution
            .mark_progress(&write.step_id, Some(&write.stage))
            .await?;
    }

    Ok(build_checkpoint_job_result(
        &execution.publish_bundle,
        "verified",
        None,
    ))
}

async fn write_zero_g_checkpoint_entry(
    config: &CheckpointSyncConfig,
    write: &PreparedCheckpointWrite,
) -> Result<()> {
    let network = resolve_zero_g_network(config)?;
    let http = Client::builder()
        .timeout(Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS))
        .build()
        .context("failed to build 0G HTTP client")?;
    let upload_plan = build_upload_plan(&write.encoded_stream_data)?;
    let storage_node_url = select_storage_node_url(&http, &network.indexer_rpc).await?;
    submit_flow_transaction(config, &network, &upload_plan, &write.tags).await?;
    let file_info = wait_for_transaction_entry(&http, &storage_node_url, &upload_plan.root)
        .await
        .with_context(|| format!("0g transaction did not appear for {}", write.storage_key))?;
    let tx_seq = file_info.tx.seq;
    upload_segments(&http, &storage_node_url, tx_seq, &upload_plan).await?;
    wait_for_file_finalized(&http, &storage_node_url, tx_seq)
        .await
        .with_context(|| format!("0g upload did not finalize for {}", write.storage_key))?;
    verify_remote_write(
        &http,
        config,
        &network,
        &storage_node_url,
        &upload_plan.root,
        &write.normalized_stream_id,
        write,
    )
    .await
    .with_context(|| format!("0g remote verify failed for {}", write.storage_key))?;
    Ok(())
}

fn resolve_zero_g_network(config: &CheckpointSyncConfig) -> Result<ZeroGNetworkConfig> {
    resolve_zero_g_network_with_overrides(config, ZeroGNetworkOverrides::from_env()?)
}

impl ZeroGNetworkOverrides {
    fn from_env() -> Result<Self> {
        Ok(Self {
            chain_name: read_non_empty_env("TRAPEZOHE_MEMORY_CHAIN_NAME"),
            chain_id: std::env::var("TRAPEZOHE_MEMORY_CHAIN_ID")
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok()),
            chain_rpc: read_non_empty_env("TRAPEZOHE_MEMORY_CHAIN_RPC"),
            indexer_rpc: read_non_empty_env("TRAPEZOHE_MEMORY_INDEXER_RPC"),
            flow_contract: read_non_empty_env("TRAPEZOHE_MEMORY_FLOW_CONTRACT")
                .map(|value| {
                    value
                        .parse::<Address>()
                        .context("invalid TRAPEZOHE_MEMORY_FLOW_CONTRACT address")
                })
                .transpose()?,
            pointer_registry: read_non_empty_env("TRAPEZOHE_MEMORY_POINTER_REGISTRY")
                .map(|value| {
                    value
                        .parse::<Address>()
                        .context("invalid TRAPEZOHE_MEMORY_POINTER_REGISTRY address")
                })
                .transpose()?,
        })
    }
}

fn read_non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_zero_g_network_with_overrides(
    config: &CheckpointSyncConfig,
    overrides: ZeroGNetworkOverrides,
) -> Result<ZeroGNetworkConfig> {
    let kv_rpc = config
        .kv_rpc
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let uses_kv_rpc = kv_rpc.is_some();

    let chain_name = overrides.chain_name.unwrap_or_else(|| {
        if uses_kv_rpc {
            "0G-Galileo-Testnet".to_string()
        } else {
            "0G-Mainnet".to_string()
        }
    });
    let chain_id = overrides
        .chain_id
        .unwrap_or(if uses_kv_rpc { 16_602 } else { 16_661 });
    let chain_rpc = overrides.chain_rpc.unwrap_or_else(|| {
        if uses_kv_rpc {
            "https://evmrpc-testnet.0g.ai".to_string()
        } else {
            "https://evmrpc.0g.ai".to_string()
        }
    });
    let indexer_rpc = overrides.indexer_rpc.unwrap_or_else(|| {
        if uses_kv_rpc {
            "https://indexer-storage-testnet-turbo.0g.ai".to_string()
        } else {
            "https://indexer-storage-turbo.0g.ai".to_string()
        }
    });
    let flow_contract = overrides.flow_contract.unwrap_or_else(|| {
        if uses_kv_rpc {
            "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296"
                .parse::<Address>()
                .expect("default 0G Galileo flow contract should be valid")
        } else {
            "0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526"
                .parse::<Address>()
                .expect("default 0G mainnet flow contract should be valid")
        }
    });
    let pointer_registry = overrides.pointer_registry.or_else(|| {
        if uses_kv_rpc {
            None
        } else {
            Some(
                "0x68F8610888C26caD04B37FadE933AB0031C5e61c"
                    .parse::<Address>()
                    .expect("default 0G mainnet pointer registry should be valid"),
            )
        }
    });

    if !uses_kv_rpc && pointer_registry.is_none() {
        anyhow::bail!("memory_checkpoint_jobs_require_pointer_registry");
    }

    Ok(ZeroGNetworkConfig {
        chain_name,
        chain_id,
        chain_rpc,
        indexer_rpc,
        flow_contract,
        kv_rpc,
        pointer_registry,
    })
}

fn build_upload_plan(data: &[u8]) -> Result<ZeroGUploadPlan> {
    if data.is_empty() {
        anyhow::bail!("0g stream data is empty");
    }
    let padded_size = iterator_padded_size(data.len());
    let segment_hashes = (0..num_segments_padded(padded_size))
        .map(|segment_index| {
            let offset = segment_index * ZERO_G_SEGMENT_SIZE;
            let segment = read_padded_range(data, offset, ZERO_G_SEGMENT_SIZE, padded_size)?;
            Ok(segment_root(&segment))
        })
        .collect::<Result<Vec<_>>>()?;
    let segment_tree = MerkleTreeData::from_hashes(segment_hashes)?;
    let submission_nodes = build_submission_nodes(data, padded_size)?;

    Ok(ZeroGUploadPlan {
        raw_data: data.to_vec(),
        root: segment_tree.root(),
        padded_size,
        submission_nodes,
        segment_tree,
    })
}

fn build_submission_nodes(data: &[u8], padded_size: usize) -> Result<Vec<SubmissionNodeData>> {
    let num_chunks = num_splits(data.len(), ZERO_G_CHUNK_SIZE);
    let (mut remaining_chunks, mut next_chunk_size) = compute_padded_chunks(num_chunks);
    let mut node_chunk_sizes = Vec::new();
    while remaining_chunks > 0 {
        if remaining_chunks >= next_chunk_size {
            remaining_chunks -= next_chunk_size;
            node_chunk_sizes.push(next_chunk_size);
        }
        next_chunk_size /= 2;
    }

    let mut nodes = Vec::with_capacity(node_chunk_sizes.len());
    let mut offset = 0usize;
    for chunk_count in node_chunk_sizes {
        let batch_chunks = chunk_count.min(ZERO_G_SEGMENT_MAX_CHUNKS);
        let batch_size = batch_chunks * ZERO_G_CHUNK_SIZE;
        let node_size = chunk_count * ZERO_G_CHUNK_SIZE;
        let root = build_segment_node_root(data, offset, batch_size, node_size, padded_size)?;
        nodes.push(SubmissionNodeData {
            root,
            height: log2_power_of_two(chunk_count)?,
        });
        offset += node_size;
    }

    Ok(nodes)
}

fn build_segment_node_root(
    data: &[u8],
    offset: usize,
    batch_size: usize,
    node_size: usize,
    padded_size: usize,
) -> Result<[u8; 32]> {
    let leaf_hashes = (0..num_splits(node_size, batch_size))
        .map(|task_index| {
            let task_offset = offset + task_index * batch_size;
            let segment = read_padded_range(data, task_offset, batch_size, padded_size)?;
            Ok(segment_root(&segment))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(MerkleTreeData::from_hashes(leaf_hashes)?.root())
}

fn iterator_padded_size(data_len: usize) -> usize {
    let (padded_chunks, _) = compute_padded_chunks(num_splits(data_len, ZERO_G_CHUNK_SIZE));
    padded_chunks * ZERO_G_CHUNK_SIZE
}

fn num_segments_padded(padded_size: usize) -> usize {
    num_splits(padded_size, ZERO_G_SEGMENT_SIZE)
}

fn num_splits(total: usize, unit: usize) -> usize {
    total.saturating_sub(1) / unit + 1
}

fn compute_padded_chunks(chunks: usize) -> (usize, usize) {
    let chunks_next_pow2 = next_pow2(chunks.max(1));
    if chunks_next_pow2 == chunks {
        return (chunks_next_pow2, chunks_next_pow2);
    }
    let min_chunk = if chunks_next_pow2 >= 16 {
        chunks_next_pow2 / 16
    } else {
        1
    };
    let padded_chunks = ((chunks - 1) / min_chunk + 1) * min_chunk;
    (padded_chunks, chunks_next_pow2)
}

fn next_pow2(input: usize) -> usize {
    input.max(1).next_power_of_two()
}

fn log2_power_of_two(input: usize) -> Result<u32> {
    if input == 0 || !input.is_power_of_two() {
        anyhow::bail!("0g node chunk size must be a power of two");
    }
    Ok(input.trailing_zeros())
}

fn read_padded_range(
    data: &[u8],
    offset: usize,
    read_size: usize,
    padded_size: usize,
) -> Result<Vec<u8>> {
    if offset >= padded_size {
        anyhow::bail!("0g invalid read offset");
    }
    let expected_size = read_size.min(padded_size - offset);
    let mut buffer = vec![0_u8; expected_size];
    if offset < data.len() {
        let available_end = data.len().min(offset + expected_size);
        buffer[..available_end - offset].copy_from_slice(&data[offset..available_end]);
    }
    Ok(buffer)
}

fn segment_root(segment: &[u8]) -> [u8; 32] {
    let mut leaf_hashes = Vec::with_capacity(num_splits(segment.len(), ZERO_G_CHUNK_SIZE));
    for offset in (0..segment.len()).step_by(ZERO_G_CHUNK_SIZE) {
        leaf_hashes.push(keccak256_hash(&[
            &segment[offset..offset + ZERO_G_CHUNK_SIZE]
        ]));
    }
    MerkleTreeData::from_hashes(leaf_hashes)
        .expect("segment merkle tree")
        .root()
}

impl MerkleTreeData {
    fn from_hashes(leaf_hashes: Vec<[u8; 32]>) -> Result<Self> {
        if leaf_hashes.is_empty() {
            anyhow::bail!("0g merkle tree requires at least one leaf");
        }
        let mut layers = vec![leaf_hashes];
        while layers.last().unwrap().len() > 1 {
            let current = layers.last().unwrap();
            let mut next = Vec::with_capacity(current.len().div_ceil(2));
            let mut index = 0usize;
            while index < current.len() {
                if index + 1 >= current.len() {
                    next.push(current[index]);
                } else {
                    next.push(keccak256_hash(&[&current[index], &current[index + 1]]));
                }
                index += 2;
            }
            layers.push(next);
        }
        Ok(Self { layers })
    }

    fn root(&self) -> [u8; 32] {
        self.layers.last().unwrap()[0]
    }

    fn proof_at(&self, mut index: usize) -> Result<MerkleProofData> {
        let leaves = &self.layers[0];
        if index >= leaves.len() {
            anyhow::bail!("0g merkle proof index out of bounds");
        }
        if leaves.len() == 1 {
            return Ok(MerkleProofData {
                lemma: vec![self.root()],
                path: Vec::new(),
            });
        }

        let mut lemma = vec![leaves[index]];
        let mut path = Vec::new();
        for layer in &self.layers[..self.layers.len() - 1] {
            if index % 2 == 0 {
                if index + 1 < layer.len() {
                    lemma.push(layer[index + 1]);
                    path.push(true);
                }
            } else {
                lemma.push(layer[index - 1]);
                path.push(false);
            }
            index /= 2;
        }
        lemma.push(self.root());
        Ok(MerkleProofData { lemma, path })
    }
}

impl ZeroGUploadPlan {
    fn protocol_sectors(&self) -> u64 {
        self.submission_nodes
            .iter()
            .map(|node| 1_u64 << node.height)
            .sum()
    }

    fn segments(&self, data: &[u8]) -> Result<Vec<UploadSegmentData>> {
        let mut segments = Vec::with_capacity(num_segments_padded(self.padded_size));
        for segment_index in 0..num_segments_padded(self.padded_size) {
            let offset = segment_index * ZERO_G_SEGMENT_SIZE;
            segments.push(UploadSegmentData {
                root: self.root,
                data: read_padded_range(data, offset, ZERO_G_SEGMENT_SIZE, self.padded_size)?,
                index: segment_index as u64,
                proof: self.segment_tree.proof_at(segment_index)?,
                file_size: data.len() as u64,
            });
        }
        Ok(segments)
    }
}

async fn submit_flow_transaction(
    config: &CheckpointSyncConfig,
    network: &ZeroGNetworkConfig,
    upload_plan: &ZeroGUploadPlan,
    tags: &[u8],
) -> Result<()> {
    let provider = Provider::<Http>::try_from(network.chain_rpc.as_str())
        .with_context(|| format!("failed to connect to {}", network.chain_rpc))?
        .interval(Duration::from_millis(250));
    let wallet = config
        .private_key
        .parse::<LocalWallet>()
        .with_context(|| "invalid checkpoint sync private key")?
        .with_chain_id(network.chain_id);
    let client = Arc::new(SignerMiddleware::new(provider, wallet.clone()));

    let flow_abi = AbiParser::default().parse(&[
        "function market() view returns (address)",
        "function submit(((uint256 length, bytes tags, (bytes32 root, uint256 height)[] nodes) data, address submitter) submission) payable returns (uint256, bytes32, uint256, uint256)",
    ])?;
    let market_abi =
        AbiParser::default().parse(&["function pricePerSector() view returns (uint256)"])?;

    let flow = Contract::new(network.flow_contract, flow_abi, client.clone());
    let market_address: Address = flow
        .method::<_, Address>("market", ())?
        .call()
        .await
        .with_context(|| format!("failed to query 0G market on {}", network.chain_name))?;
    let market = Contract::new(market_address, market_abi, client.clone());
    let price_per_sector: U256 = market
        .method::<_, U256>("pricePerSector", ())?
        .call()
        .await
        .with_context(|| format!("failed to query pricePerSector on {}", network.chain_name))?;
    let fee = U256::from(upload_plan.protocol_sectors()) * price_per_sector;

    let submission_nodes = upload_plan
        .submission_nodes
        .iter()
        .map(|node| (H256::from(node.root), U256::from(node.height)))
        .collect::<Vec<_>>();
    let submission = (
        (
            U256::from(upload_plan.raw_data.len() as u64),
            Bytes::from(tags.to_vec()),
            submission_nodes,
        ),
        wallet.address(),
    );

    let submit_call = flow
        .method::<_, (U256, H256, U256, U256)>("submit", (submission,))?
        .value(fee)
        .gas(ZERO_G_FLOW_GAS_LIMIT);
    let pending = submit_call
        .send()
        .await
        .context("failed to submit 0G flow transaction")?;

    let tx_hash = pending.tx_hash();
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(ZERO_G_TX_WAIT_TIMEOUT_SECS) {
        match pending.provider().get_transaction_receipt(tx_hash).await {
            Ok(Some(receipt)) => {
                if receipt.status == Some(1_u64.into()) {
                    return Ok(());
                }
                anyhow::bail!("0g flow transaction reverted: {tx_hash:?}");
            }
            Ok(None) => sleep(Duration::from_millis(ZERO_G_POLL_INTERVAL_MS)).await,
            Err(error) => {
                return Err(anyhow!(error)).context("failed to poll 0G flow receipt");
            }
        }
    }

    anyhow::bail!("timed out waiting for 0G flow receipt");
}

async fn select_storage_node_url(client: &Client, indexer_rpc: &str) -> Result<String> {
    let envelope: IndexerShardedNodes = json_rpc_call(
        client,
        indexer_rpc,
        "indexer_getShardedNodes",
        json!([]),
        Duration::from_secs(ZERO_G_INDEXER_TIMEOUT_SECS),
    )
    .await?;
    envelope
        .trusted
        .into_iter()
        .chain(envelope.discovered.into_iter())
        .map(|node| node.url.trim().to_string())
        .find(|url| !url.is_empty())
        .ok_or_else(|| anyhow!("0g indexer returned no usable storage nodes"))
}

async fn wait_for_transaction_entry(
    client: &Client,
    node_url: &str,
    root: &[u8; 32],
) -> Result<ZgsFileInfo> {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(ZERO_G_TX_WAIT_TIMEOUT_SECS) {
        let info: Option<ZgsFileInfo> = json_rpc_call(
            client,
            node_url,
            "zgs_getFileInfo",
            json!([bytes32_hex(root), true]),
            Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS),
        )
        .await?;
        if let Some(info) = info {
            return Ok(info);
        }
        sleep(Duration::from_millis(ZERO_G_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("timed out waiting for 0G file info");
}

async fn upload_segments(
    client: &Client,
    node_url: &str,
    tx_seq: u64,
    upload_plan: &ZeroGUploadPlan,
) -> Result<()> {
    for segment in upload_plan.segments(&upload_plan.raw_data)? {
        let result = json_rpc_call::<Value>(
            client,
            node_url,
            "zgs_uploadSegmentByTxSeq",
            json!([segment_json(&segment), tx_seq]),
            Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS),
        )
        .await;
        match result {
            Ok(_) => {}
            Err(error) => {
                let message = error.to_string().to_ascii_lowercase();
                if message.contains(ZERO_G_DUPLICATE_ROOT_ERROR)
                    || message.contains(ZERO_G_DUPLICATE_SEGMENT_ERROR)
                {
                    continue;
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn wait_for_file_finalized(client: &Client, node_url: &str, tx_seq: u64) -> Result<()> {
    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(ZERO_G_FINALIZE_WAIT_TIMEOUT_SECS) {
        let info: Option<ZgsFileInfo> = json_rpc_call(
            client,
            node_url,
            "zgs_getFileInfoByTxSeq",
            json!([tx_seq]),
            Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS),
        )
        .await?;
        if info.as_ref().map(|value| value.finalized).unwrap_or(false) {
            return Ok(());
        }
        sleep(Duration::from_millis(ZERO_G_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("timed out waiting for 0G file finalization");
}

async fn verify_remote_write(
    client: &Client,
    config: &CheckpointSyncConfig,
    network: &ZeroGNetworkConfig,
    node_url: &str,
    expected_root: &[u8; 32],
    normalized_stream_id: &str,
    write: &PreparedCheckpointWrite,
) -> Result<()> {
    if let Some(pointer_registry) = network.pointer_registry {
        set_pointer_on_chain(
            config,
            network,
            pointer_registry,
            &write.storage_key,
            expected_root,
        )
        .await?;
        return verify_remote_write_via_segments(
            client,
            config,
            network,
            node_url,
            expected_root,
            &write.storage_key,
            &write.encrypted_payload,
        )
        .await;
    }

    let Some(kv_rpc) = network.kv_rpc.as_deref() else {
        anyhow::bail!("verify_read_path_unavailable");
    };

    for delay_ms in ZERO_G_VERIFY_RETRY_DELAYS_MS {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        let remote_raw =
            fetch_remote_kv_raw(client, kv_rpc, normalized_stream_id, &write.storage_key).await?;
        if remote_raw.as_deref() == Some(write.encrypted_payload.as_str()) {
            return Ok(());
        }
    }

    anyhow::bail!("verify_read_failed");
}

async fn set_pointer_on_chain(
    config: &CheckpointSyncConfig,
    network: &ZeroGNetworkConfig,
    pointer_registry: Address,
    key: &str,
    root_hash: &[u8; 32],
) -> Result<()> {
    let provider = Provider::<Http>::try_from(network.chain_rpc.as_str())
        .with_context(|| format!("failed to connect to {}", network.chain_rpc))?
        .interval(Duration::from_millis(250));
    let wallet = config
        .private_key
        .parse::<LocalWallet>()
        .with_context(|| "invalid checkpoint sync private key")?
        .with_chain_id(network.chain_id);
    let client = Arc::new(SignerMiddleware::new(provider, wallet));
    let registry_abi = AbiParser::default()
        .parse(&["function setPointers(bytes32[] keyHashes, bytes32[] rootHashes)"])?;
    let registry = Contract::new(pointer_registry, registry_abi, client.clone());
    let key_hash = H256::from(hash_storage_key(key));
    let root_hash = H256::from(*root_hash);
    let call = registry
        .method::<_, ()>("setPointers", (vec![key_hash], vec![root_hash]))?
        .gas(ZERO_G_FLOW_GAS_LIMIT);
    let pending = call
        .send()
        .await
        .context("failed to submit pointer registry update")?;
    let tx_hash = pending.tx_hash();

    let started_at = Instant::now();
    while started_at.elapsed() < Duration::from_secs(ZERO_G_TX_WAIT_TIMEOUT_SECS) {
        match pending.provider().get_transaction_receipt(tx_hash).await {
            Ok(Some(receipt)) => {
                if receipt.status == Some(1_u64.into()) {
                    return Ok(());
                }
                anyhow::bail!("pointer registry transaction reverted: {tx_hash:?}");
            }
            Ok(None) => sleep(Duration::from_millis(ZERO_G_POLL_INTERVAL_MS)).await,
            Err(error) => {
                return Err(anyhow!(error)).context("failed to poll pointer registry receipt");
            }
        }
    }

    anyhow::bail!("timed out waiting for pointer registry receipt");
}

async fn verify_remote_write_via_segments(
    client: &Client,
    config: &CheckpointSyncConfig,
    network: &ZeroGNetworkConfig,
    node_url: &str,
    expected_root: &[u8; 32],
    key: &str,
    expected_value: &str,
) -> Result<()> {
    let expected_root = H256::from(*expected_root);
    for delay_ms in ZERO_G_VERIFY_RETRY_DELAYS_MS {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        let pointer = fetch_pointer_from_chain(config, network, key).await?;
        if pointer != Some(expected_root) {
            continue;
        }
        let downloaded = download_segment_file(client, node_url, &expected_root).await?;
        let Some((downloaded_key, downloaded_value)) = parse_kv_segment_binary(&downloaded) else {
            continue;
        };
        if downloaded_key == key && downloaded_value == expected_value {
            return Ok(());
        }
    }

    anyhow::bail!("verify_segment_download_failed");
}

async fn fetch_pointer_from_chain(
    config: &CheckpointSyncConfig,
    network: &ZeroGNetworkConfig,
    key: &str,
) -> Result<Option<H256>> {
    let Some(pointer_registry) = network.pointer_registry else {
        return Ok(None);
    };
    let provider = Provider::<Http>::try_from(network.chain_rpc.as_str())
        .with_context(|| format!("failed to connect to {}", network.chain_rpc))?;
    let wallet = config
        .private_key
        .parse::<LocalWallet>()
        .with_context(|| "invalid checkpoint sync private key")?
        .with_chain_id(network.chain_id);
    let registry_abi = AbiParser::default().parse(&[
        "function getPointers(address user, bytes32[] keyHashes) view returns (bytes32[])",
    ])?;
    let registry = Contract::new(pointer_registry, registry_abi, Arc::new(provider));
    let values: Vec<H256> = registry
        .method::<_, Vec<H256>>(
            "getPointers",
            (wallet.address(), vec![H256::from(hash_storage_key(key))]),
        )?
        .call()
        .await
        .context("failed to read pointer registry value")?;
    let value = values.into_iter().next().unwrap_or_default();
    if value == H256::zero() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

async fn fetch_remote_kv_raw(
    client: &Client,
    kv_rpc: &str,
    normalized_stream_id: &str,
    key: &str,
) -> Result<Option<String>> {
    let result: Option<String> = json_rpc_call(
        client,
        kv_rpc,
        "kv_getValue",
        json!([
            normalized_stream_id,
            BASE64_STANDARD.encode(key.as_bytes()),
            ""
        ]),
        Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS),
    )
    .await?;
    let Some(raw) = result else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let decoded = BASE64_STANDARD
        .decode(raw.trim())
        .with_context(|| "failed to decode kv_getValue payload")?;
    let text = String::from_utf8(decoded).with_context(|| "failed to decode remote KV utf-8")?;
    Ok(Some(text))
}

async fn download_segment_file(
    client: &Client,
    node_url: &str,
    root_hash: &H256,
) -> Result<Vec<u8>> {
    let first_segment = download_segment_range(client, node_url, root_hash, 0, 1)
        .await?
        .ok_or_else(|| anyhow!("segment_download_missing_initial_segment"))?;
    let first_raw = BASE64_STANDARD
        .decode(first_segment.trim())
        .with_context(|| "failed to decode initial segment payload")?;
    if first_raw.len() > ZERO_G_CHUNK_SIZE {
        return Ok(first_raw);
    }

    let needed_segments = estimate_segments_needed(&first_raw);
    if needed_segments <= 1 {
        return Ok(first_raw);
    }

    let mut combined = Vec::new();
    for start_index in (0..needed_segments).step_by(ZERO_G_DOWNLOAD_SEGMENT_CHUNK_SIZE) {
        let end_index = needed_segments.min(start_index + ZERO_G_DOWNLOAD_SEGMENT_CHUNK_SIZE);
        let segment = download_segment_range(
            client,
            node_url,
            root_hash,
            start_index as u64,
            end_index as u64,
        )
        .await?;
        let Some(segment) = segment else {
            anyhow::bail!("segment_download_incomplete:{start_index}-{end_index}");
        };
        let decoded = BASE64_STANDARD
            .decode(segment.trim())
            .with_context(|| "failed to decode downloaded segment payload")?;
        combined.extend_from_slice(&decoded);
    }
    Ok(combined)
}

async fn download_segment_range(
    client: &Client,
    node_url: &str,
    root_hash: &H256,
    start_index: u64,
    end_index: u64,
) -> Result<Option<String>> {
    json_rpc_call(
        client,
        node_url,
        "zgs_downloadSegment",
        json!([format!("{root_hash:#x}"), start_index, end_index]),
        Duration::from_secs(ZERO_G_NODE_TIMEOUT_SECS),
    )
    .await
}

fn parse_kv_segment_header(raw: &[u8]) -> Option<(String, usize, usize)> {
    if raw.len() < 59 {
        return None;
    }

    let mut offset = 50usize;
    let key_len = *raw.get(offset)? as usize;
    if key_len == 0 || key_len > 200 {
        return None;
    }
    offset += 1;
    if offset + key_len + 8 > raw.len() {
        return None;
    }

    let key = String::from_utf8(raw[offset..offset + key_len].to_vec()).ok()?;
    offset += key_len;
    let value_length = u64::from_be_bytes(raw[offset..offset + 8].try_into().ok()?) as usize;
    Some((key, offset + 8, value_length))
}

fn parse_kv_segment_binary(raw: &[u8]) -> Option<(String, String)> {
    let (key, value_offset, value_length) = parse_kv_segment_header(raw)?;
    if value_offset + value_length > raw.len() {
        return None;
    }
    let value = String::from_utf8(raw[value_offset..value_offset + value_length].to_vec()).ok()?;
    Some((key, value))
}

fn estimate_segments_needed(first_segment: &[u8]) -> usize {
    let Some((_, value_offset, value_length)) = parse_kv_segment_header(first_segment) else {
        return 1;
    };
    let total_bytes = value_offset + value_length;
    let segments = total_bytes.div_ceil(ZERO_G_CHUNK_SIZE);
    segments.min(ZERO_G_MAX_DOWNLOAD_SEGMENTS)
}

fn hash_storage_key(key: &str) -> [u8; 32] {
    keccak256_hash(&[key.as_bytes()])
}

async fn json_rpc_call<T: DeserializeOwned>(
    client: &Client,
    url: &str,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<T> {
    let response = client
        .post(url)
        .timeout(timeout)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .with_context(|| format!("failed to call {method} on {url}"))?;
    if !response.status().is_success() {
        anyhow::bail!("{method} failed with HTTP {}", response.status());
    }
    let envelope = response
        .json::<JsonRpcEnvelope<T>>()
        .await
        .with_context(|| format!("failed to parse {method} response"))?;
    if let Some(error) = envelope.error {
        anyhow::bail!("{method} rpc error: {}", error.message);
    }
    envelope
        .result
        .ok_or_else(|| anyhow!("{method} returned no result"))
}

fn segment_json(segment: &UploadSegmentData) -> Value {
    json!({
        "root": bytes32_hex(&segment.root),
        "data": BASE64_STANDARD.encode(&segment.data),
        "index": segment.index,
        "proof": {
            "lemma": segment.proof.lemma.iter().map(bytes32_hex).collect::<Vec<_>>(),
            "path": segment.proof.path,
        },
        "fileSize": segment.file_size,
    })
}

fn bytes32_hex(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn keccak256_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ethers::utils::hex;

    fn test_config() -> CheckpointSyncConfig {
        CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1"
                .to_string(),
            kv_rpc: Some("https://kv-rpc-galileo.0g.ai".to_string()),
        }
    }

    #[test]
    fn zero_g_executor_supports_testnet_and_mainnet_paths() {
        assert!(zero_g_executor_supported(&test_config()));
        assert!(zero_g_executor_supported(&CheckpointSyncConfig {
            kv_rpc: None,
            ..test_config()
        }));
        assert_eq!(zero_g_executor_support_reason(&test_config()), "ready");
        assert_eq!(
            zero_g_executor_support_reason(&CheckpointSyncConfig {
                kv_rpc: None,
                ..test_config()
            }),
            "ready"
        );
    }

    #[test]
    fn resolve_zero_g_network_uses_mainnet_defaults_without_kv_rpc() {
        let resolved = resolve_zero_g_network_with_overrides(
            &CheckpointSyncConfig {
                kv_rpc: None,
                ..test_config()
            },
            ZeroGNetworkOverrides::default(),
        )
        .unwrap();
        assert_eq!(resolved.chain_name, "0G-Mainnet");
        assert_eq!(resolved.chain_id, 16_661);
        assert_eq!(resolved.chain_rpc, "https://evmrpc.0g.ai");
        assert_eq!(resolved.indexer_rpc, "https://indexer-storage-turbo.0g.ai");
        assert_eq!(
            resolved.flow_contract,
            "0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526"
                .parse::<Address>()
                .unwrap()
        );
        assert_eq!(
            resolved.pointer_registry,
            Some(
                "0x68F8610888C26caD04B37FadE933AB0031C5e61c"
                    .parse::<Address>()
                    .unwrap()
            )
        );
        assert_eq!(resolved.kv_rpc, None);
    }

    #[test]
    fn parse_kv_segment_binary_reads_single_segment_payload() {
        let stream_id = crate::sync::normalize_remote_stream_id("stream-a").unwrap();
        let raw = crate::sync::encode_single_stream_write(
            &stream_id,
            b"memory-checkpoints/latest.json",
            b"{\"ok\":true}",
        )
        .unwrap();
        let parsed = parse_kv_segment_binary(&raw).unwrap();
        assert_eq!(parsed.0, "memory-checkpoints/latest.json");
        assert_eq!(parsed.1, "{\"ok\":true}");
        assert_eq!(estimate_segments_needed(&raw), 1);
    }

    #[test]
    fn parse_kv_segment_binary_reads_multi_segment_payload() {
        let stream_id = crate::sync::normalize_remote_stream_id("stream-a").unwrap();
        let value = "x".repeat(900);
        let raw = crate::sync::encode_single_stream_write(
            &stream_id,
            b"memory-checkpoints/history.json",
            value.as_bytes(),
        )
        .unwrap();
        let parsed = parse_kv_segment_binary(&raw).unwrap();
        assert_eq!(parsed.0, "memory-checkpoints/history.json");
        assert_eq!(parsed.1, value);
        assert!(estimate_segments_needed(&raw) > 1);
    }

    #[test]
    fn hash_storage_key_matches_ethers_keccak256() {
        assert_eq!(
            format!("0x{}", hex::encode(hash_storage_key("abc"))),
            "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }

    #[test]
    fn build_upload_plan_matches_go_root_for_small_payload() {
        let plan = build_upload_plan(b"hello").unwrap();
        assert_eq!(
            bytes32_hex(&plan.root),
            "0x3c0a2457170aa849c8f7051e23d7874a362be798d95fbb333c901c6cf19dca5a"
        );
        assert_eq!(plan.submission_nodes.len(), 1);
        assert_eq!(
            bytes32_hex(&plan.submission_nodes[0].root),
            "0x3c0a2457170aa849c8f7051e23d7874a362be798d95fbb333c901c6cf19dca5a"
        );
        assert_eq!(plan.submission_nodes[0].height, 0);
        let proof = plan.segment_tree.proof_at(0).unwrap();
        assert_eq!(proof.lemma.len(), 1);
        assert!(proof.path.is_empty());
    }

    #[test]
    fn build_upload_plan_matches_go_root_for_two_segment_payload() {
        let mut raw = vec![0_u8; 300_000];
        for (index, byte) in raw.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        let plan = build_upload_plan(&raw).unwrap();
        assert_eq!(
            bytes32_hex(&plan.root),
            "0x04f3f3c1a9b94c408cc91624244806a8ab53ffc5842647189d4060cf39d58318"
        );
        assert_eq!(plan.submission_nodes.len(), 2);
        assert_eq!(
            bytes32_hex(&plan.submission_nodes[0].root),
            "0x4d533607c0f4423a9287d761e7394aa61552adb7d6a080cdb278ddb65b2eacb7"
        );
        assert_eq!(plan.submission_nodes[0].height, 10);
        assert_eq!(
            bytes32_hex(&plan.submission_nodes[1].root),
            "0x2c952a66f5595358191832ebb83c766db03296f5e269f5a27508d8fce86c68d9"
        );
        assert_eq!(plan.submission_nodes[1].height, 8);
        let proof = plan.segment_tree.proof_at(0).unwrap();
        assert_eq!(proof.path, vec![true]);
        assert_eq!(proof.lemma.len(), 3);
    }
}
