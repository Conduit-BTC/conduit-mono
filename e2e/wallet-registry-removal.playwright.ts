import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { readTestRelayEvents } from "./helpers/auth"
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

const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const accountRecovery =
  "/@fs" + path.resolve("packages/core/src/wallets/account-spark-recovery.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const market =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
const merchant =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")

test.setTimeout(90_000)
test.use({ trace: "off", screenshot: "off", video: "off" })

async function localSparkWalletIds(page: Page): Promise<string[]> {
  return page.evaluate(async (moduleUrl) => {
    const { db } = await import(moduleUrl)
    return (await db.wallets.toArray())
      .filter((wallet: { providerId: string }) => wallet.providerId === "spark")
      .map((wallet: { id: string }) => wallet.id)
  }, core)
}

test("account removal stays removed in a fresh app while its encrypted backup remains @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const sourceContext = await browser.newContext()
  const targetContext = await browser.newContext()
  const source = await sourceContext.newPage()
  const target = await targetContext.newPage()
  try {
    await prepareControlledWallet(source)
    await installRealTestSigner(source, identity, relay)
    await source.goto(market + "/wallet")
    await installControlledWallet(source)
    await openWalletSetup(source, "Create wallet")
    await saveWalletRecovery(source, false)
    const [walletId] = await localSparkWalletIds(source)
    if (!walletId) throw new Error("WALLET_REGISTRY_SOURCE_WALLET_MISSING")

    const backupDTag = `conduit:spark:wallet:v1:${walletId}`
    const registryDTag = "conduit:spark:registry:v1:mainnet"
    const accountEvents = () =>
      readTestRelayEvents({ authors: [identity.pubkey], kinds: [30_078] })
    const byDTag = async (dTag: string) =>
      (await accountEvents()).filter((event) =>
        event.tags.some(([name, value]) => name === "d" && value === dTag)
      )
    await expect.poll(async () => (await byDTag(backupDTag)).length).toBe(1)
    await expect
      .poll(async () => (await byDTag(registryDTag))[0]?.id)
      .toBeTruthy()
    const [beforeRemoval] = await byDTag(registryDTag)
    if (!beforeRemoval) throw new Error("WALLET_REGISTRY_CREATE_EVENT_MISSING")

    await source
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await source
      .getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    const confirmation = source.getByRole("alertdialog")
    await confirmation.locator("#remove-recovery").check()
    await confirmation
      .getByRole("button", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    await expect(confirmation).toHaveCount(0)
    await expect
      .poll(async () => (await localSparkWalletIds(source)).length)
      .toBe(0)

    // The stable account coordinate advances, while the per-wallet encrypted
    // recovery event remains independently stored on the relay.
    await expect
      .poll(async () => {
        const [current] = await byDTag(registryDTag)
        return !!current && current.id !== beforeRemoval.id
      })
      .toBe(true)
    expect((await byDTag(backupDTag)).length).toBe(1)

    await prepareControlledWallet(target)
    await observeWalletController(target)
    await installRealTestSigner(target, identity, relay)
    await target.goto(merchant + "/wallet")
    await installControlledWallet(target)
    await expect
      .poll(() =>
        target.evaluate(
          () =>
            (
              window as typeof window & {
                __controlledWalletController?: { recoverySync: string }
              }
            ).__controlledWalletController?.recoverySync
        )
      )
      .toBe("ready")
    const verifiedRemoval = await target.evaluate(
      async ({ core, accountRecovery, walletId }) => {
        const { getAccountSigner } = await import(core)
        const { getAccountSparkRecovery } = await import(accountRecovery)
        const signer = getAccountSigner()
        if (!signer) return false
        const snapshot = (
          await getAccountSparkRecovery(signer).discover(false, "mainnet")
        ).registry
        return (
          !!snapshot &&
          snapshot.activeWalletIds.length === 0 &&
          snapshot.removedWalletIds.includes(walletId)
        )
      },
      { core, accountRecovery, walletId }
    )
    expect(verifiedRemoval).toBe(true)
    expect(await localSparkWalletIds(target)).toHaveLength(0)
    await expect(target.getByRole("button", { name: /^Manage / })).toHaveCount(
      0
    )
    expect(
      await target.evaluate(
        () =>
          (window as typeof window & { __walletProbe: { opens: number } })
            .__walletProbe.opens
      )
    ).toBe(0)
    expect(
      await target.evaluate(
        () =>
          (
            window as typeof window & {
              __walletProbe: { registrations: number }
            }
          ).__walletProbe.registrations
      )
    ).toBe(0)
  } finally {
    await Promise.all([sourceContext.close(), targetContext.close()])
    disposeRuntimeSignerIdentity(identity)
  }
})
