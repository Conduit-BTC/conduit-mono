import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import {
  publishAccountNetworkMutation,
  reorderAccountNetworkRelays,
  retryAccountNetworkMutation,
  reviewAccountNetworkMutation,
  type AccountNetworkMutationDependencies,
  type AccountNetworkRelayRoles,
  type ReviewedAccountNetworkMutation,
} from "../protocol/account-network-mutation"
import { normalizeAccountNetworkPubkey } from "../protocol/account-network-local-state"
import type { AccountNetworkPreferencesReconciliation } from "../protocol/network-preferences"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import { NostrSignerError } from "../protocol/nostr-event-signer"
import {
  assertSafeNip65RelayList,
  createRelaySettingsFromPreferences,
  getPublishableRelaySettingsEntries,
  getRelaySettingsStorageKey,
  hasManualRelaySettings,
  isAccountRelaySettingsScope,
  loadRelaySettings,
  mergeRelayPreferencesIntoSettings,
  mergeNip65RelayUrls,
  readNip07RelayPreferences,
  removeRelaySettingsEntry,
  reorderCommerceRelay,
  RELAY_SETTINGS_STORAGE_VERSION,
  saveRelaySettings,
  scanRelaySettingsEntry,
  subscribeRelaySettingsChanges,
  tryNormalizeRelayUrl,
  updateRelaySettingsEntry,
  upsertRelaySettingsEntry,
  type RelayPreference,
  type RelaySettingsState,
} from "../protocol/relay-settings"
import { getRelayList } from "../protocol/relay-list"
import { EVENT_KINDS } from "../protocol/kinds"
import {
  closeAllProtectedRelayConnections,
  closeProtectedRelayConnectionsForRelay,
  getRelayAuthenticationEvidence,
  subscribeRelayAuthenticationEvidence,
  type RelayAuthEvidenceState,
} from "../protocol/relay-executor"
import { useAuth } from "../context/AuthContext"
import { useConduitSession } from "../context/ConduitSessionContext"

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

interface AccountMutationAuthority {
  authGeneration: number
  method: "nip07" | "nip46" | null
  pubkey: string | null
  relayScope: string | null
  sessionPubkey: string | null
  signer: NDKSigner | null
  status: string
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

/** Legacy view adapter; signed authority stays in the reconciliation model. */
export function createAccountRelaySettingsPresentation(
  reconciliation: AccountNetworkPreferencesReconciliation | null
): RelaySettingsState {
  if (!reconciliation) return createEmptyRelaySettings()
  if (reconciliation.legacyReviewCandidate) {
    return structuredClone(reconciliation.legacyReviewCandidate.draft)
  }
  const positionByUrl = new Map(
    reconciliation.projection.rows.map((row) => [row.url, row.position])
  )
  const preferences = [...reconciliation.ownerRelayList.preferences].sort(
    (left, right) =>
      (positionByUrl.get(left.url) ?? Number.MAX_SAFE_INTEGER) -
        (positionByUrl.get(right.url) ?? Number.MAX_SAFE_INTEGER) ||
      left.url.localeCompare(right.url)
  )
  const settings = createRelaySettingsFromPreferences(preferences, "published")
  settings.updatedAt =
    reconciliation.ownerRelayList.current?.observedAt ??
    reconciliation.ownerRelayList.lookup.observedAt
  return settings
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

function currentInboxRelayUrls(
  reconciliation: AccountNetworkPreferencesReconciliation
): string[] {
  if (reconciliation.inboxDeclaration.state === "distribution_pending") {
    return [...(reconciliation.inboxDeclaration.pendingRelayUrls ?? [])]
  }
  return reconciliation.inboxDeclaration.state === "declared"
    ? [...reconciliation.inboxDeclaration.relayUrls]
    : []
}

function rolesForRelayListReview(
  reconciliation: AccountNetworkPreferencesReconciliation,
  settings: RelaySettingsState
): AccountNetworkRelayRoles[] {
  const rolesByUrl = new Map<string, AccountNetworkRelayRoles>()
  for (const entry of getPublishableRelaySettingsEntries(settings.entries)) {
    rolesByUrl.set(entry.url, {
      url: entry.url,
      read: entry.readEnabled,
      publish: entry.writeEnabled,
      privateInbox: false,
    })
  }
  for (const relayUrl of currentInboxRelayUrls(reconciliation)) {
    const current = rolesByUrl.get(relayUrl)
    rolesByUrl.set(relayUrl, {
      url: relayUrl,
      read: current?.read ?? false,
      publish: current?.publish ?? false,
      privateInbox: true,
    })
  }
  return [...rolesByUrl.values()]
}

/** Review a NIP-65-only edit while preserving the current kind:10050 set. */
export function reviewRelaySettingsAccountMutation(
  reconciliation: AccountNetworkPreferencesReconciliation,
  settings: RelaySettingsState
): ReviewedAccountNetworkMutation {
  const reviewed = reviewAccountNetworkMutation(reconciliation, {
    type: "set_roles",
    relays: rolesForRelayListReview(reconciliation, settings),
  })
  if (
    reviewed.changedKinds.includes(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) ||
    reviewed.signerRequestCount > 1
  ) {
    throw new Error(
      "Private inbox evidence changed. Refresh Network settings before publishing the relay list."
    )
  }
  return reviewed
}

export function shouldRetryRelaySettingsAccountMutation(
  reconciliation: AccountNetworkPreferencesReconciliation,
  reviewed: ReviewedAccountNetworkMutation
): boolean {
  return Boolean(
    reconciliation.ownerRelayList.pendingDistribution &&
    !reviewed.changedKinds.includes(EVENT_KINDS.RELAY_LIST)
  )
}

function sameAccountMutationAuthority(
  current: AccountMutationAuthority,
  expected: AccountMutationAuthority
): boolean {
  return (
    current.authGeneration === expected.authGeneration &&
    current.method === expected.method &&
    current.pubkey === expected.pubkey &&
    current.relayScope === expected.relayScope &&
    current.sessionPubkey === expected.sessionPubkey &&
    current.signer === expected.signer &&
    current.status === expected.status
  )
}

export function useRelaySettings(
  scope?: string | null,
  options: UseRelaySettingsOptions = {}
): UseRelaySettingsResult {
  const auth = useAuth()
  const session = useConduitSession()
  const pubkey = options.pubkey?.trim() || null
  const enabled = options.enabled ?? true
  const bootstrapRelayList = options.bootstrapRelayList ?? true
  const accountScoped = isAccountRelaySettingsScope(scope)
  const normalizedPubkey = pubkey ? normalizeAccountNetworkPubkey(pubkey) : null
  const normalizedAuthenticatedPubkey = auth.pubkey
    ? normalizeAccountNetworkPubkey(auth.pubkey)
    : null
  const ownerRelayListAuthenticatedPubkey =
    auth.status === "connected" &&
    normalizedPubkey !== null &&
    normalizedAuthenticatedPubkey === normalizedPubkey
      ? normalizedPubkey
      : null
  const accountReconciliation = session.accountNetworkPreferences.reconciliation
  const accountContextMatches = Boolean(
    accountScoped &&
    pubkey &&
    session.mode === "signed_in" &&
    session.pubkey === pubkey &&
    session.relayScope === scope?.trim() &&
    (!accountReconciliation ||
      (accountReconciliation.projection.pubkey === pubkey &&
        accountReconciliation.projection.relayScope === scope?.trim()))
  )
  const accountReconciliationRef = useRef(accountReconciliation)
  const authorityRef = useRef<AccountMutationAuthority>({
    authGeneration: auth.authGeneration,
    method: auth.method,
    pubkey: auth.pubkey,
    relayScope: session.relayScope,
    sessionPubkey: session.pubkey,
    signer: auth.signer,
    status: auth.status,
  })
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
    accountScoped
      ? createAccountRelaySettingsPresentation(
          accountContextMatches ? accountReconciliation : null
        )
      : loadRelaySettings(scope)
  )
  const settingsRef = useRef(settings)
  const accountDraftDirtyRef = useRef(false)
  const accountDraftRelayListEventIdRef = useRef<string | null>(
    accountReconciliation?.ownerRelayList.current?.signedEvent.id ?? null
  )
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
    useState(() => {
      const initial = accountScoped
        ? createAccountRelaySettingsPresentation(
            accountContextMatches ? accountReconciliation : null
          )
        : loadRelaySettings(scope)
      return (
        enabled && bootstrapRelayList && !!pubkey && hasNoRelaySettings(initial)
      )
    })
  const [publishedRelayListUpdatedAt, setPublishedRelayListUpdatedAt] =
    useState<number | null>(null)
  const [publishingRelayList, setPublishingRelayList] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [authEvidenceRevision, setAuthEvidenceRevision] = useState(0)
  const contextReady = initializedContextKey === relaySettingsContextKey
  const localSettingsControlConnections = !accountScoped

  useEffect(() => {
    accountReconciliationRef.current = accountReconciliation
  }, [accountReconciliation])

  useEffect(() => {
    authorityRef.current = {
      authGeneration: auth.authGeneration,
      method: auth.method,
      pubkey: auth.pubkey,
      relayScope: session.relayScope,
      sessionPubkey: session.pubkey,
      signer: auth.signer,
      status: auth.status,
    }
  }, [
    auth.authGeneration,
    auth.method,
    auth.pubkey,
    auth.signer,
    auth.status,
    session.pubkey,
    session.relayScope,
  ])

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
    if (
      localSettingsControlConnections &&
      previousContextKeyRef.current !== relaySettingsContextKey
    ) {
      closeAllProtectedRelayConnections()
    }
    previousContextKeyRef.current = relaySettingsContextKey
    currentContextKeyRef.current = relaySettingsContextKey
    setInitializedContextKey(relaySettingsContextKey)
    setScanningUrls([])
    setError(null)
    accountDraftDirtyRef.current = false
    accountDraftRelayListEventIdRef.current =
      accountReconciliationRef.current?.ownerRelayList.current?.signedEvent
        .id ?? null
    if (!enabled) {
      setIsLoadingPublishedRelayList(false)
      return
    }
    if (accountScoped && !accountContextMatches) {
      const next = createEmptyRelaySettings()
      settingsRef.current = next
      setSettings(next)
      setError("The active Network account changed. Reload and try again.")
      setIsLoadingPublishedRelayList(false)
      return
    }

    const loaded = accountScoped
      ? createAccountRelaySettingsPresentation(accountReconciliationRef.current)
      : loadRelaySettings(scope)
    const next = loaded
    settingsRef.current = next
    setSettings(next)
    if (bootstrapRelayList && pubkey && hasNoRelaySettings(loaded)) {
      setIsLoadingPublishedRelayList(true)
    } else {
      setIsLoadingPublishedRelayList(false)
    }
  }, [
    accountContextMatches,
    accountScoped,
    bootstrapRelayList,
    enabled,
    pubkey,
    relaySettingsContextKey,
    localSettingsControlConnections,
    scope,
  ])

  useEffect(() => {
    if (!accountScoped || !enabled || !contextReady || !accountReconciliation) {
      return
    }
    if (
      accountReconciliation.projection.pubkey !== pubkey ||
      accountReconciliation.projection.relayScope !== scope?.trim()
    ) {
      return
    }
    const nextEventId =
      accountReconciliation.ownerRelayList.current?.signedEvent.id ?? null
    if (
      accountDraftDirtyRef.current &&
      accountDraftRelayListEventIdRef.current === nextEventId
    ) {
      return
    }
    const evidenceChangedWhileEditing = accountDraftDirtyRef.current
    const next = createAccountRelaySettingsPresentation(accountReconciliation)
    accountDraftDirtyRef.current = false
    accountDraftRelayListEventIdRef.current = nextEventId
    settingsRef.current = next
    setSettings(next)
    setPublishedRelayListUpdatedAt(
      accountReconciliation.ownerRelayList.current?.signedEvent.created_at ??
        null
    )
    if (evidenceChangedWhileEditing) {
      setError(
        "The published relay list changed while you were editing. Review the refreshed settings and try again."
      )
    }
  }, [
    accountReconciliation,
    accountScoped,
    contextReady,
    enabled,
    pubkey,
    scope,
  ])

  useEffect(() => {
    if (!enabled || !contextReady) return
    if (typeof window === "undefined") return
    if (accountScoped) return

    const storageKey = getRelaySettingsStorageKey(scope)
    function handleStorage(event: StorageEvent): void {
      if (event.key !== storageKey) return
      const next = loadRelaySettings(scope)
      settingsRef.current = next
      setSettings(next)
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [accountScoped, contextReady, enabled, pubkey, scope])

  useEffect(() => {
    if (!enabled || !contextReady) return
    if (accountScoped) return
    return subscribeRelaySettingsChanges((changedScope) => {
      const targetScope = scope?.trim() || null
      if (changedScope !== targetScope) return
      const next = loadRelaySettings(scope)
      settingsRef.current = next
      setSettings(next)
    })
  }, [accountScoped, contextReady, enabled, pubkey, scope])

  const persist = useCallback(
    (update: (current: RelaySettingsState) => RelaySettingsState): void => {
      const updated = update(settingsRef.current)
      const next = accountScoped
        ? { ...updated, updatedAt: Date.now() }
        : saveRelaySettings(updated, scope)
      if (accountScoped) {
        if (!accountDraftDirtyRef.current) {
          accountDraftRelayListEventIdRef.current =
            accountReconciliationRef.current?.ownerRelayList.current
              ?.signedEvent.id ?? null
        }
        accountDraftDirtyRef.current = true
      }
      settingsRef.current = next
      setSettings(next)
    },
    [accountScoped, scope]
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
      const next = accountScoped
        ? { ...base, updatedAt: Date.now() }
        : saveRelaySettings(base, scope)
      if (accountScoped) accountDraftDirtyRef.current = true
      settingsRef.current = next
      setSettings(next)
      return next
    },
    [accountScoped, scope]
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
    if (accountScoped && !accountReconciliation?.legacyReviewCandidate) {
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
  }, [
    accountScoped,
    accountReconciliation,
    contextReady,
    enabled,
    scanImportedRelayUrls,
    scope,
    settings.entries,
  ])

  useEffect(() => {
    if (!enabled || !bootstrapRelayList || !contextReady) return
    // Signed-in account reconciliation is owned by the session hook. This
    // compatibility hook may present that projection, but must not copy it or
    // signer preferences into an authoritative-looking local draft.
    if (accountScoped) {
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
          authenticatedPubkey: ownerRelayListAuthenticatedPubkey,
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
          authenticatedPubkey: ownerRelayListAuthenticatedPubkey,
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
    accountScoped,
    contextReady,
    enabled,
    ownerRelayListAuthenticatedPubkey,
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
    const next = reorderCommerceRelay(settingsRef.current, sourceUrl, targetUrl)
    persist(() => next)
    if (!accountScoped || !pubkey) return
    if (
      session.mode !== "signed_in" ||
      session.pubkey !== pubkey ||
      session.relayScope !== scope?.trim()
    ) {
      setError("The active Network account changed. Reload and try again.")
      return
    }
    const preferredRelayOrder = [
      ...next.entries
        .filter((entry) => entry.section === "commerce")
        .sort((left, right) => {
          return (
            (left.commercePriority ?? Number.MAX_SAFE_INTEGER) -
            (right.commercePriority ?? Number.MAX_SAFE_INTEGER)
          )
        }),
      ...next.entries.filter((entry) => entry.section !== "commerce"),
    ].map((entry) => entry.url)
    const reorderContextKey = relaySettingsContextKey
    void reorderAccountNetworkRelays({
      pubkey,
      relayUrls: preferredRelayOrder,
    })
      .then(() => {
        if (currentContextKeyRef.current === reorderContextKey) {
          session.accountNetworkPreferences.refetch()
        }
      })
      .catch((reorderError: unknown) => {
        if (currentContextKeyRef.current === reorderContextKey) {
          setError(getErrorMessage(reorderError))
        }
      })
  }

  function resetRelaySettings(): void {
    setError(null)
    setPublishError(null)
    if (localSettingsControlConnections) {
      closeAllProtectedRelayConnections()
    }
    persist(() => createEmptyRelaySettings())
  }

  function restoreDefaultRelaySettings(): void {
    setError(null)
    setPublishError(null)
    if (localSettingsControlConnections) {
      closeAllProtectedRelayConnections()
    }
    persist(() => createEmptyRelaySettings())
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
      if (!accountScoped) {
        throw new Error(
          "Published relay lists require signed-in account Network settings."
        )
      }
      const accountNetworkPreferences = session.accountNetworkPreferences
      const reconciliation = accountNetworkPreferences.reconciliation
      if (
        session.mode !== "signed_in" ||
        session.pubkey !== pubkey ||
        session.relayScope !== scope?.trim() ||
        reconciliation?.projection.pubkey !== pubkey ||
        reconciliation.projection.relayScope !== scope?.trim()
      ) {
        throw new Error(
          "The active Network account changed. Reload and try again."
        )
      }
      if (accountNetworkPreferences.status !== "ready") {
        throw new Error(
          "Network evidence is still refreshing. Wait for the current account check and try again."
        )
      }

      const publishableEntries = getPublishableRelaySettingsEntries(
        settingsRef.current.entries
      )
      if (publishableEntries.length === 0) {
        throw new Error(
          "Choose relays for your published NIP-65 list first. Conduit app fallback relays are not part of your personal relay list."
        )
      }

      assertSafeNip65RelayList(publishableEntries)
      const reviewed = reviewRelaySettingsAccountMutation(
        reconciliation,
        settingsRef.current
      )
      const expectedAuthority = { ...authorityRef.current }
      const shouldContinue = (): boolean =>
        currentContextKeyRef.current === relaySettingsContextKey &&
        sameAccountMutationAuthority(authorityRef.current, expectedAuthority)
      if (
        expectedAuthority.status !== "connected" ||
        expectedAuthority.pubkey !== pubkey ||
        expectedAuthority.sessionPubkey !== pubkey ||
        expectedAuthority.relayScope !== scope?.trim()
      ) {
        throw new NostrSignerError("authority_changed")
      }
      const dependencies: AccountNetworkMutationDependencies = {
        shouldContinue,
      }
      const retryExactPending = shouldRetryRelaySettingsAccountMutation(
        reconciliation,
        reviewed
      )
      const result = retryExactPending
        ? await retryAccountNetworkMutation({
            pubkey,
            authenticatedPubkey: pubkey,
            kind: EVENT_KINDS.RELAY_LIST,
            dependencies,
          })
        : await publishAccountNetworkMutation({
            reviewed,
            authenticatedPubkey: pubkey,
            ...(reviewed.signerRequestCount > 0
              ? {
                  signer:
                    expectedAuthority.signer && expectedAuthority.method
                      ? createNdkNostrEventSigner(
                          expectedAuthority.signer,
                          pubkey,
                          expectedAuthority.method
                        )
                      : undefined,
                }
              : {}),
            dependencies,
          })
      if (!shouldContinue()) throw new NostrSignerError("authority_changed")
      const relayListCheckpoint = result.checkpoints.find(
        (checkpoint) => checkpoint.kind === EVENT_KINDS.RELAY_LIST
      )
      accountDraftDirtyRef.current = false
      accountDraftRelayListEventIdRef.current =
        relayListCheckpoint?.signedEvent.id ??
        reconciliation.ownerRelayList.current?.signedEvent.id ??
        null
      setPublishedRelayListUpdatedAt(
        relayListCheckpoint?.signedEvent.created_at ??
          reconciliation.ownerRelayList.current?.signedEvent.created_at ??
          null
      )
    } catch (publishListError) {
      const message = getErrorMessage(publishListError)
      setPublishError(message)
      throw publishListError
    } finally {
      if (accountScoped) session.accountNetworkPreferences.refetch()
      setPublishingRelayList(false)
    }
  }

  const presentation = prepareRelaySettingsContextPresentation(
    settings,
    authEvidenceByUrl,
    contextReady && (!accountScoped || accountContextMatches)
  )
  if (!contextReady || (accountScoped && !accountContextMatches)) {
    const noop = () => undefined
    const noopAsync = async () => undefined
    return {
      ...presentation,
      scanningUrls: [],
      error:
        accountScoped && !accountContextMatches
          ? "The active Network account changed. Reload and try again."
          : null,
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
