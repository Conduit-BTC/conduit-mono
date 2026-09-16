import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCollectionDraft,
  getEventMarketCollectionLifecycleEvidence,
  isEventMarketCollectionLifecycleContinuation,
  parseEventMarketCollectionEvent,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = "a".repeat(64)
const calendar = `31923:${organizer}:calendar`
const pickup = `30406:${organizer}:pickup`
const product = `30402:${merchant}:product`

function collection(acceptance?: "open" | "closed", createdAt = 100) {
  return finalizeEvent(
    {
      ...buildEventMarketCollectionDraft({
        dTag: "collection",
        title: "Event",
        eventCoordinate: calendar,
        pickupCoordinate: pickup,
        productCoordinates: [product],
        ...(acceptance ? { orderAcceptance: acceptance } : {}),
      }),
      created_at: createdAt,
    },
    secret
  )
}

function continuation(
  previous: SignedPublicNostrEvent,
  next: SignedPublicNostrEvent,
  events = [previous, next]
) {
  return isEventMarketCollectionLifecycleContinuation({
    original: parseEventMarketCollectionEvent(previous)!,
    current: parseEventMarketCollectionEvent(next)!,
    events,
  })
}

describe("exact event collection lifecycle continuity", () => {
  it("preserves only a signed status-only change, including legacy opt-in", () => {
    expect(continuation(collection("open"), collection("closed", 101))).toBe(
      true
    )
    expect(continuation(collection(), collection("closed", 101))).toBe(true)
    expect(continuation(collection("open"), collection("open", 102))).toBe(true)
  })

  it("rejects missing originals, invalid signatures, coordinate changes and rollback", () => {
    const original = collection("open")
    const current = collection("closed", 101)
    expect(continuation(original, current, [current])).toBe(false)
    expect(
      continuation(original, current, [
        { ...original, sig: "0".repeat(128) },
        current,
      ])
    ).toBe(false)
    expect(continuation(original, collection("closed", 99))).toBe(false)
    expect(continuation(collection("closed"), current)).toBe(false)
    const other = finalizeEvent(
      {
        ...current,
        tags: current.tags.map((tag) =>
          tag[0] === "d" ? ["d", "other"] : tag
        ),
      },
      secret
    )
    expect(continuation(original, other)).toBe(false)
  })

  it("does not forgive membership, pickup, calendar, content or metadata changes", () => {
    const original = collection("open")
    const closed = collection("closed", 101)
    const changes = [
      { tags: closed.tags.filter((tag) => tag[1] !== product) },
      { tags: closed.tags.filter((tag) => tag[1] !== pickup) },
      {
        tags: closed.tags.map((tag) =>
          tag[1] === calendar ? ["a", `31923:${organizer}:other`] : tag
        ),
      },
      { content: "different" },
      { tags: [...closed.tags, ["summary", "different"]] },
    ]
    for (const change of changes) {
      expect(
        continuation(original, finalizeEvent({ ...closed, ...change }, secret))
      ).toBe(false)
    }
  })

  it("reads only the missing exact revision with a bounded relay plan", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const reads: unknown[] = []
    const events = await getEventMarketCollectionLifecycleEvidence(
      {
        original: parseEventMarketCollectionEvent(original)!,
        current: parseEventMarketCollectionEvent(current)!,
      },
      {
        getRetainedEvidence: async () => ({
          events: [current],
          eventSourceRelayUrls: {},
        }),
        getLocalEvidence: () => ({ status: "ready", events: [] }),
        getRelayLists: async () => new Map(),
        fetchEvents: async (filter, options) => {
          reads.push(filter)
          expect(options.relayUrls.length).toBeLessThanOrEqual(8)
          return {
            events: [original],
            eventSourceRelayUrls: {},
            relays: [],
            eventsVerified: true,
          }
        },
      }
    )
    expect(reads).toEqual([
      { kinds: [30405], authors: [organizer], ids: [original.id], limit: 2 },
    ])
    expect(continuation(original, current, events)).toBe(true)
  })

  it("combines the current signed graph with retained original evidence without extra I/O", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const events = await getEventMarketCollectionLifecycleEvidence(
      {
        original: parseEventMarketCollectionEvent(original)!,
        current: parseEventMarketCollectionEvent(current)!,
      },
      {
        getRetainedEvidence: async () => ({
          events: [original],
          eventSourceRelayUrls: {},
        }),
        getLocalEvidence: () => ({ status: "ready", events: [] }),
        getRelayLists: async () => {
          throw new Error("No network read expected")
        },
      }
    )
    expect(continuation(original, current, events)).toBe(true)
  })
})
