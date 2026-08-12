import type { NDKSigner } from "@nostr-dev-kit/ndk"
import {
  buildEventMarketFulfillmentRevocationPayload,
  buildEventMarketHandoffAckPayload,
  buildEventMarketReadyReceiptPayload,
  authorizeEventMarketFulfillmentRevocation,
  authorizeEventMarketHandoffAck,
  createEventMarketPrivateDeliveryProgress,
  getEventMarketReceiptMerchandise,
  getEventMarketOrderCorrelationRef,
  parseEventMarketPrivateDeliveryProgress,
  parseEventMarketPrivateDeliveryRecord,
  publishEventMarketFulfillmentRevocation,
  publishEventMarketHandoffAck,
  publishEventMarketReadyReceipt,
  resolveEventMarketHandoffAckGate,
  retryEventMarketPrivateDelivery,
  RelayPublishDiagnosticsError,
  type EventMarketOrganizerClaim,
  type EventMarketHandoffAckGate,
  type EventMarketPrivateDeliveryProgress,
  type EventMarketPrivateDeliveryRecord,
  type EventMarketPrivatePublishResult,
  type EventMarketPrivateReadResult,
  type EventMarketPrivateTransportOptions,
  type EventMarketReadyReceiptSchema,
  type EventMarketReceiptMerchandiseResolution,
  type EventMarketResolution,
  type GiftUnwrapFn,
  type OrderSchema,
  type PublishWithPlannerResult,
  type RetryEventMarketPrivateDeliveryResult,
} from "@conduit/core"

const STORAGE_PREFIX = "conduit:merchant:event-handoff-delivery:v1"
const STORAGE_LIMIT = 100
const MAX_DELIVERY_TARGET_COUNT = 64

export type EventMarketRecipientDeliveryStatus =
  "pending" | "unknown" | "zero_ack" | "partial_success" | "full_success"

export type EventMarketSelfCopyDeliveryStatus =
  | "pending"
  | "unknown"
  | "accepted"
  | "zero_ack"
  | "partial_success"
  | "full_success"
  | "failed"

export interface EventMarketDeliveryLegState<Status extends string> {
  status: Status
  acknowledgedCount: number
  failedCount: number
}

export interface StoredEventMarketHandoffDelivery {
  record: EventMarketPrivateDeliveryRecord
  deliveryProgress: EventMarketPrivateDeliveryProgress
  recipient: EventMarketDeliveryLegState<EventMarketRecipientDeliveryStatus>
  selfCopy: EventMarketDeliveryLegState<EventMarketSelfCopyDeliveryStatus>
  savedAt: number
}

export interface MerchantHandoffGraphEvidence {
  claimRef: string
  merchantPubkey: string
  organizerPubkey: string
  calendar: { coordinate: string; eventId: string; createdAt: number }
  collection: { coordinate: string; eventId: string; createdAt: number }
  option: { coordinate: string; eventId: string; createdAt: number }
}

interface MerchantHandoffAckEvidence extends MerchantHandoffGraphEvidence {
  readyReceiptId: string
}

function sameHandoffEvidenceRevision(
  left: { coordinate: string; eventId: string; createdAt: number },
  right: { coordinate: string; eventId: string; createdAt: number }
): boolean {
  return (
    left.coordinate === right.coordinate &&
    left.eventId === right.eventId &&
    left.createdAt === right.createdAt
  )
}

function sameHandoffGraph(
  left: MerchantHandoffGraphEvidence,
  right: MerchantHandoffGraphEvidence
): boolean {
  return (
    left.claimRef === right.claimRef &&
    left.merchantPubkey.trim().toLowerCase() ===
      right.merchantPubkey.trim().toLowerCase() &&
    left.organizerPubkey.trim().toLowerCase() ===
      right.organizerPubkey.trim().toLowerCase() &&
    sameHandoffEvidenceRevision(left.calendar, right.calendar) &&
    sameHandoffEvidenceRevision(left.collection, right.collection) &&
    sameHandoffEvidenceRevision(left.option, right.option)
  )
}

/** Reduce already-authenticated ACKs without letting one exact match hide conflict. */
export function resolveMerchantHandoffAckEvidence<
  Ack extends { createdAt: number; payload: MerchantHandoffAckEvidence },
>(input: {
  acks: readonly Ack[]
  readyReceiptId: string
  expectedGraph: MerchantHandoffGraphEvidence
  hasRevocation: boolean
}): { exactAck: Ack | null; conflicting: boolean } {
  const readyReceiptId = input.readyReceiptId.toLowerCase()
  const scoped = input.acks.filter(
    (ack) => ack.payload.readyReceiptId.toLowerCase() === readyReceiptId
  )
  const matching = scoped.filter((ack) =>
    sameHandoffGraph(ack.payload, input.expectedGraph)
  )
  const conflicting =
    matching.length !== scoped.length ||
    (input.hasRevocation && matching.length > 0)
  const exactAck = conflicting
    ? null
    : ([...matching]
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1) ?? null)
  return { exactAck, conflicting }
}

export type MerchantHandoffAckReadBlocker =
  | "pending"
  | "read_error"
  | "unavailable"
  | "stale"
  | "decrypt_failure"
  | "inbox_not_declared"
  | "coverage_incomplete"

/**
 * Keep transport activity separate from the last strict inbox result.
 * Background polling does not invalidate an already-complete read, while any
 * stale, unreadable, undeclared, or incompletely covered read remains closed.
 */
export function resolveMerchantHandoffAckReadState<
  Ack extends { createdAt: number; payload: MerchantHandoffAckEvidence },
>(input: {
  read:
    | (Omit<EventMarketPrivateReadResult<unknown>, "data"> & {
        data: readonly Ack[]
      })
    | null
    | undefined
  isError: boolean
  isFetching: boolean
  readyReceiptId: string
  expectedGraph: MerchantHandoffGraphEvidence
  hasRevocation: boolean
}): {
  exactAck: Ack | null
  conflicting: boolean
  blocker: MerchantHandoffAckReadBlocker | null
  refreshing: boolean
} {
  const blocker: MerchantHandoffAckReadBlocker | null = input.isError
    ? "read_error"
    : !input.read
      ? input.isFetching
        ? "pending"
        : "unavailable"
      : input.read.stale
        ? "stale"
        : input.read.decryptFailureCount > 0
          ? "decrypt_failure"
          : input.read.inbox?.declarationState !== "declared"
            ? "inbox_not_declared"
            : input.read.inbox.coverage !== "complete"
              ? "coverage_incomplete"
              : null
  if (blocker) {
    return {
      exactAck: null,
      conflicting: false,
      blocker,
      refreshing: input.isFetching,
    }
  }
  return {
    ...resolveMerchantHandoffAckEvidence({
      acks: input.read!.data,
      readyReceiptId: input.readyReceiptId,
      expectedGraph: input.expectedGraph,
      hasRevocation: input.hasRevocation,
    }),
    blocker: null,
    refreshing: input.isFetching,
  }
}

type HandoffStorage = Pick<Storage, "getItem" | "setItem">

function browserStorage(): HandoffStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function storageKey(principalPubkey: string): string {
  return `${STORAGE_PREFIX}:${principalPubkey.trim().toLowerCase()}`
}

function boundedCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DELIVERY_TARGET_COUNT
    ? value
    : null
}

function validLegState<Status extends string>(
  value: unknown,
  statuses: readonly Status[]
): EventMarketDeliveryLegState<Status> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<EventMarketDeliveryLegState<Status>>
  const acknowledgedCount = boundedCount(candidate.acknowledgedCount)
  const failedCount = boundedCount(candidate.failedCount)
  if (
    typeof candidate.status !== "string" ||
    !statuses.includes(candidate.status as Status) ||
    acknowledgedCount === null ||
    failedCount === null
  ) {
    return null
  }
  return {
    status: candidate.status as Status,
    acknowledgedCount,
    failedCount,
  }
}

function recipientStateIsConsistent(
  state: EventMarketDeliveryLegState<EventMarketRecipientDeliveryStatus>
): boolean {
  switch (state.status) {
    case "pending":
      return state.acknowledgedCount === 0 && state.failedCount === 0
    case "unknown":
      return state.failedCount === 0
    case "zero_ack":
      return true
    case "partial_success":
      return state.acknowledgedCount > 0 && state.failedCount > 0
    case "full_success":
      return state.acknowledgedCount > 0 && state.failedCount === 0
  }
}

function selfCopyStateIsConsistent(
  state: EventMarketDeliveryLegState<EventMarketSelfCopyDeliveryStatus>
): boolean {
  switch (state.status) {
    case "pending":
    case "accepted":
      return state.acknowledgedCount === 0 && state.failedCount === 0
    case "unknown":
      return state.failedCount === 0
    case "zero_ack":
    case "failed":
      return true
    case "partial_success":
      return state.acknowledgedCount > 0 && state.failedCount > 0
    case "full_success":
      return state.acknowledgedCount > 0 && state.failedCount === 0
  }
}

const RECIPIENT_STATUSES: readonly EventMarketRecipientDeliveryStatus[] = [
  "pending",
  "unknown",
  "zero_ack",
  "partial_success",
  "full_success",
]

const SELF_COPY_STATUSES: readonly EventMarketSelfCopyDeliveryStatus[] = [
  "pending",
  "unknown",
  "accepted",
  "zero_ack",
  "partial_success",
  "full_success",
  "failed",
]

function legacyDeliveryState(
  record: EventMarketPrivateDeliveryRecord
): Pick<StoredEventMarketHandoffDelivery, "recipient" | "selfCopy"> {
  // Aggregate legacy states cannot prove which relay ACKed which exact wrap.
  // Preserve the immutable wraps but require a fresh progress-aware retry.
  return {
    recipient: {
      status: "unknown",
      acknowledgedCount: 0,
      failedCount: 0,
    },
    selfCopy: {
      status: record.signedSelfWrap ? "unknown" : "failed",
      acknowledgedCount: 0,
      failedCount: 0,
    },
  }
}

function validStoredDelivery(
  value: unknown,
  principalPubkey: string
): StoredEventMarketHandoffDelivery | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<StoredEventMarketHandoffDelivery> & {
    delivered?: unknown
  }
  let record: EventMarketPrivateDeliveryRecord
  try {
    record = parseEventMarketPrivateDeliveryRecord(candidate.record)
  } catch {
    return null
  }
  if (
    typeof candidate.savedAt !== "number" ||
    !Number.isFinite(candidate.savedAt)
  ) {
    return null
  }
  if (
    record.messageType === "organizer_fulfillment_receipt" &&
    (!record.signedSelfWrap || !record.orderCorrelationRef)
  ) {
    return null
  }
  if (
    record.messageType === "organizer_fulfillment_revocation" &&
    !record.orderCorrelationRef
  ) {
    return null
  }
  let deliveryProgress: EventMarketPrivateDeliveryProgress
  const hasBoundProgress = candidate.deliveryProgress !== undefined
  try {
    deliveryProgress = hasBoundProgress
      ? parseEventMarketPrivateDeliveryProgress(
          candidate.deliveryProgress,
          record
        )
      : createEventMarketPrivateDeliveryProgress(record)
  } catch {
    return null
  }
  const state = (() => {
    if (!hasBoundProgress) return legacyDeliveryState(record)
    const recipient = validLegState(candidate.recipient, RECIPIENT_STATUSES)
    const selfCopy = validLegState(candidate.selfCopy, SELF_COPY_STATUSES)
    return recipient && selfCopy ? { recipient, selfCopy } : null
  })()
  if (
    !state ||
    !recipientStateIsConsistent(state.recipient) ||
    !selfCopyStateIsConsistent(state.selfCopy) ||
    state.recipient.acknowledgedCount !==
      deliveryProgress.recipientAcknowledgedRelayRefs.length ||
    state.selfCopy.acknowledgedCount !==
      deliveryProgress.selfAcknowledgedRelayRefs.length ||
    (!record.signedSelfWrap &&
      state.selfCopy.status !== "failed" &&
      state.selfCopy.status !== "unknown")
  ) {
    return null
  }
  const principal = principalPubkey.trim().toLowerCase()
  if (record.senderPubkey.toLowerCase() !== principal) return null
  return {
    record,
    deliveryProgress,
    ...state,
    savedAt: candidate.savedAt,
  }
}

export function loadEventMarketHandoffDeliveries(
  principalPubkey: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage()
): StoredEventMarketHandoffDelivery[] {
  if (!storage) return []
  try {
    const parsed = JSON.parse(
      storage.getItem(storageKey(principalPubkey)) ?? "[]"
    ) as unknown
    if (!Array.isArray(parsed)) return []
    const latest = new Map<string, StoredEventMarketHandoffDelivery>()
    for (const value of parsed) {
      const delivery = validStoredDelivery(value, principalPubkey)
      if (!delivery) continue
      const identity = deliveryIdentity(delivery)
      const current = latest.get(identity)
      if (!current || delivery.savedAt >= current.savedAt) {
        latest.set(identity, delivery)
      }
    }
    return Array.from(latest.values())
  } catch {
    return []
  }
}

function deliveryIdentity(delivery: StoredEventMarketHandoffDelivery): string {
  return `${delivery.record.messageType}:${delivery.record.readyReceiptId}`
}

export function eventMarketHandoffRecipientAcknowledged(
  delivery: StoredEventMarketHandoffDelivery
): boolean {
  return delivery.recipient.acknowledgedCount > 0
}

export function eventMarketHandoffDeliveryNeedsRetry(
  delivery: StoredEventMarketHandoffDelivery
): boolean {
  const recipientComplete = delivery.recipient.status === "full_success"
  const selfCopyComplete = delivery.selfCopy.status === "full_success"
  return !recipientComplete || !selfCopyComplete
}

function hasMatchingDeliveredRevocation(
  ready: StoredEventMarketHandoffDelivery,
  deliveries: readonly StoredEventMarketHandoffDelivery[]
): boolean {
  return deliveries.some(
    (delivery) =>
      delivery.record.messageType === "organizer_fulfillment_revocation" &&
      delivery.record.readyReceiptId === ready.record.readyReceiptId &&
      delivery.record.orderCorrelationRef ===
        ready.record.orderCorrelationRef &&
      !eventMarketHandoffDeliveryNeedsRetry(delivery)
  )
}

function deliveryRequiresRetention(
  delivery: StoredEventMarketHandoffDelivery,
  deliveries: readonly StoredEventMarketHandoffDelivery[]
): boolean {
  if (eventMarketHandoffDeliveryNeedsRetry(delivery)) return true
  return (
    delivery.record.messageType === "organizer_fulfillment_receipt" &&
    !hasMatchingDeliveredRevocation(delivery, deliveries)
  )
}

function readStoredDeliveries(
  principalPubkey: string,
  storage: Pick<Storage, "getItem">
): StoredEventMarketHandoffDelivery[] {
  const raw = storage.getItem(storageKey(principalPubkey))
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error("Private handoff delivery storage is malformed.")
  }
  return parsed.flatMap((value) => {
    const delivery = validStoredDelivery(value, principalPubkey)
    return delivery ? [delivery] : []
  })
}

function upsertDelivery(
  principalPubkey: string,
  delivery: StoredEventMarketHandoffDelivery,
  storage: HandoffStorage | null
): void {
  if (!storage) {
    throw new Error(
      "Durable private handoff retry storage is unavailable. Publishing was stopped before relay delivery."
    )
  }
  const valid = validStoredDelivery(delivery, principalPubkey)
  if (!valid) throw new Error("Stored handoff delivery is invalid.")
  try {
    const latest = new Map<string, StoredEventMarketHandoffDelivery>()
    for (const current of readStoredDeliveries(principalPubkey, storage)) {
      const identity = deliveryIdentity(current)
      const prior = latest.get(identity)
      if (!prior || current.savedAt >= prior.savedAt) {
        latest.set(identity, current)
      }
    }
    const candidateIdentity = deliveryIdentity(valid)
    latest.set(candidateIdentity, valid)
    if (
      valid.record.messageType === "organizer_fulfillment_revocation" &&
      valid.record.orderCorrelationRef
    ) {
      for (const [identity, current] of latest) {
        if (
          current.record.messageType === "organizer_fulfillment_receipt" &&
          current.record.readyReceiptId === valid.record.readyReceiptId &&
          current.record.orderCorrelationRef ===
            valid.record.orderCorrelationRef
        ) {
          latest.delete(identity)
        }
      }
    }
    const sorted = Array.from(latest.values()).sort(
      (left, right) => right.savedAt - left.savedAt
    )
    const required = sorted.filter(
      (item) =>
        deliveryRequiresRetention(item, sorted) ||
        deliveryIdentity(item) === candidateIdentity
    )
    if (required.length > STORAGE_LIMIT) {
      throw new Error("Private handoff retry storage is at capacity.")
    }
    const terminalHistory = sorted.filter(
      (item) =>
        !deliveryRequiresRetention(item, sorted) &&
        deliveryIdentity(item) !== candidateIdentity
    )
    const rows = [
      ...required,
      ...terminalHistory.slice(0, Math.max(0, STORAGE_LIMIT - required.length)),
    ]
    storage.setItem(storageKey(principalPubkey), JSON.stringify(rows))
    const persisted = readStoredDeliveries(principalPubkey, storage).find(
      (item) => deliveryIdentity(item) === candidateIdentity
    )
    if (
      persisted?.record.signedRecipientWrap.id !==
        valid.record.signedRecipientWrap.id ||
      persisted.record.signedRecipientWrap.sig !==
        valid.record.signedRecipientWrap.sig ||
      persisted.record.signedSelfWrap?.id !== valid.record.signedSelfWrap?.id ||
      persisted.record.signedSelfWrap?.sig !==
        valid.record.signedSelfWrap?.sig ||
      JSON.stringify(persisted.deliveryProgress) !==
        JSON.stringify(valid.deliveryProgress)
    ) {
      throw new Error("Exact encrypted handoff wraps were not retained.")
    }
  } catch {
    throw new Error(
      "The exact encrypted handoff delivery could not be saved. Relay publishing was stopped."
    )
  }
}

export function rememberEventMarketHandoffDelivery(
  principalPubkey: string,
  delivery: StoredEventMarketHandoffDelivery,
  storage: HandoffStorage | null = browserStorage()
): void {
  const valid = validStoredDelivery(delivery, principalPubkey)
  if (!valid) throw new Error("Stored handoff delivery is invalid.")
  upsertDelivery(principalPubkey, valid, storage)
}

export function buildOrganizerReadyReceiptPayload(
  order: OrderSchema,
  market: EventMarketResolution,
  fulfillmentState: "paid" | "zero_cost",
  issuedAt = Math.floor(Date.now() / 1_000)
): EventMarketReadyReceiptSchema {
  return buildEventMarketReadyReceiptPayload({
    order,
    market,
    fulfillmentState,
    issuedAt,
  })
}

export async function resolveOrganizerHandoffMerchandise(input: {
  organizerPubkey: string
  claim: EventMarketOrganizerClaim
}): Promise<EventMarketReceiptMerchandiseResolution> {
  const organizer = input.organizerPubkey.trim().toLowerCase()
  if (input.claim.receipt.payload.organizerPubkey.toLowerCase() !== organizer) {
    throw new Error("The handoff receipt does not belong to this organizer.")
  }
  return getEventMarketReceiptMerchandise({
    receipt: input.claim.receipt.payload,
    authenticatedPubkey: organizer,
  })
}

export function resolveOrganizerHandoffAckReadiness(input: {
  claim: EventMarketOrganizerClaim
  read: Pick<
    EventMarketPrivateReadResult<unknown>,
    "stale" | "decryptFailureCount" | "inbox"
  >
  market: EventMarketResolution
  merchandise?: EventMarketReceiptMerchandiseResolution
}): EventMarketHandoffAckGate {
  if (!input.merchandise) {
    return { state: "blocked", reason: "merchandise_not_verified" }
  }
  return resolveEventMarketHandoffAckGate({
    claim: input.claim,
    read: input.read,
    market: input.market,
    merchandise: input.merchandise,
  })
}

export function getOrganizerReadyReceiptFulfillmentState(
  order: OrderSchema,
  paymentAuthenticated: boolean
): "paid" | "zero_cost" {
  const zeroCost =
    order.items.length > 0 &&
    order.subtotal === 0 &&
    (order.shippingCostSats ?? 0) === 0 &&
    order.items.every(
      (item) =>
        item.fulfillment?.type === "pickup" &&
        item.priceAtPurchase === 0 &&
        (item.shippingCostSats ?? 0) === 0
    )
  if (!zeroCost && !paymentAuthenticated) {
    throw new Error(
      "Verify the paid order status before sharing a ready receipt."
    )
  }
  return zeroCost ? "zero_cost" : "paid"
}

function countTargets(values: readonly string[] | undefined): number {
  return Math.min(MAX_DELIVERY_TARGET_COUNT, new Set(values ?? []).size)
}

type CurrentDeliveryStatus = "zero_success" | "partial_success" | "full_success"

function recipientStateFromResult(
  status: CurrentDeliveryStatus,
  result: PublishWithPlannerResult | null,
  progress: EventMarketPrivateDeliveryProgress
): EventMarketDeliveryLegState<EventMarketRecipientDeliveryStatus> {
  const acknowledgedCount = progress.recipientAcknowledgedRelayRefs.length
  const failedCount = countTargets(result?.failedRelayUrls)
  return {
    status: status === "zero_success" ? "zero_ack" : status,
    acknowledgedCount,
    failedCount: status === "full_success" ? 0 : failedCount,
  }
}

function selfCopyStateFromResult(
  status: CurrentDeliveryStatus | null,
  result: PublishWithPlannerResult | null | undefined,
  progress: EventMarketPrivateDeliveryProgress
): EventMarketDeliveryLegState<EventMarketSelfCopyDeliveryStatus> {
  const acknowledgedCount = progress.selfAcknowledgedRelayRefs.length
  if (!status) {
    return {
      status: "failed",
      acknowledgedCount,
      failedCount: countTargets(result?.failedRelayUrls),
    }
  }
  const failedCount = countTargets(result?.failedRelayUrls)
  return {
    status: status === "zero_success" ? "zero_ack" : status,
    acknowledgedCount,
    failedCount: status === "full_success" ? 0 : failedCount,
  }
}

function stateFromPublishResult(
  stored: StoredEventMarketHandoffDelivery,
  result: EventMarketPrivatePublishResult
): StoredEventMarketHandoffDelivery {
  return {
    ...stored,
    deliveryProgress: result.deliveryProgress,
    recipient: recipientStateFromResult(
      result.deliveryStatus,
      result.recipientDelivery,
      result.deliveryProgress
    ),
    selfCopy: selfCopyStateFromResult(
      result.selfDeliveryStatus,
      result.selfDelivery,
      result.deliveryProgress
    ),
    savedAt: Date.now(),
  }
}

function stateFromRetryResult(
  stored: StoredEventMarketHandoffDelivery,
  result: RetryEventMarketPrivateDeliveryResult
): StoredEventMarketHandoffDelivery {
  return {
    ...stored,
    deliveryProgress: result.deliveryProgress,
    recipient: recipientStateFromResult(
      result.recipientStatus,
      result.recipientDelivery,
      result.deliveryProgress
    ),
    selfCopy: selfCopyStateFromResult(
      result.selfDeliveryStatus,
      result.selfDelivery,
      result.deliveryProgress
    ),
    savedAt: Date.now(),
  }
}

function stateFromDeliveryError(
  stored: StoredEventMarketHandoffDelivery,
  error: unknown
): StoredEventMarketHandoffDelivery {
  const diagnostics =
    error instanceof RelayPublishDiagnosticsError ? error.diagnostics : null
  const acknowledgedCount =
    stored.deliveryProgress.recipientAcknowledgedRelayRefs.length
  const failedCount = countTargets(diagnostics?.failedRelayUrls)
  const failedRecipient: StoredEventMarketHandoffDelivery["recipient"] =
    acknowledgedCount > 0
      ? diagnostics && failedCount > 0
        ? {
            status: "partial_success",
            acknowledgedCount,
            failedCount,
          }
        : {
            status: "unknown",
            acknowledgedCount,
            failedCount: 0,
          }
      : {
          status: "zero_ack",
          acknowledgedCount: 0,
          failedCount,
        }
  return {
    ...stored,
    // A failed attempt cannot erase relay ACKs proven by the bound checkpoint.
    recipient: failedRecipient,
    savedAt: Date.now(),
  }
}

function pendingDelivery(
  record: EventMarketPrivateDeliveryRecord,
  initialDeliveryProgress: EventMarketPrivateDeliveryProgress
): StoredEventMarketHandoffDelivery {
  const deliveryProgress = parseEventMarketPrivateDeliveryProgress(
    initialDeliveryProgress,
    record
  )
  return {
    record,
    deliveryProgress,
    recipient: {
      status: "pending",
      acknowledgedCount: 0,
      failedCount: 0,
    },
    selfCopy: {
      status: record.signedSelfWrap ? "pending" : "failed",
      acknowledgedCount: 0,
      failedCount: 0,
    },
    savedAt: Date.now(),
  }
}

async function retryStoredDelivery(
  principalPubkey: string,
  stored: StoredEventMarketHandoffDelivery,
  storage: HandoffStorage | null,
  transport?: EventMarketPrivateTransportOptions
): Promise<StoredEventMarketHandoffDelivery> {
  try {
    const result = await retryEventMarketPrivateDelivery({
      record: stored.record,
      deliveryProgress: stored.deliveryProgress,
      recipientInboxRelays: transport?.recipientInboxRelays,
      senderInboxRelays: transport?.senderInboxRelays,
      publishFn: transport?.publishFn,
    })
    const delivered = stateFromRetryResult(stored, result)
    upsertDelivery(principalPubkey, delivered, storage)
    return delivered
  } catch (error) {
    upsertDelivery(
      principalPubkey,
      stateFromDeliveryError(stored, error),
      storage
    )
    throw error
  }
}

export async function issueOrganizerReadyReceipt(input: {
  merchantPubkey: string
  order: OrderSchema
  paymentAuthenticated: boolean
  market: EventMarketResolution
  signer: NDKSigner
  storage?: HandoffStorage | null
  transport?: EventMarketPrivateTransportOptions
}): Promise<StoredEventMarketHandoffDelivery> {
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const orderCorrelationRef = getEventMarketOrderCorrelationRef(input.order.id)
  const deliveries = loadEventMarketHandoffDeliveries(
    input.merchantPubkey,
    storage
  )
  if (
    deliveries.some(
      (delivery) =>
        delivery.record.orderCorrelationRef === orderCorrelationRef &&
        delivery.record.messageType === "organizer_fulfillment_revocation"
    )
  ) {
    throw new Error(
      "This organizer ready receipt was revoked and cannot be shared again."
    )
  }
  const existing = deliveries.find(
    (delivery) =>
      delivery.record.orderCorrelationRef === orderCorrelationRef &&
      delivery.record.messageType === "organizer_fulfillment_receipt"
  )
  if (existing) {
    return !eventMarketHandoffDeliveryNeedsRetry(existing)
      ? existing
      : retryStoredDelivery(
          input.merchantPubkey,
          existing,
          storage,
          input.transport
        )
  }

  const fulfillmentState = getOrganizerReadyReceiptFulfillmentState(
    input.order,
    input.paymentAuthenticated
  )
  const payload = buildOrganizerReadyReceiptPayload(
    input.order,
    input.market,
    fulfillmentState
  )
  let stored: StoredEventMarketHandoffDelivery | null = null
  let result: EventMarketPrivatePublishResult
  try {
    result = await publishEventMarketReadyReceipt({
      payload,
      order: input.order,
      fulfillmentState,
      market: input.market,
      signer: input.signer,
      persistExactWraps: (record, initialDeliveryProgress) => {
        const pending = pendingDelivery(record, initialDeliveryProgress)
        upsertDelivery(input.merchantPubkey, pending, storage)
        stored = pending
      },
      transport: input.transport,
    })
  } catch (error) {
    const persisted = stored as StoredEventMarketHandoffDelivery | null
    if (persisted) {
      upsertDelivery(
        input.merchantPubkey,
        stateFromDeliveryError(persisted, error),
        storage
      )
    }
    throw error
  }
  const persisted = stored as StoredEventMarketHandoffDelivery | null
  if (!persisted)
    throw new Error("The encrypted ready receipt was not persisted.")
  const delivered = stateFromPublishResult(persisted, result)
  upsertDelivery(input.merchantPubkey, delivered, storage)
  return delivered
}

export async function acknowledgeOrganizerHandoff(input: {
  organizerPubkey: string
  claim: EventMarketOrganizerClaim
  read: EventMarketPrivateReadResult<EventMarketOrganizerClaim[]>
  market: EventMarketResolution
  merchandise: EventMarketReceiptMerchandiseResolution
  signer: NDKSigner
  storage?: HandoffStorage | null
  transport?: EventMarketPrivateTransportOptions
}): Promise<StoredEventMarketHandoffDelivery> {
  if (input.claim.state !== "ready_for_pickup") {
    throw new Error("Only a current ready receipt can be marked handed out.")
  }
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const readyReceiptId = input.claim.receipt.id.toLowerCase()
  const existing = loadEventMarketHandoffDeliveries(
    input.organizerPubkey,
    storage
  ).find(
    (delivery) =>
      delivery.record.readyReceiptId === readyReceiptId &&
      delivery.record.messageType === "organizer_handoff_ack"
  )
  if (existing) {
    return !eventMarketHandoffDeliveryNeedsRetry(existing)
      ? existing
      : retryStoredDelivery(
          input.organizerPubkey,
          existing,
          storage,
          input.transport
        )
  }
  const authorization = authorizeEventMarketHandoffAck({
    claim: input.claim,
    read: input.read,
    market: input.market,
    merchandise: input.merchandise,
  })
  const payload = buildEventMarketHandoffAckPayload({
    authorization,
  })
  let stored: StoredEventMarketHandoffDelivery | null = null
  let result: EventMarketPrivatePublishResult
  try {
    result = await publishEventMarketHandoffAck({
      payload,
      authorization,
      signer: input.signer,
      persistExactWraps: (record, initialDeliveryProgress) => {
        const pending = pendingDelivery(record, initialDeliveryProgress)
        upsertDelivery(input.organizerPubkey, pending, storage)
        stored = pending
      },
      transport: input.transport,
    })
  } catch (error) {
    const persisted = stored as StoredEventMarketHandoffDelivery | null
    if (persisted) {
      upsertDelivery(
        input.organizerPubkey,
        stateFromDeliveryError(persisted, error),
        storage
      )
    }
    throw error
  }
  const persisted = stored as StoredEventMarketHandoffDelivery | null
  if (!persisted)
    throw new Error("The encrypted handoff update was not persisted.")
  const delivered = stateFromPublishResult(persisted, result)
  upsertDelivery(input.organizerPubkey, delivered, storage)
  return delivered
}

export async function revokeOrganizerReadyReceipt(input: {
  merchantPubkey: string
  orderId: string
  signer: NDKSigner
  giftUnwrap?: GiftUnwrapFn
  matchingAckReceiptIds: ReadonlySet<string>
  evidenceReadStale: boolean
  storage?: HandoffStorage | null
  transport?: EventMarketPrivateTransportOptions
}): Promise<"not_required" | "revoked"> {
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const orderCorrelationRef = getEventMarketOrderCorrelationRef(input.orderId)
  const deliveries = loadEventMarketHandoffDeliveries(
    input.merchantPubkey,
    storage
  )
  const ready = deliveries.find(
    (delivery) =>
      delivery.record.orderCorrelationRef === orderCorrelationRef &&
      delivery.record.messageType === "organizer_fulfillment_receipt"
  )
  const existing = deliveries.find(
    (delivery) =>
      delivery.record.orderCorrelationRef === orderCorrelationRef &&
      delivery.record.messageType === "organizer_fulfillment_revocation"
  )
  const readyReceiptId =
    existing?.record.readyReceiptId ?? ready?.record.readyReceiptId
  if (!readyReceiptId) return "not_required"
  if (input.evidenceReadStale) {
    throw new Error(
      "Cancellation is blocked until current organizer handoff acknowledgements can be checked."
    )
  }
  if (input.matchingAckReceiptIds.has(readyReceiptId)) {
    throw new Error(
      "The organizer already marked this order handed out. Review it manually before changing status."
    )
  }
  if (existing) {
    if (eventMarketHandoffDeliveryNeedsRetry(existing)) {
      const retried = await retryStoredDelivery(
        input.merchantPubkey,
        existing,
        storage,
        input.transport
      )
      if (eventMarketHandoffDeliveryNeedsRetry(retried)) {
        throw new Error(
          "The exact organizer revocation is still only partially delivered. Cancellation remains blocked."
        )
      }
    }
    return "revoked"
  }
  if (!ready) return "not_required"
  const authorization = await authorizeEventMarketFulfillmentRevocation({
    deliveryRecord: ready.record,
    signer: input.signer,
    ...(input.giftUnwrap ? { giftUnwrap: input.giftUnwrap } : {}),
  })
  const payload = buildEventMarketFulfillmentRevocationPayload({
    authorization,
  })
  let stored: StoredEventMarketHandoffDelivery | null = null
  let result: EventMarketPrivatePublishResult
  try {
    result = await publishEventMarketFulfillmentRevocation({
      payload,
      authorization,
      signer: input.signer,
      persistExactWraps: (record, initialDeliveryProgress) => {
        const pending = pendingDelivery(record, initialDeliveryProgress)
        upsertDelivery(input.merchantPubkey, pending, storage)
        stored = pending
      },
      transport: input.transport,
    })
  } catch (error) {
    const persisted = stored as StoredEventMarketHandoffDelivery | null
    if (persisted) {
      upsertDelivery(
        input.merchantPubkey,
        stateFromDeliveryError(persisted, error),
        storage
      )
    }
    throw error
  }
  const persisted = stored as StoredEventMarketHandoffDelivery | null
  if (!persisted) throw new Error("The encrypted revocation was not persisted.")
  const delivered = stateFromPublishResult(persisted, result)
  upsertDelivery(input.merchantPubkey, delivered, storage)
  if (eventMarketHandoffDeliveryNeedsRetry(delivered)) {
    const retried = await retryStoredDelivery(
      input.merchantPubkey,
      delivered,
      storage,
      input.transport
    )
    if (eventMarketHandoffDeliveryNeedsRetry(retried)) {
      throw new Error(
        "The exact organizer revocation is still only partially delivered. Cancellation remains blocked."
      )
    }
  }
  return "revoked"
}
