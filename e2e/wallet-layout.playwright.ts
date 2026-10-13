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
  test(`${app} wallet hierarchy keeps selection separate from defaults on desktop and mobile @market @merchant`, async ({
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
      // Exercise the released invitation without contacting the name service.
      await page.route(
        "**/packages/ui/src/components/AddressNameRequestForm.tsx*",
        async (route) => {
          const response = await route.fetch()
          const body = await response.text()
          const marker =
            'siteKey = import.meta.env?.VITE_ADDRESS_REQUEST_TURNSTILE_SITE_KEY ?? "",'
          if (body.split(marker).length !== 2)
            throw new Error("Address invitation fixture seam changed")
          await route.fulfill({
            response,
            body: body.replace(marker, 'siteKey = "controlled-key",'),
          })
        }
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
      const choices = page.getByRole("tab")
      await expect(choices).toHaveCount(2)
      await choices.last().click()
      expect(await defaults()).toEqual(before)
      await page.getByRole("tab", { name: "Daily wallet", exact: true }).click()
      await expect(
        page.getByRole("button", {
          name: "Get my @conduit.cash address",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", {
          name: "Set Nostr receiving address",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", {
          name: /^(Retry encrypted wallet sync|Sync encrypted wallet recovery)$/,
        })
      ).toHaveCount(1)
      // Recovery is a single action in the selected wallet's overflow.
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
          await page.evaluate(() => window.scrollTo(0, 0))
          await expect(
            page.getByRole("button", { name: "Send", exact: true })
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
