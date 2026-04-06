import { create } from 'zustand'
import type { AdminActionConfirmPayload } from '@/types/companion'

export type Page = 'overview' | 'permissions' | 'logs' | 'settings'
export type LogFilter = 'all' | 'blocked' | 'failed'

interface UIState {
  currentPage: Page
  selectedPermissionId: string | null
  logFilter: LogFilter
  logPermissionId: string | null
  riskConfirmPermissionId: string | null
  adminConfirmAction: AdminActionConfirmPayload | null
  busy: boolean

  setPage: (page: Page) => void
  selectPermission: (id: string | null) => void
  setLogFilter: (filter: LogFilter) => void
  setLogPermission: (permissionId: string | null) => void
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
  logPermissionId: null,
  riskConfirmPermissionId: null,
  adminConfirmAction: null,
  busy: false,

  setPage: (page) =>
    set((state) => ({
      currentPage: page,
      selectedPermissionId: null,
      logPermissionId: page === 'logs' ? state.logPermissionId : null,
    })),
  selectPermission: (id) =>
    set((state) => ({
      selectedPermissionId: state.selectedPermissionId === id ? null : id,
    })),
  setLogFilter: (filter) => set({ logFilter: filter }),
  setLogPermission: (permissionId) => set({ logPermissionId: permissionId }),
  showRiskConfirm: (permissionId) => set({ riskConfirmPermissionId: permissionId }),
  hideRiskConfirm: () => set({ riskConfirmPermissionId: null }),
  showAdminConfirm: (payload) => set({ adminConfirmAction: payload }),
  hideAdminConfirm: () => set({ adminConfirmAction: null }),
  setBusy: (busy) => set({ busy }),
}))
