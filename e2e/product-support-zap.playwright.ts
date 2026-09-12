import { expect, test, type Page } from "@playwright/test"
import { nip19 } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  installTestSigner,
  publishTestRelayEvents,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const merchantSecretKey = generateSecretKey()
const merchantPubkey = getPublicKey(merchantSecretKey)
const buyerSecretKey = generateSecretKey()
const buyerPubkey = getPublicKey(buyerSecretKey)
const receiptPubkey = getPublicKey(generateSecretKey())
const productDTag = "support-dialog-cancellation"
const productAddress = `30402:${merchantPubkey}:${productDTag}`
const productTitle = "Support dialog cancellation fixture"
const productUrl = `${marketUrl}/products/${nip19.naddrEncode({
  kind: 30_402,
  pubkey: merchantPubkey,
  identifier: productDTag,
  relays: [],
})}`

type SupportSignerWindow = typeof window & {
  __supportSignAttempts?: number
  __supportSignSettled?: boolean
  __resolveSupportSign?: () => void
  nostr?: {
    signEvent: (
      event: Record<string, unknown>
    ) => Promise<Record<string, unknown>>
  }
}

async function installStalledSupportSigner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const targetWindow = window as SupportSignerWindow
      const signer = targetWindow.nostr
      if (!signer) return
      const originalSignEvent = signer.signEvent.bind(signer)
      signer.signEvent = (event) => {
        targetWindow.__supportSignAttempts =
          (targetWindow.__supportSignAttempts ?? 0) + 1
        targetWindow.__supportSignSettled = false
        return new Promise((resolve, reject) => {
          targetWindow.__resolveSupportSign = () =>
            void originalSignEvent(event).then((signedEvent) => {
              targetWindow.__supportSignSettled = true
              resolve(signedEvent)
            }, reject)
        })
      }
    })
  })
}

async function waitForSupportSignAttempt(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as SupportSignerWindow).__supportSignAttempts ?? 0
      )
    )
    .toBe(1)
}

async function releaseSupportSign(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as SupportSignerWindow).__resolveSupportSign?.()
  })
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as SupportSignerWindow).__supportSignSettled ?? false
      )
    )
    .toBe(true)
}

let productRevisionTime = Math.floor(Date.now() / 1_000)

async function publishSupportProduct(
  extraTags: string[][] = []
): Promise<void> {
  productRevisionTime = Math.max(
    productRevisionTime + 1,
    Math.floor(Date.now() / 1_000)
  )
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 30402,
        created_at: productRevisionTime,
        tags: [
          ["d", productDTag],
          ["title", productTitle],
          ["price", "21", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "1"],
          ["image", "https://blossom.conduit.market/support-fixture.png"],
          ...extraTags,
        ],
        content: "A deterministic product-support browser fixture.",
      },
      merchantSecretKey
    ),
  ])
}

async function seedSupportProduct(
  page: Page,
  extraTags: string[][] = []
): Promise<void> {
  // Routing evidence must come from the signed listing, never a cache seed.
  await publishSupportProduct(extraTags)
  await page.evaluate(
    ({ pubkey, relayUrl }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            ["products", "profiles"],
            "readwrite"
          )
          const now = Date.now()
          transaction.objectStore("profiles").put({
            pubkey,
            displayName: "Support Merchant",
            lud16: "support@merchant-fixture.dev",
            rawContent: JSON.stringify({
              display_name: "Support Merchant",
              lud16: "support@merchant-fixture.dev",
            }),
            eventId: "2".repeat(64),
            eventCreatedAt: 1,
            sourceRelayUrls: [relayUrl],
            cachedAt: now,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      pubkey: merchantPubkey,
      relayUrl: TEST_RELAY_URL,
    }
  )
}

test("a stalled product-support signer can be dismissed without retaining a late result @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({
          display_name: "Support Merchant",
          lud16: "support@merchant-fixture.dev",
        }),
      },
      merchantSecretKey
    ),
  ])
  await installTestSigner(page, buyerPubkey, { secretKey: buyerSecretKey })
  await installStalledSupportSigner(page)
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: "https://merchant-fixture.dev/callback",
        minSendable: 1_000,
        maxSendable: 100_000_000,
        allowsNostr: true,
        nostrPubkey: receiptPubkey,
        metadata: JSON.stringify([["text/plain", "support"]]),
      }),
    })
  })

  await page.goto(`${marketUrl}/products`)
  await seedSupportProduct(page)
  await page.goto(productUrl)
  await expect(page.getByRole("heading", { name: productTitle })).toBeVisible()
  await page.getByRole("button", { name: "Support product" }).click()
  await page.getByRole("button", { name: "Create zap invoice" }).click()
  await waitForSupportSignAttempt(page)

  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Preparing invoice…")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).not.toBeVisible()

  await releaseSupportSign(page)
  await page.waitForTimeout(100)
  await page.getByRole("button", { name: "Support product" }).click()
  await expect(page.getByRole("dialog")).not.toContainText("Invoice ready")
  await expect(page.getByRole("dialog")).not.toContainText(
    "product support target changed"
  )
  await expect(
    page.getByRole("button", { name: "Create zap invoice" })
  ).toBeEnabled()
})

test("leaving the product route stops a stalled support request before the provider callback @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({
          display_name: "Support Merchant",
          lud16: "support@merchant-fixture.dev",
        }),
      },
      merchantSecretKey
    ),
  ])
  await installTestSigner(page, buyerPubkey, { secretKey: buyerSecretKey })
  await installStalledSupportSigner(page)
  let callbackRequests = 0
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/callback") {
      callbackRequests += 1
      await route.abort()
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: "https://merchant-fixture.dev/callback",
        minSendable: 1_000,
        maxSendable: 100_000_000,
        allowsNostr: true,
        nostrPubkey: receiptPubkey,
        metadata: JSON.stringify([["text/plain", "support"]]),
      }),
    })
  })

  await page.goto(`${marketUrl}/products`)
  await seedSupportProduct(page)
  await page.goto(productUrl)
  await page.getByRole("button", { name: "Support product" }).click()
  await page.getByRole("button", { name: "Create zap invoice" }).click()
  await waitForSupportSignAttempt(page)

  await page
    .locator('a[href="/products"]')
    .first()
    .evaluate((link) => {
      ;(link as HTMLAnchorElement).click()
    })
  await expect(page).toHaveURL(/\/products\/?$/)

  await releaseSupportSign(page)
  await page.waitForTimeout(100)
  expect(callbackRequests).toBe(0)
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`an unpaid support invoice has readable status in ${colorScheme} theme @market`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000)
    await page.emulateMedia({ colorScheme })
    await publishTestRelayEvents([
      finalizeEvent(
        {
          kind: 0,
          created_at: Math.floor(Date.now() / 1_000),
          tags: [],
          content: JSON.stringify({
            display_name: "Support Merchant",
            lud16: "support@merchant-fixture.dev",
          }),
        },
        merchantSecretKey
      ),
    ])
    await installTestSigner(page, buyerPubkey, { secretKey: buyerSecretKey })
    let callbackRequests = 0
    await page.route("https://merchant-fixture.dev/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/callback") {
        callbackRequests += 1
        const request = url.searchParams.get("nostr") ?? ""
        const zap = JSON.parse(request)
        expect(zap.kind === 9734 && zap.content === "Public fixture note").toBe(
          true
        )
        expect(
          zap.tags.some(
            (tag: string[]) => tag[0] === "a" && tag[1] === productAddress
          )
        ).toBe(true)
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            pr: makeBolt11Fixture({
              hrp: "lnbc210n",
              createdAt: Math.floor(Date.now() / 1_000),
              fields: [
                bolt11PaymentHashField(),
                bolt11DescriptionHashField(request),
              ],
            }),
          }),
        })
        return
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tag: "payRequest",
          callback: "https://merchant-fixture.dev/callback",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          allowsNostr: true,
          nostrPubkey: receiptPubkey,
          metadata: JSON.stringify([["text/plain", "support"]]),
        }),
      })
    })

    await page.goto(`${marketUrl}/products`)
    await seedSupportProduct(page)
    await page.goto(productUrl)
    await page.getByRole("button", { name: "Support product" }).click()
    await page.getByLabel("Public note (optional)").fill("Public fixture note")
    await page.getByRole("button", { name: "Create zap invoice" }).click()
    const status = page.getByRole("status").filter({ hasText: "Invoice ready" })
    await expect(status).toHaveText(
      "Invoice ready. Conduit has not sent or confirmed a payment."
    )
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      colorScheme === "light" ? "day-market" : "night-market"
    )
    await expect(
      page.getByRole("link", { name: "Open in wallet" })
    ).toBeVisible()
    expect(callbackRequests).toBe(1)
    // Capture only the state message; never attach invoice or request material.
    await status.screenshot({ path: testInfo.outputPath("invoice-status.png") })
    if (colorScheme === "light") {
      const refreshButton = page.locator(
        'button[aria-label="Refresh"], button[aria-label="May be out of date"], button[aria-label="Updated"]'
      )
      // A complete refresh of the same signed listing changes only the
      // observation time. It must not discard the already prepared invoice.
      await refreshButton.evaluate((button) => {
        ;(button as HTMLButtonElement).click()
      })
      await expect(page.locator('button[aria-label="Updated"]')).toBeVisible()
      await expect(status).toHaveText(
        "Invoice ready. Conduit has not sent or confirmed a payment."
      )
      await expect(
        page.getByRole("link", { name: "Open in wallet" })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Copy invoice", exact: true })
      ).toBeVisible()
      expect(callbackRequests).toBe(1)

      await publishSupportProduct([["zap", receiptPubkey, TEST_RELAY_URL]])
      // Exercise an existing background refresh while preserving the open dialog.
      await refreshButton.evaluate((button) => {
        ;(button as HTMLButtonElement).click()
      })
      await expect(page.getByRole("dialog")).toContainText("custom zap routing")
      await expect(
        page.getByRole("link", { name: "Open in wallet" })
      ).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "Copy invoice", exact: true })
      ).toHaveCount(0)
      await expect(page.getByRole("dialog")).not.toContainText("Invoice ready")
      expect(callbackRequests).toBe(1)
    }
  })
}

test("a signed custom zap route is unavailable before support signer or provider work @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await installTestSigner(page, buyerPubkey, { secretKey: buyerSecretKey })
  await installStalledSupportSigner(page)
  let providerRequests = 0
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    providerRequests += 1
    await route.abort()
  })
  await page.goto(`${marketUrl}/products`)
  await seedSupportProduct(page, [["zap", receiptPubkey, TEST_RELAY_URL, "1"]])
  await page.goto(productUrl)
  await expect(page.getByRole("heading", { name: productTitle })).toBeVisible()
  await expect(
    page.getByText("This product uses custom zap routing", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Support product" })
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => (window as SupportSignerWindow).__supportSignAttempts ?? 0
    )
  ).toBe(0)
  expect(providerRequests).toBe(0)
})
