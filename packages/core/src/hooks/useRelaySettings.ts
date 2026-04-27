import { useEffect, useRef, useState } from "react"
import {
  createDefaultRelaySettings,
  getRelaySettingsStorageKey,
  loadRelaySettings,
  mergeRelayPreferencesIntoSettings,
  readNip07RelayPreferences,
  removeRelaySettingsEntry,
  reorderCommerceRelay,
  saveRelaySettings,
  scanRelaySettingsEntry,
  tryNormalizeRelayUrl,
  updateRelaySettingsEntry,
  upsertRelaySettingsEntry,
  type RelaySettingsState,
} from "../protocol/relay-settings"
import { refreshNdkRelaySettings } from "../protocol/ndk"

export interface UseRelaySettingsResult {
  settings: RelaySettingsState
  scanningUrls: string[]
  error: string | null
  addRelay: (url: string) => Promise<void>
  refreshRelay: (url: string) => Promise<void>
  removeRelay: (url: string) => void
  toggleRelayRead: (url: string, enabled: boolean) => void
  toggleRelayWrite: (url: string, enabled: boolean) => void
  reorderRelay: (sourceUrl: string, targetUrl: string) => void
  resetRelaySettings: () => void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update relays"
}

function removeScanningUrl(urls: readonly string[], url: string): string[] {
  return urls.filter((item) => item !== url)
}

export function useRelaySettings(
  scope?: string | null
): UseRelaySettingsResult {
  const [settings, setSettings] = useState<RelaySettingsState>(() =>
    loadRelaySettings(scope)
  )
  const settingsRef = useRef(settings)
  const [scanningUrls, setScanningUrls] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const next = loadRelaySettings(scope)
    settingsRef.current = next
    setSettings(next)
    refreshNdkRelaySettings(scope)
  }, [scope])

  useEffect(() => {
    if (typeof window === "undefined") return

    const storageKey = getRelaySettingsStorageKey(scope)
    function handleStorage(event: StorageEvent): void {
      if (event.key !== storageKey) return
      const next = loadRelaySettings(scope)
      settingsRef.current = next
      setSettings(next)
      refreshNdkRelaySettings(scope)
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [scope])

  useEffect(() => {
    let cancelled = false

    async function importSignerRelays(): Promise<void> {
      const preferences = await readNip07RelayPreferences()
      if (cancelled || preferences.length === 0) return

      const next = saveRelaySettings(
        mergeRelayPreferencesIntoSettings(settingsRef.current, preferences),
        scope
      )
      settingsRef.current = next
      setSettings(next)
      refreshNdkRelaySettings(scope)
    }

    void importSignerRelays()

    return () => {
      cancelled = true
    }
  }, [scope])

  function persist(
    update: (current: RelaySettingsState) => RelaySettingsState
  ): void {
    const next = saveRelaySettings(update(settingsRef.current), scope)
    settingsRef.current = next
    setSettings(next)
    refreshNdkRelaySettings(scope)
  }

  async function addRelay(url: string): Promise<void> {
    setError(null)
    const normalized = tryNormalizeRelayUrl(url)
    const scanningKey = normalized.ok ? normalized.url : url.trim()

    try {
      if (!normalized.ok) throw new Error(normalized.error)

      const existing = settingsRef.current.entries.find(
        (entry) => entry.url === normalized.url
      )
      setScanningUrls((current) =>
        current.includes(scanningKey) ? current : [...current, scanningKey]
      )
      const scanned = await scanRelaySettingsEntry(url, {}, existing)
      persist((current) => upsertRelaySettingsEntry(current, scanned))
    } catch (scanError) {
      setError(getErrorMessage(scanError))
    } finally {
      setScanningUrls((current) => removeScanningUrl(current, scanningKey))
    }
  }

  async function refreshRelay(url: string): Promise<void> {
    setError(null)
    const existing = settingsRef.current.entries.find(
      (entry) => entry.url === url
    )

    try {
      setScanningUrls((current) =>
        current.includes(url) ? current : [...current, url]
      )
      const scanned = await scanRelaySettingsEntry(url, {}, existing)
      persist((current) => upsertRelaySettingsEntry(current, scanned))
    } catch (scanError) {
      setError(getErrorMessage(scanError))
    } finally {
      setScanningUrls((current) => removeScanningUrl(current, url))
    }
  }

  function removeRelay(url: string): void {
    setError(null)
    persist((current) => removeRelaySettingsEntry(current, url))
  }

  function toggleRelayRead(url: string, enabled: boolean): void {
    setError(null)
    persist((current) =>
      updateRelaySettingsEntry(current, url, { readEnabled: enabled })
    )
  }

  function toggleRelayWrite(url: string, enabled: boolean): void {
    setError(null)
    persist((current) =>
      updateRelaySettingsEntry(current, url, { writeEnabled: enabled })
    )
  }

  function reorderRelay(sourceUrl: string, targetUrl: string): void {
    setError(null)
    persist((current) => reorderCommerceRelay(current, sourceUrl, targetUrl))
  }

  function resetRelaySettings(): void {
    setError(null)
    const defaults = saveRelaySettings(createDefaultRelaySettings(), scope)
    settingsRef.current = defaults
    setSettings(defaults)
    refreshNdkRelaySettings(scope)
  }

  return {
    settings,
    scanningUrls,
    error,
    addRelay,
    refreshRelay,
    removeRelay,
    toggleRelayRead,
    toggleRelayWrite,
    reorderRelay,
    resetRelaySettings,
  }
}
