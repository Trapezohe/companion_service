import { useStatus, useSetLanguage, useSetAutostart, useOpenLogs, useOpenReleasePage, useStopService, useQuitTray } from '@/hooks/use-status'
import { useUIStore } from '@/stores/ui-store'
import { t } from '@/i18n/translations'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Settings() {
  const { data: status } = useStatus()
  const setLanguage = useSetLanguage()
  const setAutostart = useSetAutostart()
  const openLogs = useOpenLogs()
  const openReleasePage = useOpenReleasePage()
  const stopService = useStopService()
  const quitTray = useQuitTray()
  const busy = useUIStore((s) => s.busy)

  if (!status) return null

  const lang = status.language ?? 'en'
  const autostartEnabled = status.autostart?.enabled ?? false

  return (
    <div className="flex flex-col gap-3 p-3.5">
      {/* Language */}
      <div className="bg-[var(--color-card)] border border-[var(--color-card-border)] rounded-lg p-2.5 flex flex-col gap-2">
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          {t('languageLabel', lang)}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setLanguage.mutate('en')}
            className={cn(
              'bg-[var(--color-surface)] border border-[var(--color-card-border)] rounded-md px-2.5 py-2 text-left cursor-pointer flex flex-col gap-0.5',
              lang === 'en' && 'bg-[var(--color-status-blue-soft)] border-[rgba(10,132,255,0.3)] text-[var(--color-status-blue)]',
              lang !== 'en' && 'text-[var(--color-foreground-muted)]',
            )}
          >
            <div className="text-xs font-medium">{t('languageEnglish', lang)}</div>
            <div className="text-[10px] opacity-80">{t('languageEnglishHelp', lang)}</div>
          </button>
          <button
            onClick={() => setLanguage.mutate('zh')}
            className={cn(
              'bg-[var(--color-surface)] border border-[var(--color-card-border)] rounded-md px-2.5 py-2 text-left cursor-pointer flex flex-col gap-0.5',
              lang === 'zh' && 'bg-[var(--color-status-blue-soft)] border-[rgba(10,132,255,0.3)] text-[var(--color-status-blue)]',
              lang !== 'zh' && 'text-[var(--color-foreground-muted)]',
            )}
          >
            <div className="text-xs font-medium">{t('languageChinese', lang)}</div>
            <div className="text-[10px] opacity-80">{t('languageChineseHelp', lang)}</div>
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        {status.actions.can_toggle_autostart && (
          <Button
            variant="secondary"
            className="w-full justify-start"
            onClick={() => setAutostart.mutate(!autostartEnabled)}
          >
            {autostartEnabled ? t('disableAutostart', lang) : t('enableAutostart', lang)}
          </Button>
        )}

        {status.actions.can_open_logs && (
          <Button
            variant="secondary"
            className="w-full justify-start"
            onClick={() => openLogs.mutate()}
          >
            {t('openLogsFolder', lang)}
          </Button>
        )}

        <Button
          variant="secondary"
          className="w-full justify-start"
          onClick={() => openReleasePage.mutate()}
        >
          {t('releaseFallback', lang)}
        </Button>

        {status.actions.can_stop && (
          <Button
            variant="secondary"
            className="w-full justify-start"
            disabled={busy}
            onClick={() => stopService.mutate()}
          >
            {t('stopService', lang)}
          </Button>
        )}

        <Button
          variant="destructive"
          className="w-full justify-start"
          onClick={() => quitTray.mutate()}
        >
          {t('quit', lang)}
        </Button>
      </div>
    </div>
  )
}
