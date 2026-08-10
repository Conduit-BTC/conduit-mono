import { expect, test, type Page } from "@playwright/test"
import { nip19 } from "nostr-tools"

import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  installTestSigner,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const productDTag = "cnd-158-e2e-shirt"
const productId = `30402:${TEST_MERCHANT_PUBKEY}:${productDTag}`
const evidenceDir = process.env.CND158_EVIDENCE_DIR

async function seedCustomZapCheckout(page: Page): Promise<void> {
  await page.routeWebSocket(/.*/, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return
      try {
        const frame = JSON.parse(message) as unknown
        if (
          Array.isArray(frame) &&
          frame[0] === "REQ" &&
          typeof frame[1] === "string"
        ) {
          socket.send(JSON.stringify(["EOSE", frame[1]]))
        }
      } catch {
        // Ignore non-Nostr frames in the transport-only browser fixture.
      }
    })
  })

  await page.addInitScript(
    ({ merchantPubkey, canonicalProductId }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          items: [
            {
              productId: canonicalProductId,
              merchantPubkey,
              title: "Sick Shirt",
              price: 1_000,
              currency: "SATS",
              priceSats: 1_000,
              format: "digital",
              quantity: 1,
              stock: 5,
              publicZapEnabled: true,
              zapMessagePolicy: "custom",
              publicZapPolicyKnown: true,
            },
          ],
        })
      )
    },
    { merchantPubkey: TEST_MERCHANT_PUBKEY, canonicalProductId: productId }
  )

  await page.route("**/.well-known/lnurlp/merchant", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        callback: "https://example.com/lnurl/callback",
        minSendable: 1_000,
        maxSendable: 10_000_000,
        tag: "payRequest",
        allowsNostr: true,
        nostrPubkey: TEST_MERCHANT_PUBKEY,
        metadata: JSON.stringify([["text/plain", "CND-158 merchant"]]),
      }),
    })
  })
}

async function seedMerchantProfile(page: Page): Promise<void> {
  await page.evaluate((merchantPubkey) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("profiles", "readwrite")
        transaction.objectStore("profiles").put({
          pubkey: merchantPubkey,
          name: "CND-158 Merchant",
          lud16: "merchant@example.com",
          cachedAt: Date.now(),
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, TEST_MERCHANT_PUBKEY)
}

async function seedOrderHistory(page: Page, zapContent: string): Promise<void> {
  await page.evaluate(
    ({ buyerPubkey, merchantPubkey, canonicalProductId, content }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          const timestamp = Date.now()
          transaction.objectStore("orderLifecycles").put({
            orderId: "cnd158-browser-evidence-order",
            buyerPubkey,
            buyerIdentityKind: "signed_in",
            merchantPubkey,
            checkoutMode: "public_zap_as_shopper",
            publicZapSigner: "shopper",
            merchantLightningAddress: "merchant@example.com",
            items: [
              {
                productId: canonicalProductId,
                title: "Sick Shirt",
                format: "digital",
                quantity: 1,
                priceAtPurchase: 1_000,
                currency: "SATS",
              },
            ],
            itemSubtotalSats: 1_000,
            shippingCostSats: 0,
            totalSats: 1_000,
            totalMsats: 1_000_000,
            currency: "SATS",
            zapContent: content,
            zapTargetAddress: canonicalProductId,
            addressValidity: "not_required",
            shippingZoneEligibility: "not_required",
            orderDeliveryStatus: "sent",
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus: "sent",
            zapReceiptStatus: "observed",
            zapRequestId: "2".repeat(64),
            zapReceiptId: "3".repeat(64),
            phase: "in_progress",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    },
    {
      buyerPubkey: TEST_BUYER_PUBKEY,
      merchantPubkey: TEST_MERCHANT_PUBKEY,
      canonicalProductId: productId,
      content: zapContent,
    }
  )
}

async function expectHealthyPage(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toHaveText("")
  await expect(
    page.locator(
      "vite-error-overlay, [data-nextjs-dialog], #webpack-dev-server-client-overlay"
    )
  ).toHaveCount(0)
}

test("market shopper custom product zap note presentation is accessible at checkout and in seeded history", async ({
  page,
}) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`${message.text()} (${message.location().url})`)
    }
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await page.setViewportSize({ width: 1280, height: 900 })
  await installTestSigner(page, TEST_BUYER_PUBKEY, { relays: {} })
  await seedCustomZapCheckout(page)

  await page.goto(`${marketUrl}/products`)
  await expect(page.getByText("Catalog", { exact: true })).toBeVisible()
  await seedMerchantProfile(page)

  await page.goto(`${marketUrl}/checkout`)
  await expectHealthyPage(page)

  const shopperMode = page.getByRole("button", {
    name: /Public zap as shopper/i,
  })
  await expect(shopperMode).toBeEnabled()
  await shopperMode.click()

  const note = page.getByRole("textbox", {
    name: "Public zap note (optional)",
  })
  await expect(note).toBeVisible()
  await expect(note).toHaveAttribute(
    "aria-describedby",
    "zap-content-help zap-content-count"
  )
  await expect(page.locator("#zap-content-help")).toContainText(
    "Public zap receipts can expose this comment."
  )
  await note.fill("sick shirt 🔥")
  await expect(note).toHaveValue("sick shirt 🔥")
  await expect(page.locator("#zap-content-help")).toContainText(
    "also adds a public link to this product"
  )
  await expect(page.locator("#zap-content-count")).toHaveText(
    /^12\/\d+ note characters; product link reserved$/
  )

  await note.fill("")
  await expect(note).toHaveValue("")
  await expect(page.locator("#zap-content-count")).toHaveText(
    "0/280 characters"
  )
  await expect(page.locator("#zap-content-help")).not.toContainText(
    "adds a public link"
  )

  await note.fill("sick shirt 🔥")
  if (evidenceDir) {
    await note.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `${evidenceDir}/checkout-note-desktop.png`,
    })
  }

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(note).toBeVisible()
  const noteBox = await note.boundingBox()
  if (!noteBox) throw new Error("Zap note was not visible at phone width")
  expect(noteBox.x).toBeGreaterThanOrEqual(0)
  expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(375)
  if (evidenceDir) {
    await note.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `${evidenceDir}/checkout-note-phone.png`,
      fullPage: true,
    })
  }

  const productNaddr = nip19.naddrEncode({
    kind: 30402,
    pubkey: TEST_MERCHANT_PUBKEY,
    identifier: productDTag,
    relays: [],
  })
  await seedOrderHistory(page, `sick shirt 🔥\n\nnostr:${productNaddr}`)
  await page.goto(`${marketUrl}/orders?order=cnd158-browser-evidence-order`)
  await expect(
    page.getByRole("heading", { name: "Public zap note" })
  ).toBeVisible()
  await expect(page.locator("blockquote")).toContainText("sick shirt 🔥")
  await expect(
    page.getByRole("link", { name: "View zapped product" })
  ).toBeVisible()
  await expect(page.getByRole("status")).toContainText(
    "Public receipt observed"
  )
  await expectHealthyPage(page)
  if (evidenceDir) {
    await page.screenshot({
      path: `${evidenceDir}/order-history-note-phone.png`,
      fullPage: true,
    })
  }

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
