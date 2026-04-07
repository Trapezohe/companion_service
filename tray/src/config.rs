use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

use crate::models::CompanionConfig;

const COMPANION_PERMISSION_IDS: [&str; 10] = [
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

#[derive(Debug, Deserialize)]
struct RawCompanionConfig {
    port: Option<u16>,
    token: Option<String>,
}

pub fn default_companion_capabilities() -> HashMap<String, bool> {
    COMPANION_PERMISSION_IDS
        .iter()
        .map(|id| (id.to_string(), false))
        .collect()
}

fn normalize_companion_capabilities(input: Option<&Map<String, Value>>) -> HashMap<String, bool> {
    let mut normalized = default_companion_capabilities();
    if let Some(input) = input {
        for id in COMPANION_PERMISSION_IDS {
            if let Some(value) = input.get(id).and_then(Value::as_bool) {
                normalized.insert(id.to_string(), value);
            }
        }
    }
    normalized
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
    config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
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
        logs_dir: resolve_logs_dir(&config_path.to_path_buf())
            .display()
            .to_string(),
    })
}

pub fn load_config() -> Result<CompanionConfig> {
    let config_path = resolve_config_path();
    load_config_from_path(&config_path)
}

pub fn load_companion_capabilities() -> Result<HashMap<String, bool>> {
    let config_path = resolve_config_path();
    load_companion_capabilities_from_path(&config_path)
}

pub fn load_companion_capabilities_from_path(config_path: &Path) -> Result<HashMap<String, bool>> {
    if !config_path.exists() {
        return Ok(default_companion_capabilities());
    }

    let raw = fs::read_to_string(config_path)
        .with_context(|| format!("Failed to read config: {}", config_path.display()))?;
    let parsed: Value = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse JSON config: {}", config_path.display()))?;

    Ok(normalize_companion_capabilities(
        parsed
            .as_object()
            .and_then(|object| object.get("companionCapabilities"))
            .and_then(Value::as_object),
    ))
}

pub fn save_companion_capabilities(capabilities: &HashMap<String, bool>) -> Result<()> {
    let config_path = resolve_config_path();
    save_companion_capabilities_to_path(&config_path, capabilities)
}

pub fn save_companion_capabilities_to_path(
    config_path: &Path,
    capabilities: &HashMap<String, bool>,
) -> Result<()> {
    let normalized = normalize_companion_capabilities(Some(
        &capabilities
            .iter()
            .map(|(key, value)| (key.clone(), Value::Bool(*value)))
            .collect::<Map<String, Value>>(),
    ));

    let mut root = if config_path.exists() {
        let raw = fs::read_to_string(config_path)
            .with_context(|| format!("Failed to read config: {}", config_path.display()))?;
        serde_json::from_str::<Value>(&raw)
            .with_context(|| format!("Failed to parse JSON config: {}", config_path.display()))?
    } else {
        json!({})
    };

    if !root.is_object() {
        root = json!({});
    }

    let object = root.as_object_mut().expect("config root should be object");
    object.insert(
        "companionCapabilities".to_string(),
        serde_json::to_value(normalized).context("Failed to serialize companion capabilities")?,
    );

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }

    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&root).context("Failed to encode config JSON")?
    );
    fs::write(config_path, body)
        .with_context(|| format!("Failed to write config: {}", config_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{tempdir, NamedTempFile};

    #[test]
    fn loads_valid_companion_config() {
        let mut file = NamedTempFile::new().expect("temp file");
        writeln!(file, "{{\"port\":41591,\"token\":\"abc\"}}").expect("write config");
        let config = load_config_from_path(file.path()).expect("config should load");
        assert_eq!(config.port, 41591);
        assert_eq!(config.token, "abc");
        assert!(config
            .config_path
            .ends_with(file.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn rejects_missing_token() {
        let mut file = NamedTempFile::new().expect("temp file");
        writeln!(file, "{{\"port\":41591,\"token\":\"\"}}").expect("write config");
        let error = load_config_from_path(file.path()).expect_err("config should fail");
        assert!(error.to_string().contains("missing token"));
    }

    #[test]
    fn loads_default_companion_capabilities_when_config_missing() {
        let dir = tempdir().expect("temp dir");
        let missing = dir.path().join("missing-companion.json");
        let caps = load_companion_capabilities_from_path(&missing).expect("load caps");
        assert_eq!(caps.get("local_command"), Some(&false));
        assert_eq!(caps.get("browser_control"), Some(&false));
        assert_eq!(caps.get("admin_action"), Some(&false));
    }

    #[test]
    fn saves_companion_capabilities_without_overwriting_other_config_fields() {
        let mut file = NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            "{{\"port\":41591,\"token\":\"abc\",\"permissionPolicy\":{{\"mode\":\"full\",\"workspaceRoots\":[]}}}}"
        )
        .expect("write config");

        let mut caps = default_companion_capabilities();
        caps.insert("local_command".into(), true);
        save_companion_capabilities_to_path(file.path(), &caps).expect("save caps");

        let raw = std::fs::read_to_string(file.path()).expect("read config");
        assert!(raw.contains("\"token\": \"abc\""));
        assert!(raw.contains("\"local_command\": true"));
        assert!(raw.contains("\"browser_control\": false"));
    }
}
