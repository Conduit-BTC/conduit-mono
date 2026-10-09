import { afterEach, describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import Dexie from "dexie"
import { finalizeEvent } from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  discoverFutureEventMarkets,
  readEventMarketAuthorization,
  readEventMarketRoster,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import {
  createEventMarketEvidenceStore,
  MAX_EVENT_MARKET_DISCOVERY_BYTES,
  MAX_EVENT_MARKET_DISCOVERY_RECORDS,
} from "@conduit/core/protocol/event-market-evidence-store"
import { fixture } from "./helpers/future-market-discovery-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  const opened = databases.splice(0)
  for (const database of opened) database.close()
  await Promise.all(
    [
      ...new Map(opened.map((database) => [database.name, database])).values(),
    ].map((database) => database.delete())
  )
})
function storage() {
  const database = new ConduitDB(`event-discovery-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  return { database, ...createEventMarketEvidenceStore(database) }
}
function candidates(count: number) {
  const state = fixture(1)
  const record = state.records[0]!
  const rosters = Array.from({ length: count }, (_, index) =>
    finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          organizerPubkey: record.author,
          dTag: `storage-${index}`,
          calendarCoordinate: `31923:${record.author}:date-0`,
          state: "open",
          merchants: [],
        }),
        created_at: 100 + Math.floor(index / 100),
      },
      record.secret
    )
  )
  state.live.splice(0, state.live.length, ...rosters, record.calendar)
  return state
}

describe("bounded Event Market discovery storage", () => {
  it("adds the discovery size index to v25 without rewriting legacy evidence", async () => {
    const name = `event-discovery-upgrade-${crypto.randomUUID()}`
    const previous = new Dexie(name, { indexedDB, IDBKeyRange })
    previous
      .version(25)
      .stores({ eventMarketRosterEvidence: "id, marketCoordinate, cachedAt" })
    const record = fixture(1).records[0]!
    const row = {
      id: `${record.coordinate}:${record.roster.id}`,
      marketCoordinate: record.coordinate,
      signedEvent: record.roster,
      cachedAt: 1,
    }
    await previous.table("eventMarketRosterEvidence").put(row)
    previous.close()
    const upgraded = new ConduitDB(name, { indexedDB, IDBKeyRange })
    databases.push(upgraded)
    await upgraded.open()
    expect(upgraded.verno).toBe(26)
    expect(
      upgraded.eventMarketRosterEvidence.schema.idxByName.discoveryBytes
    ).toBeDefined()
    expect(await upgraded.eventMarketRosterEvidence.get(row.id)).toEqual(
      JSON.parse(JSON.stringify(row))
    )
    expect(
      await upgraded.eventMarketRosterEvidence
        .where("discoveryBytes")
        .aboveOrEqual(0)
        .count()
    ).toBe(0)
  })

  it("keeps excess signed guest candidates out of storage and resumes their exact observed sources", async () => {
    const state = candidates(MAX_EVENT_MARKET_DISCOVERY_RECORDS + 2)
    const store = storage()
    const dependencies = {
      ...state.dependencies,
      load: store.load,
      retain: store.retain,
    }
    const first = await discoverFutureEventMarkets({}, dependencies)
    const rows = await store.database.eventMarketRosterEvidence.toArray()
    expect(first.markets).toHaveLength(128)
    expect(rows).toHaveLength(256)
    expect(new Set(rows.map((row) => row.marketCoordinate)).size).toBe(128)
    expect(rows.every((row) => row.discoveryBytes !== undefined)).toBe(true)
    expect(first.continuation?.pendingCoordinates).toHaveLength(1_922)
    expect(
      first.continuation?.pendingCoordinates.every((item) =>
        item.relayHints.includes("wss://relay.example")
      )
    ).toBe(true)
    const pending = first.continuation!.pendingCoordinates[0]!.coordinate
    expect(await store.load(pending)).toEqual([])
    const next = await discoverFutureEventMarkets(
      { continuation: JSON.parse(JSON.stringify(first.continuation)) },
      dependencies
    )
    expect(next.markets).toHaveLength(128)
    expect(next.markets[0]?.calendar).toBeDefined()
    expect(next.markets.some((market) => market.coordinate === pending)).toBe(
      true
    )
    expect(await store.database.eventMarketRosterEvidence.count()).toBe(512)
    expect(next.continuation?.pendingCoordinates).toHaveLength(1_794)
  }, 30_000)

  it("enforces one row budget across concurrent stores and keeps uncached live events visible", async () => {
    const state = candidates(129)
    const record = state.records[0]!
    const store = storage()
    // Fill the actual default budget with signed revisions in one transaction.
    const revisions = Array.from(
      { length: MAX_EVENT_MARKET_DISCOVERY_RECORDS - 1 },
      (_, index) =>
        finalizeEvent(
          {
            ...record.roster,
            created_at: index + 1,
          },
          record.secret
        )
    )
    await store.retain(record.coordinate, revisions, "discovery")
    const peerDatabase = new ConduitDB(store.database.name, {
      indexedDB,
      IDBKeyRange,
    })
    databases.push(peerDatabase)
    const peer = createEventMarketEvidenceStore(peerDatabase)
    const attempts = await Promise.allSettled(
      state.live
        .filter((event) => event.kind === 30409)
        .slice(0, 4)
        .map((event, index) =>
          (index % 2 ? peer : store).retain(
            `30409:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")![1]}`,
            [event],
            "discovery"
          )
        )
    )
    expect(
      attempts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(await store.database.eventMarketRosterEvidence.count()).toBe(
      MAX_EVENT_MARKET_DISCOVERY_RECORDS
    )
    const dependencies = {
      ...state.dependencies,
      load: store.load,
      retain: store.retain,
    }
    const result = await discoverFutureEventMarkets({}, dependencies)
    expect(result.markets).toHaveLength(128)
    expect(result.markets.every((market) => !!market.calendar)).toBe(true)
    expect(result.markets.some((market) => !market.retained)).toBe(true)
    expect(result.coverage).toBe("partial")
    expect(result.continuation?.pendingCoordinates).toHaveLength(1)
    const continued = await discoverFutureEventMarkets(
      { continuation: result.continuation },
      dependencies
    )
    expect(continued.markets).toHaveLength(1)
    expect(continued.markets[0]?.calendar).toBeDefined()
    await discoverFutureEventMarkets({}, dependencies)
    expect(await store.database.eventMarketRosterEvidence.count()).toBe(
      MAX_EVENT_MARKET_DISCOVERY_RECORDS
    )
  }, 30_000)

  it("bounds aggregate UTF-8 bytes while semantically valid events keep loading beyond cache capacity", async () => {
    const state = candidates(140)
    const record = state.records[0]!
    const store = storage()
    state.live.splice(
      0,
      state.live.length,
      ...state.live.map((event) =>
        event.kind === 30409
          ? finalizeEvent(
              {
                ...event,
                tags: [...event.tags, ["test-padding", "😀".repeat(15_750)]],
              },
              record.secret
            )
          : event
      )
    )
    const dependencies = {
      ...state.dependencies,
      load: store.load,
      retain: store.retain,
    }
    const first = await discoverFutureEventMarkets({}, dependencies)
    expect(first.markets).toHaveLength(128)
    expect(
      first.markets.every((market) => market.resolution.state === "current")
    ).toBe(true)
    const next = await discoverFutureEventMarkets(
      { continuation: first.continuation },
      dependencies
    )
    expect(next.markets).toHaveLength(12)
    expect(
      next.markets.every(
        (market) => market.resolution.state === "current" && !!market.calendar
      )
    ).toBe(true)
    expect(next.markets.some((market) => !market.retained)).toBe(true)
    expect(next.coverage).toBe("partial")
    const rows = await store.database.eventMarketRosterEvidence.toArray()
    expect(rows.length).toBeLessThan(280)
    expect(
      rows.reduce((total, row) => total + (row.discoveryBytes ?? 0), 0)
    ).toBeLessThanOrEqual(MAX_EVENT_MARKET_DISCOVERY_BYTES)
    expect(
      rows.reduce(
        (total, row) =>
          total + new TextEncoder().encode(JSON.stringify(row)).byteLength,
        0
      )
    ).toBeLessThanOrEqual(MAX_EVENT_MARKET_DISCOVERY_BYTES)
  }, 30_000)

  it("preserves saved and legacy signatures, tombstones, revocations, and durable promotion under cache pressure", async () => {
    const state = fixture(1)
    const record = state.records[0]!
    const store = storage()
    await store.retain(record.coordinate, [record.roster, record.calendar])
    const deletion = finalizeEvent(
      {
        kind: 5,
        tags: [["a", record.coordinate]],
        content: "",
        created_at: 200,
      },
      record.secret
    )
    const grant = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate: record.coordinate,
          merchantPubkey: record.author,
          state: "active",
          sequence: 0,
          parentIds: [],
        }),
        created_at: 110,
      },
      record.secret
    )
    const revoke = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate: record.coordinate,
          merchantPubkey: record.author,
          state: "revoked",
          sequence: 1,
          parentIds: [grant.id],
        }),
        created_at: 120,
      },
      record.secret
    )
    await store.retain(
      record.coordinate,
      [deletion, grant, revoke],
      "discovery"
    )
    const legacy = {
      id: `legacy:${record.calendar.id}`,
      marketCoordinate: `30409:${record.author}:legacy`,
      signedEvent: record.calendar,
      cachedAt: 1,
    }
    await store.database.eventMarketRosterEvidence.put(legacy)
    const pressure = candidates(1).records[0]!
    const large = finalizeEvent(
      {
        ...pressure.roster,
        content: "x".repeat(MAX_EVENT_MARKET_DISCOVERY_BYTES),
      },
      pressure.secret
    )
    await expect(
      store.retain(pressure.coordinate, [large], "discovery")
    ).rejects.toThrow("discovery cache is at capacity")
    const retained = await store.load(record.coordinate)
    expect(retained.map((event) => event.id).sort()).toEqual(
      [record.roster, record.calendar, deletion, grant, revoke]
        .map((event) => event.id)
        .sort()
    )
    expect(
      await store.database.eventMarketRosterEvidence.get(legacy.id)
    ).toEqual(JSON.parse(JSON.stringify(legacy)))
    const dependencies = {
      ...state.dependencies,
      load: store.load,
      retain: store.retain,
      fetch: async () => ({
        events: [] as SignedPublicNostrEvent[],
        relays: [
          { relayUrl: "wss://relay.example", status: "failed" as const },
        ],
      }),
    }
    const market = await readEventMarketRoster(
      { reference: record.coordinate },
      dependencies
    )
    expect(market.resolution.state).toBe("deleted")
    const authorization = await readEventMarketAuthorization(
      { marketCoordinate: record.coordinate, merchantPubkey: record.author },
      dependencies
    )
    expect(authorization.resolution.state).toBe("revoked")
    await store.retain(record.coordinate, [revoke])
    await store.retain(record.coordinate, [revoke], "discovery")
    expect(
      (
        await store.database.eventMarketRosterEvidence.get(
          `${record.coordinate}:${revoke.id}`
        )
      )?.discoveryBytes
    ).toBeUndefined()
  }, 30_000)
})
