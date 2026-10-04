import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { eventMarketClaimRefSchema } from "../schemas"
import {
  resolveInboxDeclaration,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
const HEX_64 = /^[0-9a-f]{64}$/i

/** Content-free local join key; never emit or log the underlying order id. */
export function getEventMarketOrderCorrelationRef(orderId: string): string {
  if (!orderId) throw new Error("Order correlation requires an order id.")
  return bytesToHex(
    sha256(new TextEncoder().encode(`event-market-order-v1\0${orderId}`))
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
        | "not_observed"
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
          ? "not_observed"
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
