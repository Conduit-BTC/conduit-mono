import type { AccountNetworkPreferenceRelayRole } from "../db"
import { accountNetworkDiscoveryRelayUrls } from "./owner-relay-list-evidence"
import {
  accountNetworkPreferenceUpdateId,
  accountNetworkPreferenceCheckpointConfirmed,
  accountNetworkPreferenceCheckpointSharedSetConfirmed,
  applyAccountNetworkPreferenceRuntimeState,
  dexieAccountNetworkPreferenceUpdateRepository,
  getUnresolvedAccountNetworkPreferencePublishRelayUrls,
  getUnresolvedAccountNetworkPreferenceReadbackRelayUrls,
  NETWORK_PREFERENCE_CUTOVER_GRACE_MS,
  NETWORK_PREFERENCE_CUTOVER_POLICY_VERSION,
  NETWORK_PREFERENCE_MAX_PLAN_RELAYS,
  validateAccountNetworkPreferenceUpdateRecord,
  validateAccountNetworkPreferenceDurableFrontiers,
  type AccountNetworkPreferenceEventCheckpoint,
  type AccountNetworkPreferenceEventKind,
  type AccountNetworkPreferenceDurableFrontiers,
  type AccountNetworkPreferenceReviewFrontier,
  type AccountNetworkPreferenceUpdateRecord,
  type AccountNetworkPreferenceUpdateRepository,
} from "./network-preference-update-state"
import {
  clearLegacyRelayReadRecovery,
  reconcileAccountNetworkPreferences,
  type AccountNetworkPreferencesReconciliation,
  type ReconcileAccountNetworkPreferencesOptions,
} from "./network-preferences"
import { NostrSignerError, type NostrEventSigner } from "./nostr-event-signer"
import type { InboxDeclarationResolution } from "./private-message-routing"
import {
  publishSignedEventToRelay,
  type ExclusiveRelayPublishStatus,
} from "./relay-publish"
import { fetchSignedEventsFanoutDetailed } from "./relay-reader"
import {
  assertSafeNip65RelayList,
  normalizeSecureOrIsolatedE2eRelayUrls,
  serializeNip65RelayTags,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import { EVENT_KINDS } from "./kinds"
import {
  areSameSignedPublicNostrEvent,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const MAX_NETWORK_PREFERENCE_FUTURE_SKEW_SECONDS = 5 * 60
const HEX_PUBKEY = /^[0-9a-f]{64}$/

export interface ReviewedAccountNetworkPreferences {
  relayList: AccountNetworkPreferenceReviewFrontier
  inboxDeclaration: AccountNetworkPreferenceReviewFrontier
}

export type AccountNetworkPreferenceAction =
  | {
      type: "set_roles"
      nip65Preferences: readonly AccountNetworkPreferenceRelayRole[]
      inboxRelayUrls: readonly string[]
      /** Empty kind-10050 is blocked unless the caller explicitly reviewed it. */
      allowSignedEmptyInbox?: boolean
    }
  | {
      type: "remove_relay"
      relayUrl: string
    }

export interface AccountNetworkPreferenceUpdateDependencies {
  repository?: AccountNetworkPreferenceUpdateRepository
  reconcile?: typeof reconcileAccountNetworkPreferences
  reconcileOptions?: ReconcileAccountNetworkPreferencesOptions
  resolveRelayPlan?: (input: {
    pubkey: string
    kind: AccountNetworkPreferenceEventKind
  }) => Promise<readonly string[]> | readonly string[]
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
}

export interface AccountNetworkPreferenceCheckpointResult {
  kind: AccountNetworkPreferenceEventKind
  state: "active" | "superseded"
  exactEventObserved: boolean
  sharedSetConfirmed: boolean
  relayOutcomes: AccountNetworkPreferenceEventCheckpoint["relayOutcomes"]
}

export interface AccountNetworkPreferenceUpdateResult {
  status: "no_change" | "staged"
  update: AccountNetworkPreferenceUpdateRecord | null
  checkpoints: AccountNetworkPreferenceCheckpointResult[]
}

export type AccountNetworkPreferenceUpdateErrorCode =
  | "invalid_account"
  | "evidence_unavailable"
  | "evidence_changed"
  | "pending_update"
  | "invalid_preferences"
  | "no_publish_targets"
  | "signer_mismatch"
  | "invalid_signature"
  | "missing_update"

export class AccountNetworkPreferenceUpdateError extends Error {
  constructor(
    readonly code: AccountNetworkPreferenceUpdateErrorCode,
    message: string
  ) {
    super(message)
    this.name = "AccountNetworkPreferenceUpdateError"
  }
}

const accountMutationTails = new Map<string, Promise<void>>()

async function withAccountMutationLock<T>(
  pubkey: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = accountMutationTails.get(pubkey) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  accountMutationTails.set(pubkey, tail)
  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release()
    if (accountMutationTails.get(pubkey) === tail) {
      accountMutationTails.delete(pubkey)
    }
  }
}

function normalizePubkey(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase()
  if (!HEX_PUBKEY.test(normalized)) {
    throw new AccountNetworkPreferenceUpdateError(
      "invalid_account",
      "Network updates require a valid account public key."
    )
  }
  return normalized
}

function reviewFrontier(input: {
  eventId?: string
  createdAt?: number
  state: string
}): AccountNetworkPreferenceReviewFrontier {
  return {
    eventId: input.eventId ?? null,
    createdAt: input.createdAt ?? null,
    state: input.state,
  }
}

export function reviewAccountNetworkPreferences(
  reconciliation: AccountNetworkPreferencesReconciliation
): ReviewedAccountNetworkPreferences {
  return {
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
  }
}

function sameReview(
  left: ReviewedAccountNetworkPreferences,
  right: ReviewedAccountNetworkPreferences
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertCompleteFreshEvidence(
  reconciliation: AccountNetworkPreferencesReconciliation
): void {
  if (
    reconciliation.ownerRelayList.lookup.coverage !== "complete" ||
    reconciliation.inboxDeclaration.observation?.coverage !== "complete"
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "evidence_unavailable",
      "A complete fresh check of both signed Network frontiers is required."
    )
  }
}

function normalizeNip65Preferences(
  preferences: readonly AccountNetworkPreferenceRelayRole[]
): AccountNetworkPreferenceRelayRole[] {
  const byUrl = new Map<string, AccountNetworkPreferenceRelayRole>()
  for (const preference of preferences) {
    const normalized = tryNormalizeRelayUrl(preference.url)
    if (!normalized.ok) {
      throw new AccountNetworkPreferenceUpdateError(
        "invalid_preferences",
        "NIP-65 preferences contain an invalid relay URL."
      )
    }
    const existing = byUrl.get(normalized.url)
    const readEnabled =
      (existing?.readEnabled ?? false) || preference.readEnabled
    const writeEnabled =
      (existing?.writeEnabled ?? false) || preference.writeEnabled
    if (!readEnabled && !writeEnabled) {
      byUrl.delete(normalized.url)
      continue
    }
    byUrl.set(normalized.url, {
      url: normalized.url,
      readEnabled,
      writeEnabled,
    })
  }
  return [...byUrl.values()]
}

function normalizeInboxRelayUrls(relayUrls: readonly string[]): string[] {
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
  if (normalized.length !== new Set(relayUrls).size) {
    throw new AccountNetworkPreferenceUpdateError(
      "invalid_preferences",
      "Private inbox relays must be unique secure WebSocket URLs."
    )
  }
  return normalized
}

function currentInboxRelayUrls(
  resolution: InboxDeclarationResolution
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls(
    resolution.state === "distribution_pending"
      ? (resolution.pendingRelayUrls ?? [])
      : resolution.state === "declared"
        ? resolution.relayUrls
        : []
  )
}

function previousValidInboxRelayUrls(
  resolution: InboxDeclarationResolution,
  currentRelayUrls: readonly string[]
): string[] {
  if (currentRelayUrls.length > 0) return [...currentRelayUrls]
  if (resolution.state !== "signed_empty" && resolution.state !== "malformed") {
    return []
  }
  return normalizeSecureOrIsolatedE2eRelayUrls(
    resolution.retainedReadRelayUrls ?? []
  )
}

function normalizedContentMatches(input: {
  state: string
  currentTags: string[][]
  desiredTags: string[][]
  usableState: string
}): boolean {
  if (input.desiredTags.length === 0) {
    return input.state === "signed_empty"
  }
  return (
    input.state === input.usableState &&
    JSON.stringify(input.currentTags) === JSON.stringify(input.desiredTags)
  )
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
    throw new AccountNetworkPreferenceUpdateError(
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
  const signed = input.signedEvent
  const unsigned = input.unsignedEvent
  if (
    !isValidSignedPublicNostrEvent(signed) ||
    signed.pubkey !== unsigned.pubkey ||
    signed.kind !== unsigned.kind ||
    signed.created_at !== unsigned.created_at ||
    signed.content !== unsigned.content ||
    JSON.stringify(signed.tags) !== JSON.stringify(unsigned.tags)
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "invalid_signature",
      "The signer returned an invalid Network preference event."
    )
  }
}

function checkpointResults(
  record: AccountNetworkPreferenceUpdateRecord
): AccountNetworkPreferenceCheckpointResult[] {
  return record.checkpoints.map((checkpoint) => ({
    kind: checkpoint.kind,
    state: checkpoint.state,
    exactEventObserved: accountNetworkPreferenceCheckpointConfirmed(checkpoint),
    sharedSetConfirmed:
      accountNetworkPreferenceCheckpointSharedSetConfirmed(checkpoint),
    relayOutcomes: structuredClone(checkpoint.relayOutcomes),
  }))
}

function stagedResult(
  record: AccountNetworkPreferenceUpdateRecord
): AccountNetworkPreferenceUpdateResult {
  return {
    status: "staged",
    update: structuredClone(record),
    checkpoints: checkpointResults(record),
  }
}

async function resolveRelayPlan(
  pubkey: string,
  kind: AccountNetworkPreferenceEventKind,
  excludedRelayUrls: ReadonlySet<string>,
  dependencies: AccountNetworkPreferenceUpdateDependencies
): Promise<string[]> {
  const requested = dependencies.resolveRelayPlan
    ? await dependencies.resolveRelayPlan({ pubkey, kind })
    : accountNetworkDiscoveryRelayUrls()
  const relayPlan = normalizeSecureOrIsolatedE2eRelayUrls(requested)
    .filter((relayUrl) => !excludedRelayUrls.has(relayUrl))
    .slice(0, NETWORK_PREFERENCE_MAX_PLAN_RELAYS)
  if (relayPlan.length === 0) {
    throw new AccountNetworkPreferenceUpdateError(
      "no_publish_targets",
      "No bounded shared relay targets are available for this update."
    )
  }
  return relayPlan
}

function durableFrontierIds(input: {
  relayList: SignedPublicNostrEvent | null
  inboxDeclaration: SignedPublicNostrEvent | null
}): [string | null, string | null] {
  return [input.relayList?.id ?? null, input.inboxDeclaration?.id ?? null]
}

function assertDurableFrontiersMatchReview(
  frontiers: {
    relayList: SignedPublicNostrEvent | null
    inboxDeclaration: SignedPublicNostrEvent | null
  },
  reviewed: ReviewedAccountNetworkPreferences
): void {
  const [relayListId, inboxId] = durableFrontierIds(frontiers)
  if (
    relayListId !== reviewed.relayList.eventId ||
    inboxId !== reviewed.inboxDeclaration.eventId
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "evidence_changed",
      "Durable signed Network evidence changed after review."
    )
  }
}

async function loadValidatedDurableFrontiers(
  repository: AccountNetworkPreferenceUpdateRepository,
  pubkey: string
): Promise<AccountNetworkPreferenceDurableFrontiers> {
  return validateAccountNetworkPreferenceDurableFrontiers(
    pubkey,
    await repository.getDurableFrontiers(pubkey)
  )
}

function checkpointHasOutstandingWork(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): boolean {
  return (
    checkpoint.state === "active" &&
    (getUnresolvedAccountNetworkPreferencePublishRelayUrls(checkpoint).length >
      0 ||
      getUnresolvedAccountNetworkPreferenceReadbackRelayUrls(checkpoint)
        .length > 0)
  )
}

function hasActiveCheckpointWithoutExactDurableFrontier(
  record: AccountNetworkPreferenceUpdateRecord,
  frontiers: AccountNetworkPreferenceDurableFrontiers
): boolean {
  return record.checkpoints.some((checkpoint) => {
    if (checkpoint.state !== "active") return false
    const durable =
      checkpoint.kind === EVENT_KINDS.RELAY_LIST
        ? frontiers.relayList
        : frontiers.inboxDeclaration
    const observed =
      checkpoint.kind === EVENT_KINDS.RELAY_LIST
        ? frontiers.relayListObserved
        : frontiers.inboxDeclarationObserved
    return (
      !observed ||
      !areSameSignedPublicNostrEvent(
        checkpoint.signedEvent,
        durable ?? undefined
      )
    )
  })
}

interface PreparedDraft {
  kind: AccountNetworkPreferenceEventKind
  unsignedEvent: Omit<SignedPublicNostrEvent, "id" | "sig">
  relayPlan: string[]
}

async function deliverStagedUpdate(input: {
  pubkey: string
  updateId: string
  repository: AccountNetworkPreferenceUpdateRepository
  dependencies: AccountNetworkPreferenceUpdateDependencies
}): Promise<AccountNetworkPreferenceUpdateResult> {
  const now = input.dependencies.now ?? Date.now
  assertContinue(input.dependencies.shouldContinue)
  let durable = await input.repository.reconcileSupersession({
    pubkey: input.pubkey,
    updateId: input.updateId,
    observedAt: now(),
  })
  durable = {
    ...durable,
    record: validateAccountNetworkPreferenceUpdateRecord(durable.record),
  }
  assertContinue(input.dependencies.shouldContinue)
  applyAccountNetworkPreferenceRuntimeState(
    durable.record,
    durable.inboxEvidence,
    durable.frontiers
  )

  const publishWork = durable.record.checkpoints.flatMap((checkpoint) =>
    getUnresolvedAccountNetworkPreferencePublishRelayUrls(checkpoint).map(
      (relayUrl) => ({ checkpoint, relayUrl })
    )
  )
  if (publishWork.length > 0) {
    input.dependencies.onPhase?.("publishing")
    assertContinue(input.dependencies.shouldContinue)
    const publishToRelay =
      input.dependencies.publishToRelay ?? publishSignedEventToRelay
    const observations = await Promise.all(
      publishWork.map(async ({ checkpoint, relayUrl }) => {
        assertContinue(input.dependencies.shouldContinue)
        let status: ExclusiveRelayPublishStatus
        try {
          status = await publishToRelay({
            signedEvent: checkpoint.signedEvent,
            relayUrl,
            authorPubkey: input.pubkey,
            authenticatedPubkey: input.pubkey,
          })
        } catch {
          status = "timed_out"
        }
        return { kind: checkpoint.kind, relayUrl, status }
      })
    )
    durable = await input.repository.recordOutcomes({
      pubkey: input.pubkey,
      updateId: input.updateId,
      publish: observations,
      observedAt: now(),
    })
    durable = {
      ...durable,
      record: validateAccountNetworkPreferenceUpdateRecord(durable.record),
    }
  }

  const readbackWork = durable.record.checkpoints.flatMap((checkpoint) =>
    getUnresolvedAccountNetworkPreferenceReadbackRelayUrls(checkpoint).map(
      (relayUrl) => ({ checkpoint, relayUrl })
    )
  )
  if (readbackWork.length > 0) {
    input.dependencies.onPhase?.("confirming")
    const fetchEvents =
      input.dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    const observations = await Promise.all(
      readbackWork.map(async ({ checkpoint, relayUrl }) => {
        assertContinue(input.dependencies.shouldContinue)
        try {
          const result = await fetchEvents(
            {
              ids: [checkpoint.signedEvent.id],
              kinds: [checkpoint.kind],
              authors: [input.pubkey],
              limit: 1,
            },
            {
              relayUrls: [relayUrl],
              connectTimeoutMs: 4_000,
              fetchTimeoutMs: 6_000,
              skipHealthFilter: true,
            }
          )
          const relay = result.relays.find(
            (candidate) => candidate.relayUrl === relayUrl
          )
          const exact = result.events.find((event) =>
            areSameSignedPublicNostrEvent(event, checkpoint.signedEvent)
          )
          const hasExactSource = Boolean(
            exact &&
            result.eventsVerified === true &&
            (result.eventSourceRelayUrls[exact.id] ?? []).includes(relayUrl)
          )
          return {
            kind: checkpoint.kind,
            relayUrl,
            status: hasExactSource
              ? ("observed" as const)
              : relay?.status === "success" && result.eventsVerified === true
                ? ("absent" as const)
                : ("timed_out" as const),
          }
        } catch {
          return {
            kind: checkpoint.kind,
            relayUrl,
            status: "timed_out" as const,
          }
        }
      })
    )
    durable = await input.repository.recordOutcomes({
      pubkey: input.pubkey,
      updateId: input.updateId,
      readback: observations,
      observedAt: now(),
    })
    durable = {
      ...durable,
      record: validateAccountNetworkPreferenceUpdateRecord(durable.record),
    }
  }
  assertContinue(input.dependencies.shouldContinue)
  applyAccountNetworkPreferenceRuntimeState(
    durable.record,
    durable.inboxEvidence,
    durable.frontiers
  )
  return stagedResult(durable.record)
}

async function publishUnderLock(input: {
  pubkey: string
  action: AccountNetworkPreferenceAction
  signer: NostrEventSigner
  reviewed: ReviewedAccountNetworkPreferences
  dependencies: AccountNetworkPreferenceUpdateDependencies
}): Promise<AccountNetworkPreferenceUpdateResult> {
  const repository =
    input.dependencies.repository ??
    dexieAccountNetworkPreferenceUpdateRepository
  const reconcile =
    input.dependencies.reconcile ?? reconcileAccountNetworkPreferences
  const now = input.dependencies.now ?? Date.now
  input.dependencies.onPhase?.("checking")
  const reconciliation = await reconcile(input.pubkey, {
    ...input.dependencies.reconcileOptions,
    networkPreferenceUpdateRepository: repository,
  })
  assertCompleteFreshEvidence(reconciliation)
  if (
    !sameReview(input.reviewed, reviewAccountNetworkPreferences(reconciliation))
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "evidence_changed",
      "Signed Network evidence changed after review."
    )
  }

  const loadedPriorUpdate = await repository.get(input.pubkey)
  let priorUpdate = loadedPriorUpdate
    ? validateAccountNetworkPreferenceUpdateRecord(loadedPriorUpdate)
    : null
  let durableFrontiers: AccountNetworkPreferenceDurableFrontiers
  if (priorUpdate) {
    const reconciledPrior = await repository.reconcileSupersession({
      pubkey: input.pubkey,
      updateId: priorUpdate.updateId,
      observedAt: now(),
    })
    priorUpdate = validateAccountNetworkPreferenceUpdateRecord(
      reconciledPrior.record
    )
    durableFrontiers = await loadValidatedDurableFrontiers(
      repository,
      input.pubkey
    )
    applyAccountNetworkPreferenceRuntimeState(
      priorUpdate,
      reconciledPrior.inboxEvidence,
      durableFrontiers
    )
    if (
      hasActiveCheckpointWithoutExactDurableFrontier(
        priorUpdate,
        durableFrontiers
      )
    ) {
      throw new AccountNetworkPreferenceUpdateError(
        "pending_update",
        "Retry the existing signed Network update before starting another."
      )
    }
  } else {
    durableFrontiers = await loadValidatedDurableFrontiers(
      repository,
      input.pubkey
    )
  }
  assertDurableFrontiersMatchReview(durableFrontiers, input.reviewed)

  const currentNip65 = normalizeNip65Preferences(
    reconciliation.ownerRelayList.preferences
  )
  const currentInbox = currentInboxRelayUrls(reconciliation.inboxDeclaration)
  const previousInbox = previousValidInboxRelayUrls(
    reconciliation.inboxDeclaration,
    currentInbox
  )
  let desiredNip65: AccountNetworkPreferenceRelayRole[]
  let desiredInbox: string[]
  let removedRelayUrl: string | undefined
  if (input.action.type === "set_roles") {
    desiredNip65 = normalizeNip65Preferences(input.action.nip65Preferences)
    desiredInbox = normalizeInboxRelayUrls(input.action.inboxRelayUrls)
  } else {
    const normalizedRemoval = tryNormalizeRelayUrl(input.action.relayUrl)
    if (!normalizedRemoval.ok) {
      throw new AccountNetworkPreferenceUpdateError(
        "invalid_preferences",
        "Whole-setup removal requires a valid relay URL."
      )
    }
    removedRelayUrl = normalizedRemoval.url
    desiredNip65 = currentNip65.filter(
      (preference) => preference.url !== removedRelayUrl
    )
    desiredInbox = currentInbox.filter(
      (relayUrl) => relayUrl !== removedRelayUrl
    )
  }
  const desiredNip65Tags = serializeNip65RelayTags(desiredNip65)
  const currentNip65Tags = serializeNip65RelayTags(currentNip65)
  const desiredInboxTags = desiredInbox.map((relayUrl) => ["relay", relayUrl])
  const currentInboxTags = currentInbox.map((relayUrl) => ["relay", relayUrl])
  const forceBoth = input.action.type === "remove_relay"
  const needsNip65 =
    forceBoth ||
    !normalizedContentMatches({
      state: reconciliation.ownerRelayList.state,
      currentTags: currentNip65Tags,
      desiredTags: desiredNip65Tags,
      usableState: "declared",
    })
  const needsInbox =
    forceBoth ||
    !normalizedContentMatches({
      state: reconciliation.inboxDeclaration.state,
      currentTags: currentInboxTags,
      desiredTags: desiredInboxTags,
      usableState: "declared",
    })
  if (needsInbox && desiredInbox.length > 3) {
    throw new AccountNetworkPreferenceUpdateError(
      "invalid_preferences",
      "Private inbox declarations require one to three secure relays."
    )
  }
  if (
    needsInbox &&
    input.action.type === "set_roles" &&
    desiredInbox.length === 0 &&
    input.action.allowSignedEmptyInbox !== true
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "invalid_preferences",
      "An empty Private inbox declaration requires explicit review."
    )
  }
  if (needsNip65) {
    try {
      assertSafeNip65RelayList(desiredNip65)
    } catch (error) {
      throw new AccountNetworkPreferenceUpdateError(
        "invalid_preferences",
        error instanceof Error ? error.message : "Unsafe NIP-65 preferences."
      )
    }
  }
  if (!needsNip65 && !needsInbox) {
    return { status: "no_change", update: null, checkpoints: [] }
  }
  const carriedCheckpoints = (priorUpdate?.checkpoints ?? []).flatMap(
    (checkpoint) => {
      const kindChanges =
        checkpoint.kind === EVENT_KINDS.RELAY_LIST ? needsNip65 : needsInbox
      return !kindChanges && checkpointHasOutstandingWork(checkpoint)
        ? [structuredClone(checkpoint)]
        : []
    }
  )

  const drafts: PreparedDraft[] = []
  const configuredRelayUrls = new Set([
    ...desiredNip65.map((preference) => preference.url),
    ...desiredInbox,
  ])
  const excludedRelayUrls = new Set(
    [
      ...(priorUpdate?.legacyRecoveryRemovedRelayUrls ?? []),
      ...(removedRelayUrl ? [removedRelayUrl] : []),
    ].filter((relayUrl) => !configuredRelayUrls.has(relayUrl))
  )
  if (needsNip65) {
    drafts.push({
      kind: EVENT_KINDS.RELAY_LIST,
      unsignedEvent: {
        pubkey: input.pubkey,
        kind: EVENT_KINDS.RELAY_LIST,
        created_at: selectCreatedAt(
          durableFrontiers.relayList?.created_at ?? null,
          now()
        ),
        tags: desiredNip65Tags,
        content: "",
      },
      relayPlan: await resolveRelayPlan(
        input.pubkey,
        EVENT_KINDS.RELAY_LIST,
        excludedRelayUrls,
        input.dependencies
      ),
    })
  }
  if (needsInbox) {
    drafts.push({
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      unsignedEvent: {
        pubkey: input.pubkey,
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: selectCreatedAt(
          durableFrontiers.inboxDeclaration?.created_at ?? null,
          now()
        ),
        tags: desiredInboxTags,
        content: "",
      },
      relayPlan: await resolveRelayPlan(
        input.pubkey,
        EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        excludedRelayUrls,
        input.dependencies
      ),
    })
  }

  if (
    input.signer.authMethod !== "nip07" &&
    input.signer.authMethod !== "nip46"
  ) {
    throw new NostrSignerError("unavailable")
  }
  assertContinue(input.dependencies.shouldContinue)
  const signerPubkey = (await input.signer.getPublicKey()).trim().toLowerCase()
  assertContinue(input.dependencies.shouldContinue)
  if (signerPubkey !== input.pubkey) {
    throw new AccountNetworkPreferenceUpdateError(
      "signer_mismatch",
      "The active signer does not match this Network account."
    )
  }
  input.dependencies.onPhase?.("awaiting_signatures")
  const signedCheckpoints: Array<
    Omit<AccountNetworkPreferenceEventCheckpoint, "stagedAt">
  > = []
  for (const draft of drafts) {
    assertContinue(input.dependencies.shouldContinue)
    const signedEvent = await input.signer.signEvent(draft.unsignedEvent)
    assertContinue(input.dependencies.shouldContinue)
    assertValidSignedDraft({ signedEvent, unsignedEvent: draft.unsignedEvent })
    signedCheckpoints.push({
      kind: draft.kind,
      signedEvent: structuredClone(signedEvent),
      relayPlan: [...draft.relayPlan],
      relayOutcomes: draft.relayPlan.map((relayUrl) => ({
        relayUrl,
        publishStatus: "pending",
        publishAttemptCount: 0,
        readbackStatus: "pending",
        readbackAttemptCount: 0,
      })),
      state: "active",
    })
  }

  // A delayed external signer must not turn a reviewed stale frontier into a
  // network write. The atomic stage repeats this check and supersedes each
  // affected kind independently while retaining its exact bytes for audit.
  assertContinue(input.dependencies.shouldContinue)
  const finalFrontiers = await loadValidatedDurableFrontiers(
    repository,
    input.pubkey
  )
  if (
    input.action.type === "remove_relay" &&
    durableFrontierIds(finalFrontiers).some(
      (eventId, index) =>
        eventId !==
        (index === 0
          ? input.reviewed.relayList.eventId
          : input.reviewed.inboxDeclaration.eventId)
    )
  ) {
    throw new AccountNetworkPreferenceUpdateError(
      "evidence_changed",
      "A signed Network frontier changed before the whole removal was staged."
    )
  }
  input.dependencies.onPhase?.("staging")
  assertContinue(input.dependencies.shouldContinue)
  const successorStagedAt = Math.max(now(), priorUpdate?.updatedAt ?? 0)
  const checkpoints: AccountNetworkPreferenceEventCheckpoint[] = [
    ...carriedCheckpoints,
    ...signedCheckpoints.map((checkpoint) => ({
      ...checkpoint,
      stagedAt: successorStagedAt,
    })),
  ].sort((left, right) => left.kind - right.kind)
  const stagedAt = Math.min(
    ...checkpoints.map((checkpoint) => checkpoint.stagedAt)
  )
  const updateId = accountNetworkPreferenceUpdateId(checkpoints)
  const staged = await repository.stage({
    expectedUpdateId: priorUpdate?.updateId ?? null,
    record: {
      pubkey: input.pubkey,
      updateId,
      action:
        input.action.type === "remove_relay"
          ? "whole_relay_removal"
          : "ordinary",
      removedRelayUrl,
      baseRelayList: structuredClone(input.reviewed.relayList),
      baseInboxDeclaration: structuredClone(input.reviewed.inboxDeclaration),
      nip65Preferences: desiredNip65,
      inboxRelayUrls: desiredInbox,
      previousInboxRelayUrls: previousInbox,
      legacyRecoveryRemovedRelayUrls: removedRelayUrl ? [removedRelayUrl] : [],
      // The atomic stage reducer promotes this only when the kind-10050
      // checkpoint remains active after its final durable-frontier check.
      legacyRecoveryDiscarded: false,
      cutoverPolicyVersion: NETWORK_PREFERENCE_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: NETWORK_PREFERENCE_CUTOVER_GRACE_MS,
      checkpoints,
      stagedAt,
      updatedAt: successorStagedAt,
    },
  })
  assertContinue(input.dependencies.shouldContinue)
  const stagedRecord = validateAccountNetworkPreferenceUpdateRecord(
    staged.record
  )
  assertContinue(input.dependencies.shouldContinue)
  applyAccountNetworkPreferenceRuntimeState(
    stagedRecord,
    staged.inboxEvidence,
    staged.frontiers
  )
  if (stagedRecord.legacyRecoveryDiscarded) {
    clearLegacyRelayReadRecovery({
      pubkey: input.pubkey,
      storage: input.dependencies.reconcileOptions?.storage,
    })
  }
  return await deliverStagedUpdate({
    pubkey: input.pubkey,
    updateId: stagedRecord.updateId,
    repository,
    dependencies: input.dependencies,
  })
}

export async function publishAccountNetworkPreferenceUpdate(input: {
  pubkey: string
  action: AccountNetworkPreferenceAction
  signer: NostrEventSigner
  reviewed: ReviewedAccountNetworkPreferences
  dependencies?: AccountNetworkPreferenceUpdateDependencies
}): Promise<AccountNetworkPreferenceUpdateResult> {
  const pubkey = normalizePubkey(input.pubkey)
  return await withAccountMutationLock(
    pubkey,
    async () =>
      await publishUnderLock({
        ...input,
        pubkey,
        dependencies: input.dependencies ?? {},
      })
  )
}

export async function retryAccountNetworkPreferenceUpdate(input: {
  pubkey: string
  dependencies?: AccountNetworkPreferenceUpdateDependencies
}): Promise<AccountNetworkPreferenceUpdateResult> {
  const pubkey = normalizePubkey(input.pubkey)
  const dependencies = input.dependencies ?? {}
  return await withAccountMutationLock(pubkey, async () => {
    const repository =
      dependencies.repository ?? dexieAccountNetworkPreferenceUpdateRepository
    const record = await repository.get(pubkey)
    if (!record) {
      throw new AccountNetworkPreferenceUpdateError(
        "missing_update",
        "No signed Network update is waiting to be retried."
      )
    }
    dependencies.onPhase?.("checking")
    await (dependencies.reconcile ?? reconcileAccountNetworkPreferences)(
      pubkey,
      {
        ...dependencies.reconcileOptions,
        networkPreferenceUpdateRepository: repository,
      }
    )
    return await deliverStagedUpdate({
      pubkey,
      updateId: record.updateId,
      repository,
      dependencies,
    })
  })
}

export function __resetAccountNetworkPreferenceUpdateLocksForTests(): void {
  accountMutationTails.clear()
}
