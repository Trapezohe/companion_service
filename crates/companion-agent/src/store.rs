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
use crate::types::{
    AgentTurnErrorDetail, AgentTurnStatus, SerializedRunPiAgentLoopResult,
};
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
    /// Live status. Updated by the LLM loop as the turn progresses.
    pub status: RwLock<AgentTurnStatus>,
    pub updated_at: RwLock<i64>,
    /// Set when status flips to Completed.
    pub result: RwLock<Option<SerializedRunPiAgentLoopResult>>,
    /// Set when status flips to Failed.
    pub error: RwLock<Option<AgentTurnErrorDetail>>,
    /// Filled by the LLM loop when it emits a tool_call SSE event; consumed
    /// by the matching tool_result POST.
    pub pending_tool: RwLock<Option<PendingToolCall>>,
    /// Aborts the loop when triggered (cancel endpoint or daemon shutdown).
    pub cancel: CancellationToken,
}

impl RunHandle {
    fn new(run_id: String) -> Arc<Self> {
        Arc::new(Self {
            run_id,
            status: RwLock::new(AgentTurnStatus::Running),
            updated_at: RwLock::new(now_millis()),
            result: RwLock::new(None),
            error: RwLock::new(None),
            pending_tool: RwLock::new(None),
            cancel: CancellationToken::new(),
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
    }

    pub async fn record_result(&self, result: SerializedRunPiAgentLoopResult) {
        *self.result.write().await = Some(result);
        self.set_status(AgentTurnStatus::Completed).await;
    }

    pub async fn record_error(&self, error: AgentTurnErrorDetail) {
        *self.error.write().await = Some(error);
        self.set_status(AgentTurnStatus::Failed).await;
    }

    pub async fn record_cancellation(&self) {
        self.cancel.cancel();
        self.set_status(AgentTurnStatus::Cancelled).await;
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
}

impl AgentRunStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create(&self) -> Arc<RunHandle> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let handle = RunHandle::new(run_id.clone());
        self.runs.write().await.insert(run_id, handle.clone());
        handle
    }

    pub async fn get(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        self.runs.read().await.get(run_id).cloned()
    }

    /// Removes the run from the active map. Snapshot stays accessible to any
    /// caller that already holds the Arc (e.g. the SSE response future).
    pub async fn remove(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        self.runs.write().await.remove(run_id)
    }

    /// Inflight count — exposed for diagnostics + tests.
    pub async fn inflight_count(&self) -> usize {
        self.runs.read().await.len()
    }
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
