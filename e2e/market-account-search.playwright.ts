import { expect, test, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { nip19, matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { installTestSigner } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
// Members of the repository-owned Market list. Keep these fixtures explicit so
// Playwright does not evaluate browser-only application modules in Node.
const SELLER_PUBKEY =
  "c4eabae1be3cf657bc1855ee05e69de9f059cb7a059227168b80b89761cbc4e0"
const ELIGIBLE_ACCOUNT_PUBKEY =
  "088436cd039ff89074468fd327facf62784eeb37490e0a118ab9f14c9d2646cc"
const UNLISTED_ACCOUNT_PUBKEY = "c".repeat(64)
const IMAGE_FIXTURE_MERCHANTS = (
  JSON.parse(
    readFileSync(
      new URL("../apps/market/src/data/market-merchants.json", import.meta.url),
      "utf8"
    )
  ) as string[]
).slice(0, 48)
const OFFSCREEN_MERCHANT_PUBKEY = IMAGE_FIXTURE_MERCHANTS.at(-1)!
const IMAGE_FIXTURE_BASE = "https://blossom.conduit.market/hydration-fixture"
const IMAGE_FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
)

async function seedAccounts(
  page: Page,
  sellerPubkey = SELLER_PUBKEY,
  productTitle = "Account search fixture"
): Promise<void> {
  await page.waitForLoadState("networkidle")
  await page.evaluate(
    ({
      sellerPubkey,
      productTitle,
      eligibleAccountPubkey,
      unlistedAccountPubkey,
    }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["profiles", "products"],
            "readwrite"
          )
          const timestamp = Date.now()
          const profiles = transaction.objectStore("profiles")
          profiles.put({
            pubkey: sellerPubkey,
            name: "alice",
            displayName: "Alice Storefront",
            cachedAt: timestamp,
          })
          profiles.put({
            pubkey: eligibleAccountPubkey,
            name: "alice",
            displayName: "Wonderland Account",
            cachedAt: timestamp,
          })
          profiles.put({
            pubkey: unlistedAccountPubkey,
            name: "alicia",
            displayName: "Alicia Reader",
            cachedAt: timestamp,
          })
          transaction.objectStore("products").put({
            id: `30402:${sellerPubkey}:account-search-fixture`,
            pubkey: sellerPubkey,
            title: productTitle,
            summary: "Seeded listing so the account is a merchant",
            price: 1,
            currency: "SATS",
            priceSats: 1,
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [
              { url: "https://blossom.conduit.market/account-search.png" },
            ],
            tags: ["art", "artisan goods"],
            eventId: "f".repeat(64),
            eventCreatedAt: 100,
            dTag: "account-search-fixture",
            createdAt: timestamp,
            updatedAt: timestamp,
            cachedAt: timestamp,
          })
          transaction.objectStore("products").put({
            id: `30402:${unlistedAccountPubkey}:hidden-category-fixture`,
            pubkey: unlistedAccountPubkey,
            title: "Hidden category fixture",
            summary: "Seeded outside the active Market author scope",
            price: 1,
            currency: "SATS",
            priceSats: 1,
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [
              { url: "https://blossom.conduit.market/hidden-category.png" },
            ],
            tags: ["hidden-category"],
            eventId: "e".repeat(64),
            eventCreatedAt: 100,
            dTag: "hidden-category-fixture",
            createdAt: timestamp,
            updatedAt: timestamp,
            cachedAt: timestamp,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      sellerPubkey,
      productTitle,
      eligibleAccountPubkey: ELIGIBLE_ACCOUNT_PUBKEY,
      unlistedAccountPubkey: UNLISTED_ACCOUNT_PUBKEY,
    }
  )
}

async function seedMerchantImageRows(
  page: Page,
  pubkeys = IMAGE_FIXTURE_MERCHANTS,
  cacheProfiles = true
): Promise<void> {
  await page.waitForLoadState("networkidle")
  await page.evaluate(
    ({ pubkeys, imageBase, cacheProfiles }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["profiles", "products"],
            "readwrite"
          )
          const timestamp = Date.now()
          const profiles = transaction.objectStore("profiles")
          const products = transaction.objectStore("products")
          pubkeys.forEach((pubkey, index) => {
            const fixtureId = `hydration-fixture-${index}`
            if (cacheProfiles)
              profiles.put({
                pubkey,
                name: `Fixture Merchant ${index}`,
                displayName: `Fixture Merchant ${index}`,
                picture: `${imageBase}-avatar-${index}.png`,
                banner: `${imageBase}-banner.png`,
                cachedAt: timestamp,
              })
            products.put({
              id: `30402:${pubkey}:${fixtureId}`,
              pubkey,
              title: `Hydration product ${index}`,
              summary: "Cached listing for image request coverage",
              price: 1,
              currency: "SATS",
              priceSats: 1,
              type: "simple",
              format: "digital",
              visibility: "public",
              stock: 1,
              images: [{ url: `${imageBase}-product.png` }],
              tags: ["art"],
              eventId: (index + 1).toString(16).padStart(64, "0"),
              eventCreatedAt: 100,
              dTag: fixtureId,
              createdAt: timestamp,
              updatedAt: timestamp,
              cachedAt: timestamp,
            })
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    { pubkeys, imageBase: IMAGE_FIXTURE_BASE, cacheProfiles }
  )
}

async function prepareScopedNameSearch(
  page: Page,
  mode: "complete" | "partial" | "unavailable"
) {
  const keys = Array.from({ length: 48 }, generateSecretKey).sort((a, b) =>
    getPublicKey(a).localeCompare(getPublicKey(b))
  )
  const pubkeys = keys.map(getPublicKey)
  const ownerKey = generateSecretKey()
  const owner = getPublicKey(ownerKey)
  const now = Math.floor(Date.now() / 1000)
  const follows = finalizeEvent(
    {
      kind: 3,
      created_at: now,
      content: "",
      tags: pubkeys.map((pubkey) => ["p", pubkey]),
    },
    ownerKey
  )
  const profiles = keys.map((key, index) =>
    finalizeEvent(
      {
        kind: 0,
        created_at: now,
        tags: [],
        content: JSON.stringify({
          name: index === 47 ? "Zebra Store" : `Alpha Merchant ${index}`,
        }),
      },
      key
    )
  )
  const requests: Filter[] = []
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((payload) => {
      const frame = JSON.parse(String(payload))
      if (frame[0] !== "REQ") return
      const filters = frame.slice(2) as Filter[]
      requests.push(...filters)
      const nameSearch = filters.some(
        (filter) => filter.search && filter.kinds?.includes(0)
      )
      if (nameSearch && mode === "unavailable") {
        socket.send(
          JSON.stringify([
            "CLOSED",
            frame[1],
            "error: fixture search unavailable",
          ])
        )
        return
      }
      if (nameSearch && mode === "partial") {
        // A rejected signature keeps even an EOSE answer incomplete.
        socket.send(
          JSON.stringify([
            "EVENT",
            frame[1],
            { ...profiles[0], sig: "0".repeat(128) },
          ])
        )
      } else if (!nameSearch) {
        for (const event of [follows, ...profiles]) {
          if (filters.some((filter) => matchFilter(filter, event))) {
            socket.send(JSON.stringify(["EVENT", frame[1], event]))
          }
        }
      }
      socket.send(JSON.stringify(["EOSE", frame[1]]))
    })
  })
  await installTestSigner(page, owner, { secretKey: ownerKey })
  // Seed display listings, but leave every profile to the staged signed read.
  await page.goto(`${marketUrl}/products?source=following`)
  await seedMerchantImageRows(page, pubkeys, false)
  return { pubkeys, requests }
}

async function enableFixtureNameSearch(page: Page, useSearchSocket = false) {
  // NIP-50 planning requires wss. Every socket is intercepted by this fixture;
  // the default isolated development relay uses ws and is not search eligible.
  const moduleUrl = `/@fs${fileURLToPath(new URL("../packages/core/src/config.ts", import.meta.url))}`
  await page.evaluate(
    async ({ moduleUrl, useSearchSocket }) => {
      const { config } = await import(moduleUrl)
      config.searchIndexRelayUrls = ["wss://merchant-search-fixture.example"]
      // The composed evidence tests must observe the same wss target they plan.
      // All WebSockets are intercepted; no external relay connection is opened.
      if (useSearchSocket) config.e2eRelayIsolationEnabled = false
    },
    { moduleUrl, useSearchSocket }
  )
}

for (const scenario of [
  { query: "z", mode: "complete" as const, description: "one-character query" },
  {
    query: "Zebra",
    mode: "unavailable" as const,
    description: "unavailable search with initially empty results",
  },
]) {
  test(`directory progressively checks an off-page name for ${scenario.description} @market`, async ({
    page,
  }) => {
    const { pubkeys, requests } = await prepareScopedNameSearch(
      page,
      scenario.mode
    )
    await page.goto(`${marketUrl}/merchants?source=following`)
    await enableFixtureNameSearch(page)
    await page
      .getByRole("textbox", { name: "Filter merchants" })
      .fill(scenario.query)
    const directory = page.locator(
      'section[aria-labelledby="discovered-merchants-heading"]'
    )
    const more = directory.getByRole("button", {
      name: "Check more merchant names",
    })
    await expect(directory).toContainText("0 of 0 merchants")
    await expect(directory).toContainText(
      "Merchant name results may be incomplete"
    )
    await expect(more).toBeVisible()
    if (process.env.FOLLOWUP_UI_EVIDENCE) {
      await page.screenshot({
        path: `${process.env.FOLLOWUP_UI_EVIDENCE}/directory-empty-${scenario.mode}.png`,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(more).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await page.screenshot({
        path: `${process.env.FOLLOWUP_UI_EVIDENCE}/directory-empty-${scenario.mode}-mobile.png`,
      })
      await page.setViewportSize({ width: 1280, height: 720 })
    }
    const exactProfiles = () =>
      requests.filter((filter) => filter.kinds?.includes(0) && !filter.search)
    expect(
      exactProfiles().flatMap((filter) => filter.authors ?? [])
    ).not.toContain(pubkeys[47])
    const catalogReads = requests.filter((filter) =>
      filter.kinds?.includes(30402)
    ).length
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      if (pageIndex === 0 && scenario.query.length === 1) {
        await more.focus()
        await more.press("Enter")
      } else {
        await more.click()
      }
    }
    await expect(
      directory.getByRole("link", { name: /Zebra Store/ })
    ).toBeVisible()
    await expect(more).toHaveCount(0)
    expect(
      new Set(
        exactProfiles()
          .flatMap((filter) => filter.authors ?? [])
          .filter((pubkey) => pubkeys.includes(pubkey))
      ).size
    ).toBe(48)
    expect(
      requests.filter((filter) => filter.kinds?.includes(30402)).length
    ).toBe(catalogReads)
    if (scenario.query.length === 1) {
      expect(
        requests.some(
          (filter) =>
            filter.search === scenario.query && filter.kinds?.includes(0)
        )
      ).toBe(false)
    } else {
      await expect(directory).toContainText("Search relays are unavailable")
    }
    if (process.env.FOLLOWUP_UI_EVIDENCE) {
      await page.screenshot({
        path: `${process.env.FOLLOWUP_UI_EVIDENCE}/directory-${scenario.mode}.png`,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(
        directory.getByRole("link", { name: /Zebra Store/ })
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await page.screenshot({
        path: `${process.env.FOLLOWUP_UI_EVIDENCE}/directory-${scenario.mode}-mobile.png`,
      })
    }
  })
}

for (const mode of ["complete", "partial", "unavailable"] as const) {
  test(`merchant name search distinguishes ${mode} empty evidence @market`, async ({
    page,
  }) => {
    const { requests } = await prepareScopedNameSearch(page, mode)
    await page.goto(`${marketUrl}/products?source=following`)
    await enableFixtureNameSearch(page, true)
    await page
      .getByRole("combobox", { name: "All merchants", exact: true })
      .click()
    const input = page.getByRole("combobox", {
      name: "Search merchants",
      exact: true,
    })
    await input.fill("no-such-name")
    const status = page.getByRole("status").filter({
      hasText:
        mode === "complete"
          ? "No matching merchant names found on the searched relays"
          : "Merchant name results may be incomplete",
    })
    await expect(status).toBeVisible()
    await expect
      .poll(
        () =>
          requests.filter(
            (filter) =>
              filter.search === "no-such-name" && filter.kinds?.includes(0)
          ).length
      )
      .toBeGreaterThan(0)
    if (mode === "partial")
      await expect(status).toHaveText(
        "Merchant name results may be incomplete."
      )
    if (mode === "unavailable")
      await expect(status).toContainText("Search relays are unavailable")
    if (mode === "complete")
      await expect(
        page.getByText(/Merchant name results may be incomplete/)
      ).toHaveCount(0)
    await page.keyboard.press("Escape")
    await page.goto(`${marketUrl}/merchants?source=following`)
    await enableFixtureNameSearch(page, true)
    await page
      .getByRole("textbox", { name: "Filter merchants" })
      .fill("no-such-name")
    const directory = page.locator(
      'section[aria-labelledby="discovered-merchants-heading"]'
    )
    await expect(directory).toContainText(
      mode === "complete"
        ? "No matching merchant names found on the searched relays"
        : "Merchant name results may be incomplete"
    )
    await expect(
      directory.getByRole("button", { name: "Check more merchant names" })
    ).toHaveCount(mode === "complete" ? 0 : 1)
    if (mode === "complete")
      await expect(directory).not.toContainText("may be incomplete")
  })
}

test("guest catalog uses the repository list despite legacy follows and relay failure @market", async ({
  page,
}) => {
  const addedMerchant =
    "005bc4de41cfcb580f71cad6ae8909a976568633a4f6a93c6b7fd5bfef11e1a2"
  await page.addInitScript(
    ({ unlisted }) => {
      localStorage.setItem(
        "conduit.market.defaultPerspectiveFollows.v3",
        JSON.stringify({
          pubkeys: [unlisted],
          eventCreatedAt: Math.floor(Date.now() / 1000) + 100,
          eventId: "0".repeat(64),
        })
      )
    },
    { unlisted: UNLISTED_ACCOUNT_PUBKEY }
  )
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page, addedMerchant)

  const requests: { kinds?: number[]; authors?: string[] }[] = []
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message))
      if (frame[0] !== "REQ") return
      const filters = frame.slice(2) as {
        kinds?: number[]
        authors?: string[]
      }[]
      requests.push(...filters)
      if (filters.some((filter) => filter.kinds?.includes(30402))) {
        socket.send(
          JSON.stringify(["CLOSED", frame[1], "error: unavailable fixture"])
        )
      } else {
        socket.send(JSON.stringify(["EOSE", frame[1]]))
      }
    })
  })
  await page.reload()
  await expect
    .poll(
      () => requests.filter((filter) => filter.kinds?.includes(30402)).length
    )
    .toBeGreaterThan(0)
  await expect(
    page.getByText("Account search fixture", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Hidden category fixture", { exact: true })
  ).toHaveCount(0)
  const productAuthors = requests
    .filter((filter) => filter.kinds?.includes(30402))
    .flatMap((filter) => filter.authors ?? [])
  expect(productAuthors).toContain(addedMerchant)
  expect(productAuthors).not.toContain(UNLISTED_ACCOUNT_PUBKEY)
  expect(requests.some((filter) => filter.kinds?.includes(3))).toBe(false)

  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await input.fill("ali")
  const listbox = page.getByRole("listbox", {
    name: "Matching categories, merchants, and accounts",
  })
  await expect(
    listbox.getByRole("option", { name: /Alice Storefront/ })
  ).toBeVisible()
  await expect(listbox.getByText("Alicia Reader")).toHaveCount(0)
  await page.goto(`${marketUrl}/events`)
  await expect
    .poll(
      () => requests.filter((filter) => filter.kinds?.includes(30409)).length
    )
    .toBeGreaterThan(0)
  expect(requests.some((filter) => filter.kinds?.includes(3))).toBe(false)
})

test("market header preserves account search inside the eligible author scope @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page)
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await input.click()
  await input.pressSequentially("ali", { delay: 40 })

  const listbox = page.getByRole("listbox", {
    name: "Matching categories, merchants, and accounts",
  })
  await expect(listbox).toBeVisible()
  await expect(input).toHaveAttribute("aria-expanded", "true")
  const merchants = listbox.getByRole("group", { name: "Merchants" })
  const merchant = merchants.getByRole("option", { name: /Alice Storefront/ })
  await expect(merchant).toBeVisible()
  await expect(
    listbox
      .getByRole("group", { name: "Accounts" })
      .getByRole("option", { name: /Wonderland Account/ })
  ).toBeVisible()
  await expect(listbox.getByText("Alicia Reader")).toHaveCount(0)
  await expect(listbox.getByRole("option")).toHaveCount(2)

  await page.keyboard.press("ArrowDown")
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "market-search-suggestions-option-0"
  )
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(
    `${marketUrl}/${nip19.npubEncode(SELLER_PUBKEY)}`
  )
  await expect(listbox).toBeHidden()
})

test("guest whitelist controls content discovery across cached reloads @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/about`)
  await seedAccounts(page, SELLER_PUBKEY, "Counterfeit goods display fixture")
  await page.routeWebSocket(/.*/, async (webSocket) => {
    await webSocket.close({ code: 1011, reason: "offline catalog fixture" })
  })
  await page.goto(`${marketUrl}/products?source=conduit`)

  const listedProduct = page.getByText("Counterfeit goods display fixture", {
    exact: true,
  })
  await expect(listedProduct).toBeVisible()
  await expect(
    page.getByText("Hidden category fixture", { exact: true })
  ).toHaveCount(0)
  await page.reload()
  await expect(listedProduct).toBeVisible()
  await expect(
    page.getByText("Hidden category fixture", { exact: true })
  ).toHaveCount(0)
})

test("market header selects cached categories inside the active catalog scope @market", async ({
  page,
}) => {
  // Use a different connected account so the seller stays inside the Conduit
  // author set while personal follow-discovery evidence stays out of this case.
  await installTestSigner(page, ELIGIBLE_ACCOUNT_PUBKEY)
  await page.goto(
    `${marketUrl}/products?source=conduit&merchant=${SELLER_PUBKEY}&sort=price_asc&q=old`
  )
  await seedAccounts(page)
  await page.routeWebSocket(/.*/, async (webSocket) => {
    await webSocket.close({ code: 1011, reason: "catalog unavailable fixture" })
  })
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await input.fill("art")

  const listbox = page.getByRole("listbox", {
    name: "Matching categories, merchants, and accounts",
  })
  const categories = listbox.getByRole("group", { name: "Categories" })
  await expect(categories).toBeVisible()
  await expect(
    page.getByText(
      "The active Market catalog is incomplete. Some categories or merchants may be missing.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    categories.getByRole("option", {
      name: /^# art Browse category$/i,
    })
  ).toBeVisible()
  await expect(categories.getByRole("option")).toHaveCount(2)
  await expect(listbox.getByText("hidden-category")).toHaveCount(0)

  await page.keyboard.press("ArrowDown")
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    "market-search-suggestions-option-0"
  )
  await page.keyboard.press("Enter")

  await expect.poll(() => new URL(page.url()).pathname).toBe("/products")
  const selected = new URL(page.url()).searchParams
  expect(selected.get("source")).toBe("conduit")
  expect(selected.has("merchant")).toBe(true)
  expect(selected.get("sort")).toBe("price_asc")
  expect(JSON.parse(selected.get("tag") ?? "null")).toEqual(["art"])
  expect(selected.has("q")).toBe(false)
  expect(selected.has("authRequired")).toBe(false)
})

test("market header keeps Enter as a product search when no suggestion is active @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/about`)
  await seedAccounts(page)
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await input.click()
  await input.pressSequentially("alice", { delay: 40 })
  await expect(
    page.getByRole("listbox", {
      name: "Matching categories, merchants, and accounts",
    })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("listbox", {
      name: "Matching categories, merchants, and accounts",
    })
  ).toBeHidden()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/products\?q=alice$/)
})

test("merchants tab lists discovered merchants and filters by name @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page)
  await page.goto(`${marketUrl}/merchants?source=combined`)

  await expect(
    page.getByRole("navigation", { name: "Market browse" }).getByRole("link", {
      name: "Merchants",
    })
  ).toHaveAttribute("aria-current", "page")
  await expect(page).toHaveTitle("Merchants | Conduit Market")
  const directory = page.locator(
    'section[aria-labelledby="discovered-merchants-heading"]'
  )
  await expect(
    directory.getByRole("link", { name: /Alice Storefront/ })
  ).toBeVisible()

  const networkAccounts = page.locator(
    'section[aria-labelledby="network-accounts-heading"]'
  )
  await page.getByRole("textbox", { name: "Filter merchants" }).fill("a")
  await expect(page).toHaveURL(/\/merchants\?.*q=a(?:&|$)/)
  await expect(
    networkAccounts.getByText("Other eligible accounts")
  ).toBeVisible()
  await expect(
    networkAccounts.getByRole("link", { name: /Wonderland Account/ })
  ).toBeVisible()
  await expect(networkAccounts.getByText("Alicia Reader")).toHaveCount(0)

  await page
    .getByRole("textbox", { name: "Filter merchants" })
    .fill("zzzz-no-match")
  await expect(page).toHaveURL(/\/merchants\?.*q=zzzz-no-match/)
  await expect(directory).toContainText(
    "Merchant name results may be incomplete"
  )
  await expect(networkAccounts).toBeVisible()
})

test("incomplete personal follow eligibility stays visible instead of looking like no matches @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${marketUrl}/products?source=following`)
  await seedAccounts(page)
  await page.routeWebSocket(/.*/, async (socket) => {
    await socket.close({ code: 1011, reason: "catalog unavailable fixture" })
  })
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await input.fill("~")
  const listbox = page.getByRole("listbox", {
    name: "Matching categories, merchants, and accounts",
  })
  await expect(listbox).toBeVisible()
  await expect(listbox).toContainText(
    "Results may be incomplete. No matches yet."
  )
  await expect(listbox.getByRole("option")).toHaveCount(0)
  await expect(input).toHaveAttribute("aria-expanded", "true")
})

test("merchants page filters with its own field while Enter still searches products @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page)
  await page.goto(`${marketUrl}/merchants?source=combined`)

  await page.getByRole("textbox", { name: "Filter merchants" }).fill("alice")
  await expect(page).toHaveURL(/\/merchants\?.*q=alice/)
  await expect(page).toHaveURL(/source=combined/)
  await expect(
    page
      .locator('section[aria-labelledby="discovered-merchants-heading"]')
      .getByRole("link", { name: /Alice Storefront/ })
  ).toBeVisible()

  const header = page.getByRole("combobox", {
    name: "Search products, categories, merchants, and accounts",
  })
  await header.click()
  await header.pressSequentially("alice", { delay: 40 })
  await page.keyboard.press("Escape")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/products\?q=alice$/)
})

test("product search lists matching merchants above the product results @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page)
  await page.goto(`${marketUrl}/products?source=combined&q=alice`)

  const merchants = page.locator(
    'section[aria-labelledby="matching-merchants-heading"]'
  )
  await expect(merchants).toBeVisible()
  await expect(
    merchants.getByRole("link", { name: /Alice Storefront/ })
  ).toHaveAttribute("href", `/${nip19.npubEncode(SELLER_PUBKEY)}`)
  // The perspective travels with the link; the directory reads the same
  // source and would otherwise show a different merchant set.
  await expect(
    merchants.getByRole("link", { name: "Search the merchant directory" })
  ).toHaveAttribute(
    "href",
    /\/merchants\?(?=[^"]*q=alice)(?=[^"]*source=combined)/
  )
  // The merchant row answers the name query; product filtering stays product-only.
  await expect(
    page.getByRole("link", { name: /Account search fixture/ })
  ).toHaveCount(0)
})

test("merchant picker and directory load more rows on scroll @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${marketUrl}/products`)
  await seedMerchantImageRows(page)
  await page.reload()
  await expect(
    page.getByText(/Hydration product \d+/, { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText(/^\d+ products?$/, { exact: true })).toHaveCount(
    0
  )
  await expect(
    page.getByRole("button", { name: /Refresh|Updating listings/ }).first()
  ).toBeVisible()
  await page
    .getByRole("combobox", { name: "All merchants", exact: true })
    .click()
  const list = page.getByRole("listbox", { name: "All merchants" })
  await expect(list.getByRole("option")).toHaveCount(13)
  await expect(
    list.getByRole("option", { name: "All merchants Selected", exact: true })
  ).not.toContainText("48")
  for (const expectedCount of [25, 37, 49]) {
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(list.getByRole("option")).toHaveCount(expectedCount)
  }
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("combobox", { name: "All merchants", exact: true })
  ).toBeFocused()

  await page.goto(`${marketUrl}/merchants`)
  const directory = page.locator(
    'section[aria-labelledby="discovered-merchants-heading"]'
  )
  await expect(directory.getByRole("link")).toHaveCount(12)
  for (const expectedCount of [24, 36, 48]) {
    await directory
      .getByRole("link")
      .last()
      .evaluate((element) => {
        element.scrollIntoView({ block: "end" })
      })
    await expect(directory.getByRole("link")).toHaveCount(expectedCount)
    await expect(directory).toContainText(`${expectedCount} of 48 merchants`)
  }
  await expect(
    directory.getByRole("button", { name: "Load more merchants" })
  ).toHaveCount(0)
})

test("merchant picker searches beyond its first page and preserves multi-selection @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  await seedMerchantImageRows(page)
  await page.reload()
  await page
    .getByRole("combobox", { name: "All merchants", exact: true })
    .click()
  const list = page.getByRole("listbox", { name: "All merchants" })
  const input = page.getByRole("combobox", {
    name: "Search merchants",
    exact: true,
  })
  await input.fill("Fixture Merchant 47")
  const match = list.getByRole("option", { name: /Fixture Merchant 47/ })
  await expect(match).toBeVisible()
  await expect(list.getByRole("option")).toHaveCount(2)
  await input.press("ArrowDown")
  await input.press("Enter")
  await expect
    .poll(() =>
      JSON.parse(new URL(page.url()).searchParams.get("merchant") ?? "[]")
    )
    .toEqual([OFFSCREEN_MERCHANT_PUBKEY])
  expect(new URL(page.url()).searchParams.has("q")).toBe(false)
  await expect(match).toContainText("Selected")
  await expect(list).toBeVisible()
  await input.fill("Fixture Merchant 46")
  await list.getByRole("option", { name: /Fixture Merchant 46/ }).click()
  await expect
    .poll(
      () =>
        JSON.parse(new URL(page.url()).searchParams.get("merchant") ?? "[]")
          .length
    )
    .toBe(2)
  await input.fill("merchant-that-does-not-exist")
  await expect(list.getByRole("option")).toHaveCount(1)
  await expect(
    page.getByText(
      /Merchant name results may be incomplete|No matching merchant/
    )
  ).toBeVisible()
  await list.getByRole("option", { name: /All merchants/ }).click()
  await expect
    .poll(() => new URL(page.url()).searchParams.has("merchant"))
    .toBe(false)
  await input.fill("")
  await expect(list.getByRole("option")).toHaveCount(13)
  if (process.env.FOLLOWUP_UI_EVIDENCE) {
    await page.screenshot({
      path: `${process.env.FOLLOWUP_UI_EVIDENCE}/merchant-picker.png`,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(input).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true)
    await page.screenshot({
      path: `${process.env.FOLLOWUP_UI_EVIDENCE}/merchant-picker-mobile.png`,
    })
  }
  await page.keyboard.press("Escape")

  await page.goto(`${marketUrl}/merchants?q=Fixture%20Merchant%2047`)
  const directory = page.locator(
    'section[aria-labelledby="discovered-merchants-heading"]'
  )
  await expect(
    directory.getByRole("link", { name: /Fixture Merchant 47/ })
  ).toBeVisible()
  await expect(directory).toContainText("1 of 1 merchants")
  await expect(
    directory.getByRole("button", { name: "Check more merchant names" })
  ).toBeVisible()
})

test("merchant paging retains an action when intersection observers are unavailable @market", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      value: undefined,
      configurable: true,
    })
  })
  await page.goto(`${marketUrl}/products`)
  await seedMerchantImageRows(page)
  await page.reload()
  await page
    .getByRole("combobox", { name: "All merchants", exact: true })
    .click()
  const list = page.getByRole("listbox", { name: "All merchants" })
  await expect(list.getByRole("option")).toHaveCount(13)
  await list.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(list.getByRole("option")).toHaveCount(25)
  await page.keyboard.press("Escape")
  await page.goto(`${marketUrl}/merchants`)
  const directory = page.locator(
    'section[aria-labelledby="discovered-merchants-heading"]'
  )
  await expect(directory.getByRole("link")).toHaveCount(12)
  const more = directory.getByRole("button", { name: "Load more merchants" })
  await more.focus()
  await more.press("Enter")
  await expect(directory.getByRole("link")).toHaveCount(24)
})

test("merchant avatars wait for visible rows and banners wait for profile navigation @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const targetAvatarUrl = `${IMAGE_FIXTURE_BASE}-avatar-47.png`
  const bannerUrl = `${IMAGE_FIXTURE_BASE}-banner.png`
  let targetAvatarRequests = 0
  let bannerRequests = 0
  await page.route(`${IMAGE_FIXTURE_BASE}-*.png`, async (route) => {
    const url = route.request().url()
    if (url === targetAvatarUrl) targetAvatarRequests += 1
    if (url === bannerUrl) bannerRequests += 1
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: IMAGE_FIXTURE_PNG,
    })
  })

  await page.goto(`${marketUrl}/products`)
  await seedMerchantImageRows(page)
  await page.reload()
  await expect(
    page.getByText(/Hydration product \d+/, { exact: true }).first()
  ).toBeVisible()
  expect(bannerRequests).toBe(0)

  await page.goto(`${marketUrl}/merchants`)
  const directory = page.locator(
    'section[aria-labelledby="discovered-merchants-heading"]'
  )
  const target = directory.getByRole("link", {
    name: /Fixture Merchant 47/,
  })
  const targetAvatar = target.locator(`img[src="${targetAvatarUrl}"]`)
  await expect(directory.getByRole("link")).toHaveCount(12)
  await expect(target).toHaveCount(0)
  expect(targetAvatarRequests).toBe(0)
  expect(bannerRequests).toBe(0)
  for (const expectedCount of [24, 36, 48]) {
    await directory
      .getByRole("link")
      .last()
      .evaluate((element) => {
        element.scrollIntoView({ block: "end" })
      })
    await expect(directory.getByRole("link")).toHaveCount(expectedCount)
  }
  await expect(target).toBeAttached()
  await target.scrollIntoViewIfNeeded()
  await expect(targetAvatar).toBeVisible()
  await expect.poll(() => targetAvatarRequests).toBeGreaterThan(0)
  expect(bannerRequests).toBe(0)
  if (process.env.FOLLOWUP_UI_EVIDENCE) {
    await page.screenshot({
      path: `${process.env.FOLLOWUP_UI_EVIDENCE}/merchant-directory.png`,
    })
  }

  await target.click()
  await expect(page).toHaveURL(
    `${marketUrl}/${nip19.npubEncode(OFFSCREEN_MERCHANT_PUBKEY)}`
  )
  await expect.poll(() => bannerRequests).toBeGreaterThan(0)
})
