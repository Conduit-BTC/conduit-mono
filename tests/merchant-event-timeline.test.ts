import { describe, expect, it } from "bun:test"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  retainMerchantOrganizerEventMarkets,
  type MerchantOrganizerEventMarket,
} from "../apps/merchant/src/lib/event-market"
import {
  filterAndSortMerchantEventTimeline,
  formatMerchantEventTimelineSchedule,
  getMerchantEventTimelineStatus,
  mergeMerchantEventTimeline,
} from "../apps/merchant/src/lib/merchant-event-timeline"

const NOW = Date.UTC(2027, 5, 1, 12)
const MERCHANT = "a".repeat(64)
const OTHER = "b".repeat(64)

function market(input: {
  suffix: string
  organizer?: string
  startMs: number
  endMs?: number
  state?: MerchantOrganizerEventMarket["state"]
  relayHints?: string[]
  collectionCreatedAt?: number
}): MerchantOrganizerEventMarket {
  const organizer = input.organizer ?? OTHER
  const collectionCoordinate = `30405:${organizer}:${input.suffix}`
  const calendarCoordinate = `31923:${organizer}:${input.suffix}`
  const state = input.state ?? "active"
  const collectionCreatedAt = input.collectionCreatedAt ?? 1
  const collectionEventId = "1".repeat(64)
  const calendarEventId = "2".repeat(64)
  return {
    state,
    organizerPubkey: organizer,
    collectionCoordinate,
    calendarCoordinate,
    pickupCoordinates: [],
    naddr: encodeEventMarketNaddr(collectionCoordinate, input.relayHints),
    title: input.suffix,
    eventLocation: "Chicago",
    calendarKind: 31923,
    start: input.startMs / 1_000,
    end: (input.endMs ?? input.startMs + 3_600_000) / 1_000,
    timezone: "America/Chicago",
    collectionCreatedAt,
    collectionEventId,
    calendarCreatedAt: collectionCreatedAt,
    calendarEventId,
    productCoordinates: [],
    participation: [],
    source: {
      state,
      reference: collectionCoordinate,
      organizerPubkey: organizer,
      collectionCoordinate,
      calendarCoordinate,
      collection: {
        coordinate: collectionCoordinate,
        eventId: collectionEventId,
        authorPubkey: organizer,
        dTag: input.suffix,
        title: input.suffix,
        content: "",
        eventCoordinates: [calendarCoordinate],
        pickupCoordinates: [],
        productCoordinates: [],
        unsupportedReferences: [],
        createdAt: collectionCreatedAt,
      },
      calendar: {
        coordinate: calendarCoordinate,
        eventId: calendarEventId,
        authorPubkey: organizer,
        dTag: input.suffix,
        kind: 31923,
        title: input.suffix,
        content: "",
        locations: ["Chicago"],
        start: input.startMs,
        end: input.endMs ?? input.startMs + 3_600_000,
        createdAt: collectionCreatedAt,
      },
      organizerProductCoordinates: [],
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [],
      participationRequests: [],
      pickups: [],
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
    },
  }
}

function dateMarket(input: {
  suffix: string
  startDate: string
  endDate?: string
}): MerchantOrganizerEventMarket {
  const result = market({
    suffix: input.suffix,
    startMs: Date.parse(`${input.startDate}T00:00:00Z`),
  })
  return {
    ...result,
    calendarKind: 31922,
    calendarCoordinate: result.calendarCoordinate.replace("31923:", "31922:"),
    start: input.startDate,
    ...(input.endDate ? { end: input.endDate } : { end: undefined }),
  }
}

describe("Merchant event timeline", () => {
  it("retires known invalid coordinates while incomplete reads retain positive cards", () => {
    const positive = market({ suffix: "known", startMs: NOW + 3_600_000 })
    const unrelated = market({ suffix: "other", startMs: NOW + 7_200_000 })
    const input = {
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [positive, unrelated],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [{ reference: positive.naddr, savedAt: NOW }],
      sellingCollectionCoordinates: [positive.collectionCoordinate],
    }
    for (const state of ["malformed", "conflicting", "unsupported"] as const) {
      const rows = mergeMerchantEventTimeline({
        ...input,
        resolutionObservations: [
          {
            readScope: "perspective",
            resolution: { ...positive.source, state },
          },
        ],
      })
      expect(rows.map((row) => row.market.collectionCoordinate)).toEqual([
        unrelated.collectionCoordinate,
      ])
    }
    for (const state of ["partial", "unavailable", "missing"] as const) {
      const rows = mergeMerchantEventTimeline({
        ...input,
        resolutionObservations: [
          {
            readScope: "perspective",
            resolution: { ...positive.source, state },
          },
        ],
      })
      expect(rows.map((row) => row.market.collectionCoordinate)).toContain(
        positive.collectionCoordinate
      )
    }
    expect(input.savedReferences).toHaveLength(1)
  })

  it("retains a newer exact market over an older invalid perspective observation", () => {
    const olderInvalid = market({
      suffix: "cross-query-valid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })
    const newerValid = market({
      suffix: "cross-query-valid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 20,
    })

    const rows = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [],
      ownedMarkets: [],
      exactRelationshipMarkets: [newerValid],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [
        {
          readScope: "perspective",
          resolution: {
            ...olderInvalid.source,
            state: "malformed",
            calendar: undefined,
          },
        },
      ],
    })

    expect(rows).toEqual([
      expect.objectContaining({
        market: expect.objectContaining({ collectionCreatedAt: 20 }),
        reconciliationPending: false,
      }),
    ])
  })

  it("retains a newer owned market through partial-read invalidation before reconciliation", () => {
    const olderInvalid = market({
      suffix: "retained-owned-valid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })
    const newerValid = market({
      suffix: "retained-owned-valid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 20,
    })
    const invalidResolution = {
      ...olderInvalid.source,
      state: "malformed" as const,
      calendar: undefined,
    }
    const retainedOwned = retainMerchantOrganizerEventMarkets([newerValid], {
      state: "partial",
      markets: [
        {
          ...olderInvalid,
          state: "malformed",
          source: invalidResolution,
        },
      ],
      resolutions: [invalidResolution],
      coverage: invalidResolution.coverage,
      relayListState: "network",
      relayHintTruncated: false,
    })

    const rows = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [],
      ownedMarkets: retainedOwned,
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [
        { readScope: "owned", resolution: invalidResolution },
      ],
    })

    expect(rows).toEqual([
      expect.objectContaining({
        market: expect.objectContaining({
          collectionCreatedAt: 20,
          state: "stale",
        }),
        reconciliationPending: false,
      }),
    ])
  })

  it("marks equal-frontier observations from independent read scopes pending", () => {
    const exact = market({
      suffix: "cross-query-pending",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })

    const rows = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [],
      ownedMarkets: [],
      exactRelationshipMarkets: [exact],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [
        {
          readScope: "perspective",
          resolution: { ...exact.source, state: "conflicting" },
        },
      ],
    })

    expect(rows).toEqual([
      expect.objectContaining({
        market: exact,
        reconciliationPending: true,
      }),
    ])
  })

  it("marks a missing invalid child frontier pending at the same collection revision", () => {
    const positive = market({
      suffix: "missing-invalid-child-frontier",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })

    const rows = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [positive],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [
        {
          readScope: "perspective",
          resolution: {
            ...positive.source,
            state: "malformed",
            calendar: undefined,
          },
        },
      ],
    })

    expect(rows).toEqual([
      expect.objectContaining({
        market: positive,
        reconciliationPending: true,
      }),
    ])
  })

  it("retains complete positive evidence over a weaker invalid read in the same scope", () => {
    const positive = market({
      suffix: "weaker-invalid-read",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })
    const partialInvalid = {
      ...positive.source,
      state: "malformed" as const,
      coverage: {
        attemptedRelayCount: 2,
        completeRelayCount: 1,
        partialRelayCount: 0,
        failedRelayCount: 1,
      },
    }

    const rows = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [positive],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [
        { readScope: "perspective", resolution: partialInvalid },
      ],
    })

    expect(rows).toEqual([
      expect.objectContaining({
        market: positive,
        reconciliationPending: false,
      }),
    ])
  })

  it("retires an older perspective market under a newer invalid exact revision", () => {
    const olderValid = market({
      suffix: "cross-query-invalid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })
    const newerInvalid = market({
      suffix: "cross-query-invalid",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 20,
    })

    expect(
      mergeMerchantEventTimeline({
        merchantPubkey: MERCHANT,
        perspectiveMarkets: [olderValid],
        ownedMarkets: [],
        exactRelationshipMarkets: [],
        savedReferences: [],
        sellingCollectionCoordinates: [],
        resolutionObservations: [
          {
            readScope: "exact",
            resolution: {
              ...newerInvalid.source,
              state: "unsupported",
              calendar: undefined,
            },
          },
        ],
      })
    ).toEqual([])
  })

  it("reconciles an exact deletion against each candidate's signed frontier", () => {
    const older = market({
      suffix: "recreated",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 10,
    })
    const newer = market({
      suffix: "recreated",
      startMs: NOW + 3_600_000,
      collectionCreatedAt: 30,
    })
    older.collectionEventId = "a".repeat(64)
    newer.collectionEventId = "b".repeat(64)
    const deletion = {
      ...older.source,
      state: "deleted" as const,
      deletion: {
        record: "collection" as const,
        coordinate: older.collectionCoordinate,
        createdAt: 10,
        eventId: "a".repeat(64),
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 20,
            authorPubkey: OTHER,
            eventTargets: [],
            addressableTargets: [older.collectionCoordinate],
          },
        ],
      },
    }
    const base = {
      merchantPubkey: MERCHANT,
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
      resolutionObservations: [{ readScope: "exact", resolution: deletion }],
    }
    expect(
      mergeMerchantEventTimeline({ ...base, perspectiveMarkets: [older] })
    ).toEqual([])
    expect(
      mergeMerchantEventTimeline({ ...base, perspectiveMarkets: [newer] }).map(
        (row) => row.market.collectionCreatedAt
      )
    ).toEqual([30])
    expect(
      mergeMerchantEventTimeline({
        ...base,
        perspectiveMarkets: [older],
        exactRelationshipMarkets: [newer],
      }).map((row) => row.market.collectionCreatedAt)
    ).toEqual([30])
  })

  it("unions exact relationships with perspective discovery and deduplicates coordinates", () => {
    const sharedNetwork = market({
      suffix: "shared",
      startMs: NOW + 3_600_000,
      state: "partial",
      relayHints: ["wss://network.example"],
      collectionCreatedAt: 1,
    })
    const sharedExact = market({
      suffix: "shared",
      startMs: NOW + 3_600_000,
      relayHints: ["wss://exact.example"],
      collectionCreatedAt: 2,
    })
    const owned = market({
      suffix: "owned",
      organizer: MERCHANT,
      startMs: NOW + 7_200_000,
    })
    const selling = market({
      suffix: "selling",
      startMs: NOW + 10_800_000,
    })

    const result = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [sharedNetwork],
      ownedMarkets: [owned],
      exactRelationshipMarkets: [sharedExact, selling],
      savedReferences: [
        {
          reference: encodeEventMarketNaddr(sharedExact.collectionCoordinate, [
            "wss://saved.example",
          ]),
          savedAt: NOW,
        },
      ],
      sellingCollectionCoordinates: [selling.collectionCoordinate],
    })

    expect(result).toHaveLength(3)
    expect(
      result.find(
        (item) =>
          item.market.collectionCoordinate === sharedExact.collectionCoordinate
      )?.relationships
    ).toEqual(["saved"])
    expect(
      result.find(
        (item) =>
          item.market.collectionCoordinate === owned.collectionCoordinate
      )?.relationships
    ).toEqual(["organizing"])
    expect(
      result.find(
        (item) =>
          item.market.collectionCoordinate === selling.collectionCoordinate
      )?.relationships
    ).toEqual(["selling"])

    const shared = result.find(
      (item) =>
        item.market.collectionCoordinate === sharedExact.collectionCoordinate
    )!
    expect(shared.market.state).toBe("active")
    expect(
      decodeEventMarketReference(shared.market.naddr, [30405])?.relayHints
    ).toEqual(
      expect.arrayContaining([
        "wss://network.example",
        "wss://exact.example",
        "wss://saved.example",
      ])
    )
  })

  it("filters relations and dates while ordering upcoming and past events", () => {
    const past = market({
      suffix: "past",
      startMs: NOW - 86_400_000,
      endMs: NOW - 3_600_000,
      state: "ended",
    })
    const soon = market({ suffix: "soon", startMs: NOW + 3_600_000 })
    const later = market({
      suffix: "later",
      startMs: NOW + 10 * 86_400_000,
    })
    const items = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [later, past, soon],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [{ reference: soon.naddr, savedAt: NOW }],
      sellingCollectionCoordinates: [later.collectionCoordinate],
    })

    expect(
      filterAndSortMerchantEventTimeline(items, {}, NOW).map(
        (item) => item.market.title
      )
    ).toEqual(["soon", "later"])
    expect(
      filterAndSortMerchantEventTimeline(
        items,
        { relation: "selling", window: "all" },
        NOW
      ).map((item) => item.market.title)
    ).toEqual(["later"])
    expect(
      filterAndSortMerchantEventTimeline(
        items,
        { relation: "saved", window: "all" },
        NOW
      ).map((item) => item.market.title)
    ).toEqual(["soon"])
    expect(
      filterAndSortMerchantEventTimeline(items, { window: "past" }, NOW).map(
        (item) => item.market.title
      )
    ).toEqual(["past"])
  })

  it("keeps a no-end date event upcoming through its start date and displays explicit ends exclusively", () => {
    const singleDay = dateMarket({
      suffix: "single-day",
      startDate: "2027-06-01",
    })
    const explicitSingleDay = dateMarket({
      suffix: "explicit-single-day",
      startDate: "2027-06-01",
      endDate: "2027-06-02",
    })
    const multiDay = dateMarket({
      suffix: "multi-day",
      startDate: "2027-06-01",
      endDate: "2027-06-03",
    })
    const items = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [singleDay, multiDay],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
    })

    expect(
      filterAndSortMerchantEventTimeline(items, {}, NOW).map(
        (item) => item.market.title
      )
    ).toContain("single-day")
    expect(
      filterAndSortMerchantEventTimeline(
        [
          {
            market: explicitSingleDay,
            relationships: [],
            reconciliationPending: false,
          },
        ],
        { window: "past" },
        Date.UTC(2027, 5, 2)
      )
    ).toHaveLength(1)
    const explicitSingleDaySchedule = formatMerchantEventTimelineSchedule(
      explicitSingleDay,
      "en-US"
    )
    expect(explicitSingleDaySchedule).toBe("Jun 1, 2027")
    expect(explicitSingleDaySchedule).not.toContain("Jun 2")
    expect(formatMerchantEventTimelineSchedule(multiDay, "en-US")).toBe(
      "Jun 1, 2027 – Jun 2, 2027"
    )
  })

  it("uses signed schedule evidence and relay-aware status labels", () => {
    const partial = market({
      suffix: "partial",
      startMs: Date.UTC(2027, 5, 1, 14),
      state: "partial",
    })
    const [item] = mergeMerchantEventTimeline({
      merchantPubkey: MERCHANT,
      perspectiveMarkets: [partial],
      ownedMarkets: [],
      exactRelationshipMarkets: [],
      savedReferences: [],
      sellingCollectionCoordinates: [],
    })
    expect(getMerchantEventTimelineStatus(item!, NOW)).toEqual({
      label: "Partial relay view",
      tone: "warning",
    })
    expect(formatMerchantEventTimelineSchedule(partial, "en-US")).toContain(
      "9:00 AM"
    )
  })
})
