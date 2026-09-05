import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  eventMarketFulfillmentRevocationSchema,
  eventMarketHandoffAckSchema,
  eventMarketClaimRefSchema,
  eventMarketReadyReceiptSchema,
  orderSchema,
  resolveOrderPickupHandoffAuthority,
  type EventMarketFulfillmentRevocationSchema,
  type EventMarketHandoffAckSchema,
  type EventMarketReadyReceiptSchema,
  type OrderPickupFulfillmentSchema,
  type OrderSchema,
} from "../schemas"
import { getEventMarketPrivateMessageList } from "./commerce"
import { EVENT_KINDS } from "./kinds"
import type { EventMarketResolution } from "./event-market"
import {
  isVerifiedEventMarketReceiptMerchandiseResolution,
  type EventMarketReceiptMerchandiseResolution,
} from "./event-market-merchandise"
import {
  publishPrivateMessage,
  unwrapGiftWrap,
  type PrivateMessageSelfDeliveryStatus,
  type GiftUnwrapFn,
  type PreparedPrivateMessageWraps,
  type PublishPrivateMessageInput,
  type PublishPrivateMessageResult,
} from "./messaging"
import { getNdk } from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import type {
  ParsedEventMarketPrivateMessage,
  ParsedOrderMessage,
} from "./orders"
import {
  resolveInboxDeclaration,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  type PublishWithPlannerResult,
} from "./relay-publish"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/i

/** Content-free local join key; never emit or log the underlying order id. */
export function getEventMarketOrderCorrelationRef(orderId: string): string {
  if (!orderId) throw new Error("Order correlation requires an order id.")
  return bytesToHex(
    sha256(new TextEncoder().encode(`event-market-order-v1\0${orderId}`))
  )
}

export interface EventMarketPickupClaimInput {
  orderId: string
  merchantPubkey: string
  organizerPubkey: string
  collectionCoordinate: string
}

/** Buyer/merchant-shared opaque claim; no buyer identity enters the receipt. */
export function getEventMarketPickupClaimRef(
  input: EventMarketPickupClaimInput
): string {
  const merchant = input.merchantPubkey.trim().toLowerCase()
  const organizer = input.organizerPubkey.trim().toLowerCase()
  const collection = eventMarketCoordinateIdentity(
    input.collectionCoordinate.trim()
  )
  if (
    !input.orderId ||
    !HEX_64.test(merchant) ||
    !HEX_64.test(organizer) ||
    merchant === organizer ||
    !collection ||
    !collection.startsWith(`30405:${organizer}:`)
  ) {
    throw new Error("Event-market pickup claim input is invalid.")
  }
  return eventMarketClaimRefSchema.parse(
    bytesToHex(
      sha256(
        new TextEncoder().encode(
          `event-market-pickup-claim-v1\0${input.orderId}\0${merchant}\0${organizer}\0${collection}`
        )
      )
    )
  )
}

/** Human-verifiable projection; the full claim remains the authority. */
export function formatEventMarketPickupClaimCode(claimRef: string): string {
  if (!eventMarketClaimRefSchema.safeParse(claimRef).success) {
    throw new Error("Event-market pickup claim is invalid.")
  }
  const short = claimRef.slice(0, 12).toUpperCase()
  return `${short.slice(0, 4)}-${short.slice(4, 8)}-${short.slice(8, 12)}`
}

export type EventMarketOrganizerInboxResolution =
  | {
      state: "ready"
      organizerPubkey: string
      relayUrls: string[]
    }
  | {
      state: "blocked"
      organizerPubkey: string
      reason:
        | "invalid_organizer"
        | "not_declared"
        | "distribution_pending"
        | "signed_empty"
        | "malformed"
        | "lookup_partial"
        | "lookup_unavailable"
        | "stale"
    }

/** Action-time, content-free organizer kind-10050 readiness gate. */
export async function resolveEventMarketOrganizerInbox(
  organizerPubkey: string,
  options: ResolveInboxDeclarationOptions = {}
): Promise<EventMarketOrganizerInboxResolution> {
  const normalized = organizerPubkey.trim().toLowerCase()
  if (!HEX_64.test(normalized)) {
    return {
      state: "blocked",
      organizerPubkey: normalized,
      reason: "invalid_organizer",
    }
  }
  const declaration = await resolveInboxDeclaration(normalized, options)
  if (declaration.state !== "declared") {
    return {
      state: "blocked",
      organizerPubkey: normalized,
      reason:
        declaration.state === "not_observed"
          ? "not_declared"
          : declaration.state,
    }
  }
  // A failed discovery relay cannot revoke a known signed kind-10050 inbox.
  // The shared resolver preserves newer withdrawals/malformed declarations;
  // its stale flag describes lookup freshness/coverage, not delivery authority.
  const relayUrls = normalizeSecureOrIsolatedE2eRelayUrls(declaration.relayUrls)
  return relayUrls.length > 0
    ? { state: "ready", organizerPubkey: normalized, relayUrls }
    : {
        state: "blocked",
        organizerPubkey: normalized,
        reason: "malformed",
      }
}

type EventMarketPrivatePayload =
  | EventMarketReadyReceiptSchema
  | EventMarketFulfillmentRevocationSchema
  | EventMarketHandoffAckSchema

type EventMarketPrivateMessageType = EventMarketPrivatePayload["type"]

function expectedSender(payload: EventMarketPrivatePayload): string {
  return payload.type === "organizer_handoff_ack"
    ? payload.organizerPubkey
    : payload.merchantPubkey
}

function expectedRecipient(payload: EventMarketPrivatePayload): string {
  return payload.type === "organizer_handoff_ack"
    ? payload.merchantPubkey
    : payload.organizerPubkey
}

function payloadTimestamp(payload: EventMarketPrivatePayload): number {
  return payload.type === "organizer_handoff_ack"
    ? payload.handedOutAt
    : payload.issuedAt
}

function buildEventMarketPrivateRumor(
  payload: EventMarketPrivatePayload,
  appId: ConduitAppId
): NDKEvent {
  const rumor = new NDKEvent()
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = expectedSender(payload).toLowerCase()
  rumor.created_at = payloadTimestamp(payload)
  const tags: string[][] = [
    ["p", expectedRecipient(payload).toLowerCase()],
    ["type", payload.type],
    ["claim", payload.claimRef],
  ]
  if (payload.type !== "organizer_fulfillment_receipt") {
    tags.push(["e", payload.readyReceiptId])
  }
  rumor.tags = appendConduitClientTag(tags, appId)
  rumor.content = JSON.stringify(payload)
  rumor.id = rumor.getEventHash()
  return rumor
}

export function buildEventMarketReadyReceiptRumor(
  input: EventMarketReadyReceiptSchema
): NDKEvent {
  return buildEventMarketPrivateRumor(
    eventMarketReadyReceiptSchema.parse(input),
    "merchant"
  )
}

export function buildEventMarketFulfillmentRevocationRumor(
  input: EventMarketFulfillmentRevocationSchema
): NDKEvent {
  return buildEventMarketPrivateRumor(
    eventMarketFulfillmentRevocationSchema.parse(input),
    "merchant"
  )
}

export function buildEventMarketHandoffAckRumor(
  input: EventMarketHandoffAckSchema
): NDKEvent {
  return buildEventMarketPrivateRumor(
    eventMarketHandoffAckSchema.parse(input),
    "merchant"
  )
}

function singleTag(event: Pick<NDKEvent, "tags">, name: string): string | null {
  const values = (event.tags ?? [])
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
  return values.length === 1 ? values[0]! : null
}

function parseEventMarketPrivateRumor<T extends EventMarketPrivatePayload>(
  event: Pick<
    NDKEvent,
    "kind" | "id" | "pubkey" | "created_at" | "tags" | "content"
  >,
  type: EventMarketPrivateMessageType,
  parse: (value: unknown) => T
): T {
  if (event.kind !== EVENT_KINDS.ORDER) {
    throw new Error("Event-market handoff rumor must use kind 16.")
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(event.content)
  } catch {
    throw new Error("Event-market handoff rumor content is malformed.")
  }
  const payload = parse(parsedJson)
  const sender = event.pubkey.trim().toLowerCase()
  const recipient = singleTag(event, "p")?.trim().toLowerCase()
  if (
    singleTag(event, "type") !== type ||
    singleTag(event, "claim") !== payload.claimRef ||
    sender !== expectedSender(payload).toLowerCase() ||
    recipient !== expectedRecipient(payload).toLowerCase() ||
    event.created_at !== payloadTimestamp(payload)
  ) {
    throw new Error("Event-market handoff rumor authority is invalid.")
  }
  const readyReceiptId =
    payload.type === "organizer_fulfillment_receipt"
      ? null
      : payload.readyReceiptId.toLowerCase()
  if (
    readyReceiptId &&
    singleTag(event, "e")?.toLowerCase() !== readyReceiptId
  ) {
    throw new Error("Event-market handoff rumor receipt scope is invalid.")
  }
  if (event.id) {
    const rumor = new NDKEvent(undefined, {
      kind: event.kind,
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
      sig: "",
    })
    if (rumor.getEventHash().toLowerCase() !== event.id.toLowerCase()) {
      throw new Error("Event-market handoff rumor id is invalid.")
    }
  }
  return payload
}

export function parseEventMarketReadyReceiptRumor(
  event: Pick<
    NDKEvent,
    "kind" | "id" | "pubkey" | "created_at" | "tags" | "content"
  >
): EventMarketReadyReceiptSchema {
  return parseEventMarketPrivateRumor(
    event,
    "organizer_fulfillment_receipt",
    (value) => eventMarketReadyReceiptSchema.parse(value)
  )
}

export function parseEventMarketFulfillmentRevocationRumor(
  event: Pick<
    NDKEvent,
    "kind" | "id" | "pubkey" | "created_at" | "tags" | "content"
  >
): EventMarketFulfillmentRevocationSchema {
  return parseEventMarketPrivateRumor(
    event,
    "organizer_fulfillment_revocation",
    (value) => eventMarketFulfillmentRevocationSchema.parse(value)
  )
}

export function parseEventMarketHandoffAckRumor(
  event: Pick<
    NDKEvent,
    "kind" | "id" | "pubkey" | "created_at" | "tags" | "content"
  >
): EventMarketHandoffAckSchema {
  return parseEventMarketPrivateRumor(event, "organizer_handoff_ack", (value) =>
    eventMarketHandoffAckSchema.parse(value)
  )
}

function sameEvidenceRevision(
  left: { coordinate: string; eventId: string; createdAt: number },
  right: { coordinate: string; eventId: string; createdAt: number }
): boolean {
  return (
    eventMarketCoordinateIdentity(left.coordinate) ===
      eventMarketCoordinateIdentity(right.coordinate) &&
    left.eventId.toLowerCase() === right.eventId.toLowerCase() &&
    left.createdAt === right.createdAt
  )
}

function eventMarketCoordinateIdentity(value: string): string | null {
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first < 1 || second <= first + 1) return null
  const kind = Number(value.slice(0, first))
  const author = value.slice(first + 1, second)
  const dTag = value.slice(second + 1)
  if (!Number.isSafeInteger(kind) || !HEX_64.test(author) || !dTag) return null
  return `${kind}:${author.toLowerCase()}:${dTag}`
}

function sameEventMarketCoordinate(left: string, right: string): boolean {
  const leftIdentity = eventMarketCoordinateIdentity(left)
  return (
    leftIdentity !== null &&
    leftIdentity === eventMarketCoordinateIdentity(right)
  )
}

function pickupGraphMatches(
  payload: Pick<
    EventMarketPrivatePayload,
    "merchantPubkey" | "organizerPubkey" | "calendar" | "collection" | "option"
  >,
  fulfillment: OrderPickupFulfillmentSchema
): boolean {
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  return (
    !authority.legacySafeDefault &&
    authority.mode === "organizer_handoff" &&
    payload.merchantPubkey.toLowerCase() ===
      fulfillment.product.merchantPubkey.toLowerCase() &&
    payload.organizerPubkey.toLowerCase() ===
      fulfillment.organizerPubkey.toLowerCase() &&
    authority.handlerPubkey === payload.organizerPubkey.toLowerCase() &&
    sameEvidenceRevision(payload.calendar, fulfillment.calendar) &&
    sameEvidenceRevision(payload.collection, fulfillment.collection) &&
    sameEvidenceRevision(payload.option, fulfillment.option)
  )
}

export interface ValidateEventMarketReadyReceiptInput {
  payload: EventMarketReadyReceiptSchema
  order: OrderSchema
  /** Fresh current public graph; stale/deleted/conflicting evidence is denied. */
  market: EventMarketResolution
  fulfillmentState: "paid" | "zero_cost"
}

/** Bind the minimal organizer receipt to one authenticated merchant order. */
export function validateEventMarketReadyReceipt(
  input: ValidateEventMarketReadyReceiptInput
): EventMarketReadyReceiptSchema {
  const payload = eventMarketReadyReceiptSchema.parse(input.payload)
  const order = orderSchema.parse(input.order)
  const market = input.market
  if (
    market.state !== "active" &&
    market.state !== "partial" &&
    market.state !== "ended"
  ) {
    throw new Error("Current organizer handoff evidence is not usable.")
  }
  if (
    market.organizerPubkey?.toLowerCase() !==
      payload.organizerPubkey.toLowerCase() ||
    !market.calendar ||
    !market.collection ||
    !sameEvidenceRevision(payload.calendar, market.calendar) ||
    !sameEvidenceRevision(payload.collection, market.collection)
  ) {
    throw new Error("Ready receipt event graph is not current.")
  }
  const currentCollection = market.collection
  const currentPickup = market.pickups.find((pickup) =>
    sameEvidenceRevision(payload.option, pickup)
  )
  if (
    !currentPickup ||
    currentPickup.authorPubkey.toLowerCase() !==
      payload.organizerPubkey.toLowerCase() ||
    !currentCollection.pickupCoordinates.some((coordinate) =>
      sameEventMarketCoordinate(coordinate, payload.option.coordinate)
    )
  ) {
    throw new Error("Ready receipt organizer pickup is not current.")
  }
  if (
    order.merchantPubkey.toLowerCase() !== payload.merchantPubkey.toLowerCase()
  ) {
    throw new Error("Ready receipt merchant does not match the order.")
  }
  const expectedClaimRef = getEventMarketPickupClaimRef({
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: payload.organizerPubkey,
    collectionCoordinate: payload.collection.coordinate,
  })
  if (payload.claimRef !== expectedClaimRef) {
    throw new Error("Ready receipt pickup claim does not match the order.")
  }
  if (
    input.fulfillmentState === "zero_cost" &&
    (order.items.some(
      (item) =>
        item.fulfillment?.type !== "pickup" ||
        item.priceAtPurchase !== 0 ||
        (item.shippingCostSats ?? 0) !== 0
    ) ||
      order.subtotal !== 0 ||
      (order.shippingCostSats ?? 0) !== 0)
  ) {
    throw new Error(
      "Only an all-pickup zero-cost order may use zero-cost authorization."
    )
  }
  const pickupItems = order.items.filter(
    (item) => item.fulfillment?.type === "pickup"
  )
  if (
    pickupItems.length === 0 ||
    order.items.some(
      (item) => item.fulfillment?.type !== "pickup" && item.format !== "digital"
    )
  ) {
    throw new Error(
      "Ready receipt may include pickup lines alongside digital lines only."
    )
  }
  const orderItems = new Map<string, (typeof pickupItems)[number]>()
  for (const item of pickupItems) {
    const key = eventMarketCoordinateIdentity(item.productId)
    if (!key) throw new Error("Pickup product coordinate is invalid.")
    if (orderItems.has(key)) {
      throw new Error(
        "Duplicate pickup product lines cannot be represented safely."
      )
    }
    orderItems.set(key, item)
  }
  if (orderItems.size !== payload.items.length) {
    throw new Error("Ready receipt items do not exactly match the order.")
  }
  for (const receiptItem of payload.items) {
    const orderItem = orderItems.get(
      eventMarketCoordinateIdentity(receiptItem.product.coordinate) ?? ""
    )
    const fulfillment = orderItem?.fulfillment
    if (
      !orderItem ||
      fulfillment?.type !== "pickup" ||
      orderItem.quantity !== receiptItem.quantity ||
      !sameEvidenceRevision(receiptItem.product, fulfillment.product) ||
      !pickupGraphMatches(payload, fulfillment)
    ) {
      throw new Error(
        "Ready receipt does not match exact organizer handoff evidence."
      )
    }
    const currentProduct = market.acceptedProductEvidence.find(
      (evidence) =>
        sameEventMarketCoordinate(
          evidence.productCoordinate,
          receiptItem.product.coordinate
        ) &&
        evidence.eventId.toLowerCase() ===
          receiptItem.product.eventId.toLowerCase() &&
        evidence.createdAt === receiptItem.product.createdAt
    )
    const selectedOrganizerPickup = Boolean(
      currentProduct &&
      (currentProduct.shippingOptionCoordinates.some((coordinate) =>
        sameEventMarketCoordinate(coordinate, payload.option.coordinate)
      ) ||
        (currentCollection.pickupCoordinates.length === 1 &&
          currentProduct.shippingOptionCoordinates.some((coordinate) =>
            sameEventMarketCoordinate(coordinate, currentCollection.coordinate)
          )))
    )
    if (!selectedOrganizerPickup) {
      throw new Error(
        "Current merchant product does not select the organizer pickup."
      )
    }
  }
  return payload
}

export interface BuildEventMarketReadyReceiptPayloadInput extends Omit<
  ValidateEventMarketReadyReceiptInput,
  "payload"
> {
  issuedAt?: number
}

/** Build the minimal organizer payload without exposing the private order. */
export function buildEventMarketReadyReceiptPayload(
  input: BuildEventMarketReadyReceiptPayloadInput
): EventMarketReadyReceiptSchema {
  const order = orderSchema.parse(input.order)
  const pickupItems = order.items.filter(
    (item) => item.fulfillment?.type === "pickup"
  )
  const firstFulfillment = pickupItems[0]?.fulfillment
  if (firstFulfillment?.type !== "pickup") {
    throw new Error("Organizer ready receipt requires pickup fulfillment.")
  }
  const payload = eventMarketReadyReceiptSchema.parse({
    version: 1,
    type: "organizer_fulfillment_receipt",
    state: "ready_for_pickup",
    paymentConfirmed: true,
    orderReady: true,
    releaseAuthorized: true,
    claimRef: getEventMarketPickupClaimRef({
      orderId: order.id,
      merchantPubkey: order.merchantPubkey,
      organizerPubkey: firstFulfillment.organizerPubkey,
      collectionCoordinate: firstFulfillment.collection.coordinate,
    }),
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: firstFulfillment.organizerPubkey,
    calendar: firstFulfillment.calendar,
    collection: firstFulfillment.collection,
    option: firstFulfillment.option,
    items: pickupItems.map((item) => {
      const fulfillment = item.fulfillment
      if (fulfillment?.type !== "pickup") {
        throw new Error("Organizer ready receipt pickup evidence is invalid.")
      }
      return {
        product: {
          coordinate: fulfillment.product.coordinate,
          eventId: fulfillment.product.eventId,
          createdAt: fulfillment.product.createdAt,
        },
        quantity: item.quantity,
        variants: [],
      }
    }),
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1_000),
  })
  return validateEventMarketReadyReceipt({
    payload,
    order,
    market: input.market,
    fulfillmentState: input.fulfillmentState,
  })
}

export interface EventMarketFulfillmentRevocationAuthorization {
  readonly receiptId: string
  readonly claimRef: string
}

interface EventMarketFulfillmentRevocationScope {
  receiptId: string
  receipt: EventMarketReadyReceiptSchema
  orderCorrelationRef?: string
}

const fulfillmentRevocationAuthorizations = new WeakMap<
  EventMarketFulfillmentRevocationAuthorization,
  EventMarketFulfillmentRevocationScope
>()

export type BuildEventMarketFulfillmentRevocationPayloadInput =
  | {
      readyReceiptId: string
      readyReceipt: EventMarketReadyReceiptSchema
      issuedAt?: number
    }
  | {
      authorization: EventMarketFulfillmentRevocationAuthorization
      issuedAt?: number
    }

/** Revoke from a receipt or its content-free exact-wrap delivery descriptor. */
export function buildEventMarketFulfillmentRevocationPayload(
  input: BuildEventMarketFulfillmentRevocationPayloadInput
): EventMarketFulfillmentRevocationSchema {
  const source =
    "authorization" in input
      ? (() => {
          const scope = fulfillmentRevocationAuthorizations.get(
            input.authorization
          )
          if (!scope) {
            throw new Error("Fulfillment revocation authorization is invalid.")
          }
          const receipt = scope.receipt
          return {
            claimRef: receipt.claimRef,
            merchantPubkey: receipt.merchantPubkey,
            organizerPubkey: receipt.organizerPubkey,
            calendar: receipt.calendar,
            collection: receipt.collection,
            option: receipt.option,
            readyReceiptId: scope.receiptId,
          }
        })()
      : (() => {
          const receipt = eventMarketReadyReceiptSchema.parse(
            input.readyReceipt
          )
          return {
            claimRef: receipt.claimRef,
            merchantPubkey: receipt.merchantPubkey,
            organizerPubkey: receipt.organizerPubkey,
            calendar: receipt.calendar,
            collection: receipt.collection,
            option: receipt.option,
            readyReceiptId: input.readyReceiptId,
          }
        })()
  return eventMarketFulfillmentRevocationSchema.parse({
    version: 1,
    type: "organizer_fulfillment_revocation",
    state: "revoked",
    ...source,
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1_000),
  })
}

export interface EventMarketPrivateGraphDescriptor {
  calendar: EventMarketReadyReceiptSchema["calendar"]
  collection: EventMarketReadyReceiptSchema["collection"]
  option: EventMarketReadyReceiptSchema["option"]
}

export interface EventMarketPrivateDeliveryRecord {
  messageType: EventMarketPrivateMessageType
  /** Exact inner rumor id; content-free and required for revocation scope. */
  rumorId: string
  /** Ready rumor id targeted by this stream record. */
  readyReceiptId: string
  claimRef: string
  senderPubkey: string
  recipientPubkey: string
  /** Public signed-event identities only; never order or buyer content. */
  graph: EventMarketPrivateGraphDescriptor
  /** Merchant-local hash used to join a ready/revocation outbox to its order. */
  orderCorrelationRef?: string
  signedRecipientWrap: SignedPublicNostrEvent
  signedSelfWrap: SignedPublicNostrEvent
  createdAt: number
}

export type PersistEventMarketPrivateWraps = (
  record: EventMarketPrivateDeliveryRecord,
  initialDeliveryProgress: EventMarketPrivateDeliveryProgress
) => void | Promise<void>

export interface EventMarketPrivateDeliveryProgress {
  version: 1
  /** Exact wrap binding prevents progress reuse across delivery jobs. */
  recipientWrapId: string
  selfWrapId: string
  /** URL-free stable refs for relays that acknowledged the recipient wrap. */
  recipientAcknowledgedRelayRefs: string[]
  /** URL-free stable refs for relays that acknowledged the sender self-wrap. */
  selfAcknowledgedRelayRefs: string[]
}

export interface EventMarketPrivatePublishResult extends PublishPrivateMessageResult {
  deliveryProgress: EventMarketPrivateDeliveryProgress
}

export type EventMarketPrivateTransportOptions = Pick<
  PublishPrivateMessageInput,
  | "recipientInboxRelays"
  | "senderInboxRelays"
  | "resolveInboxRelays"
  | "giftWrapFn"
  | "publishFn"
  | "waitForSignerVisibility"
  | "refreshRelayLists"
>

function hasExactOuterRecipient(
  event: SignedPublicNostrEvent,
  recipientPubkey: string
): boolean {
  const recipients = event.tags.filter(
    (tag) => tag[0] === "p" && typeof tag[1] === "string"
  )
  return (
    recipients.length === 1 &&
    recipients[0]![1]!.toLowerCase() === recipientPubkey.toLowerCase()
  )
}

/** Parse a persisted ciphertext-only descriptor at the local-storage boundary. */
export function parseEventMarketPrivateDeliveryRecord(
  value: unknown
): EventMarketPrivateDeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted event-market delivery record is invalid.")
  }
  const record = value as EventMarketPrivateDeliveryRecord
  if (
    ![
      "organizer_fulfillment_receipt",
      "organizer_fulfillment_revocation",
      "organizer_handoff_ack",
    ].includes(record.messageType) ||
    typeof record.claimRef !== "string" ||
    !eventMarketClaimRefSchema.safeParse(record.claimRef).success ||
    !record.graph ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    throw new Error("Persisted event-market delivery record is invalid.")
  }
  if (
    !HEX_64.test(record.rumorId) ||
    !HEX_64.test(record.readyReceiptId) ||
    !HEX_64.test(record.senderPubkey) ||
    !HEX_64.test(record.recipientPubkey) ||
    !isValidSignedPublicNostrEvent(record.signedRecipientWrap) ||
    record.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    !hasExactOuterRecipient(record.signedRecipientWrap, record.recipientPubkey)
  ) {
    throw new Error("Persisted recipient wrap is invalid.")
  }
  if (
    record.messageType === "organizer_fulfillment_receipt" &&
    record.readyReceiptId.toLowerCase() !== record.rumorId.toLowerCase()
  ) {
    throw new Error("Persisted ready receipt scope is invalid.")
  }
  if (
    record.orderCorrelationRef !== undefined &&
    !HEX_64.test(record.orderCorrelationRef)
  ) {
    throw new Error("Persisted order correlation is invalid.")
  }
  if (
    record.signedSelfWrap &&
    (!isValidSignedPublicNostrEvent(record.signedSelfWrap) ||
      record.signedSelfWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
      !hasExactOuterRecipient(record.signedSelfWrap, record.senderPubkey))
  ) {
    throw new Error("Persisted sender self-wrap is invalid.")
  }
  if (!record.signedSelfWrap) {
    throw new Error("Persisted sender self-wrap is required.")
  }
  const merchantPubkey =
    record.messageType === "organizer_handoff_ack"
      ? record.recipientPubkey
      : record.senderPubkey
  const organizerPubkey =
    record.messageType === "organizer_handoff_ack"
      ? record.senderPubkey
      : record.recipientPubkey
  eventMarketFulfillmentRevocationSchema.parse({
    version: 1,
    type: "organizer_fulfillment_revocation",
    state: "revoked",
    claimRef: record.claimRef,
    merchantPubkey,
    organizerPubkey,
    calendar: record.graph.calendar,
    collection: record.graph.collection,
    option: record.graph.option,
    readyReceiptId: record.readyReceiptId,
    issuedAt: 0,
  })
  return record
}

function assertValidEventMarketPrivateDeliveryRecord(
  record: EventMarketPrivateDeliveryRecord
): void {
  parseEventMarketPrivateDeliveryRecord(record)
}

const EVENT_MARKET_PRIVATE_RELAY_PROGRESS_LIMIT = 64
const CANONICAL_HEX_64 = /^[0-9a-f]{64}$/

function eventMarketPrivateRelayTargetRef(relayUrl: string): string {
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls([relayUrl])[0]
  if (!normalized) {
    throw new Error("Event-market private relay target is invalid.")
  }
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        `event-market-private-relay-target-v1\0${normalized}`
      )
    )
  )
}

function normalizedRelayTargetRefs(relayUrls: readonly string[]): string[] {
  return Array.from(
    new Set(
      normalizeSecureOrIsolatedE2eRelayUrls(relayUrls).map((relayUrl) =>
        eventMarketPrivateRelayTargetRef(relayUrl)
      )
    )
  ).sort()
}

function parseRelayTargetRefs(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > EVENT_MARKET_PRIVATE_RELAY_PROGRESS_LIMIT ||
    value.some(
      (entry) => typeof entry !== "string" || !CANONICAL_HEX_64.test(entry)
    )
  ) {
    return null
  }
  const normalized = Array.from(new Set(value)).sort()
  return normalized.length === value.length ? normalized : null
}

/** Create the URL-free empty checkpoint that must persist with exact wraps. */
export function createEventMarketPrivateDeliveryProgress(
  record: EventMarketPrivateDeliveryRecord
): EventMarketPrivateDeliveryProgress {
  assertValidEventMarketPrivateDeliveryRecord(record)
  return {
    version: 1,
    recipientWrapId: record.signedRecipientWrap.id.toLowerCase(),
    selfWrapId: record.signedSelfWrap.id.toLowerCase(),
    recipientAcknowledgedRelayRefs: [],
    selfAcknowledgedRelayRefs: [],
  }
}

/** Parse URL-free relay ACK progress and optionally bind it to exact wraps. */
export function parseEventMarketPrivateDeliveryProgress(
  value: unknown,
  record?: EventMarketPrivateDeliveryRecord
): EventMarketPrivateDeliveryProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted event-market delivery progress is invalid.")
  }
  const candidate = value as EventMarketPrivateDeliveryProgress
  const recipientRefs = parseRelayTargetRefs(
    candidate.recipientAcknowledgedRelayRefs
  )
  const selfRefs = parseRelayTargetRefs(candidate.selfAcknowledgedRelayRefs)
  if (
    candidate.version !== 1 ||
    !CANONICAL_HEX_64.test(candidate.recipientWrapId) ||
    !CANONICAL_HEX_64.test(candidate.selfWrapId) ||
    !recipientRefs ||
    !selfRefs
  ) {
    throw new Error("Persisted event-market delivery progress is invalid.")
  }
  if (record) {
    assertValidEventMarketPrivateDeliveryRecord(record)
    if (
      candidate.recipientWrapId !==
        record.signedRecipientWrap.id.toLowerCase() ||
      candidate.selfWrapId !== record.signedSelfWrap.id.toLowerCase()
    ) {
      throw new Error("Persisted event-market delivery progress is misbound.")
    }
  }
  return {
    version: 1,
    recipientWrapId: candidate.recipientWrapId,
    selfWrapId: candidate.selfWrapId,
    recipientAcknowledgedRelayRefs: recipientRefs,
    selfAcknowledgedRelayRefs: selfRefs,
  }
}

/** Recover and authorize revocation from the signed sender self-copy only. */
export async function authorizeEventMarketFulfillmentRevocation(input: {
  deliveryRecord: EventMarketPrivateDeliveryRecord
  signer: NDKSigner
  giftUnwrap?: GiftUnwrapFn
}): Promise<EventMarketFulfillmentRevocationAuthorization> {
  const record = input.deliveryRecord
  assertValidEventMarketPrivateDeliveryRecord(record)
  if (
    record.messageType !== "organizer_fulfillment_receipt" ||
    !record.signedSelfWrap
  ) {
    throw new Error("Recoverable ready receipt self-copy is required.")
  }
  const signerPubkey = (await input.signer.user()).pubkey.toLowerCase()
  if (signerPubkey !== record.senderPubkey.toLowerCase()) {
    throw new Error("Ready receipt recovery signer does not match sender.")
  }
  const outcome = await unwrapGiftWrap(
    new NDKEvent(getNdk(), record.signedSelfWrap),
    input.signer,
    input.giftUnwrap ? { giftUnwrap: input.giftUnwrap } : {}
  )
  if (outcome.status !== "ok" || outcome.category !== "order") {
    throw new Error("Ready receipt self-copy could not be recovered.")
  }
  const receipt = parseEventMarketReadyReceiptRumor(outcome.rumor)
  if (
    outcome.rumor.id.toLowerCase() !== record.rumorId.toLowerCase() ||
    receipt.claimRef !== record.claimRef ||
    receipt.merchantPubkey.toLowerCase() !==
      record.senderPubkey.toLowerCase() ||
    receipt.organizerPubkey.toLowerCase() !==
      record.recipientPubkey.toLowerCase() ||
    !sameEvidenceRevision(receipt.calendar, record.graph.calendar) ||
    !sameEvidenceRevision(receipt.collection, record.graph.collection) ||
    !sameEvidenceRevision(receipt.option, record.graph.option)
  ) {
    throw new Error("Recovered ready receipt does not match its descriptor.")
  }
  const authorization = Object.freeze({
    receiptId: outcome.rumor.id,
    claimRef: receipt.claimRef,
  })
  fulfillmentRevocationAuthorizations.set(authorization, {
    receiptId: outcome.rumor.id,
    receipt,
    ...(record.orderCorrelationRef
      ? { orderCorrelationRef: record.orderCorrelationRef }
      : {}),
  })
  return authorization
}

function consumeEventMarketFulfillmentRevocationAuthorization(
  authorization: EventMarketFulfillmentRevocationAuthorization
): EventMarketFulfillmentRevocationScope {
  const scope = fulfillmentRevocationAuthorizations.get(authorization)
  if (!scope)
    throw new Error("Fulfillment revocation authorization is invalid.")
  fulfillmentRevocationAuthorizations.delete(authorization)
  return scope
}

function signedWrap(event: NDKEvent): SignedPublicNostrEvent {
  const signed = event.rawEvent() as SignedPublicNostrEvent
  if (
    signed.kind !== EVENT_KINDS.GIFT_WRAP ||
    !isValidSignedPublicNostrEvent(signed)
  ) {
    throw new Error("Event-market private delivery wrap is invalid.")
  }
  return signed
}

function persistPreparedWraps(
  payload: EventMarketPrivatePayload,
  persist: PersistEventMarketPrivateWraps,
  orderCorrelationRef?: string
): (prepared: PreparedPrivateMessageWraps) => Promise<void> {
  return async (prepared) => {
    const signedRecipientWrap = signedWrap(prepared.wrappedToRecipient)
    const signedSelfWrap = prepared.wrappedToSelf
      ? signedWrap(prepared.wrappedToSelf)
      : undefined
    if (!signedSelfWrap) {
      throw new Error(
        "Event-market private delivery requires a signed sender self-copy before delivery."
      )
    }
    const record: EventMarketPrivateDeliveryRecord = {
      messageType: payload.type,
      rumorId: prepared.rumorId,
      readyReceiptId:
        payload.type === "organizer_fulfillment_receipt"
          ? prepared.rumorId
          : payload.readyReceiptId,
      claimRef: payload.claimRef,
      senderPubkey: expectedSender(payload).toLowerCase(),
      recipientPubkey: expectedRecipient(payload).toLowerCase(),
      graph: {
        calendar: payload.calendar,
        collection: payload.collection,
        option: payload.option,
      },
      ...(orderCorrelationRef ? { orderCorrelationRef } : {}),
      signedRecipientWrap,
      signedSelfWrap,
      createdAt: Date.now(),
    }
    await persist(record, createEventMarketPrivateDeliveryProgress(record))
  }
}

async function publishEventMarketPrivatePayload(input: {
  payload: EventMarketPrivatePayload
  rumor: NDKEvent
  signer: NDKSigner
  persistExactWraps: PersistEventMarketPrivateWraps
  orderCorrelationRef?: string
  transport?: EventMarketPrivateTransportOptions
}): Promise<EventMarketPrivatePublishResult> {
  const result = await publishPrivateMessage({
    rumor: input.rumor,
    senderPubkey: expectedSender(input.payload),
    recipientPubkey: expectedRecipient(input.payload),
    signer: input.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: true,
    ...input.transport,
    signerInteraction: "external",
    // Organizer handoff traffic never enters the CND-208 compatibility lane.
    onWrapped: persistPreparedWraps(
      input.payload,
      input.persistExactWraps,
      input.orderCorrelationRef
    ),
  })
  if (!result.wrappedToSelf) {
    throw new Error("Event-market private delivery self-wrap is missing.")
  }
  const record = {
    messageType: input.payload.type,
    rumorId: input.rumor.id,
    readyReceiptId:
      input.payload.type === "organizer_fulfillment_receipt"
        ? input.rumor.id
        : input.payload.readyReceiptId,
    claimRef: input.payload.claimRef,
    senderPubkey: expectedSender(input.payload).toLowerCase(),
    recipientPubkey: expectedRecipient(input.payload).toLowerCase(),
    graph: {
      calendar: input.payload.calendar,
      collection: input.payload.collection,
      option: input.payload.option,
    },
    signedRecipientWrap: signedWrap(result.wrappedToRecipient),
    signedSelfWrap: signedWrap(result.wrappedToSelf),
    createdAt: Date.now(),
  } satisfies EventMarketPrivateDeliveryRecord
  const deliveryProgress = createEventMarketPrivateDeliveryProgress(record)
  deliveryProgress.recipientAcknowledgedRelayRefs = mergeAcknowledgedRelayRefs({
    existing: [],
    attemptedRelayUrls: result.recipientDelivery.attemptedRelayUrls ?? [],
    successfulRelayUrls: result.recipientDelivery.successfulRelayUrls ?? [],
  })
  deliveryProgress.selfAcknowledgedRelayRefs = result.selfDelivery
    ? mergeAcknowledgedRelayRefs({
        existing: [],
        attemptedRelayUrls: result.selfDelivery.attemptedRelayUrls ?? [],
        successfulRelayUrls: result.selfDelivery.successfulRelayUrls ?? [],
      })
    : []
  return { ...result, deliveryProgress }
}

export interface PublishEventMarketReadyReceiptInput extends ValidateEventMarketReadyReceiptInput {
  signer: NDKSigner
  persistExactWraps: PersistEventMarketPrivateWraps
  transport?: EventMarketPrivateTransportOptions
}

export async function publishEventMarketReadyReceipt(
  input: PublishEventMarketReadyReceiptInput
): Promise<EventMarketPrivatePublishResult> {
  const payload = validateEventMarketReadyReceipt(input)
  return publishEventMarketPrivatePayload({
    payload,
    rumor: buildEventMarketReadyReceiptRumor(payload),
    signer: input.signer,
    persistExactWraps: input.persistExactWraps,
    orderCorrelationRef: getEventMarketOrderCorrelationRef(
      orderSchema.parse(input.order).id
    ),
    transport: input.transport,
  })
}

function assertScopedToReadyReceipt(
  payload: EventMarketFulfillmentRevocationSchema | EventMarketHandoffAckSchema,
  receiptId: string,
  receipt: EventMarketReadyReceiptSchema
): void {
  if (
    payload.readyReceiptId.toLowerCase() !== receiptId.toLowerCase() ||
    payload.claimRef !== receipt.claimRef ||
    payload.merchantPubkey.toLowerCase() !==
      receipt.merchantPubkey.toLowerCase() ||
    payload.organizerPubkey.toLowerCase() !==
      receipt.organizerPubkey.toLowerCase() ||
    !sameEvidenceRevision(payload.calendar, receipt.calendar) ||
    !sameEvidenceRevision(payload.collection, receipt.collection) ||
    !sameEvidenceRevision(payload.option, receipt.option)
  ) {
    throw new Error(
      "Event-market handoff update does not match its ready receipt."
    )
  }
}

export interface PublishEventMarketFulfillmentRevocationInput {
  payload: EventMarketFulfillmentRevocationSchema
  authorization: EventMarketFulfillmentRevocationAuthorization
  signer: NDKSigner
  persistExactWraps: PersistEventMarketPrivateWraps
  transport?: EventMarketPrivateTransportOptions
}

export async function publishEventMarketFulfillmentRevocation(
  input: PublishEventMarketFulfillmentRevocationInput
): Promise<EventMarketPrivatePublishResult> {
  const payload = eventMarketFulfillmentRevocationSchema.parse(input.payload)
  const scope = consumeEventMarketFulfillmentRevocationAuthorization(
    input.authorization
  )
  assertScopedToReadyReceipt(payload, scope.receiptId, scope.receipt)
  return publishEventMarketPrivatePayload({
    payload,
    rumor: buildEventMarketFulfillmentRevocationRumor(payload),
    signer: input.signer,
    persistExactWraps: input.persistExactWraps,
    orderCorrelationRef: scope.orderCorrelationRef,
    transport: input.transport,
  })
}

export interface PublishEventMarketHandoffAckInput {
  payload: EventMarketHandoffAckSchema
  authorization: EventMarketHandoffAckAuthorization
  signer: NDKSigner
  persistExactWraps: PersistEventMarketPrivateWraps
  transport?: EventMarketPrivateTransportOptions
}

export async function publishEventMarketHandoffAck(
  input: PublishEventMarketHandoffAckInput
): Promise<EventMarketPrivatePublishResult> {
  const payload = eventMarketHandoffAckSchema.parse(input.payload)
  const claim = consumeEventMarketHandoffAckAuthorization(input.authorization)
  const receipt = eventMarketReadyReceiptSchema.parse(claim.receipt.payload)
  assertScopedToReadyReceipt(payload, claim.receipt.id, receipt)
  return publishEventMarketPrivatePayload({
    payload,
    rumor: buildEventMarketHandoffAckRumor(payload),
    signer: input.signer,
    persistExactWraps: input.persistExactWraps,
    transport: input.transport,
  })
}

export interface RetryEventMarketPrivateDeliveryResult {
  recipientDelivery: PublishWithPlannerResult | null
  recipientStatus: PrivateMessageSelfDeliveryStatus
  selfDelivery: PublishWithPlannerResult | null
  selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null
  selfCopyError: string | null
  deliveryProgress: EventMarketPrivateDeliveryProgress
}

async function strictInboxRelays(
  pubkey: string,
  options?: ResolveInboxDeclarationOptions
): Promise<string[]> {
  const inbox = await resolveEventMarketOrganizerInbox(pubkey, options)
  if (inbox.state !== "ready") {
    throw new Error("Private-message recipient inbox is not currently usable.")
  }
  return inbox.relayUrls
}

function pendingRelayUrls(
  relayUrls: readonly string[],
  acknowledgedRefs: readonly string[]
): string[] {
  const acknowledged = new Set(acknowledgedRefs)
  return normalizeSecureOrIsolatedE2eRelayUrls(relayUrls).filter(
    (relayUrl) => !acknowledged.has(eventMarketPrivateRelayTargetRef(relayUrl))
  )
}

function mergeAcknowledgedRelayRefs(input: {
  existing: readonly string[]
  attemptedRelayUrls: readonly string[]
  successfulRelayUrls: readonly string[]
}): string[] {
  const attempted = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(input.attemptedRelayUrls)
  )
  const additions = normalizeSecureOrIsolatedE2eRelayUrls(
    input.successfulRelayUrls
  )
    .filter((relayUrl) => attempted.has(relayUrl))
    .map(eventMarketPrivateRelayTargetRef)
  const merged = Array.from(new Set([...input.existing, ...additions])).sort()
  if (merged.length > EVENT_MARKET_PRIVATE_RELAY_PROGRESS_LIMIT) {
    throw new Error("Event-market private delivery progress exceeds its limit.")
  }
  return merged
}

function deliveryLegStatus(
  currentRelayUrls: readonly string[],
  acknowledgedRefs: readonly string[]
): PrivateMessageSelfDeliveryStatus {
  const acknowledged = new Set(acknowledgedRefs)
  const acknowledgedCurrentCount = normalizedRelayTargetRefs(
    currentRelayUrls
  ).filter((targetRef) => acknowledged.has(targetRef)).length
  if (acknowledgedCurrentCount === 0) return "zero_success"
  return acknowledgedCurrentCount ===
    normalizeSecureOrIsolatedE2eRelayUrls(currentRelayUrls).length
    ? "full_success"
    : "partial_success"
}

function selfCopyErrorForStatus(
  status: PrivateMessageSelfDeliveryStatus
): string | null {
  if (status === "zero_success") {
    return "Sender self-copy received no relay ACK."
  }
  if (status === "partial_success") {
    return "Sender self-copy reached only part of its inbox relay set."
  }
  return null
}

function recoverEventMarketPartialPublishDiagnostics(
  error: unknown
): PublishWithPlannerResult | null {
  return error instanceof RelayPublishDiagnosticsError &&
    error.diagnostics.successfulRelayUrls.length > 0
    ? error.diagnostics
    : null
}

/** Retry persisted exact gift wraps without signing or re-encrypting. */
export async function retryEventMarketPrivateDelivery(input: {
  record: EventMarketPrivateDeliveryRecord
  deliveryProgress?: EventMarketPrivateDeliveryProgress
  recipientInboxRelays?: readonly string[]
  senderInboxRelays?: readonly string[]
  /** Shared declaration read seam for deterministic delivery tests/adapters. */
  inboxDeclarationOptions?: ResolveInboxDeclarationOptions
  publishFn?: typeof publishWithPlanner
}): Promise<RetryEventMarketPrivateDeliveryResult> {
  assertValidEventMarketPrivateDeliveryRecord(input.record)
  let deliveryProgress = input.deliveryProgress
    ? parseEventMarketPrivateDeliveryProgress(
        input.deliveryProgress,
        input.record
      )
    : createEventMarketPrivateDeliveryProgress(input.record)
  const recipientRelayUrls = input.recipientInboxRelays
    ? normalizeSecureOrIsolatedE2eRelayUrls(input.recipientInboxRelays)
    : await strictInboxRelays(
        input.record.recipientPubkey,
        input.inboxDeclarationOptions
      )
  if (recipientRelayUrls.length === 0) {
    throw new Error("Private-message recipient inbox is not currently usable.")
  }
  const publish = input.publishFn ?? publishWithPlanner
  const pendingRecipientRelayUrls = pendingRelayUrls(
    recipientRelayUrls,
    deliveryProgress.recipientAcknowledgedRelayRefs
  )
  let recipientDelivery: PublishWithPlannerResult | null = null
  if (pendingRecipientRelayUrls.length > 0) {
    try {
      recipientDelivery = await publish(
        new NDKEvent(getNdk(), input.record.signedRecipientWrap),
        {
          intent: "recipient_event",
          authorPubkey: input.record.senderPubkey,
          authenticatedPubkey: input.record.senderPubkey,
          recipientPubkeys: [input.record.recipientPubkey],
          exclusiveRelayUrls: pendingRecipientRelayUrls,
          deliveryMode: "critical",
        }
      )
    } catch (error) {
      const partial = recoverEventMarketPartialPublishDiagnostics(error)
      if (!partial) throw error
      recipientDelivery = partial
    }
  }
  if (recipientDelivery) {
    deliveryProgress = {
      ...deliveryProgress,
      recipientAcknowledgedRelayRefs: mergeAcknowledgedRelayRefs({
        existing: deliveryProgress.recipientAcknowledgedRelayRefs,
        attemptedRelayUrls: pendingRecipientRelayUrls,
        successfulRelayUrls: recipientDelivery.successfulRelayUrls,
      }),
    }
  }
  const recipientStatus = deliveryLegStatus(
    recipientRelayUrls,
    deliveryProgress.recipientAcknowledgedRelayRefs
  )
  let selfDelivery: PublishWithPlannerResult | null = null
  let selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null = null
  let selfCopyError: string | null = null
  if (input.record.signedSelfWrap) {
    try {
      const senderRelayUrls = input.senderInboxRelays
        ? normalizeSecureOrIsolatedE2eRelayUrls(input.senderInboxRelays)
        : await strictInboxRelays(
            input.record.senderPubkey,
            input.inboxDeclarationOptions
          )
      if (senderRelayUrls.length === 0) {
        throw new Error("Sender inbox is not currently usable.")
      }
      const pendingSelfRelayUrls = pendingRelayUrls(
        senderRelayUrls,
        deliveryProgress.selfAcknowledgedRelayRefs
      )
      if (pendingSelfRelayUrls.length > 0) {
        try {
          selfDelivery = await publish(
            new NDKEvent(getNdk(), input.record.signedSelfWrap),
            {
              intent: "recipient_event",
              authorPubkey: input.record.senderPubkey,
              authenticatedPubkey: input.record.senderPubkey,
              recipientPubkeys: [input.record.senderPubkey],
              exclusiveRelayUrls: pendingSelfRelayUrls,
              deliveryMode: "critical",
            }
          )
        } catch (error) {
          const partial = recoverEventMarketPartialPublishDiagnostics(error)
          if (!partial) throw error
          selfDelivery = partial
        }
        deliveryProgress = {
          ...deliveryProgress,
          selfAcknowledgedRelayRefs: mergeAcknowledgedRelayRefs({
            existing: deliveryProgress.selfAcknowledgedRelayRefs,
            attemptedRelayUrls: pendingSelfRelayUrls,
            successfulRelayUrls: selfDelivery.successfulRelayUrls,
          }),
        }
      }
      selfDeliveryStatus = deliveryLegStatus(
        senderRelayUrls,
        deliveryProgress.selfAcknowledgedRelayRefs
      )
      selfCopyError = selfCopyErrorForStatus(selfDeliveryStatus)
    } catch (error) {
      selfCopyError =
        error instanceof Error
          ? error.message
          : "Sender self-copy retry failed."
    }
  }
  return {
    recipientDelivery,
    recipientStatus,
    selfDelivery,
    selfDeliveryStatus,
    selfCopyError,
    deliveryProgress,
  }
}

function isAuthorizedPrivateMessage(
  message: ParsedEventMarketPrivateMessage
): boolean {
  const payload = message.payload
  const payloadIsValid =
    payload.type === "organizer_fulfillment_receipt"
      ? eventMarketReadyReceiptSchema.safeParse(payload).success
      : payload.type === "organizer_fulfillment_revocation"
        ? eventMarketFulfillmentRevocationSchema.safeParse(payload).success
        : payload.type === "organizer_handoff_ack"
          ? eventMarketHandoffAckSchema.safeParse(payload).success
          : false
  return (
    payloadIsValid &&
    message.senderPubkey.toLowerCase() ===
      expectedSender(payload).toLowerCase() &&
    message.recipientPubkey.toLowerCase() ===
      expectedRecipient(payload).toLowerCase()
  )
}

function samePrivateGraph(
  left: EventMarketPrivatePayload,
  right: EventMarketPrivatePayload
): boolean {
  return (
    left.claimRef === right.claimRef &&
    left.merchantPubkey.toLowerCase() === right.merchantPubkey.toLowerCase() &&
    left.organizerPubkey.toLowerCase() ===
      right.organizerPubkey.toLowerCase() &&
    sameEvidenceRevision(left.calendar, right.calendar) &&
    sameEvidenceRevision(left.collection, right.collection) &&
    sameEvidenceRevision(left.option, right.option)
  )
}

export type EventMarketOrganizerClaimState =
  "ready_for_pickup" | "revoked" | "handed_out" | "conflicting"

export interface EventMarketOrganizerClaim {
  receipt: Extract<
    ParsedOrderMessage,
    { type: "organizer_fulfillment_receipt" }
  >
  state: EventMarketOrganizerClaimState
  revocation?: Extract<
    ParsedOrderMessage,
    { type: "organizer_fulfillment_revocation" }
  >
  ack?: Extract<ParsedOrderMessage, { type: "organizer_handoff_ack" }>
}

export interface EventMarketPrivateReadResult<T> {
  data: T
  stale: boolean
  decryptFailureCount: number
  inbox: Awaited<ReturnType<typeof getEventMarketPrivateMessageList>>["inbox"]
}

export type EventMarketHandoffAckGate =
  | { state: "ready" }
  | {
      state: "blocked"
      reason:
        | "claim_not_ready"
        | "public_graph_not_current"
        | "product_not_accepted"
        | "handoff_changed"
        | "merchandise_not_verified"
    }

function revisionIsCurrentOrNewer(
  receipt: { coordinate: string; eventId: string; createdAt: number },
  current: { coordinate: string; eventId: string; createdAt: number }
): boolean {
  if (!sameEventMarketCoordinate(receipt.coordinate, current.coordinate)) {
    return false
  }
  return (
    current.createdAt > receipt.createdAt ||
    (current.createdAt === receipt.createdAt &&
      current.eventId.toLowerCase() <= receipt.eventId.toLowerCase())
  )
}

function resolveEventMarketHandoffPublicGate(input: {
  claim: EventMarketOrganizerClaim
  market: EventMarketResolution
  merchandise: EventMarketReceiptMerchandiseResolution
}): EventMarketHandoffAckGate {
  const receipt = eventMarketReadyReceiptSchema.parse(
    input.claim.receipt.payload
  )
  const market = input.market
  if (
    !["active", "partial", "ended"].includes(market.state) ||
    market.organizerPubkey?.toLowerCase() !==
      receipt.organizerPubkey.toLowerCase() ||
    !market.calendar ||
    !market.collection ||
    !revisionIsCurrentOrNewer(receipt.calendar, market.calendar) ||
    !revisionIsCurrentOrNewer(receipt.collection, market.collection)
  ) {
    return { state: "blocked", reason: "public_graph_not_current" }
  }
  const pickup = market.pickups.find((candidate) =>
    sameEventMarketCoordinate(candidate.coordinate, receipt.option.coordinate)
  )
  // The receipt cannot prove that a newer public pickup place or price is
  // semantically equivalent, so ACK authority stays on the buyer's exact
  // signed pickup revision.
  if (
    !pickup ||
    pickup.authorPubkey.toLowerCase() !==
      receipt.organizerPubkey.toLowerCase() ||
    !sameEvidenceRevision(receipt.option, pickup) ||
    !market.collection.pickupCoordinates.some((coordinate) =>
      sameEventMarketCoordinate(coordinate, receipt.option.coordinate)
    )
  ) {
    return { state: "blocked", reason: "handoff_changed" }
  }
  for (const receiptItem of receipt.items) {
    const current = market.acceptedProductEvidence.find((evidence) =>
      sameEventMarketCoordinate(
        evidence.productCoordinate,
        receiptItem.product.coordinate
      )
    )
    if (
      !current ||
      current.merchantPubkey?.toLowerCase() !==
        receipt.merchantPubkey.toLowerCase() ||
      !revisionIsCurrentOrNewer(receiptItem.product, {
        coordinate: current.productCoordinate,
        eventId: current.eventId,
        createdAt: current.createdAt,
      })
    ) {
      return { state: "blocked", reason: "product_not_accepted" }
    }
    if (
      current.fulfillmentStatus !== "resolved" ||
      current.handoffMode !== "organizer_handoff" ||
      current.handoffPubkey?.toLowerCase() !==
        receipt.organizerPubkey.toLowerCase() ||
      current.pickupAuthorPubkey?.toLowerCase() !==
        receipt.organizerPubkey.toLowerCase() ||
      !current.pickupCoordinate ||
      !sameEventMarketCoordinate(
        current.pickupCoordinate,
        receipt.option.coordinate
      )
    ) {
      return { state: "blocked", reason: "handoff_changed" }
    }
  }
  if (
    !isVerifiedEventMarketReceiptMerchandiseResolution(input.merchandise) ||
    input.merchandise.claimRef !== receipt.claimRef ||
    input.merchandise.merchantPubkey.toLowerCase() !==
      receipt.merchantPubkey.toLowerCase() ||
    input.merchandise.organizerPubkey.toLowerCase() !==
      receipt.organizerPubkey.toLowerCase() ||
    input.merchandise.items.length !== receipt.items.length ||
    receipt.items.some((receiptItem) => {
      const merchandise = input.merchandise.items.find((item) =>
        sameEvidenceRevision(item.product, receiptItem.product)
      )
      return (
        !merchandise ||
        merchandise.state !== "verified" ||
        merchandise.quantity !== receiptItem.quantity ||
        !merchandise.title
      )
    })
  ) {
    return { state: "blocked", reason: "merchandise_not_verified" }
  }
  return { state: "ready" }
}

/**
 * A valid authenticated merchant claim is positive handoff authority.
 * Inbox coverage affects discovery, not the authority of evidence already
 * found. Known revocations and conflicts are reflected in the claim state.
 */
export function resolveEventMarketHandoffAckGate(input: {
  claim: EventMarketOrganizerClaim
  market: EventMarketResolution
  merchandise: EventMarketReceiptMerchandiseResolution
}): EventMarketHandoffAckGate {
  if (input.claim.state !== "ready_for_pickup") {
    return { state: "blocked", reason: "claim_not_ready" }
  }
  return resolveEventMarketHandoffPublicGate(input)
}

export interface EventMarketHandoffAckAuthorization {
  readonly receiptId: string
  readonly claimRef: string
}

const handoffAckAuthorizations = new WeakMap<
  EventMarketHandoffAckAuthorization,
  EventMarketOrganizerClaim
>()

/** Issue a one-use ACK capability from exact positive merchant authority. */
export function authorizeEventMarketHandoffAck(input: {
  claim: EventMarketOrganizerClaim
  market: EventMarketResolution
  merchandise: EventMarketReceiptMerchandiseResolution
}): EventMarketHandoffAckAuthorization {
  const gate = resolveEventMarketHandoffAckGate(input)
  if (gate.state === "blocked") {
    throw new Error(`Organizer handoff ACK is blocked: ${gate.reason}.`)
  }
  const authorization = Object.freeze({
    receiptId: input.claim.receipt.id,
    claimRef: input.claim.receipt.payload.claimRef,
  })
  handoffAckAuthorizations.set(authorization, input.claim)
  return authorization
}

/** Derive the only ACK payload authorized by the exact merchant claim. */
export function buildEventMarketHandoffAckPayload(input: {
  authorization: EventMarketHandoffAckAuthorization
  handedOutAt?: number
}): EventMarketHandoffAckSchema {
  const claim = handoffAckAuthorizations.get(input.authorization)
  if (!claim) throw new Error("Organizer handoff ACK authorization is invalid.")
  const receipt = eventMarketReadyReceiptSchema.parse(claim.receipt.payload)
  return eventMarketHandoffAckSchema.parse({
    version: 1,
    type: "organizer_handoff_ack",
    state: "handed_out",
    claimRef: receipt.claimRef,
    merchantPubkey: receipt.merchantPubkey,
    organizerPubkey: receipt.organizerPubkey,
    calendar: receipt.calendar,
    collection: receipt.collection,
    option: receipt.option,
    readyReceiptId: claim.receipt.id,
    handedOutAt: input.handedOutAt ?? Math.floor(Date.now() / 1_000),
  })
}

function consumeEventMarketHandoffAckAuthorization(
  authorization: EventMarketHandoffAckAuthorization
): EventMarketOrganizerClaim {
  const claim = handoffAckAuthorizations.get(authorization)
  if (!claim) throw new Error("Organizer handoff ACK authorization is invalid.")
  handoffAckAuthorizations.delete(authorization)
  return claim
}

async function readPrivateMessages(principalPubkey: string) {
  const result = await getEventMarketPrivateMessageList(principalPubkey)
  return {
    ...result,
    messages: result.messages.filter(isAuthorizedPrivateMessage),
  }
}

/** Deterministically reduce one authenticated organizer handoff stream. */
export function reduceEventMarketOrganizerClaims(input: {
  organizerPubkey: string
  messages: readonly ParsedEventMarketPrivateMessage[]
  collectionCoordinate?: string
}): EventMarketOrganizerClaim[] {
  const organizer = input.organizerPubkey.trim().toLowerCase()
  const messages = input.messages.filter(isAuthorizedPrivateMessage)
  const receipts = messages.filter(
    (
      message
    ): message is Extract<
      ParsedEventMarketPrivateMessage,
      { type: "organizer_fulfillment_receipt" }
    > =>
      message.type === "organizer_fulfillment_receipt" &&
      message.recipientPubkey.toLowerCase() === organizer &&
      (!input.collectionCoordinate ||
        sameEventMarketCoordinate(
          message.payload.collection.coordinate,
          input.collectionCoordinate
        ))
  )
  const revocations = messages.filter(
    (
      message
    ): message is Extract<
      ParsedEventMarketPrivateMessage,
      { type: "organizer_fulfillment_revocation" }
    > => message.type === "organizer_fulfillment_revocation"
  )
  const acks = messages.filter(
    (
      message
    ): message is Extract<
      ParsedEventMarketPrivateMessage,
      { type: "organizer_handoff_ack" }
    > => message.type === "organizer_handoff_ack"
  )
  const byClaim = new Map<string, typeof receipts>()
  for (const receipt of receipts) {
    const key = `${receipt.payload.merchantPubkey.toLowerCase()}:${receipt.payload.claimRef}`
    const bucket = byClaim.get(key) ?? []
    if (!bucket.some((candidate) => candidate.id === receipt.id)) {
      bucket.push(receipt)
    }
    byClaim.set(key, bucket)
  }
  const claims: EventMarketOrganizerClaim[] = []
  for (const bucket of byClaim.values()) {
    bucket.sort((left, right) => left.createdAt - right.createdAt)
    const receipt = bucket[bucket.length - 1]!
    if (bucket.length > 1) {
      claims.push({ receipt, state: "conflicting" })
      continue
    }
    const scopedRevocations = revocations.filter(
      (message) =>
        message.payload.readyReceiptId.toLowerCase() ===
        receipt.id.toLowerCase()
    )
    const scopedAcks = acks.filter(
      (message) =>
        message.payload.readyReceiptId.toLowerCase() ===
        receipt.id.toLowerCase()
    )
    if (
      [...scopedRevocations, ...scopedAcks].some(
        (message) => !samePrivateGraph(message.payload, receipt.payload)
      )
    ) {
      claims.push({ receipt, state: "conflicting" })
      continue
    }
    const revocation = scopedRevocations
      .sort((left, right) => left.createdAt - right.createdAt)
      .at(-1)
    const ack = scopedAcks
      .sort((left, right) => left.createdAt - right.createdAt)
      .at(-1)
    if (revocation && ack) {
      claims.push({ receipt, state: "conflicting", revocation, ack })
      continue
    }
    claims.push({
      receipt,
      state: revocation ? "revoked" : ack ? "handed_out" : "ready_for_pickup",
      ...(revocation ? { revocation } : {}),
      ...(ack ? { ack } : {}),
    })
  }
  return claims.sort(
    (left, right) => right.receipt.createdAt - left.receipt.createdAt
  )
}

/** Read and reduce organizer receipts; contradictory terminal evidence conflicts. */
export async function readEventMarketReadyReceipts(input: {
  organizerPubkey: string
  collectionCoordinate?: string
}): Promise<EventMarketPrivateReadResult<EventMarketOrganizerClaim[]>> {
  const organizer = input.organizerPubkey.trim().toLowerCase()
  const result = await readPrivateMessages(organizer)
  return {
    data: reduceEventMarketOrganizerClaims({
      organizerPubkey: organizer,
      messages: result.messages,
      collectionCoordinate: input.collectionCoordinate,
    }),
    stale: result.stale,
    decryptFailureCount: result.decryptFailures.length,
    inbox: result.inbox,
  }
}

export async function readEventMarketFulfillmentRevocations(input: {
  principalPubkey: string
  collectionCoordinate?: string
}): Promise<
  EventMarketPrivateReadResult<
    Array<
      Extract<
        ParsedEventMarketPrivateMessage,
        { type: "organizer_fulfillment_revocation" }
      >
    >
  >
> {
  const result = await readPrivateMessages(input.principalPubkey)
  return {
    data: result.messages.filter(
      (
        message
      ): message is Extract<
        ParsedEventMarketPrivateMessage,
        { type: "organizer_fulfillment_revocation" }
      > =>
        message.type === "organizer_fulfillment_revocation" &&
        (!input.collectionCoordinate ||
          sameEventMarketCoordinate(
            message.payload.collection.coordinate,
            input.collectionCoordinate
          ))
    ),
    stale: result.stale,
    decryptFailureCount: result.decryptFailures.length,
    inbox: result.inbox,
  }
}

export async function readEventMarketHandoffAcks(input: {
  merchantPubkey: string
  collectionCoordinate?: string
}): Promise<
  EventMarketPrivateReadResult<
    Array<
      Extract<
        ParsedEventMarketPrivateMessage,
        { type: "organizer_handoff_ack" }
      >
    >
  >
> {
  const merchant = input.merchantPubkey.trim().toLowerCase()
  const result = await readPrivateMessages(merchant)
  return {
    data: result.messages.filter(
      (
        message
      ): message is Extract<
        ParsedEventMarketPrivateMessage,
        { type: "organizer_handoff_ack" }
      > =>
        message.type === "organizer_handoff_ack" &&
        message.recipientPubkey.toLowerCase() === merchant &&
        (!input.collectionCoordinate ||
          sameEventMarketCoordinate(
            message.payload.collection.coordinate,
            input.collectionCoordinate
          ))
    ),
    stale: result.stale,
    decryptFailureCount: result.decryptFailures.length,
    inbox: result.inbox,
  }
}
