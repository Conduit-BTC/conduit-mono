import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { OrderLifecycle } from "../packages/core/src"
import { makeSignedBolt11Fixture } from "../tests/support/signed-bolt11-fixture"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const moduleUrl = (file: string) => `/@fs${path.resolve(process.cwd(), file)}`

type CheckoutMode = "private_checkout" | "public_zap"
type TerminalStatus = "cancelled" | "refund_requested"

async function mountInvoice(page: Page, checkoutMode: CheckoutMode) {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc400u",
    createdAt: Math.floor(Date.now() / 1_000),
  })
  await page.goto(`${marketUrl}/products`)
  await page.evaluate(
    async ({
      componentUrl,
      orderViewUrl,
      configUrl,
      invoice,
      checkoutMode,
    }) => {
      const React = (await import("/@id/react")).default
      const ReactDOM = (await import("/@id/react-dom/client")).default
      const { InvoicePayment } = await import(componentUrl)
      const { deriveBoundMerchantInvoiceAccess } = await import(orderViewUrl)
      const { config } = await import(configUrl)
      // The mock app runs locally; only this isolated component fixture uses mainnet.
      config.lightningNetwork = "mainnet"
      const host = document.createElement("div")
      host.id = "cash-app-invoice-e2e"
      Object.assign(host.style, {
        position: "fixed",
        inset: "0",
        overflow: "auto",
        zIndex: "9999",
        padding: "16px",
        background: "var(--surface)",
      })
      const card = document.createElement("div")
      Object.assign(card.style, { maxWidth: "480px", margin: "0 auto" })
      host.append(card)
      document.body.append(host)
      const state = window as typeof window & {
        __invoiceTest: {
          status: TerminalStatus | null
          attempts: number
          links: boolean[]
          copies: string[]
        }
      }
      state.__invoiceTest = { status: null, attempts: 0, links: [], copies: [] }
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            state.__invoiceTest.copies.push(value)
          },
        },
      })
      // Observe the component's React guard before suppressing every navigation.
      // No test invoice is sent to Cash App or an installed wallet.
      document.addEventListener("click", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("#cash-app-invoice-e2e a")
        ) {
          state.__invoiceTest.links.push(event.defaultPrevented)
          event.preventDefault()
        }
      })
      const lifecycle = {
        checkoutMode,
        invoice,
        invoiceStatus: "received",
        paymentStatus: "manual_required",
        phase: "in_progress",
      } as OrderLifecycle
      ReactDOM.createRoot(card).render(
        React.createElement(InvoicePayment, {
          invoice,
          expectedAmountSats: 40_000,
          preference: { currency: "USD", bitcoinUnit: "sats" },
          quote: null,
          guestSession: true,
          onBeforeInvoiceUse: () => {
            state.__invoiceTest.attempts += 1
            const access = deriveBoundMerchantInvoiceAccess(
              lifecycle,
              state.__invoiceTest.status
            )
            return access !== "closed" && access !== "report_only"
          },
        })
      )
    },
    {
      componentUrl: moduleUrl("apps/market/src/components/InvoicePayment.tsx"),
      orderViewUrl: moduleUrl("apps/market/src/lib/order-view.ts"),
      configUrl: moduleUrl("packages/core/src/config.ts"),
      invoice,
      checkoutMode,
    }
  )
  await expect(
    page.getByRole("link", { name: "Pay with Cash App" })
  ).toBeVisible()
  return invoice
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1024, height: 768 },
]) {
  test(`Cash App consumes the same invoice at ${viewport.width}px @market`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const invoice = await mountInvoice(page, "private_checkout")
    const cash = page.getByRole("link", { name: "Pay with Cash App" })
    const lightning = page.getByRole("link", { name: "Open Lightning wallet" })
    await expect(cash).toHaveAttribute(
      "href",
      `https://cash.app/launch/lightning/${invoice}`
    )
    await expect(lightning).toHaveAttribute("href", `lightning:${invoice}`)
    await cash.click()
    await lightning.click()
    await page.getByRole("button", { name: "Copy invoice" }).click()
    await expect(
      page.locator("#cash-app-invoice-e2e").getByRole("status")
    ).toHaveText("Invoice copied.")
    expect(await page.evaluate(() => window.__invoiceTest.links)).toEqual([
      false,
      false,
    ])
    expect(await page.evaluate(() => window.__invoiceTest.copies)).toEqual([
      invoice,
    ])
    expect(await page.evaluate(() => window.__invoiceTest.attempts)).toBe(3)
    const qr = page.locator("#cash-app-invoice-e2e svg", {
      has: page.locator("title", { hasText: "Lightning invoice" }),
    })
    await expect(qr).toHaveCount(1)
    if (viewport.width < 640) {
      await expect(qr).toBeHidden()
      await page.getByRole("button", { name: "Show QR code" }).click()
    }
    await expect(qr).toBeVisible()
  })
}

// Compose the real component and production access helper. The route-contract
// test separately verifies Orders wires this guard; this is not relay lifecycle QA.
for (const checkoutMode of ["private_checkout", "public_zap"] as const) {
  for (const status of ["cancelled", "refund_requested"] as const) {
    test(`${status} ${checkoutMode} blocks every stale invoice action @market`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 844, height: 390 })
      await mountInvoice(page, checkoutMode)
      // Change current order authority after render, before the buyer clicks.
      await page.evaluate((nextStatus) => {
        window.__invoiceTest.status = nextStatus
      }, status)
      await page.getByRole("link", { name: "Pay with Cash App" }).click()
      await page.getByRole("link", { name: "Open Lightning wallet" }).click()
      await page.getByRole("button", { name: "Copy invoice" }).click()
      expect(await page.evaluate(() => window.__invoiceTest.links)).toEqual([
        true,
        true,
      ])
      expect(await page.evaluate(() => window.__invoiceTest.copies)).toEqual([])
      expect(await page.evaluate(() => window.__invoiceTest.attempts)).toBe(3)
      await expect(
        page.locator("#cash-app-invoice-e2e").getByRole("status")
      ).toHaveCount(0)
    })
  }
}

declare global {
  interface Window {
    __invoiceTest: {
      status: TerminalStatus | null
      attempts: number
      links: boolean[]
      copies: string[]
    }
  }
}
