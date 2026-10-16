import { describe, expect, it, spyOn } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { isDeepStrictEqual } from "node:util"
import { finalizeEvent } from "nostr-tools/pure"
import { ConduitDB } from "../packages/core/src/db"
import { createEventMarketEvidenceStore } from "../packages/core/src/protocol/event-market-evidence-store"
import { readEventMarketRoster } from "../packages/core/src/protocol/event-market-roster-read"
import frozenHistories from "./fixtures/event-market-db-histories.json"
import { fixture } from "./helpers/future-market-discovery-fixture"

// Exact cumulative schemas extracted from the frozen source heads in the fixture.
// Generic rows prove table/key preservation; signed rows also exercise rehydration.
describe("Event Market schema lineage upgrades", () => {
  const histories = [
    ...frozenHistories,
    {
      ...frozenHistories[0]!,
      name: "native schema-repaired main",
      version: 26.1,
      stores: {
        ...frozenHistories[0]!.stores,
        eventMarketRosterEvidence:
          "id, marketCoordinate, cachedAt, discoveryBytes",
      },
    },
  ]
  for (const history of histories) {
    it(`preserves every ${history.name} v${history.version} table and signed deletion at a fresh version`, async () => {
      const options = { indexedDB: new IDBFactory(), IDBKeyRange }
      const name = `event-market-upgrade-${crypto.randomUUID()}`
      const state = fixture(1)
      const record = state.records[0]!
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 200,
          tags: [["a", record.coordinate]],
          content: "",
        },
        record.secret
      )
      const old = new Dexie(name, options)
      old.version(history.version).stores(history.stores)
      const retained = new Map<string, object[]>()
      for (const [table, schema] of Object.entries(history.stores)) {
        const primary = schema.split(",")[0]!.replace(/^[&+*]+/, "")
        expect(primary.startsWith("[")).toBe(false)
        retained.set(table, [
          { [primary]: `${table}-fixture`, marker: "retained-before-upgrade" },
        ])
      }
      retained.set(
        "eventMarketRosterEvidence",
        [record.roster, record.calendar, deletion].map((signedEvent) => {
          const row: {
            id: string
            marketCoordinate: string
            signedEvent: typeof signedEvent
            cachedAt: number
            discoveryBytes?: number
          } = {
            id: `${record.coordinate}:${signedEvent.id}`,
            marketCoordinate: record.coordinate,
            signedEvent,
            cachedAt: 1,
          }
          if (
            history.stores.eventMarketRosterEvidence.includes("discoveryBytes")
          ) {
            row.discoveryBytes = 0
            row.discoveryBytes =
              new TextEncoder().encode(JSON.stringify(row)).byteLength + 16
          }
          return row
        })
      )
      await old.open()
      for (const [table, rows] of retained) await old.table(table).bulkPut(rows)
      old.close()
      const upgraded = new ConduitDB(name, options)
      const warnings = spyOn(console, "warn").mockImplementation(() => {})
      try {
        await upgraded.open()
        expect(upgraded.verno).toBe(28)
        expect(upgraded.backendDB().version).toBe(280)
        expect(warnings).not.toHaveBeenCalled()
        for (const [table, rows] of retained) {
          expect(
            upgraded.tables.some((candidate) => candidate.name === table)
          ).toBe(true)
          if ((await upgraded.table(table).count()) !== rows.length)
            throw new Error(`Upgrade changed the retained ${table} row count.`)
          // Boolean comparisons keep signed/encrypted fixture bytes out of failure logs.
          const primary = history.stores[
            table as keyof typeof history.stores
          ]!.split(",")[0]!.replace(/^[&+*]+/, "")
          for (const row of rows) {
            const value = await upgraded
              .table(table)
              .get((row as Record<string, string>)[primary]!)
            if (!isDeepStrictEqual(value, structuredClone(row)))
              throw new Error(`Upgrade changed a retained ${table} row.`)
          }
        }
        expect(
          upgraded.eventMarketRosterEvidence.schema.idxByName.discoveryBytes
        ).toBeDefined()
        for (const table of [
          "merchantInventoryProducts",
          "merchantInventoryAssignments",
          "merchantInventoryAcceptedOrders",
          "localProductWriteIntents",
          "localProductWriteFrontiers",
          "localProductShippingOutbox",
          "commerceInboxWrappers",
          "sparkRecoveryEvidence",
        ])
          expect(
            upgraded.tables.some((candidate) => candidate.name === table)
          ).toBe(true)
        const store = createEventMarketEvidenceStore(upgraded)
        const restored = await readEventMarketRoster(
          { reference: record.coordinate },
          {
            ...state.dependencies,
            load: store.load,
            retain: store.retain,
            fetch: async () => ({ events: [], relays: [] }),
          }
        )
        expect(restored.resolution.state).toBe("deleted")
        expect(
          (await store.load(record.coordinate)).map((event) => event.id).sort()
        ).toEqual([record.roster.id, record.calendar.id, deletion.id].sort())
      } finally {
        warnings.mockRestore()
        upgraded.close()
        await upgraded.delete()
      }
    })
  }
})
