import { describe, expect, it } from "bun:test"

describe("checkout completion navigation contracts", () => {
  it("routes completed checkout flows to Orders instead of stale cart state", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    // CND-122: completed checkout flows navigate to the status-first Orders
    // tracker via a deep link (`?order=<id>`), so Orders can render the order
    // immediately from durable local lifecycle state.
    const ordersNavigations =
      checkoutRoute.match(
        /navigate\(\{\s*to: "\/orders",\s*search: \{ order: orderId \},\s*replace: true,?\s*\}\)/g
      ) ?? []

    expect(checkoutRoute).toContain("const navigate = useNavigate()")
    expect(ordersNavigations.length).toBeGreaterThanOrEqual(2)
    expect(checkoutRoute).toContain("createOrderLifecycle(")
  })

  it("does not offer cart as a terminal paid-checkout action", async () => {
    const paymentTracker = await Bun.file(
      "apps/market/src/components/PaymentTracker.tsx"
    ).text()

    expect(paymentTracker).toContain('<Link to="/orders">View orders</Link>')
    expect(paymentTracker).not.toContain('<Link to="/cart">Back to cart</Link>')
  })

  it("uses the published fast-checkout total for degraded success telemetry", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "let publishedTotalSats: number | null = null"
    )
    expect(checkoutRoute).toContain(
      "publishedTotalSats = checkoutPricing.totalSats"
    )
    expect(checkoutRoute).toContain(
      "const deliveredAmountSats = publishedTotalSats ?? total"
    )
    expect(checkoutRoute).toContain("amountSats: deliveredAmountSats")
  })

  it("renders and publishes the same server-authorized anonymous checkout state", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "Signed listing total — review before confirming"
    )
    expect(checkoutRoute).toContain("authorizedPricing={reviewedAnonPricing}")
    expect(checkoutRoute).toContain("for (const item of checkoutPricing.items)")
    expect(checkoutRoute).toContain(
      "items: buildLifecycleItems(checkoutPricing.items)"
    )
  })

  it("offers guest shoppers a signer path when invoice checkout is unavailable", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkoutRoute).toContain("{isGuestCheckout && !fastEligible && (")
    expect(checkoutRoute).toContain("Connect signer to send order")
    expect(checkoutRoute).toContain("<SignerSwitch")
  })

  it("warns guests about tab-scoped recovery before and during payment", async () => {
    const checkoutRoute = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const ordersRoute = await Bun.file(
      "apps/market/src/routes/orders.tsx"
    ).text()

    expect(checkoutRoute).toContain(
      "Keep this tab open until the payment is reported"
    )
    expect(ordersRoute).toContain("Closing it ends")
    expect(ordersRoute).toContain("local access to this guest order")
    expect(ordersRoute).toContain("merchant will follow up")
    expect(ordersRoute).toContain("disabled={!activeBuyerPubkey || isFetching}")
  })
})
