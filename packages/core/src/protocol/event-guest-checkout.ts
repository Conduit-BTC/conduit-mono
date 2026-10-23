import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { z } from "zod"
import type { OrderItemFulfillmentSchema, OrderSchema } from "../schemas"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"

/** Experimental Conduit product extension; absent or ambiguous means contact required. */
export const EVENT_GUEST_CONTACT_TAG = "conduit_event_guest"
export function hasSignedEventGuestOptIn(
  tags: readonly (readonly string[])[]
): boolean {
  const policies = tags.filter((tag) => tag[0] === EVENT_GUEST_CONTACT_TAG)
  return (
    policies.length === 1 &&
    policies[0]?.length === 2 &&
    policies[0]?.[1] === "contact_optional"
  )
}

function hasReservedOrganizerHandoff(
  fulfillment: Extract<
    OrderItemFulfillmentSchema,
    { type: "event_market_pickup" }
  >
): boolean {
  const evidence = fulfillment.occurrenceAssignment
  if (!evidence) return false
  const assignment = parseEventMarketAssignmentEvent(evidence.signedEvent)
  return (
    !!assignment &&
    assignment.eventId === evidence.eventId &&
    assignment.coordinate === evidence.coordinate &&
    assignment.state === "active" &&
    assignment.merchantPubkey === fulfillment.merchantPubkey &&
    assignment.organizerPubkey === fulfillment.organizerPubkey &&
    assignment.merchantPubkey !== assignment.organizerPubkey &&
    assignment.marketCoordinate === fulfillment.market.coordinate &&
    assignment.occurrenceCoordinate === fulfillment.calendar.coordinate &&
    assignment.productCoordinate === fulfillment.product.coordinate &&
    assignment.fulfillmentMethods.includes("pickup") &&
    assignment.stockPool.state === "valid" &&
    assignment.stockPool.pool.state === "active" &&
    assignment.stockPool.pool.organizerPubkey === fulfillment.organizerPubkey &&
    assignment.stockPool.pool.quantity >
      assignment.stockPool.pool.importedQuantity
  )
}

export function isContactFreeEventHandoff(
  items: readonly {
    fulfillment?: OrderItemFulfillmentSchema
  }[],
  now: number
): boolean {
  return (
    items.length > 0 &&
    items.every((item) => {
      const fulfillment = item.fulfillment
      return (
        fulfillment?.type === "event_market_pickup" &&
        (fulfillment.mode === "merchant_present" ||
          (fulfillment.mode === "organizer_handoff" &&
            hasReservedOrganizerHandoff(fulfillment))) &&
        now < fulfillment.calendar.end &&
        isValidSignedPublicNostrEvent(fulfillment.product.signedEvent) &&
        fulfillment.product.signedEvent.pubkey === fulfillment.merchantPubkey &&
        fulfillment.product.signedEvent.id === fulfillment.product.eventId &&
        (fulfillment.occurrenceAssignment
          ? fulfillment.occurrenceAssignment.signedEvent.id ===
            fulfillment.occurrenceAssignment.eventId
          : now >= fulfillment.calendar.start &&
            hasSignedEventGuestOptIn(fulfillment.product.signedEvent.tags))
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

/** A human-readable private export; the signed receipt commitment is unchanged. */
export function formatEventGuestReceipt(receipt: EventGuestReceipt): string {
  const parsed = eventGuestReceiptSchema.parse(receipt)
  return [
    "Conduit private event receipt (v1)",
    `Order: ${parsed.orderId}`,
    `Merchant: ${parsed.merchantPubkey}`,
    `Private receipt code: ${parsed.claimSecret}`,
    "",
    "Keep this receipt private. Anyone with this code can present it.",
    "Show it to the seller or organizer for pickup or support.",
    "This receipt is not proof of payment and does not guarantee a refund.",
  ].join("\n")
}

/** Accept original JSON exports and the bounded readable v1 export. */
export function parseEventGuestReceipt(text: string): EventGuestReceipt | null {
  if (new TextEncoder().encode(text).length > 4096) return null
  try {
    const trimmed = text.trim()
    const lines = trimmed.split(/\r?\n/)
    const value: unknown = trimmed.startsWith("{")
      ? JSON.parse(trimmed)
      : lines[0] === "Conduit private event receipt (v1)" &&
          lines[1]?.startsWith("Order: ") &&
          lines[2]?.startsWith("Merchant: ") &&
          lines[3]?.startsWith("Private receipt code: ")
        ? {
            format: "conduit-event-receipt",
            version: 1,
            orderId: lines[1].slice(7),
            merchantPubkey: lines[2].slice(10),
            claimSecret: lines[3].slice(22),
          }
        : null
    const parsed = eventGuestReceiptSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

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
