import path from "node:path"
import { expect, test } from "@playwright/test"
import { measureTextContrast } from "./helpers/rendered-contrast"
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
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

for (const app of ["market", "merchant"] as const) {
  test(`${app} wallet hierarchy stacks cards without changing defaults on desktop and mobile @market @merchant`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    try {
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(
        page,
        identity,
        `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
      )
      await page.goto(`http://127.0.0.1:${port}/wallet`)
      await installControlledWallet(page)
      await openWalletSetup(page, "Create wallet")
      await saveWalletRecovery(page)
      await expect(
        page.getByRole("button", { name: "Receive", exact: true })
      ).toBeEnabled()
      await page.getByRole("button", { name: /^Rename / }).click()
      await page.getByLabel("Wallet name", { exact: true }).fill("Daily wallet")
      await page.getByRole("button", { name: "Save name", exact: true }).click()
      await expect(
        page.getByRole("heading", { name: "Daily wallet", exact: true })
      ).toBeVisible()
      await openWalletSetup(page, "Create wallet")
      await saveWalletRecovery(page, false)
      const defaults = () =>
        page.evaluate(() => {
          const wallets = (window as any).__controlledWalletController
          return [...wallets.portableWallets, ...wallets.connectedWallets].map(
            (wallet: any) => ({
              id: wallet.id,
              defaults: wallet.defaultIntents,
            })
          )
        })
      const before = await defaults()
      const cards = page.getByRole("article", { name: / wallet$/ })
      await expect(cards).toHaveCount(2)
      await expect(page.getByRole("tab")).toHaveCount(0)
      await expect(cards.nth(0)).toBeVisible()
      await expect(cards.nth(1)).toBeVisible()
      expect(await defaults()).toEqual(before)
      await expect(
        cards.nth(0).getByLabel("Desired name", { exact: true })
      ).toBeVisible()
      await expect(
        cards.nth(0).getByRole("button", { name: "Request name", exact: true })
      ).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.locator("[data-wallet-profile-row]")).toHaveCount(2)
      await expect(
        page.getByRole("button", { name: /^Refresh .* balance$/ })
      ).toHaveCount(2)
      await expect(
        page.getByRole("button", {
          name: "Retry encrypted wallet sync",
          exact: true,
        })
      ).toHaveCount(0)
      // Each wallet keeps one recovery-management action in its overflow.
      await page
        .getByRole("button", { name: "Manage Daily wallet", exact: true })
        .click()
      await expect(
        page.getByRole("menuitem", { name: "Recovery details", exact: true })
      ).toHaveCount(1)
      await expect(
        page.getByRole("menuitem", {
          name: "Remove wallet from account",
          exact: true,
        })
      ).toBeVisible()
      await page
        .getByRole("menuitem", { name: "Recovery details", exact: true })
        .click()
      const recoveryDialog = page.getByRole("dialog", {
        name: "Recovery for Daily wallet",
        exact: true,
      })
      const recoveryDetails = recoveryDialog.getByText(
        "Recovery sync details",
        { exact: true }
      )
      await expect(recoveryDetails).toBeVisible()
      await recoveryDetails.click()
      await expect(
        recoveryDialog.getByText("Wallet 1 backup:", { exact: false })
      ).toBeVisible()
      await expect(
        recoveryDialog.locator("li").filter({ hasText: "Wallet 1 backup:" })
      ).toHaveText(
        /^Wallet 1 backup: (?:no local signed record|relay acceptance pending|relay authentication required|relay rejected the write|relay write timed out|relay policy blocked the write|write was interrupted|relay write failed|exact readback has not run|exact readback did not find the record|exact readback was unavailable|last confirmed readback is stale|not enough confirmed copies)(?: \(.*\))?$/
      )
      await page.keyboard.press("Escape")
      await page
        .getByRole("button", { name: "Add wallet", exact: true })
        .click()
      await expect(
        page.getByRole("menuitem", {
          name: "Import an existing wallet",
          exact: true,
        })
      ).toBeVisible()
      await page.keyboard.press("Escape")
      for (const size of [
        { name: "desktop", width: 1440, height: 1000 },
        { name: "mobile", width: 390, height: 844 },
      ]) {
        await page.setViewportSize(size)
        for (const theme of ["night-market", "day-market"] as const) {
          await page.evaluate(
            async ({ moduleUrl, theme }) => {
              ;(await import(moduleUrl)).setThemePreference(theme)
            },
            {
              moduleUrl: `/@fs${path.resolve("packages/ui/src/theme/runtime.ts")}`,
              theme,
            }
          )
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme
          )
          await page.evaluate(async () => {
            await document.fonts.ready
            window.scrollTo({ top: 0, behavior: "instant" })
            document
              .querySelector<HTMLElement>("[data-merchant-main-scroll]")
              ?.scrollTo({ top: 0, behavior: "instant" })
          })
          await expect(
            cards.first().getByRole("button", { name: "Send", exact: true })
          ).toBeEnabled()
          await expect(
            page.getByRole("button", { name: "Add wallet", exact: true })
          ).toBeEnabled()
          const heading = page.getByRole("heading", {
            name: "Wallets",
            exact: true,
            level: 1,
          })
          await expect(heading).toBeVisible()
          await expect
            .poll(async () => (await measureTextContrast(heading))[0].ratio)
            .toBeGreaterThanOrEqual(4.5)
          const geometry = await page
            .locator("[data-wallet-balance]:visible")
            .first()
            .evaluate((node) => ({
              fontSize: parseFloat(getComputedStyle(node).fontSize),
              overflow: document.documentElement.scrollWidth > innerWidth,
            }))
          expect(geometry.fontSize).toBeGreaterThanOrEqual(48)
          expect(geometry.overflow).toBe(false)
          await page.screenshot({
            path: `/private/tmp/wallet-ui-${app}-${size.name}-${theme}.png`,
            fullPage: true,
            animations: "disabled",
            mask: [
              page.getByRole("button", {
                name: /^Open (merchant )?account menu$/,
              }),
              page.locator(
                "[data-wallet-balance], [data-wallet-address], .tabular-nums, input, textarea"
              ),
              page.getByText(/^(Current address:|This wallet receives at)/),
            ],
          })
        }
      }
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
