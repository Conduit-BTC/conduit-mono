import { z } from "zod"
import type { ParsedOrderPayload } from "./orders"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"
import { merchantAcceptanceBinding } from "./merchant-acceptance-privacy"

type OrderIdentity = Pick<OrderSchema, "id" | "buyerPubkey" | "merchantPubkey">
const hash = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)))
const identityBinding = (order: OrderIdentity) =>
  JSON.stringify([order.id, order.buyerPubkey, order.merchantPubkey])

// Independent numeric orders have aggregate terms, not historical line prices.
// Keep their narrow ordinary-order shape; never invent a price or pickup claim.
const numericAcceptanceOrderSchema = z
  .strictObject({
    id: z.string().regex(/^open-markets:[a-f0-9]{64}$/),
    buyerPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    merchantPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    items: z
      .array(
        z.strictObject({
          productId: z.string().regex(/^30402:[a-f0-9]{64}:.+$/),
          quantity: z.number().int().positive().safe(),
          currency: z.literal("SATS"),
        })
      )
      .min(1)
      .max(128),
    subtotal: z.number().int().nonnegative().safe(),
    currency: z.literal("SATS"),
    createdAt: z.number().int().nonnegative().safe(),
    note: z.string().max(4000).optional(),
    openMarkets: z.strictObject({
      address: z.string().max(4000).optional(),
      email: z.string().max(4000).optional(),
      phone: z.string().max(4000).optional(),
      shippingCoordinate: z.string().max(4000).optional(),
    }),
  })
  .refine(
    (order) =>
      order.buyerPubkey !== order.merchantPubkey &&
      new Set(order.items.map((item) => item.productId)).size ===
        order.items.length &&
      order.items.every((item) =>
        item.productId.startsWith(`30402:${order.merchantPubkey}:`)
      ) &&
      (!order.openMarkets.shippingCoordinate ||
        order.openMarkets.shippingCoordinate.startsWith(
          `30406:${order.merchantPubkey}:`
        ))
  )

export function parseMerchantOccurrenceOrder(
  candidate: ParsedOrderPayload
): ParsedOrderPayload {
  const complete = orderSchema.safeParse(candidate)
  if (complete.success) return complete.data
  if (!candidate.openMarkets || !candidate.id.startsWith("open-markets:"))
    throw complete.error
  return numericAcceptanceOrderSchema.parse(candidate)
}

export function merchantOccurrenceAcceptanceBindings(
  order: ParsedOrderPayload
) {
  return {
    identityBinding: merchantAcceptanceBinding(
      "identity",
      identityBinding(order)
    ),
    termsBinding: merchantAcceptanceBinding("terms", JSON.stringify(order)),
  }
}

/** Same canonical identity commitment when the private full order is not retained. */
export function getOrganizerStockOrderIdentityHash(order: OrderIdentity) {
  return hash(identityBinding(order))
}

/** Opaque journal commitments over the existing canonical acceptance bytes. */
export function getOrganizerStockOrderBindings(candidate: OrderSchema) {
  const order = orderSchema.parse(candidate)
  // These canonical wire commitments predate the device-local storage format.
  const bindings = {
    identityBinding: identityBinding(order),
    termsBinding: JSON.stringify(order),
  }
  return {
    ...bindings,
    identityHash: hash(bindings.identityBinding),
    termsHash: hash(bindings.termsBinding),
  }
}
