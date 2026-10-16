import { retryWalletRecovery } from "./helpers/wallet-fixture"
import path from "node:path"
import { expect, test, type Page, type Browser } from "@playwright/test"
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

async function assertEmptyAccountReplacement(
  browser: Browser,
  nextAction: "Create wallet" | "Import wallet"
) {
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
    await openWalletSetup(source, nextAction)
    if (nextAction === "Import wallet") {
      await source
        .getByLabel("Recovery phrase", { exact: true })
        .evaluate((input) => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          )!.set!
          setter.call(
            input,
            Reflect.get(window, "__walletProbe").importMnemonic
          )
          input.dispatchEvent(new Event("input", { bubbles: true }))
        })
      await source
        .getByRole("dialog")
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
    }
    await saveWalletRecovery(source, false)
    const [replacementId] = await localSparkWalletIds(source)
    expect(!!replacementId && replacementId !== walletId).toBe(true)
    await expect
      .poll(() =>
        source.evaluate(
          async ({ core, accountRecovery, replacementId, walletId }) => {
            const { getAccountSigner } = await import(core)
            const { getAccountSparkRecovery } = await import(accountRecovery)
            const discovery = await getAccountSparkRecovery(
              getAccountSigner()
            ).discover(false, "mainnet")
            return (
              discovery.registryMembershipReady === true &&
              discovery.registry?.activeWalletIds.length === 1 &&
              discovery.registry.activeWalletIds.includes(replacementId) &&
              discovery.registry.removedWalletIds.includes(walletId)
            )
          },
          { core, accountRecovery, replacementId, walletId }
        )
      )
      .toBe(true)
    // This app has no local recovery credential for the replacement wallet.
    await target.reload()
    await installControlledWallet(target)
    await expect
      .poll(() => localSparkWalletIds(target))
      .toEqual([replacementId])
    await expect(
      target.getByRole("button", { name: "Send", exact: true })
    ).toBeEnabled()
  } finally {
    await Promise.all([sourceContext.close(), targetContext.close()])
    disposeRuntimeSignerIdentity(identity)
  }
}

for (const nextAction of ["Create wallet", "Import wallet"] as const) {
  test(`empty account membership preserves removal and allows ${nextAction} on a fresh device @market @merchant`, async ({
    browser,
  }) => {
    await assertEmptyAccountReplacement(browser, nextAction)
  })
}

test("failed removal survives reload and retries the retained event before exclusion @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page, false)
    const [walletId] = await localSparkWalletIds(page)
    // Fail only the transport publication boundary. Real signing, journal,
    // readback, hook, storage and account lifecycle remain composed.
    await page.evaluate(
      async ({ core, accountRecovery }) => {
        const { getAccountSigner } = await import(core)
        const { getAccountSparkRecovery } = await import(accountRecovery)
        const service = getAccountSparkRecovery(getAccountSigner())
        service.input.transport.publish = async () => "rejected"
      },
      { core, accountRecovery }
    )
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await page
      .getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    const confirmation = page.getByRole("alertdialog")
    await confirmation.locator("#remove-recovery").check()
    await confirmation
      .getByRole("button", { name: "Remove wallet from account", exact: true })
      .click()
    await expect(
      confirmation.getByText(
        "Wallet removal has not reached recovery relays. Retry when recovery is available.",
        { exact: true }
      )
    ).toBeVisible()
    const retainedId = await page.evaluate(
      async ({ core, accountRecovery }) => {
        const { getAccountSigner } = await import(core)
        const { getAccountSparkRecovery } = await import(accountRecovery)
        return (
          await getAccountSparkRecovery(getAccountSigner()).discover(
            false,
            "mainnet",
            { priority: "foreground" }
          )
        ).registryEventId
      },
      { core, accountRecovery }
    )
    expect(retainedId).toBeTruthy()
    await page.reload()
    await installControlledWallet(page)
    await expect(page.getByRole("button", { name: /^Manage / })).toHaveCount(1)
    expect(await localSparkWalletIds(page)).toEqual([walletId])
    await retryWalletRecovery(page)
    await expect(page.getByRole("button", { name: /^Manage / })).toHaveCount(0)
    const registryEvents = await readTestRelayEvents({
      authors: [identity.pubkey],
      kinds: [30_078],
      "#d": ["conduit:spark:registry:v1:mainnet"],
    })
    expect(registryEvents.map((event) => event.id)).toEqual([retainedId])
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
