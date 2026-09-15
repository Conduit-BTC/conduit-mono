import { expect, test, type Page } from "@playwright/test"
import { installTestSigner } from "./helpers/auth"

const SELLER_PUBKEY = "b".repeat(64)
const BUYER_PUBKEY = "c".repeat(64)

async function seedAccounts(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle")
  await page.evaluate(
    ({ sellerPubkey, buyerPubkey }) =>
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
            pubkey: buyerPubkey,
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
    { sellerPubkey: SELLER_PUBKEY, buyerPubkey: BUYER_PUBKEY }
  )
}

test("market header suggests locally known accounts and opens the storefront from the keyboard @market", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:7000/products")
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
      .getByRole("option", { name: /Alicia Reader/ })
  ).toBeVisible()
  await expect(
    listbox.getByRole("option", { name: /Alicia Reader/ })
  ).toBeVisible()
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
  await page.goto("http://127.0.0.1:7000/about")
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
  await page.goto("http://127.0.0.1:7000/products")
  await seedAccounts(page)
  await page.goto("http://127.0.0.1:7000/sellers?source=combined")

  await expect(
    page.getByRole("navigation", { name: "Market browse" }).getByRole("link", {
      name: "Sellers",
    })
  ).toHaveAttribute("aria-current", "page")
  await expect(page).toHaveTitle("Sellers | Conduit Market")
  const directory = page.locator(
    'section[aria-labelledby="discovered-sellers-heading"]'
  )
  await expect(
    directory.getByRole("link", { name: /Alice Storefront/ })
  ).toBeVisible()

  await page
    .getByRole("textbox", { name: "Filter sellers" })
    .fill("zzzz-no-match")
  await expect(page).toHaveURL(/\/sellers\?.*q=zzzz-no-match/)
  await expect(directory).toContainText("No discovered seller name matches")
  await expect(
    page.locator('section[aria-labelledby="network-accounts-heading"]')
  ).toBeVisible()
})

test("sellers page filters with its own field while Enter still searches products @market", async ({
  page,
}) => {
  await installTestSigner(page, SELLER_PUBKEY)
  await page.goto("http://127.0.0.1:7000/products")
  await seedAccounts(page)
  await page.goto("http://127.0.0.1:7000/sellers?source=combined")

  await page.getByRole("textbox", { name: "Filter sellers" }).fill("alice")
  await expect(page).toHaveURL(/\/sellers\?.*q=alice/)
  await expect(page).toHaveURL(/source=combined/)
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
  await page.goto("http://127.0.0.1:7000/products")
  await seedAccounts(page)
  await page.goto("http://127.0.0.1:7000/products?source=combined&q=alice")

  const stores = page.locator(
    'section[aria-labelledby="matching-stores-heading"]'
  )
  await expect(stores).toBeVisible()
  await expect(
    stores.getByRole("link", { name: /Alice Storefront/ })
  ).toHaveAttribute("href", /\/store\/npub1/)
  await expect(stores.getByRole("link", { name: /See all/ })).toHaveAttribute(
    "href",
    /\/sellers\?q=alice/
  )
  // The store row answers the name query; product filtering stays product-only.
  await expect(
    page.getByRole("link", { name: /Account search fixture/ })
  ).toHaveCount(0)
})
