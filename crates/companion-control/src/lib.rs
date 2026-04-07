use anyhow::{Context, Result};
use companion_config::get_config_dir;
use companion_shared::RUN_CONTRACT_VERSION;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

const DEFAULT_MAX_RUNS: usize = 200;
const DEFAULT_APPROVAL_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_APPROVALS: usize = 500;
const DEFAULT_APPROVAL_TTL_MS: u64 = 120_000;

const RUN_TYPES: &[&str] = &["exec", "session", "cron", "heartbeat", "acp", "approval"];
const RUN_STATES: &[&str] = &[
    "queued",
    "idle",
    "running",
    "waiting_approval",
    "retrying",
    "done",
    "failed",
    "cancelled",
];
const RUN_SOURCES: &[&str] = &["chat", "cron", "heartbeat", "remote", "replay"];
const APPROVAL_STATUSES: &[&str] = &["pending", "approved", "rejected", "expired"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub state: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_state: Option<DeliveryState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    pub contract_version: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordView {
    #[serde(flatten)]
    pub run: RunRecord,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunLink {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_request_id: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RunSnapshot {
    #[serde(default)]
    runs: Vec<RunRecord>,
    #[serde(default)]
    session_links: BTreeMap<String, RunLink>,
    #[serde(default)]
    action_links: BTreeMap<String, RunLink>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateRunInput {
    pub run_id: Option<String>,
    pub run_type: Option<String>,
    pub state: Option<String>,
    pub created_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub meta: Option<Map<String, Value>>,
    pub delivery_state: Option<DeliveryState>,
    pub session_id: Option<String>,
    pub session_type: Option<String>,
    pub attempt_id: Option<String>,
    pub lane_id: Option<String>,
    pub source: Option<String>,
    pub parent_run_id: Option<String>,
    pub contract_version: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct RunListQuery {
    pub run_type: Option<String>,
    pub state: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct RunLinkInput {
    pub run_type: Option<String>,
    pub conversation_id: Option<String>,
    pub source_tool_name: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub approval_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunListResult {
    pub runs: Vec<RunRecordView>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunTypeSummary {
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub active: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunWindowSummary {
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub completion_rate: Option<f64>,
    pub avg_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunHistorySummaryItem {
    pub run_id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub state: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunDiagnostics {
    pub ok: bool,
    pub sampled: usize,
    pub total_runs: usize,
    pub completion_rate: Option<f64>,
    pub avg_duration_ms: Option<u64>,
    pub p95_duration_ms: Option<u64>,
    pub by_type: BTreeMap<String, RunTypeSummary>,
    pub windows: BTreeMap<String, RunWindowSummary>,
    pub recent: Vec<RunRecordView>,
    pub history_summary: Vec<RunHistorySummaryItem>,
    pub generated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub request_id: String,
    pub conversation_id: String,
    pub tool_name: String,
    pub tool_preview: String,
    pub risk_level: String,
    #[serde(default)]
    pub channels: Vec<String>,
    pub status: String,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateApprovalInput {
    pub request_id: Option<String>,
    pub conversation_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_preview: Option<String>,
    pub risk_level: Option<String>,
    pub channels: Option<Vec<String>>,
    pub expires_at: Option<u64>,
    pub meta: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ApprovalSnapshot {
    #[serde(default)]
    approvals: Vec<ApprovalRecord>,
}

#[derive(Debug, Clone)]
pub struct RunStore {
    inner: Arc<Mutex<RunStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
    max_runs: usize,
}

#[derive(Debug, Default)]
struct RunStoreInner {
    loaded: bool,
    snapshot: RunSnapshot,
}

#[derive(Debug, Clone)]
pub struct ApprovalStore {
    inner: Arc<Mutex<ApprovalStoreInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
    max_approvals: usize,
    resolved_retention_ms: u64,
}

#[derive(Debug, Default)]
struct ApprovalStoreInner {
    loaded: bool,
    snapshot: ApprovalSnapshot,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawRunRecord {
    #[serde(default)]
    run_id: String,
    #[serde(default, rename = "type")]
    run_type: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    updated_at: Option<u64>,
    #[serde(default)]
    started_at: Option<u64>,
    #[serde(default)]
    finished_at: Option<u64>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    meta: Option<Value>,
    #[serde(default)]
    delivery_state: Option<DeliveryState>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_type: Option<String>,
    #[serde(default)]
    attempt_id: Option<String>,
    #[serde(default)]
    lane_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    parent_run_id: Option<String>,
    #[serde(default)]
    contract_version: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawRunLink {
    #[serde(default)]
    run_id: String,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    source_tool_name: Option<String>,
    #[serde(default)]
    source_tool_call_id: Option<String>,
    #[serde(default)]
    approval_request_id: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawRunSnapshot {
    #[serde(default)]
    runs: Vec<RawRunRecord>,
    #[serde(default)]
    session_links: BTreeMap<String, RawRunLink>,
    #[serde(default)]
    action_links: BTreeMap<String, RawRunLink>,
}

impl RunStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(RunStoreInner::default())),
            primary_path: config_dir.join("runs.json"),
            backup_path: config_dir.join("runs.json.bak"),
            max_runs: read_usize_env("TRAPEZOHE_MAX_RUNS", DEFAULT_MAX_RUNS).max(1),
        }
    }

    pub fn create_run(&self, input: CreateRunInput) -> Result<RunRecord> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let now = now_millis();
        let record = normalize_run_raw(RawRunRecord {
            run_id: input.run_id.unwrap_or_else(generate_hex_id),
            run_type: input.run_type.unwrap_or_else(|| "exec".to_string()),
            state: input.state.unwrap_or_else(|| "queued".to_string()),
            created_at: Some(input.created_at.unwrap_or(now)),
            updated_at: Some(input.updated_at.unwrap_or(now)),
            started_at: input.started_at,
            finished_at: input.finished_at,
            summary: input.summary,
            error: input.error,
            meta: input.meta.map(Value::Object),
            delivery_state: input.delivery_state,
            session_id: input.session_id,
            session_type: input.session_type,
            attempt_id: input.attempt_id,
            lane_id: input.lane_id,
            source: input.source,
            parent_run_id: input.parent_run_id,
            contract_version: input.contract_version,
        })
        .context("Failed to normalize run input")?;
        inner.snapshot.runs.push(record.clone());
        trim_runs(&mut inner.snapshot.runs, self.max_runs);
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(record)
    }

    pub fn update_run<F>(&self, run_id: &str, apply: F) -> Result<Option<RunRecord>>
    where
        F: FnOnce(&mut RunRecord),
    {
        let normalized_id = trim_non_empty(run_id);
        if normalized_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let Some(index) = inner
            .snapshot
            .runs
            .iter()
            .position(|item| item.run_id == normalized_id)
        else {
            return Ok(None);
        };
        let current = inner.snapshot.runs[index].clone();
        let mut next = current.clone();
        apply(&mut next);
        next.run_id = current.run_id.clone();
        next.created_at = current.created_at;
        next.updated_at = now_millis();
        if matches!(next.state.as_str(), "running" | "retrying") && next.started_at.is_none() {
            next.started_at = Some(next.updated_at);
        }
        if matches!(next.state.as_str(), "done" | "failed") && next.finished_at.is_none() {
            next.finished_at = Some(next.updated_at);
        }
        let normalized = normalize_run_raw(run_record_to_raw(&next))
            .context("Failed to normalize run update")?;
        inner.snapshot.runs[index] = normalized.clone();
        trim_runs(&mut inner.snapshot.runs, self.max_runs);
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(Some(normalized))
    }

    pub fn list_runs(&self, query: RunListQuery) -> Result<RunListResult> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let run_type = query
            .run_type
            .as_deref()
            .map(normalize_type_filter)
            .transpose()?;
        let state = query
            .state
            .as_deref()
            .map(normalize_state_filter)
            .transpose()?;
        let limit = query.limit.unwrap_or(50).clamp(1, 500);
        let offset = query.offset.unwrap_or(0);
        let mut filtered = inner
            .snapshot
            .runs
            .iter()
            .filter(|run| {
                let type_match = run_type
                    .as_deref()
                    .map(|value| value == run.r#type)
                    .unwrap_or(true);
                let state_match = state
                    .as_deref()
                    .map(|value| value == run.state)
                    .unwrap_or(true);
                type_match && state_match
            })
            .cloned()
            .collect::<Vec<_>>();
        filtered.sort_by(sort_runs_desc);
        let total = filtered.len();
        let runs = filtered
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(run_view)
            .collect::<Vec<_>>();
        Ok(RunListResult {
            has_more: offset + runs.len() < total,
            runs,
            total,
            offset,
            limit,
        })
    }

    pub fn get_run_record(&self, run_id: &str) -> Result<Option<RunRecord>> {
        let normalized_id = trim_non_empty(run_id);
        if normalized_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner
            .snapshot
            .runs
            .iter()
            .find(|run| run.run_id == normalized_id)
            .cloned())
    }

    pub fn get_run_by_id(&self, run_id: &str) -> Result<Option<RunRecordView>> {
        Ok(self.get_run_record(run_id)?.map(|run| run_view(run)))
    }

    pub fn get_run_diagnostics(&self, limit: Option<usize>) -> Result<RunDiagnostics> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let limit = limit.unwrap_or(100).clamp(1, 500);
        let recent_detail_count = 10_usize;
        let mut sorted = inner.snapshot.runs.clone();
        sorted.sort_by(sort_runs_desc);
        let sorted = sorted.into_iter().take(limit).collect::<Vec<_>>();
        let views = sorted.iter().cloned().map(run_view).collect::<Vec<_>>();
        let durations = views
            .iter()
            .filter(|view| matches!(view.run.state.as_str(), "done" | "failed"))
            .filter_map(|view| view.duration_ms)
            .collect::<Vec<_>>();
        let completed = views
            .iter()
            .filter(|view| matches!(view.run.state.as_str(), "done" | "failed"))
            .count();
        let failed = views
            .iter()
            .filter(|view| view.run.state == "failed")
            .count();
        let recent = views
            .iter()
            .take(recent_detail_count)
            .cloned()
            .collect::<Vec<_>>();
        let history_summary = views
            .iter()
            .skip(recent_detail_count)
            .map(|view| RunHistorySummaryItem {
                run_id: view.run.run_id.clone(),
                r#type: view.run.r#type.clone(),
                state: view.run.state.clone(),
                created_at: view.run.created_at,
                finished_at: view.run.finished_at,
                duration_ms: view.duration_ms,
                error: view
                    .run
                    .error
                    .clone()
                    .map(|value| truncate_text(&value, 80))
                    .flatten(),
            })
            .collect::<Vec<_>>();

        let mut by_type = BTreeMap::new();
        for view in &views {
            let entry = by_type
                .entry(view.run.r#type.clone())
                .or_insert_with(RunTypeSummary::default);
            entry.total += 1;
            match view.run.state.as_str() {
                "done" => entry.done += 1,
                "failed" => entry.failed += 1,
                _ => entry.active += 1,
            }
        }

        let mut windows = BTreeMap::new();
        windows.insert("1h".to_string(), summarize_window(&views, 3_600_000));
        windows.insert("6h".to_string(), summarize_window(&views, 21_600_000));
        windows.insert("24h".to_string(), summarize_window(&views, 86_400_000));

        Ok(RunDiagnostics {
            ok: true,
            sampled: views.len(),
            total_runs: inner.snapshot.runs.len(),
            completion_rate: completion_rate(completed, failed),
            avg_duration_ms: average_duration(&durations),
            p95_duration_ms: percentile(&durations, 95),
            by_type,
            windows,
            recent,
            history_summary,
            generated_at: now_millis(),
        })
    }

    pub fn set_session_run_link(
        &self,
        session_id: &str,
        run_id: &str,
        input: RunLinkInput,
    ) -> Result<Option<RunLink>> {
        let normalized_session_id = trim_non_empty(session_id);
        let normalized_run_id = trim_non_empty(run_id);
        if normalized_session_id.is_empty() || normalized_run_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let link = RunLink {
            run_id: normalized_run_id,
            r#type: input.run_type.and_then(|value| trim_optional(value)),
            conversation_id: input.conversation_id.and_then(|value| trim_optional(value)),
            source_tool_name: input
                .source_tool_name
                .and_then(|value| trim_optional(value)),
            source_tool_call_id: input
                .source_tool_call_id
                .and_then(|value| trim_optional(value)),
            approval_request_id: input
                .approval_request_id
                .and_then(|value| trim_optional(value)),
            updated_at: now_millis(),
        };
        inner
            .snapshot
            .session_links
            .insert(normalized_session_id, link.clone());
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(Some(link))
    }

    pub fn get_session_run_link(&self, session_id: &str) -> Result<Option<RunLink>> {
        let normalized_session_id = trim_non_empty(session_id);
        if normalized_session_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner
            .snapshot
            .session_links
            .get(&normalized_session_id)
            .cloned())
    }

    pub fn clear_session_run_link(&self, session_id: &str) -> Result<bool> {
        let normalized_session_id = trim_non_empty(session_id);
        if normalized_session_id.is_empty() {
            return Ok(false);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let removed = inner
            .snapshot
            .session_links
            .remove(&normalized_session_id)
            .is_some();
        if removed {
            persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        }
        Ok(removed)
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = RunSnapshot::default();
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut RunStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        let raw = load_run_snapshot(&self.primary_path, &self.backup_path)?;
        inner.snapshot = raw;
        trim_runs(&mut inner.snapshot.runs, self.max_runs);
        inner.loaded = true;
        Ok(())
    }
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(ApprovalStoreInner::default())),
            primary_path: config_dir.join("approvals.json"),
            backup_path: config_dir.join("approvals.json.bak"),
            max_approvals: DEFAULT_MAX_APPROVALS,
            resolved_retention_ms: DEFAULT_APPROVAL_RETENTION_MS,
        }
    }

    pub fn create_approval(&self, input: CreateApprovalInput) -> Result<ApprovalRecord> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let request_id = trim_optional(input.request_id.unwrap_or_else(generate_hex_id))
            .unwrap_or_else(generate_hex_id);
        if let Some(index) = inner
            .snapshot
            .approvals
            .iter()
            .rposition(|approval| approval.request_id == request_id)
        {
            let current = inner.snapshot.approvals[index].clone();
            let next = ApprovalRecord {
                request_id: request_id.clone(),
                conversation_id: if !current.conversation_id.is_empty() {
                    current.conversation_id.clone()
                } else {
                    trim_non_empty(input.conversation_id.unwrap_or_default())
                },
                tool_name: if !current.tool_name.is_empty() {
                    current.tool_name.clone()
                } else {
                    trim_non_empty(input.tool_name.unwrap_or_default())
                },
                tool_preview: if !current.tool_preview.is_empty() {
                    current.tool_preview.clone()
                } else {
                    trim_preview(input.tool_preview)
                },
                risk_level: if !current.risk_level.is_empty() {
                    current.risk_level.clone()
                } else {
                    trim_optional(input.risk_level.unwrap_or_else(|| "medium".to_string()))
                        .unwrap_or_else(|| "medium".to_string())
                },
                channels: if !current.channels.is_empty() {
                    current.channels.clone()
                } else {
                    normalize_channels(input.channels)
                },
                status: normalize_approval_status(&current.status, "pending"),
                created_at: if current.created_at > 0 {
                    current.created_at
                } else {
                    now_millis()
                },
                expires_at: if current.expires_at > 0 {
                    current.expires_at
                } else {
                    input
                        .expires_at
                        .unwrap_or_else(|| now_millis() + DEFAULT_APPROVAL_TTL_MS)
                },
                resolved_at: current.resolved_at,
                resolved_by: current.resolved_by.clone(),
                meta: merge_meta_preserving_canonical(
                    &request_id,
                    current.meta.as_ref(),
                    input.meta.as_ref(),
                ),
            };
            inner.snapshot.approvals[index] = next.clone();
            prune_approvals(
                &mut inner.snapshot.approvals,
                self.max_approvals,
                self.resolved_retention_ms,
            );
            persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
            return Ok(next);
        }

        let record = ApprovalRecord {
            request_id: request_id.clone(),
            conversation_id: trim_non_empty(input.conversation_id.unwrap_or_default()),
            tool_name: trim_non_empty(input.tool_name.unwrap_or_default()),
            tool_preview: trim_preview(input.tool_preview),
            risk_level: trim_optional(input.risk_level.unwrap_or_else(|| "medium".to_string()))
                .unwrap_or_else(|| "medium".to_string()),
            channels: normalize_channels(input.channels),
            status: "pending".to_string(),
            created_at: now_millis(),
            expires_at: input
                .expires_at
                .unwrap_or_else(|| now_millis() + DEFAULT_APPROVAL_TTL_MS),
            resolved_at: None,
            resolved_by: None,
            meta: merge_meta_preserving_canonical(&request_id, None, input.meta.as_ref()),
        };
        inner.snapshot.approvals.push(record.clone());
        prune_approvals(
            &mut inner.snapshot.approvals,
            self.max_approvals,
            self.resolved_retention_ms,
        );
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(record)
    }

    pub fn relink_approval_run(
        &self,
        request_id: &str,
        run_id: &str,
    ) -> Result<Option<ApprovalRecord>> {
        let normalized_request_id = trim_non_empty(request_id);
        let normalized_run_id = trim_non_empty(run_id);
        if normalized_request_id.is_empty() || normalized_run_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let Some(index) = inner
            .snapshot
            .approvals
            .iter()
            .rposition(|approval| approval.request_id == normalized_request_id)
        else {
            return Ok(None);
        };
        let current = inner.snapshot.approvals[index].clone();
        let mut incoming = Map::new();
        incoming.insert("runId".to_string(), Value::String(normalized_run_id));
        let next = ApprovalRecord {
            meta: merge_meta_preserving_canonical(
                &current.request_id,
                current.meta.as_ref(),
                Some(&incoming),
            ),
            ..current
        };
        inner.snapshot.approvals[index] = next.clone();
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(Some(next))
    }

    pub fn resolve_approval(
        &self,
        request_id: &str,
        resolution: &str,
        resolved_by: Option<String>,
    ) -> Result<Option<ApprovalRecord>> {
        let normalized_request_id = trim_non_empty(request_id);
        if normalized_request_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let Some(index) = inner
            .snapshot
            .approvals
            .iter()
            .rposition(|approval| approval.request_id == normalized_request_id)
        else {
            return Ok(None);
        };
        let current = inner.snapshot.approvals[index].clone();
        if current.status != "pending" {
            return Ok(Some(current));
        }
        let next = ApprovalRecord {
            status: normalize_approval_status(resolution, "rejected"),
            resolved_at: Some(now_millis()),
            resolved_by: resolved_by.and_then(trim_optional),
            ..current
        };
        inner.snapshot.approvals[index] = next.clone();
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(Some(next))
    }

    pub fn get_approval_by_id(&self, request_id: &str) -> Result<Option<ApprovalRecord>> {
        let normalized_request_id = trim_non_empty(request_id);
        if normalized_request_id.is_empty() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(inner
            .snapshot
            .approvals
            .iter()
            .rev()
            .find(|approval| approval.request_id == normalized_request_id)
            .cloned())
    }

    pub fn list_pending_approvals(&self) -> Result<Vec<ApprovalRecord>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let cutoff = now_millis();
        Ok(inner
            .snapshot
            .approvals
            .iter()
            .filter(|approval| approval.status == "pending" && approval.expires_at > cutoff)
            .cloned()
            .collect())
    }

    pub fn expire_overdue_approvals(&self) -> Result<Vec<ApprovalRecord>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let cutoff = now_millis();
        let mut expired = Vec::new();
        let mut changed = false;
        for approval in &mut inner.snapshot.approvals {
            if approval.status == "pending" && approval.expires_at <= cutoff {
                approval.status = "expired".to_string();
                approval.resolved_at = Some(cutoff);
                expired.push(approval.clone());
                changed = true;
            }
        }
        if changed {
            persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        }
        Ok(expired)
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = ApprovalSnapshot::default();
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut ApprovalStoreInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_approval_snapshot(&self.primary_path, &self.backup_path)?;
        prune_approvals(
            &mut inner.snapshot.approvals,
            self.max_approvals,
            self.resolved_retention_ms,
        );
        inner.loaded = true;
        Ok(())
    }
}

fn load_run_snapshot(primary: &Path, backup: &Path) -> Result<RunSnapshot> {
    match load_json::<RawRunSnapshot>(primary) {
        Ok(Some(snapshot)) => return Ok(normalize_run_snapshot(snapshot)),
        Ok(None) | Err(_) => {}
    }
    match load_json::<RawRunSnapshot>(backup) {
        Ok(Some(snapshot)) => return Ok(normalize_run_snapshot(snapshot)),
        Ok(None) | Err(_) => {}
    }
    Ok(RunSnapshot::default())
}

fn load_approval_snapshot(primary: &Path, backup: &Path) -> Result<ApprovalSnapshot> {
    match load_json::<ApprovalSnapshot>(primary) {
        Ok(Some(snapshot)) => return Ok(snapshot),
        Ok(None) | Err(_) => {}
    }
    match load_json::<ApprovalSnapshot>(backup) {
        Ok(Some(snapshot)) => return Ok(snapshot),
        Ok(None) | Err(_) => {}
    }
    Ok(ApprovalSnapshot::default())
}

fn load_json<T>(path: &Path) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read snapshot: {}", path.display()))?;
    let parsed = serde_json::from_str::<T>(&raw)
        .with_context(|| format!("Failed to parse snapshot: {}", path.display()))?;
    Ok(Some(parsed))
}

fn persist_json_snapshot<T>(primary: &Path, backup: &Path, snapshot: &T) -> Result<()>
where
    T: Serialize,
{
    ensure_parent_dir(primary)?;
    let payload = serde_json::to_string_pretty(snapshot)? + "\n";
    atomic_write(primary, payload.as_bytes())?;
    atomic_write(backup, payload.as_bytes())?;
    Ok(())
}

fn normalize_run_snapshot(raw: RawRunSnapshot) -> RunSnapshot {
    let runs = raw
        .runs
        .into_iter()
        .filter_map(|record| normalize_run_raw(record).ok())
        .collect::<Vec<_>>();
    let session_links = raw
        .session_links
        .into_iter()
        .filter_map(|(key, value)| {
            normalize_run_link(&key, value).map(|link| (trim_non_empty(key), link))
        })
        .filter(|(key, _)| !key.is_empty())
        .collect::<BTreeMap<_, _>>();
    let action_links = raw
        .action_links
        .into_iter()
        .filter_map(|(key, value)| {
            normalize_run_link(&key, value).map(|link| (trim_non_empty(key), link))
        })
        .filter(|(key, _)| !key.is_empty())
        .collect::<BTreeMap<_, _>>();
    RunSnapshot {
        runs,
        session_links,
        action_links,
    }
}

fn normalize_run_link(key: &str, raw: RawRunLink) -> Option<RunLink> {
    if trim_non_empty(key).is_empty() {
        return None;
    }
    let run_id = trim_non_empty(raw.run_id);
    if run_id.is_empty() {
        return None;
    }
    Some(RunLink {
        run_id,
        r#type: raw.r#type.and_then(trim_optional),
        conversation_id: raw.conversation_id.and_then(trim_optional),
        source_tool_name: raw.source_tool_name.and_then(trim_optional),
        source_tool_call_id: raw.source_tool_call_id.and_then(trim_optional),
        approval_request_id: raw.approval_request_id.and_then(trim_optional),
        updated_at: raw.updated_at.unwrap_or_else(now_millis),
    })
}

fn normalize_run_raw(raw: RawRunRecord) -> Result<RunRecord> {
    let run_id = trim_non_empty(raw.run_id);
    if run_id.is_empty() {
        anyhow::bail!("runId is required");
    }
    let created_at = raw.created_at.unwrap_or_else(now_millis);
    let updated_at = raw.updated_at.unwrap_or(created_at);
    let started_at = raw.started_at;
    let finished_at = raw.finished_at;
    let meta_map = value_to_object_map(raw.meta);
    let session_id = raw
        .session_id
        .and_then(trim_optional)
        .or_else(|| object_string(meta_map.as_ref(), "sessionId"));
    let session_type = raw
        .session_type
        .and_then(normalize_session_type)
        .or_else(|| {
            object_string(meta_map.as_ref(), "sessionType").and_then(normalize_session_type)
        });
    let has_v2_fields = session_id.is_some()
        || session_type.is_some()
        || raw
            .attempt_id
            .as_ref()
            .and_then(|value| trim_optional(value.clone()))
            .is_some()
        || raw
            .lane_id
            .as_ref()
            .and_then(|value| trim_optional(value.clone()))
            .is_some()
        || raw
            .source
            .as_ref()
            .and_then(|value| normalize_run_source(value))
            .is_some()
        || raw
            .parent_run_id
            .as_ref()
            .and_then(|value| trim_optional(value.clone()))
            .is_some()
        || raw.contract_version.unwrap_or_default() >= RUN_CONTRACT_VERSION;
    let contract_version = normalize_contract_version(raw.contract_version, has_v2_fields);
    let attempt_id = raw.attempt_id.and_then(trim_optional).or_else(|| {
        if contract_version >= RUN_CONTRACT_VERSION {
            Some(format!("{run_id}:attempt-1"))
        } else {
            None
        }
    });
    let state_fallback = if finished_at.is_some() {
        if finished_at.unwrap_or_default() > 0 && started_at.is_some() {
            "done"
        } else {
            "failed"
        }
    } else {
        "queued"
    };
    let mut meta = meta_map.unwrap_or_default();
    if let Some(value) = &session_id {
        meta.entry("sessionId".to_string())
            .or_insert_with(|| Value::String(value.clone()));
    }
    if let Some(value) = &session_type {
        meta.entry("sessionType".to_string())
            .or_insert_with(|| Value::String(value.clone()));
    }
    let meta = if meta.is_empty() { None } else { Some(meta) };
    Ok(RunRecord {
        run_id,
        r#type: normalize_known_value(raw.run_type, RUN_TYPES, "exec"),
        state: normalize_known_value(raw.state, RUN_STATES, state_fallback),
        created_at,
        updated_at,
        started_at,
        finished_at,
        summary: truncate_text_opt(raw.summary, 500),
        error: truncate_text_opt(raw.error, 500),
        meta,
        delivery_state: raw.delivery_state.and_then(normalize_delivery_state),
        session_id,
        session_type,
        attempt_id,
        lane_id: raw.lane_id.and_then(trim_optional),
        source: raw
            .source
            .as_ref()
            .and_then(|value| normalize_run_source(value)),
        parent_run_id: raw.parent_run_id.and_then(trim_optional),
        contract_version,
    })
}

fn run_record_to_raw(record: &RunRecord) -> RawRunRecord {
    RawRunRecord {
        run_id: record.run_id.clone(),
        run_type: record.r#type.clone(),
        state: record.state.clone(),
        created_at: Some(record.created_at),
        updated_at: Some(record.updated_at),
        started_at: record.started_at,
        finished_at: record.finished_at,
        summary: record.summary.clone(),
        error: record.error.clone(),
        meta: record.meta.clone().map(Value::Object),
        delivery_state: record.delivery_state.clone(),
        session_id: record.session_id.clone(),
        session_type: record.session_type.clone(),
        attempt_id: record.attempt_id.clone(),
        lane_id: record.lane_id.clone(),
        source: record.source.clone(),
        parent_run_id: record.parent_run_id.clone(),
        contract_version: Some(record.contract_version),
    }
}

fn normalize_delivery_state(state: DeliveryState) -> Option<DeliveryState> {
    let channel = state.channel.and_then(trim_optional);
    let attempts = state.attempts;
    let last_attempt_at = state.last_attempt_at;
    if channel.is_none() && attempts.is_none() && last_attempt_at.is_none() {
        return None;
    }
    Some(DeliveryState {
        channel,
        attempts,
        last_attempt_at,
    })
}

fn normalize_contract_version(explicit: Option<u32>, has_v2_fields: bool) -> u32 {
    match explicit.unwrap_or_default() {
        value if value >= RUN_CONTRACT_VERSION => RUN_CONTRACT_VERSION,
        1 => 1,
        _ if has_v2_fields => RUN_CONTRACT_VERSION,
        _ => 1,
    }
}

fn normalize_session_type(value: String) -> Option<String> {
    let normalized = trim_non_empty(value);
    if normalized.is_empty() {
        return None;
    }
    if normalized == "chat/main"
        || normalized.starts_with("workflow/")
        || normalized.starts_with("automation/")
        || normalized.starts_with("acp/")
    {
        return Some(normalized);
    }
    None
}

fn normalize_run_source(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    if RUN_SOURCES.contains(&normalized.as_str()) {
        Some(normalized)
    } else {
        None
    }
}

fn normalize_known_value(value: String, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if allowed.contains(&normalized.as_str()) {
        normalized
    } else {
        fallback.to_string()
    }
}

fn normalize_type_filter(value: &str) -> Result<String> {
    let normalized = value.trim().to_lowercase();
    if RUN_TYPES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        anyhow::bail!("type must be one of: exec, session, cron, heartbeat, acp, approval")
    }
}

fn normalize_state_filter(value: &str) -> Result<String> {
    let normalized = value.trim().to_lowercase();
    if RUN_STATES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        anyhow::bail!(
            "state must be one of: queued, idle, running, waiting_approval, retrying, done, failed, cancelled"
        )
    }
}

fn normalize_approval_status(value: &str, fallback: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if APPROVAL_STATUSES.contains(&normalized.as_str()) {
        normalized
    } else {
        fallback.to_string()
    }
}

fn normalize_channels(channels: Option<Vec<String>>) -> Vec<String> {
    let normalized = channels
        .unwrap_or_else(|| vec!["sidepanel".to_string()])
        .into_iter()
        .filter_map(trim_optional)
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        vec!["sidepanel".to_string()]
    } else {
        normalized
    }
}

fn merge_meta_preserving_canonical(
    request_id: &str,
    current: Option<&Map<String, Value>>,
    incoming: Option<&Map<String, Value>>,
) -> Option<Map<String, Value>> {
    let canonical = resolve_canonical_approval_request_id(request_id, current, incoming);
    let mut merged = Map::new();
    if let Some(incoming) = incoming {
        for (key, value) in incoming {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(current) = current {
        for (key, value) in current {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(canonical) = canonical {
        merged.insert(
            "approvalRequestId".to_string(),
            Value::String(canonical.clone()),
        );
        merged.insert("requestId".to_string(), Value::String(canonical));
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn resolve_canonical_approval_request_id(
    request_id: &str,
    current: Option<&Map<String, Value>>,
    incoming: Option<&Map<String, Value>>,
) -> Option<String> {
    trim_optional(request_id.to_string())
        .or_else(|| current.and_then(|value| object_string(Some(value), "approvalRequestId")))
        .or_else(|| current.and_then(|value| object_string(Some(value), "requestId")))
        .or_else(|| incoming.and_then(|value| object_string(Some(value), "approvalRequestId")))
        .or_else(|| incoming.and_then(|value| object_string(Some(value), "requestId")))
}

fn prune_approvals(approvals: &mut Vec<ApprovalRecord>, max_approvals: usize, retention_ms: u64) {
    let cutoff = now_millis().saturating_sub(retention_ms);
    approvals.retain(|approval| {
        approval.status == "pending" || approval.resolved_at.unwrap_or(approval.created_at) > cutoff
    });
    if approvals.len() > max_approvals {
        let start = approvals.len() - max_approvals;
        *approvals = approvals[start..].to_vec();
    }
}

fn trim_runs(runs: &mut Vec<RunRecord>, max_runs: usize) {
    if runs.len() > max_runs {
        let start = runs.len() - max_runs;
        *runs = runs[start..].to_vec();
    }
}

fn run_view(run: RunRecord) -> RunRecordView {
    let duration_ms = match (run.started_at, run.finished_at) {
        (Some(started_at), Some(finished_at)) => Some(finished_at.saturating_sub(started_at)),
        _ => None,
    };
    RunRecordView { run, duration_ms }
}

fn sort_runs_desc(left: &RunRecord, right: &RunRecord) -> std::cmp::Ordering {
    let left_time = left
        .finished_at
        .unwrap_or(left.updated_at.max(left.created_at));
    let right_time = right
        .finished_at
        .unwrap_or(right.updated_at.max(right.created_at));
    right_time.cmp(&left_time)
}

fn summarize_window(runs: &[RunRecordView], window_ms: u64) -> RunWindowSummary {
    let cutoff = now_millis().saturating_sub(window_ms);
    let in_window = runs
        .iter()
        .filter(|run| {
            run.run
                .finished_at
                .unwrap_or(run.run.updated_at.max(run.run.created_at))
                >= cutoff
        })
        .collect::<Vec<_>>();
    let completed = in_window
        .iter()
        .filter(|run| matches!(run.run.state.as_str(), "done" | "failed"))
        .count();
    let failed = in_window
        .iter()
        .filter(|run| run.run.state == "failed")
        .count();
    let durations = in_window
        .iter()
        .filter_map(|run| run.duration_ms)
        .collect::<Vec<_>>();
    RunWindowSummary {
        total: in_window.len(),
        completed,
        failed,
        completion_rate: completion_rate(completed, failed),
        avg_duration_ms: average_duration(&durations),
    }
}

fn completion_rate(completed: usize, failed: usize) -> Option<f64> {
    if completed == 0 {
        return None;
    }
    let success = completed.saturating_sub(failed);
    Some(((success as f64 / completed as f64) * 10_000.0).round() / 10_000.0)
}

fn average_duration(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<u64>() / values.len() as u64)
}

fn percentile(values: &[u64], percentile: usize) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank =
        (((percentile as f64 / 100.0) * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    sorted
        .get(rank.min(sorted.len().saturating_sub(1)))
        .copied()
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
        .and_then(|value| trim_optional(value.to_string()))
}

fn trim_preview(value: Option<String>) -> String {
    truncate_text_opt(value, 500).unwrap_or_default()
}

fn truncate_text_opt(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|item| truncate_text(&item, max_chars))
}

fn truncate_text(value: &str, max_chars: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= max_chars {
        return Some(trimmed.to_string());
    }
    let keep = max_chars.saturating_sub(16).max(32);
    let shortened = trimmed.chars().take(keep).collect::<String>();
    Some(format!("{}...[truncated]", shortened.trim_end()))
}

fn trim_optional(value: impl AsRef<str>) -> Option<String> {
    let trimmed = value.as_ref().trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn trim_non_empty(value: impl AsRef<str>) -> String {
    trim_optional(value).unwrap_or_default()
}

fn generate_hex_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn read_usize_env(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
    let mut temp = NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temp.write_all(payload)?;
    set_file_permissions(temp.path())?;
    temp.persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("Failed to persist file: {}", path.display()))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn temp_paths() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn run_store_supports_create_update_list_and_diagnostics() {
        let temp_dir = temp_paths();
        let store = RunStore::new_in(temp_dir.path());

        let run = store
            .create_run(CreateRunInput {
                run_type: Some("exec".to_string()),
                state: Some("running".to_string()),
                summary: Some("Executing command".to_string()),
                started_at: Some(now_millis().saturating_sub(1_000)),
                session_id: Some("session-exec-1".to_string()),
                session_type: Some("chat/main".to_string()),
                lane_id: Some("remote:exec".to_string()),
                source: Some("remote".to_string()),
                contract_version: Some(2),
                meta: Some(Map::from_iter([(
                    "command".to_string(),
                    Value::String("echo ok".to_string()),
                )])),
                ..CreateRunInput::default()
            })
            .unwrap();
        assert_eq!(run.state, "running");
        assert_eq!(run.session_id.as_deref(), Some("session-exec-1"));
        assert_eq!(
            run.attempt_id.as_deref(),
            Some(format!("{}:attempt-1", run.run_id).as_str())
        );

        let updated = store
            .update_run(&run.run_id, |current| {
                current.state = "done".to_string();
                current.finished_at = Some(now_millis());
                current.summary = Some("Command completed".to_string());
            })
            .unwrap()
            .unwrap();
        assert_eq!(updated.state, "done");

        let listed = store
            .list_runs(RunListQuery {
                run_type: Some("exec".to_string()),
                limit: Some(10),
                ..RunListQuery::default()
            })
            .unwrap();
        assert_eq!(listed.total, 1);
        assert_eq!(listed.runs[0].run.run_id, run.run_id);
        assert!(listed.runs[0].duration_ms.is_some());

        let fetched = store.get_run_by_id(&run.run_id).unwrap().unwrap();
        assert_eq!(fetched.run.state, "done");
        assert_eq!(fetched.run.session_type.as_deref(), Some("chat/main"));

        let diagnostics = store.get_run_diagnostics(Some(20)).unwrap();
        assert!(diagnostics.ok);
        assert!(diagnostics.sampled >= 1);
        assert!(diagnostics.by_type.get("exec").unwrap().total >= 1);
    }

    #[test]
    fn run_store_falls_back_to_backup_when_primary_is_corrupted() {
        let temp_dir = temp_paths();
        let store = RunStore::new_in(temp_dir.path());
        let created = store
            .create_run(CreateRunInput {
                run_id: Some("run-backup".to_string()),
                run_type: Some("heartbeat".to_string()),
                state: Some("done".to_string()),
                summary: Some("from backup".to_string()),
                ..CreateRunInput::default()
            })
            .unwrap();
        assert_eq!(created.run_id, "run-backup");

        let primary = temp_dir.path().join("runs.json");
        let backup = temp_dir.path().join("runs.json.bak");
        let payload = fs::read_to_string(&primary).unwrap();
        fs::write(&backup, payload).unwrap();
        fs::write(&primary, "{ invalid json").unwrap();

        let reloaded = RunStore::new_in(temp_dir.path());
        let fetched = reloaded.get_run_by_id("run-backup").unwrap().unwrap();
        assert_eq!(fetched.run.summary.as_deref(), Some("from backup"));
    }

    #[test]
    fn run_store_persists_session_links() {
        let temp_dir = temp_paths();
        let store = RunStore::new_in(temp_dir.path());
        store
            .set_session_run_link(
                "session-1",
                "run-1",
                RunLinkInput {
                    run_type: Some("session".to_string()),
                    ..RunLinkInput::default()
                },
            )
            .unwrap();
        let reloaded = RunStore::new_in(temp_dir.path());
        let link = reloaded.get_session_run_link("session-1").unwrap().unwrap();
        assert_eq!(link.run_id, "run-1");
        assert_eq!(link.r#type.as_deref(), Some("session"));
    }

    #[test]
    fn approval_store_is_idempotent_for_same_request_and_preserves_run_link() {
        let temp_dir = temp_paths();
        let store = ApprovalStore::new_in(temp_dir.path());
        let first = store
            .create_approval(CreateApprovalInput {
                request_id: Some("req-approval-1".to_string()),
                conversation_id: Some("conv-approval-1".to_string()),
                tool_name: Some("Read".to_string()),
                tool_preview: Some("Read /tmp/one.txt".to_string()),
                risk_level: Some("medium".to_string()),
                channels: Some(vec!["sidepanel".to_string()]),
                expires_at: Some(now_millis() + 60_000),
                meta: Some(Map::from_iter([
                    (
                        "runId".to_string(),
                        Value::String("run-approval-1".to_string()),
                    ),
                    (
                        "correlationId".to_string(),
                        Value::String("corr-approval-1".to_string()),
                    ),
                ])),
            })
            .unwrap();
        let retried = store
            .create_approval(CreateApprovalInput {
                request_id: Some("req-approval-1".to_string()),
                conversation_id: Some("conv-retry".to_string()),
                tool_name: Some("Bash".to_string()),
                tool_preview: Some("Run ls".to_string()),
                risk_level: Some("high".to_string()),
                channels: Some(vec!["telegram".to_string()]),
                expires_at: Some(now_millis() + 120_000),
                meta: Some(Map::from_iter([(
                    "correlationId".to_string(),
                    Value::String("corr-approval-retry".to_string()),
                )])),
            })
            .unwrap();
        assert_eq!(retried.request_id, first.request_id);
        assert_eq!(retried.created_at, first.created_at);
        assert_eq!(
            object_string(retried.meta.as_ref(), "runId").as_deref(),
            Some("run-approval-1")
        );
        assert_eq!(
            object_string(retried.meta.as_ref(), "correlationId").as_deref(),
            Some("corr-approval-1")
        );
    }

    #[test]
    fn approval_store_preserves_canonical_request_id_in_meta() {
        let temp_dir = temp_paths();
        let store = ApprovalStore::new_in(temp_dir.path());
        let created = store
            .create_approval(CreateApprovalInput {
                request_id: Some("req-canonical-1".to_string()),
                meta: Some(Map::from_iter([(
                    "runId".to_string(),
                    Value::String("run-1".to_string()),
                )])),
                ..CreateApprovalInput::default()
            })
            .unwrap();
        assert_eq!(
            object_string(created.meta.as_ref(), "approvalRequestId").as_deref(),
            Some("req-canonical-1")
        );
        assert_eq!(
            object_string(created.meta.as_ref(), "requestId").as_deref(),
            Some("req-canonical-1")
        );

        let retried = store
            .create_approval(CreateApprovalInput {
                request_id: Some("req-canonical-1".to_string()),
                meta: Some(Map::from_iter([
                    (
                        "approvalRequestId".to_string(),
                        Value::String("wrong-id".to_string()),
                    ),
                    (
                        "requestId".to_string(),
                        Value::String("wrong-request-id".to_string()),
                    ),
                ])),
                ..CreateApprovalInput::default()
            })
            .unwrap();
        assert_eq!(
            object_string(retried.meta.as_ref(), "approvalRequestId").as_deref(),
            Some("req-canonical-1")
        );
    }

    #[test]
    fn approval_store_expires_pending_records() {
        let temp_dir = temp_paths();
        let store = ApprovalStore::new_in(temp_dir.path());
        store
            .create_approval(CreateApprovalInput {
                request_id: Some("req-expire-1".to_string()),
                expires_at: Some(now_millis().saturating_sub(1)),
                ..CreateApprovalInput::default()
            })
            .unwrap();
        let expired = store.expire_overdue_approvals().unwrap();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].status, "expired");
        assert!(store.list_pending_approvals().unwrap().is_empty());
    }
}
