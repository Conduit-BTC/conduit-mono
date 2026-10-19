import { expect, test } from "@playwright/test"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
test.use({ trace: "off", screenshot: "off", video: "off" })

declare global {
  interface Window {
    __invoiceSourceConversations: unknown[]
    __invoiceSourceFixture: {
      setReceiving: (id: string | null) => void
      receiving: string | null
    }
  }
}

for (const choice of ["untouched", "manual", "profile"] as const) {
  test(`late receiving default respects ${choice} invoice source @merchant`, async ({
    page,
  }) => {
    const merchant = createRuntimeSignerIdentity()
    const buyer = createRuntimeSignerIdentity()
    try {
      const now = Math.floor(Date.now() / 1000)
      await publishTestRelayEvents(
        [0, 10002, 10050].map((kind) =>
          signRuntimeTestEvent(merchant, {
            kind,
            created_at: now,
            tags:
              kind === 10002
                ? [["r", TEST_RELAY_URL]]
                : kind === 10050
                  ? [["relay", TEST_RELAY_URL]]
                  : [],
            content: kind === 0 ? "{}" : "",
          })
        )
      )
      await installRealTestSigner(page, merchant, TEST_RELAY_URL)
      // Control only prepared inputs to the real Orders component. Its form,
      // selection/reset effect and shared Select run unchanged. This exercises
      // loading order, not wallet cryptography or invoice delivery.
      const conversations = ["first", "second"].map((name) => {
        const orderId = `source-${name}`
        return {
          id: orderId,
          orderId,
          buyerPubkey: buyer.pubkey,
          merchantPubkey: merchant.pubkey,
          latestAt: now,
          latestType: "order",
          status: null,
          totalSummary: "100 SATS",
          preview: `Source ${name} order`,
          messageCount: 2,
          messages: [
            {
              id: `${orderId}-message`,
              orderId,
              type: "order",
              createdAt: now,
              senderPubkey: buyer.pubkey,
              recipientPubkey: merchant.pubkey,
              rawContent: "",
              payload: {
                id: orderId,
                buyerPubkey: buyer.pubkey,
                merchantPubkey: merchant.pubkey,
                items: [
                  {
                    productId: "source-digital",
                    format: "digital",
                    quantity: 1,
                    priceAtPurchase: 100,
                    currency: "SATS",
                    shippingCostSats: 0,
                  },
                ],
                subtotal: 100,
                currency: "SATS",
                createdAt: now,
              },
            },
            {
              id: `${orderId}-accepted`,
              orderId,
              type: "status_update",
              createdAt: now + 1,
              senderPubkey: merchant.pubkey,
              recipientPubkey: buyer.pubkey,
              rawContent: "",
              payload: { orderId, status: "accepted" },
            },
          ],
        }
      })
      await page.addInitScript((value) => {
        window.__invoiceSourceConversations = value
      }, conversations)
      await page.route(
        (url) =>
          url.pathname.endsWith("/src/routes/orders.tsx") &&
          url.searchParams.get("tsr-split") === "component",
        async (route) => {
          const response = await route.fetch()
          let body = await response.text()
          const walletSeam = "const nwc = useMerchantPaymentAutomation();"
          const inboxSeam = "const ordersQuery = inbox.merchant;"
          for (const seam of [walletSeam, inboxSeam]) {
            if (body.split(seam).length !== 2)
              throw new Error("Orders fixture input seam changed")
          }
          body = body
            .replace(
              walletSeam,
              `const realNwc = useMerchantPaymentAutomation();
          const [receiving, setReceiving] = useState(null);
          const nwc = { ...realNwc, receivingWalletId: receiving };
          window.__invoiceSourceFixture = { receiving, setReceiving };`
            )
            .replace(
              inboxSeam,
              "const ordersQuery = { ...inbox.merchant, isPending: false, error: null, data: { data: window.__invoiceSourceConversations } };"
            )
            .replace(
              /const profileLud16 =[\s\S]*?;/,
              `const profileLud16 = ${JSON.stringify("merchant@invoice-source.invalid")};`
            )
          await route.fulfill({ response, body })
        }
      )
      await page.goto(`${merchantUrl}/orders?order=source-first`)
      const source = page.locator("#invoice-source")
      await expect(source).toHaveText("Profile Lightning address")
      await page.locator("#invoice-amount").fill("123")
      if (choice !== "untouched") {
        await source.click()
        await page
          .getByRole("option", {
            name:
              choice === "manual"
                ? "Paste BOLT11 manually"
                : "Profile Lightning address",
            exact: true,
          })
          .click()
      }
      await page.evaluate(() =>
        window.__invoiceSourceFixture.setReceiving("fixture-receiving-wallet")
      )
      await expect
        .poll(() =>
          page.evaluate(() => window.__invoiceSourceFixture.receiving)
        )
        .toBe("fixture-receiving-wallet")
      await expect(source).toHaveText(
        choice === "untouched"
          ? "My receiving wallet"
          : choice === "manual"
            ? "Paste BOLT11 manually"
            : "Profile Lightning address"
      )
      if (choice !== "manual")
        await expect(page.locator("#invoice-amount")).toHaveValue("123")
      // The real order-selection reset releases the previous explicit choice.
      await page.getByRole("button", { name: /Source second order/ }).click()
      await expect(page).toHaveURL(/order=source-second/)
      await expect(source).toHaveText("My receiving wallet")
      await expect(page.locator("#invoice-amount")).toHaveValue("100")
    } finally {
      disposeRuntimeSignerIdentity(merchant)
      disposeRuntimeSignerIdentity(buyer)
    }
  })
}
