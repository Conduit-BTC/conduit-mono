import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  EVENT_KINDS,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  organizerEventMarketReferencesMatch,
  parseOrganizerEventMarketReference,
  resolveOrganizerEventMarket,
} from "../apps/merchant/src/lib/event-market"

const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const COLLECTION = `30405:${ORGANIZER}:public-market`
const CALENDAR = `31923:${ORGANIZER}:public-market-day`
const HINT_RELAY = "wss://hint.example/events"
const DISCOVERY_RELAY = "wss://discovery.example/read"

afterEach(() => __resetEventMarketTestOverrides())

function signedEvent(
  draft: { kind: number; content: string; tags: string[][] },
  createdAt: number
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: draft.kind,
      created_at: createdAt,
      content: draft.content,
      tags: draft.tags,
    },
    ORGANIZER_SECRET
  )
}

describe("merchant organizer event-market references", () => {
  it("preserves imported naddr hints while comparing coordinate identity", () => {
    const imported = encodeEventMarketNaddr(COLLECTION, [HINT_RELAY])
    const parsed = parseOrganizerEventMarketReference(imported)

    expect(parsed).toEqual({
      coordinate: COLLECTION,
      naddr: imported,
      relayHints: [HINT_RELAY],
    })
    expect(organizerEventMarketReferencesMatch(imported, COLLECTION)).toBe(true)
  })

  it("uses a non-overlapping imported hint for reads and canonical share output", async () => {
    const imported = encodeEventMarketNaddr(COLLECTION, [HINT_RELAY])
    const readPlans: string[][] = []
    const now = Math.floor(Date.now() / 1_000)
    const graph = [
      signedEvent(
        buildEventMarketCalendarDraft({
          kind: EVENT_KINDS.CALENDAR_TIME,
          dTag: "public-market-day",
          title: "Public market day",
          start: now + 86_400,
          end: now + 90_000,
          startTzid: "UTC",
          endTzid: "UTC",
        }),
        now
      ),
      signedEvent(
        buildEventMarketCollectionDraft({
          dTag: "public-market",
          title: "Public market",
          eventCoordinate: CALENDAR,
          productCoordinates: [],
        }),
        now + 1
      ),
    ]
    __setEventMarketTestOverrides({
      getRelayLists: async () =>
        new Map([
          [
            ORGANIZER,
            {
              pubkey: ORGANIZER,
              readRelayUrls: [DISCOVERY_RELAY],
              writeRelayUrls: [],
              eventCreatedAt: 1,
              cachedAt: 1,
            },
          ],
        ]),
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        readPlans.push([...(options.relayUrls ?? [])])
        const filter = rawFilter as NDKFilter
        const events = graph.filter((event) => {
          if (filter.kinds && !filter.kinds.includes(event.kind as never)) {
            return false
          }
          if (filter.authors && !filter.authors.includes(event.pubkey)) {
            return false
          }
          const dTags = filter["#d"]
          return (
            !dTags ||
            event.tags.some(
              (tag) => tag[0] === "d" && dTags.includes(tag[1] ?? "")
            )
          )
        })
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
    })

    const market = await resolveOrganizerEventMarket(imported, ORGANIZER)

    expect(readPlans.length).toBeGreaterThan(0)
    for (const relayUrls of readPlans) {
      expect(relayUrls[0]).toBe(HINT_RELAY)
      expect(relayUrls.some((relayUrl) => relayUrl !== HINT_RELAY)).toBe(true)
    }
    expect(market.collectionCoordinate).toBe(COLLECTION)
    expect(market.naddr).toBe(imported)
    expect(
      decodeEventMarketReference(market.naddr, [30405])?.relayHints
    ).toEqual([HINT_RELAY])
  })
})
