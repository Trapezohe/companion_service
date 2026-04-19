// Persistence for ACP session metadata. Same contract as
// companion-runtime's persist module: metadata only — no env vars, no
// event streams, no prompt text, no provenance beyond the normalized
// object the caller sent at create time.
//
// On daemon restart, any session still marked `idle` or `running` gets
// flipped to `error` with an `orphan_reason` marker so the extension
// distinguishes "daemon was killed mid-turn" from a real failure.
use anyhow::{Context, Result};
use companion_shared::RunTier;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::NamedTempFile;

use crate::CommandSpec;

const PRIMARY_FILENAME: &str = "acp-sessions.json";
const BACKUP_FILENAME: &str = "acp-sessions.json.bak";
const DEFAULT_MAX_HISTORY: usize = 200;
const MAX_HISTORY_ENV: &str = "TRAPEZOHE_MAX_ACP_SESSION_HISTORY";

pub const ORPHAN_REASON: &str = "daemon_restart_orphan";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAcpSession {
    pub session_id: String,
    pub agent_type: String,
    pub state: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_provenance: Option<Value>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
    #[serde(default)]
    pub tier: RunTier,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphan_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSnapshot {
    sessions: Vec<PersistedAcpSession>,
}

#[derive(Debug)]
pub struct AcpPersistence {
    primary: PathBuf,
    backup: PathBuf,
    max_history: usize,
    write_lock: Mutex<()>,
}

impl AcpPersistence {
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

    pub fn load(&self) -> Vec<PersistedAcpSession> {
        match read_snapshot(&self.primary) {
            Ok(snapshot) => snapshot.sessions,
            Err(_) => match read_snapshot(&self.backup) {
                Ok(snapshot) => snapshot.sessions,
                Err(_) => Vec::new(),
            },
        }
    }

    pub fn save(&self, sessions: &[PersistedAcpSession]) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|p| p.into_inner());
        let trimmed = trim_history(sessions, self.max_history);
        let snapshot = PersistedSnapshot { sessions: trimmed };
        let payload = serde_json::to_vec_pretty(&snapshot)
            .context("Failed to serialize ACP session snapshot")?;
        ensure_parent_dir(&self.primary)?;
        if self.primary.exists() {
            let _ = fs::copy(&self.primary, &self.backup);
        }
        atomic_write(&self.primary, &payload)?;
        Ok(())
    }
}

pub fn mark_orphans(
    sessions: Vec<PersistedAcpSession>,
    now_millis: u64,
) -> Vec<PersistedAcpSession> {
    sessions
        .into_iter()
        .map(|mut session| {
            if matches!(session.state.as_str(), "idle" | "running") {
                session.state = "error".to_string();
                session.finished_at = Some(now_millis);
                session.orphan_reason = Some(ORPHAN_REASON.to_string());
            }
            session
        })
        .collect()
}

fn trim_history(sessions: &[PersistedAcpSession], max: usize) -> Vec<PersistedAcpSession> {
    if sessions.len() <= max {
        return sessions.to_vec();
    }
    let mut sorted: Vec<PersistedAcpSession> = sessions.to_vec();
    sorted.sort_by(|a, b| {
        let left = b.finished_at.unwrap_or(b.created_at);
        let right = a.finished_at.unwrap_or(a.created_at);
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

// Suppress dead_code on BTreeMap — we keep it in case we later persist
// env vars (gated behind a secret-scrubber).
#[allow(dead_code)]
fn _env_anchor(_env: &BTreeMap<String, String>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make(session_id: &str, state: &str, created_at: u64) -> PersistedAcpSession {
        PersistedAcpSession {
            session_id: session_id.to_string(),
            agent_type: "raw".to_string(),
            state: state.to_string(),
            cwd: "/tmp".to_string(),
            command: None,
            origin: None,
            input_provenance: None,
            created_at,
            started_at: None,
            finished_at: None,
            current_turn_id: None,
            run_id: None,
            runtime_session_id: None,
            tier: RunTier::Default,
            timed_out: false,
            orphan_reason: None,
        }
    }

    #[test]
    fn roundtrip_persists_metadata() {
        let dir = TempDir::new().unwrap();
        let store = AcpPersistence::new(dir.path());
        store
            .save(&[make("a", "idle", 1000), make("b", "running", 2000)])
            .unwrap();
        let reloaded = store.load();
        assert_eq!(reloaded.len(), 2);
    }

    #[test]
    fn orphan_recovery_flips_idle_and_running() {
        let sessions = vec![
            make("done", "done", 1000),
            make("idle-orphan", "idle", 2000),
            make("running-orphan", "running", 3000),
        ];
        let recovered = mark_orphans(sessions, 9999);
        let by_id: std::collections::HashMap<&str, &PersistedAcpSession> =
            recovered.iter().map(|s| (s.session_id.as_str(), s)).collect();
        assert_eq!(by_id["done"].state, "done");
        assert_eq!(by_id["idle-orphan"].state, "error");
        assert_eq!(
            by_id["idle-orphan"].orphan_reason.as_deref(),
            Some(ORPHAN_REASON)
        );
        assert_eq!(by_id["running-orphan"].state, "error");
    }
}
