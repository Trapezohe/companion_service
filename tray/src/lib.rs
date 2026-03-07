mod config;
mod daemon;
mod health;
mod models;
mod tray;
mod window;

use health::{misconfigured_snapshot, spawn_health_checker, stopped_snapshot};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::watch;

struct ShellResources {
  config: Mutex<Option<models::CompanionConfig>>,
}

fn current_config(app: &AppHandle<Wry>) -> Option<models::CompanionConfig> {
  let state = app.state::<ShellResources>();
  state.config.lock().ok().and_then(|guard| guard.clone())
}

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let config_result = config::load_config();
      let loaded_config = config_result.as_ref().ok().cloned();
      app.manage(ShellResources {
        config: Mutex::new(loaded_config.clone()),
      });

      let initial_snapshot = match config_result {
        Ok(config) => {
          let snapshot = stopped_snapshot(Some(&config));
          let (tx, mut rx) = watch::channel(snapshot.clone());
          spawn_health_checker(config, tx);

          let handle = app.handle().clone();
          tauri::async_runtime::spawn(async move {
            loop {
              if rx.changed().await.is_err() {
                break;
              }
              let next = rx.borrow().clone();
              let _ = tray::apply_snapshot(&handle, &next);
            }
          });

          snapshot
        }
        Err(error) => misconfigured_snapshot(error.to_string()),
      };

      tray::build_tray(&app.handle(), &initial_snapshot)?;
      Ok(())
    })
    .on_menu_event(|app, event| {
      match event.id().0.as_str() {
        tray::MENU_QUIT => app.exit(0),
        tray::MENU_OPEN_STATUS | tray::MENU_DIAGNOSTICS => {
          let _ = window::open_or_focus_status_window(app);
        }
        tray::MENU_START => {
          tauri::async_runtime::spawn(async {
            let _ = daemon::start_daemon();
          });
        }
        tray::MENU_STOP => {
          if let Some(config) = current_config(app) {
            tauri::async_runtime::spawn(async move {
              let _ = daemon::stop_daemon(&config).await;
            });
          }
        }
        tray::MENU_RESTART => {
          if let Some(config) = current_config(app) {
            tauri::async_runtime::spawn(async move {
              let _ = daemon::restart_daemon(&config).await;
            });
          }
        }
        tray::MENU_OPEN_LOGS => {
          if let Some(config) = current_config(app) {
            let _ = daemon::open_logs_dir(&config.logs_dir);
          }
        }
        _ => {}
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tray shell");
}
