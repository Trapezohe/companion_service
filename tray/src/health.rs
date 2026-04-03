use anyhow::Result;
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{
    daemon,
    models::{
        ActionLogEntry, CompanionConfig, CompanionShellState, DiagnosticsSnapshot, HealthSnapshot,
        McpServerSnapshot, RecentFailure, StatusActions, StatusViewModel,
    },
};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HealthPayload {
    pub ok: bool,
    pub pid: u32,
    pub version: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: Option<String>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: u32,
    #[serde(rename = "mcpTools")]
    pub mcp_tools: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsPayload {
    #[serde(default)]
    mcp: DiagnosticsMcpPayload,
    #[serde(default)]
    runs: DiagnosticsRunsPayload,
    #[serde(default)]
    approvals: DiagnosticsApprovalsPayload,
    #[serde(default)]
    acp: DiagnosticsAcpPayload,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsMcpPayload {
    #[serde(rename = "configuredServers", default)]
    configured_servers: u32,
    #[serde(rename = "connectedServers", default)]
    connected_servers: u32,
    #[serde(rename = "totalTools", default)]
    total_tools: u32,
    #[serde(default)]
    servers: Vec<DiagnosticsMcpServerPayload>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsMcpServerPayload {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(rename = "toolCount", default)]
    tool_count: u32,
    #[serde(default)]
    command: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsRunsPayload {
    #[serde(rename = "recentFailed", default)]
    recent_failed: Vec<DiagnosticsRunPayload>,
    #[serde(rename = "recentActions", default)]
    recent_actions: Vec<DiagnosticsActionLogPayload>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsRunPayload {
    #[serde(rename = "runId", default)]
    run_id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    error: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsActionLogPayload {
    #[serde(rename = "runId", default)]
    run_id: String,
    #[serde(default)]
    timestamp: u64,
    #[serde(rename = "actionName", default)]
    action_name: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    detail: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsApprovalsPayload {
    #[serde(default)]
    pending: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct DiagnosticsAcpPayload {
    #[serde(rename = "runningSessions", default)]
    running_sessions: u32,
    #[serde(rename = "idleSessions", default)]
    idle_sessions: u32,
}

pub fn checking_snapshot(config: &CompanionConfig) -> StatusViewModel {
    let state = CompanionShellState::Checking;
    StatusViewModel {
        state: state.clone(),
        config_path: config.config_path.clone(),
        logs_dir: config.logs_dir.clone(),
        endpoint: config.endpoint(),
        checked_at_ms: now_ms(),
        actions: StatusActions::from_state(
            &state,
            !config.logs_dir.is_empty(),
            !config.config_path.is_empty(),
        ),
        ..StatusViewModel::default()
    }
}

pub fn misconfigured_snapshot(reason: impl Into<String>) -> StatusViewModel {
    StatusViewModel::misconfigured(reason.into(), now_ms())
}

pub fn map_health_payload(payload: HealthPayload) -> HealthSnapshot {
    HealthSnapshot {
        pid: payload.pid,
        version: payload.version,
        protocol_version: payload.protocol_version,
        mcp_servers: payload.mcp_servers,
        mcp_tools: payload.mcp_tools,
    }
}

fn map_diagnostics_payload(payload: DiagnosticsPayload) -> DiagnosticsSnapshot {
    DiagnosticsSnapshot {
        connected_mcp_servers: payload.mcp.connected_servers,
        configured_mcp_servers: payload.mcp.configured_servers,
        total_mcp_tools: payload.mcp.total_tools,
        running_acp_sessions: payload.acp.running_sessions,
        idle_acp_sessions: payload.acp.idle_sessions,
        pending_approvals: payload.approvals.pending.len() as u32,
        recent_failures: payload
            .runs
            .recent_failed
            .into_iter()
            .filter(|item| item.error != "companion_restart_recovery")
            .map(|item| RecentFailure {
                run_id: item.run_id,
                summary: item.summary,
                error: item.error,
            })
            .collect(),
        servers: payload
            .mcp
            .servers
            .into_iter()
            .map(|item| McpServerSnapshot {
                name: item.name,
                status: item.status,
                tool_count: item.tool_count,
                command: item.command,
            })
            .collect(),
        action_logs: payload
            .runs
            .recent_actions
            .into_iter()
            .map(|item| ActionLogEntry {
                run_id: item.run_id,
                timestamp: item.timestamp,
                action_name: item.action_name,
                target: item.target,
                status: item.status,
                detail: item.detail,
            })
            .collect(),
    }
}

pub async fn fetch_health(config: &CompanionConfig) -> Result<HealthSnapshot> {
    let payload = fetch_json::<HealthPayload>(config, "/healthz").await?;
    Ok(map_health_payload(payload))
}

pub async fn fetch_diagnostics(config: &CompanionConfig) -> Result<DiagnosticsSnapshot> {
    let payload = fetch_json::<DiagnosticsPayload>(config, "/api/system/diagnostics").await?;
    Ok(map_diagnostics_payload(payload))
}

pub async fn collect_status_snapshot(
    config: &CompanionConfig,
    previous: Option<&StatusViewModel>,
    force_self_check: bool,
) -> StatusViewModel {
    let checked_at_ms = now_ms();
    let mut last_error = None;

    let health = match fetch_health(config).await {
        Ok(payload) => Some(payload),
        Err(error) => {
            last_error = Some(error.to_string());
            None
        }
    };

    let diagnostics = if health.is_some() {
        match fetch_diagnostics(config).await {
            Ok(payload) => Some(payload),
            Err(error) => {
                last_error.get_or_insert_with(|| error.to_string());
                None
            }
        }
    } else {
        None
    };

    let previous_self_check = previous.and_then(|snapshot| snapshot.self_check.clone());
    let self_check = if force_self_check || previous_self_check.is_none() {
        match daemon::run_self_check() {
            Ok(snapshot) => Some(snapshot),
            Err(error) => {
                last_error.get_or_insert_with(|| error.to_string());
                previous_self_check
            }
        }
    } else {
        previous_self_check
    };

    StatusViewModel::from_probe_results(
        config,
        health,
        diagnostics,
        self_check,
        last_error,
        checked_at_ms,
    )
}

async fn fetch_json<T: for<'de> Deserialize<'de>>(
    config: &CompanionConfig,
    path: &str,
) -> Result<T> {
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(3))
        .build()?;
    let response = client
        .get(format!("{}{}", config.endpoint(), path))
        .bearer_auth(&config.token)
        .send()
        .await?;
    let response = response.error_for_status()?;
    Ok(response.json::<T>().await?)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_healthy_payload_into_snapshot() {
        let model = map_health_payload(HealthPayload {
            ok: true,
            pid: 123,
            version: "0.1.2".into(),
            protocol_version: Some("trapezohe-companion/2026-03-07".into()),
            mcp_servers: 2,
            mcp_tools: 5,
        });

        assert_eq!(model.pid, 123);
        assert_eq!(model.mcp_servers, 2);
        assert_eq!(model.mcp_tools, 5);
    }

    #[test]
    fn maps_diagnostics_payload_into_snapshot() {
        let payload = DiagnosticsPayload {
            mcp: DiagnosticsMcpPayload {
                configured_servers: 3,
                connected_servers: 2,
                total_tools: 9,
                servers: vec![DiagnosticsMcpServerPayload {
                    name: "bnbchain-mcp".into(),
                    status: "connected".into(),
                    tool_count: 4,
                    command: "node".into(),
                }],
            },
            runs: DiagnosticsRunsPayload {
                recent_failed: vec![DiagnosticsRunPayload {
                    run_id: "run_1".into(),
                    summary: "Restart failed".into(),
                    error: "runtime_restart_failed".into(),
                }],
                recent_actions: vec![DiagnosticsActionLogPayload {
                    run_id: "run_action_1".into(),
                    timestamp: 1_710_000_000_000,
                    action_name: "open_url".into(),
                    target: "https://example.com".into(),
                    status: "success".into(),
                    detail: "page opened".into(),
                }],
            },
            approvals: DiagnosticsApprovalsPayload {
                pending: vec![serde_json::json!({ "approvalId": "ap_1" })],
            },
            acp: DiagnosticsAcpPayload {
                running_sessions: 1,
                idle_sessions: 2,
            },
        };

        let mapped = map_diagnostics_payload(payload);
        assert_eq!(mapped.connected_mcp_servers, 2);
        assert_eq!(mapped.pending_approvals, 1);
        assert_eq!(mapped.running_acp_sessions, 1);
        assert_eq!(mapped.recent_failures.len(), 1);
        assert_eq!(mapped.action_logs.len(), 1);
        assert_eq!(mapped.action_logs[0].action_name, "open_url");
        assert_eq!(mapped.servers[0].tool_count, 4);
    }

    #[test]
    fn ignores_restart_recovery_failures_in_diagnostics_mapping() {
        let payload = DiagnosticsPayload {
            runs: DiagnosticsRunsPayload {
                recent_failed: vec![DiagnosticsRunPayload {
                    run_id: "run_recovery".into(),
                    summary: "Session orphaned after companion restart".into(),
                    error: "companion_restart_recovery".into(),
                }],
                recent_actions: Vec::new(),
            },
            ..DiagnosticsPayload::default()
        };

        let mapped = map_diagnostics_payload(payload);
        assert!(mapped.recent_failures.is_empty());
    }

    #[test]
    fn marks_misconfigured_snapshot() {
        let model = misconfigured_snapshot("missing token");
        match model.state {
            CompanionShellState::Misconfigured { reason } => {
                assert!(reason.contains("missing token"))
            }
            _ => panic!("expected misconfigured state"),
        }
    }
}
