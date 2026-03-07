use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{env, fs, path::{Path, PathBuf}};

use crate::models::CompanionConfig;

#[derive(Debug, Deserialize)]
struct RawCompanionConfig {
    port: Option<u16>,
    token: Option<String>,
}

pub fn resolve_config_path() -> PathBuf {
    if let Ok(path) = env::var("TRAPEZOHE_COMPANION_CONFIG_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".trapezohe")
        .join("companion.json")
}

pub fn resolve_logs_dir(config_path: &PathBuf) -> PathBuf {
    config_path.parent().unwrap_or_else(|| std::path::Path::new(".")).to_path_buf()
}

pub fn load_config_from_path(config_path: &Path) -> Result<CompanionConfig> {
    let raw = fs::read_to_string(config_path)
        .with_context(|| format!("Failed to read config: {}", config_path.display()))?;
    let parsed: RawCompanionConfig = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse JSON config: {}", config_path.display()))?;

    let token = parsed.token.unwrap_or_default().trim().to_string();
    if token.is_empty() {
        bail!("Companion config is missing token")
    }

    Ok(CompanionConfig {
        port: parsed.port.unwrap_or(41591),
        token,
        config_path: config_path.display().to_string(),
        logs_dir: resolve_logs_dir(&config_path.to_path_buf()).display().to_string(),
    })
}

pub fn load_config() -> Result<CompanionConfig> {
    let config_path = resolve_config_path();
    load_config_from_path(&config_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn loads_valid_companion_config() {
        let mut file = NamedTempFile::new().expect("temp file") ;
        writeln!(file, "{{\"port\":41591,\"token\":\"abc\"}}") .expect("write config");
        let config = load_config_from_path(file.path()).expect("config should load");
        assert_eq!(config.port, 41591);
        assert_eq!(config.token, "abc");
        assert!(config.config_path.ends_with(file.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn rejects_missing_token() {
        let mut file = NamedTempFile::new().expect("temp file");
        writeln!(file, "{{\"port\":41591,\"token\":\"\"}}") .expect("write config");
        let error = load_config_from_path(file.path()).expect_err("config should fail");
        assert!(error.to_string().contains("missing token"));
    }
}
