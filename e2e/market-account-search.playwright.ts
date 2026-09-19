import { expect, test, type Page } from "@playwright/test"
import { installTestSigner } from "./helpers/auth"

// A member of the bundled Conduit perspective. Keep this fixture explicit so
// Playwright does not evaluate browser-only application modules in Node.
const SELLER_PUBKEY =
  "c4eabae1be3cf657bc1855ee05e69de9f059cb7a059227168b80b89761cbc4e0"
const ELIGIBLE_ACCOUNT_PUBKEY =
  "088436cd039ff89074468fd327facf62784eeb37490e0a118ab9f14c9d2646cc"
const UNLISTED_ACCOUNT_PUBKEY = "c".repeat(64)
const MARKET_ORIGIN = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

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
            summary: "Seeded listing so the account is a seller",
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
            tags: [],
            eventId: "f".repeat(64),
            eventCreatedAt: 100,
            dTag: "account-search-fixture",
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
  await page.goto(`${MARKET_ORIGIN}/products`)
  await seedAccounts(page)
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products and accounts",
  })
  await input.click()
  await input.pressSequentially("ali", { delay: 40 })

  const listbox = page.getByRole("listbox", {
    name: "Matching stores and accounts",
  })
  await expect(listbox).toBeVisible()
  await expect(input).toHaveAttribute("aria-expanded", "true")
  const stores = listbox.getByRole("group", { name: "Stores" })
  const seller = stores.getByRole("option", { name: /Alice Storefront/ })
  await expect(seller).toBeVisible()
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
    "market-account-suggestions-option-0"
  )
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/store\/npub1/)
  await expect(listbox).toBeHidden()
})

test("market header keeps Enter as a product search when no suggestion is active @market", async ({
  page,
}) => {
  await page.goto(`${MARKET_ORIGIN}/about`)
  await seedAccounts(page)
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products and accounts",
  })
  await input.click()
  await input.pressSequentially("alice", { delay: 40 })
  await expect(
    page.getByRole("listbox", { name: "Matching stores and accounts" })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("listbox", { name: "Matching stores and accounts" })
  ).toBeHidden()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/products\?q=alice$/)
})

test("sellers tab lists discovered storefronts and filters by name @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${MARKET_ORIGIN}/products`)
  await seedAccounts(page)
  await page.goto(`${MARKET_ORIGIN}/sellers`)

  await expect(
    page.getByRole("navigation", { name: "Market browse" }).getByRole("link", {
      name: "Sellers",
    })
  ).toHaveAttribute("aria-current", "page")
  await expect(page).toHaveTitle("Sellers | Conduit Market")
  await expect(
    page
      .getByRole("group", { name: "Market perspective" })
      .getByRole("button", { name: "Following + Conduit" })
  ).toHaveAttribute("aria-pressed", "true")
  const directory = page.locator(
    'section[aria-labelledby="discovered-sellers-heading"]'
  )
  await expect(
    directory.getByRole("link", { name: /Alice Storefront/ })
  ).toBeVisible()

  await page.getByRole("textbox", { name: "Filter sellers" }).fill("a")
  await expect(page).toHaveURL(/\/sellers\?.*q=a(?:&|$)/)
  const accounts = page.locator(
    'section[aria-labelledby="network-accounts-heading"]'
  )
  await expect(accounts.getByText("Other eligible accounts")).toBeVisible()
  await expect(
    accounts.getByRole("link", { name: /Wonderland Account/ })
  ).toBeVisible()
  await expect(accounts.getByText("Alicia Reader")).toHaveCount(0)

  await page
    .getByRole("textbox", { name: "Filter sellers" })
    .fill("zzzz-no-match")
  await expect(page).toHaveURL(/\/sellers\?.*q=zzzz-no-match/)
  await expect(directory).toContainText("No discovered seller name matches")
})

test("incomplete eligibility stays visible instead of looking like no matches @market", async ({
  page,
}) => {
  await page.goto(`${MARKET_ORIGIN}/products`)
  await seedAccounts(page)
  await page.reload()

  const input = page.getByRole("combobox", {
    name: "Search products and accounts",
  })
  await input.fill("~")
  const listbox = page.getByRole("listbox", {
    name: "Matching stores and accounts",
  })
  await expect(listbox).toBeVisible()
  await expect(listbox).toContainText(
    "Eligible account results may be incomplete. No matches yet."
  )
  await expect(listbox.getByRole("option")).toHaveCount(0)
  await expect(input).toHaveAttribute("aria-expanded", "true")
})

test("sellers page filters with its own field while Enter still searches products @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${MARKET_ORIGIN}/products`)
  await seedAccounts(page)
  await page.goto(`${MARKET_ORIGIN}/sellers`)

  await page.getByRole("textbox", { name: "Filter sellers" }).fill("alice")
  await expect(page).toHaveURL(/\/sellers\?.*q=alice/)
  await expect(page).not.toHaveURL(/source=/)
  await expect(
    page
      .locator('section[aria-labelledby="discovered-sellers-heading"]')
      .getByRole("link", { name: /Alice Storefront/ })
  ).toBeVisible()

  const header = page.getByRole("combobox", {
    name: "Search products and accounts",
  })
  await header.click()
  await header.pressSequentially("alice", { delay: 40 })
  await page.keyboard.press("Escape")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/products\?q=alice$/)
})

test("product search lists matching storefronts above the product results @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto(`${MARKET_ORIGIN}/products`)
  await seedAccounts(page)
  await page.goto(`${MARKET_ORIGIN}/products?source=combined&q=alice`)

  const stores = page.locator(
    'section[aria-labelledby="matching-stores-heading"]'
  )
  await expect(stores).toBeVisible()
  await expect(
    stores.getByRole("link", { name: /Alice Storefront/ })
  ).toHaveAttribute("href", /\/store\/npub1/)
  // The perspective travels with the link; the directory reads the same
  // source and would otherwise show a different seller set.
  await expect(stores.getByRole("link", { name: /See all/ })).toHaveAttribute(
    "href",
    /\/sellers\?(?=[^"]*q=alice)(?=[^"]*source=combined)/
  )
  // The store row answers the name query; product filtering stays product-only.
  await expect(
    page.getByRole("link", { name: /Account search fixture/ })
  ).toHaveCount(0)
})
