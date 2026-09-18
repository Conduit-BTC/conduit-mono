import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  EVENT_KINDS,
  getEventMarketOrderAcceptance,
  getRetainedEventMarketCollectionEvidence,
  getRetainedEventMarketCollectionLifecycleEvidence,
  parseEventMarketCollectionEvent,
  resolveEventMarketEvidence,
  selectEventMarketEvidenceForRetention,
  type CachedEventMarketEvidence,
  type EventMarketEventDraft,
  type EventMarketOrderAcceptance,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const secret = generateSecretKey()
const author = getPublicKey(secret)
const calendarCoordinate = `31923:${author}:calendar`
const reference = `30405:${author}:market`
const start = 2_000_000_000
const end = start + 3600
const beforeEnd = (end - 1) * 1000
const afterEnd = (end + 1) * 1000
const partial = {
  attemptedRelayCount: 2,
  completeRelayCount: 1,
  partialRelayCount: 0,
  failedRelayCount: 1,
}

function sign(draft: EventMarketEventDraft, createdAt = 100) {
  return finalizeEvent({ ...draft, created_at: createdAt }, secret)
}

const calendar = sign(
  buildEventMarketCalendarDraft({
    kind: EVENT_KINDS.CALENDAR_TIME,
    dTag: "calendar",
    title: "Market",
    start,
    end,
  })
)

function collection(
  orderAcceptance?: EventMarketOrderAcceptance,
  createdAt = 100
) {
  return sign(
    buildEventMarketCollectionDraft({
      dTag: "market",
      title: "Market",
      eventCoordinate: calendarCoordinate,
      orderAcceptance,
    }),
    createdAt
  )
}

function resolve(events: SignedPublicNostrEvent[], nowMs = afterEnd) {
  return resolveEventMarketEvidence({
    reference,
    events: [calendar, ...events],
    nowMs,
  })
}

function row(
  event: SignedPublicNostrEvent,
  cachedAt = 1
): CachedEventMarketEvidence {
  return {
    id: event.id,
    organizerPubkey: author,
    kind: event.kind,
    signedEvent: event,
    sourceRelayUrls: [],
    cachedAt,
  }
}

describe("event market lifecycle", () => {
  afterEach(() => {
    __resetEventMarketTestOverrides()
  })

  it("separates advertised end from explicit organizer availability", () => {
    const open = collection("open")
    for (const nowMs of [beforeEnd, end * 1000, afterEnd]) {
      expect(resolve([open], nowMs).state).toBe("active")
    }
    expect(getEventMarketOrderAcceptance(resolve([open]))).toBe("open")
    expect(resolve([collection("closed")], beforeEnd).state).toBe("ended")
    expect(resolve([collection()], beforeEnd).state).toBe("active")
    expect(resolve([collection()], end * 1000).state).toBe("ended")
    expect(
      getEventMarketOrderAcceptance(resolve([collection()]), afterEnd)
    ).toBe("legacy-ended")
  })

  it("does not promote open events past partial, unavailable, or stale evidence", () => {
    for (const acceptance of ["open", "closed"] as const) {
      const events = [calendar, collection(acceptance)]
      expect(
        resolveEventMarketEvidence({
          reference,
          events,
          nowMs: afterEnd,
          coverage: partial,
        }).state
      ).toBe(acceptance === "open" ? "partial" : "ended")
      expect(
        resolveEventMarketEvidence({
          reference,
          events,
          nowMs: afterEnd,
          evidenceObservedAt: beforeEnd - 600_000,
        }).state
      ).toBe("stale")
      expect(
        resolveEventMarketEvidence({
          reference,
          events,
          nowMs: afterEnd,
          coverage: { ...partial, completeRelayCount: 0, failedRelayCount: 2 },
        }).state
      ).toBe("unavailable")
    }
  })

  it("rejects malformed and unknown lifecycle tags instead of applying legacy rules", () => {
    const legacy = collection()
    for (const tags of [
      [["conduit_event_market"]],
      [["conduit_event_market", "2", "open"]],
      [["conduit_event_market", "1", "maybe"]],
      [["conduit_event_market", "1", "open", "extra"]],
      [
        ["conduit_event_market", "1", "open"],
        ["conduit_event_market", "1", "closed"],
      ],
    ]) {
      const invalid = sign({ ...legacy, tags: [...legacy.tags, ...tags] }, 200)
      expect(parseEventMarketCollectionEvent(invalid)).toBeNull()
      expect(resolve([legacy, invalid], beforeEnd).state).toBe("malformed")
    }
  })

  it("retains stronger closure over older open revisions and rejects a stripped lifecycle", () => {
    const open = collection("open", 100)
    const closed = collection("closed", 200)
    const stripped = collection(undefined, 300)
    expect(resolve([closed, open], beforeEnd).state).toBe("ended")
    expect(resolve([stripped, closed, open], beforeEnd).state).toBe("malformed")
    const reopened = collection("open", 400)
    const result = resolve([stripped, closed, open, reopened])
    expect(result.state).toBe("active")
    expect(result.collection?.coordinate).toBe(reference)
    expect(result.calendar?.end).toBe(end * 1000)
  })

  it("does not let an exact-deleted lifecycle revision poison a surviving legacy revision", () => {
    const legacy = collection(undefined, 100)
    const tagged = collection("open", 200)
    const deletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["e", tagged.id]] },
      300
    )
    const result = resolve([legacy, tagged, deletion], beforeEnd)
    expect(result.state).toBe("active")
    expect(result.collection?.eventId).toBe(legacy.id)
  })

  it("does not let a same-timestamp losing lifecycle revision poison the canonical legacy revision", () => {
    const legacyCandidates = Array.from({ length: 16 }, (_, index) =>
      sign(
        {
          ...buildEventMarketCollectionDraft({
            dTag: "market",
            title: "Market",
            eventCoordinate: calendarCoordinate,
          }),
          content: `legacy-${index}`,
        },
        200
      )
    )
    const taggedCandidates = Array.from({ length: 16 }, (_, index) =>
      sign(
        {
          ...buildEventMarketCollectionDraft({
            dTag: "market",
            title: "Market",
            eventCoordinate: calendarCoordinate,
            orderAcceptance: "open",
          }),
          content: `tagged-${index}`,
        },
        200
      )
    )
    const legacy = [...legacyCandidates].sort((a, b) =>
      a.id.localeCompare(b.id)
    )[0]!
    const tagged = [...taggedCandidates].sort((a, b) =>
      b.id.localeCompare(a.id)
    )[0]!
    expect(legacy.id.localeCompare(tagged.id)).toBeLessThan(0)

    const result = resolve([tagged, legacy], beforeEnd)
    expect(result.state).toBe("active")
    expect(result.collection?.eventId).toBe(legacy.id)
  })

  it("uses only the canonical older revision when enforcing lifecycle opt-in", () => {
    const legacyCandidates = Array.from({ length: 16 }, (_, index) =>
      sign(
        {
          ...buildEventMarketCollectionDraft({
            dTag: "market",
            title: "Market",
            eventCoordinate: calendarCoordinate,
          }),
          content: `older-legacy-${index}`,
        },
        200
      )
    )
    const taggedCandidates = Array.from({ length: 16 }, (_, index) =>
      sign(
        {
          ...buildEventMarketCollectionDraft({
            dTag: "market",
            title: "Market",
            eventCoordinate: calendarCoordinate,
            orderAcceptance: "open",
          }),
          content: `older-tagged-${index}`,
        },
        200
      )
    )
    const canonicalLegacy = [...legacyCandidates].sort((a, b) =>
      a.id.localeCompare(b.id)
    )[0]!
    const losingTagged = [...taggedCandidates].sort((a, b) =>
      b.id.localeCompare(a.id)
    )[0]!
    expect(canonicalLegacy.id.localeCompare(losingTagged.id)).toBeLessThan(0)

    const laterLegacy = collection(undefined, 300)
    const result = resolve(
      [laterLegacy, canonicalLegacy, losingTagged],
      beforeEnd
    )
    expect(result.state).toBe("active")
    expect(result.collection?.eventId).toBe(laterLegacy.id)

    const canonicalTagged = [...taggedCandidates].sort((a, b) =>
      a.id.localeCompare(b.id)
    )[0]!
    const losingLegacy = [...legacyCandidates].sort((a, b) =>
      b.id.localeCompare(a.id)
    )[0]!
    expect(canonicalTagged.id.localeCompare(losingLegacy.id)).toBeLessThan(0)
    expect(
      resolve([laterLegacy, canonicalTagged, losingLegacy], beforeEnd).state
    ).toBe("malformed")
  })

  it("retains NIP-01 revision tie breaking and signed deletion semantics", () => {
    const revisions = [collection("open", 200), collection("closed", 200)].sort(
      (a, b) => a.id.localeCompare(b.id)
    )
    expect(resolve(revisions).collection?.eventId).toBe(revisions[0]!.id)
    const deletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["a", reference]] },
      300
    )
    expect(resolve([...revisions, deletion]).state).toBe("deleted")
  })

  it("retains history, lifecycle opt-in, and deletions beyond the transient cache limit", () => {
    const closed = collection("closed", 200)
    const stripped = collection(undefined, 300)
    const pickup = sign({
      kind: EVENT_KINDS.SHIPPING_OPTION,
      content: "",
      tags: [["d", "pickup"]],
    })
    const product = sign({
      kind: EVENT_KINDS.PRODUCT,
      content: "",
      tags: [["d", "product"]],
    })
    const deletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["e", product.id]] },
      400
    )
    const rows = [
      row(calendar),
      row(closed),
      row(stripped),
      row(pickup),
      row(product, 999),
      row(deletion),
    ]
    const retained = selectEventMarketEvidenceForRetention(rows, 5)
    expect(retained.map((entry) => entry.id).sort()).toEqual(
      [calendar.id, closed.id, stripped.id, pickup.id, deletion.id].sort()
    )
    expect(
      resolve(
        retained.map((entry) => entry.signedEvent),
        beforeEnd
      ).state
    ).toBe("malformed")
  })

  it("retains a stripped current revision atomically with its lifecycle predecessor", async () => {
    const closed = collection("closed", 200)
    const stripped = collection(undefined, 300)
    const unrelated = Array.from({ length: 749 }, (_, index) =>
      row(
        sign(
          buildEventMarketCollectionDraft({
            dTag: `unrelated-${index}`,
            title: `Unrelated ${index}`,
            eventCoordinate: calendarCoordinate,
          }),
          400 + index
        ),
        1_000 + index
      )
    )
    __setEventMarketTestOverrides({
      loadCachedCollectionEvidence: async () => [
        row(stripped, 10_000),
        row(closed, 1),
        ...unrelated,
      ],
    })

    const retained = await getRetainedEventMarketCollectionEvidence({
      organizerPubkeys: [author],
    })
    const retainedIds = new Set(retained.events.map((event) => event.id))
    expect(retainedIds.has(stripped.id)).toBe(true)
    expect(retainedIds.has(closed.id)).toBe(true)
    expect(resolve(retained.events, beforeEnd).state).toBe("malformed")

    const single = selectEventMarketEvidenceForRetention(
      [row(stripped, 10_000), row(closed, 1)],
      1
    )
    expect(single.map((entry) => entry.id)).toEqual([closed.id])
    expect(
      resolve(
        single.map((entry) => entry.signedEvent),
        beforeEnd
      ).state
    ).toBe("ended")
  }, 15_000)

  it("does not repair one lifecycle guard by breaking another complete guard", () => {
    const market = (
      dTag: string,
      orderAcceptance: EventMarketOrderAcceptance | undefined,
      createdAt: number
    ) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag,
          title: dTag,
          eventCoordinate: calendarCoordinate,
          orderAcceptance,
        }),
        createdAt
      )
    const closedA = market("market-a", "closed", 100)
    const currentA = market("market-a", undefined, 200)
    const closedB = market("market-b", "closed", 100)
    const currentB = market("market-b", undefined, 200)
    const retained = selectEventMarketEvidenceForRetention(
      [
        row(currentA, 400),
        row(currentB, 300),
        row(closedB, 200),
        row(closedA, 100),
      ],
      3
    )
    const retainedIds = new Set(retained.map((entry) => entry.id))

    for (const [current, predecessor] of [
      [currentA, closedA],
      [currentB, closedB],
    ] as const) {
      expect(
        retainedIds.has(current.id) && !retainedIds.has(predecessor.id)
      ).toBe(false)
      expect(
        resolveEventMarketEvidence({
          reference: `30405:${author}:${current.tags.find((tag) => tag[0] === "d")![1]}`,
          events: [calendar, ...retained.map((entry) => entry.signedEvent)],
          nowMs: beforeEnd,
        }).state
      ).not.toBe("active")
    }
  })

  it("ranks pinned lifecycle guards atomically and independently of input order", () => {
    const market = (
      dTag: string,
      orderAcceptance: EventMarketOrderAcceptance | undefined,
      createdAt: number
    ) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag,
          title: dTag,
          eventCoordinate: calendarCoordinate,
          orderAcceptance,
        }),
        createdAt
      )
    const pinnedClosed = market("pinned", "closed", 100)
    const pinnedCurrent = market("pinned", undefined, 200)
    const otherClosed = market("other", "closed", 100)
    const otherCurrent = market("other", undefined, 200)
    const rows = [
      row(pinnedCurrent, 400),
      row(otherCurrent, 300),
      row(otherClosed, 200),
      row(pinnedClosed, 100),
    ]
    const select = (input: CachedEventMarketEvidence[]) =>
      selectEventMarketEvidenceForRetention(input, 3, [pinnedCurrent.id])
        .map((entry) => entry.id)
        .sort()

    const retainedIds = select(rows)
    expect(retainedIds).toEqual(select([...rows].reverse()))
    expect(retainedIds).toContain(pinnedCurrent.id)
    expect(retainedIds).toContain(pinnedClosed.id)
    expect(
      retainedIds.includes(otherCurrent.id) &&
        !retainedIds.includes(otherClosed.id)
    ).toBe(false)
  })

  it("preserves exact existing-order source revisions through a status-only chain under cache pressure", () => {
    const legacy = collection(undefined, 100)
    const open = collection("open", 200)
    const closed = collection("closed", 300)
    const reopened = collection("open", 400)
    const earlierDifferentGraph = sign(
      { ...legacy, content: "Previous collection terms" },
      50
    )
    const retained = selectEventMarketEvidenceForRetention(
      [
        row(calendar),
        row(legacy),
        row(open),
        row(closed),
        row(reopened),
        row(earlierDifferentGraph),
      ],
      3,
      [legacy.id]
    )
    expect(retained.map((entry) => entry.id).sort()).toEqual(
      [calendar.id, legacy.id, reopened.id].sort()
    )
    expect(resolve(retained.map((entry) => entry.signedEvent)).state).toBe(
      "active"
    )
  })

  it("preserves the surviving graph revision when an exact newer revision was deleted", () => {
    const closed = collection("closed", 200)
    const reopened = collection("open", 300)
    const deletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["e", reopened.id]] },
      400
    )
    const retained = selectEventMarketEvidenceForRetention(
      [row(calendar), row(closed), row(reopened), row(deletion)],
      4
    )
    expect(
      resolve(
        retained.map((entry) => entry.signedEvent),
        beforeEnd
      ).state
    ).toBe("ended")
    expect(
      resolve(
        retained.map((entry) => entry.signedEvent),
        beforeEnd
      ).collection?.eventId
    ).toBe(closed.id)
  })

  it("enforces the organizer evidence limit across retained frontiers", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(
        sign(
          buildEventMarketCollectionDraft({
            dTag: `market-${index}`,
            title: `Market ${index}`,
            eventCoordinate: calendarCoordinate,
          }),
          100 + index
        ),
        index
      )
    )
    expect(selectEventMarketEvidenceForRetention(rows, 12)).toHaveLength(12)
  })

  it("never retains a deleted revision without its exact or coordinate tombstone", () => {
    const deleted = sign(
      buildEventMarketCollectionDraft({
        dTag: "deleted-market",
        title: "Deleted market",
        eventCoordinate: calendarCoordinate,
        orderAcceptance: "open",
      }),
      500
    )
    const exactDeletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["e", deleted.id]] },
      600
    )
    const coordinateDeletion = sign(
      {
        kind: EVENT_KINDS.DELETION,
        content: "",
        tags: [["a", `30405:${author}:deleted-market`]],
      },
      600
    )
    const unrelated = Array.from({ length: 750 }, (_, index) =>
      row(
        sign(
          buildEventMarketCollectionDraft({
            dTag: `unrelated-${index}`,
            title: `Unrelated ${index}`,
            eventCoordinate: calendarCoordinate,
          }),
          700 + index
        ),
        1_000 + index
      )
    )
    for (const [deletion, competingRows, limit] of [
      [exactDeletion, unrelated, 750],
      [coordinateDeletion, unrelated.slice(0, 20), 20],
    ] as const) {
      const retainedIds = new Set(
        selectEventMarketEvidenceForRetention(
          [row(deleted, 10_000), row(deletion, 1), ...competingRows],
          limit
        ).map((entry) => entry.id)
      )

      expect(retainedIds.has(deletion.id)).toBe(false)
      expect(retainedIds.has(deleted.id)).toBe(false)
    }
  }, 15_000)

  it("hydrates retained lifecycle revisions together with their tombstones", async () => {
    const original = collection("open", 100)
    const current = collection("closed", 200)
    const deletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["e", original.id]] },
      300
    )
    __setEventMarketTestOverrides({
      loadCachedEvidence: async () => [
        row(original),
        row(current),
        row(deletion),
      ],
    })

    const retained = await getRetainedEventMarketCollectionLifecycleEvidence({
      organizerPubkey: author,
      revisions: [
        parseEventMarketCollectionEvent(original)!,
        parseEventMarketCollectionEvent(current)!,
      ],
    })
    expect(retained.events.map((event) => event.id).sort()).toEqual(
      [original.id, current.id, deletion.id].sort()
    )
  })

  it("bounds retained collection hydration per organizer", async () => {
    const rows = Array.from({ length: 760 }, (_, index) =>
      row(
        sign(
          buildEventMarketCollectionDraft({
            dTag: `market-${index}`,
            title: `Market ${index}`,
            eventCoordinate: calendarCoordinate,
          }),
          100 + index
        ),
        index
      )
    )
    __setEventMarketTestOverrides({
      loadCachedCollectionEvidence: async () => rows,
    })

    const retained = await getRetainedEventMarketCollectionEvidence({
      organizerPubkeys: [author],
    })
    expect(retained.events).toHaveLength(750)
  }, 15_000)
})
