use tauri::{AppHandle, Wry, image::Image, menu::MenuBuilder, tray::TrayIconBuilder};

use crate::models::{CompanionShellState, StatusViewModel};

pub const TRAY_ID: &str = "companion-tray";
pub const MENU_OPEN_STATUS: &str = "open_status";
pub const MENU_START: &str = "start_service";
pub const MENU_STOP: &str = "stop_service";
pub const MENU_RESTART: &str = "restart_service";
pub const MENU_DIAGNOSTICS: &str = "run_diagnostics";
pub const MENU_OPEN_LOGS: &str = "open_logs";
pub const MENU_QUIT: &str = "quit_tray";

fn icon_path_for_state(state: &CompanionShellState) -> &'static str {
    match state {
        CompanionShellState::Healthy { .. } => concat!(env!("CARGO_MANIFEST_DIR"), "/icons/tray-green.png"),
        CompanionShellState::Checking | CompanionShellState::Degraded { .. } => concat!(env!("CARGO_MANIFEST_DIR"), "/icons/tray-yellow.png"),
        CompanionShellState::Stopped | CompanionShellState::Misconfigured { .. } => concat!(env!("CARGO_MANIFEST_DIR"), "/icons/tray-red.png"),
    }
}

pub fn tooltip_for_state(snapshot: &StatusViewModel) -> String {
    match &snapshot.state {
        CompanionShellState::Healthy { version, mcp_servers, mcp_tools, .. } => {
            format!("Trapezohe Companion · Healthy · v{version} · MCP {mcp_servers}/{mcp_tools}")
        }
        CompanionShellState::Checking => "Trapezohe Companion · Checking".into(),
        CompanionShellState::Stopped => "Trapezohe Companion · Stopped".into(),
        CompanionShellState::Degraded { reason } => format!("Trapezohe Companion · Degraded · {reason}"),
        CompanionShellState::Misconfigured { reason } => format!("Trapezohe Companion · Misconfigured · {reason}"),
    }
}

pub fn build_tray(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("status", tooltip_for_state(snapshot))
        .separator()
        .text(MENU_OPEN_STATUS, "Open Status Window")
        .text(MENU_START, "Start Service")
        .text(MENU_STOP, "Stop Service")
        .text(MENU_RESTART, "Restart Service")
        .separator()
        .text(MENU_DIAGNOSTICS, "Run Diagnostics")
        .text(MENU_OPEN_LOGS, "Open Logs Folder")
        .separator()
        .text(MENU_QUIT, "Quit Tray")
        .build()?;

    let icon = Image::from_path(icon_path_for_state(&snapshot.state))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip(tooltip_for_state(snapshot))
        .build(app)?;
    Ok(())
}

pub fn apply_snapshot(app: &AppHandle<Wry>, snapshot: &StatusViewModel) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(Image::from_path(icon_path_for_state(&snapshot.state))?))?;
        tray.set_tooltip(Some(tooltip_for_state(snapshot)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::StatusViewModel;

    #[test]
    fn returns_expected_tooltip_for_healthy_state() {
        let snapshot = StatusViewModel {
            state: CompanionShellState::Healthy {
                version: "0.1.0".into(),
                protocol_version: None,
                pid: 123,
                mcp_servers: 2,
                mcp_tools: 8,
            },
            config_path: String::new(),
            logs_dir: String::new(),
        };
        assert!(tooltip_for_state(&snapshot).contains("Healthy"));
        assert!(tooltip_for_state(&snapshot).contains("0.1.0"));
    }
}
