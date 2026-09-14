import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

async function mountInvoice(page: Page, failFirst = false, expired = false) {
  const invoice = makeBolt11Fixture({
    hrp: "lnbc1110n",
    createdAt: Math.floor(Date.now() / 1_000) - (expired ? 3_601 : 0),
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(7)),
      bolt11PlainDescriptionField("Invoice visibility fixture"),
    ],
  })
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort()
  })
  await page.goto(`${marketUrl}/products`)
  await page.evaluate(
    async ({ rootPath, invoice, failFirst }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { ExternalWalletPanel } = await import(
        `/@fs${rootPath}/apps/market/src/components/ExternalWalletPanel.tsx`
      )
      const { buildOrderViewModel } = await import(
        `/@fs${rootPath}/apps/market/src/lib/order-view.ts`
      )
      const {
        prepareMerchantInvoicePaymentAction,
        isMerchantInvoicePaymentActionBound,
      } = await import(
        `/@fs${rootPath}/apps/market/src/lib/order-payment-service.ts`
      )
      const { db, config } = await import(
        `/@fs${rootPath}/packages/core/src/index.ts`
      )
      config.lightningNetwork = "mainnet"
      const order = {
        orderId: "invoice-visibility-order",
        buyerPubkey: "invoice-visibility-buyer",
        merchantPubkey: "invoice-visibility-merchant",
        checkoutMode: "pay_later",
        items: [],
        itemSubtotalSats: 111,
        shippingCostSats: 0,
        totalSats: 111,
        totalMsats: 111_000,
        currency: "SATS",
        addressValidity: "not_required",
        shippingZoneEligibility: "eligible",
        orderDeliveryStatus: "sent",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        phase: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await db.orderLifecycles.put(order)
      const messages = [
        {
          id: "invoice-visibility-message",
          orderId: order.orderId,
          createdAt: Date.now(),
          senderPubkey: order.merchantPubkey,
          recipientPubkey: order.buyerPubkey,
          rawContent: "{}",
          type: "payment_request",
          payload: { invoice, amount: 111, currency: "SATS" },
        },
      ]
      const host = document.createElement("div")
      host.id = "invoice-visibility-fixture"
      Object.assign(host.style, {
        position: "fixed",
        inset: "100px 40px auto 40px",
        zIndex: "9999",
        background: "var(--surface)",
      })
      document.body.append(host)
      const state = window as typeof window & {
        __invoicePreparationCalls: number
        __releaseInvoice: () => void
        __rerenderInvoice: () => void
        __switchInvoiceScope: () => void
        __rejectOldInvoice: () => void
        __readBoundInvoice: () => Promise<unknown>
      }
      state.__invoicePreparationCalls = 0
      state.__readBoundInvoice = () => db.orderLifecycles.get(order.orderId)
      const root = ReactDOM.createRoot(host)
      let lifecycle = order
      let scope = "first-session"
      state.__rerenderInvoice = () => render()
      state.__switchInvoiceScope = () => {
        scope = "second-session"
        render()
      }
      function render() {
        const vm = buildOrderViewModel({
          orderId: order.orderId,
          lifecycle,
          messages,
        })
        root.render(
          React.createElement(ExternalWalletPanel, {
            vm,
            busy: false,
            guestSession: false,
            autoDetectReceipt: false,
            preparationScope: scope,
            merchantInvoicePrepared: isMerchantInvoicePaymentActionBound(
              lifecycle,
              vm.merchantInvoiceAction
            ),
            boundMerchantInvoiceExpiresAt: lifecycle.invoiceExpiresAt ?? null,
            onBeforeInvoiceUse: () => true,
            onMarkPaid: () => {
              throw new Error("Preparation must not report payment")
            },
            onPrepareMerchantInvoice: async () => {
              state.__invoicePreparationCalls += 1
              if (failFirst && state.__invoicePreparationCalls === 1) {
                throw new Error("Invoice preparation failed")
              }
              await new Promise<void>((resolve, reject) => {
                state.__releaseInvoice = resolve
                if (state.__invoicePreparationCalls === 1) {
                  state.__rejectOldInvoice = () =>
                    reject(new Error("Old session failed"))
                }
              })
              const bound = await prepareMerchantInvoicePaymentAction(
                vm.merchantInvoiceAction
              )
              lifecycle = bound
              render()
            },
          })
        )
      }
      render()
    },
    { rootPath: path.resolve(process.cwd()), invoice, failFirst }
  )
  return { host: page.locator("#invoice-visibility-fixture"), invoice }
}

test("merchant invoice appears automatically after exact persistent binding @market", async ({
  page,
}) => {
  const { host, invoice } = await mountInvoice(page)
  await expect(host.getByRole("status")).toHaveText(
    "Your payment details will appear automatically."
  )
  await expect(host.locator("svg")).toHaveCount(0)
  await expect(
    host.getByRole("button", { name: "Use merchant invoice" })
  ).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__invoicePreparationCalls))
    .toBe(1)
  await page.evaluate(() => window.__releaseInvoice())
  await expect(
    host.getByRole("link", { name: "Open in wallet" })
  ).toHaveAttribute("href", `lightning:${invoice}`)
  await expect(host.getByRole("button", { name: "Copy invoice" })).toBeVisible()
  await expect(host.locator("svg").first()).toBeVisible()
  expect(await page.evaluate(() => window.__readBoundInvoice())).toMatchObject({
    invoice,
    paymentHash: "07".repeat(32),
    invoiceStatus: "manual_required",
    paymentStatus: "manual_required",
    proofDeliveryStatus: "not_started",
  })
})

test("failed preparation stays blocked until an explicit retry @market", async ({
  page,
}) => {
  const { host } = await mountInvoice(page, true)
  await expect(host.getByRole("alert")).toHaveText("Invoice preparation failed")
  await page.evaluate(() => window.__rerenderInvoice())
  await expect(host.getByRole("alert")).toHaveText("Invoice preparation failed")
  expect(await page.evaluate(() => window.__invoicePreparationCalls)).toBe(1)
  await expect(host.getByRole("link", { name: "Open in wallet" })).toHaveCount(
    0
  )
  await host.getByRole("button", { name: "Retry invoice" }).click()
  await expect
    .poll(() => page.evaluate(() => window.__invoicePreparationCalls))
    .toBe(2)
  await page.evaluate(() => window.__releaseInvoice())
  await expect(host.getByRole("button", { name: "Copy invoice" })).toBeVisible()
})

test("a previous session preparation cannot replace the current invoice state @market", async ({
  page,
}) => {
  const { host } = await mountInvoice(page)
  await expect
    .poll(() => page.evaluate(() => window.__invoicePreparationCalls))
    .toBe(1)
  await page.evaluate(() => window.__switchInvoiceScope())
  await expect
    .poll(() => page.evaluate(() => window.__invoicePreparationCalls))
    .toBe(2)
  await page.evaluate(() => window.__rejectOldInvoice())
  await expect(host.getByRole("status")).toHaveText(
    "Your payment details will appear automatically."
  )
  await expect(host.getByRole("alert")).toHaveCount(0)
  await page.evaluate(() => window.__releaseInvoice())
  await expect(host.getByRole("button", { name: "Copy invoice" })).toBeVisible()
})

test("expired merchant invoices stay unavailable without starting preparation @market", async ({
  page,
}) => {
  const { host } = await mountInvoice(page, false, true)
  await expect(
    host.getByRole("heading", { name: "Invoice unavailable" })
  ).toBeVisible()
  await expect(host.getByRole("link", { name: "Open in wallet" })).toHaveCount(
    0
  )
  await expect(host.getByRole("button", { name: "Copy invoice" })).toHaveCount(
    0
  )
  expect(await page.evaluate(() => window.__invoicePreparationCalls)).toBe(0)
})
