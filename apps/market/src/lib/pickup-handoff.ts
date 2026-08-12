import {
  formatEventMarketPickupClaimCode,
  getEventMarketPickupClaimRef,
  resolveEventMarketOrganizerInbox,
  resolveOrderPickupHandoffAuthority,
  type EventMarketOrganizerInboxResolution,
} from "@conduit/core"
import type { CartItem, CartPickupFulfillment } from "./cart-model"

export const ORGANIZER_HANDOFF_DISCLOSURE =
  "The merchant asked the event organizer to handle pickup. After the merchant confirms payment (or immediately for a zero-cost order), the organizer receives a minimal private pickup receipt with item references, quantities, and event pickup identity. Pickup is not ready until the organizer receives that merchant confirmation. Contact details, addresses, notes, invoices, and payment secrets are not shared."

export const MERCHANT_HANDOFF_PRIVACY_COPY =
  "Your private order and payment updates go only to the merchant; no organizer receipt is sent."

export type PickupHandoffSummary = {
  mode: "merchant_handoff" | "organizer_handoff"
  handlerPubkey: string
  legacySafeDefault: boolean
  label: "Pickup from merchant booth" | "Pickup from event organizer"
}

export function getPickupHandoffSummary(
  fulfillment: CartPickupFulfillment
): PickupHandoffSummary {
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  return {
    ...authority,
    label:
      authority.mode === "organizer_handoff"
        ? "Pickup from event organizer"
        : "Pickup from merchant booth",
  }
}

export function getCartPickupHandoffSummary(
  items: readonly Pick<CartItem, "fulfillment">[]
): PickupHandoffSummary | null {
  const pickup = items.find(
    (item): item is { fulfillment: CartPickupFulfillment } =>
      item.fulfillment?.type === "pickup"
  )?.fulfillment
  return pickup ? getPickupHandoffSummary(pickup) : null
}

export function getPickupHandoffPrivacyCopy(
  summary: PickupHandoffSummary
): string {
  return summary.mode === "organizer_handoff"
    ? ORGANIZER_HANDOFF_DISCLOSURE
    : MERCHANT_HANDOFF_PRIVACY_COPY
}

/**
 * Derive the buyer-visible code locally from private order context. The
 * organizer receives the same opaque claim in the redacted ready receipt.
 */
export function getOrganizerPickupClaimCode(
  orderId: string,
  fulfillment: CartPickupFulfillment
): string | null {
  const authority = resolveOrderPickupHandoffAuthority(fulfillment)
  if (
    authority.legacySafeDefault ||
    authority.mode !== "organizer_handoff" ||
    authority.handlerPubkey !== fulfillment.organizerPubkey.toLowerCase()
  ) {
    return null
  }
  try {
    return formatEventMarketPickupClaimCode(
      getEventMarketPickupClaimRef({
        orderId,
        merchantPubkey: fulfillment.product.merchantPubkey,
        organizerPubkey: fulfillment.organizerPubkey,
        collectionCoordinate: fulfillment.collection.coordinate,
      })
    )
  } catch {
    return null
  }
}

export function getOrganizerInboxBlockingMessage(
  resolution: Extract<EventMarketOrganizerInboxResolution, { state: "blocked" }>
): string {
  switch (resolution.reason) {
    case "not_declared":
      return "Organizer pickup is unavailable because the event organizer has not declared a usable private inbox. They must publish current kind-10050 inbox relays before checkout can continue."
    case "malformed":
      return "Organizer pickup is unavailable because the organizer's signed private inbox declaration has no usable secure relay."
    case "lookup_partial":
    case "lookup_unavailable":
      return "Organizer pickup readiness could not be confirmed from current relays. Retry when relay access recovers."
    case "stale":
      return "Only stale organizer inbox evidence is available. Refresh before ordering or paying for organizer pickup."
    case "invalid_organizer":
      return "The organizer pickup identity is invalid, so checkout is blocked."
  }
}

type OrganizerInboxResolver = (
  organizerPubkey: string
) => Promise<EventMarketOrganizerInboxResolution>

/** Merchant handoff needs no organizer inbox; organizer handoff fails closed. */
export async function assertCartPickupHandlerReady(
  items: readonly Pick<CartItem, "fulfillment">[],
  resolveInbox: OrganizerInboxResolver = resolveEventMarketOrganizerInbox
): Promise<void> {
  const handoff = getCartPickupHandoffSummary(items)
  if (!handoff || handoff.mode !== "organizer_handoff") return

  const resolution = await resolveInbox(handoff.handlerPubkey)
  if (resolution.state === "blocked") {
    throw new Error(getOrganizerInboxBlockingMessage(resolution))
  }
}
