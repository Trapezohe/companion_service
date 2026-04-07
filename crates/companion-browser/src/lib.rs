use anyhow::{anyhow, Context, Result};
use companion_config::get_config_dir;
use companion_shared::SupportedFeatures;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

const DEFAULT_MAX_BROWSER_SESSIONS: usize = 50;
const DEFAULT_MAX_BROWSER_ACTIONS_PER_SESSION: usize = 200;
const DEFAULT_MAX_BROWSER_ARTIFACTS_PER_SESSION: usize = 50;
const DEFAULT_MAX_BROWSER_EVENTS: usize = 500;
const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSnapshot {
    #[serde(default)]
    sessions: Vec<Value>,
    #[serde(default)]
    actions: Vec<Value>,
    #[serde(default)]
    artifacts: Vec<Value>,
    #[serde(default)]
    events: Vec<Value>,
    #[serde(default = "default_next_cursor")]
    next_cursor: u64,
}

impl Default for BrowserSnapshot {
    fn default() -> Self {
        Self {
            sessions: Vec::new(),
            actions: Vec::new(),
            artifacts: Vec::new(),
            events: Vec::new(),
            next_cursor: default_next_cursor(),
        }
    }
}

#[derive(Debug, Default)]
struct BrowserLedgerInner {
    loaded: bool,
    snapshot: BrowserSnapshot,
}

#[derive(Debug, Clone)]
pub struct BrowserLedger {
    inner: Arc<Mutex<BrowserLedgerInner>>,
    primary_path: PathBuf,
    backup_path: PathBuf,
    max_sessions: usize,
    max_actions_per_session: usize,
    max_artifacts_per_session: usize,
    max_events: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserSessionListQuery {
    pub session_id: Option<String>,
    pub state: Option<String>,
    pub owner_conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub source_tool_name: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub approval_request_id: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserActionListQuery {
    pub action_id: Option<String>,
    pub session_id: Option<String>,
    pub target_id: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub source_tool_name: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub approval_request_id: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserArtifactListQuery {
    pub artifact_id: Option<String>,
    pub session_id: Option<String>,
    pub target_id: Option<String>,
    pub action_id: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserEventsQuery {
    pub after: Option<u64>,
    pub window: Option<String>,
    pub limit: Option<usize>,
    pub session_id: Option<String>,
    pub action_id: Option<String>,
    pub artifact_id: Option<String>,
    pub event_type: Option<String>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub source_tool_name: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub approval_request_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserDrilldownQuery {
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub source_tool_name: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub approval_request_id: Option<String>,
    pub session_id: Option<String>,
    pub action_id: Option<String>,
    pub artifact_id: Option<String>,
    pub event_type: Option<String>,
    pub session_limit: Option<usize>,
    pub action_limit: Option<usize>,
    pub artifact_limit: Option<usize>,
    pub event_limit: Option<usize>,
    pub event_after: Option<u64>,
    pub event_window: Option<String>,
}

impl BrowserLedger {
    pub fn new() -> Self {
        Self::new_in(get_config_dir())
    }

    pub fn new_in<P: Into<PathBuf>>(config_dir: P) -> Self {
        let config_dir = config_dir.into();
        Self {
            inner: Arc::new(Mutex::new(BrowserLedgerInner::default())),
            primary_path: config_dir.join("browser-ledger.json"),
            backup_path: config_dir.join("browser-ledger.json.bak"),
            max_sessions: env_usize(
                "TRAPEZOHE_MAX_BROWSER_SESSIONS",
                DEFAULT_MAX_BROWSER_SESSIONS,
                1,
            ),
            max_actions_per_session: env_usize(
                "TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION",
                DEFAULT_MAX_BROWSER_ACTIONS_PER_SESSION,
                1,
            ),
            max_artifacts_per_session: env_usize(
                "TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION",
                DEFAULT_MAX_BROWSER_ARTIFACTS_PER_SESSION,
                1,
            ),
            max_events: env_usize(
                "TRAPEZOHE_MAX_BROWSER_EVENTS",
                DEFAULT_MAX_BROWSER_EVENTS,
                1,
            ),
        }
    }

    pub fn sync_session(&self, payload: Value) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let normalized = normalize_session_payload(&payload)?;
        let session_id = string_path(&normalized, &["session", "sessionId"])
            .ok_or_else(|| anyhow!("session.sessionId is required."))?;
        if let Some(index) = inner.snapshot.sessions.iter().position(|entry| {
            string_path(entry, &["session", "sessionId"]).as_deref() == Some(session_id.as_str())
        }) {
            let merged = merge_session_entry(&inner.snapshot.sessions[index], &normalized);
            inner.snapshot.sessions[index] = merged;
        } else {
            inner.snapshot.sessions.push(normalized.clone());
        }
        let stored = inner
            .snapshot
            .sessions
            .iter()
            .find(|entry| {
                string_path(entry, &["session", "sessionId"]).as_deref()
                    == Some(session_id.as_str())
            })
            .cloned()
            .unwrap_or(normalized);
        append_browser_event(
            &mut inner.snapshot,
            build_session_sync_event(&stored),
            self.max_events,
        );
        trim_snapshot(
            &mut inner.snapshot,
            self.max_sessions,
            self.max_actions_per_session,
            self.max_artifacts_per_session,
            self.max_events,
        );
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(stored)
    }

    pub fn sync_action(&self, payload: Value) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let normalized = normalize_action_payload(&payload)?;
        let action_id = string_path(&normalized, &["action", "actionId"])
            .ok_or_else(|| anyhow!("action.actionId and action.sessionId are required."))?;
        if let Some(index) = inner.snapshot.actions.iter().position(|entry| {
            string_path(entry, &["action", "actionId"]).as_deref() == Some(action_id.as_str())
        }) {
            let merged = merge_action_entry(&inner.snapshot.actions[index], &normalized);
            inner.snapshot.actions[index] = merged;
        } else {
            inner.snapshot.actions.push(normalized.clone());
        }
        let stored = inner
            .snapshot
            .actions
            .iter()
            .find(|entry| {
                string_path(entry, &["action", "actionId"]).as_deref() == Some(action_id.as_str())
            })
            .cloned()
            .unwrap_or(normalized);
        append_browser_event(
            &mut inner.snapshot,
            build_action_sync_event(&stored),
            self.max_events,
        );
        trim_snapshot(
            &mut inner.snapshot,
            self.max_sessions,
            self.max_actions_per_session,
            self.max_artifacts_per_session,
            self.max_events,
        );
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(stored)
    }

    pub fn sync_artifact(&self, payload: Value) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let normalized = normalize_artifact_payload(&inner.snapshot, &payload)?;
        let artifact_id = string_path(&normalized, &["artifact", "artifactId"])
            .ok_or_else(|| anyhow!("artifact.artifactId and artifact.sessionId are required."))?;
        if let Some(index) = inner.snapshot.artifacts.iter().position(|entry| {
            string_path(entry, &["artifact", "artifactId"]).as_deref() == Some(artifact_id.as_str())
        }) {
            let merged = merge_artifact_entry(&inner.snapshot.artifacts[index], &normalized);
            inner.snapshot.artifacts[index] = merged;
        } else {
            inner.snapshot.artifacts.push(normalized.clone());
        }
        let stored = inner
            .snapshot
            .artifacts
            .iter()
            .find(|entry| {
                string_path(entry, &["artifact", "artifactId"]).as_deref()
                    == Some(artifact_id.as_str())
            })
            .cloned()
            .unwrap_or(normalized);
        append_browser_event(
            &mut inner.snapshot,
            build_artifact_sync_event(&stored),
            self.max_events,
        );
        trim_snapshot(
            &mut inner.snapshot,
            self.max_sessions,
            self.max_actions_per_session,
            self.max_artifacts_per_session,
            self.max_events,
        );
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)?;
        Ok(stored)
    }

    pub fn list_sessions(&self, query: BrowserSessionListQuery) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(build_session_list_result(&inner.snapshot, query))
    }

    pub fn get_session_by_id(&self, session_id: &str) -> Result<Option<Value>> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let normalized_id = trim_optional(session_id);
        if normalized_id.is_none() {
            return Ok(None);
        }
        Ok(inner
            .snapshot
            .sessions
            .iter()
            .find(|entry| {
                string_path(entry, &["session", "sessionId"]).as_deref() == normalized_id.as_deref()
            })
            .cloned())
    }

    pub fn list_actions(&self, query: BrowserActionListQuery) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(build_action_list_result(&inner.snapshot, query))
    }

    pub fn list_artifacts(&self, query: BrowserArtifactListQuery) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(build_artifact_list_result(&inner.snapshot, query))
    }

    pub fn list_events(&self, query: BrowserEventsQuery) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        Ok(build_event_list_result(&inner.snapshot, query))
    }

    pub fn drilldown(&self, query: BrowserDrilldownQuery) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let normalized = normalize_drilldown_query(query);
        let sessions = build_session_list_result(
            &inner.snapshot,
            BrowserSessionListQuery {
                session_id: normalized.session_id.clone(),
                run_id: normalized.run_id.clone(),
                conversation_id: normalized.conversation_id.clone(),
                source_tool_name: normalized.source_tool_name.clone(),
                source_tool_call_id: normalized.source_tool_call_id.clone(),
                approval_request_id: normalized.approval_request_id.clone(),
                limit: Some(normalized.session_limit),
                offset: Some(0),
                ..BrowserSessionListQuery::default()
            },
        );
        let actions = build_action_list_result(
            &inner.snapshot,
            BrowserActionListQuery {
                action_id: normalized.action_id.clone(),
                session_id: normalized.session_id.clone(),
                run_id: normalized.run_id.clone(),
                conversation_id: normalized.conversation_id.clone(),
                source_tool_name: normalized.source_tool_name.clone(),
                source_tool_call_id: normalized.source_tool_call_id.clone(),
                approval_request_id: normalized.approval_request_id.clone(),
                limit: Some(normalized.action_limit),
                offset: Some(0),
                ..BrowserActionListQuery::default()
            },
        );
        let artifacts = build_artifact_list_result(
            &inner.snapshot,
            BrowserArtifactListQuery {
                artifact_id: normalized.artifact_id.clone(),
                action_id: normalized.action_id.clone(),
                session_id: normalized.session_id.clone(),
                limit: Some(normalized.artifact_limit),
                offset: Some(0),
                ..BrowserArtifactListQuery::default()
            },
        );
        let events = build_event_list_result(
            &inner.snapshot,
            BrowserEventsQuery {
                after: Some(normalized.event_after),
                window: normalized.event_window.clone(),
                limit: Some(normalized.event_limit),
                session_id: normalized.session_id.clone(),
                action_id: normalized.action_id.clone(),
                artifact_id: normalized.artifact_id.clone(),
                event_type: normalized.event_type.clone(),
                run_id: normalized.run_id.clone(),
                conversation_id: normalized.conversation_id.clone(),
                source_tool_name: normalized.source_tool_name.clone(),
                source_tool_call_id: normalized.source_tool_call_id.clone(),
                approval_request_id: normalized.approval_request_id.clone(),
            },
        );

        Ok(json!({
            "ok": true,
            "filters": build_drilldown_filters(&normalized),
            "sessions": sessions,
            "actions": actions,
            "artifacts": artifacts,
            "events": events,
        }))
    }

    pub fn diagnostics(&self, supported_features: &SupportedFeatures) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded_locked(&mut inner)?;
        let linked_sessions = sort_descending(
            inner
                .snapshot
                .sessions
                .iter()
                .filter(|entry| read_linked_field(entry, "runId").is_some())
                .cloned()
                .collect(),
            session_sort_key,
        );
        let linked_actions = sort_descending(
            inner
                .snapshot
                .actions
                .iter()
                .filter(|entry| read_linked_field(entry, "runId").is_some())
                .cloned()
                .collect(),
            action_sort_key,
        );
        let active_sessions = inner
            .snapshot
            .sessions
            .iter()
            .filter(|entry| {
                string_path(entry, &["session", "state"])
                    .map(|state| {
                        let normalized = state.trim().to_lowercase();
                        !normalized.is_empty() && normalized != "closed" && normalized != "error"
                    })
                    .unwrap_or(false)
            })
            .count();
        let failed_recent = inner
            .snapshot
            .actions
            .iter()
            .filter(|entry| string_path(entry, &["action", "status"]).as_deref() == Some("failed"))
            .count();
        let mut recent_events = inner.snapshot.events.clone();
        recent_events.sort_by_key(event_sort_key);
        recent_events.reverse();
        recent_events.truncate(5);
        Ok(json!({
            "enabled": supported_features.browser_ledger,
            "loaded": inner.loaded,
            "sessions": {
                "total": inner.snapshot.sessions.len(),
                "active": active_sessions,
                "linked": linked_sessions.len(),
                "recentLinked": linked_sessions.into_iter().take(5).map(|entry| build_recent_linked_session_summary(&entry)).collect::<Vec<_>>(),
            },
            "actions": {
                "total": inner.snapshot.actions.len(),
                "failedRecent": failed_recent,
                "linked": linked_actions.len(),
                "recentLinked": linked_actions.into_iter().take(5).map(|entry| build_recent_linked_action_summary(&entry)).collect::<Vec<_>>(),
            },
            "artifacts": {
                "total": inner.snapshot.artifacts.len(),
                "recent": inner.snapshot.artifacts.len(),
            },
            "events": {
                "total": inner.snapshot.events.len(),
                "recent": recent_events,
                "nextCursor": inner.snapshot.next_cursor.saturating_sub(1),
            },
            "operator": {
                "drilldownAvailable": supported_features.browser_drilldown,
                "routes": if supported_features.browser_drilldown {
                    json!({ "drilldown": "/api/browser/drilldown" })
                } else {
                    json!({})
                },
                "eventWindowModes": if supported_features.browser_events {
                    json!(["tail"])
                } else {
                    json!([])
                },
            },
            "capabilities": {
                "browserLedger": supported_features.browser_ledger,
                "browserEvents": supported_features.browser_events,
                "browserDrilldown": supported_features.browser_drilldown,
            }
        }))
    }

    pub fn clear_for_tests(&self) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.snapshot = BrowserSnapshot::default();
        persist_json_snapshot(&self.primary_path, &self.backup_path, &inner.snapshot)
    }

    fn ensure_loaded_locked(&self, inner: &mut BrowserLedgerInner) -> Result<()> {
        if inner.loaded {
            return Ok(());
        }
        inner.snapshot = load_browser_snapshot(&self.primary_path, &self.backup_path)?;
        trim_snapshot(
            &mut inner.snapshot,
            self.max_sessions,
            self.max_actions_per_session,
            self.max_artifacts_per_session,
            self.max_events,
        );
        inner.loaded = true;
        Ok(())
    }
}

fn default_next_cursor() -> u64 {
    1
}

fn env_usize(name: &str, fallback: usize, min: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.max(min))
        .unwrap_or(fallback.max(min))
}

fn load_browser_snapshot(primary_path: &Path, backup_path: &Path) -> Result<BrowserSnapshot> {
    match read_browser_snapshot(primary_path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => read_browser_snapshot(backup_path).map(|value| value.unwrap_or_default()),
        Err(primary_error) => match read_browser_snapshot(backup_path) {
            Ok(Some(snapshot)) => Ok(snapshot),
            Ok(None) => Ok(BrowserSnapshot::default()),
            Err(_) => {
                eprintln!(
                    "Failed to read browser-ledger primary snapshot ({}); starting fresh.",
                    primary_error
                );
                Ok(BrowserSnapshot::default())
            }
        },
    }
}

fn read_browser_snapshot(path: &Path) -> Result<Option<BrowserSnapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read browser snapshot: {}", path.display()))?;
    let snapshot = serde_json::from_str::<BrowserSnapshot>(&raw)
        .with_context(|| format!("Failed to parse browser snapshot: {}", path.display()))?;
    Ok(Some(snapshot))
}

fn persist_json_snapshot(
    primary_path: &Path,
    backup_path: &Path,
    snapshot: &BrowserSnapshot,
) -> Result<()> {
    if let Some(parent) = primary_path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create browser snapshot dir: {}",
                parent.display()
            )
        })?;
    }

    let temp_path = primary_path.parent().unwrap_or_else(|| Path::new("."));
    let mut temp = NamedTempFile::new_in(temp_path).with_context(|| {
        format!(
            "Failed to create temp browser snapshot near {}",
            primary_path.display()
        )
    })?;
    serde_json::to_writer_pretty(&mut temp, snapshot)
        .context("Failed to encode browser snapshot")?;
    use std::io::Write;
    temp.write_all(b"\n")
        .context("Failed to finalize browser snapshot")?;
    temp.flush().context("Failed to flush browser snapshot")?;

    if primary_path.exists() {
        if backup_path.exists() {
            let _ = fs::remove_file(backup_path);
        }
        fs::copy(primary_path, backup_path).with_context(|| {
            format!(
                "Failed to write browser snapshot backup {}",
                backup_path.display()
            )
        })?;
    }

    temp.persist(primary_path)
        .map_err(|error| anyhow!(error.error))
        .with_context(|| {
            format!(
                "Failed to persist browser snapshot to {}",
                primary_path.display()
            )
        })?;

    Ok(())
}

fn trim_snapshot(
    snapshot: &mut BrowserSnapshot,
    max_sessions: usize,
    max_actions_per_session: usize,
    max_artifacts_per_session: usize,
    max_events: usize,
) {
    snapshot.sessions = trim_grouped_items(
        sort_descending(snapshot.sessions.clone(), session_sort_key),
        max_sessions,
        None,
        |_| None,
    );
    snapshot.actions = trim_grouped_items(
        sort_descending(snapshot.actions.clone(), action_sort_key),
        usize::MAX,
        Some(max_actions_per_session),
        |entry| string_path(entry, &["action", "sessionId"]),
    );
    snapshot.artifacts = trim_grouped_items(
        sort_descending(snapshot.artifacts.clone(), artifact_sort_key),
        usize::MAX,
        Some(max_artifacts_per_session),
        |entry| string_path(entry, &["artifact", "sessionId"]),
    );
    if snapshot.events.len() > max_events {
        let keep_from = snapshot.events.len() - max_events;
        snapshot.events = snapshot.events.split_off(keep_from);
    }
    snapshot.sessions.truncate(max_sessions);
    if snapshot.next_cursor == 0 {
        snapshot.next_cursor = 1;
    }
}

fn trim_grouped_items<F>(
    items: Vec<Value>,
    total_limit: usize,
    per_group_limit: Option<usize>,
    group_key: F,
) -> Vec<Value>
where
    F: Fn(&Value) -> Option<String>,
{
    let mut kept = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for item in items {
        if kept.len() >= total_limit {
            break;
        }
        if let Some(limit) = per_group_limit {
            if let Some(key) = group_key(&item) {
                let count = counts.entry(key).or_insert(0);
                if *count >= limit {
                    continue;
                }
                *count += 1;
            }
        }
        kept.push(item);
    }
    kept
}

fn normalize_session_payload(payload: &Value) -> Result<Value> {
    let raw_session = payload
        .get("session")
        .and_then(Value::as_object)
        .or_else(|| payload.as_object())
        .ok_or_else(|| anyhow!("session.sessionId is required."))?;
    let session_id = safe_text(raw_session.get("sessionId"), 200)
        .ok_or_else(|| anyhow!("session.sessionId is required."))?;
    let created_at = timestamp_or(raw_session.get("createdAt"), now_millis());
    let updated_at = timestamp_or(raw_session.get("updatedAt"), created_at);

    let mut session = Map::new();
    insert_string(&mut session, "sessionId", Some(session_id.clone()));
    insert_string(
        &mut session,
        "driver",
        safe_text(raw_session.get("driver"), 64).or_else(|| Some("extension-tab".to_string())),
    );
    insert_string(
        &mut session,
        "state",
        safe_text(raw_session.get("state"), 64).or_else(|| Some("idle".to_string())),
    );
    insert_u64(&mut session, "createdAt", Some(created_at));
    insert_u64(&mut session, "updatedAt", Some(updated_at));
    insert_string(
        &mut session,
        "ownerConversationId",
        safe_text(raw_session.get("ownerConversationId"), 200),
    );
    insert_string(
        &mut session,
        "ownerRunId",
        safe_text(raw_session.get("ownerRunId"), 200),
    );
    insert_string(
        &mut session,
        "sourceToolName",
        safe_text(raw_session.get("sourceToolName"), 200),
    );
    insert_string(
        &mut session,
        "sourceToolCallId",
        safe_text(raw_session.get("sourceToolCallId"), 200),
    );
    insert_string(
        &mut session,
        "approvalRequestId",
        safe_text(raw_session.get("approvalRequestId"), 200),
    );
    insert_string(
        &mut session,
        "profileId",
        safe_text(raw_session.get("profileId"), 200).or_else(|| Some("default".to_string())),
    );
    insert_string(
        &mut session,
        "primaryTargetId",
        safe_text(raw_session.get("primaryTargetId"), 200),
    );
    insert_string(
        &mut session,
        "lastSnapshotId",
        safe_text(raw_session.get("lastSnapshotId"), 200),
    );
    if let Some(last_error) = normalize_runtime_error(raw_session.get("lastError")) {
        session.insert("lastError".to_string(), last_error);
    }
    session.insert(
        "capabilities".to_string(),
        normalize_capabilities(raw_session.get("capabilities")),
    );

    let targets = payload
        .get("targets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| normalize_target_record(item, &session_id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let link = normalize_link(
        payload.get("link"),
        LinkFallback {
            run_id: safe_text(raw_session.get("ownerRunId"), 200),
            conversation_id: safe_text(raw_session.get("ownerConversationId"), 200),
            source_tool_name: safe_text(raw_session.get("sourceToolName"), 200),
            source_tool_call_id: safe_text(raw_session.get("sourceToolCallId"), 200),
            approval_request_id: safe_text(raw_session.get("approvalRequestId"), 200),
            updated_at: Some(updated_at),
        },
    );

    let mut envelope = Map::new();
    envelope.insert("session".to_string(), Value::Object(session));
    envelope.insert("targets".to_string(), Value::Array(targets));
    insert_string(
        &mut envelope,
        "source",
        safe_text(payload.get("source"), 64).or_else(|| Some("extension-background".to_string())),
    );
    insert_u64(&mut envelope, "syncedAt", Some(now_millis()));
    if let Some(link) = link {
        envelope.insert("link".to_string(), link);
    }
    Ok(Value::Object(envelope))
}

fn normalize_action_payload(payload: &Value) -> Result<Value> {
    let raw_action = payload
        .get("action")
        .and_then(Value::as_object)
        .or_else(|| payload.as_object())
        .ok_or_else(|| anyhow!("action.actionId and action.sessionId are required."))?;
    let action_id = safe_text(raw_action.get("actionId"), 200)
        .ok_or_else(|| anyhow!("action.actionId and action.sessionId are required."))?;
    let session_id = safe_text(raw_action.get("sessionId"), 200)
        .ok_or_else(|| anyhow!("action.actionId and action.sessionId are required."))?;

    let mut action = Map::new();
    insert_string(&mut action, "actionId", Some(action_id));
    insert_string(&mut action, "sessionId", Some(session_id));
    insert_string(
        &mut action,
        "targetId",
        safe_text(raw_action.get("targetId"), 200),
    );
    insert_string(
        &mut action,
        "kind",
        safe_text(raw_action.get("kind"), 64).or_else(|| Some("navigate".to_string())),
    );
    insert_string(
        &mut action,
        "status",
        safe_text(raw_action.get("status"), 64).or_else(|| Some("queued".to_string())),
    );
    insert_optional_timestamp(&mut action, "startedAt", raw_action.get("startedAt"));
    insert_optional_timestamp(&mut action, "finishedAt", raw_action.get("finishedAt"));
    insert_string(
        &mut action,
        "ownerConversationId",
        safe_text(raw_action.get("ownerConversationId"), 200),
    );
    insert_string(
        &mut action,
        "ownerRunId",
        safe_text(raw_action.get("ownerRunId"), 200),
    );
    insert_string(
        &mut action,
        "sourceToolName",
        safe_text(raw_action.get("sourceToolName"), 200),
    );
    insert_string(
        &mut action,
        "sourceToolCallId",
        safe_text(raw_action.get("sourceToolCallId"), 200),
    );
    insert_string(
        &mut action,
        "approvalRequestId",
        safe_text(raw_action.get("approvalRequestId"), 200),
    );
    insert_string(
        &mut action,
        "inputSummary",
        safe_text(raw_action.get("inputSummary"), 500).or_else(|| Some(String::new())),
    );
    insert_string(
        &mut action,
        "resultSummary",
        safe_text(raw_action.get("resultSummary"), 500),
    );
    insert_string(
        &mut action,
        "nextSnapshotId",
        safe_text(raw_action.get("nextSnapshotId"), 200),
    );
    if let Some(error) = normalize_runtime_error(raw_action.get("error")) {
        action.insert("error".to_string(), error);
    }
    if let Some(effects) = payload_object_or(raw_action.get("effects")) {
        action.insert("effects".to_string(), Value::Object(effects));
    }

    let mut envelope = Map::new();
    envelope.insert("action".to_string(), Value::Object(action));
    if let Some(snapshot) = normalize_snapshot_record(
        payload.get("snapshot"),
        string_path(&Value::Object(envelope.clone()), &["action", "sessionId"]).as_deref(),
        string_path(&Value::Object(envelope.clone()), &["action", "targetId"]).as_deref(),
    ) {
        envelope.insert("snapshot".to_string(), snapshot);
    }
    if let Some(link) = normalize_link(
        payload.get("link"),
        LinkFallback {
            run_id: safe_text(raw_action.get("ownerRunId"), 200),
            conversation_id: safe_text(raw_action.get("ownerConversationId"), 200),
            source_tool_name: safe_text(raw_action.get("sourceToolName"), 200),
            source_tool_call_id: safe_text(raw_action.get("sourceToolCallId"), 200),
            approval_request_id: safe_text(raw_action.get("approvalRequestId"), 200),
            updated_at: timestamp_from(raw_action.get("finishedAt"))
                .or_else(|| timestamp_from(raw_action.get("startedAt"))),
        },
    ) {
        envelope.insert("link".to_string(), link);
    }
    insert_u64(&mut envelope, "syncedAt", Some(now_millis()));
    Ok(Value::Object(envelope))
}

fn normalize_artifact_payload(snapshot: &BrowserSnapshot, payload: &Value) -> Result<Value> {
    let raw_artifact = payload
        .get("artifact")
        .and_then(Value::as_object)
        .or_else(|| payload.as_object())
        .ok_or_else(|| anyhow!("artifact.artifactId and artifact.sessionId are required."))?;
    let artifact_id = safe_text(raw_artifact.get("artifactId"), 200)
        .ok_or_else(|| anyhow!("artifact.artifactId and artifact.sessionId are required."))?;
    let session_id = safe_text(raw_artifact.get("sessionId"), 200)
        .ok_or_else(|| anyhow!("artifact.artifactId and artifact.sessionId are required."))?;
    let action_id = safe_text(payload.get("actionId"), 200);

    let related_action = action_id.as_ref().and_then(|id| {
        snapshot.actions.iter().find(|entry| {
            string_path(entry, &["action", "actionId"]).as_deref() == Some(id.as_str())
        })
    });
    let related_session = snapshot.sessions.iter().find(|entry| {
        string_path(entry, &["session", "sessionId"]).as_deref() == Some(session_id.as_str())
    });

    let link_fallback = if let Some(action) = related_action {
        LinkFallback {
            run_id: read_linked_field(action, "runId"),
            conversation_id: read_linked_field(action, "conversationId"),
            source_tool_name: read_linked_field(action, "sourceToolName"),
            source_tool_call_id: read_linked_field(action, "sourceToolCallId"),
            approval_request_id: read_linked_field(action, "approvalRequestId"),
            updated_at: timestamp_from(value_path(action, &["action", "finishedAt"]))
                .or_else(|| timestamp_from(value_path(action, &["action", "startedAt"])))
                .or_else(|| timestamp_from(value_path(action, &["syncedAt"]))),
        }
    } else if let Some(session) = related_session {
        LinkFallback {
            run_id: read_linked_field(session, "runId"),
            conversation_id: read_linked_field(session, "conversationId"),
            source_tool_name: read_linked_field(session, "sourceToolName"),
            source_tool_call_id: read_linked_field(session, "sourceToolCallId"),
            approval_request_id: read_linked_field(session, "approvalRequestId"),
            updated_at: timestamp_from(value_path(session, &["session", "updatedAt"]))
                .or_else(|| timestamp_from(value_path(session, &["syncedAt"]))),
        }
    } else {
        LinkFallback::default()
    };

    let mut artifact = Map::new();
    insert_string(&mut artifact, "artifactId", Some(artifact_id));
    insert_string(&mut artifact, "sessionId", Some(session_id));
    insert_string(
        &mut artifact,
        "targetId",
        safe_text(raw_artifact.get("targetId"), 200),
    );
    insert_string(
        &mut artifact,
        "kind",
        safe_text(raw_artifact.get("kind"), 64).or_else(|| Some("download".to_string())),
    );
    insert_u64(
        &mut artifact,
        "createdAt",
        Some(timestamp_or(raw_artifact.get("createdAt"), now_millis())),
    );
    insert_string(
        &mut artifact,
        "mimeType",
        safe_text(raw_artifact.get("mimeType"), 200)
            .or_else(|| Some("application/octet-stream".to_string())),
    );
    insert_u64(
        &mut artifact,
        "byteLength",
        Some(number_from_value(raw_artifact.get("byteLength")).unwrap_or(0)),
    );
    insert_string(
        &mut artifact,
        "storage",
        safe_text(raw_artifact.get("storage"), 64).or_else(|| Some("companion".to_string())),
    );
    insert_string(
        &mut artifact,
        "pathOrKey",
        safe_text(raw_artifact.get("pathOrKey"), 2_000).or_else(|| Some(String::new())),
    );

    let mut envelope = Map::new();
    envelope.insert("artifact".to_string(), Value::Object(artifact));
    insert_string(&mut envelope, "actionId", action_id);
    if let Some(link) = normalize_link(payload.get("link"), link_fallback) {
        envelope.insert("link".to_string(), link);
    }
    insert_string(
        &mut envelope,
        "bytesBase64",
        safe_text(payload.get("bytesBase64"), 20_000_000),
    );
    insert_u64(&mut envelope, "syncedAt", Some(now_millis()));
    Ok(Value::Object(envelope))
}

fn normalize_snapshot_record(
    raw: Option<&Value>,
    fallback_session_id: Option<&str>,
    fallback_target_id: Option<&str>,
) -> Option<Value> {
    let raw = raw?.as_object()?;
    let snapshot_id = safe_text(raw.get("snapshotId"), 200)?;
    let session_id = safe_text(raw.get("sessionId"), 200)
        .or_else(|| fallback_session_id.and_then(trim_optional))?;
    let target_id = safe_text(raw.get("targetId"), 200)
        .or_else(|| fallback_target_id.and_then(trim_optional))?;

    let stats = raw.get("stats").and_then(Value::as_object);
    Some(json!({
        "snapshotId": snapshot_id,
        "sessionId": session_id,
        "targetId": target_id,
        "format": safe_text(raw.get("format"), 32).unwrap_or_else(|| "ai".to_string()),
        "url": safe_text(raw.get("url"), 2_000).unwrap_or_default(),
        "title": safe_text(raw.get("title"), 500).unwrap_or_default(),
        "body": raw
            .get("body")
            .map(stringify_value)
            .unwrap_or_default(),
        "refs": raw.get("refs").and_then(Value::as_array).cloned().unwrap_or_default(),
        "stats": {
            "chars": stats.and_then(|item| number_from_value(item.get("chars"))).unwrap_or(0),
            "lines": stats.and_then(|item| number_from_value(item.get("lines"))).unwrap_or(0),
            "refs": stats.and_then(|item| number_from_value(item.get("refs"))).unwrap_or(0),
            "interactive": stats.and_then(|item| number_from_value(item.get("interactive"))).unwrap_or(0),
            "truncated": stats.and_then(|item| bool_from_value(item.get("truncated"))).unwrap_or(false),
        },
        "createdAt": timestamp_or(raw.get("createdAt"), now_millis()),
        "source": safe_text(raw.get("source"), 64).unwrap_or_else(|| "manual".to_string()),
    }))
}

fn normalize_target_record(raw: &Value, session_id: &str) -> Option<Value> {
    let raw = raw.as_object()?;
    let target_id = safe_text(raw.get("targetId"), 200)?;
    let mut target = Map::new();
    insert_string(&mut target, "targetId", Some(target_id));
    insert_string(&mut target, "sessionId", Some(session_id.to_string()));
    if let Some(tab_id) = number_from_value(raw.get("tabId")) {
        insert_u64(&mut target, "tabId", Some(tab_id));
    }
    if let Some(frame_id) = number_from_value(raw.get("frameId")) {
        insert_u64(&mut target, "frameId", Some(frame_id));
    }
    insert_string(
        &mut target,
        "kind",
        safe_text(raw.get("kind"), 32).or_else(|| Some("page".to_string())),
    );
    insert_string(
        &mut target,
        "url",
        safe_text(raw.get("url"), 2_000).or_else(|| Some(String::new())),
    );
    insert_string(
        &mut target,
        "title",
        safe_text(raw.get("title"), 500).or_else(|| Some(String::new())),
    );
    target.insert(
        "active".to_string(),
        Value::Bool(bool_from_value(raw.get("active")).unwrap_or(true)),
    );
    target.insert(
        "attached".to_string(),
        Value::Bool(bool_from_value(raw.get("attached")).unwrap_or(true)),
    );
    insert_u64(
        &mut target,
        "lastSeenAt",
        Some(timestamp_or(raw.get("lastSeenAt"), now_millis())),
    );
    Some(Value::Object(target))
}

fn normalize_capabilities(raw: Option<&Value>) -> Value {
    let raw = raw.and_then(Value::as_object);
    let mut capabilities = Map::new();
    let defaults = [
        ("navigate", true),
        ("snapshot", true),
        ("click", true),
        ("type", true),
        ("upload", false),
        ("dialog", false),
        ("console", false),
        ("screenshot", false),
        ("pdf", false),
    ];
    for (key, default) in defaults {
        capabilities.insert(
            key.to_string(),
            Value::Bool(
                raw.and_then(|item| bool_from_value(item.get(key)))
                    .unwrap_or(default),
            ),
        );
    }
    if let Some(debugger) = raw.and_then(|item| bool_from_value(item.get("debugger"))) {
        capabilities.insert("debugger".to_string(), Value::Bool(debugger));
    }
    Value::Object(capabilities)
}

fn normalize_runtime_error(raw: Option<&Value>) -> Option<Value> {
    let raw = raw?.as_object()?;
    let code = safe_text(raw.get("code"), 64)?;
    let message = safe_text(raw.get("message"), 500)?;
    let mut error = Map::new();
    insert_string(&mut error, "code", Some(code));
    insert_string(&mut error, "message", Some(message));
    error.insert(
        "retryable".to_string(),
        Value::Bool(bool_from_value(raw.get("retryable")).unwrap_or(true)),
    );
    insert_string(&mut error, "hint", safe_text(raw.get("hint"), 500));
    if let Some(details) = payload_object_or(raw.get("details")) {
        error.insert("details".to_string(), Value::Object(details));
    }
    Some(Value::Object(error))
}

#[derive(Debug, Clone, Default)]
struct LinkFallback {
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
    updated_at: Option<u64>,
}

fn normalize_link(raw: Option<&Value>, fallback: LinkFallback) -> Option<Value> {
    let raw = raw.and_then(Value::as_object);
    let run_id = raw
        .and_then(|item| safe_text(item.get("runId"), 200))
        .or(fallback.run_id)?;
    let mut link = Map::new();
    insert_string(&mut link, "runId", Some(run_id));
    insert_string(
        &mut link,
        "type",
        raw.and_then(|item| safe_text(item.get("type"), 64)),
    );
    insert_string(
        &mut link,
        "conversationId",
        raw.and_then(|item| safe_text(item.get("conversationId"), 200))
            .or(fallback.conversation_id),
    );
    insert_string(
        &mut link,
        "sourceToolName",
        raw.and_then(|item| safe_text(item.get("sourceToolName"), 200))
            .or(fallback.source_tool_name),
    );
    insert_string(
        &mut link,
        "sourceToolCallId",
        raw.and_then(|item| safe_text(item.get("sourceToolCallId"), 200))
            .or(fallback.source_tool_call_id),
    );
    insert_string(
        &mut link,
        "approvalRequestId",
        raw.and_then(|item| safe_text(item.get("approvalRequestId"), 200))
            .or(fallback.approval_request_id),
    );
    insert_u64(
        &mut link,
        "updatedAt",
        Some(
            raw.and_then(|item| timestamp_from(item.get("updatedAt")))
                .or(fallback.updated_at)
                .unwrap_or_else(now_millis),
        ),
    );
    Some(Value::Object(link))
}

fn merge_session_entry(current: &Value, incoming: &Value) -> Value {
    let mut session = payload_object_or(value_path(current, &["session"])).unwrap_or_default();
    if let Some(incoming_session) = payload_object_or(value_path(incoming, &["session"])) {
        let current_created = timestamp_from(session.get("createdAt"));
        let current_updated = timestamp_from(session.get("updatedAt")).unwrap_or(0);
        let incoming_created =
            timestamp_from(incoming_session.get("createdAt")).unwrap_or_else(now_millis);
        let incoming_updated =
            timestamp_from(incoming_session.get("updatedAt")).unwrap_or(incoming_created);
        session.extend(incoming_session);
        insert_u64(
            &mut session,
            "createdAt",
            Some(current_created.unwrap_or(incoming_created)),
        );
        insert_u64(
            &mut session,
            "updatedAt",
            Some(current_updated.max(incoming_updated)),
        );
        if value_path(incoming, &["session", "lastError"]).is_none() {
            if let Some(current_error) = value_path(current, &["session", "lastError"]).cloned() {
                session.insert("lastError".to_string(), current_error);
            }
        }
    }

    let incoming_targets = value_path(incoming, &["targets"])
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let targets = if incoming_targets.is_empty() {
        value_path(current, &["targets"])
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    } else {
        Value::Array(incoming_targets)
    };
    let link = normalize_link(
        value_path(incoming, &["link"]),
        LinkFallback {
            run_id: string_path(current, &["link", "runId"]),
            conversation_id: string_path(current, &["link", "conversationId"]),
            source_tool_name: string_path(current, &["link", "sourceToolName"]),
            source_tool_call_id: string_path(current, &["link", "sourceToolCallId"]),
            approval_request_id: string_path(current, &["link", "approvalRequestId"]),
            updated_at: timestamp_from(value_path(current, &["link", "updatedAt"])),
        },
    );

    json!({
        "session": Value::Object(session),
        "targets": targets,
        "source": string_path(incoming, &["source"]).or_else(|| string_path(current, &["source"])) .unwrap_or_else(|| "extension-background".to_string()),
        "syncedAt": timestamp_from(value_path(incoming, &["syncedAt"])) .unwrap_or_else(now_millis),
        "link": link,
    })
}

fn merge_action_entry(current: &Value, incoming: &Value) -> Value {
    let mut action = payload_object_or(value_path(current, &["action"])).unwrap_or_default();
    if let Some(incoming_action) = payload_object_or(value_path(incoming, &["action"])) {
        let existing_error = action.get("error").cloned();
        let existing_effects = action.get("effects").cloned();
        action.extend(incoming_action);
        if value_path(incoming, &["action", "error"]).is_none() {
            if let Some(value) = existing_error {
                action.insert("error".to_string(), value);
            }
        }
        if value_path(incoming, &["action", "effects"]).is_none() {
            if let Some(value) = existing_effects {
                action.insert("effects".to_string(), value);
            }
        }
    }

    let snapshot = value_path(incoming, &["snapshot"])
        .cloned()
        .or_else(|| value_path(current, &["snapshot"]).cloned());
    let link = normalize_link(
        value_path(incoming, &["link"]),
        LinkFallback {
            run_id: string_path(current, &["link", "runId"]),
            conversation_id: string_path(current, &["link", "conversationId"]),
            source_tool_name: string_path(current, &["link", "sourceToolName"]),
            source_tool_call_id: string_path(current, &["link", "sourceToolCallId"]),
            approval_request_id: string_path(current, &["link", "approvalRequestId"]),
            updated_at: timestamp_from(value_path(current, &["link", "updatedAt"])),
        },
    );

    let mut envelope = Map::new();
    envelope.insert("action".to_string(), Value::Object(action));
    if let Some(snapshot) = snapshot {
        envelope.insert("snapshot".to_string(), snapshot);
    }
    if let Some(link) = link {
        envelope.insert("link".to_string(), link);
    }
    insert_u64(
        &mut envelope,
        "syncedAt",
        Some(timestamp_from(value_path(incoming, &["syncedAt"])).unwrap_or_else(now_millis)),
    );
    Value::Object(envelope)
}

fn merge_artifact_entry(current: &Value, incoming: &Value) -> Value {
    let mut artifact = payload_object_or(value_path(current, &["artifact"])).unwrap_or_default();
    if let Some(incoming_artifact) = payload_object_or(value_path(incoming, &["artifact"])) {
        artifact.extend(incoming_artifact);
    }
    let link = normalize_link(
        value_path(incoming, &["link"]),
        LinkFallback {
            run_id: string_path(current, &["link", "runId"]),
            conversation_id: string_path(current, &["link", "conversationId"]),
            source_tool_name: string_path(current, &["link", "sourceToolName"]),
            source_tool_call_id: string_path(current, &["link", "sourceToolCallId"]),
            approval_request_id: string_path(current, &["link", "approvalRequestId"]),
            updated_at: timestamp_from(value_path(current, &["link", "updatedAt"])),
        },
    );
    let mut envelope = Map::new();
    envelope.insert("artifact".to_string(), Value::Object(artifact));
    insert_string(
        &mut envelope,
        "actionId",
        string_path(incoming, &["actionId"]).or_else(|| string_path(current, &["actionId"])),
    );
    if let Some(link) = link {
        envelope.insert("link".to_string(), link);
    }
    insert_string(
        &mut envelope,
        "bytesBase64",
        string_path(incoming, &["bytesBase64"]).or_else(|| string_path(current, &["bytesBase64"])),
    );
    insert_u64(
        &mut envelope,
        "syncedAt",
        Some(timestamp_from(value_path(incoming, &["syncedAt"])).unwrap_or_else(now_millis)),
    );
    Value::Object(envelope)
}

fn build_session_sync_event(entry: &Value) -> Value {
    let target = resolve_session_target(entry);
    json!({
        "type": "session_synced",
        "sessionId": string_path(entry, &["session", "sessionId"]).unwrap_or_default(),
        "targetId": target.as_ref().and_then(|value| string_path(value, &["targetId"])),
        "state": string_path(entry, &["session", "state"]),
        "source": string_path(entry, &["source"]),
        "syncedAt": timestamp_from(value_path(entry, &["syncedAt"])) .unwrap_or_else(now_millis),
        "link": value_path(entry, &["link"]).cloned(),
    })
}

fn build_action_sync_event(entry: &Value) -> Value {
    json!({
        "type": "action_synced",
        "sessionId": string_path(entry, &["action", "sessionId"]).unwrap_or_default(),
        "actionId": string_path(entry, &["action", "actionId"]),
        "targetId": string_path(entry, &["action", "targetId"]),
        "kind": string_path(entry, &["action", "kind"]),
        "status": string_path(entry, &["action", "status"]),
        "source": "extension-background",
        "syncedAt": timestamp_from(value_path(entry, &["syncedAt"])) .unwrap_or_else(now_millis),
        "errorCode": string_path(entry, &["action", "error", "code"]),
        "resultSummary": string_path(entry, &["action", "resultSummary"]),
        "link": value_path(entry, &["link"]).cloned(),
    })
}

fn build_artifact_sync_event(entry: &Value) -> Value {
    json!({
        "type": "artifact_synced",
        "sessionId": string_path(entry, &["artifact", "sessionId"]).unwrap_or_default(),
        "actionId": string_path(entry, &["actionId"]),
        "artifactId": string_path(entry, &["artifact", "artifactId"]),
        "targetId": string_path(entry, &["artifact", "targetId"]),
        "kind": string_path(entry, &["artifact", "kind"]),
        "mimeType": string_path(entry, &["artifact", "mimeType"]),
        "source": "extension-background",
        "syncedAt": timestamp_from(value_path(entry, &["syncedAt"])) .unwrap_or_else(now_millis),
        "link": value_path(entry, &["link"]).cloned(),
    })
}

fn append_browser_event(snapshot: &mut BrowserSnapshot, event: Value, max_events: usize) {
    let normalized = normalize_event_record(event, snapshot.next_cursor);
    snapshot.next_cursor = normalized
        .get("cursor")
        .and_then(Value::as_u64)
        .unwrap_or(snapshot.next_cursor)
        + 1;
    snapshot.events.push(normalized);
    if snapshot.events.len() > max_events {
        let keep_from = snapshot.events.len() - max_events;
        snapshot.events = snapshot.events.split_off(keep_from);
    }
}

fn normalize_event_record(input: Value, cursor: u64) -> Value {
    json!({
        "cursor": cursor,
        "type": safe_text(input.get("type"), 64).unwrap_or_else(|| "event".to_string()),
        "sessionId": safe_text(input.get("sessionId"), 200).unwrap_or_default(),
        "actionId": safe_text(input.get("actionId"), 200),
        "artifactId": safe_text(input.get("artifactId"), 200),
        "targetId": safe_text(input.get("targetId"), 200),
        "kind": safe_text(input.get("kind"), 64),
        "state": safe_text(input.get("state"), 64),
        "status": safe_text(input.get("status"), 64),
        "source": safe_text(input.get("source"), 64),
        "errorCode": safe_text(input.get("errorCode"), 64),
        "resultSummary": safe_text(input.get("resultSummary"), 500),
        "mimeType": safe_text(input.get("mimeType"), 200),
        "syncedAt": timestamp_or(input.get("syncedAt"), now_millis()),
        "link": input.get("link").cloned(),
    })
}

fn build_session_list_result(snapshot: &BrowserSnapshot, query: BrowserSessionListQuery) -> Value {
    let session_id = query.session_id.as_deref().and_then(trim_optional);
    let state = query.state.as_deref().and_then(trim_optional);
    let owner_conversation_id = query
        .owner_conversation_id
        .as_deref()
        .and_then(trim_optional);
    let filters = LinkFilters::from_session_query(&query);

    let mut sessions = sort_descending(snapshot.sessions.clone(), session_sort_key);
    sessions.retain(|entry| {
        if let Some(ref session_id) = session_id {
            if string_path(entry, &["session", "sessionId"]).as_deref() != Some(session_id.as_str())
            {
                return false;
            }
        }
        if let Some(ref state) = state {
            if string_path(entry, &["session", "state"]).as_deref() != Some(state.as_str()) {
                return false;
            }
        }
        if let Some(ref conversation_id) = owner_conversation_id {
            if string_path(entry, &["session", "ownerConversationId"]).as_deref()
                != Some(conversation_id.as_str())
            {
                return false;
            }
        }
        matches_link_filters(entry, &filters)
    });
    let page = paginate(sessions, query.limit, query.offset);
    json!({
        "total": page.total,
        "limit": page.limit,
        "offset": page.offset,
        "hasMore": page.has_more,
        "sessions": page.items,
    })
}

fn build_action_list_result(snapshot: &BrowserSnapshot, query: BrowserActionListQuery) -> Value {
    let action_id = query.action_id.as_deref().and_then(trim_optional);
    let session_id = query.session_id.as_deref().and_then(trim_optional);
    let target_id = query.target_id.as_deref().and_then(trim_optional);
    let kind = query.kind.as_deref().and_then(trim_optional);
    let status = query.status.as_deref().and_then(trim_optional);
    let filters = LinkFilters::from_action_query(&query);

    let mut actions = sort_descending(snapshot.actions.clone(), action_sort_key);
    actions.retain(|entry| {
        if let Some(ref action_id) = action_id {
            if string_path(entry, &["action", "actionId"]).as_deref() != Some(action_id.as_str()) {
                return false;
            }
        }
        if let Some(ref session_id) = session_id {
            if string_path(entry, &["action", "sessionId"]).as_deref() != Some(session_id.as_str())
            {
                return false;
            }
        }
        if let Some(ref target_id) = target_id {
            if string_path(entry, &["action", "targetId"]).as_deref() != Some(target_id.as_str()) {
                return false;
            }
        }
        if let Some(ref kind) = kind {
            if string_path(entry, &["action", "kind"]).as_deref() != Some(kind.as_str()) {
                return false;
            }
        }
        if let Some(ref status) = status {
            if string_path(entry, &["action", "status"]).as_deref() != Some(status.as_str()) {
                return false;
            }
        }
        matches_link_filters(entry, &filters)
    });
    let page = paginate(actions, query.limit, query.offset);
    json!({
        "total": page.total,
        "limit": page.limit,
        "offset": page.offset,
        "hasMore": page.has_more,
        "actions": page.items,
    })
}

fn build_artifact_list_result(
    snapshot: &BrowserSnapshot,
    query: BrowserArtifactListQuery,
) -> Value {
    let artifact_id = query.artifact_id.as_deref().and_then(trim_optional);
    let session_id = query.session_id.as_deref().and_then(trim_optional);
    let target_id = query.target_id.as_deref().and_then(trim_optional);
    let action_id = query.action_id.as_deref().and_then(trim_optional);
    let kind = query.kind.as_deref().and_then(trim_optional);

    let mut artifacts = sort_descending(snapshot.artifacts.clone(), artifact_sort_key);
    artifacts.retain(|entry| {
        if let Some(ref artifact_id) = artifact_id {
            if string_path(entry, &["artifact", "artifactId"]).as_deref()
                != Some(artifact_id.as_str())
            {
                return false;
            }
        }
        if let Some(ref session_id) = session_id {
            if string_path(entry, &["artifact", "sessionId"]).as_deref()
                != Some(session_id.as_str())
            {
                return false;
            }
        }
        if let Some(ref target_id) = target_id {
            if string_path(entry, &["artifact", "targetId"]).as_deref() != Some(target_id.as_str())
            {
                return false;
            }
        }
        if let Some(ref action_id) = action_id {
            if string_path(entry, &["actionId"]).as_deref() != Some(action_id.as_str()) {
                return false;
            }
        }
        if let Some(ref kind) = kind {
            if string_path(entry, &["artifact", "kind"]).as_deref() != Some(kind.as_str()) {
                return false;
            }
        }
        true
    });
    let page = paginate(artifacts, query.limit, query.offset);
    json!({
        "total": page.total,
        "limit": page.limit,
        "offset": page.offset,
        "hasMore": page.has_more,
        "artifacts": page.items,
    })
}

fn build_event_list_result(snapshot: &BrowserSnapshot, query: BrowserEventsQuery) -> Value {
    let after = query.after.unwrap_or(0);
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let use_tail = query
        .window
        .as_deref()
        .map(|value| value == "tail" || value == "recent")
        .unwrap_or(false);
    let session_id = query.session_id.as_deref().and_then(trim_optional);
    let action_id = query.action_id.as_deref().and_then(trim_optional);
    let artifact_id = query.artifact_id.as_deref().and_then(trim_optional);
    let event_type = query.event_type.as_deref().and_then(trim_optional);
    let filters = LinkFilters::from_events_query(&query);

    let mut events = snapshot
        .events
        .iter()
        .filter(|entry| event_sort_key(entry) > after)
        .filter(|entry| {
            if let Some(ref session_id) = session_id {
                if string_path(entry, &["sessionId"]).as_deref() != Some(session_id.as_str()) {
                    return false;
                }
            }
            if let Some(ref action_id) = action_id {
                if string_path(entry, &["actionId"]).as_deref() != Some(action_id.as_str()) {
                    return false;
                }
            }
            if let Some(ref artifact_id) = artifact_id {
                if string_path(entry, &["artifactId"]).as_deref() != Some(artifact_id.as_str()) {
                    return false;
                }
            }
            if let Some(ref event_type) = event_type {
                if string_path(entry, &["type"]).as_deref() != Some(event_type.as_str()) {
                    return false;
                }
            }
            matches_link_filters(entry, &filters)
        })
        .cloned()
        .collect::<Vec<_>>();
    events.sort_by_key(event_sort_key);

    let selected = if use_tail {
        let keep_from = events.len().saturating_sub(limit);
        events[keep_from..].to_vec()
    } else {
        events.iter().take(limit).cloned().collect::<Vec<_>>()
    };
    let next_cursor = selected
        .last()
        .map(event_sort_key)
        .unwrap_or_else(|| after.max(snapshot.next_cursor.saturating_sub(1)));
    let has_more = if use_tail {
        false
    } else {
        events
            .iter()
            .any(|entry| event_sort_key(entry) > next_cursor)
    };

    json!({
        "ok": true,
        "events": selected,
        "nextCursor": next_cursor,
        "hasMore": has_more,
    })
}

#[derive(Debug, Clone, Default)]
struct NormalizedDrilldownQuery {
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
    session_id: Option<String>,
    action_id: Option<String>,
    artifact_id: Option<String>,
    event_type: Option<String>,
    session_limit: usize,
    action_limit: usize,
    artifact_limit: usize,
    event_limit: usize,
    event_after: u64,
    event_window: Option<String>,
}

fn normalize_drilldown_query(query: BrowserDrilldownQuery) -> NormalizedDrilldownQuery {
    let source_tool_call_id = query.source_tool_call_id.as_deref().and_then(trim_optional);
    NormalizedDrilldownQuery {
        run_id: query.run_id.as_deref().and_then(trim_optional),
        conversation_id: query.conversation_id.as_deref().and_then(trim_optional),
        source_tool_name: if source_tool_call_id.is_some() {
            None
        } else {
            query.source_tool_name.as_deref().and_then(trim_optional)
        },
        source_tool_call_id,
        approval_request_id: query.approval_request_id.as_deref().and_then(trim_optional),
        session_id: query.session_id.as_deref().and_then(trim_optional),
        action_id: query.action_id.as_deref().and_then(trim_optional),
        artifact_id: query.artifact_id.as_deref().and_then(trim_optional),
        event_type: query.event_type.as_deref().and_then(trim_optional),
        session_limit: query.session_limit.unwrap_or(5).clamp(1, 100),
        action_limit: query.action_limit.unwrap_or(8).clamp(1, 100),
        artifact_limit: query.artifact_limit.unwrap_or(6).clamp(1, 100),
        event_limit: query.event_limit.unwrap_or(10).clamp(1, 100),
        event_after: query.event_after.unwrap_or(0),
        event_window: query
            .event_window
            .as_deref()
            .filter(|value| *value == "tail")
            .map(ToString::to_string),
    }
}

fn build_drilldown_filters(query: &NormalizedDrilldownQuery) -> Value {
    let mut filters = Map::new();
    insert_string(&mut filters, "runId", query.run_id.clone());
    insert_string(
        &mut filters,
        "conversationId",
        query.conversation_id.clone(),
    );
    insert_string(
        &mut filters,
        "sourceToolName",
        query.source_tool_name.clone(),
    );
    insert_string(
        &mut filters,
        "sourceToolCallId",
        query.source_tool_call_id.clone(),
    );
    insert_string(
        &mut filters,
        "approvalRequestId",
        query.approval_request_id.clone(),
    );
    insert_string(&mut filters, "sessionId", query.session_id.clone());
    insert_string(&mut filters, "actionId", query.action_id.clone());
    insert_string(&mut filters, "artifactId", query.artifact_id.clone());
    insert_string(&mut filters, "type", query.event_type.clone());
    insert_string(&mut filters, "eventWindow", query.event_window.clone());
    insert_u64(
        &mut filters,
        "sessionLimit",
        Some(query.session_limit as u64),
    );
    insert_u64(&mut filters, "actionLimit", Some(query.action_limit as u64));
    insert_u64(
        &mut filters,
        "artifactLimit",
        Some(query.artifact_limit as u64),
    );
    insert_u64(&mut filters, "eventLimit", Some(query.event_limit as u64));
    insert_u64(&mut filters, "eventAfter", Some(query.event_after));
    Value::Object(filters)
}

#[derive(Debug, Clone, Default)]
struct LinkFilters {
    run_id: Option<String>,
    conversation_id: Option<String>,
    source_tool_name: Option<String>,
    source_tool_call_id: Option<String>,
    approval_request_id: Option<String>,
}

impl LinkFilters {
    fn from_session_query(query: &BrowserSessionListQuery) -> Self {
        Self {
            run_id: query.run_id.as_deref().and_then(trim_optional),
            conversation_id: query.conversation_id.as_deref().and_then(trim_optional),
            source_tool_name: query.source_tool_name.as_deref().and_then(trim_optional),
            source_tool_call_id: query.source_tool_call_id.as_deref().and_then(trim_optional),
            approval_request_id: query.approval_request_id.as_deref().and_then(trim_optional),
        }
    }

    fn from_action_query(query: &BrowserActionListQuery) -> Self {
        Self {
            run_id: query.run_id.as_deref().and_then(trim_optional),
            conversation_id: query.conversation_id.as_deref().and_then(trim_optional),
            source_tool_name: query.source_tool_name.as_deref().and_then(trim_optional),
            source_tool_call_id: query.source_tool_call_id.as_deref().and_then(trim_optional),
            approval_request_id: query.approval_request_id.as_deref().and_then(trim_optional),
        }
    }

    fn from_events_query(query: &BrowserEventsQuery) -> Self {
        Self {
            run_id: query.run_id.as_deref().and_then(trim_optional),
            conversation_id: query.conversation_id.as_deref().and_then(trim_optional),
            source_tool_name: query.source_tool_name.as_deref().and_then(trim_optional),
            source_tool_call_id: query.source_tool_call_id.as_deref().and_then(trim_optional),
            approval_request_id: query.approval_request_id.as_deref().and_then(trim_optional),
        }
    }
}

fn matches_link_filters(entry: &Value, filters: &LinkFilters) -> bool {
    if let Some(ref run_id) = filters.run_id {
        if read_linked_field(entry, "runId").as_deref() != Some(run_id.as_str()) {
            return false;
        }
    }
    if let Some(ref conversation_id) = filters.conversation_id {
        if read_linked_field(entry, "conversationId").as_deref() != Some(conversation_id.as_str()) {
            return false;
        }
    }
    if let Some(ref source_tool_name) = filters.source_tool_name {
        if read_linked_field(entry, "sourceToolName").as_deref() != Some(source_tool_name.as_str())
        {
            return false;
        }
    }
    if let Some(ref source_tool_call_id) = filters.source_tool_call_id {
        if read_linked_field(entry, "sourceToolCallId").as_deref()
            != Some(source_tool_call_id.as_str())
        {
            return false;
        }
    }
    if let Some(ref approval_request_id) = filters.approval_request_id {
        if read_linked_field(entry, "approvalRequestId").as_deref()
            != Some(approval_request_id.as_str())
        {
            return false;
        }
    }
    true
}

fn read_linked_field(entry: &Value, field: &str) -> Option<String> {
    if let Some(value) = string_path(entry, &["link", field]) {
        return Some(value);
    }
    let owner = value_path(entry, &["session"]).or_else(|| value_path(entry, &["action"]));
    match field {
        "runId" => owner.and_then(|value| string_path(value, &["ownerRunId"])),
        "conversationId" => owner.and_then(|value| string_path(value, &["ownerConversationId"])),
        "sourceToolName" => owner.and_then(|value| string_path(value, &["sourceToolName"])),
        "sourceToolCallId" => owner.and_then(|value| string_path(value, &["sourceToolCallId"])),
        "approvalRequestId" => owner.and_then(|value| string_path(value, &["approvalRequestId"])),
        _ => None,
    }
}

fn resolve_session_target(entry: &Value) -> Option<Value> {
    let targets = value_path(entry, &["targets"]).and_then(Value::as_array)?;
    let primary_target_id = string_path(entry, &["session", "primaryTargetId"]);
    if let Some(primary_target_id) = primary_target_id {
        if let Some(target) = targets.iter().find(|target| {
            string_path(target, &["targetId"]).as_deref() == Some(primary_target_id.as_str())
        }) {
            return Some(target.clone());
        }
    }
    if let Some(target) = targets
        .iter()
        .find(|target| bool_from_value(target.get("active")).unwrap_or(false))
    {
        return Some(target.clone());
    }
    targets.first().cloned()
}

fn build_recent_linked_session_summary(entry: &Value) -> Value {
    let target = resolve_session_target(entry);
    let mut summary = Map::new();
    insert_string(
        &mut summary,
        "sessionId",
        string_path(entry, &["session", "sessionId"]),
    );
    insert_string(
        &mut summary,
        "state",
        string_path(entry, &["session", "state"]),
    );
    insert_u64(
        &mut summary,
        "updatedAt",
        Some(
            timestamp_from(value_path(entry, &["session", "updatedAt"]))
                .or_else(|| timestamp_from(value_path(entry, &["session", "createdAt"])))
                .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
                .unwrap_or(0),
        ),
    );
    insert_string(
        &mut summary,
        "targetId",
        target
            .as_ref()
            .and_then(|value| string_path(value, &["targetId"])),
    );
    insert_string(
        &mut summary,
        "url",
        target
            .as_ref()
            .and_then(|value| string_path(value, &["url"])),
    );
    insert_string(
        &mut summary,
        "title",
        target
            .as_ref()
            .and_then(|value| string_path(value, &["title"])),
    );
    summary.insert(
        "link".to_string(),
        value_path(entry, &["link"]).cloned().unwrap_or_else(|| {
            json!({
                "runId": read_linked_field(entry, "runId"),
                "conversationId": read_linked_field(entry, "conversationId"),
                "sourceToolName": read_linked_field(entry, "sourceToolName"),
                "sourceToolCallId": read_linked_field(entry, "sourceToolCallId"),
                "approvalRequestId": read_linked_field(entry, "approvalRequestId"),
                "updatedAt": timestamp_from(value_path(entry, &["session", "updatedAt"]))
                    .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
                    .unwrap_or(0),
            })
        }),
    );
    Value::Object(summary)
}

fn build_recent_linked_action_summary(entry: &Value) -> Value {
    let mut summary = Map::new();
    insert_string(
        &mut summary,
        "actionId",
        string_path(entry, &["action", "actionId"]),
    );
    insert_string(
        &mut summary,
        "sessionId",
        string_path(entry, &["action", "sessionId"]),
    );
    insert_string(
        &mut summary,
        "targetId",
        string_path(entry, &["action", "targetId"]),
    );
    insert_string(
        &mut summary,
        "kind",
        string_path(entry, &["action", "kind"]),
    );
    insert_string(
        &mut summary,
        "status",
        string_path(entry, &["action", "status"]),
    );
    insert_u64(
        &mut summary,
        "finishedAt",
        Some(
            timestamp_from(value_path(entry, &["action", "finishedAt"]))
                .or_else(|| timestamp_from(value_path(entry, &["action", "startedAt"])))
                .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
                .unwrap_or(0),
        ),
    );
    insert_string(
        &mut summary,
        "errorCode",
        string_path(entry, &["action", "error", "code"]),
    );
    insert_string(
        &mut summary,
        "resultSummary",
        string_path(entry, &["action", "resultSummary"]),
    );
    summary.insert(
        "link".to_string(),
        value_path(entry, &["link"]).cloned().unwrap_or_else(|| {
            json!({
                "runId": read_linked_field(entry, "runId"),
                "conversationId": read_linked_field(entry, "conversationId"),
                "sourceToolName": read_linked_field(entry, "sourceToolName"),
                "sourceToolCallId": read_linked_field(entry, "sourceToolCallId"),
                "approvalRequestId": read_linked_field(entry, "approvalRequestId"),
                "updatedAt": timestamp_from(value_path(entry, &["action", "finishedAt"]))
                    .or_else(|| timestamp_from(value_path(entry, &["action", "startedAt"])))
                    .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
                    .unwrap_or(0),
            })
        }),
    );
    Value::Object(summary)
}

struct Page {
    total: usize,
    limit: usize,
    offset: usize,
    has_more: bool,
    items: Vec<Value>,
}

fn paginate(items: Vec<Value>, limit: Option<usize>, offset: Option<usize>) -> Page {
    let total = items.len();
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let offset = offset.unwrap_or(0).min(total);
    let page_items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let has_more = offset + page_items.len() < total;
    Page {
        total,
        limit,
        offset,
        has_more,
        items: page_items,
    }
}

fn session_sort_key(entry: &Value) -> u64 {
    timestamp_from(value_path(entry, &["session", "updatedAt"]))
        .or_else(|| timestamp_from(value_path(entry, &["session", "createdAt"])))
        .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
        .unwrap_or(0)
}

fn action_sort_key(entry: &Value) -> u64 {
    timestamp_from(value_path(entry, &["action", "finishedAt"]))
        .or_else(|| timestamp_from(value_path(entry, &["action", "startedAt"])))
        .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
        .unwrap_or(0)
}

fn artifact_sort_key(entry: &Value) -> u64 {
    timestamp_from(value_path(entry, &["artifact", "createdAt"]))
        .or_else(|| timestamp_from(value_path(entry, &["syncedAt"])))
        .unwrap_or(0)
}

fn event_sort_key(entry: &Value) -> u64 {
    timestamp_from(value_path(entry, &["cursor"])).unwrap_or(0)
}

fn sort_descending(mut items: Vec<Value>, sort_key: fn(&Value) -> u64) -> Vec<Value> {
    items.sort_by(|left, right| sort_key(right).cmp(&sort_key(left)));
    items
}

fn value_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    safe_text(value_path(value, path), 2_000)
}

fn timestamp_from(raw: Option<&Value>) -> Option<u64> {
    number_from_value(raw)
}

fn timestamp_or(raw: Option<&Value>, fallback: u64) -> u64 {
    timestamp_from(raw).unwrap_or(fallback)
}

fn number_from_value(raw: Option<&Value>) -> Option<u64> {
    match raw? {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_i64()
                .and_then(|value| (value >= 0).then_some(value as u64))
        }),
        Value::String(value) => value.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn bool_from_value(raw: Option<&Value>) -> Option<bool> {
    match raw? {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn safe_text(raw: Option<&Value>, max_chars: usize) -> Option<String> {
    let raw = raw?;
    let mut text = match raw {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    if text.len() > max_chars {
        let prefix = max_chars.saturating_sub(16).max(32).min(text.len());
        text = format!("{}...[truncated]", text[..prefix].trim_end());
    }
    Some(text)
}

fn stringify_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn trim_optional(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn payload_object_or(value: Option<&Value>) -> Option<Map<String, Value>> {
    value.and_then(Value::as_object).cloned()
}

fn insert_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Value::String(value));
    }
}

fn insert_u64(target: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Value::Number(Number::from(value)));
    }
}

fn insert_optional_timestamp(target: &mut Map<String, Value>, key: &str, raw: Option<&Value>) {
    if let Some(value) = timestamp_from(raw) {
        insert_u64(target, key, Some(value));
    }
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_ledger() -> (BrowserLedger, TempDir) {
        let dir = TempDir::new().unwrap();
        let ledger = BrowserLedger::new_in(dir.path().to_path_buf());
        (ledger, dir)
    }

    #[test]
    fn sync_roundtrip_persists_and_lists_browser_records() {
        let (ledger, _dir) = test_ledger();
        let session = ledger
            .sync_session(json!({
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
                    "active": true
                }],
                "link": {
                    "runId": "run-1",
                    "conversationId": "conv-1",
                    "sourceToolCallId": "tool-call-1"
                }
            }))
            .unwrap();
        assert_eq!(
            string_path(&session, &["session", "sessionId"]).as_deref(),
            Some("browser-session-1")
        );

        let action = ledger
            .sync_action(json!({
                "action": {
                    "actionId": "browser-action-1",
                    "sessionId": "browser-session-1",
                    "kind": "navigate",
                    "status": "completed",
                    "startedAt": 20,
                    "finishedAt": 21,
                    "inputSummary": "navigate",
                    "resultSummary": "done"
                },
                "link": {
                    "runId": "run-1",
                    "conversationId": "conv-1",
                    "sourceToolCallId": "tool-call-1"
                }
            }))
            .unwrap();
        assert_eq!(
            string_path(&action, &["action", "actionId"]).as_deref(),
            Some("browser-action-1")
        );

        let artifact = ledger
            .sync_artifact(json!({
                "artifact": {
                    "artifactId": "browser-artifact-1",
                    "sessionId": "browser-session-1",
                    "kind": "screenshot",
                    "mimeType": "image/png",
                    "byteLength": 128,
                    "pathOrKey": "browser/snap.png"
                },
                "actionId": "browser-action-1"
            }))
            .unwrap();
        assert_eq!(
            string_path(&artifact, &["artifact", "artifactId"]).as_deref(),
            Some("browser-artifact-1")
        );

        let sessions = ledger
            .list_sessions(BrowserSessionListQuery {
                run_id: Some("run-1".to_string()),
                ..BrowserSessionListQuery::default()
            })
            .unwrap();
        assert_eq!(sessions["total"].as_u64(), Some(1));

        let actions = ledger
            .list_actions(BrowserActionListQuery {
                source_tool_call_id: Some("tool-call-1".to_string()),
                ..BrowserActionListQuery::default()
            })
            .unwrap();
        assert_eq!(actions["total"].as_u64(), Some(1));

        let events = ledger
            .list_events(BrowserEventsQuery {
                after: Some(0),
                limit: Some(10),
                ..BrowserEventsQuery::default()
            })
            .unwrap();
        assert_eq!(events["events"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn diagnostics_and_drilldown_follow_source_tool_call_filter() {
        let (ledger, _dir) = test_ledger();
        ledger
            .sync_session(json!({
                "session": {
                    "sessionId": "browser-session-2",
                    "state": "ready"
                },
                "link": {
                    "runId": "run-2",
                    "conversationId": "conv-2",
                    "sourceToolName": "browser_navigate",
                    "sourceToolCallId": "tool-call-2",
                    "approvalRequestId": "approval-2"
                }
            }))
            .unwrap();
        ledger
            .sync_action(json!({
                "action": {
                    "actionId": "browser-action-2",
                    "sessionId": "browser-session-2",
                    "kind": "click",
                    "status": "completed",
                    "resultSummary": "clicked"
                },
                "link": {
                    "runId": "run-2",
                    "conversationId": "conv-2",
                    "sourceToolName": "browser_click",
                    "sourceToolCallId": "tool-call-2",
                    "approvalRequestId": "approval-2"
                }
            }))
            .unwrap();
        ledger
            .sync_artifact(json!({
                "artifact": {
                    "artifactId": "browser-artifact-2",
                    "sessionId": "browser-session-2",
                    "kind": "screenshot",
                    "mimeType": "image/png",
                    "byteLength": 64,
                    "pathOrKey": "browser/two.png"
                },
                "actionId": "browser-action-2",
                "link": {
                    "runId": "run-2",
                    "conversationId": "conv-2",
                    "sourceToolName": "browser_click",
                    "sourceToolCallId": "tool-call-2",
                    "approvalRequestId": "approval-2"
                }
            }))
            .unwrap();

        let diagnostics = ledger.diagnostics(&SupportedFeatures::default()).unwrap();
        assert_eq!(diagnostics["sessions"]["linked"].as_u64(), Some(1));
        assert_eq!(diagnostics["actions"]["linked"].as_u64(), Some(1));

        let drilldown = ledger
            .drilldown(BrowserDrilldownQuery {
                run_id: Some("run-2".to_string()),
                conversation_id: Some("conv-2".to_string()),
                source_tool_name: Some("browser_click".to_string()),
                source_tool_call_id: Some("tool-call-2".to_string()),
                approval_request_id: Some("approval-2".to_string()),
                session_id: Some("browser-session-2".to_string()),
                action_id: Some("browser-action-2".to_string()),
                event_window: Some("tail".to_string()),
                event_limit: Some(2),
                ..BrowserDrilldownQuery::default()
            })
            .unwrap();
        assert_eq!(drilldown["sessions"]["total"].as_u64(), Some(1));
        assert_eq!(drilldown["actions"]["total"].as_u64(), Some(1));
        assert_eq!(drilldown["artifacts"]["total"].as_u64(), Some(1));
        assert_eq!(drilldown["filters"].get("sourceToolName"), None);
        assert_eq!(
            drilldown["filters"]["sourceToolCallId"].as_str(),
            Some("tool-call-2")
        );
    }
}
