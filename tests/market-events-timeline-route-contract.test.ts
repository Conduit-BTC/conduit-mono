import { describe, expect, it } from "bun:test"

describe("Market Events timeline route", () => {
  it("registers a guest-visible Events route beside Catalog", async () => {
    const [route, navigation, root, tree] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/components/MarketBrowseNavigation.tsx").text(),
      Bun.file("apps/market/src/routes/__root.tsx").text(),
      Bun.file("apps/market/src/routeTree.gen.ts").text(),
    ])

    expect(route).toContain('createFileRoute("/events/")')
    expect(navigation).toContain('to="/products"')
    expect(navigation).toContain('to="/events"')
    expect(navigation).toContain("Following + Conduit")
    expect(navigation).toContain('aria-label="Market perspective"')
    expect(navigation).toContain("aria-pressed={selected}")
    expect(root).toContain('pathname === "/events"')
    expect(tree).toContain("'/events/'")
    expect(route).not.toContain("SignerSwitch")
    expect(route).not.toContain("Connect a signer")
  })

  it("uses bounded perspective discovery and preserves partial positives", async () => {
    const [route, hook, discovery] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/hooks/useEventTimeline.ts").text(),
      Bun.file("packages/core/src/protocol/event-market-discovery.ts").text(),
    ])

    expect(hook).toContain("resolvePerspectiveAuthorPubkeys")
    expect(hook).toContain("discoverPerspectiveEventMarkets")
    expect(hook).toContain("includeEnded: true")
    expect(route).toContain("getOrganizerDiscoveryPresentation")
    expect(route).toContain("filteredMarkets.map")
    expect(discovery).toContain("readEventMarketCollectionCandidates")
    expect(discovery).toContain("perspectiveOrganizerSet.has(organizerPubkey)")
    expect(discovery).not.toContain("FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT")
  })

  it("binds timeline and follow reads to the current authenticated session", async () => {
    const hook = await Bun.file(
      "apps/market/src/hooks/useEventTimeline.ts"
    ).text()
    expect(hook).toContain(
      "const { pubkey, status, authGeneration } = useAuth()"
    )
    expect(hook).toContain('session.relayScope ?? "no-relay-scope"')
    expect(hook).toMatch(
      /"market-event-timeline",[\s\S]*?authenticatedPubkey,[\s\S]*?authGeneration,/
    )
    expect(
      hook.match(
        /!signal.aborted && authGenerationRef.current === authGeneration/g
      )
    ).toHaveLength(2)
  })

  it("renders reusable cards with exact event links and no product-count claim", async () => {
    const [route, card] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("packages/ui/src/components/EventMarketCard.tsx").text(),
    ])

    expect(route).toContain("encodeEventMarketNaddr")
    expect(route).toContain('to="/events/$collectionRef"')
    expect(route).toContain("EventMarketCard")
    expect(card).toContain("export function EventMarketCard")
    expect(route).not.toMatch(/product count/i)
    expect(route).not.toContain("acceptedProductCoordinates.length")
  })
})
