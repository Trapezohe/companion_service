use tauri::{image::Image, AppHandle, Wry};

use crate::models::{CompanionShellState, DisplayLanguage, StatusViewModel};

pub const TRAY_ID: &str = "companion-tray";

fn icon_bytes_for_state(state: &CompanionShellState) -> &'static [u8] {
    match state {
        CompanionShellState::Healthy { .. } => include_bytes!("../icons/tray-green.png"),
        CompanionShellState::Checking | CompanionShellState::Degraded { .. } => {
            include_bytes!("../icons/tray-yellow.png")
        }
        CompanionShellState::Stopped | CompanionShellState::Misconfigured { .. } => {
            include_bytes!("../icons/tray-red.png")
        }
    }
}

fn truncate(input: &str, limit: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn localized_status_word(state: &CompanionShellState, language: DisplayLanguage) -> &'static str {
    match language {
        DisplayLanguage::En => match state {
            CompanionShellState::Healthy { .. } => "Healthy",
            CompanionShellState::Checking => "Checking",
            CompanionShellState::Stopped => "Stopped",
            CompanionShellState::Degraded { .. } => "Needs Attention",
            CompanionShellState::Misconfigured { .. } => "Setup Needed",
        },
        DisplayLanguage::Zh => match state {
            CompanionShellState::Healthy { .. } => "正常",
            CompanionShellState::Checking => "检查中",
            CompanionShellState::Stopped => "已停止",
            CompanionShellState::Degraded { .. } => "需注意",
            CompanionShellState::Misconfigured { .. } => "需设置",
        },
    }
}

pub fn tooltip_for_state(snapshot: &StatusViewModel) -> String {
    let update_suffix = snapshot
        .update
        .as_ref()
        .filter(|u| u.available)
        .map(|u| match snapshot.language {
            DisplayLanguage::En => format!(" · Update v{}", u.latest_version),
            DisplayLanguage::Zh => format!(" · 可更新 v{}", u.latest_version),
        })
        .unwrap_or_default();

    match snapshot.language {
        DisplayLanguage::En => match &snapshot.state {
            CompanionShellState::Healthy {
                version,
                mcp_servers,
                mcp_tools,
                ..
            } => format!(
                "Trapezohe Companion · {} · v{version} · MCP {mcp_servers}/{mcp_tools}{update_suffix}",
                localized_status_word(&snapshot.state, snapshot.language)
            ),
            CompanionShellState::Checking
            | CompanionShellState::Stopped
            | CompanionShellState::Degraded { .. }
            | CompanionShellState::Misconfigured { .. } => {
                let mut label = format!(
                    "Trapezohe Companion · {}",
                    localized_status_word(&snapshot.state, snapshot.language)
                );
                if let CompanionShellState::Degraded { reason }
                | CompanionShellState::Misconfigured { reason } = &snapshot.state
                {
                    label.push_str(" · ");
                    label.push_str(&truncate(reason, 48));
                }
                label.push_str(&update_suffix);
                label
            }
        },
        DisplayLanguage::Zh => match &snapshot.state {
            CompanionShellState::Healthy {
                version,
                mcp_servers,
                mcp_tools,
                ..
            } => format!(
                "Companion · {} · v{version} · MCP {mcp_servers}/{mcp_tools}{update_suffix}",
                localized_status_word(&snapshot.state, snapshot.language)
            ),
            CompanionShellState::Checking
            | CompanionShellState::Stopped
            | CompanionShellState::Degraded { .. }
            | CompanionShellState::Misconfigured { .. } => {
                let mut label = format!(
                    "Companion · {}",
                    localized_status_word(&snapshot.state, snapshot.language)
                );
                if let CompanionShellState::Degraded { reason }
                | CompanionShellState::Misconfigured { reason } = &snapshot.state
                {
                    label.push_str(" · ");
                    label.push_str(&truncate(reason, 28));
                }
                label.push_str(&update_suffix);
                label
            }
        },
    }
}

pub fn build_tray(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    let icon = Image::from_bytes(icon_bytes_for_state(&snapshot.state))?;
    tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(tooltip_for_state(snapshot))
        .build(app)?;
    Ok(())
}

pub fn apply_snapshot(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(Image::from_bytes(icon_bytes_for_state(&snapshot.state))?))?;
        tray.set_tooltip(Some(tooltip_for_state(snapshot)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompanionShellState, DisplayLanguage, StatusActions, StatusViewModel};

    #[test]
    fn returns_expected_tooltip_for_healthy_state() {
        let snapshot = StatusViewModel {
            state: CompanionShellState::Healthy {
                version: "0.1.2".into(),
                protocol_version: None,
                pid: 123,
                mcp_servers: 2,
                mcp_tools: 8,
            },
            language: DisplayLanguage::En,
            actions: StatusActions::default(),
            ..StatusViewModel::default()
        };
        assert!(tooltip_for_state(&snapshot).contains("Healthy"));
        assert!(tooltip_for_state(&snapshot).contains("0.1.2"));
    }

    #[test]
    fn localizes_tooltip_when_language_is_chinese() {
        let snapshot = StatusViewModel {
            state: CompanionShellState::Stopped,
            language: DisplayLanguage::Zh,
            actions: StatusActions::default(),
            ..StatusViewModel::default()
        };

        assert!(tooltip_for_state(&snapshot).contains("已停止"));
    }
}
