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

  it("guards Orders retry before freshness, target replacement, and legacy payment", async () => {
    const route = await Bun.file("apps/market/src/routes/orders.tsx").text()
    const retry = route.slice(
      route.indexOf("async function retryPayment(): Promise<void>"),
      route.indexOf("async function runRetryPayment(")
    )
    expect(
      retry.indexOf("assertLegacyOrderPaymentAllowed(row.lifecycle)")
    ).toBeLessThan(retry.indexOf("await verifyRetryFreshness()"))
    const targetReplacement = route.slice(
      route.indexOf("async function persistTargetAndBuildServiceCtx()"),
      route.indexOf("const withBusy = useCallback(")
    )
    expect(
      targetReplacement.indexOf(
        "assertLegacyOrderPaymentAllowed(row.lifecycle)"
      )
    ).toBeLessThan(
      targetReplacement.indexOf("await replaceOrderPaymentTarget(")
    )
    expect(
      targetReplacement.indexOf(
        "assertLegacyOrderPaymentAllowed(await getOrderLifecycle(vm.orderId))"
      )
    ).toBeLessThan(
      targetReplacement.indexOf("await replaceOrderPaymentTarget(")
    )
    const directRun = route.slice(
      route.indexOf("async function runRetryPayment("),
      route.indexOf("async function finishAcceptedOrderRecovery(")
    )
    expect(
      directRun.indexOf("assertLegacyOrderPaymentAllowed(row.lifecycle)")
    ).toBeLessThan(directRun.indexOf("runOrderPayment(context)"))
    expect(
      directRun.indexOf(
        "assertLegacyOrderPaymentAllowed(await getOrderLifecycle(vm.orderId))"
      )
    ).toBeLessThan(directRun.indexOf("runOrderPayment(context)"))
  })
})
