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

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/trapezohe/companion/main/install.ps1 | iex
```

### Manual Install (npm)

```bash
npm install -g trapezohe-companion
trapezohe-companion init
trapezohe-companion start
```

### Connect to Extension

1. Start the companion: `trapezohe-companion start`
2. Copy the access token shown in the terminal
3. In the Trapezohe extension: **Settings → Local Command Runtime**
4. Enter URL: `http://127.0.0.1:8791`
5. Paste the token
6. Enable and save

## Configuration

Config file: `~/.trapezohe/companion.json`

```json
{
  "port": 8791,
  "token": "your-access-token",
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
trapezohe-companion status      # Show status and MCP server info
trapezohe-companion init        # Create default config
trapezohe-companion config      # Print config file path
trapezohe-companion token       # Print access token
```

## API Endpoints

All endpoints require `Authorization: Bearer <token>` header and only accept connections from localhost.

### Health Check

```
GET /healthz
→ { "ok": true, "version": "0.1.0", "mcpServers": 2, "mcpTools": 5 }
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
- Trapezohe Chrome Extension v0.1.0+

## License

MIT
