use anyhow::{anyhow, bail, Context, Result};
use companion_config::{CompanionConfig, McpServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, RwLock};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

#[cfg(target_os = "windows")]
fn suppress_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn suppress_console_window(_command: &mut Command) {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusView {
    pub name: String,
    pub status: String,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    pub command: String,
    pub args: Vec<String>,
    pub request_timeout_ms: u64,
    pub failure_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<u64>,
    pub restartable: bool,
    pub restart_pending: bool,
    pub write_capable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<Value>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpManager {
    inner: Arc<RwLock<HashMap<String, Arc<ServerEntry>>>>,
}

#[derive(Debug)]
struct ServerEntry {
    name: String,
    state: Mutex<ServerState>,
}

#[derive(Debug)]
struct ServerState {
    config: McpServerConfig,
    status: String,
    transport: Option<Arc<TransportHandle>>,
    tools: Vec<ToolDescriptor>,
    error: Option<String>,
    started_at: Option<u64>,
    failure_count: u32,
    last_failure_at: Option<u64>,
    next_retry_at: Option<u64>,
    restart_pending: bool,
    write_capable: bool,
}

#[derive(Debug, Clone)]
struct ToolDescriptor {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug)]
struct TransportHandle {
    stdin: Mutex<tokio::process::ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: Mutex<u64>,
    request_timeout_ms: u64,
    stderr: Arc<Mutex<String>>,
}

#[derive(Debug, Deserialize)]
struct InitializeResult {
    #[serde(rename = "capabilities", default)]
    _capabilities: Value,
}

#[derive(Debug, Deserialize)]
struct ToolsListResult {
    #[serde(default)]
    tools: Vec<RemoteTool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTool {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_input_schema")]
    input_schema: Value,
}

fn default_input_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

impl McpManager {
    pub fn from_config(config: &CompanionConfig) -> Self {
        let mut entries = HashMap::new();
        for (name, server_config) in &config.mcp_servers {
            entries.insert(
                name.clone(),
                Arc::new(ServerEntry {
                    name: name.clone(),
                    state: Mutex::new(ServerState {
                        config: server_config.clone(),
                        status: "stopped".to_string(),
                        transport: None,
                        tools: Vec::new(),
                        error: None,
                        started_at: None,
                        failure_count: 0,
                        last_failure_at: None,
                        next_retry_at: None,
                        restart_pending: false,
                        write_capable: server_config.write_capable.unwrap_or(false),
                    }),
                }),
            );
        }
        Self {
            inner: Arc::new(RwLock::new(entries)),
        }
    }

    pub async fn start_all(&self) {
        let names = self.inner.read().await.keys().cloned().collect::<Vec<_>>();
        for name in names {
            let _ = self.start_server(&name).await;
        }
    }

    pub async fn stop_all(&self) {
        let names = self.inner.read().await.keys().cloned().collect::<Vec<_>>();
        for name in names {
            let _ = self.stop_server(&name).await;
        }
    }

    pub async fn start_server(&self, name: &str) -> Result<()> {
        let entry = self
            .inner
            .read()
            .await
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow!("Unknown MCP server: {name}"))?;

        let config = {
            let mut state = entry.state.lock().await;
            if state.status == "connected" {
                return Ok(());
            }
            state.status = "starting".to_string();
            state.error = None;
            state.tools.clear();
            state.config.clone()
        };

        let mut command = Command::new(config.command.clone());
        command.args(config.args.clone());
        if let Some(cwd) = &config.cwd {
            command.current_dir(cwd);
        }
        if !config.env.is_empty() {
            command.envs(config.env.clone());
        }
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        suppress_console_window(&mut command);

        #[cfg(unix)]
        {
            use nix::libc;
            unsafe {
                command.pre_exec(|| {
                    let result = libc::setpgid(0, 0);
                    if result == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::last_os_error())
                    }
                });
            }
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("Failed to start MCP server: {}", config.command))?;
        let stdin = child.stdin.take().context("MCP server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("MCP server stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("MCP server stderr unavailable")?;
        let stderr_buffer = Arc::new(Mutex::new(String::new()));
        let transport = Arc::new(TransportHandle {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            request_timeout_ms: config.request_timeout_ms.unwrap_or(120_000),
            stderr: stderr_buffer.clone(),
        });

        spawn_stdout_reader(transport.clone(), stdout, entry.clone());
        spawn_stderr_reader(stderr_buffer, stderr);

        let initialize = transport
            .request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "trapezohe-companion",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
            )
            .await?;
        let _init: InitializeResult = serde_json::from_value(initialize)
            .context("Failed to parse MCP initialize response")?;

        let _ = transport
            .notify("notifications/initialized", json!({}))
            .await;

        let tools = match transport.request("tools/list", json!({})).await {
            Ok(value) => {
                let result: ToolsListResult =
                    serde_json::from_value(value).context("Failed to parse MCP tools list")?;
                result
                    .tools
                    .into_iter()
                    .map(|tool| ToolDescriptor {
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.input_schema,
                    })
                    .collect::<Vec<_>>()
            }
            Err(error) => {
                tracing::warn!("MCP tools/list failed for {name}: {error}");
                Vec::new()
            }
        };

        let mut state = entry.state.lock().await;
        state.transport = Some(transport);
        state.status = "connected".to_string();
        state.started_at = Some(now_millis());
        state.failure_count = 0;
        state.last_failure_at = None;
        state.next_retry_at = None;
        state.restart_pending = false;
        state.write_capable = resolve_write_capable(&state.config, &tools);
        state.tools = tools;
        Ok(())
    }

    pub async fn stop_server(&self, name: &str) -> Result<()> {
        let entry = self
            .inner
            .read()
            .await
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow!("Unknown MCP server: {name}"))?;
        let transport = {
            let mut state = entry.state.lock().await;
            state.status = "stopped".to_string();
            state.error = None;
            state.tools.clear();
            state.started_at = None;
            state.restart_pending = false;
            state.next_retry_at = None;
            state.transport.take()
        };
        if let Some(transport) = transport {
            transport.close().await;
        }
        Ok(())
    }

    pub async fn restart_server(&self, name: &str) -> Result<()> {
        let _ = self.stop_server(name).await;
        self.start_server(name).await
    }

    pub async fn get_servers(&self) -> Vec<ServerStatusView> {
        let entries = self
            .inner
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        for entry in entries {
            let state = entry.state.lock().await;
            result.push(ServerStatusView {
                name: entry.name.clone(),
                status: state.status.clone(),
                tool_count: state.tools.len(),
                error: state.error.clone(),
                started_at: state.started_at,
                command: state.config.command.clone(),
                args: state.config.args.clone(),
                request_timeout_ms: state.config.request_timeout_ms.unwrap_or(120_000),
                failure_count: state.failure_count,
                last_failure_at: state.last_failure_at,
                next_retry_at: state.next_retry_at,
                restartable: state.config.restartable.unwrap_or(true),
                restart_pending: state.restart_pending,
                write_capable: state.write_capable,
            });
        }
        result
    }

    pub async fn get_all_tools(&self) -> Vec<ListedTool> {
        let entries = self
            .inner
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        for entry in entries {
            let state = entry.state.lock().await;
            if state.status != "connected" {
                continue;
            }
            for tool in &state.tools {
                result.push(ListedTool {
                    server: entry.name.clone(),
                    name: tool.name.clone(),
                    description: tool.description.clone(),
                    input_schema: tool.input_schema.clone(),
                });
            }
        }
        result
    }

    pub async fn get_connected_count(&self) -> usize {
        let entries = self
            .inner
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut count = 0;
        for entry in entries {
            let state = entry.state.lock().await;
            if state.status == "connected" {
                count += 1;
            }
        }
        count
    }

    pub async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: Value,
    ) -> ToolCallResult {
        let entry = match self.resolve_server_entry(server_name).await {
            Some(entry) => entry,
            None => {
                return ToolCallResult {
                    ok: false,
                    content: Vec::new(),
                    is_error: false,
                    error: Some(format!("Unknown MCP server: {server_name}")),
                }
            }
        };

        let transport = {
            let state = entry.state.lock().await;
            let tool_exists = state.tools.iter().any(|tool| tool.name == tool_name);
            if !tool_exists {
                return ToolCallResult {
                    ok: false,
                    content: Vec::new(),
                    is_error: false,
                    error: Some(format!(
                        "Tool \"{tool_name}\" not found on server \"{}\"",
                        entry.name
                    )),
                };
            }
            match state.transport.clone() {
                Some(transport) if state.status == "connected" => transport,
                _ => {
                    return ToolCallResult {
                        ok: false,
                        content: Vec::new(),
                        is_error: false,
                        error: Some(format!(
                            "MCP server \"{}\" is not connected (status: {})",
                            entry.name, state.status
                        )),
                    };
                }
            }
        };

        match transport
            .request(
                "tools/call",
                json!({
                    "name": tool_name,
                    "arguments": args,
                }),
            )
            .await
        {
            Ok(value) => ToolCallResult {
                ok: !value
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                content: value
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                is_error: value
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                error: None,
            },
            Err(error) => ToolCallResult {
                ok: false,
                content: Vec::new(),
                is_error: false,
                error: Some(error.to_string()),
            },
        }
    }

    pub async fn upsert_server(
        &self,
        name: &str,
        config: McpServerConfig,
        start: bool,
    ) -> Result<()> {
        let server_name = name.trim();
        if server_name.is_empty() {
            bail!("MCP server name is required.");
        }
        let normalized = companion_config::normalize_mcp_server_config(&config)?;
        let entry = {
            let mut inner = self.inner.write().await;
            inner
                .entry(server_name.to_string())
                .or_insert_with(|| {
                    Arc::new(ServerEntry {
                        name: server_name.to_string(),
                        state: Mutex::new(ServerState {
                            config: normalized.clone(),
                            status: "stopped".to_string(),
                            transport: None,
                            tools: Vec::new(),
                            error: None,
                            started_at: None,
                            failure_count: 0,
                            last_failure_at: None,
                            next_retry_at: None,
                            restart_pending: false,
                            write_capable: normalized.write_capable.unwrap_or(false),
                        }),
                    })
                })
                .clone()
        };
        let mut state = entry.state.lock().await;
        state.config = normalized.clone();
        state.write_capable = normalized.write_capable.unwrap_or(false);
        drop(state);
        if start {
            self.restart_server(server_name).await?;
        }
        Ok(())
    }

    pub async fn delete_server(&self, name: &str) -> Result<bool> {
        let server_name = name.trim();
        if server_name.is_empty() {
            bail!("MCP server name is required.");
        }
        let removed = self.inner.write().await.remove(server_name);
        if let Some(entry) = removed {
            if let Some(transport) = entry.state.lock().await.transport.take() {
                transport.close().await;
            }
            return Ok(true);
        }
        Ok(false)
    }

    async fn resolve_server_entry(&self, server_name: &str) -> Option<Arc<ServerEntry>> {
        let requested = server_name.trim();
        if requested.is_empty() {
            return None;
        }
        let inner = self.inner.read().await;
        if let Some(exact) = inner.get(requested) {
            return Some(exact.clone());
        }
        let normalized = normalize_server_name(requested);
        let base = server_base_name(requested);
        let mut candidates = Vec::new();
        for entry in inner.values() {
            let entry_normalized = normalize_server_name(&entry.name);
            if entry_normalized == normalized
                || server_base_name(&entry.name) == base
                || entry_normalized == format!("{base}-mcp")
            {
                candidates.push(entry.clone());
            }
        }
        if candidates.len() == 1 {
            return Some(candidates.remove(0));
        }
        None
    }
}

impl TransportHandle {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let request_id = {
            let mut next = self.next_id.lock().await;
            let current = *next;
            *next += 1;
            current
        };
        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id, tx);
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(payload.to_string().as_bytes())
                .await
                .context("Failed to write MCP request")?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
        }
        let response = tokio::time::timeout(Duration::from_millis(self.request_timeout_ms), rx)
            .await
            .map_err(|_| {
                anyhow!(
                    "MCP request timed out after {}ms: {method}",
                    self.request_timeout_ms
                )
            })?
            .map_err(|_| anyhow!("MCP request channel closed: {method}"))?;
        let value = response.map_err(|error| anyhow!(error))?;
        Ok(value)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(payload.to_string().as_bytes())
            .await
            .context("Failed to write MCP notification")?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn close(&self) {
        {
            let mut pending = self.pending.lock().await;
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Transport closed".to_string()));
            }
        }
        let mut child = self.child.lock().await;
        let _ = terminate_child(&mut child).await;
    }
}

fn spawn_stdout_reader(
    transport: Arc<TransportHandle>,
    stdout: ChildStdout,
    entry: Arc<ServerEntry>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed = match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if let Some(id) = parsed.get("id").and_then(Value::as_u64) {
                if let Some(sender) = transport.pending.lock().await.remove(&id) {
                    if let Some(error) = parsed.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("MCP request failed")
                            .to_string();
                        let _ = sender.send(Err(message));
                    } else {
                        let _ =
                            sender.send(Ok(parsed.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
        }

        let stderr = transport.stderr.lock().await.clone();
        {
            let mut pending = transport.pending.lock().await;
            for (_, sender) in pending.drain() {
                let message = if stderr.trim().is_empty() {
                    "MCP server process exited".to_string()
                } else {
                    format!("MCP server process exited: {}", stderr.trim())
                };
                let _ = sender.send(Err(message));
            }
        }

        let mut state = entry.state.lock().await;
        if state.status != "stopped" {
            state.status = "disconnected".to_string();
            state.error = if stderr.trim().is_empty() {
                Some("MCP server process exited".to_string())
            } else {
                Some(format!("MCP server process exited: {}", stderr.trim()))
            };
            state.started_at = None;
            state.tools.clear();
            state.failure_count = state.failure_count.saturating_add(1);
            state.last_failure_at = Some(now_millis());
        }
    });
}

fn spawn_stderr_reader(buffer: Arc<Mutex<String>>, mut stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        let content = String::from_utf8_lossy(&bytes).to_string();
        let mut current = buffer.lock().await;
        *current = if content.len() > 10_000 {
            content[content.len() - 10_000..].to_string()
        } else {
            content
        };
    });
}

async fn terminate_child(child: &mut Child) -> Result<()> {
    let Some(pid) = child.id() else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGTERM)
            .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGTERM));
        tokio::time::sleep(Duration::from_millis(200)).await;
        if child.try_wait()?.is_none() {
            let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL)
                .or_else(|_| kill(Pid::from_raw(pid as i32), Signal::SIGKILL));
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .await;
    }
    let _ = child.wait().await;
    Ok(())
}

fn normalize_server_name(input: &str) -> String {
    input.trim().to_lowercase()
}

fn server_base_name(input: &str) -> String {
    let normalized = normalize_server_name(input);
    normalized
        .strip_suffix("-mcp")
        .unwrap_or(&normalized)
        .to_string()
}

fn resolve_write_capable(config: &McpServerConfig, tools: &[ToolDescriptor]) -> bool {
    if let Some(value) = config.write_capable {
        return value;
    }
    tools.iter().any(|tool| {
        let name = tool.name.to_lowercase();
        [
            "write", "edit", "delete", "remove", "create", "update", "run", "execute",
        ]
        .iter()
        .any(|needle| name.contains(needle))
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use companion_config::CompanionConfig;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use tokio::fs;

    async fn create_fake_mcp_server(dir: &TempDir) -> PathBuf {
        let script = dir.path().join("fake-mcp-server.mjs");
        let source = r#"
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) handle(JSON.parse(line))
    newlineIndex = buffer.indexOf('\n')
  }
})

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } })
    return
  }
  if (message.method === 'tools/list') {
    respond(message.id, { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] })
    return
  }
  if (message.method === 'tools/call') {
    respond(message.id, { isError: false, content: [{ type: 'text', text: String(message.params?.arguments?.value || '') }] })
  }
}
"#;
        fs::write(&script, source.as_bytes()).await.unwrap();
        script
    }

    #[tokio::test]
    async fn manager_starts_server_and_calls_tool() {
        let dir = TempDir::new().unwrap();
        let script = create_fake_mcp_server(&dir).await;
        let mut config = CompanionConfig::default();
        config.mcp_servers.insert(
            "fake".to_string(),
            McpServerConfig {
                command: std::env::var("NODE").unwrap_or_else(|_| "node".to_string()),
                args: vec![script.to_string_lossy().to_string()],
                env: BTreeMap::new(),
                cwd: None,
                request_timeout_ms: Some(5_000),
                restartable: Some(true),
                write_capable: Some(false),
            },
        );
        let manager = McpManager::from_config(&config);
        manager.start_server("fake").await.unwrap();

        let servers = manager.get_servers().await;
        assert_eq!(servers[0].status, "connected");
        let tools = manager.get_all_tools().await;
        assert_eq!(tools.len(), 1);
        let result = manager
            .call_tool("fake", "echo", json!({ "value": "hello" }))
            .await;
        assert!(result.ok);
        assert_eq!(
            result.content[0].get("text").and_then(Value::as_str),
            Some("hello")
        );
        manager.stop_all().await;
    }
}
