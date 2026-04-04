use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Position, Rect, Size,
    WebviewWindowBuilder, Window, WindowEvent, Wry,
};

use crate::models::DisplayLanguage;

pub const STATUS_WINDOW_LABEL: &str = "status";
const STATUS_PANEL_VERTICAL_GAP: i32 = 10;
const DEFAULT_STATUS_WINDOW_WIDTH: f64 = 344.0;
const DEFAULT_STATUS_WINDOW_HEIGHT: f64 = 660.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWindowTrigger {
    TrayClick,
    MenuCommand,
    StartupAttention,
    FocusLost,
    CloseRequested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWindowIntent {
    ShowAndFocus,
    HideToTray,
}

#[derive(Debug, Clone, Copy)]
pub struct StatusWindowAnchor {
    rect: PhysicalRect<i32, u32>,
}

impl StatusWindowAnchor {
    pub fn from_tray_rect(rect: Rect) -> Option<Self> {
        let position = match rect.position {
            Position::Physical(position) => position,
            Position::Logical(_) => return None,
        };
        let size = match rect.size {
            Size::Physical(size) => size,
            Size::Logical(_) => return None,
        };
        Some(Self {
            rect: PhysicalRect { position, size },
        })
    }

    fn center_x(self) -> f64 {
        f64::from(self.rect.position.x) + f64::from(self.rect.size.width) / 2.0
    }

    fn bottom_y(self) -> f64 {
        f64::from(self.rect.position.y) + f64::from(self.rect.size.height)
    }
}

pub fn resolve_status_window_intent(trigger: StatusWindowTrigger) -> StatusWindowIntent {
    match trigger {
        StatusWindowTrigger::TrayClick
        | StatusWindowTrigger::MenuCommand
        | StatusWindowTrigger::StartupAttention => StatusWindowIntent::ShowAndFocus,
        StatusWindowTrigger::FocusLost | StatusWindowTrigger::CloseRequested => {
            StatusWindowIntent::HideToTray
        }
    }
}

fn status_window_config(app: &AppHandle<Wry>) -> tauri::Result<tauri::utils::config::WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == STATUS_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("status window config".into()))
}

fn status_window_from_config(app: &AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let config = status_window_config(app)?;

    WebviewWindowBuilder::from_config(app, &config)?.build()
}

pub fn sync_status_window_title(
    app: &AppHandle<Wry>,
    language: DisplayLanguage,
) -> tauri::Result<()> {
    ensure_status_window(app)?;
    if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        let title = match language {
            DisplayLanguage::En => "Trapezohe Companion",
            DisplayLanguage::Zh => "Trapezohe Companion 控制面板",
        };
        window.set_title(title)?;
    }
    Ok(())
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
    apply_status_window_intent_with_anchor(app, trigger, None)
}

fn fallback_status_window_size(app: &AppHandle<Wry>, scale_factor: f64) -> PhysicalSize<u32> {
    let (width, height) = status_window_config(app)
        .map(|config| (config.width, config.height))
        .unwrap_or((DEFAULT_STATUS_WINDOW_WIDTH, DEFAULT_STATUS_WINDOW_HEIGHT));

    PhysicalSize::new(
        (width * scale_factor).round().max(1.0) as u32,
        (height * scale_factor).round().max(1.0) as u32,
    )
}

fn resolve_tray_panel_position(
    tray_rect: PhysicalRect<i32, u32>,
    window_size: PhysicalSize<u32>,
    work_area: PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    let target_x = (f64::from(tray_rect.position.x) + f64::from(tray_rect.size.width) / 2.0
        - f64::from(window_size.width) / 2.0)
        .round() as i32;
    let target_y =
        (f64::from(tray_rect.position.y) + f64::from(tray_rect.size.height)).round() as i32
            + STATUS_PANEL_VERTICAL_GAP;

    let min_x = work_area.position.x;
    let max_x = work_area.position.x + work_area.size.width as i32 - window_size.width as i32;
    let min_y = work_area.position.y;
    let max_y = work_area.position.y + work_area.size.height as i32 - window_size.height as i32;

    PhysicalPosition::new(
        clamp_i32(target_x, min_x, max_x),
        clamp_i32(target_y, min_y, max_y),
    )
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        min
    } else {
        value.clamp(min, max)
    }
}

fn position_status_window(
    app: &AppHandle<Wry>,
    window: &tauri::WebviewWindow<Wry>,
    anchor: StatusWindowAnchor,
) -> tauri::Result<()> {
    let monitor = app
        .monitor_from_point(anchor.center_x(), anchor.bottom_y())?
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let window_size = window
        .outer_size()
        .unwrap_or_else(|_| fallback_status_window_size(app, monitor.scale_factor()));
    let position = resolve_tray_panel_position(anchor.rect, window_size, *monitor.work_area());
    window.set_position(Position::Physical(position))
}

pub fn apply_status_window_intent_with_anchor(
    app: &AppHandle<Wry>,
    trigger: StatusWindowTrigger,
    anchor: Option<StatusWindowAnchor>,
) -> tauri::Result<()> {
    ensure_status_window(app)?;

    match resolve_status_window_intent(trigger) {
        StatusWindowIntent::ShowAndFocus => {
            if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
                if let Some(anchor) = anchor {
                    let _ = position_status_window(app, &window, anchor);
                }
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

pub fn handle_status_window_event(window: &Window<Wry>, event: &WindowEvent) {
    if window.label() != STATUS_WINDOW_LABEL {
        return;
    }

    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = apply_status_window_intent(
                &window.app_handle(),
                StatusWindowTrigger::CloseRequested,
            );
        }
        WindowEvent::Focused(false) => {
            let _ = apply_status_window_intent(&window.app_handle(), StatusWindowTrigger::FocusLost);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};

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

    #[test]
    fn focus_loss_hides_to_tray() {
        assert_eq!(
            resolve_status_window_intent(StatusWindowTrigger::FocusLost),
            StatusWindowIntent::HideToTray
        );
    }

    #[test]
    fn tray_anchor_centers_panel_below_icon() {
        let position = resolve_tray_panel_position(
            PhysicalRect {
                position: PhysicalPosition::new(200, 6),
                size: PhysicalSize::new(24, 24),
            },
            PhysicalSize::new(344, 660),
            PhysicalRect {
                position: PhysicalPosition::new(0, 0),
                size: PhysicalSize::new(1440, 900),
            },
        );

        assert_eq!(position, PhysicalPosition::new(40, 40));
    }

    #[test]
    fn tray_anchor_clamps_panel_inside_monitor_edges() {
        let right = resolve_tray_panel_position(
            PhysicalRect {
                position: PhysicalPosition::new(1412, 6),
                size: PhysicalSize::new(24, 24),
            },
            PhysicalSize::new(344, 660),
            PhysicalRect {
                position: PhysicalPosition::new(0, 0),
                size: PhysicalSize::new(1440, 900),
            },
        );
        let left = resolve_tray_panel_position(
            PhysicalRect {
                position: PhysicalPosition::new(2, 6),
                size: PhysicalSize::new(24, 24),
            },
            PhysicalSize::new(344, 660),
            PhysicalRect {
                position: PhysicalPosition::new(0, 0),
                size: PhysicalSize::new(1440, 900),
            },
        );

        assert_eq!(right, PhysicalPosition::new(1096, 40));
        assert_eq!(left, PhysicalPosition::new(0, 40));
    }

    #[test]
    fn tray_anchor_respects_monitor_work_area_top_edge() {
        let position = resolve_tray_panel_position(
            PhysicalRect {
                position: PhysicalPosition::new(240, 0),
                size: PhysicalSize::new(24, 18),
            },
            PhysicalSize::new(344, 660),
            PhysicalRect {
                position: PhysicalPosition::new(0, 32),
                size: PhysicalSize::new(1440, 868),
            },
        );

        assert_eq!(position, PhysicalPosition::new(80, 32));
    }
}
