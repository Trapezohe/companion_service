import { useStatus, useSetLanguage, useSetAutostart, useOpenLogs, useOpenReleasePage, useStopService, useQuitTray } from '@/hooks/use-status'
import { useUIStore } from '@/stores/ui-store'
import { t } from '@/i18n/translations'
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
    <div className="flex flex-col gap-2.5">
      {/* Language card */}
      <div className="rounded-lg bg-[var(--color-card)] overflow-hidden px-3 py-2.5">
        <div className="text-[11px] font-semibold text-[var(--color-foreground-muted)] uppercase tracking-wide mb-2">
          {t('languageLabel', lang)}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setLanguage.mutate('en')}
            className={cn(
              'rounded-md px-2.5 py-2 text-left cursor-pointer flex flex-col gap-0.5 transition-colors',
              lang === 'en'
                ? 'bg-[var(--color-status-blue-soft)] text-[var(--color-status-blue)]'
                : 'bg-[var(--color-surface)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)]',
            )}
          >
            <div className="text-[12px] font-medium">{t('languageEnglish', lang)}</div>
            <div className="text-[10px] opacity-70">{t('languageEnglishHelp', lang)}</div>
          </button>
          <button
            onClick={() => setLanguage.mutate('zh')}
            className={cn(
              'rounded-md px-2.5 py-2 text-left cursor-pointer flex flex-col gap-0.5 transition-colors',
              lang === 'zh'
                ? 'bg-[var(--color-status-blue-soft)] text-[var(--color-status-blue)]'
                : 'bg-[var(--color-surface)] text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface-hover)]',
            )}
          >
            <div className="text-[12px] font-medium">{t('languageChinese', lang)}</div>
            <div className="text-[10px] opacity-70">{t('languageChineseHelp', lang)}</div>
          </button>
        </div>
      </div>

      {/* Actions card */}
      <div className="rounded-lg bg-[var(--color-card)] overflow-hidden">
        {status.actions.can_toggle_autostart && (
          <SettingsRow onClick={() => setAutostart.mutate(!autostartEnabled)}>
            {autostartEnabled ? t('disableAutostart', lang) : t('enableAutostart', lang)}
          </SettingsRow>
        )}
        {status.actions.can_open_logs && (
          <SettingsRow onClick={() => openLogs.mutate()}>
            {t('openLogsFolder', lang)}
          </SettingsRow>
        )}
        <SettingsRow onClick={() => openReleasePage.mutate()}>
          {t('releaseFallback', lang)}
        </SettingsRow>
        {status.actions.can_stop && (
          <SettingsRow onClick={() => stopService.mutate()} disabled={busy}>
            {t('stopService', lang)}
          </SettingsRow>
        )}
      </div>

      {/* Quit card */}
      <div className="rounded-lg bg-[var(--color-card)] overflow-hidden">
        <SettingsRow onClick={() => quitTray.mutate()} destructive isLast>
          {t('quit', lang)}
        </SettingsRow>
      </div>
    </div>
  )
}

function SettingsRow({
  children,
  onClick,
  disabled,
  destructive,
  isLast,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
  isLast?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full text-left px-3 py-2.5 text-[13px] transition-colors cursor-pointer',
        'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-2)]',
        'disabled:opacity-40 disabled:pointer-events-none',
        !isLast && 'border-b border-[var(--color-line)]',
        destructive ? 'text-[var(--color-status-red)]' : 'text-[var(--color-foreground-primary)]',
      )}
    >
      {children}
    </button>
  )
}
