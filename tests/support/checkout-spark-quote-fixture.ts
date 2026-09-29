import type { CheckoutSparkQuoteAuthority } from "../../apps/market/src/lib/checkout-spark-quote-authority"

/** Only the fields consumed by the router's frozen-quote boundary. */
export function checkoutSparkQuoteFixture(
  merchantPubkey: string,
  commerceTotalSats = 1_000
): CheckoutSparkQuoteAuthority {
  const productCoordinate = `30402:${merchantPubkey}:router-fixture`
  const productEventId = "d".repeat(64)
  return {
    pricing: {
      status: "ok",
      totalSats: commerceTotalSats,
      items: [
        {
          productId: productCoordinate,
          quantity: 1,
          priceAtPurchase: commerceTotalSats,
          shippingCostSats: 0,
        },
      ],
    },
    products: [
      {
        id: productCoordinate,
        sourceEventId: productEventId,
        pubkey: merchantPubkey,
      },
    ],
    lines: [
      {
        productCoordinate,
        productEventId,
        merchantPubkey,
        quantity: 1,
      },
    ],
  } as CheckoutSparkQuoteAuthority
}
