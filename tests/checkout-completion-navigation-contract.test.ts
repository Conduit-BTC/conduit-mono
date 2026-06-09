import { describe, expect, it } from "bun:test"

describe("checkout completion navigation contracts", () => {
  it("routes completed checkout flows to Orders instead of stale cart state", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const ordersNavigations =
      checkoutRoute.match(/navigate\(\{ to: "\/orders", replace: true \}\)/g) ??
      []

    expect(checkoutRoute).toContain("const navigate = useNavigate()")
    expect(ordersNavigations.length).toBeGreaterThanOrEqual(3)
    expect(checkoutRoute).toContain('<Link to="/orders">')
  })

  it("does not offer cart as a terminal paid-checkout action", async () => {
    const paymentTracker = await Bun.file(
      "apps/market/src/components/PaymentTracker.tsx"
    ).text()

    expect(paymentTracker).toContain('<Link to="/orders">View orders</Link>')
    expect(paymentTracker).not.toContain('<Link to="/cart">Back to cart</Link>')
  })
})
