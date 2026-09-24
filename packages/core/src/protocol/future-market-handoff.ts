import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
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
import { verifyEventMarketOrderEvidence } from "./event-market-order-evidence"
import { getEventMarketPrivateMessageList } from "./commerce"
import type { ParsedEventMarketPrivateMessage } from "./orders"
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
  message: ParsedEventMarketPrivateMessage
): message is FuturePrivateMessage {
  const payload = message.payload
  if (
    payload.type !== "future_market_ready" &&
    payload.type !== "future_market_revoked" &&
    payload.type !== "future_market_handed_out"
  )
    return false
  const schema =
    payload.type === "future_market_ready"
      ? futureMarketReadyReceiptSchema
      : payload.type === "future_market_revoked"
        ? futureMarketRevocationSchema
        : futureMarketHandoffAckSchema
  return (
    schema.safeParse(payload).success &&
    message.senderPubkey === sender(payload) &&
    message.recipientPubkey === recipient(payload)
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

export async function readFutureMarketReadyReceipts(input: {
  organizerPubkey: string
  marketCoordinate?: string
}): Promise<{
  claims: FutureMarketOrganizerClaim[]
  stale: boolean
  inbox: Awaited<ReturnType<typeof getEventMarketPrivateMessageList>>["inbox"]
}> {
  const read = await getEventMarketPrivateMessageList(input.organizerPubkey)
  return {
    claims: reduceFutureMarketOrganizerClaims({
      organizerPubkey: input.organizerPubkey,
      messages: read.messages,
      marketCoordinate: input.marketCoordinate,
    }),
    stale: read.stale || read.inbox?.coverage !== "complete",
    inbox: read.inbox,
  }
}

export async function readFutureMarketHandoffAcks(input: {
  merchantPubkey: string
  readyReceiptId: string
  receipt: FutureMarketReadyReceiptSchema
}): Promise<{
  exactAck: AckMessage | null
  revoked: boolean
  conflicting: boolean
  stale: boolean
}> {
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  const read = await getEventMarketPrivateMessageList(input.merchantPubkey)
  const terminal = read.messages
    .filter(authenticatedFutureMessage)
    .filter(
      (message): message is RevocationMessage | AckMessage =>
        message.type !== "future_market_ready" &&
        message.payload.readyReceiptId === input.readyReceiptId
    )
  const conflicting = terminal.some(
    (message) => !sameFutureGraph(message.payload, receipt)
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
  const stale = read.stale || read.inbox?.coverage !== "complete"
  return {
    exactAck:
      !conflicting && !revoked && !stale && acks.length === 1 ? acks[0]! : null,
    revoked,
    conflicting: conflicting || acks.length > 1 || (revoked && acks.length > 0),
    stale,
  }
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
  const first = order.items[0]!.fulfillment
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
    items: order.items.map((item) => {
      if (item.fulfillment?.type !== "event_market_pickup")
        throw new Error(
          "Organizer release requires one exact future pickup order."
        )
      return {
        product: item.fulfillment.product,
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
const FUTURE_DELIVERY_LIMIT = 100

export function loadFutureMarketPrivateDeliveries(
  ownerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): FutureMarketPrivateDeliveryRecord[] {
  if (!storage || !HEX_64.test(ownerPubkey)) return []
  const raw = storage.getItem(
    `${FUTURE_DELIVERY_STORAGE_PREFIX}:${ownerPubkey}`
  )
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored future handoff recovery records are invalid.")
  }
  if (!Array.isArray(parsed) || parsed.length > FUTURE_DELIVERY_LIMIT)
    throw new Error("Stored future handoff recovery records are invalid.")
  return parsed
    .map(parseFutureMarketPrivateDeliveryRecord)
    .filter((record) => record.senderPubkey === ownerPubkey)
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
  const current = loadFutureMarketPrivateDeliveries(ownerPubkey, storage)
  const existing = current.find(
    (candidate) => candidate.rumorId === exact.rumorId
  )
  if (existing && JSON.stringify(existing) !== JSON.stringify(exact))
    throw new Error(
      "A different exact handoff delivery already owns this rumor."
    )
  if (!existing && current.length >= FUTURE_DELIVERY_LIMIT)
    throw new Error("Future handoff recovery storage is full.")
  storage.setItem(
    `${FUTURE_DELIVERY_STORAGE_PREFIX}:${ownerPubkey}`,
    JSON.stringify(existing ? current : [...current, exact])
  )
}

/** Persist signed exact wraps before any relay publish; retry never re-signs. */
async function publishFutureMarketPrivatePayload(input: {
  payload: FutureMarketPrivatePayload
  signer: NDKSigner
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
  return publishPrivateMessage({
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
}

export async function publishFutureMarketReadyReceipt(input: {
  order: OrderSchema
  signedOrderEvidence: readonly SignedPublicNostrEvent[]
  paymentAuthenticated: boolean
  releaseConfirmed: boolean
  signer: NDKSigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  const payload = buildFutureMarketReadyReceipt(input)
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
  signer: NDKSigner
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
  const current = await readFutureMarketReadyReceipts({
    organizerPubkey: input.organizerPubkey,
    marketCoordinate: input.claim.receipt.payload.market.coordinate,
  })
  const exact = current.claims.find(
    (claim) =>
      claim.receipt.id === input.claim.receipt.id &&
      claim.receipt.payload.claimRef === input.claim.receipt.payload.claimRef
  )
  if (current.stale || !exact || exact.state !== "ready_for_pickup")
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
  signer: NDKSigner
}): Promise<FutureMarketReadyReceiptSchema> {
  const record = parseFutureMarketPrivateDeliveryRecord(input.record)
  if (
    record.type !== "future_market_ready" ||
    (await input.signer.user()).pubkey !== record.senderPubkey
  )
    throw new Error("Merchant ready receipt recovery authority is invalid.")
  const outcome = await unwrapGiftWrap(
    new NDKEvent(getNdk(), record.signedSelfWrap),
    input.signer
  )
  if (
    outcome.status !== "ok" ||
    outcome.category !== "order" ||
    outcome.rumor.id !== record.rumorId
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
  readyRecord: FutureMarketPrivateDeliveryRecord
  signer: NDKSigner
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  persistExactWraps: (
    record: FutureMarketPrivateDeliveryRecord
  ) => void | Promise<void>
}): Promise<PublishPrivateMessageResult> {
  const receipt = await recoverFutureMarketReadyReceipt({
    record: input.readyRecord,
    signer: input.signer,
  })
  const payload = buildFutureMarketRevocation({
    receipt,
    readyReceiptId: input.readyRecord.readyReceiptId,
  })
  validateFutureMarketPrivateUpdate({
    receipt,
    readyReceiptId: input.readyRecord.readyReceiptId,
    update: payload,
  })
  return publishFutureMarketPrivatePayload({
    payload,
    signer: input.signer,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    orderCorrelationRef: input.readyRecord.orderCorrelationRef,
    persistExactWraps: input.persistExactWraps,
  })
}

/** Retry the same signed wraps; no new rumor, signature, or semantic release. */
export async function retryFutureMarketPrivateDelivery(input: {
  record: FutureMarketPrivateDeliveryRecord
  authenticatedOwnerPubkey: string
  shouldContinue?: () => boolean
}): Promise<{ recipientDelivered: boolean; selfCopyDelivered: boolean }> {
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
  const senderInbox = await resolveEventMarketOrganizerInbox(
    record.senderPubkey,
    {
      requestingAccountPubkey: record.senderPubkey,
      authenticatedPubkey: input.authenticatedOwnerPubkey,
      shouldContinue: input.shouldContinue,
    }
  )
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
  return {
    recipientDelivered: recipientDelivery.successfulRelayUrls.length > 0,
    selfCopyDelivered: selfDelivery.successfulRelayUrls.length > 0,
  }
}
