use anyhow::{anyhow, Context, Result};
use companion_config::get_config_dir;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingCronRun {
    pub pending_id: String,
    pub task_id: String,
    pub missed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CronSnapshot {
    #[serde(default)]
    jobs: Vec<Value>,
    #[serde(default)]
    pending: Vec<PendingCronRun>,
}

#[derive(Debug, Default)]
struct CronStoreInner {
    loaded: bool,
    snapshot: CronSnapshot,
}

#[derive(Debug, Clone)]
pub struct CronStore {
    inner: Arc<Mutex<CronStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
}

impl CronStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(CronStoreInner::default())),
            primary_path: config_dir.join("cron-jobs.json"),
            backup_path: config_dir.join("cron-jobs.json.bak"),
        }
    }

    pub fn list_jobs(&self) -> Result<Vec<Value>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner.snapshot.jobs.clone())
    }

    pub fn upsert_job(&self, job: Value) -> Result<String> {
        let task_id = job
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("\"id\" is required."))?
            .to_string();
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        if let Some(index) = inner
            .snapshot
            .jobs
            .iter()
            .position(|item| item.get("id").and_then(Value::as_str) == Some(task_id.as_str()))
        {
            inner.snapshot.jobs[index] = job;
        } else {
            inner.snapshot.jobs.push(job);
        }
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(task_id)
    }

    pub fn remove_job(&self, task_id: &str) -> Result<bool> {
        let task_id = trim_non_empty(task_id);
        if task_id.is_empty() {
            return Ok(false);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let before = inner.snapshot.jobs.len();
        inner
            .snapshot
            .jobs
            .retain(|item| item.get("id").and_then(Value::as_str) != Some(task_id.as_str()));
        let removed = before != inner.snapshot.jobs.len();
        if removed {
            persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        }
        Ok(removed)
    }

    pub fn list_pending_runs(&self) -> Result<Vec<PendingCronRun>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner.snapshot.pending.clone())
    }

    pub fn add_pending_run(&self, task_id: &str) -> Result<PendingCronRun> {
        let task_id = trim_non_empty(task_id);
        if task_id.is_empty() {
            anyhow::bail!("taskId is required");
        }
        let pending = PendingCronRun {
            pending_id: generate_hex_id(),
            task_id,
            missed_at: now_millis(),
        };
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        inner.snapshot.pending.push(pending.clone());
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(pending)
    }

    pub fn ack_pending_runs_value(&self, input: &Value) -> Result<usize> {
        let (pending_ids, task_ids) = normalize_ack_request(input);
        if pending_ids.is_empty() && task_ids.is_empty() {
            return Ok(0);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let before = inner.snapshot.pending.len();
        inner.snapshot.pending.retain(|pending| {
            !pending_ids.iter().any(|item| item == &pending.pending_id)
                && !task_ids.iter().any(|item| item == &pending.task_id)
        });
        let removed = before.saturating_sub(inner.snapshot.pending.len());
        if removed > 0 {
            persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        }
        Ok(removed)
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = CronSnapshot::default();
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut CronStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_snapshot(&self.primary_path, &self.backup_path)?;
        inner.loaded = true;
        Ok(())
    }
}

fn normalize_ack_request(input: &Value) -> (Vec<String>, Vec<String>) {
    if let Some(items) = input.as_array() {
        let task_ids = items
            .iter()
            .filter_map(Value::as_str)
            .map(trim_non_empty)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        return (Vec::new(), task_ids);
    }

    let pending_ids = input
        .get("pendingIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(trim_non_empty)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let task_ids = input
        .get("taskIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(trim_non_empty)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    let single_pending = input
        .get("pendingId")
        .and_then(Value::as_str)
        .map(trim_non_empty)
        .filter(|value| !value.is_empty());
    let single_task = input
        .get("taskId")
        .and_then(Value::as_str)
        .map(trim_non_empty)
        .filter(|value| !value.is_empty());

    let mut normalized_pending_ids = pending_ids;
    if let Some(pending_id) = single_pending {
        normalized_pending_ids.push(pending_id);
    }
    let mut normalized_task_ids = task_ids;
    if let Some(task_id) = single_task {
        normalized_task_ids.push(task_id);
    }

    (normalized_pending_ids, normalized_task_ids)
}

fn load_snapshot(primary_path: &Path, backup_path: &Path) -> Result<CronSnapshot> {
    match read_snapshot(primary_path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => Ok(read_snapshot(backup_path)?.unwrap_or_default()),
        Err(primary_error) => match read_snapshot(backup_path) {
            Ok(Some(snapshot)) => Ok(snapshot),
            Ok(None) => Ok(CronSnapshot::default()),
            Err(_) => {
                eprintln!(
                    "Failed to read cron snapshot ({}); starting fresh.",
                    primary_error
                );
                Ok(CronSnapshot::default())
            }
        },
    }
}

fn read_snapshot(path: &Path) -> Result<Option<CronSnapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read cron snapshot: {}", path.display()))?;
    let parsed = serde_json::from_str::<Value>(&raw)
        .with_context(|| format!("Failed to parse cron snapshot: {}", path.display()))?;
    let jobs = parsed
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pending = parsed
        .get("pending")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_pending_run)
        .collect::<Vec<_>>();
    Ok(Some(CronSnapshot { jobs, pending }))
}

fn normalize_pending_run(value: &Value) -> Option<PendingCronRun> {
    let task_id = value
        .get("taskId")
        .and_then(Value::as_str)
        .map(trim_non_empty)
        .filter(|item| !item.is_empty())?;
    Some(PendingCronRun {
        pending_id: value
            .get("pendingId")
            .and_then(Value::as_str)
            .map(trim_non_empty)
            .filter(|item| !item.is_empty())
            .unwrap_or_else(generate_hex_id),
        task_id,
        missed_at: value
            .get("missedAt")
            .and_then(number_u64)
            .unwrap_or_else(now_millis),
    })
}

fn persist_snapshot(
    primary_path: &Path,
    backup_path: &Path,
    snapshot: &CronSnapshot,
) -> Result<()> {
    if let Some(parent) = primary_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create cron dir: {}", parent.display()))?;
    }
    let temp_dir = primary_path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(temp_dir).with_context(|| {
        format!(
            "Failed to create temp cron snapshot near {}",
            primary_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut temp, snapshot).context("Failed to encode cron snapshot")?;
    use std::io::Write;
    temp.write_all(b"\n")
        .context("Failed to finalize cron snapshot")?;
    temp.flush().context("Failed to flush cron snapshot")?;

    if primary_path.exists() {
        if backup_path.exists() {
            let _ = fs::remove_file(backup_path);
        }
        fs::copy(primary_path, backup_path).with_context(|| {
            format!(
                "Failed to write cron snapshot backup: {}",
                backup_path.display()
            )
        })?;
    }

    temp.persist(primary_path)
        .map_err(|error| anyhow!(error.error))
        .with_context(|| {
            format!(
                "Failed to persist cron snapshot: {}",
                primary_path.display()
            )
        })?;
    Ok(())
}

fn number_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_i64()
                .and_then(|item| (item >= 0).then_some(item as u64))
        }),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn trim_non_empty(value: &str) -> String {
    value.trim().to_string()
}

fn generate_hex_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_store() -> (CronStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = CronStore::new_in(dir.path().to_path_buf());
        (store, dir)
    }

    #[test]
    fn pending_runs_ack_by_pending_id_and_task_id() {
        let (store, _dir) = test_store();
        let first = store.add_pending_run("task-a").unwrap();
        let second = store.add_pending_run("task-a").unwrap();
        let third = store.add_pending_run("task-b").unwrap();

        let removed = store
            .ack_pending_runs_value(&serde_json::json!({
                "pendingIds": [first.pending_id],
                "taskIds": ["task-b"]
            }))
            .unwrap();
        assert_eq!(removed, 2);

        let remaining = store.list_pending_runs().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].pending_id, second.pending_id);
        assert_ne!(remaining[0].pending_id, third.pending_id);
    }

    #[test]
    fn upsert_and_remove_jobs_round_trip() {
        let (store, _dir) = test_store();
        store
            .upsert_job(serde_json::json!({ "id": "task-1", "name": "One" }))
            .unwrap();
        store
            .upsert_job(serde_json::json!({ "id": "task-1", "name": "Updated" }))
            .unwrap();
        store
            .upsert_job(serde_json::json!({ "id": "task-2", "name": "Two" }))
            .unwrap();

        let jobs = store.list_jobs().unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0]["name"].as_str(), Some("Updated"));
        assert_eq!(jobs[1]["name"].as_str(), Some("Two"));

        assert!(store.remove_job("task-1").unwrap());
        assert!(!store.remove_job("missing").unwrap());
        let jobs = store.list_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["id"].as_str(), Some("task-2"));
    }
}
