import {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKUser,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { config, type ConduitConfig } from "../config"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanout,
  fetchEventsFanoutWithDiagnostics,
  getNdk,
} from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { parseOrderMessageRumorEvent } from "./orders"
import { publishWithPlanner } from "./relay-publish"
import { isInsecureRelayUrl } from "./relay-list"
import { getGeneralReadRelayUrls, tryNormalizeRelayUrl } from "./relay-settings"
import {
  withTransientNip07Retry,
  type TransientNip07RetryOptions,
} from "./signing-retry"

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
  /** Injectable kind-10050 resolver (tests); defaults to fetchInboxRelayUrls. */
  resolveInboxRelays?: (pubkey: string) => Promise<string[]>
  /** Injectable relay publisher for focused transport tests. */
  publishFn?: typeof publishWithPlanner
}

export interface PublishPrivateMessageResult {
  wrappedToRecipient: NDKEvent
  wrappedToSelf: NDKEvent | null
  /** Non-null when the non-critical self-copy leg needs retry. */
  selfCopyError: string | null
}

export type PrivateMessageRelayReadinessReason =
  "recipient_not_ready" | "recipient_lookup_failed"

export class PrivateMessageRelayReadinessError extends Error {
  readonly reason: PrivateMessageRelayReadinessReason

  constructor(reason: PrivateMessageRelayReadinessReason) {
    super(
      reason === "recipient_not_ready"
        ? "Recipient has not declared NIP-17 inbox relays."
        : "Recipient inbox relay discovery failed."
    )
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

  const giftWrapFn = input.giftWrapFn ?? giftWrap
  const selfCopy = input.selfCopy ?? true
  const refreshRelayLists = input.refreshRelayLists ?? true
  const wrapParams = { rumorKind: input.rumorKind }
  const resolveInboxRelays = input.resolveInboxRelays ?? fetchInboxRelayUrls
  const publishFn = input.publishFn ?? publishWithPlanner

  // NIP-17 requires exclusive delivery to the recipient's declared inbox.
  let recipientInboxRelays: readonly string[]
  try {
    recipientInboxRelays =
      input.recipientInboxRelays ??
      (await resolveInboxRelays(input.recipientPubkey))
  } catch {
    throw new PrivateMessageRelayReadinessError("recipient_lookup_failed")
  }
  if (recipientInboxRelays.length === 0) {
    throw new PrivateMessageRelayReadinessError("recipient_not_ready")
  }
  const senderInboxRelays = selfCopy
    ? (input.senderInboxRelays ??
      (await resolveInboxRelays(input.senderPubkey).catch(() => [])))
    : []

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

  await publishFn(wrappedToRecipient, {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    authenticatedPubkey: input.senderPubkey,
    recipientPubkeys: [input.recipientPubkey],
    exclusiveRelayUrls: recipientInboxRelays,
    refreshRelayLists,
    deliveryMode: "critical",
  })

  if (wrappedToSelf) {
    try {
      await publishFn(wrappedToSelf, {
        intent: "recipient_event",
        authorPubkey: input.senderPubkey,
        authenticatedPubkey: input.senderPubkey,
        recipientPubkeys: [input.senderPubkey],
        exclusiveRelayUrls: senderInboxRelays,
        refreshRelayLists,
        deliveryMode: "critical",
      })
    } catch (error) {
      selfCopyError =
        error instanceof Error ? error.message : "Self-copy publish failed"
    }
  }

  return { wrappedToRecipient, wrappedToSelf, selfCopyError }
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

export interface PrivateMessageRelays {
  pubkey: string
  relayUrls: string[]
}

/**
 * Parse a kind-10050 private-message relay list into recipient inbox relays.
 * An absent or unusable declaration means the recipient is not NIP-17 ready;
 * general relay lists and configured relays are not delivery fallbacks.
 */
export function parsePrivateMessageRelays(event: {
  kind?: number
  pubkey?: string
  tags?: string[][]
}): PrivateMessageRelays | null {
  if (event.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) return null
  const seen = new Set<string>()
  const relayUrls: string[] = []
  for (const tag of event.tags ?? []) {
    if (tag[0] !== "relay" || typeof tag[1] !== "string") continue
    const url = tag[1].trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    relayUrls.push(url)
  }
  return { pubkey: event.pubkey ?? "", relayUrls }
}

const inboxRelayCache = new Map<string, string[]>()

export interface FetchInboxRelayOptions {
  fetchEvents?: typeof fetchEventsFanout
  fetchEventsWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
  relayUrls?: string[]
}

export type OwnPrivateMessageRelayReadiness =
  { state: "ready"; relayUrls: string[] } | { state: "not_declared" }

/** Reset the kind-10050 inbox-relay cache (tests). */
export function __resetInboxRelayCache(): void {
  inboxRelayCache.clear()
}

/**
 * Resolve a pubkey's kind-10050 private-message inbox relays. Positive results
 * are cached; absent declarations and lookup errors remain retryable.
 */
export async function fetchInboxRelayUrls(
  pubkey: string,
  options: FetchInboxRelayOptions = {}
): Promise<string[]> {
  const cached = inboxRelayCache.get(pubkey)
  if (cached) return cached
  const filter = {
    kinds: [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
    authors: [pubkey],
    limit: 1,
  }
  const fetchOptions = {
    relayUrls: options.relayUrls ?? getGeneralReadRelayUrls({}),
    connectTimeoutMs: 3_000,
    fetchTimeoutMs: 6_000,
  }
  let events: NDKEvent[]
  let lookupHadFailures = false
  if (options.fetchEvents) {
    events = await options.fetchEvents(filter, fetchOptions)
  } else {
    const result = await (
      options.fetchEventsWithDiagnostics ?? fetchEventsFanoutWithDiagnostics
    )(filter, fetchOptions)
    if (result.successfulRelayUrls.length === 0) {
      throw new Error("Private-message relay lookup unavailable")
    }
    lookupHadFailures = result.failedRelayUrls.length > 0
    events = result.events
  }
  let relayUrls: string[] = []
  let newest = -1
  for (const event of events) {
    const parsed = parsePrivateMessageRelays(event)
    if (parsed?.pubkey === pubkey && (event.created_at ?? 0) > newest) {
      relayUrls = parsed.relayUrls
      newest = event.created_at ?? 0
    }
  }
  const secure = relayUrls.flatMap((url) => {
    const normalized = tryNormalizeRelayUrl(url)
    return normalized.ok && !isInsecureRelayUrl(normalized.url)
      ? [normalized.url]
      : []
  })
  if (secure.length > 0) {
    inboxRelayCache.set(pubkey, secure)
  } else if (lookupHadFailures) {
    throw new Error("Private-message relay lookup incomplete")
  }
  return secure
}

/** Inspect the principal's kind-10050 declaration without masking lookup errors. */
export async function inspectOwnPrivateMessageRelayReadiness(
  pubkey: string,
  options: FetchInboxRelayOptions = {}
): Promise<OwnPrivateMessageRelayReadiness> {
  const relayUrls = await fetchInboxRelayUrls(pubkey, options)
  return relayUrls.length > 0
    ? { state: "ready", relayUrls }
    : { state: "not_declared" }
}

export interface PublishPrivateMessageRelayDeclarationInput {
  pubkey: string
  signer: NDKSigner
  ndk?: ReturnType<typeof getNdk>
  /** Defaults to config.dmInboxDefaultRelayUrls. */
  relayUrls?: readonly string[]
  createdAt?: number
  relayConfig?: Pick<ConduitConfig, "dmInboxDefaultRelayUrls">
  getSignerPubkey?: (signer: NDKSigner) => Promise<string>
  signFn?: (event: NDKEvent, signer: NDKSigner) => Promise<string>
  getDiscoveryRelayUrls?: () => readonly string[]
  publishFn?: typeof publishWithPlanner
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
    (input.getDiscoveryRelayUrls ?? (() => getGeneralReadRelayUrls({})))(),
    "Private-message relay discovery targets"
  )
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
  event.created_at = input.createdAt ?? Math.floor(Date.now() / 1000)
  event.tags = relayUrls.map((relayUrl) => ["relay", relayUrl])
  event.content = ""

  const signFn = input.signFn ?? ((event, signer) => event.sign(signer))
  await signFn(event, input.signer)
  await (input.publishFn ?? publishWithPlanner)(event, {
    intent: "author_event",
    authorPubkey: input.pubkey,
    authenticatedPubkey: input.pubkey,
    exclusiveRelayUrls: discoveryRelayUrls,
    deliveryMode: "critical",
  })

  inboxRelayCache.set(input.pubkey, relayUrls)
  return event
}
