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
    "calendar",
    "reminders",
    "contacts",
    "photos",
    "notes",
    "mail",
    "messages",
    "finder",
    "safari",
    "desktop_notification",
    "clipboard",
    "filesystem",
    "explorer",
    "process_control",
    "screenshot",
    "window_automation",
    "registry_write",
    "service_control",
    "task_scheduler",
    "admin_shell",
    "local_command",
    "browser_control",
    "admin_action",
];

pub fn companion_capability_default_enabled(id: &str) -> bool {
    matches!(id, "local_command" | "browser_control")
}

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

/// Long-running task tier. The extension (or any upstream caller) declares a
/// tier per request so the companion can distinguish a quick shell call that
/// should time out fast from a legitimate multi-hour compile/test. Default
/// tier keeps the historical safety net (5min runtime / 10min ACP); LongTask
/// opens it up to 24h.
///
/// This exists to remove the case where an LLM loop — now hosted in the
/// daemon itself (PR 9 phase 1-3) — drives a `run_command("cargo build
/// --release")` that the runtime would have strangled at 5 minutes even
/// though the loop itself is healthy and waiting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunTier {
    #[default]
    Default,
    LongTask,
}

pub const DEFAULT_TIER_RUNTIME_MAX_TIMEOUT_MS: u64 = 5 * 60 * 1000;
pub const DEFAULT_TIER_ACP_MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
pub const LONG_TASK_TIER_MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_TIER_SESSION_TTL_MS: u64 = 60 * 60 * 1000;
pub const LONG_TASK_TIER_SESSION_TTL_MS: u64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_TIER_TOOL_WAIT_MS: u64 = 5 * 60 * 1000;
pub const LONG_TASK_TIER_TOOL_WAIT_MS: u64 = 60 * 60 * 1000;

impl RunTier {
    /// Maximum per-request timeout. `default_cap` is the crate's historical
    /// upper bound (e.g. 300_000 for runtime, 600_000 for ACP). Long-task
    /// tier returns a flat 24h regardless of the caller's default, because
    /// the whole point is to let declared long tasks run to completion.
    pub fn max_timeout_ms(&self, default_cap: u64) -> u64 {
        match self {
            RunTier::Default => default_cap,
            RunTier::LongTask => LONG_TASK_TIER_MAX_TIMEOUT_MS,
        }
    }

    pub fn session_ttl_ms(&self) -> u64 {
        match self {
            RunTier::Default => DEFAULT_TIER_SESSION_TTL_MS,
            RunTier::LongTask => LONG_TASK_TIER_SESSION_TTL_MS,
        }
    }

    /// How long an LLM loop should patiently wait for a tool_result before
    /// declaring the extension dead. Long-task tier bumps this to 1h —
    /// enough for a real build — without going all the way to 24h (which
    /// would mask a genuinely dead extension).
    pub fn tool_wait_ms(&self) -> u64 {
        match self {
            RunTier::Default => DEFAULT_TIER_TOOL_WAIT_MS,
            RunTier::LongTask => LONG_TASK_TIER_TOOL_WAIT_MS,
        }
    }
}
