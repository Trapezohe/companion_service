use crate::{
    autostart::{LoginItemMode, StartupPolicy},
    models::{CompanionShellState, StartupContextView, StatusViewModel},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupAction {
    Noop,
    EnsureDaemon,
    RevealPanel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupDecision {
    pub action: StartupAction,
    pub note: String,
}

pub fn startup_context(
    launch_source: &str,
    phase: &str,
    note: impl Into<String>,
) -> StartupContextView {
    StartupContextView {
        launch_source: launch_source.to_string(),
        phase: phase.to_string(),
        note: note.into(),
    }
}

pub fn context_from_decision(
    launch_source: &str,
    decision: &StartupDecision,
) -> StartupContextView {
    let phase = match decision.action {
        StartupAction::Noop => "ready",
        StartupAction::EnsureDaemon => "ensuring",
        StartupAction::RevealPanel => "attention",
    };
    startup_context(launch_source, phase, decision.note.clone())
}

pub fn decide_startup_action(
    policy: Option<&StartupPolicy>,
    has_config: bool,
    snapshot: &StatusViewModel,
) -> StartupDecision {
    match &snapshot.state {
        CompanionShellState::Healthy { .. } | CompanionShellState::Checking => StartupDecision {
            action: StartupAction::Noop,
            note: "tray launch found a healthy or still-refreshing runtime".into(),
        },
        CompanionShellState::Misconfigured { reason } => StartupDecision {
            action: StartupAction::RevealPanel,
            note: format!("startup needs setup attention: {reason}"),
        },
        CompanionShellState::Degraded { reason } => StartupDecision {
            action: StartupAction::RevealPanel,
            note: format!("startup found a degraded runtime: {reason}"),
        },
        CompanionShellState::Stopped if !has_config => StartupDecision {
            action: StartupAction::RevealPanel,
            note: "startup cannot ensure the daemon because local config is missing".into(),
        },
        CompanionShellState::Stopped if policy_allows_daemon_ensure(policy) => StartupDecision {
            action: StartupAction::EnsureDaemon,
            note: "startup policy says the tray should ensure the local daemon".into(),
        },
        CompanionShellState::Stopped => StartupDecision {
            action: StartupAction::Noop,
            note: "startup policy leaves the daemon stopped until the user opens the panel".into(),
        },
    }
}

pub fn decide_post_ensure_action(snapshot: &StatusViewModel) -> StartupDecision {
    match &snapshot.state {
        CompanionShellState::Healthy { .. } => StartupDecision {
            action: StartupAction::Noop,
            note: "daemon ensure completed successfully".into(),
        },
        CompanionShellState::Checking => StartupDecision {
            action: StartupAction::Noop,
            note: "daemon ensure is still settling".into(),
        },
        CompanionShellState::Stopped => StartupDecision {
            action: StartupAction::RevealPanel,
            note: "daemon ensure finished but the runtime is still stopped".into(),
        },
        CompanionShellState::Degraded { reason } => StartupDecision {
            action: StartupAction::RevealPanel,
            note: format!("daemon ensure left the runtime degraded: {reason}"),
        },
        CompanionShellState::Misconfigured { reason } => StartupDecision {
            action: StartupAction::RevealPanel,
            note: format!("daemon ensure exposed a setup problem: {reason}"),
        },
    }
}

fn policy_allows_daemon_ensure(policy: Option<&StartupPolicy>) -> bool {
    matches!(
        policy,
        Some(StartupPolicy {
            login_item: LoginItemMode::Tray,
            ensure_daemon_on_tray_launch: true,
        })
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn startup_policy_enabled() -> StartupPolicy {
        StartupPolicy {
            login_item: LoginItemMode::Tray,
            ensure_daemon_on_tray_launch: true,
        }
    }

    fn snapshot(state: CompanionShellState) -> StatusViewModel {
        StatusViewModel {
            state,
            ..StatusViewModel::default()
        }
    }

    #[test]
    fn policy_enabled_stopped_with_config_ensures_daemon() {
        let decision = decide_startup_action(
            Some(&startup_policy_enabled()),
            true,
            &snapshot(CompanionShellState::Stopped),
        );

        assert_eq!(decision.action, StartupAction::EnsureDaemon);
    }

    #[test]
    fn healthy_runtime_stays_silent_on_startup() {
        let decision = decide_startup_action(
            Some(&startup_policy_enabled()),
            true,
            &snapshot(CompanionShellState::Healthy {
                version: "0.1.0".into(),
                protocol_version: None,
                pid: 123,
                mcp_servers: 2,
                mcp_tools: 8,
            }),
        );

        assert_eq!(decision.action, StartupAction::Noop);
    }

    #[test]
    fn misconfigured_startup_reveals_panel() {
        let decision = decide_startup_action(
            Some(&startup_policy_enabled()),
            false,
            &snapshot(CompanionShellState::Misconfigured {
                reason: "missing token".into(),
            }),
        );

        assert_eq!(decision.action, StartupAction::RevealPanel);
    }

    #[test]
    fn stopped_without_config_reveals_panel_instead_of_ensuring() {
        let decision = decide_startup_action(
            Some(&startup_policy_enabled()),
            false,
            &snapshot(CompanionShellState::Stopped),
        );

        assert_eq!(decision.action, StartupAction::RevealPanel);
    }

    #[test]
    fn degraded_state_after_ensure_failure_reveals_panel() {
        let decision = decide_post_ensure_action(&snapshot(CompanionShellState::Degraded {
            reason: "health check never recovered".into(),
        }));

        assert_eq!(decision.action, StartupAction::RevealPanel);
    }
}
