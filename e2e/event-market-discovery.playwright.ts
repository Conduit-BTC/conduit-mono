import { expect, test } from "@playwright/test"
import { buildEventMarketCalendarDraft } from "@conduit/core/protocol/event-market"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

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
      expect(cache.schemaVersion).toBe(260)
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
