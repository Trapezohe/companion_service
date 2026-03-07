mod autostart;
mod config;
mod daemon;
mod health;
mod models;
mod tray;
mod window;

use autostart::StartupPolicy;
use models::{CompanionConfig, StatusViewModel};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tokio::time::{interval, sleep, Duration};

const STATUS_EVENT: &str = "companion://status";

struct ShellResources {
    config: Mutex<Option<CompanionConfig>>,
    snapshot: Mutex<StatusViewModel>,
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

fn current_snapshot(app: &AppHandle<Wry>) -> StatusViewModel {
    let state = app.state::<ShellResources>();
    state
        .snapshot
        .lock()
        .ok()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn publish_snapshot(app: &AppHandle<Wry>, snapshot: StatusViewModel) {
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.snapshot.lock() {
        *guard = snapshot.clone();
    }
    let _ = tray::apply_snapshot(app, &snapshot);
    let _ = app.emit(STATUS_EVENT, &snapshot);
}

fn attach_autostart_status(snapshot: &mut StatusViewModel) {
    if let Ok(status) = autostart::current_autostart_status() {
        snapshot.autostart = Some(status);
    }
}

fn should_ensure_daemon_on_startup(
    policy: Option<&StartupPolicy>,
    has_config: bool,
    snapshot: &StatusViewModel,
) -> bool {
    has_config
        && matches!(
            policy,
            Some(policy)
                if policy.ensure_daemon_on_tray_launch
                    && matches!(policy.login_item, autostart::LoginItemMode::Tray)
        )
        && matches!(snapshot.state, models::CompanionShellState::Stopped)
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

async fn settle_after_action(
    app: &AppHandle<Wry>,
    delay_ms: u64,
    force_self_check: bool,
) -> StatusViewModel {
    sleep(Duration::from_millis(delay_ms)).await;
    refresh_snapshot(app, force_self_check).await
}

fn spawn_status_poller(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let _ = refresh_snapshot(&app, false).await;
        }
    });
}

async fn run_startup_reconciliation(app: AppHandle<Wry>) {
    let snapshot = refresh_snapshot(&app, true).await;
    let policy = autostart::load_startup_policy().ok().flatten();
    if !should_ensure_daemon_on_startup(policy.as_ref(), current_config(&app).is_some(), &snapshot)
    {
        return;
    }

    set_checking_snapshot(&app);
    if daemon::start_daemon().is_ok() {
        let _ = settle_after_action(&app, 1200, true).await;
    } else {
        let _ = refresh_snapshot(&app, true).await;
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
    set_checking_snapshot(&app);
    daemon::start_daemon().map_err(|error| error.to_string())?;
    Ok(settle_after_action(&app, 1200, true).await)
}

#[tauri::command]
async fn stop_service(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    let config =
        current_config(&app).ok_or_else(|| "Companion config is not loaded".to_string())?;
    set_checking_snapshot(&app);
    daemon::stop_daemon(&config)
        .await
        .map_err(|error| error.to_string())?;
    Ok(settle_after_action(&app, 900, true).await)
}

#[tauri::command]
async fn restart_service(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    let config =
        current_config(&app).ok_or_else(|| "Companion config is not loaded".to_string())?;
    set_checking_snapshot(&app);
    daemon::restart_daemon(&config)
        .await
        .map_err(|error| error.to_string())?;
    Ok(settle_after_action(&app, 1500, true).await)
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
            let mut initial_snapshot = match config_result {
                Ok(config) => health::checking_snapshot(&config),
                Err(error) => health::misconfigured_snapshot(error.to_string()),
            };
            if let Ok(status) = autostart::sync_autostart_on_launch() {
                initial_snapshot.autostart = Some(status);
            }

            app.manage(ShellResources {
                config: Mutex::new(loaded_config),
                snapshot: Mutex::new(initial_snapshot.clone()),
            });

            tray::build_tray(&app.handle(), &initial_snapshot)?;
            spawn_status_poller(app.handle().clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_startup_reconciliation(handle).await;
            });
            Ok(())
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

        assert!(should_ensure_daemon_on_startup(
            Some(&startup_policy_enabled()),
            true,
            &stopped_snapshot,
        ));

        let healthy_snapshot = StatusViewModel {
            state: CompanionShellState::Healthy {
                version: "0.1.0".into(),
                protocol_version: None,
                pid: 42,
                mcp_servers: 1,
                mcp_tools: 3,
            },
            ..StatusViewModel::default()
        };

        assert!(!should_ensure_daemon_on_startup(
            Some(&startup_policy_enabled()),
            true,
            &healthy_snapshot,
        ));
        assert!(!should_ensure_daemon_on_startup(
            Some(&startup_policy_enabled()),
            false,
            &stopped_snapshot,
        ));
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

        assert!(!should_ensure_daemon_on_startup(None, true, &snapshot));
        assert!(!should_ensure_daemon_on_startup(
            Some(&disabled),
            true,
            &snapshot,
        ));
    }
}
