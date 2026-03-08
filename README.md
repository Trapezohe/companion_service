# Trapezohe Companion

Local companion daemon for the [Trapezohe AI](https://github.com/trapezohe/trapezohe) Chrome extension — hosts MCP servers and provides a command execution runtime.

## What It Does

The Trapezohe Chrome extension has limited capabilities due to browser sandbox restrictions. The Companion runs on your local machine and provides:

- **MCP Server Host** — Spawn and manage [Model Context Protocol](https://modelcontextprotocol.io/) servers (Tavily search, filesystem access, databases, etc.)
- **Command Runtime** — Execute shell commands on your machine (with user confirmation in the extension)
- **Tool Bridge** — Exposes all MCP tools to the extension via a local HTTP API

## Quick Start

### One-Click Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/trapezohe/companion/main/install.sh | bash
```

Non-interactive (one command, no prompts — replace `<your-extension-id>` with your actual extension ID from `chrome://extensions/`):

```bash
curl -fsSL https://raw.githubusercontent.com/trapezohe/companion/main/install.sh | bash -s -- --non-interactive --ext-id <your-extension-id> --mode workspace --workspace ~/trapezohe-workspace
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/trapezohe/companion/main/install.ps1 | iex
```

Non-interactive (replace `<your-extension-id>` with your actual extension ID):

```powershell
irm https://raw.githubusercontent.com/trapezohe/companion/main/install.ps1 | iex -- --non-interactive --ext-id <your-extension-id> --mode workspace --workspace "$HOME\\trapezohe-workspace"
```

### Installer Packages (No Terminal Flow)

You can also install from GitHub Releases:

- macOS: `trapezohe-companion-macos.pkg`
- Windows: `trapezohe-companion-windows.msi`
- Integrity file: `SHA256SUMS.txt`

Latest release page:

```text
https://github.com/trapezohe/companion/releases/latest
```

Recommended verification before running installers:

macOS:

```bash
shasum -a 256 ./trapezohe-companion-macos.pkg
```

Windows (PowerShell):

```powershell
Get-FileHash .\trapezohe-companion-windows.msi -Algorithm SHA256
```

Compare the command output with `SHA256SUMS.txt`.

Both installers now ship the local daemon and the desktop tray panel together. The desktop tray panel is installed together with the daemon as the default local control surface:

- the tray is installed as a real app / executable, not a separate public portable download
- the tray becomes the single desktop login item
- on sign-in, the tray checks daemon state and starts the local runtime if policy allows it

> Note: unsigned installers can trigger OS trust warnings (Gatekeeper / SmartScreen). This is expected for unsigned builds; verify checksum first, then proceed only if you trust the release source.

Installers attempt a best-effort bootstrap automatically. If Node.js is missing or bootstrap fails, package installation still succeeds so users can retry from extension **Settings → Companion**. The tray startup policy is still written so ordinary users can reopen the panel and retry local runtime setup without touching Terminal.
- macOS installer log: `/Users/Shared/trapezohe-companion-installer.log`
- Windows installer log: `%ProgramData%\\TrapezoheCompanion\\installer.log`

### Manual Install (npm)

```bash
npm install -g trapezohe-companion
trapezohe-companion bootstrap --ext-id <your-extension-id>
```

> **Where to find your extension ID:** Open `chrome://extensions/`, find "Trapezohe AI" and copy the ID string (e.g. `abcdefghijklmnopqrstuvwxyz123456`). The extension's **Settings → Companion** page also shows a ready-to-copy install command with the ID pre-filled.

The `bootstrap` command handles everything: creates config, registers the Chrome Native Messaging host for auto-pairing, and starts the daemon.

If you prefer step-by-step:

```bash
npm install -g trapezohe-companion
trapezohe-companion init                           # Create config
trapezohe-companion register <your-extension-id>   # Register native messaging host
trapezohe-companion start                          # Start the daemon
```

### Connect to Extension

**Automatic (recommended):** If you used `bootstrap` or `register` with your extension ID, the extension auto-discovers the companion via Chrome Native Messaging — no manual config needed.

**Manual fallback:**
1. Start the companion: `trapezohe-companion start`
2. Copy the access token: `trapezohe-companion token`
3. In the Trapezohe extension: **Settings → Companion**
4. Enter URL: `http://127.0.0.1:41591`
5. Paste the token
6. Enable and save

## Configuration

Config file: `~/.trapezohe/companion.json`

```json
{
  "port": 41591,
  "token": "your-access-token",
  "permissionPolicy": {
    "mode": "workspace",
    "workspaceRoots": ["/Users/me/trapezohe-workspace"]
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/documents"]
    },
    "tavily-search": {
      "command": "npx",
      "args": ["-y", "@anthropic/tavily-mcp-server"],
      "env": {
        "TAVILY_API_KEY": "tvly-xxxxx"
      }
    }
  }
}
```

### Permission Modes

- `workspace` (recommended): command runtime is restricted to configured `workspaceRoots`; requests outside the boundary are blocked.
- `full`: no workspace boundary checks (OpenClaw-like full system control with current user permissions).

The `mcpServers` format is compatible with [Claude Desktop](https://modelcontextprotocol.io/quickstart/user) — you can reuse your existing MCP server configurations.

### MCP Server Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Command to launch the MCP server |
| `args` | string[] | Command arguments |
| `env` | object | Additional environment variables |
| `cwd` | string | Working directory (optional) |

## CLI Commands

```bash
trapezohe-companion start       # Start in foreground
trapezohe-companion start -d    # Start as background daemon
trapezohe-companion stop        # Stop the daemon
trapezohe-companion stop --force # Force stop (SIGKILL fallback)
trapezohe-companion status      # Show status and MCP server info
trapezohe-companion init        # Create default config
trapezohe-companion config      # Print config file path
trapezohe-companion token       # Print access token
trapezohe-companion policy      # Show current permission policy
trapezohe-companion policy full
trapezohe-companion policy workspace ~/trapezohe-workspace
trapezohe-companion self-check  # Run local diagnostics + suggested repairs
trapezohe-companion repair repair_config
trapezohe-companion repair register_native_host --ext-id abc123
trapezohe-companion bootstrap --ext-id abc123 --mode workspace --workspace ~/trapezohe-workspace
```

## Diagnostics and Repair

The Companion now exposes a built-in self-check and a small repair loop for the most common local failures:

```bash
trapezohe-companion self-check
trapezohe-companion self-check --json
trapezohe-companion repair repair_config
trapezohe-companion repair register_native_host --ext-id <your-extension-id>
```

What these do:

- `self-check` validates config readability, token presence, workspace policy, native host registration, and configured MCP executable availability.
- `repair repair_config` rewrites missing config defaults while preserving MCP server config and saved extension IDs where possible.
- `repair register_native_host` re-registers the Chrome native messaging manifest for the provided extension ID(s) or the IDs already saved in config.

## API Endpoints

All endpoints require `Authorization: Bearer <token>` header and only accept connections from localhost.

### Health Check

```
GET /healthz
→ { "ok": true, "pid": 12345, "version": "0.1.1", "mcpServers": 2, "mcpTools": 5, "permissionPolicy": { ... } }
```

### Diagnostics / Repair

```
GET /api/system/diagnostics
→ structured MCP / ACP / runs / approvals diagnostics payload

GET /api/system/self-check
→ { "ok": true, "checks": { ... }, "repairActions": [...] }

POST /api/system/repair
Body: { "action": "repair_config" }
→ { "ok": true, "action": "repair_config", "selfCheck": { ... } }
```

### Command Execution

```
POST /api/runtime/exec
Body: { "command": "echo hello", "cwd": "/tmp", "timeoutMs": 30000 }
→ { "ok": true, "stdout": "hello\n", "stderr": "", "exitCode": 0, ... }
```

### MCP Tools

```
GET /api/mcp/tools
→ { "tools": [{ "server": "filesystem", "name": "read_file", "description": "...", "inputSchema": {...} }] }

POST /api/mcp/tools/call
Body: { "server": "filesystem", "tool": "read_file", "arguments": { "path": "/tmp/test.txt" } }
→ { "ok": true, "content": [{ "type": "text", "text": "file contents..." }] }
```

### MCP Servers

```
GET /api/mcp/servers
→ { "servers": [{ "name": "filesystem", "status": "connected", "toolCount": 5 }] }

POST /api/mcp/servers/{name}/restart
→ { "ok": true, "name": "filesystem" }
```

### Permission Policy

```
GET /api/security/policy
→ { "policy": { "mode": "workspace", "workspaceRoots": ["/Users/me/trapezohe-workspace"] } }

POST /api/security/policy
Body: { "mode": "full" }
→ { "ok": true, "policy": { "mode": "full", "workspaceRoots": [] } }
```

## Popular MCP Servers

| Server | Install | Description |
|--------|---------|-------------|
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem /path` | Read/write files |
| Brave Search | `npx -y @anthropic/brave-search-mcp-server` | Web search |
| GitHub | `npx -y @modelcontextprotocol/server-github` | GitHub API |
| PostgreSQL | `npx -y @modelcontextprotocol/server-postgres` | Database queries |
| Puppeteer | `npx -y @anthropic/puppeteer-mcp-server` | Browser automation |

Find more at [MCP Servers Directory](https://github.com/modelcontextprotocol/servers).

## Security

- **Loopback only**: The server only accepts connections from `127.0.0.1` / `::1`
- **Token auth**: Every request requires a Bearer token
- **User permissions**: MCP server processes run with your user permissions
- **Extension confirmation**: High-risk commands require user confirmation in the extension UI

## Requirements

- Node.js 18+
- Trapezohe Chrome Extension v0.1.1+

## License

MIT
