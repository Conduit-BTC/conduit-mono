import { openWalletSetup } from "./helpers/wallet-fixture"
import path from "node:path"
import { expect, test } from "@playwright/test"
import {
  installControlledWallet,
  observeWalletController,
  prepareControlledWallet,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const storage =
  "/@fs" + path.resolve("packages/core/src/wallets/wallet-storage.ts")
const sparkSdk = "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const market =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")

test.use({ trace: "off", screenshot: "off", video: "off" })

test("superseded wallet reload cannot close a new native session @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(market + "/wallet")
    await installControlledWallet(page)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const controller = (window as any).__controlledWalletController
          return (
            controller?.loading === false &&
            !["idle", "checking"].includes(controller.recoverySync)
          )
        })
      )
      .toBe(true)

    await page.evaluate(
      async ({ storage, sparkSdk }) => {
        const { getMarketWalletStore } = await import(storage)
        const { getSparkWalletManager } = await import(sparkSdk)
        const fixture = window as any
        const store = getMarketWalletStore()
        const originalListVisible = store.listVisible.bind(store)
        let releaseReload!: () => void
        const reloadGate = new Promise<void>((resolve) => {
          releaseReload = resolve
        })
        let held = false
        store.listVisible = async (owner: string | null) => {
          const wallets = await originalListVisible(owner)
          if (!held) {
            held = true
            fixture.__staleReloadWalletCount = wallets.length
            fixture.__releaseStaleReload = releaseReload
            await reloadGate
            fixture.__staleReloadReturned = true
          }
          return wallets
        }

        const manager = getSparkWalletManager()!
        const originalBalance = manager.getBalance.bind(manager)
        let releaseBalance!: () => void
        const balanceGate = new Promise<void>((resolve) => {
          releaseBalance = resolve
        })
        manager.getBalance = async (walletId: string) => {
          const balance = await originalBalance(walletId)
          fixture.__balanceHeld = true
          fixture.__releaseBalance = releaseBalance
          await balanceGate
          return balance
        }

        // Exercise the same subscription path used for another tab's change.
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "conduit:wallets-change:v1",
            newValue: "storage-fallback:reload-regression",
          })
        )
      },
      { storage, sparkSdk }
    )
    await expect
      .poll(() => page.evaluate(() => (window as any).__staleReloadWalletCount))
      .toBe(0)
    await openWalletSetup(page, "Create wallet")
    await expect
      .poll(() => page.evaluate(() => (window as any).__balanceHeld === true))
      .toBe(true)
    await page.evaluate(() => (window as any).__releaseStaleReload())
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__staleReloadReturned === true)
      )
      .toBe(true)
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    )
    await page.evaluate(() => (window as any).__releaseBalance())

    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Save your recovery details" })
    ).toBeVisible()
    expect(
      await page.evaluate(
        async ({ core, sparkSdk }) => {
          const { db } = await import(core)
          const { getSparkWalletManager } = await import(sparkSdk)
          const [wallet] = await db.wallets.toArray()
          const probe = (window as any).__walletProbe
          return {
            opens: probe.opens,
            disconnects: probe.disconnects,
            nativeOpen: wallet
              ? getSparkWalletManager()?.isOpen(wallet.id)
              : false,
          }
        },
        { core, sparkSdk }
      )
    ).toEqual({ opens: 1, disconnects: 0, nativeOpen: true })
  } finally {
    await page
      .evaluate(() => {
        ;(window as any).__releaseStaleReload?.()
        ;(window as any).__releaseBalance?.()
      })
      .catch(() => undefined)
    disposeRuntimeSignerIdentity(identity)
  }
})
