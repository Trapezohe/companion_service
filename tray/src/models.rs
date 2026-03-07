use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompanionShellState {
    Checking,
    Healthy {
        version: String,
        protocol_version: Option<String>,
        pid: u32,
        mcp_servers: u32,
        mcp_tools: u32,
    },
    Degraded { reason: String },
    Stopped,
    Misconfigured { reason: String },
}

impl Default for CompanionShellState {
    fn default() -> Self {
        Self::Checking
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CompanionConfig {
    pub port: u16,
    pub token: String,
    pub config_path: String,
    pub logs_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StatusViewModel {
    pub state: CompanionShellState,
    pub config_path: String,
    pub logs_dir: String,
}
