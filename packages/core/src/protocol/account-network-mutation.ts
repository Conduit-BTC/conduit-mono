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
  applyInboxDeclarationDistributionRestage,
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
  normalizeOwnerSelectedRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeSecureOrIsolatedE2eRelayUrls,
  parseNip65RelayTags,
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
  /** Exact whole-relay exclusion set frozen by this review. */
  localExcludedRelayUrls: string[]
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
  /** Kind-10050 only: canonical shared subset that owns cutover confirmation. */
  confirmationRelayUrls?: string[]
}

export interface StageAccountNetworkMutationInput {
  pubkey: string
  expectedRelayListEventId: string | null
  expectedInboxDeclarationEventId: string | null
  /** Compare-and-swap guard for signer-free whole-relay cutoffs. */
  expectedExcludedRelayUrls: readonly string[]
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
  /** Atomically replace only the exact retained kind-10050 delivery plan. */
  restageInboxDistribution(input: {
    pubkey: string
    signedEvent: SignedPublicNostrEvent
    expectedPublishRelayUrls: readonly string[]
    publishRelayUrls: readonly string[]
    stagedAt: number
  }): Promise<AccountNetworkMutationSnapshot>
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
    relayUrls: readonly string[],
    ownerSelectedRelayUrls: readonly string[],
    authenticatedPubkey: string | null
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

function matchingAuthenticatedPubkey(
  pubkey: string,
  authenticatedPubkey: string | null | undefined
): string | null {
  if (!authenticatedPubkey) return null
  try {
    const normalized = normalizePubkey(authenticatedPubkey)
    return normalized === pubkey ? normalized : null
  } catch {
    return null
  }
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

function localExcludedRelayUrls(state: AccountNetworkLocalState): string[] {
  // This state can only be written by the authenticated account mutation.
  return normalizeOwnerSelectedRelayUrls(
    normalizeAccountNetworkLocalState(state).exclusions.map(
      (exclusion) => exclusion.relayUrl
    )
  ).sort()
}

function requireExpectedLocalExclusions(
  state: AccountNetworkLocalState,
  expectedRelayUrls: readonly string[]
): void {
  const expected = normalizeOwnerSelectedRelayUrls(expectedRelayUrls).sort()
  if (!sameStrings(localExcludedRelayUrls(state), expected)) {
    throw new AccountNetworkMutationError(
      "evidence_changed",
      "Whole-relay exclusions changed after this Network review."
    )
  }
}

function normalizeAuthenticatedOwnerInboxRelayUrls(
  accountPubkey: string,
  resolution: InboxDeclarationResolution,
  relayUrls: readonly string[]
): string[] {
  if (normalizePubkey(resolution.pubkey) !== accountPubkey) {
    throw new AccountNetworkMutationError(
      "evidence_changed",
      "Private inbox evidence belongs to another account."
    )
  }
  return normalizeOwnerSelectedRelayUrls(relayUrls)
}

function currentInboxRelayUrls(
  accountPubkey: string,
  resolution: InboxDeclarationResolution
): string[] {
  if (resolution.state === "distribution_pending") {
    return normalizeAuthenticatedOwnerInboxRelayUrls(
      accountPubkey,
      resolution,
      resolution.pendingRelayUrls ?? []
    )
  }
  return resolution.state === "declared"
    ? normalizeAuthenticatedOwnerInboxRelayUrls(
        accountPubkey,
        resolution,
        resolution.relayUrls
      )
    : []
}

function previousInboxRelayUrls(
  accountPubkey: string,
  resolution: InboxDeclarationResolution,
  currentRelayUrls: readonly string[],
  legacyInboxRecoveryRelayUrls: readonly string[]
): string[] {
  const activeRecoveryRelayUrls = new Set(
    normalizeAuthenticatedOwnerInboxRelayUrls(
      accountPubkey,
      resolution,
      resolution.cutoverRecoveryRelayUrls ?? []
    )
  )
  return normalizeAuthenticatedOwnerInboxRelayUrls(accountPubkey, resolution, [
    ...currentRelayUrls,
    ...(resolution.retainedReadRelayUrls ?? []).filter(
      (relayUrl) => !activeRecoveryRelayUrls.has(relayUrl)
    ),
    ...legacyInboxRecoveryRelayUrls.filter(
      (relayUrl) => !activeRecoveryRelayUrls.has(relayUrl)
    ),
  ])
}

function usableInboxRelayUrls(
  accountPubkey: string,
  resolution: InboxDeclarationResolution,
  legacyInboxRecoveryRelayUrls: readonly string[]
): string[] {
  return normalizeAuthenticatedOwnerInboxRelayUrls(accountPubkey, resolution, [
    ...currentInboxRelayUrls(accountPubkey, resolution),
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
    // A reviewed action is the authenticated owner's explicit Network choice.
    const normalized = normalizeOwnerSelectedRelayUrls([relay.url])[0]
    if (!normalized) {
      throw new AccountNetworkMutationError(
        "invalid_preferences",
        "Network preferences require valid ws:// or wss:// relay URLs."
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
  const removedRelayUrls = normalizeOwnerSelectedRelayUrls(
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
  const normalized = normalizeOwnerSelectedRelayUrls(requested)
  if (normalized.length !== requested.length) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Private inboxes require unique valid ws:// or wss:// relay URLs."
    )
  }
  return normalized
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
  const currentInbox = currentInboxRelayUrls(
    pubkey,
    reconciliation.inboxDeclaration
  )
  const desiredInbox = inboxRelayUrlsFromAction(action)
  if (desiredInbox.length > 3) {
    throw new AccountNetworkMutationError(
      "invalid_preferences",
      "Choose no more than three Private inbox relays."
    )
  }
  const removedRelayUrls = new Set(action.removedRelayUrls)
  const survivingRecoveryInboxRelayUrls = normalizeOwnerSelectedRelayUrls([
    ...(reconciliation.inboxDeclaration.retainedReadRelayUrls ?? []),
    ...(reconciliation.inboxDeclaration.cutoverRecoveryRelayUrls ?? []),
    ...(reconciliation.legacyInboxRecoveryRelayUrls ?? []),
  ]).filter((relayUrl) => !removedRelayUrls.has(relayUrl))
  const hadUsableInbox =
    usableInboxRelayUrls(
      pubkey,
      reconciliation.inboxDeclaration,
      reconciliation.legacyInboxRecoveryRelayUrls ?? []
    ).length > 0
  const retainsUsableInbox =
    normalizeOwnerSelectedRelayUrls([
      ...desiredInbox,
      ...survivingRecoveryInboxRelayUrls,
    ]).length > 0
  const removesCurrentInboxWithoutReplacement =
    currentInbox.length > 0 && desiredInbox.length === 0
  if (
    removesCurrentInboxWithoutReplacement ||
    (hadUsableInbox && !retainsUsableInbox)
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
    localExcludedRelayUrls: [...reconciliation.localExcludedRelayUrls].sort(),
    previousInboxRelayUrls: previousInboxRelayUrls(
      pubkey,
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

function inboxRestageRelayUrls(
  localState: AccountNetworkLocalState,
  publishRelayUrls: readonly string[]
): string[] {
  const excludedRelayUrls = new Set(localExcludedRelayUrls(localState))
  const eligibleRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    publishRelayUrls
  ).filter((relayUrl) => !excludedRelayUrls.has(relayUrl))
  if (eligibleRelayUrls.length === 0) {
    throw new AccountNetworkMutationError(
      "no_publish_targets",
      "No eligible shared relay targets remain after current whole-relay exclusions."
    )
  }
  return eligibleRelayUrls
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
  requireExpectedLocalExclusions(
    snapshot.localState,
    input.expectedExcludedRelayUrls
  )
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
          confirmationRelayUrls: checkpoint.confirmationRelayUrls,
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
      input.removedRelayUrls,
      input.stagedAt
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
    async restageInboxDistribution(input) {
      const normalized = normalizePubkey(input.pubkey)
      await db.transaction(
        "rw",
        db.inboxDeclarationEvidence,
        db.accountNetworkLocalState,
        async () => {
          const inboxPubkey =
            normalizeInboxDeclarationEvidencePubkey(normalized)!
          const [existing, storedLocalState] = await Promise.all([
            db.inboxDeclarationEvidence.get(inboxPubkey),
            db.accountNetworkLocalState.get(normalized),
          ])
          if (!existing) {
            throw new AccountNetworkMutationError(
              "evidence_changed",
              "The retained inbox declaration changed before redistribution."
            )
          }
          const publishRelayUrls = inboxRestageRelayUrls(
            storedLocalState ?? emptyAccountNetworkLocalState(normalized),
            input.publishRelayUrls
          )
          const next = applyInboxDeclarationDistributionRestage(existing, {
            ...input,
            pubkey: normalized,
            publishRelayUrls,
            relayOutcomes: initialRelayOutcomes(publishRelayUrls),
            cachedAt: input.stagedAt,
          })
          await db.inboxDeclarationEvidence.put(next)
        }
      )
      return await this.get(normalized)
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
    async restageInboxDistribution(input) {
      const normalized = normalizePubkey(input.pubkey)
      const current = getSnapshot(normalized)
      if (!current.inboxDeclaration) {
        throw new AccountNetworkMutationError(
          "evidence_changed",
          "The retained inbox declaration changed before redistribution."
        )
      }
      const publishRelayUrls = inboxRestageRelayUrls(
        current.localState,
        input.publishRelayUrls
      )
      current.inboxDeclaration = applyInboxDeclarationDistributionRestage(
        current.inboxDeclaration,
        {
          ...input,
          pubkey: normalized,
          publishRelayUrls,
          relayOutcomes: initialRelayOutcomes(publishRelayUrls),
          cachedAt: input.stagedAt,
        }
      )
      snapshots.set(normalized, cloneSnapshot(current))
      return cloneSnapshot(current)
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
  authenticatedPubkey: string | null,
  relayUrls: readonly string[],
  ownerSelectedRelayUrls: readonly string[],
  dependencies: AccountNetworkMutationDependencies
): Promise<string[]> {
  const authorizedOwnerSelectedRelayUrls =
    authenticatedPubkey === pubkey ? ownerSelectedRelayUrls : []
  if (dependencies.filterEligibleRelayUrls) {
    return await dependencies.filterEligibleRelayUrls(
      pubkey,
      relayUrls,
      authorizedOwnerSelectedRelayUrls,
      authenticatedPubkey
    )
  }
  return await filterEligibleAccountRelayUrls({
    accountPubkey: pubkey,
    authenticatedPubkey,
    candidateRelayUrls: relayUrls,
    ownerSelectedRelayUrls: authorizedOwnerSelectedRelayUrls,
    repository: dexieAccountNetworkLocalStateRepository,
  })
}

async function resolveDistributionPlan(input: {
  pubkey: string
  authenticatedPubkey: string | null
  kind: AccountNetworkSignedKind
  desiredPublishRelayUrls: readonly string[]
  excludedRelayUrls: readonly string[]
  dependencies: AccountNetworkMutationDependencies
}): Promise<{
  publishRelayUrls: string[]
  confirmationRelayUrls?: string[]
}> {
  const plannedRelayUrls = input.dependencies.resolveRelayPlan
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
    normalizeOwnerSelectedRelayUrls(input.excludedRelayUrls)
  )
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    input.desiredPublishRelayUrls
  )
  const sharedRelayUrls =
    input.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
      ? normalizePublicOrIsolatedE2eRelayHints(plannedRelayUrls).filter(
          (relayUrl) => !excluded.has(relayUrl)
        )
      : []
  const remoteOrCodeOwnedRelayUrls =
    input.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
      ? sharedRelayUrls
      : normalizePublicOrIsolatedE2eRelayHints(plannedRelayUrls)
  const requested = Array.from(
    new Set([...remoteOrCodeOwnedRelayUrls, ...ownerSelectedRelayUrls])
  ).filter((relayUrl) => !excluded.has(relayUrl))
  const eligible = await eligibleRelayUrls(
    input.pubkey,
    input.authenticatedPubkey,
    requested,
    ownerSelectedRelayUrls,
    input.dependencies
  )
  const eligibleSet = new Set(
    Array.from(
      new Set([
        ...normalizePublicOrIsolatedE2eRelayHints(eligible),
        ...normalizeOwnerSelectedRelayUrls(eligible).filter((relayUrl) =>
          ownerSelectedRelayUrls.includes(relayUrl)
        ),
      ])
    )
  )
  const publishRelayUrls = requested
    .filter((relayUrl) => eligibleSet.has(relayUrl))
    .slice(0, MAX_ACCOUNT_NETWORK_DISTRIBUTION_RELAYS)
  const confirmationRelayUrls = sharedRelayUrls.filter((relayUrl) =>
    publishRelayUrls.includes(relayUrl)
  )
  if (
    publishRelayUrls.length === 0 ||
    (input.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
      confirmationRelayUrls.length === 0)
  ) {
    throw new AccountNetworkMutationError(
      "no_publish_targets",
      "No eligible shared relay targets are available for this change."
    )
  }
  return {
    publishRelayUrls,
    ...(input.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
      ? { confirmationRelayUrls: [...confirmationRelayUrls].sort() }
      : {}),
  }
}

function pendingForKind(
  snapshot: AccountNetworkMutationSnapshot,
  kind: AccountNetworkSignedKind
) {
  return kind === EVENT_KINDS.RELAY_LIST
    ? snapshot.ownerRelayList?.pendingDistribution
    : snapshot.inboxDeclaration?.pendingDistribution
}

function ownerSelectedRelayUrlsFromSnapshot(
  pubkey: string,
  snapshot: AccountNetworkMutationSnapshot
): string[] {
  if (snapshot.ownerRelayList?.pubkey !== pubkey) return []
  const pendingEvent = snapshot.ownerRelayList.pendingDistribution?.signedEvent
  if (
    pendingEvent?.kind === EVENT_KINDS.RELAY_LIST &&
    pendingEvent.pubkey === pubkey
  ) {
    return normalizeOwnerSelectedRelayUrls(
      parseNip65RelayTags(pendingEvent.tags).flatMap((preference) =>
        preference.writeEnabled ? [preference.url] : []
      )
    )
  }
  const evidence =
    snapshot.ownerRelayList.current?.state === "declared"
      ? snapshot.ownerRelayList.current
      : snapshot.ownerRelayList.lastUsable
  return normalizeOwnerSelectedRelayUrls(
    (evidence?.preferences ?? []).flatMap((preference) =>
      preference.writeEnabled ? [preference.url] : []
    )
  )
}

async function deliverPendingKind(input: {
  pubkey: string
  authenticatedPubkey: string | null
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
  const ownerSelectedRelayUrls =
    input.authenticatedPubkey === input.pubkey
      ? ownerSelectedRelayUrlsFromSnapshot(input.pubkey, snapshot)
      : []
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
        input.authenticatedPubkey,
        [relayUrl],
        ownerSelectedRelayUrls,
        input.dependencies
      )
      if (eligible[0] !== relayUrl) continue
      let status: ExclusiveRelayPublishStatus
      try {
        status = await publishToRelay({
          signedEvent,
          relayUrl,
          authorPubkey: input.pubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          accountPubkey: input.pubkey,
          ownerSelectedRelayUrls,
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
        input.authenticatedPubkey,
        [relayUrl],
        ownerSelectedRelayUrls,
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
            authenticatedPubkey: input.authenticatedPubkey,
            ownerSelectedRelayUrls,
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
  authenticatedPubkey: string | null
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
    authenticatedPubkey: input.authenticatedPubkey,
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
  requireExpectedLocalExclusions(
    (await repository.get(input.pubkey)).localState,
    currentReview.localExcludedRelayUrls
  )

  const desiredRelayPreferences = stablePreferenceOrder(
    reconciliation.ownerRelayList.preferences,
    relayPreferencesFromAction(currentReview.action)
  )
  const currentInbox = currentInboxRelayUrls(
    input.pubkey,
    reconciliation.inboxDeclaration
  )
  const desiredInbox = stableInboxOrder(
    currentInbox,
    inboxRelayUrlsFromAction(currentReview.action)
  )
  const desiredPublishRelayUrls = desiredRelayPreferences.flatMap(
    (preference) => (preference.writeEnabled ? [preference.url] : [])
  )
  const plans = new Map<
    AccountNetworkSignedKind,
    Awaited<ReturnType<typeof resolveDistributionPlan>>
  >()
  for (const kind of currentReview.changedKinds) {
    plans.set(
      kind,
      await resolveDistributionPlan({
        pubkey: input.pubkey,
        authenticatedPubkey: input.authenticatedPubkey,
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
      (input.signer.authMethod !== "nip07" &&
        input.signer.authMethod !== "nip46")
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
      publishRelayUrls: [...plans.get(draft.kind)!.publishRelayUrls],
      ...(plans.get(draft.kind)!.confirmationRelayUrls
        ? {
            confirmationRelayUrls: [
              ...plans.get(draft.kind)!.confirmationRelayUrls!,
            ],
          }
        : {}),
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
    expectedExcludedRelayUrls: currentReview.localExcludedRelayUrls,
    checkpoints,
    previousInboxRelayUrls: currentReview.previousInboxRelayUrls,
    removedRelayUrls: currentReview.action.removedRelayUrls,
    stagedAt: now(),
  })
  assertContinue(input.dependencies.shouldContinue)
  const legacyRecoveryRemoval =
    currentReview.action.removedRelayUrls.length > 0
      ? (
          input.dependencies.removeLegacyReadRecoveryRelayUrls ??
          removeLegacyRelayReadRecoveryRelayUrls
        )({
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
      authenticatedPubkey: input.authenticatedPubkey,
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
  authenticatedPubkey?: string | null
  /** Required only when the frozen review contains a changed signed kind. */
  signer?: NostrEventSigner
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.reviewed.pubkey)
  const authenticatedPubkey = matchingAuthenticatedPubkey(
    pubkey,
    input.authenticatedPubkey
  )
  return await withAccountMutationLock(
    pubkey,
    async () =>
      await publishUnderLock({
        pubkey,
        authenticatedPubkey,
        reviewed: structuredClone(input.reviewed),
        signer: input.signer,
        dependencies: input.dependencies ?? {},
      })
  )
}

export async function retryAccountNetworkMutation(input: {
  pubkey: string
  authenticatedPubkey?: string | null
  kind?: AccountNetworkSignedKind
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.pubkey)
  const authenticatedPubkey = matchingAuthenticatedPubkey(
    pubkey,
    input.authenticatedPubkey
  )
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
        authenticatedPubkey,
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
  authenticatedPubkey?: string | null
  dependencies?: AccountNetworkMutationDependencies
}): Promise<AccountNetworkMutationResult> {
  const pubkey = normalizePubkey(input.pubkey)
  const authenticatedPubkey = matchingAuthenticatedPubkey(
    pubkey,
    input.authenticatedPubkey
  )
  const dependencies = input.dependencies ?? {}
  const repository =
    dependencies.repository ?? dexieAccountNetworkMutationRepository
  const reconcile = dependencies.reconcile ?? reconcileAccountNetworkPreferences

  return await withAccountMutationLock(pubkey, async () => {
    const existing = await repository.get(pubkey)
    const existingPending = existing.inboxDeclaration?.pendingDistribution
    if (existingPending) {
      const signedEvent = structuredClone(existingPending.signedEvent)
      const existingPublishRelayUrls = [...existingPending.publishRelayUrls]
      let delivered = await deliverPendingKind({
        pubkey,
        authenticatedPubkey,
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        repository,
        dependencies,
      })
      const currentSharedPlan = await resolveDistributionPlan({
        pubkey,
        authenticatedPubkey,
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        desiredPublishRelayUrls: [],
        excludedRelayUrls: [],
        dependencies,
      })
      const currentSharedRelayUrls =
        currentSharedPlan.confirmationRelayUrls ?? []
      const oldTargets = new Set(existingPublishRelayUrls)
      const stillPending = Boolean(
        delivered.inboxDeclaration?.pendingDistribution
      )
      const needsCurrentSharedRestage =
        currentSharedRelayUrls.some((relayUrl) => !oldTargets.has(relayUrl)) ||
        (stillPending &&
          !sameStrings(existingPublishRelayUrls, currentSharedRelayUrls))
      if (needsCurrentSharedRestage) {
        dependencies.onPhase?.("staging")
        await repository.restageInboxDistribution({
          pubkey,
          signedEvent,
          expectedPublishRelayUrls: existingPublishRelayUrls,
          publishRelayUrls: currentSharedRelayUrls,
          stagedAt: (dependencies.now ?? Date.now)(),
        })
        await dependencies.refreshRuntime?.(pubkey)
        delivered = await deliverPendingKind({
          pubkey,
          authenticatedPubkey,
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          repository,
          dependencies,
        })
      }
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
      authenticatedPubkey,
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
      authenticatedPubkey,
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      desiredPublishRelayUrls: [],
      excludedRelayUrls: [],
      dependencies,
    })
    dependencies.onPhase?.("staging")
    await repository.restageInboxDistribution({
      pubkey,
      signedEvent: structuredClone(current.signedEvent),
      expectedPublishRelayUrls: [],
      publishRelayUrls: plan.confirmationRelayUrls ?? [],
      stagedAt: (dependencies.now ?? Date.now)(),
    })
    await dependencies.refreshRuntime?.(pubkey)
    const delivered = await deliverPendingKind({
      pubkey,
      authenticatedPubkey,
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
