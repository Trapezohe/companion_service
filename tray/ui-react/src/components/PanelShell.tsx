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
    <div className="w-full h-screen p-[5px]">
      <div className="relative w-full h-full flex flex-col rounded-[10px] bg-[var(--color-panel)] border border-[var(--color-panel-border)] shadow-[0_8px_40px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(0,0,0,0.4)] backdrop-blur-[20px] overflow-hidden">
        {/* Header */}
        <header className="shrink-0 flex items-center h-10 px-3">
          {showBack ? (
            <button
              onClick={() => setPage('overview')}
              className="flex items-center gap-0.5 text-[13px] text-[var(--color-status-blue)] hover:opacity-80 transition-opacity cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>{t(NAV_ITEMS.find((n) => n.page === currentPage)?.labelKey ?? 'navOverview', lang)}</span>
            </button>
          ) : (
            <span className="text-[13px] font-semibold text-[var(--color-foreground-primary)]">
              {t('brandTitle', lang)}
            </span>
          )}
        </header>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto px-2.5 pb-2.5">
          {children}
        </div>
      </div>
    </div>
  )
}

export function NavRow({
  page,
  label,
  detail,
  icon,
  isLast,
}: {
  page: Page
  label: string
  detail?: string
  icon?: ReactNode
  isLast?: boolean
}) {
  const setPage = useUIStore((s) => s.setPage)

  return (
    <button
      onClick={() => setPage(page)}
      className={cn(
        'w-full flex items-center gap-2.5 py-2 px-2.5',
        'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-2)]',
        'transition-colors cursor-pointer text-left',
        !isLast && 'border-b border-[var(--color-line)]',
      )}
    >
      {icon && (
        <div className="flex items-center justify-center w-[26px] h-[26px] rounded-[6px] bg-[var(--color-surface-2)] text-[var(--color-foreground-muted)] shrink-0">
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-[var(--color-foreground-primary)] leading-tight">
          {label}
        </div>
        {detail && (
          <div className="text-[11px] text-[var(--color-foreground-muted)] mt-px truncate leading-tight">
            {detail}
          </div>
        )}
      </div>
      <ChevronLeft className="w-3 h-3 text-[var(--color-foreground-soft)] rotate-180 shrink-0" />
    </button>
  )
}
