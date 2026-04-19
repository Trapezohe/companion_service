mod persist;

use anyhow::{anyhow, bail, Context, Result};
use companion_shared::{RunTier, DEFAULT_TIER_ACP_MAX_TIMEOUT_MS};
pub use persist::{AcpPersistence, PersistedAcpSession, ORPHAN_REASON};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// Historical default-tier cap. Long-task tier reaches beyond this — see
/// [`RunTier::max_timeout_ms`] in `companion_shared`.
const MAX_TIMEOUT_MS: u64 = DEFAULT_TIER_ACP_MAX_TIMEOUT_MS;
const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 500;
const MAX_EVENT_COUNT: usize = 5_000;
const KILL_DELAY_MS: u64 = 3_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CommandSpec {
    Shell(String),
    Args(Vec<String>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionSnapshot {
    pub session_id: String,
    pub agent_type: String,
    pub state: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<CommandSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_provenance: Option<Value>,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub queue_depth: usize,
    pub terminal_emitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpListResult {
    pub sessions: Vec<AcpSessionSnapshot>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptAck {
    pub ok: bool,
    pub session_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCancelResult {
    pub ok: bool,
    pub session_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_terminal: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEventsResult {
    pub events: Vec<AcpEvent>,
    pub next_cursor: u64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub cursor: u64,
    pub session_id: String,
    pub emitted_at: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateSessionInput {
    pub session_id: Option<String>,
    pub agent_type: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<CommandSpec>,
    pub env: Option<BTreeMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub origin: Option<String>,
    pub input_provenance: Option<Value>,
    /// Tier declared by the caller. Default keeps the 10-minute historical
    /// cap; LongTask opens it to 24h so a long `delegate_task` run into an
    /// external agent (claude-code-cli, hermes, etc.) isn't strangled.
    pub tier: RunTier,
}

#[derive(Debug, Clone, Default)]
pub struct PromptInput {
    pub prompt: Option<String>,
    pub turn_id: Option<String>,
    pub timeout_ms: Option<u64>,
    pub command: Option<CommandSpec>,
    pub cwd: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub origin: Option<String>,
    pub input_provenance: Option<Value>,
    /// Per-turn tier override. Falls back to the session tier if None.
    pub tier: Option<RunTier>,
}

#[derive(Debug, Clone, Default)]
pub struct SteerInput {
    pub text: Option<String>,
    pub submit: Option<bool>,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionListQuery {
    pub state: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionEventsQuery {
    pub after: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct AcpManager {
    inner: Arc<AcpInner>,
}

#[derive(Debug)]
struct AcpInner {
    sessions: RwLock<HashMap<String, Arc<SessionHandle>>>,
    events: RwLock<Vec<AcpEvent>>,
    next_cursor: AtomicU64,
    /// Same pattern as companion-runtime + companion-agent: disk-backed
    /// metadata so daemon restart can fall back to "the session existed
    /// and was orphaned" instead of 404.
    persistence: Option<Arc<AcpPersistence>>,
    /// Terminal-state + orphan-recovered sessions. `get_session` and
    /// `list_sessions` consult this after the live map misses.
    history: RwLock<HashMap<String, PersistedAcpSession>>,
}

#[derive(Debug)]
struct SessionHandle {
    child: Mutex<Option<Child>>,
    state: Mutex<SessionState>,
}

#[derive(Debug)]
struct SessionState {
    session_id: String,
    agent_type: String,
    state: String,
    cwd: String,
    command: Option<CommandSpec>,
    env: Option<BTreeMap<String, String>>,
    timeout_ms: u64,
    origin: Option<String>,
    input_provenance: Option<Value>,
    created_at: u64,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    current_turn_id: Option<String>,
    run_id: Option<String>,
    queue_depth: usize,
    terminal_emitted: bool,
    runtime_session_id: Option<String>,
    timed_out: bool,
    /// Declared by the caller at create time; prompt-level overrides
    /// temporarily widen this but the default returns on the next turn.
    tier: RunTier,
}

impl AcpManager {
    pub fn new() -> Self {
        Self::build(None)
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        Self::build(Some(Arc::new(AcpPersistence::new(config_dir.into()))))
    }

    fn build(persistence: Option<Arc<AcpPersistence>>) -> Self {
        let recovered = match persistence.as_ref() {
            None => Vec::new(),
            Some(persistence) => {
                let now = now_millis();
                let loaded = persistence.load();
                let cleaned = persist::mark_orphans(loaded, now);
                if let Err(err) = persistence.save(&cleaned) {
                    tracing::warn!(
                        target: "companion_acp",
                        error = %err,
                        "Failed to persist orphan recovery snapshot"
                    );
                }
                cleaned
            }
        };
        let mut history = HashMap::new();
        for session in recovered {
            history.insert(session.session_id.clone(), session);
        }
        Self {
            inner: Arc::new(AcpInner {
                sessions: RwLock::new(HashMap::new()),
                events: RwLock::new(Vec::new()),
                next_cursor: AtomicU64::new(1),
                persistence,
                history: RwLock::new(history),
            }),
        }
    }

    /// Diagnostic + test hook.
    pub async fn history_count(&self) -> usize {
        self.inner.history.read().await.len()
    }

    pub async fn create_session(&self, input: CreateSessionInput) -> AcpSessionSnapshot {
        let session_id = input.session_id.unwrap_or_else(generate_id);
        let agent_type = input.agent_type.unwrap_or_else(|| "raw".to_string());
        let handle = Arc::new(SessionHandle {
            child: Mutex::new(None),
            state: Mutex::new(SessionState {
                session_id: session_id.clone(),
                agent_type,
                state: "idle".to_string(),
                cwd: input.cwd.unwrap_or_else(default_cwd),
                command: input.command,
                env: input.env,
                timeout_ms: clamp_timeout(input.timeout_ms, input.tier),
                origin: input.origin.and_then(trim_optional),
                input_provenance: normalize_object(input.input_provenance),
                created_at: now_millis(),
                started_at: None,
                finished_at: None,
                current_turn_id: None,
                run_id: None,
                queue_depth: 0,
                terminal_emitted: false,
                runtime_session_id: None,
                timed_out: false,
                tier: input.tier,
            }),
        });
        self.inner
            .sessions
            .write()
            .await
            .insert(session_id, handle.clone());
        persist_acp_snapshot(&self.inner).await;
        self.snapshot(&handle).await
    }

    pub async fn get_session(&self, session_id: &str) -> Option<AcpSessionSnapshot> {
        if let Some(handle) = self.inner.sessions.read().await.get(session_id).cloned() {
            return Some(self.snapshot(&handle).await);
        }
        // Live miss: answer from history so a daemon-restart orphan shows
        // up as `state='error', orphanReason='daemon_restart_orphan'`
        // instead of disappearing entirely.
        let history = self.inner.history.read().await;
        history
            .get(session_id)
            .map(|persisted| snapshot_from_persisted(persisted))
    }

    pub async fn attach_run_id(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Option<AcpSessionSnapshot> {
        let handle = self.inner.sessions.read().await.get(session_id).cloned()?;
        let mut state = handle.state.lock().await;
        state.run_id = trim_optional(run_id);
        drop(state);
        Some(self.snapshot(&handle).await)
    }

    pub async fn list_sessions(&self, query: SessionListQuery) -> AcpListResult {
        let offset = query.offset.unwrap_or(0);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_LIMIT);
        let state_filter = query.state.and_then(trim_optional);
        let handles = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut sessions = Vec::new();
        for handle in handles {
            let snapshot = self.snapshot(&handle).await;
            if let Some(filter) = state_filter.as_deref() {
                if snapshot.state != filter {
                    continue;
                }
            }
            sessions.push(snapshot);
        }
        sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        let total = sessions.len();
        let paged = sessions
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        AcpListResult {
            has_more: offset + paged.len() < total,
            sessions: paged,
            total,
            offset,
            limit,
        }
    }

    pub async fn enqueue_prompt(
        &self,
        session_id: &str,
        input: PromptInput,
    ) -> Result<AcpPromptAck> {
        let handle = self.handle(session_id).await?;
        let (turn_id, session_id, command, cwd, env, timeout_ms, prompt, run_id) = {
            let mut state = handle.state.lock().await;
            if matches!(state.state.as_str(), "error" | "cancelled" | "timeout") {
                bail!(
                    "ACP session \"{}\" is in terminal state \"{}\".",
                    state.session_id,
                    state.state
                );
            }
            if state.state == "done" {
                state.state = "idle".to_string();
                state.started_at = None;
                state.finished_at = None;
                state.current_turn_id = None;
                state.terminal_emitted = false;
                state.timed_out = false;
            }
            if let Some(origin) = input.origin.clone().and_then(trim_optional) {
                state.origin = Some(origin);
            }
            if let Some(provenance) = normalize_object(input.input_provenance.clone()) {
                state.input_provenance = Some(provenance);
            }
            let command = input
                .command
                .clone()
                .or_else(|| state.command.clone())
                .ok_or_else(|| {
                    anyhow!(
                        "No command specified for ACP session \"{}\" (agentType=\"{}\").",
                        state.session_id,
                        state.agent_type
                    )
                })?;
            let child_running = handle
                .child
                .lock()
                .await
                .as_ref()
                .and_then(|child| child.id())
                .is_some()
                && state.state == "running";
            if child_running {
                bail!(
                    "Session \"{}\" already has a running child process.",
                    state.session_id
                );
            }
            let turn_id = input.turn_id.clone().unwrap_or_else(generate_short_id);
            state.state = "running".to_string();
            state.started_at = Some(now_millis());
            state.finished_at = None;
            state.current_turn_id = Some(turn_id.clone());
            state.terminal_emitted = false;
            state.timed_out = false;
            state.queue_depth = 0;
            (
                turn_id,
                state.session_id.clone(),
                command,
                input.cwd.clone().unwrap_or_else(|| state.cwd.clone()),
                input.env.clone().or_else(|| state.env.clone()),
                clamp_timeout(
                    input.timeout_ms.or(Some(state.timeout_ms)),
                    input.tier.unwrap_or(state.tier),
                ),
                input.prompt.clone(),
                state.run_id.clone(),
            )
        };

        let mut child = spawn_command(&command, &cwd, env).await?;
        if let Some(prompt) = prompt.as_deref() {
            if let Some(stdin) = child.stdin.as_mut() {
                stdin
                    .write_all(format!("{prompt}\n").as_bytes())
                    .await
                    .context("Failed to write prompt to ACP child stdin")?;
                stdin.flush().await.ok();
            }
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *handle.child.lock().await = Some(child);

        if let Some(stdout) = stdout {
            spawn_stdout_reader(self.inner.clone(), handle.clone(), stdout);
        }
        if let Some(stderr) = stderr {
            spawn_stderr_reader(self.inner.clone(), handle.clone(), stderr);
        }
        spawn_monitor(self.inner.clone(), handle, timeout_ms);

        Ok(AcpPromptAck {
            ok: true,
            session_id,
            turn_id,
            run_id,
        })
    }

    pub async fn enqueue_steer(&self, session_id: &str, input: SteerInput) -> Result<AcpPromptAck> {
        let handle = self.handle(session_id).await?;
        let turn_id = {
            let state = handle.state.lock().await;
            if state.state != "running" {
                bail!(
                    "Cannot steer: session state is \"{}\", expected \"running\"",
                    state.state
                );
            }
            input
                .turn_id
                .clone()
                .or_else(|| state.current_turn_id.clone())
                .unwrap_or_else(generate_short_id)
        };
        let payload = if input.submit.unwrap_or(true) {
            format!("{}\n", input.text.unwrap_or_default())
        } else {
            input.text.unwrap_or_default()
        };
        let mut child_guard = handle.child.lock().await;
        let Some(child) = child_guard.as_mut() else {
            bail!("Agent stdin is not writable");
        };
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("Agent stdin is not writable"))?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .context("Failed to write ACP steer input")?;
        stdin.flush().await.ok();
        Ok(AcpPromptAck {
            ok: true,
            session_id: session_id.to_string(),
            turn_id,
            run_id: self
                .get_session(session_id)
                .await
                .and_then(|session| session.run_id),
        })
    }

    pub async fn cancel_session(&self, session_id: &str) -> Result<AcpCancelResult> {
        let handle = self.handle(session_id).await?;
        let (already_terminal, state_name) = {
            let state = handle.state.lock().await;
            (
                matches!(
                    state.state.as_str(),
                    "done" | "error" | "cancelled" | "timeout"
                ),
                state.state.clone(),
            )
        };
        if already_terminal {
            return Ok(AcpCancelResult {
                ok: true,
                session_id: session_id.to_string(),
                state: state_name,
                already_terminal: Some(true),
            });
        }

        self.finalize_session(
            &handle,
            "cancelled",
            Some("cancelled".to_string()),
            Some("Session cancelled by user".to_string()),
            None,
        )
        .await;

        if let Some(child) = handle.child.lock().await.as_mut() {
            let _ = terminate_child_tree(child, false).await;
            tokio::spawn({
                let handle = handle.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(KILL_DELAY_MS)).await;
                    if let Some(child) = handle.child.lock().await.as_mut() {
                        let _ = terminate_child_tree(child, true).await;
                    }
                }
            });
        }

        Ok(AcpCancelResult {
            ok: true,
            session_id: session_id.to_string(),
            state: "cancelled".to_string(),
            already_terminal: None,
        })
    }

    pub async fn list_session_events(
        &self,
        session_id: &str,
        query: SessionEventsQuery,
    ) -> AcpEventsResult {
        let after = query.after.unwrap_or(0);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_LIMIT);
        let events = self
            .inner
            .events
            .read()
            .await
            .iter()
            .filter(|event| event.session_id == session_id && event.cursor > after)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_cursor = events.last().map(|event| event.cursor).unwrap_or_else(|| {
            self.inner
                .next_cursor
                .load(Ordering::SeqCst)
                .saturating_sub(1)
                .max(after)
        });
        let has_more = self
            .inner
            .events
            .read()
            .await
            .iter()
            .any(|event| event.session_id == session_id && event.cursor > next_cursor);
        AcpEventsResult {
            events,
            next_cursor,
            has_more,
        }
    }

    pub async fn list_global_events(&self, after: u64, limit: usize) -> Vec<AcpEvent> {
        self.inner
            .events
            .read()
            .await
            .iter()
            .filter(|event| event.cursor > after)
            .take(limit.clamp(1, MAX_LIST_LIMIT))
            .cloned()
            .collect()
    }

    async fn handle(&self, session_id: &str) -> Result<Arc<SessionHandle>> {
        self.inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("ACP session not found: {session_id}"))
    }

    async fn snapshot(&self, handle: &Arc<SessionHandle>) -> AcpSessionSnapshot {
        let state = handle.state.lock().await;
        AcpSessionSnapshot {
            session_id: state.session_id.clone(),
            agent_type: state.agent_type.clone(),
            state: state.state.clone(),
            cwd: state.cwd.clone(),
            command: state.command.clone(),
            origin: state.origin.clone(),
            input_provenance: state.input_provenance.clone(),
            created_at: state.created_at,
            started_at: state.started_at,
            finished_at: state.finished_at,
            current_turn_id: state.current_turn_id.clone(),
            run_id: state.run_id.clone(),
            queue_depth: state.queue_depth,
            terminal_emitted: state.terminal_emitted,
            runtime_session_id: state.runtime_session_id.clone(),
        }
    }

    async fn push_event(&self, handle: &Arc<SessionHandle>, mut event: AcpEvent) {
        let session_id = handle.state.lock().await.session_id.clone();
        event.cursor = self.inner.next_cursor.fetch_add(1, Ordering::SeqCst);
        event.session_id = session_id;
        event.emitted_at = now_millis();
        let mut events = self.inner.events.write().await;
        events.push(event);
        if events.len() > MAX_EVENT_COUNT {
            let excess = events.len() - MAX_EVENT_COUNT;
            events.drain(0..excess);
        }
    }

    async fn finalize_session(
        &self,
        handle: &Arc<SessionHandle>,
        next_state: &str,
        code: Option<String>,
        message: Option<String>,
        exit_code: Option<i32>,
    ) {
        let turn_id = {
            let mut state = handle.state.lock().await;
            if state.terminal_emitted {
                return;
            }
            state.state = next_state.to_string();
            state.finished_at = Some(now_millis());
            state.terminal_emitted = true;
            let persisted = state_to_persisted(&state);
            self.inner
                .history
                .write()
                .await
                .insert(persisted.session_id.clone(), persisted);
            state.current_turn_id.clone()
        };
        persist_acp_snapshot(&self.inner).await;
        self.push_event(
            handle,
            AcpEvent {
                cursor: 0,
                session_id: String::new(),
                emitted_at: 0,
                event_type: "terminal".to_string(),
                turn_id,
                text: None,
                status_code: None,
                code,
                message,
                exit_code,
            },
        )
        .await;
    }
}

fn spawn_stdout_reader(
    inner: Arc<AcpInner>,
    handle: Arc<SessionHandle>,
    stdout: tokio::process::ChildStdout,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let is_message_stop = serde_json::from_str::<Value>(&line)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("type")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                        .as_deref()
                        == Some("message_stop");
                    if is_message_stop {
                        continue;
                    }
                    let turn_id = handle.state.lock().await.current_turn_id.clone();
                    push_event_inner(
                        inner.clone(),
                        &handle,
                        AcpEvent {
                            cursor: 0,
                            session_id: String::new(),
                            emitted_at: 0,
                            event_type: "status".to_string(),
                            turn_id,
                            text: Some(line),
                            status_code: Some("stdout".to_string()),
                            code: None,
                            message: None,
                            exit_code: None,
                        },
                    )
                    .await;
                }
                Ok(None) => break,
                Err(error) => {
                    push_event_inner(
                        inner.clone(),
                        &handle,
                        AcpEvent {
                            cursor: 0,
                            session_id: String::new(),
                            emitted_at: 0,
                            event_type: "status".to_string(),
                            turn_id: handle.state.lock().await.current_turn_id.clone(),
                            text: Some(format!("[stdout_error] {}", error)),
                            status_code: Some("stdout_error".to_string()),
                            code: None,
                            message: None,
                            exit_code: None,
                        },
                    )
                    .await;
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(
    inner: Arc<AcpInner>,
    handle: Arc<SessionHandle>,
    stderr: tokio::process::ChildStderr,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let text = normalize_status_text(&line);
                    if text.is_empty() {
                        continue;
                    }
                    let (status_code, text) = if is_permission_related_text(&text) {
                        ("awaiting_approval".to_string(), text)
                    } else {
                        ("stderr".to_string(), format!("[stderr] {text}"))
                    };
                    let turn_id = handle.state.lock().await.current_turn_id.clone();
                    push_event_inner(
                        inner.clone(),
                        &handle,
                        AcpEvent {
                            cursor: 0,
                            session_id: String::new(),
                            emitted_at: 0,
                            event_type: "status".to_string(),
                            turn_id,
                            text: Some(text),
                            status_code: Some(status_code),
                            code: None,
                            message: None,
                            exit_code: None,
                        },
                    )
                    .await;
                }
                Ok(None) => break,
                Err(error) => {
                    push_event_inner(
                        inner.clone(),
                        &handle,
                        AcpEvent {
                            cursor: 0,
                            session_id: String::new(),
                            emitted_at: 0,
                            event_type: "status".to_string(),
                            turn_id: handle.state.lock().await.current_turn_id.clone(),
                            text: Some(format!("[stderr_error] {}", error)),
                            status_code: Some("stderr_error".to_string()),
                            code: None,
                            message: None,
                            exit_code: None,
                        },
                    )
                    .await;
                    break;
                }
            }
        }
    });
}

fn spawn_monitor(inner: Arc<AcpInner>, handle: Arc<SessionHandle>, timeout_ms: u64) {
    tokio::spawn(async move {
        let timeout_deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut kill_deadline: Option<Instant> = None;
        loop {
            {
                let mut child_guard = handle.child.lock().await;
                if let Some(child) = child_guard.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let exit_code = status.code().unwrap_or(-1);
                            let next_state = {
                                let state = handle.state.lock().await;
                                if state.state == "cancelled" {
                                    "cancelled"
                                } else if state.timed_out {
                                    "timeout"
                                } else if exit_code == 0 {
                                    "done"
                                } else {
                                    "error"
                                }
                            };
                            finalize_inner(
                                inner.clone(),
                                &handle,
                                next_state,
                                if next_state == "done" {
                                    Some("end_turn".to_string())
                                } else {
                                    Some(next_state.to_string())
                                },
                                Some(if exit_code == 0 {
                                    "ACP session completed".to_string()
                                } else {
                                    format!("ACP session exited with code {exit_code}")
                                }),
                                Some(exit_code),
                            )
                            .await;
                            *child_guard = None;
                            return;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            finalize_inner(
                                inner.clone(),
                                &handle,
                                "error",
                                Some("process_error".to_string()),
                                Some(error.to_string()),
                                Some(-1),
                            )
                            .await;
                            *child_guard = None;
                            return;
                        }
                    }

                    if Instant::now() >= timeout_deadline {
                        let mut state = handle.state.lock().await;
                        if state.state == "running" && !state.timed_out {
                            state.timed_out = true;
                            drop(state);
                            finalize_inner(
                                inner.clone(),
                                &handle,
                                "timeout",
                                Some("timeout".to_string()),
                                Some(format!("ACP session timed out after {timeout_ms}ms")),
                                None,
                            )
                            .await;
                            let _ = terminate_child_tree(child, false).await;
                            kill_deadline =
                                Some(Instant::now() + Duration::from_millis(KILL_DELAY_MS));
                        }
                    }

                    if let Some(deadline) = kill_deadline {
                        if Instant::now() >= deadline {
                            let _ = terminate_child_tree(child, true).await;
                            kill_deadline = None;
                        }
                    }
                } else {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    });
}

async fn push_event_inner(inner: Arc<AcpInner>, handle: &Arc<SessionHandle>, mut event: AcpEvent) {
    event.cursor = inner.next_cursor.fetch_add(1, Ordering::SeqCst);
    event.session_id = handle.state.lock().await.session_id.clone();
    event.emitted_at = now_millis();
    let mut events = inner.events.write().await;
    events.push(event);
    if events.len() > MAX_EVENT_COUNT {
        let excess = events.len() - MAX_EVENT_COUNT;
        events.drain(0..excess);
    }
}

async fn finalize_inner(
    inner: Arc<AcpInner>,
    handle: &Arc<SessionHandle>,
    next_state: &str,
    code: Option<String>,
    message: Option<String>,
    exit_code: Option<i32>,
) {
    let turn_id = {
        let mut state = handle.state.lock().await;
        if state.terminal_emitted {
            return;
        }
        state.state = next_state.to_string();
        state.finished_at = Some(now_millis());
        state.terminal_emitted = true;
        let persisted = state_to_persisted(&state);
        inner
            .history
            .write()
            .await
            .insert(persisted.session_id.clone(), persisted);
        state.current_turn_id.clone()
    };
    persist_acp_snapshot(&inner).await;
    push_event_inner(
        inner,
        handle,
        AcpEvent {
            cursor: 0,
            session_id: String::new(),
            emitted_at: 0,
            event_type: "terminal".to_string(),
            turn_id,
            text: None,
            status_code: None,
            code,
            message,
            exit_code,
        },
    )
    .await;
}

async fn spawn_command(
    command: &CommandSpec,
    cwd: &str,
    env: Option<BTreeMap<String, String>>,
) -> Result<Child> {
    let mut builder = match command {
        CommandSpec::Args(args) => {
            if args.is_empty() {
                bail!("ACP command array cannot be empty");
            }
            let mut command = Command::new(&args[0]);
            command.args(&args[1..]);
            command
        }
        CommandSpec::Shell(command_text) => {
            if cfg!(windows) {
                let mut command = Command::new(
                    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
                );
                command.args(["/d", "/s", "/c", command_text]);
                command
            } else {
                let mut command = Command::new(
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()),
                );
                command.args(["-lc", command_text]);
                command
            }
        }
    };

    builder.current_dir(cwd);
    if let Some(env) = env {
        builder.envs(env);
    }
    builder.stdin(Stdio::piped());
    builder.stdout(Stdio::piped());
    builder.stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use nix::libc;
        unsafe {
            builder.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }

    builder.spawn().context("Failed to spawn ACP child process")
}

fn clamp_timeout(value: Option<u64>, tier: RunTier) -> u64 {
    value
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, tier.max_timeout_ms(MAX_TIMEOUT_MS))
}

fn state_to_persisted(state: &SessionState) -> PersistedAcpSession {
    PersistedAcpSession {
        session_id: state.session_id.clone(),
        agent_type: state.agent_type.clone(),
        state: state.state.clone(),
        cwd: state.cwd.clone(),
        command: state.command.clone(),
        origin: state.origin.clone(),
        input_provenance: state.input_provenance.clone(),
        created_at: state.created_at,
        started_at: state.started_at,
        finished_at: state.finished_at,
        current_turn_id: state.current_turn_id.clone(),
        run_id: state.run_id.clone(),
        runtime_session_id: state.runtime_session_id.clone(),
        tier: state.tier,
        timed_out: state.timed_out,
        orphan_reason: None,
    }
}

fn snapshot_from_persisted(session: &PersistedAcpSession) -> AcpSessionSnapshot {
    AcpSessionSnapshot {
        session_id: session.session_id.clone(),
        agent_type: session.agent_type.clone(),
        state: session.state.clone(),
        cwd: session.cwd.clone(),
        command: session.command.clone(),
        origin: session.origin.clone(),
        input_provenance: session.input_provenance.clone(),
        created_at: session.created_at,
        started_at: session.started_at,
        finished_at: session.finished_at,
        current_turn_id: session.current_turn_id.clone(),
        run_id: session.run_id.clone(),
        queue_depth: 0,
        terminal_emitted: true,
        runtime_session_id: session.runtime_session_id.clone(),
    }
}

async fn persist_acp_snapshot(inner: &Arc<AcpInner>) {
    let Some(persistence) = inner.persistence.as_ref() else {
        return;
    };
    let mut combined: Vec<PersistedAcpSession> = Vec::new();
    {
        let sessions = inner.sessions.read().await;
        for handle in sessions.values() {
            let state = handle.state.lock().await;
            combined.push(state_to_persisted(&state));
        }
    }
    {
        let history = inner.history.read().await;
        for (id, persisted) in history.iter() {
            if !combined.iter().any(|item| item.session_id == *id) {
                combined.push(persisted.clone());
            }
        }
    }
    if let Err(err) = persistence.save(&combined) {
        tracing::warn!(
            target: "companion_acp",
            error = %err,
            "Failed to persist ACP session snapshot"
        );
    }
}

fn normalize_object(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::Object(map)) if !map.is_empty() => Some(Value::Object(map)),
        _ => None,
    }
}

fn default_cwd() -> String {
    std::env::current_dir()
        .unwrap_or_else(|_| ".".into())
        .to_string_lossy()
        .to_string()
}

fn trim_optional(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_status_text(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.trim().to_string()
}

fn is_permission_related_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("permission")
        || lower.contains("approve")
        || lower.contains("approval")
        || lower.contains("trust")
        || lower.contains("not granted")
        || lower.contains("granted")
}

fn generate_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn generate_short_id() -> String {
    let mut bytes = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn terminate_child_tree(child: &mut Child, force: bool) -> Result<()> {
    let Some(pid) = child.id() else {
        bail!("ACP child process is unavailable");
    };
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let signal = if force {
            Signal::SIGKILL
        } else {
            Signal::SIGTERM
        };
        kill(Pid::from_raw(-(pid as i32)), signal)
            .or_else(|_| kill(Pid::from_raw(pid as i32), signal))
            .map_err(|error| anyhow!(error.to_string()))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let status = if force {
            Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .status()
                .await
                .context("Failed to invoke taskkill")?
        } else {
            Command::new("taskkill")
                .args(["/T", "/PID", &pid.to_string()])
                .status()
                .await
                .context("Failed to invoke taskkill")?
        };
        if status.success() {
            Ok(())
        } else {
            bail!("taskkill exited with status {}", status)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn session_prompt_runs_command_and_reaches_done() {
        let manager = AcpManager::new();
        let session = manager
            .create_session(CreateSessionInput {
                agent_type: Some("raw".to_string()),
                command: Some(CommandSpec::Args(vec![
                    "node".to_string(),
                    "-e".to_string(),
                    "process.stdin.on('data',()=>{console.log(JSON.stringify({type:'message_stop'}));process.exit(0)})"
                        .to_string(),
                ])),
                ..CreateSessionInput::default()
            })
            .await;
        let ack = manager
            .enqueue_prompt(
                &session.session_id,
                PromptInput {
                    prompt: Some("hello".to_string()),
                    ..PromptInput::default()
                },
            )
            .await
            .unwrap();
        assert!(ack.ok);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = manager.get_session(&session.session_id).await.unwrap();
            if snapshot.state == "done" {
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn permission_stderr_emits_awaiting_approval_event() {
        let manager = AcpManager::new();
        let session = manager
            .create_session(CreateSessionInput {
                agent_type: Some("raw".to_string()),
                command: Some(CommandSpec::Args(vec![
                    "node".to_string(),
                    "-e".to_string(),
                    "process.stderr.write('Requested permissions were not granted yet.\\n');process.stdin.on('data',()=>setTimeout(()=>process.exit(0),200));"
                        .to_string(),
                ])),
                ..CreateSessionInput::default()
            })
            .await;
        manager
            .enqueue_prompt(
                &session.session_id,
                PromptInput {
                    prompt: Some("inspect".to_string()),
                    ..PromptInput::default()
                },
            )
            .await
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let events = manager
                .list_session_events(&session.session_id, SessionEventsQuery::default())
                .await;
            if events
                .events
                .iter()
                .any(|event| event.status_code.as_deref() == Some("awaiting_approval"))
            {
                return;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
