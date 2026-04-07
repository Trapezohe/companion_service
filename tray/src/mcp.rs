use anyhow::{bail, Context, Result};
use companion_config::{
    load_config as load_runtime_config, mark_mcp_server_disabled, mark_mcp_server_enabled,
    remove_mcp_server_config, save_config as save_runtime_config, sync_discovered_mcp_servers,
    update_mcp_server_config, DiscoveredMcpServer as RuntimeDiscoveredMcpServer,
    McpServerConfig as RuntimeMcpServerConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{CompanionConfig, DiagnosticsSnapshot, StatusViewModel};

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoverySnapshot {
    pub connected_servers: u32,
    pub configured_servers: u32,
    pub total_tools: u32,
    #[serde(default)]
    pub configured: Vec<ConfiguredMcpServer>,
    #[serde(default)]
    pub discovered: Vec<DiscoveredMcpCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServer {
    pub name: String,
    pub status: String,
    pub tool_count: u32,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpCandidate {
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
    pub configured: bool,
    pub connected: bool,
}

#[derive(Debug, Clone)]
struct RawMcpCandidate {
    id: String,
    name: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: Option<String>,
    source: String,
}

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

pub fn build_snapshot(status: Option<&StatusViewModel>) -> Result<McpDiscoverySnapshot> {
    let runtime_config = load_runtime_config().unwrap_or_default();
    let diagnostics = status.and_then(|snapshot| snapshot.diagnostics.as_ref());

    let mut configured = runtime_config
        .mcp_servers
        .iter()
        .map(|(name, server)| {
            let runtime =
                diagnostics.and_then(|diag| find_runtime_server(diag, name, &server.command));
            ConfiguredMcpServer {
                name: name.clone(),
                status: runtime
                    .map(|item| item.status.clone())
                    .unwrap_or_else(|| "stopped".to_string()),
                tool_count: runtime.map(|item| item.tool_count).unwrap_or(0),
                command: server.command.clone(),
                args: server.args.clone(),
                connected: runtime
                    .map(|item| item.status.eq_ignore_ascii_case("connected"))
                    .unwrap_or(false),
            }
        })
        .collect::<Vec<_>>();
    configured.sort_by(|left, right| left.name.cmp(&right.name));

    let configured_by_name = runtime_config
        .mcp_servers
        .keys()
        .map(|name| normalize_server_name(name))
        .collect::<HashSet<_>>();
    let configured_by_command = runtime_config
        .mcp_servers
        .values()
        .map(|server| normalized_candidate_command_key(&server.command, &server.args))
        .collect::<HashSet<_>>();

    let mut discovered = discover_candidates()?
        .into_iter()
        .map(|candidate| {
            let runtime = diagnostics
                .and_then(|diag| find_runtime_server(diag, &candidate.name, &candidate.command));
            let configured_candidate = configured_by_name.contains(&candidate.id)
                || configured_by_command.contains(&normalized_candidate_command_key(
                    &candidate.command,
                    &candidate.args,
                ));
            DiscoveredMcpCandidate {
                id: candidate.id,
                name: candidate.name,
                command: candidate.command,
                args: candidate.args,
                env: candidate.env,
                cwd: candidate.cwd,
                source: candidate.source,
                configured: configured_candidate,
                connected: runtime
                    .map(|item| item.status.eq_ignore_ascii_case("connected"))
                    .unwrap_or(false),
            }
        })
        .collect::<Vec<_>>();
    discovered.sort_by(|left, right| left.name.cmp(&right.name));

    let (connected_servers, configured_servers, total_tools) = if let Some(diag) = diagnostics {
        (
            diag.connected_mcp_servers,
            diag.configured_mcp_servers,
            diag.total_mcp_tools,
        )
    } else {
        let connected = configured.iter().filter(|item| item.connected).count() as u32;
        let tools = configured.iter().map(|item| item.tool_count).sum::<u32>();
        (connected, configured.len() as u32, tools)
    };

    Ok(McpDiscoverySnapshot {
        connected_servers,
        configured_servers,
        total_tools,
        configured,
        discovered,
    })
}

pub async fn sync_discovered_servers(config: Option<&CompanionConfig>) -> Result<()> {
    let current = load_runtime_config()?;
    let result = sync_discovered_mcp_servers(&current)?;
    if !result.changed() {
        return Ok(());
    }

    save_runtime_config(&result.config)?;

    if let Some(config) = config {
        for candidate in &result.added_servers {
            let runtime_server = runtime_server_from_discovered(candidate);
            let _ = upsert_server_via_http(config, &candidate.id, &runtime_server).await;
        }
    }

    Ok(())
}

pub async fn enable_server(
    config: Option<&CompanionConfig>,
    name: &str,
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: Option<&str>,
) -> Result<()> {
    let server_name = preferred_server_name(name, command)?;
    let runtime_server = RuntimeMcpServerConfig {
        command: command.trim().to_string(),
        args: sanitize_args(args),
        env: sanitize_env(env),
        cwd: sanitize_optional_string(cwd),
        request_timeout_ms: Some(DEFAULT_REQUEST_TIMEOUT_MS),
        restartable: Some(true),
        write_capable: Some(false),
    };

    if let Some(config) = config {
        if upsert_server_via_http(config, &server_name, &runtime_server)
            .await
            .is_ok()
        {
            return Ok(());
        }
    }

    let current = load_runtime_config()?;
    let next = update_mcp_server_config(
        &mark_mcp_server_enabled(&current, &server_name)?,
        &server_name,
        &runtime_server,
    )?;
    save_runtime_config(&next)
}

pub async fn disable_server(config: Option<&CompanionConfig>, name: &str) -> Result<()> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        bail!("MCP server name is required.");
    }

    if let Some(config) = config {
        if delete_server_via_http(config, trimmed_name).await.is_ok() {
            return Ok(());
        }
    }

    let current = load_runtime_config()?;
    let (next, _) = remove_mcp_server_config(&current, trimmed_name)?;
    let next = mark_mcp_server_disabled(&next, trimmed_name)?;
    save_runtime_config(&next)
}

fn discover_candidates() -> Result<Vec<RawMcpCandidate>> {
    let mut discovered = Vec::new();

    append_unique_candidates(&mut discovered, discover_external_config_candidates()?);
    append_unique_candidates(&mut discovered, discover_path_candidates()?);

    Ok(discovered)
}

fn discover_path_candidates() -> Result<Vec<RawMcpCandidate>> {
    let path_var = env::var_os("PATH").unwrap_or_default();
    let directories = env::split_paths(&path_var).collect::<Vec<_>>();
    discover_path_candidates_from_dirs(&directories)
}

fn discover_path_candidates_from_dirs(directories: &[PathBuf]) -> Result<Vec<RawMcpCandidate>> {
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

            let id = normalize_server_name(file_name);
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }

            discovered.push(RawMcpCandidate {
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

fn discover_external_config_candidates() -> Result<Vec<RawMcpCandidate>> {
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
) -> Result<Vec<RawMcpCandidate>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("Failed to read {}", path.display()))
        }
    };

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

        discovered.push(RawMcpCandidate {
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

fn append_unique_candidates(target: &mut Vec<RawMcpCandidate>, candidates: Vec<RawMcpCandidate>) {
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

fn same_candidate(left: &RawMcpCandidate, right: &RawMcpCandidate) -> bool {
    left.id == right.id
        || normalized_candidate_command_key(&left.command, &left.args)
            == normalized_candidate_command_key(&right.command, &right.args)
}

fn should_replace_candidate(existing: &RawMcpCandidate, incoming: &RawMcpCandidate) -> bool {
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
    let normalized_name = normalize_server_name(name);
    if !normalized_name.is_empty() {
        return Ok(normalized_name);
    }

    let fallback = normalize_server_name(command);
    if !fallback.is_empty() {
        return Ok(fallback);
    }

    bail!("Unable to determine MCP server name.")
}

fn find_runtime_server<'a>(
    diagnostics: &'a DiagnosticsSnapshot,
    name: &str,
    command: &str,
) -> Option<&'a crate::models::McpServerSnapshot> {
    let normalized_name = normalize_server_name(name);
    let normalized_command = normalized_command_key(command);

    diagnostics.servers.iter().find(|server| {
        normalize_server_name(&server.name) == normalized_name
            || normalized_command_key(&server.command) == normalized_command
    })
}

fn normalize_server_name(value: &str) -> String {
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

fn runtime_server_from_discovered(
    candidate: &RuntimeDiscoveredMcpServer,
) -> RuntimeMcpServerConfig {
    RuntimeMcpServerConfig {
        command: candidate.command.trim().to_string(),
        args: sanitize_args(&candidate.args),
        env: sanitize_env(&candidate.env),
        cwd: sanitize_optional_string(candidate.cwd.as_deref()),
        request_timeout_ms: Some(DEFAULT_REQUEST_TIMEOUT_MS),
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

async fn upsert_server_via_http(
    config: &CompanionConfig,
    name: &str,
    server: &RuntimeMcpServerConfig,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    client
        .post(format!(
            "http://127.0.0.1:{}/api/mcp/servers/upsert",
            config.port
        ))
        .bearer_auth(&config.token)
        .json(&serde_json::json!({
            "name": name,
            "config": server,
        }))
        .send()
        .await?
        .error_for_status()
        .context("Failed to add MCP server via daemon API")?;
    Ok(())
}

async fn delete_server_via_http(config: &CompanionConfig, name: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    client
        .delete(format!(
            "http://127.0.0.1:{}/api/mcp/servers/{}",
            config.port, name
        ))
        .bearer_auth(&config.token)
        .send()
        .await?
        .error_for_status()
        .context("Failed to remove MCP server via daemon API")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn normalizes_server_name_from_paths_and_labels() {
        assert_eq!(
            normalize_server_name("chrome-devtools-mcp"),
            "chrome-devtools-mcp"
        );
        assert_eq!(
            normalize_server_name("/tmp/Chrome DevTools MCP"),
            "chrome-devtools-mcp"
        );
        assert_eq!(normalize_server_name(""), "");
    }

    #[test]
    fn detects_mcp_like_binary_names() {
        assert!(looks_like_mcp_command("chrome-devtools"));
        assert!(looks_like_mcp_command("filesystem-mcp"));
        assert!(!looks_like_mcp_command("google-chrome"));
        assert!(!looks_like_mcp_command("trapezohe-companion"));
    }

    #[test]
    fn detects_mcp_server_from_config_command_and_args() {
        assert!(looks_like_mcp_server_definition(
            "codex",
            "/tmp/codex",
            &["mcp-server".to_string()]
        ));
        assert!(looks_like_mcp_server_definition(
            "Playwright MCP",
            "npx",
            &["@playwright/mcp@latest".to_string()]
        ));
        assert!(!looks_like_mcp_server_definition(
            "node",
            "node",
            &["server.js".to_string()]
        ));
    }

    #[test]
    fn discovers_external_mcp_servers_from_config_file() {
        let dir = tempdir().expect("temp dir");
        let config_path = dir.path().join("mcp.json");
        fs::write(
            &config_path,
            r#"{
              "mcpServers": {
                "Context7": {
                  "command": "npx",
                  "args": ["-y", "@upstash/context7-mcp"],
                  "env": {
                    "DEFAULT_MINIMUM_TOKENS": "${DEFAULT_MINIMUM_TOKENS}"
                  }
                },
                "codex": {
                  "command": "/tmp/codex",
                  "args": ["mcp-server"]
                }
              }
            }"#,
        )
        .expect("write config");

        let candidates =
            discover_external_config_candidates_from_path(&config_path, "claude-config")
                .expect("discover config candidates");

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].name, "Context7");
        assert_eq!(candidates[0].command, "npx");
        assert_eq!(
            candidates[0].args,
            vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]
        );
        assert_eq!(
            candidates[0]
                .env
                .get("DEFAULT_MINIMUM_TOKENS")
                .map(String::as_str),
            Some("${DEFAULT_MINIMUM_TOKENS}")
        );
        assert_eq!(candidates[1].id, "codex");
    }

    #[test]
    fn prefers_config_candidate_over_bare_path_candidate() {
        let mut merged = Vec::new();
        append_unique_candidates(
            &mut merged,
            vec![RawMcpCandidate {
                id: "codex".to_string(),
                name: "codex".to_string(),
                command: "/tmp/codex".to_string(),
                args: vec!["mcp-server".to_string()],
                env: BTreeMap::from([("A".to_string(), "1".to_string())]),
                cwd: None,
                source: "claude-config".to_string(),
            }],
        );
        append_unique_candidates(
            &mut merged,
            vec![RawMcpCandidate {
                id: "codex".to_string(),
                name: "codex".to_string(),
                command: "/tmp/codex".to_string(),
                args: vec!["mcp-server".to_string()],
                env: BTreeMap::new(),
                cwd: None,
                source: "path".to_string(),
            }],
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].env.get("A").map(String::as_str), Some("1"));
        assert_eq!(merged[0].source, "claude-config");
    }

    #[cfg(unix)]
    #[test]
    fn discovers_executables_from_path_directories() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("temp dir");
        let script_path = dir.path().join("filesystem-mcp");
        let mut file = fs::File::create(&script_path).expect("create fake executable");
        writeln!(file, "#!/bin/sh").expect("write executable");
        writeln!(file, "exit 0").expect("write executable");
        let mut perms = file.metadata().expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");

        let candidates =
            discover_path_candidates_from_dirs(&[dir.path().to_path_buf()]).expect("discover");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "filesystem-mcp");
        assert_eq!(candidates[0].name, "filesystem-mcp");
        assert!(candidates[0].args.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn discovers_codex_binary_as_mcp_server() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("temp dir");
        let script_path = dir.path().join("codex");
        let mut file = fs::File::create(&script_path).expect("create fake executable");
        writeln!(file, "#!/bin/sh").expect("write executable");
        writeln!(file, "exit 0").expect("write executable");
        let mut perms = file.metadata().expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");

        let candidates =
            discover_path_candidates_from_dirs(&[dir.path().to_path_buf()]).expect("discover");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "codex");
        assert_eq!(candidates[0].args, vec!["mcp-server".to_string()]);
    }
}
