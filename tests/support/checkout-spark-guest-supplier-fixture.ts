import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  createSelectedProfileContext,
  parseProductEvent,
  parseShippingOptionEvent,
  snapshotCheckoutSparkPlanSourceEvents,
  type SelectedProfileContext,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { createCartItemFromProduct } from "../../apps/market/src/lib/cart-model"
import { prepareCartFulfillment } from "../../apps/market/src/lib/cart-shipping-options"
import { buildCheckoutPricingIntent } from "../../apps/market/src/lib/checkout-payment"
import type { CheckoutSparkQuoteAuthority } from "../../apps/market/src/lib/checkout-spark-quote-authority"

/** Genuine, offline signed evidence; all signing material is synthetic and in memory. */
export function createCheckoutSparkGuestSupplierFixture(
  nowMs: number,
  physical = false
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Supplier fixture time is invalid")
  }
  const createdAt = Math.floor(nowMs / 1_000)
  const merchantSecret = generateSecretKey()
  const supplierSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const supplierPubkey = getPublicKey(supplierSecret)
  const merchantSigner = new NDKPrivateKeySigner(
    Buffer.from(merchantSecret).toString("hex")
  )
  const terms = [
    { dTag: "guest-supplier-first", unitSats: 1_003, quantity: 3 },
    { dTag: "guest-supplier-second", unitSats: 11, quantity: 2 },
  ]
  const shippingEvent = physical
    ? finalizeEvent(
        {
          kind: 30_406,
          created_at: createdAt - 1,
          content: "",
          tags: [
            ["d", "guest-supplier-first-shipping-standard"],
            ["title", "Standard shipping"],
            ["price", "20", "SAT"],
            ["country", "US"],
            ["service", "standard"],
          ],
        },
        merchantSecret
      )
    : undefined
  const shipping = shippingEvent
    ? parseShippingOptionEvent(shippingEvent)!
    : undefined
  const productEvents = terms.map(({ dTag, unitSats }, index) =>
    finalizeEvent(
      {
        kind: 30_402,
        created_at: createdAt,
        tags: [
          ["d", dTag],
          ["title", "Synthetic supplier item"],
          ["price", String(unitSats), "SAT"],
          ["type", "simple", physical && index === 0 ? "physical" : "digital"],
          ...(shipping && index === 0
            ? [["shipping_option", shipping.id]]
            : []),
          ["conduit_supplier_allocation", "1"],
          ["zap", merchantPubkey, "wss://relay.conduit.market", "3"],
          ["zap", supplierPubkey, "wss://relay.conduit.market", "1"],
        ],
        content: "Synthetic signed supplier listing",
      },
      merchantSecret
    )
  )
  const products = productEvents.map((event) => ({
    ...parseProductEvent(event),
    sourceEventId: event.id,
  }))
  const rawItems = products.map((product, index) => ({
    ...createCartItemFromProduct(product),
    quantity: terms[index]!.quantity,
  }))
  const cartItems = shipping
    ? prepareCartFulfillment(rawItems, [shipping]).items
    : rawItems
  const pricing = buildCheckoutPricingIntent(cartItems, null, nowMs)
  if (pricing.status !== "ok") {
    throw new Error("Expected exact supplier pricing")
  }
  const quoteAuthority: CheckoutSparkQuoteAuthority = {
    products,
    pricing,
    ...(shippingEvent ? { shippingSourceEvents: [shippingEvent] } : {}),
    lines: products.map((product, index) => ({
      productCoordinate: product.id,
      productEventId: product.sourceEventId,
      merchantPubkey,
      quantity: terms[index]!.quantity,
      ...(shipping && index === 0
        ? {
            shippingOption: {
              coordinate: shipping.id,
              eventId: shipping.eventId,
            },
          }
        : {}),
    })),
  }
  const profile = (secret: Uint8Array, lud16: string) =>
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({ lud16 }),
      },
      secret
    )
  const merchantProfile = profile(
    merchantSecret,
    "merchant@wallet.conduit.market"
  )
  const supplierProfile = profile(
    supplierSecret,
    "supplier@wallet.conduit.market"
  )
  const profileContexts: Record<string, SelectedProfileContext> = {}
  for (const event of [merchantProfile, supplierProfile]) {
    profileContexts[event.pubkey] = {
      ...createSelectedProfileContext({
        pubkey: event.pubkey,
        row: {
          pubkey: event.pubkey,
          eventId: event.id,
          eventCreatedAt: event.created_at,
          rawContent: event.content,
          cachedAt: nowMs,
        },
        observed: true,
        readComplete: true,
      }),
      signedEvent: event,
    }
  }
  const sourceEvents: SignedPublicNostrEvent[] =
    snapshotCheckoutSparkPlanSourceEvents([
      ...productEvents,
      ...(shippingEvent ? [shippingEvent] : []),
      merchantProfile,
      supplierProfile,
    ])

  return {
    nowMs,
    merchantSigner,
    merchantPubkey,
    supplierPubkey,
    productEvents,
    products,
    cartItems,
    quoteAuthority,
    merchantProfile,
    supplierProfile,
    sourceEvents,
    profileContexts,
  }
}
