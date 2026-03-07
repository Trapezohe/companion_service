mod autostart;
mod config;
mod daemon;
mod health;
mod models;
mod startup;
mod tray;
mod window;

use models::{CompanionConfig, StartupContextView, StatusViewModel};
use startup::{
    context_from_decision, decide_post_ensure_action, decide_startup_action, startup_context,
    StartupAction,
};
use std::sync::Mutex;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};
use tokio::time::interval;

const STATUS_EVENT: &str = "companion://status";

struct ShellResources {
    config: Mutex<Option<CompanionConfig>>,
    snapshot: Mutex<StatusViewModel>,
    startup_context: Mutex<Option<StartupContextView>>,
}

fn current_config(app: &AppHandle<Wry>) -> Option<CompanionConfig> {
    let state = app.state::<ShellResources>();
    state.config.lock().ok().and_then(|guard| guard.clone())
}

fn replace_config(app: &AppHandle<Wry>, config: Option<CompanionConfig>) {
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.config.lock() {
        *guard = config;
    };
}

fn current_startup_context(app: &AppHandle<Wry>) -> Option<StartupContextView> {
    let state = app.state::<ShellResources>();
    state
        .startup_context
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn replace_startup_context(app: &AppHandle<Wry>, context: Option<StartupContextView>) {
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.startup_context.lock() {
        *guard = context;
    };
}

fn current_snapshot(app: &AppHandle<Wry>) -> StatusViewModel {
    let mut snapshot = app
        .state::<ShellResources>()
        .snapshot
        .lock()
        .ok()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    snapshot.startup = current_startup_context(app);
    snapshot
}

fn publish_snapshot(app: &AppHandle<Wry>, snapshot: StatusViewModel) {
    let mut snapshot = snapshot;
    snapshot.startup = current_startup_context(app);
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.snapshot.lock() {
        *guard = snapshot.clone();
    }
    let _ = tray::apply_snapshot(app, &snapshot);
    let _ = app.emit(STATUS_EVENT, &snapshot);
}

fn set_startup_context(app: &AppHandle<Wry>, context: Option<StartupContextView>) {
    replace_startup_context(app, context);
    publish_snapshot(app, current_snapshot(app));
}

fn attach_autostart_status(snapshot: &mut StatusViewModel) {
    if let Ok(status) = autostart::current_autostart_status() {
        snapshot.autostart = Some(status);
    }
}

async fn refresh_snapshot(app: &AppHandle<Wry>, force_self_check: bool) -> StatusViewModel {
    match config::load_config() {
        Ok(config) => {
            replace_config(app, Some(config.clone()));
            let previous = current_snapshot(app);
            let mut snapshot =
                health::collect_status_snapshot(&config, Some(&previous), force_self_check).await;
            attach_autostart_status(&mut snapshot);
            publish_snapshot(app, snapshot.clone());
            snapshot
        }
        Err(error) => {
            replace_config(app, None);
            let mut snapshot = health::misconfigured_snapshot(error.to_string());
            attach_autostart_status(&mut snapshot);
            publish_snapshot(app, snapshot.clone());
            snapshot
        }
    }
}

fn set_checking_snapshot(app: &AppHandle<Wry>) {
    if let Some(config) = current_config(app) {
        let mut snapshot = health::checking_snapshot(&config);
        attach_autostart_status(&mut snapshot);
        publish_snapshot(app, snapshot);
    }
}

fn spawn_status_poller(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(std::time::Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let _ = refresh_snapshot(&app, false).await;
        }
    });
}

async fn start_daemon_flow(
    app: &AppHandle<Wry>,
    launch_source: &str,
    attention_trigger: window::StatusWindowTrigger,
) -> Result<StatusViewModel, String> {
    set_startup_context(
        app,
        Some(startup_context(
            launch_source,
            "ensuring",
            "Starting the local daemon and waiting for readiness.",
        )),
    );
    set_checking_snapshot(app);

    let config = current_config(app);
    if let Err(error) = daemon::start_daemon_and_wait(config.as_ref()).await {
        let message = error.to_string();
        set_startup_context(
            app,
            Some(startup_context(
                launch_source,
                "attention",
                format!("Failed to start the local daemon: {message}"),
            )),
        );
        let snapshot = refresh_snapshot(app, true).await;
        let decision = decide_post_ensure_action(&snapshot);
        set_startup_context(app, Some(context_from_decision(launch_source, &decision)));
        let _ = window::apply_status_window_intent(app, attention_trigger);
        return Err(message);
    }

    let snapshot = refresh_snapshot(app, true).await;
    let decision = decide_post_ensure_action(&snapshot);
    set_startup_context(app, Some(context_from_decision(launch_source, &decision)));
    if matches!(decision.action, StartupAction::RevealPanel) {
        let _ = window::apply_status_window_intent(app, attention_trigger);
    }
    Ok(current_snapshot(app))
}

async fn run_startup_reconciliation(app: AppHandle<Wry>) {
    set_startup_context(
        &app,
        Some(startup_context(
            "tray_boot",
            "checking",
            "Tray launched and is reconciling the local companion runtime.",
        )),
    );
    let snapshot = refresh_snapshot(&app, true).await;
    let policy = autostart::load_startup_policy().ok().flatten();
    let decision = decide_startup_action(policy.as_ref(), current_config(&app).is_some(), &snapshot);
    set_startup_context(&app, Some(context_from_decision("tray_boot", &decision)));

    match decision.action {
        StartupAction::Noop => {}
        StartupAction::EnsureDaemon => {
            let _ =
                start_daemon_flow(&app, "tray_boot", window::StatusWindowTrigger::StartupAttention)
                    .await;
        }
        StartupAction::RevealPanel => {
            let _ = window::apply_status_window_intent(
                &app,
                window::StatusWindowTrigger::StartupAttention,
            );
        }
    }
}

#[tauri::command]
async fn get_status_snapshot(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    Ok(current_snapshot(&app))
}

#[tauri::command]
async fn refresh_status_snapshot(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    Ok(refresh_snapshot(&app, true).await)
}

#[tauri::command]
async fn run_self_check(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    Ok(refresh_snapshot(&app, true).await)
}

#[tauri::command]
async fn set_autostart_enabled(
    app: AppHandle<Wry>,
    enabled: bool,
) -> Result<StatusViewModel, String> {
    let status = autostart::set_autostart_enabled(enabled).map_err(|error| error.to_string())?;
    let mut snapshot = current_snapshot(&app);
    snapshot.autostart = Some(status);
    publish_snapshot(&app, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
async fn start_service(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    start_daemon_flow(&app, "panel", window::StatusWindowTrigger::MenuCommand).await
}

#[tauri::command]
async fn stop_service(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    let config =
        current_config(&app).ok_or_else(|| "Companion config is not loaded".to_string())?;
    set_checking_snapshot(&app);
    daemon::stop_daemon(&config)
        .await
        .map_err(|error| error.to_string())?;
    set_startup_context(
        &app,
        Some(startup_context(
            "panel",
            "ready",
            "The local daemon was stopped from the companion panel.",
        )),
    );
    Ok(refresh_snapshot(&app, true).await)
}

#[tauri::command]
async fn restart_service(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    let config =
        current_config(&app).ok_or_else(|| "Companion config is not loaded".to_string())?;
    set_checking_snapshot(&app);
    daemon::restart_daemon(&config)
        .await
        .map_err(|error| error.to_string())?;
    set_startup_context(
        &app,
        Some(startup_context(
            "panel",
            "ensuring",
            "Restarting the local daemon and waiting for the runtime to settle.",
        )),
    );
    Ok(refresh_snapshot(&app, true).await)
}

#[tauri::command]
async fn run_repair(app: AppHandle<Wry>, action: String) -> Result<StatusViewModel, String> {
    daemon::run_repair(&action).map_err(|error| error.to_string())?;
    Ok(refresh_snapshot(&app, true).await)
}

#[tauri::command]
fn open_logs(app: AppHandle<Wry>) -> Result<(), String> {
    let config =
        current_config(&app).ok_or_else(|| "Companion config is not loaded".to_string())?;
    daemon::open_logs_dir(&config.logs_dir).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_status_snapshot,
            refresh_status_snapshot,
            run_self_check,
            set_autostart_enabled,
            start_service,
            stop_service,
            restart_service,
            run_repair,
            open_logs,
        ])
        .setup(|app| {
            let config_result = config::load_config();
            let loaded_config = config_result.as_ref().ok().cloned();
            let startup_note = Some(startup_context(
                "tray_boot",
                "checking",
                "Tray launched and is reconciling the local companion runtime.",
            ));
            let mut initial_snapshot = match config_result {
                Ok(config) => health::checking_snapshot(&config),
                Err(error) => health::misconfigured_snapshot(error.to_string()),
            };
            if let Ok(status) = autostart::sync_autostart_on_launch() {
                initial_snapshot.autostart = Some(status);
            }
            initial_snapshot.startup = startup_note.clone();

            app.manage(ShellResources {
                config: Mutex::new(loaded_config),
                snapshot: Mutex::new(initial_snapshot.clone()),
                startup_context: Mutex::new(startup_note),
            });

            window::ensure_status_window(&app.handle())?;
            tray::build_tray(&app.handle(), &initial_snapshot)?;
            spawn_status_poller(app.handle().clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_startup_reconciliation(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            window::handle_status_window_event(window, event);
        })
        .on_tray_icon_event(|app, event| match event {
            TrayIconEvent::Click {
                id,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } if id == tray::TRAY_ID => {
                let _ =
                    window::apply_status_window_intent(app, window::StatusWindowTrigger::TrayClick);
            }
            TrayIconEvent::DoubleClick {
                id,
                button: MouseButton::Left,
                ..
            } if id == tray::TRAY_ID => {
                let _ =
                    window::apply_status_window_intent(app, window::StatusWindowTrigger::TrayClick);
            }
            _ => {}
        })
        .on_menu_event(|app, event| match event.id().0.as_str() {
            tray::MENU_QUIT => app.exit(0),
            tray::MENU_OPEN_STATUS => {
                let _ = window::open_or_focus_status_window(app);
            }
            tray::MENU_START => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = start_service(handle).await;
                });
            }
            tray::MENU_STOP => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = stop_service(handle).await;
                });
            }
            tray::MENU_RESTART => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = restart_service(handle).await;
                });
            }
            tray::MENU_DIAGNOSTICS => {
                let _ = window::open_or_focus_status_window(app);
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = refresh_status_snapshot(handle).await;
                });
            }
            tray::MENU_OPEN_LOGS => {
                let handle = app.clone();
                let _ = open_logs(handle);
            }
            tray::MENU_TOGGLE_AUTOSTART => {
                let handle = app.clone();
                let enable = !current_snapshot(app)
                    .autostart
                    .as_ref()
                    .map(|item| item.enabled)
                    .unwrap_or(false);
                tauri::async_runtime::spawn(async move {
                    let _ = set_autostart_enabled(handle, enable).await;
                });
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tray shell");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autostart::{LoginItemMode, StartupPolicy};
    use crate::models::CompanionShellState;
    use crate::startup::{decide_startup_action, StartupAction};

    fn startup_policy_enabled() -> StartupPolicy {
        StartupPolicy {
            login_item: LoginItemMode::Tray,
            ensure_daemon_on_tray_launch: true,
        }
    }

    #[test]
    fn starts_daemon_only_when_policy_owns_login_and_snapshot_is_stopped() {
        let stopped_snapshot = StatusViewModel {
            state: CompanionShellState::Stopped,
            ..StatusViewModel::default()
        };

        let decision = decide_startup_action(
            Some(&startup_policy_enabled()),
            true,
            &stopped_snapshot,
        );
        assert_eq!(decision.action, StartupAction::EnsureDaemon);
    }

    #[test]
    fn disabled_or_missing_policy_never_requests_daemon_ensure() {
        let snapshot = StatusViewModel {
            state: CompanionShellState::Stopped,
            ..StatusViewModel::default()
        };
        let disabled = StartupPolicy {
            login_item: LoginItemMode::Disabled,
            ensure_daemon_on_tray_launch: false,
        };

        assert_eq!(decide_startup_action(None, true, &snapshot).action, StartupAction::Noop);
        assert_eq!(
            decide_startup_action(Some(&disabled), true, &snapshot).action,
            StartupAction::Noop
        );
        assert_eq!(
            decide_startup_action(Some(&startup_policy_enabled()), false, &snapshot).action,
            StartupAction::RevealPanel
        );
    }
}
