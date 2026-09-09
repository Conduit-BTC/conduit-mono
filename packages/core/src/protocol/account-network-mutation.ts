import {
  db,
  type AccountNetworkFrontierReference,
  type AccountNetworkLocalState,
  type InboxDeclarationEvidenceRecord,
  type NetworkPreferenceRelayOutcome,
  type OwnerRelayListEvidenceRecord,
} from "../db"
import {
  applyAccountNetworkRelayExclusion,
  applyAuthoritativeAccountNetworkReadds,
  type AccountNetworkLocalStateRepository,
  dexieAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
  filterEligibleAccountRelayUrls,
  normalizeAccountNetworkLocalState,
  replaceAccountNetworkPreferredRelayOrder,
  replaceAccountNetworkRelayScans,
} from "./account-network-local-state"
import {
  applyInboxDeclarationCutoverExclusions,
  applyInboxDeclarationDistributionOutcomes,
  applyInboxDeclarationDistributionStage,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
  normalizeInboxDeclarationEvidencePubkey,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  unresolvedNetworkPreferencePublishRelayUrls,
  unresolvedNetworkPreferenceReadbackRelayUrls,
  type NetworkPreferenceDistributionOutcomeUpdate,
} from "./network-preference-delivery"
import {
  completeLegacyRelaySettingsDraftMigration,
  reconcileAccountNetworkPreferences,
  removeLegacyRelayReadRecoveryRelayUrls,
  type AccountNetworkPreferencesReconciliation,
  type CompleteLegacyRelaySettingsMigrationStatus,
  type LegacyRelaySettingsReviewCandidate,
  type LegacyRelayReadRecoveryRelayRemovalStatus,
  type ReconcileAccountNetworkPreferencesOptions,
} from "./network-preferences"
import { NostrSignerError, type NostrEventSigner } from "./nostr-event-signer"
import {
  accountNetworkDiscoveryRelayUrls,
  applyOwnerRelayListDistributionOutcomes,
  applyOwnerRelayListDistributionStage,
  normalizeOwnerRelayListPubkey,
} from "./owner-relay-list-evidence"
import {
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
} from "./private-message-routing"
import {
  publishSignedEventToRelay,
  type ExclusiveRelayPublishStatus,
} from "./relay-publish"
import { fetchSignedEventsFanoutDetailed } from "./relay-reader"
import {
  assertSafeNip65RelayList,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeSecureOrIsolatedE2eRelayUrls,
  serializeNip65RelayTags,
  type RelayPreference,
  type RelayScanResult,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const MAX_NETWORK_PREFERENCE_FUTURE_SKEW_SECONDS = 5 * 60
export const MAX_ACCOUNT_NETWORK_DISTRIBUTION_RELAYS = 8

export type AccountNetworkSignedKind =
  typeof EVENT_KINDS.RELAY_LIST | typeof EVENT_KINDS.PRIVATE_MESSAGE_RELAYS

export interface AccountNetworkRelayRoles {
  url: string
  read: boolean
  publish: boolean
  privateInbox: boolean
}

/**
 * One reviewed role update. `removedRelayUrls` are whole-relay cutoffs, not
 * another desired-role representation; every removed URL must be absent from
 * all desired roles.
 */
export interface AccountNetworkSetRolesAction {
  type: "set_roles"
  relays: readonly AccountNetworkRelayRoles[]
  removedRelayUrls?: readonly string[]
}

export type AccountNetworkMutationAction = AccountNetworkSetRolesAction

export interface AccountNetworkReviewFrontier {
  eventId: string | null
  createdAt: number | null
  state: string
}

export type AccountNetworkReviewWarning = "single_relay_no_redundancy"

export interface ReviewedAccountNetworkMutation {
  pubkey: string
  action: {
    type: "set_roles"
    relays: AccountNetworkRelayRoles[]
    removedRelayUrls: string[]
  }
  relayList: AccountNetworkReviewFrontier
  inboxDeclaration: AccountNetworkReviewFrontier
  previousInboxRelayUrls: string[]
  changedKinds: AccountNetworkSignedKind[]
  signerRequestCount: number
  warnings: AccountNetworkReviewWarning[]
  evidenceReady: boolean
  /** Exact ephemeral legacy source approved by this same reviewed action. */
  legacyReviewCandidate: LegacyRelaySettingsReviewCandidate | null
}

export type AccountNetworkMutationErrorCode =
  | "invalid_account"
  | "invalid_preferences"
  | "evidence_unavailable"
  | "evidence_changed"
  | "signer_mismatch"
  | "invalid_signature"
  | "no_publish_targets"
  | "missing_pending_distribution"

export class AccountNetworkMutationError extends Error {
  constructor(
    readonly code: AccountNetworkMutationErrorCode,
    message: string
  ) {
    super(message)
    this.name = "AccountNetworkMutationError"
  }
}

export interface AccountNetworkMutationSnapshot {
  ownerRelayList?: OwnerRelayListEvidenceRecord
  inboxDeclaration?: InboxDeclarationEvidenceRecord
  localState: AccountNetworkLocalState
}

export interface AccountNetworkStagedCheckpoint {
  kind: AccountNetworkSignedKind
  signedEvent: SignedPublicNostrEvent
  publishRelayUrls: string[]
}

export interface StageAccountNetworkMutationInput {
  pubkey: string
  expectedRelayListEventId: string | null
  expectedInboxDeclarationEventId: string | null
  checkpoints: readonly AccountNetworkStagedCheckpoint[]
  previousInboxRelayUrls: readonly string[]
  removedRelayUrls: readonly string[]
  stagedAt: number
}

export interface AccountNetworkMutationRepository {
  get(pubkey: string): Promise<AccountNetworkMutationSnapshot>
  stage(
    input: StageAccountNetworkMutationInput
  ): Promise<AccountNetworkMutationSnapshot>
  recordOutcomes(input: {
    pubkey: string
    kind: AccountNetworkSignedKind
    signedEventId: string
    update: NetworkPreferenceDistributionOutcomeUpdate
  }): Promise<AccountNetworkMutationSnapshot>
}

export interface AccountNetworkCheckpointResult {
  kind: AccountNetworkSignedKind
  signedEvent: SignedPublicNostrEvent
  pending: boolean
  relayOutcomes: NetworkPreferenceRelayOutcome[]
}

export interface AccountNetworkMutationResult {
  status: "no_change" | "staged"
  checkpoints: AccountNetworkCheckpointResult[]
  localStateChanged: boolean
  /** Cleanup result after the replacement kind:10002 checkpoint was staged. */
  legacyMigrationCompletion: CompleteLegacyRelaySettingsMigrationStatus | null
  /** Durable legacy inbox cleanup after an immediate whole-relay cutoff. */
  legacyRecoveryRemoval: LegacyRelayReadRecoveryRelayRemovalStatus | null
}

export interface AccountNetworkMutationDependencies {
  repository?: AccountNetworkMutationRepository
  reconcile?: typeof reconcileAccountNetworkPreferences
  reconcileOptions?: ReconcileAccountNetworkPreferencesOptions
  completeLegacyDraftMigration?: typeof completeLegacyRelaySettingsDraftMigration
  removeLegacyReadRecoveryRelayUrls?: typeof removeLegacyRelayReadRecoveryRelayUrls
  resolveRelayPlan?: (input: {
    pubkey: string
    kind: AccountNetworkSignedKind
    desiredPublishRelayUrls: readonly string[]
  }) => Promise<readonly string[]> | readonly string[]
  filterEligibleRelayUrls?: (
    pubkey: string,
    relayUrls: readonly string[]
  ) => Promise<string[]>
  publishToRelay?: typeof publishSignedEventToRelay
  fetchEvents?: typeof fetchSignedEventsFanoutDetailed
  shouldContinue?: () => boolean
  now?: () => number
  onPhase?: (
    phase:
      | "checking"
      | "awaiting_signatures"
      | "staging"
      | "publishing"
      | "confirming"
  ) => void
  refreshRuntime?: (pubkey: string) => Promise<void> | void
}

export interface AccountNetworkLocalMutationDependencies {
  repository?: AccountNetworkLocalStateRepository
  now?: () => number
}

const accountMutationTails = new Map<string, Promise<void>>()

function normalizePubkey(pubkey: string): string {
  const normalized = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalized) {
    throw new AccountNetworkMutationError(
      "invalid_account",
      "Network changes require a valid account public key."
    )
  }
  return normalized
}

function cloneSnapshot(
  snapshot: AccountNetworkMutationSnapshot
): AccountNetworkMutationSnapshot {
  return structuredClone(snapshot)
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameSignedEvent(
  left: SignedPublicNostrEvent,
  right: SignedPublicNostrEvent
): boolean {
  return (
    left.id === right.id &&
    left.pubkey === right.pubkey &&
    left.created_at === right.created_at &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.sig === right.sig &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  )
}

function frontierReference(
  event: SignedPublicNostrEvent | undefined
): AccountNetworkFrontierReference {
  return event
    ? { eventId: event.id, createdAt: event.created_at }
    : { eventId: null, createdAt: null }
}

function currentInboxRelayUrls(
  resolution: InboxDeclarationResolution
): string[] {
  if (resolution.state === "distribution_pending") {
    return normalizeSecureOrIsolatedE2eRelayUrls(
      resolution.pendingRelayUrls ?? []
    )
  }
  return resolution.state === "declared"
    ? normalizeSecureOrIsolatedE2eRelayUrls(resolution.relayUrls)
    : []
}

function previousInboxRelayUrls(
  resolution: InboxDeclarationResolution,
  currentRelayUrls: readonly string[],
  legacyInboxRecoveryRelayUrls: readonly string[]
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls([
    ...currentRelayUrls,
    ...(resolution.retainedReadRelayUrls ?? []),
    ...(resolution.cutoverRecoveryRelayUrls ?? []),
    ...legacyInboxRecoveryRelayUrls,
  ])
}

function usableInboxRelayUrls(
  resolution: InboxDeclarationResolution,
  legacyInboxRecoveryRelayUrls: readonly string[]
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls([
    ...currentInboxRelayUrls(resolution),
    ...(resolution.retainedReadRelayUrls ?? []),
    ...(resolution.cutoverRecoveryRelayUrls ?? []),
    ...legacyInboxRecoveryRelayUrls,
  ])
}

function normalizeAction(
  action: AccountNetworkMutationAction
): ReviewedAccountNetworkMutation["action"] {
  const byUrl = new Map<string, AccountNetworkRelayRoles>()
  for (const relay of action.relays) {
    const normalized = normalizeSecureOrIsolatedE2eRelayUrls([relay.url])[0]
    if (!normalized) {
      throw new AccountNetworkMutationError(
        "invalid_preferences",
        "Network preferences require secure relay URLs."
      )
    }
    const prior = byUrl.get(normalized)
    byUrl.set(normalized, {
      url: normalized,
      read: Boolean(prior?.read || relay.read),
      publish: Boolean(prior?.publish || relay.publish),
      privateInbox: Boolean(prior?.privateInbox || relay.privateInbox),
    })
  }
  const removedRelayUrls = normalizePublicOrIsolatedE2eRelayHints(
    action.removedRelayUrls ?? []
  ).sort()
  if (removedRelayUrls.length !== new Set(action.removedRelayUrls ?? []).size) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Whole-relay removals must be unique valid relay URLs."
    )
  }
  const removed = new Set(removedRelayUrls)
  const relays = [...byUrl.values()]
    .filter((relay) => relay.read || relay.publish || relay.privateInbox)
    .sort((left, right) => left.url.localeCompare(right.url))
  if (
    relays.some(
      (relay) =>
        removed.has(relay.url) &&
        (relay.read || relay.publish || relay.privateInbox)
    )
  ) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "A whole-relay removal cannot keep an active relay role."
    )
  }
  return { type: "set_roles", relays, removedRelayUrls }
}

function relayPreferencesFromAction(
  action: ReviewedAccountNetworkMutation["action"]
): RelayPreference[] {
  return action.relays.flatMap((relay) =>
    relay.read || relay.publish
      ? [
          {
            url: relay.url,
            readEnabled: relay.read,
            writeEnabled: relay.publish,
          },
        ]
      : []
  )
}

function inboxRelayUrlsFromAction(
  action: ReviewedAccountNetworkMutation["action"]
): string[] {
  const requested = action.relays.flatMap((relay) =>
    relay.privateInbox ? [relay.url] : []
  )
  const secure = normalizeSecureOrIsolatedE2eRelayUrls(requested)
  if (secure.length !== requested.length) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Private inboxes require unique secure relay URLs."
    )
  }
  return secure
}

function normalizedPreferenceSemantics(
  preferences: readonly RelayPreference[]
): string {
  return JSON.stringify(
    preferences
      .map((preference) => ({
        url: preference.url,
        readEnabled: preference.readEnabled,
        writeEnabled: preference.writeEnabled,
      }))
      .sort((left, right) => left.url.localeCompare(right.url))
  )
}

function sameInboxSemantics(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return sameStrings([...left].sort(), [...right].sort())
}

function stablePreferenceOrder(
  current: readonly RelayPreference[],
  desired: readonly RelayPreference[]
): RelayPreference[] {
  const desiredByUrl = new Map(
    desired.map((preference) => [preference.url, preference] as const)
  )
  const retained = current.flatMap((preference) => {
    const next = desiredByUrl.get(preference.url)
    if (!next) return []
    desiredByUrl.delete(preference.url)
    return [{ ...next }]
  })
  return [
    ...retained,
    ...[...desiredByUrl.values()].sort((left, right) =>
      left.url.localeCompare(right.url)
    ),
  ]
}

function stableInboxOrder(
  current: readonly string[],
  desired: readonly string[]
): string[] {
  const remaining = new Set(desired)
  const retained = current.filter((relayUrl) => {
    if (!remaining.has(relayUrl)) return false
    remaining.delete(relayUrl)
    return true
  })
  return [...retained, ...[...remaining].sort()]
}

function reviewFrontier(input: {
  eventId?: string
  createdAt?: number
  state: string
}): AccountNetworkReviewFrontier {
  return {
    eventId: input.eventId ?? null,
    createdAt: input.createdAt ?? null,
    state: input.state,
  }
}

export function reviewAccountNetworkMutation(
  reconciliation: AccountNetworkPreferencesReconciliation,
  requestedAction: AccountNetworkMutationAction
): ReviewedAccountNetworkMutation {
  const pubkey = normalizePubkey(reconciliation.projection.pubkey)
  const action = normalizeAction(requestedAction)
  const currentRelayPreferences = reconciliation.ownerRelayList.preferences
  const desiredRelayPreferences = relayPreferencesFromAction(action)
  try {
    assertSafeNip65RelayList(desiredRelayPreferences)
  } catch (error) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      error instanceof Error ? error.message : "Unsafe relay preferences."
    )
  }
  const currentInbox = currentInboxRelayUrls(reconciliation.inboxDeclaration)
  const desiredInbox = inboxRelayUrlsFromAction(action)
  if (desiredInbox.length > 3) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Choose no more than three Private inbox relays."
    )
  }
  if (
    usableInboxRelayUrls(
      reconciliation.inboxDeclaration,
      reconciliation.legacyInboxRecoveryRelayUrls ?? []
    ).length > 0 &&
    desiredInbox.length === 0
  ) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Choose a replacement before removing the last usable Private inbox."
    )
  }

  const relayListChanged =
    reconciliation.ownerRelayList.state !== "declared" ||
    normalizedPreferenceSemantics(currentRelayPreferences) !==
      normalizedPreferenceSemantics(desiredRelayPreferences)
  const inboxChanged =
    (desiredInbox.length > 0 &&
      reconciliation.inboxDeclaration.state !== "declared" &&
      reconciliation.inboxDeclaration.state !== "distribution_pending") ||
    !sameInboxSemantics(currentInbox, desiredInbox)
  const changedKinds: AccountNetworkSignedKind[] = []
  if (relayListChanged) changedKinds.push(EVENT_KINDS.RELAY_LIST)
  if (inboxChanged) changedKinds.push(EVENT_KINDS.PRIVATE_MESSAGE_RELAYS)

  return {
    pubkey,
    action,
    relayList: reviewFrontier({
      eventId: reconciliation.ownerRelayList.current?.signedEvent.id,
      createdAt: reconciliation.ownerRelayList.current?.signedEvent.created_at,
      state: reconciliation.ownerRelayList.state,
    }),
    inboxDeclaration: reviewFrontier({
      eventId: reconciliation.inboxDeclaration.eventId,
      createdAt: reconciliation.inboxDeclaration.eventCreatedAt,
      state: reconciliation.inboxDeclaration.state,
    }),
    previousInboxRelayUrls: previousInboxRelayUrls(
      reconciliation.inboxDeclaration,
      currentInbox,
      reconciliation.legacyInboxRecoveryRelayUrls ?? []
    ),
    changedKinds,
    signerRequestCount: changedKinds.length,
    warnings:
      desiredRelayPreferences.filter((preference) => preference.writeEnabled)
        .length === 1
        ? ["single_relay_no_redundancy"]
        : [],
    evidenceReady:
      reconciliation.ownerRelayList.lookup.coverage === "complete" &&
      reconciliation.inboxDeclaration.observation?.coverage === "complete",
    legacyReviewCandidate: reconciliation.legacyReviewCandidate
      ? structuredClone(reconciliation.legacyReviewCandidate)
      : null,
  }
}

function sameReview(
  left: ReviewedAccountNetworkMutation,
  right: ReviewedAccountNetworkMutation
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertContinue(shouldContinue: (() => boolean) | undefined): void {
  if (shouldContinue?.() === false) {
    throw new NostrSignerError("authority_changed")
  }
}

function selectCreatedAt(
  frontierCreatedAt: number | null,
  nowMs: number
): number {
  const nowSeconds = Math.floor(nowMs / 1_000)
  const createdAt =
    frontierCreatedAt === null
      ? nowSeconds
      : Math.max(nowSeconds, frontierCreatedAt + 1)
  if (createdAt > nowSeconds + MAX_NETWORK_PREFERENCE_FUTURE_SKEW_SECONDS) {
    throw new AccountNetworkMutationError(
      "evidence_changed",
      "A signed Network frontier is too far ahead of this device clock."
    )
  }
  return createdAt
}

function assertValidSignedDraft(input: {
  signedEvent: SignedPublicNostrEvent
  unsignedEvent: Omit<SignedPublicNostrEvent, "id" | "sig">
}): void {
  const { signedEvent, unsignedEvent } = input
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== unsignedEvent.pubkey ||
    signedEvent.kind !== unsignedEvent.kind ||
    signedEvent.created_at !== unsignedEvent.created_at ||
    signedEvent.content !== unsignedEvent.content ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(unsignedEvent.tags)
  ) {
    throw new AccountNetworkMutationError(
      "invalid_signature",
      "The signer returned an invalid Network preference event."
    )
  }
}

function initialRelayOutcomes(
  publishRelayUrls: readonly string[]
): NetworkPreferenceRelayOutcome[] {
  return publishRelayUrls.map((relayUrl) => ({
    relayUrl,
    publishStatus: "pending",
    publishAttemptCount: 0,
    readbackStatus: "pending",
    readbackAttemptCount: 0,
  }))
}

function checkpointForKind(
  snapshot: AccountNetworkMutationSnapshot,
  kind: AccountNetworkSignedKind
): AccountNetworkCheckpointResult | null {
  const pending =
    kind === EVENT_KINDS.RELAY_LIST
      ? snapshot.ownerRelayList?.pendingDistribution
      : snapshot.inboxDeclaration?.pendingDistribution
  if (!pending?.relayOutcomes) return null
  return {
    kind,
    signedEvent: structuredClone(pending.signedEvent),
    pending: true,
    relayOutcomes: structuredClone(pending.relayOutcomes),
  }
}

function resultFromSnapshot(
  snapshot: AccountNetworkMutationSnapshot,
  kinds: readonly AccountNetworkSignedKind[],
  localStateChanged: boolean,
  legacyMigrationCompletion: CompleteLegacyRelaySettingsMigrationStatus | null = null,
  legacyRecoveryRemoval: LegacyRelayReadRecoveryRelayRemovalStatus | null = null
): AccountNetworkMutationResult {
  return {
    status: "staged",
    checkpoints: kinds.flatMap((kind) => {
      const checkpoint = checkpointForKind(snapshot, kind)
      if (checkpoint) return [checkpoint]
      const evidence =
        kind === EVENT_KINDS.RELAY_LIST
          ? snapshot.ownerRelayList?.current?.signedEvent
          : snapshot.inboxDeclaration?.current.signedEvent
      return evidence
        ? [
            {
              kind,
              signedEvent: structuredClone(evidence),
              pending: false,
              relayOutcomes: [],
            },
          ]
        : []
    }),
    localStateChanged,
    legacyMigrationCompletion,
    legacyRecoveryRemoval,
  }
}

function applyStageToSnapshot(
  snapshot: AccountNetworkMutationSnapshot,
  input: StageAccountNetworkMutationInput
): AccountNetworkMutationSnapshot {
  const currentRelayListEventId =
    snapshot.ownerRelayList?.current?.signedEvent.id ?? null
  const currentInboxEventId =
    snapshot.inboxDeclaration?.current.signedEvent.id ?? null
  if (
    currentRelayListEventId !== input.expectedRelayListEventId ||
    currentInboxEventId !== input.expectedInboxDeclarationEventId
  ) {
    throw new AccountNetworkMutationError(
      "evidence_changed",
      "Durable signed Network evidence changed before staging."
    )
  }
  let ownerRelayList = snapshot.ownerRelayList
    ? structuredClone(snapshot.ownerRelayList)
    : undefined
  let inboxDeclaration = snapshot.inboxDeclaration
    ? structuredClone(snapshot.inboxDeclaration)
    : undefined
  for (const checkpoint of input.checkpoints) {
    const relayOutcomes = initialRelayOutcomes(checkpoint.publishRelayUrls)
    if (checkpoint.kind === EVENT_KINDS.RELAY_LIST) {
      ownerRelayList = applyOwnerRelayListDistributionStage(ownerRelayList, {
        pubkey: input.pubkey,
        signedEvent: checkpoint.signedEvent,
        publishRelayUrls: checkpoint.publishRelayUrls,
        relayOutcomes,
        expectedCurrentEventId: input.expectedRelayListEventId,
        stagedAt: input.stagedAt,
        cachedAt: input.stagedAt,
      })
    } else {
      inboxDeclaration = applyInboxDeclarationDistributionStage(
        inboxDeclaration,
        {
          pubkey: input.pubkey,
          signedEvent: checkpoint.signedEvent,
          publishRelayUrls: checkpoint.publishRelayUrls,
          relayOutcomes,
          previousRelayUrls: input.previousInboxRelayUrls,
          excludedRelayUrls: input.removedRelayUrls,
          cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
          cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
          expectedCurrentEventId: input.expectedInboxDeclarationEventId,
          stagedAt: input.stagedAt,
          cachedAt: input.stagedAt,
        }
      )
    }
  }
  if (inboxDeclaration && input.removedRelayUrls.length > 0) {
    inboxDeclaration = applyInboxDeclarationCutoverExclusions(
      inboxDeclaration,
      input.removedRelayUrls
    )
  }

  let localState = normalizeAccountNetworkLocalState(snapshot.localState)
  const relayListFrontier = frontierReference(
    ownerRelayList?.current?.signedEvent
  )
  const inboxDeclarationFrontier = frontierReference(
    inboxDeclaration?.current.signedEvent
  )
  for (const relayUrl of input.removedRelayUrls) {
    localState = applyAccountNetworkRelayExclusion(localState, {
      relayUrl,
      relayListFrontier,
      inboxDeclarationFrontier,
      committedAt: input.stagedAt,
    })
  }
  localState = applyAuthoritativeAccountNetworkReadds(localState, {
    relayList: input.checkpoints.find(
      (checkpoint) => checkpoint.kind === EVENT_KINDS.RELAY_LIST
    )?.signedEvent,
    inboxDeclaration: input.checkpoints.find(
      (checkpoint) => checkpoint.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
    )?.signedEvent,
    updatedAt: input.stagedAt,
  })
  return {
    ownerRelayList,
    inboxDeclaration,
    localState,
  }
}

function createDexieAccountNetworkMutationRepository(): AccountNetworkMutationRepository {
  return {
    async get(pubkey) {
      const normalized = normalizePubkey(pubkey)
      const ownerPubkey = normalizeOwnerRelayListPubkey(normalized)!
      const inboxPubkey = normalizeInboxDeclarationEvidencePubkey(normalized)!
      const [ownerRelayList, inboxDeclaration, local] = await Promise.all([
        db.ownerRelayListEvidence.get(ownerPubkey),
        db.inboxDeclarationEvidence.get(inboxPubkey),
        db.accountNetworkLocalState.get(normalized),
      ])
      return cloneSnapshot({
        ownerRelayList,
        inboxDeclaration,
        localState: normalizeAccountNetworkLocalState(
          local ?? emptyAccountNetworkLocalState(normalized)
        ),
      })
    },
    async stage(input) {
      const normalized = normalizePubkey(input.pubkey)
      return await db.transaction(
        "rw",
        db.ownerRelayListEvidence,
        db.inboxDeclarationEvidence,
        db.accountNetworkLocalState,
        async () => {
          const current = await this.get(normalized)
          const next = applyStageToSnapshot(current, {
            ...input,
            pubkey: normalized,
          })
          if (next.ownerRelayList) {
            await db.ownerRelayListEvidence.put(
              structuredClone(next.ownerRelayList)
            )
          }
          if (next.inboxDeclaration) {
            await db.inboxDeclarationEvidence.put(
              structuredClone(next.inboxDeclaration)
            )
          }
          await db.accountNetworkLocalState.put(
            structuredClone(next.localState)
          )
          return cloneSnapshot(next)
        }
      )
    },
    async recordOutcomes(input) {
      const normalized = normalizePubkey(input.pubkey)
      return await db.transaction(
        "rw",
        db.ownerRelayListEvidence,
        db.inboxDeclarationEvidence,
        db.accountNetworkLocalState,
        async () => {
          const current = await this.get(normalized)
          if (input.kind === EVENT_KINDS.RELAY_LIST) {
            const pending = current.ownerRelayList?.pendingDistribution
            if (pending?.signedEvent.id === input.signedEventId) {
              current.ownerRelayList = applyOwnerRelayListDistributionOutcomes(
                current.ownerRelayList!,
                input.update
              )
              await db.ownerRelayListEvidence.put(current.ownerRelayList)
            }
          } else {
            const pending = current.inboxDeclaration?.pendingDistribution
            if (pending?.signedEvent.id === input.signedEventId) {
              current.inboxDeclaration =
                applyInboxDeclarationDistributionOutcomes(
                  current.inboxDeclaration!,
                  input.update
                )
              await db.inboxDeclarationEvidence.put(current.inboxDeclaration)
            }
          }
          return cloneSnapshot(current)
        }
      )
    },
  }
}

export const dexieAccountNetworkMutationRepository =
  createDexieAccountNetworkMutationRepository()

export function createInMemoryAccountNetworkMutationRepository(
  initial: readonly {
    pubkey: string
    snapshot: AccountNetworkMutationSnapshot
  }[] = []
): AccountNetworkMutationRepository {
  const snapshots = new Map(
    initial.map(({ pubkey, snapshot }) => [
      normalizePubkey(pubkey),
      cloneSnapshot(snapshot),
    ])
  )
  const getSnapshot = (pubkey: string): AccountNetworkMutationSnapshot => {
    const normalized = normalizePubkey(pubkey)
    const snapshot = snapshots.get(normalized)
    return snapshot
      ? cloneSnapshot(snapshot)
      : {
          localState: emptyAccountNetworkLocalState(normalized),
        }
  }
  return {
    async get(pubkey) {
      return getSnapshot(pubkey)
    },
    async stage(input) {
      const normalized = normalizePubkey(input.pubkey)
      const next = applyStageToSnapshot(getSnapshot(normalized), {
        ...input,
        pubkey: normalized,
      })
      snapshots.set(normalized, cloneSnapshot(next))
      return cloneSnapshot(next)
    },
    async recordOutcomes(input) {
      const normalized = normalizePubkey(input.pubkey)
      const current = getSnapshot(normalized)
      if (input.kind === EVENT_KINDS.RELAY_LIST) {
        const pending = current.ownerRelayList?.pendingDistribution
        if (pending?.signedEvent.id === input.signedEventId) {
          current.ownerRelayList = applyOwnerRelayListDistributionOutcomes(
            current.ownerRelayList!,
            input.update
          )
        }
      } else {
        const pending = current.inboxDeclaration?.pendingDistribution
        if (pending?.signedEvent.id === input.signedEventId) {
          current.inboxDeclaration = applyInboxDeclarationDistributionOutcomes(
            current.inboxDeclaration!,
            input.update
          )
        }
      }
      snapshots.set(normalized, cloneSnapshot(current))
      return cloneSnapshot(current)
    },
  }
}

async function withAccountMutationLock<T>(
  pubkey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = accountMutationTails.get(pubkey) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  accountMutationTails.set(pubkey, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (accountMutationTails.get(pubkey) === tail) {
      accountMutationTails.delete(pubkey)
    }
  }
}

async function eligibleRelayUrls(
  pubkey: string,
  relayUrls: readonly string[],
  dependencies: AccountNetworkMutationDependencies
): Promise<string[]> {
  if (dependencies.filterEligibleRelayUrls) {
    return await dependencies.filterEligibleRelayUrls(pubkey, relayUrls)
  }
  return await filterEligibleAccountRelayUrls({
    accountPubkey: pubkey,
    candidateRelayUrls: relayUrls,
    repository: dexieAccountNetworkLocalStateRepository,
  })
}

async function resolveDistributionPlan(input: {
  pubkey: string
  kind: AccountNetworkSignedKind
  desiredPublishRelayUrls: readonly string[]
  excludedRelayUrls: readonly string[]
  dependencies: AccountNetworkMutationDependencies
}): Promise<string[]> {
  const requested = input.dependencies.resolveRelayPlan
    ? await input.dependencies.resolveRelayPlan({
        pubkey: input.pubkey,
        kind: input.kind,
        desiredPublishRelayUrls: input.desiredPublishRelayUrls,
      })
    : input.kind === EVENT_KINDS.RELAY_LIST
      ? [
          ...input.desiredPublishRelayUrls,
          ...accountNetworkDiscoveryRelayUrls(),
        ]
      : sharedInboxDiscoveryRelayUrls()
  const excluded = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(input.excludedRelayUrls)
  )
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls(requested)
    .filter((relayUrl) => !excluded.has(relayUrl))
    .sort()
    .slice(0, MAX_ACCOUNT_NETWORK_DISTRIBUTION_RELAYS)
  const eligible = await eligibleRelayUrls(
    input.pubkey,
    normalized,
    input.dependencies
  )
  if (eligible.length === 0) {
    throw new AccountNetworkMutationError(
      "no_publish_targets",
      "No eligible shared relay targets are available for this change."
    )
  }
  return [...eligible].sort()
}

function pendingForKind(
  snapshot: AccountNetworkMutationSnapshot,
  kind: AccountNetworkSignedKind
) {
  return kind === EVENT_KINDS.RELAY_LIST
    ? snapshot.ownerRelayList?.pendingDistribution
    : snapshot.inboxDeclaration?.pendingDistribution
}

async function deliverPendingKind(input: {
  pubkey: string
  kind: AccountNetworkSignedKind
  repository: AccountNetworkMutationRepository
  dependencies: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationSnapshot> {
  const now = input.dependencies.now ?? Date.now
  let snapshot = await input.repository.get(input.pubkey)
  let pending = pendingForKind(snapshot, input.kind)
  if (!pending?.relayOutcomes) {
    throw new AccountNetworkMutationError(
      "missing_pending_distribution",
      "No exact signed Network event is waiting for this retry."
    )
  }
  const signedEvent = structuredClone(pending.signedEvent)
  const publishTargets = unresolvedNetworkPreferencePublishRelayUrls(
    pending.relayOutcomes
  )
  const publishObservations: Array<{
    relayUrl: string
    status: ExclusiveRelayPublishStatus
  }> = []
  if (publishTargets.length > 0) {
    input.dependencies.onPhase?.("publishing")
    const publishToRelay =
      input.dependencies.publishToRelay ?? publishSignedEventToRelay
    for (const relayUrl of publishTargets) {
      assertContinue(input.dependencies.shouldContinue)
      const eligible = await eligibleRelayUrls(
        input.pubkey,
        [relayUrl],
        input.dependencies
      )
      if (eligible[0] !== relayUrl) continue
      let status: ExclusiveRelayPublishStatus
      try {
        status = await publishToRelay({
          signedEvent,
          relayUrl,
          authorPubkey: input.pubkey,
          authenticatedPubkey: input.pubkey,
          accountPubkey: input.pubkey,
        })
      } catch {
        status = "timed_out"
      }
      publishObservations.push({ relayUrl, status })
    }
    if (publishObservations.length > 0) {
      snapshot = await input.repository.recordOutcomes({
        pubkey: input.pubkey,
        kind: input.kind,
        signedEventId: signedEvent.id,
        update: {
          publish: publishObservations,
          observedAt: now(),
        },
      })
    }
  }

  pending = pendingForKind(snapshot, input.kind)
  if (!pending?.relayOutcomes || pending.signedEvent.id !== signedEvent.id) {
    return snapshot
  }
  const readbackTargets = unresolvedNetworkPreferenceReadbackRelayUrls(
    pending.relayOutcomes
  )
  const readbackObservations: Array<{
    relayUrl: string
    status: "observed" | "absent" | "timed_out"
  }> = []
  if (readbackTargets.length > 0) {
    input.dependencies.onPhase?.("confirming")
    const fetchEvents =
      input.dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    for (const relayUrl of readbackTargets) {
      assertContinue(input.dependencies.shouldContinue)
      const eligible = await eligibleRelayUrls(
        input.pubkey,
        [relayUrl],
        input.dependencies
      )
      if (eligible[0] !== relayUrl) continue
      try {
        const result = await fetchEvents(
          {
            ids: [signedEvent.id],
            kinds: [input.kind],
            authors: [input.pubkey],
            limit: 1,
          },
          {
            relayUrls: [relayUrl],
            connectTimeoutMs: 4_000,
            fetchTimeoutMs: 6_000,
            skipHealthFilter: true,
            accountPubkey: input.pubkey,
          }
        )
        const sourceExact = result.events.some(
          (event) =>
            sameSignedEvent(event, signedEvent) &&
            (result.eventSourceRelayUrls[event.id] ?? []).includes(relayUrl)
        )
        const relay = result.relays.find(
          (candidate) => candidate.relayUrl === relayUrl
        )
        readbackObservations.push({
          relayUrl,
          status:
            sourceExact && result.eventsVerified
              ? "observed"
              : relay?.status === "success" && result.eventsVerified
                ? "absent"
                : "timed_out",
        })
      } catch {
        readbackObservations.push({ relayUrl, status: "timed_out" })
      }
    }
    if (readbackObservations.length > 0) {
      snapshot = await input.repository.recordOutcomes({
        pubkey: input.pubkey,
        kind: input.kind,
        signedEventId: signedEvent.id,
        update: {
          readback: readbackObservations,
          observedAt: now(),
        },
      })
    }
  }
  await input.dependencies.refreshRuntime?.(input.pubkey)
  return snapshot
}

async function publishUnderLock(input: {
  pubkey: string
  reviewed: ReviewedAccountNetworkMutation
  signer?: NostrEventSigner
  dependencies: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const repository =
    input.dependencies.repository ?? dexieAccountNetworkMutationRepository
  const reconcile =
    input.dependencies.reconcile ?? reconcileAccountNetworkPreferences
  const now = input.dependencies.now ?? Date.now
  input.dependencies.onPhase?.("checking")
  const reconciliation = await reconcile(input.pubkey, {
    ...input.dependencies.reconcileOptions,
    requestingAccountPubkey: input.pubkey,
  })
  const currentReview = reviewAccountNetworkMutation(
    reconciliation,
    input.reviewed.action
  )
  if (!currentReview.evidenceReady) {
    throw new AccountNetworkMutationError(
      "evidence_unavailable",
      "A complete fresh check of both signed Network frontiers is required."
    )
  }
  if (!sameReview(input.reviewed, currentReview)) {
    throw new AccountNetworkMutationError(
      "evidence_changed",
      "Signed Network evidence changed after review."
    )
  }

  const desiredRelayPreferences = stablePreferenceOrder(
    reconciliation.ownerRelayList.preferences,
    relayPreferencesFromAction(currentReview.action)
  )
  const currentInbox = currentInboxRelayUrls(reconciliation.inboxDeclaration)
  const desiredInbox = stableInboxOrder(
    currentInbox,
    inboxRelayUrlsFromAction(currentReview.action)
  )
  const desiredPublishRelayUrls = desiredRelayPreferences.flatMap(
    (preference) => (preference.writeEnabled ? [preference.url] : [])
  )
  const plans = new Map<AccountNetworkSignedKind, string[]>()
  for (const kind of currentReview.changedKinds) {
    plans.set(
      kind,
      await resolveDistributionPlan({
        pubkey: input.pubkey,
        kind,
        desiredPublishRelayUrls,
        excludedRelayUrls: currentReview.action.removedRelayUrls,
        dependencies: input.dependencies,
      })
    )
  }

  if (currentReview.changedKinds.length > 0) {
    if (
      !input.signer ||
      input.signer.authMethod !== "nip07" &&
      input.signer.authMethod !== "nip46"
    ) {
      throw new NostrSignerError("unavailable")
    }
    assertContinue(input.dependencies.shouldContinue)
    const signerPubkey = (await input.signer.getPublicKey())
      .trim()
      .toLowerCase()
    assertContinue(input.dependencies.shouldContinue)
    if (signerPubkey !== input.pubkey) {
      throw new AccountNetworkMutationError(
        "signer_mismatch",
        "The active signer does not match this Network account."
      )
    }
  }

  const unsignedEvents: Array<{
    kind: AccountNetworkSignedKind
    event: Omit<SignedPublicNostrEvent, "id" | "sig">
  }> = currentReview.changedKinds.map((kind) => ({
    kind,
    event: {
      pubkey: input.pubkey,
      kind,
      created_at: selectCreatedAt(
        kind === EVENT_KINDS.RELAY_LIST
          ? currentReview.relayList.createdAt
          : currentReview.inboxDeclaration.createdAt,
        now()
      ),
      tags:
        kind === EVENT_KINDS.RELAY_LIST
          ? serializeNip65RelayTags(desiredRelayPreferences)
          : desiredInbox.map((relayUrl) => ["relay", relayUrl]),
      content: "",
    },
  }))
  const checkpoints: AccountNetworkStagedCheckpoint[] = []
  if (unsignedEvents.length > 0) {
    input.dependencies.onPhase?.("awaiting_signatures")
  }
  for (const draft of unsignedEvents) {
    if (!input.signer) throw new NostrSignerError("unavailable")
    assertContinue(input.dependencies.shouldContinue)
    const signedEvent = await input.signer.signEvent(draft.event)
    assertContinue(input.dependencies.shouldContinue)
    assertValidSignedDraft({ signedEvent, unsignedEvent: draft.event })
    checkpoints.push({
      kind: draft.kind,
      signedEvent: structuredClone(signedEvent),
      publishRelayUrls: [...plans.get(draft.kind)!],
    })
  }

  const localStateChanged = currentReview.action.removedRelayUrls.length > 0
  if (checkpoints.length === 0 && !localStateChanged) {
    return {
      status: "no_change",
      checkpoints: [],
      localStateChanged: false,
      legacyMigrationCompletion: null,
      legacyRecoveryRemoval: null,
    }
  }
  assertContinue(input.dependencies.shouldContinue)
  input.dependencies.onPhase?.("staging")
  const staged = await repository.stage({
    pubkey: input.pubkey,
    expectedRelayListEventId: currentReview.relayList.eventId,
    expectedInboxDeclarationEventId: currentReview.inboxDeclaration.eventId,
    checkpoints,
    previousInboxRelayUrls: currentReview.previousInboxRelayUrls,
    removedRelayUrls: currentReview.action.removedRelayUrls,
    stagedAt: now(),
  })
  assertContinue(input.dependencies.shouldContinue)
  const legacyRecoveryRemoval =
    currentReview.action.removedRelayUrls.length > 0
      ? (input.dependencies.removeLegacyReadRecoveryRelayUrls ??
          removeLegacyRelayReadRecoveryRelayUrls)({
          pubkey: input.pubkey,
          relayUrls: currentReview.action.removedRelayUrls,
          storage: input.dependencies.reconcileOptions?.storage,
        })
      : null
  let legacyMigrationCompletion: CompleteLegacyRelaySettingsMigrationStatus | null =
    null
  if (
    currentReview.legacyReviewCandidate &&
    currentReview.changedKinds.includes(EVENT_KINDS.RELAY_LIST)
  ) {
    const completeLegacyDraftMigration =
      input.dependencies.completeLegacyDraftMigration ??
      completeLegacyRelaySettingsDraftMigration
    legacyMigrationCompletion = await completeLegacyDraftMigration({
      candidate: currentReview.legacyReviewCandidate,
      disposition: "publish_staged",
      storage: input.dependencies.reconcileOptions?.storage,
      localStateRepository:
        input.dependencies.reconcileOptions?.localStateRepository,
      now,
    })
  }
  await input.dependencies.refreshRuntime?.(input.pubkey)

  let delivered = staged
  for (const kind of currentReview.changedKinds) {
    delivered = await deliverPendingKind({
      pubkey: input.pubkey,
      kind,
      repository,
      dependencies: input.dependencies,
    })
  }
  return resultFromSnapshot(
    delivered,
    currentReview.changedKinds,
    localStateChanged,
    legacyMigrationCompletion,
    legacyRecoveryRemoval
  )
}

export async function publishAccountNetworkMutation(input: {
  reviewed: ReviewedAccountNetworkMutation
  /** Required only when the frozen review contains a changed signed kind. */
  signer?: NostrEventSigner
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.reviewed.pubkey)
  return await withAccountMutationLock(
    pubkey,
    async () =>
      await publishUnderLock({
        pubkey,
        reviewed: structuredClone(input.reviewed),
        signer: input.signer,
        dependencies: input.dependencies ?? {},
      })
  )
}

export async function retryAccountNetworkMutation(input: {
  pubkey: string
  kind?: AccountNetworkSignedKind
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.pubkey)
  const dependencies = input.dependencies ?? {}
  const repository =
    dependencies.repository ?? dexieAccountNetworkMutationRepository
  return await withAccountMutationLock(pubkey, async () => {
    const initial = await repository.get(pubkey)
    const kinds = input.kind
      ? [input.kind]
      : ([
          ...(initial.ownerRelayList?.pendingDistribution
            ? [EVENT_KINDS.RELAY_LIST]
            : []),
          ...(initial.inboxDeclaration?.pendingDistribution
            ? [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS]
            : []),
        ] as AccountNetworkSignedKind[])
    if (kinds.length === 0) {
      throw new AccountNetworkMutationError(
        "missing_pending_distribution",
        "No exact signed Network event is waiting to be retried."
      )
    }
    let snapshot = initial
    for (const kind of kinds) {
      snapshot = await deliverPendingKind({
        pubkey,
        kind,
        repository,
        dependencies,
      })
    }
    return resultFromSnapshot(snapshot, kinds, false)
  })
}

/**
 * Reorder is a signer-free local preference. It can rank only relay operations
 * that a caller has already classified as otherwise equivalent and eligible.
 */
export async function reorderAccountNetworkRelays(input: {
  pubkey: string
  relayUrls: readonly string[]
  dependencies?: AccountNetworkLocalMutationDependencies
}): Promise<AccountNetworkLocalState> {
  const pubkey = normalizePubkey(input.pubkey)
  const dependencies = input.dependencies ?? {}
  const repository =
    dependencies.repository ?? dexieAccountNetworkLocalStateRepository
  const updatedAt = (dependencies.now ?? Date.now)()
  return await repository.update(pubkey, (current) =>
    replaceAccountNetworkPreferredRelayOrder(
      current,
      input.relayUrls,
      updatedAt
    )
  )
}

/** Persist existing capability evidence without turning it into signed roles. */
export async function recordAccountNetworkRelayScans(input: {
  pubkey: string
  relayScans: readonly RelayScanResult[]
  dependencies?: AccountNetworkLocalMutationDependencies
}): Promise<AccountNetworkLocalState> {
  const pubkey = normalizePubkey(input.pubkey)
  const dependencies = input.dependencies ?? {}
  const repository =
    dependencies.repository ?? dexieAccountNetworkLocalStateRepository
  const updatedAt = (dependencies.now ?? Date.now)()
  return await repository.update(pubkey, (current) =>
    replaceAccountNetworkRelayScans(current, input.relayScans, updatedAt)
  )
}

/**
 * Repair discoverability by retrying the exact retained kind:10050 bytes.
 * This never asks the signer for a replacement event.
 */
export async function redistributeAccountNetworkInboxDeclaration(input: {
  pubkey: string
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.pubkey)
  const dependencies = input.dependencies ?? {}
  const repository =
    dependencies.repository ?? dexieAccountNetworkMutationRepository
  const reconcile = dependencies.reconcile ?? reconcileAccountNetworkPreferences

  return await withAccountMutationLock(pubkey, async () => {
    const existing = await repository.get(pubkey)
    if (existing.inboxDeclaration?.pendingDistribution) {
      const delivered = await deliverPendingKind({
        pubkey,
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        repository,
        dependencies,
      })
      return resultFromSnapshot(
        delivered,
        [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
        false
      )
    }

    dependencies.onPhase?.("checking")
    const reconciliation = await reconcile(pubkey, {
      ...dependencies.reconcileOptions,
      requestingAccountPubkey: pubkey,
    })
    const inbox = reconciliation.inboxDeclaration
    if (
      inbox.observation?.coverage !== "complete" ||
      (inbox.state !== "declared" && inbox.state !== "distribution_pending") ||
      !inbox.eventId
    ) {
      throw new AccountNetworkMutationError(
        "evidence_unavailable",
        "A complete fresh inbox check is required before redistribution."
      )
    }
    const snapshot = await repository.get(pubkey)
    const current = snapshot.inboxDeclaration?.current
    if (
      current?.state !== "declared" ||
      current.signedEvent.id !== inbox.eventId
    ) {
      throw new AccountNetworkMutationError(
        "evidence_changed",
        "The retained inbox declaration changed before redistribution."
      )
    }

    const plan = await resolveDistributionPlan({
      pubkey,
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      desiredPublishRelayUrls: [],
      excludedRelayUrls: [],
      dependencies,
    })
    dependencies.onPhase?.("staging")
    await repository.stage({
      pubkey,
      expectedRelayListEventId:
        snapshot.ownerRelayList?.current?.signedEvent.id ?? null,
      expectedInboxDeclarationEventId: current.signedEvent.id,
      checkpoints: [
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          signedEvent: structuredClone(current.signedEvent),
          publishRelayUrls: plan,
        },
      ],
      previousInboxRelayUrls: current.secureRelayUrls,
      removedRelayUrls: [],
      stagedAt: (dependencies.now ?? Date.now)(),
    })
    await dependencies.refreshRuntime?.(pubkey)
    const delivered = await deliverPendingKind({
      pubkey,
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      repository,
      dependencies,
    })
    return resultFromSnapshot(
      delivered,
      [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
      false
    )
  })
}

export function __resetAccountNetworkMutationLocksForTests(): void {
  accountMutationTails.clear()
}
