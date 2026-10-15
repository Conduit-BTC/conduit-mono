import {
  openWalletSetup,
  closeDefaultWalletSession,
  observeWalletController,
  installWalletReloadObservationBarrier,
  openWalletDuringDescriptorReload,
} from "./helpers/wallet-fixture"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { WalletDescriptor } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type { AccountSignerOperationOptions } from "@conduit/core/protocol/nostr-event-signer"
import type {
  SparkRecoveryRecord,
  SparkRecoveryTransport,
} from "@conduit/core/wallets/spark-recovery-service"
import {
  prepareControlledWallet,
  installControlledWallet,
  saveWalletRecovery as saved,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"
import { publishTestRelayEvents } from "./helpers/auth"
import {
  recordSmokeDiagnostic,
  recordSmokeFailureContext,
} from "./helpers/smoke-diagnostics"

type WalletFixtureWindow = Window & {
  nostr: {
    nip44: {
      decrypt(peer: string, ciphertext: string): Promise<string>
    }
  }
  __walletProbe: {
    opens: number
    disconnects: number
    registrations: number
    importMnemonic: string
    openedAccounts: number[]
    addressUnavailableReason?: string
    reloadHeld: boolean
    reloadReleased: boolean
    recoveryReads: number
    releaseReload(): void
  }
  __controlledWalletController: Omit<UseWalletsReturn, "unlockSpark"> & {
    unlockSpark(
      walletId: string,
      password?: string,
      migrate?: boolean,
      options?: Pick<AccountSignerOperationOptions, "priority">
    ): Promise<void>
  }
  __walletSignerGate: {
    mode: "deny" | "hold"
    entered: number
    exited: number
    release(): void
  }
  __backgroundRecoveryReadHeld: boolean
  __releaseBackgroundRecoveryRead(): void
  __backgroundOpen: Promise<string>
  __foregroundOpen: Promise<string>
  __secondForegroundOpen: Promise<string>
  __lateBackgroundRecoveryReadHeld: boolean
  __releaseLateBackgroundRecoveryRead(): void
  __restoreLateBackgroundRecoveryRead(): void
  __lateBackgroundOpen: Promise<string>
  __joinedLateBackgroundOpen: Promise<string>
  __clickedRecoverySync?: Promise<"resolved" | "rejected">
  __restoreClickedRecoverySync?: () => void
  __observeControlledWalletController?: (wallets: UseWalletsReturn) => void
  __watchClickedRecoverySync?: boolean
}

const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const storage =
  "/@fs" + path.resolve("packages/core/src/wallets/wallet-storage.ts")
const sparkSdk = "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const apps = {
  market: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"),
  merchant:
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"),
}
type WalletRaceWindow = Window & {
  __walletProbe: {
    savedMnemonic: string
    reloadHeld: boolean
    balanceHeld: boolean
    oldBalanceSettled: boolean
    failBalance: boolean
    releaseReload: () => void
    releaseBalance: () => void
  }
  __controlledWalletController: UseWalletsReturn
}
test.setTimeout(90000)
test.use({ trace: "off", screenshot: "off", video: "off" })
async function wallets(page: Page) {
  return page.evaluate(async (moduleUrl) => {
    const { db, getAccountSigner } = await import(moduleUrl)
    const owner = getAccountSigner().pubkey
    const descriptors = await db.wallets.toArray()
    const ids = []
    for (const wallet of descriptors) {
      const credential = await db.walletCredentials.get(wallet.id)
      if (credential && JSON.parse(credential.credential).ownerPubkey === owner)
        ids.push(wallet.id)
    }
    return ids
  }, core)
}

test("wallet names follow encrypted account recovery across apps and reloads @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const market = await context.newPage()
  const merchant = await context.newPage()
  const rename = async (page: Page, name: string, waitForSync = true) => {
    await page.getByRole("button", { name: /^Manage / }).click()
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Rename wallet" })
    await dialog.getByLabel("Wallet name", { exact: true }).fill(name)
    await dialog.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: `Manage ${name}`, exact: true })
    ).toBeVisible()
    if (waitForSync)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  __controlledWalletController?: UseWalletsReturn
                }
              ).__controlledWalletController?.nameSync
          )
        )
        .toBe("ready")
  }
  try {
    for (const page of [market, merchant]) {
      await observeWalletController(page)
      await prepareControlledWallet(page)
      await installRealTestSigner(page, identity, relay)
    }
    await market.goto(apps.market + "/wallet")
    await installControlledWallet(market)
    await openWalletSetup(market, "Create wallet")
    await saved(market)
    const original = await wallets(market)
    expect(original).toHaveLength(1)
    await rename(market, "Shared travel wallet")
    await merchant.goto(apps.merchant + "/wallet")
    await installControlledWallet(merchant)
    await expect(
      merchant.getByRole("button", {
        name: "Manage Shared travel wallet",
        exact: true,
      })
    ).toBeVisible()
    expect(await wallets(merchant)).toEqual(original)
    await rename(merchant, "Shared family wallet")
    await market.reload()
    await installControlledWallet(market)
    await expect(
      market.getByRole("button", {
        name: "Manage Shared family wallet",
        exact: true,
      })
    ).toBeVisible()
    expect(await wallets(market)).toEqual(original)
    await context.setOffline(true)
    await rename(market, "Offline travel wallet", false)
    await expect(
      market.getByText(
        "Wallet names saved on this device. Name sync is pending.",
        { exact: true }
      )
    ).toBeVisible()
    await context.setOffline(false)
    await market.reload()
    await installControlledWallet(market)
    await expect(
      market.getByRole("button", {
        name: "Manage Offline travel wallet",
        exact: true,
      })
    ).toBeVisible()
    await expect
      .poll(() =>
        market.evaluate(
          () =>
            (
              window as typeof window & {
                __controlledWalletController?: UseWalletsReturn
              }
            ).__controlledWalletController?.nameSync
        )
      )
      .toBe("ready")
    await merchant.reload()
    await installControlledWallet(merchant)
    await expect(
      merchant.getByRole("button", {
        name: "Manage Offline travel wallet",
        exact: true,
      })
    ).toBeVisible()
    expect(await wallets(merchant)).toEqual(original)
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

async function gateWalletSigner(page: Page) {
  await page.evaluate(async (moduleUrl) => {
    const { db } = await import(moduleUrl)
    const credential = (await db.walletCredentials.toArray())[0]
    const ciphertext = JSON.parse(credential.credential).ciphertext
    const fixture = window as unknown as WalletFixtureWindow
    const decrypt = fixture.nostr.nip44.decrypt
    const gate: WalletFixtureWindow["__walletSignerGate"] = {
      mode: "deny",
      entered: 0,
      exited: 0,
      release: () => {},
    }
    fixture.__walletSignerGate = gate
    fixture.nostr.nip44.decrypt = async (peer: string, value: string) => {
      if (value !== ciphertext) return decrypt(peer, value)
      gate.entered++
      try {
        if (gate.mode === "deny") throw new Error("Signer permission denied")
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
        return await decrypt(peer, value)
      } finally {
        gate.exited++
      }
    }
  }, core)
}

for (const app of ["market", "merchant"] as const) {
  test(`${app} gets a generated address and applies its card address to latest complete metadata @market @merchant`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await publishTestRelayEvents([
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            name: "Wallet fixture",
            about: "Original",
            lud16: "current@wallet.example",
            custom: { retain: true },
          }),
        }),
      ])
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps[app] + "/wallet")
      await installControlledWallet(page)
      await openWalletSetup(page, "Create wallet")
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByLabel("Conduit address name")).toHaveCount(0)
      await saved(page)
      await expect(
        page.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("current@wallet.example")
      await page
        .getByRole("button", { name: "Keep the current address", exact: true })
        .click()
      await page
        .getByRole("button", {
          name: "Set as public Lightning address",
          exact: true,
        })
        .click()
      await page.evaluate(
        async ({ core, app }) => {
          await (
            await import(core)
          ).publishProfileContext({ about: "Competing ordinary edit" }, app)
        },
        { core, app }
      )
      await page
        .getByRole("button", { name: "Use this wallet’s address", exact: true })
        .click()
      await expect(
        page.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("wallet1@breez.tips")
      const metadata = await page.evaluate(async (core) => {
        const { fetchProfileContext, getAccountSigner } = await import(core)
        const owner = getAccountSigner().pubkey
        const context = await fetchProfileContext(owner, {
          authenticatedPubkey: owner,
          accountPubkey: owner,
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "profile_edit",
        })
        const raw = JSON.parse(context.frontier.rawContent)
        return { name: raw.name, about: raw.about, custom: raw.custom }
      }, core)
      expect(metadata).toEqual({
        name: "Wallet fixture",
        about: "Competing ordinary edit",
        custom: { retain: true },
      })
      await expect(
        page.getByText("Default for merchant invoices", { exact: true })
      ).toBeVisible()
      await page.getByRole("button", { name: /^Manage Conduit Wallet/ }).click()
      await closeDefaultWalletSession(page)
      await expect(
        page.getByRole("button", { name: "Open wallet", exact: true })
      ).toBeVisible()
      await gateWalletSigner(page)
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(
        page.getByRole("alert").filter({ hasText: "authorization_denied" })
      ).toBeVisible()
      expect(
        await page.evaluate(
          () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
        )
      ).toBe(1)
      await page.evaluate(() => {
        ;(window as unknown as WalletFixtureWindow).__walletSignerGate.mode =
          "hold"
      })
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletFixtureWindow).__walletSignerGate
                .entered
          )
        )
        .toBe(2)
      // A descriptor reload while external permission is pending must retain
      // Opening and must not initialize another native wallet session.
      await page.evaluate(async (moduleUrl) => {
        const { db } = await import(moduleUrl)
        const wallet = (await db.wallets.toArray())[0]
        await db.wallets.update(wallet.id, { label: "Conduit Wallet renamed" })
      }, core)
      await expect(
        page.getByRole("button", { name: "Opening…", exact: true })
      ).toBeDisabled()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.evaluate(() =>
        (window as unknown as WalletFixtureWindow).__walletSignerGate.release()
      )
      await expect(page.getByText("Ready", { exact: true })).toBeVisible()
      expect(
        await page.evaluate(
          () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
        )
      ).toBe(2)
      await page.getByRole("button", { name: /^Manage Conduit Wallet/ }).click()
      await closeDefaultWalletSession(page)
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletFixtureWindow).__walletSignerGate
                .entered
          )
        )
        .toBe(3)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page
        .getByLabel(
          app === "market" ? "Open account menu" : "Open merchant account menu"
        )
        .click()
      await page
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click()
      await page.evaluate(() =>
        (window as unknown as WalletFixtureWindow).__walletSignerGate.release()
      )
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletFixtureWindow).__walletSignerGate
                .exited
          )
        )
        .toBe(3)
      expect(
        await page.evaluate(
          () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
        )
      ).toBe(2)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletFixtureWindow).__walletProbe
                ?.disconnects ?? 0
          )
        )
        .toBeGreaterThan(0)
      if (app === "merchant") await page.goto(apps[app] + "/wallet")
      await expect(
        page.getByRole("button", { name: /^Manage Conduit Wallet/ })
      ).toHaveCount(0)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
for (const from of ["market", "merchant"] as const) {
  for (const recoveryMode of ["automatic", "foreground"] as const) {
    test(`${from} imports a second main wallet and restores that selection through ${recoveryMode} recovery across origins @market @merchant`, async ({
      browser,
    }) => {
      const identity = createRuntimeSignerIdentity()
      const context = await browser.newContext()
      const source = await context.newPage()
      const target = await context.newPage()
      const to = from === "market" ? "merchant" : "market"
      let denyTargetRecovery = recoveryMode === "foreground"
      let explicitlyReopenedAccount: number | undefined
      let targetSignerDecryptCalls = 0
      let targetSignerDecryptDenials = 0
      try {
        for (const page of [source, target]) {
          await observeWalletController(page)
          if (
            page === target &&
            from === "market" &&
            recoveryMode === "foreground"
          )
            await installWalletReloadObservationBarrier(page)
          await prepareControlledWallet(page)
          await installRealTestSigner(page, identity, relay, {
            beforeDecrypt: () => {
              if (page === target) {
                targetSignerDecryptCalls++
                if (denyTargetRecovery) {
                  targetSignerDecryptDenials++
                  throw new Error("Signer permission denied")
                }
              }
            },
          })
        }
        await source.goto(apps[from] + "/wallet")
        await installControlledWallet(source)
        await openWalletSetup(source, "Create wallet")
        await saved(source)
        await expect(
          source.getByLabel("Lightning address", { exact: true })
        ).toHaveValue("wallet1@breez.tips")
        const first = (await wallets(source))[0]
        await openWalletSetup(source, "Import wallet")
        await source
          .getByLabel("Recovery phrase", { exact: true })
          .fill(
            await source.evaluate(
              () =>
                (window as unknown as WalletFixtureWindow).__walletProbe
                  .importMnemonic
            )
          )
        await source.getByText("Advanced settings", { exact: true }).click()
        await source
          .getByLabel("Spark account number", { exact: true })
          .fill("7")
        await source
          .getByRole("dialog")
          .getByRole("button", { name: "Import wallet", exact: true })
          .click()
        await saved(source, false)
        await source
          .getByRole("button", {
            name: "Keep the current address",
            exact: true,
          })
          .click()
        const ids = await wallets(source)
        expect(ids).toHaveLength(2)
        const selected = ids.find((id) => id !== first)!
        const selectedLabel = await source.evaluate(
          async ({ storage, core, selected }) => {
            const { getMarketWalletStore } = await import(storage)
            const { getWalletDisplayLabels, getAccountSigner } = await import(
              core
            )
            const visible = await getMarketWalletStore().listVisible(
              getAccountSigner().pubkey
            )
            return getWalletDisplayLabels(visible).get(selected)!
          },
          { storage, core, selected }
        )
        await source
          .getByRole("button", { name: `Manage ${selectedLabel}`, exact: true })
          .click()
        await source
          .getByRole("menuitem", {
            name: "Make main wallet across apps",
            exact: true,
          })
          .click()
        await expect
          .poll(() =>
            source.evaluate(
              async ({ storage, core, selected }) => {
                const { getMarketWalletStore } = await import(storage)
                const { getAccountSigner } = await import(core)
                return (
                  await getMarketWalletStore().listVisible(
                    getAccountSigner().pubkey
                  )
                )
                  .find((wallet: WalletDescriptor) => wallet.id === selected)
                  ?.defaultIntents.sort()
              },
              { storage, core, selected }
            )
          )
          .toEqual(["pay_invoice", "receive"])
        await expect(
          source.getByLabel("Lightning address", { exact: true })
        ).toHaveValue("wallet1@breez.tips")
        await target.goto(apps[to] + "/wallet")
        await installControlledWallet(target, false, "support@conduit.cash")
        if (recoveryMode === "foreground") {
          await expect(
            target.getByText(
              "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
              { exact: true }
            )
          ).toBeVisible()
          expect(await wallets(target)).toHaveLength(0)
          denyTargetRecovery = false
          await openWalletSetup(target, "Create wallet")
          const dialog = target.getByRole("dialog")
          await expect(
            dialog.getByRole("heading", {
              name: "Wallet imported",
              exact: true,
            })
          ).toBeVisible()
          await expect(
            dialog.getByLabel("Make this my main wallet", { exact: true })
          ).not.toBeChecked()
          await saved(target, false)
          if (from === "market")
            explicitlyReopenedAccount =
              await openWalletDuringDescriptorReload(target)
          // Background consent remains paused; explicitly open the other
          // restored wallet instead of assuming automatic consent resumed.
          const openWallet = target.getByRole("button", {
            name: "Open wallet",
            exact: true,
          })
          try {
            await expect(openWallet).toHaveCount(1)
          } catch (error) {
            const safe = {
              signerDecryptCalls: targetSignerDecryptCalls,
              signerDecryptDenials: targetSignerDecryptDenials,
              observationAvailable: false,
            } as Record<string, string | number | boolean>
            try {
              const observed = await target.evaluate(
                async ({ core, storage, sparkSdk }) => {
                  const { getAccountSigner } = await import(core)
                  const { getMarketWalletStore } = await import(storage)
                  const { getSparkWalletManager } = await import(sparkSdk)
                  const visible = await getMarketWalletStore().listVisible(
                    getAccountSigner()?.pubkey ?? null
                  )
                  const manager = getSparkWalletManager()
                  const controller = (window as unknown as WalletRaceWindow)
                    .__controlledWalletController
                  const runtime = controller.runtime
                  const stateCount = (status: string) =>
                    visible.filter(
                      (wallet: WalletDescriptor) =>
                        controller.runtime[wallet.id]?.status === status
                    ).length
                  return {
                    runtimeLockedCount: stateCount("locked"),
                    runtimeConnectingCount: stateCount("connecting"),
                    runtimeReadyCount: stateCount("ready"),
                    runtimeErrorCount: stateCount("error"),
                    runtimeMissingCount: visible.filter(
                      (wallet: WalletDescriptor) =>
                        !controller.runtime[wallet.id]
                    ).length,
                    sparkAvailability: controller.sparkAvailability.status,
                    visibleWalletCount: visible.length,
                    nativeOpenCount: visible.filter(
                      (wallet: WalletDescriptor) => manager?.isOpen(wallet.id)
                    ).length,
                    nativeErrorCount: visible.filter(
                      (wallet: WalletDescriptor) =>
                        manager?.isOpen(wallet.id) &&
                        runtime[wallet.id]?.status === "error"
                    ).length,
                    nativeLockedCount: visible.filter(
                      (wallet: WalletDescriptor) =>
                        manager?.isOpen(wallet.id) &&
                        runtime[wallet.id]?.status === "locked"
                    ).length,
                  }
                },
                { core, storage, sparkSdk }
              )
              Object.assign(safe, observed, {
                openButtonCount: await openWallet.count(),
                openingButtonCount: await target
                  .getByRole("button", { name: "Opening…", exact: true })
                  .count(),
                readyCount: await target
                  .getByText("Ready", { exact: true })
                  .count(),
                recoveryNotice: (await target
                  .getByText(
                    "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
                    { exact: true }
                  )
                  .isVisible())
                  ? "blocked"
                  : (await target
                        .getByText("Checking encrypted wallet recovery…", {
                          exact: true,
                        })
                        .isVisible())
                    ? "checking"
                    : (await target
                          .getByText(
                            "Recovery sync is pending. Save your recovery details before switching apps.",
                            { exact: true }
                          )
                          .isVisible())
                      ? "pending"
                      : "absent",
                observationAvailable: true,
              })
            } catch {
              // Preserve the original assertion when the observation is unavailable.
            }
            recordSmokeDiagnostic(test.info(), "wallet-foreground-open", safe)
            throw error
          }
          if (from === "market")
            await target.evaluate(() =>
              (
                window as typeof window & {
                  __releaseControlledWalletBalance?: () => void
                }
              ).__releaseControlledWalletBalance?.()
            )
          await openWallet.click()
        }
        await expect.poll(async () => (await wallets(target)).length).toBe(2)
        await expect
          .poll(() =>
            target.evaluate(() =>
              (
                window as unknown as WalletFixtureWindow
              ).__walletProbe.openedAccounts.sort()
            )
          )
          .toEqual(
            [
              1,
              7,
              ...(explicitlyReopenedAccount === undefined
                ? []
                : [explicitlyReopenedAccount]),
            ].sort()
          )
        const state = await target.evaluate(
          async ({ core, storage, selected }) => {
            const { getAccountSigner } = await import(core)
            const { getMarketWalletStore } = await import(storage)
            const descriptor = (
              await getMarketWalletStore().listVisible(
                getAccountSigner()?.pubkey ?? null
              )
            ).find((wallet: WalletDescriptor) => wallet.id === selected)!
            return {
              intents: descriptor.defaultIntents,
              registrations: (window as unknown as WalletFixtureWindow)
                .__walletProbe.registrations,
            }
          },
          { core, storage, selected }
        )
        expect(state.intents.sort()).toEqual(["pay_invoice", "receive"])
        expect(state.registrations).toBe(0)
        expect((await wallets(target)).sort()).toEqual(ids.sort())
        await expect(
          target.getByLabel("Lightning address", { exact: true })
        ).toHaveValue("wallet1@breez.tips")
        await expect(
          target.getByText("Default for merchant invoices", { exact: true })
        ).toBeVisible()
        await expect(
          target.getByRole("button", { name: "Open wallet", exact: true })
        ).toHaveCount(0)
        await expect(target.getByRole("dialog")).toHaveCount(0)
        await expect(target.getByText("Ready", { exact: true })).toHaveCount(2)
        // All recovered signer-backed wallets open, independent of main selection.
        await expect(
          target.getByText("Receiving address: support@conduit.cash", {
            exact: true,
          })
        ).toHaveCount(2)
      } finally {
        await context.close()
        disposeRuntimeSignerIdentity(identity)
      }
    })
  }
}
for (const app of ["market", "merchant"] as const) {
  test(`${app} explicitly retries declined relay recovery without poisoning evidence or resuming background decryption @market @merchant`, async ({
    browser,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const context = await browser.newContext()
    const source = await context.newPage()
    const target = await context.newPage()
    const from = app === "market" ? "merchant" : "market"
    let denied = true
    let decryptRequests = 0
    try {
      for (const page of [source, target]) await prepareControlledWallet(page)
      await installRealTestSigner(source, identity, relay)
      await installRealTestSigner(target, identity, relay, {
        beforeDecrypt: () => {
          decryptRequests++
          if (denied) throw new Error("Signer permission denied")
        },
      })
      await source.goto(apps[from] + "/wallet")
      await installControlledWallet(source)
      await openWalletSetup(source, "Create wallet")
      await saved(source)
      const originalWallets = await wallets(source)
      expect(originalWallets).toHaveLength(1)

      await target.goto(apps[app] + "/wallet")
      await installControlledWallet(target)
      const blocked = target.getByText(
        "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
        { exact: true }
      )
      await expect(blocked).toBeVisible()
      expect(decryptRequests).toBe(1)
      expect(await wallets(target)).toHaveLength(0)
      const journal = () =>
        target.evaluate(async (moduleUrl) => {
          const { db, getAccountSigner } = await import(moduleUrl)
          const evidence = await db.sparkRecoveryEvidence.get(
            getAccountSigner().pubkey
          )
          return {
            retained: evidence?.records.length ?? 0,
            unresolved: evidence?.unresolvedObserved ?? false,
          }
        }, core)
      expect((await journal()).retained).toBeGreaterThan(0)
      expect((await journal()).unresolved).toBe(false)

      denied = false
      await target
        .getByRole("button", { name: "Sync wallet recovery", exact: true })
        .click()
      await expect.poll(() => wallets(target)).toEqual(originalWallets)
      await expect(blocked).toHaveCount(0)
      expect((await journal()).unresolved).toBe(false)
      // Explicit recovery must not silently resume consent for background reads.
      const backgroundCode = await target.evaluate(async (moduleUrl) => {
        const { getAccountSigner } = await import(moduleUrl)
        try {
          await getAccountSigner().decryptNip44(
            getAccountSigner().pubkey,
            "unused",
            { priority: "background" }
          )
          return "unexpected_success"
        } catch (error) {
          return (error as { code?: string }).code
        }
      }, core)
      expect(backgroundCode).toBe("background_paused")
      await target
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect(target.getByText("Ready", { exact: true })).toBeVisible()
      expect(
        await target.evaluate(
          () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
        )
      ).toBe(1)
      expect(await wallets(target)).toEqual(originalWallets)
    } finally {
      await context.close()
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("foreground Open does not inherit a paused background wallet open @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const source = await context.newPage()
  const target = await context.newPage()
  let denied = true
  try {
    for (const page of [source, target]) await prepareControlledWallet(page)
    await observeWalletController(target)
    await installRealTestSigner(source, identity, relay)
    await installRealTestSigner(target, identity, relay, {
      beforeDecrypt: () => {
        if (denied) throw new Error("Signer permission denied")
      },
    })
    await source.goto(apps.market + "/wallet")
    await installControlledWallet(source)
    await openWalletSetup(source, "Create wallet")
    await saved(source)
    const originalWallets = await wallets(source)
    expect(originalWallets).toHaveLength(1)
    await target.goto(apps.merchant + "/wallet")
    await installControlledWallet(target)
    await expect(
      target.getByText(
        "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
        { exact: true }
      )
    ).toBeVisible()
    denied = false
    await target.getByRole("button", { name: "Sync wallet recovery" }).click()
    await expect.poll(() => wallets(target)).toEqual(originalWallets)
    await expect(
      target.getByRole("button", { name: "Open wallet", exact: true })
    ).toBeVisible()

    await target.evaluate(async (storage) => {
      const { getMarketWalletStore } = await import(storage)
      const fixture = window as unknown as WalletFixtureWindow
      const controller = fixture.__controlledWalletController
      const walletId = controller.portableWallets[0].id
      const store = getMarketWalletStore()
      const original = store.getSparkRecovery.bind(store)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let armed = true
      store.getSparkRecovery = async (id: string) => {
        const recovery = await original(id)
        if (armed && id === walletId) {
          armed = false
          fixture.__backgroundRecoveryReadHeld = true
          await gate
        }
        return recovery
      }
      fixture.__releaseBackgroundRecoveryRead = release
      const result = (promise: Promise<void>) =>
        promise.then(
          () => "resolved",
          (error: { code?: string }) => error.code ?? "rejected"
        )
      fixture.__backgroundOpen = result(
        controller.unlockSpark(walletId, "", false, {
          priority: "background",
        })
      )
    }, storage)
    await expect
      .poll(() =>
        target.evaluate(
          () =>
            (window as unknown as WalletFixtureWindow)
              .__backgroundRecoveryReadHeld
        )
      )
      .toBe(true)
    await target.evaluate(() => {
      const fixture = window as unknown as WalletFixtureWindow
      const controller = fixture.__controlledWalletController
      const walletId = controller.portableWallets[0].id
      fixture.__foregroundOpen = controller.unlockSpark(walletId).then(
        () => "resolved",
        (error: { code?: string }) => error.code ?? "rejected"
      )
      fixture.__secondForegroundOpen = controller.unlockSpark(walletId).then(
        () => "resolved",
        (error: { code?: string }) => error.code ?? "rejected"
      )
      fixture.__releaseBackgroundRecoveryRead()
    })
    const result = await target.evaluate(async () => {
      const fixture = window as unknown as WalletFixtureWindow
      return {
        background: await fixture.__backgroundOpen,
        foreground: await fixture.__foregroundOpen,
        secondForeground: await fixture.__secondForegroundOpen,
        nativeOpens: fixture.__walletProbe.opens,
      }
    })
    expect(result).toEqual({
      background: "background_paused",
      foreground: "resolved",
      secondForeground: "resolved",
      nativeOpens: 1,
    })
    await expect(target.getByText("Ready", { exact: true })).toBeVisible()
    expect(await wallets(target)).toEqual(originalWallets)
    expect(
      await target.evaluate(async (moduleUrl) => {
        const { getAccountSigner } = await import(moduleUrl)
        const signer = getAccountSigner()
        try {
          await signer.decryptNip44(signer.pubkey, "unused", {
            priority: "background",
          })
          return "unexpected_success"
        } catch (error) {
          return (error as { code?: string }).code
        }
      }, core)
    ).toBe("background_paused")
  } finally {
    await target
      .evaluate(() =>
        (
          window as unknown as WalletFixtureWindow
        ).__releaseBackgroundRecoveryRead?.()
      )
      .catch(() => undefined)
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const size of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const from of ["market", "merchant"] as const) {
    test(
      size.name +
        " " +
        from +
        " setup restores the same identity in the other app @market @merchant",
      async ({ browser }) => {
        const identity = createRuntimeSignerIdentity()
        const context = await browser.newContext({ viewport: size })
        const source = await context.newPage()
        const target = await context.newPage()
        const to = from === "market" ? "merchant" : "market"
        try {
          for (const page of [source, target]) {
            await prepareControlledWallet(page)
            await installRealTestSigner(page, identity, relay)
          }
          await source.goto(apps[from] + "/wallet")
          await expect(
            source.getByRole("heading", { name: "My wallets", exact: true })
          ).toBeVisible()
          await installControlledWallet(source)
          await expect(
            source.getByText(
              "Mainnet uses real bitcoin. Save your recovery details before receiving funds.",
              { exact: true }
            )
          ).toHaveCount(0)
          expect(
            await source.evaluate(
              () =>
                (window as unknown as WalletFixtureWindow).__walletProbe.opens
            )
          ).toBe(0)
          await openWalletSetup(source, "Create wallet")
          await saved(source)
          const sourceIds = await wallets(source)
          expect(sourceIds).toHaveLength(1)

          await target.goto(apps[to] + "/wallet")

          await target
            .getByText("External wallet management", { exact: true })
            .click()
          await expect(
            target.getByRole("heading", {
              name: "External wallets",
              exact: true,
            })
          ).toBeVisible()

          await installControlledWallet(target, false, "wallet1@breez.tips")
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await expect(
            target.getByRole("button", { name: "Open wallet", exact: true })
          ).toHaveCount(0)
          await expect(
            target.getByRole("button", { name: "Receive", exact: true })
          ).toBeVisible()
          expect(
            await target.evaluate(
              () =>
                (window as unknown as WalletFixtureWindow).__walletProbe
                  .registrations
            )
          ).toBe(0)
          expect(
            await target.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true)
          await target.screenshot({
            path: "/tmp/635-" + to + "-" + size.name + "-shared-wallet.png",
            mask: [
              target.locator("input, textarea, .font-mono, .tabular-nums"),
              target.getByText(/^Receiving address:/),
              target.getByText(/^[\d,]+ sats$/),
              target.getByLabel(
                to === "market"
                  ? "Open account menu"
                  : "Open merchant account menu"
              ),
            ],
          })
        } finally {
          await context.close()
          disposeRuntimeSignerIdentity(identity)
        }
      }
    )
  }
}
for (const size of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const from of ["market", "merchant"] as const) {
    test(
      size.name +
        " " +
        from +
        " import preserves receiving address in the other app @market @merchant",
      async ({ browser }) => {
        const identity = createRuntimeSignerIdentity()
        const context = await browser.newContext({ viewport: size })
        const source = await context.newPage()
        const target = await context.newPage()
        const to = from === "market" ? "merchant" : "market"
        try {
          for (const page of [source, target]) {
            await prepareControlledWallet(page)
            await installRealTestSigner(page, identity, relay)
          }
          await source.goto(apps[from] + "/wallet")
          await expect(
            source.getByRole("heading", { name: "My wallets", exact: true })
          ).toBeVisible()
          await installControlledWallet(source)
          await openWalletSetup(source, "Import wallet")
          const phrase = await source.evaluate(
            () =>
              (window as unknown as WalletFixtureWindow).__walletProbe
                .importMnemonic
          )
          await source
            .getByLabel("Recovery phrase", { exact: true })
            .fill(phrase)
          await source
            .getByRole("dialog")
            .getByRole("button", { name: "Import wallet", exact: true })
            .click()
          await saved(source)
          await expect(
            source.getByLabel("Lightning address", { exact: true })
          ).toHaveValue("")
          const sourceIds = await wallets(source)
          expect(sourceIds).toHaveLength(1)

          await target.goto(apps[to] + "/wallet")

          await target
            .getByText("External wallet management", { exact: true })
            .click()
          await expect(
            target.getByRole("heading", {
              name: "External wallets",
              exact: true,
            })
          ).toBeVisible()

          await installControlledWallet(target, false, "support@conduit.cash")
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await expect(
            target.getByRole("button", { name: "Open wallet", exact: true })
          ).toHaveCount(0)
          await expect(
            target.getByRole("button", { name: "Receive", exact: true })
          ).toBeVisible()
          expect(
            await target.evaluate(
              () =>
                (window as unknown as WalletFixtureWindow).__walletProbe
                  .registrations
            )
          ).toBe(0)
          expect(
            await target.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true)
          await expect(
            target.getByLabel("Lightning address", { exact: true })
          ).toHaveValue("")
          await target.screenshot({
            path:
              "/tmp/635-" + to + "-" + size.name + "-import-shared-wallet.png",
            mask: [
              target.locator("input, textarea, .font-mono, .tabular-nums"),
              target.getByText(/^Receiving address:/),
              target.getByText(/^[\d,]+ sats$/),
              target.getByLabel(
                to === "market"
                  ? "Open account menu"
                  : "Open merchant account menu"
              ),
            ],
          })
        } finally {
          await context.close()
          disposeRuntimeSignerIdentity(identity)
        }
      }
    )
  }
}
test("controlled recovery transport retains concurrent signed branches and blocks another wallet on retry @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const pages = [await context.newPage(), await context.newPage()]
  try {
    for (const [index, page] of pages.entries()) {
      await prepareControlledWallet(page)
      await installRealTestSigner(page, identity, relay)
      await page.goto((index ? apps.merchant : apps.market) + "/wallet")
      await expect(
        page.getByRole("heading", { name: "My wallets", exact: true })
      ).toBeVisible()
      await installControlledWallet(page)
      // Partition recovery transport so both origins sign independent registry
      // branches before discovery; a single replaceable-event relay cannot
      // retain both independent histories.
      await page.evaluate(
        async ({ core, recoveryModule }) => {
          const { getAccountSigner } = await import(core)
          const { getAccountSparkRecovery } = await import(recoveryModule)
          const service = getAccountSparkRecovery(getAccountSigner())
          const transport = (
            service as unknown as {
              input: { transport: SparkRecoveryTransport }
            }
          ).input.transport
          type RecoveryEvent = Parameters<SparkRecoveryTransport["publish"]>[1]
          const events = new Map<string, RecoveryEvent>()
          const controlledWindow = window as unknown as {
            __controlledRecoveryEvents: Map<string, RecoveryEvent>
          }
          controlledWindow.__controlledRecoveryEvents = events
          transport.publish = async (_url, event, shouldContinue) => {
            if (!shouldContinue()) return "cancelled"
            events.set(event.id, event)
            return "acked"
          }
          transport.read = async (
            _url,
            owner,
            eventId,
            shouldContinue,
            dTag
          ) => {
            if (!shouldContinue()) return { status: "unavailable", events: [] }
            return {
              status: "complete",
              events: [...events.values()].filter(
                (event) =>
                  event.pubkey === owner &&
                  (!eventId || event.id === eventId) &&
                  (!dTag ||
                    event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag))
              ),
            }
          }
        },
        {
          core,
          recoveryModule:
            "/@fs" +
            path.resolve("packages/core/src/wallets/account-spark-recovery.ts"),
        }
      )
    }
    await Promise.all(
      pages.map((page) =>
        page.getByRole("button", { name: "Add a wallet", exact: true }).click()
      )
    )
    await Promise.all(pages.map((page) => saved(page, false)))
    const snapshots = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          type RecoveryEvent = Parameters<SparkRecoveryTransport["publish"]>[1]
          const controlledWindow = window as unknown as {
            __controlledRecoveryEvents: Map<string, RecoveryEvent>
          }
          return [...controlledWindow.__controlledRecoveryEvents.values()]
        })
      )
    )
    const coordinates = snapshots.map((events) =>
      events.map((event) => event.tags.find((tag) => tag[0] === "d")?.[1] ?? "")
    )
    for (const values of coordinates)
      expect({
        backup: values.some((value) =>
          value.startsWith("conduit:spark:wallet:v1:")
        ),
        primary: values.some((value) =>
          value.startsWith("conduit:spark:primary:v1:")
        ),
        registry: values.some((value) =>
          value.startsWith("conduit:spark:registry:v1:")
        ),
      }).toEqual({ backup: true, primary: true, registry: true })
    const registryIds = snapshots.map(
      (events) =>
        events.find((event) =>
          event.tags.some(
            (tag) =>
              tag[0] === "d" && tag[1].startsWith("conduit:spark:registry:v1:")
          )
        )?.id
    )
    expect(registryIds.every(Boolean)).toBe(true)
    expect(new Set(registryIds).size).toBe(2)
    const combined = snapshots.flat()
    await Promise.all(
      pages.map((page) =>
        page.evaluate((events) => {
          type RecoveryEvent = Parameters<SparkRecoveryTransport["publish"]>[1]
          const controlledWindow = window as unknown as {
            __controlledRecoveryEvents: Map<string, RecoveryEvent>
          }
          const store = controlledWindow.__controlledRecoveryEvents
          for (const event of events) store.set(event.id, event)
        }, combined)
      )
    )
    for (const page of pages)
      expect(
        await page.evaluate((ids) => {
          type RecoveryEvent = Parameters<SparkRecoveryTransport["publish"]>[1]
          const controlledWindow = window as unknown as {
            __controlledRecoveryEvents: Map<string, RecoveryEvent>
          }
          return ids.every(
            (id) =>
              typeof id === "string" &&
              controlledWindow.__controlledRecoveryEvents.has(id)
          )
        }, registryIds)
      ).toBe(true)
    const originalWallets = await Promise.all(pages.map(wallets))
    for (const ids of originalWallets) expect(ids).toHaveLength(1)
    expect(new Set(originalWallets.flat()).size).toBe(2)
    for (const [index, page] of pages.entries()) {
      await page
        .getByRole("button", { name: "Sync wallet recovery", exact: true })
        .click()
      await expect(
        page.getByText(
          "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
          { exact: true }
        )
      ).toBeVisible()
      // Conflicting discovery retains both backups without restoring an
      // ambiguous wallet into either device's usable wallet list.
      expect(await wallets(page)).toEqual(originalWallets[index])
      const retainedBackups = await page.evaluate(async (moduleUrl) => {
        const { db, getAccountSigner } = await import(moduleUrl)
        const evidence = await db.sparkRecoveryEvidence.get(
          getAccountSigner().pubkey
        )
        return evidence.records.flatMap((record: SparkRecoveryRecord) =>
          record.event.tags
            .filter(
              (tag: readonly string[]) =>
                tag[0] === "d" && tag[1].startsWith("conduit:spark:wallet:v1:")
            )
            .map((tag: readonly string[]) =>
              tag[1].slice("conduit:spark:wallet:v1:".length)
            )
        )
      }, core)
      expect([...new Set(retainedBackups)].sort()).toEqual(
        originalWallets.flat().sort()
      )
      const before = (await wallets(page)).sort()
      await openWalletSetup(page, "Create wallet")
      const blockedCreation = page.getByRole("dialog").getByRole("status")
      await expect(blockedCreation).toHaveText(
        "Wallet recovery is incomplete or conflicting. Retry recovery before creating or importing another wallet."
      )
      const opens = await page.evaluate(
        () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
      )
      await page
        .getByRole("button", { name: "Retry creation", exact: true })
        .click()
      await expect(blockedCreation).toHaveText(
        "Wallet recovery is incomplete or conflicting. Retry recovery before creating or importing another wallet."
      )
      expect((await wallets(page)).sort()).toEqual(before)
      expect(
        await page.evaluate(
          () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
        )
      ).toBe(opens)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
    }
  } finally {
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(
    app +
      " disabled address support leaves invoice receive usable @market @merchant",
    async ({ browser }) => {
      const identity = createRuntimeSignerIdentity()
      const context = await browser.newContext()
      const page = await context.newPage()
      try {
        await prepareControlledWallet(page)
        await installRealTestSigner(page, identity, relay)
        await page.goto(apps[app] + "/wallet")
        await expect(
          page.getByRole("heading", { name: "My wallets", exact: true })
        ).toBeVisible()
        await installControlledWallet(page)
        await page.evaluate(() => {
          ;(
            window as unknown as WalletFixtureWindow
          ).__walletProbe.addressUnavailableReason = "unconfigured"
        })
        await expect(
          page.getByText(
            "Mainnet uses real bitcoin. Save your recovery details before receiving funds.",
            { exact: true }
          )
        ).toHaveCount(0)
        expect(
          await page.evaluate(
            () => (window as unknown as WalletFixtureWindow).__walletProbe.opens
          )
        ).toBe(0)
        await openWalletSetup(page, "Create wallet")
        await saved(page)
        await expect(
          page.getByText(
            "Receiving address: Lightning addresses are not enabled in this build.",
            { exact: true }
          )
        ).toBeVisible()
        await expect(
          page.getByRole("button", { name: "Retry address setup", exact: true })
        ).toHaveCount(0)
        await page.getByRole("button", { name: "Receive", exact: true }).click()
        await expect(
          page.getByRole("button", {
            name: "Create Lightning invoice",
            exact: true,
          })
        ).toBeEnabled()
      } finally {
        await context.close()
        expect(disposeRuntimeSignerIdentity(identity)).toBe(true)
      }
    }
  )
}

for (const app of ["market", "merchant"] as const) {
  for (const blankLud16 of [false, true]) {
    for (const operation of ["replace", "clear"] as const) {
      test(`${app} ${operation}s a legacy public address with ${blankLud16 ? "blank" : "absent"} lud16 while retaining metadata @market @merchant`, async ({
        page,
      }) => {
        const identity = createRuntimeSignerIdentity()
        try {
          const metadata = {
            name: "Address fixture",
            custom: { keep: [1, "two"] },
          }
          await publishTestRelayEvents([
            signRuntimeTestEvent(identity, {
              kind: 0,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: JSON.stringify({
                ...metadata,
                ...(blankLud16 ? { lud16: " \t " } : {}),
                lud06: "  https://wallet.example/LNURL/Token  ",
              }),
            }),
          ])
          await prepareControlledWallet(page)
          await installRealTestSigner(page, identity, relay)
          await page.goto(apps[app] + "/wallet")
          await installControlledWallet(page)
          const address = page.getByLabel("Lightning address", { exact: true })
          await expect(address).toHaveValue(
            "https://wallet.example/LNURL/Token"
          )
          const retained = () =>
            page.evaluate(async (core) => {
              const { fetchProfileContext, getAccountSigner } = await import(
                core
              )
              const owner = getAccountSigner().pubkey
              const context = await fetchProfileContext(owner, {
                authenticatedPubkey: owner,
                accountPubkey: owner,
                skipCache: true,
                requireCompleteEvidence: true,
                evidenceScope: "profile_edit",
              })
              return JSON.parse(context.frontier.rawContent)
            }, core)
          // An ordinary edit after review must survive the address-only save.
          await page.evaluate(
            async ({ core, app }) => {
              const { publishProfileContext } = await import(core)
              await publishProfileContext({ about: "Ordinary edit" }, app)
            },
            { core, app }
          )
          const completeMetadata = { ...metadata, about: "Ordinary edit" }
          if (operation === "replace") {
            await address.fill("new@wallet.example")
            await page
              .getByRole("button", {
                name: "Save public address",
                exact: true,
              })
              .click()
            await expect.poll(retained).toEqual({
              ...completeMetadata,
              lud16: "new@wallet.example",
            })
            await expect(address).toHaveValue("new@wallet.example")
          }
          await address.fill("")
          await page
            .getByRole("button", {
              name: "Save public address",
              exact: true,
            })
            .click()
          await expect.poll(retained).toEqual(completeMetadata)
          await page.reload()
          await expect(address).toHaveValue("")
          await expect(
            page.getByText("Current address: None", {
              exact: true,
            })
          ).toBeVisible()
          expect(await retained()).toEqual(completeMetadata)
        } finally {
          disposeRuntimeSignerIdentity(identity)
        }
      })
    }
  }
}

test("wallet reload cannot overwrite a newer lock state @market", async ({
  page,
}) => {
  test.setTimeout(20_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page.evaluate(
      async ({ core, managerUrl }) => {
        const { db } = await import(core)
        const { getSparkWalletManager } = await import(managerUrl)
        const manager = getSparkWalletManager()
        const read = manager.getBalance.bind(manager)
        const probe = (window as unknown as WalletFixtureWindow).__walletProbe
        probe.reloadHeld = false
        probe.releaseReload = () => {}
        const gate = new Promise<void>((resolve) => {
          probe.releaseReload = () => {
            probe.reloadReleased = true
            resolve()
          }
        })
        manager.getBalance = async (id: string) => {
          const balance = await read(id)
          if (!probe.reloadReleased) {
            probe.reloadHeld = true
            await gate
          }
          return balance
        }
        const wallet = (await db.wallets.toArray())[0]
        await db.wallets.update(wallet.id, { label: "Reload gated wallet" })
      },
      {
        core,
        managerUrl:
          "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts"),
      }
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as WalletFixtureWindow).__walletProbe.reloadHeld
        )
      )
      .toBe(true)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)
    await page.evaluate(() =>
      (window as unknown as WalletFixtureWindow).__walletProbe.releaseReload()
    )
    await expect(
      page.getByLabel("Manage Reload gated wallet", { exact: true })
    ).toBeVisible()
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("wallet reload cannot overwrite a newer open state @market", async ({
  page,
}) => {
  test.setTimeout(20_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)
    await page.evaluate(
      async ({ core, storage }) => {
        const { db } = await import(core)
        const { getMarketWalletStore } = await import(storage)
        const store = getMarketWalletStore()
        const read = store.getSparkRecovery.bind(store)
        const probe = (window as unknown as WalletFixtureWindow).__walletProbe
        probe.recoveryReads = 0
        probe.reloadHeld = false
        const gate = new Promise<void>((resolve) => {
          probe.releaseReload = resolve
        })
        store.getSparkRecovery = async (id: string) => {
          const recovery = await read(id)
          // listVisible is the first credential read; reload's metadata read
          // follows its runtime snapshot and is the second read.
          if (++probe.recoveryReads === 2) {
            probe.reloadHeld = true
            await gate
          }
          return recovery
        }
        const wallet = (await db.wallets.toArray())[0]
        await db.wallets.update(wallet.id, { label: "Reload gated wallet" })
      },
      { core, storage }
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as WalletFixtureWindow).__walletProbe.reloadHeld
        )
      )
      .toBe(true)
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page.evaluate(() =>
      (window as unknown as WalletFixtureWindow).__walletProbe.releaseReload()
    )
    await expect(
      page.getByLabel("Manage Reload gated wallet", { exact: true })
    ).toBeVisible()
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("wallet reload shows a newly native-open wallet while balance refresh is pending @market", async ({
  page,
}) => {
  test.setTimeout(25_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)

    await page.evaluate(
      async ({ core, storage, managerUrl }) => {
        const { db } = await import(core)
        const { getMarketWalletStore } = await import(storage)
        const { getSparkWalletManager } = await import(managerUrl)
        const store = getMarketWalletStore()
        const manager = getSparkWalletManager()!
        const probe = (window as unknown as WalletRaceWindow).__walletProbe
        const readRecovery = store.getSparkRecovery.bind(store)
        const readBalance = manager.getBalance.bind(manager)
        let recoveryReads = 0
        const reloadGate = new Promise<void>((resolve) => {
          probe.releaseReload = resolve
        })
        const balanceGate = new Promise<void>((resolve) => {
          probe.releaseBalance = resolve
        })
        probe.reloadHeld = false
        probe.balanceHeld = false
        store.getSparkRecovery = async (id: string) => {
          const recovery = await readRecovery(id)
          // listVisible reads the credential first. This second read follows
          // the reload's snapshot of the still-closed native wallet.
          if (++recoveryReads === 2) {
            probe.reloadHeld = true
            await reloadGate
          }
          return recovery
        }
        manager.getBalance = async (id: string) => {
          const balance = await readBalance(id)
          probe.balanceHeld = true
          await balanceGate
          return balance
        }
        const wallet = (await db.wallets.toArray())[0]
        await db.wallets.update(wallet.id, {
          label: "Native-open reload wallet",
        })
      },
      {
        core,
        storage,
        managerUrl:
          "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts"),
      }
    )
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as WalletRaceWindow).__walletProbe.reloadHeld
        )
      )
      .toBe(true)
    await page.evaluate(
      async (managerUrl) => {
        const { getSparkWalletManager } = await import(managerUrl)
        const probe = (window as unknown as WalletRaceWindow).__walletProbe
        const controller = (window as unknown as WalletRaceWindow)
          .__controlledWalletController
        const walletId = controller.portableWallets[0].id
        await getSparkWalletManager()!.openWithMnemonic({
          walletId,
          mnemonic: probe.savedMnemonic,
          accountNumber: 1,
        })
      },
      "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts")
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as WalletRaceWindow).__walletProbe.balanceHeld
        )
      )
      .toBe(true)
    await page.evaluate(() =>
      (window as unknown as WalletRaceWindow).__walletProbe.releaseReload()
    )
    try {
      await expect(
        page.getByLabel("Manage Native-open reload wallet", { exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Open wallet", exact: true })
      ).toHaveCount(0)
      // Reconcile the confirmed native session immediately; balance
      // availability remains independent while the sampled read is pending.
      await expect(
        page.getByRole("button", { name: "Opening…", exact: true })
      ).toHaveCount(0)
      await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
      await expect(
        page.getByText("Balance unavailable", { exact: true })
      ).toBeVisible()
    } finally {
      await page.evaluate(() =>
        (window as unknown as WalletRaceWindow).__walletProbe.releaseBalance()
      )
    }
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("stale balance failure cannot replace a reopened wallet session @market", async ({
  page,
}) => {
  test.setTimeout(25_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)

    await page.evaluate(
      async (managerUrl) => {
        const { getSparkWalletManager } = await import(managerUrl)
        const manager = getSparkWalletManager()!
        const readBalance = manager.getBalance.bind(manager)
        const controller = (window as unknown as WalletRaceWindow)
          .__controlledWalletController
        const walletId = controller.portableWallets[0].id
        const probe = (window as unknown as WalletRaceWindow).__walletProbe
        let calls = 0
        const gate = new Promise<void>((resolve) => {
          probe.releaseBalance = resolve
        })
        probe.balanceHeld = false
        probe.oldBalanceSettled = false
        manager.getBalance = async (id: string) => {
          const balance = await readBalance(id)
          if (++calls === 1) {
            probe.balanceHeld = true
            await gate
            throw new Error("Wallet session changed.")
          }
          return balance
        }
        void controller.refreshBalance(walletId).then(
          () => {
            probe.oldBalanceSettled = true
          },
          () => {
            probe.oldBalanceSettled = true
          }
        )
      },
      "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts")
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as WalletRaceWindow).__walletProbe.balanceHeld
        )
      )
      .toBe(true)
    await page.evaluate(async () => {
      const controller = (window as unknown as WalletRaceWindow)
        .__controlledWalletController
      const walletId = controller.portableWallets[0].id
      await controller.lockSpark(walletId)
      await controller.unlockSpark(walletId)
    })
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page.evaluate(() =>
      (window as unknown as WalletRaceWindow).__walletProbe.releaseBalance()
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as WalletRaceWindow).__walletProbe
              .oldBalanceSettled
        )
      )
      .toBe(true)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(0)
    // A failure from the current session must still be visible.
    await page.evaluate(async () => {
      const target = window as unknown as WalletRaceWindow
      target.__walletProbe.failBalance = true
      const controller = target.__controlledWalletController
      await controller
        .refreshBalance(controller.portableWallets[0].id)
        .catch(() => undefined)
    })
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(1)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("stale unlock failure cannot replace a reopened wallet session @market", async ({
  page,
}) => {
  test.setTimeout(30_000)
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)

    await page.evaluate(async (storageUrl) => {
      const { getMarketWalletStore } = await import(storageUrl)
      const store = getMarketWalletStore()
      const target = window as unknown as WalletRaceWindow & {
        __unlockRace: {
          held: boolean
          settled: boolean
          rejected: boolean
          release: () => void
        }
      }
      const controller = target.__controlledWalletController
      const walletId = controller.portableWallets[0].id
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      target.__unlockRace = {
        held: false,
        settled: false,
        rejected: false,
        release,
      }
      store.getSparkRecovery = async () => {
        target.__unlockRace.held = true
        await gate
        throw new Error("Injected old recovery failure")
      }
      void Promise.allSettled([
        controller.unlockSpark(walletId),
        controller.unlockSpark(walletId),
      ]).then((results) => {
        target.__unlockRace.rejected = results.every(
          (result) => result.status === "rejected"
        )
        target.__unlockRace.settled = true
      })
    }, storage)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as WalletRaceWindow & {
                __unlockRace: { held: boolean }
              }
            ).__unlockRace.held
        )
      )
      .toBe(true)
    await page.evaluate(async (managerUrl) => {
      const { getSparkWalletManager } = await import(managerUrl)
      const target = window as unknown as WalletRaceWindow
      const controller = target.__controlledWalletController
      const probe = target.__walletProbe
      const walletId = controller.portableWallets[0].id
      await getSparkWalletManager()!.openWithMnemonic({
        walletId,
        mnemonic: probe.savedMnemonic,
        accountNumber: 1,
      })
      await controller.refreshBalance(walletId)
    }, sparkSdk)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1)
    await page.evaluate(() =>
      (
        window as unknown as Window & { __unlockRace: { release(): void } }
      ).__unlockRace.release()
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as Window & {
                __unlockRace: { settled: boolean }
              }
            ).__unlockRace.settled
        )
      )
      .toBe(true)
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              __unlockRace: { rejected: boolean }
            }
          ).__unlockRace.rejected
      )
    ).toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(
      await page.evaluate(() => {
        const controller = (window as unknown as WalletRaceWindow)
          .__controlledWalletController
        return controller.runtime[controller.portableWallets[0].id]?.status
      })
    ).toBe("ready")
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(0)

    // A current unlock failure must still replace the visible state.
    await page.evaluate(async (storageUrl) => {
      const { getMarketWalletStore } = await import(storageUrl)
      const controller = (window as unknown as WalletRaceWindow)
        .__controlledWalletController
      const walletId = controller.portableWallets[0].id
      await controller.lockSpark(walletId)
      getMarketWalletStore().getSparkRecovery = async () => {
        throw new Error("Injected current recovery failure")
      }
      await controller.unlockSpark(walletId).catch(() => undefined)
    }, storage)
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(1)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("foreground wallet import stays ready after an older background opening is refused @market @merchant", async ({
  browser,
}, testInfo) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const source = await context.newPage()
  const target = await context.newPage()
  let denied = true
  type RefusalPhase =
    | "sync_click"
    | "sync_settled"
    | "background_read_held"
    | "foreground_import"
    | "foreground_import_settled"
    | "background_released"
    | "complete"
  const diagnostic: {
    phase: RefusalPhase
    syncObserved: boolean
    syncOutcome: "pending" | "resolved" | "rejected"
    foregroundImportSettled: boolean
    observationAvailable: boolean
    lockObservationAvailable: boolean
    heldReadInsideAccountSetupLock?: boolean
  } = {
    phase: "sync_click",
    syncObserved: false,
    syncOutcome: "pending",
    foregroundImportSettled: false,
    observationAvailable: true,
    lockObservationAvailable: false,
  }
  let readinessObservation: Record<string, number | boolean> = {}
  const checkpoint = (phase: RefusalPhase) => {
    diagnostic.phase = phase
    recordSmokeDiagnostic(testInfo, "wallet-background-refusal", {
      ...diagnostic,
      ...readinessObservation,
    })
  }
  try {
    for (const page of [source, target]) await prepareControlledWallet(page)
    await observeWalletController(target)
    await installRealTestSigner(source, identity, relay)
    await installRealTestSigner(target, identity, relay, {
      beforeDecrypt: () => {
        if (denied) throw new Error("Signer permission denied")
      },
    })
    await source.goto(apps.merchant + "/wallet")
    await installControlledWallet(source)
    await openWalletSetup(source, "Create wallet")
    await saved(source)
    const first = (await wallets(source))[0]
    await openWalletSetup(source, "Import wallet")
    const mnemonic = await source.evaluate(
      () =>
        (window as unknown as WalletFixtureWindow).__walletProbe.importMnemonic
    )
    await source.getByLabel("Recovery phrase", { exact: true }).fill(mnemonic)
    await source.getByText("Advanced settings", { exact: true }).click()
    await source.getByLabel("Spark account number", { exact: true }).fill("7")
    await source
      .getByRole("dialog")
      .getByRole("button", { name: "Import wallet", exact: true })
      .click()
    await saved(source, false)
    const sourceWallets = await wallets(source)
    expect(sourceWallets).toHaveLength(2)
    const walletId = sourceWallets.find((id) => id !== first)!

    await target.goto(apps.market + "/wallet")
    await installControlledWallet(target, false, "support@conduit.cash")
    await expect(
      target.getByText(
        "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
        { exact: true }
      )
    ).toBeVisible()
    denied = false
    checkpoint("sync_click")
    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_sync_completed",
      "pending"
    )
    await target.evaluate(() => {
      const fixture = window as unknown as WalletFixtureWindow
      const originals = new Map<
        UseWalletsReturn,
        UseWalletsReturn["retryRecovery"]
      >()
      const observe = (controller: UseWalletsReturn) => {
        if (originals.has(controller)) return
        const original = controller.retryRecovery
        originals.set(controller, original)
        controller.retryRecovery = () => {
          const attempt = original.call(controller)
          if (fixture.__watchClickedRecoverySync) {
            fixture.__watchClickedRecoverySync = false
            fixture.__clickedRecoverySync = attempt.then(
              () => "resolved",
              () => "rejected"
            )
          }
          return attempt
        }
      }
      fixture.__observeControlledWalletController = observe
      observe(fixture.__controlledWalletController)
      fixture.__restoreClickedRecoverySync = () => {
        fixture.__watchClickedRecoverySync = false
        delete fixture.__observeControlledWalletController
        for (const [controller, original] of originals)
          controller.retryRecovery = original
        originals.clear()
      }
      fixture.__watchClickedRecoverySync = true
    })
    await target.getByRole("button", { name: "Sync wallet recovery" }).click()
    const syncOutcome = await target.evaluate(async () => {
      const fixture = window as unknown as WalletFixtureWindow
      if (!fixture.__clickedRecoverySync) return "not_observed"
      const outcome = await fixture.__clickedRecoverySync
      fixture.__restoreClickedRecoverySync?.()
      return outcome
    })
    diagnostic.syncObserved = syncOutcome !== "not_observed"
    if (syncOutcome !== "not_observed") diagnostic.syncOutcome = syncOutcome
    checkpoint("sync_settled")
    expect(syncOutcome).toBe("resolved")
    await expect
      .poll(async () => (await wallets(target)).sort())
      .toEqual([...sourceWallets].sort())
    await expect(
      target.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(2)

    await target.evaluate(
      async ({ storage, walletId }) => {
        const { getMarketWalletStore } = await import(storage)
        const fixture = window as unknown as WalletFixtureWindow
        const store = getMarketWalletStore()
        const original = store.getSparkRecovery.bind(store)
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let armed = true
        store.getSparkRecovery = async (id: string) => {
          const recovery = await original(id)
          if (armed && id === walletId) {
            armed = false
            fixture.__lateBackgroundRecoveryReadHeld = true
            await gate
          }
          return recovery
        }
        fixture.__releaseLateBackgroundRecoveryRead = release
        fixture.__restoreLateBackgroundRecoveryRead = () => {
          store.getSparkRecovery = original
        }
        fixture.__lateBackgroundOpen = fixture.__controlledWalletController
          .unlockSpark(walletId, "", false, { priority: "background" })
          .then(
            () => "resolved",
            (error: { code?: string }) => error.code ?? "rejected"
          )
        fixture.__joinedLateBackgroundOpen =
          fixture.__controlledWalletController
            .unlockSpark(walletId, "", false, { priority: "background" })
            .then(
              () => "resolved",
              (error: { code?: string }) => error.code ?? "rejected"
            )
      },
      { storage, walletId }
    )
    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_background_read_held",
      "pending"
    )
    await expect
      .poll(() =>
        target.evaluate(
          () =>
            (window as unknown as WalletFixtureWindow)
              .__lateBackgroundRecoveryReadHeld
        )
      )
      .toBe(true)

    checkpoint("background_read_held")
    const heldReadLock = await target
      .evaluate(async (pubkey) => {
        try {
          const locks = await navigator.locks.query()
          const name = `conduit:account-wallet-setup:${pubkey}`
          return {
            available: true,
            held: locks.held?.some((lock) => lock.name === name) === true,
          }
        } catch {
          return { available: false, held: false }
        }
      }, identity.pubkey)
      .catch((error) => {
        diagnostic.observationAvailable = false
        checkpoint("background_read_held")
        throw error
      })
    diagnostic.lockObservationAvailable = heldReadLock.available
    diagnostic.observationAvailable = heldReadLock.available
    if (heldReadLock.available)
      diagnostic.heldReadInsideAccountSetupLock = heldReadLock.held
    checkpoint("background_read_held")
    expect(heldReadLock.available).toBe(true)
    expect(heldReadLock.held).toBe(false)

    checkpoint("foreground_import")
    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_foreground_import_completed",
      "pending"
    )
    const restoredSameWallet = await target.evaluate(
      async ({ mnemonic, walletId }) => {
        const wallet = await (
          window as unknown as WalletFixtureWindow
        ).__controlledWalletController.importSpark({
          label: "",
          mnemonic,
          accountNumber: 7,
        })
        return wallet.id === walletId
      },
      { mnemonic, walletId }
    )
    diagnostic.foregroundImportSettled = true
    checkpoint("foreground_import_settled")
    expect(restoredSameWallet).toBe(true)
    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_foreground_import_completed",
      "met"
    )
    recordSmokeFailureContext(testInfo, "wallet_refusal_import_ready")
    try {
      const restoredWallet = target.locator(`[data-wallet-id="${walletId}"]`)
      await expect(restoredWallet).toHaveAttribute("data-wallet-state", "ready")
      await expect(
        restoredWallet.getByRole("button", { name: "Open wallet", exact: true })
      ).toHaveCount(0)
      await expect(target.locator("[data-wallet-id]")).toHaveCount(2)
    } catch (error) {
      readinessObservation = { readinessObservationAvailable: false }
      try {
        const runtime = await target.evaluate(
          async ({ sparkSdk, walletId }) => {
            const { getSparkWalletManager } = await import(sparkSdk)
            const manager = getSparkWalletManager()
            const controller = (window as unknown as WalletFixtureWindow)
              .__controlledWalletController
            const state = controller.runtime[walletId]
            const others = controller.portableWallets.filter(
              (wallet) => wallet.id !== walletId
            )
            return {
              nativeSessionOpen: manager?.isOpen(walletId) === true,
              targetRuntimeReady: state?.status === "ready",
              targetRuntimeConnecting: state?.status === "connecting",
              targetRuntimeLocked: state?.status === "locked",
              targetRuntimeUnavailable: state?.status === "unavailable",
              targetRuntimeError: state?.status === "error",
              walletCount: controller.portableWallets.length,
              otherReadyWalletCount: others.filter(
                (wallet) => controller.runtime[wallet.id]?.status === "ready"
              ).length,
              otherConnectingWalletCount: others.filter(
                (wallet) =>
                  controller.runtime[wallet.id]?.status === "connecting"
              ).length,
              otherLockedWalletCount: others.filter(
                (wallet) => controller.runtime[wallet.id]?.status === "locked"
              ).length,
              otherErrorWalletCount: others.filter(
                (wallet) => controller.runtime[wallet.id]?.status === "error"
              ).length,
              otherNativeOpenWalletCount: others.filter(
                (wallet) => manager?.isOpen(wallet.id) === true
              ).length,
            }
          },
          { sparkSdk, walletId }
        )
        readinessObservation = {
          readinessObservationAvailable: true,
          ...runtime,
          readyTextCount: await target
            .getByText("Ready", { exact: true })
            .count(),
          readyStateCount: await target
            .locator('[data-wallet-state="ready"]')
            .count(),
          openButtonCount: await target
            .getByRole("button", { name: "Open wallet", exact: true })
            .count(),
          openingButtonCount: await target
            .getByRole("button", { name: "Opening…", exact: true })
            .count(),
        }
      } catch {
        // Keep the original assertion failure if a read-only probe is unavailable.
      }
      checkpoint("foreground_import_settled")
      recordSmokeFailureContext(
        testInfo,
        "wallet_refusal_import_ready",
        "unmet"
      )
      throw error
    }
    recordSmokeFailureContext(testInfo, "wallet_refusal_import_ready", "met")

    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_background_released",
      "pending"
    )
    const backgroundOutcome = await target.evaluate(async () => {
      const fixture = window as unknown as WalletFixtureWindow
      fixture.__releaseLateBackgroundRecoveryRead()
      const outcome = {
        original: await fixture.__lateBackgroundOpen,
        joined: await fixture.__joinedLateBackgroundOpen,
      }
      fixture.__restoreLateBackgroundRecoveryRead()
      return outcome
    })
    checkpoint("background_released")
    recordSmokeFailureContext(
      testInfo,
      "wallet_refusal_ready_preserved",
      "pending"
    )
    expect(backgroundOutcome).toEqual({
      original: "background_paused",
      joined: "background_paused",
    })
    expect(
      await target.evaluate(
        async ({ sparkSdk, walletId }) => {
          const { getSparkWalletManager } = await import(sparkSdk)
          return getSparkWalletManager()?.isOpen(walletId) === true
        },
        { sparkSdk, walletId }
      )
    ).toBe(true)
    const restoredWallet = target.locator(`[data-wallet-id="${walletId}"]`)
    await expect(restoredWallet).toHaveAttribute("data-wallet-state", "ready")
    await expect(
      restoredWallet.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(0)
    await expect(target.locator("[data-wallet-id]")).toHaveCount(2)
    checkpoint("complete")
    recordSmokeFailureContext(testInfo, "wallet_refusal_ready_preserved", "met")
  } finally {
    await target
      .evaluate(() => {
        const fixture = window as unknown as WalletFixtureWindow
        fixture.__releaseLateBackgroundRecoveryRead?.()
        fixture.__restoreLateBackgroundRecoveryRead?.()
        fixture.__restoreClickedRecoverySync?.()
      })
      .catch(() => undefined)
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
