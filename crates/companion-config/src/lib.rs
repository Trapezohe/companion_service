use anyhow::{bail, Context, Result};
use companion_shared::{
    PermissionPolicy, COMPANION_PERMISSION_IDS, DEFAULT_PORT, PERMISSION_MODE_FULL,
    PERMISSION_MODE_WORKSPACE,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const DEFAULT_DISCOVERED_MCP_REQUEST_TIMEOUT_MS: u64 = 120_000;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSyncConfig {
    pub stream_id: String,
    pub private_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_rpc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoveryConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_server_ids: Vec<String>,
}

impl McpDiscoveryConfig {
    pub fn is_empty(&self) -> bool {
        self.disabled_server_ids.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpServer {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct McpDiscoverySyncResult {
    pub config: CompanionConfig,
    pub added_servers: Vec<DiscoveredMcpServer>,
}

impl McpDiscoverySyncResult {
    pub fn changed(&self) -> bool {
        !self.added_servers.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionConfig {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
    #[serde(default, skip_serializing_if = "McpDiscoveryConfig::is_empty")]
    pub mcp_discovery: McpDiscoveryConfig,
    #[serde(default)]
    pub permission_policy: PermissionPolicy,
    #[serde(default)]
    pub companion_capabilities: BTreeMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_sync: Option<CheckpointSyncConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extension_ids: Vec<String>,
}

impl Default for CompanionConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: String::new(),
            mcp_servers: BTreeMap::new(),
            mcp_discovery: McpDiscoveryConfig::default(),
            permission_policy: PermissionPolicy::default(),
            companion_capabilities: default_companion_capabilities(),
            checkpoint_sync: None,
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

pub fn normalize_mcp_server_id(value: &str) -> String {
    let source = Path::new(value)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase();

    let mut normalized = String::new();
    let mut last_was_dash = false;
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            normalized.push('-');
            last_was_dash = true;
        }
    }

    normalized.trim_matches('-').to_string()
}

pub fn normalize_mcp_discovery_config(input: &McpDiscoveryConfig) -> McpDiscoveryConfig {
    let mut disabled_server_ids = Vec::new();
    for server_id in &input.disabled_server_ids {
        let normalized = normalize_mcp_server_id(server_id);
        if normalized.is_empty() {
            continue;
        }
        if !disabled_server_ids
            .iter()
            .any(|existing| existing == &normalized)
        {
            disabled_server_ids.push(normalized);
        }
    }

    McpDiscoveryConfig {
        disabled_server_ids,
    }
}

pub fn normalize_checkpoint_sync_config(
    input: &Option<CheckpointSyncConfig>,
) -> Option<CheckpointSyncConfig> {
    let Some(raw) = input.as_ref() else {
        return None;
    };

    let stream_id = raw.stream_id.trim().to_string();
    let private_key = raw.private_key.trim().to_string();
    let kv_rpc = raw
        .kv_rpc
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if stream_id.is_empty() || private_key.is_empty() {
        return None;
    }

    Some(CheckpointSyncConfig {
        stream_id,
        private_key,
        kv_rpc,
    })
}

fn checkpoint_sync_from_env() -> Option<CheckpointSyncConfig> {
    let stream_id = std::env::var("TRAPEZOHE_MEMORY_STREAM_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let private_key = std::env::var("TRAPEZOHE_MEMORY_PRIVATE_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let kv_rpc = std::env::var("TRAPEZOHE_MEMORY_KV_RPC")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match (stream_id, private_key) {
        (Some(stream_id), Some(private_key)) => Some(CheckpointSyncConfig {
            stream_id,
            private_key,
            kv_rpc,
        }),
        _ => None,
    }
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

pub fn mark_mcp_server_enabled(config: &CompanionConfig, name: &str) -> Result<CompanionConfig> {
    let server_name = name.trim();
    if server_name.is_empty() {
        bail!("MCP server name is required.");
    }

    let normalized_name = normalize_mcp_server_id(server_name);
    let mut next = config.clone();
    next.mcp_discovery
        .disabled_server_ids
        .retain(|server_id| server_id != &normalized_name);
    Ok(next)
}

pub fn mark_mcp_server_disabled(config: &CompanionConfig, name: &str) -> Result<CompanionConfig> {
    let server_name = name.trim();
    if server_name.is_empty() {
        bail!("MCP server name is required.");
    }

    let normalized_name = normalize_mcp_server_id(server_name);
    let mut next = config.clone();
    if !normalized_name.is_empty()
        && !next
            .mcp_discovery
            .disabled_server_ids
            .iter()
            .any(|server_id| server_id == &normalized_name)
    {
        next.mcp_discovery.disabled_server_ids.push(normalized_name);
    }
    next.mcp_discovery = normalize_mcp_discovery_config(&next.mcp_discovery);
    Ok(next)
}

pub fn discover_mcp_servers() -> Result<Vec<DiscoveredMcpServer>> {
    let mut discovered = Vec::new();

    append_unique_candidates(&mut discovered, discover_external_config_candidates()?);
    append_unique_candidates(&mut discovered, discover_path_candidates()?);
    discovered.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(discovered)
}

pub fn sync_discovered_mcp_servers(config: &CompanionConfig) -> Result<McpDiscoverySyncResult> {
    let discovered = discover_mcp_servers()?;
    let disabled_server_ids = config
        .mcp_discovery
        .disabled_server_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let mut configured_by_name = config
        .mcp_servers
        .keys()
        .map(|name| normalize_mcp_server_id(name))
        .collect::<HashSet<_>>();
    let mut configured_by_command = config
        .mcp_servers
        .values()
        .map(|server| normalized_candidate_command_key(&server.command, &server.args))
        .collect::<HashSet<_>>();

    let mut next = config.clone();
    let mut added_servers = Vec::new();

    for candidate in discovered {
        let command_key = normalized_candidate_command_key(&candidate.command, &candidate.args);
        if candidate.id.is_empty()
            || disabled_server_ids.contains(&candidate.id)
            || configured_by_name.contains(&candidate.id)
            || configured_by_command.contains(&command_key)
        {
            continue;
        }

        next.mcp_servers.insert(
            candidate.id.clone(),
            discovered_mcp_server_to_config(&candidate),
        );
        configured_by_name.insert(candidate.id.clone());
        configured_by_command.insert(command_key);
        added_servers.push(candidate);
    }

    Ok(McpDiscoverySyncResult {
        config: next,
        added_servers,
    })
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
    config.mcp_discovery = normalize_mcp_discovery_config(&config.mcp_discovery);
    config.permission_policy = normalize_permission_policy(&config.permission_policy);
    config.companion_capabilities =
        normalize_companion_capabilities(&config.companion_capabilities);
    config.checkpoint_sync = checkpoint_sync_from_env()
        .or_else(|| normalize_checkpoint_sync_config(&config.checkpoint_sync));
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
        mcp_discovery: normalize_mcp_discovery_config(&config.mcp_discovery),
        permission_policy: normalize_permission_policy(&config.permission_policy),
        companion_capabilities: normalize_companion_capabilities(&config.companion_capabilities),
        checkpoint_sync: normalize_checkpoint_sync_config(&config.checkpoint_sync),
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

fn discover_path_candidates() -> Result<Vec<DiscoveredMcpServer>> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let directories = std::env::split_paths(&path_var).collect::<Vec<_>>();
    discover_path_candidates_from_dirs(&directories)
}

fn discover_path_candidates_from_dirs(directories: &[PathBuf]) -> Result<Vec<DiscoveredMcpServer>> {
    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    for directory in directories {
        if !directory.is_dir() {
            continue;
        }

        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            if !path.is_file() || !is_executable_path(&path) {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if is_companion_internal_command(file_name) {
                continue;
            }

            let args = implicit_args_for_path_command(file_name).unwrap_or_default();
            if !looks_like_mcp_server_definition(file_name, file_name, &args) {
                continue;
            }

            let id = normalize_mcp_server_id(file_name);
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }

            discovered.push(DiscoveredMcpServer {
                id,
                name: display_name_from_command(file_name),
                command: path.display().to_string(),
                args,
                env: BTreeMap::new(),
                cwd: None,
                source: "path".to_string(),
            });
        }
    }

    Ok(discovered)
}

fn discover_external_config_candidates() -> Result<Vec<DiscoveredMcpServer>> {
    let mut discovered = Vec::new();

    for (source, path) in known_external_config_paths() {
        append_unique_candidates(
            &mut discovered,
            discover_external_config_candidates_from_path(&path, source)?,
        );
    }

    Ok(discovered)
}

fn known_external_config_paths() -> Vec<(&'static str, PathBuf)> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    let mut push_path = |source: &'static str, path: PathBuf| {
        if seen.insert(path.clone()) {
            paths.push((source, path));
        }
    };

    if let Some(home_dir) = dirs::home_dir() {
        push_path(
            "claude-config",
            home_dir.join(".config").join("claude").join("mcp.json"),
        );
        push_path(
            "alma-config",
            home_dir.join(".config").join("alma").join("mcp.json"),
        );
    }

    if let Some(config_dir) = dirs::config_dir() {
        push_path("claude-config", config_dir.join("claude").join("mcp.json"));
        push_path("alma-config", config_dir.join("alma").join("mcp.json"));
    }

    paths
}

fn discover_external_config_candidates_from_path(
    path: &Path,
    source: &str,
) -> Result<Vec<DiscoveredMcpServer>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("Failed to read {}", path.display()))
        }
    };

    #[derive(Debug, Clone, Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct ExternalMcpConfigFile {
        #[serde(default, rename = "mcpServers")]
        mcp_servers: BTreeMap<String, ExternalMcpConfigEntry>,
    }

    #[derive(Debug, Clone, Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct ExternalMcpConfigEntry {
        #[serde(default)]
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        cwd: Option<String>,
    }

    let parsed: ExternalMcpConfigFile = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(Vec::new()),
    };

    let mut discovered = Vec::new();
    let mut seen = HashSet::new();

    for (name, entry) in parsed.mcp_servers {
        let command = entry.command.trim().to_string();
        let args = sanitize_args(&entry.args);
        if command.is_empty() || !looks_like_mcp_server_definition(&name, &command, &args) {
            continue;
        }

        let id = preferred_server_name(&name, &command)?;
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }

        discovered.push(DiscoveredMcpServer {
            id,
            name: display_name_from_label(&name, &command),
            command,
            args,
            env: sanitize_env(&entry.env),
            cwd: sanitize_optional_string(entry.cwd.as_deref()),
            source: source.to_string(),
        });
    }

    Ok(discovered)
}

fn append_unique_candidates(
    target: &mut Vec<DiscoveredMcpServer>,
    candidates: Vec<DiscoveredMcpServer>,
) {
    for candidate in candidates {
        if let Some(index) = target
            .iter()
            .position(|existing| same_candidate(existing, &candidate))
        {
            if should_replace_candidate(&target[index], &candidate) {
                target[index] = candidate;
            }
            continue;
        }

        target.push(candidate);
    }
}

fn same_candidate(left: &DiscoveredMcpServer, right: &DiscoveredMcpServer) -> bool {
    left.id == right.id
        || normalized_candidate_command_key(&left.command, &left.args)
            == normalized_candidate_command_key(&right.command, &right.args)
}

fn should_replace_candidate(
    existing: &DiscoveredMcpServer,
    incoming: &DiscoveredMcpServer,
) -> bool {
    let existing_priority = source_priority(&existing.source);
    let incoming_priority = source_priority(&incoming.source);
    if incoming_priority != existing_priority {
        return incoming_priority > existing_priority;
    }

    incoming.args.len() > existing.args.len()
        || incoming.env.len() > existing.env.len()
        || incoming.cwd.is_some() && existing.cwd.is_none()
}

fn source_priority(source: &str) -> u8 {
    match source {
        "claude-config" | "alma-config" => 3,
        "path" => 1,
        _ => 0,
    }
}

fn preferred_server_name(name: &str, command: &str) -> Result<String> {
    let normalized_name = normalize_mcp_server_id(name);
    if !normalized_name.is_empty() {
        return Ok(normalized_name);
    }

    let fallback = normalize_mcp_server_id(command);
    if !fallback.is_empty() {
        return Ok(fallback);
    }

    bail!("Unable to determine MCP server name.")
}

fn normalized_command_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

fn normalized_candidate_command_key(command: &str, args: &[String]) -> String {
    let normalized_args = sanitize_args(args)
        .into_iter()
        .map(|item| item.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("\u{1f}");
    format!(
        "{}\u{1e}{}",
        normalized_command_key(command),
        normalized_args
    )
}

fn display_name_from_command(value: &str) -> String {
    Path::new(value)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(value)
        .to_string()
}

fn display_name_from_label(name: &str, command: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        trimmed.to_string()
    } else {
        display_name_from_command(command)
    }
}

fn looks_like_mcp_command(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("mcp")
        || normalized.contains("modelcontextprotocol")
        || (normalized.contains("chrome") && normalized.contains("devtools"))
        || (normalized.contains("browser") && normalized.contains("devtools"))
}

fn looks_like_mcp_server_definition(name: &str, command: &str, args: &[String]) -> bool {
    if looks_like_mcp_command(name) || looks_like_mcp_command(command) {
        return true;
    }

    if normalized_command_key(command) == "codex"
        && args
            .iter()
            .any(|item| item.trim().eq_ignore_ascii_case("mcp-server"))
    {
        return true;
    }

    args.iter().any(|item| {
        let trimmed = item.trim();
        trimmed.eq_ignore_ascii_case("mcp-server") || looks_like_mcp_command(trimmed)
    })
}

fn implicit_args_for_path_command(command: &str) -> Option<Vec<String>> {
    match normalized_command_key(command).as_str() {
        "codex" => Some(vec!["mcp-server".to_string()]),
        _ => None,
    }
}

fn is_companion_internal_command(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("trapezohe-companion") || normalized.contains("ghastai-companion")
}

fn sanitize_args(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn sanitize_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter_map(|(key, value)| {
            let trimmed_key = key.trim();
            if trimmed_key.is_empty() {
                return None;
            }
            Some((trimmed_key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn sanitize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
}

fn discovered_mcp_server_to_config(candidate: &DiscoveredMcpServer) -> McpServerConfig {
    McpServerConfig {
        command: candidate.command.trim().to_string(),
        args: sanitize_args(&candidate.args),
        env: sanitize_env(&candidate.env),
        cwd: sanitize_optional_string(candidate.cwd.as_deref()),
        request_timeout_ms: Some(DEFAULT_DISCOVERED_MCP_REQUEST_TIMEOUT_MS),
        restartable: Some(true),
        write_capable: Some(false),
    }
}

#[cfg(unix)]
fn is_executable_path(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|meta| meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "exe" | "cmd" | "bat" | "com" | "ps1"
            )
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn is_executable_path(_path: &Path) -> bool {
    true
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
    use std::sync::{LazyLock, Mutex};
    use tempfile::TempDir;

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn with_temp_config_dir<F>(test_fn: F)
    where
        F: FnOnce(),
    {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
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

    fn with_temp_home_and_config_dir<F>(test_fn: F)
    where
        F: FnOnce(&TempDir),
    {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let temp_dir = TempDir::new().unwrap();
        let old_config_dir = env::var("TRAPEZOHE_CONFIG_DIR").ok();
        let old_home = env::var("HOME").ok();
        let old_xdg = env::var("XDG_CONFIG_HOME").ok();
        let old_path = env::var("PATH").ok();
        let empty_bin = temp_dir.path().join("bin");
        fs::create_dir_all(&empty_bin).unwrap();

        env::set_var(
            "TRAPEZOHE_CONFIG_DIR",
            temp_dir.path().join("runtime-config"),
        );
        env::set_var("HOME", temp_dir.path());
        env::set_var("XDG_CONFIG_HOME", temp_dir.path().join(".config"));
        env::set_var("PATH", &empty_bin);

        test_fn(&temp_dir);

        if let Some(value) = old_config_dir {
            env::set_var("TRAPEZOHE_CONFIG_DIR", value);
        } else {
            env::remove_var("TRAPEZOHE_CONFIG_DIR");
        }

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }

        if let Some(value) = old_xdg {
            env::set_var("XDG_CONFIG_HOME", value);
        } else {
            env::remove_var("XDG_CONFIG_HOME");
        }

        if let Some(value) = old_path {
            env::set_var("PATH", value);
        } else {
            env::remove_var("PATH");
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

    #[test]
    fn normalize_checkpoint_sync_config_discards_incomplete_values() {
        assert_eq!(
            normalize_checkpoint_sync_config(&Some(CheckpointSyncConfig {
                stream_id: "stream-1".to_string(),
                private_key: String::new(),
                kv_rpc: Some("  ".to_string()),
            })),
            None
        );

        assert_eq!(
            normalize_checkpoint_sync_config(&Some(CheckpointSyncConfig {
                stream_id: " stream-1 ".to_string(),
                private_key: " 0xabc ".to_string(),
                kv_rpc: Some(" https://rpc.test ".to_string()),
            })),
            Some(CheckpointSyncConfig {
                stream_id: "stream-1".to_string(),
                private_key: "0xabc".to_string(),
                kv_rpc: Some("https://rpc.test".to_string()),
            })
        );
    }

    #[test]
    fn load_config_normalizes_mcp_discovery_state() {
        with_temp_config_dir(|| {
            let path = get_config_path();
            fs::write(
                &path,
                r#"{
                  "port": 41591,
                  "token": "abc",
                  "mcpDiscovery": {
                    "disabledServerIds": [" Context7 ", "context7", "Playwright MCP"]
                  }
                }"#,
            )
            .unwrap();

            let config = load_config().unwrap();
            assert_eq!(
                config.mcp_discovery.disabled_server_ids,
                vec!["context7".to_string(), "playwright-mcp".to_string()]
            );
        });
    }

    #[test]
    fn sync_discovered_mcp_servers_auto_adds_external_config_servers() {
        with_temp_home_and_config_dir(|temp_dir| {
            let claude_dir = temp_dir.path().join(".config").join("claude");
            fs::create_dir_all(&claude_dir).unwrap();
            fs::write(
                claude_dir.join("mcp.json"),
                r#"{
                  "mcpServers": {
                    "Context7": {
                      "command": "npx",
                      "args": ["-y", "@upstash/context7-mcp"]
                    }
                  }
                }"#,
            )
            .unwrap();

            let config = CompanionConfig {
                token: "abc".to_string(),
                ..CompanionConfig::default()
            };

            let result = sync_discovered_mcp_servers(&config).unwrap();
            assert!(result.changed());
            assert_eq!(result.added_servers.len(), 1);
            assert_eq!(result.added_servers[0].id, "context7");
            assert!(result.config.mcp_servers.contains_key("context7"));
        });
    }

    #[test]
    fn sync_discovered_mcp_servers_respects_disabled_server_ids() {
        with_temp_home_and_config_dir(|temp_dir| {
            let alma_dir = temp_dir.path().join(".config").join("alma");
            fs::create_dir_all(&alma_dir).unwrap();
            fs::write(
                alma_dir.join("mcp.json"),
                r#"{
                  "mcpServers": {
                    "Context7": {
                      "command": "npx",
                      "args": ["-y", "@upstash/context7-mcp"]
                    }
                  }
                }"#,
            )
            .unwrap();

            let config = CompanionConfig {
                token: "abc".to_string(),
                mcp_discovery: McpDiscoveryConfig {
                    disabled_server_ids: vec!["context7".to_string()],
                },
                ..CompanionConfig::default()
            };

            let result = sync_discovered_mcp_servers(&config).unwrap();
            assert!(!result.changed());
            assert!(result.config.mcp_servers.is_empty());
        });
    }

    #[test]
    fn mark_mcp_server_disabled_and_enabled_updates_disabled_ids() {
        let config = CompanionConfig::default();
        let disabled = mark_mcp_server_disabled(&config, "Context7").unwrap();
        assert_eq!(
            disabled.mcp_discovery.disabled_server_ids,
            vec!["context7".to_string()]
        );

        let enabled = mark_mcp_server_enabled(&disabled, "context7").unwrap();
        assert!(enabled.mcp_discovery.disabled_server_ids.is_empty());
    }
}
