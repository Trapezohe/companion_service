// Persistence for agent run records. Phase 3 scope: METADATA ONLY — no
// prompt, no messages, no api_secret, no streaming assistant text. The
// extension already has the prompt + history + secret on its side, so the
// daemon never needs to re-derive them. What we DO persist is enough to:
//
//   1. answer GET /api/agent/turn/{run_id}/status after a daemon restart,
//      so the extension knows "that run exists, here's its terminal state"
//   2. mark in-flight runs as failed with reason='daemon_restart_orphan' on
//      startup, so the extension stops waiting on a stream that died with
//      the previous daemon process
//   3. retain a bounded history (default 200) for diagnostic UI
//
// What we do NOT do (deferred to phase 4/5):
//   - Resume a mid-stream LLM call (the upstream provider stream is dead)
//   - Replay tool_call SSE events to a reconnecting client (no event log)
//   - Cache provider responses for replay
//
// File layout mirrors companion-control's RunStore: primary `agent-runs.json`
// + `.bak` sibling. Atomic writes via NamedTempFile + persist_into.
use crate::types::{
    AgentTurnErrorCode, AgentTurnErrorDetail, AgentTurnStatus,
    SerializedRunPiAgentLoopResult,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::NamedTempFile;

const PRIMARY_FILENAME: &str = "agent-runs.json";
const BACKUP_FILENAME: &str = "agent-runs.json.bak";
const DEFAULT_MAX_HISTORY: usize = 200;
const MAX_HISTORY_ENV: &str = "TRAPEZOHE_MAX_AGENT_RUN_HISTORY";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentRun {
    pub run_id: String,
    /// Optional client-supplied conversation id, used by the UI to group runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub status: AgentTurnStatus,
    pub created_at: i64,
    pub updated_at: i64,
    /// Set when the run reaches a terminal state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    /// Final assistant text and tool footprint when the turn completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<PersistedRunResultSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentTurnErrorDetail>,
    /// Free-form provenance — currently just the model name. Helps diagnose
    /// "this run failed, what was the model?" without needing to keep prompts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRunResultSummary {
    /// Truncated copy of the assistant text (first 500 chars). Bigger payloads
    /// are intentionally not retained — we already promised to never log
    /// model output beyond metadata.
    pub assistant_text_preview: String,
    pub assistant_text_chars: usize,
    pub tool_outputs: usize,
    pub invoked_tools: Vec<String>,
}

impl PersistedRunResultSummary {
    pub fn from_result(result: &SerializedRunPiAgentLoopResult) -> Self {
        Self {
            assistant_text_preview: clip_preview(&result.assistant_text),
            assistant_text_chars: result.assistant_text.chars().count(),
            tool_outputs: result.tool_outputs.len(),
            invoked_tools: result.invoked_tools.clone(),
        }
    }
}

fn clip_preview(text: &str) -> String {
    const MAX: usize = 500;
    if text.chars().count() <= MAX {
        return text.to_string();
    }
    let cutoff_byte = text
        .char_indices()
        .nth(MAX)
        .map(|(idx, _)| idx)
        .unwrap_or(text.len());
    format!("{}…", &text[..cutoff_byte])
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSnapshot {
    runs: Vec<PersistedAgentRun>,
}

/// File-backed store for agent run metadata. Caller owns the in-memory
/// state; this struct only handles disk IO + recovery on startup.
#[derive(Debug)]
pub struct AgentRunPersistence {
    primary: PathBuf,
    backup: PathBuf,
    max_history: usize,
    /// Serializes writes so concurrent record updates don't clobber each
    /// other. Reads use a fresh load — the in-memory state is owned by
    /// AgentRunStore, so this lock only protects file writes.
    write_lock: Mutex<()>,
}

impl AgentRunPersistence {
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

    /// Best-effort load. A missing or corrupt file returns an empty list —
    /// agent recovery is downstream of the persistence layer and should not
    /// be blocked by a bad file.
    pub fn load(&self) -> Vec<PersistedAgentRun> {
        match read_snapshot(&self.primary) {
            Ok(snapshot) => snapshot.runs,
            Err(_) => match read_snapshot(&self.backup) {
                Ok(snapshot) => snapshot.runs,
                Err(_) => Vec::new(),
            },
        }
    }

    /// Snapshot the current run set to disk. Atomic via NamedTempFile.
    pub fn save(&self, runs: &[PersistedAgentRun]) -> Result<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|p| p.into_inner());
        let trimmed = trim_history(runs, self.max_history);
        let snapshot = PersistedSnapshot { runs: trimmed };
        let payload = serde_json::to_vec_pretty(&snapshot)
            .context("Failed to serialize agent run snapshot")?;

        ensure_parent_dir(&self.primary)?;
        // Backup current primary before swapping. Skip silently if primary
        // doesn't exist yet — the first save establishes both files.
        if self.primary.exists() {
            let _ = fs::copy(&self.primary, &self.backup);
        }
        atomic_write(&self.primary, &payload)?;
        Ok(())
    }
}

/// Sweep persisted runs, marking any that were running/waiting at the time
/// of the last persist as failed with reason='daemon_restart_orphan'.
/// Returns the rewritten list — caller is responsible for re-saving + for
/// re-hydrating the in-memory store with the cleaned records.
pub fn mark_orphans(runs: Vec<PersistedAgentRun>, now: i64) -> Vec<PersistedAgentRun> {
    runs.into_iter()
        .map(|mut run| {
            match run.status {
                AgentTurnStatus::Running | AgentTurnStatus::WaitingToolResult => {
                    run.status = AgentTurnStatus::Failed;
                    run.finished_at = Some(now);
                    run.updated_at = now;
                    run.error = Some(AgentTurnErrorDetail {
                        code: AgentTurnErrorCode::InternalError,
                        message: "Companion daemon restarted while this run was in flight."
                            .to_string(),
                        retryable: Some(true),
                    });
                }
                AgentTurnStatus::Completed
                | AgentTurnStatus::Failed
                | AgentTurnStatus::Cancelled => {}
            }
            run
        })
        .collect()
}

fn trim_history(runs: &[PersistedAgentRun], max: usize) -> Vec<PersistedAgentRun> {
    if runs.len() <= max {
        return runs.to_vec();
    }
    // Newest first; keep the most-recent `max` records.
    let mut sorted: Vec<PersistedAgentRun> = runs.to_vec();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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

    fn make_run(run_id: &str, status: AgentTurnStatus, ts: i64) -> PersistedAgentRun {
        PersistedAgentRun {
            run_id: run_id.to_string(),
            conversation_id: None,
            status,
            created_at: ts,
            updated_at: ts,
            finished_at: matches!(
                status,
                AgentTurnStatus::Completed | AgentTurnStatus::Failed | AgentTurnStatus::Cancelled
            )
            .then_some(ts),
            result_summary: None,
            error: None,
            model: None,
        }
    }

    #[test]
    fn save_and_reload_roundtrip() {
        let dir = TempDir::new().unwrap();
        let store = AgentRunPersistence::new(dir.path());
        let runs = vec![
            make_run("a", AgentTurnStatus::Completed, 1000),
            make_run("b", AgentTurnStatus::Failed, 2000),
        ];
        store.save(&runs).unwrap();

        let reloaded = store.load();
        assert_eq!(reloaded.len(), 2);
        assert!(reloaded.iter().any(|r| r.run_id == "a"));
        assert!(reloaded.iter().any(|r| r.run_id == "b"));
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = TempDir::new().unwrap();
        let store = AgentRunPersistence::new(dir.path());
        assert!(store.load().is_empty());
    }

    #[test]
    fn corrupt_primary_falls_back_to_backup() {
        let dir = TempDir::new().unwrap();
        let store = AgentRunPersistence::new(dir.path());
        // First save writes primary only — no backup yet because there was
        // no prior primary to demote. A second save promotes primary-1 into
        // the backup slot, which is the state we want to probe here.
        store.save(&[make_run("a", AgentTurnStatus::Completed, 1000)]).unwrap();
        store.save(&[make_run("a", AgentTurnStatus::Completed, 1000)]).unwrap();
        // Corrupt primary; backup should still parse.
        fs::write(dir.path().join(PRIMARY_FILENAME), b"{ not json").unwrap();
        let reloaded = store.load();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].run_id, "a");
    }

    #[test]
    fn orphan_recovery_marks_inflight_as_failed() {
        let runs = vec![
            make_run("running", AgentTurnStatus::Running, 1000),
            make_run("waiting", AgentTurnStatus::WaitingToolResult, 2000),
            make_run("done", AgentTurnStatus::Completed, 3000),
            make_run("failed", AgentTurnStatus::Failed, 4000),
        ];
        let recovered = mark_orphans(runs, 9999);
        let by_id: std::collections::HashMap<&str, &PersistedAgentRun> =
            recovered.iter().map(|r| (r.run_id.as_str(), r)).collect();

        assert_eq!(by_id["running"].status, AgentTurnStatus::Failed);
        assert_eq!(by_id["waiting"].status, AgentTurnStatus::Failed);
        assert!(by_id["running"].error.as_ref().is_some());
        assert!(by_id["waiting"].error.as_ref().is_some());
        assert_eq!(by_id["running"].finished_at, Some(9999));

        // Already-terminal runs are untouched.
        assert_eq!(by_id["done"].status, AgentTurnStatus::Completed);
        assert_eq!(by_id["failed"].status, AgentTurnStatus::Failed);
    }

    #[test]
    fn save_trims_to_max_history_keeping_newest() {
        let dir = TempDir::new().unwrap();
        std::env::set_var(MAX_HISTORY_ENV, "3");
        let store = AgentRunPersistence::new(dir.path());
        let runs: Vec<PersistedAgentRun> = (0..10)
            .map(|i| make_run(&format!("run-{i}"), AgentTurnStatus::Completed, i * 1000))
            .collect();
        store.save(&runs).unwrap();
        std::env::remove_var(MAX_HISTORY_ENV);

        let reloaded = store.load();
        assert_eq!(reloaded.len(), 3);
        let mut ids: Vec<_> = reloaded.iter().map(|r| r.run_id.clone()).collect();
        ids.sort();
        // Newest 3 = run-7, run-8, run-9 (updated_at 7000/8000/9000).
        assert_eq!(ids, vec!["run-7", "run-8", "run-9"]);
    }
}
