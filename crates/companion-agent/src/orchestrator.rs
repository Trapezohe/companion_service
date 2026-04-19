// Drives a single agent turn end-to-end: stream the LLM, emit SSE events,
// pause on tool_call, await the extension's tool_result POST, then continue.
//
// One AgentRunOrchestrator instance per inflight turn. The HTTP handler in
// handlers.rs spawns a tokio task running `run()` and converts its event
// channel into the SSE response.
use crate::llm::{
    build_messages, stream_chat_completion, AggregatedToolCall, LlmCallSpec, LlmStreamEvent,
};
use crate::store::{PendingToolCall, RunHandle, ToolResultPayload};
use crate::types::{
    AgentAssistantDeltaEventPayload, AgentCompleteEventPayload, AgentErrorEventPayload,
    AgentToolCallEventPayload, AgentTurnErrorCode, AgentTurnErrorDetail, AgentTurnSseEvent,
    AgentTurnStatus, AgentUsageEventPayload, RunAgentTurnRequest,
    SerializedRunPiAgentLoopResult,
};
use anyhow::Result;
use futures::future::join_all;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_TURNS: u32 = 32;

/// Outcome of one turn — either a final assistant message or a list of pending
/// tool calls that need extension-side execution.
#[derive(Debug)]
enum RoundOutcome {
    Done {
        assistant_text: String,
    },
    ToolCalls {
        assistant_text: String,
        tool_calls: Vec<AggregatedToolCall>,
    },
}

pub struct AgentRunOrchestrator {
    pub run: Arc<RunHandle>,
    pub http_client: Client,
}

impl AgentRunOrchestrator {
    /// Spawn a task driving the loop. All events go through the
    /// broadcast channel on the RunHandle, so the HTTP handlers don't
    /// need a dedicated receiver — they just `subscribe_events()` off
    /// the handle whenever a client connects or reconnects.
    pub fn spawn(
        run: Arc<RunHandle>,
        request: RunAgentTurnRequest,
        http_client: Client,
    ) {
        let orchestrator = AgentRunOrchestrator {
            run: run.clone(),
            http_client,
        };
        tokio::spawn(async move {
            orchestrator.run(request).await;
        });
    }

    async fn run(self, request: RunAgentTurnRequest) {
        let cancel_token = self.run.cancel.clone();
        match self.run_inner(request, cancel_token).await {
            Ok(result) => {
                let payload = AgentCompleteEventPayload {
                    run_id: self.run.run_id.clone(),
                    result: result.clone(),
                };
                self.run.record_result(result).await;
                self.run.emit_event(AgentTurnSseEvent::Complete(payload));
            }
            Err(error) => {
                let detail = AgentTurnErrorDetail {
                    code: error.code,
                    message: error.message.clone(),
                    retryable: error.retryable,
                };
                let payload = AgentErrorEventPayload {
                    run_id: self.run.run_id.clone(),
                    error: detail.clone(),
                };
                if matches!(error.code, AgentTurnErrorCode::Cancelled) {
                    self.run.record_cancellation().await;
                } else {
                    self.run.record_error(detail).await;
                }
                self.run.emit_event(AgentTurnSseEvent::Error(payload));
            }
        }
    }

    async fn run_inner(
        &self,
        request: RunAgentTurnRequest,
        cancel: CancellationToken,
    ) -> Result<SerializedRunPiAgentLoopResult, OrchestratorError> {
        let api_secret = request
            .api_secret
            .first()
            .ok_or_else(|| OrchestratorError::bad_request("api_secret missing or empty"))?
            .to_string();

        let max_turns = request
            .max_turns
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_MAX_TURNS);

        let post_system = request.post_system_messages.clone().unwrap_or_default();
        let mut messages = build_messages(
            &request.system_prompt,
            &post_system,
            &request.history,
            &request.prompt,
        );

        let mut assistant_text_total = String::new();
        let mut tool_outputs: Vec<String> = Vec::new();
        let mut invoked_tools: Vec<String> = Vec::new();

        for turn_index in 0..max_turns {
            if cancel.is_cancelled() {
                return Err(OrchestratorError::cancelled());
            }

            let spec = LlmCallSpec {
                provider_url: request.provider_url.clone(),
                api_secret: api_secret.clone(),
                model: request.model.clone(),
                messages: messages.clone(),
                tools: request.tool_definitions.clone(),
            };

            let outcome = self.run_one_round(&spec, &cancel).await?;

            match outcome {
                RoundOutcome::Done { assistant_text } => {
                    if !assistant_text.is_empty() {
                        assistant_text_total = assistant_text;
                    }
                    return Ok(SerializedRunPiAgentLoopResult {
                        assistant_text: assistant_text_total,
                        assistant_turns: vec![],
                        context_report: None,
                        tool_outputs,
                        invoked_tools,
                        runtime_diagnostics: None,
                        aborted: false,
                        error: None,
                    });
                }
                RoundOutcome::ToolCalls {
                    assistant_text,
                    tool_calls,
                } => {
                    if !assistant_text.is_empty() {
                        assistant_text_total = assistant_text.clone();
                    }
                    let assistant_msg = build_assistant_tool_call_message(
                        &assistant_text,
                        &tool_calls,
                    );
                    messages.push(assistant_msg);

                    self.run.set_status(AgentTurnStatus::WaitingToolResult).await;
                    if cancel.is_cancelled() {
                        return Err(OrchestratorError::cancelled());
                    }

                    // Phase 5b: emit every tool_call up front + register
                    // its pending slot, then await all oneshots
                    // concurrently. Extension-side batching (parallel
                    // wallet sigs, concurrent fetches, etc.) now finishes
                    // in max(tool_i) instead of sum(tool_i).
                    let mut await_futures = Vec::with_capacity(tool_calls.len());
                    let mut call_meta: Vec<(String, String)> =
                        Vec::with_capacity(tool_calls.len());
                    for call in &tool_calls {
                        let call_id = call.id.clone();
                        let (tx, rx) = oneshot::channel();
                        self.run
                            .register_pending_tool(PendingToolCall {
                                call_id: call_id.clone(),
                                tx,
                            })
                            .await;
                        let payload = AgentToolCallEventPayload {
                            run_id: self.run.run_id.clone(),
                            call_id: call_id.clone(),
                            name: call.name.clone(),
                            arguments: call.parsed_arguments(),
                        };
                        self.run.emit_event(AgentTurnSseEvent::ToolCall(payload));
                        call_meta.push((call_id, call.name.clone()));
                        await_futures.push(self.await_tool_result(rx, &cancel));
                    }

                    let results = join_all(await_futures).await;
                    for ((call_id, tool_name), result) in
                        call_meta.into_iter().zip(results.into_iter())
                    {
                        let payload = result?;
                        invoked_tools.push(tool_name.clone());
                        tool_outputs.push(payload.result.clone());
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": tool_name,
                            "content": payload.result,
                        }));
                    }

                    self.run.set_status(AgentTurnStatus::Running).await;
                    let _ = turn_index;
                    continue;
                }
            }
        }

        Err(OrchestratorError {
            code: AgentTurnErrorCode::InternalError,
            message: format!(
                "Agent turn exceeded the {}-round safety cap without producing a final answer.",
                max_turns
            ),
            retryable: Some(false),
        })
    }

    async fn run_one_round(
        &self,
        spec: &LlmCallSpec,
        cancel: &CancellationToken,
    ) -> Result<RoundOutcome, OrchestratorError> {
        let run = self.run.clone();
        let run_id = self.run.run_id.clone();

        // The streaming callback runs synchronously inside
        // stream_chat_completion's poll loop. `RunHandle::emit_event`
        // is itself sync (std::sync::Mutex + broadcast::send), so we
        // can forward directly without worrying about backpressure
        // from a slow SSE consumer — the replay buffer bounds memory
        // and broadcast drops lagged subscribers.
        let snapshot = tokio::select! {
            _ = cancel.cancelled() => return Err(OrchestratorError::cancelled()),
            result = stream_chat_completion(&self.http_client, spec, move |event| {
                match event {
                    LlmStreamEvent::AssistantDelta(chunk) => {
                        let payload = AgentAssistantDeltaEventPayload {
                            run_id: run_id.clone(),
                            chunk,
                        };
                        run.emit_event(AgentTurnSseEvent::AssistantDelta(payload));
                    }
                    LlmStreamEvent::Usage(usage) => {
                        let payload = AgentUsageEventPayload {
                            run_id: run_id.clone(),
                            usage,
                        };
                        run.emit_event(AgentTurnSseEvent::Usage(payload));
                    }
                }
            }) => result.map_err(|err| OrchestratorError {
                code: AgentTurnErrorCode::ProviderError,
                message: err.to_string(),
                retryable: Some(true),
            })?,
        };

        if !snapshot.tool_calls.is_empty() {
            return Ok(RoundOutcome::ToolCalls {
                assistant_text: snapshot.assistant_text,
                tool_calls: snapshot.tool_calls,
            });
        }
        Ok(RoundOutcome::Done {
            assistant_text: snapshot.assistant_text,
        })
    }

    async fn await_tool_result(
        &self,
        rx: oneshot::Receiver<ToolResultPayload>,
        cancel: &CancellationToken,
    ) -> Result<ToolResultPayload, OrchestratorError> {
        // Tier-aware wait: LongTask expects real builds / delegate calls
        // that can run for tens of minutes, so we stretch to an hour. At
        // the default tier we still bail after 5 minutes — faster failure
        // for the common case where the extension genuinely died.
        let wait_ms = self.run.tier.tool_wait_ms();
        tokio::select! {
            _ = cancel.cancelled() => Err(OrchestratorError::cancelled()),
            res = timeout(Duration::from_millis(wait_ms), rx) => {
                match res {
                    Ok(Ok(payload)) => Ok(payload),
                    Ok(Err(_recv_err)) => Err(OrchestratorError {
                        code: AgentTurnErrorCode::ToolResultRejected,
                        message: "Extension dropped the tool result channel.".to_string(),
                        retryable: Some(false),
                    }),
                    Err(_elapsed) => Err(OrchestratorError {
                        code: AgentTurnErrorCode::ToolResultTimeout,
                        message: format!(
                            "Tool result not received within {}ms.",
                            wait_ms
                        ),
                        retryable: Some(false),
                    }),
                }
            }
        }
    }
}

fn build_assistant_tool_call_message(
    assistant_text: &str,
    tool_calls: &[AggregatedToolCall],
) -> Value {
    let serialized: Vec<Value> = tool_calls
        .iter()
        .map(|call| {
            json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": call.arguments_raw,
                }
            })
        })
        .collect();
    json!({
        "role": "assistant",
        "content": if assistant_text.is_empty() { Value::Null } else { Value::String(assistant_text.to_string()) },
        "tool_calls": serialized,
    })
}

#[derive(Debug, Clone)]
pub struct OrchestratorError {
    pub code: AgentTurnErrorCode,
    pub message: String,
    pub retryable: Option<bool>,
}

impl OrchestratorError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            code: AgentTurnErrorCode::BadRequest,
            message: msg.into(),
            retryable: Some(false),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            code: AgentTurnErrorCode::Cancelled,
            message: "Run cancelled.".to_string(),
            retryable: Some(false),
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: AgentTurnErrorCode::InternalError,
            message: msg.into(),
            retryable: Some(false),
        }
    }
}

impl From<anyhow::Error> for OrchestratorError {
    fn from(err: anyhow::Error) -> Self {
        Self::internal(err.to_string())
    }
}
