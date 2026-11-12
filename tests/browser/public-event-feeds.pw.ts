import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { matchFilter, type Filter } from "nostr-tools"
import type { PublicEventFeedFixtures } from "./public-event-feeds-app"

type Mode = "healthy" | "partial" | "outage"
type Traffic = {
  mode: Mode
  infrastructureSockets: number
  sockets: string[]
  deniedHttp: string[]
  requests: { url: string; filter: Filter }[]
  fixtures?: PublicEventFeedFixtures
}
const byContext = new WeakMap<BrowserContext, Traffic>()
const destination = (url: URL) =>
  `${url.origin}${url.pathname}`.replace(/\/$/, "")
test.setTimeout(120_000)
// Playwright traces would retain raw infrastructure URLs including HMR tokens.
test.use({ trace: "off" })
test.beforeEach(async ({ context }) => {
  const traffic: Traffic = {
    mode: "healthy",
    infrastructureSockets: 0,
    sockets: [],
    deniedHttp: [],
    requests: [],
  }
  byContext.set(context, traffic)
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === "http://127.0.0.1:4318") return route.continue()
    traffic.deniedHttp.push(destination(url))
    return route.abort("blockedbyclient")
  })
  // Every socket is fulfilled here. Never connectToServer, including controls.
  await context.routeWebSocket(/.*/, (socket) => {
    const parsed = new URL(socket.url())
    if (parsed.origin === "ws://127.0.0.1:4318" && parsed.pathname === "/") {
      traffic.infrastructureSockets++
      socket.close()
      return
    }
    const url = destination(parsed)
    traffic.sockets.push(url)
    const fixture = traffic.fixtures
    if (
      !fixture ||
      ![
        ...fixture.configured,
        ...fixture.hints,
        fixture.outsideFallback,
      ].includes(url)
    ) {
      socket.close()
      return
    }
    if (
      traffic.mode === "outage" ||
      (traffic.mode === "partial" && url === fixture.configured[1])
    ) {
      socket.close({ code: 1011, reason: "Synthetic outage" })
      return
    }
    socket.onMessage((message) => {
      const frame: unknown = JSON.parse(String(message))
      if (
        !Array.isArray(frame) ||
        frame[0] !== "REQ" ||
        typeof frame[1] !== "string"
      )
        return
      const returned = new Map<
        string,
        PublicEventFeedFixtures["publicEvents"][number]
      >()
      for (const filter of frame.slice(2) as Filter[]) {
        traffic.requests.push({ url, filter })
        const events = fixture.configured.includes(url)
          ? fixture.publicEvents
          : fixture.authorityEvents
        const matches = events
          .filter((event) => matchFilter(filter, event))
          .sort(
            (left, right) =>
              right.created_at - left.created_at ||
              left.id.localeCompare(right.id)
          )
        for (const event of matches.slice(0, filter.limit ?? matches.length))
          returned.set(event.id, event)
      }
      for (const event of returned.values())
        socket.send(JSON.stringify(["EVENT", frame[1], event]))
      socket.send(JSON.stringify(["EOSE", frame[1]]))
    })
  })
})
async function open(page: Page, context: BrowserContext) {
  await page.goto("/public-event-feeds.html")
  await expect(page.locator("#status")).toHaveText("Ready", { timeout: 30_000 })
  const traffic = byContext.get(context)!
  traffic.fixtures = await page.evaluate(
    () => window.publicEventFeedHarness.fixtures
  )
  return traffic
}
async function run(page: Page, action: string) {
  await page.getByRole("button", { name: action, exact: true }).click()
  await expect(page.locator("#status")).toHaveText("Ready", { timeout: 90_000 })
  const result = JSON.parse(
    await page.locator("#result").innerText()
  ) as Record<string, unknown>
  expect(result.action).toBe(action)
  expect(result.error).toBeUndefined()
  return result
}
function expectConfiguredOnly(traffic: Traffic) {
  expect(traffic.deniedHttp).toEqual([])
  expect(traffic.sockets.length).toBeGreaterThan(0)
  expect(new Set(traffic.sockets).size).toBeLessThanOrEqual(
    traffic.fixtures!.configured.length
  )
  expect(
    traffic.sockets.every((url) => traffic.fixtures!.configured.includes(url))
  ).toBe(true)
  expect(
    traffic.requests.some(({ filter }) => filter.kinds?.includes(10002))
  ).toBe(false)
}

test("Event discovery continues and refreshes without following 120 advertised sources", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  expect(traffic.fixtures!.hints).toHaveLength(120)
  const initial = await run(page, "browse")
  expect(initial).toMatchObject({
    hasMore: true,
    removedState: "deleted",
    activeState: "closed",
    displayOnly: true,
  })
  expect(initial.pending).toBeGreaterThan(0)
  expect(initial.snapshots).toBeGreaterThan(0)
  const continued = await run(page, "continue")
  expect(continued.count).toBeGreaterThan(0)
  expect(continued.displayOnly).toBe(true)
  for (const name of initial.pendingNames as string[])
    expect(continued.names as string[]).toContain(name)
  const refreshed = await run(page, "refresh")
  expect(refreshed).toMatchObject({
    removedState: "deleted",
    activeState: "closed",
    displayOnly: true,
  })
  expectConfiguredOnly(traffic)
})

test("Event catalog and support preserve newer roster and revocation evidence on configured peers", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const catalog = await run(page, "catalog")
  expect(catalog).toMatchObject({
    marketState: "closed",
    schedule: "series",
    calendar: traffic.fixtures!.occurrence,
    productCount: 0,
    displayOnly: true,
  })
  const support = await run(page, "support")
  expect(support).toMatchObject({
    authorizationState: "revoked",
    actionable: false,
    writeReady: false,
    assignmentState: "active",
    profileComplete: false,
    schedule: "series",
  })
  const kinds = new Set(
    traffic.requests.flatMap(({ filter }) => filter.kinds ?? [])
  )
  for (const kind of [0, 5, 3841, 30402, 30409, 30410, 31922, 31924])
    expect(kinds.has(kind)).toBe(true)
  expectConfiguredOnly(traffic)
})

for (const mode of ["partial", "outage"] as const) {
  test(`Event ${mode} refresh and continuation retain negatives without broadening destinations`, async ({
    page,
    context,
  }) => {
    const traffic = await open(page, context)
    traffic.mode = mode
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run(page, "refresh")
      expect(result).toMatchObject({
        removedState: "deleted",
        activeState: "closed",
        displayOnly: true,
      })
      expect(result.coverage).not.toBe("complete")
      expect(result.hasMore).toBe(true)
      const continued = await run(page, "continue")
      expect(continued.coverage).not.toBe("complete")
      expect(continued.displayOnly).toBe(true)
    }
    const support = await run(page, "support")
    expect(support).toMatchObject({
      authorizationState: "revoked",
      actionable: false,
      writeReady: false,
      profileComplete: false,
    })
    expectConfiguredOnly(traffic)
  })
}

test("organizer action evidence still visits advertised peers and observes the current revoke", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const result = await run(page, "organizer action")
  expect(result).toMatchObject({
    state: "revoked",
    scope: "authority",
    actionable: false,
    writeReady: true,
  })
  expect(traffic.deniedHttp).toEqual([])
  expect(
    traffic.fixtures!.hints.every((url) => traffic.sockets.includes(url))
  ).toBe(true)
  expect(new Set(traffic.sockets).size).toBeGreaterThan(100)
})

test.afterEach(async ({ context }, testInfo) => {
  const traffic = byContext.get(context)!
  await testInfo.attach("destination-counts", {
    body: JSON.stringify(
      {
        configuredPeers: traffic.fixtures?.configured.length ?? 0,
        uniqueRelayDestinations: new Set(traffic.sockets).size,
        socketAttempts: traffic.sockets.length,
        infrastructureSockets: traffic.infrastructureSockets,
        deniedExternalHttp: traffic.deniedHttp.length,
      },
      null,
      2
    ),
    contentType: "application/json",
  })
})
