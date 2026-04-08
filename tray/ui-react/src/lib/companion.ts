import type { Lang } from "./translations";

export interface UpdateInfo {
  available: boolean;
  can_install: boolean;
  current_version: string;
  latest_version: string;
  release_url: string;
  status: string;
  downloaded_bytes?: number;
  total_bytes?: number | null;
  last_error?: string | null;
}

export interface ShellState {
  kind: "checking" | "healthy" | "degraded" | "stopped" | "misconfigured";
  version?: string;
  protocol_version?: string | null;
  pid?: number;
  mcp_servers?: number;
  mcp_tools?: number;
  reason?: string;
}

export interface HealthSnapshot {
  pid: number;
  version: string;
  protocol_version?: string | null;
  mcp_servers: number;
  mcp_tools: number;
}

export interface McpRuntimeServer {
  name: string;
  status: string;
  tool_count: number;
  command: string;
}

export interface ActionLogEntry {
  run_id: string;
  timestamp: number;
  action_name: string;
  source: string;
  capability: string;
  permission_id: string;
  target: string;
  status: string;
  detail: string;
}

export interface DiagnosticsSnapshot {
  connected_mcp_servers: number;
  configured_mcp_servers: number;
  total_mcp_tools: number;
  running_acp_sessions: number;
  idle_acp_sessions: number;
  pending_approvals: number;
  servers: McpRuntimeServer[];
  action_logs: ActionLogEntry[];
}

export interface StatusSnapshot {
  language: Lang;
  endpoint: string;
  state: ShellState;
  checked_at_ms?: number;
  health?: HealthSnapshot;
  diagnostics?: DiagnosticsSnapshot;
  update?: UpdateInfo;
}

export interface ConfiguredMcpServer {
  name: string;
  status: string;
  toolCount: number;
  command: string;
  args: string[];
  connected: boolean;
}

export interface DiscoveredMcpCandidate {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  source: string;
  configured: boolean;
  connected: boolean;
}

export interface McpDiscoverySnapshot {
  connectedServers: number;
  configuredServers: number;
  totalTools: number;
  configured: ConfiguredMcpServer[];
  discovered: DiscoveredMcpCandidate[];
}

export type PermissionGroup = "system" | "application" | "high_risk";

export type SystemAuthStatus =
  | "authorized"
  | "not_authorized"
  | "not_supported"
  | "implicitly_allowed"
  | "unknown";

export interface PermissionItem {
  id: string;
  group: PermissionGroup;
  title_key: string;
  description_key: string;
  system_auth: SystemAuthStatus;
  companion_enabled: boolean;
  is_high_risk: boolean;
  requires_per_action_confirm: boolean;
  platform_supported: boolean;
}

export interface PermissionsSnapshot {
  items: PermissionItem[];
}
