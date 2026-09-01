import { expect, test, type Locator, type Page } from "@playwright/test"
import { nip19 } from "@nostr-dev-kit/ndk"

import { installTestSigner, TEST_MERCHANT_PUBKEY } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`
const PARENT_D_TAG = "shareable-pocket-relay"
const BLUE_D_TAG = "shareable-pocket-relay-blue"
const RED_D_TAG = "shareable-pocket-relay-red"
const PARENT_ADDRESS = `30402:${TEST_MERCHANT_PUBKEY}:${PARENT_D_TAG}`
const BLUE_ADDRESS = `30402:${TEST_MERCHANT_PUBKEY}:${BLUE_D_TAG}`
const RED_ADDRESS = `30402:${TEST_MERCHANT_PUBKEY}:${RED_D_TAG}`
const PARENT_TITLE = "Shareable Pocket Relay"
const RED_TITLE = "Shareable Pocket Relay — Red"

function productUrl(addressId: string): string {
  const [, pubkey, ...dTagParts] = addressId.split(":")
  return `${marketUrl}/products/${nip19.naddrEncode({
    kind: 30_402,
    pubkey: pubkey!,
    identifier: dTagParts.join(":"),
    relays: [],
  })}`
}

const PARENT_URL = productUrl(PARENT_ADDRESS)
const RED_URL = productUrl(RED_ADDRESS)

async function installShareCaptures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const targetWindow = window as typeof window & {
      __clipboardAttempts?: number
      __clipboardShouldReject?: boolean
      __copiedProductUrl?: string
      __nativeShareAttempts?: number
      __nativeShareOutcome?: "resolve" | "cancel" | "reject"
      __sharedProductPayload?: ShareData
    }
    targetWindow.__clipboardAttempts = 0
    targetWindow.__clipboardShouldReject = false
    targetWindow.__nativeShareAttempts = 0
    targetWindow.__nativeShareOutcome = "resolve"

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value: string) {
          targetWindow.__clipboardAttempts =
            (targetWindow.__clipboardAttempts ?? 0) + 1
          if (targetWindow.__clipboardShouldReject) {
            throw new DOMException("Unavailable", "NotAllowedError")
          }
          targetWindow.__copiedProductUrl = value
        },
      },
    })
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        targetWindow.__nativeShareAttempts =
          (targetWindow.__nativeShareAttempts ?? 0) + 1
        targetWindow.__sharedProductPayload = structuredClone(data)
        if (targetWindow.__nativeShareOutcome === "cancel") {
          throw new DOMException("Cancelled", "AbortError")
        }
        if (targetWindow.__nativeShareOutcome === "reject") {
          throw new DOMException("Unavailable", "NotAllowedError")
        }
      },
    })
  })
}

async function seedCachedProductFamily(page: Page): Promise<void> {
  await page.evaluate(
    ({
      parentAddress,
      blueAddress,
      redAddress,
      merchantPubkey,
      parentDTag,
      blueDTag,
      redDTag,
      parentTitle,
      redTitle,
    }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("products", "readwrite")
          const timestamp = Date.now()
          const common = {
            pubkey: merchantPubkey,
            summary: "A deterministic product-share browser fixture.",
            currency: "SATS",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [
              {
                url: "https://blossom.conduit.market/shareable-product.png",
              },
            ],
            tags: ["share", "product"],
            publicZapEnabled: true,
            zapMessagePolicy: "generic_only",
            publicZapPolicyKnown: true,
            sourceRelayUrls: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            cachedAt: timestamp,
          }
          const products = [
            {
              ...common,
              id: parentAddress,
              dTag: parentDTag,
              title: parentTitle,
              price: 21,
              priceSats: 21,
              sourcePrice: {
                amount: 21,
                currency: "SATS",
                normalizedCurrency: "SATS",
              },
              type: "variable",
              specifications: [],
              eventId: "1".repeat(64),
              eventCreatedAt: 100,
            },
            {
              ...common,
              id: blueAddress,
              dTag: blueDTag,
              title: "Shareable Pocket Relay — Blue",
              price: 25,
              priceSats: 25,
              sourcePrice: {
                amount: 25,
                currency: "SATS",
                normalizedCurrency: "SATS",
              },
              type: "variation",
              parentProductId: parentAddress,
              specifications: [{ key: "color", value: "Blue" }],
              eventId: "2".repeat(64),
              eventCreatedAt: 101,
            },
            {
              ...common,
              id: redAddress,
              dTag: redDTag,
              title: redTitle,
              price: 30,
              priceSats: 30,
              sourcePrice: {
                amount: 30,
                currency: "SATS",
                normalizedCurrency: "SATS",
              },
              type: "variation",
              parentProductId: parentAddress,
              specifications: [{ key: "color", value: "Red" }],
              eventId: "3".repeat(64),
              eventCreatedAt: 102,
            },
          ]
          const store = transaction.objectStore("products")
          for (const product of products) store.put(product)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      parentAddress: PARENT_ADDRESS,
      blueAddress: BLUE_ADDRESS,
      redAddress: RED_ADDRESS,
      merchantPubkey: TEST_MERCHANT_PUBKEY,
      parentDTag: PARENT_D_TAG,
      blueDTag: BLUE_D_TAG,
      redDTag: RED_D_TAG,
      parentTitle: PARENT_TITLE,
      redTitle: RED_TITLE,
    }
  )
}

async function copiedProductUrl(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () =>
      (window as typeof window & { __copiedProductUrl?: string })
        .__copiedProductUrl
  )
}

async function clipboardAttempts(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __clipboardAttempts?: number })
        .__clipboardAttempts ?? 0
  )
}

async function nativeShareAttempts(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __nativeShareAttempts?: number })
        .__nativeShareAttempts ?? 0
  )
}

async function sharedProductPayload(
  page: Page
): Promise<ShareData | undefined> {
  return page.evaluate(
    () =>
      (window as typeof window & { __sharedProductPayload?: ShareData })
        .__sharedProductPayload
  )
}

async function getShareStatus(
  page: Page,
  shareButton: Locator
): Promise<Locator> {
  const describedBy = await shareButton.getAttribute("aria-describedby")
  const statusId = describedBy?.trim().split(/\s+/).at(-1)
  if (!statusId) throw new Error("Share button is missing its status region.")
  return page.locator(`[id="${statusId}"]`)
}

async function getStableShareButton(
  page: Page,
  accessibleName: string
): Promise<Locator> {
  const namedButton = page.getByRole("button", { name: accessibleName })
  await expect(namedButton).toBeVisible()
  const describedBy = await namedButton.getAttribute("aria-describedby")
  const statusId = describedBy?.trim().split(/\s+/).at(-1)
  if (!statusId) throw new Error("Share button is missing its status region.")
  return page.locator(`button[aria-describedby~="${statusId}"]`)
}

async function openRedMarketVariation(page: Page): Promise<Locator> {
  await page.goto(`${marketUrl}/products`)
  await expect(
    page.getByRole("textbox", { name: "Search products" })
  ).toBeVisible()
  await seedCachedProductFamily(page)
  await page.goto(RED_URL)
  await expect(page.getByRole("heading", { name: PARENT_TITLE })).toBeVisible()
  await expect(
    page.getByRole("combobox", { name: "Choose color" })
  ).toContainText("Red")
  return getStableShareButton(page, `Share ${RED_TITLE}`)
}

test("shopper copies the exact selected variation link @market", async ({
  page,
}) => {
  await installShareCaptures(page)
  const share = await openRedMarketVariation(page)

  await share.click()

  await expect(share).toContainText("Copied")
  await expect.poll(() => copiedProductUrl(page)).toBe(RED_URL)
})

test("mobile share cancellation and fresh-gesture copy fallback stay honest @market", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installShareCaptures(page)
  const share = await openRedMarketVariation(page)
  const status = await getShareStatus(page, share)

  await share.click()
  await expect(share).toContainText("Shared")
  await expect(status).toHaveText(`${RED_TITLE} link shared.`)
  expect(await nativeShareAttempts(page)).toBe(1)
  expect(await sharedProductPayload(page)).toEqual({
    title: RED_TITLE,
    text: `View ${RED_TITLE} on Conduit Market.`,
    url: RED_URL,
  })
  expect(await clipboardAttempts(page)).toBe(0)
  await expect(share).toHaveText("Share", { timeout: 3_000 })

  await page.evaluate(() => {
    const targetWindow = window as typeof window & {
      __nativeShareOutcome?: string
    }
    targetWindow.__nativeShareOutcome = "cancel"
  })
  await share.click()
  await expect(share).toHaveText("Share")
  await expect(status).toHaveText("")
  expect(await nativeShareAttempts(page)).toBe(2)
  expect(await clipboardAttempts(page)).toBe(0)

  await page.evaluate(() => {
    const targetWindow = window as typeof window & {
      __nativeShareOutcome?: string
      __clipboardShouldReject?: boolean
    }
    targetWindow.__nativeShareOutcome = "reject"
    targetWindow.__clipboardShouldReject = true
  })
  await share.click()
  await expect(share).toContainText("Copy link")
  await expect(status).toContainText("Sharing was unavailable")
  expect(await nativeShareAttempts(page)).toBe(3)
  expect(await clipboardAttempts(page)).toBe(0)

  await share.click()
  await expect(share).toContainText("Try copy again")
  expect(await nativeShareAttempts(page)).toBe(3)
  expect(await clipboardAttempts(page)).toBe(1)
  await page.waitForTimeout(2_000)
  await expect(share).toContainText("Try copy again")

  await page.evaluate(() => {
    const targetWindow = window as typeof window & {
      __clipboardShouldReject?: boolean
    }
    targetWindow.__clipboardShouldReject = false
  })
  await share.click()
  await expect(share).toContainText("Copied")
  expect(await nativeShareAttempts(page)).toBe(3)
  await expect.poll(() => copiedProductUrl(page)).toBe(RED_URL)
})

test("merchant copies the buyer-facing parent product link @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await installShareCaptures(page)
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await seedCachedProductFamily(page)
  await page.reload()

  await expect(page.getByText(PARENT_TITLE, { exact: true })).toBeVisible()
  const share = await getStableShareButton(page, `Share ${PARENT_TITLE}`)
  await share.click()

  await expect(share).toContainText("Copied")
  await expect.poll(() => copiedProductUrl(page)).toBe(PARENT_URL)
  expect(await copiedProductUrl(page)).not.toBe(RED_URL)
})
