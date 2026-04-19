// Run state store. Each in-flight agent turn gets a `RunHandle` registered
// here so:
//   - `tool_result` POST can deliver the result to the right run by id
//   - `cancel` POST can abort the right run by id
//   - `status` GET can read the latest snapshot for long-poll fallback
//
// The store is in-memory only — phase 1+2 explicitly defer persistence to
// phase 4. A daemon restart drops all in-flight runs; the extension client
// surfaces this as a stream-end error and falls back to the local PI-runtime
// loop on the next turn.
use crate::persist::{
    mark_orphans, AgentRunPersistence, PersistedAgentRun, PersistedRunResultSummary,
};
use crate::types::{
    AgentTurnErrorDetail, AgentTurnStatus, SerializedRunPiAgentLoopResult,
};
use companion_shared::RunTier;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{oneshot, RwLock};
use tokio_util::sync::CancellationToken;

/// Public snapshot for the GET /status endpoint.
#[derive(Debug, Clone)]
pub struct RunSnapshot {
    pub run_id: String,
    pub status: AgentTurnStatus,
    pub updated_at: i64,
    pub result: Option<SerializedRunPiAgentLoopResult>,
    pub error: Option<AgentTurnErrorDetail>,
}

/// Outcome a worker reports back via `tool_result`. `success=false` is a
/// legitimate outcome (extension's tool returned an error) — only the absence
/// of a response signals a problem.
#[derive(Debug, Clone)]
pub struct ToolResultPayload {
    pub call_id: String,
    pub result: String,
    pub success: bool,
}

/// One pending tool call awaiting a result POST. The cell is shared between
/// the LLM loop (which reads via .recv()) and the HTTP handler (which writes
/// via .deliver()). At most one pending tool result per run is supported in
/// phase 1+2 — the LLM loop emits one tool_call event then awaits before
/// continuing, so the queue depth is structurally one.
#[derive(Debug)]
pub struct PendingToolCall {
    pub call_id: String,
    pub tx: oneshot::Sender<ToolResultPayload>,
}

#[derive(Debug)]
pub struct RunHandle {
    pub run_id: String,
    pub conversation_id: Option<String>,
    pub model: Option<String>,
    pub tier: RunTier,
    pub created_at: i64,
    /// Live status. Updated by the LLM loop as the turn progresses.
    pub status: RwLock<AgentTurnStatus>,
    pub updated_at: RwLock<i64>,
    /// Set when the run reaches a terminal state.
    pub finished_at: RwLock<Option<i64>>,
    /// Set when status flips to Completed.
    pub result: RwLock<Option<SerializedRunPiAgentLoopResult>>,
    /// Set when status flips to Failed.
    pub error: RwLock<Option<AgentTurnErrorDetail>>,
    /// Filled by the LLM loop when it emits a tool_call SSE event; consumed
    /// by the matching tool_result POST.
    pub pending_tool: RwLock<Option<PendingToolCall>>,
    /// Aborts the loop when triggered (cancel endpoint or daemon shutdown).
    pub cancel: CancellationToken,
    /// Hook back to the owning store so terminal-state writes can flush
    /// persistence without each call site needing to know about disk IO.
    persistence: Option<Arc<AgentRunPersistence>>,
    /// Snapshot of all in-memory runs — captured by the store so terminal
    /// transitions can serialize the entire current state. Optional so
    /// tests/standalone construction don't need to wire it.
    runs_for_snapshot:
        Option<Arc<RwLock<HashMap<String, Arc<RunHandle>>>>>,
}

impl RunHandle {
    fn new(
        run_id: String,
        conversation_id: Option<String>,
        model: Option<String>,
        tier: RunTier,
        persistence: Option<Arc<AgentRunPersistence>>,
        runs_for_snapshot: Option<Arc<RwLock<HashMap<String, Arc<RunHandle>>>>>,
    ) -> Arc<Self> {
        let now = now_millis();
        Arc::new(Self {
            run_id,
            conversation_id,
            model,
            tier,
            created_at: now,
            status: RwLock::new(AgentTurnStatus::Running),
            updated_at: RwLock::new(now),
            finished_at: RwLock::new(None),
            result: RwLock::new(None),
            error: RwLock::new(None),
            pending_tool: RwLock::new(None),
            cancel: CancellationToken::new(),
            persistence,
            runs_for_snapshot,
        })
    }

    pub async fn snapshot(&self) -> RunSnapshot {
        RunSnapshot {
            run_id: self.run_id.clone(),
            status: *self.status.read().await,
            updated_at: *self.updated_at.read().await,
            result: self.result.read().await.clone(),
            error: self.error.read().await.clone(),
        }
    }

    pub async fn set_status(&self, status: AgentTurnStatus) {
        *self.status.write().await = status;
        *self.updated_at.write().await = now_millis();
        self.persist_snapshot().await;
    }

    pub async fn record_result(&self, result: SerializedRunPiAgentLoopResult) {
        *self.result.write().await = Some(result);
        let now = now_millis();
        *self.finished_at.write().await = Some(now);
        // Update timestamps + status under the same write epoch so the
        // persistence flush sees a consistent record.
        *self.status.write().await = AgentTurnStatus::Completed;
        *self.updated_at.write().await = now;
        self.persist_snapshot().await;
    }

    pub async fn record_error(&self, error: AgentTurnErrorDetail) {
        *self.error.write().await = Some(error);
        let now = now_millis();
        *self.finished_at.write().await = Some(now);
        *self.status.write().await = AgentTurnStatus::Failed;
        *self.updated_at.write().await = now;
        self.persist_snapshot().await;
    }

    pub async fn record_cancellation(&self) {
        self.cancel.cancel();
        let now = now_millis();
        *self.finished_at.write().await = Some(now);
        *self.status.write().await = AgentTurnStatus::Cancelled;
        *self.updated_at.write().await = now;
        self.persist_snapshot().await;
    }

    pub async fn persisted_form(&self) -> PersistedAgentRun {
        let result = self.result.read().await.clone();
        let summary = result
            .as_ref()
            .map(PersistedRunResultSummary::from_result);
        PersistedAgentRun {
            run_id: self.run_id.clone(),
            conversation_id: self.conversation_id.clone(),
            status: *self.status.read().await,
            created_at: self.created_at,
            updated_at: *self.updated_at.read().await,
            finished_at: *self.finished_at.read().await,
            result_summary: summary,
            error: self.error.read().await.clone(),
            model: self.model.clone(),
        }
    }

    /// Flush the entire in-memory store to disk. Called on every status
    /// write so that mid-flight runs show up in the on-disk snapshot — if
    /// the daemon crashes mid-turn, the next startup's orphan recovery
    /// sweep depends on the run already being visible in the primary file.
    async fn persist_snapshot(&self) {
        let Some(persistence) = self.persistence.as_ref() else {
            return;
        };
        let Some(runs_arc) = self.runs_for_snapshot.as_ref() else {
            return;
        };
        let snapshot: Vec<PersistedAgentRun> = {
            let runs = runs_arc.read().await;
            let mut out = Vec::with_capacity(runs.len());
            for handle in runs.values() {
                out.push(handle.persisted_form().await);
            }
            out
        };
        if let Err(err) = persistence.save(&snapshot) {
            tracing::warn!(target: "companion_agent", error = %err, "Failed to persist agent run snapshot");
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Default)]
pub struct AgentRunStore {
    runs: Arc<RwLock<HashMap<String, Arc<RunHandle>>>>,
    /// Persisted history (terminal runs only). Optional: when None, the
    /// store runs in-memory-only mode (used by tests + when daemon has no
    /// config dir).
    persistence: Option<Arc<AgentRunPersistence>>,
    /// History of terminal runs that aren't in the live `runs` map. Read by
    /// `get` so a daemon-restart-orphan run still shows up via the status
    /// endpoint after the orphan recovery sweep.
    history: Arc<RwLock<HashMap<String, PersistedAgentRun>>>,
}

impl AgentRunStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Variant with disk-backed persistence. Loads existing records, runs
    /// orphan recovery, persists the cleaned snapshot, and seeds the
    /// terminal-state history map so subsequent status queries can answer.
    pub fn new_with_persistence(persistence: AgentRunPersistence) -> Self {
        let persistence = Arc::new(persistence);
        let now = now_millis();
        let mut loaded = persistence.load();
        loaded = mark_orphans(loaded, now);
        if let Err(err) = persistence.save(&loaded) {
            tracing::warn!(
                target: "companion_agent",
                error = %err,
                "Failed to persist orphan recovery snapshot",
            );
        }
        let history: HashMap<String, PersistedAgentRun> = loaded
            .into_iter()
            .map(|run| (run.run_id.clone(), run))
            .collect();
        Self {
            runs: Arc::new(RwLock::new(HashMap::new())),
            persistence: Some(persistence),
            history: Arc::new(RwLock::new(history)),
        }
    }

    pub async fn create(&self) -> Arc<RunHandle> {
        self.create_with_metadata(CreateRunMetadata::default()).await
    }

    pub async fn create_with_metadata(&self, meta: CreateRunMetadata) -> Arc<RunHandle> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let handle = RunHandle::new(
            run_id.clone(),
            meta.conversation_id,
            meta.model,
            meta.tier,
            self.persistence.clone(),
            Some(self.runs.clone()),
        );
        self.runs.write().await.insert(run_id, handle.clone());
        // Flush the new run to disk immediately so orphan recovery can see
        // it if the daemon crashes before the first status transition.
        handle.persist_snapshot().await;
        handle
    }

    pub async fn get(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        self.runs.read().await.get(run_id).cloned()
    }

    /// Removes the run from the active map AND seeds the terminal-state
    /// history with its final persisted form. The persisted snapshot on
    /// disk is the source of truth across restarts; history is the in-
    /// memory cache that lets `status` answer without reading the file.
    pub async fn remove(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        let handle = self.runs.write().await.remove(run_id)?;
        let persisted = handle.persisted_form().await;
        self.history.write().await.insert(run_id.to_string(), persisted);
        Some(handle)
    }

    /// Status lookup that consults BOTH the live runs and the terminal
    /// history. Returns whichever exists — live takes priority.
    pub async fn snapshot_for(&self, run_id: &str) -> Option<RunSnapshot> {
        if let Some(handle) = self.get(run_id).await {
            return Some(handle.snapshot().await);
        }
        let history = self.history.read().await;
        history.get(run_id).map(|persisted| RunSnapshot {
            run_id: persisted.run_id.clone(),
            status: persisted.status,
            updated_at: persisted.updated_at,
            // Terminal history doesn't keep the full result; only the summary
            // was retained on disk. The status endpoint can still report
            // status + error which is what the extension needs to fall back.
            result: None,
            error: persisted.error.clone(),
        })
    }

    /// Inflight count — exposed for diagnostics + tests.
    pub async fn inflight_count(&self) -> usize {
        self.runs.read().await.len()
    }

    /// History size — exposed for diagnostics + tests.
    pub async fn history_count(&self) -> usize {
        self.history.read().await.len()
    }
}

/// Optional metadata captured at create time and persisted with the run.
/// Kept narrow on purpose: anything that contains tokens or prompt text
/// MUST NOT live here.
#[derive(Default, Debug, Clone)]
pub struct CreateRunMetadata {
    pub conversation_id: Option<String>,
    pub model: Option<String>,
    /// Tier flows from the client request; controls how long the
    /// orchestrator will patiently wait on a pending tool_result before
    /// declaring the extension dead.
    pub tier: RunTier,
}

/// Result of trying to deliver a tool result for a run. Distinguished from a
/// generic Result so the handler can return precise HTTP status codes.
#[derive(Debug)]
pub enum DeliverToolResult {
    Delivered,
    /// Run exists but no pending tool call is currently registered.
    NoPendingCall,
    /// Pending call exists but its callId differs from the one delivered.
    CallIdMismatch { expected: String },
    /// Run is not in a state that accepts tool results.
    RunNotReceiving,
}

impl RunHandle {
    /// Atomically pop the pending tool call (if it matches) and deliver the
    /// result via its oneshot channel.
    pub async fn deliver_tool_result(
        &self,
        payload: ToolResultPayload,
    ) -> DeliverToolResult {
        let status_now = *self.status.read().await;
        if !matches!(status_now, AgentTurnStatus::WaitingToolResult | AgentTurnStatus::Running) {
            return DeliverToolResult::RunNotReceiving;
        }
        let mut pending = self.pending_tool.write().await;
        match pending.take() {
            None => DeliverToolResult::NoPendingCall,
            Some(call) if call.call_id != payload.call_id => {
                // Put it back — the wrong client could have raced.
                *pending = Some(call);
                DeliverToolResult::CallIdMismatch {
                    expected: pending.as_ref().map(|c| c.call_id.clone()).unwrap_or_default(),
                }
            }
            Some(call) => {
                let _ = call.tx.send(payload);
                DeliverToolResult::Delivered
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SerializedRunPiAgentLoopResult;
    use tempfile::TempDir;

    fn sample_result() -> SerializedRunPiAgentLoopResult {
        SerializedRunPiAgentLoopResult {
            assistant_text: "hi".to_string(),
            assistant_turns: vec![],
            context_report: None,
            tool_outputs: vec![],
            invoked_tools: vec!["echo".to_string()],
            runtime_diagnostics: None,
            aborted: false,
            error: None,
        }
    }

    #[tokio::test]
    async fn persistence_survives_restart_and_recovers_orphans() {
        let dir = TempDir::new().unwrap();

        // Run #1: completes cleanly — should survive restart intact.
        let store_a = AgentRunStore::new_with_persistence(AgentRunPersistence::new(dir.path()));
        let completed = store_a
            .create_with_metadata(CreateRunMetadata {
                conversation_id: Some("conv-1".to_string()),
                model: Some("gpt-test".to_string()),
                tier: RunTier::default(),
            })
            .await;
        completed.record_result(sample_result()).await;
        let completed_id = completed.run_id.clone();

        // Run #2: left "in flight" — the next startup should flip it to Failed
        // with the orphan reason.
        let orphan = store_a
            .create_with_metadata(CreateRunMetadata::default())
            .await;
        let orphan_id = orphan.run_id.clone();
        // Force a flush now by touching a terminal-adjacent write path for a
        // separate run. record_result on `completed` already flushed, so we
        // can drop store_a directly.
        drop(store_a);

        // Restart: new store reads the same dir and runs orphan recovery.
        let store_b = AgentRunStore::new_with_persistence(AgentRunPersistence::new(dir.path()));
        let completed_snap = store_b.snapshot_for(&completed_id).await.expect("completed run visible after restart");
        assert_eq!(completed_snap.status, AgentTurnStatus::Completed);
        // Full result payload is not persisted by design — status + error are
        // what the extension needs for fallback.
        assert!(completed_snap.result.is_none());

        let orphan_snap = store_b.snapshot_for(&orphan_id).await.expect("orphan run visible after restart");
        assert_eq!(orphan_snap.status, AgentTurnStatus::Failed);
        assert!(orphan_snap.error.is_some(), "orphan must carry an error detail");
    }

    #[tokio::test]
    async fn in_memory_only_mode_has_no_history_after_remove() {
        let store = AgentRunStore::new();
        let run = store.create().await;
        let id = run.run_id.clone();
        run.record_cancellation().await;
        // remove returns the handle + seeds the in-memory history map even
        // without disk persistence, so snapshot_for still answers.
        let _ = store.remove(&id).await;
        let snap = store.snapshot_for(&id).await.expect("history retained");
        assert_eq!(snap.status, AgentTurnStatus::Cancelled);
        assert_eq!(store.inflight_count().await, 0);
        assert_eq!(store.history_count().await, 1);
    }
}
