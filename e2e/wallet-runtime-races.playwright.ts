import path from "node:path"
import { expect, test } from "@playwright/test"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type { AccountSignerOperationOptions } from "@conduit/core/protocol/nostr-event-signer"
import {
  openWalletSetup,
  closeDefaultWalletSession,
  observeWalletController,
  prepareControlledWallet,
  installControlledWallet,
  installWalletReloadObservationBarrier,
  saveWalletRecovery as saved,
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
const apps = {
  market: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"),
}
test.setTimeout(90_000)
test.use({ trace: "off", screenshot: "off", video: "off" })
type WalletFixtureWindow = Window & {
  __controlledWalletReloadBarrier?: () => Promise<void>
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
type WalletRaceWindow = Window & {
  __controlledWalletReloadBarrier?: () => Promise<void>
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

type WalletSetupRemovalWindow = WalletFixtureWindow & {
  __walletSetupBarrier?: () => Promise<void>
  __setupRemoval: {
    opening: boolean
    cleanupObserved: boolean
    walletId: string
    readyCallbacks: number
    release(): void
    result: Promise<{ rejected: boolean; removalError: boolean }>
  }
}

for (const mode of ["create", "import"] as const)
  test(`${mode} retires a native wallet removed while opening @market`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps.market + "/wallet")
      await installControlledWallet(page)
      // Navigation can finish before the split wallet component has rendered.
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as unknown as WalletFixtureWindow)
                .__controlledWalletController
            )
          )
        )
        .toBe(true)
      await page.evaluate(async () => {
        await (
          window as unknown as WalletFixtureWindow
        ).__controlledWalletController.retryRecovery()
      })
      await page.evaluate(
        async ({ mode, sparkSdk }) => {
          const w = window as unknown as WalletSetupRemovalWindow
          const manager = (await import(sparkSdk)).getSparkWalletManager()
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          const state: WalletSetupRemovalWindow["__setupRemoval"] = {
            opening: false,
            cleanupObserved: false,
            walletId: "",
            readyCallbacks: 0,
            release,
            result: Promise.resolve({ rejected: false, removalError: false }),
          }
          w.__setupRemoval = state
          w.__walletSetupBarrier = async () => {
            state.opening = true
            await gate
          }
          const closeUnused = manager.closeWalletsExcept.bind(manager)
          manager.closeWalletsExcept = async (ids: ReadonlySet<string>) => {
            await closeUnused(ids)
            if (state.walletId && !ids.has(state.walletId))
              state.cleanupObserved = true
          }
          const options = {
            onRecoveryReady: () => {
              state.readyCallbacks++
            },
          }
          const setup =
            mode === "create"
              ? w.__controlledWalletController.createSpark(
                  "Removal race",
                  options
                )
              : w.__controlledWalletController.importSpark(
                  {
                    label: "Removal race",
                    mnemonic: w.__walletProbe.importMnemonic,
                    accountNumber: 0,
                  },
                  options
                )
          state.result = setup.then(
            () => ({ rejected: false, removalError: false }),
            (error: unknown) => ({
              rejected: true,
              removalError:
                error instanceof Error &&
                error.message.includes("removed while it was unlocking"),
            })
          )
        },
        { mode, sparkSdk }
      )
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletSetupRemovalWindow).__setupRemoval
                .opening
          )
        )
        .toBe(true)
      // A valid newer record arrives through the real bounded relay reader while
      // the native factory is held. Setup's account lock must not hide this race.
      await page.evaluate(
        async ({ core, syncUrl, transportUrl, relay }) => {
          const w = window as unknown as WalletSetupRemovalWindow
          const { db, getAccountSigner } = await import(core)
          const { getPortableWalletSync } = await import(syncUrl)
          const { createAccountWalletTransport } = await import(transportUrl)
          const signer = getAccountSigner()
          const service = getPortableWalletSync(signer)
          const account = await db.portableWalletAccounts.get(signer.pubkey)
          const saved = Object.values(account.wallets)[0] as {
            event: { created_at: number; kind: number; tags: string[][] }
          }
          const walletId = Object.keys(account.wallets)[0]
          w.__setupRemoval.walletId = walletId
          const record = await service.get(walletId, { priority: "foreground" })
          const event = await signer.signEvent({
            pubkey: signer.pubkey,
            kind: saved.event.kind,
            tags: saved.event.tags,
            created_at: saved.event.created_at + 1,
            content: await signer.encryptNip44(
              signer.pubkey,
              JSON.stringify({ ...record, lifecycle: "removed" })
            ),
          })
          const status = await createAccountWalletTransport(signer).publish(
            relay,
            event,
            () => true
          )
          if (status !== "acked")
            throw new Error("Removal fixture was not stored")
          await service.sync({ priority: "background" })
        },
        {
          core,
          relay,
          syncUrl:
            "/@fs" +
            path.resolve("packages/core/src/wallets/portable-wallet-sync.ts"),
          transportUrl:
            "/@fs" +
            path.resolve(
              "packages/core/src/wallets/portable-wallet-transport.ts"
            ),
        }
      )
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as WalletSetupRemovalWindow).__setupRemoval
                .cleanupObserved
          )
        )
        .toBe(true)
      const result = await page.evaluate(async (sparkSdk) => {
        const w = window as unknown as WalletSetupRemovalWindow
        w.__setupRemoval.release()
        const result = await w.__setupRemoval.result
        const manager = (await import(sparkSdk)).getSparkWalletManager()
        return {
          ...result,
          open: manager.isOpen(w.__setupRemoval.walletId),
          disconnects: w.__walletProbe.disconnects,
          readyCallbacks: w.__setupRemoval.readyCallbacks,
        }
      }, sparkSdk)
      expect(result).toEqual({
        rejected: true,
        removalError: true,
        open: false,
        disconnects: 1,
        readyCallbacks: 0,
      })
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })

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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(0)
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
    await installWalletReloadObservationBarrier(page)
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)
    await page.evaluate(
      async ({ core }) => {
        const { db } = await import(core)
        const probe = (window as unknown as WalletFixtureWindow).__walletProbe
        probe.recoveryReads = 0
        probe.reloadHeld = false
        const gate = new Promise<void>((resolve) => {
          probe.releaseReload = resolve
        })
        ;(
          window as unknown as WalletFixtureWindow
        ).__controlledWalletReloadBarrier = async () => {
          if (++probe.recoveryReads === 1) {
            probe.reloadHeld = true
            await gate
          }
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
    await page.evaluate(() =>
      (window as unknown as WalletFixtureWindow).__walletProbe.releaseReload()
    )
    await expect(
      page.getByLabel("Manage Reload gated wallet", { exact: true })
    ).toBeVisible()
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await installWalletReloadObservationBarrier(page)
    await prepareControlledWallet(page)
    await observeWalletController(page)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saved(page)
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
    await page
      .getByRole("button", { name: /^Manage / })
      .first()
      .click()
    await closeDefaultWalletSession(page)
    await expect(page.getByText("Locked", { exact: true })).toHaveCount(1)

    await page.evaluate(
      async ({ core, managerUrl }) => {
        const { db } = await import(core)
        const { getSparkWalletManager } = await import(managerUrl)
        const manager = getSparkWalletManager()!
        const probe = (window as unknown as WalletRaceWindow).__walletProbe
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
        ;(
          window as unknown as WalletRaceWindow
        ).__controlledWalletReloadBarrier = async () => {
          // Hold after the native snapshot, regardless of credential-read count.
          if (++recoveryReads === 1) {
            probe.reloadHeld = true
            await reloadGate
          }
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
      await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
      await expect(
        page.getByText("Balance unavailable", { exact: true })
      ).toBeVisible()
    } finally {
      await page.evaluate(() =>
        (window as unknown as WalletRaceWindow).__walletProbe.releaseBalance()
      )
    }
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)

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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(0)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(1)
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
    await expect(page.locator('[data-wallet-state="ready"]')).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toHaveCount(1)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})
