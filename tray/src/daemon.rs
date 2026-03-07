use anyhow::{Context, Result};
use std::{path::PathBuf, process::Command};

use crate::models::CompanionConfig;

pub fn resolve_repo_root() -> Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().map(|p| p.to_path_buf()).context("Failed to resolve repo root")
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
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build()?;
    client
        .post(format!("http://127.0.0.1:{}/api/system/shutdown", config.port))
        .bearer_auth(&config.token)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn restart_daemon(config: &CompanionConfig) -> Result<()> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build()?;
    client
        .post(format!("http://127.0.0.1:{}/api/system/restart", config.port))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cli_entry_under_repo_bin() {
        let cli = resolve_cli_entry().expect("cli path");
        assert!(cli.ends_with("bin/cli.mjs"));
    }
}
