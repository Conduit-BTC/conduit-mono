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
const now = Math.floor(Date.now() / 1000)
const ownerKey = generateSecretKey()
const owner = getPublicKey(ownerKey)
const keys = Array.from({ length: 64 }, generateSecretKey)
const authors = keys.map(getPublicKey).sort()
const keyByAuthor = new Map(keys.map((key) => [getPublicKey(key), key]))
function listing(
  author: string,
  index: number,
  category = "art",
  timestamp = now - index,
  title = `Listing ${authors.indexOf(author)} item ${index}`
) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: timestamp,
      content: title,
      tags: [
        ["d", `item-${index}`],
        ["title", title],
        ["price", String(index + 1), "SATS"],
        ["type", "simple", "digital"],
        ["stock", "20"],
        ["t", category],
        ["image", "https://blossom.conduit.market/browse-fixture.png"],
      ],
    },
    keyByAuthor.get(author)!
  )
}
const listings = authors.flatMap((author) =>
  Array.from({ length: 24 }, (_, index) => listing(author, index))
)
const follows = finalizeEvent(
  {
    kind: 3,
    created_at: now,
    tags: authors.map((author) => ["p", author]),
    content: "",
  },
  ownerKey
)
const profiles = authors.map((author, index) =>
  finalizeEvent(
    {
      kind: 0,
      created_at: now,
      tags: [],
      content: JSON.stringify({ name: `Fixture Merchant ${index}` }),
    },
    keyByAuthor.get(author)!
  )
)

async function fixture(page: Page) {
  await installTestSigner(page, owner, { secretKey: ownerKey })
  await page.route(
    "https://blossom.conduit.market/browse-fixture.png",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
          "base64"
        ),
      })
  )
  const state = {
    events: [...listings],
    requests: [] as Filter[],
    delivered: 0,
    productBytes: 0,
    closed: 0,
    hold: false,
    pending: [] as Array<() => void>,
  }
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((payload) => {
      const frame = JSON.parse(String(payload))
      if (!Array.isArray(frame)) return
      const [type, id, filter] = frame
      if (type === "CLOSE") {
        state.closed++
        return
      }
      if (type !== "REQ") return
      state.requests.push(filter)
      const emit = () => {
        const selected = [follows, ...profiles, ...state.events]
          .filter((event) => matchFilter(filter, event as Event))
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
          )
        const search = filter.search
          ? selected.filter((event) =>
              event.content.toLowerCase().includes(filter.search.toLowerCase())
            )
          : selected
        for (const event of search.slice(0, filter.limit ?? search.length)) {
          if (event.kind === 30402) {
            state.delivered++
            state.productBytes += Buffer.byteLength(
              JSON.stringify(["EVENT", id, event])
            )
          }
          socket.send(JSON.stringify(["EVENT", id, event]))
        }
        socket.send(JSON.stringify(["EOSE", id]))
      }
      if (state.hold && !filter.search && filter.kinds?.includes(30402))
        state.pending.push(emit)
      else setTimeout(emit, 20)
    })
  })
  return state
}
const cards = (page: Page) =>
  page
    .getByRole("link")
    .filter({ has: page.getByRole("heading", { level: 3 }) })
const searchBox = (page: Page) =>
  page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })

async function search(page: Page, text: string) {
  await searchBox(page).fill(text)
  await searchBox(page).press("Enter")
}

test("bounded Discover retains selectors and reaches an older product, merchant, and category outside the sample @market", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(cards(page)).toHaveCount(24)
  const initialAuthors = new Set(
    state.requests
      .filter((filter) => filter.kinds?.includes(30402))
      .flatMap((filter) => filter.authors ?? [])
  )
  const outside = authors.find((author) => !initialAuthors.has(author))!
  expect(outside).toBeTruthy()
  const rare = listing(
    outside,
    100,
    "rare-category",
    now - 400 * 86400,
    "Longstanding rare offer"
  )
  state.events.push(rare)
  await expect(
    page.getByText("Longstanding rare offer", { exact: true })
  ).toHaveCount(0)
  // Known identities are separate metadata. The isolated loopback relay does
  // not enter the existing wss-only profile-search plan.
  await page.evaluate(
    ({ profiles, rare }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction(
            ["profiles", "products"],
            "readwrite"
          )
          for (const event of profiles)
            transaction.objectStore("profiles").put({
              pubkey: event.pubkey,
              name: JSON.parse(event.content).name,
              eventId: event.id,
              createdAt: event.created_at * 1000,
              cachedAt: Date.now(),
            })
          transaction.objectStore("products").put({
            id: `30402:${rare.pubkey}:item-100`,
            pubkey: rare.pubkey,
            title: "Longstanding rare offer",
            summary: "",
            price: 101,
            currency: "SATS",
            priceSats: 101,
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 20,
            images: [
              { url: "https://blossom.conduit.market/browse-fixture.png" },
            ],
            tags: ["rare-category"],
            eventId: rare.id,
            eventCreatedAt: rare.created_at,
            dTag: "item-100",
            createdAt: rare.created_at * 1000,
            updatedAt: rare.created_at * 1000,
            cachedAt: Date.now(),
          })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
      }),
    { profiles, rare }
  )
  await page.reload()
  await expect(cards(page)).toHaveCount(24)
  await expect(
    page.getByText("Longstanding rare offer", { exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "All categories", exact: true })
    .click()
  await expect(
    page.getByRole("menuitemcheckbox", { name: /rare-category/ })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await page
    .getByRole("combobox", { name: "All merchants", exact: true })
    .click()
  await page
    .getByRole("combobox", { name: "Search merchants" })
    .fill(`Fixture Merchant ${authors.indexOf(outside)}`)
  await page
    .getByRole("option", {
      name: new RegExp(`Fixture Merchant ${authors.indexOf(outside)}`),
    })
    .click()
  await page.keyboard.press("Escape")
  await expect
    .poll(() => new URL(page.url()).searchParams.has("merchant"))
    .toBe(true)
  await expect(cards(page)).toHaveCount(24)
  expect(
    state.requests.some(
      (filter) =>
        filter.authors?.length === 1 &&
        filter.authors[0] === outside &&
        filter.limit === 96 &&
        !filter.since
    )
  ).toBe(true)
  await search(page, "Longstanding")
  await expect(
    page.getByText("Longstanding rare offer", { exact: true })
  ).toBeVisible()
  const request = state.requests.findLast(
    (filter) => filter.search === "Longstanding"
  )!
  expect(request.authors).toEqual([outside])
  expect(request.since).toBeUndefined()
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Browse any category" })
    .fill("rare-category")
  await page.getByRole("button", { name: "Browse", exact: true }).click()
  await expect(
    page.getByText("Longstanding rare offer", { exact: true })
  ).toBeVisible()
  expect(
    state.requests.some(
      (filter) =>
        filter["#t"]?.includes("rare-category") &&
        filter.authors?.length === 64 &&
        !filter.since
    )
  ).toBe(true)
  await page.getByRole("button", { name: /Sort:/ }).click()
  await page
    .getByRole("menuitemcheckbox", { name: "Price: Low to High" })
    .click()
  await expect(
    page.getByText("Longstanding rare offer", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await page
    .getByRole("button", { name: "All categories", exact: true })
    .click()
  await expect(
    page.getByRole("menuitemcheckbox", { name: /rare-category/ })
  ).toBeVisible()
})

test("scopes combine and price sorting overrides relevance only when requested @market", async ({
  page,
}) => {
  const state = await fixture(page)
  const author = authors[0]
  state.events = [
    listing(author, 3, "clothing", now, "Canvas offer"),
    listing(author, 1, "clothing", now - 10, "Canvas inexpensive"),
    listing(authors[1], 0, "clothing", now, "Canvas other merchant"),
    listing(author, 0, "books", now, "Canvas wrong category"),
  ]
  await page.goto(
    `${marketUrl}/products?source=following&view=recent&tag=clothing&merchant=${author}&q=Canvas`
  )
  await expect(cards(page)).toHaveCount(2)
  await expect(
    page.getByRole("button", { name: /Sort: Relevance/ })
  ).toBeVisible()
  expect(
    state.requests
      .filter((filter) => filter.search)
      .every(
        (filter) =>
          filter.authors?.join() === author &&
          filter["#t"]?.join() === "clothing" &&
          !filter.since
      )
  ).toBe(true)
  await expect(
    page.getByText("Canvas other merchant", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText("Canvas wrong category", { exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: /Sort:/ }).click()
  await page
    .getByRole("menuitemcheckbox", { name: "Price: Low to High" })
    .click()
  await expect(cards(page).first()).toContainText("Canvas inexpensive")
  await page.getByRole("button", { name: /Sort:/ }).click()
  await page
    .getByRole("menuitemcheckbox", { name: "Price: High to Low" })
    .click()
  await expect(cards(page).first()).toContainText("Canvas offer")
})

test("recent revision activity has an explicit older option; facets and Explore all have no recency gate @market", async ({
  page,
}) => {
  const state = await fixture(page)
  state.events = [
    listing(authors[0], 0, "art", now, "Revised listing"),
    listing(authors[1], 1, "art", now - 90 * 86400, "Older listing"),
  ]
  await page.goto(`${marketUrl}/products?source=following&view=recent`)
  await expect(page.getByText("Revised listing", { exact: true })).toBeVisible()
  await expect(page.getByText("Older listing", { exact: true })).toHaveCount(0)
  expect(
    state.requests.some(
      (filter) => filter.kinds?.includes(30402) && !!filter.since
    )
  ).toBe(true)
  await page.getByRole("checkbox", { name: "Include older listings" }).check()
  await expect(
    page.getByText(
      "Listing publications and revisions, including older listings."
    )
  ).toBeVisible()
  await expect(page.getByText("Older listing", { exact: true })).toBeVisible()
  await page.getByRole("checkbox", { name: "Include older listings" }).uncheck()
  await page.getByRole("button", { name: "art", exact: true }).click()
  await expect(page.getByText("Older listing", { exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has("view")).toBe(false)
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await page.getByRole("tab", { name: "Explore all products" }).click()
  await expect(page.getByText("Older listing", { exact: true })).toBeVisible()
})

test("keyboard and mobile category browsing retains focus and avoids horizontal overflow @market", async ({
  page,
}) => {
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(cards(page)).toHaveCount(24)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: "context/category-products-mobile-discover.png",
    fullPage: false,
  })
  await page
    .getByRole("button", { name: "All categories", exact: true })
    .focus()
  await page.keyboard.press("Enter")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: "All categories", exact: true })
  ).toBeFocused()
  await page.getByRole("textbox", { name: "Browse any category" }).fill("art")
  await page
    .getByRole("textbox", { name: "Browse any category" })
    .press("Enter")
  await expect(page.getByRole("button", { name: /Sort:/ })).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: "context/category-products-mobile.png",
    fullPage: false,
  })
})

test("leaving Discover cancels pending candidate reads @market", async ({
  page,
}) => {
  const state = await fixture(page)
  state.hold = true
  await page.goto(`${marketUrl}/products?source=following`)
  await expect.poll(() => state.pending.length).toBeGreaterThan(0)
  const before = state.closed
  await search(page, "missing query")
  await expect.poll(() => state.closed).toBeGreaterThan(before)
  state.hold = false
  state.pending.splice(0).forEach((emit) => emit())
  await expect(
    page.getByText("Search results may be incomplete. Retry to check again.")
  ).toBeVisible()
  await expect(page.getByText("Listing 0 item 0", { exact: true })).toHaveCount(
    0
  )
})

test("scroll expands reads only after the prepared cards; keyboard fallback also works @market", async ({
  page,
}) => {
  const state = await fixture(page)
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(cards(page)).toHaveCount(24)
  const reads = () =>
    state.requests.filter((filter) => filter.kinds?.includes(30402)).length
  expect(reads()).toBe(12)
  for (const count of [48, 72]) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect(cards(page)).toHaveCount(count)
    await page.waitForTimeout(200)
    await expect(cards(page)).toHaveCount(count)
  }
  await expect.poll(reads).toBe(24)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect(cards(page)).toHaveCount(96)
  await expect.poll(reads).toBe(36)
  await page.waitForTimeout(200)
  await expect(cards(page)).toHaveCount(96)
  expect(reads()).toBe(36)
  await page.addInitScript(() =>
    Object.defineProperty(window, "IntersectionObserver", { value: undefined })
  )
  await page.reload()
  await expect(cards(page)).toHaveCount(24)
  const more = page.getByRole("button", { name: "Show more", exact: true })
  await more.focus()
  await page.keyboard.press("Enter")
  await expect(cards(page)).toHaveCount(48)
})

test("initial browse work and responsiveness benchmark @market", async ({
  page,
}) => {
  const state = await fixture(page)
  if (process.env.BROWSE_BENCHMARK_DISPLAY_CARDS === "24")
    await page.addInitScript(() =>
      Object.defineProperty(window, "IntersectionObserver", {
        value: undefined,
      })
    )
  await page.addInitScript(() => {
    const metrics = { longTasks: 0, longTaskMs: 0, maxFrameGapMs: 0 }
    Object.assign(window, { __browseMetrics: metrics })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        metrics.longTasks++
        metrics.longTaskMs += entry.duration
      }
    }).observe({ type: "longtask", buffered: true })
    let previous = 0
    const frame = (time: number) => {
      if (previous)
        metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, time - previous)
      previous = time
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  const started = Date.now()
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(cards(page).first()).toBeVisible({ timeout: 20000 })
  const firstCardMs = Date.now() - started
  if (
    process.env.BROWSE_BENCHMARK_DISPLAY_CARDS === "24" &&
    (await cards(page).count()) === 12
  ) {
    await page.getByRole("button", { name: "Show more", exact: true }).click()
    await expect(cards(page)).toHaveCount(24)
  }
  await page.waitForTimeout(2500)
  const metrics = await page.evaluate(
    () =>
      (window as Window & { __browseMetrics: Record<string, number> })
        .__browseMetrics
  )
  const productRequests = state.requests.filter((filter) =>
    filter.kinds?.includes(30402)
  )
  const report = {
    firstCardMs,
    ...metrics,
    productRequests: productRequests.length,
    deliveredCandidates: state.delivered,
    productBytes: state.productBytes,
    totalRequests: state.requests.length,
    displayCards: await cards(page).count(),
    authorsRead: new Set(
      productRequests.flatMap((filter) => filter.authors ?? [])
    ).size,
  }
  console.log(`BROWSE_BENCHMARK ${JSON.stringify(report)}`)
  await page.screenshot({
    path: "context/category-products-desktop.png",
    fullPage: false,
  })
})

test("global search reaches longstanding products outside Discover across the full eligible catalog @market", async ({
  page,
}) => {
  const state = await fixture(page)
  const rare = listing(
    authors[63],
    100,
    "rare-global",
    now - 400 * 86400,
    "Longstanding global offer"
  )
  state.events.push(rare)
  await page.goto(`${marketUrl}/products?source=following`)
  await expect(cards(page)).toHaveCount(24)
  await expect(
    page.getByText("Longstanding global offer", { exact: true })
  ).toHaveCount(0)
  await search(page, "Longstanding global")
  await expect(
    page.getByText("Longstanding global offer", { exact: true })
  ).toBeVisible()
  const request = state.requests.findLast(
    (filter) =>
      filter.search === "Longstanding global" && filter.kinds?.includes(30402)
  )!
  expect(new Set(request.authors)).toEqual(new Set(authors))
  expect(request.since).toBeUndefined()
  expect(request.until).toBeUndefined()
  await expect(
    page.getByRole("button", { name: "Sort: Relevance" })
  ).toBeVisible()
})
