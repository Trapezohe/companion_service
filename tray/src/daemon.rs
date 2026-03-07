use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{path::PathBuf, process::Command};

use crate::models::{CompanionConfig, RepairAction, SelfCheckSnapshot};

pub fn resolve_repo_root() -> Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|p| p.to_path_buf())
        .context("Failed to resolve repo root")
}

pub fn resolve_cli_entry() -> Result<PathBuf> {
    Ok(resolve_repo_root()?.join("bin").join("cli.mjs"))
}

pub fn start_daemon() -> Result<()> {
    let cli = resolve_cli_entry()?;
    let status = Command::new("node")
        .arg(cli)
        .arg("start")
        .arg("-d")
        .status()
        .context("Failed to spawn companion daemon")?;
    if !status.success() {
        anyhow::bail!("Companion daemon start command failed: {status}");
    }
    Ok(())
}

pub async fn stop_daemon(config: &CompanionConfig) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    client
        .post(format!(
            "http://127.0.0.1:{}/api/system/shutdown",
            config.port
        ))
        .bearer_auth(&config.token)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn restart_daemon(config: &CompanionConfig) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    client
        .post(format!(
            "http://127.0.0.1:{}/api/system/restart",
            config.port
        ))
        .bearer_auth(&config.token)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub fn open_logs_dir(path: &str) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(path).status()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer").arg(path).status()
    } else {
        Command::new("xdg-open").arg(path).status()
    }
    .context("Failed to open logs directory")?;

    if !status.success() {
        anyhow::bail!("Open logs command failed: {status}");
    }
    Ok(())
}

pub fn run_self_check() -> Result<SelfCheckSnapshot> {
    let payload: Value = run_cli_json(&["self-check", "--json"])?;
    Ok(SelfCheckSnapshot {
        ok: payload.get("ok").and_then(Value::as_bool).unwrap_or(false),
        failing_checks: extract_failing_checks(payload.get("checks")),
        repair_actions: extract_repair_actions(payload.get("repairActions")),
    })
}

pub fn run_repair(action: &str) -> Result<()> {
    let trimmed = action.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Repair action is required")
    }
    let _: Value = run_cli_json(&["repair", trimmed, "--json"])?;
    Ok(())
}

fn run_cli_json<T: DeserializeOwned>(args: &[&str]) -> Result<T> {
    let cli = resolve_cli_entry()?;
    let output = Command::new("node")
        .arg(cli)
        .args(args)
        .output()
        .context("Failed to invoke companion CLI")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("CLI exited with status {}", output.status)
        };
        anyhow::bail!(message)
    }

    serde_json::from_slice(&output.stdout).context("Failed to parse CLI JSON output")
}

fn extract_failing_checks(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Object(entries)) = value else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|(key, value)| {
            let failed = match value {
                Value::Object(map) => map
                    .get("ok")
                    .and_then(Value::as_bool)
                    .map(|item| !item)
                    .unwrap_or(false),
                Value::Array(items) => items.iter().any(|item| {
                    item.get("ok")
                        .and_then(Value::as_bool)
                        .map(|value| !value)
                        .unwrap_or(false)
                }),
                _ => false,
            };
            failed.then(|| key.to_string())
        })
        .collect()
}

fn extract_repair_actions(value: Option<&Value>) -> Vec<RepairAction> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };

    items
        .iter()
        .map(|item| RepairAction {
            id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            description: item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cli_entry_under_repo_bin() {
        let cli = resolve_cli_entry().expect("cli path");
        assert!(cli.ends_with("bin/cli.mjs"));
    }

    #[test]
    fn extracts_failed_checks_from_mixed_payloads() {
        let payload = serde_json::json!({
            "configReadable": { "ok": true },
            "nativeHostRegistration": { "ok": false },
            "mcpExecutables": [
                { "name": "a", "ok": true },
                { "name": "b", "ok": false }
            ]
        });

        let checks = extract_failing_checks(Some(&payload));
        assert_eq!(
            checks,
            vec![
                "mcpExecutables".to_string(),
                "nativeHostRegistration".to_string()
            ]
        );
    }
}
