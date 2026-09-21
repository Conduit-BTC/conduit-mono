import { expect, test, type Page } from "@playwright/test"
import { installTestSigner } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
// Members of the bundled Conduit perspective. Keep these fixtures explicit so
// Playwright does not evaluate browser-only application modules in Node.
const SELLER_PUBKEY =
  "c4eabae1be3cf657bc1855ee05e69de9f059cb7a059227168b80b89761cbc4e0"
const ELIGIBLE_ACCOUNT_PUBKEY =
  "088436cd039ff89074468fd327facf62784eeb37490e0a118ab9f14c9d2646cc"
const UNLISTED_ACCOUNT_PUBKEY = "c".repeat(64)

async function seedAccounts(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle")
  await page.evaluate(
    ({ sellerPubkey, eligibleAccountPubkey, unlistedAccountPubkey }) =>
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
            title: "Account search fixture",
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
      sellerPubkey: SELLER_PUBKEY,
      eligibleAccountPubkey: ELIGIBLE_ACCOUNT_PUBKEY,
      unlistedAccountPubkey: UNLISTED_ACCOUNT_PUBKEY,
    }
  )
}

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
  await expect(page).toHaveURL(/\/store\/npub1/)
  await expect(listbox).toBeHidden()
})

test("market header selects cached categories inside the active catalog scope @market", async ({
  page,
}) => {
  // Use a different connected account so the seller stays inside the Conduit
  // author set while guest follow-discovery evidence stays out of this case.
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
  await expect(directory).toContainText("No discovered merchant name matches")
  await expect(networkAccounts).toBeVisible()
})

test("incomplete eligibility stays visible instead of looking like no matches @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  await seedAccounts(page)
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
  ).toHaveAttribute("href", /\/store\/npub1/)
  // The perspective travels with the link; the directory reads the same
  // source and would otherwise show a different merchant set.
  await expect(
    merchants.getByRole("link", { name: /See all/ })
  ).toHaveAttribute(
    "href",
    /\/merchants\?(?=[^"]*q=alice)(?=[^"]*source=combined)/
  )
  // The merchant row answers the name query; product filtering stays product-only.
  await expect(
    page.getByRole("link", { name: /Account search fixture/ })
  ).toHaveCount(0)
})
