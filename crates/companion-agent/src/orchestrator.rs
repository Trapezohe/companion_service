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
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_TURNS: u32 = 32;
const TOOL_RESULT_WAIT_TIMEOUT_SECS: u64 = 60 * 5;
const EVENT_CHANNEL_CAPACITY: usize = 64;

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
    pub event_tx: mpsc::Sender<AgentTurnSseEvent>,
    pub http_client: Client,
}

impl AgentRunOrchestrator {
    /// Spawn a task driving the loop. Returns the receiver end of the event
    /// channel that the SSE handler reads.
    pub fn spawn(
        run: Arc<RunHandle>,
        request: RunAgentTurnRequest,
        http_client: Client,
    ) -> mpsc::Receiver<AgentTurnSseEvent> {
        let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let orchestrator = AgentRunOrchestrator {
            run: run.clone(),
            event_tx: tx,
            http_client,
        };
        tokio::spawn(async move {
            orchestrator.run(request).await;
        });
        rx
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
                let _ = self
                    .event_tx
                    .send(AgentTurnSseEvent::Complete(payload))
                    .await;
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
                let _ = self
                    .event_tx
                    .send(AgentTurnSseEvent::Error(payload))
                    .await;
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
                    for call in tool_calls {
                        if cancel.is_cancelled() {
                            return Err(OrchestratorError::cancelled());
                        }
                        let call_id = call.id.clone();
                        let payload = AgentToolCallEventPayload {
                            run_id: self.run.run_id.clone(),
                            call_id: call_id.clone(),
                            name: call.name.clone(),
                            arguments: call.parsed_arguments(),
                        };
                        let (tx, rx) = oneshot::channel();
                        {
                            let mut pending = self.run.pending_tool.write().await;
                            *pending = Some(PendingToolCall {
                                call_id: call_id.clone(),
                                tx,
                            });
                        }
                        self.event_tx
                            .send(AgentTurnSseEvent::ToolCall(payload))
                            .await
                            .map_err(|_| OrchestratorError::internal("event channel closed"))?;

                        let result = self.await_tool_result(rx, &cancel).await?;
                        invoked_tools.push(call.name.clone());
                        tool_outputs.push(result.result.clone());

                        // Tool result message goes back into the history for
                        // the next round, matching OpenAI's tool-message shape.
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": call.name,
                            "content": result.result,
                        }));
                    }
                    self.run.set_status(AgentTurnStatus::Running).await;
                    // Loop again — the next round may produce more tool calls
                    // or a final answer.
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
        let event_tx = self.event_tx.clone();
        let run_id = self.run.run_id.clone();

        // The streaming callback runs synchronously inside stream_chat_completion's
        // poll loop. We forward via try_send so a slow SSE consumer never
        // blocks the upstream LLM stream — capacity is bounded so this is
        // bounded-loss behavior, not OOM risk.
        let snapshot = tokio::select! {
            _ = cancel.cancelled() => return Err(OrchestratorError::cancelled()),
            result = stream_chat_completion(&self.http_client, spec, move |event| {
                match event {
                    LlmStreamEvent::AssistantDelta(chunk) => {
                        let payload = AgentAssistantDeltaEventPayload {
                            run_id: run_id.clone(),
                            chunk,
                        };
                        let _ = event_tx.try_send(AgentTurnSseEvent::AssistantDelta(payload));
                    }
                    LlmStreamEvent::Usage(usage) => {
                        let payload = AgentUsageEventPayload {
                            run_id: run_id.clone(),
                            usage,
                        };
                        let _ = event_tx.try_send(AgentTurnSseEvent::Usage(payload));
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
        tokio::select! {
            _ = cancel.cancelled() => Err(OrchestratorError::cancelled()),
            res = timeout(Duration::from_secs(TOOL_RESULT_WAIT_TIMEOUT_SECS), rx) => {
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
                            "Tool result not received within {}s.",
                            TOOL_RESULT_WAIT_TIMEOUT_SECS
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
