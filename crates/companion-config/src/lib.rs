use anyhow::{bail, Context, Result};
use companion_shared::{
    PermissionPolicy, COMPANION_PERMISSION_IDS, DEFAULT_PORT, PERMISSION_MODE_FULL,
    PERMISSION_MODE_WORKSPACE,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restartable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_capable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConfig {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
    #[serde(default)]
    pub permission_policy: PermissionPolicy,
    #[serde(default)]
    pub companion_capabilities: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extension_ids: Vec<String>,
}

impl Default for CompanionConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: String::new(),
            mcp_servers: BTreeMap::new(),
            permission_policy: PermissionPolicy::default(),
            companion_capabilities: default_companion_capabilities(),
            extension_ids: Vec::new(),
        }
    }
}

pub fn default_companion_capabilities() -> BTreeMap<String, bool> {
    COMPANION_PERMISSION_IDS
        .iter()
        .map(|id| ((*id).to_string(), false))
        .collect()
}

pub fn normalize_companion_capabilities(input: &BTreeMap<String, bool>) -> BTreeMap<String, bool> {
    COMPANION_PERMISSION_IDS
        .iter()
        .map(|id| {
            let key = (*id).to_string();
            let value = input.get(*id).copied().unwrap_or(false);
            (key, value)
        })
        .collect()
}

pub fn normalize_permission_policy(input: &PermissionPolicy) -> PermissionPolicy {
    let raw_mode = input.mode.trim().to_lowercase();
    let mode = match raw_mode.as_str() {
        PERMISSION_MODE_FULL => PERMISSION_MODE_FULL.to_string(),
        PERMISSION_MODE_WORKSPACE => PERMISSION_MODE_WORKSPACE.to_string(),
        _ => PERMISSION_MODE_WORKSPACE.to_string(),
    };

    let mut workspace_roots = Vec::new();
    if mode == PERMISSION_MODE_WORKSPACE {
        for root in &input.workspace_roots {
            let trimmed = root.trim();
            if trimmed.is_empty() {
                continue;
            }
            let expanded = expand_tilde(trimmed);
            let absolute = expanded
                .canonicalize()
                .unwrap_or_else(|_| expanded.clone())
                .to_string_lossy()
                .to_string();
            if !workspace_roots.contains(&absolute) {
                workspace_roots.push(absolute);
            }
        }
    }

    let policy_reason = if mode == PERMISSION_MODE_FULL {
        "policy_mode:full".to_string()
    } else if workspace_roots.is_empty() {
        "policy_mode:workspace_unscoped".to_string()
    } else {
        "policy_mode:workspace".to_string()
    };

    PermissionPolicy {
        mode,
        workspace_roots,
        policy_reason,
    }
}

pub fn normalize_extension_ids(ids: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

pub fn is_path_within_roots(target: &Path, roots: &[String]) -> bool {
    let resolved_target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    for root in roots {
        let root_path = PathBuf::from(root);
        let resolved_root = root_path.canonicalize().unwrap_or(root_path);
        if resolved_target == resolved_root {
            return true;
        }
        if let Ok(relative) = resolved_target.strip_prefix(&resolved_root) {
            if !relative.as_os_str().is_empty() {
                return true;
            }
        }
    }
    false
}

pub fn normalize_mcp_server_config(input: &McpServerConfig) -> Result<McpServerConfig> {
    let command = input.command.trim();
    if command.is_empty() {
        bail!("MCP server config.command is required.");
    }
    let mut args = input
        .args
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    for arg in &mut args {
        if arg.starts_with("@bnb-chain/bnbchain-mcp") {
            *arg = "@bnb-chain/mcp@latest".to_string();
        }
    }
    let cwd = input
        .cwd
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(McpServerConfig {
        command: command.to_string(),
        args,
        env: input.env.clone(),
        cwd,
        request_timeout_ms: input.request_timeout_ms.filter(|value| *value > 0),
        restartable: input.restartable,
        write_capable: input.write_capable,
    })
}

pub fn update_mcp_server_config(
    config: &CompanionConfig,
    name: &str,
    server_config: &McpServerConfig,
) -> Result<CompanionConfig> {
    let server_name = name.trim();
    if server_name.is_empty() {
        bail!("MCP server name is required.");
    }
    let mut next = config.clone();
    next.mcp_servers.insert(
        server_name.to_string(),
        normalize_mcp_server_config(server_config)?,
    );
    Ok(next)
}

pub fn remove_mcp_server_config(
    config: &CompanionConfig,
    name: &str,
) -> Result<(CompanionConfig, bool)> {
    let server_name = name.trim();
    if server_name.is_empty() {
        bail!("MCP server name is required.");
    }
    let mut next = config.clone();
    let removed = next.mcp_servers.remove(server_name).is_some();
    Ok((next, removed))
}

pub fn get_config_dir() -> PathBuf {
    let override_dir = std::env::var("TRAPEZOHE_CONFIG_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(path) = override_dir {
        return PathBuf::from(path);
    }

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".trapezohe")
}

pub fn get_config_path() -> PathBuf {
    get_config_dir().join("companion.json")
}

pub fn get_pid_path() -> PathBuf {
    get_config_dir().join("companion.pid")
}

pub fn ensure_config_dir() -> Result<PathBuf> {
    let dir = get_config_dir();
    fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create config dir: {}", dir.display()))?;
    set_dir_permissions(&dir)?;
    Ok(dir)
}

pub fn load_config() -> Result<CompanionConfig> {
    ensure_config_dir()?;
    let path = get_config_path();
    if !path.exists() {
        return Ok(CompanionConfig::default());
    }

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config: {}", path.display()))?;
    let mut config: CompanionConfig = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse config JSON: {}", path.display()))?;
    config.port = if config.port == 0 {
        DEFAULT_PORT
    } else {
        config.port
    };
    config.token = config.token.trim().to_string();
    config.permission_policy = normalize_permission_policy(&config.permission_policy);
    config.companion_capabilities =
        normalize_companion_capabilities(&config.companion_capabilities);
    config.extension_ids = normalize_extension_ids(&config.extension_ids);
    Ok(config)
}

pub fn save_config(config: &CompanionConfig) -> Result<()> {
    ensure_config_dir()?;
    let path = get_config_path();
    let parent = path
        .parent()
        .context("Config path is missing a parent directory")?;
    let normalized = CompanionConfig {
        port: if config.port == 0 {
            DEFAULT_PORT
        } else {
            config.port
        },
        token: config.token.trim().to_string(),
        mcp_servers: config.mcp_servers.clone(),
        permission_policy: normalize_permission_policy(&config.permission_policy),
        companion_capabilities: normalize_companion_capabilities(&config.companion_capabilities),
        extension_ids: normalize_extension_ids(&config.extension_ids),
    };
    let json = serde_json::to_string_pretty(&normalized)? + "\n";
    let mut temp = NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temp.write_all(json.as_bytes())?;
    set_file_permissions(temp.path())?;
    temp.persist(&path)
        .map_err(|error| error.error)
        .with_context(|| format!("Failed to persist config: {}", path.display()))?;
    set_file_permissions(&path)?;
    Ok(())
}

pub fn init_config() -> Result<CompanionConfig> {
    let mut config = load_config()?;
    if config.token.is_empty() {
        config.token = generate_token();
    }
    save_config(&config)?;
    Ok(config)
}

pub fn ensure_token(config: &mut CompanionConfig) -> Result<()> {
    if config.token.trim().is_empty() {
        config.token = generate_token();
        save_config(config)?;
    }
    Ok(())
}

pub fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn write_pid(pid: u32) -> Result<()> {
    ensure_config_dir()?;
    let path = get_pid_path();
    fs::write(&path, format!("{pid}\n"))
        .with_context(|| format!("Failed to write pid file: {}", path.display()))?;
    set_file_permissions(&path)?;
    Ok(())
}

pub fn read_pid() -> Result<Option<u32>> {
    let path = get_pid_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read pid file: {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let pid = trimmed
        .parse::<u32>()
        .with_context(|| format!("Invalid pid in {}", path.display()))?;
    Ok(Some(pid))
}

pub fn remove_pid() -> Result<()> {
    let path = get_pid_path();
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("Failed to remove pid file: {}", path.display()))?;
    }
    Ok(())
}

fn expand_tilde(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("Failed to set file permissions for {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("Failed to set dir permissions for {}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::TempDir;

    fn with_temp_config_dir<F>(test_fn: F)
    where
        F: FnOnce(),
    {
        let temp_dir = TempDir::new().unwrap();
        let old_value = env::var("TRAPEZOHE_CONFIG_DIR").ok();
        env::set_var("TRAPEZOHE_CONFIG_DIR", temp_dir.path());
        test_fn();
        if let Some(value) = old_value {
            env::set_var("TRAPEZOHE_CONFIG_DIR", value);
        } else {
            env::remove_var("TRAPEZOHE_CONFIG_DIR");
        }
    }

    #[test]
    fn load_config_returns_defaults_when_missing() {
        with_temp_config_dir(|| {
            let config = load_config().unwrap();
            assert_eq!(config.port, DEFAULT_PORT);
            assert!(config.token.is_empty());
            assert_eq!(
                config.companion_capabilities,
                default_companion_capabilities()
            );
        });
    }

    #[test]
    fn init_config_generates_token_and_persists_it() {
        with_temp_config_dir(|| {
            let config = init_config().unwrap();
            assert_eq!(config.token.len(), 48);
            let loaded = load_config().unwrap();
            assert_eq!(loaded.token, config.token);
        });
    }

    #[test]
    fn normalize_invalid_permission_mode_to_workspace() {
        let policy = PermissionPolicy {
            mode: "weird".to_string(),
            workspace_roots: vec!["~/workspace".to_string()],
            policy_reason: String::new(),
        };
        let normalized = normalize_permission_policy(&policy);
        assert_eq!(normalized.mode, PERMISSION_MODE_WORKSPACE);
        assert_eq!(normalized.policy_reason, "policy_mode:workspace");
        assert_eq!(normalized.workspace_roots.len(), 1);
    }
}
