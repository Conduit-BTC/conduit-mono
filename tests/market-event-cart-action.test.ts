import { describe, expect, it } from "bun:test"
import { getEventCatalogCartAction } from "../apps/market/src/lib/event-market-cart-action"

describe("Market event catalog cart action", () => {
  it("does not reuse previous pickup authorization during a refresh", () => {
    expect(
      getEventCatalogCartAction({
        state: "active",
        purchaseReady: true,
        hasPickupFulfillment: true,
        isChecking: true,
      })
    ).toEqual({ enabled: false, disabledLabel: "Checking pickup…" })
  })

  it("keeps an active exact pickup product addable", () => {
    expect(
      getEventCatalogCartAction({
        state: "active",
        purchaseReady: true,
        hasPickupFulfillment: true,
      })
    ).toEqual({ enabled: true, disabledLabel: null })
  })

  it("allows reversible cart intent while pickup evidence is still pending", () => {
    expect(
      getEventCatalogCartAction({
        state: "active",
        purchaseReady: false,
        hasPickupFulfillment: false,
        allowPendingCart: true,
        isChecking: true,
      })
    ).toEqual({ enabled: true, disabledLabel: null })
  })

  it("never lets pending cart intent bypass explicit organizer closure", () => {
    expect(
      getEventCatalogCartAction({
        state: "ended",
        orderAcceptance: "closed",
        purchaseReady: false,
        hasPickupFulfillment: false,
        allowPendingCart: true,
        isChecking: true,
      })
    ).toEqual({ enabled: false, disabledLabel: "Event closed" })
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

it("names explicit organizer closure independently of the advertised end", () => {
  expect(
    getEventCatalogCartAction({
      state: "ended",
      orderAcceptance: "closed",
      purchaseReady: false,
      hasPickupFulfillment: true,
    })
  ).toEqual({ enabled: false, disabledLabel: "Event closed" })
})
