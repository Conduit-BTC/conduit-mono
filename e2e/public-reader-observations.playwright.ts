import { expect, test } from "@playwright/test"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  getPublicKey,
  generateSecretKey,
} from "nostr-tools/pure"
import { installTestSigner, TEST_RELAY_URL } from "./helpers/auth"

test.use({ screenshot: "off", trace: "off", video: "off" })
const key = generateSecretKey()
const merchant = getPublicKey(key)
const created_at = 1790812800
const sign = (kind: number, content: string, tags: string[][] = []) =>
  finalizeEvent({ kind, content, tags, created_at }, key)
const title = "Plain reader fixture listing"
const fixture = [
  sign(0, JSON.stringify({ name: "Reader fixture merchant" })),
  sign(3, "", [["p", merchant]]),
  sign(10002, "", [["r", TEST_RELAY_URL]]),
  sign(10050, "", [["relay", TEST_RELAY_URL]]),
  sign(30402, "Public fixture", [
    ["d", "reader-fixture"],
    ["title", title],
    ["price", "1", "SATS"],
    ["type", "simple", "digital"],
    ["visibility", "on-sale"],
    ["stock", "10"],
    ["image", "https://blossom.conduit.market/reader-fixture.png"],
  ]),
]

for (const app of ["market", "merchant"] as const) {
  test(`plain public reader paints catalog and discovers Network @${app}`, async ({
    page,
  }) => {
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    const origin = `http://127.0.0.1:${port}`
    let sockets = 0,
      requests = 0,
      completions = 0
    const kinds: Record<string, number> = {}
    await page.routeWebSocket(/.*/, (socket) => {
      if (socket.url().startsWith(origin.replace("http", "ws"))) {
        socket.connectToServer()
        return
      }
      sockets += 1
      socket.onMessage((payload) => {
        const parsed = JSON.parse(String(payload))
        if (!Array.isArray(parsed)) return
        const [type, id, ...filters] = parsed
        if (type !== "REQ") return
        requests += 1
        for (const filter of filters as Filter[])
          for (const kind of filter.kinds ?? [])
            kinds[kind] = (kinds[kind] ?? 0) + 1
        setTimeout(() => {
          for (const event of fixture.filter((event) =>
            filters.some((filter: Filter) => matchFilter(filter, event))
          ))
            socket.send(JSON.stringify(["EVENT", id, event]))
          socket.send(JSON.stringify(["EOSE", id]))
          completions += 1
        }, 15)
      })
    })
    await page.route("https://blossom.conduit.market/**", (route) =>
      route.abort()
    )
    await installTestSigner(page, merchant, { secretKey: key })
    const started = Date.now()
    await page.goto(`${origin}/products`)
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible({
      timeout: 15000,
    })
    const usefulPaintMs = Date.now() - started
    await page.goto(`${origin}/network`)
    await expect(
      page.getByRole("heading", { name: "Network", exact: true })
    ).toBeVisible()
    await expect(
      page.getByText("Your Relays", { exact: true }).first()
    ).toBeVisible()
    await expect.poll(() => kinds[10002] ?? 0).toBeGreaterThan(0)
    await expect.poll(() => kinds[0] ?? 0).toBeGreaterThan(0)
    await expect.poll(() => completions).toBe(requests)
    console.log(
      JSON.stringify({
        publicReaderObservation: app,
        usefulPaintMs,
        completionMs: Date.now() - started,
        sockets,
        requests,
        completions,
        kinds,
      })
    )
  })
}
