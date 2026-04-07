mod sync;
mod zero_g;

pub use sync::{
    build_checkpoint_step_id, build_checkpoint_write_plan, build_remote_encryption_aad,
    build_stream_tags, decrypt_remote_payload, derive_remote_data_key_hkdf,
    derive_remote_data_key_legacy, encode_single_stream_write, encrypt_remote_payload,
    normalize_private_key_hex, normalize_remote_stream_id, prepare_checkpoint_write,
    PreparedCheckpointWrite, RemoteEncryptedKvEnvelope, MEMORY_CHECKPOINTS_LATEST_KEY,
};
pub use zero_g::{
    execute_zero_g_checkpoint_job, zero_g_executor_support_reason, zero_g_executor_supported,
};

use anyhow::{anyhow, Context, Result};
use companion_config::{get_config_dir, CheckpointSyncConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;
use tokio::sync::Mutex as AsyncMutex;

const DEFAULT_STATE_VERSION: u64 = 1;
const MAX_PERSISTED_TERMINAL_JOBS: usize = 64;

type ExecutorFuture = Pin<Box<dyn Future<Output = Result<CheckpointJobResult>> + Send>>;
type StepFuture = Pin<Box<dyn Future<Output = Result<Option<CheckpointJobStatus>>> + Send>>;
type CheckpointJobExecutor = dyn Fn(CheckpointJobExecution) -> ExecutorFuture + Send + Sync;
type StepUpdater = dyn Fn(String, Option<String>) -> StepFuture + Send + Sync;
type Clock = dyn Fn() -> u64 + Send + Sync;

fn default_state_version() -> u64 {
    DEFAULT_STATE_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobLocalAckPlan {
    pub remote_storage_keys: Vec<String>,
    pub generation: String,
    pub committed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobPublishBundle {
    pub generation: String,
    pub committed_at: u64,
    pub coverage_day: String,
    pub latest_pointer: Value,
    pub latest_pointer_payload: String,
    pub history: Value,
    pub history_payload: String,
    pub manifest: Value,
    pub manifest_payload: String,
    pub artifact_payloads: BTreeMap<String, String>,
    pub local_ack_plan: CheckpointJobLocalAckPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobResult {
    pub latest_pointer: Value,
    pub latest_pointer_payload: String,
    pub history: Value,
    pub history_payload: String,
    pub manifest: Value,
    pub manifest_payload: String,
    pub verification_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_error: Option<String>,
    pub local_ack_plan: CheckpointJobLocalAckPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobRecord {
    pub job_id: String,
    pub generation: String,
    pub state: String,
    pub stage: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub attempt_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed_steps: Vec<String>,
    pub publish_bundle: CheckpointJobPublishBundle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<CheckpointJobResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobStatus {
    pub job_id: String,
    pub generation: String,
    pub state: String,
    pub stage: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub attempt_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed_steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<CheckpointJobResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobSubmitInput {
    pub generation: String,
    pub publish_bundle: CheckpointJobPublishBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobSubmitResult {
    pub ok: bool,
    pub accepted: bool,
    pub job: CheckpointJobStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointJobResumeState {
    #[serde(default)]
    pub completed_steps: Vec<String>,
}

#[derive(Clone)]
pub struct CheckpointJobExecution {
    pub job_id: String,
    pub generation: String,
    pub publish_bundle: CheckpointJobPublishBundle,
    pub attempt_count: u64,
    pub resume_state: CheckpointJobResumeState,
    mark_step_completed: Arc<StepUpdater>,
}

impl CheckpointJobExecution {
    pub async fn mark_step_completed(&self, step: &str) -> Result<Option<CheckpointJobStatus>> {
        self.mark_progress(step, None).await
    }

    pub async fn mark_progress(
        &self,
        step: &str,
        display_stage: Option<&str>,
    ) -> Result<Option<CheckpointJobStatus>> {
        (self.mark_step_completed)(
            step.to_string(),
            display_stage.map(|value| value.trim().to_string()),
        )
        .await
    }
}

pub fn build_checkpoint_job_result(
    publish_bundle: &CheckpointJobPublishBundle,
    verification_status: &str,
    verification_error: Option<&str>,
) -> CheckpointJobResult {
    CheckpointJobResult {
        latest_pointer: publish_bundle.latest_pointer.clone(),
        latest_pointer_payload: publish_bundle.latest_pointer_payload.clone(),
        history: publish_bundle.history.clone(),
        history_payload: publish_bundle.history_payload.clone(),
        manifest: publish_bundle.manifest.clone(),
        manifest_payload: publish_bundle.manifest_payload.clone(),
        verification_status: verification_status.trim().to_string(),
        verification_error: verification_error
            .map(trim_non_empty)
            .filter(|value| !value.is_empty()),
        local_ack_plan: publish_bundle.local_ack_plan.clone(),
    }
}

pub async fn execute_checkpoint_publish_bundle<F, Fut>(
    config: &CheckpointSyncConfig,
    execution: &CheckpointJobExecution,
    mut write_committed: F,
) -> Result<CheckpointJobResult>
where
    F: FnMut(PreparedCheckpointWrite) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let writes = build_checkpoint_write_plan(config, &execution.publish_bundle)?;
    for write in writes {
        if execution
            .resume_state
            .completed_steps
            .iter()
            .any(|step| step == &write.step_id)
        {
            continue;
        }
        write_committed(write.clone()).await?;
        execution
            .mark_progress(&write.step_id, Some(&write.stage))
            .await?;
    }

    Ok(build_checkpoint_job_result(
        &execution.publish_bundle,
        "pending",
        Some("verification_unavailable"),
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointJobSnapshot {
    #[serde(default = "default_state_version")]
    version: u64,
    #[serde(default)]
    jobs: Vec<CheckpointJobRecord>,
}

impl Default for CheckpointJobSnapshot {
    fn default() -> Self {
        Self {
            version: DEFAULT_STATE_VERSION,
            jobs: Vec::new(),
        }
    }
}

#[derive(Debug, Default)]
struct CheckpointStoreInner {
    loaded: bool,
    snapshot: CheckpointJobSnapshot,
}

#[derive(Debug, Clone)]
pub struct CheckpointJobStore {
    inner: Arc<Mutex<CheckpointStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
}

struct CheckpointJobRunnerInner {
    store: CheckpointJobStore,
    executor: Option<Arc<CheckpointJobExecutor>>,
    now: Arc<Clock>,
    submit_locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    running_jobs: AsyncMutex<HashSet<String>>,
}

#[derive(Clone)]
pub struct CheckpointJobRunner {
    inner: Arc<CheckpointJobRunnerInner>,
}

impl CheckpointJobStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(CheckpointStoreInner::default())),
            primary_path: config_dir.join("checkpoint-jobs.json"),
            backup_path: config_dir.join("checkpoint-jobs.json.bak"),
        }
    }

    fn load_snapshot(&self) -> Result<CheckpointJobSnapshot> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner.snapshot.clone())
    }

    fn save_snapshot(&self, snapshot: CheckpointJobSnapshot) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = normalize_snapshot(snapshot);
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    #[cfg(test)]
    fn replace_snapshot_for_tests(&self, snapshot: CheckpointJobSnapshot) -> Result<()> {
        self.save_snapshot(snapshot)
    }

    #[cfg(test)]
    fn raw_snapshot_for_tests(&self) -> Result<CheckpointJobSnapshot> {
        self.load_snapshot()
    }

    fn ensure_loaded_locked(&self, inner: &mut CheckpointStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_snapshot(&self.primary_path, &self.backup_path)?;
        inner.loaded = true;
        Ok(())
    }
}

impl CheckpointJobRunner {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        Self::build(
            CheckpointJobStore::new_in(config_dir),
            None,
            Arc::new(now_millis),
        )
    }

    pub fn with_executor_in<P, F, Fut>(config_dir: P, executor: F) -> Self
    where
        P: Into<PathBuf>,
        F: Fn(CheckpointJobExecution) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<CheckpointJobResult>> + Send + 'static,
    {
        Self::build(
            CheckpointJobStore::new_in(config_dir),
            Some(boxed_executor(executor)),
            Arc::new(now_millis),
        )
    }

    #[cfg(test)]
    fn with_store_and_executor<F, Fut>(
        store: CheckpointJobStore,
        executor: Option<F>,
        now: Arc<Clock>,
    ) -> Self
    where
        F: Fn(CheckpointJobExecution) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<CheckpointJobResult>> + Send + 'static,
    {
        let executor = executor.map(boxed_executor);
        Self::build(store, executor, now)
    }

    fn build(
        store: CheckpointJobStore,
        executor: Option<Arc<CheckpointJobExecutor>>,
        now: Arc<Clock>,
    ) -> Self {
        Self {
            inner: Arc::new(CheckpointJobRunnerInner {
                store,
                executor,
                now,
                submit_locks: AsyncMutex::new(HashMap::new()),
                running_jobs: AsyncMutex::new(HashSet::new()),
            }),
        }
    }

    pub fn is_available(&self) -> bool {
        self.inner.executor.is_some()
    }

    pub async fn submit(
        &self,
        input: CheckpointJobSubmitInput,
    ) -> Result<CheckpointJobSubmitResult> {
        if !self.is_available() {
            anyhow::bail!("memory_checkpoint_jobs_unavailable");
        }
        let input = normalize_submit_input(input)?;
        let generation = input.generation.clone();
        let generation_lock = {
            let mut locks = self.inner.submit_locks.lock().await;
            locks
                .entry(generation.clone())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        let guard = generation_lock.lock().await;

        let result = (|| -> Result<CheckpointJobSubmitResult> {
            let snapshot = self.inner.store.load_snapshot()?;
            if let Some(existing) = find_job_by_generation(&snapshot, &generation) {
                if matches!(existing.state.as_str(), "queued" | "running") {
                    let runner = self.clone();
                    let job_id = existing.job_id.clone();
                    tokio::spawn(async move {
                        let _ = runner.execute_job(&job_id).await;
                    });
                }
                return Ok(CheckpointJobSubmitResult {
                    ok: true,
                    accepted: existing.state == "queued",
                    job: job_status(existing),
                });
            }

            let created_at = (self.inner.now)();
            let record = CheckpointJobRecord {
                job_id: build_job_id(&input.generation),
                generation: input.generation.clone(),
                state: "queued".to_string(),
                stage: "queued".to_string(),
                created_at,
                updated_at: created_at,
                started_at: None,
                finished_at: None,
                attempt_count: 0,
                error: None,
                completed_steps: Vec::new(),
                publish_bundle: input.publish_bundle,
                result: None,
            };

            let mut next = snapshot;
            next.jobs.push(record.clone());
            self.inner.store.save_snapshot(next)?;

            let runner = self.clone();
            let job_id = record.job_id.clone();
            tokio::spawn(async move {
                let _ = runner.execute_job(&job_id).await;
            });

            Ok(CheckpointJobSubmitResult {
                ok: true,
                accepted: true,
                job: job_status(&record),
            })
        })();

        drop(guard);
        let mut locks = self.inner.submit_locks.lock().await;
        if locks
            .get(&generation)
            .map(|existing| Arc::ptr_eq(existing, &generation_lock))
            .unwrap_or(false)
        {
            locks.remove(&generation);
        }
        result
    }

    pub async fn get_status(&self, job_id: &str) -> Result<Option<CheckpointJobStatus>> {
        let job_id = trim_non_empty(job_id);
        if job_id.is_empty() {
            return Ok(None);
        }
        let snapshot = self.inner.store.load_snapshot()?;
        Ok(snapshot
            .jobs
            .iter()
            .find(|job| job.job_id == job_id)
            .map(job_status))
    }

    pub async fn resume_pending_jobs(&self) -> Result<Vec<Option<CheckpointJobStatus>>> {
        if !self.is_available() {
            return Ok(Vec::new());
        }
        let snapshot = self.inner.store.load_snapshot()?;
        let resumable = snapshot
            .jobs
            .iter()
            .filter(|job| matches!(job.state.as_str(), "queued" | "running"))
            .map(|job| job.job_id.clone())
            .collect::<Vec<_>>();
        let mut results = Vec::with_capacity(resumable.len());
        for job_id in resumable {
            results.push(self.execute_job(&job_id).await?);
        }
        Ok(results)
    }

    async fn execute_job(&self, job_id: &str) -> Result<Option<CheckpointJobStatus>> {
        if !self.is_available() {
            return Ok(None);
        }

        {
            let mut running = self.inner.running_jobs.lock().await;
            if running.contains(job_id) {
                drop(running);
                return self.get_status(job_id).await;
            }
            running.insert(job_id.to_string());
        }

        let result = self.execute_job_inner(job_id).await;
        let mut running = self.inner.running_jobs.lock().await;
        running.remove(job_id);
        result
    }

    async fn execute_job_inner(&self, job_id: &str) -> Result<Option<CheckpointJobStatus>> {
        let executor = self
            .inner
            .executor
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("memory_checkpoint_jobs_unavailable"))?;
        let snapshot = self.inner.store.load_snapshot()?;
        let Some(current) = snapshot
            .jobs
            .iter()
            .find(|job| job.job_id == job_id)
            .cloned()
        else {
            return Ok(None);
        };
        if current.state == "completed" {
            return Ok(Some(job_status(&current)));
        }

        let started_at = current.started_at.unwrap_or_else(|| (self.inner.now)());
        let completed_steps = normalize_string_vec(&current.completed_steps);
        let mut next = snapshot;
        if let Some(index) = find_job_index_by_id(&next, job_id) {
            next.jobs[index].state = "running".to_string();
            next.jobs[index].stage = if !completed_steps.is_empty() && current.stage != "queued" {
                current.stage.clone()
            } else {
                "running".to_string()
            };
            next.jobs[index].started_at = Some(started_at);
            next.jobs[index].updated_at = (self.inner.now)();
            next.jobs[index].attempt_count = current.attempt_count.saturating_add(1);
            next.jobs[index].error = None;
            next.jobs[index].completed_steps = completed_steps.clone();
        }
        self.inner.store.save_snapshot(next)?;

        let runner = self.clone();
        let job_id_owned = job_id.to_string();
        let mark_step_completed: Arc<StepUpdater> =
            Arc::new(move |step: String, display_stage: Option<String>| {
                let runner = runner.clone();
                let job_id = job_id_owned.clone();
                Box::pin(async move {
                    runner
                        .mark_step_completed(&job_id, &step, display_stage.as_deref())
                        .await
                })
            });

        let execution = CheckpointJobExecution {
            job_id: current.job_id.clone(),
            generation: current.generation.clone(),
            publish_bundle: current.publish_bundle.clone(),
            attempt_count: current.attempt_count.saturating_add(1),
            resume_state: CheckpointJobResumeState {
                completed_steps: completed_steps.clone(),
            },
            mark_step_completed,
        };

        match executor(execution).await {
            Ok(result) => {
                let result = normalize_result(result)?;
                let mut next = self.inner.store.load_snapshot()?;
                let Some(index) = find_job_index_by_id(&next, job_id) else {
                    return Ok(None);
                };
                let final_completed_steps = normalize_string_vec(&next.jobs[index].completed_steps);
                next.jobs[index].state = "completed".to_string();
                next.jobs[index].stage = "completed".to_string();
                next.jobs[index].updated_at = (self.inner.now)();
                next.jobs[index].finished_at = Some((self.inner.now)());
                next.jobs[index].error = None;
                next.jobs[index].completed_steps = final_completed_steps;
                next.jobs[index].result = Some(result);
                self.inner.store.save_snapshot(next.clone())?;
                Ok(find_job_by_id(&next, job_id).map(job_status))
            }
            Err(error) => {
                let mut next = self.inner.store.load_snapshot()?;
                let Some(index) = find_job_index_by_id(&next, job_id) else {
                    return Ok(None);
                };
                next.jobs[index].state = "failed".to_string();
                next.jobs[index].stage = "failed".to_string();
                next.jobs[index].updated_at = (self.inner.now)();
                next.jobs[index].finished_at = Some((self.inner.now)());
                next.jobs[index].error = Some(error.to_string());
                next.jobs[index].completed_steps =
                    normalize_string_vec(&next.jobs[index].completed_steps);
                self.inner.store.save_snapshot(next.clone())?;
                Ok(find_job_by_id(&next, job_id).map(job_status))
            }
        }
    }

    async fn mark_step_completed(
        &self,
        job_id: &str,
        step: &str,
        display_stage: Option<&str>,
    ) -> Result<Option<CheckpointJobStatus>> {
        let step = trim_non_empty(step);
        if step.is_empty() {
            anyhow::bail!("checkpoint_job_step_invalid");
        }
        let mut next = self.inner.store.load_snapshot()?;
        let Some(index) = find_job_index_by_id(&next, job_id) else {
            return Ok(None);
        };
        let mut completed_steps = normalize_string_vec(&next.jobs[index].completed_steps);
        if !completed_steps.iter().any(|item| item == &step) {
            completed_steps.push(step.clone());
        }
        next.jobs[index].state = "running".to_string();
        next.jobs[index].stage = display_stage
            .map(trim_non_empty)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| step.clone());
        next.jobs[index].updated_at = (self.inner.now)();
        next.jobs[index].completed_steps = completed_steps;
        self.inner.store.save_snapshot(next.clone())?;
        Ok(find_job_by_id(&next, job_id).map(job_status))
    }
}

fn normalize_submit_input(input: CheckpointJobSubmitInput) -> Result<CheckpointJobSubmitInput> {
    let generation = trim_non_empty(&input.generation);
    if generation.is_empty() {
        anyhow::bail!("checkpoint_job_invalid_request");
    }
    let publish_bundle = normalize_publish_bundle(input.publish_bundle)?;
    if publish_bundle.generation != generation {
        anyhow::bail!("checkpoint_job_generation_mismatch");
    }
    Ok(CheckpointJobSubmitInput {
        generation,
        publish_bundle,
    })
}

fn normalize_publish_bundle(
    input: CheckpointJobPublishBundle,
) -> Result<CheckpointJobPublishBundle> {
    let generation = trim_non_empty(&input.generation);
    let coverage_day = trim_non_empty(&input.coverage_day);
    if generation.is_empty() || coverage_day.is_empty() || input.committed_at == 0 {
        anyhow::bail!("checkpoint_job_invalid_request");
    }
    let local_ack_plan = normalize_local_ack_plan(input.local_ack_plan)?;
    Ok(CheckpointJobPublishBundle {
        generation,
        committed_at: input.committed_at,
        coverage_day,
        latest_pointer: input.latest_pointer,
        latest_pointer_payload: trim_non_empty(&input.latest_pointer_payload),
        history: input.history,
        history_payload: trim_non_empty(&input.history_payload),
        manifest: input.manifest,
        manifest_payload: trim_non_empty(&input.manifest_payload),
        artifact_payloads: input
            .artifact_payloads
            .into_iter()
            .filter_map(|(key, value)| {
                let key = trim_non_empty(&key);
                let value = trim_non_empty(&value);
                if key.is_empty() || value.is_empty() {
                    None
                } else {
                    Some((key, value))
                }
            })
            .collect(),
        local_ack_plan,
    })
}

fn normalize_local_ack_plan(input: CheckpointJobLocalAckPlan) -> Result<CheckpointJobLocalAckPlan> {
    let generation = trim_non_empty(&input.generation);
    if generation.is_empty() || input.committed_at == 0 {
        anyhow::bail!("checkpoint_job_invalid_request");
    }
    Ok(CheckpointJobLocalAckPlan {
        remote_storage_keys: normalize_string_vec(&input.remote_storage_keys),
        generation,
        committed_at: input.committed_at,
    })
}

fn normalize_result(input: CheckpointJobResult) -> Result<CheckpointJobResult> {
    let verification_status = trim_non_empty(&input.verification_status);
    let local_ack_plan = normalize_local_ack_plan(input.local_ack_plan)?;
    let latest_pointer_payload = trim_non_empty(&input.latest_pointer_payload);
    let history_payload = trim_non_empty(&input.history_payload);
    let manifest_payload = trim_non_empty(&input.manifest_payload);
    if latest_pointer_payload.is_empty()
        || history_payload.is_empty()
        || manifest_payload.is_empty()
    {
        anyhow::bail!("checkpoint_job_invalid_request");
    }
    Ok(CheckpointJobResult {
        latest_pointer: input.latest_pointer,
        latest_pointer_payload,
        history: input.history,
        history_payload,
        manifest: input.manifest,
        manifest_payload,
        verification_status: if verification_status.is_empty() {
            "unknown".to_string()
        } else {
            verification_status
        },
        verification_error: input
            .verification_error
            .as_deref()
            .map(trim_non_empty)
            .filter(|value| !value.is_empty()),
        local_ack_plan,
    })
}

fn normalize_snapshot(snapshot: CheckpointJobSnapshot) -> CheckpointJobSnapshot {
    let jobs = snapshot
        .jobs
        .into_iter()
        .filter_map(|job| normalize_record(job).ok())
        .collect::<Vec<_>>();
    let mut active_jobs = jobs
        .iter()
        .filter(|job| matches!(job.state.as_str(), "queued" | "running"))
        .cloned()
        .collect::<Vec<_>>();
    let mut terminal_jobs = jobs
        .iter()
        .filter(|job| matches!(job.state.as_str(), "completed" | "failed"))
        .cloned()
        .collect::<Vec<_>>();
    sort_jobs_desc(&mut active_jobs);
    sort_jobs_desc(&mut terminal_jobs);
    terminal_jobs.truncate(MAX_PERSISTED_TERMINAL_JOBS);
    let mut normalized = active_jobs;
    normalized.extend(terminal_jobs);
    sort_jobs_desc(&mut normalized);
    CheckpointJobSnapshot {
        version: DEFAULT_STATE_VERSION,
        jobs: normalized,
    }
}

fn boxed_executor<F, Fut>(executor: F) -> Arc<CheckpointJobExecutor>
where
    F: Fn(CheckpointJobExecution) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CheckpointJobResult>> + Send + 'static,
{
    Arc::new(move |input| -> ExecutorFuture { Box::pin(executor(input)) })
}

fn normalize_record(input: CheckpointJobRecord) -> Result<CheckpointJobRecord> {
    let job_id = trim_non_empty(&input.job_id);
    let generation = trim_non_empty(&input.generation);
    if job_id.is_empty() || generation.is_empty() || input.created_at == 0 || input.updated_at == 0
    {
        anyhow::bail!("invalid checkpoint job record");
    }
    Ok(CheckpointJobRecord {
        job_id,
        generation,
        state: normalize_state(&input.state),
        stage: normalize_stage(&input.stage),
        created_at: input.created_at,
        updated_at: input.updated_at,
        started_at: positive_option(input.started_at),
        finished_at: positive_option(input.finished_at),
        attempt_count: input.attempt_count,
        error: input
            .error
            .as_deref()
            .map(trim_non_empty)
            .filter(|value| !value.is_empty()),
        completed_steps: normalize_string_vec(&input.completed_steps),
        publish_bundle: normalize_publish_bundle(input.publish_bundle)?,
        result: input.result.map(normalize_result).transpose()?,
    })
}

fn normalize_state(value: &str) -> String {
    match value.trim() {
        "queued" | "running" | "completed" | "failed" => value.trim().to_string(),
        _ => "queued".to_string(),
    }
}

fn normalize_stage(value: &str) -> String {
    let trimmed = trim_non_empty(value);
    if trimmed.is_empty() {
        "queued".to_string()
    } else {
        trimmed
    }
}

fn positive_option(value: Option<u64>) -> Option<u64> {
    value.filter(|item| *item > 0)
}

fn normalize_string_vec(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = trim_non_empty(value);
        if trimmed.is_empty() || normalized.iter().any(|item| item == &trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }
    normalized
}

fn sort_jobs_desc(jobs: &mut [CheckpointJobRecord]) {
    jobs.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| right.job_id.cmp(&left.job_id))
    });
}

fn load_snapshot(primary_path: &Path, backup_path: &Path) -> Result<CheckpointJobSnapshot> {
    match read_snapshot(primary_path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => Ok(read_snapshot(backup_path)?.unwrap_or_default()),
        Err(primary_error) => match read_snapshot(backup_path) {
            Ok(Some(snapshot)) => Ok(snapshot),
            Ok(None) => Ok(CheckpointJobSnapshot::default()),
            Err(_) => {
                eprintln!(
                    "Failed to read checkpoint job snapshot ({}); starting fresh.",
                    primary_error
                );
                Ok(CheckpointJobSnapshot::default())
            }
        },
    }
}

fn read_snapshot(path: &Path) -> Result<Option<CheckpointJobSnapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read checkpoint snapshot: {}", path.display()))?;
    let snapshot = serde_json::from_str::<CheckpointJobSnapshot>(&raw)
        .with_context(|| format!("Failed to parse checkpoint snapshot: {}", path.display()))?;
    Ok(Some(normalize_snapshot(snapshot)))
}

fn persist_snapshot(
    primary_path: &Path,
    backup_path: &Path,
    snapshot: &CheckpointJobSnapshot,
) -> Result<()> {
    if let Some(parent) = primary_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create checkpoint snapshot dir: {}",
                parent.display()
            )
        })?;
    }
    let temp_dir = primary_path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(temp_dir).with_context(|| {
        format!(
            "Failed to create temp checkpoint snapshot near {}",
            primary_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut temp, snapshot)
        .context("Failed to encode checkpoint snapshot")?;
    use std::io::Write;
    temp.write_all(b"\n")
        .context("Failed to finalize checkpoint snapshot")?;
    temp.flush()
        .context("Failed to flush checkpoint snapshot")?;

    if primary_path.exists() {
        if backup_path.exists() {
            let _ = fs::remove_file(backup_path);
        }
        fs::copy(primary_path, backup_path).with_context(|| {
            format!(
                "Failed to write checkpoint backup: {}",
                backup_path.display()
            )
        })?;
    }

    temp.persist(primary_path)
        .map_err(|error| anyhow!(error.error))
        .with_context(|| {
            format!(
                "Failed to persist checkpoint snapshot: {}",
                primary_path.display()
            )
        })?;
    Ok(())
}

fn build_job_id(generation: &str) -> String {
    format!("checkpoint-{generation}")
}

fn job_status(job: &CheckpointJobRecord) -> CheckpointJobStatus {
    CheckpointJobStatus {
        job_id: job.job_id.clone(),
        generation: job.generation.clone(),
        state: job.state.clone(),
        stage: job.stage.clone(),
        created_at: job.created_at,
        updated_at: job.updated_at,
        attempt_count: job.attempt_count,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error: job.error.clone(),
        completed_steps: job.completed_steps.clone(),
        result: job.result.clone(),
    }
}

fn find_job_index_by_id(snapshot: &CheckpointJobSnapshot, job_id: &str) -> Option<usize> {
    snapshot.jobs.iter().position(|job| job.job_id == job_id)
}

fn find_job_by_id<'a>(
    snapshot: &'a CheckpointJobSnapshot,
    job_id: &str,
) -> Option<&'a CheckpointJobRecord> {
    snapshot.jobs.iter().find(|job| job.job_id == job_id)
}

fn find_job_by_generation<'a>(
    snapshot: &'a CheckpointJobSnapshot,
    generation: &str,
) -> Option<&'a CheckpointJobRecord> {
    snapshot
        .jobs
        .iter()
        .find(|job| job.generation == generation)
}

fn trim_non_empty(value: &str) -> String {
    value.trim().to_string()
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
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::sync::oneshot;

    const COMMITTED_AT: u64 = 1_773_312_000_000;

    fn make_bundle(generation: &str) -> CheckpointJobPublishBundle {
        let committed_at = COMMITTED_AT;
        CheckpointJobPublishBundle {
            generation: generation.to_string(),
            committed_at,
            coverage_day: "2026-03-12".to_string(),
            latest_pointer: json!({}),
            latest_pointer_payload: "{}".to_string(),
            history: json!({}),
            history_payload: "{}".to_string(),
            manifest: json!({}),
            manifest_payload: "{}".to_string(),
            artifact_payloads: BTreeMap::new(),
            local_ack_plan: CheckpointJobLocalAckPlan {
                remote_storage_keys: Vec::new(),
                generation: generation.to_string(),
                committed_at,
            },
        }
    }

    fn make_sync_config() -> CheckpointSyncConfig {
        CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1"
                .to_string(),
            kv_rpc: Some("https://kv-rpc-galileo.0g.ai".to_string()),
        }
    }

    fn make_publish_bundle_with_artifacts(generation: &str) -> CheckpointJobPublishBundle {
        let committed_at = COMMITTED_AT;
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
            latest_pointer_payload: "{\"latest\":true}".to_string(),
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
                    }
                ],
            }),
            manifest_payload: "{\"manifest\":true}".to_string(),
            artifact_payloads: BTreeMap::from([(
                artifact_storage_key,
                "{\"nodes\":true}".to_string(),
            )]),
            local_ack_plan: CheckpointJobLocalAckPlan {
                remote_storage_keys: Vec::new(),
                generation: generation.to_string(),
                committed_at,
            },
        }
    }

    #[tokio::test]
    async fn submit_dedupes_same_generation() {
        let temp_dir = TempDir::new().unwrap();
        let executions = Arc::new(AsyncMutex::new(0_usize));
        let executions_clone = executions.clone();
        let runner = CheckpointJobRunner::with_executor_in(temp_dir.path(), move |job| {
            let executions = executions_clone.clone();
            async move {
                let mut guard = executions.lock().await;
                *guard += 1;
                Ok(build_checkpoint_job_result(
                    &job.publish_bundle,
                    "verified",
                    None,
                ))
            }
        });

        let generation = "2026-03-12T08-00-00.000Z";
        let bundle = make_bundle(generation);
        let first = runner
            .submit(CheckpointJobSubmitInput {
                generation: generation.to_string(),
                publish_bundle: bundle.clone(),
            })
            .await
            .unwrap();
        let second = runner
            .submit(CheckpointJobSubmitInput {
                generation: generation.to_string(),
                publish_bundle: bundle,
            })
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let count = *executions.lock().await;
        assert_eq!(first.job.job_id, second.job.job_id);
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn resume_pending_jobs_reuses_completed_steps() {
        let temp_dir = TempDir::new().unwrap();
        let store = CheckpointJobStore::new_in(temp_dir.path());
        let generation = "2026-03-12T08-00-00.000Z";
        let bundle = make_bundle(generation);
        store
            .replace_snapshot_for_tests(CheckpointJobSnapshot {
                version: DEFAULT_STATE_VERSION,
                jobs: vec![CheckpointJobRecord {
                    job_id: build_job_id(generation),
                    generation: generation.to_string(),
                    state: "running".to_string(),
                    stage: "publish_artifacts".to_string(),
                    created_at: bundle.committed_at,
                    updated_at: bundle.committed_at + 1,
                    started_at: Some(bundle.committed_at + 1),
                    finished_at: None,
                    attempt_count: 1,
                    error: None,
                    completed_steps: vec!["publish_artifacts".to_string()],
                    publish_bundle: bundle.clone(),
                    result: None,
                }],
            })
            .unwrap();
        let seen_steps = Arc::new(AsyncMutex::new(Vec::new()));
        let seen_steps_clone = seen_steps.clone();
        let runner = CheckpointJobRunner::with_store_and_executor(
            store,
            Some(move |job: CheckpointJobExecution| {
                let seen_steps = seen_steps_clone.clone();
                async move {
                    *seen_steps.lock().await = job.resume_state.completed_steps.clone();
                    job.mark_step_completed("write_history").await?;
                    Ok(build_checkpoint_job_result(
                        &job.publish_bundle,
                        "verified",
                        None,
                    ))
                }
            }),
            Arc::new(|| 1_700_000_010_000_u64),
        );

        let resumed = runner.resume_pending_jobs().await.unwrap();
        assert_eq!(resumed.len(), 1);
        assert_eq!(
            *seen_steps.lock().await,
            vec!["publish_artifacts".to_string()]
        );
        let status = resumed[0].as_ref().unwrap();
        assert_eq!(status.state, "completed");
        assert_eq!(
            status.completed_steps,
            vec!["publish_artifacts", "write_history"]
        );
    }

    #[tokio::test]
    async fn submit_persists_in_flight_progress_for_status_polling() {
        let temp_dir = TempDir::new().unwrap();
        let (progress_tx, progress_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let progress_tx = Arc::new(AsyncMutex::new(Some(progress_tx)));
        let release_rx = Arc::new(AsyncMutex::new(Some(release_rx)));
        let runner = CheckpointJobRunner::with_executor_in(temp_dir.path(), move |job| {
            let progress_tx = progress_tx.clone();
            let release_rx = release_rx.clone();
            async move {
                job.mark_step_completed("publish_artifacts").await?;
                if let Some(sender) = progress_tx.lock().await.take() {
                    let _ = sender.send(());
                }
                if let Some(receiver) = release_rx.lock().await.take() {
                    let _ = receiver.await;
                }
                Ok(build_checkpoint_job_result(
                    &job.publish_bundle,
                    "verified",
                    None,
                ))
            }
        });

        let generation = "2026-03-12T08-00-00.000Z";
        let submit = runner
            .submit(CheckpointJobSubmitInput {
                generation: generation.to_string(),
                publish_bundle: make_bundle(generation),
            })
            .await
            .unwrap();
        let _ = progress_rx.await;
        let in_flight = runner
            .get_status(&submit.job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(in_flight.state, "running");
        assert_eq!(in_flight.stage, "publish_artifacts");
        assert_eq!(in_flight.completed_steps, vec!["publish_artifacts"]);
        let _ = release_tx.send(());
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let completed = runner
            .get_status(&submit.job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.state, "completed");
    }

    #[tokio::test]
    async fn snapshot_trims_older_terminal_jobs() {
        let temp_dir = TempDir::new().unwrap();
        let store = CheckpointJobStore::new_in(temp_dir.path());
        let base = make_bundle("2026-03-12T08-00-00.000Z");
        let mut jobs = Vec::new();
        for index in 0..70_u64 {
            jobs.push(CheckpointJobRecord {
                job_id: format!("checkpoint-terminal-{index}"),
                generation: format!("2026-03-12T08-00-{index:02}.000Z"),
                state: if index % 2 == 0 {
                    "completed".to_string()
                } else {
                    "failed".to_string()
                },
                stage: if index % 2 == 0 {
                    "completed".to_string()
                } else {
                    "failed".to_string()
                },
                created_at: base.committed_at + index,
                updated_at: base.committed_at + index,
                started_at: Some(base.committed_at + index),
                finished_at: Some(base.committed_at + index + 1),
                attempt_count: 1,
                error: if index % 2 == 0 {
                    None
                } else {
                    Some("checkpoint_job_failed".to_string())
                },
                completed_steps: Vec::new(),
                publish_bundle: CheckpointJobPublishBundle {
                    generation: format!("2026-03-12T08-00-{index:02}.000Z"),
                    ..base.clone()
                },
                result: if index % 2 == 0 {
                    Some(build_checkpoint_job_result(
                        &CheckpointJobPublishBundle {
                            generation: format!("2026-03-12T08-00-{index:02}.000Z"),
                            ..base.clone()
                        },
                        "verified",
                        None,
                    ))
                } else {
                    None
                },
            });
        }
        jobs.push(CheckpointJobRecord {
            job_id: "checkpoint-running".to_string(),
            generation: "2026-03-12T09-00-00.000Z".to_string(),
            state: "running".to_string(),
            stage: "publish_artifacts".to_string(),
            created_at: base.committed_at + 10_000,
            updated_at: base.committed_at + 10_001,
            started_at: Some(base.committed_at + 10_001),
            finished_at: None,
            attempt_count: 2,
            error: None,
            completed_steps: vec!["publish_artifacts".to_string()],
            publish_bundle: CheckpointJobPublishBundle {
                generation: "2026-03-12T09-00-00.000Z".to_string(),
                ..base.clone()
            },
            result: None,
        });
        store
            .replace_snapshot_for_tests(CheckpointJobSnapshot {
                version: DEFAULT_STATE_VERSION,
                jobs,
            })
            .unwrap();
        let snapshot = store.raw_snapshot_for_tests().unwrap();
        let terminal = snapshot
            .jobs
            .iter()
            .filter(|job| matches!(job.state.as_str(), "completed" | "failed"))
            .count();
        assert_eq!(terminal, 64);
        assert!(snapshot
            .jobs
            .iter()
            .any(|job| job.job_id == "checkpoint-running"));
        assert!(!snapshot
            .jobs
            .iter()
            .any(|job| job.job_id == "checkpoint-terminal-0"));
    }

    #[tokio::test]
    async fn mark_progress_keeps_stage_label_separate_from_step_id() {
        let temp_dir = TempDir::new().unwrap();
        let (progress_tx, progress_rx) = oneshot::channel::<()>();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let progress_tx = Arc::new(AsyncMutex::new(Some(progress_tx)));
        let release_rx = Arc::new(AsyncMutex::new(Some(release_rx)));
        let step_id = "publish_artifacts::memory-checkpoints/latest.json".to_string();
        let step_id_for_executor = step_id.clone();

        let runner = CheckpointJobRunner::with_executor_in(temp_dir.path(), move |job| {
            let progress_tx = progress_tx.clone();
            let release_rx = release_rx.clone();
            let step_id = step_id_for_executor.clone();
            async move {
                job.mark_progress(&step_id, Some("publish_artifacts"))
                    .await?;
                if let Some(sender) = progress_tx.lock().await.take() {
                    let _ = sender.send(());
                }
                if let Some(receiver) = release_rx.lock().await.take() {
                    let _ = receiver.await;
                }
                Ok(build_checkpoint_job_result(
                    &job.publish_bundle,
                    "verified",
                    None,
                ))
            }
        });

        let generation = "2026-03-12T08-10-00.000Z";
        let submit = runner
            .submit(CheckpointJobSubmitInput {
                generation: generation.to_string(),
                publish_bundle: make_bundle(generation),
            })
            .await
            .unwrap();
        let _ = progress_rx.await;
        let in_flight = runner
            .get_status(&submit.job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(in_flight.stage, "publish_artifacts");
        assert_eq!(in_flight.completed_steps, vec![step_id.clone()]);

        let _ = release_tx.send(());
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let completed = runner
            .get_status(&submit.job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(completed.completed_steps, vec![step_id]);
    }

    #[tokio::test]
    async fn execute_checkpoint_publish_bundle_skips_completed_step_ids_on_resume() {
        let temp_dir = TempDir::new().unwrap();
        let store = CheckpointJobStore::new_in(temp_dir.path());
        let generation = "2026-03-12T08-20-00.000Z";
        let bundle = make_publish_bundle_with_artifacts(generation);
        let sync_config = make_sync_config();
        let plan = build_checkpoint_write_plan(&sync_config, &bundle).unwrap();
        let already_completed = plan[0].step_id.clone();

        store
            .replace_snapshot_for_tests(CheckpointJobSnapshot {
                version: DEFAULT_STATE_VERSION,
                jobs: vec![CheckpointJobRecord {
                    job_id: build_job_id(generation),
                    generation: generation.to_string(),
                    state: "running".to_string(),
                    stage: "publish_artifacts".to_string(),
                    created_at: bundle.committed_at,
                    updated_at: bundle.committed_at + 1,
                    started_at: Some(bundle.committed_at + 1),
                    finished_at: None,
                    attempt_count: 1,
                    error: None,
                    completed_steps: vec![already_completed.clone()],
                    publish_bundle: bundle.clone(),
                    result: None,
                }],
            })
            .unwrap();

        let writes_seen = Arc::new(AsyncMutex::new(Vec::<String>::new()));
        let writes_seen_clone = writes_seen.clone();
        let config_for_executor = sync_config.clone();
        let runner = CheckpointJobRunner::with_store_and_executor(
            store,
            Some(move |job: CheckpointJobExecution| {
                let writes_seen = writes_seen_clone.clone();
                let sync_config = config_for_executor.clone();
                async move {
                    execute_checkpoint_publish_bundle(&sync_config, &job, |write| {
                        let writes_seen = writes_seen.clone();
                        async move {
                            writes_seen.lock().await.push(write.step_id.clone());
                            Ok(())
                        }
                    })
                    .await
                }
            }),
            Arc::new(|| 1_700_000_020_000_u64),
        );

        let resumed = runner.resume_pending_jobs().await.unwrap();
        let status = resumed[0].as_ref().unwrap();
        let executed_steps = writes_seen.lock().await.clone();

        assert_eq!(executed_steps.len(), 3);
        assert!(!executed_steps.iter().any(|step| step == &already_completed));
        assert_eq!(
            status.completed_steps,
            plan.iter()
                .map(|write| write.step_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            status.result.as_ref().unwrap().verification_status,
            "pending"
        );
        assert_eq!(
            status
                .result
                .as_ref()
                .unwrap()
                .verification_error
                .as_deref(),
            Some("verification_unavailable")
        );
    }
}
