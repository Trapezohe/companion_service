use anyhow::{anyhow, Context, Result};
use companion_config::get_config_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationOutboxItem {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub task_name: String,
    pub mode: String,
    pub text: String,
    pub target: Option<serde_json::Value>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationOutboxListResult {
    pub items: Vec<AutomationOutboxItem>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AutomationSnapshot {
    #[serde(default)]
    items: Vec<AutomationOutboxItem>,
}

#[derive(Debug, Default)]
struct AutomationStoreInner {
    loaded: bool,
    snapshot: AutomationSnapshot,
}

#[derive(Debug, Clone)]
pub struct AutomationOutboxStore {
    inner: Arc<Mutex<AutomationStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
}

impl AutomationOutboxStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(AutomationStoreInner::default())),
            primary_path: config_dir.join("automation-outbox.json"),
            backup_path: config_dir.join("automation-outbox.json.bak"),
        }
    }

    pub fn enqueue_item(&self, item: AutomationOutboxItem) -> Result<AutomationOutboxItem> {
        let normalized =
            normalize_item(&item).ok_or_else(|| anyhow!("invalid automation outbox item"))?;
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        inner
            .snapshot
            .items
            .retain(|entry| entry.id != normalized.id);
        inner.snapshot.items.push(normalized.clone());
        sort_newest_first(&mut inner.snapshot.items);
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(normalized)
    }

    pub fn list_items(
        &self,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<AutomationOutboxListResult> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
        let total = inner.snapshot.items.len();
        let offset = offset.unwrap_or(0).min(total);
        let items = inner
            .snapshot
            .items
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        Ok(AutomationOutboxListResult {
            has_more: offset + items.len() < total,
            items,
            total,
            limit,
            offset,
        })
    }

    pub fn ack_items(&self, ids: &[String]) -> Result<usize> {
        let normalized_ids = ids
            .iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if normalized_ids.is_empty() {
            return Ok(0);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let before = inner.snapshot.items.len();
        inner
            .snapshot
            .items
            .retain(|entry| !normalized_ids.iter().any(|id| id == &entry.id));
        let removed = before.saturating_sub(inner.snapshot.items.len());
        if removed > 0 {
            persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        }
        Ok(removed)
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = AutomationSnapshot::default();
        persist_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut AutomationStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_snapshot(&self.primary_path, &self.backup_path)?;
        inner.loaded = true;
        Ok(())
    }
}

fn load_snapshot(primary_path: &Path, backup_path: &Path) -> Result<AutomationSnapshot> {
    match read_snapshot(primary_path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => Ok(read_snapshot(backup_path)?.unwrap_or_default()),
        Err(primary_error) => match read_snapshot(backup_path) {
            Ok(Some(snapshot)) => Ok(snapshot),
            Ok(None) => Ok(AutomationSnapshot::default()),
            Err(_) => {
                eprintln!(
                    "Failed to read automation outbox snapshot ({}); starting fresh.",
                    primary_error
                );
                Ok(AutomationSnapshot::default())
            }
        },
    }
}

fn read_snapshot(path: &Path) -> Result<Option<AutomationSnapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).with_context(|| {
        format!(
            "Failed to read automation outbox snapshot: {}",
            path.display()
        )
    })?;
    let mut snapshot = serde_json::from_str::<AutomationSnapshot>(&raw).with_context(|| {
        format!(
            "Failed to parse automation outbox snapshot: {}",
            path.display()
        )
    })?;
    snapshot.items = snapshot
        .items
        .iter()
        .filter_map(normalize_item)
        .collect::<Vec<_>>();
    sort_newest_first(&mut snapshot.items);
    Ok(Some(snapshot))
}

fn persist_snapshot(
    primary_path: &Path,
    backup_path: &Path,
    snapshot: &AutomationSnapshot,
) -> Result<()> {
    if let Some(parent) = primary_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create automation outbox dir: {}",
                parent.display()
            )
        })?;
    }
    let temp_dir = primary_path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(temp_dir).with_context(|| {
        format!(
            "Failed to create temp automation outbox snapshot near {}",
            primary_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut temp, snapshot)
        .context("Failed to encode automation outbox snapshot")?;
    use std::io::Write;
    temp.write_all(b"\n")
        .context("Failed to finalize automation outbox snapshot")?;
    temp.flush()
        .context("Failed to flush automation outbox snapshot")?;

    if primary_path.exists() {
        if backup_path.exists() {
            let _ = fs::remove_file(backup_path);
        }
        fs::copy(primary_path, backup_path).with_context(|| {
            format!(
                "Failed to write automation outbox backup: {}",
                backup_path.display()
            )
        })?;
    }

    temp.persist(primary_path)
        .map_err(|error| anyhow!(error.error))
        .with_context(|| {
            format!(
                "Failed to persist automation outbox snapshot: {}",
                primary_path.display()
            )
        })?;
    Ok(())
}

fn normalize_item(item: &AutomationOutboxItem) -> Option<AutomationOutboxItem> {
    let id = trim_non_empty(&item.id);
    let run_id = trim_non_empty(&item.run_id);
    let task_id = trim_non_empty(&item.task_id);
    let task_name = trim_non_empty(&item.task_name);
    let mode = trim_non_empty(&item.mode);
    let text = item.text.trim().to_string();
    if id.is_empty()
        || run_id.is_empty()
        || task_id.is_empty()
        || task_name.is_empty()
        || text.is_empty()
    {
        return None;
    }
    if mode != "chat" && mode != "remote_channel" {
        return None;
    }
    let target = item
        .target
        .as_ref()
        .filter(|value| value.is_object())
        .cloned();
    Some(AutomationOutboxItem {
        id,
        run_id,
        task_id,
        task_name,
        mode,
        text: item.text.clone(),
        target,
        created_at: if item.created_at == 0 {
            now_millis()
        } else {
            item.created_at
        },
    })
}

fn sort_newest_first(items: &mut [AutomationOutboxItem]) {
    items.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn trim_non_empty(value: &str) -> String {
    value.trim().to_string()
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

    fn test_store() -> (AutomationOutboxStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = AutomationOutboxStore::new_in(dir.path().to_path_buf());
        (store, dir)
    }

    #[test]
    fn enqueue_and_ack_items() {
        let (store, _dir) = test_store();
        store
            .enqueue_item(AutomationOutboxItem {
                id: "outbox-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: "task-1".to_string(),
                task_name: "Daily brief".to_string(),
                mode: "chat".to_string(),
                text: "Brief ready".to_string(),
                target: None,
                created_at: 10,
            })
            .unwrap();
        store
            .enqueue_item(AutomationOutboxItem {
                id: "outbox-2".to_string(),
                run_id: "run-2".to_string(),
                task_id: "task-2".to_string(),
                task_name: "Slack alert".to_string(),
                mode: "remote_channel".to_string(),
                text: "Alert ready".to_string(),
                target: Some(serde_json::json!({ "channelId": "slack" })),
                created_at: 20,
            })
            .unwrap();

        let listed = store.list_items(None, None).unwrap();
        assert_eq!(listed.items.len(), 2);
        assert_eq!(listed.items[0].id, "outbox-2");

        let removed = store.ack_items(&["outbox-2".to_string()]).unwrap();
        assert_eq!(removed, 1);
        let listed = store.list_items(None, None).unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].id, "outbox-1");
    }
}
