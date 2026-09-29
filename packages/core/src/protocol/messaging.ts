import {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKUser,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { buildMerchantOrderReviewUrl } from "../app-links"
import type {
  OrderDeliveryRoute,
  OrderRelayDeliveryRecord,
  OrderRelayDeliveryStatus,
  OrderRelayCompatibilityPlan,
  OrderRelayRoutingAuthority,
} from "../db"
import {
  recordBrowserTelemetryEvent,
  type ConduitTelemetryApp,
} from "../telemetry"
import {
  buildNip17CompatibilityResultTelemetryProperties,
  type Nip17CompatibilityResultTelemetryInput,
} from "../telemetry-event-properties"
import type { InboxDeclarationEvidenceRepository } from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanout,
  fetchEventsFanoutWithDiagnostics,
  getNdk,
  type FetchEventsFanoutOptions,
} from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import {
  filterEligibleAccountRelayUrls,
  normalizeAccountNetworkPubkey,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { parseOrderMessageRumorEvent } from "./orders"
import {
  __resetInboxDeclarationCache,
  publicRelayHintUrls,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  isApprovedCompatibilityOrderRelayPlan,
  selectPrivateMessageDeliveryRoute,
  sharedInboxDiscoveryRelayUrls,
  type DeliveryRouteSelection,
  type InboxDeclarationResolution,
  type PrivateMessageDeliveryRoute,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  publishWithPlanner,
  publishWithPlannerProgressive,
  RelayPublishDiagnosticsError,
  type ProgressivePublishSnapshot,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { getRelayLists } from "./relay-list"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
} from "./relay-settings"
import { waitForVisibleDocument } from "./interactive-signer"
import { createNdkNostrEventSigner } from "./ndk-nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/**
 * Shared private-message boundary (CND-57). Centralizes NIP-17 gift-wrap build,
 * publish, unwrap, and classification so Market/Merchant routes never hand-roll
 * NDK wrap/unwrap logic. See docs/specs/messaging.md and docs/specs/protocol.md.
 *
 * Two conversation types share the same NIP-17 transport, distinguished by the
 * inner rumor kind: kind 14 general direct messages (order-independent, threaded
 * by counterparty) vs kind 16 order-linked messages (threaded by order id).
 */

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
  rumor: NDKEvent
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

export function isOrderCompanionNotificationRumor(rumor: NDKEvent): boolean {
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
  authoritativeOrder: NDKEvent
  senderPubkey: string
  recipientPubkey: string
  buyerIdentityKind: "signed_in" | "guest_ephemeral"
  merchantOrigin: string
}): NDKEvent {
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

  const companion = new NDKEvent()
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
  companion.id = companion.getEventHash()
  return companion
}

/**
 * Issue a one-use compatibility-routing capability bound to one validated
 * kind-16 rumor, order id, sender, and recipient. Relay URLs are deliberately
 * absent: validation can authorize the lane but cannot widen its relay pool.
 */
export function createValidatedOrderRouteScope(input: {
  rumor: NDKEvent
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
  if (
    input.rumor.kind !== EVENT_KINDS.ORDER ||
    !input.rumor.id ||
    input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey ||
    rumorRecipient !== expectedRumorRecipient ||
    (expectedRumorRecipient !== recipientPubkey &&
      recipientPubkey !== senderPubkey) ||
    rumorOrderId !== orderId ||
    classifyLegacyOrderRumor(input.rumor) !== "ok"
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
  authoritativeOrder: NDKEvent
  senderPubkey: string
  recipientPubkey: string
  merchantOrigin: string
}): {
  companion: NDKEvent
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
      rumor: NDKEvent
      category: PrivateMessageCategory
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
  event: NDKEvent,
  signer: NDKSigner
) => Promise<NDKEvent | null>

export interface UnwrapGiftWrapOptions {
  timeoutMs?: number
  /** Replace the default nip44→nip04 attempt (used by tests). */
  giftUnwrap?: GiftUnwrapFn
}

const DEFAULT_UNWRAP_TIMEOUT_MS = 8_000
const UNWRAP_TIMEOUT = Symbol("unwrap_timeout")
const LEGACY_ORDER_MESSAGE_TYPES = new Set([
  "order",
  "payment_request",
  "status_update",
  "shipping_update",
  "receipt",
  "message",
  "payment_proof",
  "organizer_fulfillment_receipt",
  "organizer_fulfillment_revocation",
  "organizer_handoff_ack",
])
const EVENT_MARKET_PRIVATE_MESSAGE_TYPES = new Set([
  "organizer_fulfillment_receipt",
  "organizer_fulfillment_revocation",
  "organizer_handoff_ack",
])

function classifyLegacyOrderRumor(
  rumor: NDKEvent
): "ok" | "ignored" | "malformed" | "deferred_machine" {
  const tags = rumor.tags ?? []
  const typeTags = tags.filter((tag) => tag[0] === "type")
  const orderTags = tags.filter((tag) => tag[0] === "order")
  const recipientTags = tags.filter((tag) => tag[0] === "p")
  const type = typeTags[0]?.[1]
  const orderId = orderTags[0]?.[1]
  const claimRef = tags.find((tag) => tag[0] === "claim")?.[1]
  const recipient = recipientTags[0]?.[1]

  // A checkout recovery rumor contains wallet authority, not a conversation
  // message. Leave its ciphertext for the dedicated strict recovery reader;
  // the generic inbox must neither cache its content nor consume its wrap.
  if (typeTags.some((tag) => tag[1] === "checkout_spark_recovery")) {
    return typeTags.length === 1 &&
      orderTags.length === 1 &&
      recipientTags.length === 1 &&
      orderId &&
      recipient
      ? "deferred_machine"
      : "malformed"
  }

  // Kind 16 is also NIP-18 generic repost. Only a positively identified
  // Conduit legacy commerce envelope enters the order parser.
  if (!type && !orderId && !claimRef) return "ignored"
  if (
    !type ||
    !recipient ||
    (EVENT_MARKET_PRIVATE_MESSAGE_TYPES.has(type) ? !claimRef : !orderId)
  ) {
    return "malformed"
  }
  if (!LEGACY_ORDER_MESSAGE_TYPES.has(type)) return "ignored"
  try {
    const content = JSON.parse(rumor.content) as unknown
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return "malformed"
    }
    if (
      type === "message" &&
      (typeof (content as { note?: unknown }).note !== "string" ||
        !(content as { note: string }).note.trim())
    ) {
      return "malformed"
    }
    parseOrderMessageRumorEvent(rumor)
    return "ok"
  } catch {
    return "malformed"
  }
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
  event: NDKEvent,
  signer: NDKSigner,
  options: UnwrapGiftWrapOptions = {}
): Promise<UnwrapOutcome> {
  const wrapId = event.id
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNWRAP_TIMEOUT_MS

  const runner = (async (): Promise<{
    rumor: NDKEvent | null
    reason: DecryptFailureReason | null
  }> => {
    if (options.giftUnwrap) {
      try {
        const rumor = await options.giftUnwrap(event, signer)
        return { rumor, reason: rumor ? null : "nip44_failed" }
      } catch {
        return { rumor: null, reason: "nip44_failed" }
      }
    }

    try {
      return {
        rumor: await giftUnwrap(event, undefined, signer, "nip44"),
        reason: null,
      }
    } catch {
      return { rumor: null, reason: "nip44_failed" }
    }
  })()

  const raced = await Promise.race([
    runner,
    new Promise<typeof UNWRAP_TIMEOUT>((resolve) =>
      setTimeout(() => resolve(UNWRAP_TIMEOUT), timeoutMs)
    ),
  ])

  if (raced === UNWRAP_TIMEOUT) {
    return { status: "decrypt_failed", wrapId, reason: "timeout" }
  }

  const { rumor, reason } = raced
  if (!rumor) {
    return {
      status: "decrypt_failed",
      wrapId,
      reason: reason ?? "nip44_failed",
    }
  }

  const category = classifyPrivateMessageKind(rumor.kind)
  if (!category) {
    return { status: "ignored", wrapId, kind: rumor.kind }
  }
  if (category === "order") {
    const classification = classifyLegacyOrderRumor(rumor)
    if (classification === "deferred_machine") {
      return { status: "deferred_machine", wrapId, kind: EVENT_KINDS.ORDER }
    }
    if (classification === "ignored") {
      return { status: "ignored", wrapId, kind: rumor.kind }
    }
    if (classification === "malformed") {
      return { status: "decrypt_failed", wrapId, reason: "malformed" }
    }
  }
  return { status: "ok", wrapId, rumor, category }
}

/** Unwrap a batch of gift wraps, capping concurrency per chunk. */
export async function unwrapGiftWraps(
  events: NDKEvent[],
  signer: NDKSigner,
  options: UnwrapGiftWrapOptions = {},
  batchSize = 5
): Promise<UnwrapOutcome[]> {
  const results: UnwrapOutcome[] = []
  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize)
    const batchResults = await Promise.all(
      batch.map((event) => unwrapGiftWrap(event, signer, options))
    )
    results.push(...batchResults)
  }
  return results
}

export interface BuildDirectMessageRumorInput {
  senderPubkey: string
  recipientPubkey: string
  content: string
  appId: ConduitAppId
  subject?: string
  createdAt?: number
}

/** Build an unsigned kind-14 general direct-message rumor (NIP-17). */
export function buildDirectMessageRumor(
  input: BuildDirectMessageRumorInput
): NDKEvent {
  const rumor = new NDKEvent()
  rumor.kind = EVENT_KINDS.DIRECT_MESSAGE
  rumor.pubkey = input.senderPubkey
  rumor.created_at = input.createdAt ?? Math.floor(Date.now() / 1000)
  const tags: string[][] = [["p", input.recipientPubkey]]
  if (input.subject) tags.push(["subject", input.subject])
  rumor.tags = appendConduitClientTag(tags, input.appId)
  rumor.content = input.content
  try {
    rumor.id = rumor.getEventHash()
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

export function createNdkLegacyDmDecrypt(signer: NDKSigner): LegacyDmDecrypt {
  return async (counterpartyPubkey, ciphertext) =>
    await signer.decrypt(
      new NDKUser({ pubkey: counterpartyPubkey }),
      ciphertext,
      "nip04"
    )
}

export async function decryptLegacyDirectMessage(
  event: NDKEvent,
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

  const timeout = Symbol("legacy_dm_timeout")
  try {
    const result = await Promise.race([
      decrypt(counterpartyPubkey, event.content ?? ""),
      new Promise<typeof timeout>((resolve) =>
        setTimeout(
          () => resolve(timeout),
          options.timeoutMs ?? DEFAULT_UNWRAP_TIMEOUT_MS
        )
      ),
    ])
    if (result === timeout) {
      return {
        status: "decrypt_failed",
        failure: { eventId: event.id, reason: "timeout", retryable: true },
      }
    }
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
export function parseDirectMessageRumor(rumor: NDKEvent): ParsedDirectMessage {
  const recipientPubkey =
    (rumor.tags ?? []).find((tag) => tag[0] === "p")?.[1] ?? ""
  return {
    id: rumor.id,
    senderPubkey: rumor.pubkey,
    recipientPubkey,
    content: rumor.content ?? "",
    createdAt: (rumor.created_at ?? 0) * 1000,
    transport: "nip17",
  }
}

export interface PublishPrivateMessageInput {
  /** Caller-built rumor (pubkey stamped); its kind must equal rumorKind. */
  rumor: NDKEvent
  senderPubkey: string
  recipientPubkey: string
  /**
   * Explicit signed-in account whose durable whole-relay exclusions apply to
   * discovery and delivery. Omit for guest/public sends; this is never inferred
   * from the rumor author or recipient.
   */
  accountPubkey?: string | null
  /**
   * Active authenticated account. Owner-selected ws:// authority is granted
   * only when this separately supplied identity, accountPubkey, and the
   * signer-verified sender are the same account.
   */
  authenticatedPubkey?: string | null
  /** Injectable durable-state reader for deterministic eligibility tests. */
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Live caller authority for recipient and sender declaration reads. */
  shouldContinue?: FetchEventsFanoutOptions["shouldContinue"]
  signer: NDKSigner
  rumorKind: typeof EVENT_KINDS.DIRECT_MESSAGE | typeof EVENT_KINDS.ORDER
  /** Wrap a sender self-copy for local recovery. Default true. */
  selfCopy?: boolean
  refreshRelayLists?: boolean
  /** Skip foreground coordination for a caller-owned ephemeral guest signer. */
  signerInteraction?: "external" | "background_external" | "application_owned"
  /** External account method eligible to answer a foreground NIP-42 challenge. */
  relayAuthMethod?: "nip07" | "nip46"
  /** Controlled visibility seam for interactive external signer workflows. */
  waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  giftWrapFn?: typeof giftWrap
  /**
   * Durable exact-retry seam. Runs after wrapping and before the first relay
   * write; callers may persist the signed ciphertext wraps, never plaintext.
   */
  onWrapped?: (prepared: PreparedPrivateMessageWraps) => void | Promise<void>
  /** Persist the exact merchant wrap and signed route before relay I/O. */
  onRecipientPrepared?: (
    prepared: PreparedPrivateMessageRecipientDelivery
  ) => void | Promise<void>
  /** Commit the attempt fence immediately before recipient relay I/O. */
  onRecipientPublishStarting?: (
    prepared: PreparedPrivateMessageRecipientDelivery
  ) => void | Promise<void>
  /**
   * Persist the first positive recipient relay ACK before an accepted-boundary
   * send may return to its caller.
   */
  onRecipientPublishAccepted?: (
    delivery: ProgressivePublishSnapshot
  ) => void | Promise<void>
  /** Persist terminal outcomes from the current recipient publish batch. */
  onRecipientPublishSettled?: (
    delivery: PublishWithPlannerResult | null
  ) => void | Promise<void>
  /**
   * Recipient/sender kind-10050 inbox relays. NIP-17 delivery is exclusive to
   * these declarations; an empty recipient list means the peer is not ready.
   */
  recipientInboxRelays?: readonly string[]
  senderInboxRelays?: readonly string[]
  /**
   * Legacy string[]-or-throw kind-10050 resolver seam (tests). This seam
   * cannot express a malformed declaration; when omitted, the typed
   * resolveInboxDeclaration path is used instead.
   */
  resolveInboxRelays?: (pubkey: string) => Promise<string[]>
  /** Controlled readiness seam for the sender-side kind-14 safety gate. */
  inspectOwnInboxReadiness?: (
    pubkey: string
  ) => Promise<OwnPrivateMessageRelayReadiness>
  /**
   * One-use capability for a recipient-only guest-order notification. It may
   * skip sender readiness, but cannot bypass recipient declaration routing.
   */
  validatedGuestOrderCompanionScope?: ValidatedGuestOrderCompanionScope
  /** Injectable relay publisher for focused transport tests. */
  publishFn?: typeof publishWithPlanner
  /**
   * Opt-in completion boundary for a durably staged initial order. All other
   * private messages retain the settled boundary.
   */
  recipientDeliveryBoundary?: "settled" | "accepted"
  /** Injectable progressive publisher for deterministic milestone tests. */
  publishProgressiveFn?: typeof publishWithPlannerProgressive
  /**
   * One-use capability for a validated kind-16 order lifecycle send (locally created
   * checkout/order or a validated inbound order with matching order identity
   * and counterparty). Enables the temporary compatibility order route
   * when the recipient has no usable declaration and the redeploy-controlled
   * flag is on. Kind-14 general DMs must not set this.
   */
  validatedOrderScope?: ValidatedOrderRouteScope
  /**
   * Override the compatibility lane gate and registry (tests/config seams).
   * Defaults to the repo-controlled deployment profile and
   * config.dmCompatibilityOrderRelayUrls.
   */
  compatibilityOrderRoute?: {
    enabled?: boolean
    relayUrls?: readonly string[]
    maxRelays?: number
  }
  /** Test seam for recipient-specific, signed NIP-65 read evidence. */
  resolveCompatibilityRecipientReadRelays?: (
    pubkey: string
  ) => Promise<readonly string[]>
  /** Browser app emitting the fixed-label compatibility rollout counter. */
  telemetryApp?: ConduitTelemetryApp
  /** Content-free test/adapter seam; exceptions are ignored. */
  onNip17CompatibilityOutcome?: (
    outcome: Nip17CompatibilityResultTelemetryInput
  ) => void
}

function assertPrivateMessageSignerSessionCurrent(
  shouldContinue: (() => boolean) | undefined
): void {
  if (shouldContinue?.() === false) {
    throw new Error("Private message signer session changed.")
  }
}

function createInteractionGatedSigner(
  signer: NDKSigner,
  waitForSignerVisibility: (() => Promise<void>) | undefined,
  shouldContinue: (() => boolean) | undefined
): NDKSigner {
  const beforeSignerOperation = async () => {
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
    await waitForSignerVisibility?.()
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
  }
  const afterSignerOperation = () => {
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
  }

  return new Proxy(signer, {
    get(target, property) {
      if (property === "user") {
        return async (...args: Parameters<NDKSigner["user"]>) => {
          await beforeSignerOperation()
          const result = await target.user(...args)
          afterSignerOperation()
          return result
        }
      }
      if (property === "sign") {
        return async (...args: Parameters<NDKSigner["sign"]>) => {
          await beforeSignerOperation()
          const result = await target.sign(...args)
          afterSignerOperation()
          return result
        }
      }
      if (property === "encrypt") {
        return async (...args: Parameters<NDKSigner["encrypt"]>) => {
          await beforeSignerOperation()
          const result = await target.encrypt(...args)
          afterSignerOperation()
          return result
        }
      }

      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export interface PreparedPrivateMessageWraps {
  rumorId: string
  wrappedToRecipient: NDKEvent
  wrappedToSelf: NDKEvent | null
}

export interface PreparedPrivateMessageRecipientDelivery {
  rumorId: string
  wrappedToRecipient: NDKEvent
  deliveryRoute: OrderDeliveryRoute
  routingAuthority?: OrderRelayRoutingAuthority
  compatibilityPlan?: OrderRelayCompatibilityPlan
  relayPlan: Array<{
    relayUrl: string
    source: "declared" | "recipient_nip65" | "compatibility_registry"
  }>
}

export interface PublishPrivateMessageResult {
  wrappedToRecipient: NDKEvent
  wrappedToSelf: NDKEvent | null
  /** Exact content-free planner result for the self-copy leg, when attempted. */
  selfDelivery: PublishWithPlannerResult | null
  /** Exact ACK completeness for the attempted self-copy leg. */
  selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null
  /** Non-null when the non-critical self-copy leg needs retry. */
  selfCopyError: string | null
  /** Lane used for the critical recipient leg. */
  deliveryRoute: Exclude<PrivateMessageDeliveryRoute, "blocked">
  /** Full per-relay result for the critical recipient leg. */
  recipientDelivery: Awaited<ReturnType<typeof publishWithPlanner>>
  deliveryStatus: "full_success" | "partial_success"
  deliveryRelaySources: DeliveryRouteSelection["relaySources"]
  deliveryPlanTruncated: boolean
  /** Present for a real signed kind-16 recipient wrap; content-safe and local. */
  orderRelayDelivery?: OrderRelayDeliveryRecord
  /**
   * Memoized, caller-started recovery work for an accepted initial order.
   * It never creates or republishes the semantic merchant order.
   */
  startPostAcceptanceWork?: () => Promise<PrivateMessagePostAcceptanceResult>
}

export interface PrivateMessagePostAcceptanceResult {
  wrappedToSelf: NDKEvent | null
  selfDelivery: PublishWithPlannerResult | null
  selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null
  selfCopyError: string | null
}

export type PrivateMessageSelfDeliveryStatus =
  "zero_success" | "partial_success" | "full_success"

export function summarizePrivateMessageSelfDelivery(
  delivery: PublishWithPlannerResult
): {
  status: PrivateMessageSelfDeliveryStatus
  error: string | null
} {
  if (
    Array.isArray(delivery.successfulRelayUrls) &&
    delivery.successfulRelayUrls.length === 0
  ) {
    return {
      status: "zero_success",
      error: "Sender self-copy received no relay ACK.",
    }
  }
  if (
    Array.isArray(delivery.failedRelayUrls) &&
    delivery.failedRelayUrls.length > 0
  ) {
    return {
      status: "partial_success",
      error: "Sender self-copy reached only part of its inbox relay set.",
    }
  }
  return { status: "full_success", error: null }
}

function recoverPartialRelayPublishDiagnostics(
  error: unknown
): PublishWithPlannerResult | null {
  return error instanceof RelayPublishDiagnosticsError &&
    error.diagnostics.successfulRelayUrls.length > 0
    ? error.diagnostics
    : null
}

function isCanonicalInitialOrderRumor(rumor: NDKEvent): boolean {
  const typeTags = rumor.tags.filter((tag) => tag[0] === "type")
  return typeTags.length === 1 && typeTags[0]?.[1] === "order"
}

function clonePrivateMessageRumor(rumor: NDKEvent): NDKEvent {
  return new NDKEvent(rumor.ndk, {
    kind: rumor.kind,
    id: rumor.id,
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    tags: rumor.tags.map((tag) => [...tag]),
    content: rumor.content,
    sig: "",
  })
}

const ORDER_RELAY_RETRY_RETENTION_MS = 24 * 60 * 60 * 1_000

export type PrivateMessageRelayReadinessReason =
  | "sender_not_ready"
  | "recipient_not_ready"
  | "recipient_relays_excluded"
  | "recipient_lookup_failed"
  | "recipient_declaration_distribution_pending"
  | "recipient_declaration_signed_empty"
  | "recipient_declaration_malformed"

const READINESS_MESSAGES: Record<PrivateMessageRelayReadinessReason, string> = {
  sender_not_ready:
    "Your current NIP-17 inbox declaration is not ready for direct messages.",
  recipient_not_ready:
    "No usable recipient NIP-17 inbox declaration was found on the relays checked.",
  recipient_relays_excluded:
    "Recipient inbox relays are excluded by your Network settings.",
  recipient_lookup_failed: "Recipient inbox relay discovery failed.",
  recipient_declaration_distribution_pending:
    "Recipient inbox declaration has not been confirmed on discovery relays.",
  recipient_declaration_signed_empty:
    "Recipient's signed inbox declaration lists no relays.",
  recipient_declaration_malformed:
    "Recipient inbox relay declaration is unusable.",
}

export class PrivateMessageRelayReadinessError extends Error {
  readonly reason: PrivateMessageRelayReadinessReason

  constructor(reason: PrivateMessageRelayReadinessReason) {
    super(READINESS_MESSAGES[reason])
    this.name = "PrivateMessageRelayReadinessError"
    this.reason = reason
  }
}

function recordValidatedOrderCompatibilityOutcome(
  input: PublishPrivateMessageInput,
  validatedOrder: boolean,
  outcome: Pick<
    Nip17CompatibilityResultTelemetryInput,
    "declarationClass" | "deliveryRoute" | "ackOutcome"
  > & {
    blockReason?: Nip17CompatibilityResultTelemetryInput["blockReason"]
  }
): void {
  if (!validatedOrder || input.shouldContinue?.() === false) return
  const telemetryOutcome: Nip17CompatibilityResultTelemetryInput = {
    ...outcome,
    action: "order_delivery",
    repairOutcome: "not_applicable",
    blockReason: outcome.blockReason ?? "not_applicable",
  }
  try {
    input.onNip17CompatibilityOutcome?.(telemetryOutcome)
  } catch {
    // Diagnostics are best-effort and must never affect message delivery.
  }
  if (!input.telemetryApp) return
  recordBrowserTelemetryEvent({
    app: input.telemetryApp,
    eventName: "nip17_compatibility_result",
    properties:
      buildNip17CompatibilityResultTelemetryProperties(telemetryOutcome),
  })
}

function buildRecoverableRecipientRoutingAuthority(input: {
  recipientPubkey: string
  declaration: InboxDeclarationResolution
  route: DeliveryRouteSelection
}): OrderRelayRoutingAuthority | null {
  const eventId = input.declaration.eventId?.trim().toLowerCase()
  const eventCreatedAt = input.declaration.eventCreatedAt
  const pubkey = input.recipientPubkey.trim().toLowerCase()
  if (
    input.route.route !== "declared_inbox" ||
    input.declaration.state !== "declared" ||
    !eventId ||
    !/^[0-9a-f]{64}$/.test(eventId) ||
    !Number.isSafeInteger(eventCreatedAt) ||
    (eventCreatedAt ?? -1) < 0 ||
    input.route.relayUrls.length === 0 ||
    input.route.relayUrls.some(
      (relayUrl) => input.route.relaySources[relayUrl] !== "declared"
    )
  ) {
    return null
  }

  return {
    eventId,
    eventCreatedAt: eventCreatedAt!,
    pubkey,
    kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
    relayUrls: [...input.route.relayUrls],
  }
}

/**
 * Gift-wrap a rumor to the recipient (critical) and optionally to the sender as
 * a self-copy (non-critical), publishing both through the shared relay planner.
 * Kind 14 and kind 16 sends share this primitive; the caller owns local caching.
 */
export async function publishPrivateMessage(
  input: PublishPrivateMessageInput
): Promise<PublishPrivateMessageResult> {
  if (input.rumor.kind !== input.rumorKind) {
    throw new Error("Private message rumor kind does not match requested kind")
  }

  const senderPubkey = input.senderPubkey.trim().toLowerCase()
  const recipientPubkey = input.recipientPubkey.trim().toLowerCase()
  let accountPubkey: string | null = null
  if (input.accountPubkey !== undefined && input.accountPubkey !== null) {
    accountPubkey = normalizeAccountNetworkPubkey(input.accountPubkey)
    if (!accountPubkey) {
      throw new Error("Private message account pubkey is invalid")
    }
    if (accountPubkey !== senderPubkey) {
      throw new Error("Private message account does not match sender")
    }
  }
  if (input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey) {
    throw new Error("Private message rumor author does not match sender")
  }
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  const signerPubkey = (await input.signer.user()).pubkey.trim().toLowerCase()
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  if (signerPubkey !== senderPubkey) {
    throw new Error("Private message signer does not match sender")
  }
  const suppliedAuthenticatedPubkey = input.authenticatedPubkey
    ? normalizeAccountNetworkPubkey(input.authenticatedPubkey)
    : null
  const authenticatedOwnerPubkey =
    accountPubkey &&
    suppliedAuthenticatedPubkey === accountPubkey &&
    signerPubkey === accountPubkey
      ? accountPubkey
      : null
  if (
    recipientPubkey !== senderPubkey &&
    !input.rumor.tags.some(
      (tag) =>
        tag[0] === "p" && tag[1]?.trim().toLowerCase() === recipientPubkey
    )
  ) {
    throw new Error(
      "Private message rumor recipient does not match delivery recipient"
    )
  }

  const giftWrapFn = input.giftWrapFn ?? giftWrap
  const selfCopy = input.selfCopy ?? true
  const refreshRelayLists = input.refreshRelayLists ?? true
  const wrapParams = { rumorKind: input.rumorKind }
  const publishFn = input.publishFn ?? publishWithPlanner
  const publishProgressiveFn =
    input.publishProgressiveFn ?? publishWithPlannerProgressive
  const validatedGuestOrderCompanion = consumeValidatedGuestOrderCompanionScope(
    {
      scope: input.validatedGuestOrderCompanionScope,
      rumor: input.rumor,
      senderPubkey,
      recipientPubkey,
      selfCopy,
    }
  )

  // NIP-17 delivery is exclusive to the recipient's declared inbox. The only
  // exception is the temporary compatibility route for validated kind-16
  // order traffic (CND-208); a valid declaration always outranks it.
  const validatedOrder = consumeValidatedOrderRouteScope({
    scope: input.validatedOrderScope,
    rumor: input.rumor,
    senderPubkey,
    recipientPubkey,
  })
  const progressiveRecipientDelivery =
    input.recipientDeliveryBoundary === "accepted"
  if (
    progressiveRecipientDelivery &&
    (!validatedOrder ||
      !isCanonicalInitialOrderRumor(input.rumor) ||
      !input.onRecipientPrepared ||
      !input.onRecipientPublishStarting ||
      !input.onRecipientPublishAccepted ||
      !input.onRecipientPublishSettled)
  ) {
    throw new Error(
      "Accepted delivery requires a durably staged initial order send."
    )
  }
  const resolvedRecipientDeclaration = await resolveDeclarationForSend(
    input.recipientPubkey,
    input.recipientInboxRelays,
    input.resolveInboxRelays,
    false,
    accountPubkey,
    authenticatedOwnerPubkey,
    input.accountNetworkLocalStateRepository,
    input.shouldContinue
  )
  const recipientDeclaration = await applyAccountRelayEligibilityToDeclaration(
    resolvedRecipientDeclaration,
    accountPubkey,
    authenticatedOwnerPubkey,
    input.accountNetworkLocalStateRepository
  )
  if (
    resolvedRecipientDeclaration.state === "declared" &&
    resolvedRecipientDeclaration.relayUrls.length > 0 &&
    recipientDeclaration.relayUrls.length === 0
  ) {
    // Keep a valid kind:10050 declaration authoritative even when local policy
    // excludes every target. Do not reinterpret it as missing and activate the
    // non-standard compatibility lane.
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: "declared",
      deliveryRoute: "blocked",
      ackOutcome: "not_applicable",
      blockReason: "recipient_relays_excluded",
    })
    throw new PrivateMessageRelayReadinessError("recipient_relays_excluded")
  }
  const compatibilityRecipientReadRelays =
    validatedOrder && recipientDeclaration.state !== "declared"
      ? await resolveCompatibilityRecipientReadRelays(
          input.recipientPubkey,
          input.resolveCompatibilityRecipientReadRelays
        )
      : []
  const recipientRoute = selectPrivateMessageDeliveryRoute({
    rumorKind: input.rumorKind,
    declaration: recipientDeclaration,
    validatedOrder,
    compatibilityEnabled: input.compatibilityOrderRoute?.enabled,
    compatibilityRelayUrls: input.compatibilityOrderRoute?.relayUrls,
    recipientReadRelayUrls: compatibilityRecipientReadRelays,
    maxCompatibilityRelays: input.compatibilityOrderRoute?.maxRelays,
  })
  if (recipientRoute.route === "blocked") {
    const readinessReason: PrivateMessageRelayReadinessReason =
      recipientRoute.blockedReason === "declaration_malformed"
        ? "recipient_declaration_malformed"
        : recipientRoute.blockedReason === "declaration_signed_empty"
          ? "recipient_declaration_signed_empty"
          : recipientRoute.blockedReason === "declaration_distribution_pending"
            ? "recipient_declaration_distribution_pending"
            : (recipientRoute.blockedReason ?? "recipient_not_ready")
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: "blocked",
      ackOutcome: "not_applicable",
      blockReason: readinessReason,
    })
    throw new PrivateMessageRelayReadinessError(readinessReason)
  }
  const recoverableRoutingAuthority = buildRecoverableRecipientRoutingAuthority(
    {
      recipientPubkey,
      declaration: recipientDeclaration,
      route: recipientRoute,
    }
  )
  const recoverableCompatibilityPlan =
    validatedOrder &&
    recipientRoute.route === "compatibility_order" &&
    isApprovedCompatibilityOrderRelayPlan(recipientRoute.relayUrls)
      ? { relayUrls: [...recipientRoute.relayUrls] }
      : null
  const recoverableDeliveryRequested = Boolean(
    input.onRecipientPrepared ||
    input.onRecipientPublishStarting ||
    input.onRecipientPublishSettled
  )
  if (
    recoverableDeliveryRequested &&
    !recoverableRoutingAuthority &&
    !recoverableCompatibilityPlan
  ) {
    throw new Error(
      "Recoverable order delivery requires a validated recipient relay plan."
    )
  }

  const resolveSenderRoute = async (): Promise<ReturnType<
    typeof selectPrivateMessageDeliveryRoute
  > | null> => {
    if (
      input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE &&
      !validatedGuestOrderCompanion
    ) {
      const senderReadiness = await (
        input.inspectOwnInboxReadiness ??
        inspectRetainedOwnPrivateMessageRelayReadiness
      )(senderPubkey)
      if (senderReadiness.state !== "ready") {
        throw new PrivateMessageRelayReadinessError("sender_not_ready")
      }
      const senderRelayUrls = await filterRelayUrlsForAccount(
        senderReadiness.relayUrls,
        accountPubkey,
        authenticatedOwnerPubkey,
        input.accountNetworkLocalStateRepository,
        senderReadiness.relayUrls
      )
      if (senderRelayUrls.length === 0) {
        throw new PrivateMessageRelayReadinessError("sender_not_ready")
      }
      return selectPrivateMessageDeliveryRoute({
        rumorKind: input.rumorKind,
        declaration: {
          pubkey: senderPubkey,
          state: "declared",
          relayUrls: senderRelayUrls,
          stale: senderReadiness.stale,
          fetchedAt: Date.now(),
        },
        validatedOrder: false,
        authenticatedOwnerPubkey,
        ownerSelectedRelayUrls: senderRelayUrls,
      })
    }
    if (!selfCopy) return null

    const senderDeclaration = await resolveDeclarationForSend(
      input.senderPubkey,
      input.senderInboxRelays,
      input.resolveInboxRelays,
      true,
      accountPubkey,
      authenticatedOwnerPubkey,
      input.accountNetworkLocalStateRepository,
      input.shouldContinue
    )
    // The compatibility lane is recipient-only: the non-critical sender self-copy
    // stays strict and fails soft instead of writing to compatibility relays.
    return selectPrivateMessageDeliveryRoute({
      rumorKind: input.rumorKind,
      declaration: senderDeclaration,
      validatedOrder: false,
      authenticatedOwnerPubkey,
      ownerSelectedRelayUrls: senderDeclaration.relayUrls,
    })
  }
  const senderRoute: ReturnType<
    typeof selectPrivateMessageDeliveryRoute
  > | null = progressiveRecipientDelivery ? null : await resolveSenderRoute()

  // NDK's giftWrap builds and encrypts the seal from rumor.ndk. Attach the
  // shared instance before wrapping; attaching only at publish time is too late.
  input.rumor.ndk ??= getNdk()
  const externalSignerInteraction =
    (input.signerInteraction ?? "background_external") === "external"
  const waitForSignerVisibility =
    input.waitForSignerVisibility ??
    ((signal?: AbortSignal) => waitForVisibleDocument(undefined, signal))
  const giftWrapSigner =
    externalSignerInteraction || input.shouldContinue
      ? createInteractionGatedSigner(
          input.signer,
          externalSignerInteraction
            ? () => waitForSignerVisibility()
            : undefined,
          input.shouldContinue
        )
      : input.signer
  const relayAuthentication =
    externalSignerInteraction &&
    authenticatedOwnerPubkey &&
    input.relayAuthMethod
      ? {
          expectedPubkey: authenticatedOwnerPubkey,
          signer: createNdkNostrEventSigner(
            input.signer,
            authenticatedOwnerPubkey,
            input.relayAuthMethod
          ),
          sessionScope: input.signer,
          waitForSignerVisibility,
        }
      : undefined

  let wrappedToRecipient: NDKEvent
  try {
    wrappedToRecipient = await giftWrapFn(
      input.rumor,
      new NDKUser({ pubkey: input.recipientPubkey }),
      giftWrapSigner,
      wrapParams
    )
  } catch (error) {
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: recipientRoute.route,
      ackOutcome: "unavailable",
    })
    throw error
  }
  const preparedRecipientDelivery: PreparedPrivateMessageRecipientDelivery | null =
    recoverableRoutingAuthority || recoverableCompatibilityPlan
      ? {
          rumorId: input.rumor.id,
          wrappedToRecipient,
          deliveryRoute: recipientRoute.route as OrderDeliveryRoute,
          ...(recoverableRoutingAuthority
            ? { routingAuthority: recoverableRoutingAuthority }
            : {}),
          ...(recoverableCompatibilityPlan
            ? { compatibilityPlan: recoverableCompatibilityPlan }
            : {}),
          relayPlan: recipientRoute.relayUrls.map((relayUrl) => ({
            relayUrl,
            source: recipientRoute.relaySources[relayUrl] ?? "declared",
          })),
        }
      : null
  if (preparedRecipientDelivery) {
    await input.onRecipientPrepared?.(preparedRecipientDelivery)
  }

  const recipientPublishInput = {
    intent: "recipient_event" as const,
    authorPubkey: input.senderPubkey,
    authenticatedPubkey: authenticatedOwnerPubkey,
    recipientPubkeys: [input.recipientPubkey],
    exclusiveRelayUrls: recipientRoute.relayUrls,
    appRelayUrls:
      recipientRoute.route === "compatibility_order"
        ? recipientRoute.relayUrls
        : [],
    personalRelayUrls: [],
    independentRelayUrls:
      recipientRoute.route === "compatibility_order"
        ? []
        : recipientRoute.relayUrls,
    shouldContinue: input.shouldContinue,
    refreshRelayLists,
    deliveryMode: "critical" as const,
    ...(relayAuthentication ? { relayAuthentication } : {}),
    ...(accountPubkey
      ? {
          accountPubkey,
          ...(input.accountNetworkLocalStateRepository
            ? {
                accountNetworkLocalStateRepository:
                  input.accountNetworkLocalStateRepository,
              }
            : {}),
        }
      : {}),
  }

  if (progressiveRecipientDelivery) {
    if (!preparedRecipientDelivery) {
      throw new Error("Accepted delivery requires a staged recipient wrap.")
    }
    await input.onWrapped?.({
      rumorId: input.rumor.id,
      wrappedToRecipient,
      wrappedToSelf: null,
    })
    await input.onRecipientPublishStarting?.(preparedRecipientDelivery)
    const milestones = await publishProgressiveFn(
      wrappedToRecipient,
      recipientPublishInput
    )
    const settledOutcome = milestones.settled.then(async (snapshot) => {
      try {
        await input.onRecipientPublishSettled?.(snapshot)
        return { snapshot, persistenceError: null }
      } catch (error) {
        console.warn("Failed to persist final private-message relay outcomes", {
          attemptedRelayCount: snapshot.attemptedRelayUrls.length,
          successfulRelayCount: snapshot.successfulRelayUrls.length,
        })
        return { snapshot, persistenceError: error }
      }
    })

    let recipientDelivery: ProgressivePublishSnapshot
    try {
      recipientDelivery = await milestones.accepted
    } catch (error) {
      const final = await settledOutcome
      if (final.persistenceError) throw final.persistenceError
      throw error
    }
    try {
      await input.onRecipientPublishAccepted?.(recipientDelivery)
    } catch (error) {
      // If the first-ACK transaction failed, let the all-relay transaction
      // finish before the caller re-reads durable state. Checkout may advance
      // only if that durable read proves an ACK was committed.
      await settledOutcome
      throw error
    }

    const deliveryStatus =
      recipientDelivery.failedRelayUrls.length > 0 ||
      recipientDelivery.pendingRelayUrls.length > 0
        ? "partial_success"
        : "full_success"
    const orderRelayDelivery = buildOrderRelayDeliveryRecord({
      rumorId: input.rumor.id,
      wrappedToRecipient,
      recipientRoute,
      recipientDelivery,
      routingAuthority: recoverableRoutingAuthority,
      compatibilityPlan: recoverableCompatibilityPlan,
    })
    const stableRumor = clonePrivateMessageRumor(input.rumor)
    let postAcceptanceWork: Promise<PrivateMessagePostAcceptanceResult> | null =
      null
    const startPostAcceptanceWork = () => {
      postAcceptanceWork ??= (async () => {
        let selfCopyError: string | null = null
        let selfDelivery: PublishWithPlannerResult | null = null
        let selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null = null
        let wrappedToSelf: NDKEvent | null = null
        if (!selfCopy) {
          return {
            wrappedToSelf,
            selfDelivery,
            selfDeliveryStatus,
            selfCopyError,
          }
        }
        try {
          if (input.shouldContinue?.() === false) {
            throw new Error(
              "Sender self-copy stopped because the signer session changed."
            )
          }
          const currentSenderRoute = await resolveSenderRoute()
          if (!currentSenderRoute || currentSenderRoute.route === "blocked") {
            throw new Error(
              "Sender has no usable NIP-17 inbox relay declaration."
            )
          }
          if (input.shouldContinue?.() === false) {
            throw new Error(
              "Sender self-copy stopped because the signer session changed."
            )
          }
          wrappedToSelf = await giftWrapFn(
            stableRumor,
            new NDKUser({ pubkey: input.senderPubkey }),
            giftWrapSigner,
            wrapParams
          )
          if (input.shouldContinue?.() === false) {
            throw new Error(
              "Sender self-copy stopped because the signer session changed."
            )
          }
          try {
            selfDelivery = await publishFn(wrappedToSelf, {
              intent: "recipient_event",
              authorPubkey: input.senderPubkey,
              authenticatedPubkey: authenticatedOwnerPubkey,
              recipientPubkeys: [input.senderPubkey],
              exclusiveRelayUrls: currentSenderRoute.relayUrls,
              ownerSelectedRelayUrls: currentSenderRoute.ownerSelectedRelayUrls,
              shouldContinue: input.shouldContinue,
              refreshRelayLists,
              deliveryMode: "critical",
              ...(accountPubkey
                ? {
                    accountPubkey,
                    ...(input.accountNetworkLocalStateRepository
                      ? {
                          accountNetworkLocalStateRepository:
                            input.accountNetworkLocalStateRepository,
                        }
                      : {}),
                  }
                : {}),
            })
          } catch (error) {
            const partial = recoverPartialRelayPublishDiagnostics(error)
            if (!partial) throw error
            selfDelivery = partial
          }
          const summary = summarizePrivateMessageSelfDelivery(selfDelivery)
          selfDeliveryStatus = summary.status
          selfCopyError = summary.error
        } catch (error) {
          selfCopyError =
            error instanceof Error ? error.message : "Self-copy failed"
        }
        return {
          wrappedToSelf,
          selfDelivery,
          selfDeliveryStatus,
          selfCopyError,
        }
      })()
      return postAcceptanceWork
    }

    return {
      wrappedToRecipient,
      wrappedToSelf: null,
      selfDelivery: null,
      selfDeliveryStatus: null,
      selfCopyError: null,
      deliveryRoute: recipientRoute.route,
      recipientDelivery,
      deliveryStatus,
      deliveryRelaySources: recipientRoute.relaySources,
      deliveryPlanTruncated: recipientRoute.truncated,
      orderRelayDelivery,
      startPostAcceptanceWork,
    }
  }

  // The self-copy is a non-critical local-recovery leg: a signer failure while
  // wrapping it must never block the critical recipient delivery below.
  let selfCopyError: string | null = null
  let selfDelivery: PublishWithPlannerResult | null = null
  let selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null = null
  let wrappedToSelf: NDKEvent | null = null
  if (selfCopy) {
    try {
      wrappedToSelf = await giftWrapFn(
        input.rumor,
        new NDKUser({ pubkey: input.senderPubkey }),
        giftWrapSigner,
        wrapParams
      )
    } catch (error) {
      selfCopyError =
        error instanceof Error ? error.message : "Self-copy wrap failed"
    }
  }

  try {
    await input.onWrapped?.({
      rumorId: input.rumor.id,
      wrappedToRecipient,
      wrappedToSelf,
    })
  } catch (error) {
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: recipientRoute.route,
      ackOutcome: "unavailable",
    })
    throw error
  }

  let recipientDelivery: PublishWithPlannerResult
  let recipientDeliveryReported = false
  if (preparedRecipientDelivery) {
    await input.onRecipientPublishStarting?.(preparedRecipientDelivery)
  }
  try {
    recipientDelivery = await publishFn(wrappedToRecipient, {
      intent: "recipient_event",
      authorPubkey: input.senderPubkey,
      authenticatedPubkey: authenticatedOwnerPubkey,
      recipientPubkeys: [input.recipientPubkey],
      exclusiveRelayUrls: recipientRoute.relayUrls,
      appRelayUrls:
        recipientRoute.route === "compatibility_order"
          ? recipientRoute.relayUrls
          : [],
      personalRelayUrls: [],
      independentRelayUrls:
        recipientRoute.route === "compatibility_order"
          ? []
          : recipientRoute.relayUrls,
      shouldContinue: input.shouldContinue,
      refreshRelayLists,
      deliveryMode: "critical",
      ...(relayAuthentication ? { relayAuthentication } : {}),
      ...(accountPubkey
        ? {
            accountPubkey,
            ...(input.accountNetworkLocalStateRepository
              ? {
                  accountNetworkLocalStateRepository:
                    input.accountNetworkLocalStateRepository,
                }
              : {}),
          }
        : {}),
    })
  } catch (error) {
    if (preparedRecipientDelivery && input.onRecipientPublishSettled) {
      await input.onRecipientPublishSettled(
        error instanceof RelayPublishDiagnosticsError ? error.diagnostics : null
      )
      recipientDeliveryReported = true
    }
    const partial = recoverPartialRelayPublishDiagnostics(error)
    if (partial) {
      // A planner diagnostic that includes a recipient ACK is durable delivery.
      // The caller's session may have changed while a later target was winding
      // down, but that must not make checkout retry the already accepted order.
      recipientDelivery = partial
    } else {
      const ackOutcome =
        error instanceof RelayPublishDiagnosticsError &&
        error.diagnostics.attemptedRelayUrls.length > 0
          ? "zero"
          : "unavailable"
      recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
        declarationClass: recipientDeclaration.state,
        deliveryRoute: recipientRoute.route,
        ackOutcome,
      })
      throw error
    }
  }
  if (
    preparedRecipientDelivery &&
    input.onRecipientPublishSettled &&
    !recipientDeliveryReported
  ) {
    await input.onRecipientPublishSettled(recipientDelivery)
  }
  if (
    Array.isArray(recipientDelivery.successfulRelayUrls) &&
    recipientDelivery.successfulRelayUrls.length === 0
  ) {
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: recipientRoute.route,
      ackOutcome: "zero",
    })
    throw new Error("Recipient delivery completed without a relay ACK.")
  }
  const deliveryStatus =
    Array.isArray(recipientDelivery.failedRelayUrls) &&
    recipientDelivery.failedRelayUrls.length > 0
      ? "partial_success"
      : "full_success"
  recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
    declarationClass: recipientDeclaration.state,
    deliveryRoute: recipientRoute.route,
    ackOutcome: deliveryStatus === "partial_success" ? "partial" : "positive",
  })
  const orderRelayDelivery =
    input.rumorKind === EVENT_KINDS.ORDER
      ? buildOrderRelayDeliveryRecord({
          rumorId: input.rumor.id,
          wrappedToRecipient,
          recipientRoute,
          recipientDelivery,
          routingAuthority: recoverableRoutingAuthority,
          compatibilityPlan: recoverableCompatibilityPlan,
        })
      : undefined
  const selfCopySessionChangedError =
    "Sender self-copy was skipped because the signer session changed after recipient delivery."

  if (wrappedToSelf) {
    if (!senderRoute || senderRoute.route === "blocked") {
      selfCopyError = "Sender has no usable NIP-17 inbox relay declaration."
    } else if (input.shouldContinue?.() === false) {
      // The critical recipient leg is already committed. A session change must
      // fence off the non-critical self-copy without turning the accepted
      // message into a retryable checkout failure.
      selfCopyError = selfCopySessionChangedError
    } else {
      try {
        try {
          selfDelivery = await publishFn(wrappedToSelf, {
            intent: "recipient_event",
            authorPubkey: input.senderPubkey,
            authenticatedPubkey: authenticatedOwnerPubkey,
            recipientPubkeys: [input.senderPubkey],
            exclusiveRelayUrls: senderRoute.relayUrls,
            appRelayUrls:
              senderRoute.route === "compatibility_order"
                ? senderRoute.relayUrls
                : [],
            personalRelayUrls: [],
            independentRelayUrls:
              senderRoute.route === "compatibility_order"
                ? []
                : senderRoute.relayUrls,
            ownerSelectedRelayUrls: senderRoute.ownerSelectedRelayUrls,
            shouldContinue: input.shouldContinue,
            refreshRelayLists,
            deliveryMode: "critical",
            ...(accountPubkey
              ? {
                  accountPubkey,
                  ...(input.accountNetworkLocalStateRepository
                    ? {
                        accountNetworkLocalStateRepository:
                          input.accountNetworkLocalStateRepository,
                      }
                    : {}),
                }
              : {}),
          })
        } catch (error) {
          if (input.shouldContinue?.() === false) {
            selfCopyError = selfCopySessionChangedError
          } else {
            const partial = recoverPartialRelayPublishDiagnostics(error)
            if (!partial) throw error
            selfDelivery = partial
          }
        }
        if (selfDelivery) {
          const summary = summarizePrivateMessageSelfDelivery(selfDelivery)
          selfDeliveryStatus = summary.status
          selfCopyError = summary.error
        }
      } catch (error) {
        selfCopyError =
          input.shouldContinue?.() === false
            ? selfCopySessionChangedError
            : error instanceof Error
              ? error.message
              : "Self-copy publish failed"
      }
    }
  }

  return {
    wrappedToRecipient,
    wrappedToSelf,
    selfDelivery,
    selfDeliveryStatus,
    selfCopyError,
    deliveryRoute: recipientRoute.route,
    recipientDelivery,
    deliveryStatus,
    deliveryRelaySources: recipientRoute.relaySources,
    deliveryPlanTruncated: recipientRoute.truncated,
    orderRelayDelivery,
  }
}

function consumeValidatedOrderRouteScope(input: {
  scope: ValidatedOrderRouteScope | undefined
  rumor: NDKEvent
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

function consumeValidatedGuestOrderCompanionScope(input: {
  scope: ValidatedGuestOrderCompanionScope | undefined
  rumor: NDKEvent
  senderPubkey: string
  recipientPubkey: string
  selfCopy: boolean
}): boolean {
  const scope = input.scope
  if (!scope || !validatedGuestOrderCompanionScopes.has(scope)) return false
  validatedGuestOrderCompanionScopes.delete(scope)

  let rumorHash: string
  try {
    rumorHash = input.rumor.getEventHash()
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

function buildOrderRelayDeliveryRecord(input: {
  rumorId: string
  wrappedToRecipient: NDKEvent
  recipientRoute: DeliveryRouteSelection
  recipientDelivery:
    Awaited<ReturnType<typeof publishWithPlanner>> | ProgressivePublishSnapshot
  routingAuthority: OrderRelayRoutingAuthority | null
  compatibilityPlan: OrderRelayCompatibilityPlan | null
}): OrderRelayDeliveryRecord | undefined {
  const route = input.recipientRoute.route
  if (
    (route === "declared_inbox" && !input.routingAuthority) ||
    (route === "compatibility_order" && !input.compatibilityPlan) ||
    (route !== "declared_inbox" && route !== "compatibility_order")
  ) {
    return undefined
  }
  let signedRecipientWrap: SignedPublicNostrEvent
  try {
    signedRecipientWrap =
      input.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent
  } catch {
    return undefined
  }
  if (!isValidSignedPublicNostrEvent(signedRecipientWrap)) return undefined

  const now = Date.now()
  const successful = new Set(input.recipientDelivery.successfulRelayUrls ?? [])
  const pending = new Set(
    "pendingRelayUrls" in input.recipientDelivery
      ? input.recipientDelivery.pendingRelayUrls
      : []
  )
  const rejectedRelayUrls = new Set(
    input.recipientDelivery.rejectedRelayUrls ?? []
  )
  const failures = input.recipientDelivery.relayFailureMessages ?? {}
  const relayDelivery = input.recipientRoute.relayUrls.map((relayUrl) => {
    const acked = successful.has(relayUrl)
    const rejected =
      rejectedRelayUrls.has(relayUrl) ||
      /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i.test(
        failures[relayUrl]?.trim() ?? ""
      )
    const status: OrderRelayDeliveryStatus = acked
      ? "acked"
      : pending.has(relayUrl)
        ? "pending"
        : rejected
          ? "rejected"
          : "timed_out"
    return {
      relayUrl,
      source: input.recipientRoute.relaySources[relayUrl] ?? "declared",
      status,
      attemptCount: 1,
      lastAttemptAt: now,
      ...(acked ? { acknowledgedAt: now } : {}),
      ...(rejected ? { rejectedAt: now } : {}),
      ...(!acked && !rejected && !pending.has(relayUrl)
        ? { timedOutAt: now }
        : {}),
    }
  })

  return {
    rumorId: input.rumorId,
    signedRecipientWrap,
    route,
    ...(input.routingAuthority
      ? { routingAuthority: structuredClone(input.routingAuthority) }
      : {}),
    ...(input.compatibilityPlan
      ? { compatibilityPlan: structuredClone(input.compatibilityPlan) }
      : {}),
    relayDelivery,
    deliveryAttemptCount: 1,
    retryCount: 0,
    nextRetryAt: relayDelivery.every((delivery) => delivery.status === "acked")
      ? undefined
      : now + 15_000,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ORDER_RELAY_RETRY_RETENTION_MS,
  }
}

async function resolveCompatibilityRecipientReadRelays(
  pubkey: string,
  seam?: (pubkey: string) => Promise<readonly string[]>
): Promise<readonly string[]> {
  if (seam) return await seam(pubkey)
  try {
    const lists = await getRelayLists([pubkey], { cacheOnly: true })
    return lists.get(pubkey.trim())?.readRelayUrls ?? []
  } catch {
    return []
  }
}

/**
 * Resolve the declaration for one send leg. Precedence: caller-known relays,
 * then the legacy string[] seam (tests), then the typed resolver. The typed
 * default preserves the malformed state so it can block writes.
 */
async function resolveDeclarationForSend(
  pubkey: string,
  knownRelayUrls: readonly string[] | undefined,
  legacySeam: ((pubkey: string) => Promise<string[]>) | undefined,
  allowLocalRelayUrls = false,
  requestingAccountPubkey: string | null = null,
  authenticatedPubkey: string | null = null,
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >,
  shouldContinue?: FetchEventsFanoutOptions["shouldContinue"]
): Promise<InboxDeclarationResolution> {
  const key = pubkey.trim().toLowerCase()
  if (knownRelayUrls) {
    return declarationFromKnownRelays(key, knownRelayUrls, allowLocalRelayUrls)
  }
  if (legacySeam) {
    return resolveDeclarationViaSeam(pubkey, legacySeam, allowLocalRelayUrls)
  }
  return resolveInboxDeclaration(pubkey, {
    allowLocalRelayUrlsForPubkey: allowLocalRelayUrls ? pubkey : null,
    requestingAccountPubkey,
    authenticatedPubkey,
    accountNetworkLocalStateRepository,
    shouldContinue,
  })
}

async function filterRelayUrlsForAccount(
  relayUrls: readonly string[],
  accountPubkey: string | null,
  authenticatedPubkey: string | null,
  repository?: Pick<AccountNetworkLocalStateRepository, "get">,
  ownerSelectedRelayUrls: readonly string[] = []
): Promise<string[]> {
  return accountPubkey
    ? await filterEligibleAccountRelayUrls({
        accountPubkey,
        authenticatedPubkey,
        candidateRelayUrls: relayUrls,
        ownerSelectedRelayUrls,
        repository,
      })
    : [...relayUrls]
}

async function applyAccountRelayEligibilityToDeclaration(
  declaration: InboxDeclarationResolution,
  accountPubkey: string | null,
  authenticatedPubkey: string | null,
  repository?: Pick<AccountNetworkLocalStateRepository, "get">
): Promise<InboxDeclarationResolution> {
  if (declaration.state !== "declared" || !accountPubkey) return declaration
  return {
    ...declaration,
    relayUrls: await filterRelayUrlsForAccount(
      declaration.relayUrls,
      accountPubkey,
      authenticatedPubkey,
      repository
    ),
  }
}

/**
 * Treat caller-supplied inbox relays as an authoritative declaration state.
 * Owner context may retain explicit ws:// selections; recipient context stays
 * remote-safe. A nonempty unusable list is malformed rather than absent.
 */
function declarationFromKnownRelays(
  pubkey: string,
  relayUrls: readonly string[],
  allowLocalRelayUrls: boolean
): InboxDeclarationResolution {
  const eligible = allowLocalRelayUrls
    ? normalizeOwnerSelectedRelayUrls(relayUrls)
    : publicRelayHintUrls(relayUrls)
  const state =
    eligible.length > 0
      ? "declared"
      : relayUrls.length > 0
        ? "malformed"
        : "not_observed"
  return {
    pubkey,
    state,
    relayUrls: eligible,
    stale: false,
    fetchedAt: Date.now(),
  }
}

/**
 * Adapt the legacy string[]-or-throw inbox resolver seam into the typed
 * declaration model. A thrown "incomplete" lookup maps to lookup_partial;
 * any other failure maps to lookup_unavailable.
 */
async function resolveDeclarationViaSeam(
  pubkey: string,
  resolveInboxRelays: (pubkey: string) => Promise<string[]>,
  allowLocalRelayUrls: boolean
): Promise<InboxDeclarationResolution> {
  const key = pubkey.trim().toLowerCase()
  try {
    const relayUrls = await resolveInboxRelays(pubkey)
    return declarationFromKnownRelays(key, relayUrls, allowLocalRelayUrls)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    return {
      pubkey: key,
      state: message.includes("incomplete")
        ? "lookup_partial"
        : "lookup_unavailable",
      relayUrls: [],
      stale: false,
      fetchedAt: Date.now(),
    }
  }
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
  fetchEvents?: typeof fetchEventsFanout
  fetchEventsWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
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
  shouldContinue?: FetchEventsFanoutOptions["shouldContinue"]
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
  fetchEvents: typeof fetchEventsFanout
): typeof fetchEventsFanoutWithDiagnostics {
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
