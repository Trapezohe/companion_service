export type Lang = "en" | "zh";

const en = {
  // CompanionPanel footer
  footer: "Click outside to close",

  // HomePage
  appSubtitle: "Local bridge service for browser extension",
  statusOnline: "Service Running",
  statusOffline: "Offline",
  statusError: "Error",
  statusChecking: "Checking…",
  port: "Port",
  daemonReady: "Local companion is ready to handle extension requests.",
  daemonStopped: "Local companion is not running right now.",
  daemonChecking: "Checking local companion status.",
  daemonNeedsAttention: "Local companion needs attention before it can serve requests.",
  pid: "PID",
  approvals: "Approvals",
  updatedAt: "Updated",
  justNow: "Just now",
  updateAvailable: (v: string) => `New version ${v} available`,
  updateNow: "Update Now",
  mcpServices: "MCP Services",
  mcpOnline: "online",
  mcpTools: "tools",
  connected: "Connected",
  mcpManageTitle: "MCP Services",
  mcpSummary: (connected: number, configured: number, tools: number) =>
    `${connected} connected · ${configured} configured · ${tools} tools`,
  mcpDetectedHint: (count: number) =>
    count > 0 ? `${count} MCP services or configs were found on this machine.` : "No runnable MCP service or saved MCP config was found on this machine.",
  mcpDetectedAllEnabled: "All discovered MCP services are already enabled.",
  mcpConfiguredSection: "Configured",
  mcpDetectedSection: "Discovered",
  mcpConfiguredEmpty: "No MCP service has been enabled yet.",
  mcpDetectedEmpty: "No runnable MCP service or saved MCP config was found.",
  mcpMore: (count: number) => `+${count} more`,
  mcpServerMeta: (tools: number, status: string) => `${tools} tools · ${status}`,
  mcpSourceLabel: (source: string) =>
    `Source: ${
      source === "path"
        ? "PATH"
        : source === "claude-config"
          ? "Claude config"
          : source === "alma-config"
            ? "Alma config"
            : source
    }`,
  mcpAddAction: "Enable",
  mcpRemoveAction: "Remove",
  mcpWorking: "Working…",
  permissionsTitle: "Permissions & Security",
  permissionsSubtitle: (enabled: number, review: number) =>
    `${enabled} enabled · ${review} to review`,
  logsTitle: "Extension Action Logs",
  logsNoRecent: "No recent extension actions.",
  settingsTitle: "Settings",
  version: "Version",

  // PermissionsPage
  enabledBadge: (enabled: number, review: number) =>
    `${enabled} enabled · ${review} to review`,
  highRiskBadge: (count: number) => `${count} high-risk capabilities disabled`,
  systemPermissions: "System Permissions",
  highRiskCapabilities: "High-Risk Capabilities",
  // Permission entries
  screenCapture: "Screen Recording",
  screenCaptureDesc:
    "Allows capturing screen content for visual context.",
  accessibility: "Accessibility",
  accessibilityDesc: "Allows reading and manipulating UI elements.",
  automation: "Automation",
  automationDesc: "Allows controlling other apps via scripts.",
  camera: "Camera",
  cameraDesc: "Allows camera access for visual input.",
  microphone: "Microphone",
  microphoneDesc: "Allows microphone access for audio input.",
  location: "Location",
  locationDesc: "Allows accessing device location.",
  notification: "Notifications",
  notificationDesc: "Allows sending system notifications.",
  localCommand: "Local Command Execution",
  localCommandDesc:
    "Can execute local commands and scripts. May modify files, read environment, launch processes.",
  browserControl: "Browser Control / UI Automation",
  browserControlDesc:
    "Can control browser, click elements, type content, read page info.",
  adminAction: "Admin Actions",
  adminActionDesc:
    "Sensitive operations requiring elevated system permissions. Requires confirmation for each execution.",
  // ToggleRow badges
  systemAuthorized: "System Authorized",
  systemUnauthorized: "System Unauthorized",
  companionOpen: "Companion Enabled",
  companionClosed: "Companion Disabled",
  highRisk: "High Risk",
  requireConfirm: "Confirm Each Time",

  // LogsPage
  tabAll: "All",
  tabBlocked: "Blocked",
  tabFailed: "Failed",
  logsEmpty: "No recent extension actions.",
  logsEmptyHint:
    "When the browser extension requests the companion to perform actions, logs will appear here.",

  // SettingsPage
  language: "Language",
  englishSubLabel: "Default",
  chineseSubLabel: "Simplified Chinese",
  checkUpdateAction: "Check for Updates",
  restartService: "Restart Service",
  disableAutostart: "Disable Auto-start",
  openLogsFolder: "Open Logs Folder",
  openReleasePage: "Open Releases Page",
  stopService: "Stop Service",
  quitCompanion: "Quit Companion",
};

const zh: typeof en = {
  footer: "点面板外即可关闭",

  appSubtitle: "浏览器插件使用的本地桥接服务",
  statusOnline: "服务运行中",
  statusOffline: "离线",
  statusError: "错误",
  statusChecking: "检查中…",
  port: "端口",
  daemonReady: "本地 companion 已就绪，可以响应插件请求。",
  daemonStopped: "本地 companion 当前没有运行。",
  daemonChecking: "正在检查本地 companion 状态。",
  daemonNeedsAttention: "本地 companion 当前需要处理后才能继续提供服务。",
  pid: "PID",
  approvals: "审批",
  updatedAt: "更新时间",
  justNow: "刚刚",
  updateAvailable: (v: string) => `发现新版本 ${v}`,
  updateNow: "立即更新",
  mcpServices: "MCP 服务",
  mcpOnline: "在线",
  mcpTools: "个工具",
  connected: "已连接",
  mcpManageTitle: "MCP 服务",
  mcpSummary: (connected: number, configured: number, tools: number) =>
    `${connected} 个已连接 · ${configured} 个已配置 · ${tools} 个工具`,
  mcpDetectedHint: (count: number) =>
    count > 0 ? `本机发现 ${count} 个可用的 MCP 服务或 MCP 配置。` : "本机暂未发现可用的 MCP 服务或已保存的 MCP 配置。",
  mcpDetectedAllEnabled: "本机发现到的 MCP 都已经开启了。",
  mcpConfiguredSection: "已配置",
  mcpDetectedSection: "本机发现",
  mcpConfiguredEmpty: "当前还没有启用任何 MCP 服务。",
  mcpDetectedEmpty: "当前没有发现可用的 MCP 服务或已保存的 MCP 配置。",
  mcpMore: (count: number) => `还有 ${count} 个`,
  mcpServerMeta: (tools: number, status: string) => `${tools} 个工具 · ${status}`,
  mcpSourceLabel: (source: string) =>
    `来源：${
      source === "path"
        ? "PATH"
        : source === "claude-config"
          ? "Claude 配置"
          : source === "alma-config"
            ? "Alma 配置"
            : source
    }`,
  mcpAddAction: "启用",
  mcpRemoveAction: "移除",
  mcpWorking: "处理中…",
  permissionsTitle: "权限与安全",
  permissionsSubtitle: (enabled: number, review: number) =>
    `${enabled} 已启用 · ${review} 须处理`,
  logsTitle: "插件动作日志",
  logsNoRecent: "最近还没有插件动作记录。",
  settingsTitle: "设置",
  version: "版本",

  enabledBadge: (enabled: number, review: number) =>
    `${enabled} 已启用 · ${review} 须处理`,
  highRiskBadge: (count: number) => `${count} 项高风险能力已关闭`,
  systemPermissions: "系统权限",
  highRiskCapabilities: "高风险能力",
  screenCapture: "屏幕录制",
  screenCaptureDesc: "允许捕获屏幕内容以提供视觉上下文。",
  accessibility: "辅助功能",
  accessibilityDesc: "允许读取和操作界面元素。",
  automation: "自动化",
  automationDesc: "允许通过脚本控制其他应用程序。",
  camera: "相机",
  cameraDesc: "允许访问相机获取视觉输入。",
  microphone: "麦克风",
  microphoneDesc: "允许访问麦克风获取音频输入。",
  location: "定位",
  locationDesc: "允许获取设备位置信息。",
  notification: "通知",
  notificationDesc: "允许发送系统通知。",
  localCommand: "本地命令执行",
  localCommandDesc:
    "能执行本地命令和脚本。可能修改文件、读取环境、启动进程。",
  browserControl: "浏览器控制 / UI 自动化",
  browserControlDesc:
    "能控制浏览器、点击元素、输入内容、读取页面信息。",
  adminAction: "管理员动作",
  adminActionDesc:
    "涉及更高系统权限的敏感操作。每次执行均需单独确认。",
  systemAuthorized: "系统已授权",
  systemUnauthorized: "系统未授权",
  companionOpen: "Companion 已开启",
  companionClosed: "Companion 已关闭",
  highRisk: "高风险",
  requireConfirm: "每次都确认",

  tabAll: "全部",
  tabBlocked: "被拦截",
  tabFailed: "失败",
  logsEmpty: "最近没有插件动作记录。",
  logsEmptyHint:
    "当浏览器插件请求 companion 执行动作时，日志将显示在这里。",

  language: "语言",
  englishSubLabel: "默认",
  chineseSubLabel: "简体中文",
  checkUpdateAction: "检查更新",
  restartService: "重启服务",
  disableAutostart: "关闭开机启动",
  openLogsFolder: "打开日志文件夹",
  openReleasePage: "打开发布页",
  stopService: "停止服务",
  quitCompanion: "退出 Companion",
};

const translations: Record<Lang, typeof en> = { en, zh };

export function useT(lang: Lang): typeof en {
  return translations[lang];
}
