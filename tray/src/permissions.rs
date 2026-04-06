use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::models::CompanionConfig;

// ─── Permission model types ───

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionGroup {
    System,
    HighRisk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAuthStatus {
    Authorized,
    NotAuthorized,
    NotSupported,
    ImplicitlyAllowed,
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

const PERMISSION_IDS: [&str; 10] = [
    "screen_recording",
    "accessibility",
    "automation",
    "camera",
    "microphone",
    "location",
    "notifications",
    "local_command",
    "browser_control",
    "admin_action",
];

pub fn default_companion_capability_flags() -> CompanionCapabilityFlags {
    PERMISSION_IDS
        .iter()
        .map(|id| (id.to_string(), false))
        .collect()
}

pub fn normalize_companion_capability_flags(
    input: &HashMap<String, bool>,
) -> CompanionCapabilityFlags {
    let mut flags = default_companion_capability_flags();
    for id in PERMISSION_IDS {
        if let Some(enabled) = input.get(id) {
            flags.insert(id.to_string(), *enabled);
        }
    }
    flags
}

pub fn validate_permission_id(id: &str) -> Result<(), String> {
    if PERMISSION_IDS.contains(&id) {
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

// ─── System permission detection (macOS stubs) ───

#[cfg(target_os = "macos")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    // TODO: Implement real macOS permission detection using CoreGraphics,
    // Accessibility APIs (AXIsProcessTrusted), etc.
    // For now, return NotAuthorized for system permissions to demonstrate
    // the "needs authorization" flow in the UI.
    match id {
        "notifications" => SystemAuthStatus::Authorized, // Notifications are typically auto-granted
        "screen_recording" | "accessibility" | "automation" | "camera" | "microphone"
        | "location" => SystemAuthStatus::NotAuthorized,
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(target_os = "windows")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    match id {
        // Windows doesn't have the same permission model as macOS for most of these
        "notifications" => SystemAuthStatus::ImplicitlyAllowed,
        "camera" | "microphone" | "location" => SystemAuthStatus::NotAuthorized,
        "screen_recording" | "accessibility" | "automation" => SystemAuthStatus::ImplicitlyAllowed,
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(target_os = "linux")]
fn detect_system_auth(id: &str) -> SystemAuthStatus {
    match id {
        // Linux generally doesn't have macOS-style permission dialogs
        "notifications" | "screen_recording" | "accessibility" | "automation" => {
            SystemAuthStatus::ImplicitlyAllowed
        }
        "camera" | "microphone" => SystemAuthStatus::NotAuthorized,
        "location" => SystemAuthStatus::NotSupported,
        _ => SystemAuthStatus::NotSupported,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn detect_system_auth(_id: &str) -> SystemAuthStatus {
    SystemAuthStatus::NotSupported
}

/// Build the full permissions snapshot by combining system detection with companion flags
pub fn build_permissions_snapshot(flags: &CompanionCapabilityFlags) -> PermissionsSnapshot {
    let items = vec![
        // ── System Permissions ──
        build_system_permission("screen_recording", flags),
        build_system_permission("accessibility", flags),
        build_system_permission("automation", flags),
        build_system_permission("camera", flags),
        build_system_permission("microphone", flags),
        build_system_permission("location", flags),
        build_system_permission("notifications", flags),
        // ── High-Risk Capabilities ──
        build_high_risk_capability("local_command", false, flags),
        build_high_risk_capability("browser_control", false, flags),
        build_high_risk_capability("admin_action", true, flags),
    ];

    PermissionsSnapshot { items }
}

fn build_system_permission(id: &str, flags: &CompanionCapabilityFlags) -> PermissionItem {
    let system_auth = detect_system_auth(id);
    let platform_supported = !matches!(system_auth, SystemAuthStatus::NotSupported);
    let companion_enabled = match system_auth {
        SystemAuthStatus::Authorized | SystemAuthStatus::ImplicitlyAllowed => {
            flags.get(id).copied().unwrap_or(false)
        }
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

fn build_high_risk_capability(
    id: &str,
    requires_per_action: bool,
    flags: &CompanionCapabilityFlags,
) -> PermissionItem {
    PermissionItem {
        id: id.to_string(),
        group: PermissionGroup::HighRisk,
        title_key: format!("perm{}", to_pascal_case(id)),
        description_key: format!("perm{}Desc", to_pascal_case(id)),
        system_auth: SystemAuthStatus::Authorized, // high-risk capabilities aren't gated by system auth
        companion_enabled: flags.get(id).copied().unwrap_or(false),
        is_high_risk: true,
        requires_per_action_confirm: requires_per_action,
        platform_supported: true,
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
            "camera" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "location" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
            }
            "notifications" => "x-apple.systempreferences:com.apple.preference.notifications",
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
            "camera" => "ms-settings:privacy-webcam",
            "microphone" => "ms-settings:privacy-microphone",
            "location" => "ms-settings:privacy-location",
            "notifications" => "ms-settings:notifications",
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
        .json(&CapabilityUpdateRequest { capabilities: flags })
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
    fn test_default_permissions_all_disabled() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        // All system permissions should default to companion_enabled = false
        for item in &snapshot.items {
            assert!(!item.companion_enabled, "Permission {} should default to disabled", item.id);
        }
    }

    #[test]
    fn test_toggle_companion_flag() {
        let mut flags = default_companion_capability_flags();
        set_companion_capability_flag(&mut flags, "local_command", true).expect("valid flag");
        let snapshot = build_permissions_snapshot(&flags);
        let local_cmd = snapshot.items.iter().find(|p| p.id == "local_command").unwrap();
        assert!(local_cmd.companion_enabled);
        assert!(local_cmd.is_high_risk);
    }

    #[test]
    fn test_high_risk_items_flagged() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let high_risk: Vec<_> = snapshot.items.iter().filter(|p| p.is_high_risk).collect();
        assert_eq!(high_risk.len(), 3);
        assert!(high_risk.iter().all(|p| p.group == PermissionGroup::HighRisk));
    }

    #[test]
    fn test_admin_action_requires_per_action_confirm() {
        let flags = default_companion_capability_flags();
        let snapshot = build_permissions_snapshot(&flags);
        let admin = snapshot.items.iter().find(|p| p.id == "admin_action").unwrap();
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
            if item.system_auth == SystemAuthStatus::NotAuthorized && item.group == PermissionGroup::System {
                assert!(!item.companion_enabled,
                    "System permission '{}' should not be enabled when not authorized", item.id);
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
}
