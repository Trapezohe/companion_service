use tauri::{AppHandle, Manager, WebviewWindowBuilder, Wry};

pub fn open_or_focus_status_window(app: &AppHandle<Wry>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("status") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "status")
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("status window config".into()))?;

    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}
