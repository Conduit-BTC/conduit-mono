import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  prepareControlledWallet,
  installControlledWallet,
  observeWalletController,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"

const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchant = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const relay = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
const core = `/@fs${path.resolve("packages/core/src/index.ts")}`
const recovery = `/@fs${path.resolve("packages/core/src/wallets/spark-recovery.ts")}`
type WalletWindow = Window & { __controlledWalletController: UseWalletsReturn }
// Generated phrases and signer material never enter screenshots, traces or logs.
test.use({ trace: "off", screenshot: "off", video: "off" })
test.setTimeout(120_000)
async function ready(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as unknown as WalletWindow).__controlledWalletController
            ?.signerUnlockSupported
      )
    )
    .toBe(true)
}
async function names(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as WalletWindow
    ).__controlledWalletController.portableWallets
      .map((w) => w.label)
      .sort()
  )
}

test("seed import restores all complete wallets automatically across Shop and Sell @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const shop = await context.newPage(),
    sell = await context.newPage()
  try {
    for (const page of [shop, sell]) {
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(page, identity, relay)
    }
    await shop.goto(`${market}/wallet`)
    await installControlledWallet(shop)
    await ready(shop)
    await shop.evaluate(
      async ({ moduleUrl }) => {
        const { generateSparkMnemonic } = await import(moduleUrl)
        const controller = (window as unknown as WalletWindow)
          .__controlledWalletController
        await controller.importSpark({
          label: "Daily",
          mnemonic: generateSparkMnemonic(),
          accountNumber: 1,
        })
        await controller.importSpark({
          label: "Savings",
          mnemonic: generateSparkMnemonic(),
          accountNumber: 7,
        })
      },
      { moduleUrl: recovery }
    )
    await expect
      .poll(() =>
        shop.evaluate(
          () =>
            (window as unknown as WalletWindow).__controlledWalletController
              .recoverySync
        )
      )
      .toBe("ready")
    await sell.goto(`${merchant}/wallet`)
    await installControlledWallet(sell)
    await ready(sell)
    await expect.poll(() => names(sell)).toEqual(["Daily", "Savings"])
    await expect
      .poll(() =>
        sell.evaluate(() => {
          const c = (window as unknown as WalletWindow)
            .__controlledWalletController
          return c.portableWallets.filter(
            (w) => c.runtime[w.id]?.status === "ready"
          ).length
        })
      )
      .toBe(2)
    await sell.evaluate(async () => {
      const c = (window as unknown as WalletWindow).__controlledWalletController
      await c.renameWallet(
        c.portableWallets.find((w) => w.label === "Daily")!.id,
        "Daily renamed"
      )
    })
    await expect
      .poll(() => names(shop), { timeout: 50_000 })
      .toEqual(["Daily renamed", "Savings"])
    for (const page of [shop, sell]) {
      await expect(
        page.getByRole("button", { name: "Sync wallet names" })
      ).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "Repair saved recovery state" })
      ).toHaveCount(0)
    }
    // A third fresh origin storage context discovers all records after signer approval.
    const fresh = await browser.newContext()
    try {
      const page = await fresh.newPage()
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(page, identity, relay)
      await page.goto(`${market}/wallet`)
      await installControlledWallet(page)
      await ready(page)
      await expect.poll(() => names(page)).toEqual(["Daily renamed", "Savings"])
      expect(
        await page.evaluate(async (moduleUrl) => {
          const { db } = await import(moduleUrl)
          return db.sparkRecoveryEvidence.count()
        }, core)
      ).toBe(0)
    } finally {
      await fresh.close()
    }
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
