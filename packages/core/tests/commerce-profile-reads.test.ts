import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { config } from "../src/config"
import { ConduitDB, db, type CachedProfile } from "../src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getProfiles,
} from "../src/protocol/commerce"
import { parseRelayListEvent } from "../src/protocol/relay-list"
import { admitPublicEvent } from "../src/protocol/verified-public-event"

const testDb = new ConduitDB(`profile-reads-${crypto.randomUUID()}`, {
  indexedDB,
  IDBKeyRange,
})
const originalProfiles = db.profiles
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const originalConfig = { ...config }
const fixtureKey = new Uint8Array(32).fill(9)
const author = getPublicKey(fixtureKey)
const relay = "wss://one.profile-read-fixture.test"
const authorRelay = "wss://author.profile-read-fixture.net"
let restoreTransaction: () => void
let clockMs = 1_000_000
let networkAttempts = 0
let fetchCount = 0
let liveEvents: ReturnType<typeof finalizeEvent>[] = []

function profile(
  createdAt: number,
  content: { name?: string; lud16?: string } | string
) {
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      content: typeof content === "string" ? content : JSON.stringify(content),
      tags: [],
    },
    fixtureKey
  )
}

function cached(
  event: ReturnType<typeof finalizeEvent>,
  cachedAt = clockMs
): CachedProfile {
  const content = JSON.parse(event.content) as { name?: string; lud16?: string }
  return {
    pubkey: event.pubkey,
    name: content.name,
    lud16: content.lud16,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    rawContent: event.content,
    cachedAt,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function useSignedAuthorRelay() {
  const admitted = await admitPublicEvent(
    finalizeEvent(
      {
        kind: 10002,
        created_at: 1,
        content: "",
        tags: [["r", authorRelay, "write"]],
      },
      fixtureKey
    )
  )
  if (admitted.status !== "verified") {
    throw new Error("Ordinary signed relay-list fixture must be admitted")
  }
  const relayList = parseRelayListEvent(admitted.event)
  __setCommerceTestOverrides({
    getRelayLists: async () => new Map([[author, relayList]]),
    getRelayListsDetailed: async () => ({
      relayLists: new Map([[author, relayList]]),
      resolutionStates: new Map([[author, "network" as const]]),
    }),
  })
}

beforeAll(async () => {
  await testDb.open()
  db.profiles = testDb.profiles
  const transaction = spyOn(db, "transaction").mockImplementation(
    testDb.transaction.bind(testDb)
  )
  restoreTransaction = () => transaction.mockRestore()
})

beforeEach(async () => {
  __resetCommerceTestOverrides()
  await testDb.profiles.clear()
  clockMs = 1_000_000
  networkAttempts = 0
  fetchCount = 0
  liveEvents = []
  Object.assign(config, {
    defaultRelays: [relay],
    appReadRelayUrls: [relay],
    corePublicFallbackRelayUrls: [relay],
    commerceDiscoveryRelayUrls: [relay],
    appBackplaneRelayUrls: [relay],
  })
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error("External fetch forbidden in profile fixtures")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("External WebSocket forbidden in profile fixtures")
    }
  } as unknown as typeof WebSocket
  __setCommerceTestOverrides({
    now: () => clockMs,
    getCachedProducts: async () => [],
    getRelayLists: async () => new Map(),
    getRelayListsDetailed: async () => ({
      relayLists: new Map(),
      resolutionStates: new Map(),
    }),
    fetchPublicEvents: async () => {
      fetchCount++
      return liveEvents
    },
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  Object.assign(config, originalConfig)
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  expect(networkAttempts).toBe(0)
})

afterAll(async () => {
  restoreTransaction()
  db.profiles = originalProfiles
  await testDb.delete()
})

describe("commerce profile reads", () => {
  it("uses the display TTL but refreshes an expired profile and its authenticated owner", async () => {
    const retained = profile(10, { name: "Cached" })
    await db.profiles.put(cached(retained))
    liveEvents = [profile(11, { name: "Refreshed" })]
    const fresh = await getProfiles({ pubkeys: [author] })
    expect(fresh.data[author]?.name).toBe("Cached")
    expect(fresh.meta).toMatchObject({ source: "local_cache", stale: false })
    expect(fetchCount).toBe(0)

    clockMs += 5 * 60_000
    const expired = await getProfiles({ pubkeys: [author] })
    expect(expired.data[author]?.name).toBe("Refreshed")
    expect(fetchCount).toBe(1)

    liveEvents = [profile(12, { name: "Owner refresh" })]
    const owner = await getProfiles({
      pubkeys: [author],
      authenticatedPubkey: author,
    })
    expect(owner.data[author]?.name).toBe("Owner refresh")
    expect(fetchCount).toBe(2)
  })

  it("skipCache fetches without regressing a stronger signed retained frontier", async () => {
    const retained = profile(20, {
      name: "Retained",
      lud16: "retained@fixture.test",
    })
    await db.profiles.put(cached(retained))
    liveEvents = [profile(10, { name: "Older", lud16: "older@fixture.test" })]
    const result = await getProfiles({ pubkeys: [author], skipCache: true })
    expect(fetchCount).toBe(1)
    expect(result.data[author]?.lud16).toBe("retained@fixture.test")
    expect(result.profileContexts[author]).toMatchObject({
      frontier: { eventId: retained.id, rawContent: retained.content },
      freshness: "retained",
      readComplete: false,
    })
    expect(result.meta.stale).toBe(true)
    expect((await db.profiles.get(author))?.eventId).toBe(retained.id)
  })

  it.each(["removed", "malformed"] as const)(
    "a newer %s frontier cannot retain the old Lightning address",
    async (kind) => {
      await db.profiles.put(
        cached(
          profile(10, { name: "Retained name", lud16: "old@fixture.test" })
        )
      )
      const newer = profile(
        11,
        kind === "removed" ? { name: "Without address" } : "{malformed"
      )
      liveEvents = [newer]
      const result = await getProfiles({
        pubkeys: [author],
        skipCache: true,
        evidenceScope: "payment",
        requireCompleteEvidence: true,
      })
      expect(result.data[author]?.lud16).toBeUndefined()
      expect(result.profileContexts[author]?.profile.lud16).toBeUndefined()
      expect(result.profileContexts[author]?.frontier).toMatchObject({
        eventId: newer.id,
        rawContent: newer.content,
        validity: kind === "removed" ? "valid" : "malformed",
      })
      expect((await db.profiles.get(author))?.lud16).toBeUndefined()
      if (kind === "malformed") {
        expect(result.meta.degraded).toBe(true)
        expect(result.profileContexts[author]?.readComplete).toBe(false)
      } else {
        expect(result.profileContexts[author]?.signedEvent?.id).toBe(newer.id)
      }
    }
  )

  it("selects a stronger concurrently retained row when cache reconciliation resumes", async () => {
    await db.profiles.put(cached(profile(10, { name: "Initial" })))
    const observed = profile(11, {
      name: "Observed",
      lud16: "observed@fixture.test",
    })
    const concurrent = profile(12, {
      name: "Concurrent",
      lud16: "new@fixture.test",
    })
    liveEvents = [observed]
    const entered = deferred()
    const release = deferred()
    let cacheReads = 0
    __setCommerceTestOverrides({
      getCachedProfiles: async (pubkeys) => {
        if (++cacheReads === 2) {
          // Pause the reconciliation read after the initial snapshot and live result.
          entered.resolve()
          await release.promise
        }
        return db.profiles.bulkGet(pubkeys)
      },
      putCachedProfiles: async (rows) => {
        await db.profiles.bulkPut(rows)
      },
    })
    const read = getProfiles({ pubkeys: [author], skipCache: true })
    await entered.promise
    await db.profiles.put(cached(concurrent))
    release.resolve()
    const result = await read
    expect(result.data[author]?.lud16).toBe("new@fixture.test")
    expect(result.profileContexts[author]).toMatchObject({
      frontier: { eventId: concurrent.id },
      freshness: "retained",
      readComplete: false,
    })
    expect(result.meta.stale).toBe(true)
    expect((await db.profiles.get(author))?.eventId).toBe(concurrent.id)
  })

  it("emits provisional progress before committing the final selected context", async () => {
    const retained = profile(10, { name: "Cached" })
    const observed = profile(11, { name: "Observed" })
    await db.profiles.put(cached(retained, 0))
    liveEvents = [observed]
    const entered = deferred()
    const release = deferred()
    const progress: Array<{
      name: string | undefined
      eventId: string | undefined
      persistence: string | undefined
      readComplete: boolean | undefined
    }> = []
    __setCommerceTestOverrides({
      getCachedProfiles: (pubkeys) => db.profiles.bulkGet(pubkeys),
      putCachedProfiles: async (rows) => {
        entered.resolve()
        await release.promise
        await db.profiles.bulkPut(rows)
      },
    })
    const read = getProfiles({
      pubkeys: [author],
      evidenceScope: "full_profile",
      requireCompleteEvidence: true,
      onProgress(result) {
        const context = result.profileContexts[author]
        progress.push({
          name: result.data[author]?.name,
          eventId: context?.frontier?.eventId,
          persistence: context?.persistence,
          readComplete: context?.readComplete,
        })
      },
    })
    await entered.promise
    expect(progress).toEqual([
      {
        name: "Cached",
        eventId: retained.id,
        persistence: "durable",
        readComplete: false,
      },
      {
        name: "Observed",
        eventId: observed.id,
        persistence: "unknown",
        readComplete: false,
      },
    ])
    expect((await db.profiles.get(author))?.eventId).toBe(retained.id)
    release.resolve()
    const result = await read
    expect(result.profileContexts[author]).toMatchObject({
      frontier: { eventId: observed.id },
      persistence: "durable",
      freshness: "observed",
      readComplete: true,
    })
    expect((await db.profiles.get(author))?.eventId).toBe(observed.id)
  })

  it.each(["author", "optional"] as const)(
    "payment evidence distinguishes a failed %s relay from required author coverage",
    async (failed) => {
      await useSignedAuthorRelay()
      const event = profile(10, { name: "Observed", lud16: "pay@fixture.test" })
      __setCommerceTestOverrides({
        fetchSignedEventsFanoutDetailed: async (_filter, options) => {
          expect(options?.relayUrls).toContain(authorRelay)
          expect(options?.relayUrls).toContain(relay)
          return {
            events: [event],
            relays: [
              {
                relayUrl: authorRelay,
                status: failed === "author" ? "failed" : "success",
                eventCount: failed === "author" ? 0 : 1,
              },
              {
                relayUrl: relay,
                status: failed === "optional" ? "failed" : "success",
                eventCount: failed === "optional" ? 0 : 1,
              },
            ],
          }
        },
      })
      const result = await getProfiles({
        pubkeys: [author],
        evidenceScope: "payment",
        requireCompleteEvidence: true,
        authorRelayPaymentPolicy: true,
      })
      expect(result.profileContexts[author]).toMatchObject({
        frontier: { eventId: event.id },
        freshness: "observed",
        readComplete: failed === "optional",
        signedEvent: { id: event.id },
      })
      expect(result.meta.degraded).toBe(failed === "author")
      expect(result.meta.capped).toBe(false)
    }
  )

  it("does not attach older signed payment evidence to a stronger concurrent cache frontier", async () => {
    await useSignedAuthorRelay()
    await db.profiles.put(cached(profile(10, { name: "Initial" })))
    const observed = profile(11, {
      name: "Observed",
      lud16: "old@fixture.test",
    })
    const concurrent = profile(12, {
      name: "Concurrent",
      lud16: "new@fixture.test",
    })
    liveEvents = [observed]
    const entered = deferred()
    const release = deferred()
    let cacheReads = 0
    __setCommerceTestOverrides({
      getCachedProfiles: async (pubkeys) => {
        if (++cacheReads === 2) {
          entered.resolve()
          await release.promise
        }
        return db.profiles.bulkGet(pubkeys)
      },
      putCachedProfiles: async (rows) => {
        await db.profiles.bulkPut(rows)
      },
    })
    const read = getProfiles({
      pubkeys: [author],
      skipCache: true,
      evidenceScope: "payment",
      requireCompleteEvidence: true,
      authorRelayPaymentPolicy: true,
    })
    await entered.promise
    await db.profiles.put(cached(concurrent))
    release.resolve()
    const result = await read
    expect(result.profileContexts[author]).toMatchObject({
      profile: { lud16: "new@fixture.test" },
      frontier: { eventId: concurrent.id, rawContent: concurrent.content },
      freshness: "retained",
      persistence: "durable",
      readComplete: false,
    })
    expect(result.profileContexts[author]?.signedEvent).toBeUndefined()
    expect(result.meta.stale).toBe(true)
  })

  it.each(["complete", "partial", "capped"] as const)(
    "strict %s evidence retains the correct read-completion contract",
    async (coverage) => {
      const event = profile(10, { name: "Observed" })
      __setCommerceTestOverrides({
        fetchSignedEventsFanoutDetailed: async (filter) => ({
          events: [event],
          relays: [
            {
              relayUrl: relay,
              status: "success" as const,
              eventCount:
                coverage === "capped"
                  ? ((Array.isArray(filter)
                      ? filter[0]?.limit
                      : filter.limit) ?? 10)
                  : 1,
            },
            ...(coverage === "partial"
              ? [
                  {
                    relayUrl: "wss://two.profile-read-fixture.test",
                    status: "failed" as const,
                    eventCount: 0,
                  },
                ]
              : []),
          ],
        }),
      })
      const result = await getProfiles({
        pubkeys: [author],
        evidenceScope: "full_profile",
        requireCompleteEvidence: true,
      })
      expect(result.data[author]?.name).toBe("Observed")
      expect(result.profileContexts[author]).toMatchObject({
        frontier: { eventId: event.id },
        freshness: "observed",
        readComplete: coverage === "complete",
      })
      // Saturation is represented separately from transport degradation.
      expect(result.meta.degraded).toBe(coverage === "partial")
      expect(result.meta.capped).toBe(coverage === "capped")
    }
  )

  it("propagates revoked transport authority instead of returning its captured cache", async () => {
    await db.profiles.put(cached(profile(10, { name: "Cached" }), 0))
    const entered = deferred()
    const release = deferred()
    const cancelled = new Error(
      "Controlled profile-read authority cancellation"
    )
    let active = true
    __setCommerceTestOverrides({
      fetchPublicEvents: async (_filter, options) => {
        entered.resolve()
        await release.promise
        if (options?.shouldContinue?.() === false) throw cancelled
        return []
      },
    })
    const read = getProfiles({
      pubkeys: [author],
      shouldContinue: () => active,
    })
    await entered.promise
    active = false
    release.resolve()
    await expect(read).rejects.toBe(cancelled)
  })
})
