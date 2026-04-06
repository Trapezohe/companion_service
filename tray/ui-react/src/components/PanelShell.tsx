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
    <div className="relative w-full h-screen flex flex-col bg-[var(--color-panel)] backdrop-blur-[40px] backdrop-saturate-[180%] isolation-auto overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-3.5 pt-3 pb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {showBack && (
            <button
              onClick={() => setPage('overview')}
              className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--color-foreground-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground-primary)] transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-foreground-primary)] leading-tight">
              {showBack
                ? t(
                    NAV_ITEMS.find((n) => n.page === currentPage)?.labelKey ??
                      'navOverview',
                    lang,
                  )
                : t('brandTitle', lang)}
            </div>
            {!showBack && (
              <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5">
                {t('brandSubtitle', lang)}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {children}
      </div>

      {/* Footer */}
      <footer className="px-3.5 py-1.5 border-t border-[var(--color-line)] text-center">
        <div className="text-[10px] text-[var(--color-foreground-soft)]">
          {t('footer', lang)}
        </div>
      </footer>
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
        'w-full flex items-center justify-between py-2.5 px-3.5',
        'border-t border-[var(--color-line)] first:border-t-0',
        'hover:bg-[var(--color-surface)] transition-colors cursor-pointer text-left',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {icon && (
          <div className="text-[var(--color-foreground-muted)] shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-xs font-medium text-[var(--color-foreground-primary)]">
            {label}
          </div>
          {detail && (
            <div className="text-[11px] text-[var(--color-foreground-muted)] mt-0.5 truncate">
              {detail}
            </div>
          )}
        </div>
      </div>
      <ChevronLeft className="w-3.5 h-3.5 text-[var(--color-foreground-soft)] rotate-180 shrink-0" />
    </button>
  )
}
