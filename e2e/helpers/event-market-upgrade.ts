import type { Page } from "@playwright/test"
import { resolve } from "node:path"
import { viteFileModuleUrl } from "./vite-file-module-url"

export type EventMarketDatabaseHistory = {
  name: string
  version: number
  stores: Record<string, string>
}
export type EventMarketUpgradeRows = Record<
  string,
  Array<Record<string, unknown>>
>

export async function seedHistoricalEventMarketDatabase(
  page: Page,
  history: EventMarketDatabaseHistory,
  rows: EventMarketUpgradeRows
) {
  await page.evaluate(
    ({ history, rows }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(
          "conduit",
          Math.round(history.version * 10)
        )
        request.onerror = () => reject(request.error)
        request.onupgradeneeded = () => {
          for (const [name, schema] of Object.entries(history.stores)) {
            const [primary, ...indexes] = schema
              .split(",")
              .map((value) => value.trim())
            const path = (value: string) => {
              const key = value.replace(/^[&*+]+/, "")
              return key.startsWith("[") ? key.slice(1, -1).split("+") : key
            }
            const store = request.result.createObjectStore(name, {
              keyPath: path(primary!),
              autoIncrement: primary!.startsWith("++"),
            })
            for (const index of indexes)
              store.createIndex(index.replace(/^[&*]+/, ""), path(index), {
                unique: index.startsWith("&"),
                multiEntry: index.startsWith("*"),
              })
          }
        }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            Object.keys(rows),
            "readwrite"
          )
          transaction.onerror = () => {
            database.close()
            reject(transaction.error)
          }
          transaction.onabort = () => {
            database.close()
            reject(transaction.error)
          }
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          for (const [table, values] of Object.entries(rows))
            for (const row of values) transaction.objectStore(table).put(row)
        }
      }),
    { history, rows }
  )
}

export async function inspectUpgradedEventMarketDatabase(
  page: Page,
  history: EventMarketDatabaseHistory,
  rows: EventMarketUpgradeRows,
  coordinate: string
) {
  return page.evaluate(
    async ({ history, rows, coordinate, root }) => {
      const { ConduitDB } = await import(`${root}/db/index.ts`)
      const { createEventMarketEvidenceStore } = await import(
        `${root}/protocol/event-market-evidence-store.ts`
      )
      const { readEventMarketRoster } = await import(
        `${root}/protocol/event-market-roster-read.ts`
      )
      const database = new ConduitDB("conduit")
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, item]) => [key, canonical(item)])
              )
            : value
      try {
        await database.open()
        for (const [name, values] of Object.entries(rows)) {
          const key = history.stores[name]!.split(",")[0]!.replace(
            /^[&*+]+/,
            ""
          )
          if ((await database.table(name).count()) !== values.length)
            throw new Error(`Upgrade changed ${name} row count`)
          for (const value of values) {
            const restored = await database.table(name).get(value[key])
            if (
              JSON.stringify(canonical(restored)) !==
              JSON.stringify(canonical(value))
            )
              throw new Error(`Upgrade changed ${name} retained bytes`)
          }
        }
        const store = createEventMarketEvidenceStore(database)
        const read = await readEventMarketRoster(
          { reference: coordinate },
          {
            load: store.load,
            retain: store.retain,
            plan: async () => ({
              relayUrls: [],
              candidateRelayUrls: [],
              relayTargets: [],
              ownerSelectedRelayUrls: [],
              appRelayUrls: [],
              personalRelayUrls: [],
              independentRelayUrls: [],
              relayListState: "lookup-unavailable",
              relayHintTruncated: false,
            }),
            fetch: async () => ({ events: [], relays: [] }),
          }
        )
        return {
          nativeVersion: database.backendDB().version,
          preservedTables: Object.keys(rows).length,
          discoveryIndex:
            !!database.eventMarketRosterEvidence.schema.idxByName
              .discoveryBytes,
          deleted: read.resolution.state === "deleted",
          inventoryStores: [
            "merchantInventoryProducts",
            "merchantInventoryAssignments",
            "merchantInventoryAcceptedOrders",
          ].every((name) =>
            database.tables.some(
              (table: { name: string }) => table.name === name
            )
          ),
          organizerStockStores: [
            "eventMarketOrganizerStockPools",
            "eventMarketOrganizerStockEntries",
            "eventMarketOrganizerStockWriters",
          ].every((name) =>
            database.tables.some(
              (table: { name: string }) => table.name === name
            )
          ),
          organizerStockWriterIndexes: Array.from(
            database
              .backendDB()
              .transaction("eventMarketOrganizerStockWriters")
              .objectStore("eventMarketOrganizerStockWriters").indexNames
          ).sort(),
          organizerStockWriterMarketUnique: database
            .backendDB()
            .transaction("eventMarketOrganizerStockWriters")
            .objectStore("eventMarketOrganizerStockWriters")
            .index("[accountPubkey+marketCoordinate]").unique,
          organizerStockWriterCount:
            await database.eventMarketOrganizerStockWriters.count(),
        }
      } finally {
        database.close()
      }
    },
    {
      history,
      rows,
      coordinate,
      root: viteFileModuleUrl(resolve("packages/core/src")),
    }
  )
}
