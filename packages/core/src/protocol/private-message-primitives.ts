import { getEventHash } from "nostr-tools"
import { v2 as nip44 } from "nostr-tools/nip44"
import { createWrap } from "nostr-tools/nip59"
import { buildMerchantOrderReviewUrl } from "../app-links"
import { type AccountNetworkLocalStateRepository } from "./account-network-local-state"
import {
  decodeCommerceMessageRumor,
  type DecodedCommerceMessage,
} from "./commerce-message-codec"
import type { InboxDeclarationEvidenceRepository } from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import {
  NostrSignerError,
  type NostrKeySigner,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { parseOrderMessageRumorEvent } from "./orders"
import {
  __resetInboxDeclarationCache,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationResolution,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  fetchPublicEvents,
  fetchPublicEventsWithDiagnostics,
  type PublicRelayReadOptions,
} from "./relay-reader"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import { MAX_RELAY_MESSAGE_CHARS } from "./relay-wire-limits"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/**
 * NIP-17 rumor/envelope construction, parsing and retained inbox readiness.
 * These primitives do not stage or publish; private-message-delivery owns sends.
 *
 * Two conversation types share the same NIP-17 transport, distinguished by the
 * inner rumor kind: kind 14 general direct messages (order-independent, threaded
 * by counterparty) vs kind 16 order-linked messages (threaded by order id).
 */

/** Plain event surface shared by envelopes, codecs and immutable delivery. */
export interface PrivateMessageEvent {
  id: string
  pubkey: string
  kind: number
  created_at?: number
  tags: string[][]
  content: string
  sig?: string
}
export type PrivateMessageRumor = UnsignedNostrEvent & { id: string }
export function createPrivateMessageRumor(
  input: UnsignedNostrEvent
): PrivateMessageRumor {
  const event = { ...input, tags: input.tags.map((tag) => [...tag]) }
  return { ...event, id: getEventHash(event) }
}
export function completePrivateMessageEvent(
  event: PrivateMessageEvent
): PrivateMessageRumor {
  if (event.kind === undefined || event.created_at === undefined)
    throw new Error("Incomplete private event")
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
  }
}

export type PrivateMessageCategory = "order" | "direct"

export interface ValidatedOrderRouteScope {
  readonly rumorId: string
  readonly orderId: string
  readonly senderPubkey: string
  readonly recipientPubkey: string
}

const validatedOrderRouteScopes = new WeakSet<ValidatedOrderRouteScope>()

export interface ValidatedGuestOrderCompanionScope {
  readonly rumorId: string
  readonly orderRumorId: string
  readonly orderId: string
  readonly subject: string
  readonly senderPubkey: string
  readonly recipientPubkey: string
}

const validatedGuestOrderCompanionScopes =
  new WeakSet<ValidatedGuestOrderCompanionScope>()

export const ORDER_COMPANION_NOTIFICATION_SUBJECT = "conduit-order-notification"
export const ORDER_COMPANION_NOTIFICATION_MARKER = "order-companion"
export const ORDER_COMPANION_NOTIFICATION_VERSION = "1"

export function buildOrderCompanionNotificationMarkerTag(
  authoritativeOrderId: string
): string[] {
  const orderRumorId = authoritativeOrderId.trim()
  if (!orderRumorId) {
    throw new Error(
      "Order companion marker requires an authoritative event id."
    )
  }
  return [
    "conduit",
    ORDER_COMPANION_NOTIFICATION_MARKER,
    ORDER_COMPANION_NOTIFICATION_VERSION,
    orderRumorId,
  ]
}

export interface OrderCompanionNotificationIdentity {
  orderId: string
  orderRumorId: string
  senderPubkey: string
  recipientPubkey: string
}

const GUEST_ORDER_COMPANION_COPY =
  "A new guest order was sent to you through Conduit Market.\n" +
  "This buyer does not receive Nostr replies. Review the order and follow up using the email or phone provided there."
const SIGNED_IN_ORDER_COMPANION_COPY =
  "A new order was sent to you through Conduit Market."

export function getOrderCompanionNotificationContentOrderId(
  content: string
): string | null {
  for (const copy of [
    GUEST_ORDER_COMPANION_COPY,
    SIGNED_IN_ORDER_COMPANION_COPY,
  ]) {
    const prefix = `${copy}\nReview it at: `
    if (!content.startsWith(prefix)) continue
    const reviewUrl = content.slice(prefix.length)
    if (!reviewUrl || reviewUrl.includes("\n")) return null
    try {
      const parsed = new URL(reviewUrl)
      const orderIds = parsed.searchParams.getAll("order")
      const orderId = orderIds.length === 1 ? orderIds[0]?.trim() : null
      if (!orderId) return null
      return buildMerchantOrderReviewUrl(parsed.origin, orderId) === reviewUrl
        ? orderId
        : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Identify the exact app-level marker used for advisory order notifications.
 * Transport remains generic: callers can still unwrap the rumor, while
 * Conduit's inbox projection can keep this machine notification out of human
 * conversation threads.
 */
export function getOrderCompanionNotificationIdentity(
  rumor: PrivateMessageEvent
): OrderCompanionNotificationIdentity | null {
  if (rumor.kind !== EVENT_KINDS.DIRECT_MESSAGE) return null
  const subjects = rumor.tags.filter((tag) => tag[0] === "subject")
  const orders = rumor.tags.filter((tag) => tag[0] === "order")
  const recipients = rumor.tags.filter((tag) => tag[0] === "p")
  const clients = rumor.tags.filter(isConduitMarketClientTag)
  const markers = rumor.tags.filter(
    (tag) =>
      tag[0] === "conduit" && tag[1] === ORDER_COMPANION_NOTIFICATION_MARKER
  )
  const isCanonical =
    rumor.tags.length === 5 &&
    subjects.length === 1 &&
    subjects[0]?.length === 2 &&
    subjects[0]?.[1] === ORDER_COMPANION_NOTIFICATION_SUBJECT &&
    orders.length === 1 &&
    orders[0]?.length === 2 &&
    Boolean(orders[0]?.[1]?.trim()) &&
    recipients.length === 1 &&
    recipients[0]?.length === 2 &&
    Boolean(recipients[0]?.[1]?.trim()) &&
    markers.length === 1 &&
    markers[0]?.length === 4 &&
    markers[0]?.[2] === ORDER_COMPANION_NOTIFICATION_VERSION &&
    Boolean(markers[0]?.[3]?.trim()) &&
    clients.length === 1 &&
    getOrderCompanionNotificationContentOrderId(rumor.content) ===
      orders[0]?.[1]?.trim()
  if (!isCanonical) return null

  return {
    orderId: orders[0]![1]!.trim(),
    orderRumorId: markers[0]![3]!.trim(),
    senderPubkey: rumor.pubkey.trim().toLowerCase(),
    recipientPubkey: recipients[0]![1]!.trim().toLowerCase(),
  }
}

export function isOrderCompanionNotificationRumor(
  rumor: PrivateMessageEvent
): boolean {
  return getOrderCompanionNotificationIdentity(rumor) !== null
}

function isConduitMarketClientTag(tag: string[]): boolean {
  return (
    tag[0] === "client" &&
    (tag[1] === "Conduit Market" ||
      tag[2]?.endsWith(":conduit-market") === true)
  )
}

export function createOrderCompanionNotificationRumor(input: {
  authoritativeOrder: PrivateMessageEvent
  senderPubkey: string
  recipientPubkey: string
  buyerIdentityKind: "signed_in" | "guest_ephemeral"
  merchantOrigin: string
}): PrivateMessageEvent {
  const orderId = input.authoritativeOrder.tags.find(
    (tag) => tag[0] === "order"
  )?.[1]
  if (!orderId) throw new Error("Order notification requires an order tag.")
  if (!input.authoritativeOrder.id) {
    throw new Error("Order notification requires the authoritative event id.")
  }
  if (input.authoritativeOrder.created_at === undefined) {
    throw new Error("Order notification requires the order timestamp.")
  }

  const companion: PrivateMessageEvent = {
    id: "",
    kind: EVENT_KINDS.DIRECT_MESSAGE,
    pubkey: input.senderPubkey,
    tags: [],
    content: "",
  }
  companion.kind = EVENT_KINDS.DIRECT_MESSAGE
  companion.pubkey = input.senderPubkey
  companion.created_at = input.authoritativeOrder.created_at
  companion.tags = appendConduitClientTag(
    [
      ["p", input.recipientPubkey],
      ["subject", ORDER_COMPANION_NOTIFICATION_SUBJECT],
      ["order", orderId],
      buildOrderCompanionNotificationMarkerTag(input.authoritativeOrder.id),
    ],
    "market"
  )

  if (!companion.tags.some((tag) => tag[0] === "client")) {
    const authoritativeClientTag = input.authoritativeOrder.tags.find(
      isConduitMarketClientTag
    )
    if (authoritativeClientTag) {
      companion.tags.push([...authoritativeClientTag])
    }
  }
  if (!companion.tags.some(isConduitMarketClientTag)) {
    companion.tags.push(["client", "Conduit Market"])
  }

  const copy =
    input.buyerIdentityKind === "guest_ephemeral"
      ? GUEST_ORDER_COMPANION_COPY
      : SIGNED_IN_ORDER_COMPANION_COPY
  companion.content =
    `${copy}\n` +
    `Review it at: ${buildMerchantOrderReviewUrl(input.merchantOrigin, orderId)}`
  companion.id = getEventHash(completePrivateMessageEvent(companion))
  return companion
}

/**
 * Issue a one-use compatibility-routing capability bound to one validated
 * kind-16 rumor, order id, sender, and recipient. Relay URLs are deliberately
 * absent: validation can authorize the lane but cannot widen its relay pool.
 */
export function createValidatedOrderRouteScope(input: {
  rumor: PrivateMessageEvent
  orderId: string
  senderPubkey: string
  recipientPubkey: string
  /**
   * Logical order counterparty named by the rumor's `p` tag when the encrypted
   * delivery recipient is the sender itself. This supports merchant-only
   * operational records for outbound-only guest orders without treating the
   * guest key as a reply inbox.
   */
  rumorRecipientPubkey?: string
}): ValidatedOrderRouteScope {
  const orderId = input.orderId.trim()
  const senderPubkey = input.senderPubkey.trim().toLowerCase()
  const recipientPubkey = input.recipientPubkey.trim().toLowerCase()
  const expectedRumorRecipient = (
    input.rumorRecipientPubkey ?? input.recipientPubkey
  )
    .trim()
    .toLowerCase()
  const rumorOrderId = input.rumor.tags.find((tag) => tag[0] === "order")?.[1]
  const rumorRecipient = input.rumor.tags
    .find((tag) => tag[0] === "p")?.[1]
    ?.trim()
    .toLowerCase()
  const decoded = decodeCommerceMessageRumor(
    completePrivateMessageEvent(input.rumor)
  )
  if (
    input.rumor.kind !== EVENT_KINDS.ORDER ||
    !input.rumor.id ||
    input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey ||
    rumorRecipient !== expectedRumorRecipient ||
    (expectedRumorRecipient !== recipientPubkey &&
      recipientPubkey !== senderPubkey) ||
    rumorOrderId !== orderId ||
    decoded.category !== "commerce" ||
    !decoded.parsedOrderMessage
  ) {
    throw new Error("Cannot authorize compatibility routing for this rumor.")
  }
  const scope = Object.freeze({
    rumorId: input.rumor.id,
    orderId,
    senderPubkey,
    recipientPubkey,
  })
  validatedOrderRouteScopes.add(scope)
  return scope
}

/**
 * Build the fixed, PII-free recipient-only kind-14 notification that follows an
 * authoritative guest order, together with its one-use transport capability.
 * Keeping construction inside this boundary prevents callers from authorizing
 * arbitrary guest-authored kind-14 content. Guests intentionally have no reply
 * inbox, so the capability skips only the sender-readiness check. The recipient
 * must still have a declared inbox and kind-14 compatibility routing remains
 * unavailable.
 */
export function createValidatedGuestOrderCompanion(input: {
  authoritativeOrder: PrivateMessageEvent
  senderPubkey: string
  recipientPubkey: string
  merchantOrigin: string
}): {
  companion: PrivateMessageEvent
  scope: ValidatedGuestOrderCompanionScope
} {
  const senderPubkey = input.senderPubkey.trim().toLowerCase()
  const recipientPubkey = input.recipientPubkey.trim().toLowerCase()
  let parsedOrder: ReturnType<typeof parseOrderMessageRumorEvent>
  try {
    parsedOrder = parseOrderMessageRumorEvent(input.authoritativeOrder)
  } catch {
    throw new Error("Cannot authorize a one-way guest order companion.")
  }

  if (
    parsedOrder.type !== "order" ||
    parsedOrder.payload.buyerIdentityKind !== "guest_ephemeral" ||
    parsedOrder.payload.buyerPubkey.trim().toLowerCase() !== senderPubkey ||
    parsedOrder.payload.merchantPubkey.trim().toLowerCase() !==
      recipientPubkey ||
    input.authoritativeOrder.kind !== EVENT_KINDS.ORDER ||
    !input.authoritativeOrder.id ||
    input.authoritativeOrder.pubkey.trim().toLowerCase() !== senderPubkey ||
    parsedOrder.recipientPubkey.trim().toLowerCase() !== recipientPubkey ||
    input.authoritativeOrder.created_at === undefined
  ) {
    throw new Error("Cannot authorize a one-way guest order companion.")
  }

  const companion = createOrderCompanionNotificationRumor({
    authoritativeOrder: input.authoritativeOrder,
    senderPubkey,
    recipientPubkey,
    buyerIdentityKind: "guest_ephemeral",
    merchantOrigin: input.merchantOrigin,
  })

  const scope = Object.freeze({
    rumorId: companion.id,
    orderRumorId: input.authoritativeOrder.id,
    orderId: parsedOrder.orderId,
    subject: ORDER_COMPANION_NOTIFICATION_SUBJECT,
    senderPubkey,
    recipientPubkey,
  })
  validatedGuestOrderCompanionScopes.add(scope)
  return { companion, scope }
}

/** Coarse, content-free decrypt-failure reason (docs/specs/messaging.md). */
export type DecryptFailureReason =
  "nip44_failed" | "nip04_failed" | "timeout" | "malformed"

/** Content-free record of a gift wrap that could not be turned into a message. */
export interface DecryptFailure {
  wrapId: string
  reason: DecryptFailureReason
}

export type UnwrapOutcome =
  | {
      status: "ok"
      wrapId: string
      rumor: PrivateMessageEvent
      category: PrivateMessageCategory
    }
  | {
      status: "external"
      wrapId: string
      rumor: PrivateMessageEvent
      category: "order"
      record: DecodedCommerceMessage
    }
  | { status: "ignored"; wrapId: string; kind: number | undefined }
  | {
      status: "deferred_machine"
      wrapId: string
      kind: typeof EVENT_KINDS.ORDER
    }
  | { status: "decrypt_failed"; wrapId: string; reason: DecryptFailureReason }

/** Injectable unwrap implementation (tests / capability overrides). */
export type GiftUnwrapFn = (
  event: PrivateMessageEvent,
  signer: NostrKeySigner
) => Promise<PrivateMessageEvent | null>

export interface UnwrapGiftWrapOptions {
  /** Dedicated handoff recovery only; general inbox consumers defer these records. */
  machineConsumer?: "future_market"
  /** Visible wait threshold only; provider deadlines belong to SessionSigner. */
  timeoutMs?: number
  onWaiting?: () => void
  /** Replace NIP-44 envelope verification and decryption (used by tests). */
  giftUnwrap?: GiftUnwrapFn
}

const DEFAULT_UNWRAP_TIMEOUT_MS = 8_000
/** Named read-only exception for authenticated client metadata on seals.
 * Canonical writes still emit empty tags. Routing/domain tags never qualify.
 */
export function acceptsAuthenticatedSealMetadata(
  tags: readonly (readonly string[])[]
): boolean {
  return (
    tags.length === 0 ||
    (tags.length === 1 &&
      tags[0]?.[0] === "client" &&
      tags[0].length >= 2 &&
      tags[0].length <= 4 &&
      tags[0].slice(1).every((value) => value.length <= 512))
  )
}

/** Bound both NIP-44 layers before asking a signer to encrypt or sign. */
export function assertPrivateMessageFitsTransport(
  rumor: UnsignedNostrEvent
): void {
  const hex64 = "0".repeat(64)
  const signedShell = {
    id: hex64,
    pubkey: hex64,
    created_at: Number.MAX_SAFE_INTEGER,
    kind: EVENT_KINDS.SEAL,
    tags: [] as string[][],
    content: "",
    sig: "0".repeat(128),
  }
  const encryptedChars = (plaintextBytes: number): number => {
    const prefixBytes = plaintextBytes < 65_536 ? 2 : 6
    // Version (1), nonce (32), length prefix, padded UTF-8 content, MAC (32), base64.
    return (
      4 *
      Math.ceil(
        (65 + prefixBytes + nip44.utils.calcPaddedLen(plaintextBytes)) / 3
      )
    )
  }
  const rumorBytes = new TextEncoder().encode(
    JSON.stringify({ ...rumor, id: hex64 })
  ).length
  const sealBytes =
    JSON.stringify(signedShell).length + encryptedChars(rumorBytes)
  const frameChars =
    JSON.stringify([
      "EVENT",
      "0".repeat(64),
      { ...signedShell, kind: EVENT_KINDS.GIFT_WRAP, tags: [["p", hex64]] },
    ]).length + encryptedChars(sealBytes)
  if (frameChars > MAX_RELAY_MESSAGE_CHARS) {
    throw new Error(
      "This message is too large to send securely. For an order, remove items from the cart or contact the merchant to arrange a smaller order."
    )
  }
}

/** NIP-59 construction with plain key operations, independent of relay clients. */
export async function wrapPrivateMessage(
  event: PrivateMessageEvent,
  recipient: { pubkey: string },
  signer: NostrKeySigner,
  params: { rumorKind?: number } = {}
): Promise<SignedPublicNostrEvent> {
  const pubkey = await signer.getPublicKey()
  if (event.pubkey && event.pubkey !== pubkey)
    throw new NostrSignerError("authority_changed")
  const rumor: UnsignedNostrEvent = {
    pubkey,
    kind: params.rumorKind ?? event.kind ?? EVENT_KINDS.DIRECT_MESSAGE,
    created_at: event.created_at ?? Math.floor(Date.now() / 1000),
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
  }
  assertPrivateMessageFitsTransport(rumor)
  const seal = await signer.signEvent({
    pubkey,
    kind: EVENT_KINDS.SEAL,
    created_at: Math.round(Date.now() / 1000 - Math.random() * 100_000),
    tags: [],
    content: await signer.encryptNip44(
      recipient.pubkey,
      JSON.stringify({ ...rumor, id: getEventHash(rumor) })
    ),
  })
  if (!isValidSignedPublicNostrEvent(seal) || seal.pubkey !== pubkey)
    throw new NostrSignerError("invalid_response")
  return createWrap(
    { ...seal, tags: seal.tags.map((tag) => [...tag]) },
    recipient.pubkey
  )
}

/** Validate both envelopes and the unsigned rumor before returning private data. */
export async function unwrapPrivateMessageEnvelope(
  event: PrivateMessageEvent | SignedPublicNostrEvent,
  signer: NostrKeySigner,
  options: { onClientSealMetadataAccepted?: () => void } = {}
): Promise<PrivateMessageEvent> {
  const wrap = event as SignedPublicNostrEvent
  const pubkey = await signer.getPublicKey()
  if (
    !isValidSignedPublicNostrEvent(wrap as SignedPublicNostrEvent) ||
    wrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    !wrap.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey)
  )
    throw new NostrSignerError("invalid_response")
  let seal: SignedPublicNostrEvent
  try {
    seal = JSON.parse(
      await signer.decryptNip44(wrap.pubkey, wrap.content)
    ) as SignedPublicNostrEvent
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new NostrSignerError("invalid_response")
    throw error
  }
  if (
    !isValidSignedPublicNostrEvent(seal) ||
    seal.kind !== EVENT_KINDS.SEAL ||
    !acceptsAuthenticatedSealMetadata(seal.tags)
  )
    throw new NostrSignerError("invalid_response")
  let rumor: UnsignedNostrEvent & { id: string; sig?: string }
  const plaintext = await signer.decryptNip44(seal.pubkey, seal.content)
  try {
    rumor = JSON.parse(plaintext) as typeof rumor
    if (
      "sig" in rumor ||
      rumor.pubkey !== seal.pubkey ||
      rumor.id !== getEventHash(rumor) ||
      (rumor.pubkey !== pubkey &&
        !rumor.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey))
    )
      throw new NostrSignerError("invalid_response")
  } catch {
    throw new NostrSignerError("invalid_response")
  }
  if (seal.tags.length) options.onClientSealMetadataAccepted?.()
  return rumor
}
/** Map an inner rumor kind to its conversation type, or null when unrelated. */
export function classifyPrivateMessageKind(
  kind: number | undefined
): PrivateMessageCategory | null {
  if (kind === EVENT_KINDS.ORDER) return "order"
  if (kind === EVENT_KINDS.DIRECT_MESSAGE) return "direct"
  return null
}

/**
 * Unwrap a single NIP-17 gift wrap into a classified outcome. Decrypt failures
 * are surfaced (id + coarse reason), never collapsed to silence. NIP-44 v2 is
 * the current path; NIP-04 stays in the separate read-only legacy lane.
 */
export async function unwrapGiftWrap(
  event: PrivateMessageEvent | SignedPublicNostrEvent,
  signer: NostrKeySigner,
  options: UnwrapGiftWrapOptions = {}
): Promise<UnwrapOutcome> {
  const wrapId = event.id
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNWRAP_TIMEOUT_MS

  const runner = (async (): Promise<{
    rumor: PrivateMessageEvent | null
    reason: DecryptFailureReason | null
  }> => {
    if (options.giftUnwrap) {
      try {
        const rumor = await options.giftUnwrap(
          { ...event, tags: event.tags.map((tag) => [...tag]) },
          signer
        )
        return { rumor, reason: rumor ? null : "nip44_failed" }
      } catch {
        return { rumor: null, reason: "nip44_failed" }
      }
    }

    try {
      return {
        rumor: await unwrapPrivateMessageEnvelope(event, signer),
        reason: null,
      }
    } catch {
      return { rumor: null, reason: "nip44_failed" }
    }
  })()

  // This timer changes visible waiting state only. The real provider operation
  // remains owned until it settles; a slow valid result is never discarded.
  const waitTimer = setTimeout(() => options.onWaiting?.(), timeoutMs)
  let decoded: Awaited<typeof runner>
  try {
    decoded = await runner
  } finally {
    clearTimeout(waitTimer)
  }
  const { rumor, reason } = decoded
  if (!rumor) {
    return {
      status: "decrypt_failed",
      wrapId,
      reason: reason ?? "nip44_failed",
    }
  }

  const decodedRecord = decodeCommerceMessageRumor(
    completePrivateMessageEvent(rumor)
  )
  if (decodedRecord.category === "machine") {
    if (options.machineConsumer === "future_market") {
      try {
        const message = parseOrderMessageRumorEvent(rumor)
        if (
          [
            "future_market_ready",
            "future_market_revoked",
            "future_market_handed_out",
          ].includes(message.type)
        )
          return { status: "ok", wrapId, rumor, category: "order" }
      } catch {
        // Invalid recovery never gains generic rendering or domain authority.
      }
    }
    return { status: "deferred_machine", wrapId, kind: EVENT_KINDS.ORDER }
  }
  if (decodedRecord.category === "commerce") {
    if (decodedRecord.parsedOrderMessage)
      return { status: "ok", wrapId, rumor, category: "order" }
    return {
      status: "external",
      wrapId,
      rumor,
      category: "order",
      record: decodedRecord,
    }
  }
  if (
    decodedRecord.category === "direct" ||
    decodedRecord.category === "file"
  ) {
    return { status: "ok", wrapId, rumor, category: "direct" }
  }
  return { status: "ignored", wrapId, kind: rumor.kind }
}

export interface BuildDirectMessageRumorInput {
  senderPubkey: string
  recipientPubkey: string
  content: string
  appId: ConduitAppId
  subject?: string
  replyTo?: string
  createdAt?: number
}

/** Build an unsigned kind-14 general direct-message rumor (NIP-17). */
export function buildDirectMessageRumor(
  input: BuildDirectMessageRumorInput
): PrivateMessageEvent {
  const rumor: PrivateMessageEvent = {
    id: "",
    kind: EVENT_KINDS.DIRECT_MESSAGE,
    pubkey: input.senderPubkey,
    tags: [],
    content: "",
  }
  rumor.kind = EVENT_KINDS.DIRECT_MESSAGE
  rumor.pubkey = input.senderPubkey
  rumor.created_at = input.createdAt ?? Math.floor(Date.now() / 1000)
  const tags: string[][] = [["p", input.recipientPubkey]]
  if (input.subject) tags.push(["subject", input.subject])
  rumor.tags = appendConduitClientTag(tags, input.appId)
  rumor.content = input.content
  try {
    rumor.id = getEventHash(completePrivateMessageEvent(rumor))
  } catch {
    // id derivation is best-effort; caching path re-derives if needed
  }
  return rumor
}

export interface ParsedDirectMessage {
  id: string
  senderPubkey: string
  recipientPubkey: string
  content: string
  /** Present only for an exact canonical companion awaiting order evidence. */
  orderCompanionIdentity?: OrderCompanionNotificationIdentity
  /** Milliseconds, matching ParsedOrderMessage.createdAt. */
  createdAt: number
  transport: DirectMessageTransport
  participants?: string[]
  conversationId?: string
  replyTo?: string
  file?: Extract<DecodedCommerceMessage, { category: "file" }>
}

export type DirectMessageTransport = "nip17" | "nip04"

export type LegacyDmFailureReason =
  "nip04_unavailable" | "decrypt_failed" | "timeout" | "malformed"

export interface LegacyDmDecryptFailure {
  eventId: string
  reason: LegacyDmFailureReason
  retryable: boolean
}

export type LegacyDmDecryptOutcome =
  | { status: "ok"; message: ParsedDirectMessage }
  | { status: "ignored"; eventId: string }
  | { status: "decrypt_failed"; failure: LegacyDmDecryptFailure }

export type LegacyDmDecrypt = (
  counterpartyPubkey: string,
  ciphertext: string
) => Promise<string>

export function createLegacyDmDecrypt(signer: NostrKeySigner): LegacyDmDecrypt {
  return async (counterpartyPubkey, ciphertext) =>
    await signer.decryptLegacy(counterpartyPubkey, ciphertext)
}

export async function decryptLegacyDirectMessage(
  event: PrivateMessageEvent | SignedPublicNostrEvent,
  principalPubkey: string,
  decrypt: LegacyDmDecrypt,
  options: { timeoutMs?: number } = {}
): Promise<LegacyDmDecryptOutcome> {
  const recipientPubkey =
    (event.tags ?? []).find((tag) => tag[0] === "p")?.[1] ?? ""
  if (
    event.kind !== EVENT_KINDS.DM_LEGACY ||
    !event.id ||
    !event.pubkey ||
    !recipientPubkey ||
    (event.pubkey !== principalPubkey && recipientPubkey !== principalPubkey)
  ) {
    return { status: "ignored", eventId: event.id }
  }

  const counterpartyPubkey =
    event.pubkey === principalPubkey ? recipientPubkey : event.pubkey
  if (!counterpartyPubkey || counterpartyPubkey === principalPubkey) {
    return { status: "ignored", eventId: event.id }
  }

  // Active-operation deadlines belong to the session signer. Queue waiting
  // and a UI waiting indicator must never discard a valid provider result.
  void options
  try {
    const result = await decrypt(counterpartyPubkey, event.content ?? "")
    return {
      status: "ok",
      message: {
        id: event.id,
        senderPubkey: event.pubkey,
        recipientPubkey,
        content: result,
        createdAt: (event.created_at ?? 0) * 1000,
        transport: "nip04",
      },
    }
  } catch {
    return {
      status: "decrypt_failed",
      failure: {
        eventId: event.id,
        reason: "decrypt_failed",
        retryable: true,
      },
    }
  }
}

/** Parse an unwrapped kind-14 rumor into a general direct message. */
export function parseDirectMessageRumor(
  rumor: PrivateMessageEvent
): ParsedDirectMessage {
  const recipientPubkey =
    (rumor.tags ?? []).find((tag) => tag[0] === "p")?.[1] ?? ""
  return {
    id: rumor.id,
    senderPubkey: rumor.pubkey,
    recipientPubkey,
    content: rumor.content ?? "",
    createdAt: (rumor.created_at ?? 0) * 1000,
    transport: "nip17",
    participants: [
      ...new Set([
        rumor.pubkey,
        ...rumor.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]!),
      ]),
    ].sort(),
    conversationId: `nip17:${[...new Set([rumor.pubkey, ...rumor.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]!)])].sort().join(":")}`,
    replyTo: rumor.tags.filter((tag) => tag[0] === "e").at(-1)?.[1],
  }
}

export function consumeValidatedOrderRouteScope(input: {
  scope: ValidatedOrderRouteScope | undefined
  rumor: PrivateMessageEvent
  senderPubkey: string
  recipientPubkey: string
}): boolean {
  const scope = input.scope
  if (!scope || !validatedOrderRouteScopes.has(scope)) return false
  validatedOrderRouteScopes.delete(scope)
  const rumorOrderId = input.rumor.tags.find((tag) => tag[0] === "order")?.[1]
  return (
    input.rumor.kind === EVENT_KINDS.ORDER &&
    scope.rumorId === input.rumor.id &&
    scope.orderId === rumorOrderId &&
    scope.senderPubkey === input.senderPubkey &&
    scope.recipientPubkey === input.recipientPubkey
  )
}

export function consumeValidatedGuestOrderCompanionScope(input: {
  scope: ValidatedGuestOrderCompanionScope | undefined
  rumor: PrivateMessageEvent
  senderPubkey: string
  recipientPubkey: string
  selfCopy: boolean
}): boolean {
  const scope = input.scope
  if (!scope || !validatedGuestOrderCompanionScopes.has(scope)) return false
  validatedGuestOrderCompanionScopes.delete(scope)

  let rumorHash: string
  try {
    rumorHash = getEventHash(completePrivateMessageEvent(input.rumor))
  } catch {
    return false
  }
  const rumorOrderId = input.rumor.tags.find((tag) => tag[0] === "order")?.[1]
  const rumorSubjects = input.rumor.tags
    .filter((tag) => tag[0] === "subject")
    .map((tag) => tag[1])
  const rumorRecipients = input.rumor.tags
    .filter((tag) => tag[0] === "p")
    .map((tag) => tag[1]?.trim().toLowerCase())
  return (
    input.rumor.kind === EVENT_KINDS.DIRECT_MESSAGE &&
    input.selfCopy === false &&
    scope.rumorId === input.rumor.id &&
    scope.rumorId === rumorHash &&
    scope.orderId === rumorOrderId &&
    rumorSubjects.length === 1 &&
    rumorSubjects[0] === scope.subject &&
    scope.senderPubkey === input.senderPubkey &&
    scope.recipientPubkey === input.recipientPubkey &&
    rumorRecipients.length === 1 &&
    rumorRecipients[0] === input.recipientPubkey
  )
}

export type Nip44Version = "v2" | "v3"

export interface Nip44Capabilities {
  hasNip44: boolean
  hasNip44V3: boolean
  /** Versions Conduit will actually use for sending, most-capable first. */
  supportedVersions: Nip44Version[]
  /** Current wire default. Stays v2 until v3 is source-gated on. */
  defaultVersion: Nip44Version
}

/**
 * NIP-44 v3 stays OFF as a send default until public draft/client references,
 * library support, and recipient capability detection are in place (CND-119).
 * The seam parses/negotiates so v3 can be enabled later without a rewrite.
 */
export const NIP44_V3_SEND_ENABLED = false

type Nip44SignerSurface = {
  nip44?: unknown
  nip44v3?: unknown
}

/**
 * Probe a signer (or `window.nostr`) for NIP-44 capabilities. Never assumes a
 * NIP-07 signer exposes v3.
 */
export function detectNip44Capabilities(
  signer?: Nip44SignerSurface | null
): Nip44Capabilities {
  const surface =
    signer ??
    (typeof window !== "undefined"
      ? ((window as unknown as { nostr?: Nip44SignerSurface }).nostr ?? null)
      : null)

  const hasNip44 = Boolean(surface && surface.nip44)
  const hasNip44V3 = Boolean(surface && surface.nip44v3)

  const supportedVersions: Nip44Version[] = []
  if (hasNip44) supportedVersions.push("v2")
  if (hasNip44V3 && NIP44_V3_SEND_ENABLED) supportedVersions.push("v3")

  return {
    hasNip44,
    hasNip44V3,
    supportedVersions,
    defaultVersion: "v2",
  }
}

export interface FetchInboxRelayOptions {
  fetchEvents?: typeof fetchPublicEvents
  fetchEventsWithDiagnostics?: typeof fetchPublicEventsWithDiagnostics
  relayUrls?: string[]
  evidenceRepository?: InboxDeclarationEvidenceRepository
  /** Account whose durable whole-relay exclusions govern declaration lookup. */
  requestingAccountPubkey?: string | null
  /** Active authenticated account for owner-selected ws:// read authority. */
  authenticatedPubkey?: string | null
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Cancels queued or in-flight declaration lookup I/O. */
  signal?: AbortSignal
  /** Live account session authority for declaration reads. */
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
}

export type OwnPrivateMessageRelayReadiness =
  | {
      state: "ready"
      eventId: string
      relayUrls: string[]
      stale: boolean
      distributionRepairable: boolean
    }
  | {
      state: "distribution_pending"
      eventId: string
      relayUrls: string[]
      retainedRelayUrls: string[]
      stale: true
      distributionRepairable: boolean
    }
  | {
      state: "signed_empty"
      eventId: string
      stale: boolean
      distributionRepairable: boolean
      retainedRelayUrls: string[]
    }
  | { state: "not_observed" }
  | {
      state: "malformed"
      eventId: string
      stale: boolean
      distributionRepairable: boolean
      retainedRelayUrls: string[]
    }
  | { state: "lookup_partial" }
  | { state: "lookup_unavailable" }

function projectOwnPrivateMessageRelayReadiness(
  resolution: InboxDeclarationResolution,
  options: {
    sharedPlanRelayUrls?: readonly string[]
    distributionRepairable?: boolean
  } = {}
): OwnPrivateMessageRelayReadiness {
  const sharedPlanRelayUrlSet = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(
      options.sharedPlanRelayUrls ?? sharedInboxDiscoveryRelayUrls()
    )
  )
  const distributionRepairable = options.distributionRepairable ?? false
  switch (resolution.state) {
    case "declared":
      if (!resolution.eventId) return { state: "lookup_unavailable" }
      if (
        !normalizeSecureOrIsolatedE2eRelayUrls(
          resolution.sharedSourceRelayUrls ?? []
        ).some((relayUrl) => sharedPlanRelayUrlSet.has(relayUrl))
      ) {
        return {
          state: "distribution_pending",
          eventId: resolution.eventId,
          relayUrls: resolution.relayUrls,
          retainedRelayUrls: resolution.retainedReadRelayUrls ?? [],
          stale: true,
          distributionRepairable,
        }
      }
      return {
        state: "ready",
        eventId: resolution.eventId,
        relayUrls: resolution.relayUrls,
        stale: resolution.stale,
        distributionRepairable,
      }
    case "distribution_pending":
      if (!resolution.eventId) return { state: "lookup_unavailable" }
      return {
        state: "distribution_pending",
        eventId: resolution.eventId,
        relayUrls: resolution.pendingRelayUrls ?? [],
        retainedRelayUrls: resolution.retainedReadRelayUrls ?? [],
        stale: true,
        distributionRepairable:
          (resolution.pendingPublishRelayUrls?.length ?? 0) > 0 ||
          distributionRepairable,
      }
    case "signed_empty":
      if (!resolution.eventId) return { state: "lookup_unavailable" }
      return {
        state: "signed_empty",
        eventId: resolution.eventId,
        stale: resolution.stale,
        distributionRepairable: false,
        retainedRelayUrls: resolution.retainedReadRelayUrls ?? [],
      }
    case "not_observed":
      return { state: "not_observed" }
    case "malformed":
      if (!resolution.eventId) return { state: "lookup_unavailable" }
      return {
        state: "malformed",
        eventId: resolution.eventId,
        stale: resolution.stale,
        distributionRepairable: false,
        retainedRelayUrls: resolution.retainedReadRelayUrls ?? [],
      }
    case "lookup_partial":
      return { state: "lookup_partial" }
    case "lookup_unavailable":
      return { state: "lookup_unavailable" }
  }
}

/**
 * Send-time owner readiness from durable evidence only. This intentionally
 * performs no relay fanout; the polling hook owns network refreshes.
 */
export async function inspectRetainedOwnPrivateMessageRelayReadiness(
  pubkey: string,
  options: Pick<FetchInboxRelayOptions, "evidenceRepository"> = {}
): Promise<OwnPrivateMessageRelayReadiness> {
  try {
    const resolution = await readRetainedInboxDeclaration(pubkey, options)
    return resolution
      ? projectOwnPrivateMessageRelayReadiness(resolution)
      : { state: "lookup_unavailable" }
  } catch {
    return { state: "lookup_unavailable" }
  }
}

/** Reset the kind-10050 inbox-relay cache (tests). */
export function __resetInboxRelayCache(): void {
  __resetInboxDeclarationCache()
}

/**
 * Adapt the legacy events-only fetch seam (tests) into the diagnostics shape.
 * An events-only fetch cannot report per-relay failure, so it counts as
 * complete coverage - matching the pre-CND-208 behavior of that seam.
 */
function adaptFetchEventsToDiagnostics(
  fetchEvents: typeof fetchPublicEvents
): typeof fetchPublicEventsWithDiagnostics {
  return async (filter, options) => {
    const events = await fetchEvents(filter, options)
    const relayUrls = [...(options?.relayUrls ?? [])]
    return {
      events,
      attemptedRelayUrls: relayUrls,
      successfulRelayUrls: relayUrls.length > 0 ? relayUrls : ["fetch-events"],
      failedRelayUrls: [],
    }
  }
}

function toDeclarationOptions(
  options: FetchInboxRelayOptions
): ResolveInboxDeclarationOptions {
  return {
    fetchEventsWithDiagnostics: options.fetchEvents
      ? adaptFetchEventsToDiagnostics(options.fetchEvents)
      : options.fetchEventsWithDiagnostics,
    relayUrls: options.relayUrls,
    evidenceRepository: options.evidenceRepository,
    requestingAccountPubkey: options.requestingAccountPubkey,
    authenticatedPubkey: options.authenticatedPubkey,
    accountNetworkLocalStateRepository:
      options.accountNetworkLocalStateRepository,
    signal: options.signal,
    shouldContinue: options.shouldContinue,
  }
}

/**
 * Resolve a pubkey's kind-10050 private-message inbox relays. Positive results
 * are cached with bounded freshness; absent declarations and lookup errors
 * remain retryable. Legacy error-throwing wrapper over
 * resolveInboxDeclaration for the send path.
 */
export async function fetchInboxRelayUrls(
  pubkey: string,
  options: FetchInboxRelayOptions = {}
): Promise<string[]> {
  const resolution = await resolveInboxDeclaration(
    pubkey,
    toDeclarationOptions(options)
  )
  switch (resolution.state) {
    case "declared":
      return resolution.relayUrls
    case "distribution_pending":
    case "signed_empty":
    case "not_observed":
    case "malformed":
      return []
    case "lookup_unavailable":
      throw new Error("Private-message relay lookup unavailable")
    case "lookup_partial":
      throw new Error("Private-message relay lookup incomplete")
  }
}

/**
 * Inspect the principal's kind-10050 declaration with typed, retryable
 * outcomes. Lookup failure is distinct from a complete "not declared";
 * a signed-but-unusable declaration is "malformed" (repair in Network).
 */
export async function inspectOwnPrivateMessageRelayReadiness(
  pubkey: string,
  options: FetchInboxRelayOptions = {}
): Promise<OwnPrivateMessageRelayReadiness> {
  const declarationOptions = toDeclarationOptions(options)
  const readPlanRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : sharedInboxDiscoveryRelayUrls()
  )
  const sharedPlanRelayUrls = sharedInboxDiscoveryRelayUrls()
  const resolution = await resolveInboxDeclaration(pubkey, {
    ...declarationOptions,
    // Owner readiness is specifically a cross-client check. A declaration
    // found only on an owner-local relay is not ready for unrelated senders.
    relayUrls: readPlanRelayUrls,
    sharedConfirmationRelayUrls: sharedPlanRelayUrls,
    freshnessMs: 0,
    // The signed relay set is rendered for its authenticated owner, so an
    // intentional local relay remains visible without becoming a peer target.
    allowLocalRelayUrlsForPubkey: pubkey,
    requestingAccountPubkey: pubkey,
    accountNetworkLocalStateRepository:
      options.accountNetworkLocalStateRepository,
  })
  const distributionRepairable = Boolean(
    resolution.stale &&
    resolution.observation?.coverage === "complete" &&
    resolution.observation.eventId === undefined &&
    resolution.eventId
  )
  return projectOwnPrivateMessageRelayReadiness(resolution, {
    sharedPlanRelayUrls,
    distributionRepairable,
  })
}

export function createParticipantMessageRumor(
  input: Omit<BuildDirectMessageRumorInput, "recipientPubkey"> & {
    recipientPubkeys: string[]
  }
): PrivateMessageRumor {
  const participants = [...new Set(input.recipientPubkeys)]
    .filter((p) => p !== input.senderPubkey)
    .sort()
  if (participants.length !== 1) throw new Error("Invalid participant set")
  return createPrivateMessageRumor({
    pubkey: input.senderPubkey,
    kind: 14,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    content: input.content,
    tags: appendConduitClientTag(
      [
        ...participants.map((p) => ["p", p]),
        ...(input.subject ? [["subject", input.subject]] : []),
        ...(input.replyTo ? [["e", input.replyTo, "", "reply"]] : []),
      ],
      input.appId
    ),
  })
}
