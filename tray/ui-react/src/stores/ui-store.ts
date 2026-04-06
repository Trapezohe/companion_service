import { create } from 'zustand'
import type { AdminActionConfirmPayload } from '@/types/companion'

export type Page = 'overview' | 'permissions' | 'logs' | 'settings'
export type LogFilter = 'all' | 'blocked' | 'failed'

interface UIState {
  currentPage: Page
  selectedPermissionId: string | null
  logFilter: LogFilter
  riskConfirmPermissionId: string | null
  adminConfirmAction: AdminActionConfirmPayload | null
  busy: boolean

  setPage: (page: Page) => void
  selectPermission: (id: string | null) => void
  setLogFilter: (filter: LogFilter) => void
  showRiskConfirm: (permissionId: string) => void
  hideRiskConfirm: () => void
  showAdminConfirm: (payload: AdminActionConfirmPayload) => void
  hideAdminConfirm: () => void
  setBusy: (busy: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  currentPage: 'overview',
  selectedPermissionId: null,
  logFilter: 'all',
  riskConfirmPermissionId: null,
  adminConfirmAction: null,
  busy: false,

  setPage: (page) => set({ currentPage: page, selectedPermissionId: null }),
  selectPermission: (id) =>
    set((state) => ({
      selectedPermissionId: state.selectedPermissionId === id ? null : id,
    })),
  setLogFilter: (filter) => set({ logFilter: filter }),
  showRiskConfirm: (permissionId) => set({ riskConfirmPermissionId: permissionId }),
  hideRiskConfirm: () => set({ riskConfirmPermissionId: null }),
  showAdminConfirm: (payload) => set({ adminConfirmAction: payload }),
  hideAdminConfirm: () => set({ adminConfirmAction: null }),
  setBusy: (busy) => set({ busy }),
}))
