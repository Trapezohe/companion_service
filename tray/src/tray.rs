use tauri::{image::Image, menu::MenuBuilder, AppHandle, Wry};

use crate::models::{CompanionShellState, StatusViewModel};

pub const TRAY_ID: &str = "companion-tray";
pub const MENU_OPEN_STATUS: &str = "open_status";
pub const MENU_START: &str = "start_service";
pub const MENU_STOP: &str = "stop_service";
pub const MENU_RESTART: &str = "restart_service";
pub const MENU_DIAGNOSTICS: &str = "run_diagnostics";
pub const MENU_OPEN_LOGS: &str = "open_logs";
pub const MENU_TOGGLE_AUTOSTART: &str = "toggle_autostart";
pub const MENU_UPDATE: &str = "open_update";
pub const MENU_QUIT: &str = "quit_tray";

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

fn status_detail(snapshot: &StatusViewModel) -> String {
    match &snapshot.state {
        CompanionShellState::Healthy {
            pid,
            mcp_servers,
            mcp_tools,
            ..
        } => format!(
            "PID {pid} · MCP {mcp_servers}/{mcp_tools} · ACP {} · Approvals {}",
            snapshot.running_sessions(),
            snapshot.pending_approvals(),
        ),
        CompanionShellState::Degraded { reason } => truncate(reason, 72),
        CompanionShellState::Misconfigured { reason } => {
            let available_repairs = snapshot.repair_actions().len();
            if available_repairs > 0 {
                format!(
                    "{} · {} repair option{} available",
                    truncate(reason, 48),
                    available_repairs,
                    if available_repairs == 1 { "" } else { "s" },
                )
            } else {
                truncate(reason, 72)
            }
        }
        CompanionShellState::Stopped => {
            "Local daemon is offline. Open the panel to start or repair it.".into()
        }
        CompanionShellState::Checking => "Refreshing local companion state…".into(),
    }
}

pub fn tooltip_for_state(snapshot: &StatusViewModel) -> String {
    let update_suffix = snapshot
        .update
        .as_ref()
        .filter(|u| u.available)
        .map(|u| format!(" · Update v{}", u.latest_version))
        .unwrap_or_default();

    match &snapshot.state {
        CompanionShellState::Healthy {
            version,
            mcp_servers,
            mcp_tools,
            ..
        } => {
            format!("Trapezohe Companion · Healthy · v{version} · MCP {mcp_servers}/{mcp_tools}{update_suffix}")
        }
        CompanionShellState::Checking => format!("Trapezohe Companion · Checking{update_suffix}"),
        CompanionShellState::Stopped => format!("Trapezohe Companion · Stopped{update_suffix}"),
        CompanionShellState::Degraded { reason } => {
            format!(
                "Trapezohe Companion · Degraded · {}{}",
                truncate(reason, 48),
                update_suffix
            )
        }
        CompanionShellState::Misconfigured { reason } => {
            format!(
                "Trapezohe Companion · Misconfigured · {}{}",
                truncate(reason, 48),
                update_suffix
            )
        }
    }
}

fn build_menu(
    app: &AppHandle<Wry>,
    snapshot: &StatusViewModel,
) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let autostart_enabled = snapshot
        .autostart
        .as_ref()
        .map(|item| item.enabled)
        .unwrap_or(false);
    let autostart_summary = if autostart_enabled {
        "Desktop startup via tray · On"
    } else {
        "Desktop startup via tray · Off"
    };
    let autostart_toggle_label = if autostart_enabled {
        "Disable Desktop Startup"
    } else {
        "Enable Desktop Startup"
    };
    let mut builder = MenuBuilder::new(app);

    // Show update item at the top if available
    if let Some(update) = &snapshot.update {
        if update.available {
            builder = builder
                .text(
                    MENU_UPDATE,
                    format!("Update Available: v{}", update.latest_version),
                )
                .separator();
        }
    }

    builder
        .text("status_headline", snapshot.headline())
        .text("status_detail", status_detail(snapshot))
        .text("autostart_status", autostart_summary)
        .separator()
        .text(MENU_OPEN_STATUS, "Open Companion Panel")
        .text(MENU_START, "Start Service")
        .text(MENU_STOP, "Stop Service")
        .text(MENU_RESTART, "Restart Service")
        .separator()
        .text(MENU_TOGGLE_AUTOSTART, autostart_toggle_label)
        .text(MENU_DIAGNOSTICS, "Refresh Diagnostics")
        .text(MENU_OPEN_LOGS, "Open Logs Folder")
        .separator()
        .text(MENU_QUIT, "Quit Tray")
        .build()
}

pub fn build_tray(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    let menu = build_menu(app, snapshot)?;
    let icon = Image::from_bytes(icon_bytes_for_state(&snapshot.state))?;
    tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip_for_state(snapshot))
        .build(app)?;
    Ok(())
}

pub fn apply_snapshot(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(Image::from_bytes(icon_bytes_for_state(&snapshot.state))?))?;
        tray.set_tooltip(Some(tooltip_for_state(snapshot)))?;
        let menu = build_menu(app, snapshot)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompanionShellState, StatusActions, StatusViewModel};

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
            actions: StatusActions::default(),
            ..StatusViewModel::default()
        };
        assert!(tooltip_for_state(&snapshot).contains("Healthy"));
        assert!(tooltip_for_state(&snapshot).contains("0.1.2"));
    }

    #[test]
    fn includes_reason_for_degraded_state() {
        let snapshot = StatusViewModel {
            state: CompanionShellState::Degraded {
                reason: "self-check needs attention".into(),
            },
            actions: StatusActions::default(),
            ..StatusViewModel::default()
        };

        assert!(status_detail(&snapshot).contains("self-check"));
    }
}
