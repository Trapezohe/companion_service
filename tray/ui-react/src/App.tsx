import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PanelShell } from '@/components/PanelShell'
import { Overview } from '@/components/Overview'
import { PermissionsSafety } from '@/components/PermissionsSafety'
import { ActionLogList } from '@/components/ActionLogList'
import { Settings } from '@/components/Settings'
import { RiskConfirmDialog } from '@/components/RiskConfirmDialog'
import { AdminActionConfirmDialog } from '@/components/AdminActionConfirmDialog'
import { useTauriEvents } from '@/hooks/use-tauri-events'
import { useUIStore } from '@/stores/ui-store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 2000,
    },
  },
})

function AppContent() {
  useTauriEvents()
  const currentPage = useUIStore((s) => s.currentPage)

  return (
    <PanelShell>
      {currentPage === 'overview' && <Overview />}
      {currentPage === 'permissions' && <PermissionsSafety />}
      {currentPage === 'logs' && <ActionLogList />}
      {currentPage === 'settings' && <Settings />}

      {/* Global dialogs */}
      <RiskConfirmDialog />
      <AdminActionConfirmDialog />
    </PanelShell>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  )
}
