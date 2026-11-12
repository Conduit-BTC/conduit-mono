import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import type { Filter } from "nostr-tools"
import type { PublicFeedBrowserFixtures } from "./public-feeds-app"

type Mode = "healthy" | "partial" | "outage" | "rate-limited"
type WireEvent = PublicFeedBrowserFixtures["catalog"][number]
type Traffic = {
  infrastructureSockets: number
  sockets: string[]
  deniedHttp: string[]
  requests: { url: string; filter: Filter }[]
  fixtures?: PublicFeedBrowserFixtures
  mode: Mode
}
const trafficByContext = new WeakMap<BrowserContext, Traffic>()
test.use({ trace: "off" })

function matches(event: WireEvent, filter: Filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  for (const [tag, values] of Object.entries(filter)) {
    if (
      tag.startsWith("#") &&
      Array.isArray(values) &&
      !event.tags.some(
        (row) =>
          row[0] === tag.slice(1) && values.some((value) => value === row[1])
      )
    )
      return false
  }
  return true
}

test.beforeEach(async ({ context }) => {
  const traffic: Traffic = {
    infrastructureSockets: 0,
    sockets: [],
    deniedHttp: [],
    requests: [],
    mode: "healthy",
  }
  trafficByContext.set(context, traffic)
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === "http://127.0.0.1:4318") return route.continue()
    traffic.deniedHttp.push(url.href)
    return route.abort("blockedbyclient")
  })
  // Never connect to a server: every WebSocket is fulfilled in-process.
  await context.routeWebSocket(/.*/, (socket) => {
    const parsed = new URL(socket.url())
    // Vite injects its exact loopback HMR endpoint even with hmr:false.
    // Count/close this infrastructure connection separately from relay I/O.
    if (parsed.origin === "ws://127.0.0.1:4318" && parsed.pathname === "/") {
      traffic.infrastructureSockets++
      socket.close()
      return
    }
    const url = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "")
    traffic.sockets.push(url)
    const fixtures = traffic.fixtures
    if (
      !fixtures ||
      ![
        ...fixtures.configured,
        ...fixtures.hints,
        fixtures.outsideFallback,
        fixtures.outsideSearch,
      ].includes(url)
    ) {
      socket.close()
      return
    }
    const fails =
      traffic.mode === "outage" ||
      (traffic.mode === "partial" && url === fixtures.configured[1])
    if (fails) {
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
      const subscription = frame[1]
      if (traffic.mode === "rate-limited") {
        socket.send(
          JSON.stringify([
            "CLOSED",
            subscription,
            "rate-limited: synthetic fixture",
          ])
        )
        return
      }
      const returned = new Map<string, WireEvent>()
      for (const filter of frame.slice(2) as Filter[]) {
        traffic.requests.push({ url, filter })
        const publicPeer = fixtures.configured.includes(url)
        const catalog = publicPeer ? fixtures.catalog : fixtures.currentCatalog
        const profile = publicPeer ? fixtures.oldProfile : fixtures.profile
        const candidates =
          filter.search && filter.kinds?.includes(30402)
            ? fixtures.ranked
            : [
                ...catalog,
                ...fixtures.tombstones,
                profile,
                fixtures.relayList,
                fixtures.followList,
              ]
        const found = candidates.filter((event) => matches(event, filter))
        for (const event of found.slice(0, filter.limit ?? found.length))
          returned.set(event.id, event)
      }
      for (const event of returned.values())
        socket.send(JSON.stringify(["EVENT", subscription, event]))
      socket.send(JSON.stringify(["EOSE", subscription]))
    })
  })
})

async function open(page: Page, context: BrowserContext) {
  await page.goto("/public-feeds.html")
  await expect(page.locator("#status")).toHaveText("Ready")
  const traffic = trafficByContext.get(context)!
  traffic.fixtures = await page.evaluate(
    () => window.publicFeedHarness.fixtures
  )
  return traffic
}
async function run(page: Page, action: string) {
  await page.getByRole("button", { name: action, exact: true }).click()
  await expect(page.locator("#status")).toHaveText("Ready", { timeout: 30_000 })
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
  expect(
    new Set(traffic.sockets).size,
    JSON.stringify([...new Set(traffic.sockets)])
  ).toBeLessThanOrEqual(traffic.fixtures!.configured.length)
  expect(
    traffic.sockets.every((url) => traffic.fixtures!.configured.includes(url))
  ).toBe(true)
}

test("public browse refresh and increased-limit reads keep all actual destinations configured-only", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const initial = await run(page, "browse")
  expect(initial.snapshots).toBeGreaterThan(0)
  expect((initial.ids as string[]).length).toBe(2)
  await run(page, "refresh")
  const expanded = await run(page, "load more")
  expect((expanded.ids as string[]).length).toBe(6)
  expect(expanded.ids as string[]).not.toContain("removed")
  expect((expanded.prices as Record<string, number>).current).toBe(40)
  expectConfiguredOnly(traffic)
})

test("production Market guest hooks select the configured public scope on demand", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  expect(traffic.sockets).toEqual([])
  const result = await run(page, "public app hooks")
  expect(result).toMatchObject({
    authStatus: "disconnected",
    guest: true,
    hasSigner: false,
    hasAccount: false,
    productError: false,
    directoryConnected: false,
    directorySource: "conduit",
    directorySearchSettled: true,
    directorySearchEvidence: "absent_within_scope",
    sellerCount: 0,
  })
  expect(result.ids as string[]).not.toContain("removed")
  expect(result.prices).toMatchObject({ current: 40 })
  const fixtureAuthor = traffic.fixtures!.profile.pubkey
  // The merchant-selected production hook reads the disposable signed author.
  expect(
    traffic.requests.some(
      ({ filter }) =>
        filter.kinds?.includes(30402) && filter.authors?.includes(fixtureAuthor)
    )
  ).toBe(true)
  // The real guest directory independently uses its repository author scope.
  expect(
    traffic.requests.some(
      ({ filter }) =>
        filter.kinds?.includes(30402) &&
        !!filter.authors?.length &&
        !filter.authors.includes(fixtureAuthor)
    )
  ).toBe(true)
  expect(
    traffic.requests.some(
      ({ filter }) => filter.kinds?.includes(0) && filter.search === "Fixture"
    )
  ).toBe(true)
  expectConfiguredOnly(traffic)
})

test("ranked search hydrates current terms, family and deletion evidence without following advertised sources", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const result = await run(page, "search")
  expect(result.ids).toEqual(["family", "current"])
  expect(result.prices).toMatchObject({ current: 40 })
  expect(result.families).toMatchObject({ family: [{ id: "red", price: 40 }] })
  expect(result.searchRelays).toEqual(traffic.fixtures!.configured.slice(0, 1))
  const searches = traffic.requests.filter(
    ({ filter }) => !!filter.search && filter.kinds?.includes(30402)
  )
  expect(searches.map(({ url }) => url)).toEqual(
    traffic.fixtures!.configured.slice(0, 1)
  )
  expect(traffic.requests.some(({ filter }) => !!filter["#d"])).toBe(true)
  expect(
    traffic.requests.some(
      ({ filter }) => !!filter["#a"] && filter.kinds?.includes(30402)
    )
  ).toBe(true)
  expect(traffic.requests.some(({ filter }) => filter.kinds?.includes(5))).toBe(
    true
  )
  expectConfiguredOnly(traffic)
})

test("public storefront, linked variation detail and support profiles/follows/search remain configured-only", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const store = await run(page, "storefront")
  expect(store.ids as string[]).not.toContain("removed")
  expect(store.prices).toMatchObject({ current: 40 })
  const detail = await run(page, "detail")
  expect(detail.ids).toEqual(["family"])
  expect(detail.families).toEqual({ family: [{ id: "red", price: 40 }] })
  const support = await run(page, "support")
  expect(support).toMatchObject({
    profileComplete: false,
    retainedRevocation: true,
    followsObserved: true,
    followCount: 1,
    searchMatches: 1,
  })
  expect(traffic.requests.some(({ filter }) => filter.kinds?.includes(0))).toBe(
    true
  )
  expect(traffic.requests.some(({ filter }) => filter.kinds?.includes(3))).toBe(
    true
  )
  expectConfiguredOnly(traffic)
})

for (const mode of ["partial", "outage", "rate-limited"] as const) {
  test(`${mode} and repeated refresh preserve retained evidence without adding destinations`, async ({
    page,
    context,
  }) => {
    const traffic = await open(page, context)
    traffic.mode = mode
    for (let refresh = 0; refresh < 3; refresh++) {
      const result = await run(page, "refresh")
      expect(result.degraded).toBe(true)
      expect(result.ids as string[]).not.toContain("removed")
      expect(result.prices).toMatchObject({ current: 40 })
    }
    expectConfiguredOnly(traffic)
  })
}

test("generic exact and payment evidence still reach advertised author relays", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const exact = await run(page, "generic exact")
  expect(exact.liveEvidence).toBe(true)
  expect(exact.prices).toMatchObject({ current: 40 })
  await page.evaluate(() => window.publicFeedHarness.resetHealth())
  const profile = await run(page, "generic profile")
  expect(profile).toMatchObject({ readComplete: true, addressRevoked: true })
  expect(traffic.deniedHttp).toEqual([])
  expect(
    traffic.sockets.some((url) => traffic.fixtures!.hints.includes(url))
  ).toBe(true)
  expect(new Set(traffic.sockets).size).toBeGreaterThan(100)
})

test("real profile hooks keep public display and unrestricted evidence in separate in-flight queries", async ({
  page,
  context,
}) => {
  const traffic = await open(page, context)
  const result = await run(page, "hook scopes")
  expect(result).toMatchObject({
    displayComplete: false,
    evidenceComplete: true,
    preparationComplete: true,
    displayAddress: false,
    evidenceAddress: false,
    profileQueries: 3,
    searchMatches: 1,
  })
  expect(traffic.deniedHttp).toEqual([])
  expect(
    traffic.sockets.some((url) => traffic.fixtures!.hints.includes(url))
  ).toBe(true)
})

test.afterEach(async ({ context }, testInfo) => {
  const traffic = trafficByContext.get(context)!
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
