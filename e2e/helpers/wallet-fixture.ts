import path from "node:path"
import type { WalletDescriptor } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { expect, type Page } from "@playwright/test"

export async function saveWalletRecovery(page: Page, makeMain = true) {
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", {
      name: /^(Wallet imported|Save your recovery details)$/,
    })
  ).toBeVisible()
  await expect(
    dialog.getByText("Checking for your Lightning address…", { exact: true })
  ).toHaveCount(0)
  // The early recovery callback can render this heading before setup settles.
  // This helper changes the main choice, so wait for that existing control to be ready.
  await expect(
    dialog.getByLabel("Make this my main wallet", { exact: true })
  ).toBeEnabled()
  if (
    await dialog
      .getByRole("heading", { name: "Wallet imported", exact: true })
      .count()
  ) {
    await expect(dialog.locator("#recovery-saved")).toHaveCount(0)
  } else {
    await expect(
      dialog.getByRole("heading", { name: "Save your recovery details" })
    ).toBeVisible()
    await dialog
      .getByLabel(
        "I saved the phrase, Spark account number and network somewhere private"
      )
      .check()
  }
  const chooser = dialog.getByRole("button", {
    name: "Get conduit.cash address",
    exact: true,
  })
  if (await chooser.count()) await chooser.click()
  await dialog
    .getByLabel("Make this my main wallet", { exact: true })
    .setChecked(makeMain)
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(dialog).toHaveCount(0)
}
export async function prepareControlledWallet(page: Page) {
  // Replace network initialization at the existing single manager's factory.
  // Production modules and UI/hooks/storage/signers otherwise run unchanged.
  await page.addInitScript(() => {
    const fixtureWindow = window as any
    fixtureWindow.__walletFixtureFactory = {
      network: "mainnet",
      async open(input: {
        mnemonic: string
        accountNumber: number
        walletId: string
      }) {
        if (!fixtureWindow.__walletProbe)
          await new Promise<void>((resolve) => {
            fixtureWindow.__walletFixtureReady = resolve
          })
        const probe = fixtureWindow.__walletProbe
        probe.opens++
        if (probe.failOpen) throw new Error("Injected SDK open failure")
        probe.openedAccounts.push(input.accountNumber)
        probe.lastAccount = input.accountNumber
        probe.savedMnemonic = input.mnemonic
        const imported = input.mnemonic === probe.importMnemonic
        const recovered = !!probe.restoredAddress
        if (fixtureWindow.__walletSetupBarrier)
          await fixtureWindow.__walletSetupBarrier()
        let registered = imported || recovered
        let registrationPending = false
        let selectedName: string | undefined
        const lookup = async (domain = "breez.tips") =>
          probe.addressUnavailableReason
            ? { status: "unavailable", reason: probe.addressUnavailableReason }
            : (
                  domain === "breez.tips"
                    ? registered
                    : imported ||
                      (recovered &&
                        probe.restoredAddress.endsWith("@conduit.cash"))
                )
              ? {
                  status: "registered",
                  address:
                    domain === "conduit.cash"
                      ? imported
                        ? "support@conduit.cash"
                        : probe.restoredAddress
                      : recovered &&
                          probe.restoredAddress.endsWith("@breez.tips")
                        ? probe.restoredAddress
                        : `${selectedName ?? `wallet${probe.registrations}`}@breez.tips`,
                  lnurl: `https://${domain}/lnurlp/test`,
                  publicLookup: "verified",
                  zap: { status: "unsupported" },
                }
              : registrationPending
                ? { status: "unavailable", reason: "registration_pending" }
                : { status: "absent" }
        return {
          async disconnect() {
            probe.disconnects++
          },
          async getInfo() {
            if (probe.infoBarrier) await probe.infoBarrier()
            if (probe.failBalance) throw new Error("Injected post-open failure")
            return { balanceSats: 0 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async lookupBreezAddress(domain?: string) {
            return lookup(domain)
          },
          async ensureBreezAddress(username?: string, domain = "breez.tips") {
            if (domain === "conduit.cash") return lookup(domain)
            if (registered) return lookup(domain)
            if (probe.delayRegistration)
              await new Promise<void>((resolve) => {
                probe.releaseRegistration = resolve
              })
            if (probe.failRegistration) {
              registrationPending = true
              return { status: "unavailable", reason: "registration_pending" }
            }
            selectedName = username
            probe.registrations++
            registered = true
            registrationPending = false
            return lookup()
          },
          async receivePayment() {
            if (probe.delayReceive) {
              probe.receiveStarted = true
              await new Promise<void>((resolve) => {
                probe.releaseReceive = resolve
              })
            }
            return { paymentRequest: "controlled-invoice", fee: 0n }
          },
          async prepareSendPayment() {
            throw new Error("Controlled unfunded wallet")
          },
          async sendPayment() {
            throw new Error("No payment is authorized in this test")
          },
        }
      },
    }
  })
  await page.route(
    "**/packages/core/src/wallets/spark-sdk.ts*",
    async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      const marker = "new FirstPartySparkSdkFactory("
      if (body.split(marker).length !== 2)
        throw new Error("Wallet factory fixture seam changed")
      await route.fulfill({
        response,
        body: body.replace(
          marker,
          "window.__walletFixtureFactory ?? new FirstPartySparkSdkFactory("
        ),
      })
    }
  )
}
export async function installControlledWallet(
  page: Page,
  failRegistration = false,
  restoredAddress?: string
) {
  await page.evaluate(
    async ({ failRegistration, modulePath, restoredAddress }) => {
      const recovery = await import("/@fs" + modulePath)
      Object.assign(window, {
        __walletProbe: {
          restoredAddress,
          registrations: 0,
          opens: 0,
          openedAccounts: [],
          disconnects: 0,
          failRegistration,
          importMnemonic: recovery.generateSparkMnemonic(),
          savedMnemonic: "",
          lastAccount: -1,
        },
      })
      ;(window as any).__walletFixtureReady?.()
    },
    {
      restoredAddress,
      failRegistration,
      modulePath: path.resolve("packages/core/src/wallets/spark-recovery.ts"),
    }
  )
}

/** Use the visible wallet actions and secondary external-wallet controls. */
export async function openWalletSetup(
  page: Page,
  name: "Create wallet" | "Import wallet" | "Connect wallet"
) {
  const button = page.getByRole("button", {
    name: name === "Create wallet" ? "Add a wallet" : name,
    exact: true,
  })
  if (name === "Connect wallet" && !(await button.isVisible()))
    await page.getByText("External wallet management", { exact: true }).click()
  await button.click()
}

/** Observe the real route controller without adding a production test API. */
export async function observeWalletController(page: Page) {
  await page.route("**/src/routes/wallet.tsx*", async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const marker = [
      "const wallets = useWallets();",
      "const wallets = automation.wallets;",
    ].find((candidate) => body.includes(candidate))
    if (!marker || body.split(marker).length !== 2)
      throw new Error("Wallet controller observation seam changed")
    await route.fulfill({
      response,
      body: body.replace(
        marker,
        marker + "window.__controlledWalletController = wallets;"
      ),
    })
  })
}

/** Retain deliberate-lock semantics after removal of the user-facing Lock control. */
export async function closeDefaultWalletSession(page: Page) {
  await page.keyboard.press("Escape")
  await page.evaluate(
    async ({ storage, core }) => {
      const { getMarketWalletStore } = await import(storage)
      const { getAccountSigner } = await import(core)
      const controller = (
        window as typeof window & {
          __controlledWalletController?: {
            lockSpark(walletId: string): Promise<void>
          }
        }
      ).__controlledWalletController
      if (!controller) throw new Error("Wallet controller was not observed.")
      const wallets = (
        await getMarketWalletStore().listVisible(
          getAccountSigner()?.pubkey ?? null
        )
      ).filter((w: { providerId: string }) => w.providerId === "spark")
      const wallet =
        wallets.find((w: { defaultIntents: string[] }) =>
          w.defaultIntents.includes("pay_invoice")
        ) ?? wallets[0]
      if (!wallet) throw new Error("No wallet session to close.")
      await controller.lockSpark(wallet.id)
    },
    {
      storage:
        "/@fs" + path.resolve("packages/core/src/wallets/wallet-storage.ts"),
      core: "/@fs" + path.resolve("packages/core/src/index.ts"),
    }
  )
}

/** Pause descriptor metadata reads after the provider sample to exercise a real reload/open interleaving. */
export async function installWalletReloadObservationBarrier(page: Page) {
  await page.route(
    "**/packages/core/src/hooks/useWallets.ts*",
    async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      const marker = ["const", "hasPasswordWallets", "="].join(" ")
      if (body.split(marker).length !== 2)
        throw new Error("Wallet reload observation seam changed")
      await route.fulfill({
        response,
        body: body.replace(
          marker,
          "await window.__controlledWalletReloadBarrier?.(); " + marker
        ),
      })
    }
  )
}

export async function openWalletDuringDescriptorReload(page: Page) {
  return page.evaluate(
    async ({ storage, core, sdk }) => {
      const { getMarketWalletStore } = await import(storage)
      const { getAccountSigner } = await import(core)
      const { getSparkWalletManager } = await import(sdk)
      const fixtureWindow = window as typeof window & {
        __controlledWalletController: UseWalletsReturn
        __walletProbe: {
          savedMnemonic: string
          lastAccount: number
          infoBarrier?: () => Promise<void>
        }
        __controlledWalletReloadBarrier?: () => Promise<void>
        __releaseControlledWalletBalance?: () => void
      }
      const controller = fixtureWindow.__controlledWalletController
      const signer = getAccountSigner()
      const manager = getSparkWalletManager()
      const wallets = await getMarketWalletStore().listVisible(signer.pubkey)
      const wallet = wallets.find((wallet: WalletDescriptor) =>
        manager.isOpen(wallet.id)
      )
      if (!wallet) throw new Error("Recovered native session was not open")
      const recovery = {
        mnemonic: fixtureWindow.__walletProbe.savedMnemonic,
        accountNumber: fixtureWindow.__walletProbe.lastAccount,
      }
      await controller.lockSpark(wallet.id)
      let releaseMetadata!: () => void,
        releaseBalance!: () => void,
        sampled!: () => void
      const metadata = new Promise<void>((resolve) => {
        releaseMetadata = resolve
      })
      const balance = new Promise<void>((resolve) => {
        releaseBalance = resolve
      })
      const sample = new Promise<void>((resolve) => {
        sampled = resolve
      })
      fixtureWindow.__controlledWalletReloadBarrier = async () => {
        sampled()
        await metadata
      }
      fixtureWindow.__walletProbe.infoBarrier = () => balance
      const reload = controller.retryInitialization()
      await sample
      await manager.openWithMnemonic({
        walletId: wallet.id,
        mnemonic: recovery.mnemonic,
        accountNumber: recovery.accountNumber,
        shouldContinue: () => getAccountSigner() === signer,
      })
      // Metadata completes while the manager's balance notification is still in flight.
      delete fixtureWindow.__controlledWalletReloadBarrier
      releaseMetadata()
      await reload
      fixtureWindow.__releaseControlledWalletBalance = () => {
        releaseBalance()
        delete fixtureWindow.__walletProbe.infoBarrier
        delete fixtureWindow.__releaseControlledWalletBalance
      }
      return recovery.accountNumber
    },
    {
      storage:
        "/@fs" + path.resolve("packages/core/src/wallets/wallet-storage.ts"),
      core: "/@fs" + path.resolve("packages/core/src/index.ts"),
      sdk: "/@fs" + path.resolve("packages/core/src/wallets/spark-sdk.ts"),
    }
  )
}
