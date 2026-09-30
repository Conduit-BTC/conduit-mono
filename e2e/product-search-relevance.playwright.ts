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
  createdAt: number
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
        ["t", "art"],
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

async function controlledSearch(page: Page) {
  const requests: Filter[] = []
  const closed: string[] = []
  const state = { unavailable: false, holdRevisions: false }
  const pendingRevisions: Array<() => void> = []
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
          : [follows, ...profiles, best, second, browse, obsolete]
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
      else emit()
    })
  })
  return {
    requests,
    closed,
    state,
    pendingRevisions,
    releaseRevisions() {
      state.holdRevisions = false
      pendingRevisions.splice(0).forEach((emit) => emit())
    },
  }
}

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
  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
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
  await page
    .getByRole("combobox", {
      name: "Search products, categories, merchants, and accounts",
    })
    .fill("mug")
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
  await page
    .getByRole("combobox", {
      name: "Search products, categories, merchants, and accounts",
    })
    .fill("capped")
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
