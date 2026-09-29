import {
  getProfilePaymentAddress,
  type SelectedProfileContext,
} from "./profile-cache"
import type { CommerceFreshnessMeta } from "./commerce"

const PUBKEY = /^[0-9a-f]{64}$/
const EVENT_ID = /^[0-9a-f]{64}$/

export type CheckoutSparkRecipientPayoutAddressResolution =
  | {
      state: "ready"
      recipientPubkey: string
      lud16: string
      profileEventId: string
      profileEventCreatedAt: number
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
 * An incomplete or retained read cannot establish a current destination.
 * This is a payment-recipient gate, not a claim of global Nostr absence.
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
  if (!context.readComplete) {
    return { state: "unavailable", reason: "read_incomplete" }
  }
  if (
    !readMeta ||
    readMeta.stale !== false ||
    readMeta.degraded !== false ||
    readMeta.capped !== false
  ) {
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

  return {
    state: "ready",
    recipientPubkey,
    lud16,
    profileEventId: frontier.eventId,
    profileEventCreatedAt: frontier.eventCreatedAt,
  }
}
