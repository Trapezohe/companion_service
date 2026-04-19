// Persistence for runtime session metadata. P1-1c scope: metadata only —
// commands, cwds, status, timestamps, exit codes. NOT:
//   - env vars (could carry per-session secrets the caller injected)
//   - stdout/stderr content (too big, not useful post-restart since the
//     process is dead anyway)
//   - event streams (bounded in memory; persisting the full stream would
//     multiply disk IO for negligible recovery value)
//
// On daemon restart, any session still marked "running" gets flipped to
// "exited" with timed_out=false, exit_code=-1, and an explicit marker so
// the extension side can distinguish a clean restart from a real failure.
use anyhow::{Context, Result};
use companion_shared::RunTier;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::NamedTempFile;

const PRIMARY_FILENAME: &str = "runtime-sessions.json";
const BACKUP_FILENAME: &str = "runtime-sessions.json.bak";
const DEFAULT_MAX_HISTORY: usize = 200;
const MAX_HISTORY_ENV: &str = "TRAPEZOHE_MAX_RUNTIME_SESSION_HISTORY";

pub const ORPHAN_REASON: &str = "daemon_restart_orphan";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuntimeSession {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub tier: RunTier,
    #[serde(default)]
    pub effective_ttl_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphan_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSnapshot {
    sessions: Vec<PersistedRuntimeSession>,
}

#[derive(Debug)]
pub struct RuntimePersistence {
    primary: PathBuf,
    backup: PathBuf,
    max_history: usize,
    write_lock: Mutex<()>,
}

impl RuntimePersistence {
    pub fn new<P: Into<PathBuf>>(config_dir: P) -> Self {
        let dir = config_dir.into();
        let max_history = read_usize_env(MAX_HISTORY_ENV, DEFAULT_MAX_HISTORY).max(1);
        Self {
            primary: dir.join(PRIMARY_FILENAME),
            backup: dir.join(BACKUP_FILENAME),
            max_history,
            write_lock: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Vec<PersistedRuntimeSession> {
        match read_snapshot(&self.primary) {
            Ok(snapshot) => snapshot.sessions,
            Err(_) => match read_snapshot(&self.backup) {
                Ok(snapshot) => snapshot.sessions,
                Err(_) => Vec::new(),
            },
        }
    }

    pub fn save(&self, sessions: &[PersistedRuntimeSession]) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|p| p.into_inner());
        let trimmed = trim_history(sessions, self.max_history);
        let snapshot = PersistedSnapshot { sessions: trimmed };
        let payload = serde_json::to_vec_pretty(&snapshot)
            .context("Failed to serialize runtime session snapshot")?;
        ensure_parent_dir(&self.primary)?;
        if self.primary.exists() {
            let _ = fs::copy(&self.primary, &self.backup);
        }
        atomic_write(&self.primary, &payload)?;
        Ok(())
    }
}

/// Flip any session still marked running into an exited/orphan state so
/// callers asking about it after restart get a deterministic answer.
pub fn mark_orphans(
    sessions: Vec<PersistedRuntimeSession>,
    now_millis: u64,
) -> Vec<PersistedRuntimeSession> {
    sessions
        .into_iter()
        .map(|mut session| {
            if session.status == "running" {
                session.status = "exited".to_string();
                session.finished_at = Some(now_millis);
                session.exit_code = Some(-1);
                session.timed_out = false;
                session.orphan_reason = Some(ORPHAN_REASON.to_string());
            }
            session
        })
        .collect()
}

fn trim_history(
    sessions: &[PersistedRuntimeSession],
    max: usize,
) -> Vec<PersistedRuntimeSession> {
    if sessions.len() <= max {
        return sessions.to_vec();
    }
    let mut sorted: Vec<PersistedRuntimeSession> = sessions.to_vec();
    sorted.sort_by(|a, b| {
        let left = b.finished_at.unwrap_or(b.started_at);
        let right = a.finished_at.unwrap_or(a.started_at);
        left.cmp(&right)
    });
    sorted.truncate(max);
    sorted
}

fn read_snapshot(path: &Path) -> Result<PersistedSnapshot> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    let snapshot: PersistedSnapshot = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse {}", path.display()))?;
    Ok(snapshot)
}

fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Path is missing parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("Failed to create dir: {}", parent.display()))?;
    set_dir_permissions(parent)?;
    Ok(())
}

fn atomic_write(path: &Path, payload: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Path is missing parent: {}", path.display()))?;
    let mut temp = NamedTempFile::new_in(parent)
        .with_context(|| format!("Failed to create temp file in {}", parent.display()))?;
    use std::io::Write;
    temp.write_all(payload)
        .with_context(|| format!("Failed to write temp file for {}", path.display()))?;
    set_file_permissions(temp.path())?;
    temp.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("Failed to persist {}", path.display()))?;
    set_file_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("Failed to set permissions for {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("Failed to set permissions for {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn read_usize_env(key: &str, default_value: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(default_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make(id: &str, status: &str, started_at: u64) -> PersistedRuntimeSession {
        PersistedRuntimeSession {
            id: id.to_string(),
            command: "echo hi".to_string(),
            cwd: "/tmp".to_string(),
            status: status.to_string(),
            started_at,
            finished_at: None,
            exit_code: None,
            timed_out: false,
            tier: RunTier::Default,
            effective_ttl_ms: 60 * 60 * 1000,
            orphan_reason: None,
        }
    }

    #[test]
    fn roundtrip_persists_metadata() {
        let dir = TempDir::new().unwrap();
        let store = RuntimePersistence::new(dir.path());
        store
            .save(&[make("a", "exited", 1000), make("b", "running", 2000)])
            .unwrap();
        let reloaded = store.load();
        assert_eq!(reloaded.len(), 2);
    }

    #[test]
    fn orphan_recovery_flips_running_to_exited() {
        let sessions = vec![
            make("done", "exited", 1000),
            make("orphan", "running", 2000),
        ];
        let recovered = mark_orphans(sessions, 9999);
        let by_id: std::collections::HashMap<&str, &PersistedRuntimeSession> =
            recovered.iter().map(|s| (s.id.as_str(), s)).collect();
        assert_eq!(by_id["done"].status, "exited");
        assert_eq!(by_id["done"].orphan_reason, None);
        assert_eq!(by_id["orphan"].status, "exited");
        assert_eq!(by_id["orphan"].exit_code, Some(-1));
        assert_eq!(by_id["orphan"].orphan_reason.as_deref(), Some(ORPHAN_REASON));
    }
}
