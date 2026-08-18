import {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKUser,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { config, type ConduitConfig } from "../config"
import type { OrderRelayDeliveryRecord, OrderRelayDeliveryStatus } from "../db"
import {
  getInboxDeclarationEvidence,
  InboxDeclarationDistributionConflictError,
  stageInboxDeclarationDistribution,
  type InboxDeclarationDistributionRepository,
  type InboxDeclarationEvidenceRepository,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanout,
  fetchEventsFanoutWithDiagnostics,
  getNdk,
} from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { parseOrderMessageRumorEvent } from "./orders"
import {
  __resetInboxDeclarationCache,
  inboxDeclarationPublishRelayUrls,
  primeInboxDeclarationEvidence,
  publicRelayHintUrls,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  secureRelayUrls,
  selectPrivateMessageDeliveryRoute,
  sharedInboxDiscoveryRelayUrls,
  type DeliveryRouteSelection,
  type InboxDeclarationResolution,
  type PrivateMessageDeliveryRoute,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import { publishWithPlanner } from "./relay-publish"
import { getRelayLists, isInsecureRelayUrl } from "./relay-list"
import { tryNormalizeRelayUrl } from "./relay-settings"
import {
  withTransientNip07Retry,
  type TransientNip07RetryOptions,
} from "./signing-retry"
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
}): ValidatedOrderRouteScope {
  const orderId = input.orderId.trim()
  const senderPubkey = input.senderPubkey.trim().toLowerCase()
  const recipientPubkey = input.recipientPubkey.trim().toLowerCase()
  const rumorOrderId = input.rumor.tags.find((tag) => tag[0] === "order")?.[1]
  const rumorRecipient = input.rumor.tags
    .find((tag) => tag[0] === "p")?.[1]
    ?.trim()
    .toLowerCase()
  if (
    input.rumor.kind !== EVENT_KINDS.ORDER ||
    !input.rumor.id ||
    input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey ||
    rumorRecipient !== recipientPubkey ||
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
])

function classifyLegacyOrderRumor(
  rumor: NDKEvent
): "ok" | "ignored" | "malformed" {
  const tags = rumor.tags ?? []
  const type = tags.find((tag) => tag[0] === "type")?.[1]
  const orderId = tags.find((tag) => tag[0] === "order")?.[1]
  const recipient = tags.find((tag) => tag[0] === "p")?.[1]

  // Kind 16 is also NIP-18 generic repost. Only a positively identified
  // Conduit legacy commerce envelope enters the order parser.
  if (!type && !orderId) return "ignored"
  if (!type || !orderId || !recipient) return "malformed"
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
  signer: NDKSigner
  rumorKind: typeof EVENT_KINDS.DIRECT_MESSAGE | typeof EVENT_KINDS.ORDER
  /** Wrap a sender self-copy for local recovery. Default true. */
  selfCopy?: boolean
  refreshRelayLists?: boolean
  retry?: TransientNip07RetryOptions
  giftWrapFn?: typeof giftWrap
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
  /** Injectable relay publisher for focused transport tests. */
  publishFn?: typeof publishWithPlanner
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
}

export interface PublishPrivateMessageResult {
  wrappedToRecipient: NDKEvent
  wrappedToSelf: NDKEvent | null
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
}

const ORDER_RELAY_RETRY_RETENTION_MS = 24 * 60 * 60 * 1_000

export type PrivateMessageRelayReadinessReason =
  | "sender_not_ready"
  | "recipient_not_ready"
  | "recipient_lookup_failed"
  | "recipient_declaration_distribution_pending"
  | "recipient_declaration_signed_empty"
  | "recipient_declaration_malformed"

const READINESS_MESSAGES: Record<PrivateMessageRelayReadinessReason, string> = {
  sender_not_ready:
    "Your current NIP-17 inbox declaration is not ready for direct messages.",
  recipient_not_ready: "Recipient has not declared NIP-17 inbox relays.",
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
  if (input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey) {
    throw new Error("Private message rumor author does not match sender")
  }
  const signerPubkey = (await input.signer.user()).pubkey.trim().toLowerCase()
  if (signerPubkey !== senderPubkey) {
    throw new Error("Private message signer does not match sender")
  }
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

  // NIP-17 delivery is exclusive to the recipient's declared inbox. The only
  // exception is the temporary compatibility route for validated kind-16
  // order traffic (CND-208); a valid declaration always outranks it.
  const validatedOrder = consumeValidatedOrderRouteScope({
    scope: input.validatedOrderScope,
    rumor: input.rumor,
    senderPubkey,
    recipientPubkey,
  })
  const recipientDeclaration = await resolveDeclarationForSend(
    input.recipientPubkey,
    input.recipientInboxRelays,
    input.resolveInboxRelays
  )
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
    throw new PrivateMessageRelayReadinessError(
      recipientRoute.blockedReason === "declaration_malformed"
        ? "recipient_declaration_malformed"
        : recipientRoute.blockedReason === "declaration_signed_empty"
          ? "recipient_declaration_signed_empty"
          : recipientRoute.blockedReason === "declaration_distribution_pending"
            ? "recipient_declaration_distribution_pending"
            : (recipientRoute.blockedReason ?? "recipient_not_ready")
    )
  }

  let senderRoute: ReturnType<typeof selectPrivateMessageDeliveryRoute> | null =
    null
  if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
    const senderReadiness = await (
      input.inspectOwnInboxReadiness ??
      inspectRetainedOwnPrivateMessageRelayReadiness
    )(senderPubkey)
    if (senderReadiness.state !== "ready") {
      throw new PrivateMessageRelayReadinessError("sender_not_ready")
    }
    senderRoute = selectPrivateMessageDeliveryRoute({
      rumorKind: input.rumorKind,
      declaration: {
        pubkey: senderPubkey,
        state: "declared",
        relayUrls: senderReadiness.relayUrls,
        stale: senderReadiness.stale,
        fetchedAt: Date.now(),
      },
      validatedOrder: false,
    })
  } else if (selfCopy) {
    const senderDeclaration = await resolveDeclarationForSend(
      input.senderPubkey,
      input.senderInboxRelays,
      input.resolveInboxRelays,
      true
    )
    // The compatibility lane is recipient-only: the non-critical sender self-copy
    // stays strict and fails soft instead of writing to compatibility relays.
    senderRoute = selectPrivateMessageDeliveryRoute({
      rumorKind: input.rumorKind,
      declaration: senderDeclaration,
      validatedOrder: false,
    })
  }

  // NDK's giftWrap builds and encrypts the seal from rumor.ndk. Attach the
  // shared instance before wrapping; attaching only at publish time is too late.
  input.rumor.ndk ??= getNdk()

  const wrappedToRecipient = await withTransientNip07Retry(
    () =>
      giftWrapFn(
        input.rumor,
        new NDKUser({ pubkey: input.recipientPubkey }),
        input.signer,
        wrapParams
      ),
    input.retry
  )

  // The self-copy is a non-critical local-recovery leg: a signer failure while
  // wrapping it must never block the critical recipient delivery below.
  let selfCopyError: string | null = null
  let wrappedToSelf: NDKEvent | null = null
  if (selfCopy) {
    try {
      wrappedToSelf = await withTransientNip07Retry(
        () =>
          giftWrapFn(
            input.rumor,
            new NDKUser({ pubkey: input.senderPubkey }),
            input.signer,
            wrapParams
          ),
        input.retry
      )
    } catch (error) {
      selfCopyError =
        error instanceof Error ? error.message : "Self-copy wrap failed"
    }
  }

  const recipientDelivery = await publishFn(wrappedToRecipient, {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    authenticatedPubkey: input.senderPubkey,
    recipientPubkeys: [input.recipientPubkey],
    exclusiveRelayUrls: recipientRoute.relayUrls,
    refreshRelayLists,
    deliveryMode: "critical",
  })
  if (
    Array.isArray(recipientDelivery.successfulRelayUrls) &&
    recipientDelivery.successfulRelayUrls.length === 0
  ) {
    throw new Error("Recipient delivery completed without a relay ACK.")
  }
  const deliveryStatus =
    Array.isArray(recipientDelivery.failedRelayUrls) &&
    recipientDelivery.failedRelayUrls.length > 0
      ? "partial_success"
      : "full_success"
  const orderRelayDelivery =
    input.rumorKind === EVENT_KINDS.ORDER
      ? buildOrderRelayDeliveryRecord({
          wrappedToRecipient,
          recipientRoute,
          recipientDelivery,
        })
      : undefined

  if (wrappedToSelf) {
    if (!senderRoute || senderRoute.route === "blocked") {
      selfCopyError = "Sender has no usable NIP-17 inbox relay declaration."
    } else {
      try {
        await publishFn(wrappedToSelf, {
          intent: "recipient_event",
          authorPubkey: input.senderPubkey,
          authenticatedPubkey: input.senderPubkey,
          recipientPubkeys: [input.senderPubkey],
          exclusiveRelayUrls: senderRoute.relayUrls,
          refreshRelayLists,
          deliveryMode: "critical",
        })
      } catch (error) {
        selfCopyError =
          error instanceof Error ? error.message : "Self-copy publish failed"
      }
    }
  }

  return {
    wrappedToRecipient,
    wrappedToSelf,
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

function buildOrderRelayDeliveryRecord(input: {
  wrappedToRecipient: NDKEvent
  recipientRoute: DeliveryRouteSelection
  recipientDelivery: Awaited<ReturnType<typeof publishWithPlanner>>
}): OrderRelayDeliveryRecord | undefined {
  const route = input.recipientRoute.route
  if (route === "blocked") return undefined
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
  const failures = input.recipientDelivery.relayFailureMessages ?? {}
  const relayDelivery = input.recipientRoute.relayUrls.map((relayUrl) => {
    const acked = successful.has(relayUrl)
    const rejected =
      /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i.test(
        failures[relayUrl]?.trim() ?? ""
      )
    const status: OrderRelayDeliveryStatus = acked
      ? "acked"
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
      ...(!acked && !rejected ? { timedOutAt: now } : {}),
    }
  })

  return {
    signedRecipientWrap,
    route,
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
  allowLocalRelayUrls = false
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
  })
}

/**
 * Treat caller-supplied inbox relays as an authoritative declaration state.
 * A nonempty list with no secure relay is a malformed declaration: it must
 * block writes rather than downgrade to "not declared" and compatibility.
 */
function declarationFromKnownRelays(
  pubkey: string,
  relayUrls: readonly string[],
  allowLocalRelayUrls: boolean
): InboxDeclarationResolution {
  const secure = allowLocalRelayUrls
    ? secureRelayUrls(relayUrls)
    : publicRelayHintUrls(relayUrls)
  const state =
    secure.length > 0
      ? "declared"
      : relayUrls.length > 0
        ? "malformed"
        : "not_observed"
  return {
    pubkey,
    state,
    relayUrls: secure,
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
    secureRelayUrls(
      options.sharedPlanRelayUrls ?? sharedInboxDiscoveryRelayUrls()
    )
  )
  const distributionRepairable = options.distributionRepairable ?? false
  switch (resolution.state) {
    case "declared":
      if (!resolution.eventId) return { state: "lookup_unavailable" }
      if (
        !secureRelayUrls(resolution.sharedSourceRelayUrls ?? []).some(
          (relayUrl) => sharedPlanRelayUrlSet.has(relayUrl)
        )
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
  const readPlanRelayUrls = secureRelayUrls(
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

export interface PublishPrivateMessageRelayDeclarationInput {
  pubkey: string
  signer: NDKSigner
  ndk?: ReturnType<typeof getNdk>
  /** Defaults to config.dmInboxDefaultRelayUrls. */
  relayUrls?: readonly string[]
  /** Current durable NIP-01 frontier captured at the explicit action boundary. */
  frontierCreatedAt: number | null
  /** Exact durable frontier reviewed before the explicit signing action. */
  expectedFrontierEventId: string | null
  /** Injectable wall clock in milliseconds (tests). */
  nowMs?: () => number
  relayConfig?: Pick<ConduitConfig, "dmInboxDefaultRelayUrls">
  getSignerPubkey?: (signer: NDKSigner) => Promise<string>
  signFn?: (event: NDKEvent, signer: NDKSigner) => Promise<string>
  getDiscoveryRelayUrls?: () => readonly string[]
  publishFn?: typeof publishWithPlanner
  /** Durable evidence seam (tests/non-browser adapters). */
  evidenceRepository?: InboxDeclarationDistributionRepository
}

export interface RedistributePrivateMessageRelayDeclarationInput {
  pubkey: string
  /** Exact previously validated event; redistribution never signs a replacement. */
  signedEvent: SignedPublicNostrEvent
  ndk?: ReturnType<typeof getNdk>
  getDiscoveryRelayUrls?: () => readonly string[]
  /** Exact durable targets from the first attempt, when one was staged. */
  publishRelayUrls?: readonly string[]
  publishFn?: typeof publishWithPlanner
}

export interface RedistributePrivateMessageRelayDeclarationAcrossPlansInput extends Omit<
  RedistributePrivateMessageRelayDeclarationInput,
  "publishRelayUrls" | "getDiscoveryRelayUrls"
> {
  /** Immutable targets durably recorded before the first attempt. */
  storedPublishRelayUrls: readonly string[]
  /** Current canonical shared-discovery targets used for fresh confirmation. */
  currentSharedRelayUrls: readonly string[]
}

export const MAX_INBOX_DECLARATION_REPAIR_FUTURE_SKEW_SECONDS = 5 * 60

export class InboxDeclarationPublishSafetyError extends Error {
  readonly code = "future_frontier_outside_publish_window" as const
  readonly frontierCreatedAt: number
  readonly nowSeconds: number
  readonly nextEligibleAt: number

  constructor(input: { frontierCreatedAt: number; nowSeconds: number }) {
    super(
      "The retained inbox declaration is too far ahead of this device clock. Check the clock or retry later; no event was signed."
    )
    this.name = "InboxDeclarationPublishSafetyError"
    this.frontierCreatedAt = input.frontierCreatedAt
    this.nowSeconds = input.nowSeconds
    this.nextEligibleAt =
      input.frontierCreatedAt -
      MAX_INBOX_DECLARATION_REPAIR_FUTURE_SKEW_SECONDS +
      1
  }
}

export function selectInboxDeclarationCreatedAt(input: {
  frontierCreatedAt: number | null
  nowMs?: () => number
}): number {
  const nowMs = (input.nowMs ?? Date.now)()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Inbox declaration wall clock must be a valid timestamp")
  }
  const nowSeconds = Math.floor(nowMs / 1_000)
  const frontierCreatedAt = input.frontierCreatedAt
  if (
    frontierCreatedAt !== null &&
    (!Number.isSafeInteger(frontierCreatedAt) || frontierCreatedAt < 0)
  ) {
    throw new Error("Inbox declaration frontier must be a valid timestamp")
  }
  const createdAt =
    frontierCreatedAt === null
      ? nowSeconds
      : Math.max(nowSeconds, frontierCreatedAt + 1)
  if (
    frontierCreatedAt !== null &&
    createdAt > nowSeconds + MAX_INBOX_DECLARATION_REPAIR_FUTURE_SKEW_SECONDS
  ) {
    throw new InboxDeclarationPublishSafetyError({
      frontierCreatedAt,
      nowSeconds,
    })
  }
  return createdAt
}

function requireSecureRelayUrls(
  relayUrls: readonly string[],
  label: string
): string[] {
  if (relayUrls.length === 0) {
    throw new Error(`${label} must include at least one relay URL`)
  }

  const normalizedRelayUrls: string[] = []
  const seen = new Set<string>()
  for (const relayUrl of relayUrls) {
    const normalized = tryNormalizeRelayUrl(relayUrl)
    if (!normalized.ok || isInsecureRelayUrl(normalized.url)) {
      throw new Error(`${label} must contain only secure wss:// relay URLs`)
    }
    if (seen.has(normalized.url)) continue
    seen.add(normalized.url)
    normalizedRelayUrls.push(normalized.url)
  }
  return normalizedRelayUrls
}

/**
 * Explicitly sign and publish the principal's replaceable NIP-17 inbox relay
 * declaration. Callers must invoke this from an intentional signing workflow.
 */
export async function publishPrivateMessageRelayDeclaration(
  input: PublishPrivateMessageRelayDeclarationInput
): Promise<NDKEvent> {
  const relayUrls = requireSecureRelayUrls(
    input.relayUrls ?? (input.relayConfig ?? config).dmInboxDefaultRelayUrls,
    "Private-message relay declaration"
  )
  const discoveryRelayUrls = requireSecureRelayUrls(
    (
      input.getDiscoveryRelayUrls ?? (() => inboxDeclarationPublishRelayUrls())
    )(),
    "Private-message relay discovery targets"
  )
  const durableEvidence = await getInboxDeclarationEvidence(
    input.pubkey,
    input.evidenceRepository
  )
  const durableFrontierEventId = durableEvidence?.current.signedEvent.id ?? null
  if (durableFrontierEventId !== input.expectedFrontierEventId) {
    throw new InboxDeclarationDistributionConflictError()
  }
  const durableFrontierCreatedAt =
    durableEvidence?.current.signedEvent.created_at ?? null
  const effectiveFrontierCreatedAt =
    input.frontierCreatedAt === null
      ? durableFrontierCreatedAt
      : durableFrontierCreatedAt === null
        ? input.frontierCreatedAt
        : Math.max(input.frontierCreatedAt, durableFrontierCreatedAt)
  const nowMs = (input.nowMs ?? Date.now)()
  const createdAt = selectInboxDeclarationCreatedAt({
    frontierCreatedAt: effectiveFrontierCreatedAt,
    nowMs: () => nowMs,
  })
  const getSignerPubkey =
    input.getSignerPubkey ?? (async (signer) => (await signer.user()).pubkey)
  const signerPubkey = await getSignerPubkey(input.signer)
  if (signerPubkey !== input.pubkey) {
    throw new Error(
      "Private-message relay declaration signer does not match pubkey"
    )
  }

  const event = new NDKEvent(input.ndk ?? getNdk())
  event.kind = EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
  event.pubkey = input.pubkey
  event.created_at = createdAt
  event.tags = relayUrls.map((relayUrl) => ["relay", relayUrl])
  event.content = ""

  const signFn = input.signFn ?? ((event, signer) => event.sign(signer))
  await signFn(event, input.signer)

  const signedEvent = event.rawEvent() as SignedPublicNostrEvent
  const expectedTags = relayUrls.map((relayUrl) => ["relay", relayUrl])
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== input.pubkey ||
    signedEvent.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS ||
    signedEvent.created_at !== createdAt ||
    signedEvent.content !== "" ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(expectedTags)
  ) {
    throw new Error(
      "Private-message relay declaration signer returned an invalid event"
    )
  }
  const mergedEvidence = await stageInboxDeclarationDistribution(
    {
      pubkey: input.pubkey,
      signedEvent,
      publishRelayUrls: discoveryRelayUrls,
      expectedCurrentEventId: durableFrontierEventId,
      stagedAt: nowMs,
    },
    input.evidenceRepository
  )
  primeInboxDeclarationEvidence(mergedEvidence, () => nowMs)

  const delivery = await (input.publishFn ?? publishWithPlanner)(event, {
    intent: "author_event",
    authorPubkey: input.pubkey,
    authenticatedPubkey: input.pubkey,
    exclusiveRelayUrls: discoveryRelayUrls,
    deliveryMode: "critical",
  })
  if (
    Array.isArray(delivery.successfulRelayUrls) &&
    delivery.successfulRelayUrls.length === 0
  ) {
    throw new Error(
      "Inbox declaration distribution completed without a relay ACK."
    )
  }

  return event
}

/**
 * Re-publish an exact retained declaration after shared discovery completed
 * without seeing it. This must never mint a newer replaceable event: a bounded
 * empty view cannot prove that another client has not published a newer one.
 */
export async function redistributePrivateMessageRelayDeclaration(
  input: RedistributePrivateMessageRelayDeclarationInput
): Promise<NDKEvent> {
  const signedEvent = input.signedEvent
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.id !== signedEvent.id.toLowerCase() ||
    signedEvent.pubkey !== input.pubkey ||
    signedEvent.pubkey !== signedEvent.pubkey.toLowerCase() ||
    signedEvent.sig !== signedEvent.sig.toLowerCase() ||
    signedEvent.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
  ) {
    throw new Error(
      "Private-message relay redistribution requires the exact valid declaration"
    )
  }
  const discoveryRelayUrls = requireSecureRelayUrls(
    (input.publishRelayUrls
      ? () => input.publishRelayUrls!
      : (input.getDiscoveryRelayUrls ??
          (() => inboxDeclarationPublishRelayUrls())))(),
    "Private-message relay discovery targets"
  )
  const event = new NDKEvent(input.ndk ?? getNdk(), signedEvent)
  const delivery = await (input.publishFn ?? publishWithPlanner)(event, {
    intent: "author_event",
    authorPubkey: input.pubkey,
    authenticatedPubkey: input.pubkey,
    exclusiveRelayUrls: discoveryRelayUrls,
    deliveryMode: "critical",
  })
  if (
    Array.isArray(delivery.successfulRelayUrls) &&
    delivery.successfulRelayUrls.length === 0
  ) {
    throw new Error(
      "Inbox declaration distribution completed without a relay ACK."
    )
  }
  return event
}

/**
 * Retry the immutable staged plan, then independently cover the current shared
 * plan with the same signed bytes when configuration rotated. A dead old plan
 * cannot prevent recovery through healthy current shared relays.
 */
export async function redistributePrivateMessageRelayDeclarationAcrossPlans(
  input: RedistributePrivateMessageRelayDeclarationAcrossPlansInput
): Promise<NDKEvent> {
  const currentSharedRelayUrls = requireSecureRelayUrls(
    input.currentSharedRelayUrls,
    "Current private-message shared discovery targets"
  )

  let storedAttemptError: unknown
  let storedPublishRelayUrls: string[] | null = null
  try {
    storedPublishRelayUrls = requireSecureRelayUrls(
      input.storedPublishRelayUrls,
      "Stored private-message relay discovery targets"
    )
  } catch (error) {
    storedAttemptError = error
  }

  if (storedPublishRelayUrls) {
    const storedPublishRelayUrlSet = new Set(storedPublishRelayUrls)
    const currentPlanCovered = currentSharedRelayUrls.every((relayUrl) =>
      storedPublishRelayUrlSet.has(relayUrl)
    )
    const samePlan =
      currentPlanCovered &&
      storedPublishRelayUrls.length === currentSharedRelayUrls.length
    try {
      const storedAttempt = await redistributePrivateMessageRelayDeclaration({
        pubkey: input.pubkey,
        signedEvent: input.signedEvent,
        ndk: input.ndk,
        publishRelayUrls: storedPublishRelayUrls,
        publishFn: input.publishFn,
      })
      if (currentPlanCovered) return storedAttempt
    } catch (error) {
      storedAttemptError = error
      if (samePlan) throw error
    }
  }

  try {
    return await redistributePrivateMessageRelayDeclaration({
      pubkey: input.pubkey,
      signedEvent: input.signedEvent,
      ndk: input.ndk,
      publishRelayUrls: currentSharedRelayUrls,
      publishFn: input.publishFn,
    })
  } catch (currentAttemptError) {
    if (storedAttemptError) {
      throw new AggregateError(
        [storedAttemptError, currentAttemptError],
        "Inbox declaration retry failed on stored and current shared targets."
      )
    }
    throw currentAttemptError
  }
}
