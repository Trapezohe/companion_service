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

  const selectedItem = selectedId ? items.find((p) => p.id === selectedId) : null

  if (isLoading) {
    return (
      <div className="px-3.5 py-8 text-center text-xs text-[var(--color-foreground-muted)]">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* Summary bar */}
      <div className="px-3.5 py-2.5 border-b border-[var(--color-line)] flex flex-wrap gap-1.5">
        <Badge variant="info">
          {t('permissionsSummary', lang, { enabled: enabledCount, attention: attentionCount })}
        </Badge>
        {highRiskOffCount > 0 && (
          <Badge variant="muted">
            {t('permHighRiskOff', lang, { count: highRiskOffCount })}
          </Badge>
        )}
      </div>

      {/* System permissions group */}
      {systemPerms.length > 0 && (
        <section>
          <div className="px-3.5 pt-3 pb-1">
            <span className="text-[11px] font-semibold text-[var(--color-foreground-primary)]">
              {t('systemPermissionsGroup', lang)}
            </span>
          </div>
          {systemPerms.map((perm) => (
            <PermissionRow key={perm.id} item={perm} lang={lang} />
          ))}
        </section>
      )}

      {/* High-risk capabilities group */}
      {highRiskPerms.length > 0 && (
        <section>
          <div className="px-3.5 pt-3 pb-1">
            <span className="text-[11px] font-semibold text-[var(--color-status-yellow)]">
              {t('highRiskGroup', lang)}
            </span>
          </div>
          {highRiskPerms.map((perm) => (
            <PermissionRow key={perm.id} item={perm} lang={lang} />
          ))}
        </section>
      )}

      {/* Inline detail panel */}
      {selectedItem && (
        <PermissionDetailPanel item={selectedItem} lang={lang} />
      )}
    </div>
  )
}
