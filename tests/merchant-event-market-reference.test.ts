import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  organizerEventMarketReferencesMatch,
  parseOrganizerEventMarketReference,
  resolveOrganizerEventMarket,
} from "../apps/merchant/src/lib/event-market"

const ORGANIZER = "a".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:public-market`
const HINT_RELAY = "wss://hint.example/events"
const DISCOVERY_RELAY = "wss://discovery.example/read"

afterEach(() => __resetEventMarketTestOverrides())

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
      fetchEventsFanoutDetailed: async (_filter, options) => {
        readPlans.push([...(options.relayUrls ?? [])])
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
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
