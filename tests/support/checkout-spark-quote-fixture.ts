import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import { parseCheckoutSparkSignedProductFields } from "../../packages/core/src/protocol/checkout-spark-product-fields"
import type { CheckoutSparkQuoteAuthority } from "../../apps/market/src/lib/checkout-spark-quote-authority"

/** Only the fields consumed by the router's frozen-quote boundary. */
export function checkoutSparkQuoteFixture(
  merchantIdentity: string | Uint8Array,
  commerceTotalSats = 1_000
): CheckoutSparkQuoteAuthority {
  const merchantPubkey =
    typeof merchantIdentity === "string"
      ? merchantIdentity
      : getPublicKey(merchantIdentity)
  const productCoordinate = `30402:${merchantPubkey}:router-fixture`
  const signedProduct =
    typeof merchantIdentity === "string"
      ? null
      : finalizeEvent(
          {
            kind: 30_402,
            created_at: 1_800_000_000,
            tags: [
              ["d", "router-fixture"],
              ["title", "Router fixture"],
              ["price", String(commerceTotalSats), "SAT"],
              ["type", "simple", "digital"],
            ],
            content: "Router test product",
          },
          merchantIdentity
        )
  const productEventId = signedProduct?.id ?? "d".repeat(64)
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
      signedProduct
        ? {
            ...parseCheckoutSparkSignedProductFields(signedProduct),
            sourceEventId: productEventId,
          }
        : {
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
