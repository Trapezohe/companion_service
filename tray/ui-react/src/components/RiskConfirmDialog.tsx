import { useUIStore } from '@/stores/ui-store'
import { usePermissions, useTogglePermission } from '@/hooks/use-status'
import { useStatus } from '@/hooks/use-status'
import { t } from '@/i18n/translations'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { AlertTriangle } from 'lucide-react'

export function RiskConfirmDialog() {
  const permissionId = useUIStore((s) => s.riskConfirmPermissionId)
  const hideRiskConfirm = useUIStore((s) => s.hideRiskConfirm)
  const togglePermission = useTogglePermission()
  const { data: status } = useStatus()
  const { data: perms } = usePermissions()

  const lang = status?.language ?? 'en'
  const item = perms?.items.find((p) => p.id === permissionId)

  const handleConfirm = () => {
    if (permissionId) {
      togglePermission.mutate({ id: permissionId, enabled: true })
    }
    hideRiskConfirm()
  }

  return (
    <Dialog open={!!permissionId} onOpenChange={(open) => !open && hideRiskConfirm()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-[var(--color-status-yellow)]" />
            {t('riskConfirmTitle', lang)}
          </DialogTitle>
        </DialogHeader>

        <DialogDescription className="text-[11px] leading-relaxed">
          {t('riskConfirmBody', lang)}
        </DialogDescription>

        {item && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5">
            <div className="text-xs font-medium text-[var(--color-foreground-primary)]">
              {t(item.title_key, lang)}
            </div>
            <div className="text-[11px] text-[var(--color-foreground-muted)] mt-1 leading-relaxed">
              {t(item.description_key, lang)}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-1">
          <Button
            variant="secondary"
            size="default"
            className="flex-1"
            onClick={hideRiskConfirm}
          >
            {t('riskConfirmCancel', lang)}
          </Button>
          <Button
            variant="attention"
            size="default"
            className="flex-1"
            onClick={handleConfirm}
          >
            {t('riskConfirmEnable', lang)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
