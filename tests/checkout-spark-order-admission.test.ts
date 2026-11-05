import { describe, expect, it } from "bun:test"
import { assertLegacyOrderPaymentAllowed } from "../apps/market/src/lib/checkout-spark-order-admission"

const routerBinding = {
  checkoutId: "checkout-1",
  planDigest: "a".repeat(64),
  walletId: "spark-checkout-1",
}

describe("legacy order payment admission", () => {
  it("preserves direct retries for historical orders without a router binding", () => {
    expect(() => assertLegacyOrderPaymentAllowed(undefined)).not.toThrow()
    expect(() =>
      assertLegacyOrderPaymentAllowed({ checkoutSparkRouterBinding: undefined })
    ).not.toThrow()
  })

  it("fails closed for a router-bound order before an old payment context is built", () => {
    expect(() =>
      assertLegacyOrderPaymentAllowed({
        checkoutSparkRouterBinding: routerBinding,
      })
    ).toThrow("Resume its saved checkout")
    // A damaged local record is not permission to fall back to direct pay.
    expect(() =>
      assertLegacyOrderPaymentAllowed({
        checkoutSparkRouterBinding: null,
      } as never)
    ).toThrow("Resume its saved checkout")
  })
})
