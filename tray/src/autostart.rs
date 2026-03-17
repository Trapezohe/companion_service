use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::models::AutoStartStatus;

/// On Windows, prevent child processes from creating a visible console window.
#[cfg(target_os = "windows")]
fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn suppress_console_window(_command: &mut Command) {}

const LEGACY_PREFS_FILE_NAME: &str = "companion-tray.json";
const STARTUP_POLICY_FILE_NAME: &str = "companion-startup.json";
const MACOS_LABEL: &str = "ai.trapezohe.companion.tray";
const MACOS_LEGACY_DAEMON_LABEL: &str = "ai.trapezohe.companion";
const LINUX_DESKTOP_NAME: &str = "trapezohe-companion-tray.desktop";
const LINUX_LEGACY_SERVICE_NAME: &str = "trapezohe-companion.service";
const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const WINDOWS_VALUE_NAME: &str = "TrapezoheCompanionTray";
const WINDOWS_LEGACY_TASK_NAME: &str = "TrapezoheCompanion";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrayPreferences {
    pub auto_start_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LoginItemMode {
    Tray,
    #[default]
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPolicy {
    pub login_item: LoginItemMode,
    pub ensure_daemon_on_tray_launch: bool,
}

impl Default for StartupPolicy {
    fn default() -> Self {
        Self {
            login_item: LoginItemMode::Disabled,
            ensure_daemon_on_tray_launch: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationTarget {
    pub strategy: String,
    pub target: String,
    pub contents: String,
}

pub fn resolve_preferences_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to resolve home directory")?;
    Ok(home.join(".trapezohe").join(LEGACY_PREFS_FILE_NAME))
}

pub fn resolve_policy_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to resolve home directory")?;
    Ok(home.join(".trapezohe").join(STARTUP_POLICY_FILE_NAME))
}

pub fn load_preferences_from_path(path: &Path) -> Result<TrayPreferences> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read tray preferences: {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse tray preferences: {}", path.display()))
}

#[cfg_attr(not(test), allow(dead_code))]
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

pub fn load_startup_policy_from_path(path: &Path) -> Result<StartupPolicy> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("Failed to read startup policy: {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse startup policy: {}", path.display()))
}

pub fn save_startup_policy_to_path(path: &Path, policy: &StartupPolicy) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create startup policy directory: {}",
                parent.display()
            )
        })?;
    }
    let payload = serde_json::to_string_pretty(policy)?;
    fs::write(path, payload)
        .with_context(|| format!("Failed to write startup policy: {}", path.display()))
}

pub fn load_startup_policy() -> Result<Option<StartupPolicy>> {
    let policy_path = resolve_policy_path()?;
    let legacy_path = resolve_preferences_path()?;
    load_startup_policy_with_migration_from_paths(&policy_path, &legacy_path)
}

pub fn save_startup_policy(policy: &StartupPolicy) -> Result<()> {
    let path = resolve_policy_path()?;
    save_startup_policy_to_path(&path, policy)
}

pub fn sync_autostart_on_launch() -> Result<AutoStartStatus> {
    let executable = current_executable_string()?;
    let home = home_dir_string()?;
    let target = registration_for_platform(std::env::consts::OS, &executable, &home);

    cleanup_legacy_daemon_autostart(std::env::consts::OS, &home)?;

    match load_startup_policy()? {
        Some(policy) => {
            apply_startup_policy(&policy, &target)?;
            build_status(&target, is_login_item_enabled(&policy))
        }
        None => {
            if should_enable_by_default(&executable) {
                let policy = enabled_startup_policy();
                apply_startup_policy(&policy, &target)?;
                save_startup_policy(&policy)?;
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
    let enabled = match load_startup_policy()? {
        Some(policy) => is_login_item_enabled(&policy),
        None => registration_exists(&target)?,
    };
    build_status(&target, enabled)
}

pub fn set_autostart_enabled(enabled: bool) -> Result<AutoStartStatus> {
    let executable = current_executable_string()?;
    let home = home_dir_string()?;
    let target = registration_for_platform(std::env::consts::OS, &executable, &home);
    let policy = if enabled {
        enabled_startup_policy()
    } else {
        StartupPolicy::default()
    };

    apply_startup_policy(&policy, &target)?;
    cleanup_legacy_daemon_autostart(std::env::consts::OS, &home)?;
    save_startup_policy(&policy)?;
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

fn enabled_startup_policy() -> StartupPolicy {
    StartupPolicy {
        login_item: LoginItemMode::Tray,
        ensure_daemon_on_tray_launch: true,
    }
}

fn is_login_item_enabled(policy: &StartupPolicy) -> bool {
    matches!(policy.login_item, LoginItemMode::Tray)
}

fn load_startup_policy_with_migration_from_paths(
    policy_path: &Path,
    legacy_path: &Path,
) -> Result<Option<StartupPolicy>> {
    if policy_path.exists() {
        return load_startup_policy_from_path(policy_path).map(Some);
    }
    if !legacy_path.exists() {
        return Ok(None);
    }

    let legacy = load_preferences_from_path(legacy_path)?;
    let policy = if legacy.auto_start_enabled {
        enabled_startup_policy()
    } else {
        StartupPolicy::default()
    };
    save_startup_policy_to_path(policy_path, &policy)?;
    let _ = fs::remove_file(legacy_path);
    Ok(Some(policy))
}

fn apply_startup_policy(policy: &StartupPolicy, target: &RegistrationTarget) -> Result<()> {
    if is_login_item_enabled(policy) {
        install_registration(target)
    } else {
        remove_registration(target)
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
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Trapezohe Companion\nComment=Launch the Trapezohe Companion tray on login and let it ensure the local daemon\nExec=\"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
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

fn legacy_cleanup_targets_for_platform(platform: &str, home: &str) -> Vec<RegistrationTarget> {
    match platform {
        "macos" | "darwin" => vec![RegistrationTarget {
            strategy: "launchd".into(),
            target: Path::new(home)
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{MACOS_LEGACY_DAEMON_LABEL}.plist"))
                .display()
                .to_string(),
            contents: String::new(),
        }],
        "linux" => vec![RegistrationTarget {
            strategy: "systemd-user".into(),
            target: Path::new(home)
                .join(".config")
                .join("systemd")
                .join("user")
                .join(LINUX_LEGACY_SERVICE_NAME)
                .display()
                .to_string(),
            contents: String::new(),
        }],
        "windows" | "win32" => vec![RegistrationTarget {
            strategy: "schtasks".into(),
            target: WINDOWS_LEGACY_TASK_NAME.into(),
            contents: String::new(),
        }],
        _ => Vec::new(),
    }
}

fn cleanup_legacy_daemon_autostart(platform: &str, home: &str) -> Result<()> {
    for target in legacy_cleanup_targets_for_platform(platform, home) {
        remove_legacy_registration(&target)?;
    }
    Ok(())
}

fn remove_legacy_registration(target: &RegistrationTarget) -> Result<()> {
    match target.strategy.as_str() {
        "systemd-user" => remove_systemd_user_registration(target),
        "schtasks" => remove_windows_scheduled_task(target),
        _ => remove_registration(target),
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
        launches: "companion_via_tray".into(),
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
    let mut cmd = Command::new("reg");
    cmd.args([
        "add",
        WINDOWS_RUN_KEY,
        "/v",
        WINDOWS_VALUE_NAME,
        "/t",
        "REG_SZ",
        "/d",
        &target.contents,
        "/f",
    ]);
    suppress_console_window(&mut cmd);
    let status = cmd
        .status()
        .context("Failed to register tray auto-start in Windows registry")?;
    if !status.success() {
        anyhow::bail!("Windows registry auto-start command failed: {status}")
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn remove_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    let mut cmd = Command::new("reg");
    cmd.args(["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME, "/f"]);
    suppress_console_window(&mut cmd);
    let status = cmd
        .status()
        .context("Failed to remove tray auto-start from Windows registry")?;
    if !status.success() {
        anyhow::bail!("Windows registry auto-start delete failed: {status}")
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn remove_windows_registry(_target: &RegistrationTarget) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_registration_exists(_target: &RegistrationTarget) -> Result<bool> {
    let mut cmd = Command::new("reg");
    cmd.args(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME]);
    suppress_console_window(&mut cmd);
    let status = cmd
        .status()
        .context("Failed to query tray auto-start from Windows registry")?;
    Ok(status.success())
}

#[cfg(not(target_os = "windows"))]
fn windows_registration_exists(_target: &RegistrationTarget) -> Result<bool> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn remove_windows_scheduled_task(target: &RegistrationTarget) -> Result<()> {
    let mut cmd = Command::new("schtasks");
    cmd.args(["/Delete", "/TN", &target.target, "/F"]);
    suppress_console_window(&mut cmd);
    let status = cmd
        .status()
        .context("Failed to remove legacy daemon scheduled task")?;
    if !status.success() {
        anyhow::bail!("Windows scheduled task delete failed: {status}")
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn remove_windows_scheduled_task(_target: &RegistrationTarget) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_systemd_user_registration(target: &RegistrationTarget) -> Result<()> {
    let service_name = Path::new(&target.target)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or(LINUX_LEGACY_SERVICE_NAME);
    let _ = Command::new("systemctl")
        .args(["--user", "disable", service_name])
        .status();
    let _ = Command::new("systemctl")
        .args(["--user", "stop", service_name])
        .status();
    match fs::remove_file(&target.target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "Failed to remove legacy systemd auto-start target: {}",
                target.target
            )
        }),
    }
}

#[cfg(not(target_os = "linux"))]
fn remove_systemd_user_registration(target: &RegistrationTarget) -> Result<()> {
    match fs::remove_file(&target.target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "Failed to remove legacy systemd auto-start target: {}",
                target.target
            )
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn normalize_test_path(path: &str) -> String {
        path.replace('\\', "/")
    }

    #[test]
    fn migrates_legacy_tray_preferences_to_unified_startup_policy() {
        let temp = tempdir().expect("temp dir");
        let legacy_path = temp.path().join("companion-tray.json");
        let policy_path = temp.path().join("companion-startup.json");

        save_preferences_to_path(
            &legacy_path,
            &TrayPreferences {
                auto_start_enabled: true,
            },
        )
        .expect("save legacy prefs");

        let policy = load_startup_policy_with_migration_from_paths(&policy_path, &legacy_path)
            .expect("load migrated policy")
            .expect("policy");

        assert_eq!(
            policy,
            StartupPolicy {
                login_item: LoginItemMode::Tray,
                ensure_daemon_on_tray_launch: true,
            }
        );
        assert!(policy_path.exists(), "migration should persist unified policy");
        assert!(!legacy_path.exists(), "legacy tray prefs should be retired");
    }

    #[test]
    fn enumerates_legacy_daemon_cleanup_targets_for_desktop_platforms() {
        let macos_targets = legacy_cleanup_targets_for_platform("darwin", "/Users/test");
        assert_eq!(macos_targets.len(), 1);
        assert_eq!(macos_targets[0].strategy, "launchd");
        assert!(normalize_test_path(&macos_targets[0].target)
            .ends_with("Library/LaunchAgents/ai.trapezohe.companion.plist"));

        let linux_targets = legacy_cleanup_targets_for_platform("linux", "/home/test");
        assert_eq!(linux_targets.len(), 1);
        assert_eq!(linux_targets[0].strategy, "systemd-user");
        assert!(normalize_test_path(&linux_targets[0].target)
            .ends_with(".config/systemd/user/trapezohe-companion.service"));

        let windows_targets = legacy_cleanup_targets_for_platform("windows", "C:/Users/test");
        assert_eq!(windows_targets.len(), 1);
        assert_eq!(windows_targets[0].strategy, "schtasks");
        assert_eq!(windows_targets[0].target, "TrapezoheCompanion");
    }

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
        assert!(normalize_test_path(&target.target)
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
        assert!(normalize_test_path(&target.target)
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
