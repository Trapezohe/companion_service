use companion_shared::{companion_capability_default_enabled, COMPANION_PERMISSION_IDS};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::models::CompanionConfig;

// ─── Permission model types ───

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionGroup {
    System,
    Application,
    HighRisk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAuthStatus {
    Authorized,
    NotAuthorized,
    NotSupported,
    ImplicitlyAllowed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionItem {
    pub id: String,
    pub group: PermissionGroup,
    pub title_key: String,
    pub description_key: String,
    pub system_auth: SystemAuthStatus,
    pub companion_enabled: bool,
    pub is_high_risk: bool,
    pub requires_per_action_confirm: bool,
    pub platform_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PermissionsSnapshot {
    pub items: Vec<PermissionItem>,
}

pub type CompanionCapabilityFlags = BTreeMap<String, bool>;

#[derive(Debug, Clone, Copy)]
struct PermissionDescriptor {
    id: &'static str,
    group: PermissionGroup,
    system_auth_override: Option<SystemAuthStatus>,
    system_auth_source: Option<&'static str>,
    requires_per_action_confirm: bool,
}

const fn permission_descriptor(
    id: &'static str,
    group: PermissionGroup,
    system_auth_override: Option<SystemAuthStatus>,
    system_auth_source: Option<&'static str>,
    requires_per_action_confirm: bool,
) -> PermissionDescriptor {
    PermissionDescriptor {
        id,
        group,
        system_auth_override,
        system_auth_source,
        requires_per_action_confirm,
    }
}

#[cfg(target_os = "macos")]
const PLATFORM_PERMISSION_DESCRIPTORS: &[PermissionDescriptor] = &[
    permission_descriptor(
        "screen_recording",
        PermissionGroup::System,
        None,
        None,
        false,
    ),
    permission_descriptor("accessibility", PermissionGroup::System, None, None, false),
    permission_descriptor("automation", PermissionGroup::System, None, None, false),
    permission_descriptor("camera", PermissionGroup::System, None, None, false),
    permission_descriptor("microphone", PermissionGroup::System, None, None, false),
    permission_descriptor("location", PermissionGroup::System, None, None, false),
    permission_descriptor("notifications", PermissionGroup::System, None, None, false),
    permission_descriptor("calendar", PermissionGroup::System, None, None, false),
    permission_descriptor("reminders", PermissionGroup::System, None, None, false),
    permission_descriptor("contacts", PermissionGroup::System, None, None, false),
    permission_descriptor("photos", PermissionGroup::System, None, None, false),
    permission_descriptor(
        "notes",
        PermissionGroup::Application,
        Some(SystemAuthStatus::Unknown),
        None,
        false,
    ),
    permission_descriptor(
        "mail",
        PermissionGroup::Application,
        Some(SystemAuthStatus::Unknown),
        None,
        false,
    ),
    permission_descriptor(
        "messages",
        PermissionGroup::Application,
        Some(SystemAuthStatus::Unknown),
        None,
        false,
    ),
    permission_descriptor(
        "finder",
        PermissionGroup::Application,
        Some(SystemAuthStatus::Unknown),
        None,
        false,
    ),
    permission_descriptor(
        "safari",
        PermissionGroup::Application,
        Some(SystemAuthStatus::Unknown),
        None,
        false,
    ),
    permission_descriptor(
        "local_command",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "browser_control",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "admin_action",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        true,
    ),
];

#[cfg(target_os = "windows")]
const PLATFORM_PERMISSION_DESCRIPTORS: &[PermissionDescriptor] = &[
    permission_descriptor(
        "screen_recording",
        PermissionGroup::System,
        None,
        None,
        false,
    ),
    permission_descriptor("camera", PermissionGroup::System, None, None, false),
    permission_descriptor("microphone", PermissionGroup::System, None, None, false),
    permission_descriptor("location", PermissionGroup::System, None, None, false),
    permission_descriptor(
        "desktop_notification",
        PermissionGroup::System,
        None,
        None,
        false,
    ),
    permission_descriptor(
        "clipboard",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "filesystem",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "explorer",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "process_control",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "screenshot",
        PermissionGroup::Application,
        None,
        Some("screen_recording"),
        false,
    ),
    permission_descriptor(
        "window_automation",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "local_command",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "browser_control",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "registry_write",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "service_control",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "task_scheduler",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "admin_shell",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        true,
    ),
    permission_descriptor(
        "admin_action",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        true,
    ),
];

#[cfg(target_os = "linux")]
const PLATFORM_PERMISSION_DESCRIPTORS: &[PermissionDescriptor] = &[
    permission_descriptor(
        "screen_recording",
        PermissionGroup::System,
        None,
        None,
        false,
    ),
    permission_descriptor("camera", PermissionGroup::System, None, None, false),
    permission_descriptor("microphone", PermissionGroup::System, None, None, false),
    permission_descriptor("location", PermissionGroup::System, None, None, false),
    permission_descriptor(
        "desktop_notification",
        PermissionGroup::System,
        None,
        None,
        false,
    ),
    permission_descriptor(
        "clipboard",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "process_control",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "screenshot",
        PermissionGroup::Application,
        Some(SystemAuthStatus::ImplicitlyAllowed),
        None,
        false,
    ),
    permission_descriptor(
        "local_command",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "browser_control",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "admin_action",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        true,
    ),
];

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const PLATFORM_PERMISSION_DESCRIPTORS: &[PermissionDescriptor] = &[
    permission_descriptor(
        "local_command",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "browser_control",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        false,
    ),
    permission_descriptor(
        "admin_action",
        PermissionGroup::HighRisk,
        Some(SystemAuthStatus::Authorized),
        None,
        true,
    ),
];

pub fn default_companion_capability_flags() -> CompanionCapabilityFlags {
    COMPANION_PERMISSION_IDS
        .iter()
        .map(|id| (id.to_string(), companion_capability_default_enabled(id)))
        .collect()
}

pub fn normalize_companion_capability_flags(
    input: &HashMap<String, bool>,
) -> CompanionCapabilityFlags {
    let mut flags = default_companion_capability_flags();
    for &id in COMPANION_PERMISSION_IDS {
        if let Some(enabled) = input.get(id) {
            flags.insert(id.to_string(), *enabled);
        }
    }
    flags
}

pub fn validate_permission_id(id: &str) -> Result<(), String> {
    if COMPANION_PERMISSION_IDS.contains(&id) {
        Ok(())
    } else {
        Err(format!("Unknown companion permission id: {id}"))
    }
}

pub fn set_companion_capability_flag(
    flags: &mut CompanionCapabilityFlags,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    validate_permission_id(id)?;
    flags.insert(id.to_string(), enabled);
    Ok(())
}

fn current_permission_descriptor(id: &str) -> Option<&'static PermissionDescriptor> {
    PLATFORM_PERMISSION_DESCRIPTORS
        .iter()
        .find(|descriptor| descriptor.id == id)
}

fn permission_system_auth(
    descriptor: &PermissionDescriptor,
    fallback_for_group: SystemAuthStatus,
) -> SystemAuthStatus {
    if let Some(source) = descriptor.system_auth_source {
        return detect_system_auth(source);
    }

    descriptor
        .system_auth_override
        .unwrap_or(fallback_for_group)
}

pub fn validate_permission_toggle(
    flags: &CompanionCapabilityFlags,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    validate_permission_id(id)?;

    let Some(descriptor) = current_permission_descriptor(id) else {
        return Err(format!(
            "Permission '{id}' is not available on this platform."
        ));
    };

    let item = build_permission_item(descriptor, flags);
    if !item.platform_supported {
        return Err(format!(
            "Permission '{id}' is not supported on this platform."
        ));
    }

    if enabled && matches!(item.system_auth, SystemAuthStatus::NotAuthorized) {
        return Err(format!(
            "Permission '{id}' still needs system authorization."
        ));
    }

    Ok(())
}

// ─── System permission detection ───

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    match id {
        "screen_recording" => {
            if unsafe { CGPreflightScreenCaptureAccess() } {
                SystemAuthStatus::Authorized
            } else {
                SystemAuthStatus::NotAuthorized
            }
        }
        "accessibility" => {
            if unsafe { AXIsProcessTrusted() } {
                SystemAuthStatus::Authorized
            } else {
                SystemAuthStatus::NotAuthorized
            }
        }
        // The remaining macOS permissions are not wired to native checks yet.
        // Report them as unknown instead of pretending we know their state.
        "automation" | "camera" | "microphone" | "location" | "notifications" | "calendar"
        | "reminders" | "contacts" | "photos" => SystemAuthStatus::Unknown,
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(any(test, target_os = "windows"))]
fn parse_windows_consent_value(value: &str) -> SystemAuthStatus {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        SystemAuthStatus::Unknown
    } else if normalized.contains("deny") {
        SystemAuthStatus::NotAuthorized
    } else if normalized.contains("allow") {
        SystemAuthStatus::Authorized
    } else {
        SystemAuthStatus::Unknown
    }
}

#[cfg(any(test, target_os = "windows"))]
fn parse_windows_toggle_dword(value: u32) -> SystemAuthStatus {
    if value == 0 {
        SystemAuthStatus::NotAuthorized
    } else {
        SystemAuthStatus::Authorized
    }
}

#[cfg(target_os = "windows")]
fn read_windows_registry_string(path: &str, value_name: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .find_map(|hive| {
            let key = RegKey::predef(hive).open_subkey(path).ok()?;
            key.get_value::<String, _>(value_name).ok()
        })
}

#[cfg(target_os = "windows")]
fn read_windows_registry_dword(path: &str, value_name: &str) -> Option<u32> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .find_map(|hive| {
            let key = RegKey::predef(hive).open_subkey(path).ok()?;
            key.get_value::<u32, _>(value_name).ok()
        })
}

#[cfg(target_os = "windows")]
fn detect_windows_consent_store_auth(capability: &str) -> SystemAuthStatus {
    let path = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{capability}"
    );
    read_windows_registry_string(&path, "Value")
        .map(|value| parse_windows_consent_value(&value))
        .unwrap_or(SystemAuthStatus::Unknown)
}

#[cfg(target_os = "windows")]
fn detect_windows_notification_auth() -> SystemAuthStatus {
    let policy_path = "Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\PushNotifications";
    if let Some(value) = read_windows_registry_dword(policy_path, "NoToastApplicationNotification")
    {
        return parse_windows_toggle_dword(1u32.saturating_sub(value.min(1)));
    }

    let push_path = "Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications";
    read_windows_registry_dword(push_path, "ToastEnabled")
        .map(parse_windows_toggle_dword)
        .unwrap_or(SystemAuthStatus::Unknown)
}

#[cfg(target_os = "windows")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    match id {
        "screen_recording" => detect_windows_consent_store_auth("graphicsCaptureProgrammatic"),
        "camera" => detect_windows_consent_store_auth("webcam"),
        "microphone" => detect_windows_consent_store_auth("microphone"),
        "location" => detect_windows_consent_store_auth("location"),
        "desktop_notification" => detect_windows_notification_auth(),
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(target_os = "linux")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    match id {
        "desktop_notification" | "screen_recording" => SystemAuthStatus::ImplicitlyAllowed,
        "camera" | "microphone" | "location" => SystemAuthStatus::Unknown,
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn detect_system_auth(_id: &str) -> SystemAuthStatus {
    SystemAuthStatus::NotSupported
}

/// Build the full permissions snapshot by combining system detection with companion flags
pub fn build_permissions_snapshot(flags: &CompanionCapabilityFlags) -> PermissionsSnapshot {
    let items = PLATFORM_PERMISSION_DESCRIPTORS
        .iter()
        .map(|descriptor| build_permission_item(descriptor, flags))
        .collect();

    PermissionsSnapshot { items }
}

fn build_permission_item(
    descriptor: &PermissionDescriptor,
    flags: &CompanionCapabilityFlags,
) -> PermissionItem {
    match descriptor.group {
        PermissionGroup::System => build_system_permission(descriptor.id, flags),
        PermissionGroup::Application => build_capability_permission(
            descriptor.id,
            PermissionGroup::Application,
            permission_system_auth(descriptor, SystemAuthStatus::Unknown),
            false,
            descriptor.requires_per_action_confirm,
            flags,
        ),
        PermissionGroup::HighRisk => build_capability_permission(
            descriptor.id,
            PermissionGroup::HighRisk,
            permission_system_auth(descriptor, SystemAuthStatus::Authorized),
            true,
            descriptor.requires_per_action_confirm,
            flags,
        ),
    }
}

fn build_system_permission(id: &str, flags: &CompanionCapabilityFlags) -> PermissionItem {
    let system_auth = detect_system_auth(id);
    let platform_supported = !matches!(system_auth, SystemAuthStatus::NotSupported);
    let stored_flag = flags
        .get(id)
        .copied()
        .unwrap_or_else(|| companion_capability_default_enabled(id));
    let companion_enabled = match system_auth {
        SystemAuthStatus::Authorized
        | SystemAuthStatus::ImplicitlyAllowed
        | SystemAuthStatus::Unknown => stored_flag,
        SystemAuthStatus::NotAuthorized | SystemAuthStatus::NotSupported => false,
    };

    PermissionItem {
        id: id.to_string(),
        group: PermissionGroup::System,
        title_key: format!("perm{}", to_pascal_case(id)),
        description_key: format!("perm{}Desc", to_pascal_case(id)),
        system_auth,
        companion_enabled,
        is_high_risk: false,
        requires_per_action_confirm: false,
        platform_supported,
    }
}

fn build_capability_permission(
    id: &str,
    group: PermissionGroup,
    system_auth: SystemAuthStatus,
    is_high_risk: bool,
    requires_per_action_confirm: bool,
    flags: &CompanionCapabilityFlags,
) -> PermissionItem {
    let platform_supported = !matches!(system_auth, SystemAuthStatus::NotSupported);
    let stored_flag = flags
        .get(id)
        .copied()
        .unwrap_or_else(|| companion_capability_default_enabled(id));
    let companion_enabled = if platform_supported {
        match system_auth {
            SystemAuthStatus::NotAuthorized | SystemAuthStatus::NotSupported => false,
            SystemAuthStatus::Authorized
            | SystemAuthStatus::ImplicitlyAllowed
            | SystemAuthStatus::Unknown => stored_flag,
        }
    } else {
        false
    };

    PermissionItem {
        id: id.to_string(),
        group,
        title_key: format!("perm{}", to_pascal_case(id)),
        description_key: format!("perm{}Desc", to_pascal_case(id)),
        system_auth,
        companion_enabled,
        is_high_risk,
        requires_per_action_confirm,
        platform_supported,
    }
}

fn to_pascal_case(snake: &str) -> String {
    snake
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect()
}

/// Open the relevant system settings pane for a specific permission
pub fn open_system_settings_for_permission(id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if id == "screen_recording" && !unsafe { CGPreflightScreenCaptureAccess() } {
            if unsafe { CGRequestScreenCaptureAccess() } {
                return Ok(());
            }
        }

        let pane = match id {
            "screen_recording" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "automation" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
            }
            "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "location" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
            }
            "notifications" => "x-apple.systempreferences:com.apple.preference.notifications",
            "calendar" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
            }
            "reminders" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
            }
            "contacts" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
            }
            "photos" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
            _ => return Err(format!("No system settings pane for: {id}")),
        };
        std::process::Command::new("open")
            .arg(pane)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let uri = match id {
            "screen_recording" | "screenshot" => "ms-settings:privacy-graphicscaptureprogrammatic",
            "camera" => "ms-settings:privacy-webcam",
            "microphone" => "ms-settings:privacy-microphone",
            "location" => "ms-settings:privacy-location",
            "desktop_notification" | "notifications" => "ms-settings:privacy-notifications",
            _ => return Err(format!("No system settings pane for: {id}")),
        };
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", uri])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // Linux doesn't have unified permission settings
        let _ = id;
        Err("System permission settings are not applicable on this platform.".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = id;
        Err("Unsupported platform".to_string())
    }
}

#[derive(Debug, Deserialize)]
struct CapabilityResponse {
    capabilities: HashMap<String, bool>,
}

#[derive(Debug, Serialize)]
struct CapabilityUpdateRequest<'a> {
    capabilities: &'a CompanionCapabilityFlags,
}

pub async fn sync_companion_capabilities(
    config: &CompanionConfig,
    flags: &CompanionCapabilityFlags,
) -> Result<CompanionCapabilityFlags, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("{}/api/security/capabilities", config.endpoint()))
        .bearer_auth(&config.token)
        .json(&CapabilityUpdateRequest {
            capabilities: flags,
        })
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let payload = response
        .json::<CapabilityResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(normalize_companion_capability_flags(&payload.capabilities))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_permissions_keep_required_capabilities_enabled() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let enabled: Vec<_> = snapshot
            .items
            .iter()
            .filter(|item| item.companion_enabled)
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(enabled, vec!["local_command", "browser_control"]);
    }

    #[test]
    fn test_new_windows_capabilities_default_to_disabled() {
        let flags = default_companion_capability_flags();
        assert_eq!(flags.get("clipboard"), Some(&false));
        assert_eq!(flags.get("filesystem"), Some(&false));
        assert_eq!(flags.get("explorer"), Some(&false));
        assert_eq!(flags.get("process_control"), Some(&false));
        assert_eq!(flags.get("screenshot"), Some(&false));
        assert_eq!(flags.get("window_automation"), Some(&false));
        assert_eq!(flags.get("registry_write"), Some(&false));
        assert_eq!(flags.get("service_control"), Some(&false));
        assert_eq!(flags.get("task_scheduler"), Some(&false));
        assert_eq!(flags.get("admin_shell"), Some(&false));
    }

    #[test]
    fn test_toggle_companion_flag() {
        let mut flags = default_companion_capability_flags();
        set_companion_capability_flag(&mut flags, "local_command", true).expect("valid flag");
        let snapshot = build_permissions_snapshot(&flags);
        let local_cmd = snapshot
            .items
            .iter()
            .find(|p| p.id == "local_command")
            .unwrap();
        assert!(local_cmd.companion_enabled);
        assert!(local_cmd.is_high_risk);
    }

    #[test]
    fn test_high_risk_items_flagged() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let high_risk: Vec<_> = snapshot.items.iter().filter(|p| p.is_high_risk).collect();
        assert!(high_risk
            .iter()
            .all(|p| p.group == PermissionGroup::HighRisk));
        #[cfg(target_os = "windows")]
        assert_eq!(high_risk.len(), 7);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(high_risk.len(), 3);
    }

    #[test]
    fn test_application_items_are_grouped_separately() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let application: Vec<_> = snapshot
            .items
            .iter()
            .filter(|p| p.group == PermissionGroup::Application)
            .map(|p| p.id.as_str())
            .collect();
        #[cfg(target_os = "macos")]
        assert_eq!(
            application,
            vec!["notes", "mail", "messages", "finder", "safari"]
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            application,
            vec![
                "clipboard",
                "filesystem",
                "explorer",
                "process_control",
                "screenshot",
                "window_automation"
            ]
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            application,
            vec!["clipboard", "process_control", "screenshot"]
        );
    }

    #[test]
    fn test_admin_action_requires_per_action_confirm() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let admin = snapshot
            .items
            .iter()
            .find(|p| p.id == "admin_action")
            .unwrap();
        assert!(admin.requires_per_action_confirm);
        assert!(admin.is_high_risk);
    }

    #[test]
    fn test_system_auth_cannot_enable_when_not_authorized() {
        // This tests the UI-level rule:
        // When system_auth is NotAuthorized, companion_enabled should not be settable.
        // The enforcement is in the frontend toggle logic, but we verify the data model here.
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);

        for item in &snapshot.items {
            if item.system_auth == SystemAuthStatus::NotAuthorized
                && item.group == PermissionGroup::System
            {
                assert!(
                    !item.companion_enabled,
                    "System permission '{}' should not be enabled when not authorized",
                    item.id
                );
            }
        }
    }

    #[test]
    fn test_pascal_case() {
        assert_eq!(to_pascal_case("screen_recording"), "ScreenRecording");
        assert_eq!(to_pascal_case("local_command"), "LocalCommand");
        assert_eq!(to_pascal_case("admin_action"), "AdminAction");
        assert_eq!(to_pascal_case("camera"), "Camera");
    }

    #[test]
    fn test_rejects_unknown_permission_ids() {
        let mut flags = default_companion_capability_flags();
        let error = set_companion_capability_flag(&mut flags, "unknown_permission", true)
            .expect_err("unknown permission should fail");
        assert!(error.contains("Unknown companion permission id"));
    }

    #[test]
    fn test_accepts_new_windows_permission_ids() {
        validate_permission_id("clipboard").expect("clipboard should be valid");
        validate_permission_id("filesystem").expect("filesystem should be valid");
        validate_permission_id("registry_write").expect("registry_write should be valid");
        validate_permission_id("admin_shell").expect("admin_shell should be valid");
    }

    #[test]
    fn test_validate_permission_toggle_rejects_other_platform_permissions() {
        let flags = default_companion_capability_flags();

        #[cfg(target_os = "macos")]
        {
            let error = validate_permission_toggle(&flags, "clipboard", true)
                .expect_err("clipboard should be unavailable on macOS");
            assert!(error.contains("not available on this platform"));
        }

        #[cfg(target_os = "windows")]
        {
            let error = validate_permission_toggle(&flags, "finder", true)
                .expect_err("finder should be unavailable on Windows");
            assert!(error.contains("not available on this platform"));
        }

        #[cfg(target_os = "linux")]
        {
            let error = validate_permission_toggle(&flags, "finder", true)
                .expect_err("finder should be unavailable on Linux");
            assert!(error.contains("not available on this platform"));
        }
    }

    #[test]
    fn test_parse_windows_consent_values() {
        assert_eq!(
            parse_windows_consent_value("Allow"),
            SystemAuthStatus::Authorized
        );
        assert_eq!(
            parse_windows_consent_value("ForceAllow"),
            SystemAuthStatus::Authorized
        );
        assert_eq!(
            parse_windows_consent_value("Deny"),
            SystemAuthStatus::NotAuthorized
        );
        assert_eq!(
            parse_windows_consent_value("SystemDeny"),
            SystemAuthStatus::NotAuthorized
        );
        assert_eq!(
            parse_windows_consent_value("Prompt"),
            SystemAuthStatus::Unknown
        );
    }

    #[test]
    fn test_parse_windows_toggle_dword() {
        assert_eq!(
            parse_windows_toggle_dword(0),
            SystemAuthStatus::NotAuthorized
        );
        assert_eq!(parse_windows_toggle_dword(1), SystemAuthStatus::Authorized);
        assert_eq!(parse_windows_toggle_dword(2), SystemAuthStatus::Authorized);
    }

    #[test]
    fn test_snapshot_only_contains_current_platform_permissions() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let ids: Vec<_> = snapshot.items.iter().map(|item| item.id.as_str()).collect();

        #[cfg(target_os = "macos")]
        {
            assert!(ids.contains(&"finder"));
            assert!(!ids.contains(&"clipboard"));
            assert!(!ids.contains(&"registry_write"));
        }

        #[cfg(target_os = "windows")]
        {
            assert!(ids.contains(&"clipboard"));
            assert!(ids.contains(&"filesystem"));
            assert!(ids.contains(&"registry_write"));
            assert!(!ids.contains(&"finder"));
            assert!(!ids.contains(&"safari"));
        }

        #[cfg(target_os = "linux")]
        {
            assert!(ids.contains(&"clipboard"));
            assert!(!ids.contains(&"finder"));
            assert!(!ids.contains(&"registry_write"));
        }
    }
}
