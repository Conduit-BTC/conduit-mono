import {
  getProfilePaymentAddress,
  type SelectedProfileContext,
} from "./profile-cache"
import type { CommerceFreshnessMeta } from "./commerce"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const PUBKEY = /^[0-9a-f]{64}$/
const EVENT_ID = /^[0-9a-f]{64}$/

export type CheckoutSparkRecipientPayoutAddressResolution =
  | {
      state: "ready"
      recipientPubkey: string
      lud16: string
      profileEventId: string
      profileEventCreatedAt: number
      signedEvent?: SignedPublicNostrEvent
    }
  | {
      state: "unavailable"
      reason:
        | "profile_unavailable"
        | "profile_not_observed"
        | "read_incomplete"
        | "payment_address_missing"
    }
  | {
      state: "invalid"
      reason:
        | "recipient_invalid"
        | "recipient_mismatch"
        | "profile_frontier_invalid"
        | "payment_address_invalid"
    }

/**
 * Resolve a payout address only from the recipient's exact selected kind-0
 * frontier. The caller must obtain `context` from a payment-scope `getProfiles`
 * read with `skipCache` and `requireCompleteEvidence`, and pass that same
 * final read's `meta`. The relay read verifies event IDs and signatures before
 * constructing the context. A progress callback, display profile, or plain
 * pubkey-to-address map is never payment authority.
 *
 * One currently observed, durably selected, valid signed event establishes
 * the recipient's destination. Incomplete discovery/relay coverage remains
 * incomplete; it does not veto that positive evidence. Retained-only data,
 * failed persistence, and a stronger selected frontier cannot authorize it.
 */
export function resolveCheckoutSparkRecipientPayoutAddress(input: {
  recipientPubkey: string
  context: SelectedProfileContext | undefined
  readMeta: CommerceFreshnessMeta
}): CheckoutSparkRecipientPayoutAddressResolution {
  const { recipientPubkey, context, readMeta } = input
  if (!PUBKEY.test(recipientPubkey)) {
    return { state: "invalid", reason: "recipient_invalid" }
  }
  if (!context) {
    return { state: "unavailable", reason: "profile_unavailable" }
  }
  if (context.profile.pubkey !== recipientPubkey) {
    return { state: "invalid", reason: "recipient_mismatch" }
  }
  const frontier = context.frontier
  if (!frontier) {
    return { state: "unavailable", reason: "profile_unavailable" }
  }
  if (
    frontier.validity !== "valid" ||
    !EVENT_ID.test(frontier.eventId) ||
    !Number.isSafeInteger(frontier.eventCreatedAt) ||
    frontier.eventCreatedAt < 0
  ) {
    return { state: "invalid", reason: "profile_frontier_invalid" }
  }
  if (context.freshness !== "observed") {
    return { state: "unavailable", reason: "profile_not_observed" }
  }
  if (context.persistence !== "durable") {
    return { state: "unavailable", reason: "read_incomplete" }
  }
  if (!readMeta || readMeta.stale !== false) {
    return { state: "unavailable", reason: "read_incomplete" }
  }

  const lud16 = getProfilePaymentAddress(context)
  if (!lud16) {
    let rawContent: unknown
    try {
      rawContent = JSON.parse(frontier.rawContent)
    } catch {
      return { state: "invalid", reason: "profile_frontier_invalid" }
    }
    const claimedAddress =
      rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)
        ? (rawContent as Record<string, unknown>).lud16
        : undefined
    return typeof claimedAddress !== "string" || !claimedAddress.trim()
      ? { state: "unavailable", reason: "payment_address_missing" }
      : { state: "invalid", reason: "payment_address_invalid" }
  }

  const signed = context.signedEvent
  if (
    !signed ||
    !isValidSignedPublicNostrEvent(signed) ||
    signed.kind !== 0 ||
    signed.id !== frontier.eventId ||
    signed.pubkey !== recipientPubkey ||
    signed.created_at !== frontier.eventCreatedAt ||
    signed.content !== frontier.rawContent
  ) {
    return { state: "invalid", reason: "profile_frontier_invalid" }
  }
  return {
    state: "ready",
    recipientPubkey,
    lud16,
    profileEventId: frontier.eventId,
    profileEventCreatedAt: frontier.eventCreatedAt,
    signedEvent: {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags.map((tag) => [...tag]),
      content: signed.content,
      sig: signed.sig,
    },
  }
}
