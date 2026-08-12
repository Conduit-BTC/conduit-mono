import { describe, expect, it } from "bun:test"
import { getEventCatalogCartAction } from "../apps/market/src/lib/event-market-cart-action"

describe("Market event catalog cart action", () => {
  it("keeps an active exact pickup product addable", () => {
    expect(
      getEventCatalogCartAction({
        state: "active",
        purchaseReady: true,
        hasPickupFulfillment: true,
      })
    ).toEqual({ enabled: true, disabledLabel: null })
  })

  it("keeps a visible recovery action when retained event evidence is stale", () => {
    expect(
      getEventCatalogCartAction({
        state: "stale",
        purchaseReady: false,
        hasPickupFulfillment: true,
      })
    ).toEqual({ enabled: false, disabledLabel: "Refresh required" })
  })

  it("keeps ended and unlinked products visibly unavailable", () => {
    expect(
      getEventCatalogCartAction({
        state: "ended",
        purchaseReady: false,
        hasPickupFulfillment: true,
      })
    ).toEqual({ enabled: false, disabledLabel: "Event ended" })
    expect(
      getEventCatalogCartAction({
        state: "active",
        purchaseReady: false,
        hasPickupFulfillment: false,
      })
    ).toEqual({ enabled: false, disabledLabel: "Pickup unavailable" })
  })

  it("waits for the active relay scope and keeps a manual recovery control", async () => {
    const [hook, route, main] = await Promise.all([
      Bun.file("apps/market/src/hooks/useEventMarket.ts").text(),
      Bun.file("apps/market/src/routes/events/$collectionRef.tsx").text(),
      Bun.file("apps/market/src/main.tsx").text(),
    ])

    expect(hook).toContain("useConduitSession")
    expect(hook).toContain("session.relayScope")
    expect(hook).toContain("enabled: session.relaySettingsReady")
    expect(route).toContain("onAddToCart={add}")
    expect(route).toContain("cartActionDisabled={!cartAction.enabled}")
    expect(route).toContain("Refresh evidence")
    expect(main).toContain('root === "event-market"')
  })
})
