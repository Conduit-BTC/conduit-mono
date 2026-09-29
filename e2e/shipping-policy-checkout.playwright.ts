import { fileURLToPath } from "node:url"
import { expect, test, type Page } from "@playwright/test"
import { TEST_RELAY_URL, publishTestRelayEvents } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"

async function seedShippingIdentity(identity: RuntimeSignerIdentity) {
  await publishTestRelayEvents(
    [0, 10002, 10050].map((kind) =>
      signRuntimeTestEvent(identity, {
        kind,
        created_at: Math.floor(Date.now() / 1000),
        content: kind === 0 ? "{}" : "",
        tags:
          kind === 10002
            ? [["r", TEST_RELAY_URL]]
            : kind === 10050
              ? [["relay", TEST_RELAY_URL]]
              : [],
      })
    )
  )
}

const coreDbModuleUrl =
  "/@fs" +
  fileURLToPath(new URL("../packages/core/src/db/index.ts", import.meta.url))
const coreOrderModuleUrl =
  "/@fs" +
  fileURLToPath(
    new URL("../packages/core/src/protocol/orders.ts", import.meta.url)
  )
const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

async function readCartLines(page: Page) {
  return page.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = await import(/* @vite-ignore */ modulePath)
    await repository.initializeCartRepository()
    return repository
      .getCartRepositorySnapshot()
      .items.map((item: { productId: string; quantity: number }) => ({
        productId: item.productId,
        quantity: item.quantity,
      }))
  })
}

async function readShippingOrder(page: Page, merchant: string) {
  return page.evaluate(
    async ({ merchantPubkey, modulePath }) => {
      const { db } = await import(/* @vite-ignore */ modulePath)
      const rows = await db.orderLifecycles.toArray()
      const order = rows.find(
        (row: { merchantPubkey: string }) =>
          row.merchantPubkey === merchantPubkey
      )
      if (!order) return null
      return {
        orderId: order.orderId,
        orderDeliveryStatus: order.orderDeliveryStatus,
        shippingCostSats: order.shippingCostSats,
        totalSats: order.totalSats,
        quotes: order.items.map(
          (item: { shippingPolicyQuote: unknown }) => item.shippingPolicyQuote
        ),
      }
    },
    { merchantPubkey: merchant, modulePath: coreDbModuleUrl }
  )
}

test("mixed currency product adjustments keep cart, encrypted order and recovered lifecycle terms aligned @commerce", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000)
  const merchantIdentity = createRuntimeSignerIdentity()
  const buyerIdentity = createRuntimeSignerIdentity()
  const merchant = merchantIdentity.pubkey
  try {
    const createdAt = Math.floor(Date.now() / 1000)
    const policyCoordinate = `30406:${merchant}:conduit-shipping-policy`
    const policy = {
      version: 2,
      title: "Synthetic mixed currency parcel table",
      originCountry: "US",
      currency: "GBP",
      domestic: {
        rules: [
          {
            country: "US",
            bands: [
              { maxWeightGrams: 1000, priceMinor: 250 },
              { maxWeightGrams: 3000, priceMinor: 500 },
            ],
          },
        ],
      },
      international: null,
    }
    const policyEvent = signRuntimeTestEvent(merchantIdentity, {
      kind: 30406,
      created_at: createdAt,
      content: "Synthetic signed parcel terms",
      tags: [
        ["d", "conduit-shipping-policy"],
        ["title", policy.title],
        ["price", "2.50", "GBP"],
        ["country", "US"],
        ["service", "standard"],
        ["conduit_shipping_table", "2", JSON.stringify(policy)],
      ],
    })
    const products = ["parcel-a", "parcel-b"].map((name, index) =>
      signRuntimeTestEvent(merchantIdentity, {
        kind: 30402,
        created_at: createdAt + 1,
        content: "Synthetic physical product",
        tags: [
          ["d", name],
          ["title", `Synthetic ${name}`],
          [
            "price",
            index === 0 ? "12.50" : "10.00",
            index === 0 ? "USD" : "EUR",
          ],
          ["type", "simple", "physical"],
          ["stock", "5"],
          ["image", "https://shipping-fixture.dev/product.png"],
          ["weight", index === 0 ? "300" : "200", "g"],
          [
            "conduit_shipping_adjustments",
            "1",
            JSON.stringify({
              weightAllowanceGrams: index === 0 ? 50 : 100,
              handling: {
                amount: index === 0 ? 1.25 : 1,
                currency: index === 0 ? "USD" : "EUR",
                normalizedCurrency: index === 0 ? "USD" : "EUR",
              },
            }),
          ],
          ["shipping_option", policyCoordinate],
          ["checkout_public_zaps", "true"],
          ["checkout_zap_message_policy", "generic_only"],
        ],
      })
    )
    let gbpPerUsd = 0.8
    await page.route("https://mempool.space/api/v1/prices", (route) =>
      route.fulfill({ json: { USD: 100000 } })
    )
    await page.route(
      "https://api.frankfurter.dev/v1/latest?base=USD",
      (route) =>
        route.fulfill({ json: { rates: { EUR: 0.8, GBP: gbpPerUsd } } })
    )
    await page.route("https://shipping-fixture.dev/product.png", (route) =>
      route.fulfill({ status: 204 })
    )
    await page.routeWebSocket(/.*/, (socket) => {
      if (new URL(socket.url()).origin !== new URL(TEST_RELAY_URL).origin) {
        socket.close()
        return
      }
      socket.connectToServer()
    })
    await seedShippingIdentity(merchantIdentity)
    await seedShippingIdentity(buyerIdentity)
    await publishTestRelayEvents([policyEvent, ...products])
    await installRealTestSigner(page, buyerIdentity, TEST_RELAY_URL)
    for (const product of products) {
      const d = product.tags.find((tag) => tag[0] === "d")![1]!
      await page.goto(`${marketUrl}/products/30402:${merchant}:${d}`)
      await page
        .getByRole("button", { name: "Add 1 to cart", exact: true })
        .click()
      await expect
        .poll(async () =>
          (await readCartLines(page)).some(
            (item: { productId: string }) =>
              item.productId === `30402:${merchant}:${d}`
          )
        )
        .toBe(true)
    }
    await page.evaluate(
      async ({ merchantPubkey, productId }) => {
        const modulePath = "/src/lib/cart-repository.ts"
        const repository = await import(/* @vite-ignore */ modulePath)
        await repository.incrementCartRepositoryItem({
          merchantPubkey,
          productId,
        })
      },
      { merchantPubkey: merchant, productId: `30402:${merchant}:parcel-a` }
    )
    await expect
      .poll(async () =>
        (await readCartLines(page)).reduce(
          (sum: number, item: { quantity: number }) => sum + item.quantity,
          0
        )
      )
      .toBe(3)
    await page.goto(`${marketUrl}/cart`)
    await page
      .getByRole("button", { name: "Estimate shipping", exact: true })
      .click()
    await page.getByLabel("State / region", { exact: true }).fill("WA")
    await page.getByLabel("Postal / ZIP code", { exact: true }).fill("98101")
    await expect(
      page.getByText(/Shipping estimate: (?:₿6,875|6,875 sats)/)
    ).toBeVisible({
      timeout: 30000,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(390)
    await page.screenshot({
      path: testInfo.outputPath("cart-shipping-mobile.png"),
      fullPage: true,
    })
    await page.goto(`${marketUrl}/checkout?merchant=${merchant}`)
    await page.getByLabel(/First name/i).fill("Synthetic")
    await page.getByLabel(/Last name/i).fill("Buyer")
    await page.getByLabel(/Street address/i).fill("1 Test Way")
    await page.getByLabel(/^City/i).fill("Seattle")
    await expect(page.getByLabel(/Postal\/ZIP code/i)).toHaveValue("98101")
    const summary = page.locator("aside").filter({
      has: page.getByRole("heading", { name: "Order summary", exact: true }),
    })
    await expect(summary.getByText(/^(?:₿6,875|6,875 sats)$/)).toBeVisible({
      timeout: 30000,
    })
    await expect(page.getByText("Zap visibility", { exact: true })).toHaveCount(
      0
    )
    const send = page.getByRole("button", { name: "Send order", exact: true })
    await expect(send).toBeEnabled({ timeout: 30000 })
    await send.click()
    await expect(page).toHaveURL(/\/orders(?:\?|$)/, { timeout: 30000 })
    const saved = await readShippingOrder(page, merchant)
    expect(saved).toMatchObject({
      shippingCostSats: 6875,
      totalSats: 44375,
      orderDeliveryStatus: "sent",
    })
    expect(saved!.quotes[0]).toMatchObject({
      policyEventId: policyEvent.id,
      version: 2,
      amountMinor: 550,
      amountSats: 6875,
      handlingMinor: 300,
      combinedWeightGrams: 1000,
      pricingRate: { rate: 100000, fiatUsdRates: { EUR: 1.25, GBP: 1.25 } },
    })
    const wraps = await readAuthenticatedGiftWraps(
      merchantIdentity,
      TEST_RELAY_URL
    )
    expect(wraps.length).toBeGreaterThan(0)
    const rumor = wraps
      .map((wrap) =>
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: merchantIdentity,
          recipient: merchantIdentity,
          sender: buyerIdentity,
          wrap,
        })
      )
      .find(
        (event) =>
          event?.kind === 16 && JSON.parse(event.content).id === saved!.orderId
      )!
    expect(rumor).toBeTruthy()
    const delivered = await page.evaluate(
      async ({ content, modulePath }) => {
        const { parseOrderRumorEvent } = await import(
          /* @vite-ignore */ modulePath
        )
        return parseOrderRumorEvent({ content })
      },
      { content: rumor.content, modulePath: coreOrderModuleUrl }
    )
    expect(delivered.shippingCostSats).toBe(6875)
    expect(delivered.items[0].shippingPolicyQuote).toEqual(saved!.quotes[0])
    expect(
      wraps.every(
        (wrap) =>
          !wrap.content.includes("98101") &&
          !wrap.content.includes("Synthetic parcel-a")
      )
    ).toBe(true)
    await publishTestRelayEvents([
      signRuntimeTestEvent(merchantIdentity, {
        ...policyEvent,
        created_at: createdAt + 2,
        tags: policyEvent.tags.map((tag) =>
          tag[0] === "conduit_shipping_table"
            ? [
                tag[0],
                "2",
                JSON.stringify({
                  ...policy,
                  domestic: {
                    rules: [
                      {
                        country: "US",
                        bands: [
                          { maxWeightGrams: 1000, priceMinor: 1000 },
                          { maxWeightGrams: 3000, priceMinor: 1500 },
                        ],
                      },
                    ],
                  },
                }),
              ]
            : tag[0] === "price"
              ? ["price", "10.00", "GBP"]
              : tag
        ),
      }),
    ])
    gbpPerUsd = 1
    await page.evaluate(() => localStorage.removeItem("conduit:btc-usd-rate"))
    await page.reload()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("conduit:btc-usd-rate") ?? "{}")
              .fiatUsdRates?.GBP
        )
      )
      .toBe(1)
    expect(await readShippingOrder(page, merchant)).toEqual(saved)
  } finally {
    disposeRuntimeSignerIdentity(merchantIdentity)
    disposeRuntimeSignerIdentity(buyerIdentity)
  }
})
