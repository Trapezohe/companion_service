import { Fragment } from 'react'
import { usePermissions } from '@/hooks/use-status'
import { useStatus } from '@/hooks/use-status'
import { t } from '@/i18n/translations'
import { Badge } from '@/components/ui/badge'
import { PermissionRow } from '@/components/PermissionRow'
import { PermissionDetailPanel } from '@/components/PermissionDetailPanel'
import { useUIStore } from '@/stores/ui-store'

export function PermissionsSafety() {
  const { data: status } = useStatus()
  const { data: perms, isLoading } = usePermissions()
  const selectedId = useUIStore((s) => s.selectedPermissionId)

  if (!status) return null

  const lang = status.language ?? 'en'
  const items = perms?.items ?? []

  const systemPerms = items.filter((p) => p.group === 'system')
  const highRiskPerms = items.filter((p) => p.group === 'high_risk')

  const enabledCount = items.filter((p) => p.companion_enabled).length
  const attentionCount = items.filter(
    (p) => !p.companion_enabled && p.platform_supported && p.system_auth === 'not_authorized',
  ).length
  const highRiskOffCount = highRiskPerms.filter((p) => !p.companion_enabled).length

  const renderGroup = (groupItems: typeof items) =>
    groupItems.map((perm) => (
      <Fragment key={perm.id}>
        <PermissionRow item={perm} lang={lang} />
        {selectedId === perm.id && (
          <PermissionDetailPanel item={perm} lang={lang} />
        )}
      </Fragment>
    ))

  if (isLoading) {
    return (
      <div className="px-4 py-8 text-center text-xs text-[var(--color-foreground-muted)]">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Summary */}
      <div className="flex flex-wrap gap-1.5 px-0.5">
        <Badge variant="info">
          {t('permissionsSummary', lang, { enabled: enabledCount, attention: attentionCount })}
        </Badge>
        {highRiskOffCount > 0 && (
          <Badge variant="muted">
            {t('permHighRiskOff', lang, { count: highRiskOffCount })}
          </Badge>
        )}
      </div>

      {/* System permissions card */}
      {systemPerms.length > 0 && (
        <div>
          <div className="px-0.5 pb-1">
            <span className="text-[11px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide">
              {t('systemPermissionsGroup', lang)}
            </span>
          </div>
          <div className="rounded-lg bg-[var(--color-card)] overflow-hidden">
            {renderGroup(systemPerms)}
          </div>
        </div>
      )}

      {/* High-risk card */}
      {highRiskPerms.length > 0 && (
        <div>
          <div className="px-0.5 pb-1">
            <span className="text-[11px] font-semibold text-[var(--color-status-yellow)] uppercase tracking-wide">
              {t('highRiskGroup', lang)}
            </span>
          </div>
          <div className="rounded-lg bg-[var(--color-card)] overflow-hidden">
            {renderGroup(highRiskPerms)}
          </div>
        </div>
      )}
    </div>
  )
}
