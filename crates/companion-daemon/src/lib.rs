use anyhow::{anyhow, Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{serve, Json, Router};
use companion_acp::{
    AcpManager, CommandSpec, CreateSessionInput as AcpCreateSessionInput,
    PromptInput as AcpPromptInput, SessionEventsQuery as AcpEventsQuery,
    SessionListQuery as AcpListQuery, SteerInput as AcpSteerInput,
};
use companion_agent::{
    agent_routes, AgentAuthFn, AgentRouterState, AgentRunPersistence, AgentState,
};
use companion_app::{
    activate_window, capture_screenshot, complete_reminder, create_calendar_event, create_note,
    create_reminder, delete_scheduled_task, get_clipboard_text, list_calendar_events,
    list_calendars, list_contact_groups, list_contacts, list_explorer_items, list_finder_items,
    list_note_folders, list_notes, list_processes, list_reminder_lists, list_reminders,
    list_safari_tabs, list_scheduled_tasks, list_services, list_windows, minimize_window,
    open_safari_tab, read_text_file, restart_service, reveal_explorer_item, reveal_finder_item,
    run_admin_shell, run_scheduled_task, set_clipboard_text, show_desktop_notification,
    start_service, stop_service, terminate_process, write_registry_value, write_text_file,
    AdminShellRequest, AdminShellResult, AppIntegrationError, CalendarEvent,
    CaptureScreenshotRequest, ClipboardTextResult, CompleteReminderRequest,
    CreateCalendarEventRequest, CreateNoteRequest, CreateReminderRequest,
    DesktopNotificationRequest, DesktopNotificationResult, ExplorerRevealRequest,
    ExplorerRevealResult, FinderRevealRequest, FinderRevealResult, ListCalendarEventsRequest,
    ListContactsRequest, ListExplorerItemsRequest, ListFinderItemsRequest, ListNotesRequest,
    ListProcessesRequest, ListRemindersRequest, ListSafariTabsRequest, ListScheduledTasksRequest,
    ListServicesRequest, ListWindowsRequest, NoteItem, OpenSafariTabRequest,
    ProcessTerminationResult, ReadTextFileRequest, RegistryWriteRequest, RegistryWriteResult,
    ReminderCompletion, ReminderItem, SafariTab, ScheduledTaskActionRequest,
    ScheduledTaskActionResult, ScreenshotCapture, ServiceActionRequest, ServiceActionResult,
    SetClipboardTextRequest, TerminateProcessRequest, TextFileContent, TextFileWriteResult,
    WindowActionRequest, WindowActionResult,
};
use companion_automation::AutomationOutboxStore;
use companion_browser::{
    BrowserActionListQuery, BrowserArtifactListQuery, BrowserDrilldownQuery, BrowserEventsQuery,
    BrowserLedger, BrowserSessionListQuery,
};
use companion_checkpoint::{
    execute_zero_g_checkpoint_job, zero_g_executor_support_reason, zero_g_executor_supported,
    CheckpointJobRunner, CheckpointJobStatus, CheckpointJobSubmitInput, CheckpointJobSubmitResult,
};
use companion_config::{
    ensure_token, get_config_dir, get_config_path, get_pid_path, mark_mcp_server_disabled,
    mark_mcp_server_enabled, normalize_mcp_server_config, remove_mcp_server_config, remove_pid,
    save_config, sync_discovered_mcp_servers, update_mcp_server_config, write_pid,
    CheckpointSyncConfig, CompanionConfig, McpServerConfig,
};
use companion_control::{
    ApprovalStore, CreateApprovalInput, CreateRunInput, RunLinkInput, RunListQuery, RunRecord,
    RunStore,
};
use companion_cron::CronStore;
use companion_mcp::{ListedTool, McpManager, ToolCallResult};
use companion_media::{
    extract_image_text_payload, normalize_image_payload, probe_media_normalization_support,
    ImageOcrRequest, NormalizeImageRequest,
};
use companion_memory::{ShadowRefreshManager, ShadowStore};
use companion_runtime::{
    ExecRequest, LogStream, RuntimeError, RuntimeManager, SessionEventsQuery, SessionListQuery,
    SessionLogQuery, SessionStartRequest, SessionStatusFilter,
};
use companion_shared::{
    capabilities_payload, version_string, CapabilitiesPayload, PermissionPolicy, RunTier,
    SupportedFeatures, FIXED_EXTENSION_ORIGIN,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::{watch, RwLock};
use tokio::time::sleep;

const BUILTIN_DESKTOP_TOOL_SERVER: &str = "ghast-companion-native";
const BUILTIN_DESKTOP_TOOL_NAME: &str = "desktop_control";

#[derive(Clone)]
pub struct AppState {
    config: Arc<RwLock<CompanionConfig>>,
    store_dir: PathBuf,
    mcp: McpManager,
    runtime: RuntimeManager,
    browser: BrowserLedger,
    cron: CronStore,
    automation_outbox: AutomationOutboxStore,
    memory_shadow: ShadowStore,
    memory_shadow_refresh: ShadowRefreshManager,
    acp: AcpManager,
    runs: RunStore,
    approvals: ApprovalStore,
    checkpoint_jobs: Arc<RwLock<CheckpointJobRunner>>,
    /// Hosts the `/api/agent/turn` LLM-loop endpoints. Lives here so the
    /// run store survives across HTTP requests within a single daemon
    /// process. With a config dir, metadata is also persisted to disk so
    /// run history + orphan recovery survive daemon restarts; without one
    /// the store falls back to memory-only mode.
    agent: AgentState,
    shutdown_tx: watch::Sender<bool>,
}

impl AppState {
    pub fn new(config: CompanionConfig) -> Self {
        Self::new_in(config, None::<PathBuf>)
    }

    pub fn new_in<P>(config: CompanionConfig, config_dir: Option<P>) -> Self
    where
        P: Into<PathBuf>,
    {
        let (shutdown_tx, _) = watch::channel(false);
        let store_dir = config_dir.map(Into::into);
        let checkpoint_store_dir = store_dir.clone().unwrap_or_else(get_config_dir);
        let checkpoint_jobs = build_checkpoint_job_runner(&config, Some(&checkpoint_store_dir));
        Self {
            config: Arc::new(RwLock::new(config.clone())),
            store_dir: checkpoint_store_dir,
            mcp: McpManager::from_config(&config),
            runtime: store_dir
                .as_ref()
                .map(|value| RuntimeManager::new_in(value.clone()))
                .unwrap_or_else(RuntimeManager::new),
            browser: store_dir
                .as_ref()
                .map(|value| BrowserLedger::new_in(value.clone()))
                .unwrap_or_else(BrowserLedger::new),
            cron: store_dir
                .as_ref()
                .map(|value| CronStore::new_in(value.clone()))
                .unwrap_or_else(CronStore::new),
            automation_outbox: store_dir
                .as_ref()
                .map(|value| AutomationOutboxStore::new_in(value.clone()))
                .unwrap_or_else(AutomationOutboxStore::new),
            memory_shadow: store_dir
                .as_ref()
                .map(|value| ShadowStore::new_in(value.clone()))
                .unwrap_or_else(ShadowStore::new),
            memory_shadow_refresh: store_dir
                .as_ref()
                .map(|value| ShadowRefreshManager::new_in(value.clone()))
                .unwrap_or_else(ShadowRefreshManager::new),
            checkpoint_jobs: Arc::new(RwLock::new(checkpoint_jobs)),
            acp: store_dir
                .as_ref()
                .map(|value| AcpManager::new_in(value.clone()))
                .unwrap_or_else(AcpManager::new),
            runs: store_dir
                .as_ref()
                .map(|value| RunStore::new_in(value.clone()))
                .unwrap_or_else(RunStore::new),
            approvals: store_dir
                .as_ref()
                .map(|value| ApprovalStore::new_in(value.clone()))
                .unwrap_or_else(ApprovalStore::new),
            agent: store_dir
                .as_ref()
                .map(|value| {
                    AgentState::new_with_persistence(
                        reqwest::Client::new(),
                        AgentRunPersistence::new(value.clone()),
                    )
                })
                .unwrap_or_else(|| AgentState::new(reqwest::Client::new())),
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

    async fn checkpoint_jobs_runner(&self) -> CheckpointJobRunner {
        self.checkpoint_jobs.read().await.clone()
    }

    async fn update_checkpoint_sync(
        &self,
        checkpoint_sync: Option<CheckpointSyncConfig>,
    ) -> Result<CheckpointJobRunner> {
        let previous_runner = self.checkpoint_jobs_runner().await;
        let next_config = {
            let mut guard = self.config.write().await;
            guard.checkpoint_sync = checkpoint_sync;
            save_config(&guard)?;
            guard.clone()
        };
        let next_runner = build_checkpoint_job_runner(&next_config, Some(&self.store_dir));
        {
            let mut guard = self.checkpoint_jobs.write().await;
            *guard = next_runner.clone();
        }
        if !previous_runner.is_available() && next_runner.is_available() {
            let _ = next_runner.resume_pending_jobs().await?;
        }
        Ok(next_runner)
    }

    fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    async fn supported_features(&self) -> SupportedFeatures {
        let checkpoint_jobs = self.checkpoint_jobs_runner().await;
        SupportedFeatures {
            memory_checkpoint_jobs: checkpoint_jobs.is_available(),
            ..SupportedFeatures::default()
        }
    }

    async fn capabilities_payload(&self) -> CapabilitiesPayload {
        let mut payload = capabilities_payload();
        payload.supported_features = self.supported_features().await;
        payload
    }

    async fn resume_pending_checkpoint_jobs(&self) -> Result<Vec<Option<CheckpointJobStatus>>> {
        let checkpoint_jobs = self.checkpoint_jobs_runner().await;
        if !checkpoint_jobs.is_available() {
            return Ok(Vec::new());
        }
        checkpoint_jobs.resume_pending_jobs().await
    }

    #[cfg(test)]
    async fn set_checkpoint_jobs_for_tests(&self, checkpoint_jobs: CheckpointJobRunner) {
        *self.checkpoint_jobs.write().await = checkpoint_jobs;
    }
}

fn build_checkpoint_job_runner(
    config: &CompanionConfig,
    store_dir: Option<&PathBuf>,
) -> CheckpointJobRunner {
    let Some(sync_config) = config
        .checkpoint_sync
        .clone()
        .filter(zero_g_executor_supported)
    else {
        return store_dir
            .map(|value| CheckpointJobRunner::new_in(value.clone()))
            .unwrap_or_else(CheckpointJobRunner::new);
    };

    let executor = move |job| {
        let sync_config = sync_config.clone();
        async move { execute_zero_g_checkpoint_job(sync_config, job).await }
    };

    if let Some(value) = store_dir {
        CheckpointJobRunner::with_executor_in(value.clone(), executor)
    } else {
        CheckpointJobRunner::with_executor_in(get_config_dir(), executor)
    }
}

fn checkpoint_job_support_reason(config: &CompanionConfig) -> &'static str {
    match config.checkpoint_sync.as_ref() {
        None => "not_configured",
        Some(sync_config) => zero_g_executor_support_reason(sync_config),
    }
}

fn checkpoint_sync_payload(config: &CompanionConfig, checkpoint_jobs_available: bool) -> Value {
    json!({
        "configured": config.checkpoint_sync.is_some(),
        "hasKvRpc": config
            .checkpoint_sync
            .as_ref()
            .and_then(|value| value.kv_rpc.as_ref())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        "streamId": config
            .checkpoint_sync
            .as_ref()
            .map(|value| mask_sensitive_tail(&value.stream_id, 8))
            .unwrap_or_default(),
        "jobsAvailable": checkpoint_jobs_available,
        "jobSupportStatus": if checkpoint_jobs_available {
            "ready"
        } else if config.checkpoint_sync.is_some() {
            "unavailable"
        } else {
            "disabled"
        },
        "jobSupportReason": checkpoint_job_support_reason(config),
    })
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
    /// Declared by the caller. Absent / unrecognized → default tier
    /// (historical 5-min cap). Extensions set `"long_task"` when running
    /// a command they've explicitly authorized to run long (build, test,
    /// large sync).
    #[serde(default)]
    tier: RunTier,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEventsParams {
    calendar_name: Option<String>,
    from_at: Option<String>,
    to_at: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEventCreateBody {
    title: Option<String>,
    start_at: Option<String>,
    end_at: Option<String>,
    calendar_name: Option<String>,
    location: Option<String>,
    notes: Option<String>,
    all_day: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderItemsParams {
    list_name: Option<String>,
    include_completed: Option<bool>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderCreateBody {
    title: Option<String>,
    list_name: Option<String>,
    due_at: Option<String>,
    notes: Option<String>,
    priority: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactsParams {
    query: Option<String>,
    group_id: Option<String>,
    group_name: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesParams {
    folder_id: Option<String>,
    folder_name: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteCreateBody {
    title: Option<String>,
    body: Option<String>,
    folder_id: Option<String>,
    folder_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinderItemsParams {
    path: Option<String>,
    include_hidden: Option<bool>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinderRevealBody {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardSetBody {
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerItemsParams {
    path: Option<String>,
    include_hidden: Option<bool>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerRevealBody {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessItemsParams {
    query: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessTerminateBody {
    pid: Option<u32>,
    force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotCaptureBody {
    display_index: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafariTabsParams {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafariOpenTabBody {
    url: Option<String>,
    activate: Option<bool>,
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
struct SessionLogStreamParams {
    stream: Option<String>,
    offset: Option<usize>,
    #[serde(alias = "pollIntervalMs")]
    poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SessionEventsParams {
    after: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct RunListParams {
    #[serde(rename = "type")]
    run_type: Option<String>,
    state: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct RunDiagnosticsParams {
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
struct DesktopControlToolArgs {
    action: Option<String>,
    text: Option<String>,
    title: Option<String>,
    body: Option<String>,
    path: Option<String>,
    name: Option<String>,
    value: Option<Value>,
    value_type: Option<String>,
    command: Option<String>,
    arguments: Option<Vec<String>>,
    working_directory: Option<String>,
    window_handle: Option<String>,
    include_hidden: Option<bool>,
    include_minimized: Option<bool>,
    limit: Option<usize>,
    query: Option<String>,
    pid: Option<u32>,
    force: Option<bool>,
    display_index: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpUpsertBody {
    name: Option<String>,
    config: Option<McpServerConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalCreateBody {
    request_id: Option<String>,
    conversation_id: Option<String>,
    tool_name: Option<String>,
    tool_preview: Option<String>,
    risk_level: Option<String>,
    channels: Option<Vec<String>>,
    expires_at: Option<u64>,
    meta: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResolveBody {
    resolution: Option<String>,
    resolved_by: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpCreateSessionBody {
    agent_type: Option<String>,
    cwd: Option<String>,
    command: Option<Value>,
    env: Option<BTreeMap<String, String>>,
    timeout_ms: Option<u64>,
    origin: Option<String>,
    input_provenance: Option<Value>,
    #[serde(default)]
    tier: RunTier,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpPromptBody {
    prompt: Option<String>,
    turn_id: Option<String>,
    timeout_ms: Option<u64>,
    command: Option<Value>,
    cwd: Option<String>,
    env: Option<BTreeMap<String, String>>,
    origin: Option<String>,
    input_provenance: Option<Value>,
    /// Per-turn override. When absent, the session-level tier set at
    /// create time is used.
    tier: Option<RunTier>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpSteerBody {
    text: Option<String>,
    submit: Option<bool>,
    turn_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AcpEventsParams {
    after: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct AcpSessionsParams {
    state: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionsParams {
    session_id: Option<String>,
    state: Option<String>,
    owner_conversation_id: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserActionsParams {
    action_id: Option<String>,
    session_id: Option<String>,
    target_id: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserArtifactsParams {
    artifact_id: Option<String>,
    session_id: Option<String>,
    target_id: Option<String>,
    action_id: Option<String>,
    kind: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEventsParams {
    after: Option<u64>,
    window: Option<String>,
    limit: Option<usize>,
    session_id: Option<String>,
    action_id: Option<String>,
    artifact_id: Option<String>,
    #[serde(rename = "type")]
    event_type: Option<String>,
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDrilldownParams {
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
    session_id: Option<String>,
    action_id: Option<String>,
    artifact_id: Option<String>,
    #[serde(rename = "type")]
    event_type: Option<String>,
    session_limit: Option<usize>,
    action_limit: Option<usize>,
    artifact_limit: Option<usize>,
    event_limit: Option<usize>,
    event_after: Option<u64>,
    event_window: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationOutboxParams {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationOutboxAckBody {
    ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowStatusParams {
    run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryShadowRefreshBody {
    force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemRepairBody {
    action: Option<String>,
}

pub async fn serve_with_signals(mut config: CompanionConfig) -> Result<()> {
    ensure_token(&mut config)?;
    match sync_discovered_mcp_servers(&config) {
        Ok(result) if result.changed() => {
            save_config(&result.config)?;
            config = result.config;
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!("Failed to sync discovered MCP servers before daemon start: {error}");
        }
    }
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
    spawn_runtime_run_sync(state.clone());
    spawn_acp_run_sync(state.clone());
    spawn_checkpoint_job_resume(state.clone());

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
        .route("/api/system/diagnostics", get(system_diagnostics))
        .route("/api/system/self-check", get(system_self_check))
        .route("/api/system/repair", post(system_repair))
        .route("/api/system/restart", post(system_restart))
        .route("/api/system/cleanup", post(system_cleanup))
        .route("/api/system/shutdown", post(system_shutdown))
        .route("/api/apps/calendar/calendars", get(calendar_calendars))
        .route(
            "/api/apps/calendar/events",
            get(calendar_events).post(calendar_create_event),
        )
        .route("/api/apps/reminders/lists", get(reminder_lists))
        .route(
            "/api/apps/reminders/items",
            get(reminder_items).post(reminder_create_item),
        )
        .route(
            "/api/apps/reminders/items/{reminder_id}/complete",
            post(reminder_complete_item),
        )
        .route("/api/apps/contacts/groups", get(contact_groups))
        .route("/api/apps/contacts/people", get(contact_people))
        .route("/api/apps/notes/folders", get(note_folders))
        .route(
            "/api/apps/notes/items",
            get(note_items).post(note_create_item),
        )
        .route(
            "/api/apps/clipboard/text",
            get(clipboard_text).post(clipboard_set_text),
        )
        .route("/api/apps/explorer/items", get(explorer_items))
        .route("/api/apps/explorer/reveal", post(explorer_reveal))
        .route("/api/apps/processes", get(process_items))
        .route("/api/apps/processes/terminate", post(process_terminate))
        .route("/api/apps/screenshot/capture", post(screenshot_capture))
        .route("/api/apps/finder/items", get(finder_items))
        .route("/api/apps/finder/reveal", post(finder_reveal))
        .route(
            "/api/apps/safari/tabs",
            get(safari_tabs).post(safari_open_new_tab),
        )
        .route("/api/media/normalize", post(media_normalize))
        .route("/api/media/ocr", post(media_ocr))
        .route(
            "/api/checkpoint-sync/config",
            get(get_checkpoint_sync_config).post(update_checkpoint_sync_config),
        )
        .route("/api/checkpoint-jobs", post(checkpoint_jobs_submit))
        .route(
            "/api/checkpoint-jobs/{job_id}/status",
            get(checkpoint_job_status),
        )
        .route("/api/memory/checkpoints/shadow", post(memory_shadow_ingest))
        .route(
            "/api/memory/checkpoints/shadow/status",
            get(memory_shadow_status),
        )
        .route(
            "/api/memory/checkpoints/shadow/refresh",
            post(memory_shadow_refresh),
        )
        .route("/api/mcp/servers", get(mcp_servers))
        .route("/api/mcp/tools", get(mcp_tools))
        .route("/api/mcp/tools/call", post(mcp_call_tool))
        .route("/api/mcp/servers/upsert", post(mcp_upsert_server))
        .route(
            "/api/mcp/servers/{name}",
            axum::routing::delete(mcp_delete_server),
        )
        .route("/api/mcp/servers/{name}/restart", post(mcp_restart_server))
        .route("/api/browser/sessions/sync", post(browser_sync_session))
        .route("/api/browser/actions/sync", post(browser_sync_action))
        .route("/api/browser/artifacts/sync", post(browser_sync_artifact))
        .route("/api/browser/sessions", get(browser_sessions))
        .route(
            "/api/browser/sessions/{session_id}",
            get(browser_session_by_id),
        )
        .route("/api/browser/actions", get(browser_actions))
        .route("/api/browser/artifacts", get(browser_artifacts))
        .route("/api/browser/events", get(browser_events))
        .route("/api/browser/drilldown", get(browser_drilldown))
        .route("/api/browser/diagnostics", get(browser_diagnostics))
        .route("/api/cron/jobs", get(cron_jobs).post(cron_upsert_job))
        .route(
            "/api/cron/jobs/{task_id}",
            axum::routing::delete(cron_delete_job),
        )
        .route("/api/cron/pending", get(cron_pending))
        .route("/api/cron/pending/ack", post(cron_ack_pending))
        .route("/api/automation/outbox", get(automation_outbox))
        .route("/api/automation/outbox/ack", post(automation_outbox_ack))
        .route("/api/workflow/status", get(workflow_status))
        .route("/api/runtime/exec", post(runtime_exec))
        .route("/api/local-runtime/exec", post(runtime_exec))
        .route("/api/runtime/session/start", post(runtime_session_start))
        .route(
            "/api/local-runtime/session/start",
            post(runtime_session_start),
        )
        .route(
            "/api/runtime/runs/diagnostics",
            get(runtime_runs_diagnostics),
        )
        .route(
            "/api/local-runtime/runs/diagnostics",
            get(runtime_runs_diagnostics),
        )
        .route("/api/runtime/runs", get(runtime_runs))
        .route("/api/local-runtime/runs", get(runtime_runs))
        .route("/api/runtime/runs/{run_id}", get(runtime_run_by_id))
        .route("/api/local-runtime/runs/{run_id}", get(runtime_run_by_id))
        .route("/api/runtime/sessions", get(runtime_sessions))
        .route("/api/local-runtime/sessions", get(runtime_sessions))
        .route(
            "/api/acp/sessions",
            post(acp_create_session).get(acp_sessions),
        )
        .route("/api/acp/sessions/{session_id}", get(acp_session_by_id))
        .route(
            "/api/acp/sessions/{session_id}/prompt",
            post(acp_prompt_session),
        )
        .route(
            "/api/acp/sessions/{session_id}/steer",
            post(acp_steer_session),
        )
        .route(
            "/api/acp/sessions/{session_id}/cancel",
            post(acp_cancel_session),
        )
        .route(
            "/api/acp/sessions/{session_id}/events",
            get(acp_session_events),
        )
        .route(
            "/api/runtime/sessions/{session_id}/log",
            get(runtime_session_log),
        )
        .route(
            "/api/local-runtime/sessions/{session_id}/log",
            get(runtime_session_log),
        )
        .route(
            "/api/runtime/sessions/{session_id}/log/stream",
            get(runtime_session_log_stream),
        )
        .route(
            "/api/local-runtime/sessions/{session_id}/log/stream",
            get(runtime_session_log_stream),
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
        .route("/api/runtime/approvals", post(create_approval))
        .route(
            "/api/runtime/approvals/pending",
            get(list_pending_approvals),
        )
        .route(
            "/api/runtime/approvals/{request_id}",
            get(get_approval_by_id),
        )
        .route(
            "/api/runtime/approvals/{request_id}/resolve",
            post(resolve_approval),
        )
        .route("/{*path}", axum::routing::options(preflight))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(state.clone())
        .merge(build_agent_router(state))
}

/// Build the agent-loop sub-router and merge it under the same daemon. The
/// agent crate validates the bearer token via a callback (instead of
/// importing CompanionConfig directly) so the dependency stays one-way:
/// daemon → agent, never the reverse.
fn build_agent_router(state: AppState) -> Router {
    let config = state.config.clone();
    let auth: AgentAuthFn = Arc::new(move |headers| {
        // The authorize() helper is async-free, but we need a snapshot of
        // the current config token. Block on the read lock — config writes
        // are rare and short, and this auth path runs once per request.
        let snapshot = futures::executor::block_on(config.read());
        authorize(headers, &snapshot)
    });
    let router_state = AgentRouterState {
        agent: state.agent.clone(),
        auth,
    };
    agent_routes(router_state).layer(middleware::from_fn(cors_middleware))
}

async fn preflight() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

fn spawn_runtime_run_sync(state: AppState) {
    tokio::spawn(async move {
        let mut shutdown_rx = state.shutdown_receiver();
        let mut after = 0_u64;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                _ = sleep(Duration::from_millis(200)) => {}
            }

            let events = state
                .runtime
                .list_session_events(SessionEventsQuery {
                    after: Some(after),
                    limit: Some(200),
                })
                .await;

            for event in events.events {
                after = after.max(event.cursor);
                if event.r#type != "session_exited" {
                    continue;
                }
                let Ok(Some(link)) = state.runs.get_session_run_link(&event.session_id) else {
                    continue;
                };
                let _ = state.runs.update_run(&link.run_id, |run| {
                    run.state = if !event.timed_out && event.exit_code == 0 {
                        "done".to_string()
                    } else {
                        "failed".to_string()
                    };
                    run.finished_at = Some(event.finished_at);
                    run.summary = Some(if !event.timed_out && event.exit_code == 0 {
                        "Session completed".to_string()
                    } else {
                        "Session failed".to_string()
                    });
                    if event.timed_out || event.exit_code != 0 {
                        run.error = Some(format!(
                            "exitCode={}, timedOut={}",
                            event.exit_code, event.timed_out
                        ));
                    } else {
                        run.error = None;
                    }
                    run.meta = merge_run_meta(
                        run.meta.clone(),
                        json_object(vec![
                            ("sessionId", Some(Value::String(event.session_id.clone()))),
                            ("command", Some(Value::String(event.command.clone()))),
                            ("cwd", Some(Value::String(event.cwd.clone()))),
                            ("exitCode", Some(Value::Number(event.exit_code.into()))),
                            ("timedOut", Some(Value::Bool(event.timed_out))),
                            (
                                "durationMs",
                                Some(Value::Number(serde_json::Number::from(event.duration_ms))),
                            ),
                        ]),
                    );
                });
                let _ = state.runs.clear_session_run_link(&event.session_id);
            }
        }
    });
}

fn spawn_acp_run_sync(state: AppState) {
    tokio::spawn(async move {
        let mut shutdown_rx = state.shutdown_receiver();
        let mut after = 0_u64;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                _ = sleep(Duration::from_millis(200)) => {}
            }

            let events = state.acp.list_global_events(after, 200).await;
            for event in events {
                after = after.max(event.cursor);
                match event.status_code.as_deref() {
                    Some("awaiting_approval") => {
                        let Some(session) = state.acp.get_session(&event.session_id).await else {
                            continue;
                        };
                        let Some(run_id) = session.run_id.clone() else {
                            continue;
                        };
                        let current_run = state.runs.get_run_record(&run_id).ok().flatten();
                        let approval_request_id = format!(
                            "acp-approval-{}-{}",
                            event.session_id,
                            event.turn_id.clone().unwrap_or_else(|| "turn".to_string())
                        );
                        let conversation_id = session
                            .input_provenance
                            .as_ref()
                            .and_then(|value| value.get("conversationId"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                            .unwrap_or_default();
                        let mut meta = json_object(vec![
                            ("runId", Some(Value::String(run_id.clone()))),
                            ("sessionId", Some(Value::String(event.session_id.clone()))),
                            (
                                "sessionType",
                                Some(Value::String(format!("acp/{}", event.session_id))),
                            ),
                            (
                                "requestId",
                                Some(Value::String(approval_request_id.clone())),
                            ),
                            (
                                "approvalRequestId",
                                Some(Value::String(approval_request_id.clone())),
                            ),
                            (
                                "conversationId",
                                trim_optional(conversation_id.clone()).map(Value::String),
                            ),
                            ("inputProvenance", session.input_provenance.clone()),
                            ("turnId", event.turn_id.clone().map(Value::String)),
                        ]);
                        if let Some(object) = meta.as_mut() {
                            if let Some(text) = event.text.clone() {
                                object.insert("toolPreview".to_string(), Value::String(text));
                            }
                            object.insert(
                                "approvalSource".to_string(),
                                Value::String("acp".to_string()),
                            );
                            object.insert(
                                "approvalSignal".to_string(),
                                Value::String("awaiting_approval".to_string()),
                            );
                            if let Some(origin) = session.origin.clone().and_then(trim_optional) {
                                object.insert("origin".to_string(), Value::String(origin));
                            }
                            if let Some(agent_type) = trim_optional(session.agent_type.clone()) {
                                object.insert("agentType".to_string(), Value::String(agent_type));
                            }
                        }
                        meta = merge_run_meta(
                            current_run.as_ref().and_then(|run| run.meta.clone()),
                            meta,
                        );
                        let approval_preview =
                            event.text.as_deref().and_then(truncate_text_for_error);
                        let approval = match state.approvals.create_approval(CreateApprovalInput {
                            request_id: Some(approval_request_id.clone()),
                            conversation_id: Some(conversation_id),
                            tool_name: Some("acp_permission".to_string()),
                            tool_preview: approval_preview,
                            risk_level: Some("high".to_string()),
                            channels: Some(vec!["sidepanel".to_string()]),
                            expires_at: Some(now_millis() + 120_000),
                            meta,
                        }) {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        let approval_meta = approval.meta.clone();
                        let status = approval.status.clone();
                        let _ = state.runs.update_run(&run_id, |run| {
                            run.state = "waiting_approval".to_string();
                            run.summary = Some("ACP awaiting approval".to_string());
                            run.meta = merge_run_meta(
                                run.meta.clone(),
                                merge_run_meta(
                                    approval_meta.clone(),
                                    json_object(vec![
                                        ("approvalStatus", Some(Value::String(status.clone()))),
                                        ("approvalSource", Some(Value::String("acp".to_string()))),
                                        (
                                            "sessionId",
                                            Some(Value::String(event.session_id.clone())),
                                        ),
                                        (
                                            "sessionType",
                                            Some(Value::String(format!(
                                                "acp/{}",
                                                event.session_id
                                            ))),
                                        ),
                                    ]),
                                ),
                            );
                        });
                    }
                    _ => {
                        if event.event_type != "terminal" {
                            continue;
                        }
                        let Some(session) = state.acp.get_session(&event.session_id).await else {
                            continue;
                        };
                        let _ = sync_acp_terminal_run_state(
                            &state,
                            &session,
                            event.turn_id.clone(),
                            event.code.clone(),
                            event.message.clone(),
                            event.exit_code,
                        );
                    }
                }
            }
        }
    });
}

fn spawn_checkpoint_job_resume(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = state.resume_pending_checkpoint_jobs().await {
            tracing::warn!("failed to resume pending checkpoint jobs: {error:#}");
        }
    });
}

async fn healthz(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HealthPayload>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let capabilities = state.capabilities_payload().await;
    Ok(Json(HealthPayload {
        ok: true,
        ts: now_millis(),
        pid: std::process::id(),
        version: version_string(),
        protocol_version: capabilities.protocol_version,
        run_contract_version: capabilities.run_contract_version,
        supported_features: capabilities.supported_features,
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
    Ok(Json(
        serde_json::to_value(state.capabilities_payload().await).unwrap(),
    ))
}

async fn system_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let capabilities = state.capabilities_payload().await;
    let mcp_servers = state.mcp.get_servers().await;
    let browser = state
        .browser
        .diagnostics(&capabilities.supported_features)
        .map_err(internal_error)?;
    let media_support = probe_media_normalization_support();
    let memory_shadow = state.memory_shadow.get_status().map_err(internal_error)?;
    let memory_shadow_envelope = state.memory_shadow.get_envelope().map_err(internal_error)?;
    let memory_shadow_refresh = state
        .memory_shadow_refresh
        .get_state(memory_shadow_envelope.as_ref())
        .map_err(internal_error)?;
    let pending_approvals = state
        .approvals
        .list_pending_approvals()
        .map_err(internal_error)?;
    let recent_runs = state
        .runs
        .list_runs(RunListQuery {
            limit: Some(50),
            ..RunListQuery::default()
        })
        .map_err(internal_error)?;
    let listed_outbox = state
        .automation_outbox
        .list_items(Some(10), Some(0))
        .map_err(internal_error)?;
    let active_workflow_runs = count_active_workflow_runs(&recent_runs.runs);
    let recent_lifecycle_phases = build_recent_workflow_lifecycle_phases(&recent_runs.runs);
    let recent_workflow_failures = build_recent_workflow_failures(&recent_runs.runs);
    let recent_failed = recent_runs
        .runs
        .iter()
        .filter(|run| run.run.state == "failed")
        .take(5)
        .cloned()
        .collect::<Vec<_>>();
    let recent_actions = recent_runs
        .runs
        .iter()
        .filter_map(|run| action_log_from_run(&run.run))
        .take(15)
        .collect::<Vec<_>>();
    let recent_failed_count = recent_runs
        .runs
        .iter()
        .filter(|run| run.run.state == "failed")
        .count();
    let checkpoint_support_reason = checkpoint_job_support_reason(&config);
    let checkpoint_jobs_available = capabilities.supported_features.memory_checkpoint_jobs;
    let mut first_page = true;
    let mut acp_total_sessions = 0_usize;
    let mut acp_running_sessions = 0_usize;
    let mut acp_idle_sessions = 0_usize;
    let mut offset = 0_usize;
    loop {
        let page = state
            .acp
            .list_sessions(AcpListQuery {
                limit: Some(200),
                offset: Some(offset),
                ..AcpListQuery::default()
            })
            .await;
        if first_page {
            acp_total_sessions = page.total;
            first_page = false;
        }
        acp_running_sessions += page
            .sessions
            .iter()
            .filter(|session| session.state == "running")
            .count();
        acp_idle_sessions += page
            .sessions
            .iter()
            .filter(|session| session.state == "idle")
            .count();
        if !page.has_more || page.sessions.is_empty() {
            break;
        }
        offset += page.sessions.len();
    }

    let mut doctor_issues = Vec::new();
    if !pending_approvals.is_empty() {
        doctor_issues.push(json!({
            "code": "pending_approvals",
            "severity": "warn",
            "message": "There are pending approvals waiting for user action.",
        }));
    }
    if recent_failed_count > 0 {
        doctor_issues.push(json!({
            "code": "recent_failed_runs",
            "severity": "warn",
            "message": "Recent companion runs have failed.",
        }));
    }
    if config.checkpoint_sync.is_some() && !checkpoint_jobs_available {
        let message = match checkpoint_support_reason {
            "missing_pointer_registry" => {
                "Checkpoint sync is configured but the 0G pointer registry is missing, so durable checkpoint jobs are disabled."
            }
            "unsupported_config" => {
                "Checkpoint sync is configured but the current companion build cannot enable durable checkpoint jobs for it."
            }
            _ => "Checkpoint sync is configured but durable checkpoint jobs are currently unavailable.",
        };
        doctor_issues.push(json!({
            "code": "checkpoint_jobs_unavailable",
            "severity": "warn",
            "message": message,
        }));
    }

    Ok(Json(json!({
        "contractVersion": capabilities.run_contract_version,
        "protocolVersion": capabilities.protocol_version,
        "version": version_string(),
        "permissionPolicy": config.permission_policy,
        "paths": {
            "config": get_config_path().to_string_lossy(),
            "pid": get_pid_path().to_string_lossy(),
        },
        "mcp": {
            "configuredServers": config.mcp_servers.len(),
            "connectedServers": state.mcp.get_connected_count().await,
            "totalTools": state.mcp.get_all_tools().await.len(),
            "servers": mcp_servers,
        },
        "mediaNormalizationSummary": {
            "enabled": capabilities.supported_features.media_normalization,
            "available": media_support.available,
            "engine": media_support.engine,
            "reason": media_support.reason,
        },
        "checkpointSync": checkpoint_sync_payload(&config, checkpoint_jobs_available),
        "memoryCheckpointJobs": {
            "available": checkpoint_jobs_available,
        },
        "memoryShadow": memory_shadow,
        "memoryShadowRefresh": memory_shadow_refresh,
        "browser": browser,
        "automation": {
            "activeWorkflowRuns": active_workflow_runs,
            "outbox": build_automation_outbox_summary(&listed_outbox),
            "recentLifecyclePhases": recent_lifecycle_phases,
            "recentFailures": recent_workflow_failures,
        },
        "runs": {
            "recentFailed": recent_failed,
            "recentActions": recent_actions,
        },
        "approvals": {
            "pending": pending_approvals,
        },
        "acp": {
            "totalSessions": acp_total_sessions,
            "runningSessions": acp_running_sessions,
            "idleSessions": acp_idle_sessions,
        },
        "doctor": {
            "status": if doctor_issues.is_empty() { "ok" } else { "needs_attention" },
            "summary": {
                "pendingApprovals": pending_approvals.len(),
                "recentFailedRuns": recent_failed_count,
                "runningAcpSessions": acp_running_sessions,
                "stalledAcpSessions": 0,
                "activeWorkflowRuns": active_workflow_runs,
                "browserLoaded": browser.get("loaded").cloned().unwrap_or(Value::Null),
            },
            "issues": doctor_issues,
        }
    })))
}

async fn system_self_check(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = run_cli_json_command(&["self-check", "--json"]).map_err(internal_error)?;
    Ok(Json(payload))
}

async fn system_repair(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SystemRepairBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "admin_action",
        "Administrator actions are disabled in Companion permissions.",
    )?;

    let action = body
        .action
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("repair_config");
    let payload = run_cli_json_command(&["repair", action, "--json"]).map_err(internal_error)?;
    Ok(Json(payload))
}

async fn system_restart(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    spawn_detached_cli_command(&["restart", "--force"]).map_err(internal_error)?;
    state.request_shutdown();
    Ok(Json(json!({
        "ok": true,
        "message": "restarting",
    })))
}

async fn system_cleanup(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = run_cli_json_command(&["cleanup", "--json"]).map_err(internal_error)?;
    state.request_shutdown();
    Ok(Json(payload))
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

async fn calendar_calendars(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "calendar",
        "Calendar access is disabled in Companion permissions.",
    )?;

    let run_id = create_app_action_run(
        &state,
        "calendar",
        "list_calendars",
        Some("all calendars".to_string()),
        "Listing calendars",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_calendars();
    match result {
        Ok(calendars) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "calendarCount",
                    Some(Value::Number(serde_json::Number::from(
                        calendars.len() as u64
                    ))),
                )]);
                let _ =
                    finish_app_action_run(&state, &run_id, true, "Listed calendars", None, extra);
            }
            Ok(Json(json!({
                "ok": true,
                "calendars": calendars,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list calendars",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn calendar_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CalendarEventsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "calendar",
        "Calendar access is disabled in Companion permissions.",
    )?;

    let query = ListCalendarEventsRequest {
        calendar_name: params.calendar_name,
        from_at: params.from_at,
        to_at: params.to_at,
        limit: params.limit,
    };
    let preview = query
        .calendar_name
        .clone()
        .unwrap_or_else(|| "upcoming calendar events".to_string());
    let run_id = create_app_action_run(
        &state,
        "calendar",
        "list_calendar_events",
        Some(preview),
        "Listing calendar events",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_calendar_events(&query);
    match result {
        Ok(events) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "eventCount",
                    Some(Value::Number(serde_json::Number::from(events.len() as u64))),
                )]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed calendar events",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "events": events,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list calendar events",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn calendar_create_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CalendarEventCreateBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "calendar",
        "Calendar access is disabled in Companion permissions.",
    )?;

    let request = CreateCalendarEventRequest {
        title: body.title.unwrap_or_default(),
        start_at: body.start_at.unwrap_or_default(),
        end_at: body.end_at.unwrap_or_default(),
        calendar_name: body.calendar_name,
        location: body.location,
        notes: body.notes,
        all_day: body.all_day.unwrap_or(false),
    };
    let preview = request
        .calendar_name
        .clone()
        .map(|calendar_name| format!("{} @ {}", request.title.trim(), calendar_name))
        .unwrap_or_else(|| request.title.trim().to_string());
    let run_id = create_app_action_run(
        &state,
        "calendar",
        "create_calendar_event",
        trim_optional(preview),
        "Creating calendar event",
    )
    .ok()
    .map(|run| run.run_id);

    let result = create_calendar_event(&request);
    match result {
        Ok(event) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Created calendar event",
                    None,
                    app_action_result_meta_calendar(&event),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "event": event,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to create calendar event",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn reminder_lists(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "reminders",
        "Reminders access is disabled in Companion permissions.",
    )?;

    let run_id = create_app_action_run(
        &state,
        "reminders",
        "list_reminder_lists",
        Some("all reminder lists".to_string()),
        "Listing reminder lists",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_reminder_lists();
    match result {
        Ok(lists) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "listCount",
                    Some(Value::Number(serde_json::Number::from(lists.len() as u64))),
                )]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed reminder lists",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "lists": lists,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list reminder lists",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn reminder_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ReminderItemsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "reminders",
        "Reminders access is disabled in Companion permissions.",
    )?;

    let query = ListRemindersRequest {
        list_name: params.list_name,
        include_completed: params.include_completed.unwrap_or(false),
        limit: params.limit,
    };
    let preview = query
        .list_name
        .clone()
        .unwrap_or_else(|| "pending reminders".to_string());
    let run_id = create_app_action_run(
        &state,
        "reminders",
        "list_reminders",
        Some(preview),
        "Listing reminders",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_reminders(&query);
    match result {
        Ok(reminders) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "reminderCount",
                    Some(Value::Number(serde_json::Number::from(
                        reminders.len() as u64
                    ))),
                )]);
                let _ =
                    finish_app_action_run(&state, &run_id, true, "Listed reminders", None, extra);
            }
            Ok(Json(json!({
                "ok": true,
                "reminders": reminders,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list reminders",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn reminder_create_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReminderCreateBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "reminders",
        "Reminders access is disabled in Companion permissions.",
    )?;

    let request = CreateReminderRequest {
        title: body.title.unwrap_or_default(),
        list_name: body.list_name,
        due_at: body.due_at,
        notes: body.notes,
        priority: body.priority,
    };
    let preview = request
        .list_name
        .clone()
        .map(|list_name| format!("{} @ {}", request.title.trim(), list_name))
        .unwrap_or_else(|| request.title.trim().to_string());
    let run_id = create_app_action_run(
        &state,
        "reminders",
        "create_reminder",
        trim_optional(preview),
        "Creating reminder",
    )
    .ok()
    .map(|run| run.run_id);

    let result = create_reminder(&request);
    match result {
        Ok(reminder) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Created reminder",
                    None,
                    app_action_result_meta_reminder(&reminder),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "reminder": reminder,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to create reminder",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn reminder_complete_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(reminder_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "reminders",
        "Reminders access is disabled in Companion permissions.",
    )?;

    let request = CompleteReminderRequest { id: reminder_id };
    let preview = trim_optional(request.id.clone());
    let run_id = create_app_action_run(
        &state,
        "reminders",
        "complete_reminder",
        preview,
        "Completing reminder",
    )
    .ok()
    .map(|run| run.run_id);

    let result = complete_reminder(&request);
    match result {
        Ok(reminder) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Completed reminder",
                    None,
                    app_action_result_meta_completion(&reminder),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "reminder": reminder,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to complete reminder",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn contact_groups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "contacts",
        "Contacts access is disabled in Companion permissions.",
    )?;

    let run_id = create_app_action_run(
        &state,
        "contacts",
        "list_contact_groups",
        Some("all contact groups".to_string()),
        "Listing contact groups",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_contact_groups();
    match result {
        Ok(groups) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "groupCount",
                    Some(Value::Number(serde_json::Number::from(groups.len() as u64))),
                )]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed contact groups",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "groups": groups,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list contact groups",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn contact_people(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ContactsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "contacts",
        "Contacts access is disabled in Companion permissions.",
    )?;

    let query = ListContactsRequest {
        query: params.query,
        group_id: params.group_id,
        group_name: params.group_name,
        limit: params.limit,
    };
    let preview = query
        .query
        .clone()
        .or_else(|| query.group_name.clone())
        .or_else(|| query.group_id.clone())
        .unwrap_or_else(|| "contact search".to_string());
    let run_id = create_app_action_run(
        &state,
        "contacts",
        "list_contacts",
        Some(preview),
        "Listing contacts",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_contacts(&query);
    match result {
        Ok(people) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "contactCount",
                    Some(Value::Number(serde_json::Number::from(people.len() as u64))),
                )]);
                let _ =
                    finish_app_action_run(&state, &run_id, true, "Listed contacts", None, extra);
            }
            Ok(Json(json!({
                "ok": true,
                "people": people,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list contacts",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn note_folders(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "notes",
        "Notes access is disabled in Companion permissions.",
    )?;

    let run_id = create_app_action_run(
        &state,
        "notes",
        "list_note_folders",
        Some("all note folders".to_string()),
        "Listing note folders",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_note_folders();
    match result {
        Ok(folders) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "folderCount",
                    Some(Value::Number(
                        serde_json::Number::from(folders.len() as u64),
                    )),
                )]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed note folders",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "folders": folders,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list note folders",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn note_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<NotesParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "notes",
        "Notes access is disabled in Companion permissions.",
    )?;

    let query = ListNotesRequest {
        folder_id: params.folder_id,
        folder_name: params.folder_name,
        query: params.query,
        limit: params.limit,
    };
    let preview = query
        .query
        .clone()
        .or_else(|| query.folder_name.clone())
        .or_else(|| query.folder_id.clone())
        .unwrap_or_else(|| "recent notes".to_string());
    let run_id = create_app_action_run(
        &state,
        "notes",
        "list_notes",
        Some(preview),
        "Listing notes",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_notes(&query);
    match result {
        Ok(notes) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "noteCount",
                    Some(Value::Number(serde_json::Number::from(notes.len() as u64))),
                )]);
                let _ = finish_app_action_run(&state, &run_id, true, "Listed notes", None, extra);
            }
            Ok(Json(json!({
                "ok": true,
                "notes": notes,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list notes",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn note_create_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NoteCreateBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "notes",
        "Notes access is disabled in Companion permissions.",
    )?;

    let request = CreateNoteRequest {
        title: body.title.unwrap_or_default(),
        body: body.body.unwrap_or_default(),
        folder_id: body.folder_id,
        folder_name: body.folder_name,
    };
    let preview = request
        .folder_name
        .clone()
        .map(|folder_name| format!("{} @ {}", request.title.trim(), folder_name))
        .unwrap_or_else(|| request.title.trim().to_string());
    let run_id = create_app_action_run(
        &state,
        "notes",
        "create_note",
        trim_optional(preview),
        "Creating note",
    )
    .ok()
    .map(|run| run.run_id);

    let result = create_note(&request);
    match result {
        Ok(note) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Created note",
                    None,
                    app_action_result_meta_note(&note),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "note": note,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to create note",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn clipboard_text(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "clipboard",
        "Clipboard access is disabled in Companion permissions.",
    )?;

    let run_id = create_app_action_run(
        &state,
        "clipboard",
        "get_clipboard_text",
        Some("clipboard text".to_string()),
        "Reading clipboard text",
    )
    .ok()
    .map(|run| run.run_id);

    let result = get_clipboard_text();
    match result {
        Ok(contents) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Read clipboard text",
                    None,
                    app_action_result_meta_clipboard(&contents),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "clipboard": contents,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to read clipboard text",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn clipboard_set_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ClipboardSetBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "clipboard",
        "Clipboard access is disabled in Companion permissions.",
    )?;

    let request = SetClipboardTextRequest {
        text: body.text.unwrap_or_default(),
    };
    let preview = trim_optional(request.text.clone());
    let run_id = create_app_action_run(
        &state,
        "clipboard",
        "set_clipboard_text",
        preview.clone(),
        "Writing clipboard text",
    )
    .ok()
    .map(|run| run.run_id);

    let result = set_clipboard_text(&request);
    match result {
        Ok(contents) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Updated clipboard text",
                    None,
                    app_action_result_meta_clipboard(&contents),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "clipboard": contents,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to write clipboard text",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn explorer_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ExplorerItemsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "explorer",
        "File Explorer access is disabled in Companion permissions.",
    )?;

    let request = ListExplorerItemsRequest {
        path: params.path,
        include_hidden: params.include_hidden.unwrap_or(false),
        limit: params.limit,
    };
    let preview = request
        .path
        .clone()
        .unwrap_or_else(|| "home folder".to_string());
    let run_id = create_app_action_run(
        &state,
        "explorer",
        "list_explorer_items",
        Some(preview.clone()),
        "Listing Explorer items",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_explorer_items(&request);
    match result {
        Ok(items) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "itemCount",
                        Some(Value::Number(serde_json::Number::from(items.len() as u64))),
                    ),
                    ("path", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed Explorer items",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "items": items,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list Explorer items",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn explorer_reveal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ExplorerRevealBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "explorer",
        "File Explorer access is disabled in Companion permissions.",
    )?;

    let request = ExplorerRevealRequest {
        path: body.path.unwrap_or_default(),
    };
    let preview = trim_optional(request.path.clone());
    let run_id = create_app_action_run(
        &state,
        "explorer",
        "reveal_explorer_item",
        preview,
        "Revealing Explorer item",
    )
    .ok()
    .map(|run| run.run_id);

    let result = reveal_explorer_item(&request);
    match result {
        Ok(item) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Revealed Explorer item",
                    None,
                    app_action_result_meta_explorer_reveal(&item),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "item": item,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to reveal Explorer item",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn process_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ProcessItemsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "process_control",
        "Process control is disabled in Companion permissions.",
    )?;

    let request = ListProcessesRequest {
        query: params.query,
        limit: params.limit,
    };
    let preview = request
        .query
        .clone()
        .unwrap_or_else(|| "all processes".to_string());
    let run_id = create_app_action_run(
        &state,
        "process_control",
        "list_processes",
        Some(preview.clone()),
        "Listing local processes",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_processes(&request);
    match result {
        Ok(processes) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "processCount",
                        Some(Value::Number(serde_json::Number::from(
                            processes.len() as u64
                        ))),
                    ),
                    ("query", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed local processes",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "processes": processes,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list local processes",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn process_terminate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProcessTerminateBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "process_control",
        "Process control is disabled in Companion permissions.",
    )?;

    let request = TerminateProcessRequest {
        pid: body.pid.unwrap_or_default(),
        force: body.force.unwrap_or(true),
    };
    let run_id = create_app_action_run(
        &state,
        "process_control",
        "terminate_process",
        Some(format!("pid {}", request.pid)),
        "Stopping a local process",
    )
    .ok()
    .map(|run| run.run_id);

    let result = terminate_process(&request);
    match result {
        Ok(process) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Stopped local process",
                    None,
                    app_action_result_meta_process_termination(&process),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "process": process,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to stop local process",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn screenshot_capture(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ScreenshotCaptureBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "screenshot",
        "Screenshot capture is disabled in Companion permissions.",
    )?;

    let request = CaptureScreenshotRequest {
        display_index: body.display_index,
    };
    let preview = request
        .display_index
        .map(|index| format!("display {index}"))
        .unwrap_or_else(|| "primary display".to_string());
    let run_id = create_app_action_run(
        &state,
        "screenshot",
        "capture_screenshot",
        Some(preview),
        "Capturing screenshot",
    )
    .ok()
    .map(|run| run.run_id);

    let result = capture_screenshot(&request);
    match result {
        Ok(capture) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Captured screenshot",
                    None,
                    app_action_result_meta_screenshot(&capture),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "capture": capture,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to capture screenshot",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn finder_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<FinderItemsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "finder",
        "Finder access is disabled in Companion permissions.",
    )?;

    let request = ListFinderItemsRequest {
        path: params.path,
        include_hidden: params.include_hidden.unwrap_or(false),
        limit: params.limit,
    };
    let preview = request
        .path
        .clone()
        .unwrap_or_else(|| "home folder".to_string());
    let run_id = create_app_action_run(
        &state,
        "finder",
        "list_finder_items",
        Some(preview),
        "Listing Finder items",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_finder_items(&request);
    match result {
        Ok(items) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "itemCount",
                    Some(Value::Number(serde_json::Number::from(items.len() as u64))),
                )]);
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Listed Finder items",
                    None,
                    extra,
                );
            }
            Ok(Json(json!({
                "ok": true,
                "items": items,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list Finder items",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn finder_reveal(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<FinderRevealBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "finder",
        "Finder access is disabled in Companion permissions.",
    )?;

    let request = FinderRevealRequest {
        path: body.path.unwrap_or_default(),
    };
    let preview = trim_optional(request.path.clone());
    let run_id = create_app_action_run(
        &state,
        "finder",
        "reveal_finder_item",
        preview,
        "Revealing Finder item",
    )
    .ok()
    .map(|run| run.run_id);

    let result = reveal_finder_item(&request);
    match result {
        Ok(item) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Revealed Finder item",
                    None,
                    app_action_result_meta_finder_reveal(&item),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "item": item,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to reveal Finder item",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn safari_tabs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SafariTabsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "safari",
        "Safari access is disabled in Companion permissions.",
    )?;

    let request = ListSafariTabsRequest {
        limit: params.limit,
    };
    let run_id = create_app_action_run(
        &state,
        "safari",
        "list_safari_tabs",
        Some("Safari tabs".to_string()),
        "Listing Safari tabs",
    )
    .ok()
    .map(|run| run.run_id);

    let result = list_safari_tabs(&request);
    match result {
        Ok(tabs) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![(
                    "tabCount",
                    Some(Value::Number(serde_json::Number::from(tabs.len() as u64))),
                )]);
                let _ =
                    finish_app_action_run(&state, &run_id, true, "Listed Safari tabs", None, extra);
            }
            Ok(Json(json!({
                "ok": true,
                "tabs": tabs,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to list Safari tabs",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn safari_open_new_tab(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SafariOpenTabBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    ensure_capability_enabled(
        &config,
        "safari",
        "Safari access is disabled in Companion permissions.",
    )?;

    let request = OpenSafariTabRequest {
        url: body.url.unwrap_or_default(),
        activate: body.activate.unwrap_or(true),
    };
    let run_id = create_app_action_run(
        &state,
        "safari",
        "open_safari_tab",
        trim_optional(request.url.clone()),
        "Opening Safari tab",
    )
    .ok()
    .map(|run| run.run_id);

    let result = open_safari_tab(&request);
    match result {
        Ok(tab) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    true,
                    "Opened Safari tab",
                    None,
                    app_action_result_meta_safari_tab(&tab),
                );
            }
            Ok(Json(json!({
                "ok": true,
                "tab": tab,
            })))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    &state,
                    &run_id,
                    false,
                    "Failed to open Safari tab",
                    Some(error.to_string()),
                    None,
                );
            }
            Err(map_app_integration_error(error))
        }
    }
}

async fn get_checkpoint_sync_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let checkpoint_jobs = state.checkpoint_jobs_runner().await;
    Ok(Json(json!({
        "ok": true,
        "checkpointSync": checkpoint_sync_payload(&config, checkpoint_jobs.is_available()),
    })))
}

async fn update_checkpoint_sync_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let current = state.snapshot_config().await;
    authorize(&headers, &current)?;
    let raw = body
        .get("checkpointSync")
        .cloned()
        .unwrap_or_else(|| body.clone());
    let next_checkpoint_sync = serde_json::from_value::<Option<CheckpointSyncConfig>>(raw)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    let checkpoint_jobs = state
        .update_checkpoint_sync(next_checkpoint_sync)
        .await
        .map_err(internal_error)?;
    let next_config = state.snapshot_config().await;
    Ok(Json(json!({
        "ok": true,
        "checkpointSync": checkpoint_sync_payload(&next_config, checkpoint_jobs.is_available()),
    })))
}

async fn media_normalize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NormalizeImageRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = normalize_image_payload(&body)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(serde_json::to_value(payload).unwrap_or_else(|_| {
        json!({
            "changed": false,
            "name": body.name,
            "mimeType": body.mime_type,
            "bytesBase64": body.bytes_base64,
        })
    })))
}

async fn media_ocr(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ImageOcrRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = extract_image_text_payload(&body)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(serde_json::to_value(payload).unwrap_or_else(|_| {
        json!({
            "status": "failed",
            "note": "ocr_response_encode_failed",
        })
    })))
}

async fn checkpoint_jobs_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CheckpointJobSubmitInput>,
) -> Result<Json<CheckpointJobSubmitResult>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let checkpoint_jobs = state.checkpoint_jobs_runner().await;
    if !checkpoint_jobs.is_available() {
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "memory_checkpoint_jobs_unavailable",
        ));
    }
    let result = checkpoint_jobs
        .submit(body)
        .await
        .map_err(map_checkpoint_job_submit_error)?;
    Ok(Json(result))
}

async fn checkpoint_job_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Json<CheckpointJobStatus>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let checkpoint_jobs = state.checkpoint_jobs_runner().await;
    if !checkpoint_jobs.is_available() {
        return Err(json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "memory_checkpoint_jobs_unavailable",
        ));
    }
    let status = checkpoint_jobs
        .get_status(&job_id)
        .await
        .map_err(internal_error)?;
    let Some(status) = status else {
        return Err(json_error(
            StatusCode::NOT_FOUND,
            "checkpoint_job_not_found",
        ));
    };
    Ok(Json(status))
}

async fn memory_shadow_ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let status = state
        .memory_shadow
        .ingest_value(body, None)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({ "ok": true, "status": status })))
}

async fn memory_shadow_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let status = state.memory_shadow.get_status().map_err(internal_error)?;
    Ok(Json(serde_json::to_value(status).unwrap_or_else(|_| {
        json!({
            "version": 1,
            "authority": "extension_primary",
            "mirroredGeneration": Value::Null,
            "mirroredCommittedAt": Value::Null,
            "verification": { "state": "unknown", "verifiedAt": Value::Null },
            "freshness": { "state": "unknown", "shadowedAt": Value::Null },
        })
    })))
}

async fn memory_shadow_refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<MemoryShadowRefreshBody>>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let envelope = state.memory_shadow.get_envelope().map_err(internal_error)?;
    let force = body.and_then(|Json(value)| value.force).unwrap_or(false);
    let result = state
        .memory_shadow_refresh
        .refresh(envelope.as_ref(), force)
        .map_err(internal_error)?;
    Ok(Json(serde_json::to_value(result).unwrap_or_else(|_| {
        json!({
            "published": false,
            "reason": "publisher_unavailable",
            "publishSource": Value::Null,
        })
    })))
}

async fn browser_sync_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let session = state
        .browser
        .sync_session(body)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({ "ok": true, "session": session })))
}

async fn browser_sync_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let action = state
        .browser
        .sync_action(body)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({ "ok": true, "action": action })))
}

async fn browser_sync_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let artifact = state
        .browser
        .sync_artifact(body)
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({ "ok": true, "artifact": artifact })))
}

async fn browser_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BrowserSessionsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .browser
        .list_sessions(BrowserSessionListQuery {
            session_id: params.session_id,
            state: params.state,
            owner_conversation_id: params.owner_conversation_id,
            run_id: params.run_id,
            conversation_id: params.conversation_id,
            source_tool_name: params.source_tool_name,
            source_tool_call_id: params.source_tool_call_id,
            approval_request_id: params.approval_request_id,
            limit: params.limit,
            offset: params.offset,
        })
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn browser_session_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let session = state
        .browser
        .get_session_by_id(&session_id)
        .map_err(internal_error)?;
    match session {
        Some(session) => Ok(Json(json!({ "session": session }))),
        None => Err(json_error(
            StatusCode::NOT_FOUND,
            "Browser session not found.",
        )),
    }
}

async fn browser_actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BrowserActionsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .browser
        .list_actions(BrowserActionListQuery {
            action_id: params.action_id,
            session_id: params.session_id,
            target_id: params.target_id,
            kind: params.kind,
            status: params.status,
            run_id: params.run_id,
            conversation_id: params.conversation_id,
            source_tool_name: params.source_tool_name,
            source_tool_call_id: params.source_tool_call_id,
            approval_request_id: params.approval_request_id,
            limit: params.limit,
            offset: params.offset,
        })
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn browser_artifacts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BrowserArtifactsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .browser
        .list_artifacts(BrowserArtifactListQuery {
            artifact_id: params.artifact_id,
            session_id: params.session_id,
            target_id: params.target_id,
            action_id: params.action_id,
            kind: params.kind,
            limit: params.limit,
            offset: params.offset,
        })
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn browser_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BrowserEventsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .browser
        .list_events(BrowserEventsQuery {
            after: params.after,
            window: params.window,
            limit: params.limit,
            session_id: params.session_id,
            action_id: params.action_id,
            artifact_id: params.artifact_id,
            event_type: params.event_type,
            run_id: params.run_id,
            conversation_id: params.conversation_id,
            source_tool_name: params.source_tool_name,
            source_tool_call_id: params.source_tool_call_id,
            approval_request_id: params.approval_request_id,
        })
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn browser_drilldown(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BrowserDrilldownParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .browser
        .drilldown(BrowserDrilldownQuery {
            run_id: params.run_id,
            conversation_id: params.conversation_id,
            source_tool_name: params.source_tool_name,
            source_tool_call_id: params.source_tool_call_id,
            approval_request_id: params.approval_request_id,
            session_id: params.session_id,
            action_id: params.action_id,
            artifact_id: params.artifact_id,
            event_type: params.event_type,
            session_limit: params.session_limit,
            action_limit: params.action_limit,
            artifact_limit: params.artifact_limit,
            event_limit: params.event_limit,
            event_after: params.event_after,
            event_window: params.event_window,
        })
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn browser_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let supported_features = state.supported_features().await;
    let payload = state
        .browser
        .diagnostics(&supported_features)
        .map_err(internal_error)?;
    Ok(Json(payload))
}

async fn cron_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let jobs = state.cron.list_jobs().map_err(internal_error)?;
    Ok(Json(json!({ "jobs": jobs })))
}

async fn cron_upsert_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let task_id = state
        .cron
        .upsert_job(body.clone())
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "id": task_id,
        "automation": build_cron_automation_response(&body),
    })))
}

async fn cron_delete_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let removed = state.cron.remove_job(&task_id).map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "removed": removed })))
}

async fn cron_pending(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let pending = state.cron.list_pending_runs().map_err(internal_error)?;
    Ok(Json(json!({ "pending": pending })))
}

async fn cron_ack_pending(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let acked = state
        .cron
        .ack_pending_runs_value(&body)
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "acked": acked })))
}

async fn automation_outbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<AutomationOutboxParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let listed = state
        .automation_outbox
        .list_items(params.limit, params.offset)
        .map_err(internal_error)?;
    Ok(Json(serde_json::to_value(listed).unwrap_or_else(|_| {
        json!({
            "items": [],
            "total": 0,
            "limit": params.limit.unwrap_or(100),
            "offset": params.offset.unwrap_or(0),
            "hasMore": false,
        })
    })))
}

async fn automation_outbox_ack(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AutomationOutboxAckBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let acked = state
        .automation_outbox
        .ack_items(body.ids.as_deref().unwrap_or(&[]))
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true, "acked": acked })))
}

async fn workflow_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<WorkflowStatusParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let run_id = params
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "Missing required param: runId"))?;
    let run = state
        .runs
        .get_run_record(run_id)
        .map_err(internal_error)?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, &format!("Run not found: {run_id}")))?;
    Ok(Json(json!({
        "runId": run.run_id,
        "state": run.state,
        "workflow": workflow_status_from_run(&run),
        "updatedAt": run.updated_at,
    })))
}

fn run_cli_json_command(args: &[&str]) -> Result<Value> {
    let current_exe = resolve_cli_executable()?;
    let output = Command::new(current_exe)
        .args(args)
        .output()
        .context("Failed to invoke companion CLI")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stderr.is_empty() {
            anyhow::bail!("{stderr}");
        }
        if !stdout.is_empty() {
            anyhow::bail!("{stdout}");
        }
        anyhow::bail!("Companion CLI exited with status {}", output.status);
    }

    let stdout = String::from_utf8(output.stdout).context("CLI output is not valid UTF-8")?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "ok": true }));
    }

    serde_json::from_str(trimmed).context("CLI output is not valid JSON")
}

fn spawn_detached_cli_command(args: &[&str]) -> Result<()> {
    let current_exe = resolve_cli_executable()?;
    let mut command = Command::new(current_exe);
    command.args(args);
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .context("Failed to spawn detached companion CLI command")?;
    Ok(())
}

fn resolve_cli_executable() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("TRAPEZOHE_CLI_PATH").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    std::env::current_exe().context("Failed to resolve current executable")
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
    let run_id = create_runtime_exec_run(&state, &body, &config)
        .ok()
        .map(|run| run.run_id);
    let result = state
        .runtime
        .run_command(ExecRequest {
            command: body.command.unwrap_or_default(),
            cwd: body.cwd,
            timeout_ms: body.timeout_ms,
            env: body.env.map(|value| value.into_iter().collect()),
            permission_policy: config.permission_policy.clone(),
            tier: body.tier,
        })
        .await
        .map_err(map_exec_runtime_error)?;
    if let Some(run_id) = run_id {
        let command = result.command.clone();
        let cwd = result.cwd.clone();
        let exit_code = result.exit_code;
        let timed_out = result.timed_out;
        let duration_ms = result.duration_ms;
        let stderr = result.stderr.clone();
        let _ = state.runs.update_run(&run_id, |run| {
            run.state = if result.ok { "done" } else { "failed" }.to_string();
            run.finished_at = Some(now_millis());
            run.summary = Some(if result.ok {
                "Local command completed".to_string()
            } else {
                "Local command failed".to_string()
            });
            run.error = if result.ok {
                None
            } else {
                truncate_text_for_error(&stderr)
            };
            run.meta = merge_run_meta(
                run.meta.clone(),
                json_object(vec![
                    ("command", Some(Value::String(command.clone()))),
                    ("cwd", Some(Value::String(cwd.clone()))),
                    (
                        "capability",
                        Some(Value::String("local_command".to_string())),
                    ),
                    (
                        "permissionId",
                        Some(Value::String("local_command".to_string())),
                    ),
                    ("actionSource", Some(Value::String("extension".to_string()))),
                    ("exitCode", Some(Value::Number(exit_code.into()))),
                    ("timedOut", Some(Value::Bool(timed_out))),
                    (
                        "durationMs",
                        Some(Value::Number(serde_json::Number::from(duration_ms))),
                    ),
                ]),
            );
        });
    }
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
            command: body.command.clone().unwrap_or_default(),
            cwd: body.cwd.clone(),
            timeout_ms: body.timeout_ms,
            env: body.env.clone().map(|value| value.into_iter().collect()),
            permission_policy: config.permission_policy.clone(),
            tier: body.tier,
        })
        .await
        .map_err(map_exec_runtime_error)?;
    if let Ok(run) = create_runtime_session_run(&state, &result, &body) {
        let _ = state.runs.set_session_run_link(
            &result.session_id,
            &run.run_id,
            RunLinkInput {
                run_type: Some("session".to_string()),
                ..RunLinkInput::default()
            },
        );
        let _ = reconcile_runtime_session_run(&state, &result.session_id).await;
    }
    Ok(Json(serde_json::to_value(result).unwrap()))
}

async fn runtime_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RunListParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let result = state
        .runs
        .list_runs(RunListQuery {
            run_type: query.run_type,
            state: query.state,
            limit: query.limit,
            offset: query.offset,
        })
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({
        "ok": true,
        "runs": result.runs,
        "total": result.total,
        "offset": result.offset,
        "limit": result.limit,
        "hasMore": result.has_more,
    })))
}

async fn runtime_run_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let Some(run) = state.runs.get_run_by_id(&run_id).map_err(internal_error)? else {
        return Err(json_error(StatusCode::NOT_FOUND, "Run not found."));
    };
    Ok(Json(json!({
        "ok": true,
        "run": run,
    })))
}

async fn runtime_runs_diagnostics(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RunDiagnosticsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .runs
        .get_run_diagnostics(query.limit)
        .map_err(internal_error)?;
    Ok(Json(serde_json::to_value(payload).unwrap()))
}

async fn acp_create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AcpCreateSessionBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let session = state
        .acp
        .create_session(AcpCreateSessionInput {
            agent_type: body.agent_type,
            cwd: body.cwd,
            command: parse_acp_command(body.command)
                .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?,
            env: body.env,
            timeout_ms: body.timeout_ms,
            origin: body.origin,
            input_provenance: body.input_provenance,
            tier: body.tier,
            ..AcpCreateSessionInput::default()
        })
        .await;
    let run = create_acp_run(&state, &session).map_err(internal_error)?;
    let session = state
        .acp
        .attach_run_id(&session.session_id, &run.run_id)
        .await
        .unwrap_or(session);
    Ok(Json(serde_json::to_value(session).unwrap()))
}

async fn acp_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AcpSessionsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .acp
        .list_sessions(AcpListQuery {
            state: query.state,
            limit: query.limit,
            offset: query.offset,
        })
        .await;
    Ok(Json(serde_json::to_value(payload).unwrap()))
}

async fn acp_session_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let Some(session) = state.acp.get_session(&session_id).await else {
        return Err(json_error(StatusCode::NOT_FOUND, "ACP session not found."));
    };
    Ok(Json(serde_json::to_value(session).unwrap()))
}

async fn acp_prompt_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<AcpPromptBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let ack = state
        .acp
        .enqueue_prompt(
            &session_id,
            AcpPromptInput {
                prompt: body.prompt,
                turn_id: body.turn_id,
                timeout_ms: body.timeout_ms,
                command: parse_acp_command(body.command)
                    .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?,
                cwd: body.cwd,
                env: body.env,
                origin: body.origin,
                input_provenance: body.input_provenance,
                tier: body.tier,
            },
        )
        .await
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    if let Some(session) = state.acp.get_session(&session_id).await {
        sync_acp_run_ingress(&state, &session, Some(ack.turn_id.clone()))
            .map_err(internal_error)?;
    }
    Ok(Json(serde_json::to_value(ack).unwrap()))
}

async fn acp_steer_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(body): Json<AcpSteerBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let ack = state
        .acp
        .enqueue_steer(
            &session_id,
            AcpSteerInput {
                text: body.text,
                submit: body.submit,
                turn_id: body.turn_id,
            },
        )
        .await
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(serde_json::to_value(ack).unwrap()))
}

async fn acp_cancel_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .acp
        .cancel_session(&session_id)
        .await
        .map_err(|error| json_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    if let Some(session) = state.acp.get_session(&session_id).await {
        let _ = sync_acp_terminal_run_state(&state, &session, None, None, None, None);
    }
    Ok(Json(serde_json::to_value(payload).unwrap()))
}

async fn acp_session_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<AcpEventsParams>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let payload = state
        .acp
        .list_session_events(
            &session_id,
            AcpEventsQuery {
                after: query.after,
                limit: query.limit,
            },
        )
        .await;
    Ok(Json(serde_json::to_value(payload).unwrap()))
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

async fn runtime_session_log_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Query(query): Query<SessionLogStreamParams>,
) -> Result<impl IntoResponse, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;

    // SSE only supports single stream (stdout or stderr), not both.
    let log_stream = match query
        .stream
        .as_deref()
        .unwrap_or("stdout")
        .trim()
        .to_lowercase()
        .as_str()
    {
        "stdout" => LogStream::Stdout,
        "stderr" => LogStream::Stderr,
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                "SSE stream must be stdout or stderr",
            ));
        }
    };
    let stream_name = match &log_stream {
        LogStream::Stdout => "stdout",
        LogStream::Stderr => "stderr",
        LogStream::Both => unreachable!(),
    };
    let poll_ms = query.poll_interval_ms.unwrap_or(500).clamp(100, 5_000);
    let start_offset = query.offset.unwrap_or(0);

    // Pre-flight: verify session exists before opening SSE connection.
    let initial = state
        .runtime
        .get_session_log(
            &session_id,
            SessionLogQuery {
                stream: log_stream.clone(),
                limit: Some(4096),
                offset: Some(start_offset),
            },
        )
        .await
        .map_err(map_runtime_error)?;
    let initial_offset = initial.next_offset.unwrap_or(start_offset);

    let event_stream = async_stream::stream! {
        // Emit initial chunk if non-empty.
        let mut offset = initial_offset;
        if let Some(output) = initial.output.as_deref() {
            if !output.is_empty() {
                let payload = serde_json::json!({
                    "stream": stream_name,
                    "output": output,
                    "offset": start_offset,
                    "nextOffset": offset,
                    "hasMore": initial.has_more.unwrap_or(false),
                });
                yield Ok::<_, std::convert::Infallible>(
                    SseEvent::default().event("log").data(payload.to_string()).id(offset.to_string())
                );
            }
        }

        if initial.status != "running" && !initial.has_more.unwrap_or(false) {
            yield Ok(SseEvent::default().event("done").data(
                serde_json::json!({"status": initial.status}).to_string()
            ));
            return;
        }

        let mut interval = tokio::time::interval(std::time::Duration::from_millis(poll_ms));
        interval.tick().await; // skip first immediate tick

        loop {
            interval.tick().await;

            let result = match state.runtime.get_session_log(
                &session_id,
                SessionLogQuery {
                    stream: log_stream.clone(),
                    limit: Some(4096),
                    offset: Some(offset),
                },
            ).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(%session_id, error = %e, "stopping session log SSE");
                    yield Ok(SseEvent::default().event("error").data(
                        serde_json::json!({"error": "session_lost"}).to_string()
                    ));
                    break;
                }
            };

            // Always sync offset from server to handle out-of-range start values.
            let next = result.next_offset.unwrap_or(offset);

            if let Some(output) = result.output.as_deref() {
                if !output.is_empty() {
                    let payload = serde_json::json!({
                        "stream": stream_name,
                        "output": output,
                        "offset": offset,
                        "nextOffset": next,
                        "hasMore": result.has_more.unwrap_or(false),
                    });
                    yield Ok(SseEvent::default().event("log").data(payload.to_string()).id(next.to_string()));
                }
            }
            offset = next;

            if result.status != "running" && !result.has_more.unwrap_or(false) {
                yield Ok(SseEvent::default().event("done").data(
                    serde_json::json!({"status": result.status}).to_string()
                ));
                break;
            }
        }
    };

    Ok(Sse::new(event_stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keepalive"),
    ))
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

fn builtin_mcp_tools() -> Vec<ListedTool> {
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }

    vec![ListedTool {
        server: BUILTIN_DESKTOP_TOOL_SERVER.to_string(),
        name: BUILTIN_DESKTOP_TOOL_NAME.to_string(),
        description: "Control local Windows desktop features exposed by Ghast AI Companion. Supported actions: clipboard read/write, filesystem text read/write, File Explorer list/reveal, process list/terminate, screenshot capture, window automation, and desktop notifications. Companion permissions still apply.".to_string(),
        input_schema: builtin_desktop_tool_schema(),
    }]
}

fn builtin_desktop_tool_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["action"],
        "properties": {
            "action": {
                "type": "string",
                "description": "Desktop action to execute.",
                "enum": [
                    "clipboard.read_text",
                    "clipboard.write_text",
                    "filesystem.read_text",
                    "filesystem.write_text",
                    "explorer.list_items",
                    "explorer.reveal_item",
                    "process.list",
                    "process.terminate",
                    "screenshot.capture",
                    "window.list",
                    "window.activate",
                    "window.minimize",
                    "notification.show",
                    "registry.write_value",
                    "service.list",
                    "service.start",
                    "service.stop",
                    "service.restart",
                    "task.list",
                    "task.run",
                    "task.delete",
                    "admin_shell.run"
                ]
            },
            "text": {
                "type": "string",
                "description": "Text to write when action=clipboard.write_text or action=filesystem.write_text."
            },
            "title": {
                "type": "string",
                "description": "Title text when action=notification.show."
            },
            "body": {
                "type": "string",
                "description": "Optional message body when action=notification.show."
            },
            "path": {
                "type": "string",
                "description": "Target path for filesystem, explorer, registry, and scheduled-task actions."
            },
            "name": {
                "type": "string",
                "description": "Value name for action=registry.write_value, service name for action=service.*, or task name for action=task.*."
            },
            "value": {
                "description": "Registry value payload for action=registry.write_value."
            },
            "valueType": {
                "type": "string",
                "enum": ["string", "expand_string", "dword", "qword"],
                "description": "Registry value type for action=registry.write_value."
            },
            "command": {
                "type": "string",
                "description": "Executable or shell entry point for action=admin_shell.run."
            },
            "arguments": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional command arguments for action=admin_shell.run."
            },
            "workingDirectory": {
                "type": "string",
                "description": "Optional working directory for action=admin_shell.run."
            },
            "windowHandle": {
                "type": "string",
                "description": "Window handle returned by action=window.list."
            },
            "includeHidden": {
                "type": "boolean",
                "description": "Whether hidden files should be included when action=explorer.list_items."
            },
            "includeMinimized": {
                "type": "boolean",
                "description": "Whether minimized windows should be included when action=window.list."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "description": "Optional maximum number of items to return for list actions."
            },
            "query": {
                "type": "string",
                "description": "Optional filter for action=process.list or action=window.list."
            },
            "pid": {
                "type": "integer",
                "minimum": 1,
                "description": "Process ID for action=process.terminate."
            },
            "force": {
                "type": "boolean",
                "description": "Whether to force-stop the process when action=process.terminate. Defaults to true."
            },
            "displayIndex": {
                "type": "integer",
                "minimum": 0,
                "description": "Display index for action=screenshot.capture. Defaults to 0."
            }
        }
    })
}

async fn call_builtin_mcp_tool(
    state: &AppState,
    config: &CompanionConfig,
    tool_name: &str,
    arguments: Value,
) -> ToolCallResult {
    if tool_name != BUILTIN_DESKTOP_TOOL_NAME {
        return builtin_tool_error(format!(
            "Tool \"{tool_name}\" not found on server \"{BUILTIN_DESKTOP_TOOL_SERVER}\""
        ));
    }

    if !cfg!(target_os = "windows") {
        return builtin_tool_error(
            "The built-in desktop_control tool is currently only available on Windows.",
        );
    }

    let args: DesktopControlToolArgs = match serde_json::from_value(arguments) {
        Ok(value) => value,
        Err(error) => {
            return builtin_tool_error(format!(
                "Invalid arguments for {BUILTIN_DESKTOP_TOOL_NAME}: {error}"
            ))
        }
    };

    let Some(action) = args.action.clone().and_then(trim_optional) else {
        return builtin_tool_error("\"action\" is required.");
    };

    match action.as_str() {
        "clipboard.read_text" => builtin_clipboard_read_tool(state, config),
        "clipboard.write_text" => builtin_clipboard_write_tool(state, config, args),
        "filesystem.read_text" => builtin_filesystem_read_tool(state, config, args),
        "filesystem.write_text" => builtin_filesystem_write_tool(state, config, args),
        "explorer.list_items" => builtin_explorer_list_tool(state, config, args),
        "explorer.reveal_item" => builtin_explorer_reveal_tool(state, config, args),
        "process.list" => builtin_process_list_tool(state, config, args),
        "process.terminate" => builtin_process_terminate_tool(state, config, args),
        "screenshot.capture" => builtin_screenshot_tool(state, config, args),
        "window.list" => builtin_window_list_tool(state, config, args),
        "window.activate" => builtin_window_activate_tool(state, config, args),
        "window.minimize" => builtin_window_minimize_tool(state, config, args),
        "notification.show" => builtin_notification_show_tool(state, config, args),
        "registry.write_value" => builtin_registry_write_tool(state, config, args),
        "service.list" => builtin_service_list_tool(state, config, args),
        "service.start" => builtin_service_start_tool(state, config, args),
        "service.stop" => builtin_service_stop_tool(state, config, args),
        "service.restart" => builtin_service_restart_tool(state, config, args),
        "task.list" => builtin_task_list_tool(state, config, args),
        "task.run" => builtin_task_run_tool(state, config, args),
        "task.delete" => builtin_task_delete_tool(state, config, args),
        "admin_shell.run" => builtin_admin_shell_tool(state, config, args),
        _ => builtin_tool_error(format!(
            "Unknown action \"{action}\" for {BUILTIN_DESKTOP_TOOL_NAME}."
        )),
    }
}

fn builtin_clipboard_read_tool(state: &AppState, config: &CompanionConfig) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "clipboard",
        "Clipboard access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let run_id = create_app_action_run(
        state,
        "clipboard",
        "desktop_control.clipboard.read_text",
        Some("clipboard text".to_string()),
        "Reading clipboard text",
    )
    .ok()
    .map(|run| run.run_id);

    match get_clipboard_text() {
        Ok(contents) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Read clipboard text",
                    None,
                    app_action_result_meta_clipboard(&contents),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "clipboard": contents,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to read clipboard text",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_clipboard_write_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "clipboard",
        "Clipboard access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = SetClipboardTextRequest {
        text: args.text.unwrap_or_default(),
    };
    let preview = trim_optional(request.text.clone());
    let run_id = create_app_action_run(
        state,
        "clipboard",
        "desktop_control.clipboard.write_text",
        preview,
        "Writing clipboard text",
    )
    .ok()
    .map(|run| run.run_id);

    match set_clipboard_text(&request) {
        Ok(contents) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Updated clipboard text",
                    None,
                    app_action_result_meta_clipboard(&contents),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "clipboard": contents,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to write clipboard text",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_filesystem_read_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "filesystem",
        "Filesystem access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ReadTextFileRequest {
        path: args.path.unwrap_or_default(),
    };
    let preview = trim_optional(request.path.clone());
    let run_id = create_app_action_run(
        state,
        "filesystem",
        "desktop_control.filesystem.read_text",
        preview,
        "Reading local text file",
    )
    .ok()
    .map(|run| run.run_id);

    match read_text_file(&request) {
        Ok(file) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Read local text file",
                    None,
                    app_action_result_meta_text_file(&file),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "file": file,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to read local text file",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_filesystem_write_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "filesystem",
        "Filesystem access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = companion_app::WriteTextFileRequest {
        path: args.path.unwrap_or_default(),
        text: args.text.unwrap_or_default(),
    };
    let preview = trim_optional(request.path.clone());
    let run_id = create_app_action_run(
        state,
        "filesystem",
        "desktop_control.filesystem.write_text",
        preview,
        "Writing local text file",
    )
    .ok()
    .map(|run| run.run_id);

    match write_text_file(&request) {
        Ok(file) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Wrote local text file",
                    None,
                    app_action_result_meta_text_file_write(&file),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "file": file,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to write local text file",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_explorer_list_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "explorer",
        "File Explorer access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ListExplorerItemsRequest {
        path: args.path,
        include_hidden: args.include_hidden.unwrap_or(false),
        limit: args.limit,
    };
    let preview = request
        .path
        .clone()
        .unwrap_or_else(|| "home folder".to_string());
    let run_id = create_app_action_run(
        state,
        "explorer",
        "desktop_control.explorer.list_items",
        Some(preview.clone()),
        "Listing Explorer items",
    )
    .ok()
    .map(|run| run.run_id);

    match list_explorer_items(&request) {
        Ok(items) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "itemCount",
                        Some(Value::Number(serde_json::Number::from(items.len() as u64))),
                    ),
                    ("path", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Listed Explorer items",
                    None,
                    extra,
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "items": items,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to list Explorer items",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_explorer_reveal_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "explorer",
        "File Explorer access is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ExplorerRevealRequest {
        path: args.path.unwrap_or_default(),
    };
    let preview = trim_optional(request.path.clone());
    let run_id = create_app_action_run(
        state,
        "explorer",
        "desktop_control.explorer.reveal_item",
        preview,
        "Revealing Explorer item",
    )
    .ok()
    .map(|run| run.run_id);

    match reveal_explorer_item(&request) {
        Ok(item) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Revealed Explorer item",
                    None,
                    app_action_result_meta_explorer_reveal(&item),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "item": item,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to reveal Explorer item",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_process_list_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "process_control",
        "Process control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ListProcessesRequest {
        query: args.query,
        limit: args.limit,
    };
    let preview = request
        .query
        .clone()
        .unwrap_or_else(|| "all processes".to_string());
    let run_id = create_app_action_run(
        state,
        "process_control",
        "desktop_control.process.list",
        Some(preview.clone()),
        "Listing local processes",
    )
    .ok()
    .map(|run| run.run_id);

    match list_processes(&request) {
        Ok(processes) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "processCount",
                        Some(Value::Number(serde_json::Number::from(
                            processes.len() as u64
                        ))),
                    ),
                    ("query", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Listed local processes",
                    None,
                    extra,
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "processes": processes,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to list local processes",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_process_terminate_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "process_control",
        "Process control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = TerminateProcessRequest {
        pid: args.pid.unwrap_or_default(),
        force: args.force.unwrap_or(true),
    };
    let run_id = create_app_action_run(
        state,
        "process_control",
        "desktop_control.process.terminate",
        Some(format!("pid {}", request.pid)),
        "Stopping a local process",
    )
    .ok()
    .map(|run| run.run_id);

    match terminate_process(&request) {
        Ok(process) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Stopped local process",
                    None,
                    app_action_result_meta_process_termination(&process),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "process": process,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to stop local process",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_screenshot_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "screenshot",
        "Screenshot capture is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = CaptureScreenshotRequest {
        display_index: args.display_index,
    };
    let preview = request
        .display_index
        .map(|index| format!("display {index}"))
        .unwrap_or_else(|| "primary display".to_string());
    let run_id = create_app_action_run(
        state,
        "screenshot",
        "desktop_control.screenshot.capture",
        Some(preview),
        "Capturing screenshot",
    )
    .ok()
    .map(|run| run.run_id);

    match capture_screenshot(&request) {
        Ok(capture) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Captured screenshot",
                    None,
                    app_action_result_meta_screenshot(&capture),
                );
            }
            builtin_tool_image_result(
                json!({
                    "ok": true,
                    "capture": {
                        "displayIndex": capture.display_index,
                        "width": capture.width,
                        "height": capture.height,
                        "mimeType": capture.mime_type.clone(),
                    }
                }),
                capture,
            )
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to capture screenshot",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_window_list_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "window_automation",
        "Window automation is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ListWindowsRequest {
        query: args.query,
        include_minimized: args.include_minimized.unwrap_or(false),
        limit: args.limit,
    };
    let preview = request
        .query
        .clone()
        .unwrap_or_else(|| "open windows".to_string());
    let run_id = create_app_action_run(
        state,
        "window_automation",
        "desktop_control.window.list",
        Some(preview.clone()),
        "Listing desktop windows",
    )
    .ok()
    .map(|run| run.run_id);

    match list_windows(&request) {
        Ok(windows) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "windowCount",
                        Some(Value::Number(
                            serde_json::Number::from(windows.len() as u64),
                        )),
                    ),
                    ("query", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Listed desktop windows",
                    None,
                    extra,
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "windows": windows,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to list desktop windows",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_window_activate_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "window_automation",
        "Window automation is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = WindowActionRequest {
        window_handle: args.window_handle.unwrap_or_default(),
    };
    let preview = trim_optional(request.window_handle.clone());
    let run_id = create_app_action_run(
        state,
        "window_automation",
        "desktop_control.window.activate",
        preview,
        "Activating desktop window",
    )
    .ok()
    .map(|run| run.run_id);

    match activate_window(&request) {
        Ok(result) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Activated desktop window",
                    None,
                    app_action_result_meta_window_action(&result),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "window": result,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to activate desktop window",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_window_minimize_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "window_automation",
        "Window automation is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = WindowActionRequest {
        window_handle: args.window_handle.unwrap_or_default(),
    };
    let preview = trim_optional(request.window_handle.clone());
    let run_id = create_app_action_run(
        state,
        "window_automation",
        "desktop_control.window.minimize",
        preview,
        "Minimizing desktop window",
    )
    .ok()
    .map(|run| run.run_id);

    match minimize_window(&request) {
        Ok(result) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Minimized desktop window",
                    None,
                    app_action_result_meta_window_action(&result),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "window": result,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to minimize desktop window",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_notification_show_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "desktop_notification",
        "Desktop notifications are disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = DesktopNotificationRequest {
        title: args.title.unwrap_or_default(),
        body: args.body,
    };
    let preview = trim_optional(request.title.clone());
    let run_id = create_app_action_run(
        state,
        "desktop_notification",
        "desktop_control.notification.show",
        preview,
        "Showing desktop notification",
    )
    .ok()
    .map(|run| run.run_id);

    match show_desktop_notification(&request) {
        Ok(notification) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Displayed desktop notification",
                    None,
                    app_action_result_meta_notification(&notification),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "notification": notification,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to display desktop notification",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_registry_write_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "registry_write",
        "Registry changes are disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = RegistryWriteRequest {
        path: args.path.unwrap_or_default(),
        name: args.name.unwrap_or_default(),
        value_type: args.value_type.unwrap_or_else(|| "string".to_string()),
        value: args.value.unwrap_or(Value::Null),
    };
    let preview = trim_optional(format!(
        "{} :: {}",
        request.path.trim(),
        request.name.trim()
    ));
    let run_id = create_app_action_run(
        state,
        "registry_write",
        "desktop_control.registry.write_value",
        preview,
        "Writing Windows registry value",
    )
    .ok()
    .map(|run| run.run_id);

    match write_registry_value(&request) {
        Ok(entry) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Updated Windows registry value",
                    None,
                    app_action_result_meta_registry_write(&entry),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "entry": entry,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to update Windows registry value",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_service_list_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "service_control",
        "Windows service control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ListServicesRequest {
        query: args.query,
        limit: args.limit,
    };
    let preview = request
        .query
        .clone()
        .unwrap_or_else(|| "all services".to_string());
    let run_id = create_app_action_run(
        state,
        "service_control",
        "desktop_control.service.list",
        Some(preview.clone()),
        "Listing Windows services",
    )
    .ok()
    .map(|run| run.run_id);

    match list_services(&request) {
        Ok(services) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "serviceCount",
                        Some(Value::Number(serde_json::Number::from(
                            services.len() as u64
                        ))),
                    ),
                    ("query", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Listed Windows services",
                    None,
                    extra,
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "services": services,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to list Windows services",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_service_start_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    builtin_service_action_tool(
        state,
        config,
        args,
        "desktop_control.service.start",
        "Starting Windows service",
        "Started Windows service",
        "Failed to start Windows service",
        start_service,
    )
}

fn builtin_service_stop_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    builtin_service_action_tool(
        state,
        config,
        args,
        "desktop_control.service.stop",
        "Stopping Windows service",
        "Stopped Windows service",
        "Failed to stop Windows service",
        stop_service,
    )
}

fn builtin_service_restart_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    builtin_service_action_tool(
        state,
        config,
        args,
        "desktop_control.service.restart",
        "Restarting Windows service",
        "Restarted Windows service",
        "Failed to restart Windows service",
        restart_service,
    )
}

fn builtin_service_action_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
    action_name: &str,
    pending_summary: &str,
    success_summary: &str,
    failed_summary: &str,
    action: fn(
        &ServiceActionRequest,
    ) -> std::result::Result<ServiceActionResult, AppIntegrationError>,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "service_control",
        "Windows service control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ServiceActionRequest {
        name: args.name.unwrap_or_default(),
    };
    let preview = trim_optional(request.name.clone());
    let run_id = create_app_action_run(
        state,
        "service_control",
        action_name,
        preview,
        pending_summary,
    )
    .ok()
    .map(|run| run.run_id);

    match action(&request) {
        Ok(service) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    success_summary,
                    None,
                    app_action_result_meta_service_action(&service),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "service": service,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    failed_summary,
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_task_list_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "task_scheduler",
        "Scheduled task control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ListScheduledTasksRequest {
        query: args.query,
        limit: args.limit,
    };
    let preview = request
        .query
        .clone()
        .unwrap_or_else(|| "all scheduled tasks".to_string());
    let run_id = create_app_action_run(
        state,
        "task_scheduler",
        "desktop_control.task.list",
        Some(preview.clone()),
        "Listing scheduled tasks",
    )
    .ok()
    .map(|run| run.run_id);

    match list_scheduled_tasks(&request) {
        Ok(tasks) => {
            if let Some(run_id) = run_id {
                let extra = json_object(vec![
                    (
                        "taskCount",
                        Some(Value::Number(serde_json::Number::from(tasks.len() as u64))),
                    ),
                    ("query", Some(Value::String(preview))),
                ]);
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    "Listed scheduled tasks",
                    None,
                    extra,
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "tasks": tasks,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to list scheduled tasks",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_task_run_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    builtin_task_action_tool(
        state,
        config,
        args,
        "desktop_control.task.run",
        "Starting scheduled task",
        "Started scheduled task",
        "Failed to start scheduled task",
        run_scheduled_task,
    )
}

fn builtin_task_delete_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    builtin_task_action_tool(
        state,
        config,
        args,
        "desktop_control.task.delete",
        "Deleting scheduled task",
        "Deleted scheduled task",
        "Failed to delete scheduled task",
        delete_scheduled_task,
    )
}

fn builtin_task_action_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
    action_name: &str,
    pending_summary: &str,
    success_summary: &str,
    failed_summary: &str,
    action: fn(
        &ScheduledTaskActionRequest,
    ) -> std::result::Result<ScheduledTaskActionResult, AppIntegrationError>,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "task_scheduler",
        "Scheduled task control is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = ScheduledTaskActionRequest {
        name: args.name.unwrap_or_default(),
        task_path: args.path,
    };
    let preview = trim_optional(match request.task_path.as_deref() {
        Some(task_path) => format!("{task_path}{}", request.name.trim()),
        None => request.name.clone(),
    });
    let run_id = create_app_action_run(
        state,
        "task_scheduler",
        action_name,
        preview,
        pending_summary,
    )
    .ok()
    .map(|run| run.run_id);

    match action(&request) {
        Ok(task) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    true,
                    success_summary,
                    None,
                    app_action_result_meta_task_action(&task),
                );
            }
            builtin_tool_json_result(json!({
                "ok": true,
                "task": task,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    failed_summary,
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn builtin_admin_shell_tool(
    state: &AppState,
    config: &CompanionConfig,
    args: DesktopControlToolArgs,
) -> ToolCallResult {
    if let Err(result) = ensure_tool_capability_enabled(
        config,
        "admin_shell",
        "Elevated shell is disabled in Companion permissions.",
    ) {
        return result;
    }

    let request = AdminShellRequest {
        command: args.command.unwrap_or_default(),
        arguments: args.arguments.unwrap_or_default(),
        working_directory: args.working_directory,
    };
    let preview = trim_optional(if request.arguments.is_empty() {
        request.command.clone()
    } else {
        format!("{} {}", request.command, request.arguments.join(" "))
    });
    let run_id = create_app_action_run(
        state,
        "admin_shell",
        "desktop_control.admin_shell.run",
        preview,
        "Running elevated shell command",
    )
    .ok()
    .map(|run| run.run_id);

    match run_admin_shell(&request) {
        Ok(result) => {
            let command_ok = result.exit_code == 0;
            if let Some(run_id) = run_id {
                let error_text = if command_ok {
                    None
                } else {
                    trim_optional(if result.stderr.trim().is_empty() {
                        format!("Process exited with code {}", result.exit_code)
                    } else {
                        format!(
                            "Process exited with code {}: {}",
                            result.exit_code,
                            result.stderr.trim()
                        )
                    })
                };
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    command_ok,
                    if command_ok {
                        "Elevated shell command finished"
                    } else {
                        "Elevated shell command failed"
                    },
                    error_text,
                    app_action_result_meta_admin_shell(&result),
                );
            }
            builtin_tool_json_result(json!({
                "ok": command_ok,
                "result": result,
            }))
        }
        Err(error) => {
            if let Some(run_id) = run_id {
                let _ = finish_app_action_run(
                    state,
                    &run_id,
                    false,
                    "Failed to run elevated shell command",
                    Some(error.to_string()),
                    None,
                );
            }
            map_app_integration_error_to_tool(error)
        }
    }
}

fn ensure_tool_capability_enabled(
    config: &CompanionConfig,
    capability: &str,
    message: &str,
) -> std::result::Result<(), ToolCallResult> {
    if config
        .companion_capabilities
        .get(capability)
        .copied()
        .unwrap_or(false)
    {
        return Ok(());
    }

    Err(builtin_tool_error(message))
}

fn map_app_integration_error_to_tool(error: AppIntegrationError) -> ToolCallResult {
    builtin_tool_error(error.to_string())
}

fn builtin_tool_json_result(payload: Value) -> ToolCallResult {
    ToolCallResult {
        ok: true,
        content: vec![json!({
            "type": "text",
            "text": payload.to_string(),
        })],
        is_error: false,
        error: None,
    }
}

fn builtin_tool_image_result(summary: Value, capture: ScreenshotCapture) -> ToolCallResult {
    ToolCallResult {
        ok: true,
        content: vec![
            json!({
                "type": "text",
                "text": summary.to_string(),
            }),
            json!({
                "type": "image",
                "data": capture.image_base64,
                "mimeType": capture.mime_type,
            }),
        ],
        is_error: false,
        error: None,
    }
}

fn builtin_tool_error(message: impl Into<String>) -> ToolCallResult {
    ToolCallResult {
        ok: false,
        content: Vec::new(),
        is_error: false,
        error: Some(message.into()),
    }
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
    let mut tools = state.mcp.get_all_tools().await;
    tools.extend(builtin_mcp_tools());
    Ok(Json(json!({
        "tools": tools,
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
    let arguments = body.arguments.unwrap_or_else(|| json!({}));
    if server.trim().is_empty() || tool.trim().is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "\"server\" and \"tool\" are required.",
        ));
    }
    if server.trim() == BUILTIN_DESKTOP_TOOL_SERVER {
        let result = call_builtin_mcp_tool(&state, &config, tool.trim(), arguments).await;
        return Ok(Json(serde_json::to_value(result).unwrap()));
    }
    let result = state
        .mcp
        .call_tool(server.trim(), tool.trim(), arguments)
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
    let next_config = update_mcp_server_config(&current, &name, &normalized)
        .and_then(|next| mark_mcp_server_enabled(&next, &name))
        .map_err(internal_error)?;
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
    let (next_config, removed) = remove_mcp_server_config(&current, &name)
        .and_then(|(next, removed)| {
            mark_mcp_server_disabled(&next, &name).map(|updated| (updated, removed))
        })
        .map_err(internal_error)?;
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

async fn create_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ApprovalCreateBody>,
) -> Result<(StatusCode, Json<serde_json::Value>), Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let request_id = trim_or_generated(body.request_id.clone());
    let body_meta = value_to_object_map(body.meta.clone());
    let existing = state
        .approvals
        .get_approval_by_id(&request_id)
        .map_err(internal_error)?;
    let mut run = existing
        .as_ref()
        .and_then(|approval| approval.meta.as_ref())
        .and_then(|meta| object_string(Some(meta), "runId"))
        .and_then(|run_id| state.runs.get_run_record(&run_id).ok().flatten());

    let tracking =
        resolve_approval_session_tracking(body_meta.as_ref(), existing.as_ref(), run.as_ref());

    if run.is_none() {
        run = Some(
            state
                .runs
                .create_run(CreateRunInput {
                    run_type: Some("approval".to_string()),
                    state: Some("waiting_approval".to_string()),
                    started_at: Some(now_millis()),
                    session_id: tracking.session_id.clone(),
                    session_type: tracking.session_type.clone(),
                    lane_id: Some("remote:approval".to_string()),
                    source: Some("remote".to_string()),
                    contract_version: Some(capabilities_payload().run_contract_version),
                    summary: Some("Awaiting approval".to_string()),
                    meta: json_object(vec![
                        ("requestId", Some(Value::String(request_id.clone()))),
                        ("approvalRequestId", Some(Value::String(request_id.clone()))),
                        (
                            "conversationId",
                            body.conversation_id
                                .clone()
                                .and_then(trim_optional)
                                .map(Value::String),
                        ),
                        (
                            "toolName",
                            body.tool_name
                                .clone()
                                .and_then(trim_optional)
                                .map(Value::String),
                        ),
                        (
                            "toolPreview",
                            body.tool_preview
                                .clone()
                                .and_then(trim_optional)
                                .map(Value::String),
                        ),
                        (
                            "riskLevel",
                            body.risk_level
                                .clone()
                                .and_then(trim_optional)
                                .map(Value::String),
                        ),
                        (
                            "channels",
                            body.channels.clone().map(|values| {
                                Value::Array(values.into_iter().map(Value::String).collect())
                            }),
                        ),
                        ("sessionId", tracking.session_id.clone().map(Value::String)),
                        (
                            "sessionType",
                            tracking.session_type.clone().map(Value::String),
                        ),
                    ]),
                    ..CreateRunInput::default()
                })
                .map_err(internal_error)?,
        );
    }

    let mut approval = state
        .approvals
        .create_approval(CreateApprovalInput {
            request_id: Some(request_id.clone()),
            conversation_id: body.conversation_id.clone(),
            tool_name: body.tool_name.clone(),
            tool_preview: body.tool_preview.clone(),
            risk_level: body.risk_level.clone(),
            channels: body.channels.clone(),
            expires_at: body.expires_at,
            meta: merge_run_meta(
                body_meta.clone(),
                json_object(vec![
                    (
                        "runId",
                        run.as_ref()
                            .map(|value| Value::String(value.run_id.clone())),
                    ),
                    ("sessionId", tracking.session_id.clone().map(Value::String)),
                    (
                        "sessionType",
                        tracking.session_type.clone().map(Value::String),
                    ),
                    ("requestId", Some(Value::String(request_id.clone()))),
                    ("approvalRequestId", Some(Value::String(request_id.clone()))),
                ]),
            ),
        })
        .map_err(internal_error)?;

    if let Some(run) = &run {
        if object_string(approval.meta.as_ref(), "runId").as_deref() != Some(run.run_id.as_str()) {
            approval = state
                .approvals
                .relink_approval_run(&approval.request_id, &run.run_id)
                .map_err(internal_error)?
                .unwrap_or(approval);
        }

        let summary = match approval.status.as_str() {
            "approved" => "Approval approved",
            "expired" => "Approval expired",
            "rejected" => "Approval rejected",
            _ => "Awaiting approval",
        };
        let desired_state = match approval.status.as_str() {
            "approved" => "done",
            "pending" => "waiting_approval",
            _ => "cancelled",
        };
        let approval_meta = approval.meta.clone();
        let conversation_id = approval.conversation_id.clone();
        let resolved_by = approval.resolved_by.clone();
        state
            .runs
            .update_run(&run.run_id, |current| {
                current.state = desired_state.to_string();
                current.summary = Some(summary.to_string());
                current.session_id = tracking
                    .session_id
                    .clone()
                    .or_else(|| current.session_id.clone());
                current.session_type = tracking
                    .session_type
                    .clone()
                    .or_else(|| current.session_type.clone());
                if desired_state != "waiting_approval" {
                    current.finished_at = Some(now_millis());
                }
                current.meta = merge_run_meta(
                    current.meta.clone(),
                    merge_run_meta(
                        approval_meta.clone(),
                        json_object(vec![
                            (
                                "conversationId",
                                trim_optional(conversation_id.clone()).map(Value::String),
                            ),
                            (
                                "approvalStatus",
                                Some(Value::String(approval.status.clone())),
                            ),
                            (
                                "resolvedBy",
                                resolved_by
                                    .clone()
                                    .and_then(trim_optional)
                                    .map(Value::String),
                            ),
                            ("sessionId", tracking.session_id.clone().map(Value::String)),
                            (
                                "sessionType",
                                tracking.session_type.clone().map(Value::String),
                            ),
                        ]),
                    ),
                );
            })
            .map_err(internal_error)?;
    }

    let status = if existing.is_some() {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(serde_json::to_value(approval).unwrap())))
}

async fn list_pending_approvals(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let expired = state
        .approvals
        .expire_overdue_approvals()
        .map_err(internal_error)?;
    for approval in expired {
        if let Some(run_id) = object_string(approval.meta.as_ref(), "runId") {
            let status = approval.status.clone();
            let meta = approval.meta.clone();
            let _ = state.runs.update_run(&run_id, |run| {
                run.state = "cancelled".to_string();
                run.finished_at = Some(now_millis());
                run.summary = Some("Approval expired".to_string());
                run.meta = merge_run_meta(
                    run.meta.clone(),
                    merge_run_meta(
                        meta.clone(),
                        json_object(vec![(
                            "approvalStatus",
                            Some(Value::String(status.clone())),
                        )]),
                    ),
                );
            });
        }
    }
    let approvals = state
        .approvals
        .list_pending_approvals()
        .map_err(internal_error)?;
    Ok(Json(json!({ "approvals": approvals })))
}

async fn resolve_approval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
    Json(body): Json<ApprovalResolveBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let Some(approval) = state
        .approvals
        .resolve_approval(
            &request_id,
            body.resolution.as_deref().unwrap_or("rejected"),
            body.resolved_by,
        )
        .map_err(internal_error)?
    else {
        return Err(json_error(StatusCode::NOT_FOUND, "Approval not found."));
    };
    if let Some(run_id) = object_string(approval.meta.as_ref(), "runId") {
        let state_value = match approval.status.as_str() {
            "approved" => "done",
            "pending" => "waiting_approval",
            _ => "cancelled",
        };
        let summary = match approval.status.as_str() {
            "approved" => "Approval approved",
            "expired" => "Approval expired",
            _ => "Approval rejected",
        };
        let approval_meta = approval.meta.clone();
        let resolved_by = approval.resolved_by.clone();
        let _ = state.runs.update_run(&run_id, |run| {
            run.state = state_value.to_string();
            run.summary = Some(summary.to_string());
            if state_value != "waiting_approval" {
                run.finished_at = Some(now_millis());
            }
            run.meta = merge_run_meta(
                run.meta.clone(),
                merge_run_meta(
                    approval_meta.clone(),
                    json_object(vec![
                        (
                            "approvalStatus",
                            Some(Value::String(approval.status.clone())),
                        ),
                        (
                            "resolvedBy",
                            resolved_by
                                .clone()
                                .and_then(trim_optional)
                                .map(Value::String),
                        ),
                    ]),
                ),
            );
        });
    }
    Ok(Json(serde_json::to_value(approval).unwrap()))
}

async fn get_approval_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let config = state.snapshot_config().await;
    authorize(&headers, &config)?;
    let expired = state
        .approvals
        .expire_overdue_approvals()
        .map_err(internal_error)?;
    for approval in expired {
        if let Some(run_id) = object_string(approval.meta.as_ref(), "runId") {
            let _ = state.runs.update_run(&run_id, |run| {
                run.state = "cancelled".to_string();
                run.finished_at = Some(now_millis());
                run.summary = Some("Approval expired".to_string());
                run.meta = merge_run_meta(
                    run.meta.clone(),
                    json_object(vec![(
                        "approvalStatus",
                        Some(Value::String("expired".to_string())),
                    )]),
                );
            });
        }
    }
    let Some(approval) = state
        .approvals
        .get_approval_by_id(&request_id)
        .map_err(internal_error)?
    else {
        return Err(json_error(StatusCode::NOT_FOUND, "Approval not found."));
    };
    Ok(Json(serde_json::to_value(approval).unwrap()))
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

fn create_app_action_run(
    state: &AppState,
    capability: &str,
    action_name: &str,
    preview: Option<String>,
    summary: &str,
) -> Result<RunRecord> {
    state.runs.create_run(CreateRunInput {
        run_type: Some("exec".to_string()),
        state: Some("running".to_string()),
        started_at: Some(now_millis()),
        lane_id: Some("remote:app".to_string()),
        source: Some("remote".to_string()),
        contract_version: Some(capabilities_payload().run_contract_version),
        summary: Some(summary.to_string()),
        meta: json_object(vec![
            ("toolName", Some(Value::String(action_name.to_string()))),
            (
                "toolPreview",
                preview.and_then(trim_optional).map(Value::String),
            ),
            ("capability", Some(Value::String(capability.to_string()))),
            ("permissionId", Some(Value::String(capability.to_string()))),
            ("actionSource", Some(Value::String("extension".to_string()))),
            ("actionCategory", Some(Value::String("app".to_string()))),
        ]),
        ..CreateRunInput::default()
    })
}

fn finish_app_action_run(
    state: &AppState,
    run_id: &str,
    ok: bool,
    summary: &str,
    error: Option<String>,
    extra_meta: Option<Map<String, Value>>,
) -> Result<()> {
    state
        .runs
        .update_run(run_id, |run| {
            run.state = if ok {
                "done".to_string()
            } else {
                "failed".to_string()
            };
            run.finished_at = Some(now_millis());
            run.summary = Some(summary.to_string());
            run.error = error.and_then(|value| truncate_text_for_error(&value));
            run.meta = merge_run_meta(run.meta.clone(), extra_meta);
        })
        .map(|_| ())
}

fn app_action_result_meta_calendar(event: &CalendarEvent) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "calendarName",
            trim_optional(event.calendar_name.clone()).map(Value::String),
        ),
        (
            "calendarEventId",
            trim_optional(event.uid.clone()).map(Value::String),
        ),
        (
            "startAt",
            trim_optional(event.start_at.clone()).map(Value::String),
        ),
        (
            "endAt",
            event
                .end_at
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
        (
            "location",
            event
                .location
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
    ])
}

fn app_action_result_meta_reminder(reminder: &ReminderItem) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "listName",
            trim_optional(reminder.list_name.clone()).map(Value::String),
        ),
        (
            "reminderId",
            trim_optional(reminder.id.clone()).map(Value::String),
        ),
        (
            "dueAt",
            reminder
                .due_at
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
        (
            "priority",
            Some(Value::Number(serde_json::Number::from(reminder.priority))),
        ),
    ])
}

fn app_action_result_meta_note(note: &NoteItem) -> Option<Map<String, Value>> {
    json_object(vec![
        ("noteId", trim_optional(note.id.clone()).map(Value::String)),
        (
            "folderId",
            note.folder_id
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
        (
            "folderName",
            trim_optional(note.folder_name.clone()).map(Value::String),
        ),
        (
            "accountName",
            note.account_name
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
        (
            "modifiedAt",
            note.modified_at
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
    ])
}

fn app_action_result_meta_clipboard(clipboard: &ClipboardTextResult) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "textLength",
            Some(Value::Number(serde_json::Number::from(
                clipboard.text.chars().count() as u64,
            ))),
        ),
        ("hasText", Some(Value::Bool(!clipboard.text.is_empty()))),
    ])
}

fn app_action_result_meta_text_file(file: &TextFileContent) -> Option<Map<String, Value>> {
    json_object(vec![
        ("path", trim_optional(file.path.clone()).map(Value::String)),
        (
            "textLength",
            Some(Value::Number(serde_json::Number::from(
                file.text.chars().count() as u64,
            ))),
        ),
    ])
}

fn app_action_result_meta_text_file_write(
    file: &TextFileWriteResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        ("path", trim_optional(file.path.clone()).map(Value::String)),
        (
            "bytesWritten",
            Some(Value::Number(serde_json::Number::from(file.bytes_written))),
        ),
    ])
}

fn app_action_result_meta_explorer_reveal(
    item: &ExplorerRevealResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        ("path", trim_optional(item.path.clone()).map(Value::String)),
        ("revealed", Some(Value::Bool(item.revealed))),
    ])
}

fn app_action_result_meta_finder_reveal(item: &FinderRevealResult) -> Option<Map<String, Value>> {
    json_object(vec![
        ("path", trim_optional(item.path.clone()).map(Value::String)),
        ("revealed", Some(Value::Bool(item.revealed))),
    ])
}

fn app_action_result_meta_safari_tab(tab: &SafariTab) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "windowIndex",
            Some(Value::Number(serde_json::Number::from(
                tab.window_index as u64,
            ))),
        ),
        (
            "tabIndex",
            Some(Value::Number(serde_json::Number::from(
                tab.tab_index as u64,
            ))),
        ),
        (
            "title",
            tab.title.clone().and_then(trim_optional).map(Value::String),
        ),
        (
            "url",
            tab.url.clone().and_then(trim_optional).map(Value::String),
        ),
        ("active", Some(Value::Bool(tab.active))),
    ])
}

fn app_action_result_meta_process_termination(
    process: &ProcessTerminationResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "pid",
            Some(Value::Number(serde_json::Number::from(process.pid as u64))),
        ),
        ("terminated", Some(Value::Bool(process.terminated))),
    ])
}

fn app_action_result_meta_screenshot(capture: &ScreenshotCapture) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "displayIndex",
            Some(Value::Number(serde_json::Number::from(
                capture.display_index as u64,
            ))),
        ),
        (
            "width",
            Some(Value::Number(serde_json::Number::from(
                capture.width as u64,
            ))),
        ),
        (
            "height",
            Some(Value::Number(serde_json::Number::from(
                capture.height as u64,
            ))),
        ),
        (
            "mimeType",
            trim_optional(capture.mime_type.clone()).map(Value::String),
        ),
    ])
}

fn app_action_result_meta_window_action(window: &WindowActionResult) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "windowHandle",
            trim_optional(window.window_handle.clone()).map(Value::String),
        ),
        ("success", Some(Value::Bool(window.success))),
    ])
}

fn app_action_result_meta_notification(
    notification: &DesktopNotificationResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "title",
            trim_optional(notification.title.clone()).map(Value::String),
        ),
        (
            "bodyLength",
            notification
                .body
                .as_ref()
                .map(|body| Value::Number(serde_json::Number::from(body.chars().count() as u64))),
        ),
        ("delivered", Some(Value::Bool(notification.delivered))),
    ])
}

fn app_action_result_meta_registry_write(
    entry: &RegistryWriteResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        ("path", trim_optional(entry.path.clone()).map(Value::String)),
        ("name", trim_optional(entry.name.clone()).map(Value::String)),
        (
            "valueType",
            trim_optional(entry.value_type.clone()).map(Value::String),
        ),
        ("updated", Some(Value::Bool(entry.updated))),
    ])
}

fn app_action_result_meta_service_action(
    service: &ServiceActionResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "name",
            trim_optional(service.name.clone()).map(Value::String),
        ),
        (
            "displayName",
            trim_optional(service.display_name.clone()).map(Value::String),
        ),
        (
            "status",
            trim_optional(service.status.clone()).map(Value::String),
        ),
    ])
}

fn app_action_result_meta_task_action(
    task: &ScheduledTaskActionResult,
) -> Option<Map<String, Value>> {
    json_object(vec![
        ("name", trim_optional(task.name.clone()).map(Value::String)),
        (
            "taskPath",
            trim_optional(task.task_path.clone()).map(Value::String),
        ),
        ("success", Some(Value::Bool(task.success))),
        (
            "state",
            task.state
                .clone()
                .and_then(trim_optional)
                .map(Value::String),
        ),
    ])
}

fn app_action_result_meta_admin_shell(result: &AdminShellResult) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "command",
            trim_optional(result.command.clone()).map(Value::String),
        ),
        (
            "exitCode",
            Some(Value::Number(serde_json::Number::from(result.exit_code))),
        ),
        (
            "stdoutLength",
            Some(Value::Number(serde_json::Number::from(
                result.stdout.chars().count() as u64,
            ))),
        ),
        (
            "stderrLength",
            Some(Value::Number(serde_json::Number::from(
                result.stderr.chars().count() as u64,
            ))),
        ),
        ("elevated", Some(Value::Bool(result.elevated))),
    ])
}

fn app_action_result_meta_completion(reminder: &ReminderCompletion) -> Option<Map<String, Value>> {
    json_object(vec![
        (
            "reminderId",
            trim_optional(reminder.id.clone()).map(Value::String),
        ),
        ("completed", Some(Value::Bool(reminder.completed))),
    ])
}

fn map_app_integration_error(error: AppIntegrationError) -> Response {
    match error {
        AppIntegrationError::InvalidRequest(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": message,
                "code": "app_invalid_request",
            })),
        )
            .into_response(),
        AppIntegrationError::PermissionDenied(message) => (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": message,
                "code": "app_permission_denied",
            })),
        )
            .into_response(),
        AppIntegrationError::UnsupportedPlatform => (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": error.to_string(),
                "code": "app_integration_unsupported",
            })),
        )
            .into_response(),
        AppIntegrationError::ExecutionFailed(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": message,
                "code": "app_integration_failed",
            })),
        )
            .into_response(),
    }
}

#[derive(Debug, Clone, Default)]
struct ApprovalTracking {
    session_id: Option<String>,
    session_type: Option<String>,
}

fn create_runtime_exec_run(
    state: &AppState,
    body: &RuntimeExecBody,
    config: &CompanionConfig,
) -> Result<RunRecord> {
    let command = body.command.clone().unwrap_or_default();
    let cwd = body.cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    });
    state.runs.create_run(CreateRunInput {
        run_type: Some("exec".to_string()),
        state: Some("running".to_string()),
        started_at: Some(now_millis()),
        lane_id: Some("remote:exec".to_string()),
        source: Some("remote".to_string()),
        contract_version: Some(capabilities_payload().run_contract_version),
        summary: Some("Executing local command".to_string()),
        meta: json_object(vec![
            ("command", trim_optional(command).map(Value::String)),
            ("cwd", trim_optional(cwd).map(Value::String)),
            (
                "timeoutMs",
                body.timeout_ms
                    .map(|value| Value::Number(serde_json::Number::from(value))),
            ),
            (
                "capability",
                Some(Value::String("local_command".to_string())),
            ),
            (
                "permissionId",
                Some(Value::String("local_command".to_string())),
            ),
            ("actionSource", Some(Value::String("extension".to_string()))),
            (
                "workspaceMode",
                Some(Value::String(config.permission_policy.mode.clone())),
            ),
        ]),
        ..CreateRunInput::default()
    })
}

fn create_runtime_session_run(
    state: &AppState,
    session: &companion_runtime::SessionSnapshot,
    body: &RuntimeExecBody,
) -> Result<RunRecord> {
    state.runs.create_run(CreateRunInput {
        run_type: Some("session".to_string()),
        state: Some(if session.status == "exited" {
            if !session.timed_out && session.exit_code.unwrap_or(-1) == 0 {
                "done".to_string()
            } else {
                "failed".to_string()
            }
        } else {
            "running".to_string()
        }),
        started_at: Some(session.started_at),
        finished_at: session.finished_at,
        session_id: Some(session.session_id.clone()),
        lane_id: Some("remote:session".to_string()),
        source: Some("remote".to_string()),
        contract_version: Some(capabilities_payload().run_contract_version),
        summary: Some(if session.status == "exited" {
            if !session.timed_out && session.exit_code.unwrap_or(-1) == 0 {
                "Session completed".to_string()
            } else {
                "Session failed".to_string()
            }
        } else {
            "Session started".to_string()
        }),
        error: if session.status == "exited"
            && (session.timed_out || session.exit_code.unwrap_or(-1) != 0)
        {
            Some(format!(
                "exitCode={}, timedOut={}",
                session.exit_code.unwrap_or(-1),
                session.timed_out
            ))
        } else {
            None
        },
        meta: json_object(vec![
            ("sessionId", Some(Value::String(session.session_id.clone()))),
            (
                "command",
                body.command
                    .clone()
                    .and_then(trim_optional)
                    .map(Value::String),
            ),
            ("cwd", trim_optional(session.cwd.clone()).map(Value::String)),
            (
                "timeoutMs",
                body.timeout_ms
                    .map(|value| Value::Number(serde_json::Number::from(value))),
            ),
            (
                "capability",
                Some(Value::String("local_command".to_string())),
            ),
            (
                "permissionId",
                Some(Value::String("local_command".to_string())),
            ),
            ("actionSource", Some(Value::String("extension".to_string()))),
        ]),
        ..CreateRunInput::default()
    })
}

async fn reconcile_runtime_session_run(state: &AppState, session_id: &str) -> Result<()> {
    let Some(session) = state.runtime.get_session(session_id).await else {
        return Ok(());
    };
    if session.status != "exited" {
        return Ok(());
    }
    let Some(link) = state.runs.get_session_run_link(session_id)? else {
        return Ok(());
    };
    state.runs.update_run(&link.run_id, |run| {
        run.state = if !session.timed_out && session.exit_code.unwrap_or(-1) == 0 {
            "done".to_string()
        } else {
            "failed".to_string()
        };
        run.finished_at = session.finished_at.or(Some(now_millis()));
        run.summary = Some(
            if !session.timed_out && session.exit_code.unwrap_or(-1) == 0 {
                "Session completed".to_string()
            } else {
                "Session failed".to_string()
            },
        );
        run.error = if session.timed_out || session.exit_code.unwrap_or(-1) != 0 {
            Some(format!(
                "exitCode={}, timedOut={}",
                session.exit_code.unwrap_or(-1),
                session.timed_out
            ))
        } else {
            None
        };
    })?;
    state.runs.clear_session_run_link(session_id)?;
    Ok(())
}

fn create_acp_run(
    state: &AppState,
    session: &companion_acp::AcpSessionSnapshot,
) -> Result<RunRecord> {
    let session_type = build_acp_session_type(&session.session_id);
    let record = state.runs.create_run(CreateRunInput {
        run_type: Some("acp".to_string()),
        state: Some(map_acp_run_state(&session.state).to_string()),
        started_at: session.started_at,
        finished_at: session.finished_at,
        session_id: Some(session.session_id.clone()),
        session_type: session_type.clone(),
        lane_id: Some("remote:acp".to_string()),
        source: Some("remote".to_string()),
        contract_version: Some(capabilities_payload().run_contract_version),
        summary: Some(acp_summary_for_state(&session.state, true).to_string()),
        meta: json_object(vec![
            ("sessionId", Some(Value::String(session.session_id.clone()))),
            ("sessionType", session_type.clone().map(Value::String)),
            (
                "agentType",
                trim_optional(session.agent_type.clone()).map(Value::String),
            ),
            ("cwd", trim_optional(session.cwd.clone()).map(Value::String)),
            (
                "origin",
                session
                    .origin
                    .clone()
                    .and_then(trim_optional)
                    .map(Value::String),
            ),
            ("inputProvenance", session.input_provenance.clone()),
            (
                "conversationId",
                json_value_string(session.input_provenance.as_ref(), "conversationId")
                    .map(Value::String),
            ),
            ("command", session.command.as_ref().map(command_spec_value)),
        ]),
        ..CreateRunInput::default()
    })?;
    let _ = state.runs.set_session_run_link(
        &session.session_id,
        &record.run_id,
        RunLinkInput {
            run_type: Some("acp".to_string()),
            ..RunLinkInput::default()
        },
    )?;
    Ok(record)
}

fn sync_acp_run_ingress(
    state: &AppState,
    session: &companion_acp::AcpSessionSnapshot,
    turn_id: Option<String>,
) -> Result<Option<RunRecord>> {
    let Some(run_id) = resolve_acp_run_id(state, session)? else {
        return Ok(None);
    };
    let session_type = build_acp_session_type(&session.session_id);
    let effective_turn_id = turn_id.or_else(|| session.current_turn_id.clone());
    let updated = state.runs.update_run(&run_id, |run| {
        run.state = map_acp_run_state(&session.state).to_string();
        run.started_at = session.started_at.or(run.started_at);
        run.session_id = Some(session.session_id.clone());
        run.session_type = session_type.clone();
        run.summary = Some(acp_summary_for_state(&session.state, false).to_string());
        run.error = None;
        run.meta = merge_run_meta(
            run.meta.clone(),
            json_object(vec![
                ("sessionId", Some(Value::String(session.session_id.clone()))),
                ("sessionType", session_type.clone().map(Value::String)),
                (
                    "turnId",
                    effective_turn_id
                        .clone()
                        .and_then(trim_optional)
                        .map(Value::String),
                ),
                (
                    "agentType",
                    trim_optional(session.agent_type.clone()).map(Value::String),
                ),
                ("cwd", trim_optional(session.cwd.clone()).map(Value::String)),
                (
                    "origin",
                    session
                        .origin
                        .clone()
                        .and_then(trim_optional)
                        .map(Value::String),
                ),
                ("inputProvenance", session.input_provenance.clone()),
                (
                    "conversationId",
                    json_value_string(session.input_provenance.as_ref(), "conversationId")
                        .map(Value::String),
                ),
                ("command", session.command.as_ref().map(command_spec_value)),
            ]),
        );
    })?;
    let _ = state.runs.set_session_run_link(
        &session.session_id,
        &run_id,
        RunLinkInput {
            run_type: Some("acp".to_string()),
            ..RunLinkInput::default()
        },
    )?;
    Ok(updated)
}

fn sync_acp_terminal_run_state(
    state: &AppState,
    session: &companion_acp::AcpSessionSnapshot,
    turn_id: Option<String>,
    terminal_code: Option<String>,
    message: Option<String>,
    exit_code: Option<i32>,
) -> Result<Option<RunRecord>> {
    let Some(run_id) = resolve_acp_run_id(state, session)? else {
        return Ok(None);
    };
    let next_state = map_acp_run_state(&session.state).to_string();
    let session_type = build_acp_session_type(&session.session_id);
    let effective_turn_id = turn_id.or_else(|| session.current_turn_id.clone());
    let error_text = if next_state == "failed" {
        message
            .clone()
            .and_then(trim_optional)
            .or_else(|| terminal_code.clone().and_then(trim_optional))
            .or_else(|| exit_code.map(|value| format!("exitCode={value}")))
    } else {
        None
    };
    let updated = state.runs.update_run(&run_id, |run| {
        run.state = next_state.clone();
        run.started_at = session.started_at.or(run.started_at);
        run.finished_at = session
            .finished_at
            .or(run.finished_at)
            .or(Some(now_millis()));
        run.session_id = Some(session.session_id.clone());
        run.session_type = session_type.clone();
        run.summary = Some(acp_summary_for_state(&session.state, false).to_string());
        run.error = error_text.clone();
        run.meta = merge_run_meta(
            run.meta.clone(),
            json_object(vec![
                ("sessionId", Some(Value::String(session.session_id.clone()))),
                ("sessionType", session_type.clone().map(Value::String)),
                (
                    "turnId",
                    effective_turn_id
                        .clone()
                        .and_then(trim_optional)
                        .map(Value::String),
                ),
                (
                    "agentType",
                    trim_optional(session.agent_type.clone()).map(Value::String),
                ),
                ("cwd", trim_optional(session.cwd.clone()).map(Value::String)),
                (
                    "origin",
                    session
                        .origin
                        .clone()
                        .and_then(trim_optional)
                        .map(Value::String),
                ),
                ("inputProvenance", session.input_provenance.clone()),
                (
                    "conversationId",
                    json_value_string(session.input_provenance.as_ref(), "conversationId")
                        .map(Value::String),
                ),
                ("command", session.command.as_ref().map(command_spec_value)),
                (
                    "exitCode",
                    exit_code.map(|value| Value::Number(value.into())),
                ),
                (
                    "terminalCode",
                    terminal_code
                        .clone()
                        .and_then(trim_optional)
                        .map(Value::String),
                ),
            ]),
        );
    })?;
    let _ = state.runs.clear_session_run_link(&session.session_id)?;
    Ok(updated)
}

fn parse_acp_command(value: Option<Value>) -> Result<Option<CommandSpec>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(command)) => Ok(Some(CommandSpec::Shell(
            trim_optional(command).ok_or_else(|| anyhow!("ACP command cannot be empty."))?,
        ))),
        Some(Value::Array(items)) => {
            let mut args = Vec::new();
            for item in items {
                let Some(item) = item.as_str() else {
                    return Err(anyhow!("ACP command array must contain only strings."));
                };
                let normalized = trim_optional(item.to_string())
                    .ok_or_else(|| anyhow!("ACP command array cannot contain empty values."))?;
                args.push(normalized);
            }
            if args.is_empty() {
                return Err(anyhow!("ACP command array cannot be empty."));
            }
            Ok(Some(CommandSpec::Args(args)))
        }
        Some(_) => Err(anyhow!(
            "ACP command must be a string shell command or an array of command arguments."
        )),
    }
}

fn resolve_acp_run_id(
    state: &AppState,
    session: &companion_acp::AcpSessionSnapshot,
) -> Result<Option<String>> {
    if let Some(run_id) = session.run_id.clone().and_then(trim_optional) {
        return Ok(Some(run_id));
    }
    Ok(state
        .runs
        .get_session_run_link(&session.session_id)?
        .map(|link| link.run_id))
}

fn build_acp_session_type(session_id: &str) -> Option<String> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("acp/{normalized}"))
    }
}

fn map_acp_run_state(state: &str) -> &'static str {
    match state {
        "idle" => "idle",
        "running" => "running",
        "done" => "done",
        "cancelled" => "cancelled",
        _ => "failed",
    }
}

fn acp_summary_for_state(state: &str, created: bool) -> &'static str {
    match state {
        "idle" if created => "ACP session created",
        "idle" => "ACP session ready",
        "running" => "ACP session running",
        "done" => "ACP session completed",
        "cancelled" => "ACP session cancelled",
        _ => "ACP session failed",
    }
}

fn command_spec_value(command: &CommandSpec) -> Value {
    match command {
        CommandSpec::Shell(command) => Value::String(command.clone()),
        CommandSpec::Args(args) => Value::Array(args.iter().cloned().map(Value::String).collect()),
    }
}

fn json_value_string(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(Value::as_object)
        .and_then(|object| object_string(Some(object), key))
}

fn action_log_from_run(run: &RunRecord) -> Option<serde_json::Value> {
    if run.r#type != "exec" && run.r#type != "session" && run.r#type != "approval" {
        return None;
    }
    let meta = run.meta.as_ref();
    Some(json!({
        "runId": run.run_id,
        "timestamp": run.finished_at.unwrap_or(run.updated_at.max(run.created_at)),
        "actionName": meta.and_then(|value| object_string(Some(value), "toolName")).or_else(|| run.summary.clone()).unwrap_or_else(|| run.r#type.clone()),
        "source": run.source.clone().or_else(|| meta.and_then(|value| object_string(Some(value), "actionSource"))).unwrap_or_else(|| "remote".to_string()),
        "capability": meta.and_then(|value| object_string(Some(value), "capability")).unwrap_or_default(),
        "permissionId": meta.and_then(|value| object_string(Some(value), "permissionId")).unwrap_or_default(),
        "target": meta.and_then(|value| object_string(Some(value), "command")).or_else(|| meta.and_then(|value| object_string(Some(value), "toolPreview"))).unwrap_or_default(),
        "status": run.state,
        "detail": run.error.clone().unwrap_or_default(),
    }))
}

fn build_cron_automation_response(job: &Value) -> Value {
    let executor = job
        .get("executor")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if executor == Some("companion_acp") {
        json!({
            "executor": "companion_acp",
            "supported": false,
            "unsupportedReason": "rust_automation_executor_pending",
        })
    } else {
        json!({
            "executor": executor,
            "supported": true,
            "unsupportedReason": Value::Null,
        })
    }
}

fn workflow_status_from_run(run: &RunRecord) -> Value {
    let workflow = run
        .meta
        .as_ref()
        .and_then(|meta| meta.get("workflow"))
        .or_else(|| {
            run.meta
                .as_ref()
                .and_then(|meta| meta.get("automationSpec"))
                .and_then(|value| value.get("workflow"))
        });

    let Some(workflow) = workflow.and_then(Value::as_object) else {
        return Value::Null;
    };

    let template = workflow
        .get("template")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let state = workflow.get("state").and_then(Value::as_object);
    let steps = state
        .and_then(|value| value.get("steps"))
        .and_then(Value::as_array)
        .map(|items| {
            items.iter()
                .filter_map(|item| item.as_object())
                .map(|item| {
                    json!({
                        "id": item.get("id").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()),
                        "kind": item.get("kind").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()),
                        "state": item.get("state").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()),
                        "summary": item.get("summary").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "template": template,
        "terminalState": state.and_then(|value| value.get("terminalState")).cloned().unwrap_or(Value::Null),
        "currentStepId": state.and_then(|value| value.get("currentStepId")).cloned().unwrap_or(Value::Null),
        "steps": steps,
    })
}

fn count_active_workflow_runs(runs: &[companion_control::RunRecordView]) -> usize {
    runs.iter()
        .filter(|item| item.run.r#type == "cron")
        .filter(|item| {
            item.run
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "executionMode"))
                .as_deref()
                == Some("companion_acp")
        })
        .filter(|item| matches!(item.run.state.as_str(), "queued" | "running" | "retrying"))
        .filter(|item| {
            item.run
                .meta
                .as_ref()
                .and_then(|meta| meta.get("workflow"))
                .and_then(Value::as_object)
                .and_then(|workflow| workflow.get("template"))
                .and_then(Value::as_str)
                .is_some_and(|template| {
                    template == "research_synthesis" || template == "research_decision"
                })
        })
        .count()
}

fn build_recent_workflow_lifecycle_phases(runs: &[companion_control::RunRecordView]) -> Vec<Value> {
    runs.iter()
        .filter(|item| item.run.r#type == "cron")
        .filter(|item| {
            item.run
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "executionMode"))
                .as_deref()
                == Some("companion_acp")
        })
        .take(5)
        .map(|item| {
            let meta = item.run.meta.as_ref();
            json!({
                "runId": item.run.run_id,
                "taskId": meta.and_then(|value| object_string(Some(value), "taskId")).unwrap_or_default(),
                "taskName": meta.and_then(|value| object_string(Some(value), "taskName")).unwrap_or_default(),
                "taskState": meta.and_then(|value| value.get("taskState")).cloned().unwrap_or(Value::Null),
                "stepState": meta.and_then(|value| value.get("stepState")).cloned().unwrap_or(Value::Null),
                "workflow": meta.and_then(|value| value.get("workflow")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn build_recent_workflow_failures(runs: &[companion_control::RunRecordView]) -> Vec<Value> {
    runs.iter()
        .filter(|item| item.run.r#type == "cron")
        .filter(|item| item.run.state == "failed")
        .filter(|item| {
            item.run
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "executionMode"))
                .as_deref()
                == Some("companion_acp")
        })
        .take(5)
        .map(|item| {
            let meta = item.run.meta.as_ref();
            json!({
                "runId": item.run.run_id,
                "summary": item.run.summary,
                "error": item.run.error,
                "taskId": meta.and_then(|value| object_string(Some(value), "taskId")),
                "taskName": meta.and_then(|value| object_string(Some(value), "taskName")),
                "finishedAt": item.run.finished_at,
            })
        })
        .collect()
}

fn build_automation_outbox_summary(
    listed: &companion_automation::AutomationOutboxListResult,
) -> Value {
    json!({
        "depth": listed.total,
        "recent": listed.items.iter().take(5).map(|item| {
            json!({
                "id": item.id,
                "runId": item.run_id,
                "taskId": item.task_id,
                "taskName": item.task_name,
                "mode": item.mode,
                "createdAt": item.created_at,
            })
        }).collect::<Vec<_>>(),
    })
}

fn resolve_approval_session_tracking(
    body_meta: Option<&Map<String, Value>>,
    existing_approval: Option<&companion_control::ApprovalRecord>,
    run: Option<&RunRecord>,
) -> ApprovalTracking {
    let run_session_id = run
        .and_then(run_session_id)
        .or_else(|| approval_tracking_meta(body_meta, "sessionId"))
        .or_else(|| {
            existing_approval
                .and_then(|value| approval_tracking_meta(value.meta.as_ref(), "sessionId"))
        });
    let run_session_type = run
        .and_then(run_session_type)
        .or_else(|| approval_tracking_meta(body_meta, "sessionType"))
        .or_else(|| {
            existing_approval
                .and_then(|value| approval_tracking_meta(value.meta.as_ref(), "sessionType"))
        })
        .or_else(|| infer_session_type(run_session_id.as_deref().unwrap_or("")));
    ApprovalTracking {
        session_id: run_session_id,
        session_type: run_session_type,
    }
}

fn approval_tracking_meta(meta: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    object_string(meta, key).or_else(|| {
        meta.and_then(|value| value.get("tracking"))
            .and_then(Value::as_object)
            .and_then(|value| object_string(Some(value), key))
    })
}

fn run_session_id(run: &RunRecord) -> Option<String> {
    run.session_id.clone().or_else(|| {
        run.meta
            .as_ref()
            .and_then(|value| object_string(Some(value), "sessionId"))
    })
}

fn run_session_type(run: &RunRecord) -> Option<String> {
    run.session_type.clone().or_else(|| {
        run.meta
            .as_ref()
            .and_then(|value| object_string(Some(value), "sessionType"))
    })
}

fn infer_session_type(session_id: &str) -> Option<String> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return None;
    }
    if normalized.starts_with("chat:main") {
        return Some("chat/main".to_string());
    }
    if let Some(value) = normalized.strip_prefix("workflow:") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(format!("workflow/{trimmed}"));
        }
    }
    if let Some(value) = normalized.strip_prefix("automation:") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(format!("automation/{trimmed}"));
        }
    }
    if let Some(value) = normalized.strip_prefix("acp:") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(format!("acp/{trimmed}"));
        }
    }
    None
}

fn merge_run_meta(
    base: Option<Map<String, Value>>,
    extra: Option<Map<String, Value>>,
) -> Option<Map<String, Value>> {
    let mut merged = base.unwrap_or_default();
    if let Some(extra) = extra {
        for (key, value) in extra {
            merged.insert(key, value);
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn json_object(items: Vec<(&str, Option<Value>)>) -> Option<Map<String, Value>> {
    let mut object = Map::new();
    for (key, value) in items {
        if let Some(value) = value {
            object.insert(key.to_string(), value);
        }
    }
    if object.is_empty() {
        None
    } else {
        Some(object)
    }
}

fn value_to_object_map(value: Option<Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(map)) if !map.is_empty() => Some(map),
        _ => None,
    }
}

fn object_string(object: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    object
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn trim_optional(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn trim_or_generated(value: Option<String>) -> String {
    value
        .and_then(trim_optional)
        .unwrap_or_else(|| format!("approval-{}", now_millis()))
}

fn mask_sensitive_tail(value: &str, keep: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let chars = trimmed.chars().collect::<Vec<_>>();
    if chars.len() <= keep {
        return trimmed.to_string();
    }

    let suffix = chars[chars.len() - keep..].iter().collect::<String>();
    format!("...{suffix}")
}

fn truncate_text_for_error(value: &str) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        None
    } else if normalized.chars().count() <= 500 {
        Some(normalized.to_string())
    } else {
        Some(format!(
            "{}...[truncated]",
            normalized.chars().take(484).collect::<String>().trim_end()
        ))
    }
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

fn map_checkpoint_job_submit_error(error: anyhow::Error) -> Response {
    let message = error.to_string();
    match message.as_str() {
        "memory_checkpoint_jobs_unavailable" => {
            json_error(StatusCode::SERVICE_UNAVAILABLE, &message)
        }
        "checkpoint_job_invalid_request"
        | "checkpoint_job_generation_mismatch"
        | "checkpoint_job_step_invalid" => json_error(StatusCode::BAD_REQUEST, &message),
        _ => internal_error(error),
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
    use companion_automation::AutomationOutboxItem;
    use companion_checkpoint::{build_checkpoint_job_result, CheckpointJobRunner};
    use companion_config::CheckpointSyncConfig;
    use http_body_util::BodyExt;
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use tower::ServiceExt;

    fn test_config() -> CompanionConfig {
        let mut config = CompanionConfig::default();
        config.token = "secret-token".to_string();
        config
            .companion_capabilities
            .insert("local_command".to_string(), true);
        config
    }

    fn test_app() -> (Router, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let app = build_router(AppState::new_in(
            test_config(),
            Some(temp_dir.path().to_path_buf()),
        ));
        (app, temp_dir)
    }

    fn test_state_app() -> (AppState, Router, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new_in(test_config(), Some(temp_dir.path().to_path_buf()));
        let app = build_router(state.clone());
        (state, app, temp_dir)
    }

    fn make_shadow_envelope() -> Value {
        let latest_pointer = json!({
            "version": 1,
            "generation": "2026-03-13T00-00-00.000Z",
            "committedAt": 1700000005000_u64,
            "manifestKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/manifest.json",
        });
        let history = json!({
            "version": 1,
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "coverageDay": "2026-03-13",
            "committedAt": 1700000005000_u64,
            "manifestKey": latest_pointer["manifestKey"].clone(),
            "artifactCount": 2,
            "requiredArtifactCount": 2,
            "lastHistoryKey": "memory-checkpoints/history/2026-03-13T00-00-00.000Z.json",
        });
        let manifest = json!({
            "version": 1,
            "generatedAt": 1700000000000_u64,
            "committedAt": 1700000005000_u64,
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "latestPointerKey": "memory-checkpoints/latest.json",
            "overallHash": "overall-hash",
            "nodeCount": 1,
            "coreDocCount": 0,
            "dailyLogCount": 0,
            "structuredContextCount": 1,
            "artifacts": [
                {
                    "key": "context-nodes.json",
                    "label": "Context Snapshot",
                    "kind": "context_snapshot",
                    "updatedAt": 1700000000000_u64,
                    "checksum": "ctx-checksum",
                    "count": 1,
                    "bytes": 128,
                    "storageKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json",
                    "required": true,
                },
                {
                    "key": "memory-index.json",
                    "label": "memory-index.json",
                    "kind": "derived_meta",
                    "updatedAt": 1700000005000_u64,
                    "checksum": "memory-index-checksum",
                    "bytes": 32,
                    "storageKey": "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json",
                    "required": true,
                }
            ]
        });
        json!({
            "version": 1,
            "authority": "extension_primary",
            "generation": "2026-03-13T00-00-00.000Z",
            "previousGeneration": "2026-03-12T00-00-00.000Z",
            "committedAt": 1700000005000_u64,
            "latestPointer": latest_pointer,
            "latestPointerPayload": latest_pointer.to_string(),
            "history": history,
            "historyPayload": history.to_string(),
            "manifest": manifest,
            "manifestPayload": manifest.to_string(),
            "artifactPayloads": {
                "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json": "{\"nodes\":true}",
                "memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json": "[{\"id\":\"mem-1\"}]"
            }
        })
    }

    fn make_checkpoint_job_bundle() -> Value {
        let generation = "2026-03-12T08-00-00.000Z";
        let committed_at = 1_773_312_000_000_u64;
        json!({
            "generation": generation,
            "committedAt": committed_at,
            "coverageDay": "2026-03-12",
            "latestPointer": {
                "version": 1,
                "generation": generation,
                "committedAt": committed_at,
                "manifestKey": format!("memory-checkpoints/generations/{generation}/manifest.json"),
            },
            "latestPointerPayload": format!("{{\"version\":1,\"generation\":\"{generation}\"}}"),
            "history": {
                "version": 1,
                "generation": generation,
                "previousGeneration": Value::Null,
                "coverageDay": "2026-03-12",
                "committedAt": committed_at,
                "manifestKey": format!("memory-checkpoints/generations/{generation}/manifest.json"),
                "artifactCount": 0,
                "requiredArtifactCount": 0,
                "lastHistoryKey": format!("memory-checkpoints/generations/{generation}/history.json"),
            },
            "historyPayload": format!("{{\"version\":1,\"generation\":\"{generation}\"}}"),
            "manifest": {
                "version": 1,
                "generation": generation,
                "previousGeneration": Value::Null,
                "committedAt": committed_at,
                "generatedAt": committed_at,
                "artifacts": [],
            },
            "manifestPayload": format!("{{\"version\":1,\"generation\":\"{generation}\",\"artifacts\":[]}}"),
            "artifactPayloads": {},
            "localAckPlan": {
                "remoteStorageKeys": [],
                "generation": generation,
                "committedAt": committed_at,
            },
        })
    }

    fn persist_checkpoint_job_snapshot(temp_dir: &TempDir, bundle: &Value, state: &str) {
        let generation = bundle["generation"].as_str().unwrap();
        let snapshot = json!({
            "version": 1,
            "jobs": [
                {
                    "jobId": format!("checkpoint-{generation}"),
                    "generation": generation,
                    "state": state,
                    "stage": state,
                    "createdAt": 1_773_312_000_001_u64,
                    "updatedAt": 1_773_312_000_001_u64,
                    "startedAt": if state == "running" {
                        Some(1_773_312_000_002_u64)
                    } else {
                        None::<u64>
                    },
                    "finishedAt": Value::Null,
                    "attemptCount": 0,
                    "error": Value::Null,
                    "completedSteps": [],
                    "publishBundle": bundle,
                    "result": Value::Null,
                }
            ]
        });
        fs::write(
            temp_dir.path().join("checkpoint-jobs.json"),
            format!("{}\n", serde_json::to_string_pretty(&snapshot).unwrap()),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn healthz_requires_authorization() {
        let (app, _temp_dir) = test_app();
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
        let (app, _temp_dir) = test_app();
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
        let (app, _temp_dir) = test_app();
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
    async fn calendar_routes_require_calendar_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/calendar/calendars")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn reminder_routes_require_reminders_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/reminders/lists")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn contact_routes_require_contacts_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/contacts/groups")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn note_routes_require_notes_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/notes/folders")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn finder_routes_require_finder_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/finder/items")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn clipboard_routes_require_clipboard_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/clipboard/text")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn explorer_routes_require_explorer_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/explorer/items")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn process_routes_require_process_control_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/processes")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn screenshot_route_requires_screenshot_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/apps/screenshot/capture")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
    }

    #[tokio::test]
    async fn safari_routes_require_safari_capability() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/apps/safari/tabs")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            payload.get("code").and_then(|value| value.as_str()),
            Some("companion_capability_disabled")
        );
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
        let temp_dir = TempDir::new().unwrap();
        let app = build_router(AppState::new_in(
            config,
            Some(temp_dir.path().to_path_buf()),
        ));
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

    #[tokio::test]
    async fn mcp_tools_endpoint_reports_builtin_desktop_tool_by_platform() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/mcp/tools")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let tools = payload["tools"].as_array().unwrap();
        let builtin = tools.iter().find(|item| {
            item.get("server").and_then(Value::as_str) == Some(BUILTIN_DESKTOP_TOOL_SERVER)
                && item.get("name").and_then(Value::as_str) == Some(BUILTIN_DESKTOP_TOOL_NAME)
        });

        if cfg!(target_os = "windows") {
            assert!(
                builtin.is_some(),
                "windows should expose the built-in desktop tool"
            );
        } else {
            assert!(
                builtin.is_none(),
                "non-windows builds should not expose the desktop tool"
            );
        }
    }

    #[test]
    fn builtin_desktop_tool_schema_lists_desktop_actions() {
        let schema = builtin_desktop_tool_schema();
        let actions = schema["properties"]["action"]["enum"]
            .as_array()
            .expect("action enum should exist");
        let values = actions.iter().filter_map(Value::as_str).collect::<Vec<_>>();

        assert!(values.contains(&"filesystem.read_text"));
        assert!(values.contains(&"filesystem.write_text"));
        assert!(values.contains(&"window.list"));
        assert!(values.contains(&"window.activate"));
        assert!(values.contains(&"window.minimize"));
        assert!(values.contains(&"notification.show"));
        assert!(values.contains(&"registry.write_value"));
        assert!(values.contains(&"service.list"));
        assert!(values.contains(&"service.start"));
        assert!(values.contains(&"service.stop"));
        assert!(values.contains(&"service.restart"));
        assert!(values.contains(&"task.list"));
        assert!(values.contains(&"task.run"));
        assert!(values.contains(&"task.delete"));
        assert!(values.contains(&"admin_shell.run"));
    }

    #[tokio::test]
    async fn builtin_desktop_tool_call_respects_platform_gate() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/mcp/tools/call")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "server": BUILTIN_DESKTOP_TOOL_SERVER,
                            "tool": BUILTIN_DESKTOP_TOOL_NAME,
                            "arguments": {
                                "action": "clipboard.read_text"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));

        let error = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if cfg!(target_os = "windows") {
            assert!(
                error.contains("Clipboard access is disabled"),
                "windows should fail because the capability starts disabled"
            );
        } else {
            assert!(
                error.contains("only available on Windows"),
                "non-windows builds should report platform gating"
            );
        }
    }

    #[tokio::test]
    async fn media_normalize_route_keeps_png_payloads_unchanged() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media/normalize")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": "photo.png",
                            "mimeType": "image/png",
                            "bytesBase64": "cG5nLWJpbmFyeQ==",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["changed"].as_bool(), Some(false));
        assert_eq!(payload["mimeType"].as_str(), Some("image/png"));
        assert_eq!(
            payload["normalization"]["status"].as_str(),
            Some("unchanged")
        );
    }

    #[tokio::test]
    async fn media_ocr_route_returns_structured_status() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/media/ocr")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": "tiny.png",
                            "mimeType": "image/png",
                            "bytesBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let status = payload["status"].as_str().unwrap_or_default();
        assert!(matches!(status, "completed" | "skipped" | "failed"));
    }

    #[tokio::test]
    async fn memory_shadow_routes_ingest_and_report_status() {
        let (app, _temp_dir) = test_app();
        let ingest = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/memory/checkpoints/shadow")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(make_shadow_envelope().to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ingest.status(), StatusCode::OK);
        let ingest_bytes = ingest.into_body().collect().await.unwrap().to_bytes();
        let ingest_payload: serde_json::Value = serde_json::from_slice(&ingest_bytes).unwrap();
        assert_eq!(ingest_payload["ok"].as_bool(), Some(true));
        assert_eq!(
            ingest_payload["status"]["mirroredGeneration"].as_str(),
            Some("2026-03-13T00-00-00.000Z")
        );

        let status = app
            .oneshot(
                Request::builder()
                    .uri("/api/memory/checkpoints/shadow/status")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        let status_bytes = status.into_body().collect().await.unwrap().to_bytes();
        let status_payload: serde_json::Value = serde_json::from_slice(&status_bytes).unwrap();
        assert_eq!(
            status_payload["mirroredGeneration"].as_str(),
            Some("2026-03-13T00-00-00.000Z")
        );
        assert_eq!(status_payload["freshness"]["state"].as_str(), Some("fresh"));
    }

    #[tokio::test]
    async fn memory_shadow_ingest_rejects_non_authoritative_payloads() {
        let (app, _temp_dir) = test_app();
        let mut invalid = make_shadow_envelope();
        invalid["authority"] = Value::String("companion_shadow".to_string());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/memory/checkpoints/shadow")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("extension_primary"));
    }

    #[tokio::test]
    async fn memory_shadow_refresh_without_envelope_reports_empty_state() {
        let (app, _temp_dir) = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/memory/checkpoints/shadow/refresh")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["published"].as_bool(), Some(false));
        assert_eq!(payload["reason"].as_str(), Some("no_shadow_checkpoint"));
    }

    #[tokio::test]
    async fn checkpoint_job_routes_return_503_when_executor_is_unavailable() {
        let (app, _temp_dir) = test_app();
        let bundle = make_checkpoint_job_bundle();

        let submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/checkpoint-jobs")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "generation": bundle["generation"].clone(),
                            "publishBundle": bundle.clone(),
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submit.status(), StatusCode::SERVICE_UNAVAILABLE);
        let submit_bytes = submit.into_body().collect().await.unwrap().to_bytes();
        let submit_payload: serde_json::Value = serde_json::from_slice(&submit_bytes).unwrap();
        assert_eq!(
            submit_payload["error"].as_str(),
            Some("memory_checkpoint_jobs_unavailable")
        );

        let status = app
            .oneshot(
                Request::builder()
                    .uri("/api/checkpoint-jobs/checkpoint-2026-03-12T08-00-00.000Z/status")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn checkpoint_capability_enables_for_mainnet_without_kv_rpc() {
        let temp_dir = TempDir::new().unwrap();
        let mut config = test_config();
        config.checkpoint_sync = Some(CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1"
                .to_string(),
            kv_rpc: None,
        });
        let app = build_router(AppState::new_in(
            config,
            Some(temp_dir.path().to_path_buf()),
        ));

        let capabilities = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/capabilities")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let capabilities_bytes = capabilities.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&capabilities_bytes).unwrap();
        assert_eq!(
            payload["supportedFeatures"]["memoryCheckpointJobs"].as_bool(),
            Some(true)
        );
    }

    #[tokio::test]
    async fn checkpoint_capability_enables_with_supported_sync_config() {
        let temp_dir = TempDir::new().unwrap();
        let mut config = test_config();
        config.checkpoint_sync = Some(CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1"
                .to_string(),
            kv_rpc: Some("https://kv-rpc-galileo.0g.ai".to_string()),
        });
        let app = build_router(AppState::new_in(
            config,
            Some(temp_dir.path().to_path_buf()),
        ));

        let capabilities = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/capabilities")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let capabilities_bytes = capabilities.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&capabilities_bytes).unwrap();
        assert_eq!(
            payload["supportedFeatures"]["memoryCheckpointJobs"].as_bool(),
            Some(true)
        );
    }

    #[tokio::test]
    async fn system_diagnostics_reports_checkpoint_job_support_reason() {
        let temp_dir = TempDir::new().unwrap();
        let mut config = test_config();
        config.checkpoint_sync = Some(CheckpointSyncConfig {
            stream_id: "stream-a".to_string(),
            private_key: "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1"
                .to_string(),
            kv_rpc: None,
        });
        let app = build_router(AppState::new_in(
            config,
            Some(temp_dir.path().to_path_buf()),
        ));

        let diagnostics = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/diagnostics")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(diagnostics.status(), StatusCode::OK);
        let diagnostics_bytes = diagnostics.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&diagnostics_bytes).unwrap();
        assert_eq!(
            payload["checkpointSync"]["jobSupportStatus"].as_str(),
            Some("ready")
        );
        assert_eq!(
            payload["checkpointSync"]["jobSupportReason"].as_str(),
            Some("ready")
        );
        assert_eq!(
            payload["checkpointSync"]["jobsAvailable"].as_bool(),
            Some(true)
        );
        assert!(!payload["doctor"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["code"].as_str() == Some("checkpoint_jobs_unavailable")));
    }

    #[tokio::test]
    async fn checkpoint_sync_config_route_updates_runner_availability() {
        let temp_dir = TempDir::new().unwrap();
        let app = build_router(AppState::new_in(
            test_config(),
            Some(temp_dir.path().to_path_buf()),
        ));

        let update = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/checkpoint-sync/config")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "checkpointSync": {
                                "streamId": "stream-a",
                                "privateKey": "0x59c6995e998f97a5a0044966f094538e9f5cb7d9f86f1c3a2d0a0f6f5d74d6a1",
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(update.status(), StatusCode::OK);
        let update_bytes = update.into_body().collect().await.unwrap().to_bytes();
        let update_payload: serde_json::Value = serde_json::from_slice(&update_bytes).unwrap();
        assert_eq!(
            update_payload["checkpointSync"]["configured"].as_bool(),
            Some(true)
        );
        assert_eq!(
            update_payload["checkpointSync"]["jobsAvailable"].as_bool(),
            Some(true)
        );
        assert_eq!(
            update_payload["checkpointSync"]["jobSupportReason"].as_str(),
            Some("ready")
        );

        let capabilities = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/system/capabilities")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let capabilities_bytes = capabilities.into_body().collect().await.unwrap().to_bytes();
        let capabilities_payload: serde_json::Value =
            serde_json::from_slice(&capabilities_bytes).unwrap();
        assert_eq!(
            capabilities_payload["supportedFeatures"]["memoryCheckpointJobs"].as_bool(),
            Some(true)
        );

        let clear = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/checkpoint-sync/config")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "checkpointSync": serde_json::Value::Null,
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(clear.status(), StatusCode::OK);
        let clear_bytes = clear.into_body().collect().await.unwrap().to_bytes();
        let clear_payload: serde_json::Value = serde_json::from_slice(&clear_bytes).unwrap();
        assert_eq!(
            clear_payload["checkpointSync"]["configured"].as_bool(),
            Some(false)
        );
        assert_eq!(
            clear_payload["checkpointSync"]["jobsAvailable"].as_bool(),
            Some(false)
        );
        assert_eq!(
            clear_payload["checkpointSync"]["jobSupportStatus"].as_str(),
            Some("disabled")
        );
    }

    #[tokio::test]
    async fn app_state_resumes_persisted_checkpoint_jobs() {
        let temp_dir = TempDir::new().unwrap();
        let bundle = make_checkpoint_job_bundle();
        persist_checkpoint_job_snapshot(&temp_dir, &bundle, "queued");
        let resumed_job_ids = Arc::new(Mutex::new(Vec::<String>::new()));
        let runner = CheckpointJobRunner::with_executor_in(temp_dir.path().to_path_buf(), {
            let resumed_job_ids = resumed_job_ids.clone();
            move |job| {
                let resumed_job_ids = resumed_job_ids.clone();
                async move {
                    resumed_job_ids.lock().unwrap().push(job.job_id.clone());
                    Ok(build_checkpoint_job_result(
                        &job.publish_bundle,
                        "verified",
                        None,
                    ))
                }
            }
        });
        let state = AppState::new_in(test_config(), Some(temp_dir.path().to_path_buf()));
        state.set_checkpoint_jobs_for_tests(runner.clone()).await;

        let resumed = state.resume_pending_checkpoint_jobs().await.unwrap();
        let job_id = format!("checkpoint-{}", bundle["generation"].as_str().unwrap());

        assert_eq!(resumed.len(), 1);
        assert_eq!(
            resumed_job_ids.lock().unwrap().as_slice(),
            &[job_id.clone()]
        );
        let status = runner.get_status(&job_id).await.unwrap().unwrap();
        assert_eq!(status.state, "completed");
        assert_eq!(status.result.unwrap().verification_status, "verified");
    }

    #[tokio::test]
    async fn checkpoint_job_routes_submit_and_report_status_with_executor() {
        let temp_dir = TempDir::new().unwrap();
        let runner = CheckpointJobRunner::with_executor_in(
            temp_dir.path().to_path_buf(),
            |job| async move {
                Ok(build_checkpoint_job_result(
                    &job.publish_bundle,
                    "verified",
                    None,
                ))
            },
        );
        let state = AppState::new_in(test_config(), Some(temp_dir.path().to_path_buf()));
        state.set_checkpoint_jobs_for_tests(runner).await;
        let app = build_router(state);

        let capabilities = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/system/capabilities")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities.status(), StatusCode::OK);
        let capabilities_bytes = capabilities.into_body().collect().await.unwrap().to_bytes();
        let capabilities_payload: serde_json::Value =
            serde_json::from_slice(&capabilities_bytes).unwrap();
        assert_eq!(
            capabilities_payload["supportedFeatures"]["memoryCheckpointJobs"].as_bool(),
            Some(true)
        );

        let bundle = make_checkpoint_job_bundle();
        let submit = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/checkpoint-jobs")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "generation": bundle["generation"].clone(),
                            "publishBundle": bundle.clone(),
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(submit.status(), StatusCode::OK);
        let submit_bytes = submit.into_body().collect().await.unwrap().to_bytes();
        let submit_payload: serde_json::Value = serde_json::from_slice(&submit_bytes).unwrap();
        let job_id = submit_payload["job"]["jobId"].as_str().unwrap().to_string();

        tokio::time::sleep(Duration::from_millis(25)).await;

        let status = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/checkpoint-jobs/{job_id}/status"))
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);
        let status_bytes = status.into_body().collect().await.unwrap().to_bytes();
        let status_payload: serde_json::Value = serde_json::from_slice(&status_bytes).unwrap();
        assert_eq!(status_payload["state"].as_str(), Some("completed"));
        assert_eq!(
            status_payload["result"]["verificationStatus"].as_str(),
            Some("verified")
        );
        assert_eq!(
            status_payload["result"]["localAckPlan"]["generation"].as_str(),
            Some("2026-03-12T08-00-00.000Z")
        );
    }

    #[tokio::test]
    async fn cron_job_routes_store_jobs_and_mark_companion_executor_pending() {
        let (app, _temp_dir) = test_app();

        let upsert_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cron/jobs")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "id": "task-1",
                            "name": "Research workflow",
                            "executor": "companion_acp",
                            "workflow": {
                                "template": "research_synthesis"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(upsert_response.status(), StatusCode::OK);
        let upsert_bytes = upsert_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let upsert_payload: serde_json::Value = serde_json::from_slice(&upsert_bytes).unwrap();
        assert_eq!(upsert_payload["ok"].as_bool(), Some(true));
        assert_eq!(upsert_payload["id"].as_str(), Some("task-1"));
        assert_eq!(
            upsert_payload["automation"]["unsupportedReason"].as_str(),
            Some("rust_automation_executor_pending")
        );

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/cron/jobs")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_bytes = list_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let list_payload: serde_json::Value = serde_json::from_slice(&list_bytes).unwrap();
        assert_eq!(list_payload["jobs"].as_array().unwrap().len(), 1);

        let delete_response = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/cron/jobs/task-1")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);
        let delete_bytes = delete_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let delete_payload: serde_json::Value = serde_json::from_slice(&delete_bytes).unwrap();
        assert_eq!(delete_payload["removed"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn cron_pending_routes_support_pending_ids_and_task_ids() {
        let (state, app, _temp_dir) = test_state_app();
        let first = state.cron.add_pending_run("task-occurrence").unwrap();
        let second = state.cron.add_pending_run("task-occurrence").unwrap();
        let third = state.cron.add_pending_run("task-other").unwrap();

        let listed_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/cron/pending")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed_response.status(), StatusCode::OK);
        let listed_bytes = listed_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let listed_payload: serde_json::Value = serde_json::from_slice(&listed_bytes).unwrap();
        assert_eq!(listed_payload["pending"].as_array().unwrap().len(), 3);

        let ack_first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cron/pending/ack")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "pendingIds": [first.pending_id, third.pending_id] })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ack_first.status(), StatusCode::OK);
        let ack_first_bytes = ack_first.into_body().collect().await.unwrap().to_bytes();
        let ack_first_payload: serde_json::Value =
            serde_json::from_slice(&ack_first_bytes).unwrap();
        assert_eq!(ack_first_payload["acked"].as_u64(), Some(2));

        let ack_second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/cron/pending/ack")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "taskIds": ["task-occurrence"] }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ack_second.status(), StatusCode::OK);
        let ack_second_bytes = ack_second.into_body().collect().await.unwrap().to_bytes();
        let ack_second_payload: serde_json::Value =
            serde_json::from_slice(&ack_second_bytes).unwrap();
        assert_eq!(ack_second_payload["acked"].as_u64(), Some(1));

        let remaining = state.cron.list_pending_runs().unwrap();
        assert!(remaining.is_empty());
        assert_ne!(first.pending_id, second.pending_id);
    }

    #[tokio::test]
    async fn automation_outbox_routes_list_and_ack_items() {
        let (state, app, _temp_dir) = test_state_app();
        state
            .automation_outbox
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
        state
            .automation_outbox
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

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/automation/outbox?limit=10&offset=0")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_bytes = list_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let list_payload: serde_json::Value = serde_json::from_slice(&list_bytes).unwrap();
        assert_eq!(list_payload["total"].as_u64(), Some(2));
        assert_eq!(list_payload["items"][0]["id"].as_str(), Some("outbox-2"));

        let ack_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/automation/outbox/ack")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "ids": ["outbox-2"] }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ack_response.status(), StatusCode::OK);
        let ack_bytes = ack_response.into_body().collect().await.unwrap().to_bytes();
        let ack_payload: serde_json::Value = serde_json::from_slice(&ack_bytes).unwrap();
        assert_eq!(ack_payload["acked"].as_u64(), Some(1));
    }

    #[tokio::test]
    async fn workflow_status_route_reads_workflow_from_run_meta() {
        let (state, app, _temp_dir) = test_state_app();
        state
            .runs
            .create_run(CreateRunInput {
                run_id: Some("workflow-run-1".to_string()),
                run_type: Some("cron".to_string()),
                state: Some("running".to_string()),
                meta: json_object(vec![
                    ("executionMode", Some(Value::String("companion_acp".to_string()))),
                    (
                        "workflow",
                        Some(serde_json::json!({
                            "template": "research_synthesis",
                            "state": {
                                "terminalState": Value::Null,
                                "currentStepId": "research",
                                "steps": [
                                    { "id": "plan", "kind": "plan", "state": "done", "summary": "Plan ready." },
                                    { "id": "research", "kind": "research", "state": "running", "summary": Value::Null }
                                ]
                            }
                        })),
                    ),
                ]),
                ..CreateRunInput::default()
            })
            .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/workflow/status?runId=workflow-run-1")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["runId"].as_str(), Some("workflow-run-1"));
        assert_eq!(payload["state"].as_str(), Some("running"));
        assert_eq!(
            payload["workflow"]["template"].as_str(),
            Some("research_synthesis")
        );
        assert_eq!(
            payload["workflow"]["currentStepId"].as_str(),
            Some("research")
        );
        assert_eq!(payload["workflow"]["steps"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn browser_routes_sync_records_and_feed_diagnostics() {
        let (app, _temp_dir) = test_app();

        let session_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/sessions/sync")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "session": {
                                "sessionId": "browser-session-1",
                                "state": "ready",
                                "createdAt": 10,
                                "updatedAt": 11,
                                "profileId": "default",
                                "primaryTargetId": "target-1"
                            },
                            "targets": [{
                                "targetId": "target-1",
                                "url": "https://example.com",
                                "title": "Example",
                                "active": true,
                                "attached": true
                            }],
                            "link": {
                                "runId": "run-browser-1",
                                "conversationId": "conv-browser-1",
                                "sourceToolName": "browser_navigate",
                                "sourceToolCallId": "tool-call-browser-1",
                                "approvalRequestId": "approval-browser-1"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(session_response.status(), StatusCode::OK);

        let action_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/actions/sync")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "action": {
                                "actionId": "browser-action-1",
                                "sessionId": "browser-session-1",
                                "targetId": "target-1",
                                "kind": "navigate",
                                "status": "completed",
                                "startedAt": 20,
                                "finishedAt": 21,
                                "inputSummary": "navigate",
                                "resultSummary": "done"
                            },
                            "link": {
                                "runId": "run-browser-1",
                                "conversationId": "conv-browser-1",
                                "sourceToolName": "browser_navigate",
                                "sourceToolCallId": "tool-call-browser-1",
                                "approvalRequestId": "approval-browser-1"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(action_response.status(), StatusCode::OK);

        let artifact_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/artifacts/sync")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "artifact": {
                                "artifactId": "browser-artifact-1",
                                "sessionId": "browser-session-1",
                                "targetId": "target-1",
                                "kind": "screenshot",
                                "mimeType": "image/png",
                                "byteLength": 128,
                                "pathOrKey": "browser/browser-artifact-1.png"
                            },
                            "actionId": "browser-action-1"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(artifact_response.status(), StatusCode::OK);

        let sessions_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/sessions?runId=run-browser-1")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sessions_response.status(), StatusCode::OK);
        let sessions_bytes = sessions_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let sessions_payload: serde_json::Value = serde_json::from_slice(&sessions_bytes).unwrap();
        assert_eq!(sessions_payload["total"].as_u64(), Some(1));
        assert_eq!(
            sessions_payload["sessions"][0]["link"]["sourceToolCallId"].as_str(),
            Some("tool-call-browser-1")
        );

        let diagnostics_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/browser/diagnostics")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(diagnostics_response.status(), StatusCode::OK);
        let diagnostics_bytes = diagnostics_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let diagnostics_payload: serde_json::Value =
            serde_json::from_slice(&diagnostics_bytes).unwrap();
        assert_eq!(diagnostics_payload["sessions"]["linked"].as_u64(), Some(1));
        assert_eq!(diagnostics_payload["actions"]["linked"].as_u64(), Some(1));
        assert_eq!(
            diagnostics_payload["operator"]["routes"]["drilldown"].as_str(),
            Some("/api/browser/drilldown")
        );

        let system_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/diagnostics")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(system_response.status(), StatusCode::OK);
        let system_bytes = system_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let system_payload: serde_json::Value = serde_json::from_slice(&system_bytes).unwrap();
        assert_eq!(system_payload["browser"]["loaded"].as_bool(), Some(true));
        assert_eq!(
            system_payload["doctor"]["summary"]["browserLoaded"].as_bool(),
            Some(true)
        );
    }

    #[tokio::test]
    async fn browser_drilldown_endpoint_prefers_source_tool_call_filter() {
        let (app, _temp_dir) = test_app();

        for request in [
            serde_json::json!({
                "method": "POST",
                "uri": "/api/browser/sessions/sync",
                "body": {
                    "session": {
                        "sessionId": "browser-session-drilldown-1",
                        "state": "ready"
                    },
                    "link": {
                        "runId": "run-browser-drilldown-1",
                        "conversationId": "conv-browser-drilldown-1",
                        "sourceToolName": "browser_navigate",
                        "sourceToolCallId": "tool-call-browser-drilldown-1",
                        "approvalRequestId": "approval-browser-drilldown-1"
                    }
                }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/api/browser/actions/sync",
                "body": {
                    "action": {
                        "actionId": "browser-action-drilldown-1",
                        "sessionId": "browser-session-drilldown-1",
                        "kind": "click",
                        "status": "completed",
                        "resultSummary": "clicked checkout button"
                    },
                    "link": {
                        "runId": "run-browser-drilldown-1",
                        "conversationId": "conv-browser-drilldown-1",
                        "sourceToolName": "browser_click",
                        "sourceToolCallId": "tool-call-browser-drilldown-1",
                        "approvalRequestId": "approval-browser-drilldown-1"
                    }
                }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/api/browser/artifacts/sync",
                "body": {
                    "artifact": {
                        "artifactId": "browser-artifact-drilldown-1",
                        "sessionId": "browser-session-drilldown-1",
                        "kind": "screenshot",
                        "mimeType": "image/png",
                        "byteLength": 64,
                        "pathOrKey": "browser/browser-artifact-drilldown-1.png"
                    },
                    "actionId": "browser-action-drilldown-1"
                }
            }),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(request["method"].as_str().unwrap())
                        .uri(request["uri"].as_str().unwrap())
                        .header("authorization", "Bearer secret-token")
                        .header("content-type", "application/json")
                        .body(Body::from(request["body"].to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let drilldown_response = app
            .oneshot(
                Request::builder()
                    .uri(
                        "/api/browser/drilldown?runId=run-browser-drilldown-1&conversationId=conv-browser-drilldown-1&sourceToolName=browser_click&sourceToolCallId=tool-call-browser-drilldown-1&approvalRequestId=approval-browser-drilldown-1&sessionId=browser-session-drilldown-1&actionId=browser-action-drilldown-1&eventWindow=tail&eventLimit=2",
                    )
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(drilldown_response.status(), StatusCode::OK);
        let drilldown_bytes = drilldown_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let drilldown_payload: serde_json::Value =
            serde_json::from_slice(&drilldown_bytes).unwrap();
        assert_eq!(drilldown_payload["sessions"]["total"].as_u64(), Some(1));
        assert_eq!(drilldown_payload["actions"]["total"].as_u64(), Some(1));
        assert_eq!(drilldown_payload["artifacts"]["total"].as_u64(), Some(1));
        assert!(drilldown_payload["filters"].get("sourceToolName").is_none());
        assert_eq!(
            drilldown_payload["filters"]["sourceToolCallId"].as_str(),
            Some("tool-call-browser-drilldown-1")
        );
        assert_eq!(
            drilldown_payload["events"]["events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn runtime_exec_is_mirrored_into_run_ledger() {
        let (app, _temp_dir) = test_app();
        let command = if cfg!(windows) {
            "echo ledger"
        } else {
            "printf ledger"
        };

        let exec_response = app
            .clone()
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
        assert_eq!(exec_response.status(), StatusCode::OK);

        let runs_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/runtime/runs?type=exec&limit=10")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(runs_response.status(), StatusCode::OK);
        let bytes = runs_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let runs = payload["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["type"].as_str(), Some("exec"));
        assert_eq!(runs[0]["state"].as_str(), Some("done"));
        assert_eq!(
            runs[0]["meta"]["capability"].as_str(),
            Some("local_command")
        );
    }

    #[tokio::test]
    async fn approval_lifecycle_updates_run_and_diagnostics() {
        let (app, _temp_dir) = test_app();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/runtime/approvals")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "requestId": "approval-1",
                            "conversationId": "conv-approval",
                            "toolName": "Read",
                            "toolPreview": "Read /tmp/one.txt",
                            "riskLevel": "medium",
                            "channels": ["sidepanel"],
                            "meta": {
                                "sessionId": "chat:main:conv-approval",
                                "toolCallId": "call-1"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::CREATED);
        let created_bytes = create_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let created_payload: serde_json::Value = serde_json::from_slice(&created_bytes).unwrap();
        let approval_run_id = created_payload["meta"]["runId"]
            .as_str()
            .unwrap()
            .to_string();

        let pending_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/runtime/approvals/pending")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(pending_response.status(), StatusCode::OK);
        let pending_bytes = pending_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let pending_payload: serde_json::Value = serde_json::from_slice(&pending_bytes).unwrap();
        assert_eq!(pending_payload["approvals"].as_array().unwrap().len(), 1);

        let resolve_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/runtime/approvals/approval-1/resolve")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "resolution": "approved",
                            "resolvedBy": "sidepanel"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resolve_response.status(), StatusCode::OK);

        let run_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/runtime/runs/{approval_run_id}"))
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(run_response.status(), StatusCode::OK);
        let run_bytes = run_response.into_body().collect().await.unwrap().to_bytes();
        let run_payload: serde_json::Value = serde_json::from_slice(&run_bytes).unwrap();
        assert_eq!(run_payload["run"]["state"].as_str(), Some("done"));
        assert_eq!(
            run_payload["run"]["meta"]["approvalStatus"].as_str(),
            Some("approved")
        );
        assert_eq!(
            run_payload["run"]["sessionType"].as_str(),
            Some("chat/main")
        );

        let diagnostics_response = app
            .oneshot(
                Request::builder()
                    .uri("/api/system/diagnostics")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(diagnostics_response.status(), StatusCode::OK);
        let diagnostics_bytes = diagnostics_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let diagnostics_payload: serde_json::Value =
            serde_json::from_slice(&diagnostics_bytes).unwrap();
        assert!(diagnostics_payload["approvals"]["pending"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(diagnostics_payload["doctor"]["status"].as_str(), Some("ok"));
        assert_eq!(
            diagnostics_payload["doctor"]["summary"]["pendingApprovals"].as_u64(),
            Some(0)
        );
    }

    #[tokio::test]
    async fn acp_session_prompt_updates_run_ledger_and_diagnostics() {
        let (state, app, _temp_dir) = test_state_app();
        spawn_acp_run_sync(state.clone());
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/acp/sessions")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "agentType": "raw",
                            "cwd": cwd,
                            "command": [
                                "node",
                                "-e",
                                "process.stdin.on('data', () => { console.log(JSON.stringify({ type: 'message_stop' })); process.exit(0); })"
                            ],
                            "timeoutMs": 5_000,
                            "origin": "code_agent",
                            "inputProvenance": {
                                "kind": "inter_agent",
                                "sourceChannel": "code_agent",
                                "conversationId": "conv-acp-ledger",
                                "originSessionId": "code-agent-session-1",
                                "metaOnly": true
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_bytes = create_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let created: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        let run_id = created["runId"].as_str().unwrap().to_string();
        assert_eq!(created["origin"].as_str(), Some("code_agent"));

        let diagnostics_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/system/diagnostics")
                    .header("authorization", "Bearer secret-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(diagnostics_response.status(), StatusCode::OK);
        let diagnostics_bytes = diagnostics_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let diagnostics_payload: serde_json::Value =
            serde_json::from_slice(&diagnostics_bytes).unwrap();
        assert_eq!(
            diagnostics_payload["acp"]["totalSessions"].as_u64(),
            Some(1)
        );
        assert_eq!(diagnostics_payload["acp"]["idleSessions"].as_u64(), Some(1));

        let prompt_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/acp/sessions/{session_id}/prompt"))
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "prompt": "hello",
                            "inputProvenance": {
                                "kind": "inter_agent",
                                "sourceChannel": "code_agent",
                                "conversationId": "conv-acp-ledger",
                                "originSessionId": "code-agent-session-1",
                                "metaOnly": true
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(prompt_response.status(), StatusCode::OK);
        let prompt_bytes = prompt_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let prompt_payload: serde_json::Value = serde_json::from_slice(&prompt_bytes).unwrap();
        assert!(prompt_payload["turnId"].as_str().is_some());

        let deadline = Instant::now() + Duration::from_secs(8);
        let run = loop {
            let run = state.runs.get_run_record(&run_id).unwrap();
            if let Some(run) = run {
                if matches!(run.state.as_str(), "done" | "failed") {
                    break run;
                }
            }
            assert!(Instant::now() < deadline);
            sleep(Duration::from_millis(50)).await;
        };

        assert_eq!(run.r#type, "acp");
        assert_eq!(run.state, "done");
        assert_eq!(run.session_id.as_deref(), Some(session_id.as_str()));
        assert_eq!(
            run.session_type.as_deref(),
            Some(format!("acp/{session_id}").as_str())
        );
        assert_eq!(
            run.meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "origin")),
            Some("code_agent".to_string())
        );
        assert_eq!(
            run.meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "conversationId")),
            Some("conv-acp-ledger".to_string())
        );
        assert!(run
            .meta
            .as_ref()
            .and_then(|meta| meta.get("inputProvenance"))
            .is_some());
        state.request_shutdown();
    }

    #[tokio::test]
    async fn acp_permission_wait_creates_approval_and_marks_run_waiting() {
        let (state, app, _temp_dir) = test_state_app();
        spawn_acp_run_sync(state.clone());
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/acp/sessions")
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "agentType": "raw",
                            "cwd": cwd,
                            "command": [
                                "node",
                                "-e",
                                "process.stderr.write('Requested permissions were not granted yet.\\n'); setInterval(() => {}, 1000)"
                            ],
                            "timeoutMs": 5_000
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_bytes = create_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let created: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        let run_id = created["runId"].as_str().unwrap().to_string();

        let prompt_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/acp/sessions/{session_id}/prompt"))
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "prompt": "inspect the workspace",
                            "inputProvenance": {
                                "kind": "remote_user",
                                "sourceChannel": "telegram",
                                "conversationId": "conv-acp-approval",
                                "remoteActorId": "tg:77"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(prompt_response.status(), StatusCode::OK);

        let approval_deadline = Instant::now() + Duration::from_secs(8);
        let approval = loop {
            let approvals = state.approvals.list_pending_approvals().unwrap();
            if let Some(approval) = approvals.into_iter().find(|item| {
                item.meta
                    .as_ref()
                    .and_then(|meta| object_string(Some(meta), "runId"))
                    .as_deref()
                    == Some(run_id.as_str())
            }) {
                break approval;
            }
            assert!(Instant::now() < approval_deadline);
            sleep(Duration::from_millis(50)).await;
        };

        assert_eq!(approval.status, "pending");
        assert_eq!(
            approval
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "sessionId")),
            Some(session_id.clone())
        );
        assert_eq!(
            approval
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "sessionType")),
            Some(format!("acp/{session_id}"))
        );
        assert_eq!(
            approval
                .meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "conversationId")),
            Some("conv-acp-approval".to_string())
        );

        let run_deadline = Instant::now() + Duration::from_secs(8);
        let run = loop {
            let run = state.runs.get_run_record(&run_id).unwrap();
            if let Some(run) = run {
                if run.state == "waiting_approval" {
                    break run;
                }
            }
            assert!(Instant::now() < run_deadline);
            sleep(Duration::from_millis(50)).await;
        };

        assert_eq!(run.state, "waiting_approval");
        assert_eq!(
            run.session_type.as_deref(),
            Some(format!("acp/{session_id}").as_str())
        );
        assert_eq!(
            run.meta
                .as_ref()
                .and_then(|meta| object_string(Some(meta), "approvalStatus")),
            Some("pending".to_string())
        );

        let cancel_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/acp/sessions/{session_id}/cancel"))
                    .header("authorization", "Bearer secret-token")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancel_response.status(), StatusCode::OK);

        let cancelled_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let run = state.runs.get_run_record(&run_id).unwrap().unwrap();
            if run.state == "cancelled" {
                break;
            }
            assert!(Instant::now() < cancelled_deadline);
            sleep(Duration::from_millis(50)).await;
        }
        state.request_shutdown();
    }
}
