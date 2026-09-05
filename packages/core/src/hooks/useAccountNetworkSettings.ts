import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import {
  useAuth,
  type AuthMethod,
  type AuthStatus,
} from "../context/AuthContext"
import { useConduitSession } from "../context/ConduitSessionContext"
import {
  buildAccountNetworkSettingsView,
  createCandidateNetworkRelayRow,
  prepareAccountNetworkSetRolesAction,
  prepareConduitRelayRecommendation,
  validateAccountNetworkDesiredRoles,
  type AccountNetworkDesiredRelayRoles,
  type AccountNetworkRelayRowView,
  type AccountNetworkRole,
  type AccountNetworkSettingsView,
} from "../protocol/network-settings-view"
import {
  publishAccountNetworkPreferenceUpdate,
  retryAccountNetworkPreferenceUpdate,
  reviewAccountNetworkPreferences,
} from "../protocol/network-preference-updates"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import {
  getRelayAuthenticationEvidence,
  subscribeRelayAuthenticationEvidence,
} from "../protocol/relay-executor"
import {
  loadRelaySettings,
  scanRelaySettingsEntry,
  tryNormalizeRelayUrl,
  type RelaySettingsEntry,
} from "../protocol/relay-settings"
import {
  inboxDeclarationPublishRelayUrls,
  readRetainedInboxDeclarationEvidence,
  sharedInboxDiscoveryRelayUrls,
} from "../protocol/private-message-routing"
import {
  redistributePrivateMessageRelayDeclaration,
  redistributePrivateMessageRelayDeclarationAcrossPlans,
} from "../protocol/messaging"
import { getNdk } from "../protocol/ndk"
import { useMediaServerPreferences } from "./useMediaServerPreferences"

export type AccountNetworkSettingsOperationPhase =
  | "idle"
  | "checking"
  | "awaiting_signatures"
  | "staging"
  | "publishing"
  | "confirming"
  | "complete"
  | "error"

export type AccountNetworkSettingsOperationKind =
  "save" | "remove" | "conduit_relay" | "retry" | "redistribute" | null

export interface AccountNetworkSettingsOperationView {
  kind: AccountNetworkSettingsOperationKind
  phase: AccountNetworkSettingsOperationPhase
  message: string | null
}

export interface AccountNetworkMediaServerController {
  view: ReturnType<typeof useMediaServerPreferences>["view"]
  onAddServer: ReturnType<typeof useMediaServerPreferences>["addServer"]
  onRemoveServer: ReturnType<typeof useMediaServerPreferences>["removeServer"]
  onMoveServer: ReturnType<typeof useMediaServerPreferences>["moveServer"]
  onPublish: ReturnType<typeof useMediaServerPreferences>["publish"]
  onRetryPublish: ReturnType<typeof useMediaServerPreferences>["retryPublish"]
  onRetryLookup: ReturnType<typeof useMediaServerPreferences>["refetch"]
}

export interface AccountNetworkSettingsController {
  view: AccountNetworkSettingsView
  operation: AccountNetworkSettingsOperationView
  exactInboxRedistributionAvailable: boolean
  mediaServers: AccountNetworkMediaServerController | null
  addRelay: (url: string) => Promise<AccountNetworkRelayRowView>
  refreshRelay: (
    row: AccountNetworkRelayRowView
  ) => Promise<AccountNetworkRelayRowView>
  save: (rows: readonly AccountNetworkDesiredRelayRoles[]) => Promise<void>
  addConduitRelay: () => Promise<void>
  removeRelay: (relayUrl: string) => Promise<void>
  retryPendingUpdate: () => Promise<void>
  redistributeExactInboxDeclaration: () => Promise<void>
  retryReconciliation: () => void
  clearOperation: () => void
}

interface AuthFenceSnapshot {
  status: AuthStatus
  pubkey: string
  signer: NDKSigner
  method: AuthMethod
  generation: number
}

const EMPTY_RELAY_CAPABILITY_EVIDENCE: Record<string, RelaySettingsEntry> = {}

function readRetainedRelayCapabilityEvidence(
  scope: string | null
): Record<string, RelaySettingsEntry> {
  // Legacy relay settings are read only for their labelled capability evidence.
  // Their role toggles and order never participate in the signed account view.
  return Object.fromEntries(
    loadRelaySettings(scope).entries.map((entry) => [entry.url, entry])
  )
}

function operationErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Network action could not be completed."
}

function hasActiveInboxCheckpoint(view: AccountNetworkSettingsView): boolean {
  return view.pendingCheckpoints.some(
    (checkpoint) =>
      checkpoint.kind === 10050 && checkpoint.state !== "superseded"
  )
}

function canRedistributeExactInbox(
  view: AccountNetworkSettingsView,
  reconciliation: ReturnType<
    typeof useConduitSession
  >["accountNetworkPreferences"]["reconciliation"]
): boolean {
  if (!reconciliation || view.pendingStatus === "unavailable") return false
  if (hasActiveInboxCheckpoint(view)) return false
  const inbox = reconciliation.inboxDeclaration
  if (!inbox.eventId) return false
  if (
    inbox.state === "distribution_pending" &&
    (inbox.pendingPublishRelayUrls?.length ?? 0) > 0
  ) {
    return true
  }
  return Boolean(
    inbox.state === "declared" &&
    inbox.stale &&
    inbox.observation?.coverage === "complete" &&
    inbox.observation.eventId === undefined
  )
}

export function useAccountNetworkSettings(): AccountNetworkSettingsController {
  const auth = useAuth()
  const session = useConduitSession()
  const accountPreferences = session.accountNetworkPreferences
  const [operation, setOperation] =
    useState<AccountNetworkSettingsOperationView>({
      kind: null,
      phase: "idle",
      message: null,
    })
  const [transientUpdate, setTransientUpdate] = useState<NonNullable<
    NonNullable<typeof accountPreferences.reconciliation>["pendingUpdate"]
  > | null>(null)
  const [capabilityEvidence, setCapabilityEvidence] = useState(() => ({
    scope: session.relayScope,
    entries: readRetainedRelayCapabilityEvidence(session.relayScope),
  }))
  const capabilityEntries =
    capabilityEvidence.scope === session.relayScope
      ? capabilityEvidence.entries
      : EMPTY_RELAY_CAPABILITY_EVIDENCE
  const [authEvidenceRevision, setAuthEvidenceRevision] = useState(0)
  const authRef = useRef(auth)

  useLayoutEffect(() => {
    authRef.current = auth
  }, [auth])

  useEffect(
    () =>
      subscribeRelayAuthenticationEvidence(() =>
        setAuthEvidenceRevision((current) => current + 1)
      ),
    []
  )

  useEffect(() => {
    setTransientUpdate(null)
    setCapabilityEvidence({
      scope: session.relayScope,
      entries: readRetainedRelayCapabilityEvidence(session.relayScope),
    })
    setOperation({ kind: null, phase: "idle", message: null })
  }, [auth.pubkey, auth.authGeneration, session.relayScope])

  useEffect(() => {
    if (!transientUpdate) return
    const reconciled = accountPreferences.reconciliation?.pendingUpdate
    if (
      reconciled?.updateId === transientUpdate.updateId ||
      (reconciled && reconciled.updatedAt >= transientUpdate.updatedAt)
    ) {
      setTransientUpdate(null)
    }
  }, [accountPreferences.reconciliation?.pendingUpdate, transientUpdate])

  const authEvidenceByUrl = useMemo(() => {
    void authEvidenceRevision
    if (!auth.pubkey) return {}
    const urls = new Set([
      ...(accountPreferences.reconciliation?.projection.rows.map(
        (row) => row.url
      ) ?? []),
      ...Object.keys(capabilityEntries),
    ])
    return Object.fromEntries(
      [...urls].map((url) => [
        url,
        getRelayAuthenticationEvidence(url, auth.pubkey!),
      ])
    )
  }, [
    accountPreferences.reconciliation?.projection.rows,
    auth.pubkey,
    authEvidenceRevision,
    capabilityEntries,
  ])

  const view = useMemo(
    () =>
      buildAccountNetworkSettingsView({
        accountPubkey:
          auth.status === "connected" ? (auth.pubkey?.trim() ?? null) : null,
        status: accountPreferences.status,
        reconciliation: accountPreferences.reconciliation,
        error: accountPreferences.error,
        capabilityEntries: Object.values(capabilityEntries),
        authEvidenceByUrl,
        transientUpdate,
      }),
    [
      accountPreferences.error,
      accountPreferences.reconciliation,
      accountPreferences.status,
      auth.pubkey,
      auth.status,
      authEvidenceByUrl,
      capabilityEntries,
      transientUpdate,
    ]
  )

  const mediaServerPreferences = useMediaServerPreferences(auth.pubkey, {
    enabled: session.relaySettingsReady,
    signer: auth.signer,
    authMethod: auth.method,
    authGeneration: auth.authGeneration,
    relayScope: session.relayScope,
  })

  const captureAuth = useCallback((): AuthFenceSnapshot => {
    if (
      auth.status !== "connected" ||
      !auth.pubkey ||
      !auth.signer ||
      !auth.method
    ) {
      throw new Error(
        "Connect a NIP-07 or NIP-46 signer to update Network preferences."
      )
    }
    return {
      status: auth.status,
      pubkey: auth.pubkey.trim().toLowerCase(),
      signer: auth.signer,
      method: auth.method,
      generation: auth.authGeneration,
    }
  }, [auth.authGeneration, auth.method, auth.pubkey, auth.signer, auth.status])

  const fenceFor = useCallback((snapshot: AuthFenceSnapshot) => {
    return () => {
      const current = authRef.current
      return (
        current.status === snapshot.status &&
        current.pubkey?.trim().toLowerCase() === snapshot.pubkey &&
        current.signer === snapshot.signer &&
        current.method === snapshot.method &&
        current.authGeneration === snapshot.generation
      )
    }
  }, [])

  const runUpdate = useCallback(
    async (
      kind: "save" | "remove" | "conduit_relay",
      action: Parameters<
        typeof publishAccountNetworkPreferenceUpdate
      >[0]["action"]
    ): Promise<void> => {
      const reconciliation = accountPreferences.reconciliation
      if (!reconciliation || accountPreferences.status !== "ready") {
        throw new Error("Finish the fresh Network check before making changes.")
      }
      if (reconciliation.pendingUpdateStatus === "unavailable") {
        throw new Error(
          "Signed retry storage is unavailable. Check again before staging a Network update."
        )
      }
      const snapshot = captureAuth()
      setOperation({ kind, phase: "checking", message: null })
      try {
        const result = await publishAccountNetworkPreferenceUpdate({
          pubkey: snapshot.pubkey,
          action,
          signer: createNdkNostrEventSigner(
            snapshot.signer,
            snapshot.pubkey,
            snapshot.method
          ),
          reviewed: reviewAccountNetworkPreferences(reconciliation),
          dependencies: {
            shouldContinue: fenceFor(snapshot),
            onPhase: (phase) => setOperation({ kind, phase, message: null }),
          },
        })
        setTransientUpdate(result.update)
        const allConfirmed =
          result.checkpoints.length > 0 &&
          result.checkpoints.every(
            (checkpoint) =>
              checkpoint.state === "superseded" || checkpoint.sharedSetConfirmed
          )
        setOperation({
          kind,
          phase: "complete",
          message:
            result.status === "no_change"
              ? "Your signed Network preferences already match this review."
              : allConfirmed
                ? "The signed preferences were confirmed on shared relays."
                : "The signed preferences are staged. Relay confirmation is still pending.",
        })
        accountPreferences.refetch()
      } catch (error) {
        setOperation({
          kind,
          phase: "error",
          message: operationErrorMessage(error),
        })
        throw error
      }
    },
    [accountPreferences, captureAuth, fenceFor]
  )

  const save = useCallback(
    async (rows: readonly AccountNetworkDesiredRelayRoles[]) => {
      const validation = validateAccountNetworkDesiredRoles(rows)
      if (validation) throw new Error(validation)
      const prepared = prepareAccountNetworkSetRolesAction(
        accountPreferences.reconciliation,
        rows
      )
      await runUpdate("save", prepared.action)
    },
    [accountPreferences.reconciliation, runUpdate]
  )

  const removeRelay = useCallback(
    async (relayUrl: string) => {
      await runUpdate("remove", { type: "remove_relay", relayUrl })
    },
    [runUpdate]
  )

  const addConduitRelay = useCallback(async () => {
    const reconciliation = accountPreferences.reconciliation
    if (!view.conduitRelayPrompt || !reconciliation) {
      throw new Error("The Conduit relay prompt is not currently available.")
    }
    const prepared = prepareConduitRelayRecommendation(reconciliation)
    if (!prepared) {
      throw new Error(
        "The current signed preferences no longer need this recommendation."
      )
    }
    await runUpdate("conduit_relay", prepared.action)
  }, [accountPreferences.reconciliation, runUpdate, view.conduitRelayPrompt])

  const retryPendingUpdate = useCallback(async () => {
    const snapshot = captureAuth()
    const shouldContinue = fenceFor(snapshot)
    setOperation({ kind: "retry", phase: "checking", message: null })
    try {
      const result = await retryAccountNetworkPreferenceUpdate({
        pubkey: snapshot.pubkey,
        dependencies: {
          shouldContinue,
          onPhase: (phase) =>
            setOperation({ kind: "retry", phase, message: null }),
        },
      })
      if (!shouldContinue()) {
        throw new Error("The active signer changed during the Network retry.")
      }
      setTransientUpdate(result.update)
      const allConfirmed = result.checkpoints.every(
        (checkpoint) =>
          checkpoint.state === "superseded" || checkpoint.sharedSetConfirmed
      )
      setOperation({
        kind: "retry",
        phase: "complete",
        message: allConfirmed
          ? "The exact signed preferences were confirmed on shared relays."
          : "The exact signed preferences remain retryable; some relay outcomes are still pending.",
      })
      accountPreferences.refetch()
    } catch (error) {
      setOperation({
        kind: "retry",
        phase: "error",
        message: operationErrorMessage(error),
      })
      throw error
    }
  }, [accountPreferences, captureAuth, fenceFor])

  const redistributeExactInboxDeclaration = useCallback(async () => {
    const reconciliation = accountPreferences.reconciliation
    if (!canRedistributeExactInbox(view, reconciliation)) {
      throw new Error(
        "No exact legacy inbox declaration is available to redistribute."
      )
    }
    const snapshot = captureAuth()
    const shouldContinue = fenceFor(snapshot)
    setOperation({ kind: "redistribute", phase: "checking", message: null })
    try {
      const durable = await readRetainedInboxDeclarationEvidence(
        snapshot.pubkey
      )
      if (
        !shouldContinue() ||
        !durable ||
        durable.current.state !== "declared" ||
        durable.current.signedEvent.id !==
          reconciliation?.inboxDeclaration.eventId
      ) {
        throw new Error(
          "The retained inbox declaration changed. Run the fresh check again."
        )
      }
      if (durable.pendingDistribution?.coordinatedUpdateId) {
        throw new Error(
          "Retry this declaration through the coordinated signed Network update."
        )
      }
      setOperation({
        kind: "redistribute",
        phase: "publishing",
        message: null,
      })
      const ndk = getNdk()
      if (durable.pendingDistribution?.publishRelayUrls.length) {
        await redistributePrivateMessageRelayDeclarationAcrossPlans({
          pubkey: snapshot.pubkey,
          signedEvent: durable.current.signedEvent,
          ndk,
          storedPublishRelayUrls: durable.pendingDistribution.publishRelayUrls,
          currentSharedRelayUrls: sharedInboxDiscoveryRelayUrls(),
        })
      } else {
        await redistributePrivateMessageRelayDeclaration({
          pubkey: snapshot.pubkey,
          signedEvent: durable.current.signedEvent,
          ndk,
          publishRelayUrls: inboxDeclarationPublishRelayUrls(),
        })
      }
      if (!shouldContinue()) {
        throw new Error("The active signer changed during redistribution.")
      }
      setOperation({
        kind: "redistribute",
        phase: "complete",
        message:
          "The exact signed inbox declaration was accepted for redistribution. Fresh confirmation is still required.",
      })
      accountPreferences.refetch()
    } catch (error) {
      setOperation({
        kind: "redistribute",
        phase: "error",
        message: operationErrorMessage(error),
      })
      throw error
    }
  }, [accountPreferences, captureAuth, fenceFor, view])

  const addRelay = useCallback(
    async (url: string): Promise<AccountNetworkRelayRowView> => {
      const normalized = tryNormalizeRelayUrl(url)
      if (!normalized.ok) throw new Error(normalized.error)
      if (view.rows.some((row) => row.url === normalized.url)) {
        throw new Error("That relay is already in this Network review.")
      }
      const entry = await scanRelaySettingsEntry(normalized.url)
      setCapabilityEvidence((current) =>
        current.scope === session.relayScope
          ? { ...current, entries: { ...current.entries, [entry.url]: entry } }
          : current
      )
      return createCandidateNetworkRelayRow(
        entry,
        auth.pubkey
          ? getRelayAuthenticationEvidence(entry.url, auth.pubkey)
          : undefined
      )
    },
    [auth.pubkey, session.relayScope, view.rows]
  )

  const refreshRelay = useCallback(
    async (
      row: AccountNetworkRelayRowView
    ): Promise<AccountNetworkRelayRowView> => {
      const existing = capabilityEntries[row.url]
      const entry = await scanRelaySettingsEntry(row.url, {}, existing)
      setCapabilityEvidence((current) =>
        current.scope === session.relayScope
          ? { ...current, entries: { ...current.entries, [entry.url]: entry } }
          : current
      )
      return {
        ...row,
        capability: createCandidateNetworkRelayRow(
          entry,
          auth.pubkey
            ? getRelayAuthenticationEvidence(entry.url, auth.pubkey)
            : undefined
        ).capability,
      }
    },
    [auth.pubkey, capabilityEntries, session.relayScope]
  )

  return {
    view,
    operation,
    exactInboxRedistributionAvailable: canRedistributeExactInbox(
      view,
      accountPreferences.reconciliation
    ),
    mediaServers: auth.pubkey
      ? {
          view: mediaServerPreferences.view,
          onAddServer: mediaServerPreferences.addServer,
          onRemoveServer: mediaServerPreferences.removeServer,
          onMoveServer: mediaServerPreferences.moveServer,
          onPublish: mediaServerPreferences.publish,
          onRetryPublish: mediaServerPreferences.retryPublish,
          onRetryLookup: mediaServerPreferences.refetch,
        }
      : null,
    addRelay,
    refreshRelay,
    save,
    addConduitRelay,
    removeRelay,
    retryPendingUpdate,
    redistributeExactInboxDeclaration,
    retryReconciliation: accountPreferences.refetch,
    clearOperation: () =>
      setOperation({ kind: null, phase: "idle", message: null }),
  }
}

export type { AccountNetworkRole }
