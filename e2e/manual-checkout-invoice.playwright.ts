import { expect, test } from "@playwright/test"
import { nip44, nip59 } from "nostr-tools"
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

const scenarios: Array<{
  name: string
  mode: "private_checkout" | "public_zap_as_shopper"
  stop?: "cancelled" | "refund_requested"
  legacyPublicZap?: boolean
}> = [
  {
    name: "completes only for the exact public receipt",
    mode: "public_zap_as_shopper",
  },
  ...(["private_checkout", "public_zap_as_shopper"] as const).flatMap((mode) =>
    (["cancelled", "refund_requested"] as const).map((stop) => ({
      name: `blocks ${mode} payment after ${stop}, including reload`,
      mode,
      stop,
    }))
  ),
  ...(["cancelled", "refund_requested"] as const).map((stop) => ({
    name: `blocks legacy public_zap payment after ${stop}, including reload`,
    mode: "public_zap_as_shopper" as const,
    stop,
    legacyPublicZap: true,
  })),
]

for (const scenario of scenarios) {
  test(`signed-in manual checkout ${scenario.name} @market`, async ({
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
    let signedZapRequest = ""
    const lnurlMetadata = JSON.stringify([["text/plain", "Synthetic merchant"]])
    let invalidReceiptId = ""
    let invalidReceiptDeliveries = 0

    // Only the isolated relay may carry fixture events. No external wallet is
    // connected; a payment invocation is a test failure, not a payment attempt.
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).origin !== new URL(TEST_RELAY_URL).origin) {
        socket.close()
        return
      }
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString())
        if (frame[0] === "EVENT" && frame[2]?.id === invalidReceiptId) {
          invalidReceiptDeliveries += 1
        }
        socket.send(message)
      })
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
        if (scenario.mode === "public_zap_as_shopper") {
          expect(signedZap).not.toBeNull()
          expect(JSON.parse(signedZap!)).toMatchObject({
            kind: 9734,
            pubkey: buyerPubkey,
          })
        } else {
          expect(signedZap).toBeNull()
        }
        signedZapRequest = signedZap ?? ""
        generatedInvoice = makeBolt11Fixture({
          hrp: "lnbc10u",
          createdAt,
          fields: [
            bolt11PaymentHashField(),
            bolt11DescriptionHashField(signedZap ?? lnurlMetadata),
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
          metadata: lnurlMetadata,
        }),
      })
    })
    await seedTestRelayIdentity(buyerSecret)
    await seedTestRelayIdentity(merchantSecret)
    await publishTestRelayEvents([
      finalizeEvent(
        {
          kind: 0,
          // Follow the seed profile even when setup crosses a second boundary.
          created_at: Math.floor(Date.now() / 1_000) + 1,
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
    // Synthetic keys exercise real NIP-44 sealing and unwrapping on the local
    // relay. They never connect to a real wallet or public relay.
    await page.exposeFunction(
      "__syntheticEncrypt",
      (peer: string, text: string) =>
        nip44.v2.encrypt(
          text,
          nip44.v2.utils.getConversationKey(buyerSecret, peer)
        )
    )
    await page.exposeFunction(
      "__syntheticDecrypt",
      (peer: string, text: string) =>
        nip44.v2.decrypt(
          text,
          nip44.v2.utils.getConversationKey(buyerSecret, peer)
        )
    )
    await page.addInitScript(() => {
      const syntheticWindow = window as unknown as {
        nostr: {
          nip44: {
            encrypt: (peer: string, text: string) => Promise<string>
            decrypt: (peer: string, text: string) => Promise<string>
          }
        }
        __syntheticEncrypt: (peer: string, text: string) => Promise<string>
        __syntheticDecrypt: (peer: string, text: string) => Promise<string>
      }
      syntheticWindow.nostr.nip44 = {
        encrypt: (peer, text) => syntheticWindow.__syntheticEncrypt(peer, text),
        decrypt: (peer, text) => syntheticWindow.__syntheticDecrypt(peer, text),
      }
    })
    await page.goto(`${marketUrl}/products/${productCoordinate}`)
    await page
      .getByRole("button", { name: "Add 1 to cart", exact: true })
      .click()

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
    await page
      .getByRole("button", {
        name:
          scenario.mode === "private_checkout"
            ? /^Private invoice/
            : /^Public zap as shopper/,
      })
      .click()
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
      page.getByRole("link", { name: "Open Lightning wallet", exact: true })
    ).toHaveAttribute("href", `lightning:${generatedInvoice}`)
    await expect(
      page.getByRole("button", { name: "Use merchant invoice", exact: true })
    ).toHaveCount(0)
    expect(callbackRequests).toBe(1)
    expect(walletSendCalls).toBe(0)

    const orderId = new URL(page.url()).searchParams.get("order")!
    if (scenario.legacyPublicZap) {
      // Older saved public zaps identify the signer through checkoutMode only.
      // Keep the actual checkout invoice and zap request for receipt matching.
      await page.evaluate(async (id) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("conduit")
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
        try {
          await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(
              "orderLifecycles",
              "readwrite"
            )
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
            const store = transaction.objectStore("orderLifecycles")
            const request = store.get(id)
            request.onsuccess = () => {
              const lifecycle = request.result
              lifecycle.checkoutMode = "public_zap"
              delete lifecycle.publicZapSigner
              store.put(lifecycle)
            }
          })
        } finally {
          database.close()
        }
      }, orderId)
      await page.reload()
      await expect(
        page.getByRole("heading", { name: "Orders", exact: true })
      ).toBeVisible()
    }
    const paymentState = async () => {
      const { checkoutMode, publicZapSigner, ...state } = await page.evaluate(
        async (id) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("conduit")
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
          })
          try {
            const lifecycle = await new Promise<Record<string, unknown>>(
              (resolve, reject) => {
                const request = database
                  .transaction("orderLifecycles", "readonly")
                  .objectStore("orderLifecycles")
                  .get(id)
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
              }
            )
            return {
              checkoutMode: lifecycle.checkoutMode,
              publicZapSigner: lifecycle.publicZapSigner,
              paymentStatus: lifecycle.paymentStatus,
              zapReceiptStatus: lifecycle.zapReceiptStatus,
              zapReceiptId: lifecycle.zapReceiptId ?? null,
              proofDeliveryStatus: lifecycle.proofDeliveryStatus,
            }
          } finally {
            database.close()
          }
        },
        orderId
      )
      if (scenario.legacyPublicZap) {
        expect(checkoutMode).toBe("public_zap")
        expect(publicZapSigner).toBeUndefined()
      }
      return state
    }
    if (scenario.legacyPublicZap) await paymentState()
    if (scenario.stop) {
      const stopStatus = scenario.stop
      const stopEvent = nip59.wrapEvent(
        {
          kind: 16,
          created_at: Math.floor(Date.now() / 1000) + 1,
          tags: [
            ["p", buyerPubkey],
            ["type", "status_update"],
            ["order", orderId],
            ["status", stopStatus],
          ],
          content: JSON.stringify({
            orderId,
            merchantPubkey,
            buyerPubkey,
            status: stopStatus,
          }),
        },
        merchantSecret,
        buyerPubkey
      )
      await publishTestRelayEvents([stopEvent])
      await page.getByRole("button", { name: "Refresh", exact: true }).click()
      const expectStoppedInvoice = async () => {
        await expect(
          page.getByText("Order no longer accepts payment", { exact: true })
        ).toBeVisible()
        await expect(
          page.getByRole("button", { name: "Copy invoice", exact: true })
        ).toHaveCount(0)
        await expect(
          page.getByRole("link", { name: "Open Lightning wallet", exact: true })
        ).toHaveCount(0)
        await expect(page.locator('a[href^="lightning:"]')).toHaveCount(0)
        await expect(
          page.getByText(generatedInvoice, { exact: true })
        ).toHaveCount(0)
        const state = await paymentState()
        expect(state.paymentStatus).toBe("manual_required")
        expect(state.proofDeliveryStatus).toBe("not_started")
        expect(callbackRequests).toBe(1)
        expect(walletSendCalls).toBe(0)
      }
      await expectStoppedInvoice()
      await page.reload()
      await expect(
        page.getByRole("heading", { name: "Orders", exact: true })
      ).toBeVisible()
      await expectStoppedInvoice()
      if (scenario.mode === "private_checkout") {
        await page
          .getByRole("button", {
            name: "Report a payment already made",
            exact: true,
          })
          .click()
        await expect.poll(paymentState, { timeout: 20_000 }).toMatchObject({
          paymentStatus: "paid",
          proofDeliveryStatus: "sent",
          zapReceiptId: null,
        })
        await expect(
          page
            .getByText(
              stopStatus === "cancelled" ? "Cancelled" : "Refund requested",
              { exact: true }
            )
            .first()
        ).toBeVisible()
        expect(callbackRequests).toBe(1)
        expect(walletSendCalls).toBe(0)
        return
      }
      await expect(
        page.getByRole("button", {
          name: "Report a payment already made",
          exact: true,
        })
      ).toHaveCount(0)
    }
    const receipt = (invoice: string) =>
      finalizeEvent(
        {
          kind: 9735,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          tags: [
            ["p", merchantPubkey],
            ["P", buyerPubkey],
            ["bolt11", invoice],
            ["description", signedZapRequest],
          ],
        },
        merchantSecret
      )
    const unrelatedInvoice = makeBolt11Fixture({
      hrp: "lnbc10u",
      createdAt,
      fields: [
        bolt11PaymentHashField(new Uint8Array(32).fill(8)),
        bolt11DescriptionHashField(signedZapRequest),
      ],
    })
    const invalidReceipt = receipt(unrelatedInvoice)
    invalidReceiptId = invalidReceipt.id
    await publishTestRelayEvents([invalidReceipt])
    // Observe the real receipt poll returning the wrong invoice more than once.
    await expect
      .poll(() => invalidReceiptDeliveries, { timeout: 8000 })
      .toBeGreaterThanOrEqual(2)
    const unpaidState = await paymentState()
    expect(unpaidState.paymentStatus).toBe("manual_required")
    expect(unpaidState.zapReceiptId).toBeNull()
    expect(unpaidState.proofDeliveryStatus).toBe("not_started")
    const copyInvoice = page.getByRole("button", {
      name: "Copy invoice",
      exact: true,
    })
    if (scenario.stop) await expect(copyInvoice).toHaveCount(0)
    else await expect(copyInvoice).toBeVisible()

    const exactReceipt = receipt(generatedInvoice)
    await publishTestRelayEvents([exactReceipt])
    await expect.poll(paymentState, { timeout: 20_000 }).toEqual({
      paymentStatus: "paid",
      zapReceiptStatus: "observed",
      zapReceiptId: exactReceipt.id,
      proofDeliveryStatus: "sent",
    })
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toHaveCount(0)
    if (scenario.stop) {
      await expect(
        page
          .getByText(
            scenario.stop === "cancelled" ? "Cancelled" : "Refund requested",
            { exact: true }
          )
          .first()
      ).toBeVisible()
    }
    expect(callbackRequests).toBe(1)
    expect(walletSendCalls).toBe(0)
  })
}
