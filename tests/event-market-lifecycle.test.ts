import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  EVENT_KINDS,
  getEventMarketOrderAcceptance,
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
    const retained = selectEventMarketEvidenceForRetention(rows, 0)
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
      0
    )
    expect(retained.map((entry) => entry.id).sort()).toEqual(
      [calendar.id, legacy.id, open.id, closed.id, reopened.id].sort()
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
      0
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
})
