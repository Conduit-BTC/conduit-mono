import {
  db,
  type AccountNetworkPreferenceEventCheckpoint,
  type AccountNetworkPreferenceEventKind,
  type AccountNetworkPreferenceReadbackStatus,
  type AccountNetworkPreferenceUpdateRecord,
  type InboxDeclarationEvidenceRecord,
  type NormalizedInboxDeclarationPubkey,
  type NormalizedOwnerRelayListPubkey,
  type OwnerRelayListEvidenceRecord,
} from "../db"
import {
  applyInboxDeclarationDistributionStage,
  applyInboxDeclarationEvidenceMerge,
  cloneInboxDeclarationEvidenceRecord,
  normalizeInboxDeclarationEvidencePubkey,
  rebindInboxDeclarationCoordinatedUpdate,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  applyOwnerRelayListEvidenceReconciliation,
  normalizeOwnerRelayListPubkey,
  projectOwnerRelayPreferencesFromSignedTags,
} from "./owner-relay-list-evidence"
import {
  clearInboxMigrationRecoveryRelayUrls,
  primeInboxDeclarationEvidence,
  setInboxCoordinatedPendingCheckpoint,
  setInboxExplicitRemovalRelayUrls,
} from "./private-message-routing"
import {
  assertSafeNip65RelayList,
  createRelaySettingsFromPreferences,
  normalizeSecureOrIsolatedE2eRelayUrls,
  serializeNip65RelayTags,
  setAccountRelaySettingsProjection,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import { getAccountRelayScope } from "./session"
import {
  areSameSignedPublicNostrEvent,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type {
  AccountNetworkPreferenceEventCheckpoint,
  AccountNetworkPreferenceEventKind,
  AccountNetworkPreferencePublishStatus,
  AccountNetworkPreferenceReadbackStatus,
  AccountNetworkPreferenceRelayOutcome,
  AccountNetworkPreferenceReviewFrontier,
  AccountNetworkPreferenceUpdateRecord,
} from "../db"

export const NETWORK_PREFERENCE_CUTOVER_POLICY_VERSION = 1
export const NETWORK_PREFERENCE_CUTOVER_GRACE_MS = 30 * 24 * 60 * 60 * 1_000
export const NETWORK_PREFERENCE_MAX_PLAN_RELAYS = 8

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/

export interface AccountNetworkPreferenceDurableFrontiers {
  relayList: SignedPublicNostrEvent | null
  relayListObserved: boolean
  inboxDeclaration: SignedPublicNostrEvent | null
  inboxDeclarationObserved: boolean
}

export interface StageAccountNetworkPreferenceUpdateResult {
  record: AccountNetworkPreferenceUpdateRecord
  inboxEvidence: InboxDeclarationEvidenceRecord | null
  /** Exact durable frontier snapshot used by the atomic state transition. */
  frontiers: AccountNetworkPreferenceDurableFrontiers
}

export interface AccountNetworkPreferencePublishObservation {
  kind: AccountNetworkPreferenceEventKind
  relayUrl: string
  status: "acked" | "rejected" | "timed_out"
}

export interface AccountNetworkPreferenceReadbackObservation {
  kind: AccountNetworkPreferenceEventKind
  relayUrl: string
  status: Exclude<AccountNetworkPreferenceReadbackStatus, "pending">
}

export interface RecordAccountNetworkPreferenceOutcomesInput {
  pubkey: string
  updateId: string
  publish?: readonly AccountNetworkPreferencePublishObservation[]
  readback?: readonly AccountNetworkPreferenceReadbackObservation[]
  observedAt: number
}

export interface AccountNetworkPreferenceUpdateRepository {
  get(pubkey: string): Promise<AccountNetworkPreferenceUpdateRecord | null>
  getDurableFrontiers(
    pubkey: string
  ): Promise<AccountNetworkPreferenceDurableFrontiers>
  stage(input: {
    record: AccountNetworkPreferenceUpdateRecord
    expectedUpdateId: string | null
  }): Promise<StageAccountNetworkPreferenceUpdateResult>
  recordOutcomes(
    input: RecordAccountNetworkPreferenceOutcomesInput
  ): Promise<StageAccountNetworkPreferenceUpdateResult>
  reconcileSupersession(input: {
    pubkey: string
    updateId: string
    observedAt: number
  }): Promise<StageAccountNetworkPreferenceUpdateResult>
}

export class AccountNetworkPreferenceUpdateConflictError extends Error {
  readonly code: "update_changed" | "missing_update"

  constructor(
    code: AccountNetworkPreferenceUpdateConflictError["code"],
    message: string
  ) {
    super(message)
    this.name = "AccountNetworkPreferenceUpdateConflictError"
    this.code = code
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function compareReplaceableEvents(
  candidate: SignedPublicNostrEvent,
  current: SignedPublicNostrEvent
): -1 | 0 | 1 {
  if (candidate.created_at > current.created_at) return 1
  if (candidate.created_at < current.created_at) return -1
  if (candidate.id === current.id) return 0
  return candidate.id < current.id ? 1 : -1
}

function eventForKind(
  frontiers: AccountNetworkPreferenceDurableFrontiers,
  kind: AccountNetworkPreferenceEventKind
): SignedPublicNostrEvent | null {
  return kind === EVENT_KINDS.RELAY_LIST
    ? frontiers.relayList
    : frontiers.inboxDeclaration
}

function baseEventIdForKind(
  record: AccountNetworkPreferenceUpdateRecord,
  kind: AccountNetworkPreferenceEventKind
): string | null {
  return kind === EVENT_KINDS.RELAY_LIST
    ? record.baseRelayList.eventId
    : record.baseInboxDeclaration.eventId
}

function inboxRelayUrlsFromSignedEvent(
  signedEvent: SignedPublicNostrEvent
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls(
    signedEvent.tags.flatMap((tag) =>
      tag[0] === "relay" && tag[1] ? [tag[1]] : []
    )
  )
}

function validateTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`)
  }
  return value
}

function invalidStoredUpdate(reason: string): never {
  throw new Error(`Stored Network preference update is invalid: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameOrderedValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateDurableFrontierEvent(
  value: unknown,
  pubkey: string,
  kind: AccountNetworkPreferenceEventKind,
  label: string
): SignedPublicNostrEvent | null {
  if (value === null) return null
  if (!isRecord(value)) {
    return invalidStoredUpdate(`${label} durable frontier is malformed`)
  }
  const signedEvent = value as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== pubkey ||
    signedEvent.kind !== kind ||
    !HEX_64.test(signedEvent.id) ||
    !HEX_64.test(signedEvent.pubkey) ||
    !HEX_128.test(signedEvent.sig)
  ) {
    return invalidStoredUpdate(`${label} durable frontier is invalid`)
  }
  return clone(signedEvent)
}

/** Validate repository frontier data before it can supersede or project. */
export function validateAccountNetworkPreferenceDurableFrontiers(
  pubkey: string,
  value: unknown
): AccountNetworkPreferenceDurableFrontiers {
  const normalizedPubkey = requireCanonicalPubkey(pubkey)
  if (
    !isRecord(value) ||
    typeof value.relayListObserved !== "boolean" ||
    typeof value.inboxDeclarationObserved !== "boolean"
  ) {
    return invalidStoredUpdate("durable Network frontiers are malformed")
  }
  const relayList = validateDurableFrontierEvent(
    value.relayList,
    normalizedPubkey,
    EVENT_KINDS.RELAY_LIST,
    "kind-10002"
  )
  const inboxDeclaration = validateDurableFrontierEvent(
    value.inboxDeclaration,
    normalizedPubkey,
    EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
    "kind-10050"
  )
  if (
    (value.relayListObserved && !relayList) ||
    (value.inboxDeclarationObserved && !inboxDeclaration)
  ) {
    return invalidStoredUpdate(
      "observed durable frontier is missing its signed event"
    )
  }
  return {
    relayList,
    relayListObserved: value.relayListObserved,
    inboxDeclaration,
    inboxDeclarationObserved: value.inboxDeclarationObserved,
  }
}

function validateCanonicalRelayUrls(
  value: unknown,
  input: {
    label: string
    secure: boolean
    minimum?: number
    maximum?: number
  }
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return invalidStoredUpdate(`${input.label} must be a relay URL array`)
  }
  const relayUrls = value as string[]
  let canonical: string[]
  if (input.secure) {
    canonical = normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
  } else {
    canonical = []
    const seen = new Set<string>()
    for (const relayUrl of relayUrls) {
      const normalized = tryNormalizeRelayUrl(relayUrl)
      if (!normalized.ok || seen.has(normalized.url)) {
        return invalidStoredUpdate(`${input.label} is not canonical and unique`)
      }
      seen.add(normalized.url)
      canonical.push(normalized.url)
    }
  }
  if (!sameOrderedValues(canonical, relayUrls)) {
    return invalidStoredUpdate(`${input.label} is not canonical and unique`)
  }
  if (canonical.length < (input.minimum ?? 0)) {
    return invalidStoredUpdate(`${input.label} has too few relays`)
  }
  if (canonical.length > (input.maximum ?? Number.MAX_SAFE_INTEGER)) {
    return invalidStoredUpdate(`${input.label} has too many relays`)
  }
  return canonical
}

function validateRelayRoles(
  value: unknown
): AccountNetworkPreferenceUpdateRecord["nip65Preferences"] {
  if (!Array.isArray(value)) {
    return invalidStoredUpdate("NIP-65 roles must be an array")
  }
  const roles: AccountNetworkPreferenceUpdateRecord["nip65Preferences"] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.url !== "string" ||
      typeof entry.readEnabled !== "boolean" ||
      typeof entry.writeEnabled !== "boolean" ||
      (!entry.readEnabled && !entry.writeEnabled)
    ) {
      return invalidStoredUpdate("NIP-65 roles are malformed")
    }
    const normalized = tryNormalizeRelayUrl(entry.url)
    if (!normalized.ok || normalized.url !== entry.url || seen.has(entry.url)) {
      return invalidStoredUpdate("NIP-65 roles are not canonical and unique")
    }
    seen.add(entry.url)
    roles.push({
      url: entry.url,
      readEnabled: entry.readEnabled,
      writeEnabled: entry.writeEnabled,
    })
  }
  if (serializeNip65RelayTags(roles).length !== roles.length) {
    return invalidStoredUpdate("NIP-65 roles cannot be serialized exactly")
  }
  return roles
}

function validateReviewFrontier(
  value: unknown,
  label: string
): AccountNetworkPreferenceUpdateRecord["baseRelayList"] {
  if (
    !isRecord(value) ||
    typeof value.state !== "string" ||
    value.state.length === 0 ||
    value.state.length > 64
  ) {
    return invalidStoredUpdate(`${label} review frontier is malformed`)
  }
  const eventId = value.eventId
  const createdAt = value.createdAt
  if (!(
    (eventId === null && createdAt === null) ||
    (typeof eventId === "string" &&
      HEX_64.test(eventId) &&
      typeof createdAt === "number" &&
      Number.isSafeInteger(createdAt) &&
      createdAt >= 0)
  )) {
    return invalidStoredUpdate(`${label} review frontier is inconsistent`)
  }
  return { eventId, createdAt, state: value.state }
}

const PUBLISH_STATUSES = new Set(["pending", "acked", "rejected", "timed_out"])
const READBACK_STATUSES = new Set([
  "pending",
  "observed",
  "absent",
  "timed_out",
])

function validateAttempt(input: {
  status: unknown
  allowedStatuses: ReadonlySet<string>
  attemptCount: unknown
  attemptedAt: unknown
  label: string
  stagedAt: number
  updatedAt: number
}): {
  status: string
  attemptCount: number
  attemptedAt?: number
} {
  if (
    typeof input.status !== "string" ||
    !input.allowedStatuses.has(input.status) ||
    typeof input.attemptCount !== "number" ||
    !Number.isSafeInteger(input.attemptCount) ||
    input.attemptCount < 0
  ) {
    return invalidStoredUpdate(`${input.label} outcome is malformed`)
  }
  if (input.status === "pending") {
    if (input.attemptCount !== 0 || input.attemptedAt !== undefined) {
      return invalidStoredUpdate(`${input.label} pending outcome was attempted`)
    }
    return { status: input.status, attemptCount: input.attemptCount }
  }
  const attemptedAt = validateTimestamp(
    input.attemptedAt,
    `${input.label} attemptedAt`
  )
  if (
    input.attemptCount < 1 ||
    attemptedAt < input.stagedAt ||
    attemptedAt > input.updatedAt
  ) {
    return invalidStoredUpdate(
      `${input.label} attempt metadata is inconsistent`
    )
  }
  return { status: input.status, attemptCount: input.attemptCount, attemptedAt }
}

function validateCheckpoint(input: {
  value: unknown
  pubkey: string
  rowStagedAt: number
  updatedAt: number
}): AccountNetworkPreferenceEventCheckpoint {
  const value = input.value
  if (
    !isRecord(value) ||
    (value.kind !== EVENT_KINDS.RELAY_LIST &&
      value.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) ||
    !isRecord(value.signedEvent)
  ) {
    return invalidStoredUpdate("event checkpoint is malformed")
  }
  const signedEvent = value.signedEvent as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== input.pubkey ||
    signedEvent.kind !== value.kind ||
    signedEvent.content !== "" ||
    !HEX_64.test(signedEvent.id) ||
    !HEX_64.test(signedEvent.pubkey) ||
    !HEX_128.test(signedEvent.sig)
  ) {
    return invalidStoredUpdate("event checkpoint signature or body is invalid")
  }
  const stagedAt = validateTimestamp(value.stagedAt, "checkpoint stagedAt")
  if (stagedAt < input.rowStagedAt || stagedAt > input.updatedAt) {
    return invalidStoredUpdate("checkpoint staging time is inconsistent")
  }
  const relayPlan = validateCanonicalRelayUrls(value.relayPlan, {
    label: "checkpoint relay plan",
    secure: true,
    minimum: 1,
    maximum: NETWORK_PREFERENCE_MAX_PLAN_RELAYS,
  })
  if (
    !Array.isArray(value.relayOutcomes) ||
    value.relayOutcomes.length !== relayPlan.length
  ) {
    return invalidStoredUpdate(
      "checkpoint outcomes do not match the relay plan"
    )
  }
  const relayOutcomes = value.relayOutcomes.map((raw, index) => {
    if (!isRecord(raw) || raw.relayUrl !== relayPlan[index]) {
      return invalidStoredUpdate("checkpoint outcomes changed the relay plan")
    }
    const publish = validateAttempt({
      status: raw.publishStatus,
      allowedStatuses: PUBLISH_STATUSES,
      attemptCount: raw.publishAttemptCount,
      attemptedAt: raw.publishAttemptedAt,
      label: "publish",
      stagedAt,
      updatedAt: input.updatedAt,
    })
    const readback = validateAttempt({
      status: raw.readbackStatus,
      allowedStatuses: READBACK_STATUSES,
      attemptCount: raw.readbackAttemptCount,
      attemptedAt: raw.readbackAttemptedAt,
      label: "readback",
      stagedAt,
      updatedAt: input.updatedAt,
    })
    let observedAt: number | undefined
    if (readback.status === "observed") {
      observedAt = validateTimestamp(raw.observedAt, "readback observedAt")
      if (observedAt !== readback.attemptedAt) {
        return invalidStoredUpdate("readback observation time is inconsistent")
      }
    } else if (raw.observedAt !== undefined) {
      return invalidStoredUpdate(
        "non-observed readback retained an observation"
      )
    }
    return {
      relayUrl: relayPlan[index]!,
      publishStatus:
        publish.status as AccountNetworkPreferenceEventCheckpoint["relayOutcomes"][number]["publishStatus"],
      publishAttemptCount: publish.attemptCount,
      publishAttemptedAt: publish.attemptedAt,
      readbackStatus:
        readback.status as AccountNetworkPreferenceEventCheckpoint["relayOutcomes"][number]["readbackStatus"],
      readbackAttemptCount: readback.attemptCount,
      readbackAttemptedAt: readback.attemptedAt,
      observedAt,
    }
  })
  if (value.state !== "active" && value.state !== "superseded") {
    return invalidStoredUpdate("checkpoint state is invalid")
  }
  let supersededAt: number | undefined
  if (value.state === "superseded") {
    supersededAt = validateTimestamp(
      value.supersededAt,
      "checkpoint supersededAt"
    )
    if (supersededAt < stagedAt || supersededAt > input.updatedAt) {
      return invalidStoredUpdate("checkpoint supersession time is inconsistent")
    }
  } else if (value.supersededAt !== undefined) {
    return invalidStoredUpdate("active checkpoint has supersession metadata")
  }
  return {
    kind: value.kind,
    signedEvent: clone(signedEvent),
    stagedAt,
    relayPlan,
    relayOutcomes,
    state: value.state,
    supersededAt,
  }
}

export function accountNetworkPreferenceUpdateId(
  checkpoints: readonly Pick<
    AccountNetworkPreferenceEventCheckpoint,
    "kind" | "signedEvent"
  >[]
): string {
  return checkpoints
    .map((checkpoint) => `${checkpoint.kind}:${checkpoint.signedEvent.id}`)
    .join("|")
}

/** Validate untrusted IndexedDB or injected repository state before projection. */
export function validateAccountNetworkPreferenceUpdateRecord(
  value: unknown
): AccountNetworkPreferenceUpdateRecord {
  if (!isRecord(value)) return invalidStoredUpdate("row is not an object")
  const pubkey =
    typeof value.pubkey === "string"
      ? requireCanonicalPubkey(value.pubkey)
      : invalidStoredUpdate("account is missing")
  if (value.pubkey !== pubkey) {
    return invalidStoredUpdate("account is not canonical")
  }
  const stagedAt = validateTimestamp(value.stagedAt, "Network update stagedAt")
  const updatedAt = validateTimestamp(
    value.updatedAt,
    "Network update updatedAt"
  )
  if (updatedAt < stagedAt) {
    return invalidStoredUpdate("updatedAt precedes stagedAt")
  }
  if (
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length < 1 ||
    value.checkpoints.length > 2
  ) {
    return invalidStoredUpdate("checkpoint count is invalid")
  }
  const checkpoints = value.checkpoints.map((checkpoint) =>
    validateCheckpoint({
      value: checkpoint,
      pubkey,
      rowStagedAt: stagedAt,
      updatedAt,
    })
  )
  if (
    stagedAt !==
    Math.min(...checkpoints.map((checkpoint) => checkpoint.stagedAt))
  ) {
    return invalidStoredUpdate(
      "row staging time must match its earliest exact checkpoint"
    )
  }
  const kinds = checkpoints.map((checkpoint) => checkpoint.kind)
  if (
    new Set(kinds).size !== kinds.length ||
    !sameOrderedValues(
      kinds,
      [...kinds].sort((left, right) => left - right)
    )
  ) {
    return invalidStoredUpdate("checkpoint kinds are duplicated or unordered")
  }
  const updateId = accountNetworkPreferenceUpdateId(checkpoints)
  if (value.updateId !== updateId) {
    return invalidStoredUpdate("update id does not match exact signed events")
  }
  const baseRelayList = validateReviewFrontier(
    value.baseRelayList,
    "kind-10002"
  )
  const baseInboxDeclaration = validateReviewFrontier(
    value.baseInboxDeclaration,
    "kind-10050"
  )
  for (const checkpoint of checkpoints) {
    const base =
      checkpoint.kind === EVENT_KINDS.RELAY_LIST
        ? baseRelayList
        : baseInboxDeclaration
    const carried = checkpoint.signedEvent.id === base.eventId
    if (
      carried
        ? checkpoint.signedEvent.created_at !== base.createdAt
        : base.createdAt !== null &&
          checkpoint.signedEvent.created_at <= base.createdAt
    ) {
      return invalidStoredUpdate(
        "checkpoint neither carries nor advances its reviewed frontier"
      )
    }
  }
  const nip65Preferences = validateRelayRoles(value.nip65Preferences)
  const inboxRelayUrls = validateCanonicalRelayUrls(value.inboxRelayUrls, {
    label: "desired inbox relays",
    secure: true,
  })
  const previousInboxRelayUrls = validateCanonicalRelayUrls(
    value.previousInboxRelayUrls,
    { label: "previous inbox relays", secure: true }
  )
  const legacyRecoveryRemovedRelayUrls = validateCanonicalRelayUrls(
    value.legacyRecoveryRemovedRelayUrls,
    { label: "legacy recovery tombstones", secure: false }
  )
  if (typeof value.legacyRecoveryDiscarded !== "boolean") {
    return invalidStoredUpdate("legacy recovery discard state is invalid")
  }
  if (
    value.cutoverPolicyVersion !== NETWORK_PREFERENCE_CUTOVER_POLICY_VERSION ||
    value.cutoverGraceMs !== NETWORK_PREFERENCE_CUTOVER_GRACE_MS
  ) {
    return invalidStoredUpdate("cutover policy is unsupported")
  }
  for (const checkpoint of checkpoints) {
    if (checkpoint.state !== "active") continue
    if (checkpoint.kind === EVENT_KINDS.RELAY_LIST) {
      if (
        !sameOrderedValues(
          checkpoint.signedEvent.tags,
          serializeNip65RelayTags(nip65Preferences)
        )
      ) {
        return invalidStoredUpdate(
          "active kind-10002 roles do not match signed tags"
        )
      }
      try {
        assertSafeNip65RelayList(nip65Preferences)
      } catch {
        return invalidStoredUpdate("active kind-10002 roles are unsafe")
      }
    } else {
      if (
        inboxRelayUrls.length > 3 ||
        !sameOrderedValues(
          checkpoint.signedEvent.tags,
          inboxRelayUrls.map((relayUrl) => ["relay", relayUrl])
        )
      ) {
        return invalidStoredUpdate(
          "active kind-10050 roles do not match signed tags"
        )
      }
    }
  }
  if (value.action !== "ordinary" && value.action !== "whole_relay_removal") {
    return invalidStoredUpdate("action is invalid")
  }
  let removedRelayUrl: string | undefined
  if (value.action === "whole_relay_removal") {
    if (typeof value.removedRelayUrl !== "string") {
      return invalidStoredUpdate("whole removal is missing its relay")
    }
    const normalizedRemoval = tryNormalizeRelayUrl(value.removedRelayUrl)
    if (
      !normalizedRemoval.ok ||
      normalizedRemoval.url !== value.removedRelayUrl
    ) {
      return invalidStoredUpdate("whole removal relay is not canonical")
    }
    removedRelayUrl = normalizedRemoval.url
    if (
      !sameOrderedValues(kinds, [
        EVENT_KINDS.RELAY_LIST,
        EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      ]) ||
      checkpoints.some((checkpoint) =>
        checkpoint.kind === EVENT_KINDS.RELAY_LIST
          ? checkpoint.signedEvent.id === baseRelayList.eventId
          : checkpoint.signedEvent.id === baseInboxDeclaration.eventId
      ) ||
      !legacyRecoveryRemovedRelayUrls.includes(removedRelayUrl) ||
      nip65Preferences.some(
        (preference) => preference.url === removedRelayUrl
      ) ||
      inboxRelayUrls.includes(removedRelayUrl) ||
      checkpoints.some((checkpoint) =>
        checkpoint.relayPlan.includes(removedRelayUrl!)
      )
    ) {
      return invalidStoredUpdate("whole removal is not atomic and complete")
    }
  } else if (value.removedRelayUrl !== undefined) {
    return invalidStoredUpdate("ordinary update retained a removal relay")
  }
  return {
    pubkey,
    updateId,
    action: value.action,
    removedRelayUrl,
    baseRelayList,
    baseInboxDeclaration,
    nip65Preferences,
    inboxRelayUrls,
    previousInboxRelayUrls,
    legacyRecoveryRemovedRelayUrls,
    legacyRecoveryDiscarded: value.legacyRecoveryDiscarded,
    cutoverPolicyVersion: value.cutoverPolicyVersion,
    cutoverGraceMs: value.cutoverGraceMs,
    checkpoints,
    stagedAt,
    updatedAt,
  }
}

function markChangedFrontiersSuperseded(
  record: AccountNetworkPreferenceUpdateRecord,
  frontiers: AccountNetworkPreferenceDurableFrontiers,
  observedAt: number,
  mode: "stage" | "resume"
): AccountNetworkPreferenceUpdateRecord {
  const next = clone(record)
  for (const checkpoint of next.checkpoints) {
    if (checkpoint.state === "superseded") continue
    const durable = eventForKind(frontiers, checkpoint.kind)
    if (durable?.id === checkpoint.signedEvent.id) continue
    const baseEventId = baseEventIdForKind(next, checkpoint.kind)
    const frontierChanged = (durable?.id ?? null) !== baseEventId
    const strongerPendingReplacement = Boolean(
      durable && compareReplaceableEvents(durable, checkpoint.signedEvent) > 0
    )
    if (
      (mode === "stage" && frontierChanged) ||
      (mode === "resume" && strongerPendingReplacement)
    ) {
      checkpoint.state = "superseded"
      checkpoint.supersededAt = Math.max(next.updatedAt, observedAt)
    }
  }
  next.updatedAt = Math.max(next.updatedAt, observedAt)
  const activeInbox = next.checkpoints.find(
    (checkpoint) =>
      checkpoint.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
      checkpoint.state === "active"
  )
  const activeInboxRelayUrls = activeInbox
    ? inboxRelayUrlsFromSignedEvent(activeInbox.signedEvent)
    : []
  next.legacyRecoveryDiscarded =
    next.legacyRecoveryDiscarded ||
    Boolean(
      activeInboxRelayUrls.length >= 1 && activeInboxRelayUrls.length <= 3
    )
  return next
}

export function applyAccountNetworkPreferenceUpdateSupersession(input: {
  record: AccountNetworkPreferenceUpdateRecord
  frontiers: AccountNetworkPreferenceDurableFrontiers
  observedAt: number
}): AccountNetworkPreferenceUpdateRecord {
  const record = validateAccountNetworkPreferenceUpdateRecord(input.record)
  return validateAccountNetworkPreferenceUpdateRecord(
    markChangedFrontiersSuperseded(
      record,
      validateAccountNetworkPreferenceDurableFrontiers(
        record.pubkey,
        input.frontiers
      ),
      validateTimestamp(input.observedAt, "Network update reconciliation time"),
      "resume"
    )
  )
}

function getFrontiersFromRecords(
  relayList: OwnerRelayListEvidenceRecord | undefined,
  inbox: InboxDeclarationEvidenceRecord | undefined
): AccountNetworkPreferenceDurableFrontiers {
  return {
    relayList: relayList?.current?.signedEvent
      ? clone(relayList.current.signedEvent)
      : null,
    relayListObserved: Boolean(relayList?.current?.sourceRelayUrls.length),
    inboxDeclaration: inbox?.current.signedEvent
      ? clone(inbox.current.signedEvent)
      : null,
    inboxDeclarationObserved: Boolean(inbox?.current.sourceRelayUrls.length),
  }
}

function stageInboxEvidence(
  existing: InboxDeclarationEvidenceRecord | undefined,
  record: AccountNetworkPreferenceUpdateRecord
): InboxDeclarationEvidenceRecord | undefined {
  const checkpoint = record.checkpoints.find(
    (candidate) =>
      candidate.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
      candidate.state === "active"
  )
  if (!checkpoint) return existing ? clone(existing) : undefined
  const carried =
    checkpoint.signedEvent.id === record.baseInboxDeclaration.eventId
  if (carried) {
    return rebindInboxDeclarationCoordinatedUpdate(existing, {
      pubkey: record.pubkey,
      signedEvent: checkpoint.signedEvent,
      coordinatedUpdateId: record.updateId,
    })
  }
  const nextInboxSet = new Set(
    inboxRelayUrlsFromSignedEvent(checkpoint.signedEvent)
  )
  const explicitlyRemoved = new Set(
    record.action === "whole_relay_removal" && record.removedRelayUrl
      ? [record.removedRelayUrl]
      : []
  )
  const cutoverRelayUrls = record.previousInboxRelayUrls.filter(
    (relayUrl) =>
      !nextInboxSet.has(relayUrl) && !explicitlyRemoved.has(relayUrl)
  )
  return applyInboxDeclarationDistributionStage(existing, {
    pubkey: record.pubkey,
    signedEvent: checkpoint.signedEvent,
    publishRelayUrls: checkpoint.relayPlan,
    expectedCurrentEventId: record.baseInboxDeclaration.eventId,
    stagedAt: checkpoint.stagedAt,
    cachedAt: checkpoint.stagedAt,
    cutoverRecovery: {
      policyVersion: record.cutoverPolicyVersion,
      relayUrls: cutoverRelayUrls,
      graceMs: record.cutoverGraceMs,
    },
    coordinatedUpdateId: record.updateId,
  })
}

function assertExpectedUpdate(
  existing: AccountNetworkPreferenceUpdateRecord | undefined,
  expectedUpdateId: string | null
): void {
  if ((existing?.updateId ?? null) !== expectedUpdateId) {
    throw new AccountNetworkPreferenceUpdateConflictError(
      "update_changed",
      "The pending Network update changed before this action was staged"
    )
  }
}

function preserveExistingCarriedCheckpoints(
  requested: AccountNetworkPreferenceUpdateRecord,
  existing: AccountNetworkPreferenceUpdateRecord | undefined
): void {
  if (!existing) {
    if (
      requested.checkpoints.some((checkpoint) =>
        checkpoint.kind === EVENT_KINDS.RELAY_LIST
          ? checkpoint.signedEvent.id === requested.baseRelayList.eventId
          : checkpoint.signedEvent.id === requested.baseInboxDeclaration.eventId
      )
    ) {
      invalidStoredUpdate("carried checkpoint has no prior durable row")
    }
    return
  }
  for (const prior of existing.checkpoints) {
    if (
      !accountNetworkPreferenceUpdateHasOutstandingWork({
        ...existing,
        checkpoints: [prior],
      })
    ) {
      continue
    }
    if (
      !requested.checkpoints.some(
        (checkpoint) => checkpoint.kind === prior.kind
      )
    ) {
      invalidStoredUpdate("successor discarded unresolved per-kind work")
    }
  }
  requested.checkpoints = requested.checkpoints.map((checkpoint) => {
    const baseEventId = baseEventIdForKind(requested, checkpoint.kind)
    if (checkpoint.signedEvent.id !== baseEventId) return checkpoint
    const prior = existing.checkpoints.find(
      (candidate) =>
        candidate.kind === checkpoint.kind && candidate.state === "active"
    )
    if (
      !prior ||
      !areSameSignedPublicNostrEvent(
        prior.signedEvent,
        checkpoint.signedEvent
      ) ||
      prior.stagedAt !== checkpoint.stagedAt ||
      !sameOrderedValues(prior.relayPlan, checkpoint.relayPlan)
    ) {
      return invalidStoredUpdate(
        "carried checkpoint changed its exact bytes or immutable plan"
      )
    }
    return clone(prior)
  })
  requested.updatedAt = Math.max(requested.updatedAt, existing.updatedAt)
}

/** Pure reducer shared by the Dexie transaction and deterministic tests. */
export function applyAccountNetworkPreferenceUpdateStage(input: {
  existingUpdate: AccountNetworkPreferenceUpdateRecord | undefined
  ownerEvidence: OwnerRelayListEvidenceRecord | undefined
  inboxEvidence: InboxDeclarationEvidenceRecord | undefined
  record: AccountNetworkPreferenceUpdateRecord
  expectedUpdateId: string | null
}): StageAccountNetworkPreferenceUpdateResult {
  const existingUpdate = input.existingUpdate
    ? validateAccountNetworkPreferenceUpdateRecord(input.existingUpdate)
    : undefined
  const requested = validateAccountNetworkPreferenceUpdateRecord(input.record)
  assertExpectedUpdate(existingUpdate, input.expectedUpdateId)
  preserveExistingCarriedCheckpoints(requested, existingUpdate)
  const frontiers = getFrontiersFromRecords(
    input.ownerEvidence,
    input.inboxEvidence
  )
  requested.legacyRecoveryDiscarded =
    requested.legacyRecoveryDiscarded ||
    Boolean(existingUpdate?.legacyRecoveryDiscarded)
  requested.legacyRecoveryRemovedRelayUrls = Array.from(
    new Set([
      ...(existingUpdate?.legacyRecoveryRemovedRelayUrls ?? []),
      ...requested.legacyRecoveryRemovedRelayUrls,
    ])
  )
  const record = markChangedFrontiersSuperseded(
    requested,
    validateAccountNetworkPreferenceDurableFrontiers(
      requested.pubkey,
      frontiers
    ),
    requested.updatedAt,
    "stage"
  )
  if (
    record.action === "whole_relay_removal" &&
    record.checkpoints.some((checkpoint) => checkpoint.state === "superseded")
  ) {
    throw new AccountNetworkPreferenceUpdateConflictError(
      "update_changed",
      "A signed Network frontier changed before the whole removal was staged"
    )
  }
  const validatedRecord = validateAccountNetworkPreferenceUpdateRecord(record)
  const inboxEvidence = stageInboxEvidence(input.inboxEvidence, validatedRecord)
  return {
    record: validatedRecord,
    inboxEvidence: inboxEvidence ?? null,
    frontiers: validateAccountNetworkPreferenceDurableFrontiers(
      validatedRecord.pubkey,
      getFrontiersFromRecords(input.ownerEvidence, inboxEvidence)
    ),
  }
}

function updateRelayOutcome(
  checkpoint: AccountNetworkPreferenceEventCheckpoint,
  relayUrl: string,
  observedAt: number,
  input: {
    publish?: "acked" | "rejected" | "timed_out"
    readback?: Exclude<AccountNetworkPreferenceReadbackStatus, "pending">
  }
): void {
  const outcome = checkpoint.relayOutcomes.find(
    (candidate) => candidate.relayUrl === relayUrl
  )
  if (!outcome) return
  if (input.publish) {
    outcome.publishStatus = input.publish
    outcome.publishAttemptCount += 1
    outcome.publishAttemptedAt = observedAt
  }
  if (input.readback) {
    outcome.readbackStatus = input.readback
    outcome.readbackAttemptCount += 1
    outcome.readbackAttemptedAt = observedAt
    if (input.readback === "observed") outcome.observedAt = observedAt
  }
}

function readbackCoverage(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): "complete" | "partial" | "unavailable" {
  const completed = checkpoint.relayOutcomes.filter(
    (outcome) =>
      outcome.readbackStatus === "observed" ||
      outcome.readbackStatus === "absent"
  ).length
  if (completed === checkpoint.relayOutcomes.length) return "complete"
  return completed > 0 ? "partial" : "unavailable"
}

function hasCompletedExactSharedSetReadback(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): boolean {
  return (
    checkpoint.relayOutcomes.length > 0 &&
    checkpoint.relayOutcomes.some(
      (outcome) => outcome.readbackStatus === "observed"
    ) &&
    checkpoint.relayOutcomes.every(
      (outcome) =>
        outcome.readbackStatus === "observed" ||
        outcome.readbackStatus === "absent"
    )
  )
}

function mergeExactReadbackEvidence(input: {
  ownerEvidence: OwnerRelayListEvidenceRecord | undefined
  inboxEvidence: InboxDeclarationEvidenceRecord | undefined
  checkpoint: AccountNetworkPreferenceEventCheckpoint
  observedAt: number
}): {
  ownerEvidence: OwnerRelayListEvidenceRecord | undefined
  inboxEvidence: InboxDeclarationEvidenceRecord | undefined
} {
  if (input.checkpoint.state !== "active") {
    return {
      ownerEvidence: input.ownerEvidence,
      inboxEvidence: input.inboxEvidence,
    }
  }
  const sourceRelayUrls = input.checkpoint.relayOutcomes.flatMap((outcome) =>
    outcome.readbackStatus === "observed" ? [outcome.relayUrl] : []
  )
  if (sourceRelayUrls.length === 0) {
    return {
      ownerEvidence: input.ownerEvidence,
      inboxEvidence: input.inboxEvidence,
    }
  }
  const exactObservedAt = Math.max(
    ...input.checkpoint.relayOutcomes.flatMap((outcome) =>
      outcome.readbackStatus === "observed" && outcome.observedAt !== undefined
        ? [outcome.observedAt]
        : []
    )
  )
  const coverage = readbackCoverage(input.checkpoint)
  const completeObservedAt =
    coverage === "complete" ? input.observedAt : undefined

  if (input.checkpoint.kind === EVENT_KINDS.RELAY_LIST) {
    return {
      ownerEvidence: applyOwnerRelayListEvidenceReconciliation(
        input.ownerEvidence,
        {
          pubkey: input.checkpoint.signedEvent.pubkey,
          observations: [
            {
              signedEvent: input.checkpoint.signedEvent,
              sourceRelayUrls,
              observedAt: exactObservedAt,
              completeObservedAt,
            },
          ],
          lookup: {
            observedAt: input.observedAt,
            coverage,
            hadEvent: true,
            eventId: input.checkpoint.signedEvent.id,
          },
          cachedAt: input.observedAt,
        }
      ),
      inboxEvidence: input.inboxEvidence,
    }
  }

  const pendingDistribution =
    input.inboxEvidence?.pendingDistribution?.signedEvent.id ===
    input.checkpoint.signedEvent.id
      ? input.inboxEvidence.pendingDistribution
      : undefined
  const cutoverRecovery =
    input.inboxEvidence?.cutoverRecovery?.replacementEventId ===
    input.checkpoint.signedEvent.id
      ? input.inboxEvidence.cutoverRecovery
      : undefined
  return {
    ownerEvidence: input.ownerEvidence,
    inboxEvidence: applyInboxDeclarationEvidenceMerge(input.inboxEvidence, {
      pubkey: input.checkpoint.signedEvent.pubkey,
      signedEvent: input.checkpoint.signedEvent,
      sourceRelayUrls,
      sharedSourceRelayUrls: hasCompletedExactSharedSetReadback(
        input.checkpoint
      )
        ? sourceRelayUrls
        : [],
      pendingDistribution,
      cutoverRecovery,
      observedAt: exactObservedAt,
      completeObservedAt,
      cachedAt: input.observedAt,
      lookup: {
        observedAt: input.observedAt,
        coverage,
        hadEvent: true,
        eventId: input.checkpoint.signedEvent.id,
      },
    }),
  }
}

/** Pure reducer shared by the Dexie transaction and deterministic tests. */
export function applyAccountNetworkPreferenceUpdateOutcomes(input: {
  existingUpdate: AccountNetworkPreferenceUpdateRecord | undefined
  ownerEvidence: OwnerRelayListEvidenceRecord | undefined
  inboxEvidence: InboxDeclarationEvidenceRecord | undefined
  mutation: RecordAccountNetworkPreferenceOutcomesInput
}): {
  record: AccountNetworkPreferenceUpdateRecord
  ownerEvidence: OwnerRelayListEvidenceRecord | undefined
  inboxEvidence: InboxDeclarationEvidenceRecord | undefined
} {
  const existing = input.existingUpdate
    ? validateAccountNetworkPreferenceUpdateRecord(input.existingUpdate)
    : undefined
  if (!existing) {
    throw new AccountNetworkPreferenceUpdateConflictError(
      "missing_update",
      "The staged Network update is no longer available"
    )
  }
  if (existing.updateId !== input.mutation.updateId) {
    throw new AccountNetworkPreferenceUpdateConflictError(
      "update_changed",
      "A different Network update replaced this retry checkpoint"
    )
  }
  const record = clone(existing)
  const observedAt = Math.max(
    record.updatedAt,
    validateTimestamp(
      input.mutation.observedAt,
      "Network update outcome observation time"
    )
  )
  for (const outcome of input.mutation.publish ?? []) {
    const checkpoint = record.checkpoints.find(
      (candidate) => candidate.kind === outcome.kind
    )
    if (!checkpoint || checkpoint.state !== "active") continue
    updateRelayOutcome(checkpoint, outcome.relayUrl, observedAt, {
      publish: outcome.status,
    })
  }
  for (const outcome of input.mutation.readback ?? []) {
    const checkpoint = record.checkpoints.find(
      (candidate) => candidate.kind === outcome.kind
    )
    if (!checkpoint || checkpoint.state !== "active") continue
    updateRelayOutcome(checkpoint, outcome.relayUrl, observedAt, {
      readback: outcome.status,
    })
  }
  record.updatedAt = observedAt

  let ownerEvidence = input.ownerEvidence
  let inboxEvidence = input.inboxEvidence
  const readbackKinds = new Set(
    (input.mutation.readback ?? []).map((outcome) => outcome.kind)
  )
  for (const checkpoint of record.checkpoints) {
    if (!readbackKinds.has(checkpoint.kind)) continue
    const merged = mergeExactReadbackEvidence({
      ownerEvidence,
      inboxEvidence,
      checkpoint,
      observedAt,
    })
    ownerEvidence = merged.ownerEvidence
    inboxEvidence = merged.inboxEvidence
  }
  return {
    record: validateAccountNetworkPreferenceUpdateRecord(record),
    ownerEvidence,
    inboxEvidence,
  }
}

type AccountNetworkPreferencePubkey = NormalizedOwnerRelayListPubkey &
  NormalizedInboxDeclarationPubkey

function requireCanonicalPubkey(
  pubkey: string
): AccountNetworkPreferencePubkey {
  const ownerPubkey = normalizeOwnerRelayListPubkey(pubkey)
  const inboxPubkey = normalizeInboxDeclarationEvidencePubkey(pubkey)
  if (!ownerPubkey || !inboxPubkey) {
    throw new Error("Network preference update requires a valid hex pubkey")
  }
  return ownerPubkey as AccountNetworkPreferencePubkey
}

function createDexieNetworkPreferenceUpdateRepository(): AccountNetworkPreferenceUpdateRepository {
  return {
    async get(pubkey) {
      const normalized = requireCanonicalPubkey(pubkey)
      const record = await db.networkPreferenceUpdates.get(normalized)
      return record
        ? validateAccountNetworkPreferenceUpdateRecord(record)
        : null
    },

    async getDurableFrontiers(pubkey) {
      const normalized = requireCanonicalPubkey(pubkey)
      const [ownerEvidence, inboxEvidence] = await Promise.all([
        db.ownerRelayListEvidence.get(normalized),
        db.inboxDeclarationEvidence.get(normalized),
      ])
      return validateAccountNetworkPreferenceDurableFrontiers(
        normalized,
        getFrontiersFromRecords(ownerEvidence, inboxEvidence)
      )
    },

    async stage({ record: requested, expectedUpdateId }) {
      const pubkey = requireCanonicalPubkey(requested.pubkey)
      return await db.transaction(
        "rw",
        db.networkPreferenceUpdates,
        db.ownerRelayListEvidence,
        db.inboxDeclarationEvidence,
        async () => {
          const [existingUpdate, ownerEvidence, inboxEvidence] =
            await Promise.all([
              db.networkPreferenceUpdates.get(pubkey),
              db.ownerRelayListEvidence.get(pubkey),
              db.inboxDeclarationEvidence.get(pubkey),
            ])
          const staged = applyAccountNetworkPreferenceUpdateStage({
            existingUpdate,
            ownerEvidence,
            inboxEvidence,
            record: requested,
            expectedUpdateId,
          })
          await db.networkPreferenceUpdates.put(clone(staged.record))
          if (staged.inboxEvidence) {
            await db.inboxDeclarationEvidence.put(
              cloneInboxDeclarationEvidenceRecord(staged.inboxEvidence)
            )
          }
          return {
            record: clone(staged.record),
            inboxEvidence: staged.inboxEvidence
              ? cloneInboxDeclarationEvidenceRecord(staged.inboxEvidence)
              : null,
            frontiers: clone(staged.frontiers),
          }
        }
      )
    },

    async recordOutcomes(mutation) {
      const pubkey = requireCanonicalPubkey(mutation.pubkey)
      return await db.transaction(
        "rw",
        db.networkPreferenceUpdates,
        db.ownerRelayListEvidence,
        db.inboxDeclarationEvidence,
        async () => {
          const [existingUpdate, ownerEvidence, inboxEvidence] =
            await Promise.all([
              db.networkPreferenceUpdates.get(pubkey),
              db.ownerRelayListEvidence.get(pubkey),
              db.inboxDeclarationEvidence.get(pubkey),
            ])
          const updated = applyAccountNetworkPreferenceUpdateOutcomes({
            existingUpdate,
            ownerEvidence,
            inboxEvidence,
            mutation,
          })
          await db.networkPreferenceUpdates.put(clone(updated.record))
          if (updated.ownerEvidence) {
            await db.ownerRelayListEvidence.put(clone(updated.ownerEvidence))
          }
          if (updated.inboxEvidence) {
            await db.inboxDeclarationEvidence.put(
              cloneInboxDeclarationEvidenceRecord(updated.inboxEvidence)
            )
          }
          return {
            record: clone(updated.record),
            inboxEvidence: updated.inboxEvidence
              ? cloneInboxDeclarationEvidenceRecord(updated.inboxEvidence)
              : null,
            frontiers: validateAccountNetworkPreferenceDurableFrontiers(
              pubkey,
              getFrontiersFromRecords(
                updated.ownerEvidence,
                updated.inboxEvidence
              )
            ),
          }
        }
      )
    },

    async reconcileSupersession(input) {
      const pubkey = requireCanonicalPubkey(input.pubkey)
      return await db.transaction(
        "rw",
        db.networkPreferenceUpdates,
        db.ownerRelayListEvidence,
        db.inboxDeclarationEvidence,
        async () => {
          const [existing, ownerEvidence, inboxEvidence] = await Promise.all([
            db.networkPreferenceUpdates.get(pubkey),
            db.ownerRelayListEvidence.get(pubkey),
            db.inboxDeclarationEvidence.get(pubkey),
          ])
          if (!existing) {
            throw new AccountNetworkPreferenceUpdateConflictError(
              "missing_update",
              "The staged Network update is no longer available"
            )
          }
          if (existing.updateId !== input.updateId) {
            throw new AccountNetworkPreferenceUpdateConflictError(
              "update_changed",
              "A different Network update replaced this retry checkpoint"
            )
          }
          const record = applyAccountNetworkPreferenceUpdateSupersession({
            record: validateAccountNetworkPreferenceUpdateRecord(existing),
            frontiers: getFrontiersFromRecords(ownerEvidence, inboxEvidence),
            observedAt: input.observedAt,
          })
          if (JSON.stringify(record) !== JSON.stringify(existing)) {
            await db.networkPreferenceUpdates.put(clone(record))
          }
          return {
            record: clone(record),
            inboxEvidence: inboxEvidence
              ? cloneInboxDeclarationEvidenceRecord(inboxEvidence)
              : null,
            frontiers: validateAccountNetworkPreferenceDurableFrontiers(
              pubkey,
              getFrontiersFromRecords(ownerEvidence, inboxEvidence)
            ),
          }
        }
      )
    },
  }
}

export const dexieAccountNetworkPreferenceUpdateRepository =
  createDexieNetworkPreferenceUpdateRepository()

export function getUnresolvedAccountNetworkPreferencePublishRelayUrls(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): string[] {
  if (checkpoint.state === "superseded") return []
  return checkpoint.relayOutcomes.flatMap((outcome) =>
    outcome.publishStatus !== "acked" && outcome.readbackStatus !== "observed"
      ? [outcome.relayUrl]
      : []
  )
}

export function getUnresolvedAccountNetworkPreferenceReadbackRelayUrls(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): string[] {
  if (checkpoint.state === "superseded") return []
  return checkpoint.relayOutcomes.flatMap((outcome) =>
    outcome.readbackStatus === "observed" ? [] : [outcome.relayUrl]
  )
}

export function accountNetworkPreferenceCheckpointConfirmed(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): boolean {
  return checkpoint.relayOutcomes.some(
    (outcome) => outcome.readbackStatus === "observed"
  )
}

export function accountNetworkPreferenceCheckpointSharedSetConfirmed(
  checkpoint: AccountNetworkPreferenceEventCheckpoint
): boolean {
  return hasCompletedExactSharedSetReadback(checkpoint)
}

export function accountNetworkPreferenceUpdateHasOutstandingWork(
  record: AccountNetworkPreferenceUpdateRecord
): boolean {
  return record.checkpoints.some(
    (checkpoint) =>
      checkpoint.state === "active" &&
      (getUnresolvedAccountNetworkPreferencePublishRelayUrls(checkpoint)
        .length > 0 ||
        getUnresolvedAccountNetworkPreferenceReadbackRelayUrls(checkpoint)
          .length > 0)
  )
}

function strongestRuntimeEvent(input: {
  checkpoint: AccountNetworkPreferenceEventCheckpoint | undefined
  durable: SignedPublicNostrEvent | null
}): {
  signedEvent: SignedPublicNostrEvent | null
  checkpoint: AccountNetworkPreferenceEventCheckpoint | null
} {
  const active =
    input.checkpoint?.state === "active" ? input.checkpoint : undefined
  if (!active) return { signedEvent: input.durable, checkpoint: null }
  if (
    input.durable &&
    compareReplaceableEvents(input.durable, active.signedEvent) > 0
  ) {
    return { signedEvent: input.durable, checkpoint: null }
  }
  return { signedEvent: active.signedEvent, checkpoint: active }
}

/** Project the strongest validated durable or pending exact state per kind. */
export function applyAccountNetworkPreferenceRuntimeState(
  record: AccountNetworkPreferenceUpdateRecord | null,
  inboxEvidence: InboxDeclarationEvidenceRecord | null,
  frontiers: AccountNetworkPreferenceDurableFrontiers
): void {
  if (!record) return
  const validated = validateAccountNetworkPreferenceUpdateRecord(record)
  const durable = validateAccountNetworkPreferenceDurableFrontiers(
    validated.pubkey,
    frontiers
  )
  const relayList = strongestRuntimeEvent({
    checkpoint: validated.checkpoints.find(
      (checkpoint) => checkpoint.kind === EVENT_KINDS.RELAY_LIST
    ),
    durable: durable.relayList,
  })
  if (relayList.signedEvent) {
    setAccountRelaySettingsProjection(
      getAccountRelayScope(validated.pubkey),
      {
        ...createRelaySettingsFromPreferences(
          projectOwnerRelayPreferencesFromSignedTags(
            relayList.signedEvent.tags
          ),
          "published"
        ),
        updatedAt: validated.updatedAt,
      },
      { signedRelayListAuthoritative: true }
    )
  }
  if (inboxEvidence) primeInboxDeclarationEvidence(inboxEvidence)
  const inbox = strongestRuntimeEvent({
    checkpoint: validated.checkpoints.find(
      (checkpoint) => checkpoint.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
    ),
    durable: durable.inboxDeclaration,
  })
  const inboxCheckpoint = inbox.checkpoint
  setInboxCoordinatedPendingCheckpoint(
    validated.pubkey,
    inboxCheckpoint
      ? {
          eventId: inboxCheckpoint.signedEvent.id,
          updateId: validated.updateId,
        }
      : null
  )
  setInboxExplicitRemovalRelayUrls(
    validated.pubkey,
    validated.legacyRecoveryRemovedRelayUrls.filter(
      (relayUrl) =>
        !inbox.signedEvent ||
        !inboxRelayUrlsFromSignedEvent(inbox.signedEvent).includes(relayUrl)
    )
  )
  if (validated.legacyRecoveryDiscarded) {
    clearInboxMigrationRecoveryRelayUrls(validated.pubkey)
  }
}

export async function resumeAccountNetworkPreferenceUpdate(
  pubkey: string,
  repository: AccountNetworkPreferenceUpdateRepository = dexieAccountNetworkPreferenceUpdateRepository,
  now: () => number = Date.now
): Promise<AccountNetworkPreferenceUpdateRecord | null> {
  const normalized = requireCanonicalPubkey(pubkey)
  try {
    const loaded = await repository.get(normalized)
    const existing = loaded
      ? validateAccountNetworkPreferenceUpdateRecord(loaded)
      : null
    if (!existing) {
      setInboxCoordinatedPendingCheckpoint(normalized, null)
      setInboxExplicitRemovalRelayUrls(normalized, [])
      return null
    }
    const reconciled = await repository.reconcileSupersession({
      pubkey: normalized,
      updateId: existing.updateId,
      observedAt: validateTimestamp(now(), "Network update resume time"),
    })
    const record = validateAccountNetworkPreferenceUpdateRecord(
      reconciled.record
    )
    applyAccountNetworkPreferenceRuntimeState(
      record,
      reconciled.inboxEvidence,
      reconciled.frontiers
    )
    return clone(record)
  } catch (error) {
    // Malformed or unavailable durable state cannot inherit an earlier
    // process-local pending write/removal authorization.
    setInboxCoordinatedPendingCheckpoint(normalized, null)
    setInboxExplicitRemovalRelayUrls(normalized, [])
    throw error
  }
}
