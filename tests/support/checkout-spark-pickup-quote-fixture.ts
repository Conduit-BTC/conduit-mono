import {
  parseProductEvent,
  resolveCheckoutSparkSignedPickup,
} from "@conduit/core"
import type { CartItem } from "../../apps/market/src/lib/cart-model"
import type { CheckoutSparkQuoteAuthority } from "../../apps/market/src/lib/checkout-spark-quote-authority"
import { createCheckoutSparkPickupFixture } from "./checkout-spark-pickup-fixture"

/** Historical exact signed quote only; never new public checkout admission. */
export async function createCheckoutSparkPickupQuoteFixture(
  options: Parameters<typeof createCheckoutSparkPickupFixture>[0] = {}
) {
  const f = createCheckoutSparkPickupFixture(options)
  const product = {
    ...parseProductEvent(f.productEvent),
    sourceEventId: f.productEvent.id,
  }
  const fulfillment = resolveCheckoutSparkSignedPickup(f)!
  const sourceShippingCost = { ...fulfillment.sourceCost }
  const item: CartItem = {
    productId: product.id,
    merchantPubkey: f.merchantPubkey,
    title: product.title,
    price: product.price,
    currency: product.currency,
    priceSats: product.priceSats,
    sourcePrice: product.sourcePrice,
    format: "physical",
    quantity: f.line.quantity,
    fulfillment: fulfillment as unknown as CartItem["fulfillment"],
    shippingCostSats: f.line.unitShippingSats,
    sourceShippingCost,
    shippingOptionId: f.line.shippingOption!.coordinate,
    shippingOptionDTag: "booth",
    productEventId: f.productEvent.id,
    productUpdatedAt: product.updatedAt,
    signedProductEvent: f.productEvent,
    stock: product.stock,
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    canonicalShippingResolved: true,
  }
  const totalSats =
    f.line.quantity * (f.line.unitMerchandiseSats + f.line.unitShippingSats)
  const quote: CheckoutSparkQuoteAuthority = {
    pricing: {
      status: "ok",
      itemSubtotalSats: f.line.quantity * f.line.unitMerchandiseSats,
      totalSats,
      totalMsats: totalSats * 1000,
      approximate: false,
      paymentRequired: true,
      shippingCost: {
        status: f.line.unitShippingSats === 0 ? "included" : "priced",
        totalSats: f.line.quantity * f.line.unitShippingSats,
        missingProductIds: [],
      },
      items: [
        {
          productId: product.id,
          title: product.title,
          format: "physical",
          quantity: f.line.quantity,
          priceAtPurchase: f.line.unitMerchandiseSats,
          currency: "SATS",
          shippingCostSats: f.line.unitShippingSats,
          sourceShippingCost,
          shippingOptionId: f.line.shippingOption!.coordinate,
          shippingOptionDTag: "booth",
          sourcePrice: product.sourcePrice,
          fulfillment: fulfillment as unknown as CartItem["fulfillment"],
        },
      ],
    },
    products: [product],
    lines: [
      {
        productCoordinate: f.line.productCoordinate,
        productEventId: f.line.productEventId,
        merchantPubkey: f.line.merchantPubkey,
        quantity: f.line.quantity,
        shippingOption: f.line.shippingOption,
        pickup: f.line.pickup,
      },
    ],
    shippingSourceEvents: [f.pickup],
    pickupSourceEvents: f.sourceEvents,
  }
  return { ...f, product, item, quote }
}
