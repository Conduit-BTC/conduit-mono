import { expect, test } from "@playwright/test"
import {
  prepareControlledWallet,
  installControlledWallet,
  observeWalletController,
  openWalletSetup,
  saveWalletRecovery,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const relay = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
type FixtureWindow = Window & {
  __walletProbe: { failOpen: boolean }
  __controlledWalletController: UseWalletsReturn
}
test.use({ trace: "off", screenshot: "off", video: "off" })
test.setTimeout(90000)

test("creation retry retains the same wallet after native opening fails @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(`${market}/wallet`)
    await installControlledWallet(page)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!(window as unknown as FixtureWindow).__controlledWalletController
              ?.signerUnlockSupported
        )
      )
      .toBe(true)
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).__walletProbe.failOpen = true
    })
    await openWalletSetup(page, "Create wallet")
    await expect(
      page.getByRole("button", { name: "Retry creation", exact: true })
    ).toBeVisible()
    const ids = await page.evaluate(() =>
      (
        window as unknown as FixtureWindow
      ).__controlledWalletController.portableWallets.map((w) => w.id)
    )
    expect(ids.length).toBe(1)
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).__walletProbe.failOpen = false
    })
    await page
      .getByRole("button", { name: "Retry creation", exact: true })
      .click()
    await expect(
      page.getByRole("heading", {
        name: "Save your recovery details",
        exact: true,
      })
    ).toBeVisible()
    expect(
      await page.evaluate(() =>
        (
          window as unknown as FixtureWindow
        ).__controlledWalletController.portableWallets.map((w) => w.id)
      )
    ).toEqual(ids)
    await saveWalletRecovery(page)
    await expect(
      page.getByRole("button", { name: "Sync wallet names" })
    ).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})
