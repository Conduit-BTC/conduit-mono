import { describe, expect, it } from "bun:test"

describe("merchant event handoff UI contract", () => {
  it("configures one event arrangement and blocks unresolved publication", async () => {
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()

    expect(panel).toContain("resolveMerchantEventHandoffArrangement")
    expect(panel).toContain("loadMerchantEventHandoffPreference")
    expect(panel).toContain("loadMerchantEventHandoffChange")
    expect(panel).toContain("Choose once before publishing")
    expect(panel).toContain('arrangement.state === "unconfigured"')
    expect(panel).toContain('arrangement.state === "consistent"')
    expect(panel).toContain('arrangement.state === "transitioning"')
    expect(panel).toContain("arrangementBlockMessage(arrangement)")
    expect(panel).toContain("disabled={!publishable}")
    expect(panel).toContain('freshMarket.state !== "active"')
    expect(panel).toContain("freshArrangement.listings.length > 0")
    expect(panel).toContain(
      'const marketPublishable = market.state === "active"'
    )
  })

  it("hides unavailable organizer handoff and reports transition progress", async () => {
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()

    expect(panel).toContain("organizerHandoffAvailable")
    expect(panel).toContain("market.source.pickup?.coordinate")
    expect(panel).toContain("organizerAvailable ? (")
    expect(panel).not.toContain("disabled={!market.pickupCoordinate}")
    expect(panel).toContain("getMerchantEventHandoffTransitionSummary")
    expect(panel).toContain('aria-label="Affected listings"')
    expect(panel).toContain("affected listing updates are delivered")
  })

  it("makes the product publisher inherit the event arrangement", async () => {
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()
    const publisher = await Bun.file(
      "apps/merchant/src/components/EventProductPublisherDialog.tsx"
    ).text()

    expect(panel).toContain("handoffPreference={handoffPreference}")
    expect(publisher).toContain(
      "createEmptyEventProductForm(market, handoffPreference)"
    )
    expect(publisher).toContain(
      "eventProductFormFromTemplate(template, market, handoffPreference)"
    )
    expect(publisher).toContain("This product inherits the merchant/event")
    expect(publisher).not.toContain('update("handoffMode"')
  })

  it("shows a booth link only for a consistent merchant arrangement", async () => {
    const panel = await Bun.file(
      "apps/merchant/src/components/MerchantEventMarketPanel.tsx"
    ).text()

    expect(panel).toContain("buildMarketEventMerchantBoothUrl")
    expect(panel).toContain(
      'arrangement.selection.mode === "merchant_handoff" && boothUrl'
    )
    expect(panel).toContain("Open booth shopping")
    expect(panel).toContain("does not override signed stock, price, payment")
  })
})
