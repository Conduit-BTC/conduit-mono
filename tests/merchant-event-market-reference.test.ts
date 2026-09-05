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
  CANONICAL_APP_BACKPLANE_RELAYS,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  EVENT_KINDS,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import {
  organizerEventMarketReferencesMatch,
  parseOrganizerEventMarketReference,
  resolveOrganizerEventMarket,
} from "../apps/merchant/src/lib/event-market"
import { rememberOrganizerEventMarket } from "../apps/merchant/src/lib/event-market-workflow"
import { loadEventCatalog } from "../apps/market/src/lib/event-market-adapter"
import {
  parseMerchantAuthHandoffSearch,
  parseMerchantEventsSearch,
} from "../apps/merchant/src/lib/market-links"

const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const COLLECTION = `30405:${ORGANIZER}:public-market`
const CALENDAR = `31923:${ORGANIZER}:public-market-day`
const HINT_RELAY = "wss://hint.example/events"
const DISCOVERY_RELAY = "wss://discovery.example/read"
const OBSERVED_RELAY = "wss://observed.example/events"
const CALENDAR_OBSERVED_RELAY = "wss://calendar-observed.example/events"
const FALLBACK_RELAY = CANONICAL_APP_BACKPLANE_RELAYS[0]!
const SUPPORT_ONLY_RELAYS = Array.from(
  { length: 7 },
  (_, index) => `wss://support-${index + 1}.example/events`
)

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
  it("accepts only an exact collection naddr from the Merchant route query", () => {
    const imported = encodeEventMarketNaddr(COLLECTION, [HINT_RELAY])

    expect(parseMerchantEventsSearch({ event: imported })).toEqual({
      event: imported,
    })
    expect(parseMerchantEventsSearch({ event: COLLECTION })).toEqual({})
    expect(
      parseMerchantEventsSearch({
        event: `https://attacker.example/redirect/${imported}`,
      })
    ).toEqual({})
    expect(
      parseMerchantEventsSearch({
        event: encodeEventMarketNaddr(CALENDAR),
      })
    ).toEqual({})
    expect(parseMerchantEventsSearch({ event: [imported] })).toEqual({})
  })

  it("preserves only a validated event through the signed-out auth handoff", () => {
    const imported = encodeEventMarketNaddr(COLLECTION, [HINT_RELAY])

    expect(
      parseMerchantAuthHandoffSearch({
        authRequired: "true",
        event: imported,
      })
    ).toEqual({ authRequired: true, event: imported })
    expect(
      parseMerchantAuthHandoffSearch({
        authRequired: true,
        event: `https://attacker.example/redirect/${imported}`,
      })
    ).toEqual({ authRequired: true })
    expect(
      parseMerchantAuthHandoffSearch({
        authRequired: "false",
        event: encodeEventMarketNaddr(CALENDAR),
      })
    ).toEqual({})
  })

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
          events: events.map((event) => {
            const ndkEvent = new NDKEvent(undefined, event)
            attachEventSourceRelayUrl(ndkEvent, OBSERVED_RELAY)
            return ndkEvent
          }),
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
    expect(market.naddr).toBe(
      encodeEventMarketNaddr(COLLECTION, [HINT_RELAY, OBSERVED_RELAY])
    )
    expect(
      decodeEventMarketReference(market.naddr, [30405])?.relayHints
    ).toEqual([HINT_RELAY, OBSERVED_RELAY])
  })

  it("queries the eighth relay on an explicit imported reference", async () => {
    const importedHints = Array.from(
      { length: 8 },
      (_, index) => `wss://import-${index + 1}.example/events`
    )
    const imported = encodeEventMarketNaddr(COLLECTION, importedHints)
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
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const relayUrls = [...(options.relayUrls ?? [])]
        readPlans.push(relayUrls)
        const events = relayUrls.includes(importedHints[7]!)
          ? graph.filter((event) => {
              const filter = rawFilter as NDKFilter
              if (filter.kinds && !filter.kinds.includes(event.kind as never)) {
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
          : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: relayUrls.map((relayUrl) => ({
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

    expect(market.collectionCoordinate).toBe(COLLECTION)
    expect(readPlans.length).toBeGreaterThan(0)
    for (const relayUrls of readPlans) {
      expect(relayUrls).toEqual(importedHints)
    }
    expect(
      decodeEventMarketReference(market.naddr, [30405])?.relayHints
    ).toEqual(importedHints)

    readPlans.length = 0
    const guestCatalog = await loadEventCatalog(market.naddr)

    expect(guestCatalog.state).toBe("active")
    expect(readPlans.length).toBeGreaterThan(0)
    for (const relayUrls of readPlans) {
      expect(relayUrls).toEqual(importedHints)
    }
  })

  it("adds observed relay sources to a share link opened without hints", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const readPlans: string[][] = []
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
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        readPlans.push([...(options.relayUrls ?? [])])
        const filter = rawFilter as NDKFilter
        const events = graph
          .filter((event) => {
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
          .map((event) => {
            const ndkEvent = new NDKEvent(undefined, event)
            attachEventSourceRelayUrl(ndkEvent, OBSERVED_RELAY)
            return ndkEvent
          })
        return {
          events,
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

    const market = await resolveOrganizerEventMarket(COLLECTION, ORGANIZER)

    expect(
      decodeEventMarketReference(market.naddr, [30405])?.relayHints
    ).toEqual([OBSERVED_RELAY])

    readPlans.length = 0
    const guestCatalog = await loadEventCatalog(market.naddr)

    expect(guestCatalog.state).toBe("active")
    expect(readPlans.length).toBeGreaterThan(0)
    for (const relayUrls of readPlans) expect(relayUrls[0]).toBe(OBSERVED_RELAY)
  })

  it("reserves a fallback when required-record sources saturate share hints", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const readPlans: string[][] = []
    let requireFallback = false
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
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const relayUrls = [...(options.relayUrls ?? [])]
        readPlans.push(relayUrls)
        const filter = rawFilter as NDKFilter
        const fallbackAvailable = relayUrls.includes(FALLBACK_RELAY)
        const events =
          !requireFallback || fallbackAvailable
            ? graph
                .filter((event) => {
                  if (
                    filter.kinds &&
                    !filter.kinds.includes(event.kind as never)
                  ) {
                    return false
                  }
                  if (
                    filter.authors &&
                    !filter.authors.includes(event.pubkey)
                  ) {
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
                .map((event) => {
                  const ndkEvent = new NDKEvent(undefined, event)
                  if (event.kind === EVENT_KINDS.PRODUCT_COLLECTION) {
                    attachEventSourceRelayUrl(ndkEvent, OBSERVED_RELAY)
                  } else {
                    for (const relayUrl of SUPPORT_ONLY_RELAYS) {
                      attachEventSourceRelayUrl(ndkEvent, relayUrl)
                    }
                  }
                  return ndkEvent
                })
            : []
        return {
          events,
          relays: relayUrls.map((relayUrl) => ({
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

    const market = await resolveOrganizerEventMarket(COLLECTION, ORGANIZER)
    const publishHints = [OBSERVED_RELAY, ...SUPPORT_ONLY_RELAYS.slice(0, 6)]
    expect(
      decodeEventMarketReference(market.naddr, [30405])?.relayHints
    ).toEqual(publishHints)

    let savedValue: string | null = null
    const storage = {
      getItem: () => savedValue,
      setItem: (_key: string, value: string) => {
        savedValue = value
      },
    }
    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: encodeEventMarketNaddr(COLLECTION, [
          "wss://stale.example/events",
        ]),
        savedAt: 1,
      },
      storage
    )
    const saved = rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: market.naddr, savedAt: 2 },
      storage
    )
    const portableReference = saved[0]!.reference
    expect(
      decodeEventMarketReference(portableReference, [30405])?.relayHints
    ).toEqual(publishHints)

    requireFallback = true
    readPlans.length = 0
    const guestCatalog = await loadEventCatalog(portableReference)

    expect(readPlans).not.toHaveLength(0)
    for (const relayUrls of readPlans) {
      expect(relayUrls).toContain(OBSERVED_RELAY)
      expect(relayUrls).toContain(FALLBACK_RELAY)
      for (const supportRelay of SUPPORT_ONLY_RELAYS.slice(0, 6)) {
        expect(relayUrls).toContain(supportRelay)
      }
      expect(relayUrls).not.toContain(SUPPORT_ONLY_RELAYS[6])
    }
    expect(guestCatalog.state).toBe("active")
  })

  it("prefers live record sources over saturated stale cache hints", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const staleRelays = Array.from(
      { length: 8 },
      (_, index) => `wss://stale-${index + 1}.example/events`
    )
    const readPlans: string[][] = []
    let includeCache = true
    let requirePortablePlan = false
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
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const relayUrls = [...(options.relayUrls ?? [])]
        readPlans.push(relayUrls)
        const portablePlanReady =
          relayUrls.includes(OBSERVED_RELAY) &&
          relayUrls.includes(CALENDAR_OBSERVED_RELAY) &&
          relayUrls.includes(FALLBACK_RELAY)
        const filter = rawFilter as NDKFilter
        const events =
          !requirePortablePlan || portablePlanReady
            ? graph
                .filter((event) => {
                  if (
                    filter.kinds &&
                    !filter.kinds.includes(event.kind as never)
                  ) {
                    return false
                  }
                  if (
                    filter.authors &&
                    !filter.authors.includes(event.pubkey)
                  ) {
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
                .map((event) => {
                  const ndkEvent = new NDKEvent(undefined, event)
                  attachEventSourceRelayUrl(
                    ndkEvent,
                    event.kind === EVENT_KINDS.PRODUCT_COLLECTION
                      ? OBSERVED_RELAY
                      : CALENDAR_OBSERVED_RELAY
                  )
                  return ndkEvent
                })
            : []
        return {
          events,
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
      loadCachedEvidence: async () =>
        includeCache
          ? graph.map((event) => ({
              id: event.id.toLowerCase(),
              organizerPubkey: ORGANIZER,
              kind: event.kind,
              signedEvent: event,
              sourceRelayUrls: staleRelays,
              cachedAt: 1,
            }))
          : [],
      persistCachedEvidence: async () => undefined,
    })

    const market = await resolveOrganizerEventMarket(COLLECTION, ORGANIZER)
    const hints =
      decodeEventMarketReference(market.naddr, [30405])?.relayHints ?? []

    expect(hints.slice(0, 2)).toEqual([OBSERVED_RELAY, CALENDAR_OBSERVED_RELAY])
    expect(hints).toHaveLength(7)

    includeCache = false
    requirePortablePlan = true
    readPlans.length = 0
    const guestCatalog = await loadEventCatalog(market.naddr)

    expect(guestCatalog.state).toBe("active")
    expect(readPlans).not.toHaveLength(0)
    for (const relayUrls of readPlans) {
      expect(relayUrls).toContain(OBSERVED_RELAY)
      expect(relayUrls).toContain(CALENDAR_OBSERVED_RELAY)
      expect(relayUrls).toContain(FALLBACK_RELAY)
    }
  })
})
