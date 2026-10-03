import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { NostrKeySigner } from "./nostr-event-signer"
import { getAccountSigner } from "./session-signer"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  futureMarketHandoffAckSchema,
  futureMarketReadyReceiptSchema,
  futureMarketRevocationSchema,
  orderSchema,
  type FutureMarketHandoffAckSchema,
  type FutureMarketReadyReceiptSchema,
  type FutureMarketRevocationSchema,
  type OrderSchema,
} from "../schemas"
import { EVENT_KINDS } from "./kinds"
import {
  publishPrivateMessage,
  type PreparedPrivateMessageWraps,
  type PublishPrivateMessageResult,
} from "./messaging"
import { appendConduitClientTag } from "./nip89"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { getFutureMarketReceiptMerchandise } from "./future-market-merchandise"
import { isVerifiedEventMarketReceiptMerchandiseResolution } from "./event-market-merchandise"
import { verifyEventMarketOrderEvidence } from "./event-market-order-evidence"
import {
  isEventMarketAddressableRevisionDeleted,
  parseEventMarketCalendarEvent,
} from "./event-market"
import { resolveEventMarketRoster } from "./event-market-roster"
import { parseEventMarketSeriesEvent } from "./event-market-schedule"
import { resolveEventMarketAuthorization } from "./event-market-authorization"
import { getEventMarketPrivateMessageList } from "./commerce"
import {
  parseOrderMessageRumorEvent,
  type ParsedEventMarketPrivateMessage,
  type ParsedOrderMessage,
} from "./orders"
import {
  getEventMarketOrderCorrelationRef,
  resolveEventMarketOrganizerInbox,
} from "./event-market-handoff"
import { unwrapGiftWrap } from "./messaging"
import { getNdk } from "./ndk"
import { publishWithPlanner } from "./relay-publish"

const HEX_64 = /^[0-9a-f]{64}$/
export type FutureMarketPrivatePayload =
  | FutureMarketReadyReceiptSchema
  | FutureMarketRevocationSchema
  | FutureMarketHandoffAckSchema
type FuturePrivateMessage = Extract<
  ParsedEventMarketPrivateMessage,
  {
    type:
      | "future_market_ready"
      | "future_market_revoked"
      | "future_market_handed_out"
  }
>
type ReadyMessage = Extract<
  FuturePrivateMessage,
  { type: "future_market_ready" }
>
type RevocationMessage = Extract<
  FuturePrivateMessage,
  { type: "future_market_revoked" }
>
type AckMessage = Extract<
  FuturePrivateMessage,
  { type: "future_market_handed_out" }
>

export interface FutureMarketOrganizerClaim {
  receipt: ReadyMessage
  state: "ready_for_pickup" | "revoked" | "handed_out" | "conflicting"
  revocation?: RevocationMessage
  ack?: AckMessage
}

function authenticatedFutureMessage(
  message: ParsedOrderMessage
): message is FuturePrivateMessage {
  const payload = message.payload
  if (
    !("type" in payload) ||
    (payload.type !== "future_market_ready" &&
      payload.type !== "future_market_revoked" &&
      payload.type !== "future_market_handed_out")
  )
    return false
  const schema =
    payload.type === "future_market_ready"
      ? futureMarketReadyReceiptSchema
      : payload.type === "future_market_revoked"
        ? futureMarketRevocationSchema
        : futureMarketHandoffAckSchema
  const parsed = schema.safeParse(payload)
  return (
    parsed.success &&
    message.type === parsed.data.type &&
    message.senderPubkey === sender(parsed.data) &&
    message.recipientPubkey === recipient(parsed.data)
  )
}

export function reduceFutureMarketOrganizerClaims(input: {
  organizerPubkey: string
  messages: readonly ParsedEventMarketPrivateMessage[]
  marketCoordinate?: string
}): FutureMarketOrganizerClaim[] {
  const messages = input.messages.filter(authenticatedFutureMessage)
  const receipts = messages.filter(
    (message): message is ReadyMessage =>
      message.type === "future_market_ready" &&
      message.recipientPubkey === input.organizerPubkey &&
      (!input.marketCoordinate ||
        message.payload.market.coordinate === input.marketCoordinate)
  )
  const claims: FutureMarketOrganizerClaim[] = []
  for (const receipt of receipts) {
    const siblings = receipts.filter(
      (candidate) =>
        candidate.payload.claimRef === receipt.payload.claimRef &&
        candidate.payload.merchantPubkey === receipt.payload.merchantPubkey
    )
    if (siblings[0]?.id !== receipt.id) continue
    const terminal = messages.filter(
      (message): message is RevocationMessage | AckMessage =>
        message.type !== "future_market_ready" &&
        message.payload.readyReceiptId === receipt.id
    )
    const revocations = terminal.filter(
      (message): message is RevocationMessage =>
        message.type === "future_market_revoked"
    )
    const acks = terminal.filter(
      (message): message is AckMessage =>
        message.type === "future_market_handed_out"
    )
    const conflicting =
      siblings.length !== 1 ||
      terminal.some(
        (message) => !sameFutureGraph(message.payload, receipt.payload)
      ) ||
      (revocations.length > 0 && acks.length > 0)
    claims.push({
      receipt,
      state: conflicting
        ? "conflicting"
        : revocations.length > 0
          ? "revoked"
          : acks.length > 0
            ? "handed_out"
            : "ready_for_pickup",
      ...(revocations.at(-1) ? { revocation: revocations.at(-1) } : {}),
      ...(acks.at(-1) ? { ack: acks.at(-1) } : {}),
    })
  }
  return claims.sort(
    (left, right) => right.receipt.createdAt - left.receipt.createdAt
  )
}

function assertFutureMarketReadCurrent(shouldContinue?: () => boolean): void {
  if (shouldContinue?.() === false) {
    throw new DOMException("Private pickup read was cancelled.", "AbortError")
  }
}

export async function readFutureMarketReadyReceipts(input: {
  organizerPubkey: string
  marketCoordinate?: string
  shouldContinue?: () => boolean
}): Promise<{
  claims: FutureMarketOrganizerClaim[]
  stale: boolean
  coverageDegraded: boolean
  inbox: Awaited<ReturnType<typeof getEventMarketPrivateMessageList>>["inbox"]
}> {
  assertFutureMarketReadCurrent(input.shouldContinue)
  // The shared inbox reader owns the external signer lease and checks it
  // throughout relay reads and decryption. The caller also owns view lifetime.
  const read = await getEventMarketPrivateMessageList(input.organizerPubkey)
  assertFutureMarketReadCurrent(input.shouldContinue)
  const claims = reduceFutureMarketOrganizerClaims({
    organizerPubkey: input.organizerPubkey,
    messages: await retainFutureMessages(
      input.organizerPubkey,
      read,
      input.shouldContinue
    ),
    marketCoordinate: input.marketCoordinate,
  })
  applyTerminalHistoryToClaims(input.organizerPubkey, claims)
  return {
    claims,
    stale: read.stale,
    coverageDegraded: read.inbox?.coverage !== "complete",
    inbox: read.inbox,
  }
}

export async function readFutureMarketHandoffAcks(input: {
  merchantPubkey: string
  readyReceiptId: string
  receipt: FutureMarketReadyReceiptSchema
  shouldContinue?: () => boolean
}): Promise<{
  exactAck: AckMessage | null
  revoked: boolean
  conflicting: boolean
  stale: boolean
  coverageDegraded: boolean
}> {
  assertFutureMarketReadCurrent(input.shouldContinue)
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  const read = await getEventMarketPrivateMessageList(input.merchantPubkey)
  assertFutureMarketReadCurrent(input.shouldContinue)
  const messages = await retainFutureMessages(
    input.merchantPubkey,
    read,
    input.shouldContinue
  )
  const terminal = messages.filter(
    (message): message is RevocationMessage | AckMessage =>
      message.type !== "future_market_ready" &&
      message.payload.readyReceiptId === input.readyReceiptId
  )
  const conflicting =
    terminal.some((message) => !sameFutureGraph(message.payload, receipt)) ||
    messages.some(
      (message) =>
        message.type === "future_market_ready" &&
        message.payload.claimRef === receipt.claimRef &&
        message.payload.merchantPubkey === receipt.merchantPubkey &&
        message.id !== input.readyReceiptId
    )
  const revoked = terminal.some(
    (message) => message.type === "future_market_revoked"
  )
  const acks = terminal.filter(
    (message): message is AckMessage =>
      message.type === "future_market_handed_out" &&
      message.senderPubkey === receipt.organizerPubkey &&
      message.recipientPubkey === receipt.merchantPubkey
  )
  const stale = read.stale
  const knownTerminal = getFutureMarketTerminalHistory(
    input.merchantPubkey,
    receipt.claimRef
  )
  const knownConflict = Boolean(
    knownTerminal &&
    (knownTerminal.conflicting ||
      knownTerminal.graphDigest !== futurePrivateGraphDigest(receipt) ||
      knownTerminal.readyReceiptId !== input.readyReceiptId ||
      (knownTerminal.ack && knownTerminal.revoked))
  )
  return {
    exactAck:
      !conflicting &&
      !revoked &&
      !knownConflict &&
      !knownTerminal?.revoked &&
      acks.length === 1
        ? acks[0]!
        : null,
    revoked: revoked || Boolean(knownTerminal?.revoked),
    conflicting:
      conflicting ||
      knownConflict ||
      acks.length > 1 ||
      (revoked && acks.length > 0),
    stale,
    coverageDegraded: read.inbox?.coverage !== "complete",
  }
}

/** Exact authenticated terminal evidence survives an unrelated failed refresh. */
export function canCompleteFutureMarketHandoff(input: {
  read?: Awaited<ReturnType<typeof readFutureMarketHandoffAcks>>
  retained?: Awaited<ReturnType<typeof readFutureMarketHandoffAcks>>
  hasLocalRevocation?: boolean
}): boolean {
  if (
    input.hasLocalRevocation ||
    input.read?.revoked ||
    input.read?.conflicting ||
    input.retained?.revoked ||
    input.retained?.conflicting
  )
    return false
  return Boolean(input.read?.exactAck ?? input.retained?.exactAck)
}

/** Opaque buyer/merchant/organizer claim with no buyer or order content. */
export function getFutureMarketClaimRef(input: {
  orderId: string
  merchantPubkey: string
  organizerPubkey: string
  marketCoordinate: string
}): string {
  if (
    !input.orderId ||
    !HEX_64.test(input.merchantPubkey) ||
    !HEX_64.test(input.organizerPubkey) ||
    !input.marketCoordinate.startsWith(`30409:${input.organizerPubkey}:`)
  )
    throw new Error("Future Event Market pickup claim is invalid.")
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        `future-event-market-claim-v2\0${input.orderId}\0${input.merchantPubkey}\0${input.organizerPubkey}\0${input.marketCoordinate}`
      )
    )
  )
}

/** Authenticate original organizer approval offline, without reapproving a paid order. */
export function verifyFutureMarketReceiptAuthority(
  input: FutureMarketReadyReceiptSchema
): boolean {
  const parsed = futureMarketReadyReceiptSchema.safeParse(input)
  if (!parsed.success || !parsed.data.authorityEvidence) return false
  const receipt = parsed.data
  const evidence = receipt.authorityEvidence!
  if (
    evidence.some(
      (event) =>
        event.pubkey !== receipt.organizerPubkey ||
        event.created_at > receipt.issuedAt ||
        ![30409, 31922, 31923, 31924, 3841, 5].includes(event.kind)
    )
  )
    return false
  const byId = new Map(evidence.map((event) => [event.id, event]))
  const marketEvent = byId.get(receipt.market.eventId)
  const calendarEvent = byId.get(receipt.calendar.eventId)
  if (!marketEvent || !calendarEvent) return false
  const deletions = evidence.filter((event) => event.kind === 5)
  const marketRead = resolveEventMarketRoster({
    coordinate: receipt.market.coordinate,
    revisions: [marketEvent],
    deletions,
  })
  if (marketRead.state !== "current") return false
  const market = marketRead.market
  const calendar = parseEventMarketCalendarEvent(calendarEvent)
  if (
    market.state !== "open" ||
    market.createdAt * 1_000 !== receipt.market.createdAt ||
    !market.merchants.some(
      (row) =>
        row.pubkey === receipt.merchantPubkey &&
        row.mode === "organizer_handoff"
    ) ||
    !calendar ||
    calendar.coordinate !== receipt.calendar.coordinate ||
    calendar.createdAt !== receipt.calendar.createdAt ||
    calendar.authorPubkey !== receipt.organizerPubkey ||
    isEventMarketAddressableRevisionDeleted(receipt.calendar, deletions)
  )
    return false
  if (market.calendarCoordinate !== calendar.coordinate) {
    const schedules = evidence
      .filter((event) => event.kind === 31924)
      .map(parseEventMarketSeriesEvent)
      .filter((series) => series?.coordinate === market.calendarCoordinate)
    if (
      schedules.length !== 1 ||
      schedules[0]?.organizerPubkey !== receipt.organizerPubkey ||
      !schedules[0]?.memberCoordinates.includes(calendar.coordinate) ||
      isEventMarketAddressableRevisionDeleted(schedules[0], deletions)
    )
      return false
  }
  const authorization = resolveEventMarketAuthorization({
    marketCoordinate: receipt.market.coordinate,
    merchantPubkey: receipt.merchantPubkey,
    transitions: evidence.filter((event) => event.kind === 3841),
    deletions,
  })
  return (
    authorization.state === "active" &&
    authorization.tip.eventId === receipt.grant.eventId &&
    authorization.tip.signedEvent.created_at * 1_000 === receipt.grant.createdAt
  )
}

/** A merchant alone grants physical release for one paid order. */
export function buildFutureMarketReadyReceipt(input: {
  order: OrderSchema
  signedOrderEvidence: readonly SignedPublicNostrEvent[]
  paymentAuthenticated: boolean
  releaseConfirmed: boolean
  issuedAt?: number
}): FutureMarketReadyReceiptSchema {
  const order = orderSchema.parse(input.order)
  const evidence = verifyEventMarketOrderEvidence({
    order,
    events: input.signedOrderEvidence,
  })
  if (evidence.status !== "verified" || evidence.mode !== "organizer_handoff")
    throw new Error("Exact signed organizer handoff evidence is required.")
  const zeroCost =
    order.subtotal === 0 &&
    (order.shippingCostSats ?? 0) === 0 &&
    order.items.every(
      (item) => item.priceAtPurchase === 0 && (item.shippingCostSats ?? 0) === 0
    )
  if ((!input.paymentAuthenticated && !zeroCost) || !input.releaseConfirmed)
    throw new Error(
      "Payment and explicit physical release authority are required."
    )
  const pickupItems = order.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const first = pickupItems[0]?.fulfillment
  if (first?.type !== "event_market_pickup")
    throw new Error("Future Event Market fulfillment is required.")
  const claimRef = getFutureMarketClaimRef({
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: first.organizerPubkey,
    marketCoordinate: first.market.coordinate,
  })
  return futureMarketReadyReceiptSchema.parse({
    version: 2,
    type: "future_market_ready",
    releaseAuthorized: true,
    claimRef,
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: first.organizerPubkey,
    market: first.market,
    calendar: first.calendar,
    grant: { eventId: first.grant.eventId, createdAt: first.grant.createdAt },
    authorityEvidence: [
      first.market.signedEvent,
      first.calendar.signedEvent,
      ...(first.schedule ? [first.schedule.signedEvent] : []),
      ...first.grant.signedEvidence.ancestry,
      ...first.grant.signedEvidence.deletions,
    ],
    items: pickupItems.map((item) => {
      if (item.fulfillment?.type !== "event_market_pickup")
        throw new Error(
          "Organizer release requires one exact future pickup order."
        )
      return {
        product: {
          coordinate: item.fulfillment.product.coordinate,
          eventId: item.fulfillment.product.eventId,
          createdAt: item.fulfillment.product.createdAt,
          signedEvent: item.fulfillment.product.signedEvent,
        },
        quantity: item.quantity,
        ...(item.selectedSpecifications?.length
          ? { selectedSpecifications: item.selectedSpecifications }
          : {}),
      }
    }),
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1_000),
  })
}

function sameFutureGraph(
  left: FutureMarketPrivatePayload,
  right: FutureMarketPrivatePayload
): boolean {
  return (
    left.claimRef === right.claimRef &&
    left.merchantPubkey === right.merchantPubkey &&
    left.organizerPubkey === right.organizerPubkey &&
    JSON.stringify(left.market) === JSON.stringify(right.market) &&
    JSON.stringify(left.calendar) === JSON.stringify(right.calendar) &&
    JSON.stringify(left.grant) === JSON.stringify(right.grant)
  )
}

export function buildFutureMarketRevocation(input: {
  receipt: FutureMarketReadyReceiptSchema
  readyReceiptId: string
  issuedAt?: number
}): FutureMarketRevocationSchema {
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  return futureMarketRevocationSchema.parse({
    version: 2,
    type: "future_market_revoked",
    claimRef: receipt.claimRef,
    merchantPubkey: receipt.merchantPubkey,
    organizerPubkey: receipt.organizerPubkey,
    market: receipt.market,
    calendar: receipt.calendar,
    grant: receipt.grant,
    readyReceiptId: input.readyReceiptId,
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1_000),
  })
}

export function buildFutureMarketHandoffAck(input: {
  receipt: FutureMarketReadyReceiptSchema
  readyReceiptId: string
  handedOutAt?: number
}): FutureMarketHandoffAckSchema {
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  return futureMarketHandoffAckSchema.parse({
    version: 2,
    type: "future_market_handed_out",
    claimRef: receipt.claimRef,
    merchantPubkey: receipt.merchantPubkey,
    organizerPubkey: receipt.organizerPubkey,
    market: receipt.market,
    calendar: receipt.calendar,
    grant: receipt.grant,
    readyReceiptId: input.readyReceiptId,
    handedOutAt: input.handedOutAt ?? Math.floor(Date.now() / 1_000),
  })
}

export function validateFutureMarketPrivateUpdate(input: {
  receipt: FutureMarketReadyReceiptSchema
  readyReceiptId: string
  update: FutureMarketRevocationSchema | FutureMarketHandoffAckSchema
}): void {
  if (
    !HEX_64.test(input.readyReceiptId) ||
    input.update.readyReceiptId !== input.readyReceiptId ||
    !sameFutureGraph(input.receipt, input.update)
  )
    throw new Error(
      "Future Event Market handoff update is not bound to its exact ready receipt."
    )
}

function sender(payload: FutureMarketPrivatePayload): string {
  return payload.type === "future_market_handed_out"
    ? payload.organizerPubkey
    : payload.merchantPubkey
}

function recipient(payload: FutureMarketPrivatePayload): string {
  return payload.type === "future_market_handed_out"
    ? payload.merchantPubkey
    : payload.organizerPubkey
}

function timestamp(payload: FutureMarketPrivatePayload): number {
  return payload.type === "future_market_handed_out"
    ? payload.handedOutAt
    : payload.issuedAt
}

export function buildFutureMarketPrivateRumor(
  payload: FutureMarketPrivatePayload
): NDKEvent {
  const rumor = new NDKEvent()
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = sender(payload)
  rumor.created_at = timestamp(payload)
  rumor.tags = appendConduitClientTag(
    [
      ["p", recipient(payload)],
      ["type", payload.type],
      ["claim", payload.claimRef],
      ...(payload.type === "future_market_ready"
        ? []
        : [["e", payload.readyReceiptId]]),
    ],
    "merchant"
  )
  rumor.content = JSON.stringify(payload)
  rumor.id = rumor.getEventHash()
  return rumor
}

export interface FutureMarketPrivateDeliveryRecord {
  version: 2
  type: FutureMarketPrivatePayload["type"]
  rumorId: string
  claimRef: string
  readyReceiptId: string
  senderPubkey: string
  recipientPubkey: string
  orderCorrelationRef?: string
  signedRecipientWrap: SignedPublicNostrEvent
  signedSelfWrap: SignedPublicNostrEvent
}

const FUTURE_DELIVERY_STORAGE_PREFIX =
  "conduit:future-market-handoff-delivery:v2"
const FUTURE_PENDING_DELIVERY_LIMIT = 128
const FUTURE_PENDING_READY_LIMIT = 96
const FUTURE_DELIVERY_ARCHIVE_PREFIX = `${FUTURE_DELIVERY_STORAGE_PREFIX}:archive`
const FUTURE_TERMINAL_STORAGE_PREFIX = `${FUTURE_DELIVERY_STORAGE_PREFIX}:terminal`
// localStorage is shared with checkout and auth. Leave headroom for those owners.
const FUTURE_PENDING_BYTES = 768 * 1024
const FUTURE_ARCHIVE_BYTES = 1024 * 1024
const FUTURE_OBSERVATION_BYTES = 1024 * 1024
const FUTURE_TERMINAL_BYTES = 512 * 1024
const FUTURE_TERMINAL_HEADROOM_BYTES = 256 * 1024

type FutureTerminalRecord = {
  readyReceiptId: string
  ack: boolean
  revoked: boolean
  conflicting: boolean
  graphDigest: string
  observedRumorIds: string[]
  compacted: boolean
}
type FutureTerminalHistory = Record<string, FutureTerminalRecord>

function storageBytes(value: string): number {
  // Web Storage quotas are commonly charged in UTF-16 code units.
  return value.length * 2
}

function assertStorageBudget(value: string, limit: number): void {
  if (storageBytes(value) > limit)
    throw new Error(
      "Future handoff recovery storage is full. Recover completed claims before issuing another update."
    )
}

function terminalKey(ownerPubkey: string): string {
  return `${FUTURE_TERMINAL_STORAGE_PREFIX}:${ownerPubkey}`
}

function loadTerminalHistory(
  ownerPubkey: string,
  storage: Pick<Storage, "getItem">
): FutureTerminalHistory {
  const raw = storage.getItem(terminalKey(ownerPubkey))
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored future handoff terminal history is invalid.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Stored future handoff terminal history is invalid.")
  for (const [claimRef, value] of Object.entries(parsed)) {
    const record = value as Partial<FutureTerminalRecord> | null
    if (
      !HEX_64.test(claimRef) ||
      !record ||
      !HEX_64.test(record.readyReceiptId ?? "") ||
      typeof record.ack !== "boolean" ||
      typeof record.revoked !== "boolean" ||
      typeof record.conflicting !== "boolean" ||
      !HEX_64.test(record.graphDigest ?? "") ||
      !Array.isArray(record.observedRumorIds) ||
      record.observedRumorIds.some(
        (id) => typeof id !== "string" || !HEX_64.test(id)
      ) ||
      typeof record.compacted !== "boolean" ||
      (!record.ack && !record.revoked)
    )
      throw new Error("Stored future handoff terminal history is invalid.")
  }
  return parsed as FutureTerminalHistory
}

/** Local authenticated terminal history is a denial fence, never positive proof of handoff. */
export function getFutureMarketTerminalHistory(
  ownerPubkey: string,
  claimRef: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): FutureTerminalRecord | null {
  if (!storage || !HEX_64.test(ownerPubkey) || !HEX_64.test(claimRef))
    return null
  return loadTerminalHistory(ownerPubkey, storage)[claimRef] ?? null
}

function applyTerminalHistoryToClaims(
  owner: string,
  claims: FutureMarketOrganizerClaim[]
): void {
  for (const claim of claims) {
    const terminal = getFutureMarketTerminalHistory(
      owner,
      claim.receipt.payload.claimRef
    )
    if (!terminal) continue
    if (
      claim.state === "conflicting" ||
      terminal.conflicting ||
      terminal.readyReceiptId !== claim.receipt.id ||
      terminal.graphDigest !==
        futurePrivateGraphDigest(claim.receipt.payload) ||
      (terminal.ack && terminal.revoked)
    )
      claim.state = "conflicting"
    else if (terminal.revoked) claim.state = "revoked"
    else if (terminal.ack) claim.state = "handed_out"
  }
}

function futurePrivateGraphDigest(payload: FutureMarketPrivatePayload): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({
          claimRef: payload.claimRef,
          merchantPubkey: payload.merchantPubkey,
          organizerPubkey: payload.organizerPubkey,
          market: payload.market,
          calendar: payload.calendar,
          grant: payload.grant,
        })
      )
    )
  )
}

export function loadFutureMarketPrivateDeliveries(
  ownerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
  options: { pendingOnly?: boolean } = {}
): FutureMarketPrivateDeliveryRecord[] {
  if (!storage || !HEX_64.test(ownerPubkey)) return []
  const parseRecords = (
    raw: string | null
  ): FutureMarketPrivateDeliveryRecord[] => {
    if (!raw) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Stored future handoff recovery records are invalid.")
    }
    if (!Array.isArray(parsed))
      throw new Error("Stored future handoff recovery records are invalid.")
    const records = parsed.map(parseFutureMarketPrivateDeliveryRecord)
    if (records.some((record) => record.senderPubkey !== ownerPubkey))
      throw new Error(
        "Stored future handoff recovery belongs to another account."
      )
    return records
  }
  const pending = parseRecords(
    storage.getItem(`${FUTURE_DELIVERY_STORAGE_PREFIX}:${ownerPubkey}`)
  )
  if (options.pendingOnly) return pending
  const archiveRaw = storage.getItem(
    `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${ownerPubkey}`
  )
  const archiveIds: unknown = archiveRaw ? JSON.parse(archiveRaw) : []
  if (
    !Array.isArray(archiveIds) ||
    archiveIds.some((id) => typeof id !== "string" || !HEX_64.test(id))
  )
    throw new Error("Stored future handoff archive is invalid.")
  const archived = archiveIds.map((id) => {
    const raw = storage.getItem(
      `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${ownerPubkey}:${id}`
    )
    if (!raw) throw new Error("Archived exact handoff evidence is unavailable.")
    const record = parseFutureMarketPrivateDeliveryRecord(JSON.parse(raw))
    if (record.rumorId !== id || record.senderPubkey !== ownerPubkey)
      throw new Error(
        "Archived exact handoff evidence belongs to another account."
      )
    return record
  })
  return [
    ...new Map(
      [...archived, ...pending].map((record) => [record.rumorId, record])
    ).values(),
  ]
}

export function saveFutureMarketPrivateDelivery(
  ownerPubkey: string,
  record: FutureMarketPrivateDeliveryRecord,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): void {
  if (
    !storage ||
    !HEX_64.test(ownerPubkey) ||
    record.senderPubkey !== ownerPubkey
  )
    throw new Error(
      "Future handoff recovery storage is unavailable or belongs to another account."
    )
  const exact = parseFutureMarketPrivateDeliveryRecord(record)
  const claimKey = `${FUTURE_DELIVERY_STORAGE_PREFIX}:claim:${ownerPubkey}:${exact.claimRef}`
  const existingReadyId = storage.getItem(claimKey)
  const terminal = getFutureMarketTerminalHistory(
    ownerPubkey,
    exact.claimRef,
    storage
  )
  if (
    exact.type === "future_market_ready" &&
    ((existingReadyId && existingReadyId !== exact.rumorId) ||
      (terminal && terminal.readyReceiptId !== exact.rumorId))
  )
    throw new Error(
      "A different exact organizer release already owns this claim."
    )
  const pending = loadFutureMarketPrivateDeliveries(ownerPubkey, storage, {
    pendingOnly: true,
  })
  if (
    exact.type === "future_market_ready" &&
    pending.some(
      (candidate) =>
        candidate.type === "future_market_ready" &&
        candidate.claimRef === exact.claimRef &&
        candidate.rumorId !== exact.rumorId
    )
  )
    throw new Error(
      "A different exact organizer release already owns this claim."
    )
  const archivedRaw = storage.getItem(
    `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${ownerPubkey}:${exact.rumorId}`
  )
  const existing = archivedRaw
    ? parseFutureMarketPrivateDeliveryRecord(JSON.parse(archivedRaw))
    : pending.find((candidate) => candidate.rumorId === exact.rumorId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(exact))
    throw new Error(
      "A different exact handoff delivery already owns this rumor."
    )
  if (existing) {
    if (exact.type === "future_market_ready" && !existingReadyId)
      storage.setItem(claimKey, exact.rumorId)
    return
  }
  if (exact.type === "future_market_ready" && terminal) return
  if (
    pending.length >=
    (exact.type === "future_market_ready"
      ? FUTURE_PENDING_READY_LIMIT
      : FUTURE_PENDING_DELIVERY_LIMIT)
  )
    throw new Error(
      "Pending handoff deliveries need recovery before another release."
    )
  const nextPending = JSON.stringify([...pending, exact])
  assertStorageBudget(
    nextPending,
    FUTURE_PENDING_BYTES -
      (exact.type === "future_market_ready"
        ? FUTURE_TERMINAL_HEADROOM_BYTES
        : 0)
  )
  // Exact wraps are written before the claim marker. If the second write
  // fails, the pending record itself still prevents fresh issuance.
  storage.setItem(
    `${FUTURE_DELIVERY_STORAGE_PREFIX}:${ownerPubkey}`,
    nextPending
  )
  if (exact.type === "future_market_ready")
    storage.setItem(claimKey, exact.rumorId)
}

/** Move fully delivered wraps out of the bounded retry queue; keep exact evidence. */
export function archiveFutureMarketPrivateDelivery(
  ownerPubkey: string,
  rumorId: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): void {
  if (!storage)
    throw new Error("Future handoff recovery storage is unavailable.")
  if (!HEX_64.test(ownerPubkey) || !HEX_64.test(rumorId))
    throw new Error("Exact handoff delivery identity is invalid.")
  const pendingKey = `${FUTURE_DELIVERY_STORAGE_PREFIX}:${ownerPubkey}`
  const pending = loadFutureMarketPrivateDeliveries(ownerPubkey, storage, {
    pendingOnly: true,
  })
  const archivedRaw = storage.getItem(
    `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${ownerPubkey}:${rumorId}`
  )
  const candidate =
    pending.find((record) => record.rumorId === rumorId) ??
    (archivedRaw ? JSON.parse(archivedRaw) : null)
  const record = candidate
    ? parseFutureMarketPrivateDeliveryRecord(candidate)
    : null
  if (!record || record.senderPubkey !== ownerPubkey)
    throw new Error("Exact handoff delivery belongs to another account.")
  const archiveKey = `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${ownerPubkey}`
  const ids = JSON.parse(storage.getItem(archiveKey) ?? "[]") as string[]
  const nextIds = ids.includes(rumorId) ? ids : [...ids, rumorId]
  const archivedBytes = nextIds.reduce(
    (total, id) => {
      const raw =
        id === rumorId
          ? JSON.stringify(record)
          : storage.getItem(`${archiveKey}:${id}`)
      if (!raw)
        throw new Error("Archived exact handoff evidence is unavailable.")
      return total + storageBytes(raw)
    },
    storageBytes(JSON.stringify(nextIds))
  )
  if (
    archivedBytes >
    FUTURE_ARCHIVE_BYTES -
      (record.type === "future_market_ready"
        ? FUTURE_TERMINAL_HEADROOM_BYTES
        : 0)
  )
    throw new Error(
      "Future handoff exact archive is full. Recover completed claims before another update."
    )
  // Write the durable evidence and its index first. An interrupted write leaves
  // the pending copy intact, and duplicate copies are deduplicated on load.
  storage.setItem(`${archiveKey}:${rumorId}`, JSON.stringify(record))
  if (!ids.includes(rumorId))
    storage.setItem(archiveKey, JSON.stringify(nextIds))
  storage.setItem(
    pendingKey,
    JSON.stringify(pending.filter((candidate) => candidate.rumorId !== rumorId))
  )
}

const retainedFutureMessages = new Map<
  string,
  Map<string, FuturePrivateMessage>
>()
/** Reset volatile observations for deterministic recovery tests; encrypted storage remains. */
export function __resetFutureMarketHandoffTestState(): void {
  retainedFutureMessages.clear()
}
const FUTURE_OBSERVATION_STORAGE_PREFIX =
  "conduit:future-market-handoff-observed:v2"
function futureObservationKey(owner: string): string {
  return `${FUTURE_OBSERVATION_STORAGE_PREFIX}:${owner}`
}

function parseStoredFutureWraps(
  raw: string | null
): Record<string, SignedPublicNostrEvent> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "{}")
  } catch {
    throw new Error(
      "Stored authenticated handoff recovery evidence is invalid."
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      "Stored authenticated handoff recovery evidence is invalid."
    )
  return parsed as Record<string, SignedPublicNostrEvent>
}

function noteTerminalMessages(
  owner: string,
  messages: readonly FuturePrivateMessage[],
  storage: Pick<Storage, "getItem" | "setItem">
): FutureTerminalHistory {
  const history = loadTerminalHistory(owner, storage)
  let changed = false
  for (const message of messages) {
    if (message.type === "future_market_ready") continue
    const previous = history[message.payload.claimRef]
    const next: FutureTerminalRecord = {
      readyReceiptId:
        previous?.readyReceiptId ?? message.payload.readyReceiptId,
      ack: Boolean(
        previous?.ack || message.type === "future_market_handed_out"
      ),
      revoked: Boolean(
        previous?.revoked || message.type === "future_market_revoked"
      ),
      conflicting: previous?.conflicting ?? false,
      graphDigest:
        previous?.graphDigest ?? futurePrivateGraphDigest(message.payload),
      observedRumorIds: previous?.observedRumorIds ?? [],
      compacted: previous?.compacted ?? false,
    }
    if (
      previous &&
      (previous.readyReceiptId !== message.payload.readyReceiptId ||
        previous.graphDigest !== futurePrivateGraphDigest(message.payload))
    )
      next.conflicting = true
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      history[message.payload.claimRef] = next
      changed = true
    }
  }
  for (const message of messages) {
    const record = history[message.payload.claimRef]
    if (
      record &&
      (record.graphDigest !== futurePrivateGraphDigest(message.payload) ||
        (message.type === "future_market_ready" &&
          record.readyReceiptId !== message.id))
    ) {
      record.conflicting = true
      changed = true
    }
    if (record && !record.observedRumorIds.includes(message.id)) {
      record.observedRumorIds.push(message.id)
      changed = true
    }
  }
  if (changed) {
    const serialized = JSON.stringify(history)
    assertStorageBudget(serialized, FUTURE_TERMINAL_BYTES)
    storage.setItem(terminalKey(owner), serialized)
  }
  return history
}

function compactTerminalArchive(
  owner: string,
  history: FutureTerminalHistory,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  completedClaimRef?: string
): void {
  const archiveKey = `${FUTURE_DELIVERY_ARCHIVE_PREFIX}:${owner}`
  const ids: unknown = JSON.parse(storage.getItem(archiveKey) ?? "[]")
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !HEX_64.test(id))
  )
    throw new Error("Stored future handoff archive is invalid.")
  const pending = loadFutureMarketPrivateDeliveries(owner, storage, {
    pendingOnly: true,
  })
  const pendingIds = new Set(pending.map((record) => record.rumorId))
  const pruneIds: string[] = []
  for (const id of ids) {
    if (pendingIds.has(id)) continue
    const raw = storage.getItem(`${archiveKey}:${id}`)
    if (!raw) throw new Error("Archived exact handoff evidence is unavailable.")
    const record = parseFutureMarketPrivateDeliveryRecord(JSON.parse(raw))
    const terminal = history[record.claimRef]
    // Organizer terminal claims cannot be released again. Merchant records
    // remain until a signed completed/cancelled order state is observed.
    if (
      terminal &&
      terminal.readyReceiptId === record.readyReceiptId &&
      (record.claimRef === completedClaimRef ||
        terminal.compacted ||
        (record.type === "future_market_ready" &&
          owner === record.recipientPubkey) ||
        (record.type === "future_market_handed_out" &&
          owner === record.senderPubkey))
    )
      pruneIds.push(id)
  }
  if (pruneIds.length === 0) return
  const pruned = new Set(pruneIds)
  storage.setItem(
    archiveKey,
    JSON.stringify(ids.filter((id) => !pruned.has(id)))
  )
  for (const id of pruneIds) storage.removeItem(`${archiveKey}:${id}`)
}

/** Called only after the order reader has authenticated a final status update. */
export async function compactCompletedFutureMarketDelivery(
  owner: string,
  claimRef: string,
  status: "complete" | "cancelled",
  storage: Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > | null = typeof localStorage === "undefined" ? null : localStorage
): Promise<void> {
  await withFutureRetentionLock(owner, async () => {
    compactCompletedFutureMarketDeliveryLocked(owner, claimRef, status, storage)
  })
}

function compactCompletedFutureMarketDeliveryLocked(
  owner: string,
  claimRef: string,
  status: "complete" | "cancelled",
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
): void {
  if (!storage || !HEX_64.test(owner) || !HEX_64.test(claimRef)) return
  const history = loadTerminalHistory(owner, storage)
  const terminal = history[claimRef]
  if (
    !terminal ||
    terminal.conflicting ||
    (terminal.ack && terminal.revoked) ||
    (status === "complete" && !terminal.ack) ||
    (status === "cancelled" && !terminal.revoked)
  )
    return
  if (!terminal.compacted) {
    terminal.compacted = true
    const serialized = JSON.stringify(history)
    assertStorageBudget(serialized, FUTURE_TERMINAL_BYTES)
    storage.setItem(terminalKey(owner), serialized)
  }
  compactTerminalArchive(owner, history, storage, claimRef)
  const key = futureObservationKey(owner)
  const observed = parseStoredFutureWraps(storage.getItem(key))
  for (const id of terminal.observedRumorIds) delete observed[id]
  storage.setItem(key, JSON.stringify(observed))
  storage.removeItem(
    `${FUTURE_DELIVERY_STORAGE_PREFIX}:claim:${owner}:${claimRef}`
  )
  const retained = retainedFutureMessages.get(owner)
  if (retained)
    for (const [id, message] of retained)
      if (message.payload.claimRef === claimRef) retained.delete(id)
}

const futureRetentionLocks = new Map<string, Promise<void>>()
async function withFutureRetentionLock<T>(
  owner: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = futureRetentionLocks.get(owner) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  futureRetentionLocks.set(owner, queued)
  await previous
  try {
    // Coordinate the read/merge/compact transaction across tabs when the
    // browser provides Web Locks, as well as across reads in this runtime.
    if (typeof navigator !== "undefined" && navigator.locks)
      return await navigator.locks.request(
        `${FUTURE_DELIVERY_STORAGE_PREFIX}:retention:${owner}`,
        operation
      )
    return await operation()
  } finally {
    release()
    if (futureRetentionLocks.get(owner) === queued)
      futureRetentionLocks.delete(owner)
  }
}

async function retainFutureMessages(
  owner: string,
  read: Awaited<ReturnType<typeof getEventMarketPrivateMessageList>>,
  shouldContinue?: () => boolean
): Promise<FuturePrivateMessage[]> {
  return withFutureRetentionLock(owner, () =>
    retainFutureMessagesLocked(owner, read, shouldContinue)
  )
}

async function retainFutureMessagesLocked(
  owner: string,
  read: Awaited<ReturnType<typeof getEventMarketPrivateMessageList>>,
  shouldContinue?: () => boolean
): Promise<FuturePrivateMessage[]> {
  assertFutureMarketReadCurrent(shouldContinue)
  const retained =
    retainedFutureMessages.get(owner) ?? new Map<string, FuturePrivateMessage>()
  const storage = typeof localStorage === "undefined" ? null : localStorage
  const key = futureObservationKey(owner)
  const stored = parseStoredFutureWraps(storage?.getItem(key) ?? null)
  const newlyObserved: Record<string, SignedPublicNostrEvent> = {}
  const signer = getAccountSigner()
  for (const [id, wrap] of Object.entries(stored)) {
    if (retained.has(id)) continue
    if (
      !isValidSignedPublicNostrEvent(wrap) ||
      wrap.kind !== EVENT_KINDS.GIFT_WRAP ||
      wrap.tags.filter((tag) => tag[0] === "p").length !== 1 ||
      !wrap.tags.some((tag) => tag[0] === "p" && tag[1] === owner)
    )
      throw new Error(
        "Stored authenticated handoff recovery evidence is invalid."
      )
    if (!signer || (await signer.getPublicKey()) !== owner)
      throw new Error(
        "Connect the account signer to recover private handoff evidence."
      )
    assertFutureMarketReadCurrent(shouldContinue)
    if (getAccountSigner() !== signer)
      throw new Error(
        "The account signer changed during private handoff recovery."
      )
    const outcome = await unwrapGiftWrap(new NDKEvent(getNdk(), wrap), signer)
    assertFutureMarketReadCurrent(shouldContinue)
    if (outcome.status !== "ok" || outcome.category !== "order")
      throw new Error(
        "Stored private handoff evidence could not be authenticated."
      )
    const message = parseOrderMessageRumorEvent(outcome.rumor)
    if (!authenticatedFutureMessage(message) || message.id !== id)
      throw new Error(
        "Stored private handoff evidence does not match its authenticated rumor."
      )
    retained.set(id, message)
  }
  for (const message of read.messages.filter(authenticatedFutureMessage)) {
    retained.set(message.id, message)
    const wrap = read.authenticatedWraps?.[message.id]
    if (wrap) {
      if (
        !isValidSignedPublicNostrEvent(wrap) ||
        wrap.kind !== EVENT_KINDS.GIFT_WRAP ||
        !wrap.tags.some((tag) => tag[0] === "p" && tag[1] === owner)
      )
        throw new Error("Authenticated handoff recovery wrap is invalid.")
      newlyObserved[message.id] = wrap
    }
  }
  assertFutureMarketReadCurrent(shouldContinue)
  const messages = [...retained.values()]
  if (storage) {
    if (
      messages.length > 0 &&
      (!signer ||
        (await signer.getPublicKey()) !== owner ||
        getAccountSigner() !== signer)
    )
      throw new Error(
        "The account signer changed during private handoff recovery."
      )
    assertFutureMarketReadCurrent(shouldContinue)
    const history = noteTerminalMessages(owner, messages, storage)
    // A concurrent tab may have committed newer ciphertext during signer work.
    // Merge that snapshot before writing; never replace it with an older read.
    const latest = parseStoredFutureWraps(storage.getItem(key))
    const merged = { ...latest, ...newlyObserved }
    const byId = new Map(messages.map((message) => [message.id, message]))
    for (const [id, message] of byId) {
      const terminal = history[message.payload.claimRef]
      if (
        terminal &&
        (owner === message.payload.organizerPubkey || terminal.compacted)
      )
        delete merged[id]
    }
    const serialized = JSON.stringify(merged)
    const hasNewReady = read.messages.some(
      (message) =>
        authenticatedFutureMessage(message) &&
        message.type === "future_market_ready" &&
        Boolean(newlyObserved[message.id]) &&
        !history[message.payload.claimRef]?.compacted
    )
    assertStorageBudget(
      serialized,
      FUTURE_OBSERVATION_BYTES -
        (hasNewReady ? FUTURE_TERMINAL_HEADROOM_BYTES : 0)
    )
    storage.setItem(key, serialized)
    compactTerminalArchive(owner, history, storage)
    // Terminal messages are represented by the durable denial ledger after
    // this read. Active exact messages stay in memory for degraded refreshes.
    for (const [id, message] of retained) {
      if (
        history[message.payload.claimRef] &&
        (owner === message.payload.organizerPubkey ||
          history[message.payload.claimRef]!.compacted)
      )
        retained.delete(id)
    }
  }
  retainedFutureMessages.set(owner, retained)
  return messages
}

/** Authenticated self-copy recovery precedes new merchant release issuance. */
export async function readFutureMarketMerchantClaim(input: {
  order: OrderSchema
  merchantPubkey: string
  shouldContinue?: () => boolean
}): Promise<{
  claim: FutureMarketOrganizerClaim | null
  stale: boolean
  coverageDegraded: boolean
}> {
  assertFutureMarketReadCurrent(input.shouldContinue)
  const order = orderSchema.parse(input.order)
  const pickupItems = order.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const first = pickupItems[0]?.fulfillment
  if (
    order.merchantPubkey !== input.merchantPubkey ||
    first?.type !== "event_market_pickup" ||
    first.mode !== "organizer_handoff"
  )
    throw new Error("Exact merchant organizer pickup order is required.")
  const claimRef = getFutureMarketClaimRef({
    orderId: order.id,
    merchantPubkey: input.merchantPubkey,
    organizerPubkey: first.organizerPubkey,
    marketCoordinate: first.market.coordinate,
  })
  const read = await getEventMarketPrivateMessageList(input.merchantPubkey)
  assertFutureMarketReadCurrent(input.shouldContinue)
  const messages = await retainFutureMessages(
    input.merchantPubkey,
    read,
    input.shouldContinue
  )
  const claim =
    reduceFutureMarketOrganizerClaims({
      organizerPubkey: first.organizerPubkey,
      messages,
      marketCoordinate: first.market.coordinate,
    }).find(
      (candidate) =>
        candidate.receipt.payload.claimRef === claimRef &&
        candidate.receipt.payload.merchantPubkey === input.merchantPubkey
    ) ?? null
  if (claim) applyTerminalHistoryToClaims(input.merchantPubkey, [claim])
  if (claim) {
    const receipt = claim.receipt.payload
    const exactSnapshot =
      receipt.market.eventId === first.market.eventId &&
      receipt.calendar.eventId === first.calendar.eventId &&
      receipt.grant.eventId === first.grant.eventId &&
      receipt.items.length === pickupItems.length &&
      receipt.items.every((item, index) => {
        const line = pickupItems[index]!
        const fulfillment = line.fulfillment
        return (
          fulfillment?.type === "event_market_pickup" &&
          item.product.coordinate === fulfillment.product.coordinate &&
          item.product.eventId === fulfillment.product.eventId &&
          item.product.createdAt === fulfillment.product.createdAt &&
          item.quantity === line.quantity &&
          JSON.stringify(item.selectedSpecifications ?? []) ===
            JSON.stringify(line.selectedSpecifications ?? [])
        )
      })
    if (!exactSnapshot) claim.state = "conflicting"
  }
  return {
    claim,
    stale: read.stale,
    coverageDegraded: read.inbox?.coverage !== "complete",
  }
}

/** Persist signed exact wraps before any relay publish; retry never re-signs. */
async function publishFutureMarketPrivatePayload(input: {
  payload: FutureMarketPrivatePayload
  signer: NostrKeySigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  orderCorrelationRef?: string
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  const payload =
    input.payload.type === "future_market_ready"
      ? futureMarketReadyReceiptSchema.parse(input.payload)
      : input.payload.type === "future_market_revoked"
        ? futureMarketRevocationSchema.parse(input.payload)
        : futureMarketHandoffAckSchema.parse(input.payload)
  const rumor = buildFutureMarketPrivateRumor(payload)
  const result = await publishPrivateMessage({
    rumor,
    senderPubkey: sender(payload),
    recipientPubkey: recipient(payload),
    accountPubkey: sender(payload),
    authenticatedPubkey: input.authenticatedPubkey,
    signer: input.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: true,
    signerInteraction: "external",
    shouldContinue: input.shouldContinue,
    onWrapped: async (prepared: PreparedPrivateMessageWraps) => {
      const recipientWrap =
        prepared.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent
      const selfWrap = prepared.wrappedToSelf?.rawEvent() as
        SignedPublicNostrEvent | undefined
      if (
        !selfWrap ||
        !isValidSignedPublicNostrEvent(recipientWrap) ||
        !isValidSignedPublicNostrEvent(selfWrap)
      )
        throw new Error(
          "Exact signed private handoff wraps are required before delivery."
        )
      await input.persistExactWraps({
        version: 2,
        type: payload.type,
        rumorId: prepared.rumorId,
        claimRef: payload.claimRef,
        readyReceiptId:
          payload.type === "future_market_ready"
            ? prepared.rumorId
            : payload.readyReceiptId,
        senderPubkey: sender(payload),
        recipientPubkey: recipient(payload),
        ...(input.orderCorrelationRef
          ? { orderCorrelationRef: input.orderCorrelationRef }
          : {}),
        signedRecipientWrap: recipientWrap,
        signedSelfWrap: selfWrap,
      })
    },
  })
  return result
}

export async function publishFutureMarketReadyReceipt(input: {
  order: OrderSchema
  signedOrderEvidence: readonly SignedPublicNostrEvent[]
  paymentAuthenticated: boolean
  releaseConfirmed: boolean
  signer: NostrKeySigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  const payload = buildFutureMarketReadyReceipt(input)
  const claimKey = `${FUTURE_DELIVERY_STORAGE_PREFIX}:claim:${payload.merchantPubkey}:${payload.claimRef}`
  if (
    typeof localStorage !== "undefined" &&
    (localStorage.getItem(claimKey) ||
      getFutureMarketTerminalHistory(payload.merchantPubkey, payload.claimRef))
  )
    throw new Error(
      "An exact release is already saved for this order. Recover its original claim."
    )
  if (
    loadFutureMarketPrivateDeliveries(payload.merchantPubkey).some(
      (record) =>
        record.type === "future_market_ready" &&
        record.claimRef === payload.claimRef
    )
  )
    throw new Error(
      "An exact release is already saved for this order. Retry its original signed wraps."
    )
  const recovered = await readFutureMarketMerchantClaim({
    order: input.order,
    merchantPubkey: payload.merchantPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (recovered.claim)
    throw new Error(
      "An authenticated release already exists for this order. Recover its exact receipt instead of creating another release."
    )
  if (
    typeof localStorage !== "undefined" &&
    (localStorage.getItem(claimKey) ||
      getFutureMarketTerminalHistory(payload.merchantPubkey, payload.claimRef))
  )
    throw new Error(
      "An authenticated terminal update already exists for this claim. Refresh its history before another release."
    )
  if (recovered.stale || recovered.coverageDegraded)
    throw new Error(
      "Private release recovery is incomplete. Refresh before issuing a new organizer release."
    )
  return publishFutureMarketPrivatePayload({
    payload,
    signer: input.signer,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    orderCorrelationRef: getEventMarketOrderCorrelationRef(input.order.id),
    persistExactWraps: input.persistExactWraps,
  })
}

export async function publishFutureMarketHandoffAck(input: {
  organizerPubkey: string
  claim: FutureMarketOrganizerClaim
  physicalReleaseConfirmed: boolean
  signer: NostrKeySigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  if (
    !input.physicalReleaseConfirmed ||
    input.claim.state !== "ready_for_pickup" ||
    input.claim.receipt.payload.organizerPubkey !== input.organizerPubkey
  )
    throw new Error(
      "Exact organizer physical release confirmation is required."
    )
  if (!verifyFutureMarketReceiptAuthority(input.claim.receipt.payload))
    throw new Error("Original signed organizer handoff approval is required.")
  const merchandise = await getFutureMarketReceiptMerchandise({
    receipt: input.claim.receipt.payload,
    authenticatedPubkey: input.organizerPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (!isVerifiedEventMarketReceiptMerchandiseResolution(merchandise))
    throw new Error("Exact signed merchandise must be verified before handoff.")
  assertFutureMarketReadCurrent(input.shouldContinue)
  const current = await readFutureMarketReadyReceipts({
    organizerPubkey: input.organizerPubkey,
    marketCoordinate: input.claim.receipt.payload.market.coordinate,
    shouldContinue: input.shouldContinue,
  })
  const exact = current.claims.find(
    (claim) =>
      claim.receipt.id === input.claim.receipt.id &&
      claim.receipt.payload.claimRef === input.claim.receipt.payload.claimRef
  )
  if (
    !exact ||
    exact.state !== "ready_for_pickup" ||
    JSON.stringify(exact.receipt.payload) !==
      JSON.stringify(input.claim.receipt.payload)
  )
    throw new Error(
      "Current exact ready receipt must be verified before handoff."
    )
  const payload = buildFutureMarketHandoffAck({
    receipt: exact.receipt.payload,
    readyReceiptId: exact.receipt.id,
  })
  return publishFutureMarketPrivatePayload({
    payload,
    signer: input.signer,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    persistExactWraps: input.persistExactWraps,
  })
}

export function parseFutureMarketPrivateDeliveryRecord(
  value: unknown
): FutureMarketPrivateDeliveryRecord {
  if (!value || typeof value !== "object")
    throw new Error("Future Event Market delivery record is invalid.")
  const record = value as FutureMarketPrivateDeliveryRecord
  if (
    record.version !== 2 ||
    ![
      "future_market_ready",
      "future_market_revoked",
      "future_market_handed_out",
    ].includes(record.type) ||
    !HEX_64.test(record.rumorId) ||
    !HEX_64.test(record.claimRef) ||
    !HEX_64.test(record.readyReceiptId) ||
    !HEX_64.test(record.senderPubkey) ||
    !HEX_64.test(record.recipientPubkey) ||
    (record.orderCorrelationRef !== undefined &&
      !HEX_64.test(record.orderCorrelationRef)) ||
    !isValidSignedPublicNostrEvent(record.signedRecipientWrap) ||
    !isValidSignedPublicNostrEvent(record.signedSelfWrap) ||
    record.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    record.signedSelfWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    record.signedRecipientWrap.tags.filter((tag) => tag[0] === "p").length !==
      1 ||
    record.signedSelfWrap.tags.filter((tag) => tag[0] === "p").length !== 1 ||
    !record.signedRecipientWrap.tags.some(
      (tag) => tag[0] === "p" && tag[1] === record.recipientPubkey
    ) ||
    !record.signedSelfWrap.tags.some(
      (tag) => tag[0] === "p" && tag[1] === record.senderPubkey
    )
  )
    throw new Error("Future Event Market exact delivery wraps are invalid.")
  return record
}

/** Recover the merchant's encrypted self-copy before revoking its exact release. */
export async function recoverFutureMarketReadyReceipt(input: {
  record: FutureMarketPrivateDeliveryRecord
  signer: NostrKeySigner
}): Promise<FutureMarketReadyReceiptSchema> {
  const record = parseFutureMarketPrivateDeliveryRecord(input.record)
  if (
    record.type !== "future_market_ready" ||
    (await input.signer.getPublicKey()) !== record.senderPubkey
  )
    throw new Error("Merchant ready receipt recovery authority is invalid.")
  const outcome = await unwrapGiftWrap(
    new NDKEvent(getNdk(), record.signedSelfWrap),
    input.signer
  )
  if (
    outcome.status !== "ok" ||
    outcome.category !== "order" ||
    outcome.rumor.id !== record.rumorId ||
    outcome.rumor.pubkey !== record.senderPubkey
  )
    throw new Error("Exact ready receipt self-copy could not be recovered.")
  const payload = futureMarketReadyReceiptSchema.parse(
    JSON.parse(outcome.rumor.content)
  )
  if (
    payload.claimRef !== record.claimRef ||
    payload.merchantPubkey !== record.senderPubkey ||
    payload.organizerPubkey !== record.recipientPubkey
  )
    throw new Error(
      "Recovered ready receipt does not match its exact delivery."
    )
  return payload
}

export async function publishFutureMarketRevocation(input: {
  readyRecord?: FutureMarketPrivateDeliveryRecord
  recoveredClaim?: FutureMarketOrganizerClaim
  signer: NostrKeySigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  const receipt = input.readyRecord
    ? await recoverFutureMarketReadyReceipt({
        record: input.readyRecord,
        signer: input.signer,
      })
    : input.recoveredClaim?.receipt.payload
  const readyReceiptId =
    input.readyRecord?.readyReceiptId ?? input.recoveredClaim?.receipt.id
  if (
    !receipt ||
    !readyReceiptId ||
    (await input.signer.getPublicKey()) !== receipt.merchantPubkey ||
    (input.recoveredClaim && input.recoveredClaim.state !== "ready_for_pickup")
  )
    throw new Error(
      "Exact uncompleted merchant release is required for revocation."
    )
  const payload = buildFutureMarketRevocation({ receipt, readyReceiptId })
  validateFutureMarketPrivateUpdate({
    receipt,
    readyReceiptId,
    update: payload,
  })
  return publishFutureMarketPrivatePayload({
    payload,
    signer: input.signer,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    orderCorrelationRef: input.readyRecord?.orderCorrelationRef,
    persistExactWraps: input.persistExactWraps,
  })
}

/** Retry the same signed wraps; no new rumor, signature, or semantic release. */
export async function retryFutureMarketPrivateDelivery(input: {
  record: FutureMarketPrivateDeliveryRecord
  authenticatedOwnerPubkey: string
  shouldContinue?: () => boolean
}): Promise<{ recipientDelivered: boolean; selfCopyDelivered: boolean }> {
  assertFutureMarketReadCurrent(input.shouldContinue)
  const record = parseFutureMarketPrivateDeliveryRecord(input.record)
  if (record.senderPubkey !== input.authenticatedOwnerPubkey)
    throw new Error("Exact future handoff delivery belongs to another account.")
  const recipientInbox = await resolveEventMarketOrganizerInbox(
    record.recipientPubkey,
    {
      requestingAccountPubkey: record.senderPubkey,
      authenticatedPubkey: input.authenticatedOwnerPubkey,
      shouldContinue: input.shouldContinue,
    }
  )
  assertFutureMarketReadCurrent(input.shouldContinue)
  const senderInbox = await resolveEventMarketOrganizerInbox(
    record.senderPubkey,
    {
      requestingAccountPubkey: record.senderPubkey,
      authenticatedPubkey: input.authenticatedOwnerPubkey,
      shouldContinue: input.shouldContinue,
    }
  )
  assertFutureMarketReadCurrent(input.shouldContinue)
  if (recipientInbox.state !== "ready" || senderInbox.state !== "ready")
    throw new Error(
      "Current private inbox routes are unavailable for exact-wrap retry."
    )
  const recipientDelivery = await publishWithPlanner(
    new NDKEvent(getNdk(), record.signedRecipientWrap),
    {
      intent: "recipient_event",
      authorPubkey: record.senderPubkey,
      authenticatedPubkey: input.authenticatedOwnerPubkey,
      accountPubkey: record.senderPubkey,
      recipientPubkeys: [record.recipientPubkey],
      exclusiveRelayUrls: recipientInbox.relayUrls,
      deliveryMode: "critical",
      shouldContinue: input.shouldContinue,
    }
  )
  assertFutureMarketReadCurrent(input.shouldContinue)
  const selfDelivery = await publishWithPlanner(
    new NDKEvent(getNdk(), record.signedSelfWrap),
    {
      intent: "recipient_event",
      authorPubkey: record.senderPubkey,
      authenticatedPubkey: input.authenticatedOwnerPubkey,
      accountPubkey: record.senderPubkey,
      recipientPubkeys: [record.senderPubkey],
      exclusiveRelayUrls: senderInbox.relayUrls,
      deliveryMode: "critical",
      shouldContinue: input.shouldContinue,
    }
  )
  assertFutureMarketReadCurrent(input.shouldContinue)
  return {
    recipientDelivered: recipientDelivery.successfulRelayUrls.length > 0,
    selfCopyDelivered: selfDelivery.successfulRelayUrls.length > 0,
  }
}
