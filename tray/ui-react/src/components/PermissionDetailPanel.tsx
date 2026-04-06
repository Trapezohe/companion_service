import { useUIStore } from '@/stores/ui-store'
import { useOpenSystemSettings } from '@/hooks/use-status'
import { t } from '@/i18n/translations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { PermissionItem, DisplayLanguage } from '@/types/companion'
import { ExternalLink, ScrollText, X } from 'lucide-react'

export function PermissionDetailPanel({
  item,
  lang,
}: {
  item: PermissionItem
  lang: DisplayLanguage
}) {
  const selectPermission = useUIStore((s) => s.selectPermission)
  const setPage = useUIStore((s) => s.setPage)
  const setLogFilter = useUIStore((s) => s.setLogFilter)
  const setLogPermission = useUIStore((s) => s.setLogPermission)
  const openSystemSettings = useOpenSystemSettings()

  const behaviorText = (() => {
    if (!item.platform_supported) return t('permBehaviorUnsupported', lang)
    if (item.group === 'system' && item.system_auth === 'not_authorized') {
      return t('permBehaviorNeedsSystemAuth', lang)
    }
    if (item.companion_enabled) {
      return item.requires_per_action_confirm
        ? t('permBehaviorEnabledWithConfirm', lang)
        : t('permBehaviorEnabled', lang)
    }
    return item.group === 'high_risk'
      ? t('permBehaviorHighRiskDisabled', lang)
      : t('permBehaviorDisabled', lang)
  })()

  const handleViewLogs = () => {
    setLogFilter('all')
    setLogPermission(item.id)
    setPage('logs')
  }

  return (
    <div className="mx-2 my-1.5 bg-[var(--color-surface)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-line)]">
        <span className="text-xs font-semibold text-[var(--color-foreground-primary)]">
          {t(item.title_key, lang)}
        </span>
        <button
          onClick={() => selectPermission(null)}
          className="w-5 h-5 flex items-center justify-center rounded text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground-primary)] hover:bg-[var(--color-surface)] transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 flex flex-col gap-2.5">
        {/* What does this do? */}
        <div>
          <div className="text-[10px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide mb-0.5">
            {t('permDetailWhat', lang)}
          </div>
          <div className="text-[11px] text-[var(--color-foreground)] leading-relaxed">
            {t(item.description_key, lang)}
          </div>
        </div>

        {/* System status */}
        <div>
          <div className="text-[10px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide mb-0.5">
            {t('permDetailSystemStatus', lang)}
          </div>
          <div className="flex items-center gap-1.5">
            {!item.platform_supported ? (
              <Badge variant="muted">{t('platformNotSupported', lang)}</Badge>
            ) : item.system_auth === 'authorized' ? (
              <Badge variant="healthy">{t('systemAuthorized', lang)}</Badge>
            ) : item.system_auth === 'implicitly_allowed' ? (
              <Badge variant="info">{t('systemImplicitlyAllowed', lang)}</Badge>
            ) : (
              <Badge variant="warning">{t('systemNotAuthorized', lang)}</Badge>
            )}
          </div>
        </div>

        {/* Companion status */}
        <div>
          <div className="text-[10px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide mb-0.5">
            {t('permDetailCompanionStatus', lang)}
          </div>
          <Badge variant={item.companion_enabled ? 'healthy' : 'muted'}>
            {item.companion_enabled
              ? t('companionEnabled', lang)
              : t('companionDisabled', lang)}
          </Badge>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide mb-0.5">
            {t('permDetailWhenEnabled', lang)}
          </div>
          <div className="text-[11px] text-[var(--color-foreground)] leading-relaxed">
            {behaviorText}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-1.5 mt-1">
          {item.platform_supported && item.system_auth === 'not_authorized' && (
            <Button
              variant="attention"
              size="sm"
              className="w-full justify-start gap-1.5"
              onClick={() => openSystemSettings.mutate(item.id)}
            >
              <ExternalLink className="w-3 h-3" />
              {t('permDetailGoToSettings', lang)}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="w-full justify-start gap-1.5"
            onClick={handleViewLogs}
          >
            <ScrollText className="w-3 h-3" />
            {t('permDetailViewLogs', lang)}
          </Button>
        </div>
      </div>
    </div>
  )
}
