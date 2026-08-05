import { expect, test, type Page } from "@playwright/test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
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
          images: [{ url: "https://blossom.conduit.market/pocket-relay.png" }],
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

async function seedCachedMerchantTagCatalog(page: Page): Promise<void> {
  await page.evaluate((merchantPubkey) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("products", "readwrite")
        const timestamp = Date.now()
        const products = [
          {
            dTag: "catalog-hardware-one",
            title: "Catalog Hardware One",
            tags: [" Hardware ", "HARDWARE", "relay"],
          },
          {
            dTag: "catalog-hardware-two",
            title: "Catalog Hardware Two",
            tags: ["hardware", "handmade"],
          },
          {
            dTag: "catalog-hardware-three",
            title: "Catalog Hardware Three",
            tags: ["hardware", "nostr"],
          },
        ]

        for (const [index, product] of products.entries()) {
          transaction.objectStore("products").put({
            id: `30402:${merchantPubkey}:${product.dTag}`,
            pubkey: merchantPubkey,
            title: product.title,
            summary: "Catalog tag suggestion fixture",
            price: 1,
            currency: "SATS",
            priceSats: 1,
            sourcePrice: {
              amount: 1,
              currency: "SATS",
              normalizedCurrency: "SATS",
            },
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [{ url: `https://example.com/catalog-${index}.png` }],
            tags: product.tags,
            publicZapEnabled: true,
            zapMessagePolicy: "generic_only",
            publicZapPolicyKnown: true,
            createdAt: timestamp - index,
            updatedAt: timestamp - index,
            cachedAt: timestamp,
          })
        }

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, TEST_MERCHANT_PUBKEY)
}

async function seedPortableWalletDescriptor(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(
          ["wallets", "walletCredentials"],
          "readwrite"
        )
        const timestamp = Date.now()
        transaction.objectStore("wallets").put({
          id: "playwright-portable-wallet",
          kind: "portable",
          providerId: "spark",
          label: "QA Portable",
          network: "mainnet",
          capabilities: [
            "pay_invoice",
            "receive",
            "balance",
            "history",
            "spark_transfer",
          ],
          status: "locked",
          defaultIntents: ["pay_invoice"],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        transaction.objectStore("walletCredentials").put({
          walletId: "playwright-portable-wallet",
          providerId: "spark",
          credential: JSON.stringify({
            type: "password",
            walletId: "playwright-portable-wallet",
            providerId: "spark",
            network: "mainnet",
            accountNumber: 1,
            recovery: {
              version: 2,
              kdf: "PBKDF2-SHA-256",
              cipher: "AES-GCM",
              iterations: 100_000,
              salt: "AAAAAAAAAAAAAAAAAAAAAA==",
              iv: "AAAAAAAAAAAAAAAA",
              ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
            },
          }),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  })
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

test("merchant product tags suggest the loaded catalog without blocking freeform entry", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 375, height: 667 },
  })
  const page = await context.newPage()
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()

  await seedCachedMerchantTagCatalog(page)
  await page.reload()
  await page.getByRole("button", { name: "Add product" }).first().click()

  const title = page.locator("#product-title")
  const tags = page.getByRole("combobox", { name: "Tags" })

  await tags.fill("ha")
  await expect(tags).toHaveAttribute("aria-expanded", "true")
  await expect(
    page.getByText("From your catalog", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("option").first()).toContainText(
    "hardware3 listings"
  )
  const suggestionListId = await tags.getAttribute("aria-controls")
  expect(suggestionListId).toBeTruthy()
  await expect(page.locator(`[id="${suggestionListId}"]`)).toHaveAttribute(
    "role",
    "listbox"
  )
  const activeSuggestionId = await tags.getAttribute("aria-activedescendant")
  expect(activeSuggestionId).toBeTruthy()
  await expect(page.locator(`[id="${activeSuggestionId}"]`)).toHaveAttribute(
    "aria-selected",
    "true"
  )

  const popup = page.locator("[data-radix-popper-content-wrapper]:visible")
  const popupBox = await popup.boundingBox()
  if (!popupBox) throw new Error("Product tag suggestion popup was not visible")
  expect(popupBox.x).toBeGreaterThanOrEqual(0)
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(375)

  await tags.press("ArrowDown")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove handmade tag" })
  ).toBeVisible()
  await expect(tags).toHaveValue("")

  await tags.fill("hard")
  await page.getByRole("option", { name: /hardware 3 listings/i }).tap()
  await expect(
    page.getByRole("button", { name: "Remove hardware tag" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Remove hard tag" })
  ).toHaveCount(0)

  await tags.fill("hard")
  await expect(tags).toHaveAttribute("aria-expanded", "false")
  await tags.fill("custom tag")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove custom tag tag" })
  ).toBeVisible()

  await tags.fill("rel")
  await expect(tags).toHaveAttribute("aria-expanded", "true")
  await tags.press("Escape")
  await expect(tags).toHaveAttribute("aria-expanded", "false")
  await expect(tags).toHaveValue("rel")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove rel tag" })
  ).toBeVisible()

  await tags.fill("blur tag")
  await title.focus()
  await expect(
    page.getByRole("button", { name: "Remove blur tag tag" })
  ).toBeVisible()
  await context.close()
})

test("merchant product options support generic three-axis sparse rows", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()

  await page
    .getByRole("checkbox", { name: /This product has variations/ })
    .check()
  await page.getByRole("button", { name: "Add custom axis" }).click()
  await page.getByRole("button", { name: "Add custom axis" }).click()

  const axisNames = page.getByLabel("Axis name")
  const axisValues = page.getByLabel("Values")
  await axisNames.nth(0).fill("screen-size")
  await axisValues.nth(0).fill('13", 15"')
  await axisNames.nth(1).fill("license-tier")
  await axisValues.nth(1).fill("Personal, Business")
  await axisNames.nth(2).fill("theme")
  await axisValues.nth(2).fill("Light, Dark")

  await page.getByRole("button", { name: "Generate combinations" }).click()
  await expect(page.getByRole("button", { name: "Remove row" })).toHaveCount(8)
  await expect(page.getByText('13" / Personal / Light')).toBeVisible()

  const dialogOverflow = await page
    .getByRole("dialog", { name: "Add product" })
    .evaluate((dialog) => {
      const directContentBottom = Math.max(
        ...Array.from(dialog.children).map(
          (child) => child.offsetTop + child.clientHeight
        )
      )
      const variationScroller = dialog.querySelector(
        "[data-product-variation-rows]"
      )

      if (!(variationScroller instanceof HTMLElement)) {
        throw new Error("Variation row scroller was not rendered")
      }

      return {
        excessScrollHeight: dialog.scrollHeight - directContentBottom,
        variationClientHeight: variationScroller.clientHeight,
        variationScrollHeight: variationScroller.scrollHeight,
      }
    })

  expect(dialogOverflow.variationScrollHeight).toBeGreaterThan(
    dialogOverflow.variationClientHeight
  )
  expect(dialogOverflow.excessScrollHeight).toBeLessThanOrEqual(32)

  await page.getByRole("button", { name: "Remove row" }).first().click()
  await expect(page.getByRole("button", { name: "Remove row" })).toHaveCount(7)
  await page.getByLabel("Child title").first().fill("Studio License")
  await expect(page.getByLabel("Child title").first()).toHaveValue(
    "Studio License"
  )
})

test("merchant product drafts survive safe dialog dismissal", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)

  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()

  const addProduct = page.getByRole("button", { name: "Add product" }).first()
  const productDialog = page.getByRole("dialog", { name: "Add product" })
  const title = page.locator("#product-title")
  const tags = page.locator("#product-tags")
  const price = page.locator("#product-price")
  const shipping = page.locator("#product-shipping")
  const coordinateShipping = page.getByRole("checkbox", {
    name: "Coordinate shipping with the buyer after the order",
  })

  await addProduct.click()
  await title.fill("Pocket relay draft")

  await expect(page.locator("#product-tags-hint")).toContainText(
    "Minimum 3; aim for 5–12. 0/24 tags used"
  )

  await tags.fill("配送")
  await tags.dispatchEvent("compositionstart")
  await tags.dispatchEvent("keydown", { key: "Enter", code: "Enter" })
  await expect(tags).toHaveValue("配送")
  await expect(
    page.getByRole("button", { name: "Remove 配送 tag" })
  ).toHaveCount(0)
  await tags.dispatchEvent("compositionend")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove 配送 tag" })
  ).toBeVisible()
  await expect(tags).toHaveValue("")

  const priceError = page.locator("#product-price-error")
  await expect(priceError).toBeVisible()
  await expect(priceError).toHaveClass(/sm:col-span-4/)

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

test("market wallets route renders portable and connected wallet groups", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/wallet`)

  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Portable", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Connected", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No Portable Wallets on this device.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No Connected Wallets on this device.", { exact: true })
  ).toBeVisible()

  const connectWalletButton = page.getByRole("button", {
    name: "Connect wallet",
  })
  await connectWalletButton.click()
  await expect(
    page.getByRole("heading", { name: "Connect wallet", exact: true })
  ).toBeVisible()
  const nwcConnection = page.getByPlaceholder("nostr+walletconnect://...")
  await expect(nwcConnection).toBeVisible()
  await nwcConnection.fill("not-an-nwc-authorization")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(connectWalletButton).toBeFocused()

  const displayCurrency = page.getByRole("combobox", {
    name: "Preferred currency",
  })
  const satsStandard = page.getByRole("switch", {
    name: "Sats the standard",
  })
  await displayCurrency.click()
  await page.getByRole("option", { name: "EUR" }).click()
  await satsStandard.click()
  await expect(displayCurrency).toContainText("EUR")
  await expect(satsStandard).toBeChecked()

  await page.reload()
  await expect(displayCurrency).toContainText("EUR")
  await expect(satsStandard).toBeChecked()
})

test("portable wallet restore keeps derivation advanced and device-only fields clear", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await page.getByRole("button", { name: "Add portable wallet" }).click()

  const dialog = page.getByRole("dialog", { name: "Add a Spark wallet" })
  await expect(dialog).toBeVisible()
  const networkContext = dialog.getByText(/^Spark wallet · /)
  await expect(networkContext).toBeVisible()
  const networkLabel = await networkContext.textContent()

  await dialog.getByRole("tab", { name: "Restore" }).click()
  await expect(dialog.getByLabel("Recovery phrase")).toBeVisible()
  const advancedSettings = dialog.locator("details")
  await expect(advancedSettings).not.toHaveAttribute("open", "")
  await advancedSettings.locator("summary").click()
  await expect(dialog.getByLabel("Spark account number")).toHaveValue(
    networkLabel?.endsWith("Regtest") ? "0" : "1"
  )
  await expect(dialog.getByLabel("Wallet nickname (optional)")).toBeVisible()
  await expect(dialog.getByLabel("Local wallet password")).toBeVisible()
  await expect(
    dialog.getByText("Use this nickname to identify the wallet in Conduit.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    dialog.getByText("It is not the source wallet's password", {
      exact: false,
    })
  ).toBeVisible()
})

test("market wallets remain available without a Nostr signer", async ({
  page,
}) => {
  await page.goto(marketUrl)

  const walletsNavigation = page.getByRole("button", {
    name: "Wallets",
    exact: true,
  })
  await expect(walletsNavigation).toBeVisible()
  await walletsNavigation.click()

  await expect(page).toHaveURL(`${marketUrl}/wallet`)
  await expect(page).toHaveTitle("Wallets | Conduit Market")
  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()
})

test("wallet dialog dismissal clears device-local sensitive state", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await seedPortableWalletDescriptor(page)
  await page.reload()

  await expect(page.getByText("QA Portable", { exact: true })).toBeVisible()

  const unlockButton = page.getByRole("button", {
    name: "Unlock",
    exact: true,
  })
  await unlockButton.click()
  const unlockDialog = page.getByRole("dialog", {
    name: "Unlock QA Portable",
  })
  const unlockPassword = unlockDialog.getByLabel("Wallet password")
  await unlockPassword.fill("ephemeral QA value")
  await page.keyboard.press("Escape")
  await expect(unlockDialog).not.toBeVisible()
  await expect(unlockButton).toBeFocused()

  await unlockButton.click()
  await expect(unlockPassword).toHaveValue("")
  await unlockDialog.getByRole("button", { name: "Cancel" }).click()

  await page
    .getByRole("button", { name: "Remove from this device", exact: true })
    .click()
  const removeDialog = page.getByRole("alertdialog", {
    name: "Remove from this device?",
  })
  const recoveryConfirmation = removeDialog.getByRole("switch", {
    name: "I have the recovery phrase and Spark account number",
  })
  await recoveryConfirmation.click()
  await expect(recoveryConfirmation).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(removeDialog).not.toBeVisible()

  await page
    .getByRole("button", { name: "Remove from this device", exact: true })
    .click()
  await expect(recoveryConfirmation).not.toBeChecked()
  await expect(
    removeDialog.getByRole("button", {
      name: "Remove from this device",
      exact: true,
    })
  ).toBeDisabled()
})

test("market shopper preferences remove legacy plaintext and render the complete form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const secretKey = generateSecretKey()
  const buyerPubkey = getPublicKey(secretKey)
  await installTestSigner(page, buyerPubkey, { nip44: false, secretKey })
  await page.addInitScript((buyerPubkey) => {
    localStorage.setItem(
      `conduit:market-shopper-presets:v1:${buyerPubkey}`,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        value: {
          shippingCountry: "DE",
        },
      })
    )
  }, buyerPubkey)

  await page.goto(`${marketUrl}/preferences`)
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText(
    /Encrypted on relays|Relay ready|Relay sync unavailable|Relay sync failed/,
    { timeout: 20_000 }
  )
  const recipientName = page.getByLabel("Recipient name")
  const addressLine1 = page.getByLabel("Address line 1")
  await expect(recipientName).toBeVisible()
  await expect(addressLine1).toBeVisible()
  const addressPositionBefore = await addressLine1.boundingBox()
  await expect(
    recipientName.locator("..").getByText("Required", { exact: true })
  ).toBeVisible()
  await recipientName.fill("Ada Lovelace")
  await expect(
    recipientName.locator("..").getByText("Required", { exact: true })
  ).not.toBeVisible()
  const addressPositionAfter = await addressLine1.boundingBox()
  expect(addressPositionAfter?.y).toBe(addressPositionBefore?.y)
  await expect(page.getByLabel("Postal / ZIP code")).toBeVisible()
  const encryptionPassword = page.getByLabel("Encryption password")
  const confirmPassword = page.getByLabel("Confirm password")
  const unlockPreference = page.getByLabel("Unlock preference")
  await expect(encryptionPassword).toBeVisible()
  await expect(confirmPassword).toBeVisible()
  await expect(unlockPreference).toBeVisible()
  const encryptionPasswordPosition = await encryptionPassword.boundingBox()
  const confirmPasswordPosition = await confirmPassword.boundingBox()
  expect(confirmPasswordPosition?.y).toBe(encryptionPasswordPosition?.y)
  const unlockPreferencePositionBefore = await unlockPreference.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY
  )
  await encryptionPassword.fill("short")
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain 16 or more characters.")
  ).toBeVisible()
  await encryptionPassword.fill("long password text")
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain at least one number.")
  ).toBeVisible()
  await encryptionPassword.fill("secure password 7")
  const unlockPreferencePositionAfter = await unlockPreference.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY
  )
  expect(unlockPreferencePositionAfter).toBe(unlockPreferencePositionBefore)
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain 16 or more characters.")
  ).not.toBeVisible()
  await confirmPassword.fill("different")
  await expect(
    confirmPassword.locator("..").getByText("Password confirmation must match.")
  ).toBeVisible()
  await confirmPassword.fill("secure password 7")
  await expect(
    confirmPassword.locator("..").getByText("Password confirmation must match.")
  ).not.toBeVisible()
  await expect(page.getByText(/save requirements remaining/)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save preferences" })
  ).toBeDisabled()

  await expect
    .poll(() =>
      page.evaluate((buyerPubkey) => {
        return localStorage.getItem(
          `conduit:market-shopper-presets:v1:${buyerPubkey}`
        )
      }, buyerPubkey)
    )
    .toBeNull()

  await addressLine1.fill("12 St James Square")
  await page.getByLabel("City").fill("London")
  await page.getByLabel("Postal / ZIP code").fill("SW1Y 4LB")
  await expect(page.getByText("Ready to save", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Save preferences" }).click()
  await expect(
    page.getByText("Preset encrypted and saved on your relays.")
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByText("Encrypted on relays", { exact: true })
  ).toBeVisible()
})
