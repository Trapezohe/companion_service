use anyhow::Result;
use serde::Deserialize;
use tokio::{sync::watch, time::{Duration, interval}};

use crate::models::{CompanionConfig, CompanionShellState, StatusViewModel};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HealthPayload {
    pub ok: bool,
    pub pid: u32,
    pub version: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: Option<String>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: u32,
    #[serde(rename = "mcpTools")]
    pub mcp_tools: u32,
}

pub fn map_health_payload(payload: HealthPayload, config: &CompanionConfig) -> StatusViewModel {
    StatusViewModel {
        state: CompanionShellState::Healthy {
            version: payload.version,
            protocol_version: payload.protocol_version,
            pid: payload.pid,
            mcp_servers: payload.mcp_servers,
            mcp_tools: payload.mcp_tools,
        },
        config_path: config.config_path.clone(),
        logs_dir: config.logs_dir.clone(),
    }
}

pub fn stopped_snapshot(config: Option<&CompanionConfig>) -> StatusViewModel {
    StatusViewModel {
        state: CompanionShellState::Stopped,
        config_path: config.map(|item| item.config_path.clone()).unwrap_or_default(),
        logs_dir: config.map(|item| item.logs_dir.clone()).unwrap_or_default(),
    }
}

pub fn misconfigured_snapshot(reason: impl Into<String>) -> StatusViewModel {
    StatusViewModel {
        state: CompanionShellState::Misconfigured { reason: reason.into() },
        config_path: String::new(),
        logs_dir: String::new(),
    }
}

pub async fn fetch_health(config: &CompanionConfig) -> Result<HealthPayload> {
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(3))
        .build()?;
    let response = client
        .get(format!("http://127.0.0.1:{}/healthz", config.port))
        .bearer_auth(&config.token)
        .send()
        .await?;
    let response = response.error_for_status()?;
    Ok(response.json::<HealthPayload>().await?)
}

pub fn spawn_health_checker(config: CompanionConfig, tx: watch::Sender<StatusViewModel>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            let next = match fetch_health(&config).await {
                Ok(payload) => map_health_payload(payload, &config),
                Err(_) => stopped_snapshot(Some(&config)),
            };
            let _ = tx.send(next);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_healthy_payload_into_view_model() {
        let config = CompanionConfig {
            port: 41591,
            token: "abc".into(),
            config_path: "/tmp/companion.json".into(),
            logs_dir: "/tmp".into(),
        };
        let model = map_health_payload(HealthPayload {
            ok: true,
            pid: 123,
            version: "0.1.0".into(),
            protocol_version: Some("trapezohe-companion/2026-03-07".into()),
            mcp_servers: 2,
            mcp_tools: 5,
        }, &config);

        assert_eq!(model.config_path, "/tmp/companion.json");
        match model.state {
            CompanionShellState::Healthy { pid, mcp_servers, mcp_tools, .. } => {
                assert_eq!(pid, 123);
                assert_eq!(mcp_servers, 2);
                assert_eq!(mcp_tools, 5);
            }
            _ => panic!("expected healthy state"),
        }
    }

    #[test]
    fn marks_misconfigured_snapshot() {
        let model = misconfigured_snapshot("missing token");
        match model.state {
            CompanionShellState::Misconfigured { reason } => assert!(reason.contains("missing token")),
            _ => panic!("expected misconfigured state"),
        }
    }
}
