mod config;
mod daemon;
mod health;
mod models;
mod tray;
mod window;

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

async fn refresh_snapshot(app: &AppHandle<Wry>, force_self_check: bool) -> StatusViewModel {
    match config::load_config() {
        Ok(config) => {
            replace_config(app, Some(config.clone()));
            let previous = current_snapshot(app);
            let snapshot =
                health::collect_status_snapshot(&config, Some(&previous), force_self_check).await;
            publish_snapshot(app, snapshot.clone());
            snapshot
        }
        Err(error) => {
            replace_config(app, None);
            let snapshot = health::misconfigured_snapshot(error.to_string());
            publish_snapshot(app, snapshot.clone());
            snapshot
        }
    }
}

fn set_checking_snapshot(app: &AppHandle<Wry>) {
    if let Some(config) = current_config(app) {
        publish_snapshot(app, health::checking_snapshot(&config));
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
            start_service,
            stop_service,
            restart_service,
            run_repair,
            open_logs,
        ])
        .setup(|app| {
            let config_result = config::load_config();
            let loaded_config = config_result.as_ref().ok().cloned();
            let initial_snapshot = match config_result {
                Ok(config) => health::checking_snapshot(&config),
                Err(error) => health::misconfigured_snapshot(error.to_string()),
            };

            app.manage(ShellResources {
                config: Mutex::new(loaded_config),
                snapshot: Mutex::new(initial_snapshot.clone()),
            });

            tray::build_tray(&app.handle(), &initial_snapshot)?;
            spawn_status_poller(app.handle().clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_snapshot(&handle, true).await;
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
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tray shell");
}
