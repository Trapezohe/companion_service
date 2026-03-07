use tauri::{AppHandle, Manager, WebviewWindowBuilder, Window, WindowEvent, Wry};

pub const STATUS_WINDOW_LABEL: &str = "status";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWindowTrigger {
    TrayClick,
    MenuCommand,
    StartupAttention,
    CloseRequested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWindowIntent {
    ShowAndFocus,
    HideToTray,
}

pub fn resolve_status_window_intent(trigger: StatusWindowTrigger) -> StatusWindowIntent {
    match trigger {
        StatusWindowTrigger::TrayClick
        | StatusWindowTrigger::MenuCommand
        | StatusWindowTrigger::StartupAttention => StatusWindowIntent::ShowAndFocus,
        StatusWindowTrigger::CloseRequested => StatusWindowIntent::HideToTray,
    }
}

fn status_window_from_config(app: &AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == STATUS_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("status window config".into()))?;

    WebviewWindowBuilder::from_config(app, &config)?.build()
}

pub fn ensure_status_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    if app.get_webview_window(STATUS_WINDOW_LABEL).is_none() {
        let window = status_window_from_config(app)?;
        window.hide()?;
    }
    Ok(())
}

pub fn apply_status_window_intent(
    app: &AppHandle<Wry>,
    trigger: StatusWindowTrigger,
) -> tauri::Result<()> {
    ensure_status_window(app)?;

    match resolve_status_window_intent(trigger) {
        StatusWindowIntent::ShowAndFocus => {
            if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
                window.show()?;
                let _ = window.unminimize();
                window.set_focus()?;
            }
        }
        StatusWindowIntent::HideToTray => {
            if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
                window.hide()?;
            }
        }
    }

    Ok(())
}

pub fn open_or_focus_status_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    apply_status_window_intent(app, StatusWindowTrigger::MenuCommand)
}

pub fn handle_status_window_event(window: &Window<Wry>, event: &WindowEvent) {
    if window.label() != STATUS_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = apply_status_window_intent(&window.app_handle(), StatusWindowTrigger::CloseRequested);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_click_resolves_to_panel_focus() {
        assert_eq!(
            resolve_status_window_intent(StatusWindowTrigger::TrayClick),
            StatusWindowIntent::ShowAndFocus
        );
    }

    #[test]
    fn startup_attention_resolves_to_panel_focus() {
        assert_eq!(
            resolve_status_window_intent(StatusWindowTrigger::StartupAttention),
            StatusWindowIntent::ShowAndFocus
        );
    }

    #[test]
    fn close_request_hides_to_tray_instead_of_destroying_panel() {
        assert_eq!(
            resolve_status_window_intent(StatusWindowTrigger::CloseRequested),
            StatusWindowIntent::HideToTray
        );
    }
}
