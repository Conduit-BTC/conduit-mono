import { expect, test, type Page } from "@playwright/test"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
  seedMarketCart,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`

async function seedCachedMerchantProduct(page: Page): Promise<void> {
  await page.evaluate((merchantPubkey) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("products", "readwrite")
        const timestamp = Date.now()
        transaction.objectStore("products").put({
          id: `30402:${merchantPubkey}:published-pocket-relay`,
          pubkey: merchantPubkey,
          title: "Published Pocket Relay",
          summary: "Published summary",
          price: 1,
          currency: "SATS",
          priceSats: 1,
          sourcePrice: {
            amount: 0.00000001,
            currency: "BTC",
            normalizedCurrency: "BTC",
          },
          type: "simple",
          format: "physical",
          visibility: "public",
          stock: 1,
          images: [{ url: "https://example.com/pocket-relay.png" }],
          tags: ["relay", "hardware", "nostr"],
          publicZapEnabled: true,
          zapMessagePolicy: "generic_only",
          publicZapPolicyKnown: true,
          createdAt: timestamp,
          updatedAt: timestamp,
          cachedAt: timestamp,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, TEST_MERCHANT_PUBKEY)
}

test("merchant shipping country combobox supports search and selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/shipping`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  const countryPicker = page.getByRole("combobox", {
    name: "Search countries to add...",
  })
  const countryPickerTrigger = page
    .locator("[data-combobox-search-trigger]")
    .filter({ has: countryPicker })
  const triggerBox = await countryPickerTrigger.boundingBox()
  if (!triggerBox) {
    throw new Error("Country picker trigger was not visible")
  }

  await page.mouse.click(
    triggerBox.x + 12,
    triggerBox.y + triggerBox.height / 2
  )
  await page.keyboard.type("un")
  await expect(countryPicker).toHaveValue("un")
  await expect(page.getByRole("option").first()).toContainText("United")

  await countryPicker.fill("")
  await expect(page.getByRole("option").first()).toContainText("Åland Islands")

  await page.getByRole("heading", { name: "Shipping" }).click()
  await page.mouse.click(
    triggerBox.x + triggerBox.width - 12,
    triggerBox.y + triggerBox.height / 2
  )
  await page.keyboard.type("canada")
  await expect(countryPicker).toHaveValue("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(
    page.locator("span").filter({ hasText: /^Canada$/ })
  ).toBeVisible()
  await expect(countryPicker).toHaveValue("")
})

test("merchant product drafts survive safe dialog dismissal", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)

  await expect(
    page.getByRole("heading", { name: "Manage your listings" })
  ).toBeVisible()

  const addProduct = page.getByRole("button", { name: "Add product" }).first()
  const productDialog = page.getByRole("dialog", { name: "Add product" })
  const title = page.locator("#product-title")
  const price = page.locator("#product-price")
  const shipping = page.locator("#product-shipping")
  const coordinateShipping = page.getByRole("checkbox", {
    name: "Coordinate shipping with the buyer after the order",
  })

  await addProduct.click()
  await title.fill("Pocket relay draft")

  await price.fill("")
  await price.press("e")
  await expect(price).toHaveValue("")
  await price.fill("1e3")
  await expect(price).toHaveValue("")
  await price.fill("25")

  await shipping.fill("e")
  await expect(shipping).toHaveValue("")
  await shipping.fill("0")
  await expect(page.locator("#product-shipping-help")).toContainText(
    "fast checkout"
  )

  await coordinateShipping.check()
  await expect(shipping).toBeDisabled()
  await expect(shipping).toHaveValue("")
  await expect(page.locator("#product-coordinate-shipping-help")).toContainText(
    "Fast checkout will be unavailable"
  )
  await coordinateShipping.uncheck()
  await expect(shipping).toBeEnabled()
  await expect(shipping).toHaveValue("0")
  await expect(shipping).toHaveAttribute("placeholder", "0 or fixed amount")

  await page.locator("#product-currency").click()
  await expect(page.getByRole("listbox")).toBeVisible()
  const titleBox = await title.boundingBox()
  if (!titleBox) throw new Error("Product title was not visible")
  await page.mouse.click(titleBox.x + 12, titleBox.y + titleBox.height / 2)

  await expect(productDialog).toBeVisible()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(page.getByRole("listbox")).not.toBeVisible()

  const currency = page.locator("#product-currency")
  await currency.click()
  await page.getByRole("option", { name: "SATS" }).click()
  await expect(currency).toContainText("SATS")

  const dialogBox = await productDialog.boundingBox()
  if (!dialogBox) throw new Error("Product dialog was not visible")
  await page.mouse.click(
    Math.max(4, dialogBox.x - 12),
    Math.max(4, dialogBox.y + 24)
  )

  await expect(productDialog).toBeVisible()
  await expect(title).toHaveValue("Pocket relay draft")

  await page.keyboard.press("Escape")
  await expect(productDialog).not.toBeVisible()
  await expect(addProduct).toBeFocused()

  await addProduct.click()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(currency).toContainText("SATS")

  await page.keyboard.press("Escape")
  await page.reload()
  await addProduct.click()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(currency).toContainText("SATS")

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard changes" }).click()
  await expect(productDialog).not.toBeVisible()

  await addProduct.click()
  await expect(title).toHaveValue("")

  await page.keyboard.press("Escape")
  await seedCachedMerchantProduct(page)
  await page.reload()

  const editProduct = page.getByRole("button", { name: "Edit" })
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })

  await expect(editProduct).toBeVisible()
  await editProduct.click()
  await expect(coordinateShipping).toBeChecked()
  await expect(shipping).toBeDisabled()
  await expect(price).toHaveValue("0.00000001")
  await title.fill("Unpublished edited title")
  await page.keyboard.press("Escape")
  await expect(editDialog).not.toBeVisible()

  await editProduct.click()
  await expect(title).toHaveValue("Unpublished edited title")
  await expect(price).toHaveValue("0.00000001")

  await page.keyboard.press("Escape")
  await page.reload()
  await editProduct.click()
  await expect(title).toHaveValue("Unpublished edited title")
  await expect(price).toHaveValue("0.00000001")

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard changes" }).click()
  await editProduct.click()
  await expect(title).toHaveValue("Published Pocket Relay")
})

test("market checkout country combobox supports search and selection", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  await page.getByRole("combobox", { name: /country/i }).click()
  await page.getByPlaceholder("Search countries...").fill("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(page.getByRole("combobox", { name: /country/i })).toContainText(
    "Canada (CA)"
  )
})

test("market wallet setup route renders for connected signer", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/wallet`)

  await expect(
    page.getByRole("heading", { name: "Wallet", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Wallet connection", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /connect wallet/i })
  ).toBeVisible()
  await expect(page.getByPlaceholder("nostr+walletconnect://...")).toBeVisible()
})
