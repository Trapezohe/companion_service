import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useQueryClient } from '@tanstack/react-query'
import type { StatusViewModel } from '@/types/companion'

const STATUS_EVENT = 'companion://status'

export function useTauriEvents() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const unlisten = listen<StatusViewModel>(STATUS_EVENT, (event) => {
      queryClient.setQueryData(['status'], event.payload)
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [queryClient])
}
