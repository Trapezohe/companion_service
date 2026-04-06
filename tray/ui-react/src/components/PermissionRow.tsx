import { useUIStore } from '@/stores/ui-store'
import { useTogglePermission } from '@/hooks/use-status'
import { t } from '@/i18n/translations'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { PermissionItem, DisplayLanguage } from '@/types/companion'

function systemAuthBadge(item: PermissionItem, lang: DisplayLanguage) {
  if (!item.platform_supported)
    return <Badge variant="muted">{t('platformNotSupported', lang)}</Badge>
  if (item.system_auth === 'authorized')
    return <Badge variant="healthy">{t('systemAuthorized', lang)}</Badge>
  if (item.system_auth === 'not_authorized')
    return <Badge variant="warning">{t('systemNotAuthorized', lang)}</Badge>
  if (item.system_auth === 'implicitly_allowed')
    return <Badge variant="info">{t('systemImplicitlyAllowed', lang)}</Badge>
  return null
}

function canToggle(item: PermissionItem): boolean {
  if (!item.platform_supported) return false
  if (item.system_auth === 'not_authorized') return false
  return true
}

export function PermissionRow({
  item,
  lang,
}: {
  item: PermissionItem
  lang: DisplayLanguage
}) {
  const selectedId = useUIStore((s) => s.selectedPermissionId)
  const selectPermission = useUIStore((s) => s.selectPermission)
  const showRiskConfirm = useUIStore((s) => s.showRiskConfirm)
  const togglePermission = useTogglePermission()

  const isSelected = selectedId === item.id
  const toggleable = canToggle(item)

  const handleToggle = (checked: boolean) => {
    if (checked && item.is_high_risk && !item.companion_enabled) {
      showRiskConfirm(item.id)
      return
    }
    togglePermission.mutate({ id: item.id, enabled: checked })
  }

  const handleRowClick = () => {
    selectPermission(item.id)
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3.5 py-2.5',
        'border-t border-[var(--color-line)] first:border-t-0',
        'transition-colors cursor-pointer',
        isSelected
          ? 'bg-[var(--color-surface)]'
          : 'hover:bg-[var(--color-surface)]',
      )}
      onClick={handleRowClick}
    >
      <div className="flex-1 min-w-0 mr-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--color-foreground-primary)]">
            {t(item.title_key, lang)}
          </span>
          {item.is_high_risk && (
            <Badge variant="warning" className="text-[9px] px-1 py-0">
              {t('highRisk', lang)}
            </Badge>
          )}
          {item.requires_per_action_confirm && (
            <Badge variant="muted" className="text-[9px] px-1 py-0">
              {t('perActionConfirm', lang)}
            </Badge>
          )}
        </div>
        <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5">
          {t(item.description_key, lang)}
        </div>
        <div className="flex items-center gap-1 mt-1">
          {systemAuthBadge(item, lang)}
          {item.platform_supported && item.system_auth !== 'not_supported' && (
            <Badge variant={item.companion_enabled ? 'healthy' : 'muted'}>
              {item.companion_enabled
                ? t('companionEnabled', lang)
                : t('companionDisabled', lang)}
            </Badge>
          )}
        </div>
      </div>

      {/* Toggle or auth button */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        {item.platform_supported && item.system_auth === 'not_authorized' ? (
          <button
            onClick={() => selectPermission(item.id)}
            className="text-[11px] font-medium text-[var(--color-status-yellow)] bg-[var(--color-status-yellow-soft)] border border-[rgba(255,159,10,0.2)] rounded-md px-2 py-1 cursor-pointer hover:brightness-110 transition-all"
          >
            {t('needsAuth', lang)}
          </button>
        ) : (
          <Switch
            checked={item.companion_enabled}
            disabled={!toggleable}
            onCheckedChange={handleToggle}
          />
        )}
      </div>
    </div>
  )
}
