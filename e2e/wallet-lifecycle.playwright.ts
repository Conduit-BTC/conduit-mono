import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  prepareControlledWallet,
  installControlledWallet,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import { createDeterministicNwcWallet } from "./helpers/deterministic-nwc-wallet"

const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const recovery =
  "/@fs" + path.resolve("packages/core/src/wallets/account-spark-recovery.ts")
const journal =
  "/@fs" + path.resolve("packages/core/src/wallets/spark-recovery-store.ts")
const phrase =
  "/@fs" + path.resolve("packages/core/src/wallets/spark-recovery.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const apps = {
  market: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"),
  merchant:
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"),
}
test.setTimeout(90_000)
test.use({ trace: "off", screenshot: "off", video: "off" })

async function observeController(
  page: Page,
  app: "market" | "merchant",
  parallel = false
) {
  await page.route("**/src/routes/wallet.tsx*", async (route) => {
    const response = await route.fetch()
    const body = await response.text()
    const marker =
      app === "market"
        ? "const wallets = useWallets();"
        : "const wallets = automation.wallets;"
    if (body.split(marker).length !== 2)
      throw new Error("Wallet controller observation seam changed")
    await route.fulfill({
      response,
      body: body.replace(
        marker,
        marker +
          (parallel
            ? "const otherWallets = useWallets();"
            : "const otherWallets = null;") +
          (app === "merchant"
            ? "window.__walletLifecycle = { wallets, otherWallets, auth, automation };"
            : "window.__walletLifecycle = { wallets, otherWallets, auth };")
      ),
    })
  })
}
async function settled(page: Page, parallel = false) {
  await expect
    .poll(() =>
      page.evaluate((two) => {
        const { wallets, otherWallets, auth } =
          (window as any).__walletLifecycle ?? {}
        return (
          auth?.signerReadiness === "ready" &&
          wallets?.loading === false &&
          !["idle", "checking"].includes(wallets.recoverySync) &&
          (!two ||
            (otherWallets?.loading === false &&
              !["idle", "checking"].includes(otherWallets.recoverySync)))
        )
      }, parallel)
    )
    .toBe(true)
}
async function seedBackup(
  page: Page,
  network: "mainnet" | "regtest" = "mainnet"
) {
  await page.evaluate(
    async ({ core, recovery, phrase, network }) => {
      const signer = (await import(core)).getAccountSigner()
      const service = (await import(recovery)).getAccountSparkRecovery(signer)
      const candidate = await service.prepare({
        mnemonic: (await import(phrase)).generateSparkMnemonic(),
        network,
        accountNumber: 7,
      })
      await service.preparePrimary(candidate)
    },
    { core, recovery, phrase, network }
  )
}
async function importKnownPhrase(page: Page, addy = false) {
  await page.getByRole("button", { name: "Import wallet", exact: true }).click()
  await page.evaluate(
    async ({ core, recovery, addy }) => {
      const signer = (await import(core)).getAccountSigner()
      const service = (await import(recovery)).getAccountSparkRecovery(signer)
      const found = await service.discover(false, "mainnet")
      const candidate = found.candidates.find(
        (c: any) => c.source === (addy ? "addy" : "conduit_v1")
      )
      const bundle = await service.restore(
        candidate,
        addy ? { network: "mainnet", accountNumber: 7 } : undefined
      )
      const textarea = document.getElementById(
        "portable-mnemonic"
      ) as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, bundle.mnemonic)
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    },
    { core, recovery, addy }
  )
  const dialog = page.getByRole("dialog")
  await dialog.getByText("Advanced settings", { exact: true }).click()
  await dialog.getByLabel("Spark account number").fill("7")
  await dialog
    .getByRole("button", { name: "Import wallet", exact: true })
    .click()
  await expect(
    dialog.getByRole("heading", { name: "Wallet imported", exact: true })
  ).toBeVisible()
  await expect(dialog.getByLabel("recovery-saved")).toHaveCount(0)
  const address = dialog.getByRole("button", {
    name: "Get conduit.cash address",
    exact: true,
  })
  if (await address.count()) await address.click()
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test("legacy device dialogs allow signed-out recovery but retire a pending lookup on account change @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeController(page, "market")
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page)
    await page.evaluate(
      async ({ core }) => {
        const { db } = await import(core)
        const random = (length: number) =>
          btoa(
            String.fromCharCode(
              ...crypto.getRandomValues(new Uint8Array(length))
            )
          )
        const id = crypto.randomUUID()
        const timestamp = Date.now()
        await db.transaction(
          "rw",
          [db.wallets, db.walletCredentials],
          async () => {
            await db.wallets.put({
              id,
              kind: "portable",
              providerId: "spark",
              label: "Legacy fence",
              network: "mainnet",
              capabilities: ["receive", "balance"],
              status: "locked",
              defaultIntents: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            await db.walletCredentials.put({
              walletId: id,
              providerId: "spark",
              credential: JSON.stringify({
                type: "password",
                walletId: id,
                providerId: "spark",
                network: "mainnet",
                accountNumber: 1,
                recovery: {
                  version: 2,
                  kdf: "PBKDF2-SHA-256",
                  cipher: "AES-GCM",
                  iterations: 100_000,
                  salt: random(16),
                  iv: random(12),
                  ciphertext: random(48),
                },
              }),
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          }
        )
      },
      { core }
    )
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toBeVisible()
    await page.evaluate(() => {
      const fixture = window as any
      const controller = fixture.__walletLifecycle.wallets
      const lookup = controller.getSparkRecoveryType
      controller.getSparkRecoveryType = async (id: string) => {
        const method = await lookup(id)
        fixture.__legacyLookupPending = true
        await new Promise<void>((resolve) => {
          fixture.__releaseLegacyLookup = resolve
        })
        fixture.__legacyLookupComplete = true
        return method
      }
    })
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => !!(window as any).__legacyLookupPending))
      .toBe(true)
    await page.evaluate(() =>
      (window as any).__walletLifecycle.auth.disconnect()
    )
    await page.evaluate(() => (window as any).__releaseLegacyLookup())
    await expect
      .poll(() => page.evaluate(() => !!(window as any).__legacyLookupComplete))
      .toBe(true)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { wallets, auth } = (window as any).__walletLifecycle
          return {
            signedOut: auth.accountPubkey === null,
            loading: wallets.loading,
            count: wallets.portableWallets.length,
          }
        })
      )
      .toEqual({ signedOut: true, loading: false, count: 1 })
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(
      page
        .getByRole("dialog", { name: "Unlock Legacy fence", exact: true })
        .getByLabel("Wallet password")
    ).toBeVisible()
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Open wallet", exact: true })
    ).toBeFocused()
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("parallel consumers share one native open and observe ready, lock and retry without incidental events @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeController(page, "market", true)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page, true)
    await seedBackup(page)
    await page.reload()
    await page.evaluate(() => {
      const fixture = window as any
      fixture.__walletSetupBarrier = () =>
        new Promise<void>((resolve) => {
          fixture.__releaseWalletOpen = resolve
        })
    })
    await installControlledWallet(page)
    await settled(page, true)
    await expect
      .poll(() => page.evaluate(() => (window as any).__walletProbe.opens))
      .toBe(1)
    await page.evaluate(
      async ({ core }) => {
        const fixture = window as any
        fixture.__walletMutationEvents = 0
        const increment = () => {
          fixture.__walletMutationEvents++
        }
        const { subscribeToWalletDescriptorChanges } = await import(core)
        await new Promise<void>((resolve, reject) => {
          subscribeToWalletDescriptorChanges({
            onChange: () => {
              increment()
              resolve()
            },
            onError: reject,
          })
        })
        fixture.__walletMutationEvents = 0
        fixture.__fallbackBaseline = localStorage.getItem(
          "conduit:wallets-change:v1"
        )
        fixture.__releaseWalletOpen()
      },
      { core }
    )
    const statuses = () =>
      page.evaluate(() => {
        const { wallets, otherWallets } = (window as any).__walletLifecycle
        return [
          Object.values(wallets.runtime)[0],
          Object.values(otherWallets.runtime)[0],
        ].map((state: any) => state?.status)
      })
    await expect.poll(statuses).toEqual(["ready", "ready"])
    expect(
      await page.evaluate(() => ({
        opens: (window as any).__walletProbe.opens,
        mutations: (window as any).__walletMutationEvents,
        fallbackChanged:
          localStorage.getItem("conduit:wallets-change:v1") !==
          (window as any).__fallbackBaseline,
      }))
    ).toEqual({ opens: 1, mutations: 0, fallbackChanged: false })
    await page.evaluate(async () => {
      const fixture = window as any
      await fixture.__walletLifecycle.wallets.lockSpark(
        fixture.__walletLifecycle.wallets.portableWallets[0].id
      )
    })
    await expect.poll(statuses).toEqual(["locked", "locked"])
    await page.evaluate(async () => {
      const fixture = window as any
      delete fixture.__walletSetupBarrier
      await fixture.__walletLifecycle.wallets.unlockSpark(
        fixture.__walletLifecycle.wallets.portableWallets[0].id
      )
    })
    await expect.poll(statuses).toEqual(["ready", "ready"])
    expect(await page.evaluate(() => (window as any).__walletProbe.opens)).toBe(
      2
    )
    await page.evaluate(async () => {
      const fixture = window as any
      const { wallets, otherWallets } = fixture.__walletLifecycle
      const id = wallets.portableWallets[0].id
      await wallets.lockSpark(id)
      fixture.__walletSetupBarrier = async () => {
        throw new Error("Controlled native initialization failed")
      }
      await Promise.allSettled([
        wallets.unlockSpark(id),
        otherWallets.unlockSpark(id),
      ])
    })
    await expect.poll(statuses).toEqual(["error", "error"])
    await page.evaluate(async () => {
      const fixture = window as any
      delete fixture.__walletSetupBarrier
      await fixture.__walletLifecycle.wallets.unlockSpark(
        fixture.__walletLifecycle.wallets.portableWallets[0].id
      )
    })
    await expect.poll(statuses).toEqual(["ready", "ready"])
    expect(await page.evaluate(() => (window as any).__walletProbe.opens)).toBe(
      4
    )
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} device removal survives retry, account reconnect and reload until explicit import @market`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await prepareControlledWallet(page)
      await observeController(page, app)
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps[app] + "/wallet")
      await installControlledWallet(page)
      await settled(page)
      await seedBackup(page)
      await page.evaluate(() =>
        (window as any).__walletLifecycle.wallets.retryRecovery()
      )
      await expect(
        page.getByRole("button", { name: "Send", exact: true })
      ).toBeEnabled()
      await page.getByRole("button", { name: /^Manage / }).click()
      await page
        .getByRole("menuitem", { name: "Remove from this device", exact: true })
        .click()
      const confirm = page.getByRole("alertdialog")
      await confirm.getByRole("switch").check()
      await confirm
        .getByRole("button", { name: "Remove from this device", exact: true })
        .click()
      await expect(confirm).toHaveCount(0)
      await page.evaluate(() =>
        (window as any).__walletLifecycle.wallets.retryRecovery()
      )
      expect(
        await page.evaluate(
          () => (window as any).__walletLifecycle.wallets.portableWallets.length
        )
      ).toBe(0)
      await page.evaluate(() =>
        (window as any).__walletLifecycle.auth.disconnect()
      )
      await page.evaluate(() =>
        (window as any).__walletLifecycle.auth.connect({ method: "nip07" })
      )
      await settled(page)
      expect(
        await page.evaluate(
          () => (window as any).__walletLifecycle.wallets.portableWallets.length
        )
      ).toBe(0)
      await page.reload()
      await installControlledWallet(page)
      await settled(page)
      expect(
        await page.evaluate(() => ({
          count: (window as any).__walletLifecycle.wallets.portableWallets
            .length,
          opens: (window as any).__walletProbe.opens,
        }))
      ).toEqual({ count: 0, opens: 0 })
      await importKnownPhrase(page)
      await expect(
        page.getByRole("button", { name: "Send", exact: true })
      ).toBeEnabled()
      expect(
        await page.evaluate(
          async ({ core, journal }) => {
            const signer = (await import(core)).getAccountSigner()
            return (
              await new (await import(journal)).DexieSparkRecoveryStore().load(
                signer.pubkey
              )
            ).removedWalletIds.length
          },
          { core, journal }
        )
      ).toBe(0)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("foreign-network evidence allows active-network creation and survives subsequent restoration @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeController(page, "market")
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page)
    await seedBackup(page, "regtest")
    for (let index = 0; index < 2; index++) {
      await page
        .getByRole("button", { name: "Create wallet", exact: true })
        .click()
      const dialog = page.getByRole("dialog")
      await expect(
        dialog.getByRole("heading", { name: "Save your recovery details" })
      ).toBeVisible()
      await dialog
        .getByLabel(
          "I saved the phrase, Spark account number and network somewhere private"
        )
        .check()
      const address = dialog.getByRole("button", {
        name: "Get conduit.cash address",
        exact: true,
      })
      if (await address.count()) await address.click()
      await dialog.getByRole("button", { name: "Done", exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    expect(
      await page.evaluate(() => ({
        opens: (window as any).__walletProbe.opens,
        accounts: (window as any).__walletProbe.openedAccounts,
      }))
    ).toEqual({ opens: 2, accounts: [1, 1] })
    await page.reload()
    await installControlledWallet(page)
    await settled(page)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Object.values(
              (window as any).__walletLifecycle.wallets.runtime
            ).filter((state: any) => state.status === "ready").length
        )
      )
      .toBe(2)
    expect(
      await page.evaluate(
        async ({ core, recovery }) => {
          const signer = (await import(core)).getAccountSigner()
          const found = await (
            await import(recovery)
          )
            .getAccountSparkRecovery(signer)
            .discover(false, "mainnet")
          return {
            active: found.candidates.length,
            foreign: found.otherNetworkCandidates.length,
            networks: (
              window as any
            ).__walletLifecycle.wallets.portableWallets.map(
              (wallet: any) => wallet.network
            ),
          }
        },
        { core, recovery }
      )
    ).toEqual({ active: 2, foreign: 1, networks: ["mainnet", "mainnet"] })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("valid Addy recovery blocks Create and imports only the supplied original account and network @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeController(page, "market")
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page)
    await page.evaluate(
      async ({ core, journal, phrase, relay }) => {
        const signer = (await import(core)).getAccountSigner()
        const mnemonic = (await import(phrase)).generateSparkMnemonic()
        const event = await signer.signEvent({
          pubkey: signer.pubkey,
          kind: 30078,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "spark-wallet-backup"]],
          content: await signer.encryptNip44(signer.pubkey, mnemonic),
        })
        await new (await import(journal)).DexieSparkRecoveryStore().retain(
          signer.pubkey,
          [
            {
              event,
              targets: [{ url: relay, operator: null }],
              delivery: [
                {
                  url: relay,
                  status: "pending",
                  accepted: false,
                  readBack: false,
                  lastRead: "not_queried",
                  checkedAt: 0,
                },
              ],
              exported: false,
            },
          ]
        )
      },
      { core, journal, phrase, relay }
    )
    await page
      .getByRole("button", { name: "Create wallet", exact: true })
      .click()
    await expect(
      page.getByText(/An Addy recovery backup needs its original network/)
    ).toBeVisible()
    expect(
      await page.evaluate(() => ({
        count: (window as any).__walletLifecycle.wallets.portableWallets.length,
        opens: (window as any).__walletProbe.opens,
      }))
    ).toEqual({ count: 0, opens: 0 })
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click()
    await importKnownPhrase(page, true)
    expect(
      await page.evaluate(() => (window as any).__walletProbe.openedAccounts)
    ).toEqual([7])
    expect(
      await page.evaluate(
        async ({ core, recovery }) => {
          const signer = (await import(core)).getAccountSigner()
          const found = await (
            await import(recovery)
          )
            .getAccountSparkRecovery(signer)
            .discover(false, "mainnet")
          return {
            resolved: found.candidates.find((c: any) => c.source === "addy")
              .resolved,
            network: (window as any).__walletLifecycle.wallets
              .portableWallets[0].network,
          }
        },
        { core, recovery }
      )
    ).toEqual({ resolved: true, network: "mainnet" })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("Merchant retires the verified legacy NWC owner and Disconnect survives reload with the Wallets title @merchant", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  const wallet = createDeterministicNwcWallet({ relayUrl: relay })
  try {
    await wallet.start()
    await observeController(page, "merchant")
    await page.route(
      "**/src/components/MerchantProjectTip.tsx*",
      async (route) => {
        const response = await route.fetch()
        const body = await response.text()
        const marker = "const nwc = useNwcConnection();"
        if (body.split(marker).length !== 2)
          throw new Error("Legacy tip-owner observation seam changed")
        await route.fulfill({
          response,
          body: body.replace(
            marker,
            marker + "window.__legacyTipConnection = !!nwc.connection;"
          ),
        })
      }
    )
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.merchant + "/wallet")
    await expect(page).toHaveTitle("Wallets | Conduit Merchant")
    await wallet.configureMerchantConnection(async (uri) => {
      await page.evaluate(
        ({ pubkey, uri }) =>
          localStorage.setItem(`conduit:merchant:nwc_uri:${pubkey}`, uri),
        { pubkey: identity.pubkey, uri }
      )
    })
    await page.reload()
    await expect
      .poll(() =>
        page.evaluate(
          async ({ core, pubkey }) => {
            const { db } = await import(core)
            return {
              legacy: !!localStorage.getItem(
                `conduit:merchant:nwc_uri:${pubkey}`
              ),
              wallets: await db.wallets.count(),
              credentials: await db.walletCredentials.count(),
              legacyTip: (window as any).__legacyTipConnection,
              legacyConnection: !!(window as any).__walletLifecycle.automation
                .connection,
            }
          },
          { core, pubkey: identity.pubkey }
        )
      )
      .toEqual({
        legacy: false,
        wallets: 1,
        credentials: 1,
        legacyConnection: false,
        legacyTip: false,
      })
    await expect(
      page.getByRole("heading", { name: "External wallets", exact: true })
    ).toBeVisible()
    await page.getByRole("button", { name: /^Manage / }).click()
    await page
      .getByRole("menuitem", { name: "Disconnect", exact: true })
      .click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Disconnect", exact: true })
      .click()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await page.reload()
    await expect(page).toHaveTitle("Wallets | Conduit Merchant")
    await settled(page)
    expect(
      await page.evaluate(
        async ({ core, pubkey }) => {
          const { db } = await import(core)
          return {
            legacy: !!localStorage.getItem(
              `conduit:merchant:nwc_uri:${pubkey}`
            ),
            wallets: await db.wallets.count(),
            credentials: await db.walletCredentials.count(),
            legacyHook: !!(window as any).__walletLifecycle.wallets
              .connectedWallets.length,
          }
        },
        { core, pubkey: identity.pubkey }
      )
    ).toEqual({ legacy: false, wallets: 0, credentials: 0, legacyHook: false })
  } finally {
    await page.close()
    await wallet.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
