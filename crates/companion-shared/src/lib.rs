use serde::{Deserialize, Serialize};

pub const COMPANION_PROTOCOL_VERSION: &str = "2026-03-07";
pub const RUN_CONTRACT_VERSION: u32 = 2;
pub const DEFAULT_PORT: u16 = 41_591;
pub const FIXED_EXTENSION_ID: &str = "nnhdkkgpoeojjddikcjadgpkbfbjhcal";
pub const FIXED_EXTENSION_ORIGIN: &str = "chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal";
pub const PERMISSION_MODE_WORKSPACE: &str = "workspace";
pub const PERMISSION_MODE_FULL: &str = "full";
pub const COMPANION_PERMISSION_IDS: &[&str] = &[
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicy {
    pub mode: String,
    #[serde(default)]
    pub workspace_roots: Vec<String>,
    pub policy_reason: String,
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        Self {
            mode: PERMISSION_MODE_FULL.to_string(),
            workspace_roots: Vec::new(),
            policy_reason: "policy_mode:full".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportedFeatures {
    pub acp: bool,
    pub mcp: bool,
    pub cron_replay: bool,
    pub diagnostics: bool,
    pub approval_store: bool,
    pub run_ledger: bool,
    pub automation_executor: bool,
    pub automation_outbox: bool,
    pub browser_ledger: bool,
    pub browser_events: bool,
    pub browser_drilldown: bool,
    pub media_normalization: bool,
    pub memory_checkpoint_shadow: bool,
    pub memory_checkpoint_jobs: bool,
    pub workflow: String,
    pub browser_cdp: String,
}

impl Default for SupportedFeatures {
    fn default() -> Self {
        Self {
            acp: true,
            mcp: true,
            cron_replay: true,
            diagnostics: true,
            approval_store: true,
            run_ledger: true,
            automation_executor: true,
            automation_outbox: true,
            browser_ledger: true,
            browser_events: true,
            browser_drilldown: true,
            media_normalization: true,
            memory_checkpoint_shadow: true,
            memory_checkpoint_jobs: false,
            workflow: "1.0.0".to_string(),
            browser_cdp: "1.0.0".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesPayload {
    pub protocol_version: String,
    pub version: String,
    pub run_contract_version: u32,
    pub supported_features: SupportedFeatures,
}

pub fn version_string() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn protocol_version_string() -> String {
    format!("trapezohe-companion/{COMPANION_PROTOCOL_VERSION}")
}

pub fn capabilities_payload() -> CapabilitiesPayload {
    CapabilitiesPayload {
        protocol_version: protocol_version_string(),
        version: version_string(),
        run_contract_version: RUN_CONTRACT_VERSION,
        supported_features: SupportedFeatures::default(),
    }
}
