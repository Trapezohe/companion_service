import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import type { StatusViewModel, PermissionsSnapshot } from '@/types/companion'
import { useUIStore } from '@/stores/ui-store'

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => invoke<StatusViewModel>('get_status_snapshot'),
    refetchInterval: 5000,
  })
}

export function useRefreshStatus() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('refresh_status_snapshot'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useStartService() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('start_service'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useStopService() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('stop_service'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useRestartService() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('restart_service'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useSetAutostart() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) =>
      invoke<StatusViewModel>('set_autostart_enabled', { enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useSetLanguage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (language: string) =>
      invoke<StatusViewModel>('set_display_language', { language }),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useCheckUpdate() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('check_update'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useInstallUpdate() {
  const queryClient = useQueryClient()
  const setBusy = useUIStore((s) => s.setBusy)
  return useMutation({
    mutationFn: () => invoke<StatusViewModel>('install_update'),
    onMutate: () => setBusy(true),
    onSettled: () => setBusy(false),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

export function useOpenLogs() {
  return useMutation({
    mutationFn: () => invoke('open_logs'),
  })
}

export function useOpenReleasePage() {
  return useMutation({
    mutationFn: () => invoke('open_release_page'),
  })
}

export function useQuitTray() {
  return useMutation({
    mutationFn: () => invoke('quit_tray'),
  })
}

export function useRunRepair() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (action: string) =>
      invoke<StatusViewModel>('run_repair', { action }),
    onSuccess: (data) => {
      queryClient.setQueryData(['status'], data)
    },
  })
}

// ─── Permission hooks ───

export function usePermissions() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: () => invoke<PermissionsSnapshot>('get_permissions_snapshot'),
    refetchInterval: 10000,
  })
}

export function useTogglePermission() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      invoke<PermissionsSnapshot>('toggle_companion_permission', {
        permissionId: id,
        enabled,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['permissions'], data)
    },
  })
}

export function useOpenSystemSettings() {
  return useMutation({
    mutationFn: (permissionId: string) =>
      invoke('open_system_permission_settings', { permissionId }),
  })
}
