/**
 * useCloudSync — polls the backend sync/pull endpoint for remote changes
 * and calls onRemoteChanges when another session has updated vault files.
 *
 * Only active when the vault path is a cloud vault_store path and the
 * vault REST API is available.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 30_000
const LAST_SYNC_KEY = 'tolaria:cloud-sync-last-pull'

export type CloudSyncStatus = 'idle' | 'syncing' | 'error'

export interface CloudSyncState {
  syncStatus: CloudSyncStatus
  lastSyncTime: number | null
  triggerSync: () => void
}

interface UseCloudSyncOptions {
  enabled: boolean
  vaultId: string
  onRemoteChanges: () => void
}

export function useCloudSync({
  enabled,
  vaultId,
  onRemoteChanges,
}: UseCloudSyncOptions): CloudSyncState {
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(LAST_SYNC_KEY))
      return v || null
    } catch {
      return null
    }
  })

  // Keep the callback ref stable so the interval closure always sees the latest
  const callbackRef = useRef(onRemoteChanges)
  callbackRef.current = onRemoteChanges

  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const pull = useCallback(async (): Promise<void> => {
    if (!enabled) return
    setSyncStatus('syncing')
    try {
      const since = Number(localStorage.getItem(LAST_SYNC_KEY) ?? '0')
      const now = Date.now() / 1000
      const res = await fetch(
        `/api/vault/sync/pull?vault_id=${encodeURIComponent(vaultId)}&since=${since}`,
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { files: unknown[]; deleted: string[]; total: number }

      if (data.total > 0) {
        console.info(
          `[cloud-sync] ${data.files.length} remote change(s) detected — reloading vault`,
        )
        callbackRef.current()
      }

      localStorage.setItem(LAST_SYNC_KEY, String(now))
      setLastSyncTime(now * 1000)
      setSyncStatus('idle')
    } catch (err) {
      console.warn('[cloud-sync] Pull failed:', err)
      setSyncStatus('error')
    }
  }, [enabled, vaultId])

  useEffect(() => {
    if (!enabled) return
    void pull()
    intervalRef.current = setInterval(() => { void pull() }, POLL_INTERVAL_MS)
    return () => { clearInterval(intervalRef.current) }
  }, [enabled, pull])

  return { syncStatus, lastSyncTime, triggerSync: pull }
}
