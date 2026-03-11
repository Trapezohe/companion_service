use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::time::{sleep, Instant};

use crate::models::{CompanionConfig, RepairAction, SelfCheckSnapshot};

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliInvocation {
    program: PathBuf,
    prefix_args: Vec<String>,
}

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
    let cli = resolve_cli_invocation()?;
    let status = build_cli_command(&cli, &["start", "-d"])
        .status()
        .context("Failed to spawn companion daemon")?;
    if !status.success() {
        anyhow::bail!("Companion daemon start command failed: {status}");
    }
    Ok(())
}

pub async fn start_daemon_and_wait(config: Option<&CompanionConfig>) -> Result<()> {
    start_daemon()?;

    if let Some(config) = config {
        wait_for_daemon_ready(config, Duration::from_secs(10)).await?;
    } else {
        sleep(Duration::from_millis(500)).await;
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

async fn wait_for_daemon_ready(config: &CompanionConfig, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(2))
        .build()?;

    loop {
        let ready = client
            .get(format!("http://127.0.0.1:{}/healthz", config.port))
            .bearer_auth(&config.token)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);

        if ready {
            return Ok(());
        }

        if Instant::now() >= deadline {
            anyhow::bail!("Timed out waiting for the companion daemon to become ready")
        }

        sleep(Duration::from_millis(250)).await;
    }
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
    let cli = resolve_cli_invocation()?;
    let output = build_cli_command(&cli, args)
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

fn resolve_cli_invocation() -> Result<CliInvocation> {
    let repo_cli = resolve_cli_entry().ok();
    let home = dirs::home_dir();
    resolve_cli_invocation_from(home.as_deref(), repo_cli.as_deref())
}

fn resolve_cli_invocation_from(home: Option<&Path>, repo_cli: Option<&Path>) -> Result<CliInvocation> {
    if let Ok(override_path) = std::env::var("TRAPEZOHE_COMPANION_CLI") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Ok(CliInvocation {
                program: PathBuf::from(trimmed),
                prefix_args: Vec::new(),
            });
        }
    }

    if let Some(home) = home {
        for candidate in installed_cli_candidates(home) {
            if candidate.exists() {
                return Ok(CliInvocation {
                    program: candidate,
                    prefix_args: Vec::new(),
                });
            }
        }
    }

    if let Some(repo_cli) = repo_cli.filter(|path| path.exists()) {
        return Ok(CliInvocation {
            program: PathBuf::from("node"),
            prefix_args: vec![repo_cli.display().to_string()],
        });
    }

    if let Some(path_cli) = resolve_command_on_path("trapezohe-companion") {
        return Ok(CliInvocation {
            program: path_cli,
            prefix_args: Vec::new(),
        });
    }

    Ok(CliInvocation {
        program: PathBuf::from("trapezohe-companion"),
        prefix_args: Vec::new(),
    })
}

fn installed_cli_candidates(home: &Path) -> Vec<PathBuf> {
    let local_node_dir = home.join(".trapezohe").join("node");
    if cfg!(target_os = "windows") {
        vec![
            local_node_dir.join("trapezohe-companion.cmd"),
            local_node_dir.join("trapezohe-companion.exe"),
            local_node_dir.join("trapezohe-companion"),
        ]
    } else {
        vec![
            local_node_dir.join("bin").join("trapezohe-companion"),
            local_node_dir.join("trapezohe-companion"),
            PathBuf::from("/opt/homebrew/bin/trapezohe-companion"),
            PathBuf::from("/usr/local/bin/trapezohe-companion"),
        ]
    }
}

fn resolve_command_on_path(name: &str) -> Option<PathBuf> {
    let lookup_program = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let output = Command::new(lookup_program).arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

fn build_cli_command(cli: &CliInvocation, args: &[&str]) -> Command {
    let mut command = Command::new(&cli.program);
    command.args(&cli.prefix_args).args(args);
    command
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
    use tempfile::tempdir;

    #[test]
    fn prefers_installed_cli_even_when_source_tree_exists() {
        let temp = tempdir().expect("temp dir");
        let repo_cli = temp.path().join("bin").join("cli.mjs");
        std::fs::create_dir_all(repo_cli.parent().expect("bin dir")).expect("create bin dir");
        std::fs::write(&repo_cli, "#!/usr/bin/env node\n").expect("write repo cli");

        let installed_cli = installed_cli_candidates(temp.path())
            .into_iter()
            .next()
            .expect("at least one candidate");
        std::fs::create_dir_all(installed_cli.parent().expect("bin dir")).expect("create bin dir");
        std::fs::write(&installed_cli, "#!/bin/sh\n").expect("write installed cli");

        let invocation =
            resolve_cli_invocation_from(Some(temp.path()), Some(&repo_cli)).expect("installed cli");
        assert_eq!(invocation.program, installed_cli);
        assert!(invocation.prefix_args.is_empty());
    }

    #[test]
    fn falls_back_to_repo_cli_when_no_installed_binary_exists() {
        let temp = tempdir().expect("temp dir");
        let repo_cli = temp.path().join("bin").join("cli.mjs");
        std::fs::create_dir_all(repo_cli.parent().expect("bin dir")).expect("create bin dir");
        std::fs::write(&repo_cli, "#!/usr/bin/env node\n").expect("write repo cli");

        let invocation = resolve_cli_invocation_from(None, Some(&repo_cli)).expect("repo cli");
        assert_eq!(invocation.program, PathBuf::from("node"));
        assert_eq!(invocation.prefix_args, vec![repo_cli.display().to_string()]);
    }

    #[test]
    fn falls_back_to_local_node_global_binary_when_present() {
        let temp = tempdir().expect("temp dir");
        let candidate = installed_cli_candidates(temp.path())
            .into_iter()
            .next()
            .expect("at least one candidate");
        std::fs::create_dir_all(candidate.parent().expect("bin dir")).expect("create bin dir");
        std::fs::write(&candidate, "#!/bin/sh\n").expect("write candidate");

        let invocation =
            resolve_cli_invocation_from(Some(temp.path()), Some(Path::new("/missing/repo-cli")))
                .expect("fallback cli");
        assert_eq!(invocation.program, candidate);
        assert!(invocation.prefix_args.is_empty());
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
