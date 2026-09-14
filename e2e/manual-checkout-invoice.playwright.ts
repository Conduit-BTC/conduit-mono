import { expect, test } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  publishTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("signed-in checkout switches from browser wallet to manual and shows its zap invoice without merchant approval @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const buyerSecret = generateSecretKey()
  const buyerPubkey = getPublicKey(buyerSecret)
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const productCoordinate = `30402:${merchantPubkey}:manual-zap-invoice`
  const createdAt = Math.floor(Date.now() / 1_000)
  let walletSendCalls = 0
  let callbackRequests = 0
  let generatedInvoice = ""

  // Only the isolated relay may carry fixture events. No external wallet is
  // connected; a payment invocation is a test failure, not a payment attempt.
  await page.routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).origin === new URL(TEST_RELAY_URL).origin)
      socket.connectToServer()
    else socket.close()
  })
  await page.exposeFunction("__unexpectedWalletSend", () => {
    walletSendCalls += 1
    throw new Error("Manual checkout must not invoke the automatic wallet")
  })
  await page.addInitScript(() => {
    Object.defineProperty(window, "webln", {
      configurable: true,
      value: {
        async enable() {},
        async sendPayment() {
          return (
            window as unknown as {
              __unexpectedWalletSend: () => Promise<never>
            }
          ).__unexpectedWalletSend()
        },
      },
    })
  })
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/product.png") {
      await route.fulfill({ status: 204 })
      return
    }
    if (url.pathname === "/callback") {
      callbackRequests += 1
      expect(url.searchParams.get("amount")).toBe("1000000")
      const signedZap = url.searchParams.get("nostr")
      expect(signedZap).not.toBeNull()
      expect(JSON.parse(signedZap!)).toMatchObject({
        kind: 9734,
        pubkey: buyerPubkey,
      })
      generatedInvoice = makeBolt11Fixture({
        hrp: "lnbc10u",
        createdAt,
        fields: [
          bolt11PaymentHashField(),
          bolt11DescriptionHashField(signedZap!),
        ],
      })
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ pr: generatedInvoice, routes: [] }),
      })
      return
    }
    expect(url.pathname).toBe("/.well-known/lnurlp/merchant")
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: "https://merchant-fixture.dev/callback",
        minSendable: 1_000,
        maxSendable: 10_000_000,
        allowsNostr: true,
        nostrPubkey: merchantPubkey,
        metadata: JSON.stringify([["text/plain", "Synthetic merchant"]]),
      }),
    })
  })
  await seedTestRelayIdentity(buyerSecret)
  await seedTestRelayIdentity(merchantSecret)
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt + 1,
        tags: [],
        content: JSON.stringify({
          name: "Synthetic invoice merchant",
          lud16: "merchant@merchant-fixture.dev",
        }),
      },
      merchantSecret
    ),
    finalizeEvent(
      {
        kind: 30402,
        created_at: createdAt,
        tags: [
          ["d", "manual-zap-invoice"],
          ["title", "Synthetic manual invoice product"],
          ["price", "1000", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "3"],
          ["image", "https://merchant-fixture.dev/product.png"],
          ["checkout_public_zaps", "true"],
          ["checkout_zap_message_policy", "generic_only"],
        ],
        content: "Synthetic digital product for manual invoice regression.",
      },
      merchantSecret
    ),
  ])
  await installTestSigner(page, buyerPubkey, { secretKey: buyerSecret })
  await page.goto(`${marketUrl}/products/${productCoordinate}`)
  await page.getByRole("button", { name: "Add 1 to cart", exact: true }).click()

  await page.goto(`${marketUrl}/checkout?merchant=${merchantPubkey}`)
  await expect(
    page.getByRole("heading", { name: "Send Order", exact: true })
  ).toBeVisible()
  const paymentTarget = page.getByRole("combobox", { name: "Pay with" })
  await expect(paymentTarget).toContainText("Browser wallet (WebLN)")
  await expect(
    page.getByRole("button", { name: "Hold to zap out", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
  await paymentTarget.click()
  await page
    .getByRole("option", {
      name: "Show invoice for manual payment",
      exact: true,
    })
    .click()
  await page.getByRole("button", { name: /^Public zap as shopper/ }).click()
  const submit = page.getByRole("button", {
    name: "Hold to send order and show invoice",
    exact: true,
  })
  await expect(submit).toBeEnabled()
  await submit.focus()
  await page.keyboard.down("Space")
  await expect(submit).toHaveAttribute("data-hold-state", "charged")
  await page.keyboard.up("Space")

  await expect(page).toHaveURL(/\/orders\?order=/, { timeout: 30_000 })
  await expect(
    page.getByRole("heading", { name: "Pay with an external wallet" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Copy invoice", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Open in wallet", exact: true })
  ).toHaveAttribute("href", `lightning:${generatedInvoice}`)
  await expect(
    page.getByRole("button", { name: "Use merchant invoice", exact: true })
  ).toHaveCount(0)
  expect(callbackRequests).toBe(1)
  expect(walletSendCalls).toBe(0)
})
