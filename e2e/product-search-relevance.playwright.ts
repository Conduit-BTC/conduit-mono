import { expect, test, type Page } from "@playwright/test"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools/pure"
import { installTestSigner } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const merchantKeys = [generateSecretKey(), generateSecretKey()]
const merchants = merchantKeys.map(getPublicKey)
const now = Math.floor(Date.now() / 1000)
const listing = (
  key: Uint8Array,
  d: string,
  title: string,
  createdAt: number,
  category = "art"
) =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: "A public fixture listing",
      tags: [
        ["d", d],
        ["title", title],
        ["price", "1", "SATS"],
        ["type", "simple", "digital"],
        ["visibility", "public"],
        ["stock", "10"],
        ["t", category],
        ["image", "https://blossom.conduit.market/search-fixture.png"],
      ],
    },
    key
  )
const best = listing(merchantKeys[0], "best", "Handmade mug", now - 300)
const second = listing(merchantKeys[1], "second", "Clay bowl", now - 100)
const browse = listing(merchantKeys[0], "browse", "Cotton tote", now)
const obsolete = listing(merchantKeys[0], "obsolete", "Obsolete match", now)
const outsideScopeKey = generateSecretKey()
const cappedHits = Array.from({ length: 100 }, (_, index) =>
  listing(outsideScopeKey, `outside-${index}`, `Outside listing ${index}`, now)
)
const follows = finalizeEvent(
  {
    kind: 3,
    created_at: now,
    tags: merchants.map((pubkey) => ["p", pubkey]),
    content: "",
  },
  ownerKey
)
const profiles = merchantKeys.map((key, index) =>
  finalizeEvent(
    {
      kind: 0,
      created_at: now,
      tags: [],
      content: JSON.stringify({ name: `Fixture merchant ${index + 1}` }),
    },
    key
  )
)

function searchBox(page: Page) {
  return page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
}

function broadCatalogRequests(requests: Filter[]) {
  return requests.filter(
    (filter) =>
      !filter.search &&
      filter.kinds?.includes(30402) &&
      !filter["#d"] &&
      !filter.ids
  )
}

async function controlledSearch(page: Page) {
  const requests: Filter[] = []
  const closed: string[] = []
  const catalogIds: string[] = []
  const state = {
    unavailable: false,
    holdRevisions: false,
    holdFollows: false,
    followsUnavailable: false,
    throttled: false,
    catalogProducts: [best, second, browse, obsolete],
  }
  const pendingRevisions: Array<() => void> = []
  const pendingFollows: Array<() => void> = []
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((payload) => {
      const frame = JSON.parse(String(payload))
      if (!Array.isArray(frame)) return
      const [type, id, filter] = frame
      if (type === "CLOSE") {
        closed.push(id)
        return
      }
      if (type !== "REQ") return
      requests.push(filter)
      if (filter.kinds?.includes(30402)) catalogIds.push(id)
      if (filter.kinds?.includes(3) && state.followsUnavailable) {
        socket.send(
          JSON.stringify(["CLOSED", id, "error: fixture unavailable"])
        )
        return
      }
      if (filter.search && filter.kinds?.includes(30402) && state.throttled) {
        socket.send(
          JSON.stringify(["NOTICE", "rate limited: fixture requests"])
        )
        return
      }
      if (filter.search && filter.kinds?.includes(30402) && state.unavailable) {
        socket.send(
          JSON.stringify(["CLOSED", id, "error: fixture unavailable"])
        )
        return
      }
      const events: Event[] =
        filter.search && filter.kinds?.includes(30402)
          ? filter.search === "empty"
            ? []
            : filter.search === "capped"
              ? cappedHits
              : filter.search === "obsolete"
                ? [obsolete]
                : [best, second]
          : [follows, ...profiles, ...state.catalogProducts]
      const emit = () => {
        for (const event of events
          .filter((event) => matchFilter(filter, event))
          .slice(0, filter.limit)) {
          socket.send(JSON.stringify(["EVENT", id, event]))
        }
        socket.send(JSON.stringify(["EOSE", id]))
      }
      if (filter.search === "obsolete") setTimeout(emit, 1200)
      else if (
        !filter.search &&
        filter.kinds?.includes(30402) &&
        state.holdRevisions
      )
        pendingRevisions.push(emit)
      else if (filter.kinds?.includes(3) && state.holdFollows)
        pendingFollows.push(emit)
      else emit()
    })
  })
  return {
    requests,
    closed,
    catalogIds,
    state,
    pendingRevisions,
    pendingFollows,
    releaseFollows() {
      state.holdFollows = false
      pendingFollows.splice(0).forEach((emit) => emit())
    },
    releaseRevisions() {
      state.holdRevisions = false
      pendingRevisions.splice(0).forEach((emit) => emit())
    },
  }
}

test("one-character local search waits for its initial catalog scope @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.holdFollows = true
  await page.goto(`${marketUrl}/products?source=following&q=p`)
  await expect.poll(() => relay.pendingFollows.length).toBeGreaterThan(0)
  const empty = page.getByText("No cached products match this search.")
  await expect(empty).toBeHidden()
  relay.releaseFollows()
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await expect(empty).toBeHidden()
  expect(
    relay.requests.filter((filter) => filter.kinds?.includes(30402))
  ).toHaveLength(0)
})

test("one-character Refresh retries unavailable author discovery without product reads @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.followsUnavailable = true
  await page.goto(`${marketUrl}/products?source=following&q=p`)
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await expect(
    page.getByText("No cached products match this search.")
  ).toBeHidden()
  expect(relay.catalogIds).toHaveLength(0)
  const failedDiscoveryRequests = relay.requests.filter((filter) =>
    filter.kinds?.includes(3)
  ).length
  relay.state.followsUnavailable = false
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect
    .poll(
      () => relay.requests.filter((filter) => filter.kinds?.includes(3)).length
    )
    .toBeGreaterThan(failedDiscoveryRequests)
  expect(relay.catalogIds).toHaveLength(0)
})

test("one-character header retry recovers author discovery without product or profile search reads @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.followsUnavailable = true
  await page.goto(`${marketUrl}/products?source=following&q=p`)
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await searchBox(page).fill("P")
  const retry = page.getByRole("button", { name: "Try again", exact: true })
  await expect(retry).toBeVisible()
  const failedDiscoveryRequests = relay.requests.filter((filter) =>
    filter.kinds?.includes(3)
  ).length
  relay.state.followsUnavailable = false
  await retry.click()
  await expect
    .poll(
      () => relay.requests.filter((filter) => filter.kinds?.includes(3)).length
    )
    .toBeGreaterThan(failedDiscoveryRequests)
  expect(relay.catalogIds).toHaveLength(0)
  expect(relay.requests.filter((filter) => filter.search)).toHaveLength(0)
})

test("one-character Refresh recovers a failed cache read without product reads @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  await page.addInitScript(() => {
    const recovery = { unavailable: true, reads: 0 }
    Object.assign(window, { __productCacheRecovery: recovery })
    for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
      for (const method of ["getAll", "openCursor"] as const) {
        const original = prototype[method]
        Object.defineProperty(prototype, method, {
          configurable: true,
          value: function (
            this: IDBObjectStore | IDBIndex,
            ...args: unknown[]
          ) {
            const store = this instanceof IDBIndex ? this.objectStore : this
            if (store.name === "products") {
              recovery.reads++
              if (recovery.unavailable)
                throw new DOMException(
                  "Fixture cache unavailable",
                  "UnknownError"
                )
            }
            return Reflect.apply(original, this, args)
          },
        })
      }
    }
  })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/products?source=following&q=p`)
  await expect(
    page.getByText("Search is unavailable. Retry to check again.")
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText("No cached products match this search.")
  ).toBeHidden()
  expect(relay.catalogIds).toHaveLength(0)
  const failedReads = await page.evaluate(() => {
    const recovery = (
      window as Window & {
        __productCacheRecovery: { unavailable: boolean; reads: number }
      }
    ).__productCacheRecovery
    recovery.unavailable = false
    return recovery.reads
  })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(
    page.getByText("Search is unavailable. Retry to check again.")
  ).toBeHidden()
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __productCacheRecovery: { reads: number }
          }
        ).__productCacheRecovery.reads
    )
  ).toBeGreaterThan(failedReads)
  expect(relay.catalogIds).toHaveLength(0)
})

test("a cold cart header discovers categories once after a settled eligible query @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/cart`)
  const catalogs = () =>
    relay.requests.filter((filter) => filter.kinds?.includes(30402))
  const input = searchBox(page)
  await input.fill("a")
  await page.waitForTimeout(400)
  expect(catalogs()).toHaveLength(0)
  await input.fill("ar")
  await page.waitForTimeout(100)
  expect(catalogs()).toHaveLength(0)
  await expect(
    page.getByRole("option", { name: /^# art Browse category$/i })
  ).toBeVisible()
  const firstCatalogs = catalogs().length
  expect(firstCatalogs).toBeGreaterThan(0)
  // The core caps signed-event overfetch at six times the visible limit.
  expect(catalogs().every((filter) => filter.limit <= 600)).toBe(true)
  await input.fill("art")
  await page.waitForTimeout(500)
  expect(catalogs()).toHaveLength(firstCatalogs)
})

test("a warm partial cache does not suppress cart header category discovery @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  const cached = listing(
    merchantKeys[0],
    "cached",
    "Cached cloth",
    now,
    "textiles"
  )
  relay.state.catalogProducts = [cached]
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(
    page.getByRole("heading", { name: "Cached cloth", exact: true })
  ).toBeVisible()
  await page.goto(`${marketUrl}/cart?source=following`)
  const catalogs = () => broadCatalogRequests(relay.requests)
  const previousCatalogs = catalogs().length
  relay.state.catalogProducts = [best, second]
  const input = searchBox(page)
  await input.fill("ar")
  await expect(
    page.getByRole("option", { name: /^# art Browse category$/i })
  ).toBeVisible()
  expect(catalogs().length).toBeGreaterThan(previousCatalogs)
  const firstCatalogs = catalogs().length
  await input.fill("te")
  await expect(
    page.getByRole("option", { name: /^# textiles Browse category$/i })
  ).toBeVisible()
  await page.waitForTimeout(500)
  expect(catalogs()).toHaveLength(firstCatalogs)
})

test("a cold Products search header discovers categories without a page catalog @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  // Ranked search cannot hydrate the local catalog in this case.
  relay.state.unavailable = true
  await page.goto(`${marketUrl}/products?source=following&q=ar`)
  await expect
    .poll(() => relay.requests.filter((filter) => filter.search).length)
    .toBeGreaterThan(0)
  const catalogs = () => broadCatalogRequests(relay.requests)
  expect(catalogs()).toHaveLength(0)
  const input = searchBox(page)
  await input.fill("art")
  await page.waitForTimeout(100)
  expect(catalogs()).toHaveLength(0)
  await expect(
    page.getByRole("option", { name: /^# art Browse category$/i })
  ).toBeVisible()
  const firstCatalogs = catalogs().length
  expect(firstCatalogs).toBeGreaterThan(0)
  expect(catalogs().every((filter) => filter.limit <= 600)).toBe(true)
  await input.fill("ar")
  await page.waitForTimeout(500)
  expect(catalogs()).toHaveLength(firstCatalogs)
})

test("a pending header fallback survives text edits and cancels when suggestions close @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.holdRevisions = true
  await page.goto(`${marketUrl}/cart`)
  const input = searchBox(page)
  await input.fill("ar")
  await expect.poll(() => relay.pendingRevisions.length).toBeGreaterThan(0)
  const initialCatalogs = relay.catalogIds.length
  await input.fill("art")
  await page.waitForTimeout(500)
  expect(relay.catalogIds).toHaveLength(initialCatalogs)
  await page.getByRole("heading", { name: "Your cart is empty" }).click()
  await expect
    .poll(() => relay.catalogIds.every((id) => relay.closed.includes(id)))
    .toBe(true)
  relay.releaseRevisions()
})

test("header retry waits for its author scope before catalog discovery @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.holdFollows = true
  await page.goto(`${marketUrl}/cart?source=following`)
  await searchBox(page).fill("ar")
  await expect.poll(() => relay.pendingFollows.length).toBeGreaterThan(0)
  await page.waitForTimeout(400)
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await page.waitForTimeout(100)
  expect(
    relay.requests.filter((filter) => filter.kinds?.includes(30402))
  ).toHaveLength(0)
  relay.releaseFollows()
  await expect(
    page.getByRole("option", { name: /^# art Browse category$/i })
  ).toBeVisible()
})

for (const catalogRoute of ["products", "merchants"]) {
  test(`header categories update from a delayed ${catalogRoute} catalog without a duplicate stream @market`, async ({
    page,
  }) => {
    await installTestSigner(page, owner, { secretKey: ownerKey })
    const relay = await controlledSearch(page)
    relay.state.holdRevisions = true
    await page.goto(`${marketUrl}/${catalogRoute}?source=following`)
    await expect.poll(() => relay.pendingRevisions.length).toBeGreaterThan(0)
    const catalogs = () => broadCatalogRequests(relay.requests)
    const initialCatalogs = catalogs().length
    await searchBox(page).fill("ar")
    await page.waitForTimeout(500)
    expect(catalogs()).toHaveLength(initialCatalogs)
    relay.releaseRevisions()
    await expect(
      page.getByRole("option", { name: /^# art Browse category$/i })
    ).toBeVisible()
  })
}

test("header category discovery reuses a populated cart's catalog read @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  await page.addInitScript(
    (seed) => localStorage.setItem("conduit:cart", JSON.stringify(seed)),
    {
      version: 2,
      items: [
        {
          productId: `30402:${best.pubkey}:best`,
          productEventId: best.id,
          merchantPubkey: best.pubkey,
          merchantAddedAt: now,
          title: "Handmade mug",
          price: 1,
          currency: "SATS",
          priceSats: 1,
          format: "digital",
          quantity: 1,
        },
      ],
    }
  )
  const relay = await controlledSearch(page)
  relay.state.holdRevisions = true
  await page.goto(`${marketUrl}/cart`)
  const catalogs = () => broadCatalogRequests(relay.requests)
  await expect.poll(() => catalogs().length).toBeGreaterThan(0)
  const initialCatalogs = catalogs().length
  await searchBox(page).fill("ar")
  await page.waitForTimeout(500)
  expect(catalogs()).toHaveLength(initialCatalogs)
  relay.releaseRevisions()
  await expect(
    page.getByRole("option", { name: /^# art Browse category$/i })
  ).toBeVisible()
})

test("typing waits for a stable two-character query before remote search @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(page.getByText("Cotton tote", { exact: true })).toBeVisible()
  const input = searchBox(page)
  const searches = () =>
    relay.requests.filter(
      (filter) => filter.search && filter.kinds?.includes(30402)
    )
  await input.fill("p")
  await expect(
    page.getByText("Enter at least two characters for live search.")
  ).toBeVisible()
  expect(searches()).toHaveLength(0)
  for (const term of ["po", "pot", "pottery"]) {
    await input.fill(term)
    await page.waitForTimeout(75)
    expect(searches()).toHaveLength(0)
  }
  await expect(page.locator("main h3")).toHaveText([
    "Handmade mug",
    "Clay bowl",
  ])
  expect(searches().map((filter) => filter.search)).toEqual(["pottery"])
})

test("a throttled search pauses explicit retry and preserves prior ranked results @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/products?source=following&q=pottery`)
  const titles = page.locator("main h3")
  await expect(titles).toHaveText(["Handmade mug", "Clay bowl"])
  relay.state.throttled = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(
    page.getByText(
      "Search is unavailable. Showing previous matches for this search."
    )
  ).toBeVisible()
  const requestsAfterThrottle = relay.requests.length
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  await page.waitForTimeout(1200)
  expect(relay.requests).toHaveLength(requestsAfterThrottle)
  await expect(titles).toHaveText(["Handmade mug", "Clay bowl"])
})

test("ranked search renders semantic matches, cancels old queries, retains exact-query results and restores browse @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(
    `${marketUrl}/products?source=following&q=pottery&sort=price_desc`
  )
  await expect(page.getByText("Best match", { exact: true })).toBeVisible()
  const titles = page.locator("main h3")
  await expect(titles).toHaveText(["Handmade mug", "Clay bowl"])
  await expect(page.getByRole("button", { name: /Sort:/ })).toHaveCount(0)
  const searches = () =>
    relay.requests.filter(
      (filter) => filter.search && filter.kinds?.includes(30402)
    )
  expect(searches().at(-1)).toEqual({
    kinds: [30402],
    search: "pottery",
    limit: 100,
  })
  expect(
    relay.requests
      .filter((filter) => filter.kinds?.includes(30402) && !filter.search)
      .every((filter) => filter["#d"])
  ).toBe(true)

  const beforeRefresh = relay.requests.length
  relay.state.unavailable = true
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(
    page.getByText(
      "Search is unavailable. Showing previous matches for this search."
    )
  ).toBeVisible({ timeout: 15000 })
  await expect(titles).toHaveText(["Handmade mug", "Clay bowl"])
  expect(
    relay.requests
      .slice(beforeRefresh)
      .filter((filter) => filter.kinds?.includes(30402) && !filter.search)
      .every((filter) => filter["#d"] || filter.ids)
  ).toBe(true)
  relay.state.unavailable = false
  const input = searchBox(page)
  await input.fill("obsolete")
  await expect
    .poll(() => searches().some((filter) => filter.search === "obsolete"))
    .toBe(true)
  const closeCount = relay.closed.length
  await input.fill("pottery")
  await expect(titles).toHaveText(["Handmade mug", "Clay bowl"])
  await expect.poll(() => relay.closed.length).toBeGreaterThan(closeCount)
  await page.waitForTimeout(1300)
  await expect(page.getByText("Obsolete match", { exact: true })).toHaveCount(0)
  await input.fill("empty")
  await expect(titles).toHaveCount(0)
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No matching products found in this Market view.")
  ).toHaveCount(0)
  await input.fill("")
  await expect(page.getByRole("button", { name: /Sort:/ })).toBeVisible()
  await expect(page.getByText("Cotton tote", { exact: true })).toBeVisible()
  await expect(page.getByText("Best match", { exact: true })).toHaveCount(0)
  const beforeBrowseRefresh = relay.requests.length
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeBrowseRefresh)
        .some(
          (filter) =>
            filter.kinds?.includes(30402) &&
            !filter.search &&
            !filter["#d"] &&
            !filter.ids
        )
    )
    .toBe(true)
})

for (const perspective of [
  "guest",
  "following",
  "conduit",
  "combined",
] as const) {
  test(`product search filters the ${perspective} whitelist after a plain NIP-50 request @market`, async ({
    page,
  }) => {
    if (perspective !== "guest")
      await installTestSigner(page, owner, { secretKey: ownerKey })
    const relay = await controlledSearch(page)
    const source = perspective === "guest" ? "conduit" : perspective
    await page.goto(`${marketUrl}/products?source=${source}&q=pottery`)
    await expect
      .poll(
        () =>
          relay.requests.filter(
            (filter) =>
              filter.search === "pottery" && filter.kinds?.includes(30402)
          ).length
      )
      .toBeGreaterThan(0)
    const request = relay.requests
      .filter(
        (filter) => filter.search === "pottery" && filter.kinds?.includes(30402)
      )
      .at(-1)!
    expect(request).toEqual({ kinds: [30402], search: "pottery", limit: 100 })
    await expect(page.getByText("Best match", { exact: true })).toBeVisible()
    await expect(page.locator("main h3")).toHaveText(
      perspective === "following" || perspective === "combined"
        ? ["Handmade mug", "Clay bowl"]
        : []
    )
  })
}

test("ranked cards render before lazy revision reads complete @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  relay.state.holdRevisions = true
  await page.goto(`${marketUrl}/products?source=following&q=pottery`)
  await expect(page.locator("main h3")).toHaveText([
    "Handmade mug",
    "Clay bowl",
  ])
  await expect(page.getByText("Best match", { exact: true })).toBeVisible()
  await expect.poll(() => relay.pendingRevisions.length).toBeGreaterThan(0)
  relay.releaseRevisions()
  await expect(page.locator("main h3")).toHaveText([
    "Handmade mug",
    "Clay bowl",
  ])
})

test("cached text matches stay labeled during an unavailable live search @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(page.getByText("Handmade mug", { exact: true })).toBeVisible()
  relay.state.unavailable = true
  await searchBox(page).fill("mug")
  await expect(page.getByText("Cached matches", { exact: true })).toBeVisible()
  await expect(page.locator("main h3")).toHaveText(["Handmade mug"])
  await expect(
    page.getByText(
      "Showing cached text matches while live search is unavailable or loading."
    )
  ).toBeVisible()
  relay.state.unavailable = false
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByText("Best match", { exact: true })).toBeVisible()
  await expect(page.locator("main h3")).toHaveText([
    "Handmade mug",
    "Clay bowl",
  ])
})

test("search Refresh avoids broad catalog reads and capped empty results offer recovery @market", async ({
  page,
}) => {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  const relay = await controlledSearch(page)
  await page.goto(`${marketUrl}/products?source=following&q=pottery`)
  await expect(page.locator("main h3")).toHaveText([
    "Handmade mug",
    "Clay bowl",
  ])
  const beforeRefresh = relay.requests.length
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRefresh)
        .some(
          (filter) =>
            filter.kinds?.includes(30402) && filter.search === "pottery"
        )
    )
    .toBe(true)
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true })
  ).toBeEnabled()
  expect(
    relay.requests
      .slice(beforeRefresh)
      .filter((filter) => filter.kinds?.includes(30402) && !filter.search)
      .every((filter) => filter["#d"] || filter.ids)
  ).toBe(true)
  await searchBox(page).fill("capped")
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await expect(page.locator("main h3")).toHaveCount(0)
  await expect(
    page.getByText("No matching products found in this Market view.")
  ).toHaveCount(0)
  const beforeRetry = relay.requests.length
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRetry)
        .some(
          (filter) =>
            filter.search === "capped" && filter.kinds?.includes(30402)
        )
    )
    .toBe(true)
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toBeEnabled()
  expect(
    relay.requests
      .slice(beforeRetry)
      .filter((filter) => filter.kinds?.includes(30402) && !filter.search)
      .every((filter) => filter["#d"] || filter.ids)
  ).toBe(true)
})
