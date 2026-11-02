import type { ConduitDB, OrderLifecycle } from "@conduit/core/db"
import {
  EVENT_KINDS,
  formatEventMarketPickupClaimCode,
  getFutureMarketClaimRef,
} from "@conduit/core"
import { getEventGuestReceiptCommitment } from "@conduit/core/protocol/event-guest-checkout"
import {
  createEventPickupReceiptRepository,
  type EventPickupReceiptBuyerScope,
  type SavedEventPickupReceipt,
} from "@conduit/core/protocol/event-pickup-receipt-storage"
import { isValidSignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  isBuyerOrderPaid,
  isZeroCostPickupOrder,
  type OrderViewModel,
} from "./order-view"

export interface EventPickupReceiptAccess {
  orderId: string
  merchantPubkey: string
  buyerScope: EventPickupReceiptBuyerScope
  commitment: string
  occurrenceCoordinate: string
  occurrenceEnd: number
  organizerClaimCode?: string
}

/** Display a private capability only after the existing exact checkout gate. */
export function getEventPickupReceiptAccess(
  lifecycle: OrderLifecycle | undefined,
  view: OrderViewModel,
  buyerPubkey: string
): EventPickupReceiptAccess | null {
  if (
    !lifecycle ||
    lifecycle.orderId !== view.orderId ||
    lifecycle.merchantPubkey !== view.merchantPubkey ||
    lifecycle.buyerPubkey !== buyerPubkey ||
    !/^[0-9a-f]{64}$/.test(lifecycle.pickupReceiptCommitment ?? "") ||
    (lifecycle.buyerIdentityKind !== "signed_in" &&
      lifecycle.buyerIdentityKind !== "guest_ephemeral") ||
    lifecycle.orderDeliveryStatus !== "sent"
  )
    return null
  const delivery = lifecycle.orderRelayDelivery
  if (
    !delivery ||
    !/^[0-9a-f]{64}$/.test(delivery.rumorId ?? "") ||
    !delivery.relayDelivery.some((target) => target.status === "acked") ||
    delivery.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    !isValidSignedPublicNostrEvent(delivery.signedRecipientWrap) ||
    delivery.signedRecipientWrap.tags.filter((tag) => tag[0] === "p").length !==
      1 ||
    !delivery.signedRecipientWrap.tags.some(
      (tag) => tag[0] === "p" && tag[1] === lifecycle.merchantPubkey
    )
  )
    return null
  const first = lifecycle.items[0]?.fulfillment
  if (
    first?.type !== "event_market_pickup" ||
    lifecycle.items.some((item) => {
      const pickup = item.fulfillment
      return (
        pickup?.type !== "event_market_pickup" ||
        pickup.merchantPubkey !== lifecycle.merchantPubkey ||
        pickup.calendar.coordinate !== first.calendar.coordinate ||
        pickup.calendar.eventId !== first.calendar.eventId ||
        pickup.calendar.end !== first.calendar.end
      )
    }) ||
    (!isBuyerOrderPaid(view) &&
      !(
        isZeroCostPickupOrder(view) &&
        lifecycle.totalSats === 0 &&
        lifecycle.totalMsats === 0 &&
        lifecycle.itemSubtotalSats === 0 &&
        lifecycle.shippingCostSats === 0
      ))
  )
    return null
  return {
    orderId: lifecycle.orderId,
    merchantPubkey: lifecycle.merchantPubkey,
    buyerScope:
      lifecycle.buyerIdentityKind === "signed_in"
        ? { kind: "signed_in", pubkey: buyerPubkey }
        : { kind: "guest" },
    commitment: lifecycle.pickupReceiptCommitment!,
    occurrenceCoordinate: first.calendar.coordinate,
    occurrenceEnd: first.calendar.end,
    ...(first.mode === "organizer_handoff"
      ? {
          organizerClaimCode: formatEventMarketPickupClaimCode(
            getFutureMarketClaimRef({
              orderId: lifecycle.orderId,
              merchantPubkey: lifecycle.merchantPubkey,
              organizerPubkey: first.organizerPubkey,
              marketCoordinate: first.market.coordinate,
            })
          ),
        }
      : {}),
  }
}

export async function loadEventPickupReceiptForOrder(
  access: EventPickupReceiptAccess,
  options: {
    database?: ConduitDB
    now?: () => number
    assertCurrent?: () => void
  } = {}
) {
  const saved = await createEventPickupReceiptRepository(options).load(
    access.orderId,
    access.buyerScope
  )
  if (!saved) return null
  assertReceiptMatches(access, saved)
  return saved
}

function assertReceiptMatches(
  access: EventPickupReceiptAccess,
  saved: SavedEventPickupReceipt
) {
  if (
    saved.merchantPubkey !== access.merchantPubkey ||
    saved.occurrenceCoordinate !== access.occurrenceCoordinate ||
    saved.occurrenceEnd !== access.occurrenceEnd ||
    getEventGuestReceiptCommitment(saved.receipt) !== access.commitment
  )
    throw new Error("The saved pickup receipt does not match this order.")
}

export function observeEventPickupReceiptForOrder(
  access: EventPickupReceiptAccess,
  onValue: (value: SavedEventPickupReceipt | null) => void,
  onError: () => void,
  options: Parameters<typeof loadEventPickupReceiptForOrder>[1] = {}
): () => void {
  return createEventPickupReceiptRepository(options).observe(
    { orderId: access.orderId, buyerScope: access.buyerScope },
    (rows) => {
      const saved = rows[0] ?? null
      try {
        if (saved) assertReceiptMatches(access, saved)
        onValue(saved)
      } catch {
        onError()
      }
    },
    onError
  )
}

/** A local possession copy, never expired guest order/payment authority. */
export function observeGuestPickupReceipts(
  onValue: (value: SavedEventPickupReceipt[]) => void,
  onError: () => void,
  options: Parameters<typeof loadEventPickupReceiptForOrder>[1] = {}
): () => void {
  return createEventPickupReceiptRepository(options).observe(
    { buyerScope: { kind: "guest" } },
    onValue,
    onError
  )
}
