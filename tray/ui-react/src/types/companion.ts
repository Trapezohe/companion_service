// ─── Types mirroring Rust models (tray/src/models.rs) ───

export type DisplayLanguage = 'en' | 'zh'

export interface CompanionShellState {
  kind: 'checking' | 'healthy' | 'degraded' | 'stopped' | 'misconfigured'
  version?: string
  protocol_version?: string
  pid?: number
  mcp_servers?: number
  mcp_tools?: number
  reason?: string
}

export interface HealthSnapshot {
  pid: number
  version: string
  protocol_version?: string
  mcp_servers: number
  mcp_tools: number
}

export interface McpServerSnapshot {
  name: string
  status: string
  tool_count: number
  command: string
}

export interface ActionLogEntry {
  runId: string
  timestamp: number
  actionName: string
  source: string
  capability: string
  permissionId: string
  target: string
  status: string
  detail: string
}

export interface RecentFailure {
  run_id: string
  summary: string
  error: string
}

export interface DiagnosticsSnapshot {
  connected_mcp_servers: number
  configured_mcp_servers: number
  total_mcp_tools: number
  running_acp_sessions: number
  idle_acp_sessions: number
  pending_approvals: number
  recent_failures: RecentFailure[]
  servers: McpServerSnapshot[]
  action_logs: ActionLogEntry[]
}

export interface RepairAction {
  id: string
  title: string
  description: string
}

export interface SelfCheckSnapshot {
  ok: boolean
  failing_checks: string[]
  repair_actions: RepairAction[]
}

export interface AutoStartStatus {
  enabled: boolean
  strategy: string
  target: string
  launches: string
}

export interface StartupContextView {
  launch_source: string
  phase: string
  note: string
}

export interface UpdateInfo {
  available: boolean
  can_install: boolean
  current_version: string
  latest_version: string
  release_url: string
  download_url?: string
  release_notes?: string
  checked_at_ms: number
  status: string
  downloaded_bytes: number
  total_bytes?: number
  last_error?: string
}

export interface StatusActions {
  can_start: boolean
  can_stop: boolean
  can_restart: boolean
  can_open_logs: boolean
  can_run_self_check: boolean
  can_toggle_autostart: boolean
}

export interface StatusViewModel {
  language: DisplayLanguage
  state: CompanionShellState
  config_path: string
  logs_dir: string
  endpoint: string
  checked_at_ms: number
  last_error?: string
  health?: HealthSnapshot
  diagnostics?: DiagnosticsSnapshot
  self_check?: SelfCheckSnapshot
  autostart?: AutoStartStatus
  startup?: StartupContextView
  update?: UpdateInfo
  actions: StatusActions
}

// ─── Permission types (new, mirroring tray/src/permissions.rs) ───

export type PermissionGroup = 'system' | 'high_risk'

export type SystemAuthStatus =
  | 'authorized'
  | 'not_authorized'
  | 'not_supported'
  | 'implicitly_allowed'

export interface PermissionItem {
  id: string
  group: PermissionGroup
  title_key: string
  description_key: string
  system_auth: SystemAuthStatus
  companion_enabled: boolean
  is_high_risk: boolean
  requires_per_action_confirm: boolean
  platform_supported: boolean
}

export interface PermissionsSnapshot {
  items: PermissionItem[]
}

export type PluginActionLogStatus =
  | 'executed'
  | 'waiting_confirm'
  | 'permission_blocked'
  | 'system_not_authorized'
  | 'user_cancelled'
  | 'failed'

export interface PluginActionLogEntry {
  id: string
  timestamp: number
  source: string
  capability: string
  status: PluginActionLogStatus
  reason: string
}

export interface AdminActionConfirmPayload {
  action_id: string
  action_name: string
  trigger: string
  reason: string
  impact: string
}
