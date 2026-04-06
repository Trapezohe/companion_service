use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use companion_config::{
    ensure_token, normalize_mcp_server_config, remove_mcp_server_config, remove_pid, save_config,
    update_mcp_server_config, write_pid, CompanionConfig, McpServerConfig,
};
use companion_mcp::McpManager;
use companion_runtime::{
    ExecRequest, LogStream, RuntimeError, RuntimeManager, SessionEventsQuery, SessionListQuery,
    SessionLogQuery, SessionStartRequest, SessionStatusFilter,
};
use companion_shared::{
    capabilities_payload, version_string, PermissionPolicy, SupportedFeatures,
    FIXED_EXTENSION_ORIGIN,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::{watch, RwLock};

#[derive(Clone)]
pub struct AppState {
    config: Arc<RwLock<CompanionConfig>>,
    mcp: McpManager,
    runtime: RuntimeManager,
    shutdown_tx: watch::Sender<bool>,
}

impl AppState {
    pub fn new(config: CompanionConfig) -> Self {
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            config: Arc::new(RwLock::new(config.clone())),
            mcp: McpManager::from_config(&config),
            runtime: RuntimeManager::new(),
            shutdown_tx,
        }
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }

    pub async fn snapshot_config(&self) -> CompanionConfig {
        self.config.read().await.clone()
    }

    async fn update_config<F, T>(&self, apply: F) -> Result<T>
    where
        F: FnOnce(&mut CompanionConfig) -> T,
    {
        let mut guard = self.config.write().await;
        let result = apply(&mut guard);
        save_config(&guard)?;
        Ok(result)
    }

    fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthPayload {
    pub ok: bool,
    pub ts: u64,
    pub pid: u32,
    pub version: String,
    pub protocol_version: String,
    pub run_contract_version: u32,
    pub supported_features: SupportedFeatures,
    pub mcp_servers: usize,
    pub mcp_tools: usize,
    pub permission_policy: PermissionPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeExecBody {
    command: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStopBody {
    force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWriteBody {
    text: Option<String>,
    submit: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSendKeysBody {
    keys: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionListParams {
    status: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SessionLogParams {
    stream: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SessionEventsParams {
    after: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolCallBody {
    server: Option<String>,
    tool: Option<String>,
    arguments: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpUpsertBody {
    name: Option<String>,
    config: Option<McpServerConfig>,
}

pub async fn serve_with_signals(mut config: CompanionConfig) -> Result<()> {
    ensure_token(&mut config)?;
    let state = AppState::new(config.clone());
    state.mcp.start_all().await;
    let _started_at = Instant::now();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .await
        .with_context(|| {
            format!(
                "Failed to bind companion daemon on 127.0.0.1:{}",
                config.port
            )
        })?;
    let bind_addr = listener.local_addr()?;
    let _pid_guard = PidFileGuard::new(std::process::id())?;
    let mut shutdown_rx = state.shutdown_receiver();
    let app = build_router(state.clone());

    serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_rx.changed() => {},
                _ = shutdown_signal() => {},
            }
        })
        .await
        .context("Companion daemon exited unexpectedly")?;

    state.mcp.stop_all().await;
    tracing::info!("companion daemon stopped: {}", bind_addr);
    Ok(())
}

pub async fn probe_health(config: &CompanionConfig) -> Result<Option<HealthPayload>> {
    let token = config.token.trim();
    if token.is_empty() {
        return Ok(None);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .get(format!("http://127.0.0.1:{}/healthz", config.port))
        .bearer_auth(token)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(Some(response.json::<HealthPayload>().await?))
}

pub async fn request_shutdown(config: &CompanionConfig) -> Result<bool> {
    let token = config.token.trim();
    if token.is_empty() {
        return Ok(false);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/api/system/shutdown",
            config.port
        ))
        .bearer_auth(token)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => Ok(true),
        Ok(_) | Err(_) => Ok(false),
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/system/capabilities", get(system_capabilities))
        .route("/api/system/shutdown", post(system_shutdown))
        .route("/api/mcp/servers", get(mcp_servers))
        .route("/api/mcp/tools", get(mcp_tools))
        .route("/api/mcp/tools/call", post(mcp_call_tool))
        .route("/api/mcp/servers/upsert", post(mcp_upsert_server))
        .route(
            "/api/mcp/servers/{name}",
            axum::routing::delete(mcp_delete_server),
        )
        .route("/api/mcp/servers/{name}/restart", post(mcp_restart_server))
        .route("/api/runtime/exec", post(runtime_exec))
        .route("/api/local-runtime/exec", post(runtime_exec))
        .route("/api/runtime/session/start", post(runtime_session_start))
        .route(
            "/api/local-runtime/session/start",
            post(runtime_session_start),
        )
        .route("/api/runtime/sessions", get(runtime_sessions))
        .route("/api/local-runtime/sessions", get(runtime_sessions))
        .route(
            "/api/runtime/sessions/{session_id}/log",
            get(runtime_session_log),
        )
        .route(
            "/api/local-runtime/sessions/{session_id}/log",
            get(runtime_session_log),
        )
        .route(
            "/api/runtime/session/{session_id}",
            get(runtime_session_status),
        )
        .route(
            "/api/local-runtime/session/{session_id}",
            get(runtime_session_status),
        )
        .route(
            "/api/runtime/session/{session_id}/stop",
            post(runtime_session_stop),
        )
        .route(
            "/api/local-runtime/session/{session_id}/stop",
            post(runtime_session_stop),
        )
        .route(
            "/api/runtime/session/{session_id}/write",
            post(runtime_session_write),
        )
        .route(
            "/api/local-runtime/session/{session_id}/write",
            post(runtime_session_write),
        )
        .route(
            "/api/runtime/session/{session_id}/send-keys",
            post(runtime_session_send_keys),
        )
        .route(
            "/api/local-runtime/session/{session_id}/send-keys",
            post(runtime_session_send_keys),
        )
        .route("/api/runtime/session-events", get(runtime_session_events))
        .route(
            "/api/local-runtime/session-events",
            get(runtime_session_events),
        )
        .route(
            "/api/security/policy",
            get(get_security_policy).post(update_security_policy),
        )
        .route(
            "/api/security/capabilities",
            get(get_security_capabilities).post(update_security_capabilities),
        )
        .route("/{*path}", axum::routing::options(preflight))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(state)
}

async fn preflight() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn healthz(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HealthPayload>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(HealthPayload {
        ok: true,
        ts: now_millis(),
        pid: std::process::id(),
        version: version_string(),
        protocol_version: capabilities_payload().protocol_version,
        run_contract_version: capabilities_payload().run_contract_version,
        supported_features: SupportedFeatures::default(),
        mcp_servers: state.mcp.get_connected_count().await,
        mcp_tools: state.mcp.get_all_tools().await.len(),
        permission_policy: config.permission_policy,
    }))
}

async fn system_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(serde_json::to_value(capabilities_payload()).unwrap()))
}

async fn system_shutdown(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    state.request_shutdown();
    Ok(Json(json!({ "ok": true })))
}

async fn runtime_exec(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RuntimeExecBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "local_command",
        "Local command execution is disabled in Companion permissions.",
    )?;
    let result = state
        .runtime
        .run_command(ExecRequest {
            command: body.command.unwrap_or_default(),
            cwd: body.cwd,
            timeout_ms: body.timeout_ms,
            env: body.env.map(|value| value.into_iter().collect()),
            permission_policy: config.permission_policy.clone(),
        })
        .await
        .map_err(map_exec_runtime_error)?;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_session_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RuntimeExecBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "local_command",
        "Local command execution is disabled in Companion permissions.",
    )?;
    let result = state
        .runtime
        .start_session(SessionStartRequest {
            command: body.command.unwrap_or_default(),
            cwd: body.cwd,
            timeout_ms: body.timeout_ms,
            env: body.env.map(|value| value.into_iter().collect()),
            permission_policy: config.permission_policy.clone(),
        })
        .await
        .map_err(map_exec_runtime_error)?;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SessionListParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let status = match query
        .status
        .as_deref()
        .map(|value| value.trim().to_lowercase())
    {
        Some(value) if value == "running" => Some(SessionStatusFilter::Running),
        Some(value) if value == "exited" => Some(SessionStatusFilter::Exited),
        Some(_) => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "status must be one of: running, exited",
            ));
        }
        None => None,
    };
    let result = state
        .runtime
        .list_sessions(SessionListQuery {
            status,
            limit: query.limit,
            offset: query.offset,
        })
        .await;
    Ok(Json(json!({
        "ok": true,
        "sessions": result.sessions,
        "total": result.total,
        "offset": result.offset,
        "limit": result.limit,
        "hasMore": result.has_more,
    })))
}

async fn runtime_session_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<SessionLogParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let stream = match query
        .stream
        .as_deref()
        .unwrap_or("both")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "stdout" => LogStream::Stdout,
        "stderr" => LogStream::Stderr,
        "both" => LogStream::Both,
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "stream must be one of: stdout, stderr, both",
            ));
        }
    };
    let result = state
        .runtime
        .get_session_log(
            &session_id,
            SessionLogQuery {
                stream,
                limit: query.limit,
                offset: query.offset,
            },
        )
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_session_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let Some(result) = state.runtime.get_session(&session_id).await else {
        return Err(json_error(StatusCode::NOT_FOUND, "Session not found."));
    };
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_session_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionStopBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let result = state
        .runtime
        .stop_session(&session_id, body.force.unwrap_or(false))
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_session_write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionWriteBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let submit = body.submit.unwrap_or(false);
    let text = body.text.unwrap_or_default();
    if text.is_empty() && !submit {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "text is required unless submit=true.",
        ));
    }
    let result = state
        .runtime
        .write_to_session(&session_id, text, submit)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_session_send_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<SessionSendKeysBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let Some(keys) = body.keys.map(|value| value.trim().to_string()) else {
        return Err(json_error(StatusCode::BAD_REQUEST, "keys is required."));
    };
    if keys.is_empty() {
        return Err(json_error(StatusCode::BAD_REQUEST, "keys is required."));
    }
    let result = state
        .runtime
        .send_keys_to_session(&session_id, &keys)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(result))
}

async fn runtime_session_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SessionEventsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let result = state
        .runtime
        .list_session_events(SessionEventsQuery {
            after: query.after,
            limit: query.limit,
        })
        .await;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn mcp_servers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(json!({
        "servers": state.mcp.get_servers().await,
    })))
}

async fn mcp_tools(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(json!({
        "tools": state.mcp.get_all_tools().await,
    })))
}

async fn mcp_call_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<McpToolCallBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let server = body.server.unwrap_or_default();
    let tool = body.tool.unwrap_or_default();
    if server.trim().is_empty() || tool.trim().is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "\"server\" and \"tool\" are required.",
        ));
    }
    let result = state
        .mcp
        .call_tool(&server, &tool, body.arguments.unwrap_or_else(|| json!({})))
        .await;
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn mcp_upsert_server(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<McpUpsertBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let current = state.snapshot_config().await;
    authorize(&headers, &current)?;
    let name = body.name.unwrap_or_default();
    let config = body
        .config
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "\"config\" is required."))?;
    let normalized = normalize_mcp_server_config(&config).map_err(internal_error)?;
    let next_config =
        update_mcp_server_config(&current, &name, &normalized).map_err(internal_error)?;
    save_config(&next_config).map_err(internal_error)?;
    {
        let mut guard = state.config.write().await;
        *guard = next_config.clone();
    }
    state
        .mcp
        .upsert_server(&name, normalized, true)
        .await
        .map_err(internal_error)?;
    let server = state
        .mcp
        .get_servers()
        .await
        .into_iter()
        .find(|item| item.name == name.trim());
    Ok(Json(json!({
        "ok": true,
        "name": name.trim(),
        "server": server,
    })))
}

async fn mcp_delete_server(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let current = state.snapshot_config().await;
    authorize(&headers, &current)?;
    let (next_config, removed) =
        remove_mcp_server_config(&current, &name).map_err(internal_error)?;
    save_config(&next_config).map_err(internal_error)?;
    {
        let mut guard = state.config.write().await;
        *guard = next_config;
    }
    let _ = state
        .mcp
        .delete_server(&name)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({
        "ok": true,
        "name": name,
        "removed": removed,
    })))
}

async fn mcp_restart_server(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    state
        .mcp
        .restart_server(&name)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({
        "ok": true,
        "name": name,
    })))
}

async fn get_security_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(json!({
        "policy": config.permission_policy,
    })))
}

async fn update_security_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let current = state.snapshot_config().await;
    authorize(&headers, &current)?;
    let body_policy = body.get("policy").cloned().unwrap_or_else(|| body.clone());
    let parsed = serde_json::from_value::<PermissionPolicy>(body_policy)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    let next_policy = companion_config::normalize_permission_policy(&parsed);
    state
        .update_config(|config| {
            config.permission_policy = next_policy.clone();
            config.permission_policy.clone()
        })
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({
        "ok": true,
        "policy": next_policy,
    })))
}

async fn get_security_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    Ok(Json(json!({
        "capabilities": config.companion_capabilities,
    })))
}

async fn update_security_capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let current = state.snapshot_config().await;
    authorize(&headers, &current)?;
    let body_capabilities = body
        .get("capabilities")
        .cloned()
        .unwrap_or_else(|| body.clone());
    let incoming = serde_json::from_value::<BTreeMap<String, bool>>(body_capabilities)
        .unwrap_or_else(|_| current.companion_capabilities.clone());
    let next_capabilities = companion_config::normalize_companion_capabilities(&incoming);
    state
        .update_config(|config| {
            config.companion_capabilities = next_capabilities.clone();
            config.companion_capabilities.clone()
        })
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({
        "ok": true,
        "capabilities": next_capabilities,
    })))
}

async fn cors_middleware(req: axum::extract::Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().trim_end_matches('/').to_string());
    let mut response = next.run(req).await;
    if let Some(origin) = origin {
        if origin == FIXED_EXTENSION_ORIGIN {
            response.headers_mut().insert(
                "access-control-allow-origin",
                HeaderValue::from_str(FIXED_EXTENSION_ORIGIN).unwrap(),
            );
            response
                .headers_mut()
                .insert("vary", HeaderValue::from_static("Origin"));
        }
    }
    response.headers_mut().insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Content-Type, Authorization"),
    );
    response.headers_mut().insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    response
}

fn authorize(headers: &HeaderMap, config: &CompanionConfig) -> Result<(), Response> {
    let token = config.token.trim();
    if token.is_empty() {
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Companion token is not configured.",
        ));
    }
    let Some(value) = headers.get(axum::http::header::AUTHORIZATION) else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Missing Authorization header.",
        ));
    };
    let Ok(text) = value.to_str() else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Invalid Authorization header.",
        ));
    };
    let Some(bearer) = text.strip_prefix("Bearer ") else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Expected Bearer token.",
        ));
    };
    if bearer.trim() != token {
        return Err(json_error(StatusCode::UNAUTHORIZED, "Invalid token."));
    }
    Ok(())
}

fn ensure_capability_enabled(
    config: &CompanionConfig,
    capability: &str,
    message: &str,
) -> Result<(), Response> {
    if config
        .companion_capabilities
        .get(capability)
        .copied()
        .unwrap_or(false)
    {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": message,
            "code": "companion_capability_disabled",
            "capability": capability,
        })),
    )
        .into_response())
}

fn map_exec_runtime_error(error: RuntimeError) -> Response {
    match error {
        RuntimeError::PermissionPolicyViolation(message) => (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": message,
                "code": "permission_policy_violation",
            })),
        )
            .into_response(),
        RuntimeError::SessionNotFound(message) => json_error(StatusCode::NOT_FOUND, &message),
        RuntimeError::InvalidRequest(message) => json_error(StatusCode::BAD_REQUEST, &message),
    }
}

fn map_runtime_error(error: RuntimeError) -> Response {
    match error {
        RuntimeError::SessionNotFound(message) => json_error(StatusCode::NOT_FOUND, &message),
        RuntimeError::PermissionPolicyViolation(message) => (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": message,
                "code": "permission_policy_violation",
            })),
        )
            .into_response(),
        RuntimeError::InvalidRequest(message) => json_error(StatusCode::BAD_REQUEST, &message),
    }
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn internal_error(error: anyhow::Error) -> Response {
    tracing::error!("companion daemon error: {error:#}");
    json_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = async {
                if let Some(signal) = term.as_mut() {
                    signal.recv().await;
                }
            } => {},
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

struct PidFileGuard {}

impl PidFileGuard {
    fn new(pid: u32) -> Result<Self> {
        write_pid(pid)?;
        Ok(Self {})
    }
}

impl Drop for PidFileGuard {
    fn drop(&mut self) {
        let _ = remove_pid();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    fn test_config() -> CompanionConfig {
        let mut config = CompanionConfig::default();
        config.token = "secret-token".to_string();
        config
            .companion_capabilities
            .insert("local_command".to_string(), true);
        config
    }

    #[tokio::test]
    async fn healthz_requires_authorization() {
        let app = build_router(AppState::new(test_config()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn healthz_returns_payload_for_valid_token() {
        let app = build_router(AppState::new(test_config()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .header("authorization", "Bearer secret-token")
                    .header("origin", FIXED_EXTENSION_ORIGIN)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            FIXED_EXTENSION_ORIGIN
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("ok").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("runContractVersion")
                .and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[tokio::test]
    async fn runtime_exec_endpoint_returns_command_output() {
        let app = build_router(AppState::new(test_config()));
        let command = if cfg!(windows) {
            "echo hello"
        } else {
            "printf hello"
        };
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/runtime/exec")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "command": command }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("ok").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(payload["stdout"]
            .as_str()
            .unwrap_or_default()
            .contains("hello"));
    }

    #[tokio::test]
    async fn mcp_servers_endpoint_lists_configured_servers() {
        let mut config = test_config();
        config.mcp_servers.insert(
            "demo".to_string(),
            McpServerConfig {
                command: "node".to_string(),
                args: vec!["demo.mjs".to_string()],
                env: BTreeMap::new(),
                cwd: None,
                request_timeout_ms: Some(5_000),
                restartable: Some(true),
                write_capable: Some(false),
            },
        );
        let app = build_router(AppState::new(config));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/servers")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let servers = payload["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"].as_str(), Some("demo"));
        assert_eq!(servers[0]["status"].as_str(), Some("stopped"));
    }
}
