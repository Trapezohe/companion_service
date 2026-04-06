import type { DisplayLanguage } from '@/types/companion'

type TranslationTable = Record<string, string>

const en: TranslationTable = {
  // ─── Brand ───
  brandTitle: 'Companion',
  brandSubtitle: 'Local bridge for the browser extension',

  // ─── Navigation ───
  navOverview: 'Overview',
  navPermissions: 'Permissions & Safety',
  navLogs: 'Plugin Activity',
  navSettings: 'Settings',

  // ─── Update ───
  checkUpdates: 'Check Updates',
  installNow: 'Install Now',
  downloading: 'Downloading...',
  installing: 'Installing...',
  retryUpdate: 'Retry Update',
  upToDate: 'You are on the latest version.',
  updateReady: 'A newer version is ready. Use the button above to install it.',
  updateBusy: 'Update is being downloaded and installed.',
  updateFailed: 'Update failed. You can retry here or open the release page from Settings.',
  updateManualInstall: 'Automatic updates are unavailable for this copy. Open the release page and install the latest package.',
  latestVersion: 'Latest: v{version}',
  currentVersion: 'Current: v{version}',

  // ─── Status ───
  statusHeading: 'Service Status',
  statusHealthy: 'Healthy',
  statusChecking: 'Checking',
  statusStopped: 'Stopped',
  statusDegraded: 'Needs Attention',
  statusMisconfigured: 'Setup Needed',
  serviceHealthyDetail: 'Local companion is reachable and ready for plugin requests.',
  serviceCheckingDetail: 'Checking the local runtime and refreshing current status.',
  serviceStoppedDetail: 'The companion service is not running yet.',
  pid: 'PID',
  approvals: 'Approvals',
  updated: 'Updated',
  autostart: 'Autostart',
  on: 'On',
  off: 'Off',

  // ─── MCP ───
  mcpHeading: 'MCP Services',
  mcpSummary: '{connected} online / {tools} tools',
  noMcp: 'No MCP service data yet.',
  serverConnected: 'Connected',
  serverIdle: 'Idle',
  serverStarting: 'Starting',
  serverDisconnected: 'Disconnected',
  serverError: 'Error',
  serverStopped: 'Stopped',
  serverUnknown: 'Unknown',
  toolCount: '{count} tools',

  // ─── Activity ───
  activityHeading: 'Plugin Activity',
  activitySubtitle: 'Recent actions requested by the browser extension',
  noActivity: 'No recent plugin actions yet.',
  showLogs: 'All Logs',
  justNow: 'Just now',
  minutesAgo: '{count}m ago',
  hoursAgo: '{count}h ago',
  statusSuccess: 'Success',
  statusFailed: 'Failed',
  statusPendingApproval: 'Pending Approval',
  statusRunning: 'Running',
  statusCancelled: 'Cancelled',
  statusUnknown: 'Unknown',

  // ─── Actions ───
  restart: 'Restart',
  start: 'Start',
  refresh: 'Refresh',

  // ─── Settings ───
  settings: 'Settings',
  settingsTitle: 'Panel Settings',
  languageLabel: 'Language',
  languageEnglish: 'English',
  languageEnglishHelp: 'Default',
  languageChinese: '中文',
  languageChineseHelp: 'Simplified Chinese',
  disableAutostart: 'Disable Autostart',
  enableAutostart: 'Enable Autostart',
  openLogsFolder: 'Open Logs Folder',
  stopService: 'Stop Service',
  quit: 'Quit Companion',
  quitShort: 'Quit',
  releaseFallback: 'Open release page',
  versionFooter: 'Version v{version}',
  footer: 'Click outside to close',

  // ─── Permissions ───
  permissionsHeading: 'Permissions & Safety',
  permissionsSummary: '{enabled} enabled · {attention} need attention',
  permHighRiskOff: '{count} high-risk capabilities off',
  systemPermissionsGroup: 'System Permissions',
  highRiskGroup: 'High-Risk Capabilities',

  // System permission items
  permScreenRecording: 'Screen Recording',
  permScreenRecordingDesc: 'Allows capturing screen content for visual context.',
  permAccessibility: 'Accessibility',
  permAccessibilityDesc: 'Allows reading and interacting with UI elements.',
  permAutomation: 'Automation',
  permAutomationDesc: 'Allows controlling other applications via scripting.',
  permCamera: 'Camera',
  permCameraDesc: 'Allows accessing the camera for visual input.',
  permMicrophone: 'Microphone',
  permMicrophoneDesc: 'Allows accessing the microphone for audio input.',
  permLocation: 'Location',
  permLocationDesc: 'Allows accessing device location information.',
  permNotifications: 'Notifications',
  permNotificationsDesc: 'Allows sending system notifications.',

  // High-risk capability items
  permLocalCommand: 'Local Command Execution',
  permLocalCommandDesc: 'Can execute local commands and scripts. May modify files, read environment, or start processes.',
  permBrowserControl: 'Browser Control / UI Automation',
  permBrowserControlDesc: 'Can control browsers, click elements, type text, and read page information.',
  permAdminAction: 'Administrator Actions',
  permAdminActionDesc: 'Sensitive operations requiring elevated system privileges. Each action requires individual confirmation.',

  // Permission states
  systemAuthorized: 'System Authorized',
  systemNotAuthorized: 'System Not Authorized',
  platformNotSupported: 'Platform Not Supported',
  systemImplicitlyAllowed: 'System Default Allowed',
  companionEnabled: 'Companion Enabled',
  companionDisabled: 'Companion Disabled',
  highRisk: 'High Risk',
  defaultOff: 'Default Off',
  perActionConfirm: 'Confirm Each Time',
  needsAuth: 'Authorize',

  // Permission detail
  permDetailWhat: 'What does this do?',
  permDetailSystemStatus: 'System Status',
  permDetailCompanionStatus: 'Companion Status',
  permDetailWhenEnabled: 'What happens when enabled?',
  permDetailGoToSettings: 'Open System Settings',
  permDetailViewLogs: 'View Related Logs',

  // Risk confirm dialog
  riskConfirmTitle: 'Enable High-Risk Capability',
  riskConfirmBody: 'You are about to enable a high-risk capability. Actions will be logged.',
  riskConfirmCancel: 'Cancel',
  riskConfirmEnable: 'Confirm Enable',

  // Admin action confirm dialog
  adminConfirmTitle: 'Administrator Action Confirmation',
  adminConfirmAction: 'Action to execute:',
  adminConfirmTrigger: 'Triggered by:',
  adminConfirmReason: 'Why admin privileges are needed:',
  adminConfirmImpact: 'Impact scope:',
  adminConfirmCancel: 'Cancel',
  adminConfirmContinue: 'Continue',

  // Action log statuses
  logStatusExecuted: 'Executed',
  logStatusWaitingConfirm: 'Waiting Confirm',
  logStatusPermissionBlocked: 'Permission Blocked',
  logStatusSystemNotAuthorized: 'System Not Authorized',
  logStatusUserCancelled: 'User Cancelled',
  logStatusFailed: 'Failed',

  // Log filters
  logFilterAll: 'All',
  logFilterBlocked: 'Blocked',
  logFilterFailed: 'Failed',
  logNoEntries: 'No plugin action logs yet.',
  logEmptyHint: 'Logs will appear here when the browser extension requests actions through companion.',
}

const zh: TranslationTable = {
  // ─── Brand ───
  brandTitle: 'Companion',
  brandSubtitle: '浏览器插件使用的本地桥接服务',

  // ─── Navigation ───
  navOverview: '概览',
  navPermissions: '权限与安全',
  navLogs: '插件动作日志',
  navSettings: '设置',

  // ─── Update ───
  checkUpdates: '检查更新',
  installNow: '立即安装',
  downloading: '下载中...',
  installing: '安装中...',
  retryUpdate: '重试更新',
  upToDate: '当前已经是最新版本。',
  updateReady: '发现新版本，点击上方按钮可直接安装。',
  updateBusy: '更新正在下载并安装。',
  updateFailed: '更新失败，你可以在这里重试，或去设置里打开发布页。',
  updateManualInstall: '当前这份应用不支持自动更新。请打开发布页并安装最新安装包。',
  latestVersion: '最新：v{version}',
  currentVersion: '当前：v{version}',

  // ─── Status ───
  statusHeading: '运行状态',
  statusHealthy: '正常',
  statusChecking: '检查中',
  statusStopped: '已停止',
  statusDegraded: '需注意',
  statusMisconfigured: '需设置',
  serviceHealthyDetail: '本地 companion 已就绪，可以响应插件请求。',
  serviceCheckingDetail: '正在检查本地运行状态并刷新当前信息。',
  serviceStoppedDetail: 'companion 服务当前还没有运行。',
  pid: 'PID',
  approvals: '审批',
  updated: '更新时间',
  autostart: '开机启动',
  on: '开',
  off: '关',

  // ─── MCP ───
  mcpHeading: 'MCP 服务',
  mcpSummary: '{connected} 在线 / {tools} 个工具',
  noMcp: '暂时还没有 MCP 服务信息。',
  serverConnected: '已连接',
  serverIdle: '空闲',
  serverStarting: '启动中',
  serverDisconnected: '已断开',
  serverError: '错误',
  serverStopped: '已停止',
  serverUnknown: '未知',
  toolCount: '{count} 个工具',

  // ─── Activity ───
  activityHeading: '插件动作日志',
  activitySubtitle: '这里显示插件请求 companion 执行的最近动作',
  noActivity: '最近还没有插件动作记录。',
  showLogs: '全部日志',
  justNow: '刚刚',
  minutesAgo: '{count} 分钟前',
  hoursAgo: '{count} 小时前',
  statusSuccess: '成功',
  statusFailed: '失败',
  statusPendingApproval: '审批中',
  statusRunning: '执行中',
  statusCancelled: '已取消',
  statusUnknown: '未知',

  // ─── Actions ───
  restart: '重启',
  start: '启动',
  refresh: '刷新',

  // ─── Settings ───
  settings: '设置',
  settingsTitle: '面板设置',
  languageLabel: '语言',
  languageEnglish: 'English',
  languageEnglishHelp: '默认',
  languageChinese: '中文',
  languageChineseHelp: '简体中文',
  disableAutostart: '关闭开机启动',
  enableAutostart: '开启开机启动',
  openLogsFolder: '打开日志文件夹',
  stopService: '停止服务',
  quit: '退出 Companion',
  quitShort: '退出',
  releaseFallback: '打开发布页',
  versionFooter: '版本 v{version}',
  footer: '点面板外即可关闭',

  // ─── Permissions ───
  permissionsHeading: '权限与安全',
  permissionsSummary: '{enabled} 已启用 · {attention} 须处理',
  permHighRiskOff: '{count} 项高风险能力已关闭',
  systemPermissionsGroup: '系统权限',
  highRiskGroup: '高风险能力',

  // System permission items
  permScreenRecording: '屏幕录制',
  permScreenRecordingDesc: '允许捕获屏幕内容以提供视觉上下文。',
  permAccessibility: '辅助功能',
  permAccessibilityDesc: '允许读取和操作界面元素。',
  permAutomation: '自动化',
  permAutomationDesc: '允许通过脚本控制其他应用程序。',
  permCamera: '相机',
  permCameraDesc: '允许访问相机获取视觉输入。',
  permMicrophone: '麦克风',
  permMicrophoneDesc: '允许访问麦克风获取音频输入。',
  permLocation: '定位',
  permLocationDesc: '允许获取设备位置信息。',
  permNotifications: '通知',
  permNotificationsDesc: '允许发送系统通知。',

  // High-risk capability items
  permLocalCommand: '本地命令执行',
  permLocalCommandDesc: '能执行本地命令和脚本。可能修改文件、读取环境、启动进程。',
  permBrowserControl: '浏览器控制 / UI 自动化',
  permBrowserControlDesc: '能控制浏览器、点击元素、输入内容、读取页面信息。',
  permAdminAction: '管理员动作',
  permAdminActionDesc: '涉及更高系统权限的敏感操作。每次执行均需单独确认。',

  // Permission states
  systemAuthorized: '系统已授权',
  systemNotAuthorized: '系统未授权',
  platformNotSupported: '当前平台不支持',
  systemImplicitlyAllowed: '系统默认允许',
  companionEnabled: 'Companion 已开启',
  companionDisabled: 'Companion 已关闭',
  highRisk: '高风险',
  defaultOff: '默认关闭',
  perActionConfirm: '每次都确认',
  needsAuth: '去授权',

  // Permission detail
  permDetailWhat: '这项能力是做什么的？',
  permDetailSystemStatus: '系统状态',
  permDetailCompanionStatus: 'Companion 状态',
  permDetailWhenEnabled: '打开后会发生什么？',
  permDetailGoToSettings: '前往系统设置',
  permDetailViewLogs: '查看相关日志',

  // Risk confirm dialog
  riskConfirmTitle: '启用高风险能力',
  riskConfirmBody: '你即将启用一项高风险能力。所有使用记录将被写入日志。',
  riskConfirmCancel: '取消',
  riskConfirmEnable: '确认启用',

  // Admin action confirm dialog
  adminConfirmTitle: '管理员动作确认',
  adminConfirmAction: '要执行的操作：',
  adminConfirmTrigger: '触发来源：',
  adminConfirmReason: '为什么需要管理员权限：',
  adminConfirmImpact: '影响范围：',
  adminConfirmCancel: '取消',
  adminConfirmContinue: '继续执行',

  // Action log statuses
  logStatusExecuted: '已执行',
  logStatusWaitingConfirm: '等待确认',
  logStatusPermissionBlocked: '被权限拦截',
  logStatusSystemNotAuthorized: '系统未授权',
  logStatusUserCancelled: '用户取消',
  logStatusFailed: '执行失败',

  // Log filters
  logFilterAll: '全部',
  logFilterBlocked: '被拦截',
  logFilterFailed: '失败',
  logNoEntries: '最近还没有插件动作记录。',
  logEmptyHint: '当浏览器插件请求 companion 执行动作时，日志将显示在这里。',
}

const tables: Record<DisplayLanguage, TranslationTable> = { en, zh }

export function t(
  key: string,
  language: DisplayLanguage,
  vars?: Record<string, string | number>,
): string {
  let value = tables[language]?.[key] ?? tables.en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${k}}`, String(v))
    }
  }
  return value
}
