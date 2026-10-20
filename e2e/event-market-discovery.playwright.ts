import { expect, test } from "@playwright/test"
import { resolve } from "node:path"
import { viteFileModuleUrl } from "./helpers/vite-file-module-url"
import { buildEventMarketCalendarDraft } from "@conduit/core/protocol/event-market"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import frozenDatabaseHistories from "../tests/fixtures/event-market-db-histories.json" with { type: "json" }
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"
import {
  seedHistoricalEventMarketDatabase,
  inspectUpgradedEventMarketDatabase,
  type EventMarketDatabaseHistory,
  type EventMarketUpgradeRows,
} from "./helpers/event-market-upgrade"

test.use({ trace: "off", screenshot: "off", video: "off" })
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

for (const audience of ["guest", "following"] as const) {
  test(`${audience} finds a public event outside the first 64 organizers @market`, async ({
    page,
  }, testInfo) => {
    const organizer = createRuntimeSignerIdentity()
    const buyer = createRuntimeSignerIdentity()
    const createdAt = Math.floor(Date.now() / 1_000)
    const title = `${audience === "guest" ? "Public" : "Following"} discovery fair ${testInfo.project.name}`
    const date = new Date(Date.now() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const requests: Array<{ kind: number; authorCount?: number }> = []
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload))
        if (frame[0] !== "REQ") return
        for (const filter of frame.slice(2))
          if (filter.kinds?.includes(30409) && !filter["#d"])
            requests.push({ kind: 30409, authorCount: filter.authors?.length })
      })
    )
    try {
      const calendar = signRuntimeTestEvent(organizer, {
        ...buildEventMarketCalendarDraft({
          kind: 31922,
          dTag: "discovery-date",
          title,
          start: date,
        }),
        created_at: createdAt,
      })
      const roster = signRuntimeTestEvent(organizer, {
        ...buildEventMarketRosterDraft({
          organizerPubkey: organizer.pubkey,
          dTag: "discovery-fair",
          calendarCoordinate: `31922:${organizer.pubkey}:discovery-date`,
          state: "open",
          merchants: [],
        }),
        created_at: createdAt,
      })
      const followAuthors = Array.from({ length: 955 }, (_, index) =>
        (index + 1).toString(16).padStart(64, "0")
      )
      expect(
        [...followAuthors, organizer.pubkey].sort().indexOf(organizer.pubkey)
      ).toBeGreaterThan(64)
      const follows = signRuntimeTestEvent(buyer, {
        kind: 3,
        created_at: createdAt,
        tags:
          audience === "following"
            ? [...followAuthors, organizer.pubkey].map((author) => [
                "p",
                author,
              ])
            : [],
        content: "",
      })
      await publishTestRelayEvents([calendar, roster, follows])
      if (audience === "following")
        await installRealTestSigner(page, buyer, TEST_RELAY_URL)
      await page.goto(
        `${marketUrl}/events${audience === "following" ? "?source=following" : ""}`
      )
      await expect(page.getByText(title, { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      const cache = await page.evaluate(
        () =>
          new Promise<{
            records: number
            bytes: number
            schemaVersion: number
          }>((resolve, reject) => {
            const request = indexedDB.open("conduit")
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction(
                "eventMarketRosterEvidence",
                "readonly"
              )
              const cursor = transaction
                .objectStore("eventMarketRosterEvidence")
                .index("discoveryBytes")
                .openKeyCursor(IDBKeyRange.lowerBound(0))
              let records = 0,
                bytes = 0
              cursor.onerror = () => {
                database.close()
                reject(cursor.error)
              }
              cursor.onsuccess = () => {
                const row = cursor.result
                if (row) {
                  records++
                  bytes += row.key as number
                  row.continue()
                } else {
                  database.close()
                  resolve({ records, bytes, schemaVersion: database.version })
                }
              }
            }
          })
      )
      expect(cache.schemaVersion).toBe(290)
      expect(cache.records).toBeGreaterThanOrEqual(2)
      expect(cache.records).toBeLessThanOrEqual(2_048)
      expect(cache.bytes).toBeLessThanOrEqual(8 * 1_024 * 1_024)
      if (audience === "guest") {
        await expect(
          page.getByText("Browsing public events from your selected relays.")
        ).toBeVisible()
        expect(
          requests.some((request) => request.authorCount === undefined)
        ).toBe(true)
      } else {
        expect(requests.length).toBeGreaterThan(1)
        expect(
          requests.every(
            (request) =>
              request.authorCount !== undefined && request.authorCount <= 64
          )
        ).toBe(true)
      }
    } finally {
      disposeRuntimeSignerIdentity(organizer)
      disposeRuntimeSignerIdentity(buyer)
    }
  })
}

const databaseHistories: EventMarketDatabaseHistory[] = [
  ...frozenDatabaseHistories,
  {
    ...frozenDatabaseHistories[0]!,
    name: "native schema-repaired main",
    version: 26.1,
    stores: {
      ...frozenDatabaseHistories[0]!.stores,
      eventMarketRosterEvidence:
        "id, marketCoordinate, cachedAt, discoveryBytes",
    },
  },
]

for (const history of databaseHistories) {
  test(`native ${history.name} v${history.version} upgrade preserves every table and signed deletion across reload @market`, async ({
    page,
  }) => {
    const organizer = createRuntimeSignerIdentity()
    const coordinate = `30409:${organizer.pubkey}:upgrade`
    const calendar = signRuntimeTestEvent(organizer, {
      ...buildEventMarketCalendarDraft({
        kind: 31922,
        dTag: "upgrade-date",
        title: "Native migration fixture",
        start: "2099-01-01",
      }),
      created_at: 100,
    })
    const roster = signRuntimeTestEvent(organizer, {
      ...buildEventMarketRosterDraft({
        organizerPubkey: organizer.pubkey,
        dTag: "upgrade",
        calendarCoordinate: `31922:${organizer.pubkey}:upgrade-date`,
        state: "open",
        merchants: [],
      }),
      created_at: 100,
    })
    const deletion = signRuntimeTestEvent(organizer, {
      kind: 5,
      created_at: 200,
      tags: [["e", roster.id]],
      content: "",
    })
    const rows: EventMarketUpgradeRows = Object.fromEntries(
      Object.entries(history.stores).map(([name, schema]) => [
        name,
        [
          {
            [schema.split(",")[0]!.replace(/^[&*+]+/, "")]: `${name}-fixture`,
            marker: "retained-before-upgrade",
          },
        ],
      ])
    )
    rows.eventMarketRosterEvidence = [roster, calendar, deletion].map(
      (signedEvent) => {
        const row: Record<string, unknown> = {
          id: `${coordinate}:${signedEvent.id}`,
          marketCoordinate: coordinate,
          signedEvent,
          cachedAt: 1,
        }
        if (
          history.stores.eventMarketRosterEvidence!.includes("discoveryBytes")
        ) {
          row.discoveryBytes = 0
          row.discoveryBytes =
            new TextEncoder().encode(JSON.stringify(row)).byteLength + 16
        }
        return row
      }
    )
    let workaroundWarnings = 0
    page.on("console", (message) => {
      if (
        message.type() === "warning" &&
        /schema.*(?:extend|version)|(?:extend|version).*schema/i.test(
          message.text()
        )
      )
        workaroundWarnings++
    })
    try {
      // The legal boot boundary does not open product providers or IndexedDB.
      await page.goto(marketUrl + "/privacy-policy")
      await seedHistoricalEventMarketDatabase(page, history, rows)
      const expected = {
        nativeVersion: 290,
        preservedTables: Object.keys(history.stores).length,
        discoveryIndex: true,
        deleted: true,
        inventoryStores: true,
        organizerStockStores: true,
        organizerStockWriterIndexes: [
          "accountPubkey",
          "[accountPubkey+marketCoordinate]",
        ].sort(),
        organizerStockWriterMarketUnique: true,
        organizerStockWriterCount:
          rows.eventMarketOrganizerStockWriters?.length ?? 0,
      }
      expect(
        await inspectUpgradedEventMarketDatabase(
          page,
          history,
          rows,
          coordinate
        )
      ).toEqual(expected)
      await page.reload()
      expect(
        await inspectUpgradedEventMarketDatabase(
          page,
          history,
          rows,
          coordinate
        )
      ).toEqual(expected)
      expect(workaroundWarnings).toBe(0)
    } finally {
      disposeRuntimeSignerIdentity(organizer)
    }
  })
}

test("native full discovery cache retains an exact-event deletion through reload @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const organizer = createRuntimeSignerIdentity()
  const coordinate = `30409:${organizer.pubkey}:pressure`
  const calendarCoordinate = `31922:${organizer.pubkey}:pressure-date`
  try {
    const calendar = signRuntimeTestEvent(organizer, {
      ...buildEventMarketCalendarDraft({
        kind: 31922,
        dTag: "pressure-date",
        title: "Pressure fixture",
        start: "2099-01-01",
      }),
      created_at: 100,
    })
    const roster = signRuntimeTestEvent(organizer, {
      ...buildEventMarketRosterDraft({
        organizerPubkey: organizer.pubkey,
        dTag: "pressure",
        calendarCoordinate,
        state: "open",
        merchants: [],
      }),
      created_at: 100,
    })
    const deletion = signRuntimeTestEvent(organizer, {
      kind: 5,
      created_at: 200,
      tags: [["e", roster.id]],
      content: "",
    })
    const filler = Array.from({ length: 2046 }, (_, index) => {
      const dTag = `budget-${index}`,
        coordinate = `30409:${organizer.pubkey}:${dTag}`
      return {
        coordinate,
        event: signRuntimeTestEvent(organizer, {
          ...buildEventMarketRosterDraft({
            organizerPubkey: organizer.pubkey,
            dTag,
            calendarCoordinate,
            state: "open",
            merchants: [],
          }),
          created_at: 100,
        }),
      }
    })
    await page.goto(marketUrl + "/privacy-policy")
    const retained = await page.evaluate(
      async ({ coordinate, roster, calendar, deletion, filler, root }) => {
        const { ConduitDB } = await import(`${root}/db/index.ts`)
        const { createEventMarketEvidenceStore } = await import(
          `${root}/protocol/event-market-evidence-store.ts`
        )
        const { sameSignedPublicEvent } = await import(
          `${root}/protocol/verified-public-event.ts`
        )
        const database = new ConduitDB("conduit")
        try {
          await database.open()
          const store = createEventMarketEvidenceStore(database)
          await store.retain(coordinate, [roster, calendar], "discovery")
          const rows = filler.map(({ coordinate, event }) => {
            const row = {
              id: `${coordinate}:${event.id}`,
              marketCoordinate: coordinate,
              signedEvent: event,
              cachedAt: 1,
              discoveryBytes: 0,
            }
            row.discoveryBytes =
              new TextEncoder().encode(JSON.stringify(row)).byteLength + 16
            return row
          })
          await database.eventMarketRosterEvidence.bulkPut(rows)
          const before = await database.eventMarketRosterEvidence.count()
          await store.retain(coordinate, [deletion], "discovery")
          const saved = await store.load(coordinate)
          let bytes = 0
          await database.eventMarketRosterEvidence
            .where("discoveryBytes")
            .aboveOrEqual(0)
            .eachKey((key: unknown) => {
              bytes += key as number
            })
          return {
            before,
            after: await database.eventMarketRosterEvidence.count(),
            bytes,
            witness: saved.some((event: unknown) =>
              sameSignedPublicEvent(event, roster)
            ),
            deletion: saved.some((event: unknown) =>
              sameSignedPublicEvent(event, deletion)
            ),
          }
        } finally {
          database.close()
        }
      },
      {
        coordinate,
        roster,
        calendar,
        deletion,
        filler,
        root: viteFileModuleUrl(resolve("packages/core/src")),
      }
    )
    expect(retained.before).toBe(2048)
    expect(retained.after).toBeLessThanOrEqual(2048)
    expect(retained.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(retained.witness && retained.deletion).toBe(true)
    await page.reload()
    const restored = await inspectUpgradedEventMarketDatabase(
      page,
      databaseHistories[0]!,
      {},
      coordinate
    )
    expect(restored.deleted).toBe(true)
    expect(restored.nativeVersion).toBe(290)
    expect(restored.organizerStockStores).toBe(true)
    expect(restored.organizerStockWriterIndexes).toEqual(
      ["accountPubkey", "[accountPubkey+marketCoordinate]"].sort()
    )
    expect(restored.organizerStockWriterMarketUnique).toBe(true)
    expect(restored.organizerStockWriterCount).toBe(0)
  } finally {
    disposeRuntimeSignerIdentity(organizer)
  }
})
