import { useUIStore } from '@/stores/ui-store'
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
import { ShieldAlert } from 'lucide-react'

export function AdminActionConfirmDialog() {
  const action = useUIStore((s) => s.adminConfirmAction)
  const hideAdminConfirm = useUIStore((s) => s.hideAdminConfirm)
  const { data: status } = useStatus()

  const lang = status?.language ?? 'en'

  const handleContinue = () => {
    // In production this would invoke the actual admin action
    // For now we just close the dialog
    hideAdminConfirm()
  }

  return (
    <Dialog open={!!action} onOpenChange={(open) => !open && hideAdminConfirm()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-[var(--color-status-red)]" />
            {t('adminConfirmTitle', lang)}
          </DialogTitle>
        </DialogHeader>

        <DialogDescription asChild>
          <div className="flex flex-col gap-2">
            {action && (
              <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 flex flex-col gap-1.5">
                <div>
                  <span className="text-[10px] text-[var(--color-foreground-muted)]">
                    {t('adminConfirmAction', lang)}
                  </span>
                  <div className="text-xs font-medium text-[var(--color-foreground-primary)]">
                    {action.action_name}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--color-foreground-muted)]">
                    {t('adminConfirmTrigger', lang)}
                  </span>
                  <div className="text-xs text-[var(--color-foreground)]">
                    {action.trigger}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--color-foreground-muted)]">
                    {t('adminConfirmReason', lang)}
                  </span>
                  <div className="text-xs text-[var(--color-foreground)]">
                    {action.reason}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--color-foreground-muted)]">
                    {t('adminConfirmImpact', lang)}
                  </span>
                  <div className="text-xs text-[var(--color-foreground)]">
                    {action.impact}
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogDescription>

        <div className="flex gap-2 mt-1">
          <Button
            variant="secondary"
            size="default"
            className="flex-1"
            onClick={hideAdminConfirm}
          >
            {t('adminConfirmCancel', lang)}
          </Button>
          <Button
            variant="destructive"
            size="default"
            className="flex-1"
            onClick={handleContinue}
          >
            {t('adminConfirmContinue', lang)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
