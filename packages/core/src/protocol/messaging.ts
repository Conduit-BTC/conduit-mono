import {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKUser,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { publishWithPlanner } from "./relay-publish"
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
 * the current path; NIP-04 stays a read-only legacy fallback.
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
      // fall through to legacy nip04 read-only fallback
    }

    try {
      return {
        rumor: await giftUnwrap(event, undefined, signer, "nip04"),
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
  }
}

export interface PublishPrivateMessageInput {
  /** Caller-built rumor (pubkey stamped); its kind must equal rumorKind. */
  rumor: NDKEvent
  senderPubkey: string
  recipientPubkey: string
  signer: NDKSigner
  rumorKind: number
  /** Wrap a sender self-copy for local recovery. Default true. */
  selfCopy?: boolean
  refreshRelayLists?: boolean
  retry?: TransientNip07RetryOptions
  giftWrapFn?: typeof giftWrap
}

export interface PublishPrivateMessageResult {
  wrappedToRecipient: NDKEvent
  wrappedToSelf: NDKEvent | null
  /** Non-null when the non-critical self-copy leg needs retry. */
  selfCopyError: string | null
}

/**
 * Gift-wrap a rumor to the recipient (critical) and optionally to the sender as
 * a self-copy (non-critical), publishing both through the shared relay planner.
 * Kind 14 and kind 16 sends share this primitive; the caller owns local caching.
 */
export async function publishPrivateMessage(
  input: PublishPrivateMessageInput
): Promise<PublishPrivateMessageResult> {
  const giftWrapFn = input.giftWrapFn ?? giftWrap
  const selfCopy = input.selfCopy ?? true
  const refreshRelayLists = input.refreshRelayLists ?? true
  const wrapParams = { rumorKind: input.rumorKind }

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
  const wrappedToSelf = selfCopy
    ? await withTransientNip07Retry(
        () =>
          giftWrapFn(
            input.rumor,
            new NDKUser({ pubkey: input.senderPubkey }),
            input.signer,
            wrapParams
          ),
        input.retry
      )
    : null

  await publishWithPlanner(wrappedToRecipient, {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    authenticatedPubkey: input.senderPubkey,
    recipientPubkeys: [input.recipientPubkey],
    refreshRelayLists,
    deliveryMode: "critical",
  })

  let selfCopyError: string | null = null
  if (wrappedToSelf) {
    try {
      await publishWithPlanner(wrappedToSelf, {
        intent: "recipient_event",
        authorPubkey: input.senderPubkey,
        authenticatedPubkey: input.senderPubkey,
        recipientPubkeys: [input.senderPubkey],
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
 * Used as an input to DM relay planning; callers fall back to NIP-65 + config
 * defaults when absent.
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
