import { expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { buildEventMarketRosterDraft } from "../packages/core/src/protocol/event-market-roster"
import { ConduitDB } from "../packages/core/src/db"
import {
  createEventMarketEvidenceStore,
  MAX_EVENT_MARKET_DISCOVERY_RECORDS,
  MAX_EVENT_MARKET_DISCOVERY_BYTES,
} from "../packages/core/src/protocol/event-market-evidence-store"
import {
  discoverFutureEventMarkets,
  readEventMarketRoster,
} from "../packages/core/src/protocol/event-market-roster-read"
import { fixture } from "./helpers/future-market-discovery-fixture"

for (const tag of ["a", "e"] as const) {
  it(`retains a new signed ${tag}-deletion at the row quota through offline restart`, async () => {
    const options = { indexedDB: new IDBFactory(), IDBKeyRange }
    const database = new ConduitDB(
      `negative-pressure-${crypto.randomUUID()}`,
      options
    )
    const state = fixture(1)
    const record = state.records[0]!
    const store = createEventMarketEvidenceStore(database)
    try {
      await store.retain(
        record.coordinate,
        [record.roster, record.calendar],
        "discovery"
      )
      const fillerCoordinate = `30409:${record.author}:budget`
      await store.retain(
        fillerCoordinate,
        Array.from(
          { length: MAX_EVENT_MARKET_DISCOVERY_RECORDS - 2 },
          (_, index) =>
            finalizeEvent(
              {
                ...record.roster,
                created_at: index + 300,
                tags: record.roster.tags.map((value) =>
                  value[0] === "d" ? ["d", "budget"] : value
                ),
              },
              record.secret
            )
        ),
        "discovery"
      )
      expect(await database.eventMarketRosterEvidence.count()).toBe(
        MAX_EVENT_MARKET_DISCOVERY_RECORDS
      )
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 200,
          tags: [[tag, tag === "a" ? record.coordinate : record.roster.id]],
          content: "",
        },
        record.secret
      )
      if (tag === "a") {
        const forged = finalizeEvent(
          {
            kind: 5,
            created_at: 200,
            tags: [["a", record.coordinate]],
            content: "",
          },
          generateSecretKey()
        )
        await expect(
          store.retain(record.coordinate, [forged], "discovery")
        ).rejects.toThrow("at capacity")
        await expect(
          store.retain(
            record.coordinate,
            [{ ...deletion, content: "tampered" }],
            "discovery"
          )
        ).rejects.toThrow("at capacity")
        expect(await database.eventMarketRosterEvidence.count()).toBe(
          MAX_EVENT_MARKET_DISCOVERY_RECORDS
        )
        const failedWrite = spyOn(
          database.eventMarketRosterEvidence,
          "bulkPut"
        ).mockImplementationOnce(async () => {
          throw new Error("fixture write failure")
        })
        try {
          await expect(
            store.retain(record.coordinate, [deletion], "discovery")
          ).rejects.toThrow("fixture write failure")
        } finally {
          failedWrite.mockRestore()
        }
        expect(await database.eventMarketRosterEvidence.count()).toBe(
          MAX_EVENT_MARKET_DISCOVERY_RECORDS
        )
        expect(
          (await store.load(record.coordinate)).some(
            (event) => event.id === record.calendar.id
          )
        ).toBe(true)
      }
      state.live.push(deletion)
      const live = await discoverFutureEventMarkets(
        { organizerPubkeys: [record.author] },
        { ...state.dependencies, ...store }
      )
      expect(
        live.markets.find((read) => read.coordinate === record.coordinate)
          ?.resolution.state
      ).toBe("deleted")
      database.close()
      const reopened = new ConduitDB(database.name, options)
      try {
        const restored = createEventMarketEvidenceStore(reopened)
        const offline = await readEventMarketRoster(
          { reference: record.coordinate },
          {
            ...state.dependencies,
            ...restored,
            fetch: async () => ({
              events: [],
              relays: [{ relayUrl: "wss://relay.example", status: "failed" }],
            }),
          }
        )
        expect(offline.resolution.state).toBe("deleted")
        expect(
          (await restored.load(record.coordinate)).some(
            (event) => event.id === deletion.id
          )
        ).toBe(true)
        expect(
          await reopened.eventMarketRosterEvidence.count()
        ).toBeLessThanOrEqual(MAX_EVENT_MARKET_DISCOVERY_RECORDS)
      } finally {
        reopened.close()
      }
    } finally {
      database.close()
      await database.delete()
    }
  }, 30_000)
}

it("retains a new deletion at the UTF-8 byte limit without discarding its roster witness", async () => {
  const options = { indexedDB: new IDBFactory(), IDBKeyRange }
  const database = new ConduitDB(
    `negative-byte-pressure-${crypto.randomUUID()}`,
    options
  )
  const state = fixture(1),
    record = state.records[0]!
  const store = createEventMarketEvidenceStore(database)
  try {
    await store.retain(
      record.coordinate,
      [record.roster, record.calendar],
      "discovery"
    )
    let remaining = MAX_EVENT_MARKET_DISCOVERY_BYTES
    await database.eventMarketRosterEvidence
      .where("discoveryBytes")
      .aboveOrEqual(0)
      .eachKey((key) => {
        remaining -= key as number
      })
    for (let index = 0; remaining > 0; index++) {
      const coordinate = `30409:${record.author}:byte-${index}`
      const draft = buildEventMarketRosterDraft({
        organizerPubkey: record.author,
        dTag: `byte-${index}`,
        calendarCoordinate: `31923:${record.author}:date-0`,
        state: "open",
        merchants: [],
      })
      const build = (padding: number) =>
        finalizeEvent(
          {
            ...draft,
            created_at: 100,
            tags: [...draft.tags, ["test-padding", "x".repeat(padding)]],
          },
          record.secret
        )
      const empty = build(0)
      const overhead =
        new TextEncoder().encode(
          JSON.stringify({
            id: `${coordinate}:${empty.id}`,
            marketCoordinate: coordinate,
            signedEvent: empty,
            cachedAt: Date.now(),
            discoveryBytes: 0,
          })
        ).byteLength + 16
      if (remaining < overhead) break
      let padding = Math.min(60_000, remaining - overhead)
      const tail = remaining - overhead - padding
      if (tail > 0 && tail < 2 * overhead) padding -= 2 * overhead - tail
      const event = padding ? build(padding) : empty
      await store.retain(coordinate, [event], "discovery")
      remaining -= (await database.eventMarketRosterEvidence.get(
        `${coordinate}:${event.id}`
      ))!.discoveryBytes!
    }
    expect(remaining).toBeLessThan(400)
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 200,
        tags: [["e", record.roster.id]],
        content: "",
      },
      record.secret
    )
    state.live.push(deletion)
    const live = await readEventMarketRoster(
      { reference: record.coordinate },
      {
        ...state.dependencies,
        load: store.load,
        retain: (coordinate, events) =>
          store.retain(coordinate, events, "discovery"),
      }
    )
    expect(live.resolution.state).toBe("deleted")
    expect(live.retained).toBe(true)
    database.close()
    const reopened = new ConduitDB(database.name, options)
    try {
      const restored = createEventMarketEvidenceStore(reopened)
      const offline = await readEventMarketRoster(
        { reference: record.coordinate },
        {
          ...state.dependencies,
          ...restored,
          fetch: async () => ({ events: [], relays: [] }),
        }
      )
      expect(offline.resolution.state).toBe("deleted")
      const events = await restored.load(record.coordinate)
      expect(events.some((event) => event.id === record.roster.id)).toBe(true)
      expect(events.some((event) => event.id === deletion.id)).toBe(true)
      let bytes = 0
      await reopened.eventMarketRosterEvidence
        .where("discoveryBytes")
        .aboveOrEqual(0)
        .eachKey((key) => {
          bytes += key as number
        })
      expect(bytes).toBeLessThanOrEqual(MAX_EVENT_MARKET_DISCOVERY_BYTES)
    } finally {
      reopened.close()
    }
  } finally {
    database.close()
    await database.delete()
  }
}, 30_000)

it("replaces only an empty initial candidate when the calendar is durable", async () => {
  const options = { indexedDB: new IDBFactory(), IDBKeyRange }
  const database = new ConduitDB(
    `negative-durable-pressure-${crypto.randomUUID()}`,
    options
  )
  const state = fixture(1),
    record = state.records[0]!
  const store = createEventMarketEvidenceStore(database)
  try {
    await store.retain(record.coordinate, [record.roster], "discovery")
    await store.retain(record.coordinate, [record.calendar])
    const cachedRow = (
      coordinate: string,
      signedEvent: typeof record.roster
    ) => {
      const row = {
        id: `${coordinate}:${signedEvent.id}`,
        marketCoordinate: coordinate,
        signedEvent,
        cachedAt: 1,
        discoveryBytes: 0,
      }
      row.discoveryBytes =
        new TextEncoder().encode(JSON.stringify(row)).byteLength + 16
      return row
    }
    const header = (dTag: string, state: "open" | "closed" = "open") =>
      finalizeEvent(
        {
          ...buildEventMarketRosterDraft({
            organizerPubkey: record.author,
            dTag,
            calendarCoordinate: `31923:${record.author}:date-0`,
            state,
            merchants: [],
          }),
          created_at: 100,
        },
        record.secret
      )
    const negativeCoordinate = `30409:${record.author}:known-negative`
    const protectedHeader = header("known-negative")
    const knownNegative = finalizeEvent(
      {
        kind: 5,
        created_at: 200,
        tags: [["e", protectedHeader.id]],
        content: "",
      },
      record.secret
    )
    const closedCoordinate = `30409:${record.author}:closed`
    const closed = header("closed", "closed")
    const rows = [
      cachedRow(negativeCoordinate, protectedHeader),
      cachedRow(negativeCoordinate, knownNegative),
      cachedRow(closedCoordinate, closed),
      ...Array.from(
        { length: MAX_EVENT_MARKET_DISCOVERY_RECORDS - 4 },
        (_, index) =>
          cachedRow(
            `30409:${record.author}:candidate-${index}`,
            header(`candidate-${index}`)
          )
      ),
    ]
    await database.eventMarketRosterEvidence.bulkPut(rows)
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 200,
        tags: [["e", record.roster.id]],
        content: "",
      },
      record.secret
    )
    await store.retain(record.coordinate, [deletion], "discovery")
    expect(
      (await store.load(record.coordinate)).map((event) => event.id).sort()
    ).toEqual([record.roster.id, record.calendar.id, deletion.id].sort())
    expect(
      (await store.load(negativeCoordinate)).some(
        (event) => event.id === knownNegative.id
      )
    ).toBe(true)
    expect(
      (await store.load(closedCoordinate)).some(
        (event) => event.id === closed.id
      )
    ).toBe(true)
    expect(
      await database.eventMarketRosterEvidence
        .where("discoveryBytes")
        .aboveOrEqual(0)
        .count()
    ).toBe(MAX_EVENT_MARKET_DISCOVERY_RECORDS)
    expect(
      (
        await database.eventMarketRosterEvidence.get(
          `${record.coordinate}:${record.calendar.id}`
        )
      )?.discoveryBytes
    ).toBeUndefined()
  } finally {
    database.close()
    await database.delete()
  }
}, 30_000)

it("retains a deletion with its durable witness when the entire discovery cache is protected", async () => {
  const options = { indexedDB: new IDBFactory(), IDBKeyRange }
  const database = new ConduitDB(
    `negative-protected-pressure-${crypto.randomUUID()}`,
    options
  )
  const state = fixture(1),
    record = state.records[0]!
  const store = createEventMarketEvidenceStore(database)
  try {
    await store.retain(record.coordinate, [record.roster, record.calendar])
    const rows = Array.from(
      { length: MAX_EVENT_MARKET_DISCOVERY_RECORDS / 2 },
      (_, index) => {
        const coordinate = `30409:${record.author}:protected-${index}`
        const roster = finalizeEvent(
          {
            ...buildEventMarketRosterDraft({
              organizerPubkey: record.author,
              dTag: `protected-${index}`,
              calendarCoordinate: `31923:${record.author}:date-0`,
              state: "closed",
              merchants: [],
            }),
            created_at: 100,
          },
          record.secret
        )
        const deletion = finalizeEvent(
          { kind: 5, created_at: 200, tags: [["a", coordinate]], content: "" },
          record.secret
        )
        return [roster, deletion].map((signedEvent) => {
          const row = {
            id: `${coordinate}:${signedEvent.id}`,
            marketCoordinate: coordinate,
            signedEvent,
            cachedAt: 1,
            discoveryBytes: 0,
          }
          row.discoveryBytes =
            new TextEncoder().encode(JSON.stringify(row)).byteLength + 16
          return row
        })
      }
    ).flat()
    await database.eventMarketRosterEvidence.bulkPut(rows)
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 200,
        tags: [["e", record.roster.id]],
        content: "",
      },
      record.secret
    )
    await store.retain(record.coordinate, [deletion], "discovery")
    expect(await database.eventMarketRosterEvidence.count()).toBe(
      MAX_EVENT_MARKET_DISCOVERY_RECORDS + 3
    )
    expect(
      await database.eventMarketRosterEvidence
        .where("discoveryBytes")
        .aboveOrEqual(0)
        .count()
    ).toBe(MAX_EVENT_MARKET_DISCOVERY_RECORDS)
    expect(
      (
        await database.eventMarketRosterEvidence.get(
          `${record.coordinate}:${deletion.id}`
        )
      )?.discoveryBytes
    ).toBeUndefined()
    database.close()
    const reopened = new ConduitDB(database.name, options)
    try {
      const restored = createEventMarketEvidenceStore(reopened)
      const offline = await readEventMarketRoster(
        { reference: record.coordinate },
        {
          ...state.dependencies,
          ...restored,
          fetch: async () => ({ events: [], relays: [] }),
        }
      )
      expect(offline.resolution.state).toBe("deleted")
    } finally {
      reopened.close()
    }
  } finally {
    database.close()
    await database.delete()
  }
}, 30_000)
