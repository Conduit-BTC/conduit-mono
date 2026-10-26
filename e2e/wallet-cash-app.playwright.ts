import path from "node:path"
import type { AuthContextValue } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
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

type FundingFixtureWindow = Window & {
  __walletProbe: {
    receiveInvoice: string
    receiveRequestId: string
    receiveFee: number
    receiveObservation: {
      type: string
      state: string
      invoice: string
      paymentHash: string
      amountMsats: number
      settledAt?: number
    }
    receiveCalls: number
    receiveAmount: number
    checkedRequestId: string
    balanceSats: number
  }
  __fundingCaptures: { copies: string[]; links: boolean[] }
  __controlledWalletController: Pick<UseWalletsReturn, "signerUnlockSupported">
  __controlledWalletAuth: Pick<
    AuthContextValue,
    "accountPubkey" | "connect" | "disconnect" | "signerReadiness"
  >
}

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

async function begin(page: Page, app: "market" | "merchant", funding = true) {
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
  // Funding exercises the signed-in wallet, not creation during signer discovery.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const fixture = window as unknown as FundingFixtureWindow
        return (
          fixture.__controlledWalletAuth?.signerReadiness === "ready" &&
          fixture.__controlledWalletController?.signerUnlockSupported === true
        )
      })
    )
    .toBe(true)
  await openWalletSetup(page, "Create wallet")
  await saveWalletRecovery(page)
  await page
    .getByRole(
      "button",
      funding
        ? { name: /^Add funds with Cash App to / }
        : { name: "Receive", exact: true }
    )
    .click()
  return identity
}
async function setInvoice(page: Page, secondsAgo = 0) {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc400u",
    createdAt: Math.floor(Date.now() / 1000) - secondsAgo,
  })
  const hash = decodeLightningInvoicePaymentHash(invoice)
  if (!hash) throw new Error("Invalid funding invoice fixture")
  await page.evaluate(
    ({ invoice, hash }) => {
      const probe = (window as unknown as FundingFixtureWindow).__walletProbe
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
      ;(window as unknown as FundingFixtureWindow).__fundingCaptures = captures
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
    { invoice, hash }
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
      const cash = page.locator('a[href^="https://cash.app/launch/lightning/"]')
      const desktop = (page.viewportSize()?.width ?? 0) >= 640
      const cashQr = page.getByRole("img", {
        name: "Open Cash App on your phone QR code",
        exact: true,
      })
      if (desktop) {
        await expect(cashQr).toBeVisible()
        const box = await cashQr.boundingBox()
        expect(box?.width).toBe(224)
        await expect(cash).toBeHidden()
      } else {
        await expect(cash).toBeVisible()
        await expect(cashQr).toBeHidden()
      }
      // Compare privately: no invoice values in assertion failure output.
      expect(
        (await cash.getAttribute("href")) ===
          `https://cash.app/launch/lightning/${invoice}`
      ).toBe(true)
      await expect(
        page.getByText("Wallet receive fee: 3 sats.", { exact: false })
      ).toBeVisible()
      if (!desktop) await cash.click()
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect(
        page.getByText("Money received in this wallet.", { exact: true })
      ).toHaveCount(0)
      await page
        .getByText("Use another Lightning wallet", { exact: true })
        .click()
      await page
        .getByRole("button", { name: "Copy invoice", exact: true })
        .click()
      expect(
        await page.evaluate(
          (invoice) =>
            (window as unknown as FundingFixtureWindow).__fundingCaptures
              .copies[0] === invoice,
          invoice
        )
      ).toBe(true)
      await page
        .getByRole("button", { name: "Show QR code", exact: true })
        .click()
      await expect(
        page.locator('svg:has(> title:text-is("Lightning invoice"))')
      ).toHaveCount(1)
      await page
        .getByText("Use another Lightning wallet", { exact: true })
        .click()
      await page
        .getByText("Use another Lightning wallet", { exact: true })
        .click()
      expect(
        await page.evaluate(
          () =>
            (window as unknown as FundingFixtureWindow).__walletProbe
              .receiveCalls
        )
      ).toBe(1)
      expect(
        await page.evaluate(
          () =>
            (window as unknown as FundingFixtureWindow).__walletProbe
              .receiveAmount
        )
      ).toBe(40000)
      expect(
        await page.evaluate(
          () =>
            (window as unknown as FundingFixtureWindow).__walletProbe
              .checkedRequestId === "deposit-request"
        )
      ).toBe(true)
      await page.evaluate(() => {
        const probe = (window as unknown as FundingFixtureWindow).__walletProbe
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
        const probe = (window as unknown as FundingFixtureWindow).__walletProbe
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
        await page.evaluate(
          () =>
            (window as unknown as FundingFixtureWindow).__walletProbe
              .receiveCalls
        )
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
      page.locator('a[href^="https://cash.app/launch/lightning/"]')
    ).toBeAttached()
    // Cross the boundary and dispatch in one task, before React can remove the
    // expired link. Native handoff gestures are covered by the funding journey.
    expect(
      await page.evaluate(() => {
        const link = document.querySelector<HTMLAnchorElement>(
          'a[href^="https://cash.app/launch/lightning/"]'
        )
        if (!link) throw new Error("Funding link missing before expiry")
        const originalNow = Date.now
        const expiredNow = originalNow() + 3_601_000
        Date.now = () => expiredNow
        try {
          link.click()
          return (
            window as unknown as FundingFixtureWindow
          ).__fundingCaptures.links.at(-1)
        } finally {
          Date.now = originalNow
        }
      })
    ).toBe(true)
    await page.clock.setFixedTime(new Date(Date.now() + 3_601_000))
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
      await (
        window as unknown as FundingFixtureWindow
      ).__controlledWalletAuth.disconnect()
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as FundingFixtureWindow).__controlledWalletAuth
              .accountPubkey
        )
      )
      .toBeNull()
    await replaceRealTestSigner(page, replacement)
    await page.evaluate(async () => {
      await (
        window as unknown as FundingFixtureWindow
      ).__controlledWalletAuth.connect({
        method: "nip07",
      })
    })
    await expect(
      page.getByRole("dialog", { name: "Add funds with Cash App" })
    ).toHaveCount(0)
    await expect(
      page.getByText("Money received in this wallet.", { exact: true })
    ).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
    disposeRuntimeSignerIdentity(replacement)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} Receive stays compact and keeps wallet address and name controls @market @merchant`, async ({
    page,
  }) => {
    const identity = await begin(page, app, false)
    try {
      const dialog = page.getByRole("dialog", {
        name: "Receive",
        exact: true,
      })
      const qr = dialog.getByRole("img", {
        name: "Reusable Lightning address QR code",
        exact: true,
      })
      await expect(qr).toBeVisible()
      await expect(
        dialog.getByText(/address setup is unavailable/)
      ).toHaveCount(0)
      await expect(dialog.getByLabel("Amount in sats (optional)")).toHaveCount(
        0
      )
      const geometry = await dialog.evaluate((node) => {
        const svg = node.querySelector('svg:not([aria-hidden="true"])')!
        return {
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          qrWidth: svg.getBoundingClientRect().width,
          qrHeight: svg.getBoundingClientRect().height,
          overflow: node.scrollWidth > node.clientWidth,
        }
      })
      expect(geometry.width).toBeLessThanOrEqual(400)
      expect(geometry.height).toBeLessThan(650)
      expect(geometry.qrWidth).toBe(224)
      expect(geometry.qrHeight).toBe(224)
      expect(geometry.overflow).toBe(false)
      await dialog
        .getByRole("button", { name: "Request a specific amount", exact: true })
        .click()
      await expect(qr).toHaveCount(0)
      await setInvoice(page)
      await dialog.getByLabel("Amount in sats (optional)").fill("40000")
      await dialog
        .getByRole("button", { name: "Create Lightning invoice", exact: true })
        .click()
      await expect(
        dialog.getByRole("img", {
          name: "Lightning invoice QR code",
          exact: true,
        })
      ).toBeVisible()
      await dialog.getByLabel("Amount in sats (optional)").fill("50000")
      await expect(
        dialog.getByRole("img", {
          name: "Lightning invoice QR code",
          exact: true,
        })
      ).toHaveCount(0)
      await dialog
        .getByRole("button", { name: "Back to Lightning address", exact: true })
        .click()
      await expect(qr).toBeVisible()
      if (process.env.WALLET_FUNDING_SCREENSHOTS)
        await dialog.screenshot({
          path: `/private/tmp/wallet-receive-${app}-${test.info().project.name}.png`,
          mask: [qr, dialog.locator('[role="status"]')],
          animations: "disabled",
        })
      await dialog.getByRole("button", { name: "Close", exact: true }).click()
      const card = page.getByRole("article", { name: / wallet$/ }).first()
      await expect(
        card.getByLabel("Desired name", { exact: true })
      ).toBeEnabled()
      await expect(
        card.getByRole("button", { name: "Request name", exact: true })
      ).toBeVisible()
      await expect(
        card.getByRole("button", { name: "Copy address", exact: true })
      ).toBeVisible()
      await expect(
        page.getByText("Nostr receiving address", { exact: true })
      ).toBeVisible()
      const header = card.locator("[data-wallet-header]")
      const positions = await header.evaluate((node) => {
        const bounds = (selector: string) =>
          node.querySelector(selector)!.getBoundingClientRect()
        const title = bounds("h3"),
          refresh = bounds('button[aria-label^="Refresh "]'),
          menu = bounds('button[aria-label^="Manage "]'),
          funds = bounds('button[aria-label^="Add funds "]'),
          description = bounds("p")
        return {
          titleY: title.y,
          refreshY: refresh.y,
          menuY: menu.y,
          fundsY: funds.y,
          descriptionY: description.y,
          fundsBottom: funds.bottom,
          height: node.getBoundingClientRect().height,
          width: innerWidth,
        }
      })
      expect(Math.abs(positions.refreshY - positions.menuY)).toBeLessThan(2)
      expect(Math.abs(positions.titleY - positions.menuY)).toBeLessThan(8)
      if (positions.width < 640) {
        expect(positions.fundsY).toBeGreaterThan(positions.titleY)
        expect(positions.descriptionY).toBeLessThan(positions.fundsBottom)
        expect(positions.height).toBeLessThanOrEqual(96)
      } else
        expect(Math.abs(positions.fundsY - positions.menuY)).toBeLessThan(8)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
