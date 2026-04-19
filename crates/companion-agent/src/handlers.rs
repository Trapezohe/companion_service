// Axum handlers for the agent endpoints. Wired into the main daemon router
// via `agent_routes()`. The handlers are intentionally thin: parse → kick
// off orchestrator → stream events back. State (run store, http client) is
// shared via AgentState and constructed once at daemon startup.
use crate::orchestrator::AgentRunOrchestrator;
use crate::persist::AgentRunPersistence;
use crate::store::{
    AgentRunStore, CreateRunMetadata, DeliverToolResult, ToolResultPayload,
};
use crate::types::{
    AgentToolResultAck, AgentToolResultRequest, AgentTurnSseEvent, RunAgentTurnRequest,
    RunAgentTurnStatusResponse,
};
use async_stream::stream;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use reqwest::Client;
use serde_json::json;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

pub const COMPANION_AGENT_RUN_ID_HEADER: &str = "x-companion-agent-run-id";

#[derive(Clone)]
pub struct AgentState {
    pub store: AgentRunStore,
    pub http_client: Client,
}

impl AgentState {
    /// In-memory only. Daemon restart loses all run history. Useful for
    /// tests + the no-config-dir code path.
    pub fn new(http_client: Client) -> Self {
        Self {
            store: AgentRunStore::new(),
            http_client,
        }
    }

    /// Disk-backed run history. On creation, replays orphan recovery so
    /// any run that was running/waiting at the previous shutdown gets
    /// marked failed with reason='daemon_restart_orphan'. Extension
    /// clients calling /status on those run_ids see the failed state and
    /// fall back to the local loop instead of waiting on a dead stream.
    pub fn new_with_persistence(http_client: Client, persistence: AgentRunPersistence) -> Self {
        Self {
            store: AgentRunStore::new_with_persistence(persistence),
            http_client,
        }
    }
}

/// Auth callback: each route in the router asks the daemon to validate the
/// bearer token. We don't bake the daemon's CompanionConfig directly into
/// this crate to keep the dependency one-way (daemon depends on agent, not
/// the reverse).
pub type AgentAuthFn = Arc<dyn Fn(&HeaderMap) -> Result<(), Response> + Send + Sync>;

#[derive(Clone)]
pub struct AgentRouterState {
    pub agent: AgentState,
    pub auth: AgentAuthFn,
}

pub fn agent_routes(state: AgentRouterState) -> Router {
    Router::new()
        .route("/api/agent/turn", post(start_agent_turn))
        .route(
            "/api/agent/turn/{run_id}/tool_result",
            post(post_tool_result),
        )
        .route("/api/agent/turn/{run_id}/cancel", post(cancel_agent_turn))
        .route("/api/agent/turn/{run_id}/status", get(get_agent_turn_status))
        .with_state(state)
}

async fn start_agent_turn(
    State(state): State<AgentRouterState>,
    headers: HeaderMap,
    Json(request): Json<RunAgentTurnRequest>,
) -> Response {
    if let Err(response) = (state.auth)(&headers) {
        return response;
    }

    if request.api_secret.first().unwrap_or("").trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "RunAgentTurnRequest.apiSecret must contain at least one non-empty entry.",
        );
    }
    if request.system_prompt.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "RunAgentTurnRequest.systemPrompt must not be empty.",
        );
    }
    if request.provider_url.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "RunAgentTurnRequest.providerUrl must not be empty.",
        );
    }

    let run = state
        .agent
        .store
        .create_with_metadata(CreateRunMetadata {
            conversation_id: request.conversation_id.clone(),
            model: Some(request.model.clone()),
            tier: request.tier,
        })
        .await;
    let run_id = run.run_id.clone();
    let event_rx = AgentRunOrchestrator::spawn(
        run.clone(),
        request,
        state.agent.http_client.clone(),
    );

    let event_stream = build_event_stream(run_id.clone(), state.agent.store.clone(), event_rx);

    let mut response = Sse::new(event_stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&run_id) {
        response.headers_mut().insert(COMPANION_AGENT_RUN_ID_HEADER, value);
    }
    response
}

fn build_event_stream(
    run_id: String,
    store: AgentRunStore,
    event_rx: tokio::sync::mpsc::Receiver<AgentTurnSseEvent>,
) -> impl Stream<Item = Result<SseEvent, Infallible>> + Send + 'static {
    stream! {
        let mut rx = ReceiverStream::new(event_rx);
        while let Some(event) = rx.next().await {
            let json = match serde_json::to_string(&event) {
                Ok(s) => s,
                Err(_) => continue,
            };
            // Mark terminality before yielding so a slow downstream still
            // observes the final event before we drop the run from the store.
            let is_terminal = matches!(
                event,
                AgentTurnSseEvent::Complete(_) | AgentTurnSseEvent::Error(_)
            );
            yield Ok(SseEvent::default().event("message").data(json));
            if is_terminal {
                break;
            }
        }
        // Cleanup: drop the run from the inflight map. Snapshot persists for
        // any caller still holding the Arc<RunHandle>.
        let _ = store.remove(&run_id).await;
    }
}

async fn post_tool_result(
    State(state): State<AgentRouterState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<AgentToolResultRequest>,
) -> Response {
    if let Err(response) = (state.auth)(&headers) {
        return response;
    }
    let Some(handle) = state.agent.store.get(&run_id).await else {
        return json_error(StatusCode::NOT_FOUND, "Unknown agent run id.");
    };
    let outcome = handle
        .deliver_tool_result(ToolResultPayload {
            call_id: payload.call_id.clone(),
            result: payload.result,
            success: payload.success,
        })
        .await;
    match outcome {
        DeliverToolResult::Delivered => Json(AgentToolResultAck {
            ok: true,
            run_id,
            call_id: payload.call_id,
        })
        .into_response(),
        DeliverToolResult::NoPendingCall => json_error(
            StatusCode::CONFLICT,
            "No pending tool call awaiting a result for this run.",
        ),
        DeliverToolResult::CallIdMismatch { expected } => Response::builder()
            .status(StatusCode::CONFLICT)
            .header(header::CONTENT_TYPE, "application/json")
            .body(
                serde_json::to_string(&json!({
                    "error": "Tool call id mismatch.",
                    "expected": expected,
                }))
                .unwrap_or_default()
                .into(),
            )
            .unwrap_or_else(|_| {
                json_error(StatusCode::CONFLICT, "Tool call id mismatch.")
            }),
        DeliverToolResult::RunNotReceiving => json_error(
            StatusCode::CONFLICT,
            "Run is not currently waiting for a tool result.",
        ),
    }
}

async fn cancel_agent_turn(
    State(state): State<AgentRouterState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = (state.auth)(&headers) {
        return response;
    }
    let Some(handle) = state.agent.store.get(&run_id).await else {
        return json_error(StatusCode::NOT_FOUND, "Unknown agent run id.");
    };
    handle.record_cancellation().await;
    Json(json!({ "ok": true, "runId": run_id })).into_response()
}

async fn get_agent_turn_status(
    State(state): State<AgentRouterState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = (state.auth)(&headers) {
        return response;
    }
    // Consults the terminal-history map too, so orphan-recovered runs and
    // runs that have already been removed from the live map still answer.
    let Some(snapshot) = state.agent.store.snapshot_for(&run_id).await else {
        return json_error(StatusCode::NOT_FOUND, "Unknown agent run id.");
    };
    Json(RunAgentTurnStatusResponse {
        ok: true,
        run_id: snapshot.run_id,
        status: snapshot.status,
        updated_at: snapshot.updated_at,
        result: snapshot.result,
        error: snapshot.error,
    })
    .into_response()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::to_string(&json!({ "error": message }))
                .unwrap_or_else(|_| String::from("{\"error\":\"unknown error\"}"))
                .into(),
        )
        .unwrap_or_else(|_| Response::new("{}".into()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn auth_failure_short_circuits() {
        let auth: AgentAuthFn = Arc::new(|_headers: &HeaderMap| {
            Err(json_error(StatusCode::UNAUTHORIZED, "no token"))
        });
        let agent = AgentState::new(Client::new());
        let state = AgentRouterState { agent, auth };

        let response = start_agent_turn(
            State(state),
            HeaderMap::new(),
            Json(RunAgentTurnRequest {
                conversation_id: None,
                system_prompt: "x".to_string(),
                post_system_messages: None,
                history: vec![],
                prompt: "y".to_string(),
                provider_url: "https://example.com".to_string(),
                model: "test".to_string(),
                api_secret: crate::types::ApiSecretInput::Single("token".to_string()),
                tool_definitions: vec![],
                max_turns: None,
                tier: companion_shared::RunTier::default(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
