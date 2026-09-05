import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  assertSafeNip65RelayList,
  canRelaySettingsChangeControlRuntime,
  createRelaySettingsFromPreferences,
  getPublishableRelaySettingsEntries,
  getRelaySettingsStorageKey,
  hasRelaySettingsDraft,
  hasManualRelaySettings,
  isAccountRelaySettingsScope,
  loadRelaySettings,
  loadRelaySettingsPresentation,
  mergeRelayPreferencesIntoSettings,
  mergeNip65RelayUrls,
  readNip07RelayPreferences,
  removeRelaySettingsEntry,
  reorderCommerceRelay,
  RELAY_SETTINGS_STORAGE_VERSION,
  saveRelaySettings,
  scanRelaySettingsEntry,
  serializeNip65RelayTags,
  subscribeRelaySettingsChanges,
  tryNormalizeRelayUrl,
  updateRelaySettingsEntry,
  upsertRelaySettingsEntry,
  type RelayPreference,
  type RelaySettingsState,
} from "../protocol/relay-settings"
import { getRelayList } from "../protocol/relay-list"
import { EVENT_KINDS } from "../protocol/kinds"
import { getNdk } from "../protocol/ndk"
import { publishWithPlanner } from "../protocol/relay-publish"
import {
  closeAllProtectedRelayConnections,
  closeProtectedRelayConnectionsForRelay,
  getRelayAuthenticationEvidence,
  subscribeRelayAuthenticationEvidence,
  type RelayAuthEvidenceState,
} from "../protocol/relay-executor"

export type RelayAuthDisplayEvidence = RelayAuthEvidenceState | "advertised"

export function resolveRelayAuthDisplayEvidence(
  runtime: RelayAuthEvidenceState | undefined,
  advertised: boolean
): RelayAuthDisplayEvidence {
  if (runtime && runtime !== "untested") return runtime
  if (advertised) return "advertised"
  return runtime ?? "untested"
}

export interface UseRelaySettingsOptions {
  pubkey?: string | null
  enabled?: boolean
  bootstrapRelayList?: boolean
}

export interface UseRelaySettingsResult {
  settings: RelaySettingsState
  authEvidenceByUrl: Readonly<Record<string, RelayAuthDisplayEvidence>>
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
  restoreDefaultRelaySettings: () => void
  includeDefaultRelays: () => void
  publishRelayList: () => Promise<void>
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update relays"
}

function removeScanningUrl(urls: readonly string[], url: string): string[] {
  return urls.filter((item) => item !== url)
}

function createEmptyRelaySettings(): RelaySettingsState {
  return {
    version: RELAY_SETTINGS_STORAGE_VERSION,
    entries: [],
    updatedAt: Date.now(),
  }
}

export function prepareRelaySettingsContextPresentation(
  settings: RelaySettingsState,
  authEvidenceByUrl: Readonly<Record<string, RelayAuthDisplayEvidence>>,
  contextReady: boolean
): Pick<UseRelaySettingsResult, "settings" | "authEvidenceByUrl"> {
  if (contextReady) return { settings, authEvidenceByUrl }
  return {
    settings: createEmptyRelaySettings(),
    authEvidenceByUrl: {},
  }
}

function hasNoRelaySettings(settings: RelaySettingsState): boolean {
  return settings.entries.length === 0
}

export function useRelaySettings(
  scope?: string | null,
  options: UseRelaySettingsOptions = {}
): UseRelaySettingsResult {
  const pubkey = options.pubkey?.trim() || null
  const enabled = options.enabled ?? true
  const bootstrapRelayList = options.bootstrapRelayList ?? true
  const relaySettingsContextKey = JSON.stringify([
    enabled,
    bootstrapRelayList,
    pubkey,
    scope?.trim() || null,
  ])
  const currentContextKeyRef = useRef(relaySettingsContextKey)
  const previousContextKeyRef = useRef(relaySettingsContextKey)
  const [initializedContextKey, setInitializedContextKey] = useState(
    relaySettingsContextKey
  )
  const [settings, setSettings] = useState<RelaySettingsState>(() =>
    loadRelaySettingsPresentation(scope)
  )
  const settingsRef = useRef(settings)
  const previousReadableRelayUrlsRef = useRef(
    new Set(
      settings.entries
        .filter((entry) => entry.readEnabled)
        .map((entry) => entry.url)
    )
  )
  const autoScannedStaleKeyRef = useRef("")
  const [scanningUrls, setScanningUrls] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isLoadingPublishedRelayList, setIsLoadingPublishedRelayList] =
    useState(
      enabled &&
        bootstrapRelayList &&
        !!pubkey &&
        hasNoRelaySettings(loadRelaySettingsPresentation(scope))
    )
  const [publishedRelayListUpdatedAt, setPublishedRelayListUpdatedAt] =
    useState<number | null>(null)
  const [publishingRelayList, setPublishingRelayList] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [authEvidenceRevision, setAuthEvidenceRevision] = useState(0)
  const contextReady = initializedContextKey === relaySettingsContextKey
  const localSettingsControlConnections = canRelaySettingsChangeControlRuntime(
    scope,
    "local_draft"
  )

  useEffect(
    () =>
      subscribeRelayAuthenticationEvidence(() =>
        setAuthEvidenceRevision((current) => current + 1)
      ),
    []
  )

  const authEvidenceByUrl = useMemo<
    Readonly<Record<string, RelayAuthDisplayEvidence>>
  >(() => {
    void authEvidenceRevision
    if (!contextReady) return {}
    return Object.fromEntries(
      settings.entries.map((entry) => {
        const runtime =
          enabled && pubkey
            ? getRelayAuthenticationEvidence(entry.url, pubkey)
            : undefined
        const advertised =
          entry.observations?.auth.status === "advertised" ||
          entry.capabilities.auth
        const state = resolveRelayAuthDisplayEvidence(runtime, advertised)
        return [entry.url, state] as const
      })
    )
  }, [authEvidenceRevision, contextReady, enabled, pubkey, settings.entries])

  useEffect(() => {
    const nextReadable = new Set(
      settings.entries
        .filter((entry) => entry.readEnabled)
        .map((entry) => entry.url)
    )
    if (localSettingsControlConnections) {
      for (const relayUrl of previousReadableRelayUrlsRef.current) {
        if (!nextReadable.has(relayUrl)) {
          closeProtectedRelayConnectionsForRelay(relayUrl)
        }
      }
    }
    previousReadableRelayUrlsRef.current = nextReadable
  }, [localSettingsControlConnections, settings.entries])

  useEffect(() => {
    if (previousContextKeyRef.current !== relaySettingsContextKey) {
      closeAllProtectedRelayConnections()
      previousContextKeyRef.current = relaySettingsContextKey
    }
    currentContextKeyRef.current = relaySettingsContextKey
    setInitializedContextKey(relaySettingsContextKey)
    setScanningUrls([])
    setError(null)
    if (!enabled) {
      setIsLoadingPublishedRelayList(false)
      return
    }

    const loaded = loadRelaySettingsPresentation(scope)
    const next = loaded
    settingsRef.current = next
    setSettings(next)
    if (bootstrapRelayList && pubkey && hasNoRelaySettings(loaded)) {
      setIsLoadingPublishedRelayList(true)
    } else {
      setIsLoadingPublishedRelayList(false)
    }
  }, [bootstrapRelayList, enabled, pubkey, relaySettingsContextKey, scope])

  useEffect(() => {
    if (!enabled || !contextReady) return
    if (typeof window === "undefined") return

    const storageKey = getRelaySettingsStorageKey(scope)
    function handleStorage(event: StorageEvent): void {
      if (event.key !== storageKey) return
      const next = loadRelaySettingsPresentation(scope)
      settingsRef.current = next
      setSettings(next)
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [contextReady, enabled, pubkey, scope])

  useEffect(() => {
    if (!enabled || !contextReady) return
    return subscribeRelaySettingsChanges((changedScope) => {
      const targetScope = scope?.trim() || null
      if (changedScope !== targetScope) return
      const next = loadRelaySettingsPresentation(scope)
      settingsRef.current = next
      setSettings(next)
    })
  }, [contextReady, enabled, pubkey, scope])

  const persist = useCallback(
    (update: (current: RelaySettingsState) => RelaySettingsState): void => {
      const next = saveRelaySettings(update(settingsRef.current), scope)
      settingsRef.current = next
      setSettings(next)
    },
    [scope]
  )

  const persistImportedPreferences = useCallback(
    (
      preferences: RelayPreference[],
      source: "published" | "signer"
    ): RelaySettingsState => {
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
      return next
    },
    [scope]
  )

  const scanImportedRelayUrls = useCallback(
    async (urls: readonly string[]): Promise<void> => {
      const operationContextKey = relaySettingsContextKey
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
        if (currentContextKeyRef.current !== operationContextKey) return
        persist((current) =>
          scanned.reduce(
            (next, entry) => upsertRelaySettingsEntry(next, entry),
            current
          )
        )
      } finally {
        if (currentContextKeyRef.current === operationContextKey) {
          setScanningUrls((current) =>
            current.filter((url) => !uniqueUrls.includes(url))
          )
        }
      }
    },
    [persist, relaySettingsContextKey]
  )

  useEffect(() => {
    if (!enabled || !contextReady) return
    if (isAccountRelaySettingsScope(scope) && !hasRelaySettingsDraft(scope)) {
      return
    }

    const staleUrls = settings.entries
      .filter((entry) => entry.warnings.staleRelayInfo)
      .map((entry) => entry.url)
      .sort()

    if (staleUrls.length === 0) return

    const staleKey = staleUrls.join("|")
    if (staleKey === autoScannedStaleKeyRef.current) return
    autoScannedStaleKeyRef.current = staleKey

    void scanImportedRelayUrls(staleUrls)
  }, [contextReady, enabled, scanImportedRelayUrls, scope, settings.entries])

  useEffect(() => {
    if (!enabled || !bootstrapRelayList || !contextReady) return
    // Signed-in account reconciliation is owned by the session hook. This
    // compatibility hook may present that projection, but must not copy it or
    // signer preferences into an authoritative-looking local draft.
    if (isAccountRelaySettingsScope(scope)) {
      setIsLoadingPublishedRelayList(false)
      return
    }
    let cancelled = false

    async function loadPublishedRelayList(): Promise<void> {
      if (!pubkey) {
        setPublishedRelayListUpdatedAt(null)
        setIsLoadingPublishedRelayList(false)
        return
      }

      setIsLoadingPublishedRelayList(true)
      try {
        const signerPreferences = await readNip07RelayPreferences()
        if (cancelled) return

        if (signerPreferences.length > 0) {
          const next = persistImportedPreferences(signerPreferences, "signer")
          void scanImportedRelayUrls(next.entries.map((entry) => entry.url))
        }

        const cachedRelayList = await getRelayList(pubkey, {
          cacheOnly: true,
          allowInsecureRelayUrlsForPubkey: pubkey,
        })
        if (cancelled) return

        if (cachedRelayList) {
          setPublishedRelayListUpdatedAt(cachedRelayList.eventCreatedAt || null)
          const cachedPreferences = mergeNip65RelayUrls({
            readRelayUrls: cachedRelayList.readRelayUrls,
            writeRelayUrls: cachedRelayList.writeRelayUrls,
          })
          if (cachedPreferences.length > 0) {
            const next = persistImportedPreferences(
              cachedPreferences,
              "published"
            )
            void scanImportedRelayUrls(next.entries.map((entry) => entry.url))
          }
        }

        const relayListSearchUrls = Array.from(
          new Set([
            ...loadRelaySettings(scope)
              .entries.filter((entry) => entry.readEnabled)
              .map((entry) => entry.url),
            ...signerPreferences.map((preference) => preference.url),
          ])
        )
        const relayList = await getRelayList(pubkey, {
          skipCache: true,
          allowInsecureRelayUrlsForPubkey: pubkey,
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
      } finally {
        if (!cancelled) setIsLoadingPublishedRelayList(false)
      }
    }

    void loadPublishedRelayList()

    return () => {
      cancelled = true
    }
  }, [
    bootstrapRelayList,
    contextReady,
    enabled,
    persistImportedPreferences,
    pubkey,
    scanImportedRelayUrls,
    scope,
  ])

  async function addRelay(url: string): Promise<void> {
    const operationContextKey = relaySettingsContextKey
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
      if (currentContextKeyRef.current !== operationContextKey) return
      persist((current) => upsertRelaySettingsEntry(current, scanned))
    } catch (scanError) {
      if (currentContextKeyRef.current !== operationContextKey) return
      setError(getErrorMessage(scanError))
    } finally {
      if (currentContextKeyRef.current === operationContextKey) {
        setScanningUrls((current) => removeScanningUrl(current, scanningKey))
      }
    }
  }

  async function refreshRelay(url: string): Promise<void> {
    const operationContextKey = relaySettingsContextKey
    setError(null)
    const existing = settingsRef.current.entries.find(
      (entry) => entry.url === url
    )

    try {
      setScanningUrls((current) =>
        current.includes(url) ? current : [...current, url]
      )
      const scanned = await scanRelaySettingsEntry(url, {}, existing)
      if (currentContextKeyRef.current !== operationContextKey) return
      persist((current) => upsertRelaySettingsEntry(current, scanned))
    } catch (scanError) {
      if (currentContextKeyRef.current !== operationContextKey) return
      setError(getErrorMessage(scanError))
    } finally {
      if (currentContextKeyRef.current === operationContextKey) {
        setScanningUrls((current) => removeScanningUrl(current, url))
      }
    }
  }

  function removeRelay(url: string): void {
    setError(null)
    if (localSettingsControlConnections) {
      closeProtectedRelayConnectionsForRelay(url)
    }
    persist((current) => removeRelaySettingsEntry(current, url))
  }

  function toggleRelayRead(url: string, enabled: boolean): void {
    setError(null)
    if (!enabled && localSettingsControlConnections) {
      closeProtectedRelayConnectionsForRelay(url)
    }
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
    if (localSettingsControlConnections) {
      closeAllProtectedRelayConnections()
    }
    const next = saveRelaySettings(createEmptyRelaySettings(), scope)
    settingsRef.current = next
    setSettings(next)
  }

  function restoreDefaultRelaySettings(): void {
    setError(null)
    setPublishError(null)
    if (localSettingsControlConnections) {
      closeAllProtectedRelayConnections()
    }
    const next = saveRelaySettings(createEmptyRelaySettings(), scope)
    settingsRef.current = next
    setSettings(next)
  }

  function includeDefaultRelays(): void {
    setError(null)
    setPublishError(null)
    persist((current) => current)
  }

  async function publishRelayList(): Promise<void> {
    setPublishError(null)
    setError(null)
    setPublishingRelayList(true)

    try {
      if (!pubkey) throw new Error("Connect a signer before publishing relays")

      const publishableEntries = getPublishableRelaySettingsEntries(
        settingsRef.current.entries
      )
      if (publishableEntries.length === 0) {
        throw new Error(
          "Choose relays for your published NIP-65 list first. Conduit app fallback relays are not part of your personal relay list."
        )
      }

      assertSafeNip65RelayList(publishableEntries)

      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Signer not connected")

      const user = await ndk.signer.user()
      if (user.pubkey !== pubkey) {
        throw new Error("Active signer does not match this relay list")
      }

      const event = new NDKEvent(ndk)
      event.kind = EVENT_KINDS.RELAY_LIST
      event.created_at = Math.floor(Date.now() / 1000)
      event.content = ""
      event.tags = serializeNip65RelayTags(publishableEntries)

      await event.sign(ndk.signer)
      if (!event.sig?.trim()) {
        throw new Error("Signer did not return a signature")
      }
      await publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: pubkey,
        authenticatedPubkey: pubkey,
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

  const presentation = prepareRelaySettingsContextPresentation(
    settings,
    authEvidenceByUrl,
    contextReady
  )
  if (!contextReady) {
    const noop = () => undefined
    const noopAsync = async () => undefined
    return {
      ...presentation,
      scanningUrls: [],
      error: null,
      isLoadingPublishedRelayList: true,
      publishedRelayListUpdatedAt: null,
      publishingRelayList: false,
      publishError: null,
      addRelay: noopAsync,
      refreshRelay: noopAsync,
      removeRelay: noop,
      toggleRelayRead: noop,
      toggleRelayWrite: noop,
      reorderRelay: noop,
      resetRelaySettings: noop,
      restoreDefaultRelaySettings: noop,
      includeDefaultRelays: noop,
      publishRelayList: noopAsync,
    }
  }

  return {
    ...presentation,
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
    restoreDefaultRelaySettings,
    includeDefaultRelays,
    publishRelayList,
  }
}
