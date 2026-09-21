import { describe, expect, it } from "bun:test"
import {
  buildEventMarketShareRelayHints,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  type EventMarketResolution,
} from "@conduit/core"
import { subscribeToTimeBoundaries } from "@conduit/ui"
import {
  filterAndSortEventMarkets,
  getEventTimelineBoundaries,
  getEventTimelinePresentation,
  getEventTimelineStatus,
  getNextEventTimelineLimit,
  MARKET_EVENT_TIMELINE_PAGE_SIZE,
  type EventTimelineWindow,
} from "../apps/market/src/lib/eventTimeline"
import { createFakeTimeBoundaryClock } from "./helpers/fake-time-boundary-clock"

function timedMarket(start: number, end: number): EventMarketResolution {
  const organizer = "a".repeat(64)
  const reference = `30405:${organizer}:boundary`
  return {
    state: "active",
    reference,
    organizerPubkey: organizer,
    collectionCoordinate: reference,
    calendarCoordinate: `31923:${organizer}:boundary`,
    collection: {
      coordinate: reference,
      eventId: "1".repeat(64),
      authorPubkey: organizer,
      dTag: "boundary",
      title: "Boundary event",
      content: "",
      eventCoordinates: [`31923:${organizer}:boundary`],
      pickupCoordinates: [],
      productCoordinates: [],
      unsupportedReferences: [],
      createdAt: start,
    },
    calendar: {
      coordinate: `31923:${organizer}:boundary`,
      eventId: "2".repeat(64),
      authorPubkey: organizer,
      dTag: "boundary",
      kind: 31923,
      title: "Boundary event",
      content: "",
      locations: [],
      start,
      end,
      createdAt: start,
    },
    pickups: [],
    organizerProductCoordinates: [],
    acceptedProductCoordinates: [],
    acceptedProductEvidence: [],
    organizerOnlyProductCoordinates: [],
    participationRequests: [],
    participationBudget: {
      state: "within_budget",
      targetCount: 0,
      targetLimit: 64,
    },
    pickupBudget: {
      state: "within_budget",
      targetCount: 0,
      targetLimit: 64,
    },
    coverage: {
      attemptedRelayCount: 1,
      completeRelayCount: 1,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
}

describe("Market Events timeline route", () => {
  it("registers Products, Merchants, and Events in that order", async () => {
    const [route, navigation, root, tree] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/components/MarketBrowseNavigation.tsx").text(),
      Bun.file("apps/market/src/routes/__root.tsx").text(),
      Bun.file("apps/market/src/routeTree.gen.ts").text(),
    ])

    expect(route).toContain('createFileRoute("/events/")')
    expect(navigation).toContain('to: "/products"')
    expect(navigation).toContain('to: "/merchants"')
    expect(navigation).toContain('to: "/events"')
    expect(navigation.indexOf('label: "Products"')).toBeLessThan(
      navigation.indexOf('label: "Merchants"')
    )
    expect(navigation.indexOf('label: "Merchants"')).toBeLessThan(
      navigation.indexOf('label: "Events"')
    )
    expect(navigation).toContain("SegmentedControl")
    expect(navigation).toContain("Following + Conduit")
    expect(navigation).toMatch(
      /\{connected && \([\s\S]*?aria-label="Market perspective"/
    )
    expect(navigation).toContain('aria-label="Market perspective"')
    expect(navigation).toContain("aria-pressed={selected}")
    expect(root).toContain('pathname === "/events"')
    expect(tree).toContain("'/events/'")
    expect(route).not.toContain("SignerSwitch")
    expect(route).not.toContain("Connect a signer")
  })

  it("uses bounded perspective discovery and preserves partial positives", async () => {
    const [route, timeline, emptyState, hook, discovery] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/components/MarketEventsTimeline.tsx").text(),
      Bun.file("apps/market/src/components/EventTimelineEmptyState.tsx").text(),
      Bun.file("apps/market/src/hooks/useEventTimeline.ts").text(),
      Bun.file("packages/core/src/protocol/event-market-discovery.ts").text(),
    ])

    expect(hook).toContain("resolvePerspectiveAuthorPubkeys")
    expect(hook).toContain("firstDegreeQuery.isRefetchError")
    expect(hook).toContain("firstDegreeQuery.isPaused")
    expect(hook).toContain("discoverPerspectiveEventMarkets")
    expect(hook).toContain("includeEnded: true")
    expect(route).not.toContain("getOrganizerDiscoveryPresentation")
    expect(route).not.toContain("discoveryPresentation")
    expect(timeline).toContain('aria-label="Refresh events"')
    expect(timeline).toContain("EventTimelineEmptyState")
    expect(timeline).toContain("getResultPresentation")
    expect(timeline).toContain("resultCount: discovery.markets.length")
    expect(timeline).toContain("visibleResultCount: filteredMarkets.length")
    expect(timeline).toContain("!discovery.isRefreshStale")
    expect(timeline).toContain('resultPresentation.visibility === "compact"')
    expect(timeline).toContain(
      "Discovery is incomplete, so matching events may still be available."
    )
    expect(emptyState).toContain("getResultPresentation")
    expect(emptyState).toContain("onRetry")
    expect(timeline).toContain("presentation.currentAndFuture.map")
    expect(discovery).toContain("readEventMarketCollectionCandidates")
    expect(discovery).toContain("perspectiveOrganizerSet.has(organizerPubkey)")
    expect(discovery).not.toContain("FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT")
  })

  it("keeps the event page focused on useful filters and results", async () => {
    const [route, timeline, merchantEditor] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/components/MarketEventsTimeline.tsx").text(),
      Bun.file(
        "apps/merchant/src/components/OrganizerEventMarketEditor.tsx"
      ).text(),
    ])

    expect(route).not.toContain("Event markets")
    expect(route).not.toContain("Browse organizer event markets")
    expect(route).not.toContain('id="event-topic-filter"')
    expect(route).not.toContain('id="event-date-filter"')
    expect(route).not.toContain("EVENT_TIMELINE_WINDOWS")
    expect(route).not.toContain("Retry discovery")
    expect(route).toContain("MarketEventsTimeline")
    expect(timeline).toContain('aria-label="Events timeline"')
    expect(timeline).toContain('aria-label="Refresh events"')
    expect(timeline).toContain("EventTimelineViewport")
    expect(merchantEditor).not.toMatch(/htmlFor="[^"]*topic/i)
  })

  it("paginates chronologically around Now with past events above", () => {
    const day = 86_400_000
    const past = Array.from({ length: 14 }, (_, index) =>
      timedMarket(index * day, index * day + day)
    )
    const future = Array.from({ length: 14 }, (_, index) =>
      timedMarket((20 + index) * day, (21 + index) * day)
    )
    const now = 18 * day
    const markets = filterAndSortEventMarkets(
      [...past, ...future],
      { window: "all" },
      now
    )
    const first = getEventTimelinePresentation(markets, {}, now)

    expect(first.past).toHaveLength(MARKET_EVENT_TIMELINE_PAGE_SIZE)
    expect(first.currentAndFuture).toHaveLength(MARKET_EVENT_TIMELINE_PAGE_SIZE)
    expect(first.hiddenEarlierCount).toBe(2)
    expect(first.hiddenLaterCount).toBe(2)
    expect(first.past.at(-1)?.calendar.end).toBeLessThanOrEqual(now)
    expect(first.currentAndFuture[0]?.calendar.end).toBeGreaterThan(now)
    expect(getNextEventTimelineLimit(first.past.length, past.length)).toBe(
      past.length
    )
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
        /!signal\.aborted\s*&&\s*authGenerationRef.current === authGeneration/g
      )
    ).toHaveLength(2)
    expect(hook).toContain("discoveryScopeRef.current === discoveryScope")
  })

  it("renders shared timeline entries with exact event links and no product-count claim", async () => {
    const [route, timeline, entry] = await Promise.all([
      Bun.file("apps/market/src/routes/events/index.tsx").text(),
      Bun.file("apps/market/src/components/MarketEventsTimeline.tsx").text(),
      Bun.file("packages/ui/src/components/EventTimeline.tsx").text(),
    ])

    expect(timeline).toContain("encodeEventMarketNaddr")
    expect(route).toContain('to: "/events/$collectionRef"')
    expect(timeline).toContain("EventTimelineEntry")
    expect(entry).toContain("export function EventTimelineEntry")
    expect(timeline).not.toMatch(/product count/i)
    expect(timeline).not.toContain("acceptedProductCoordinates.length")
  })

  it("balances saturated exact-link hints across collection, calendar, and pickup sources", async () => {
    const timeline = await Bun.file(
      "apps/market/src/components/MarketEventsTimeline.tsx"
    ).text()
    const collectionRelays = Array.from(
      { length: 8 },
      (_, index) => `wss://collection-${index + 1}.relay.conduit.market/events`
    )
    const calendarRelays = Array.from(
      { length: 8 },
      (_, index) => `wss://calendar-${index + 1}.relay.conduit.market/events`
    )
    const pickupRelays = Array.from(
      { length: 8 },
      (_, index) => `wss://pickup-${index + 1}.relay.conduit.market/events`
    )
    const relayHints = buildEventMarketShareRelayHints([
      collectionRelays,
      calendarRelays,
      pickupRelays,
    ])
    const organizer = "a".repeat(64)
    const naddr = encodeEventMarketNaddr(
      `30405:${organizer}:balanced-sources`,
      relayHints
    )

    expect(relayHints).toEqual([
      collectionRelays[0],
      calendarRelays[0],
      pickupRelays[0],
      ...collectionRelays.slice(1, 5),
    ])
    expect(relayHints).toHaveLength(7)
    expect(decodeEventMarketReference(naddr, [30405])?.relayHints).toEqual(
      relayHints
    )
    expect(timeline).toContain("buildEventMarketShareRelayHints")
    expect(timeline).toContain(
      "...market.pickups.map((pickup) => pickup.sourceRelayUrls)"
    )
  })

  it("keeps private observed relays out of portable event links", () => {
    const relayHints = buildEventMarketShareRelayHints([
      [
        "wss://127.0.0.1:7447/private",
        "wss://localhost:7447/private",
        "wss://relay.conduit.market/events",
      ],
    ])

    expect(relayHints).toEqual(["wss://relay.conduit.market/events"])
    const organizer = "a".repeat(64)
    const naddr = encodeEventMarketNaddr(
      `30405:${organizer}:public-only-hints`,
      relayHints
    )
    expect(decodeEventMarketReference(naddr, [30405])?.relayHints).toEqual([
      "wss://relay.conduit.market/events",
    ])
  })

  it("advances a mounted timeline at start and end without polling", async () => {
    const timeline = await Bun.file(
      "apps/market/src/components/MarketEventsTimeline.tsx"
    ).text()
    const start = 1_000
    const end = 2_000
    const later = timedMarket(3_000, 4_000)
    const event = timedMarket(start, end)
    const clock = createFakeTimeBoundaryClock(start - 1)
    let renderedNowMs = clock.now()
    const unmount = subscribeToTimeBoundaries({
      boundaries: [start, end, later.calendar!.start, later.calendar!.end],
      currentNowMs: renderedNowMs,
      onBoundary: (nowMs) => {
        renderedNowMs = nowMs
      },
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    expect(timeline).toContain("useTimeBoundaryNow(timelineBoundaries)")
    expect(timeline).not.toContain("const nowMs = Date.now()")
    expect(timeline).not.toContain("setInterval")
    expect(
      getEventTimelineStatus(
        filterAndSortEventMarkets([event], {}, renderedNowMs)[0]!,
        renderedNowMs
      ).label
    ).toBe("Upcoming")

    clock.advanceTo(start)
    expect(
      getEventTimelineStatus(
        filterAndSortEventMarkets([event], {}, renderedNowMs)[0]!,
        renderedNowMs
      ).label
    ).toBe("Happening now")

    clock.advanceTo(end)
    const endedEvent = filterAndSortEventMarkets(
      [event],
      { window: "all" },
      renderedNowMs
    )[0]!
    expect(getEventTimelineStatus(endedEvent, renderedNowMs).label).toBe(
      "Past event"
    )
    expect(filterAndSortEventMarkets([event], {}, renderedNowMs)).toEqual([])
    expect(clock.pendingTimerCount()).toBe(1)

    unmount()
    expect(clock.pendingTimerCount()).toBe(0)
  })

  it.each([
    ["7d", 7],
    ["30d", 30],
  ] as const)(
    "admits an event when the mounted %s window reaches its rolling cutoff",
    async (window, days) => {
      const dayMs = 86_400_000
      const start = 40 * dayMs
      const event = timedMarket(start, start + dayMs)
      const cutoff = start - days * dayMs
      const clock = createFakeTimeBoundaryClock(cutoff - 1)
      let renderedNowMs = clock.now()
      const unmount = subscribeToTimeBoundaries({
        boundaries: getEventTimelineBoundaries(
          [event],
          window as EventTimelineWindow
        ),
        currentNowMs: renderedNowMs,
        onBoundary: (nowMs) => {
          renderedNowMs = nowMs
        },
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
      })

      expect(
        filterAndSortEventMarkets([event], { window }, renderedNowMs)
      ).toEqual([])

      clock.advanceTo(cutoff)
      expect(
        filterAndSortEventMarkets([event], { window }, renderedNowMs)
      ).toHaveLength(1)

      unmount()
      expect(clock.pendingTimerCount()).toBe(0)
    }
  )
})
