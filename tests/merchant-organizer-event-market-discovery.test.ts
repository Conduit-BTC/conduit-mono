import { afterEach, describe, expect, it } from "bun:test"
import {
  __setEventMarketTestOverrides,
  __resetEventMarketTestOverrides,
} from "@conduit/core"
import type {
  EventMarketRelayCoverage,
  EventMarketResolution,
  OrganizerEventMarketsReadResult,
} from "@conduit/core"
import {
  getMerchantOrganizerEventCatalogView,
  listOrganizerEventMarkets,
  projectOrganizerEventMarketsReadResult,
  retainMerchantOrganizerEventMarkets,
} from "../apps/merchant/src/lib/event-market"

const ORGANIZER = "a".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:catalog`
const CALENDAR = `31923:${ORGANIZER}:calendar`

const COMPLETE_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 2,
  completeRelayCount: 2,
  partialRelayCount: 0,
  failedRelayCount: 0,
}

function eventMarket(): EventMarketResolution {
  return {
    state: "active",
    reference: COLLECTION,
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: CALENDAR,
    calendar: {
      coordinate: CALENDAR,
      eventId: "b".repeat(64),
      authorPubkey: ORGANIZER,
      dTag: "calendar",
      kind: 31923,
      title: "Night market",
      content: "",
      locations: [],
      start: 1_900_000_000_000,
      end: 1_900_003_600_000,
      createdAt: 1_800_000_000_000,
    },
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
    pickups: [],
    coverage: COMPLETE_COVERAGE,
  }
}

function organizerRead(
  state: OrganizerEventMarketsReadResult["state"],
  markets: EventMarketResolution[] = [],
  overrides: Partial<OrganizerEventMarketsReadResult> = {}
): OrganizerEventMarketsReadResult {
  return {
    markets,
    state,
    coverage: COMPLETE_COVERAGE,
    relayListState: "network",
    relayHintTruncated: false,
    ...overrides,
  }
}

afterEach(() => __resetEventMarketTestOverrides())

describe("Merchant organizer event discovery evidence", () => {
  it("forwards the live account and cancellation through detailed organizer reads", async () => {
    const account = "c".repeat(64)
    const controller = new AbortController()
    let active = true
    const shouldContinue = () => active
    const observed: Array<{
      authenticatedPubkey?: string | null
      signal?: AbortSignal
      shouldContinue?: () => boolean
    }> = []
    __setEventMarketTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: { version: 1, updatedAt: 1, entries: [] },
        signedRelayListAuthoritative: true,
      }),
      getRelayListsDetailed: async (_authors, options) => {
        observed.push(options ?? {})
        return {
          relayLists: new Map(),
          resolutionStates: new Map([[ORGANIZER, "missing"]]),
        }
      },
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (_filter, options) => {
        observed.push(options)
        return { events: [], relays: [], eventsVerified: true }
      },
    })
    const result = await listOrganizerEventMarkets(
      ORGANIZER,
      account,
      controller.signal,
      shouldContinue
    )
    expect(result.markets).toEqual([])
    expect(result.resolutions).toEqual([])
    expect(observed.length).toBeGreaterThan(0)
    for (const options of observed) {
      expect(options.authenticatedPubkey).toBe(account)
      expect(options.signal).toBe(controller.signal)
      expect(options.shouldContinue).toBe(shouldContinue)
    }
    active = false
    expect(
      observed.every((options) => options.shouldContinue?.() === false)
    ).toBe(true)
  })

  it("carries a complete read with events through the Merchant adapter", () => {
    const result = projectOrganizerEventMarketsReadResult(
      organizerRead("complete", [eventMarket()])
    )

    expect(result.state).toBe("complete")
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0]).toMatchObject({
      collectionCoordinate: COLLECTION,
      title: "Night market",
      state: "active",
    })
    expect(getMerchantOrganizerEventCatalogView(result, 0)).toEqual({
      discoveryState: "complete",
      emptyState: null,
      hasKnownReferences: true,
    })
  })

  it("allows the definitive empty state only for a complete bounded read", () => {
    const complete = projectOrganizerEventMarketsReadResult(
      organizerRead("complete")
    )

    expect(getMerchantOrganizerEventCatalogView(complete, 0)).toEqual({
      discoveryState: "complete",
      emptyState: "complete",
      hasKnownReferences: false,
    })
  })

  it("keeps partial events visible and distinguishes a partial empty read", () => {
    const withEvents = projectOrganizerEventMarketsReadResult(
      organizerRead("partial", [eventMarket()])
    )
    const empty = projectOrganizerEventMarketsReadResult(
      organizerRead("partial")
    )

    expect(getMerchantOrganizerEventCatalogView(withEvents, 0)).toEqual({
      discoveryState: "partial",
      emptyState: null,
      hasKnownReferences: true,
    })
    expect(getMerchantOrganizerEventCatalogView(empty, 0)).toEqual({
      discoveryState: "partial",
      emptyState: "partial",
      hasKnownReferences: false,
    })
  })

  it("keeps retained access during unavailable reads without inventing an empty catalog", () => {
    const unavailable = projectOrganizerEventMarketsReadResult(
      organizerRead("unavailable", [], {
        coverage: {
          attemptedRelayCount: 2,
          completeRelayCount: 0,
          partialRelayCount: 0,
          failedRelayCount: 2,
        },
      })
    )

    expect(getMerchantOrganizerEventCatalogView(unavailable, 0)).toEqual({
      discoveryState: "unavailable",
      emptyState: "unavailable",
      hasKnownReferences: false,
    })
    expect(getMerchantOrganizerEventCatalogView(unavailable, 1)).toEqual({
      discoveryState: "unavailable",
      emptyState: null,
      hasKnownReferences: true,
    })

    const retained = retainMerchantOrganizerEventMarkets(
      projectOrganizerEventMarketsReadResult(
        organizerRead("complete", [eventMarket()])
      ).markets,
      unavailable
    )
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({
      collectionCoordinate: COLLECTION,
      state: "stale",
      source: { state: "stale" },
    })
  })

  it("retains a partial missing observation as stale instead of global absence", () => {
    const retained = projectOrganizerEventMarketsReadResult(
      organizerRead("complete", [eventMarket()])
    ).markets
    const partialMissing = projectOrganizerEventMarketsReadResult(
      organizerRead("partial", [
        {
          ...eventMarket(),
          state: "missing",
          calendar: undefined,
        },
      ])
    )

    expect(
      retainMerchantOrganizerEventMarkets(retained, partialMissing)
    ).toEqual([
      expect.objectContaining({
        collectionCoordinate: COLLECTION,
        state: "stale",
        source: expect.objectContaining({ state: "stale" }),
      }),
    ])
  })

  it("defers non-terminal invalid observations for signed-frontier reconciliation", () => {
    const retained = projectOrganizerEventMarketsReadResult(
      organizerRead("complete", [eventMarket()])
    ).markets

    for (const state of ["malformed", "conflicting", "unsupported"] as const) {
      for (const readState of ["partial", "complete"] as const) {
        const invalidatingResolution = {
          ...eventMarket(),
          state,
        }
        const observed = projectOrganizerEventMarketsReadResult(
          organizerRead(readState, [invalidatingResolution])
        )

        expect(retainMerchantOrganizerEventMarkets(retained, observed)).toEqual(
          [
            expect.objectContaining({
              collectionCoordinate: COLLECTION,
              state: "stale",
              source: expect.objectContaining({ state: "stale" }),
            }),
          ]
        )
      }
    }
  })

  it("does not retain a card over observed terminal deletion evidence", () => {
    const retained = projectOrganizerEventMarketsReadResult(
      organizerRead("complete", [eventMarket()])
    ).markets
    const deleted = projectOrganizerEventMarketsReadResult(
      organizerRead("partial", [
        { ...eventMarket(), state: "deleted", calendar: undefined },
      ])
    )

    expect(retainMerchantOrganizerEventMarkets(retained, deleted)).toEqual([])
  })

  it("preserves truncated organizer discovery and relay coverage facts", () => {
    const coverage: EventMarketRelayCoverage = {
      attemptedRelayCount: 8,
      completeRelayCount: 7,
      partialRelayCount: 0,
      failedRelayCount: 1,
    }
    const result = projectOrganizerEventMarketsReadResult(
      organizerRead("partial", [eventMarket()], {
        coverage,
        relayListState: "fresh-cache",
        relayHintTruncated: true,
      })
    )

    expect(result).toMatchObject({
      state: "partial",
      coverage,
      relayListState: "fresh-cache",
      relayHintTruncated: true,
    })
  })

  it("transitions from partial uncertainty to a complete result after retry", () => {
    const partial = projectOrganizerEventMarketsReadResult(
      organizerRead("partial")
    )
    const complete = projectOrganizerEventMarketsReadResult(
      organizerRead("complete")
    )

    expect(getMerchantOrganizerEventCatalogView(partial, 0).emptyState).toBe(
      "partial"
    )
    expect(getMerchantOrganizerEventCatalogView(complete, 0).emptyState).toBe(
      "complete"
    )
  })

  it("does not reuse a prior complete-empty claim after a failed refresh", () => {
    const priorCompleteEmpty = projectOrganizerEventMarketsReadResult(
      organizerRead("complete")
    )

    expect(
      getMerchantOrganizerEventCatalogView(priorCompleteEmpty, 0, true)
        .emptyState
    ).toBeNull()
  })

  it("does not wire definitive no-events language to incomplete evidence", async () => {
    const route = await Bun.file("apps/merchant/src/routes/events.tsx").text()
    const definitiveStart = route.indexOf(
      'catalogView.emptyState === "complete"'
    )
    const definitiveCopy = route.indexOf(
      "No events found in the completed planned reads"
    )
    const partialStart = route.indexOf('catalogView.emptyState === "partial"')
    const partialCopy = route.indexOf("No events found in the checked portion")
    const unavailableStart = route.indexOf(
      'catalogView.emptyState === "unavailable"'
    )

    expect(partialStart).toBeGreaterThan(-1)
    expect(partialCopy).toBeGreaterThan(partialStart)
    expect(route).toMatch(/No global\s+absence is/)
    expect(unavailableStart).toBeGreaterThan(-1)
    expect(definitiveStart).toBeGreaterThan(unavailableStart)
    expect(definitiveCopy).toBeGreaterThan(definitiveStart)
    expect(route.slice(definitiveStart - 80, definitiveStart)).toContain(
      "!marketsQuery.isError"
    )
    expect(route.slice(partialStart, definitiveStart)).not.toContain(
      "No events found in the completed planned reads"
    )
    expect(route).toContain("Retry organizer discovery")
  })
})
