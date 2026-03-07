use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::models::AutoStartStatus;

const PREFS_FILE_NAME: &str = "companion-tray.json";
const MACOS_LABEL: &str = "ai.trapezohe.companion.tray";
const LINUX_DESKTOP_NAME: &str = "trapezohe-companion-tray.desktop";
const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const WINDOWS_VALUE_NAME: &str = "TrapezoheCompanionTray";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrayPreferences {
    pub auto_start_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationTarget {
    pub strategy: String,
    pub target: String,
    pub contents: String,
}

pub fn resolve_preferences_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to resolve home directory")?;
    Ok(home.join(".trapezohe").join(PREFS_FILE_NAME))
}

pub fn load_preferences_from_path(path: &Path) -> Result<TrayPreferences> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read tray preferences: {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse tray preferences: {}", path.display()))
}

pub fn save_preferences_to_path(path: &Path, prefs: &TrayPreferences) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create preferences directory: {}",
                parent.display()
            )
        })?;
    }
    let payload = serde_json::to_string_pretty(prefs)?;
    fs::write(path, payload)
        .with_context(|| format!("Failed to write tray preferences: {}", path.display()))
}

pub fn load_preferences() -> Result<Option<TrayPreferences>> {
    let path = resolve_preferences_path()?;
    if !path.exists() {
        return Ok(None);
    }
    load_preferences_from_path(&path).map(Some)
}

pub fn save_preferences(prefs: &TrayPreferences) -> Result<()> {
    let path = resolve_preferences_path()?;
    save_preferences_to_path(&path, prefs)
}

pub fn sync_autostart_on_launch() -> Result<AutoStartStatus> {
    let executable = current_executable_string()?;
    let home = home_dir_string()?;
    let target = registration_for_platform(std::env::consts::OS, &executable, &home);
    match load_preferences()? {
        Some(TrayPreferences {
            auto_start_enabled: true,
        }) => {
            install_registration(&target)?;
            build_status(&target, true)
        }
        Some(TrayPreferences {
            auto_start_enabled: false,
        }) => {
            remove_registration(&target)?;
            build_status(&target, false)
        }
        None => {
            if should_enable_by_default(&executable) {
                install_registration(&target)?;
                save_preferences(&TrayPreferences {
                    auto_start_enabled: true,
                })?;
                build_status(&target, true)
            } else {
                build_status(&target, registration_exists(&target)?)
            }
        }
    }
}

pub fn current_autostart_status() -> Result<AutoStartStatus> {
    let executable = current_executable_string()?;
    let home = home_dir_string()?;
    let target = registration_for_platform(std::env::consts::OS, &executable, &home);
    let enabled = match load_preferences()? {
        Some(pref) => pref.auto_start_enabled,
        None => registration_exists(&target)?,
    };
    build_status(&target, enabled)
}

pub fn set_autostart_enabled(enabled: bool) -> Result<AutoStartStatus> {
    let executable = current_executable_string()?;
    let home = home_dir_string()?;
    let target = registration_for_platform(std::env::consts::OS, &executable, &home);
    if enabled {
        install_registration(&target)?;
    } else {
        remove_registration(&target)?;
    }
    save_preferences(&TrayPreferences {
        auto_start_enabled: enabled,
    })?;
    build_status(&target, enabled)
}

pub fn registration_for_platform(
    platform: &str,
    executable: &str,
    home: &str,
) -> RegistrationTarget {
    match platform {
        "macos" | "darwin" => registration_for_macos(executable, home),
        "linux" => registration_for_linux(executable, home),
        "windows" | "win32" => registration_for_windows(executable),
        other => RegistrationTarget {
            strategy: other.to_string(),
            target: other.to_string(),
            contents: String::new(),
        },
    }
}

fn registration_for_macos(executable: &str, home: &str) -> RegistrationTarget {
    let target = Path::new(home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{MACOS_LABEL}.plist"));
    let logs_dir = Path::new(home).join(".trapezohe");
    let stdout = logs_dir.join("companion-tray.log");
    let stderr = logs_dir.join("companion-tray.error.log");
    let contents = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>{MACOS_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n  <key>StandardOutPath</key>\n  <string>{}</string>\n  <key>StandardErrorPath</key>\n  <string>{}</string>\n</dict>\n</plist>\n",
        xml_escape(executable),
        xml_escape(&stdout.display().to_string()),
        xml_escape(&stderr.display().to_string()),
    );
    RegistrationTarget {
        strategy: "launchd".into(),
        target: target.display().to_string(),
        contents,
    }
}

fn registration_for_linux(executable: &str, home: &str) -> RegistrationTarget {
    let target = Path::new(home)
        .join(".config")
        .join("autostart")
        .join(LINUX_DESKTOP_NAME);
    let contents = format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Trapezohe Companion\nComment=Launch the Trapezohe Companion tray shell on login\nExec=\"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        desktop_escape(executable),
    );
    RegistrationTarget {
        strategy: "xdg-autostart".into(),
        target: target.display().to_string(),
        contents,
    }
}

fn registration_for_windows(executable: &str) -> RegistrationTarget {
    RegistrationTarget {
        strategy: "registry-run".into(),
        target: format!(r"{WINDOWS_RUN_KEY}\{WINDOWS_VALUE_NAME}"),
        contents: format!("\"{}\"", executable.replace('"', "\\\"")),
    }
}

fn install_registration(target: &RegistrationTarget) -> Result<()> {
    if target.strategy == "registry-run" {
        install_windows_registry(target)
    } else {
        let path = Path::new(&target.target);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "Failed to create auto-start directory: {}",
                    parent.display()
                )
            })?;
        }
        fs::write(path, &target.contents)
            .with_context(|| format!("Failed to write auto-start target: {}", path.display()))?;
        #[cfg(target_os = "macos")]
        if target.strategy == "launchd" {
            let _ = Command::new("launchctl")
                .arg("unload")
                .arg(&target.target)
                .status();
            let _ = Command::new("launchctl")
                .arg("load")
                .arg(&target.target)
                .status();
        }
        Ok(())
    }
}

fn remove_registration(target: &RegistrationTarget) -> Result<()> {
    if target.strategy == "registry-run" {
        remove_windows_registry(target)
    } else {
        #[cfg(target_os = "macos")]
        if target.strategy == "launchd" {
            let _ = Command::new("launchctl")
                .arg("unload")
                .arg(&target.target)
                .status();
        }
        match fs::remove_file(&target.target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to remove auto-start target: {}", target.target)),
        }
    }
}

fn registration_exists(target: &RegistrationTarget) -> Result<bool> {
    if target.strategy == "registry-run" {
        windows_registration_exists(target)
    } else {
        Ok(Path::new(&target.target).exists())
    }
}

fn build_status(target: &RegistrationTarget, enabled: bool) -> Result<AutoStartStatus> {
    Ok(AutoStartStatus {
        enabled,
        strategy: target.strategy.clone(),
        target: target.target.clone(),
        launches: "tray_shell".into(),
    })
}

fn current_executable_string() -> Result<String> {
    Ok(std::env::current_exe()
        .context("Failed to resolve current tray executable")?
        .display()
        .to_string())
}

fn home_dir_string() -> Result<String> {
    Ok(dirs::home_dir()
        .context("Failed to resolve home directory")?
        .display()
        .to_string())
}

fn should_enable_by_default(executable: &str) -> bool {
    let normalized = executable.replace('\\', "/").to_ascii_lowercase();
    !(normalized.contains("/target/debug/") || normalized.contains("/target/release/"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn desktop_escape(value: &str) -> String {
    value.replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
fn install_windows_registry(target: &RegistrationTarget) -> Result<()> {
    let status = Command::new("reg")
        .args([
            "add",
            WINDOWS_RUN_KEY,
            "/v",
            WINDOWS_VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &target.contents,
            "/f",
        ])
        .status()
        .context("Failed to register tray auto-start in Windows registry")?;
    if !status.success() {
        bail!("Windows registry auto-start command failed: {status}")
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    let status = Command::new("reg")
        .args(["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME, "/f"])
        .status()
        .context("Failed to remove tray auto-start from Windows registry")?;
    if !status.success() {
        bail!("Windows registry auto-start delete failed: {status}")
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn remove_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_registration_exists(_target: &RegistrationTarget) -> Result<bool> {
    let status = Command::new("reg")
        .args(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME])
        .status()
        .context("Failed to query tray auto-start from Windows registry")?;
    Ok(status.success())
}

#[cfg(not(target_os = "windows"))]
fn windows_registration_exists(_target: &RegistrationTarget) -> Result<bool> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn persists_explicit_autostart_preference() {
        let temp = tempdir().expect("temp dir");
        let prefs_path = temp.path().join("tray-shell.json");

        save_preferences_to_path(
            &prefs_path,
            &TrayPreferences {
                auto_start_enabled: false,
            },
        )
        .expect("save prefs");
        let loaded = load_preferences_from_path(&prefs_path).expect("load prefs");

        assert!(!loaded.auto_start_enabled);
    }

    #[test]
    fn builds_macos_launch_agent_target_under_home() {
        let target = registration_for_platform(
            "darwin",
            "/Applications/Trapezohe Companion.app/Contents/MacOS/trapezohe-companion-tray",
            "/Users/test",
        );
        assert!(target
            .target
            .ends_with("Library/LaunchAgents/ai.trapezohe.companion.tray.plist"));
        assert!(target.contents.contains("trapezohe-companion-tray"));
    }

    #[test]
    fn builds_linux_desktop_autostart_entry() {
        let target = registration_for_platform(
            "linux",
            "/opt/trapezohe-companion/trapezohe-companion-tray",
            "/home/test",
        );
        assert!(target
            .target
            .ends_with(".config/autostart/trapezohe-companion-tray.desktop"));
        assert!(target.contents.contains("X-GNOME-Autostart-enabled=true"));
    }

    #[test]
    fn disables_default_registration_for_dev_binary_paths() {
        assert!(!should_enable_by_default(
            "/Users/test/trapezohe-companion/tray/target/debug/trapezohe-companion-tray"
        ));
        assert!(should_enable_by_default(
            "/Applications/Trapezohe Companion.app/Contents/MacOS/trapezohe-companion-tray"
        ));
    }
}
