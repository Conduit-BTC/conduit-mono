import path from "node:path"
import { expect, test } from "@playwright/test"
import {
  installControlledWallet,
  observeWalletController,
  prepareControlledWallet,
} from "./helpers/wallet-fixture"
import { publishTestRelayEvents } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const recovery =
  "/@fs" + path.resolve("packages/core/src/wallets/account-spark-recovery.ts")
const phrase =
  "/@fs" + path.resolve("packages/core/src/wallets/spark-recovery.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const market =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
const merchant =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")

test.use({ trace: "off", screenshot: "off", video: "off" })

test("fresh Merchant restores a resolved Addy import after registry bootstrap @market", async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const marketPage = await context.newPage()
  const merchantPage = await context.newPage()
  try {
    await prepareControlledWallet(marketPage)
    await installRealTestSigner(marketPage, identity, relay)
    await marketPage.goto(market + "/wallet")
    await installControlledWallet(marketPage)
    const seeded = await marketPage.evaluate(
      async ({ core, recovery, phrase }) => {
        const { getAccountSigner } = await import(core)
        const { getAccountSparkRecovery } = await import(recovery)
        const { generateSparkMnemonic } = await import(phrase)
        const signer = getAccountSigner()!
        const mnemonic = generateSparkMnemonic()
        const walletId = crypto.randomUUID()
        const addy = await signer.signEvent({
          kind: 30078,
          pubkey: signer.pubkey,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "spark-wallet-backup"]],
          content: await signer.encryptNip44(signer.pubkey, mnemonic),
        })
        const service = getAccountSparkRecovery(signer)
        const backup = await service.prepare(
          { mnemonic, network: "mainnet", accountNumber: 7 },
          walletId
        )
        await service.deliver(backup.eventId)
        return { addy, walletId }
      },
      { core, recovery, phrase }
    )
    await publishTestRelayEvents([seeded.addy])
    expect(
      await marketPage.evaluate(
        async ({ core, recovery }) => {
          const signer = (await import(core)).getAccountSigner()!
          const found = await (
            await import(recovery)
          )
            .getAccountSparkRecovery(signer)
            .discover(false, "mainnet")
          return {
            registryAbsent: !found.registry,
            resolvedAddy: found.candidates.some(
              (candidate: { source: string; resolved?: boolean }) =>
                candidate.source === "addy" && candidate.resolved
            ),
            conduitCount: found.candidates.filter(
              (candidate: { source: string }) =>
                candidate.source === "conduit_v1"
            ).length,
          }
        },
        { core, recovery }
      )
    ).toEqual({ registryAbsent: true, resolvedAddy: true, conduitCount: 1 })

    await prepareControlledWallet(merchantPage)
    await observeWalletController(merchantPage)
    await installRealTestSigner(merchantPage, identity, relay)
    await merchantPage.goto(merchant + "/wallet")
    await installControlledWallet(merchantPage)
    await expect
      .poll(() =>
        merchantPage.evaluate(() => {
          const wallets = (window as any).__controlledWalletController
          const openedAccounts = (window as any).__walletProbe?.openedAccounts
          return {
            walletCount: wallets?.portableWallets.length ?? -1,
            openedAccount: openedAccounts?.[0] ?? null,
          }
        })
      )
      .toEqual({ walletCount: 1, openedAccount: 7 })
    expect(
      await merchantPage.evaluate(
        async ({ core, recovery, walletId }) => {
          const signer = (await import(core)).getAccountSigner()!
          const found = await (
            await import(recovery)
          )
            .getAccountSparkRecovery(signer)
            .discover(false, "mainnet")
          const wallets = (window as any).__controlledWalletController
          return {
            registryReady: found.registryMembershipReady,
            activeIds: found.registry?.activeWalletIds,
            walletIds: wallets.portableWallets.map(
              (wallet: { id: string }) => wallet.id
            ),
            openedAccounts: (window as any).__walletProbe.openedAccounts,
            sameWallet: wallets.portableWallets[0]?.id === walletId,
          }
        },
        { core, recovery, walletId: seeded.walletId }
      )
    ).toEqual({
      registryReady: true,
      activeIds: [seeded.walletId],
      walletIds: [seeded.walletId],
      openedAccounts: [7],
      sameWallet: true,
    })
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
