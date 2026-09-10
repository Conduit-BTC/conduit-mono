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
  dexieAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
  subscribeAccountNetworkLocalState,
  type AccountNetworkLocalState,
} from "../protocol/account-network-local-state"
import {
  publishAccountNetworkMutation,
  recordAccountNetworkRelayScans,
  redistributeAccountNetworkInboxDeclaration,
  reorderAccountNetworkRelays,
  retryAccountNetworkMutation,
  reviewAccountNetworkMutation,
  type AccountNetworkMutationAction,
  type AccountNetworkMutationResult,
  type AccountNetworkSignedKind,
  type ReviewedAccountNetworkMutation,
} from "../protocol/account-network-mutation"
import { EVENT_KINDS } from "../protocol/kinds"
import {
  completeLegacyRelaySettingsDraftMigration,
  type AccountNetworkPreferencesReconciliation,
} from "../protocol/network-preferences"
import {
  buildAccountNetworkSettingsView,
  createCandidateNetworkRelayRow,
  isAccountNetworkRelayRowOrderEligible,
  validateAccountNetworkDesiredRoles,
  type AccountNetworkDesiredRelayRoles,
  type AccountNetworkDesiredRolesValidation,
  type AccountNetworkFrontierView,
  type AccountNetworkPendingExactDeliveryView,
  type AccountNetworkRelayRowView,
  type AccountNetworkRole,
  type AccountNetworkSettingsView,
} from "../protocol/network-settings-view"
import { createNdkNostrEventSigner } from "../protocol/ndk-nostr-event-signer"
import {
  getRelayAuthenticationEvidence,
  subscribeRelayAuthenticationEvidence,
} from "../protocol/relay-executor"
import {
  createRelaySettingsEntryFromScan,
  deriveRelayScanResult,
  scanRelaySettingsEntry,
  tryNormalizeRelayUrl,
  type RelayScanResult,
} from "../protocol/relay-settings"
import type { AccountNetworkPreferencesStatus } from "./useAccountNetworkPreferences"
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
  | "save"
  | "remove"
  | "retry"
  | "redistribute"
  | "reorder"
  | "discard_legacy"
  | "refresh"
  | null

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

export type AccountNetworkReviewChangedObject =
  | "Read and Publish relay preferences"
  | "Private inbox relay preferences"
  | "Local whole-relay removal policy"

export interface PreparedAccountNetworkSettingsChange {
  summary: {
    signerRequestCount: 0 | 1 | 2
    changedObjects: readonly AccountNetworkReviewChangedObject[]
    warnings: readonly string[]
  }
  /** Execute this exact frozen review at most once. */
  execute: () => Promise<void>
}

export type PrepareAccountNetworkSettingsChangeInput =
  | {
      type: "set_roles"
      rows: readonly AccountNetworkDesiredRelayRoles[]
    }
  | {
      type: "remove_relay"
      relayUrl: string
    }

export interface AccountNetworkSettingsController {
  view: AccountNetworkSettingsView
  status: AccountNetworkPreferencesStatus
  error: string | null
  /** Changes only when signed roles, exact-delivery evidence, or exclusions change. */
  revision: string
  operation: AccountNetworkSettingsOperationView
  relayInformationRefreshing: boolean
  exactInboxRedistributionAvailable: boolean
  legacyDraftReviewAvailable: boolean
  mediaServers: AccountNetworkMediaServerController | null
  addRelay: (url: string) => Promise<AccountNetworkRelayRowView>
  validate: (
    rows: readonly AccountNetworkDesiredRelayRoles[]
  ) => AccountNetworkDesiredRolesValidation
  prepareChange: (
    input: PrepareAccountNetworkSettingsChangeInput
  ) => PreparedAccountNetworkSettingsChange
  retryPendingUpdate: (kind?: AccountNetworkSignedKind) => Promise<void>
  redistributeExactInboxDeclaration: () => Promise<void>
  reorderRelays: (relayUrls: readonly string[]) => Promise<void>
  discardLegacyDraft: () => Promise<void>
  refresh: () => Promise<void>
  clearOperation: () => void
}

interface AuthFenceSnapshot {
  status: AuthStatus
  pubkey: string
  signer: NDKSigner
  method: AuthMethod
  generation: number
}

interface AccountFenceSnapshot {
  status: AuthStatus
  pubkey: string
  generation: number
}

interface ScopedLocalState {
  pubkey: string | null
  state: AccountNetworkLocalState | null
  ready: boolean
  error: string | null
}

const EMPTY_OPERATION: AccountNetworkSettingsOperationView = {
  kind: null,
  phase: "idle",
  message: null,
}
const RELAY_INFORMATION_REFRESH_CONCURRENCY = 4

function emptyFrontier(): AccountNetworkFrontierView {
  return {
    state: "not_checked",
    stale: false,
    retained: false,
    coverage: "not_checked",
    eventCreatedAt: null,
    observedAt: null,
    sourceRelayCount: 0,
  }
}

function emptyView(): AccountNetworkSettingsView {
  return {
    rows: [],
    relayList: emptyFrontier(),
    inbox: emptyFrontier(),
    pendingExactDeliveries: [],
  }
}

function operationErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Network action could not be completed."
}

function actionFromRows(
  rows: readonly AccountNetworkDesiredRelayRoles[],
  removedRelayUrls: readonly string[] = []
): AccountNetworkMutationAction {
  return {
    type: "set_roles",
    relays: rows.map((row) => ({
      url: row.url,
      read: row.readEnabled,
      publish: row.publishEnabled,
      privateInbox: row.privateInboxEnabled,
    })),
    removedRelayUrls,
  }
}

function preparedChangeSummary(
  reviewed: ReviewedAccountNetworkMutation
): PreparedAccountNetworkSettingsChange["summary"] {
  if (reviewed.signerRequestCount < 0 || reviewed.signerRequestCount > 2) {
    throw new Error("A Network review can require at most two signatures.")
  }
  const changedObjects: AccountNetworkReviewChangedObject[] = []
  if (reviewed.changedKinds.includes(EVENT_KINDS.RELAY_LIST)) {
    changedObjects.push("Read and Publish relay preferences")
  }
  if (reviewed.changedKinds.includes(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)) {
    changedObjects.push("Private inbox relay preferences")
  }
  if (reviewed.action.removedRelayUrls.length > 0) {
    changedObjects.push("Local whole-relay removal policy")
  }
  return {
    signerRequestCount: reviewed.signerRequestCount as 0 | 1 | 2,
    changedObjects,
    warnings: reviewed.warnings.flatMap((warning) =>
      warning === "single_relay_no_redundancy"
        ? [
            "One Publish relay is valid, but adding another improves redundancy.",
          ]
        : []
    ),
  }
}

function desiredRolesFromCommittedRows(
  rows: readonly AccountNetworkRelayRowView[],
  omittedRelayUrl?: string
): AccountNetworkDesiredRelayRoles[] {
  return rows.flatMap((row) =>
    row.url === omittedRelayUrl
      ? []
      : [
          {
            url: row.url,
            readEnabled:
              row.readState === "published" || row.readState === "pending",
            publishEnabled:
              row.publishState === "published" ||
              row.publishState === "pending",
            privateInboxEnabled:
              row.privateInboxState === "published" ||
              row.privateInboxState === "pending",
          },
        ]
  )
}

function relayScanFromEntry(
  entry: Awaited<ReturnType<typeof scanRelaySettingsEntry>>
): RelayScanResult {
  const scannedAt = entry.scannedAt ?? Date.now()
  const fallback = deriveRelayScanResult(entry.url, null, {
    now: () => scannedAt,
  })
  return {
    url: entry.url,
    reachable: !entry.warnings.unreachable,
    ...(entry.relayName ? { relayName: entry.relayName } : {}),
    capabilities: entry.capabilities,
    warnings: entry.warnings,
    observations: entry.observations ?? fallback.observations,
    ...(entry.commerceProfileVersion === undefined
      ? {}
      : { commerceProfileVersion: entry.commerceProfileVersion }),
    scannedAt,
  }
}

async function scanRelay(
  relayUrl: string,
  existing?: RelayScanResult
): Promise<RelayScanResult> {
  const entry = await scanRelaySettingsEntry(
    relayUrl,
    {},
    existing ? createRelaySettingsEntryFromScan(existing) : undefined
  )
  return relayScanFromEntry(entry)
}

function mergeRelayScans(
  current: readonly RelayScanResult[],
  updates: readonly RelayScanResult[]
): RelayScanResult[] {
  const merged = new Map(current.map((scan) => [scan.url, scan]))
  for (const scan of updates) merged.set(scan.url, scan)
  return [...merged.values()].sort((left, right) =>
    left.url.localeCompare(right.url)
  )
}

async function scanRelayBatch(input: {
  relayUrls: readonly string[]
  existing: readonly RelayScanResult[]
}): Promise<RelayScanResult[]> {
  const existing = new Map(input.existing.map((scan) => [scan.url, scan]))
  const relayUrls = [...new Set(input.relayUrls)]
  const scans: RelayScanResult[] = []
  for (
    let offset = 0;
    offset < relayUrls.length;
    offset += RELAY_INFORMATION_REFRESH_CONCURRENCY
  ) {
    scans.push(
      ...(await Promise.all(
        relayUrls
          .slice(offset, offset + RELAY_INFORMATION_REFRESH_CONCURRENCY)
          .map((relayUrl) => scanRelay(relayUrl, existing.get(relayUrl)))
      ))
    )
  }
  return scans
}

function resultMessage(
  kind: Exclude<AccountNetworkSettingsOperationKind, null>,
  result: AccountNetworkMutationResult
): string {
  if (result.status === "no_change") {
    return "Your signed Network preferences already match this review."
  }
  if (kind === "remove" && result.checkpoints.length === 0) {
    return result.legacyRecoveryRemoval === "retryable"
      ? "The relay cutoff is active. Local recovery cleanup will retry."
      : "The relay cutoff is active immediately."
  }
  const pending = result.checkpoints.some((checkpoint) => checkpoint.pending)
  let message = pending
    ? "The exact signed preferences are staged. Some relay confirmation remains retryable."
    : "The exact signed preferences were confirmed on the planned relays."
  if (
    result.legacyMigrationCompletion === "source_changed" ||
    result.legacyMigrationCompletion === "retryable"
  ) {
    message += " The old local relay draft still needs cleanup."
  }
  if (result.legacyRecoveryRemoval === "retryable") {
    message += " The relay cutoff is active; local recovery cleanup will retry."
  }
  return message
}

function canRedistributeExactInbox(
  reconciliation: AccountNetworkPreferencesReconciliation | null,
  pending: readonly AccountNetworkPendingExactDeliveryView[]
): boolean {
  if (!reconciliation || pending.some((item) => item.kind === 10050)) {
    return false
  }
  const inbox = reconciliation.inboxDeclaration
  return Boolean(
    inbox.state === "declared" &&
    inbox.eventId &&
    inbox.stale &&
    inbox.observation?.coverage === "complete" &&
    inbox.observation.eventId === undefined
  )
}

function scopedRevision(input: {
  pubkey: string | null
  reconciliation: AccountNetworkPreferencesReconciliation | null
  localState: AccountNetworkLocalState | null
  view: AccountNetworkSettingsView
}): string {
  return JSON.stringify({
    pubkey: input.pubkey,
    ownerEventId:
      input.reconciliation?.ownerRelayList.current?.signedEvent.id ?? null,
    inboxEventId: input.reconciliation?.inboxDeclaration.eventId ?? null,
    pending: input.view.pendingExactDeliveries.map((item) => [
      item.kind,
      item.eventId,
    ]),
    roles: input.view.rows
      .map(
        (row) =>
          [
            row.url,
            row.readState,
            row.publishState,
            row.privateInboxState,
            row.readEnabled,
            row.publishEnabled,
            row.privateInboxEnabled,
          ] as const
      )
      .sort((left, right) => left[0].localeCompare(right[0])),
    legacyDraft:
      input.reconciliation?.legacyReviewCandidate?.sourceFingerprint ?? null,
    exclusions:
      input.localState?.exclusions
        .map((exclusion) => exclusion.relayUrl)
        .sort() ?? [],
  })
}

export function useAccountNetworkSettings(): AccountNetworkSettingsController {
  const auth = useAuth()
  const session = useConduitSession()
  const accountPreferences = session.accountNetworkPreferences
  const accountPubkey =
    auth.status === "connected"
      ? (auth.pubkey?.trim().toLowerCase() ?? null)
      : null
  const [operation, setOperation] =
    useState<AccountNetworkSettingsOperationView>(EMPTY_OPERATION)
  const [local, setLocal] = useState<ScopedLocalState>({
    pubkey: null,
    state: null,
    ready: false,
    error: null,
  })
  const [relayInformationRefreshing, setRelayInformationRefreshing] =
    useState(false)
  const [authEvidenceRevision, setAuthEvidenceRevision] = useState(0)
  const scanGeneration = useRef(0)
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
    scanGeneration.current += 1
    setOperation(EMPTY_OPERATION)
    setRelayInformationRefreshing(false)
    if (!accountPubkey) {
      setLocal({ pubkey: null, state: null, ready: false, error: null })
      return
    }
    setLocal({
      pubkey: accountPubkey,
      state: null,
      ready: false,
      error: null,
    })
    try {
      return subscribeAccountNetworkLocalState(accountPubkey, {
        onChange(state) {
          setLocal({
            pubkey: accountPubkey,
            state: state ?? emptyAccountNetworkLocalState(accountPubkey),
            ready: true,
            error: null,
          })
        },
        onError(error) {
          setLocal({
            pubkey: accountPubkey,
            state: null,
            ready: false,
            error: operationErrorMessage(error),
          })
        },
      })
    } catch (error) {
      setLocal({
        pubkey: accountPubkey,
        state: null,
        ready: false,
        error: operationErrorMessage(error),
      })
    }
  }, [accountPubkey, auth.authGeneration, session.relayScope])

  const activeLocal = local.pubkey === accountPubkey ? local : null
  const reconciliation = accountPreferences.reconciliation
  const authEvidenceByUrl = useMemo(() => {
    void authEvidenceRevision
    if (!accountPubkey) return {}
    const urls = new Set([
      ...(reconciliation?.projection.rows.map((row) => row.url) ?? []),
      ...(activeLocal?.state?.relayScans.map((scan) => scan.url) ?? []),
    ])
    return Object.fromEntries(
      [...urls].map((url) => [
        url,
        getRelayAuthenticationEvidence(url, accountPubkey),
      ])
    )
  }, [
    accountPubkey,
    activeLocal?.state?.relayScans,
    authEvidenceRevision,
    reconciliation?.projection.rows,
  ])

  const baseView = useMemo(
    () =>
      reconciliation
        ? buildAccountNetworkSettingsView({
            reconciliation,
            localState: activeLocal?.state ?? null,
            authEvidenceByUrl,
          })
        : emptyView(),
    [activeLocal?.state, authEvidenceByUrl, reconciliation]
  )

  const status: AccountNetworkPreferencesStatus = activeLocal?.error
    ? "error"
    : !activeLocal?.ready && accountPreferences.status === "ready"
      ? "reconciling"
      : accountPreferences.status
  const error = activeLocal?.error ?? accountPreferences.error
  const revision = useMemo(
    () =>
      scopedRevision({
        pubkey: accountPubkey,
        reconciliation,
        localState: activeLocal?.state ?? null,
        view: baseView,
      }),
    [accountPubkey, activeLocal?.state, baseView, reconciliation]
  )
  const revisionRef = useRef(revision)

  useLayoutEffect(() => {
    revisionRef.current = revision
  }, [revision])

  const mediaServerPreferences = useMediaServerPreferences(auth.pubkey, {
    enabled: session.relaySettingsReady,
    authenticatedPubkey: auth.status === "connected" ? auth.pubkey : null,
    signer: auth.signer,
    authMethod: auth.method,
    authGeneration: auth.authGeneration,
    relayScope: session.relayScope,
  })

  const captureAccount = useCallback((): AccountFenceSnapshot => {
    if (auth.status !== "connected" || !auth.pubkey) {
      throw new Error("Connect your signer to manage Network preferences.")
    }
    return {
      status: auth.status,
      pubkey: auth.pubkey.trim().toLowerCase(),
      generation: auth.authGeneration,
    }
  }, [auth.authGeneration, auth.pubkey, auth.status])

  const captureAuth = useCallback((): AuthFenceSnapshot => {
    const account = captureAccount()
    if (!auth.signer || !auth.method) {
      throw new Error(
        "Connect a NIP-07 or NIP-46 signer to update Network preferences."
      )
    }
    return {
      ...account,
      signer: auth.signer,
      method: auth.method,
    }
  }, [auth.method, auth.signer, captureAccount])

  const accountFenceFor = useCallback((snapshot: AccountFenceSnapshot) => {
    return () => {
      const current = authRef.current
      return (
        current.status === snapshot.status &&
        current.pubkey?.trim().toLowerCase() === snapshot.pubkey &&
        current.authGeneration === snapshot.generation
      )
    }
  }, [])

  const authFenceFor = useCallback(
    (snapshot: AuthFenceSnapshot) => {
      const accountFence = accountFenceFor(snapshot)
      return () => {
        const current = authRef.current
        return (
          accountFence() &&
          current.signer === snapshot.signer &&
          current.method === snapshot.method
        )
      }
    },
    [accountFenceFor]
  )

  const requireReviewState = useCallback(() => {
    if (
      !reconciliation ||
      accountPreferences.status !== "ready" ||
      !activeLocal?.ready ||
      !activeLocal.state
    ) {
      throw new Error("Finish the fresh Network check before making changes.")
    }
    if (
      baseView.pendingExactDeliveries.some((pending) => pending.retryAvailable)
    ) {
      throw new Error(
        "Retry the exact staged Network update before preparing another change."
      )
    }
    return { reconciliation, localState: activeLocal.state }
  }, [
    accountPreferences.status,
    activeLocal?.ready,
    activeLocal?.state,
    reconciliation,
    baseView.pendingExactDeliveries,
  ])

  const validate = useCallback(
    (
      rows: readonly AccountNetworkDesiredRelayRoles[]
    ): AccountNetworkDesiredRolesValidation => {
      if (!reconciliation || !activeLocal?.ready || !activeLocal.state) {
        return {
          valid: false,
          errors: ["Finish the fresh Network check before making changes."],
          warnings: [],
        }
      }
      return validateAccountNetworkDesiredRoles(rows, {
        reconciliation,
        localState: activeLocal.state,
      })
    },
    [activeLocal?.ready, activeLocal?.state, reconciliation]
  )

  const executePreparedMutation = useCallback(
    async (
      kind: "save" | "remove",
      reviewed: ReviewedAccountNetworkMutation,
      preparedRevision: string,
      shouldContinue: () => boolean,
      signer?: ReturnType<typeof createNdkNostrEventSigner>
    ): Promise<void> => {
      let lastPhase: AccountNetworkSettingsOperationPhase = "checking"
      setOperation({ kind, phase: "checking", message: null })
      try {
        if (!shouldContinue()) {
          throw new Error(
            "The active account or signer changed after this Network review."
          )
        }
        if (revisionRef.current !== preparedRevision) {
          throw new Error(
            "Network evidence changed after review. Review the current preferences again."
          )
        }
        const result = await publishAccountNetworkMutation({
          reviewed,
          authenticatedPubkey: reviewed.pubkey,
          ...(signer ? { signer } : {}),
          dependencies: {
            shouldContinue,
            onPhase: (phase) => {
              lastPhase = phase
              setOperation({ kind, phase, message: null })
            },
          },
        })
        if (!shouldContinue()) {
          throw new Error(
            "The active account or signer changed during the Network update."
          )
        }
        setOperation({
          kind,
          phase: "complete",
          message: resultMessage(kind, result),
        })
        accountPreferences.refetch()
      } catch (error) {
        if (lastPhase !== "checking") accountPreferences.refetch()
        setOperation({
          kind,
          phase: "error",
          message: operationErrorMessage(error),
        })
        throw error
      }
    },
    [accountPreferences]
  )

  const prepareChange = useCallback(
    (
      input: PrepareAccountNetworkSettingsChangeInput
    ): PreparedAccountNetworkSettingsChange => {
      const ready = requireReviewState()
      let kind: "save" | "remove"
      let desired: AccountNetworkDesiredRelayRoles[]
      let action: AccountNetworkMutationAction
      if (input.type === "set_roles") {
        kind = "save"
        desired = input.rows.map((row) => ({ ...row }))
        action = actionFromRows(desired)
      } else {
        kind = "remove"
        const normalized = tryNormalizeRelayUrl(input.relayUrl)
        if (!normalized.ok) throw new Error(normalized.error)
        if (!baseView.rows.some((row) => row.url === normalized.url)) {
          throw new Error("That relay is not part of the current Network view.")
        }
        desired = desiredRolesFromCommittedRows(baseView.rows, normalized.url)
        action = actionFromRows(desired, [normalized.url])
      }

      const validation = validate(desired)
      if (!validation.valid) {
        throw new Error(validation.errors[0])
      }
      const reviewed = reviewAccountNetworkMutation(
        ready.reconciliation,
        action
      )
      if (!reviewed.evidenceReady) {
        throw new Error(
          "A complete fresh check of both signed Network preferences is required."
        )
      }
      const summary = preparedChangeSummary(reviewed)
      if (summary.changedObjects.length === 0) {
        throw new Error("These Network preferences are already current.")
      }
      const preparedRevision = revision
      let shouldContinue: () => boolean
      let signer: ReturnType<typeof createNdkNostrEventSigner> | undefined
      if (summary.signerRequestCount > 0) {
        const snapshot = captureAuth()
        shouldContinue = authFenceFor(snapshot)
        signer = createNdkNostrEventSigner(
          snapshot.signer,
          snapshot.pubkey,
          snapshot.method
        )
      } else {
        const snapshot = captureAccount()
        shouldContinue = accountFenceFor(snapshot)
      }
      let started = false
      return {
        summary,
        execute: async () => {
          if (started) {
            throw new Error(
              "Prepare this Network change again before retrying it."
            )
          }
          started = true
          await executePreparedMutation(
            kind,
            reviewed,
            preparedRevision,
            shouldContinue,
            signer
          )
        },
      }
    },
    [
      accountFenceFor,
      authFenceFor,
      baseView.rows,
      captureAccount,
      captureAuth,
      executePreparedMutation,
      requireReviewState,
      revision,
      validate,
    ]
  )

  const retryPendingUpdate = useCallback(
    async (kind?: AccountNetworkSignedKind) => {
      setOperation({ kind: "retry", phase: "checking", message: null })
      try {
        const snapshot = captureAccount()
        const shouldContinue = accountFenceFor(snapshot)
        const result = await retryAccountNetworkMutation({
          pubkey: snapshot.pubkey,
          authenticatedPubkey: snapshot.pubkey,
          kind,
          dependencies: {
            shouldContinue,
            onPhase: (phase) =>
              setOperation({ kind: "retry", phase, message: null }),
          },
        })
        if (!shouldContinue()) {
          throw new Error(
            "The active account changed during the Network retry."
          )
        }
        setOperation({
          kind: "retry",
          phase: "complete",
          message: resultMessage("retry", result),
        })
        accountPreferences.refetch()
      } catch (error) {
        accountPreferences.refetch()
        setOperation({
          kind: "retry",
          phase: "error",
          message: operationErrorMessage(error),
        })
        throw error
      }
    },
    [accountFenceFor, accountPreferences, captureAccount]
  )

  const redistributeExactInboxDeclaration = useCallback(async () => {
    setOperation({
      kind: "redistribute",
      phase: "checking",
      message: null,
    })
    try {
      if (
        !canRedistributeExactInbox(
          reconciliation,
          baseView.pendingExactDeliveries
        )
      ) {
        throw new Error(
          "No exact retained inbox declaration is available to redistribute."
        )
      }
      const snapshot = captureAccount()
      const shouldContinue = accountFenceFor(snapshot)
      const result = await redistributeAccountNetworkInboxDeclaration({
        pubkey: snapshot.pubkey,
        authenticatedPubkey: snapshot.pubkey,
        dependencies: {
          shouldContinue,
          onPhase: (phase) =>
            setOperation({ kind: "redistribute", phase, message: null }),
        },
      })
      if (!shouldContinue()) {
        throw new Error(
          "The active account changed during inbox redistribution."
        )
      }
      setOperation({
        kind: "redistribute",
        phase: "complete",
        message: resultMessage("redistribute", result),
      })
      accountPreferences.refetch()
    } catch (error) {
      accountPreferences.refetch()
      setOperation({
        kind: "redistribute",
        phase: "error",
        message: operationErrorMessage(error),
      })
      throw error
    }
  }, [
    accountFenceFor,
    accountPreferences,
    captureAccount,
    reconciliation,
    baseView.pendingExactDeliveries,
  ])

  const addRelay = useCallback(
    async (relayUrl: string): Promise<AccountNetworkRelayRowView> => {
      const normalized = tryNormalizeRelayUrl(relayUrl)
      if (!normalized.ok) throw new Error(normalized.error)
      if (baseView.rows.some((row) => row.url === normalized.url)) {
        throw new Error("That relay is already in this Network review.")
      }
      const snapshot = captureAccount()
      const shouldContinue = accountFenceFor(snapshot)
      const stored =
        (await dexieAccountNetworkLocalStateRepository.get(snapshot.pubkey)) ??
        emptyAccountNetworkLocalState(snapshot.pubkey)
      const candidateUrl = createCandidateNetworkRelayRow({
        url: normalized.url,
        localState: stored,
        authEvidence: getRelayAuthenticationEvidence(
          normalized.url,
          snapshot.pubkey
        ),
      }).url
      const scan = await scanRelay(
        candidateUrl,
        stored.relayScans.find((candidate) => candidate.url === candidateUrl)
      )
      if (!shouldContinue()) {
        throw new Error("The active account changed while checking the relay.")
      }
      const updated = await recordAccountNetworkRelayScans({
        pubkey: snapshot.pubkey,
        relayScans: mergeRelayScans(stored.relayScans, [scan]),
      })
      if (!shouldContinue()) {
        throw new Error(
          "The active account changed while saving relay evidence."
        )
      }
      setLocal({
        pubkey: snapshot.pubkey,
        state: updated,
        ready: true,
        error: null,
      })
      return createCandidateNetworkRelayRow({
        url: candidateUrl,
        localState: updated,
        scan,
        authEvidence: getRelayAuthenticationEvidence(
          candidateUrl,
          snapshot.pubkey
        ),
      })
    },
    [accountFenceFor, baseView.rows, captureAccount]
  )

  const reorderRelays = useCallback(
    async (relayUrls: readonly string[]) => {
      const snapshot = captureAccount()
      const shouldContinue = accountFenceFor(snapshot)
      const current = activeLocal?.state
      if (!current || !activeLocal.ready) {
        throw new Error("Local Network preferences are not ready.")
      }
      const eligibleRelayUrls = baseView.rows
        .filter(isAccountNetworkRelayRowOrderEligible)
        .map((row) => row.url)
      const eligibleRelayUrlSet = new Set(eligibleRelayUrls)
      const requested = [...new Set(relayUrls)].filter((relayUrl) =>
        eligibleRelayUrlSet.has(relayUrl)
      )
      const requestedSet = new Set(requested)
      const preserved = eligibleRelayUrls.filter(
        (relayUrl) => !requestedSet.has(relayUrl)
      )
      try {
        const updated = await reorderAccountNetworkRelays({
          pubkey: snapshot.pubkey,
          relayUrls: [...requested, ...preserved],
        })
        if (!shouldContinue()) return
        setLocal({
          pubkey: snapshot.pubkey,
          state: updated,
          ready: true,
          error: null,
        })
        setOperation({
          kind: "reorder",
          phase: "complete",
          message: "Conduit's relay order was saved without a signer request.",
        })
      } catch (error) {
        setOperation({
          kind: "reorder",
          phase: "error",
          message: operationErrorMessage(error),
        })
        throw error
      }
    },
    [accountFenceFor, activeLocal, baseView.rows, captureAccount]
  )

  const discardLegacyDraft = useCallback(async () => {
    const candidate = reconciliation?.legacyReviewCandidate
    if (!candidate) return
    const snapshot = captureAccount()
    const shouldContinue = accountFenceFor(snapshot)
    setOperation({
      kind: "discard_legacy",
      phase: "staging",
      message: null,
    })
    try {
      const status = await completeLegacyRelaySettingsDraftMigration({
        candidate,
        disposition: "discarded",
      })
      if (!shouldContinue()) return
      if (status === "source_changed" || status === "retryable") {
        throw new Error(
          status === "source_changed"
            ? "The old local relay draft changed. Refresh and review it again."
            : "The old local relay draft could not be discarded yet."
        )
      }
      setOperation({
        kind: "discard_legacy",
        phase: "complete",
        message: "The old unpublished relay draft was discarded.",
      })
      accountPreferences.refetch()
    } catch (error) {
      accountPreferences.refetch()
      setOperation({
        kind: "discard_legacy",
        phase: "error",
        message: operationErrorMessage(error),
      })
      throw error
    }
  }, [
    accountFenceFor,
    accountPreferences,
    captureAccount,
    reconciliation?.legacyReviewCandidate,
  ])

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++scanGeneration.current
    setOperation({ kind: "refresh", phase: "checking", message: null })
    setRelayInformationRefreshing(true)
    try {
      await accountPreferences.refetch()
      const snapshot = captureAccount()
      const shouldContinue = accountFenceFor(snapshot)
      const stored =
        (await dexieAccountNetworkLocalStateRepository.get(snapshot.pubkey)) ??
        emptyAccountNetworkLocalState(snapshot.pubkey)
      const scans = await scanRelayBatch({
        relayUrls: baseView.rows.map((row) => row.url),
        existing: stored.relayScans,
      })
      if (!shouldContinue() || generation !== scanGeneration.current) return
      const updated = await recordAccountNetworkRelayScans({
        pubkey: snapshot.pubkey,
        relayScans: mergeRelayScans(stored.relayScans, scans),
      })
      if (!shouldContinue() || generation !== scanGeneration.current) return
      setLocal({
        pubkey: snapshot.pubkey,
        state: updated,
        ready: true,
        error: null,
      })
      setOperation({
        kind: "refresh",
        phase: "complete",
        message: "Network relay information is current.",
      })
    } catch (error) {
      if (generation === scanGeneration.current) {
        setOperation({
          kind: "refresh",
          phase: "error",
          message: `Network relay information could not be refreshed. ${operationErrorMessage(error)} Try again.`,
        })
      }
    } finally {
      if (generation === scanGeneration.current) {
        setRelayInformationRefreshing(false)
      }
    }
  }, [accountFenceFor, accountPreferences, baseView.rows, captureAccount])

  return {
    view: baseView,
    status,
    error,
    revision,
    operation,
    relayInformationRefreshing,
    exactInboxRedistributionAvailable:
      status === "ready" &&
      canRedistributeExactInbox(
        reconciliation,
        baseView.pendingExactDeliveries
      ),
    legacyDraftReviewAvailable: Boolean(reconciliation?.legacyReviewCandidate),
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
    validate,
    prepareChange,
    retryPendingUpdate,
    redistributeExactInboxDeclaration,
    reorderRelays,
    discardLegacyDraft,
    refresh,
    clearOperation: () => setOperation(EMPTY_OPERATION),
  }
}

export type { AccountNetworkRole }
