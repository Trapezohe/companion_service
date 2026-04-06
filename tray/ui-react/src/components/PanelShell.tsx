import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useUIStore, type Page } from '@/stores/ui-store'
import { useStatus } from '@/hooks/use-status'
import { t } from '@/i18n/translations'
import { ChevronLeft } from 'lucide-react'

const NAV_ITEMS: { page: Page; labelKey: string }[] = [
  { page: 'overview', labelKey: 'navOverview' },
  { page: 'permissions', labelKey: 'navPermissions' },
  { page: 'logs', labelKey: 'navLogs' },
  { page: 'settings', labelKey: 'navSettings' },
]

export function PanelShell({ children }: { children: ReactNode }) {
  const currentPage = useUIStore((s) => s.currentPage)
  const setPage = useUIStore((s) => s.setPage)
  const { data: status } = useStatus()
  const lang = status?.language ?? 'en'

  const showBack = currentPage !== 'overview'

  return (
    <div className="w-full h-screen p-1">
      <div className="relative w-full h-full flex flex-col rounded-xl bg-[var(--color-panel)] border border-[var(--color-panel-border)] shadow-[0_8px_32px_rgba(0,0,0,0.55),0_0_0_0.5px_rgba(0,0,0,0.3)] backdrop-blur-[60px] backdrop-saturate-[180%] overflow-hidden">
        {/* Header */}
        <header className="shrink-0 px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2 min-w-0">
            {showBack && (
              <button
                onClick={() => setPage('overview')}
                className="flex items-center justify-center w-6 h-6 -ml-1 rounded-md text-[var(--color-status-blue)] hover:bg-[var(--color-surface)] transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--color-foreground-primary)] tracking-[-0.01em]">
                {showBack
                  ? t(
                      NAV_ITEMS.find((n) => n.page === currentPage)?.labelKey ??
                        'navOverview',
                      lang,
                    )
                  : t('brandTitle', lang)}
              </div>
              {!showBack && (
                <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5 leading-tight">
                  {t('brandSubtitle', lang)}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Separator */}
        <div className="mx-3 h-px bg-[var(--color-line)]" />

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto">
          {children}
        </div>

        {/* Footer */}
        <div className="mx-3 h-px bg-[var(--color-line)]" />
        <footer className="shrink-0 px-4 py-2 text-center">
          <div className="text-[10px] text-[var(--color-foreground-soft)] tracking-wide">
            {t('footer', lang)}
          </div>
        </footer>
      </div>
    </div>
  )
}

export function NavRow({
  page,
  label,
  detail,
  icon,
}: {
  page: Page
  label: string
  detail?: string
  icon?: ReactNode
}) {
  const setPage = useUIStore((s) => s.setPage)

  return (
    <button
      onClick={() => setPage(page)}
      className={cn(
        'w-full flex items-center gap-3 py-2.5 px-3',
        'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-2)]',
        'transition-colors cursor-pointer text-left',
      )}
    >
      {icon && (
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--color-surface)] text-[var(--color-foreground-muted)] shrink-0">
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[var(--color-foreground-primary)] leading-tight">
          {label}
        </div>
        {detail && (
          <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5 truncate leading-tight">
            {detail}
          </div>
        )}
      </div>
      <ChevronLeft className="w-3 h-3 text-[var(--color-foreground-soft)] rotate-180 shrink-0" />
    </button>
  )
}
