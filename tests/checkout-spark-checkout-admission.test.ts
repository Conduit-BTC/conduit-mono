import { describe, expect, test } from "bun:test"
import type { PreparedProductFulfillment } from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import { assessCheckoutSparkCheckoutAdmission } from "../apps/market/src/lib/checkout-spark-checkout-admission"

const merchant = "1".repeat(64)
const digital: CartItem = {
  productId: `30402:${merchant}:admission`,
  merchantPubkey: merchant,
  title: "Admission fixture",
  price: 1_000,
  currency: "SATS",
  quantity: 1,
  format: "digital",
  fulfillment: { type: "digital" },
}
const physical: CartItem = {
  ...digital,
  format: "physical",
  fulfillment: { type: "shipping" },
}
function assess(
  items: CartItem[],
  fulfillment = new Map<string, PreparedProductFulfillment>()
) {
  return assessCheckoutSparkCheckoutAdmission({
    enabled: true,
    freeOrderVerified: false,
    items,
    fulfillment,
  })
}

describe("required checkout routing is separate from readiness", () => {
  test("supported SAT and fiat digital purchases require routing", () => {
    expect(assess([digital])).toEqual({ mode: "router", ready: true })
    expect(assess([{ ...digital, currency: "USD", price: 1 }])).toEqual({
      mode: "router",
      ready: true,
    })
  })

  test("unsupported or unresolved upfront shipping cannot fall back to direct payment", () => {
    const item = { ...physical, shippingOptionId: `30406:${merchant}:pending` }
    const unresolved = new Map<string, PreparedProductFulfillment>([
      [
        item.productId,
        {
          intent: "fixed_standard",
          status: "order_first",
          reason: "unresolved",
        },
      ],
    ])
    expect(assess([item], unresolved)).toEqual({ mode: "router", ready: true })
    expect(
      assess([{ ...item, shippingOptionLaunchUnsupported: true }], unresolved)
    ).toEqual({ mode: "router", ready: false })
  })

  test("missing fulfillment evidence does not establish negotiated shipping", () => {
    expect(assess([physical])).toEqual({ mode: "router", ready: false })
  })

  test("only positively resolved coordinate-after-order shipping retains order-first", () => {
    const negotiated = new Map<string, PreparedProductFulfillment>([
      [
        physical.productId,
        {
          intent: "coordinate_after_order",
          status: "ready",
          reason: "missing_reference",
        },
      ],
    ])
    expect(assess([physical], negotiated)).toEqual({ mode: "order_first" })
    expect(
      assess(
        [{ ...digital, productId: `30402:${merchant}:digital` }, physical],
        negotiated
      )
    ).toEqual({ mode: "order_first" })
  })

  test("verified free and disabled profiles retain their existing flow", () => {
    expect(
      assessCheckoutSparkCheckoutAdmission({
        enabled: true,
        freeOrderVerified: true,
        items: [physical],
        fulfillment: new Map(),
      })
    ).toEqual({ mode: "free" })
    expect(
      assessCheckoutSparkCheckoutAdmission({
        enabled: false,
        freeOrderVerified: false,
        items: [digital],
        fulfillment: new Map(),
      })
    ).toEqual({ mode: "disabled" })
    expect(assess([])).toEqual({ mode: "disabled" })
  })
})
