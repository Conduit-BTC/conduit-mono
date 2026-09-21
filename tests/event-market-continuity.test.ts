import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCollectionDraft,
  EVENT_KINDS,
  getEventMarketCollectionLifecycleEvidence,
  isEventMarketCollectionLifecycleContinuation,
  parseEventMarketCollectionEvent,
  type EventMarketReadPlan,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = "a".repeat(64)
const calendar = `31923:${organizer}:calendar`
const pickup = `30406:${organizer}:pickup`
const product = `30402:${merchant}:product`

async function emptyReadPlan(): Promise<EventMarketReadPlan> {
  return {
    relayUrls: [],
    ownerSelectedRelayUrls: [],
    appRelayUrls: [],
    personalRelayUrls: [],
    relayListState: "missing",
    relayHintTruncated: false,
  }
}

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

function exactDeletion(target: SignedPublicNostrEvent, createdAt = 200) {
  return finalizeEvent(
    {
      kind: EVENT_KINDS.DELETION,
      content: "",
      tags: [["e", target.id]],
      created_at: createdAt,
    },
    secret
  )
}

function coordinateDeletion(createdAt = 100) {
  return finalizeEvent(
    {
      kind: EVENT_KINDS.DELETION,
      content: "",
      tags: [["a", `30405:${organizer}:collection`]],
      created_at: createdAt,
    },
    secret
  )
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

  it("rejects exact and coordinate deletion of either lifecycle revision", () => {
    const original = collection("open")
    const current = collection("closed", 101)
    expect(
      continuation(original, current, [
        original,
        current,
        exactDeletion(original),
      ])
    ).toBe(false)
    expect(
      continuation(original, current, [original, current, coordinateDeletion()])
    ).toBe(false)
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

  it("reads the missing exact revision and its bounded deletion evidence", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const reads: unknown[] = []
    const relayUrls = [
      "wss://organizer.example",
      "ws://127.0.0.1:7777",
      "wss://fallback.example",
    ]
    const ownerSelectedRelayUrls = ["ws://127.0.0.1:7777"]
    const appRelayUrls = ["wss://fallback.example"]
    const personalRelayUrls = ["ws://127.0.0.1:7777"]
    const events = await getEventMarketCollectionLifecycleEvidence(
      {
        original: parseEventMarketCollectionEvent(original)!,
        current: parseEventMarketCollectionEvent(current)!,
        authenticatedPubkey: ` ${organizer.toUpperCase()} `,
      },
      {
        getRetainedEvidence: async () => ({
          events: [current],
          eventSourceRelayUrls: {},
        }),
        getLocalEvidence: () => ({ status: "ready", events: [] }),
        getReadPlan: async (input) => {
          expect(input.organizerPubkey).toBe(organizer)
          expect(input.authenticatedPubkey).toBe(organizer)
          return {
            relayUrls,
            ownerSelectedRelayUrls,
            appRelayUrls,
            personalRelayUrls,
            relayListState: "network",
            relayHintTruncated: false,
          }
        },
        fetchEvents: async (filter, options) => {
          reads.push(filter)
          expect(options.relayUrls).toEqual(relayUrls)
          expect(options.ownerSelectedRelayUrls).toEqual(ownerSelectedRelayUrls)
          expect(options.appRelayUrls).toEqual(appRelayUrls)
          expect(options.personalRelayUrls).toEqual(personalRelayUrls)
          expect(options.authenticatedPubkey).toBe(organizer)
          return {
            events: filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)
              ? [original]
              : [],
            eventSourceRelayUrls: {},
            relays: [],
            eventsVerified: true,
          }
        },
      }
    )
    expect(reads).toEqual([
      { kinds: [30405], authors: [organizer], ids: [original.id], limit: 2 },
      {
        kinds: [EVENT_KINDS.DELETION],
        authors: [organizer],
        "#e": [original.id, current.id],
        limit: 500,
      },
      {
        kinds: [EVENT_KINDS.DELETION],
        authors: [organizer],
        "#a": [`30405:${organizer}:collection`],
        limit: 500,
      },
    ])
    expect(continuation(original, current, events)).toBe(true)
  })

  it("combines retained revisions without re-reading their immutable contents", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const reads: Record<string, unknown>[] = []
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
        getReadPlan: emptyReadPlan,
        fetchEvents: async (filter) => {
          reads.push(filter)
          return {
            events: [],
            eventSourceRelayUrls: {},
            relays: [],
            eventsVerified: true,
          }
        },
      }
    )
    expect(
      reads.some((filter) =>
        (filter.kinds as number[] | undefined)?.includes(
          EVENT_KINDS.PRODUCT_COLLECTION
        )
      )
    ).toBe(false)
    expect(reads.some((filter) => filter["#e"])).toBe(true)
    expect(reads.some((filter) => filter["#a"])).toBe(true)
    expect(continuation(original, current, events)).toBe(true)
  })

  it("preserves retained deletion evidence instead of returning a false continuation", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const deletion = exactDeletion(original)
    const events = await getEventMarketCollectionLifecycleEvidence(
      {
        original: parseEventMarketCollectionEvent(original)!,
        current: parseEventMarketCollectionEvent(current)!,
      },
      {
        getRetainedEvidence: async () => ({
          events: [original, current, deletion],
          eventSourceRelayUrls: {},
        }),
        getLocalEvidence: () => ({ status: "ready", events: [] }),
        getReadPlan: async () => {
          throw new Error("Known deletion should not require a network read")
        },
      }
    )
    expect(events.map((event) => event.id)).toContain(deletion.id)
    expect(continuation(original, current, events)).toBe(false)
  })

  it("checks bounded live deletion evidence before accepting continuity", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const deletion = exactDeletion(original)
    const reads: Record<string, unknown>[] = []
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
        getReadPlan: emptyReadPlan,
        fetchEvents: async (filter) => {
          reads.push(filter)
          const kinds = filter.kinds as number[] | undefined
          return {
            events: kinds?.includes(EVENT_KINDS.DELETION)
              ? filter["#e"]
                ? [deletion]
                : []
              : [original],
            eventSourceRelayUrls: {},
            relays: [],
            eventsVerified: true,
          }
        },
      }
    )
    expect(reads.some((filter) => filter["#e"])).toBe(true)
    expect(reads.some((filter) => filter["#a"])).toBe(true)
    expect(events.map((event) => event.id)).toContain(deletion.id)
    expect(continuation(original, current, events)).toBe(false)
  })

  it("checks live deletion evidence when both revisions are already retained", async () => {
    const original = collection("open")
    const current = collection("closed", 101)
    const deletion = exactDeletion(original)
    const reads: Record<string, unknown>[] = []
    const events = await getEventMarketCollectionLifecycleEvidence(
      {
        original: parseEventMarketCollectionEvent(original)!,
        current: parseEventMarketCollectionEvent(current)!,
      },
      {
        getRetainedEvidence: async () => ({
          events: [original, current],
          eventSourceRelayUrls: {},
        }),
        getLocalEvidence: () => ({ status: "ready", events: [] }),
        getReadPlan: emptyReadPlan,
        fetchEvents: async (filter) => {
          reads.push(filter)
          return {
            events: filter["#e"] ? [deletion] : [],
            eventSourceRelayUrls: {},
            relays: [],
            eventsVerified: true,
          }
        },
      }
    )
    expect(
      reads.some((filter) =>
        (filter.kinds as number[] | undefined)?.includes(
          EVENT_KINDS.PRODUCT_COLLECTION
        )
      )
    ).toBe(false)
    expect(reads.some((filter) => filter["#e"])).toBe(true)
    expect(reads.some((filter) => filter["#a"])).toBe(true)
    expect(events.map((event) => event.id)).toContain(deletion.id)
    expect(continuation(original, current, events)).toBe(false)
  })
})
