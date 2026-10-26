import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { expect, test } from "@playwright/test"
import path from "node:path"

import { recordSmokeDiagnostic } from "./helpers/smoke-diagnostics"
import { createDeterministicNwcWallet } from "./helpers/deterministic-nwc-wallet"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import {
  installControlledWallet,
  observeWalletController,
  openWalletSetup,
  prepareControlledWallet,
  saveWalletRecovery,
} from "./helpers/wallet-fixture"

type BalanceFixtureWindow = Window & {
  __controlledWalletController: UseWalletsReturn
  __walletProbe: {
    balanceSats: number
    balanceReads: number
    delayBalance: boolean
    releaseBalance(): void
  }
  __balanceReads: Promise<void[]>
}

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

for (const app of ["market", "merchant"] as const) {
  test(`${app} stacked Spark and NWC balances update automatically with bounded foreground reads @market @merchant`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const relay = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    let balanceMsats = 8_300_000
    const nwc = createDeterministicNwcWallet({
      relayUrl: relay,
      network: "mainnet",
      lud16: "external@wallet.example",
      getBalanceMsats: () => balanceMsats,
    })
    const privateBalance = createDeterministicNwcWallet({
      relayUrl: relay,
      network: "mainnet",
      methods: ["get_info", "pay_invoice"],
    })
    try {
      await prepareControlledWallet(page)
      const smokeInfo = test.info()
      await observeWalletController(page, undefined, (diagnostic) => {
        recordSmokeDiagnostic(smokeInfo, "wallet-balances", diagnostic)
      })
      await installRealTestSigner(page, identity, relay)
      await page.clock.install()
      await page.goto(`http://127.0.0.1:${port}/wallet`)
      await installControlledWallet(page)
      await openWalletSetup(page, "Create wallet")
      await saveWalletRecovery(page)
      await nwc.start()
      await nwc.configureMerchantConnection(async (uri) => {
        await openWalletSetup(page, "Connect wallet")
        await page
          .getByLabel("Wallet label", { exact: true })
          .fill("External wallet")
        await page
          .getByLabel("NWC connection string", { exact: true })
          .fill(uri)
        await page.getByRole("button", { name: "Connect", exact: true }).click()
      })
      const sparkCard = page.getByRole("article", {
        name: /^Conduit Wallet.* wallet$/,
      })
      const nwcCard = page.getByRole("article", {
        name: "External wallet wallet",
        exact: true,
      })
      await expect(sparkCard).toBeVisible()
      await expect(nwcCard).toBeVisible()
      await expect(page.getByRole("tab")).toHaveCount(0)
      await expect(nwcCard.locator("[data-wallet-balance]")).toContainText(
        "8,300"
      )
      await expect(nwcCard.locator("[data-wallet-address]")).toHaveText(
        "external@wallet.example"
      )
      await expect(
        nwcCard.getByRole("button", { name: "Copy address", exact: true })
      ).toBeVisible()
      await expect(
        nwcCard.getByRole("button", {
          name: "Refresh External wallet balance",
          exact: true,
        })
      ).toBeEnabled()
      await privateBalance.start()
      await privateBalance.configureMerchantConnection(async (uri) => {
        await openWalletSetup(page, "Connect wallet")
        await page
          .getByLabel("Wallet label", { exact: true })
          .fill("Private balance")
        await page
          .getByLabel("NWC connection string", { exact: true })
          .fill(uri)
        await page.getByRole("button", { name: "Connect", exact: true }).click()
      })
      const privateCard = page.getByRole("article", {
        name: "Private balance wallet",
        exact: true,
      })
      await expect(privateCard.locator("[data-wallet-balance]")).toHaveText(
        "Balance not shared"
      )
      expect(privateBalance.snapshot().balanceReads).toBe(0)
      await expect(page.getByRole("article")).toHaveCount(3)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      const defaults = () =>
        page.evaluate(() =>
          (
            window as unknown as BalanceFixtureWindow
          ).__controlledWalletController.wallets.map((wallet) => ({
            id: wallet.id,
            defaults: wallet.defaultIntents,
          }))
        )
      const beforeProfileChange = await defaults()
      await nwcCard
        .locator("..")
        .getByRole("button", { name: "Use this address", exact: true })
        .click()
      await page
        .getByRole("button", { name: "Use this wallet’s address", exact: true })
        .click()
      await expect(
        sparkCard.locator("[data-wallet-profile-status]")
      ).toContainText("external@wallet.example")
      await expect(
        nwcCard
          .locator("..")
          .getByText("Receiving sats on Nostr", { exact: true })
      ).toBeVisible()
      expect(await defaults()).toEqual(beforeProfileChange)
      for (const size of [
        { name: "desktop", width: 1440, height: 1000 },
        { name: "mobile", width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size)
        for (const theme of ["night-market", "day-market"] as const) {
          await page.evaluate(
            async ({ url, theme }) =>
              (await import(url)).setThemePreference(theme),
            {
              url: `/@fs${path.resolve("packages/ui/src/theme/runtime.ts")}`,
              theme,
            }
          )
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme
          )
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true)
          await page.evaluate(async () => {
            await document.fonts.ready
            window.scrollTo({ top: 0, behavior: "instant" })
            document
              .querySelector<HTMLElement>("[data-merchant-main-scroll]")
              ?.scrollTo({ top: 0, behavior: "instant" })
          })
          await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
          await page.screenshot({
            path: `/private/tmp/wallet-nwc-${app}-${size.name}-${theme}.png`,
            fullPage: true,
            animations: "disabled",
            mask: [
              page.getByRole("button", {
                name: /^Open (merchant )?account menu$/,
              }),
              page.locator(
                "[data-wallet-balance], [data-wallet-address], .tabular-nums, input, textarea"
              ),
            ],
          })
        }
      }
      balanceMsats = 9_500_000
      await page.evaluate(() => {
        ;(window as unknown as BalanceFixtureWindow).__walletProbe.balanceSats =
          24_800
      })
      await page.clock.fastForward(30_001)
      await expect(nwcCard.locator("[data-wallet-balance]")).toContainText(
        "9,500"
      )
      await expect(sparkCard.locator("[data-wallet-balance]")).toContainText(
        "24,800"
      )
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      const nwcReads = nwc.snapshot().balanceReads
      const sparkReads = await page.evaluate(
        () =>
          (window as unknown as BalanceFixtureWindow).__walletProbe.balanceReads
      )
      balanceMsats = 12_000_000
      await page.evaluate(() => {
        ;(window as unknown as BalanceFixtureWindow).__walletProbe.balanceSats =
          30_000
      })
      await page.clock.fastForward(60_001)
      expect(nwc.snapshot().balanceReads).toBe(nwcReads)
      expect(
        await page.evaluate(
          () =>
            (window as unknown as BalanceFixtureWindow).__walletProbe
              .balanceReads
        )
      ).toBe(sparkReads)
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "visibilityState")
        document.dispatchEvent(new Event("visibilitychange"))
        window.dispatchEvent(new Event("focus"))
      })
      await expect(nwcCard.locator("[data-wallet-balance]")).toContainText(
        "12,000"
      )
      await expect(sparkCard.locator("[data-wallet-balance]")).toContainText(
        "30,000"
      )
      expect(nwc.snapshot().balanceReads).toBe(nwcReads + 1)
      // Manual clicks and a foreground event share an in-flight Spark read.
      await page.evaluate(() => {
        const fixture = window as unknown as BalanceFixtureWindow
        fixture.__walletProbe.delayBalance = true
        const wallets = fixture.__controlledWalletController
        const id = wallets.portableWallets[0].id
        fixture.__balanceReads = Promise.all([
          wallets.refreshBalance(id),
          wallets.refreshBalance(id),
        ])
      })
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              typeof (window as unknown as BalanceFixtureWindow).__walletProbe
                .releaseBalance
          )
        )
        .toBe("function")
      expect(
        await page.evaluate(
          () =>
            (window as unknown as BalanceFixtureWindow).__walletProbe
              .balanceReads
        )
      ).toBe(sparkReads + 2)
      await page.evaluate(async () => {
        const fixture = window as unknown as BalanceFixtureWindow
        fixture.__walletProbe.delayBalance = false
        fixture.__walletProbe.releaseBalance()
        await fixture.__balanceReads
      })
      expect(privateBalance.snapshot().balanceReads).toBe(0)
      expect(nwc.snapshot().counters.payInvoice).toBe(0)
      expect(nwc.snapshot().counters.makeInvoice).toBe(0)
      await page.goto(`http://127.0.0.1:${port}/products`)
      const readsAfterLeaving = nwc.snapshot().balanceReads
      await page.clock.fastForward(60_001)
      expect(nwc.snapshot().balanceReads).toBe(readsAfterLeaving)
      await page.unrouteAll({ behavior: "wait" })
    } finally {
      await Promise.all([nwc.close(), privateBalance.close()])
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
