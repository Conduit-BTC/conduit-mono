import { describe, expect, it } from "bun:test"
import { createMerchantCheckoutSparkPayoutReviewSelection } from "../apps/merchant/src/lib/checkout-spark-payout-review-selection"

describe("Merchant manual payout review selection", () => {
  it("revokes consent when the same order ID changes participant or checkout", () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("shared-order", "buyer-a:checkout-a")
    const isCurrent = selection.capture("shared-order", "buyer-a:checkout-a")
    expect(isCurrent()).toBe(true)
    selection.select("shared-order", "buyer-b:checkout-b")
    expect(isCurrent()).toBe(false)
    expect(selection.capture("shared-order", "buyer-a:checkout-a")()).toBe(
      false
    )
    expect(selection.capture("shared-order", "buyer-b:checkout-b")()).toBe(true)
    selection.select("shared-order", "buyer-b:checkout-c")
    expect(selection.capture("shared-order", "buyer-b:checkout-b")()).toBe(
      false
    )
  })

  it("drops a held review when the same-ID participant changes and returns before completion", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("shared-order", "buyer-a:checkout-a")
    const isCurrent = selection.capture("shared-order", "buyer-a:checkout-a")
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let presented = false
    const review = held.then(() => {
      if (isCurrent()) presented = true
    })
    selection.select("shared-order", "buyer-b:checkout-b")
    selection.select("shared-order", "buyer-a:checkout-a")
    release()
    await review
    expect(presented).toBe(false)
    expect(isCurrent()).toBe(false)
  })

  it.each([false, true])(
    "drops a delayed review after selecting another order (return to A: %s)",
    async (returnToA) => {
      const selection = createMerchantCheckoutSparkPayoutReviewSelection()
      selection.select("order-a")
      const isCurrent = selection.capture("order-a")
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let presented = false
      const review = held.then(() => {
        if (isCurrent()) presented = true
      })
      selection.select("order-b")
      if (returnToA) selection.select("order-a")
      release()
      await review
      expect(presented).toBe(false)
      expect(isCurrent()).toBe(false)
    }
  )

  it("revokes an already displayed review before confirmation on order change", () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("order-a")
    const confirmAllowed = selection.capture("order-a")
    expect(confirmAllowed()).toBe(true)
    selection.select("order-b")
    expect(confirmAllowed()).toBe(false)
    selection.select("order-a")
    expect(confirmAllowed()).toBe(false)
    expect(selection.capture("order-a")()).toBe(true)
  })

  it("retains review consent across ordinary same-order renders", () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    const revision = selection.select("order-a")
    const isCurrent = selection.capture("order-a")
    expect(selection.select("order-a")).toBe(revision)
    expect(isCurrent()).toBe(true)
    expect(selection.capture("order-b")()).toBe(false)
    selection.select(null)
    expect(isCurrent()).toBe(false)
  })
})
