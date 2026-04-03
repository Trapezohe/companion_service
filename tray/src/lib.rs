mod autostart;
mod config;
mod daemon;
mod health;
mod models;
mod preferences;
mod startup;
mod tray;
mod update;
mod window;

use models::{CompanionConfig, DisplayLanguage, StartupContextView, StatusViewModel, UpdateInfo};
use preferences::TrayPreferences;
use startup::{
    context_from_decision, decide_post_ensure_action, decide_startup_action, startup_context,
    StartupAction,
};
use std::sync::{Arc, Mutex};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, Wry,
};
use tauri_plugin_updater::Builder as UpdaterPluginBuilder;
use tokio::time::interval;

const STATUS_EVENT: &str = "companion://status";

struct ShellResources {
    config: Mutex<Option<CompanionConfig>>,
    snapshot: Mutex<StatusViewModel>,
    startup_context: Mutex<Option<StartupContextView>>,
    update_info: Mutex<Option<UpdateInfo>>,
    preferences: Mutex<TrayPreferences>,
    exit_in_progress: Mutex<bool>,
}

fn claim_exit_shutdown(flag: &Mutex<bool>) -> bool {
    if let Ok(mut guard) = flag.lock() {
        if *guard {
            false
        } else {
            *guard = true;
            true
        }
    } else {
        false
    }
}

fn current_config(app: &AppHandle<Wry>) -> Option<CompanionConfig> {
    let state = app.state::<ShellResources>();
    state.config.lock().ok().and_then(|guard| guard.clone())
}

fn begin_exit_shutdown(app: &AppHandle<Wry>) -> bool {
    let state = app.state::<ShellResources>();
    claim_exit_shutdown(&state.exit_in_progress)
}

fn spawn_exit_shutdown(app: AppHandle<Wry>, code: Option<i32>) {
    let exit_code = code.unwrap_or(0);
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| daemon::stop_daemon_via_cli(true)).await;
        app.exit(exit_code);
    });
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

fn current_update_info(app: &AppHandle<Wry>) -> Option<UpdateInfo> {
    let state = app.state::<ShellResources>();
    state.update_info.lock().ok().and_then(|guard| guard.clone())
}

fn current_preferences(app: &AppHandle<Wry>) -> TrayPreferences {
    let state = app.state::<ShellResources>();
    state
        .preferences
        .lock()
        .ok()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn current_language(app: &AppHandle<Wry>) -> DisplayLanguage {
    current_preferences(app).language
}

fn replace_preferences(app: &AppHandle<Wry>, preferences: TrayPreferences) {
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.preferences.lock() {
        *guard = preferences;
    };
}

fn replace_update_info(app: &AppHandle<Wry>, info: Option<UpdateInfo>) {
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.update_info.lock() {
        *guard = info;
    };
}

fn set_update_info(app: &AppHandle<Wry>, info: Option<UpdateInfo>) {
    replace_update_info(app, info);
    publish_snapshot(app, current_snapshot(app));
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
    snapshot.update = current_update_info(app);
    snapshot.language = current_language(app);
    snapshot
}

fn publish_snapshot(app: &AppHandle<Wry>, snapshot: StatusViewModel) {
    let mut snapshot = snapshot;
    snapshot.startup = current_startup_context(app);
    snapshot.update = current_update_info(app);
    snapshot.language = current_language(app);
    let state = app.state::<ShellResources>();
    if let Ok(mut guard) = state.snapshot.lock() {
        *guard = snapshot.clone();
    }
    let _ = tray::apply_snapshot(app, &snapshot);
    let _ = window::sync_status_window_title(app, snapshot.language);
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

#[tauri::command]
async fn check_update(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    set_update_info(
        &app,
        Some(update::checking_update_info(update::CURRENT_VERSION)),
    );
    match update::check_for_update(&app, update::CURRENT_VERSION).await {
        Ok(info) => {
            set_update_info(&app, Some(info));
            Ok(current_snapshot(&app))
        }
        Err(error) => {
            set_update_info(
                &app,
                Some(update::install_failure_info(
                    current_update_info(&app),
                    update::CURRENT_VERSION,
                    &error.to_string(),
                )),
            );
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn install_update(app: AppHandle<Wry>) -> Result<StatusViewModel, String> {
    let progress_app = app.clone();
    let emit_progress: Arc<dyn Fn(UpdateInfo) + Send + Sync> = Arc::new(move |info| {
        set_update_info(&progress_app, Some(info));
    });

    match update::install_update(&app, update::CURRENT_VERSION, emit_progress).await {
        Ok(info) => {
            set_update_info(&app, Some(info));
            #[cfg(target_os = "macos")]
            {
                app.restart();
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(current_snapshot(&app))
            }
        }
        Err(error) => {
            set_update_info(
                &app,
                Some(update::install_failure_info(
                    current_update_info(&app),
                    update::CURRENT_VERSION,
                    &error.to_string(),
                )),
            );
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn set_display_language(app: AppHandle<Wry>, language: String) -> Result<StatusViewModel, String> {
    let next_language = DisplayLanguage::from_code(&language)
        .ok_or_else(|| format!("Unsupported language: {language}"))?;
    let mut preferences = current_preferences(&app);
    preferences.language = next_language;
    preferences::save_preferences(&preferences).map_err(|error| error.to_string())?;
    replace_preferences(&app, preferences);
    publish_snapshot(&app, current_snapshot(&app));
    Ok(current_snapshot(&app))
}

#[tauri::command]
fn open_release_page(app: AppHandle<Wry>) -> Result<(), String> {
    let info = current_update_info(&app);
    let url = info
        .as_ref()
        .and_then(|u| {
            if u.available && !u.can_install {
                u.download_url.as_deref().or(Some(u.release_url.as_str()))
            } else {
                Some(u.release_url.as_str())
            }
        })
        .unwrap_or(update::RELEASES_PAGE_URL);

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    Ok(())
}

#[tauri::command]
fn quit_tray(app: AppHandle<Wry>) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn spawn_update_checker(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        // Wait 30 seconds after launch before first check
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            if let Ok(info) = update::check_for_update(&app, update::CURRENT_VERSION).await {
                set_update_info(&app, Some(info));
            }
            // Check every hour
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

fn should_open_status_panel_for_tray_event(
    button: MouseButton,
    button_state: Option<MouseButtonState>,
    is_double_click: bool,
) -> bool {
    if is_double_click {
        return button == MouseButton::Left;
    }

    matches!(button_state, Some(MouseButtonState::Up))
        && matches!(button, MouseButton::Left | MouseButton::Right)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(UpdaterPluginBuilder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_status_snapshot,
            refresh_status_snapshot,
            run_self_check,
            set_autostart_enabled,
            set_display_language,
            start_service,
            stop_service,
            restart_service,
            run_repair,
            open_logs,
            check_update,
            install_update,
            open_release_page,
            quit_tray,
        ])
        .setup(|app| {
            let config_result = config::load_config();
            let loaded_config = config_result.as_ref().ok().cloned();
            let preferences = preferences::load_preferences().unwrap_or_default();
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
            initial_snapshot.language = preferences.language;

            app.manage(ShellResources {
                config: Mutex::new(loaded_config),
                snapshot: Mutex::new(initial_snapshot.clone()),
                startup_context: Mutex::new(startup_note),
                update_info: Mutex::new(None),
                preferences: Mutex::new(preferences.clone()),
                exit_in_progress: Mutex::new(false),
            });

            window::ensure_status_window(&app.handle())?;
            window::sync_status_window_title(&app.handle(), preferences.language)?;
            tray::build_tray(&app.handle(), &initial_snapshot)?;
            spawn_status_poller(app.handle().clone());
            spawn_update_checker(app.handle().clone());

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
                rect,
                button,
                button_state: MouseButtonState::Up,
                ..
            } if id == tray::TRAY_ID
                && should_open_status_panel_for_tray_event(button, Some(MouseButtonState::Up), false) =>
            {
                let anchor = window::StatusWindowAnchor::from_tray_rect(rect);
                let _ = window::apply_status_window_intent_with_anchor(
                    app,
                    window::StatusWindowTrigger::TrayClick,
                    anchor,
                );
            }
            TrayIconEvent::DoubleClick {
                id,
                rect,
                button,
                ..
            } if id == tray::TRAY_ID
                && should_open_status_panel_for_tray_event(button, None, true) =>
            {
                let anchor = window::StatusWindowAnchor::from_tray_rect(rect);
                let _ = window::apply_status_window_intent_with_anchor(
                    app,
                    window::StatusWindowTrigger::TrayClick,
                    anchor,
                );
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            let msg = format!("Trapezohe Companion tray failed to start:\n\n{err}");
            eprintln!("{msg}");
            // Write to shared log directory for diagnostics
            if let Some(log_dir) = dirs::data_dir().or_else(|| {
                std::env::var("ProgramData").ok().map(std::path::PathBuf::from)
            }) {
                let log_path = log_dir.join("TrapezoheCompanion").join("tray-crash.log");
                let _ = std::fs::create_dir_all(log_path.parent().unwrap());
                let _ = std::fs::write(&log_path, &msg);
            }
            #[cfg(target_os = "windows")]
            {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                let wide_msg: Vec<u16> = OsStr::new(&msg)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let wide_title: Vec<u16> = OsStr::new("Trapezohe Companion")
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                unsafe {
                    #[link(name = "user32")]
                    extern "system" {
                        fn MessageBoxW(
                            hwnd: *mut std::ffi::c_void,
                            text: *const u16,
                            caption: *const u16,
                            utype: u32,
                        ) -> i32;
                    }
                    MessageBoxW(
                        std::ptr::null_mut(),
                        wide_msg.as_ptr(),
                        wide_title.as_ptr(),
                        0x10, // MB_ICONERROR
                    );
                }
            }
            std::process::exit(1);
        });
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if begin_exit_shutdown(app) {
                api.prevent_exit();
                spawn_exit_shutdown(app.clone(), code);
            }
        }
    });
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

    #[test]
    fn exit_shutdown_is_claimed_only_once() {
        let claimed = Mutex::new(false);

        assert_eq!(claim_exit_shutdown(&claimed), true);
        assert_eq!(claim_exit_shutdown(&claimed), false);
    }

    #[test]
    fn tray_click_helper_accepts_left_and_right_button_up() {
        assert!(should_open_status_panel_for_tray_event(
            MouseButton::Left,
            Some(MouseButtonState::Up),
            false
        ));
        assert!(should_open_status_panel_for_tray_event(
            MouseButton::Right,
            Some(MouseButtonState::Up),
            false
        ));
        assert!(!should_open_status_panel_for_tray_event(
            MouseButton::Right,
            Some(MouseButtonState::Down),
            false
        ));
    }

    #[test]
    fn tray_click_helper_only_accepts_left_double_clicks() {
        assert!(should_open_status_panel_for_tray_event(
            MouseButton::Left,
            None,
            true
        ));
        assert!(!should_open_status_panel_for_tray_event(
            MouseButton::Right,
            None,
            true
        ));
    }
}
