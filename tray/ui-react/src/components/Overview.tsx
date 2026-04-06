import { useStatus, useCheckUpdate, useInstallUpdate, useRunRepair, useRunSelfCheck, useStartService, useRestartService } from '@/hooks/use-status'
import { usePermissions } from '@/hooks/use-status'
import { useUIStore } from '@/stores/ui-store'
import { t } from '@/i18n/translations'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NavRow } from '@/components/PanelShell'
import { RotateCw, Settings, Shield, ScrollText } from 'lucide-react'
import type { RepairAction, StatusViewModel, DisplayLanguage } from '@/types/companion'

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-[var(--color-foreground-soft)]">{label}</span>
      <span className="text-[11px] font-medium text-[var(--color-foreground-muted)]">{value}</span>
    </div>
  )
}

function statusLabel(kind: string, lang: DisplayLanguage) {
  const map: Record<string, string> = {
    healthy: t('statusHealthy', lang),
    checking: t('statusChecking', lang),
    stopped: t('statusStopped', lang),
    degraded: t('statusDegraded', lang),
    misconfigured: t('statusMisconfigured', lang),
  }
  return map[kind] ?? t('statusChecking', lang)
}

function statusDescription(snapshot: StatusViewModel, lang: DisplayLanguage): string {
  const kind = snapshot.state.kind
  if (kind === 'healthy') return t('serviceHealthyDetail', lang)
  if (kind === 'checking') return t('serviceCheckingDetail', lang)
  if (kind === 'stopped') return t('serviceStoppedDetail', lang)
  return snapshot.state.reason ?? snapshot.last_error ?? ''
}

function formatRelativeTime(ts: number, lang: DisplayLanguage): string {
  if (!ts) return t('justNow', lang)
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60_000) return t('justNow', lang)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('minutesAgo', lang, { count: minutes })
  return t('hoursAgo', lang, { count: Math.floor(minutes / 60) })
}

function isVersionNewer(latest: string, current: string): boolean {
  if (!latest || !current) return false
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((p) => Number(p || 0))
  const left = parse(latest)
  const right = parse(current)
  const size = Math.max(left.length, right.length)
  for (let i = 0; i < size; i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

function humanizeCheckName(value: string, lang: DisplayLanguage): string {
  const normalized = value.trim()
  if (!normalized) return t('selfCheckIssueGeneric', lang)
  const pretty = normalized.replaceAll(/[_-]+/g, ' ').trim()
  return pretty.charAt(0).toUpperCase() + pretty.slice(1)
}

function requiresAdminConfirm(action: RepairAction): boolean {
  return action.id === 'register_native_host'
}

export function Overview() {
  const { data: status } = useStatus()
  const { data: perms } = usePermissions()
  const checkUpdate = useCheckUpdate()
  const installUpdate = useInstallUpdate()
  const runSelfCheck = useRunSelfCheck()
  const runRepair = useRunRepair()
  const startService = useStartService()
  const restartService = useRestartService()
  const busy = useUIStore((s) => s.busy)
  const showAdminConfirm = useUIStore((s) => s.showAdminConfirm)

  if (!status) return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <div className="w-5 h-5 border-2 border-[var(--color-status-blue)] border-l-transparent rounded-full animate-spin" />
      <span className="text-xs text-[var(--color-foreground-muted)]">Loading…</span>
    </div>
  )

  const lang = status.language ?? 'en'
  const kind = status.state.kind
  const update = status.update
  const updateNote = (() => {
    if (!update) return ''
    if (update.status === 'downloading' || update.status === 'installing' || update.status === 'installed') {
      return t('updateBusy', lang)
    }
    if (update.status === 'error') {
      return t('updateFailed', lang)
    }
    if (update.available && isVersionNewer(update.latest_version, update.current_version)) {
      if (update.can_install) return t('updateReady', lang)
      return t('updateManualInstall', lang)
    }
    return ''
  })()

  // Update button model
  const updateModel = (() => {
    if (!update) return { cmd: 'check', label: t('checkUpdates', lang), variant: 'secondary' as const, disabled: busy }
    if (update.status === 'downloading') return { cmd: null, label: t('downloading', lang), variant: 'secondary' as const, disabled: true }
    if (update.status === 'installing' || update.status === 'installed') return { cmd: null, label: t('installing', lang), variant: 'secondary' as const, disabled: true }
    if (update.status === 'error') return { cmd: 'check', label: t('retryUpdate', lang), variant: 'secondary' as const, disabled: busy }
    if (update.available && update.can_install && isVersionNewer(update.latest_version, update.current_version)) {
      return { cmd: 'install', label: t('installNow', lang), variant: 'default' as const, disabled: busy }
    }
    return { cmd: 'check', label: t('checkUpdates', lang), variant: 'secondary' as const, disabled: busy }
  })()

  const handleUpdate = () => {
    if (updateModel.cmd === 'install') installUpdate.mutate()
    else if (updateModel.cmd === 'check') checkUpdate.mutate()
  }

  // Permission summary
  const enabledCount = perms?.items.filter((p) => p.companion_enabled).length ?? 0
  const attentionCount = perms?.items.filter((p) => !p.companion_enabled && p.platform_supported && p.system_auth === 'not_authorized').length ?? 0

  // Action logs
  const logs = status.diagnostics?.action_logs ?? []
  const recentLogCount = logs.length
  const selfCheck = status.self_check
  const repairActions = selfCheck?.repair_actions ?? []
  const failingChecks = selfCheck?.failing_checks ?? []

  const openRepairAction = (action: RepairAction) => {
    if (requiresAdminConfirm(action)) {
      showAdminConfirm({
        action_id: action.id,
        action_name: action.title,
        trigger: t('adminTriggerPanel', lang),
        reason: t('repairReasonRegisterNativeHost', lang),
        impact: t('repairImpactRegisterNativeHost', lang),
      })
      return
    }
    runRepair.mutate(action.id)
  }

  return (
    <div className="flex flex-col py-2">
      {/* ── Status hero ── */}
      <section className="px-4 py-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            {/* Status dot */}
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center shrink-0',
              kind === 'healthy' && 'bg-[var(--color-status-green-soft)]',
              kind === 'checking' && 'bg-[var(--color-status-yellow-soft)]',
              kind === 'degraded' && 'bg-[var(--color-status-yellow-soft)]',
              (kind === 'stopped' || kind === 'misconfigured') && 'bg-[var(--color-status-red-soft)]',
            )}>
              <div className={cn(
                'w-2.5 h-2.5 rounded-full',
                kind === 'healthy' && 'bg-[var(--color-status-green)]',
                kind === 'checking' && 'bg-[var(--color-status-yellow)]',
                kind === 'degraded' && 'bg-[var(--color-status-yellow)]',
                (kind === 'stopped' || kind === 'misconfigured') && 'bg-[var(--color-status-red)]',
              )} />
            </div>
            <div>
              <div className="text-[13px] font-semibold text-[var(--color-foreground-primary)] leading-tight">
                {statusLabel(kind, lang)}
              </div>
              <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5 leading-tight">
                {statusDescription(status, lang)}
              </div>
            </div>
          </div>
          <Button
            variant={updateModel.variant}
            size="sm"
            disabled={updateModel.disabled}
            onClick={handleUpdate}
            className="shrink-0 mt-0.5"
          >
            {updateModel.label}
          </Button>
        </div>

        {updateNote && (
          <div className="mt-3 rounded-lg bg-[var(--color-surface)] px-3 py-2.5">
            <div className="text-[11px] text-[var(--color-foreground)] leading-relaxed">
              {updateNote}
            </div>
            <div className="mt-1 text-[10px] text-[var(--color-foreground-soft)]">
              {t('currentVersion', lang, {
                version: update?.current_version ?? status.health?.version ?? '',
              })}
              {update?.latest_version
                ? ` → ${update.latest_version}`
                : ''}
            </div>
          </div>
        )}

        {/* Stats row */}
        {kind === 'healthy' && status.state.pid && (
          <div className="flex items-center gap-4 mt-3">
            <StatPill label={t('pid', lang)} value={String(status.state.pid)} />
            <StatPill label={t('approvals', lang)} value={String(status.diagnostics?.pending_approvals ?? 0)} />
            <StatPill label={t('updated', lang)} value={formatRelativeTime(status.checked_at_ms, lang)} />
          </div>
        )}

        {/* Service action */}
        {(kind === 'stopped' || kind === 'misconfigured') && status.actions.can_start && (
          <Button
            variant="default"
            size="default"
            className="w-full mt-3"
            disabled={busy}
            onClick={() => startService.mutate()}
          >
            {t('start', lang)}
          </Button>
        )}
        {(kind === 'healthy' || kind === 'degraded') && status.actions.can_restart && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={() => restartService.mutate()}
          >
            {t('restart', lang)}
          </Button>
        )}
      </section>

      <div className="mx-3 h-px bg-[var(--color-line)]" />

      {(failingChecks.length > 0 || repairActions.length > 0) && (
        <>
        <section className="px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-foreground-muted)]">
                  {t('selfCheckHeading', lang)}
                </span>
                <Badge variant="warning">
                  {t('selfCheckNeedsAttention', lang)}
                </Badge>
              </div>
              <div className="text-[11px] text-[var(--color-foreground-muted)] mt-1.5 leading-snug">
                {status.state.reason || t('selfCheckHint', lang)}
              </div>
            </div>
            {status.actions.can_run_self_check && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || runSelfCheck.isPending}
                onClick={() => runSelfCheck.mutate()}
              >
                <RotateCw className="w-3 h-3" />
              </Button>
            )}
          </div>

          {failingChecks.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {failingChecks.slice(0, 4).map((item) => (
                <Badge key={item} variant="muted">
                  {humanizeCheckName(item, lang)}
                </Badge>
              ))}
            </div>
          )}

          {repairActions.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-2">
              {repairActions.map((action) => (
                <div
                  key={action.id}
                  className="rounded-lg bg-[var(--color-surface)] px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[var(--color-foreground-primary)]">
                        {action.title}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--color-foreground-muted)] leading-relaxed">
                        {action.description}
                      </div>
                    </div>
                    <Button
                      variant={requiresAdminConfirm(action) ? 'destructive' : 'attention'}
                      size="sm"
                      disabled={busy || runRepair.isPending}
                      className="shrink-0"
                      onClick={() => openRepairAction(action)}
                    >
                      {requiresAdminConfirm(action)
                        ? t('repairReviewAction', lang)
                        : t('repairRunNow', lang)}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {(runRepair.error || runSelfCheck.error) && (
            <div className="mt-2 text-[11px] text-[var(--color-status-red)] leading-relaxed">
              {String(runRepair.error || runSelfCheck.error)}
            </div>
          )}
        </section>
        <div className="mx-3 h-px bg-[var(--color-line)]" />
        </>
      )}

      {/* MCP Summary */}
      {kind === 'healthy' && (
        <>
        <section className="px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-foreground-muted)]">
            {t('mcpHeading', lang)}
          </div>
          <div className="text-[11px] text-[var(--color-foreground-muted)] mt-1">
            {t('mcpSummary', lang, {
              connected: status.diagnostics?.connected_mcp_servers ?? status.state.mcp_servers ?? 0,
              tools: status.diagnostics?.total_mcp_tools ?? status.state.mcp_tools ?? 0,
            })}
          </div>
          {/* MCP server list */}
          {(status.diagnostics?.servers ?? []).slice(0, 3).map((server) => (
            <div key={server.name} className="flex justify-between items-center mt-2 py-2 px-3 rounded-lg bg-[var(--color-surface)]">
              <div>
                <div className="text-[12px] font-medium text-[var(--color-foreground-primary)]">{server.name}</div>
                <div className="text-[10px] text-[var(--color-foreground-muted)] mt-0.5">
                  {t('toolCount', lang, { count: server.tool_count })}
                </div>
              </div>
              <Badge variant={serverStatusVariant(server.status)}>
                {localizedServerStatus(server.status, lang)}
              </Badge>
            </div>
          ))}
        </section>
        <div className="mx-3 h-px bg-[var(--color-line)]" />
        </>
      )}

      {/* Nav rows */}
      <div className="py-1">
        <NavRow
          page="permissions"
          label={t('navPermissions', lang)}
          detail={t('permissionsSummary', lang, { enabled: enabledCount, attention: attentionCount })}
          icon={<Shield className="w-4 h-4" />}
        />
        <NavRow
          page="logs"
          label={t('navLogs', lang)}
          detail={recentLogCount > 0 ? `${recentLogCount} ${lang === 'zh' ? '条记录' : 'entries'}` : t('noActivity', lang)}
          icon={<ScrollText className="w-4 h-4" />}
        />
        <NavRow
          page="settings"
          label={t('navSettings', lang)}
          icon={<Settings className="w-4 h-4" />}
        />
      </div>

      {/* Version footer */}
      {status.health?.version && (
        <div className="pb-1 text-center text-[10px] text-[var(--color-foreground-soft)]">
          {t('versionFooter', lang, { version: status.health.version })}
        </div>
      )}
    </div>
  )
}

function serverStatusVariant(status: string) {
  const s = status.trim().toLowerCase()
  if (['connected', 'ready', 'active', 'idle'].includes(s)) return 'healthy' as const
  if (['starting', 'connecting', 'running'].includes(s)) return 'warning' as const
  if (['error', 'failed'].includes(s)) return 'error' as const
  return 'muted' as const
}

function localizedServerStatus(status: string, lang: DisplayLanguage) {
  const s = status.trim().toLowerCase()
  const map: Record<string, string> = {
    connected: t('serverConnected', lang),
    ready: t('serverConnected', lang),
    active: t('serverConnected', lang),
    idle: t('serverIdle', lang),
    starting: t('serverStarting', lang),
    connecting: t('serverStarting', lang),
    running: t('statusRunning', lang),
    disconnected: t('serverDisconnected', lang),
    stopped: t('serverStopped', lang),
    error: t('serverError', lang),
    failed: t('statusFailed', lang),
  }
  return map[s] ?? t('serverUnknown', lang)
}
