use anyhow::{anyhow, bail, Context, Result};
use companion_config::{get_config_dir, is_path_within_roots};
use companion_shared::PermissionPolicy;
use rand::RngCore;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MAX_OUTPUT_CHARS: usize = 200_000;
const DEFAULT_SESSION_LIST_LIMIT: usize = 50;
const MAX_SESSION_LIST_LIMIT: usize = 500;
const DEFAULT_LOG_SLICE_LIMIT: usize = 4_000;
const DEFAULT_EVENT_LIST_LIMIT: usize = 50;
const MAX_EVENT_LIST_LIMIT: usize = 500;
const DEFAULT_SESSION_TTL_MS: u64 = 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_COUNT: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("{0}")]
    InvalidRequest(String),
    #[error("{0}")]
    PermissionPolicyViolation(String),
    #[error("{0}")]
    SessionNotFound(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub command: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub ok: bool,
    pub session_id: String,
    pub status: String,
    pub command: String,
    pub cwd: String,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListItem {
    pub session_id: String,
    pub status: String,
    pub command: String,
    pub cwd: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListResult {
    pub sessions: Vec<SessionListItem>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSlice {
    pub output: String,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub next_offset: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogResult {
    pub ok: bool,
    pub session_id: String,
    pub status: String,
    pub stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<LogSlice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<LogSlice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub ok: bool,
    pub written: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendKeysResult {
    pub ok: bool,
    pub action: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub cursor: u64,
    pub r#type: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub timed_out: bool,
    pub exit_code: i32,
    pub started_at: u64,
    pub finished_at: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsResult {
    pub ok: bool,
    pub events: Vec<SessionEvent>,
    pub next_cursor: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub env: Option<HashMap<String, String>>,
    pub permission_policy: PermissionPolicy,
}

#[derive(Debug, Clone)]
pub struct SessionStartRequest {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
    pub env: Option<HashMap<String, String>>,
    pub permission_policy: PermissionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatusFilter {
    Running,
    Exited,
}

#[derive(Debug, Clone)]
pub struct SessionListQuery {
    pub status: Option<SessionStatusFilter>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum LogStream {
    Stdout,
    Stderr,
    Both,
}

#[derive(Debug, Clone)]
pub struct SessionLogQuery {
    pub stream: LogStream,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct SessionEventsQuery {
    pub after: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RuntimeManager {
    inner: Arc<RuntimeInner>,
}

#[derive(Debug)]
struct RuntimeInner {
    sessions: RwLock<HashMap<String, Arc<SessionHandle>>>,
    session_events: RwLock<Vec<SessionEvent>>,
    next_event_cursor: AtomicU64,
    session_ttl_ms: u64,
    max_session_count: usize,
}

#[derive(Debug)]
struct SessionHandle {
    child: Mutex<Child>,
    state: Mutex<SessionState>,
}

#[derive(Debug)]
struct SessionState {
    id: String,
    command: String,
    cwd: String,
    timeout_ms: u64,
    status: String,
    stdout: String,
    stderr: String,
    timed_out: bool,
    exit_code: Option<i32>,
    started_at: u64,
    finished_at: Option<u64>,
}

#[derive(Debug)]
struct SpawnedProcess {
    child: Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
}

impl RuntimeManager {
    pub fn new() -> Self {
        let session_ttl_ms = read_u64_env("TRAPEZOHE_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS);
        let max_session_count = read_usize_env("TRAPEZOHE_MAX_SESSIONS", DEFAULT_MAX_SESSION_COUNT);
        Self {
            inner: Arc::new(RuntimeInner {
                sessions: RwLock::new(HashMap::new()),
                session_events: RwLock::new(Vec::new()),
                next_event_cursor: AtomicU64::new(1),
                session_ttl_ms,
                max_session_count,
            }),
        }
    }

    pub async fn run_command(&self, request: ExecRequest) -> Result<CommandResult, RuntimeError> {
        validate_command(&request.command)?;
        let cwd = resolve_cwd(request.cwd.as_deref(), &request.permission_policy)
            .await
            .map_err(runtime_error_from_anyhow)?;
        enforce_command_policy(&request.command, &cwd, &request.permission_policy)?;
        let timeout_ms = clamp_timeout(request.timeout_ms);
        let started = Instant::now();
        let mut process = spawn_shell_process(&request.command, &cwd, request.env.clone())
            .await
            .map_err(runtime_error_from_anyhow)?;
        let stdout_handle = collect_stdout_stream(process.stdout.take());
        let stderr_handle = collect_stderr_stream(process.stderr.take());

        let exit_status = wait_with_timeout(&mut process.child, timeout_ms)
            .await
            .map_err(runtime_error_from_anyhow)?;
        let stdout = stdout_handle.await.unwrap_or_default();
        let stderr = stderr_handle.await.unwrap_or_default();
        let duration_ms = started.elapsed().as_millis() as u64;

        Ok(CommandResult {
            ok: !exit_status.timed_out && exit_status.exit_code == 0,
            exit_code: exit_status.exit_code,
            stdout,
            stderr,
            timed_out: exit_status.timed_out,
            duration_ms,
            command: request.command,
            cwd: cwd.to_string_lossy().to_string(),
        })
    }

    pub async fn start_session(
        &self,
        request: SessionStartRequest,
    ) -> Result<SessionSnapshot, RuntimeError> {
        validate_command(&request.command)?;
        let cwd = resolve_cwd(request.cwd.as_deref(), &request.permission_policy)
            .await
            .map_err(runtime_error_from_anyhow)?;
        enforce_command_policy(&request.command, &cwd, &request.permission_policy)?;
        self.prune_sessions().await;
        let timeout_ms = clamp_timeout(request.timeout_ms);
        let mut process = spawn_shell_process(&request.command, &cwd, request.env.clone())
            .await
            .map_err(runtime_error_from_anyhow)?;
        let session_id = generate_session_id();
        let state = SessionState {
            id: session_id.clone(),
            command: request.command.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            timeout_ms,
            status: "running".to_string(),
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            exit_code: None,
            started_at: now_millis(),
            finished_at: None,
        };
        let handle = Arc::new(SessionHandle {
            child: Mutex::new(process.child),
            state: Mutex::new(state),
        });

        if let Some(stdout) = process.stdout.take() {
            spawn_reader(stdout, handle.clone(), StreamKind::Stdout);
        }
        if let Some(stderr) = process.stderr.take() {
            spawn_reader(stderr, handle.clone(), StreamKind::Stderr);
        }

        self.inner
            .sessions
            .write()
            .await
            .insert(session_id.clone(), handle.clone());

        spawn_exit_watchdog(self.inner.clone(), handle.clone());
        Ok(self.make_session_snapshot(&handle).await)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<SessionSnapshot> {
        let handle = self.inner.sessions.read().await.get(session_id).cloned()?;
        Some(self.make_session_snapshot(&handle).await)
    }

    pub async fn stop_session(
        &self,
        session_id: &str,
        force: bool,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let handle = self
            .inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| RuntimeError::SessionNotFound("Session not found.".to_string()))?;
        {
            let state = handle.state.lock().await;
            if state.status == "running" {
                let mut child = handle.child.lock().await;
                signal_child_tree(&mut child, force, SignalKind::Terminate)
                    .await
                    .map_err(runtime_error_from_anyhow)?;
            }
        }
        Ok(self.make_session_snapshot(&handle).await)
    }

    pub async fn write_to_session(
        &self,
        session_id: &str,
        text: String,
        submit: bool,
    ) -> Result<WriteResult, RuntimeError> {
        let handle = self
            .inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| RuntimeError::SessionNotFound("Session not found.".to_string()))?;
        {
            let state = handle.state.lock().await;
            if state.status != "running" {
                return Err(RuntimeError::InvalidRequest(
                    "Session is not running.".to_string(),
                ));
            }
        }
        let payload = if submit { format!("{text}\n") } else { text };
        let written = payload.len();
        let mut child = handle.child.lock().await;
        let stdin = child.stdin.as_mut().ok_or_else(|| {
            RuntimeError::InvalidRequest("Session stdin is not writable.".to_string())
        })?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|error| RuntimeError::InvalidRequest(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| RuntimeError::InvalidRequest(error.to_string()))?;
        Ok(WriteResult { ok: true, written })
    }

    pub async fn send_keys_to_session(
        &self,
        session_id: &str,
        keys: &str,
    ) -> Result<serde_json::Value, RuntimeError> {
        let normalized = keys.trim().to_lowercase();
        match normalized.as_str() {
            "ctrl-c" => {
                self.signal_session(session_id, SignalKind::Interrupt)
                    .await?;
                Ok(serde_json::json!({ "ok": true, "action": "signal", "key": normalized }))
            }
            "ctrl-z" => {
                self.signal_session(session_id, SignalKind::Suspend).await?;
                Ok(serde_json::json!({ "ok": true, "action": "signal", "key": normalized }))
            }
            "ctrl-d" => {
                let handle = self.session_handle(session_id).await?;
                let mut child = handle.child.lock().await;
                let stdin = child.stdin.as_mut().ok_or_else(|| {
                    RuntimeError::InvalidRequest("Session stdin is not writable.".to_string())
                })?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|error| RuntimeError::InvalidRequest(error.to_string()))?;
                Ok(serde_json::json!({ "ok": true, "action": "stdin", "key": normalized }))
            }
            "enter" => {
                let result = self
                    .write_to_session(session_id, String::new(), true)
                    .await?;
                Ok(serde_json::to_value(result).unwrap())
            }
            "tab" => {
                let result = self
                    .write_to_session(session_id, "\t".to_string(), false)
                    .await?;
                Ok(serde_json::to_value(result).unwrap())
            }
            "escape" | "esc" => {
                let result = self
                    .write_to_session(session_id, "\u{001b}".to_string(), false)
                    .await?;
                Ok(serde_json::to_value(result).unwrap())
            }
            _ => Err(RuntimeError::InvalidRequest(
                "Unsupported key. Use one of: ctrl-c, ctrl-d, ctrl-z, enter, tab, escape"
                    .to_string(),
            )),
        }
    }

    pub async fn list_sessions(&self, query: SessionListQuery) -> SessionListResult {
        self.prune_sessions().await;
        let offset = query.offset.unwrap_or(0);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_SESSION_LIST_LIMIT)
            .clamp(1, MAX_SESSION_LIST_LIMIT);
        let mut items = Vec::new();
        for handle in self.inner.sessions.read().await.values() {
            let snapshot = self.make_session_list_item(handle).await;
            if let Some(status) = query.status {
                if status == SessionStatusFilter::Running && snapshot.status != "running" {
                    continue;
                }
                if status == SessionStatusFilter::Exited && snapshot.status != "exited" {
                    continue;
                }
            }
            items.push(snapshot);
        }
        items.sort_by(|a, b| {
            let a_time = a.finished_at.unwrap_or(a.started_at);
            let b_time = b.finished_at.unwrap_or(b.started_at);
            b_time.cmp(&a_time)
        });
        let total = items.len();
        let sessions = items
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        SessionListResult {
            has_more: offset + sessions.len() < total,
            sessions,
            total,
            offset,
            limit,
        }
    }

    pub async fn get_session_log(
        &self,
        session_id: &str,
        query: SessionLogQuery,
    ) -> Result<SessionLogResult, RuntimeError> {
        let handle = self.session_handle(session_id).await?;
        let state = handle.state.lock().await;
        let offset = query.offset.unwrap_or(0);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_LOG_SLICE_LIMIT)
            .clamp(1, MAX_OUTPUT_CHARS);
        let status = state.status.clone();
        match query.stream {
            LogStream::Stdout => {
                let slice = make_log_slice(&state.stdout, offset, limit);
                Ok(SessionLogResult {
                    ok: true,
                    session_id: state.id.clone(),
                    status,
                    stream: "stdout".to_string(),
                    output: Some(slice.output.clone()),
                    total: Some(slice.total),
                    offset: Some(slice.offset),
                    limit: Some(slice.limit),
                    next_offset: Some(slice.next_offset),
                    has_more: Some(slice.has_more),
                    stdout: None,
                    stderr: None,
                })
            }
            LogStream::Stderr => {
                let slice = make_log_slice(&state.stderr, offset, limit);
                Ok(SessionLogResult {
                    ok: true,
                    session_id: state.id.clone(),
                    status,
                    stream: "stderr".to_string(),
                    output: Some(slice.output.clone()),
                    total: Some(slice.total),
                    offset: Some(slice.offset),
                    limit: Some(slice.limit),
                    next_offset: Some(slice.next_offset),
                    has_more: Some(slice.has_more),
                    stdout: None,
                    stderr: None,
                })
            }
            LogStream::Both => Ok(SessionLogResult {
                ok: true,
                session_id: state.id.clone(),
                status,
                stream: "both".to_string(),
                output: None,
                total: None,
                offset: Some(offset),
                limit: Some(limit),
                next_offset: None,
                has_more: None,
                stdout: Some(make_log_slice(&state.stdout, offset, limit)),
                stderr: Some(make_log_slice(&state.stderr, offset, limit)),
            }),
        }
    }

    pub async fn list_session_events(&self, query: SessionEventsQuery) -> SessionEventsResult {
        let after = query.after.unwrap_or(0);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_EVENT_LIST_LIMIT)
            .clamp(1, MAX_EVENT_LIST_LIMIT);
        let events = self
            .inner
            .session_events
            .read()
            .await
            .iter()
            .filter(|event| event.cursor > after)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_cursor = events.last().map(|event| event.cursor).unwrap_or_else(|| {
            let current = self.inner.next_event_cursor.load(Ordering::SeqCst);
            current.saturating_sub(1).max(after)
        });
        let has_more = self
            .inner
            .session_events
            .read()
            .await
            .iter()
            .any(|event| event.cursor > next_cursor);
        SessionEventsResult {
            ok: true,
            events,
            next_cursor,
            has_more,
        }
    }

    async fn signal_session(&self, session_id: &str, kind: SignalKind) -> Result<(), RuntimeError> {
        let handle = self.session_handle(session_id).await?;
        {
            let state = handle.state.lock().await;
            if state.status != "running" {
                return Err(RuntimeError::InvalidRequest(
                    "Session is not running.".to_string(),
                ));
            }
        }
        let mut child = handle.child.lock().await;
        signal_child_tree(&mut child, false, kind)
            .await
            .map_err(runtime_error_from_anyhow)?;
        Ok(())
    }

    async fn session_handle(&self, session_id: &str) -> Result<Arc<SessionHandle>, RuntimeError> {
        self.inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| RuntimeError::SessionNotFound("Session not found.".to_string()))
    }

    async fn make_session_snapshot(&self, handle: &Arc<SessionHandle>) -> SessionSnapshot {
        let state = handle.state.lock().await;
        let finished_at = state.finished_at;
        SessionSnapshot {
            ok: true,
            session_id: state.id.clone(),
            status: state.status.clone(),
            command: state.command.clone(),
            cwd: state.cwd.clone(),
            stdout: state.stdout.clone(),
            stderr: state.stderr.clone(),
            timed_out: state.timed_out,
            exit_code: state.exit_code,
            started_at: state.started_at,
            finished_at,
            duration_ms: finished_at.unwrap_or_else(now_millis) - state.started_at,
        }
    }

    async fn make_session_list_item(&self, handle: &Arc<SessionHandle>) -> SessionListItem {
        let state = handle.state.lock().await;
        let finished_at = state.finished_at;
        SessionListItem {
            session_id: state.id.clone(),
            status: state.status.clone(),
            command: state.command.clone(),
            cwd: state.cwd.clone(),
            started_at: state.started_at,
            finished_at,
            timed_out: state.timed_out,
            exit_code: state.exit_code,
            duration_ms: finished_at.unwrap_or_else(now_millis) - state.started_at,
        }
    }

    async fn prune_sessions(&self) {
        let now = now_millis();
        let cutoff = now.saturating_sub(self.inner.session_ttl_ms);
        let mut ids_to_remove = Vec::new();
        {
            let sessions = self.inner.sessions.read().await;
            for (id, handle) in sessions.iter() {
                let state = handle.state.lock().await;
                if state.status == "exited" && state.finished_at.unwrap_or(0) < cutoff {
                    ids_to_remove.push(id.clone());
                }
            }
        }

        if !ids_to_remove.is_empty() {
            let mut sessions = self.inner.sessions.write().await;
            for id in ids_to_remove {
                sessions.remove(&id);
            }
        }

        let len = self.inner.sessions.read().await.len();
        if len <= self.inner.max_session_count {
            return;
        }

        let mut snapshot = Vec::new();
        {
            let sessions = self.inner.sessions.read().await;
            for (id, handle) in sessions.iter() {
                let state = handle.state.lock().await;
                snapshot.push((
                    id.clone(),
                    state.finished_at.unwrap_or(state.started_at),
                    state.status.clone(),
                ));
            }
        }
        snapshot.sort_by(|a, b| a.1.cmp(&b.1));
        let overflow = len.saturating_sub(self.inner.max_session_count);
        let remove_ids = snapshot
            .into_iter()
            .take(overflow)
            .map(|item| item.0)
            .collect::<Vec<_>>();
        let mut sessions = self.inner.sessions.write().await;
        for id in remove_ids {
            sessions.remove(&id);
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy)]
struct ExitStatusSummary {
    exit_code: i32,
    timed_out: bool,
}

#[derive(Debug, Clone, Copy)]
enum SignalKind {
    Terminate,
    Interrupt,
    Suspend,
}

fn read_u64_env(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn read_usize_env(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn generate_session_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn trim_output(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return text.to_string();
    }
    text.chars()
        .skip(text.chars().count() - MAX_OUTPUT_CHARS)
        .collect::<String>()
}

async fn resolve_cwd(
    input_cwd: Option<&str>,
    permission_policy: &PermissionPolicy,
) -> Result<PathBuf> {
    let mut cwd = if let Some(raw) = input_cwd {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            default_cwd(permission_policy)?
        } else {
            normalize_input_path(trimmed)
        }
    } else {
        default_cwd(permission_policy)?
    };

    if !cwd.exists() {
        bail!("Working directory does not exist: {}", cwd.display());
    }
    if !cwd.is_dir() {
        bail!("Working directory does not exist: {}", cwd.display());
    }

    if permission_policy.mode == "workspace" {
        if permission_policy.workspace_roots.is_empty() {
            bail!("Workspace mode is enabled, but no workspace root is configured.");
        }
        cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
        if !is_path_within_roots(&cwd, &permission_policy.workspace_roots) {
            bail!(
                "Working directory is outside allowed workspace roots: {}",
                cwd.display()
            );
        }
    }

    Ok(cwd)
}

fn default_cwd(permission_policy: &PermissionPolicy) -> Result<PathBuf> {
    if permission_policy.mode == "workspace" {
        if let Some(first) = permission_policy.workspace_roots.first() {
            return Ok(PathBuf::from(first));
        }
    }
    let companion_home = get_config_dir();
    if companion_home.exists() && companion_home.is_dir() {
        return Ok(companion_home);
    }
    std::env::current_dir().context("Failed to resolve current working directory")
}

fn normalize_input_path(input: &str) -> PathBuf {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    let candidate = PathBuf::from(input);
    if candidate.is_absolute() {
        return candidate;
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(candidate)
}

fn validate_command(command: &str) -> Result<(), RuntimeError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::InvalidRequest(
            "command is required.".to_string(),
        ));
    }
    if trimmed.len() > 10_000 {
        return Err(RuntimeError::InvalidRequest(
            "command exceeds max length (10000).".to_string(),
        ));
    }
    Ok(())
}

fn clamp_timeout(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}

fn runtime_error_from_anyhow(error: anyhow::Error) -> RuntimeError {
    RuntimeError::InvalidRequest(error.to_string())
}

fn enforce_command_policy(
    command: &str,
    cwd: &Path,
    permission_policy: &PermissionPolicy,
) -> Result<(), RuntimeError> {
    if permission_policy.mode != "workspace" {
        return Ok(());
    }

    let normalized = command.replace('\0', "");
    let lowercase = normalized.to_lowercase();
    let blocked_patterns = [
        ("sudo", "sudo is disabled in workspace mode"),
        (" su ", "user switching is disabled in workspace mode"),
        (
            "shutdown",
            "system shutdown commands are disabled in workspace mode",
        ),
        (
            "reboot",
            "system reboot commands are disabled in workspace mode",
        ),
        (
            "halt",
            "system halt commands are disabled in workspace mode",
        ),
        (
            "poweroff",
            "poweroff commands are disabled in workspace mode",
        ),
        (
            "rm -rf /",
            "destructive root deletes are blocked in workspace mode",
        ),
    ];
    for (needle, reason) in blocked_patterns {
        if lowercase.contains(needle) {
            return Err(RuntimeError::PermissionPolicyViolation(format!(
                "Command blocked by workspace policy: {reason}."
            )));
        }
    }

    let dangerous_regexes = [
        (
            Regex::new(r"\$\(").unwrap(),
            "command substitution $(...) is not allowed in workspace mode",
        ),
        (
            Regex::new(r"`[^`]*`").unwrap(),
            "backtick command substitution is not allowed in workspace mode",
        ),
        (
            Regex::new(r"\$\{").unwrap(),
            "parameter expansion ${...} is not allowed in workspace mode",
        ),
        (
            Regex::new(r"(^|[^\\])\$[A-Za-z_][A-Za-z0-9_]*").unwrap(),
            "environment variable expansion is not allowed in workspace mode",
        ),
        (
            Regex::new(r"<\(").unwrap(),
            "process substitution <(...) is not allowed in workspace mode",
        ),
        (
            Regex::new(r">\(").unwrap(),
            "process substitution >(...) is not allowed in workspace mode",
        ),
        (
            Regex::new(r#"(^|[\s="'])~(?=/|[\s"']|$)"#).unwrap(),
            "home-directory expansion is not allowed in workspace mode",
        ),
    ];
    for (pattern, reason) in dangerous_regexes {
        if pattern.is_match(&normalized) {
            return Err(RuntimeError::PermissionPolicyViolation(format!(
                "Command blocked by workspace policy: {reason}."
            )));
        }
    }

    let split_regex = Regex::new(r"\s*(?:\|{1,2}|&&|;)\s*").unwrap();
    let sub_commands = split_regex.split(&normalized).collect::<Vec<_>>();
    for sub_command in sub_commands {
        let tokens = shlex::split(sub_command).unwrap_or_else(|| {
            sub_command
                .split_whitespace()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        });
        for token in tokens {
            for candidate in maybe_path_candidates(&token) {
                if let Some(abs_path) = normalize_candidate_to_absolute(&candidate, cwd) {
                    if !is_path_within_roots(&abs_path, &permission_policy.workspace_roots) {
                        return Err(RuntimeError::PermissionPolicyViolation(format!(
                            "Path escapes workspace boundary: {candidate}"
                        )));
                    }
                }
            }
        }
    }

    Ok(())
}

fn maybe_path_candidates(token: &str) -> Vec<String> {
    if token.contains("://") {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    if let Some(index) = token.find('=') {
        if index < token.len().saturating_sub(1) {
            candidates.push(token[index + 1..].to_string());
        }
    }
    candidates.push(token.to_string());
    candidates
}

fn normalize_candidate_to_absolute(candidate: &str, cwd: &Path) -> Option<PathBuf> {
    if !looks_like_path(candidate) {
        return None;
    }
    if let Some(rest) = candidate.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return Some(home.join(rest));
        }
    }
    let path = PathBuf::from(candidate);
    if path.is_absolute() {
        return Some(path);
    }
    Some(cwd.join(path))
}

fn looks_like_path(candidate: &str) -> bool {
    if candidate.is_empty() || candidate.starts_with('-') {
        return false;
    }
    if candidate == "." || candidate == ".." {
        return true;
    }
    if candidate.starts_with("./")
        || candidate.starts_with("../")
        || candidate.starts_with("~/")
        || candidate.starts_with('/')
        || candidate.contains('/')
        || candidate.contains('\\')
    {
        return true;
    }
    #[cfg(windows)]
    {
        if Regex::new(r"^[A-Za-z]:[\\/]").unwrap().is_match(candidate) {
            return true;
        }
    }
    false
}

async fn spawn_shell_process(
    command: &str,
    cwd: &Path,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnedProcess> {
    let mut shell = if cfg!(windows) {
        let mut command_builder =
            Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()));
        command_builder.args(["/d", "/s", "/c", command]);
        command_builder
    } else {
        let shell_path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut command_builder = Command::new(shell_path);
        command_builder.args(["-lc", command]);
        command_builder
    };

    shell.current_dir(cwd);
    if let Some(env_vars) = env {
        shell.envs(env_vars);
    }
    shell.stdin(Stdio::piped());
    shell.stdout(Stdio::piped());
    shell.stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use nix::libc;
        unsafe {
            shell.pre_exec(|| {
                let result = libc::setpgid(0, 0);
                if result == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }

    let mut child = shell.spawn().context("Failed to spawn shell process")?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    Ok(SpawnedProcess {
        child,
        stdout,
        stderr,
    })
}

fn collect_stdout_stream(
    stream: Option<tokio::process::ChildStdout>,
) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let Some(mut reader) = stream else {
            return String::new();
        };
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer).await;
        trim_output(&String::from_utf8_lossy(&buffer))
    })
}

fn collect_stderr_stream(
    stream: Option<tokio::process::ChildStderr>,
) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let Some(mut reader) = stream else {
            return String::new();
        };
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer).await;
        trim_output(&String::from_utf8_lossy(&buffer))
    })
}

async fn wait_with_timeout(child: &mut Child, timeout_ms: u64) -> Result<ExitStatusSummary> {
    let pid = child.id();
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await {
        Ok(status) => {
            let status = status?;
            Ok(ExitStatusSummary {
                exit_code: status.code().unwrap_or(-1),
                timed_out: false,
            })
        }
        Err(_) => {
            if let Some(pid) = pid {
                terminate_process_tree(pid).await?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                if child.try_wait()?.is_none() {
                    kill_process_tree(pid).await?;
                }
            } else {
                let _ = child.kill().await;
            }
            let status = child.wait().await.ok();
            Ok(ExitStatusSummary {
                exit_code: status.and_then(|value| value.code()).unwrap_or(-1),
                timed_out: true,
            })
        }
    }
}

fn spawn_reader<T>(mut stream: T, handle: Arc<SessionHandle>, kind: StreamKind)
where
    T: AsyncReadExt + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let mut state = handle.state.lock().await;
                    match kind {
                        StreamKind::Stdout => {
                            state.stdout = trim_output(&(state.stdout.clone() + &chunk));
                        }
                        StreamKind::Stderr => {
                            state.stderr = trim_output(&(state.stderr.clone() + &chunk));
                        }
                    }
                }
                Err(error) => {
                    let mut state = handle.state.lock().await;
                    state.stderr = trim_output(&(state.stderr.clone() + &format!("\n{}", error)));
                    break;
                }
            }
        }
    });
}

fn spawn_exit_watchdog(inner: Arc<RuntimeInner>, handle: Arc<SessionHandle>) {
    tokio::spawn(async move {
        let timeout_ms = { handle.state.lock().await.timeout_ms };
        let timeout_deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut sigkill_deadline: Option<Instant> = None;
        loop {
            {
                let mut child = handle.child.lock().await;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        finalize_session(
                            inner.clone(),
                            handle.clone(),
                            status.code().unwrap_or(-1),
                        )
                        .await;
                        return;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        finalize_session_with_error(
                            inner.clone(),
                            handle.clone(),
                            &error.to_string(),
                        )
                        .await;
                        return;
                    }
                }

                if Instant::now() >= timeout_deadline {
                    let mut state = handle.state.lock().await;
                    if state.status == "running" && !state.timed_out {
                        state.timed_out = true;
                        drop(state);
                        let _ = signal_child_tree(&mut child, false, SignalKind::Terminate).await;
                        sigkill_deadline = Some(Instant::now() + Duration::from_secs(3));
                    }
                }

                if let Some(deadline) = sigkill_deadline {
                    if Instant::now() >= deadline {
                        let _ = signal_child_tree(&mut child, true, SignalKind::Terminate).await;
                        sigkill_deadline = None;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    });
}

async fn finalize_session(inner: Arc<RuntimeInner>, handle: Arc<SessionHandle>, exit_code: i32) {
    let mut state = handle.state.lock().await;
    if state.status == "exited" {
        return;
    }
    state.status = "exited".to_string();
    state.exit_code = Some(exit_code);
    state.finished_at = Some(now_millis());
    let event = SessionEvent {
        cursor: inner.next_event_cursor.fetch_add(1, Ordering::SeqCst),
        r#type: "session_exited".to_string(),
        session_id: state.id.clone(),
        command: state.command.clone(),
        cwd: state.cwd.clone(),
        timed_out: state.timed_out,
        exit_code,
        started_at: state.started_at,
        finished_at: state.finished_at.unwrap_or_else(now_millis),
        duration_ms: state
            .finished_at
            .unwrap_or_else(now_millis)
            .saturating_sub(state.started_at),
    };
    drop(state);
    inner.session_events.write().await.push(event);
}

async fn finalize_session_with_error(
    inner: Arc<RuntimeInner>,
    handle: Arc<SessionHandle>,
    error: &str,
) {
    {
        let mut state = handle.state.lock().await;
        state.stderr = trim_output(&(state.stderr.clone() + &format!("\n{error}")));
    }
    finalize_session(inner, handle, -1).await;
}

async fn signal_child_tree(child: &mut Child, force: bool, kind: SignalKind) -> Result<()> {
    let Some(pid) = child.id() else {
        bail!("Session child process is unavailable");
    };
    match (force, kind) {
        (true, _) => kill_process_tree(pid).await,
        (false, SignalKind::Terminate) => terminate_process_tree(pid).await,
        (false, SignalKind::Interrupt) => interrupt_process_tree(pid).await,
        (false, SignalKind::Suspend) => suspend_process_tree(pid).await,
    }
}

#[cfg(unix)]
async fn terminate_process_tree(pid: u32) -> Result<()> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM)
        .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGTERM))
        .map_err(|error| anyhow!(error.to_string()))
}

#[cfg(windows)]
async fn terminate_process_tree(pid: u32) -> Result<()> {
    let status = Command::new("taskkill")
        .args(["/T", "/PID", &pid.to_string()])
        .status()
        .await
        .context("Failed to invoke taskkill")?;
    if status.success() {
        Ok(())
    } else {
        bail!("taskkill exited with status {}", status)
    }
}

#[cfg(unix)]
async fn interrupt_process_tree(pid: u32) -> Result<()> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(-(pid as i32)), Signal::SIGINT)
        .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGINT))
        .map_err(|error| anyhow!(error.to_string()))
}

#[cfg(windows)]
async fn interrupt_process_tree(pid: u32) -> Result<()> {
    terminate_process_tree(pid).await
}

#[cfg(unix)]
async fn suspend_process_tree(pid: u32) -> Result<()> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(-(pid as i32)), Signal::SIGTSTP)
        .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGTSTP))
        .map_err(|error| anyhow!(error.to_string()))
}

#[cfg(windows)]
async fn suspend_process_tree(pid: u32) -> Result<()> {
    terminate_process_tree(pid).await
}

#[cfg(unix)]
async fn kill_process_tree(pid: u32) -> Result<()> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL)
        .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGKILL))
        .map_err(|error| anyhow!(error.to_string()))
}

#[cfg(windows)]
async fn kill_process_tree(pid: u32) -> Result<()> {
    let status = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status()
        .await
        .context("Failed to invoke taskkill")?;
    if status.success() {
        Ok(())
    } else {
        bail!("taskkill exited with status {}", status)
    }
}

fn make_log_slice(text: &str, offset: usize, limit: usize) -> LogSlice {
    let total = text.len();
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    LogSlice {
        output: text[start..end].to_string(),
        total,
        offset: start,
        limit,
        next_offset: end,
        has_more: end < total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_policy() -> PermissionPolicy {
        PermissionPolicy {
            mode: "full".to_string(),
            workspace_roots: Vec::new(),
            policy_reason: "policy_mode:full".to_string(),
        }
    }

    #[tokio::test]
    async fn run_command_executes_successfully() {
        let runtime = RuntimeManager::new();
        let command = if cfg!(windows) {
            "echo hello".to_string()
        } else {
            "printf hello".to_string()
        };
        let result = runtime
            .run_command(ExecRequest {
                command: command.clone(),
                cwd: None,
                timeout_ms: Some(5_000),
                env: None,
                permission_policy: full_policy(),
            })
            .await
            .unwrap();
        assert!(result.ok);
        assert!(result.stdout.contains("hello"));
        assert_eq!(result.command, command);
    }

    #[tokio::test]
    async fn session_lifecycle_records_exit_event() {
        let runtime = RuntimeManager::new();
        let command = if cfg!(windows) {
            "echo hi".to_string()
        } else {
            "printf hi".to_string()
        };
        let session = runtime
            .start_session(SessionStartRequest {
                command,
                cwd: None,
                timeout_ms: Some(5_000),
                env: None,
                permission_policy: full_policy(),
            })
            .await
            .unwrap();
        let mut snapshot = runtime.get_session(&session.session_id).await.unwrap();
        for _ in 0..20 {
            if snapshot.status == "exited" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            snapshot = runtime.get_session(&session.session_id).await.unwrap();
        }
        assert_eq!(snapshot.status, "exited");
        let events = runtime
            .list_session_events(SessionEventsQuery {
                after: None,
                limit: None,
            })
            .await;
        assert!(!events.events.is_empty());
    }

    #[test]
    fn workspace_policy_blocks_sudo() {
        let cwd = std::env::current_dir().unwrap();
        let policy = PermissionPolicy {
            mode: "workspace".to_string(),
            workspace_roots: vec![cwd.to_string_lossy().to_string()],
            policy_reason: "policy_mode:workspace".to_string(),
        };
        let result = enforce_command_policy("sudo ls", &cwd, &policy);
        assert!(matches!(
            result,
            Err(RuntimeError::PermissionPolicyViolation(_))
        ));
    }
}
