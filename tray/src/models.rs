use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompanionShellState {
    Checking,
    Healthy {
        version: String,
        protocol_version: Option<String>,
        pid: u32,
        mcp_servers: u32,
        mcp_tools: u32,
    },
    Degraded {
        reason: String,
    },
    Stopped,
    Misconfigured {
        reason: String,
    },
}

impl Default for CompanionShellState {
    fn default() -> Self {
        Self::Checking
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CompanionConfig {
    pub port: u16,
    pub token: String,
    pub config_path: String,
    pub logs_dir: String,
}

impl CompanionConfig {
    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct HealthSnapshot {
    pub pid: u32,
    pub version: String,
    pub protocol_version: Option<String>,
    pub mcp_servers: u32,
    pub mcp_tools: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct McpServerSnapshot {
    pub name: String,
    pub status: String,
    pub tool_count: u32,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RecentFailure {
    pub run_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DiagnosticsSnapshot {
    pub connected_mcp_servers: u32,
    pub configured_mcp_servers: u32,
    pub total_mcp_tools: u32,
    pub running_acp_sessions: u32,
    pub idle_acp_sessions: u32,
    pub pending_approvals: u32,
    #[serde(default)]
    pub recent_failures: Vec<RecentFailure>,
    #[serde(default)]
    pub servers: Vec<McpServerSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RepairAction {
    pub id: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SelfCheckSnapshot {
    pub ok: bool,
    #[serde(default)]
    pub failing_checks: Vec<String>,
    #[serde(default)]
    pub repair_actions: Vec<RepairAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StatusActions {
    pub can_start: bool,
    pub can_stop: bool,
    pub can_restart: bool,
    pub can_open_logs: bool,
    pub can_run_self_check: bool,
}

impl StatusActions {
    pub fn from_state(state: &CompanionShellState, has_logs_dir: bool, has_config: bool) -> Self {
        match state {
            CompanionShellState::Healthy { .. } | CompanionShellState::Degraded { .. } => Self {
                can_start: false,
                can_stop: true,
                can_restart: true,
                can_open_logs: has_logs_dir,
                can_run_self_check: has_config,
            },
            CompanionShellState::Stopped => Self {
                can_start: has_config,
                can_stop: false,
                can_restart: false,
                can_open_logs: has_logs_dir,
                can_run_self_check: has_config,
            },
            CompanionShellState::Misconfigured { .. } => Self {
                can_start: false,
                can_stop: false,
                can_restart: false,
                can_open_logs: has_logs_dir,
                can_run_self_check: has_config,
            },
            CompanionShellState::Checking => Self {
                can_start: false,
                can_stop: false,
                can_restart: false,
                can_open_logs: has_logs_dir,
                can_run_self_check: has_config,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StatusViewModel {
    pub state: CompanionShellState,
    pub config_path: String,
    pub logs_dir: String,
    pub endpoint: String,
    pub checked_at_ms: u64,
    pub last_error: Option<String>,
    pub health: Option<HealthSnapshot>,
    pub diagnostics: Option<DiagnosticsSnapshot>,
    pub self_check: Option<SelfCheckSnapshot>,
    pub actions: StatusActions,
}

impl StatusViewModel {
    pub fn from_probe_results(
        config: &CompanionConfig,
        health: Option<HealthSnapshot>,
        diagnostics: Option<DiagnosticsSnapshot>,
        self_check: Option<SelfCheckSnapshot>,
        last_error: Option<String>,
        checked_at_ms: u64,
    ) -> Self {
        let state = derive_state(
            health.as_ref(),
            diagnostics.as_ref(),
            self_check.as_ref(),
            last_error.as_deref(),
        );
        let actions = StatusActions::from_state(
            &state,
            !config.logs_dir.trim().is_empty(),
            !config.config_path.trim().is_empty(),
        );

        Self {
            state,
            config_path: config.config_path.clone(),
            logs_dir: config.logs_dir.clone(),
            endpoint: config.endpoint(),
            checked_at_ms,
            last_error,
            health,
            diagnostics,
            self_check,
            actions,
        }
    }

    pub fn misconfigured(reason: impl Into<String>, checked_at_ms: u64) -> Self {
        let reason = reason.into();
        let state = CompanionShellState::Misconfigured {
            reason: reason.clone(),
        };
        Self {
            state: state.clone(),
            checked_at_ms,
            last_error: Some(reason),
            actions: StatusActions::from_state(&state, false, false),
            ..Self::default()
        }
    }

    pub fn headline(&self) -> &'static str {
        match self.state {
            CompanionShellState::Checking => "Checking local companion",
            CompanionShellState::Healthy { .. } => "Companion is ready",
            CompanionShellState::Degraded { .. } => "Companion needs attention",
            CompanionShellState::Stopped => "Companion is offline",
            CompanionShellState::Misconfigured { .. } => "Companion needs setup",
        }
    }

    pub fn pending_approvals(&self) -> u32 {
        self.diagnostics
            .as_ref()
            .map(|item| item.pending_approvals)
            .unwrap_or(0)
    }

    pub fn running_sessions(&self) -> u32 {
        self.diagnostics
            .as_ref()
            .map(|item| item.running_acp_sessions)
            .unwrap_or(0)
    }

    pub fn repair_actions(&self) -> &[RepairAction] {
        self.self_check
            .as_ref()
            .map(|item| item.repair_actions.as_slice())
            .unwrap_or(&[])
    }
}

fn derive_state(
    health: Option<&HealthSnapshot>,
    diagnostics: Option<&DiagnosticsSnapshot>,
    self_check: Option<&SelfCheckSnapshot>,
    last_error: Option<&str>,
) -> CompanionShellState {
    if let Some(health) = health {
        if let Some(check) = self_check {
            if !check.ok {
                return CompanionShellState::Degraded {
                    reason: summarize_self_check_issue(check),
                };
            }
        }
        if let Some(diag) = diagnostics {
            if !diag.recent_failures.is_empty() {
                return CompanionShellState::Degraded {
                    reason: format!(
                        "{} recent runtime {}",
                        diag.recent_failures.len(),
                        pluralize(diag.recent_failures.len(), "failure", "failures"),
                    ),
                };
            }
        } else if let Some(error) = last_error {
            return CompanionShellState::Degraded {
                reason: error.to_string(),
            };
        }
        return CompanionShellState::Healthy {
            version: health.version.clone(),
            protocol_version: health.protocol_version.clone(),
            pid: health.pid,
            mcp_servers: health.mcp_servers,
            mcp_tools: health.mcp_tools,
        };
    }

    if let Some(check) = self_check {
        if !check.ok {
            return CompanionShellState::Misconfigured {
                reason: summarize_self_check_issue(check),
            };
        }
    }

    if let Some(error) = last_error {
        if looks_like_config_error(error) {
            return CompanionShellState::Misconfigured {
                reason: error.to_string(),
            };
        }
    }

    CompanionShellState::Stopped
}

fn summarize_self_check_issue(check: &SelfCheckSnapshot) -> String {
    if let Some(first) = check.failing_checks.first() {
        let label = humanize_check_name(first);
        let total = check.failing_checks.len();
        if total > 1 {
            return format!(
                "{label} and {} more issue{}",
                total - 1,
                pluralize(total - 1, "", "s")
            );
        }
        return label;
    }
    if let Some(first) = check.repair_actions.first() {
        return first.title.clone();
    }
    "Self-check reported configuration issues".into()
}

fn humanize_check_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Configuration issue detected".into();
    }
    let pretty = trimmed.replace(['_', '-'], " ");
    let mut chars = pretty.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Configuration issue detected".into(),
    }
}

fn looks_like_config_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("missing token")
        || normalized.contains("failed to read config")
        || normalized.contains("failed to parse")
        || normalized.contains("config")
}

fn pluralize<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 {
        singular
    } else {
        plural
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> CompanionConfig {
        CompanionConfig {
            port: 41591,
            token: "secret".into(),
            config_path: "/Users/test/.trapezohe/companion.json".into(),
            logs_dir: "/Users/test/.trapezohe/logs".into(),
        }
    }

    fn sample_health() -> HealthSnapshot {
        HealthSnapshot {
            pid: 4242,
            version: "0.1.0".into(),
            protocol_version: Some("trapezohe-companion/2026-03-07".into()),
            mcp_servers: 2,
            mcp_tools: 9,
        }
    }

    fn sample_diagnostics() -> DiagnosticsSnapshot {
        DiagnosticsSnapshot {
            connected_mcp_servers: 2,
            configured_mcp_servers: 3,
            total_mcp_tools: 9,
            running_acp_sessions: 1,
            idle_acp_sessions: 0,
            pending_approvals: 2,
            recent_failures: vec![RecentFailure {
                run_id: "run_1".into(),
                summary: "MCP server restart failed".into(),
            }],
            servers: vec![McpServerSnapshot {
                name: "bnbchain-mcp".into(),
                status: "connected".into(),
                tool_count: 3,
                command: "node".into(),
            }],
        }
    }

    #[test]
    fn derives_degraded_panel_snapshot_with_repair_actions() {
        let snapshot = StatusViewModel::from_probe_results(
            &sample_config(),
            Some(sample_health()),
            Some(sample_diagnostics()),
            Some(SelfCheckSnapshot {
                ok: false,
                failing_checks: vec!["native_host_registration".into()],
                repair_actions: vec![RepairAction {
                    id: "register_native_host".into(),
                    title: "Re-register native host".into(),
                    description: "Restore browser registration.".into(),
                }],
            }),
            None,
            1_772_431_234_000,
        );

        assert!(matches!(
            snapshot.state,
            CompanionShellState::Degraded { .. }
        ));
        assert_eq!(snapshot.pending_approvals(), 2);
        assert_eq!(snapshot.running_sessions(), 1);
        assert_eq!(snapshot.repair_actions().len(), 1);
        assert_eq!(snapshot.headline(), "Companion needs attention");
        assert!(!snapshot.actions.can_start);
        assert!(snapshot.actions.can_restart);
    }

    #[test]
    fn derives_stopped_panel_snapshot_without_live_service() {
        let snapshot = StatusViewModel::from_probe_results(
            &sample_config(),
            None,
            None,
            Some(SelfCheckSnapshot {
                ok: true,
                failing_checks: Vec::new(),
                repair_actions: Vec::new(),
            }),
            Some("service_unreachable".into()),
            1_772_431_234_000,
        );

        assert!(matches!(snapshot.state, CompanionShellState::Stopped));
        assert_eq!(snapshot.pending_approvals(), 0);
        assert_eq!(snapshot.running_sessions(), 0);
        assert_eq!(snapshot.headline(), "Companion is offline");
        assert!(snapshot.actions.can_start);
        assert!(!snapshot.actions.can_stop);
        assert!(!snapshot.actions.can_restart);
    }
}
