import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { decodeLightningInvoicePaymentHash } from "../packages/core/src/protocol/lightning"
import { makeSignedBolt11Fixture } from "../tests/support/signed-bolt11-fixture"
import {
  installControlledWallet,
  observeWalletController,
  openWalletSetup,
  prepareControlledWallet,
  saveWalletRecovery,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  replaceRealTestSigner,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

async function begin(page: Page, app: "market" | "merchant") {
  const identity = createRuntimeSignerIdentity()
  await prepareControlledWallet(page)
  await observeWalletController(page, undefined, undefined, true)
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  const port =
    app === "market"
      ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
      : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
  await page.goto(`http://127.0.0.1:${port}/wallet`)
  await installControlledWallet(page)
  await openWalletSetup(page, "Create wallet")
  await saveWalletRecovery(page)
  await page.getByRole("button", { name: "Receive", exact: true }).click()
  await page.getByRole("tab", { name: "Cash App", exact: true }).click()
  return identity
}
async function setInvoice(page: Page, secondsAgo = 0) {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc400u",
    createdAt: Math.floor(Date.now() / 1000) - secondsAgo,
  })
  await page.evaluate(
    ({ invoice, hash }) => {
      const probe = (window as any).__walletProbe
      probe.receiveInvoice = invoice
      probe.receiveRequestId = "deposit-request"
      probe.receiveFee = 3
      probe.receiveObservation = {
        type: "incoming",
        state: "pending",
        invoice,
        paymentHash: hash,
        amountMsats: 40_000_000,
      }
      const captures = { copies: [] as string[], links: [] as boolean[] }
      ;(window as any).__fundingCaptures = captures
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText(value: string) {
            captures.copies.push(value)
          },
        },
      })
      document.addEventListener("click", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('a[href^="https://cash.app/launch/lightning/"]')
        ) {
          captures.links.push(event.defaultPrevented)
          event.preventDefault()
        }
      })
    },
    { invoice, hash: decodeLightningInvoicePaymentHash(invoice) }
  )
  return invoice
}

for (const app of ["market", "merchant"] as const) {
  test(`${app} Cash App funds the selected wallet and confirms only its exact receipt @market @merchant`, async ({
    page,
  }) => {
    const identity = await begin(page, app)
    try {
      const invoice = await setInvoice(page)
      const next = page.getByRole("button", { name: "Continue", exact: true })
      await expect(next).toBeDisabled()
      await page.getByLabel("Amount in sats", { exact: true }).fill("0.5")
      await expect(next).toBeDisabled()
      await page.getByLabel("Amount in sats", { exact: true }).fill("40000")
      await next.click()
      const cash = page.getByRole("link", {
        name: "Open Cash App",
        exact: true,
      })
      // Compare privately: no invoice values in assertion failure output.
      expect(
        (await cash.getAttribute("href")) ===
          `https://cash.app/launch/lightning/${invoice}`
      ).toBe(true)
      await expect(
        page.getByText("Wallet receive fee: 3 sats.", { exact: false })
      ).toBeVisible()
      await cash.click()
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect(
        page.getByText("Money received in this wallet.", { exact: true })
      ).toHaveCount(0)
      await page
        .getByRole("button", { name: "Copy invoice", exact: true })
        .click()
      expect(
        await page.evaluate(
          (invoice) => (window as any).__fundingCaptures.copies[0] === invoice,
          invoice
        )
      ).toBe(true)
      await page
        .getByRole("button", { name: "Show QR code", exact: true })
        .click()
      await expect(
        page.locator('svg:has(> title:text-is("Lightning invoice"))')
      ).toHaveCount(1)
      await page.getByRole("tab", { name: "Lightning", exact: true }).click()
      await expect(page.getByLabel("Amount in sats (optional)")).toBeVisible()
      await page.getByRole("tab", { name: "Cash App", exact: true }).click()
      await expect(cash).toBeVisible()
      expect(
        await page.evaluate(() => (window as any).__walletProbe.receiveCalls)
      ).toBe(1)
      expect(
        await page.evaluate(() => (window as any).__walletProbe.receiveAmount)
      ).toBe(40000)
      expect(
        await page.evaluate(
          () =>
            (window as any).__walletProbe.checkedRequestId === "deposit-request"
        )
      ).toBe(true)
      await page.evaluate(() => {
        const probe = (window as any).__walletProbe
        probe.receiveObservation = {
          ...probe.receiveObservation,
          state: "settled",
          settledAt: Math.floor(Date.now() / 1000),
          amountMsats: 1,
        }
        probe.balanceSats = 99999
      })
      await page
        .getByRole("button", { name: "Check deposit status", exact: true })
        .click()
      await expect(
        page.getByText("Receipt status is unavailable.", { exact: false })
      ).toBeVisible()
      await expect(
        page.getByText("Money received in this wallet.", { exact: true })
      ).toHaveCount(0)
      await page
        .getByRole("button", { name: "Hide QR code", exact: true })
        .click()
      // Inspect responsive styling with every private value masked.
      for (const theme of ["day-market", "night-market"]) {
        await page.evaluate(
          async ({ moduleUrl, theme }) => {
            ;(await import(moduleUrl)).setThemePreference(theme)
          },
          {
            moduleUrl: `/@fs${path.resolve("packages/ui/src/theme/runtime.ts")}`,
            theme,
          }
        )
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true)
        await page.getByRole("dialog").evaluate((node) => {
          node.scrollTop = 0
        })
        if (process.env.WALLET_FUNDING_SCREENSHOTS)
          await page.getByRole("dialog").screenshot({
            path: `/private/tmp/wallet-cash-app-${app}-${test.info().project.name}-${theme}.png`,
            mask: [
              page.locator("svg:has(> title)"),
              page.locator(".tabular-nums, [data-wallet-balance]"),
              page.locator("input"),
              page.locator(".font-mono"),
            ],
            animations: "disabled",
          })
      }
      await page.evaluate(() => {
        const probe = (window as any).__walletProbe
        probe.receiveObservation.amountMsats = 40_000_000
      })
      await page
        .getByRole("button", { name: "Check deposit status", exact: true })
        .click()
      await expect(
        page.getByText("Money received in this wallet.", { exact: true })
      ).toBeVisible()
      await expect(cash).toHaveCount(0)
      expect(
        await page.evaluate(() => (window as any).__walletProbe.receiveCalls)
      ).toBe(1)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("Cash App expiry and account replacement cannot reuse stale funding controls @market", async ({
  page,
}) => {
  const identity = await begin(page, "market")
  const replacement = createRuntimeSignerIdentity()
  try {
    await setInvoice(page)
    await page.getByLabel("Amount in sats", { exact: true }).fill("40000")
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await expect(
      page.getByRole("link", { name: "Open Cash App", exact: true })
    ).toBeVisible()
    await page.clock.setFixedTime(new Date(Date.now() + 3_601_000))
    // A native click must revalidate even before the scheduled expiry render.
    await page.getByRole("link", { name: "Open Cash App", exact: true }).click()
    expect(
      await page.evaluate(() => (window as any).__fundingCaptures.links.at(-1))
    ).toBe(true)
    await page
      .getByRole("button", { name: "Check deposit status", exact: true })
      .click()
    await expect(
      page.getByText("This request expired.", { exact: false })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Open Cash App", exact: true })
    ).toHaveCount(0)
    await page.clock.setFixedTime(new Date())
    await page.evaluate(async () => {
      await (window as any).__controlledWalletAuth.disconnect()
    })
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__controlledWalletAuth.accountPubkey
        )
      )
      .toBeNull()
    await replaceRealTestSigner(page, replacement)
    await page.evaluate(async () => {
      await (window as any).__controlledWalletAuth.connect({ method: "nip07" })
    })
    await expect(
      page.getByRole("dialog", { name: /^Receive to / })
    ).toHaveCount(0)
    await expect(
      page.getByText("Money received in this wallet.", { exact: true })
    ).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
    disposeRuntimeSignerIdentity(replacement)
  }
})
