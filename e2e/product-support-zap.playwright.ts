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

async function seedSupportProduct(page: Page): Promise<void> {
  await page.evaluate(
    ({ address, dTag, pubkey, title, relayUrl }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            ["products", "profiles"],
            "readwrite"
          )
          const now = Date.now()
          transaction.objectStore("products").put({
            id: address,
            dTag,
            pubkey,
            title,
            summary: "A deterministic product-support browser fixture.",
            price: 21,
            priceSats: 21,
            currency: "SATS",
            sourcePrice: {
              amount: 21,
              currency: "SATS",
              normalizedCurrency: "SATS",
            },
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [
              {
                url: "https://blossom.conduit.market/support-fixture.png",
              },
            ],
            tags: ["support", "product"],
            publicZapEnabled: true,
            zapMessagePolicy: "generic_only",
            publicZapPolicyKnown: true,
            sourceRelayUrls: [relayUrl],
            eventId: "1".repeat(64),
            eventCreatedAt: Math.floor(now / 1_000),
            createdAt: now,
            updatedAt: now,
            cachedAt: now,
          })
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
      address: productAddress,
      dTag: productDTag,
      pubkey: merchantPubkey,
      title: productTitle,
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
  await page.addInitScript(() => {
    const targetWindow = window as typeof window & {
      __supportSignAttempts?: number
      __resolveSupportSign?: () => void
      nostr?: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
    }
    window.addEventListener("DOMContentLoaded", () => {
      const signer = targetWindow.nostr
      if (!signer) return
      const originalSignEvent = signer.signEvent.bind(signer)
      signer.signEvent = (event) => {
        targetWindow.__supportSignAttempts =
          (targetWindow.__supportSignAttempts ?? 0) + 1
        return new Promise((resolve, reject) => {
          targetWindow.__resolveSupportSign = () =>
            void originalSignEvent(event).then(resolve, reject)
        })
      }
    })
  })
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
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __supportSignAttempts?: number })
            .__supportSignAttempts ?? 0
      )
    )
    .toBe(1)

  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Preparing invoice…")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).not.toBeVisible()

  await page.evaluate(() => {
    ;(
      window as typeof window & { __resolveSupportSign?: () => void }
    ).__resolveSupportSign?.()
  })
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
