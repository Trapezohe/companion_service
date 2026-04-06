import { useStatus } from '@/hooks/use-status'
import { useUIStore, type LogFilter } from '@/stores/ui-store'
import { t } from '@/i18n/translations'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ActionLogEntry, DisplayLanguage } from '@/types/companion'

const FILTER_OPTIONS: { value: LogFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'logFilterAll' },
  { value: 'blocked', labelKey: 'logFilterBlocked' },
  { value: 'failed', labelKey: 'logFilterFailed' },
]

function actionStatusVariant(status: string) {
  if (status === 'success') return 'healthy' as const
  if (status === 'pending_approval' || status === 'running') return 'warning' as const
  if (status === 'permission_blocked') return 'warning' as const
  if (status === 'failed' || status === 'cancelled') return 'error' as const
  return 'muted' as const
}

function localizedActionStatus(status: string, lang: DisplayLanguage) {
  const map: Record<string, string> = {
    success: t('statusSuccess', lang),
    failed: t('statusFailed', lang),
    pending_approval: t('statusPendingApproval', lang),
    permission_blocked: t('logStatusPermissionBlocked', lang),
    running: t('statusRunning', lang),
    cancelled: t('statusCancelled', lang),
  }
  return map[status] ?? t('statusUnknown', lang)
}

function formatRelativeTime(ts: number, lang: DisplayLanguage): string {
  if (!ts) return t('justNow', lang)
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60_000) return t('justNow', lang)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('minutesAgo', lang, { count: minutes })
  return t('hoursAgo', lang, { count: Math.floor(minutes / 60) })
}

function capabilityLabel(entry: ActionLogEntry, lang: DisplayLanguage) {
  const map: Record<string, string> = {
    screen_recording: t('permScreenRecording', lang),
    accessibility: t('permAccessibility', lang),
    automation: t('permAutomation', lang),
    camera: t('permCamera', lang),
    microphone: t('permMicrophone', lang),
    location: t('permLocation', lang),
    notifications: t('permNotifications', lang),
    local_command: t('permLocalCommand', lang),
    browser_control: t('permBrowserControl', lang),
    admin_action: t('permAdminAction', lang),
  }
  return map[entry.permissionId || entry.capability] ?? ''
}

function sourceLabel(source: string, lang: DisplayLanguage) {
  const map: Record<string, string> = {
    extension: t('logSourceExtension', lang),
    automation: t('logSourceAutomation', lang),
    replay: t('logSourceReplay', lang),
    acp: t('logSourceAcp', lang),
    remote: t('logSourceExtension', lang),
    unknown: t('logSourceUnknown', lang),
  }
  return map[source] ?? source
}

function matchesFilter(entry: ActionLogEntry, filter: LogFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'blocked') return entry.status === 'permission_blocked' || entry.status === 'cancelled'
  if (filter === 'failed') return entry.status === 'failed'
  return true
}

export function ActionLogList() {
  const { data: status } = useStatus()
  const logFilter = useUIStore((s) => s.logFilter)
  const logPermissionId = useUIStore((s) => s.logPermissionId)
  const setLogFilter = useUIStore((s) => s.setLogFilter)
  const setLogPermission = useUIStore((s) => s.setLogPermission)

  if (!status) return null

  const lang = status.language ?? 'en'
  const allLogs = status.diagnostics?.action_logs ?? []
  const filteredLogs = allLogs.filter((log) => {
    if (!matchesFilter(log, logFilter)) return false
    if (!logPermissionId) return true
    return log.permissionId === logPermissionId || log.capability === logPermissionId
  })
  const activePermissionLabel = (() => {
    if (!logPermissionId) return ''
    return capabilityLabel(
      {
        runId: '',
        timestamp: 0,
        actionName: '',
        source: '',
        capability: logPermissionId,
        permissionId: logPermissionId,
        target: '',
        status: 'success',
        detail: '',
      },
      lang,
    )
  })()

  return (
    <div className="flex flex-col">
      {/* Filter tabs */}
      <div className="flex gap-1 px-3.5 py-2 border-b border-[var(--color-line)]">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setLogFilter(opt.value)}
            className={cn(
              'px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer',
              logFilter === opt.value
                ? 'bg-[var(--color-surface-2)] text-[var(--color-foreground-primary)]'
                : 'text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]',
            )}
          >
            {t(opt.labelKey, lang)}
          </button>
        ))}
      </div>

      {logPermissionId && (
        <div className="px-3.5 py-2 border-b border-[var(--color-line)] flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] text-[var(--color-foreground-muted)]">
              {t('logPermissionFilterLabel', lang)}
            </div>
            <div className="text-xs font-medium text-[var(--color-foreground-primary)] truncate">
              {activePermissionLabel || logPermissionId}
            </div>
          </div>
          <button
            onClick={() => setLogPermission(null)}
            className="text-[11px] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground-primary)] transition-colors cursor-pointer"
          >
            {t('clearFilter', lang)}
          </button>
        </div>
      )}

      {/* Log list */}
      {filteredLogs.length === 0 ? (
        <div className="px-3.5 py-8 text-center">
          <div className="text-xs text-[var(--color-foreground-muted)]">
            {logPermissionId ? t('logNoRelatedEntries', lang) : t('logNoEntries', lang)}
          </div>
          <div className="text-[11px] text-[var(--color-foreground-soft)] mt-1">
            {logPermissionId ? t('logRelatedEmptyHint', lang) : t('logEmptyHint', lang)}
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {filteredLogs.map((log, idx) => (
            <div
              key={log.runId || idx}
              className="flex flex-col gap-1 px-3.5 py-2 border-t border-[var(--color-line)] first:border-t-0"
            >
              <div className="flex justify-between text-[10px] text-[var(--color-foreground-muted)]">
                <span>{formatRelativeTime(log.timestamp, lang)}</span>
                <Badge variant={actionStatusVariant(log.status)} className="text-[10px] px-1.5 py-0">
                  {localizedActionStatus(log.status, lang)}
                </Badge>
              </div>
              <div className="text-xs font-medium text-[var(--color-foreground-primary)]">
                {log.actionName}
              </div>
              {(log.source || log.permissionId || log.capability) && (
                <div className="flex flex-wrap items-center gap-1">
                  {log.source && (
                    <Badge variant="muted" className="text-[10px] px-1.5 py-0">
                      {sourceLabel(log.source, lang)}
                    </Badge>
                  )}
                  {(log.permissionId || log.capability) && (
                    <Badge variant="info" className="text-[10px] px-1.5 py-0">
                      {capabilityLabel(log, lang) || log.permissionId || log.capability}
                    </Badge>
                  )}
                </div>
              )}
              {log.target && (
                <div className="text-[11px] text-[var(--color-foreground-muted)] truncate">
                  {log.target}
                </div>
              )}
              {log.detail && (
                <div className="text-[11px] text-[var(--color-foreground-muted)]">
                  {log.detail}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
