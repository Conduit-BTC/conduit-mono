import { useEffect, useRef, useState } from "react"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  assertSafeNip65RelayList,
  createDefaultRelaySettings,
  createRelaySettingsFromPreferences,
  getRelaySettingsStorageKey,
  hasManualRelaySettings,
  loadRelaySettings,
  mergeRelayPreferencesIntoSettings,
  mergeNip65RelayUrls,
  readNip07RelayPreferences,
  removeRelaySettingsEntry,
  reorderCommerceRelay,
  saveRelaySettings,
  scanRelaySettingsEntry,
  serializeNip65RelayTags,
  tryNormalizeRelayUrl,
  updateRelaySettingsEntry,
  upsertRelaySettingsEntry,
  type RelayPreference,
  type RelaySettingsState,
} from "../protocol/relay-settings"
import { getRelayList } from "../protocol/relay-list"
import { EVENT_KINDS } from "../protocol/kinds"
import { refreshNdkRelaySettings, requireNdkConnected } from "../protocol/ndk"
import { publishWithPlanner } from "../protocol/relay-publish"

export interface UseRelaySettingsOptions {
  pubkey?: string | null
}

export interface UseRelaySettingsResult {
  settings: RelaySettingsState
  scanningUrls: string[]
  error: string | null
  isLoadingPublishedRelayList: boolean
  publishedRelayListUpdatedAt: number | null
  publishingRelayList: boolean
  publishError: string | null
  addRelay: (url: string) => Promise<void>
  refreshRelay: (url: string) => Promise<void>
  removeRelay: (url: string) => void
  toggleRelayRead: (url: string, enabled: boolean) => void
  toggleRelayWrite: (url: string, enabled: boolean) => void
  reorderRelay: (sourceUrl: string, targetUrl: string) => void
  resetRelaySettings: () => void
  publishRelayList: () => Promise<void>
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update relays"
}

function removeScanningUrl(urls: readonly string[], url: string): string[] {
  return urls.filter((item) => item !== url)
}

export function useRelaySettings(
  scope?: string | null,
  options: UseRelaySettingsOptions = {}
): UseRelaySettingsResult {
  const pubkey = options.pubkey?.trim() || null
  const [settings, setSettings] = useState<RelaySettingsState>(() =>
    loadRelaySettings(scope)
  )
  const settingsRef = useRef(settings)
  const [scanningUrls, setScanningUrls] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoadingPublishedRelayList, setIsLoadingPublishedRelayList] =
    useState(false)
  const [publishedRelayListUpdatedAt, setPublishedRelayListUpdatedAt] =
    useState<number | null>(null)
  const [publishingRelayList, setPublishingRelayList] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

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

  function persist(
    update: (current: RelaySettingsState) => RelaySettingsState
  ): void {
    const next = saveRelaySettings(update(settingsRef.current), scope)
    settingsRef.current = next
    setSettings(next)
    refreshNdkRelaySettings(scope)
  }

  function persistImportedPreferences(
    preferences: RelayPreference[],
    source: "published" | "signer"
  ): RelaySettingsState {
    const base =
      source === "published" && !hasManualRelaySettings(settingsRef.current)
        ? createRelaySettingsFromPreferences(preferences, source)
        : mergeRelayPreferencesIntoSettings(
            settingsRef.current,
            preferences,
            source
          )
    const next = saveRelaySettings(base, scope)
    settingsRef.current = next
    setSettings(next)
    refreshNdkRelaySettings(scope)
    return next
  }

  async function scanImportedRelayUrls(urls: readonly string[]): Promise<void> {
    const uniqueUrls = Array.from(new Set(urls))
    if (uniqueUrls.length === 0) return

    setScanningUrls((current) =>
      Array.from(new Set([...current, ...uniqueUrls]))
    )

    try {
      const scanned = await Promise.all(
        uniqueUrls.map(async (url) => {
          const existing = settingsRef.current.entries.find(
            (entry) => entry.url === url
          )
          return scanRelaySettingsEntry(url, {}, existing)
        })
      )
      persist((current) =>
        scanned.reduce(
          (next, entry) => upsertRelaySettingsEntry(next, entry),
          current
        )
      )
    } finally {
      setScanningUrls((current) =>
        current.filter((url) => !uniqueUrls.includes(url))
      )
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadPublishedRelayList(): Promise<void> {
      if (!pubkey) {
        setPublishedRelayListUpdatedAt(null)
        const preferences = await readNip07RelayPreferences()
        if (cancelled || preferences.length === 0) return
        const next = persistImportedPreferences(preferences, "signer")
        void scanImportedRelayUrls(next.entries.map((entry) => entry.url))
        return
      }

      setIsLoadingPublishedRelayList(true)
      try {
        const signerPreferences = await readNip07RelayPreferences()
        const relayListSearchUrls = Array.from(
          new Set([
            ...settingsRef.current.entries
              .filter((entry) => entry.readEnabled)
              .map((entry) => entry.url),
            ...signerPreferences.map((preference) => preference.url),
          ])
        )
        const relayList = await getRelayList(pubkey, {
          skipCache: true,
          relayUrls:
            relayListSearchUrls.length > 0 ? relayListSearchUrls : undefined,
        })
        if (cancelled) return

        if (relayList) {
          setPublishedRelayListUpdatedAt(relayList.eventCreatedAt || null)
          const preferences = mergeNip65RelayUrls({
            readRelayUrls: relayList.readRelayUrls,
            writeRelayUrls: relayList.writeRelayUrls,
          })
          if (preferences.length > 0) {
            const next = persistImportedPreferences(preferences, "published")
            void scanImportedRelayUrls(next.entries.map((entry) => entry.url))
            return
          }
        }

        if (cancelled || signerPreferences.length === 0) return
        const next = persistImportedPreferences(signerPreferences, "signer")
        void scanImportedRelayUrls(next.entries.map((entry) => entry.url))
      } finally {
        if (!cancelled) setIsLoadingPublishedRelayList(false)
      }
    }

    void loadPublishedRelayList()

    return () => {
      cancelled = true
    }
  }, [pubkey, scope])

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
      updateRelaySettingsEntry(current, url, {
        readEnabled: enabled,
        source: "manual",
      })
    )
  }

  function toggleRelayWrite(url: string, enabled: boolean): void {
    setError(null)
    persist((current) =>
      updateRelaySettingsEntry(current, url, {
        writeEnabled: enabled,
        source: "manual",
      })
    )
  }

  function reorderRelay(sourceUrl: string, targetUrl: string): void {
    setError(null)
    persist((current) => reorderCommerceRelay(current, sourceUrl, targetUrl))
  }

  function resetRelaySettings(): void {
    setError(null)
    setPublishError(null)
    const defaults = saveRelaySettings(createDefaultRelaySettings(), scope)
    settingsRef.current = defaults
    setSettings(defaults)
    refreshNdkRelaySettings(scope)
  }

  async function publishRelayList(): Promise<void> {
    setPublishError(null)
    setError(null)

    try {
      if (!pubkey) throw new Error("Connect a signer before publishing relays")

      assertSafeNip65RelayList(settingsRef.current.entries)

      const ndk = await requireNdkConnected()
      if (!ndk.signer) throw new Error("Signer not connected")

      const user = await ndk.signer.user()
      if (user.pubkey !== pubkey) {
        throw new Error("Active signer does not match this relay list")
      }

      const event = new NDKEvent(ndk)
      event.kind = EVENT_KINDS.RELAY_LIST
      event.created_at = Math.floor(Date.now() / 1000)
      event.content = ""
      event.tags = serializeNip65RelayTags(settingsRef.current.entries)

      setPublishingRelayList(true)
      await event.sign(ndk.signer)
      await publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: pubkey,
        skipHealthFilter: true,
      })
      setPublishedRelayListUpdatedAt(event.created_at ?? null)
    } catch (publishListError) {
      const message = getErrorMessage(publishListError)
      setPublishError(message)
      throw publishListError
    } finally {
      setPublishingRelayList(false)
    }
  }

  return {
    settings,
    scanningUrls,
    error,
    isLoadingPublishedRelayList,
    publishedRelayListUpdatedAt,
    publishingRelayList,
    publishError,
    addRelay,
    refreshRelay,
    removeRelay,
    toggleRelayRead,
    toggleRelayWrite,
    reorderRelay,
    resetRelaySettings,
    publishRelayList,
  }
}
