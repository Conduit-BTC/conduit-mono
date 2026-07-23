import { NDKEvent } from "@nostr-dev-kit/ndk"
import type NDK from "@nostr-dev-kit/ndk"

import {
  EVENT_KINDS,
  appendConduitClientTag,
  orderSchema,
  type OrderGuestContact,
  type OrderSchema,
  type ShippingAddressSchema,
} from "@conduit/core"

import type { CheckoutPricingIntent } from "./checkout-payment"

export type ReadyCheckoutPricing = Extract<
  CheckoutPricingIntent,
  { status: "ok" }
>

export type CheckoutOrderInput = {
  orderId: string
  merchantPubkey: string
  buyerPubkey: string
  buyerIdentityKind: "signed_in" | "guest_ephemeral"
  pricing: ReadyCheckoutPricing
  shippingAddress?: ShippingAddressSchema
  guestContact?: OrderGuestContact
  note?: string
  createdAt: number
}

export function buildCheckoutOrderPayload(
  input: CheckoutOrderInput
): OrderSchema {
  return orderSchema.parse({
    id: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.buyerPubkey,
    buyerIdentityKind: input.buyerIdentityKind,
    items: input.pricing.items,
    subtotal: input.pricing.totalSats,
    currency: "SATS",
    shippingCostSats:
      input.pricing.shippingCost.status === "manual"
        ? undefined
        : input.pricing.shippingCost.totalSats,
    shippingCostStatus: input.pricing.shippingCost.status,
    shippingAddress: input.shippingAddress,
    guestContact: input.guestContact,
    note: input.note,
    createdAt: input.createdAt,
    pricingQuote: input.pricing.quote,
  })
}

export function buildCheckoutOrderRumor(
  input: CheckoutOrderInput & {
    ndk: NDK
    rumorCreatedAt: number
  }
): NDKEvent {
  const payload = buildCheckoutOrderPayload(input)
  const rumor = new NDKEvent(input.ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(input.rumorCreatedAt / 1_000)
  rumor.tags = [
    ["p", input.merchantPubkey],
    ["type", "order"],
    ["order", input.orderId],
    ["amount", String(input.pricing.totalSats)],
    ["currency", "SATS"],
  ]
  for (const item of input.pricing.items) {
    rumor.tags.push(["item", item.productId, String(item.quantity)])
    if (item.shippingOptionId) {
      rumor.tags.push(["shipping", item.shippingOptionId])
    }
  }
  rumor.tags = appendConduitClientTag(rumor.tags, "market")
  rumor.content = JSON.stringify(payload)
  return rumor
}
