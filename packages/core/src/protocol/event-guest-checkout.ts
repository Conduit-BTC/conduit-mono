import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { z } from "zod"
import type { OrderItemFulfillmentSchema, OrderSchema } from "../schemas"
import { isValidSignedPublicNostrEvent } from "./signed-event"

/** Experimental Conduit product extension; absent or ambiguous means contact required. */
export const EVENT_GUEST_CONTACT_TAG = "conduit_event_guest"
export function hasSignedEventGuestOptIn(tags: readonly string[][]): boolean {
  const policies = tags.filter((tag) => tag[0] === EVENT_GUEST_CONTACT_TAG)
  return (
    policies.length === 1 &&
    policies[0]?.length === 2 &&
    policies[0]?.[1] === "contact_optional"
  )
}

export function isContactFreeEventHandoff(
  items: readonly {
    fulfillment?: OrderItemFulfillmentSchema | { type: "event_pickup_pending" }
  }[],
  now: number
): boolean {
  return (
    items.length > 0 &&
    items.every((item) => {
      const fulfillment = item.fulfillment
      return (
        fulfillment?.type === "event_market_pickup" &&
        fulfillment.mode === "merchant_present" &&
        now >= fulfillment.calendar.start &&
        now < fulfillment.calendar.end &&
        isValidSignedPublicNostrEvent(fulfillment.product.signedEvent) &&
        fulfillment.product.signedEvent.pubkey === fulfillment.merchantPubkey &&
        fulfillment.product.signedEvent.id === fulfillment.product.eventId &&
        hasSignedEventGuestOptIn(fulfillment.product.signedEvent.tags)
      )
    })
  )
}

export const eventGuestReceiptSchema = z.strictObject({
  format: z.literal("conduit-event-receipt"),
  version: z.literal(1),
  orderId: z.uuid(),
  merchantPubkey: z.string().regex(/^[0-9a-f]{64}$/),
  claimSecret: z.string().regex(/^[0-9a-f]{64}$/),
})
export type EventGuestReceipt = z.infer<typeof eventGuestReceiptSchema>

/** This bearer receipt proves possession of the buyer's receipt, never payment. */
export function createEventGuestReceipt(
  merchantPubkey: string
): EventGuestReceipt {
  return eventGuestReceiptSchema.parse({
    format: "conduit-event-receipt",
    version: 1,
    orderId: crypto.randomUUID(),
    merchantPubkey,
    claimSecret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  })
}
export function getEventGuestReceiptCommitment(
  receipt: EventGuestReceipt
): string {
  const parsed = eventGuestReceiptSchema.parse(receipt)
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit-event-receipt",
          1,
          parsed.orderId,
          parsed.merchantPubkey,
          parsed.claimSecret,
        ])
      )
    )
  )
}

/** Original order and merchant bind the receipt. No payout or refund action is implied. */
export function verifyEventGuestReceipt(
  value: unknown,
  order: OrderSchema,
  merchantPubkey: string
): boolean {
  const receipt = eventGuestReceiptSchema.safeParse(value)
  return (
    receipt.success &&
    order.buyerIdentityKind === "guest_ephemeral" &&
    !!order.contactFreePickup &&
    merchantPubkey === order.merchantPubkey &&
    receipt.data.orderId === order.id &&
    receipt.data.merchantPubkey === order.merchantPubkey &&
    getEventGuestReceiptCommitment(receipt.data) ===
      order.contactFreePickup.receiptCommitment
  )
}
