import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import { createDeterministicNwcWallet } from "./helpers/deterministic-nwc-wallet"
const core = "/@fs" + path.resolve("packages/core/src/index.ts")
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
  await page.route(
    (url) =>
      url.pathname.endsWith("/src/routes/wallet.tsx") &&
      url.searchParams.get("tsr-split") === "component",
    async (route) => {
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
    }
  )
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
      page.getByRole("heading", { name: "Wallets", level: 1, exact: true })
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

for (const failure of ["registration", "read-back"] as const) {
  test(`Merchant retries legacy NWC ${failure} failure without reloading or changing accounts @merchant`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const wallet = createDeterministicNwcWallet({ relayUrl: relay })
    try {
      await wallet.start()
      await observeController(page, "merchant")
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps.merchant + "/wallet")
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).__walletLifecycle?.wallets.loading
          )
        )
        .toBe(false)
      await page.evaluate(
        async ({ storage, failure, pubkey }) => {
          const store = (await import(storage)).getMarketWalletStore()
          const method =
            failure === "registration" ? "putNwcCredential" : "getNwcCredential"
          const original = store[method].bind(store)
          const probe = ((window as any).__migrationRetryProbe = {
            calls: 0,
            retirements: 0,
            generation: (window as any).__walletLifecycle.auth.authGeneration,
          })
          store[method] = async (...args: any[]) => {
            probe.calls++
            if (probe.calls === 1)
              throw new Error("Injected migration storage failure")
            return original(...args)
          }
          const removeItem = Storage.prototype.removeItem
          Storage.prototype.removeItem = function (key) {
            if (
              this === localStorage &&
              key === `conduit:merchant:nwc_uri:${pubkey}`
            )
              probe.retirements++
            removeItem.call(this, key)
          }
        },
        {
          storage:
            "/@fs" +
            path.resolve("packages/core/src/wallets/wallet-storage.ts"),
          failure,
          pubkey: identity.pubkey,
        }
      )
      await wallet.configureMerchantConnection(async (uri) => {
        await page.evaluate(
          (value) => (window as any).__walletLifecycle.automation.setUri(value),
          uri
        )
      })
      const retry = page.getByRole("button", {
        name: "Retry wallet setup",
        exact: true,
      })
      await expect
        .poll(() =>
          page.evaluate(
            async ({ core, pubkey }) => {
              const { db } = await import(core)
              const probe = (window as any).__migrationRetryProbe
              return {
                wallets: await db.wallets.count(),
                credentials: await db.walletCredentials.count(),
                legacy: !!localStorage.getItem(
                  `conduit:merchant:nwc_uri:${pubkey}`
                ),
                calls: probe.calls,
                retirements: probe.retirements,
              }
            },
            { core, pubkey: identity.pubkey }
          )
        )
        .toEqual({
          wallets: 0,
          credentials: 0,
          legacy: true,
          calls: 1,
          retirements: 0,
        })
      await expect(retry).toBeVisible()
      await page.evaluate(() =>
        (window as any).__walletLifecycle.wallets.retryInitialization()
      )
      expect(
        await page.evaluate(() => (window as any).__migrationRetryProbe.calls)
      ).toBe(1)
      await retry.click()
      await expect(retry).toHaveCount(0)
      await expect
        .poll(() =>
          page.evaluate(
            async ({ core, pubkey }) => {
              const { db } = await import(core)
              const state = (window as any).__walletLifecycle
              const probe = (window as any).__migrationRetryProbe
              return {
                wallets: await db.wallets.count(),
                credentials: await db.walletCredentials.count(),
                legacy: !!localStorage.getItem(
                  `conduit:merchant:nwc_uri:${pubkey}`
                ),
                retirements: probe.retirements,
                sameAuthority:
                  state.auth.accountPubkey === pubkey &&
                  state.auth.authGeneration === probe.generation,
              }
            },
            { core, pubkey: identity.pubkey }
          )
        )
        .toEqual({
          wallets: 1,
          credentials: 1,
          legacy: false,
          retirements: 1,
          sameAuthority: true,
        })
      await wallet.configureMerchantConnection(async (uri) => {
        expect(
          await page.evaluate(
            async ({ core, uri }) => {
              const { db } = await import(core)
              const stored = await db.walletCredentials.toArray()
              return stored.length === 1 && stored[0].credential === uri
            },
            { core, uri }
          )
        ).toBe(true)
      })
    } finally {
      await page.close()
      await wallet.close()
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("Merchant compensates a new NWC migration copy after account replacement and retains legacy recovery @merchant", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  const wallet = createDeterministicNwcWallet({ relayUrl: relay })
  try {
    await wallet.start()
    await observeController(page, "merchant")
    await page.addInitScript(() => {
      const fixture = window as any
      fixture.__holdNwcMigration = () =>
        new Promise<void>((resolve) => {
          fixture.__nwcMigrationPaused = true
          fixture.__releaseNwcMigration = resolve
        })
    })
    await page.route(
      "**/packages/core/src/wallets/wallet-migration.ts*",
      async (route) => {
        const response = await route.fetch()
        const body = await response.text()
        const marker = "return await input.credentialStore.transaction("
        if (body.split(marker).length !== 2)
          throw new Error(
            "Post-registration migration observation seam changed"
          )
        await route.fulfill({
          response,
          body: body.replace(
            marker,
            "if (window.__holdNwcMigration) await window.__holdNwcMigration(); " +
              marker
          ),
        })
      }
    )
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.merchant + "/wallet")
    await wallet.configureMerchantConnection(async (uri) => {
      await page.evaluate(
        ({ pubkey, uri }) =>
          localStorage.setItem(`conduit:merchant:nwc_uri:${pubkey}`, uri),
        { pubkey: identity.pubkey, uri }
      )
    })
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => !!(window as any).__nwcMigrationPaused))
      .toBe(true)
    const copiedId = await page.evaluate(
      async ({ core }) => {
        const { db } = await import(core)
        const rows = await db.wallets.toArray()
        if (rows.length !== 1 || (await db.walletCredentials.count()) !== 1)
          throw new Error("Migration copy did not commit before the barrier")
        return rows[0].id
      },
      { core }
    )
    await page.evaluate(() =>
      (window as any).__walletLifecycle.auth.disconnect()
    )
    await page.evaluate(() => (window as any).__releaseNwcMigration())
    await expect
      .poll(() =>
        page.evaluate(
          async ({ core, pubkey, copiedId, sessions }) => {
            const { db } = await import(core)
            return {
              wallets: await db.wallets.count(),
              credentials: await db.walletCredentials.count(),
              legacy: !!localStorage.getItem(
                `conduit:merchant:nwc_uri:${pubkey}`
              ),
              attached: !!(await import(sessions)).getBuyerNwcSessionSnapshots([
                copiedId,
              ])[copiedId]?.connection,
            }
          },
          {
            core,
            pubkey: identity.pubkey,
            copiedId,
            sessions:
              "/@fs" +
              path.resolve("packages/core/src/wallets/buyer-nwc-session.ts"),
          }
        )
      )
      .toEqual({ wallets: 0, credentials: 0, legacy: true, attached: false })
    await page.evaluate(async () => {
      delete (window as any).__holdNwcMigration
      await (window as any).__walletLifecycle.auth.connect({ method: "nip07" })
    })
    await expect
      .poll(() =>
        page.evaluate(
          async ({ core, pubkey }) => {
            const { db } = await import(core)
            return {
              wallets: await db.wallets.count(),
              credentials: await db.walletCredentials.count(),
              legacy: !!localStorage.getItem(
                `conduit:merchant:nwc_uri:${pubkey}`
              ),
            }
          },
          { core, pubkey: identity.pubkey }
        )
      )
      .toEqual({ wallets: 1, credentials: 1, legacy: false })
    await page.evaluate(async () => {
      const { wallets } = (window as any).__walletLifecycle
      await wallets.removeWallet(wallets.connectedWallets[0].id)
    })
    await page.reload()
    await expect
      .poll(() =>
        page.evaluate(
          async ({ core, pubkey }) => {
            const { db } = await import(core)
            return {
              wallets: await db.wallets.count(),
              credentials: await db.walletCredentials.count(),
              legacy: !!localStorage.getItem(
                `conduit:merchant:nwc_uri:${pubkey}`
              ),
            }
          },
          { core, pubkey: identity.pubkey }
        )
      )
      .toEqual({ wallets: 0, credentials: 0, legacy: false })
  } finally {
    await wallet.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

test("unbound invoices cannot borrow unrelated NWC settlement; retained original authority still verifies @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  const original = createDeterministicNwcWallet({
    relayUrl: relay,
    network: "mainnet",
  })
  const unrelated = createDeterministicNwcWallet({
    relayUrl: relay,
    network: "mainnet",
    claimUnissuedSettled: true,
  })
  const receiving =
    "/@fs" + path.resolve("packages/core/src/wallets/wallet-receiving.ts")
  const verification =
    "/@fs" +
    path.resolve("apps/merchant/src/lib/merchant-payment-verification.ts")
  try {
    await original.start()
    await unrelated.start()
    await installRealTestSigner(page, identity, relay)
    await observeController(page, "market")
    await page.goto(apps.market + "/wallet")
    await settled(page)
    await original.configureMerchantConnection(async (uri) => {
      await page.evaluate(async (uri) => {
        ;(window as any).__originalReceiver = (
          await (window as any).__walletLifecycle.wallets.connectNwc(uri)
        ).id
      }, uri)
    })
    await unrelated.configureMerchantConnection(async (uri) => {
      await page.evaluate(async (uri) => {
        await (window as any).__walletLifecycle.wallets.connectNwc(uri)
      }, uri)
    })
    await page.evaluate(
      async ({ receiving }) => {
        const owner = (window as any).__walletLifecycle.auth.accountPubkey
        const issued = await (
          await import(receiving)
        ).createWalletReceivingInvoice(
          owner,
          (window as any).__originalReceiver,
          100
        )
        ;(window as any).__originalIssued = issued
      },
      { receiving, core }
    )
    const check = (bound: boolean) =>
      page.evaluate(
        async ({ receiving, verification, core, bound }) => {
          const controller = (window as any).__walletLifecycle
          const issued = (window as any).__originalIssued
          const candidate = {
            orderId: "original-order",
            buyerPubkey: controller.auth.accountPubkey,
            evidenceMessageId: "original-evidence",
            invoice: issued.invoice,
            paymentHash: (await import(core)).decodeLightningInvoicePaymentHash(
              issued.invoice
            ),
            expectedAmountMsats: 100_000,
            orderCreatedAt: Math.floor(Date.now() / 1000) - 10,
            delivery: "buyer_and_self",
          }
          let confirmations = 0
          const result = await (
            await import(verification)
          ).verifyMerchantPaymentCandidates({
            candidates: [candidate],
            confirmedEvidence: new Set(),
            lookupInvoice: () =>
              import(receiving).then((module) =>
                module.lookupAccountReceivingInvoice({
                  owner: controller.auth.accountPubkey,
                  invoice: issued.invoice,
                  receivingWallet: bound ? issued.receivingWallet : undefined,
                  wallets: controller.wallets.wallets,
                })
              ),
            publishConfirmation: async () => {
              confirmations++
            },
          })
          return {
            verified: result.verified,
            failures: result.lookupFailures,
            confirmations,
          }
        },
        { receiving, verification, core, bound }
      )
    expect(await check(false)).toEqual({
      verified: 0,
      failures: 1,
      confirmations: 0,
    })
    expect(original.snapshot().counters.lookupInvoice).toBe(0)
    expect(unrelated.snapshot().counters.lookupInvoice).toBe(0)
    await original.payLastInvoice()
    expect(await check(true)).toEqual({
      verified: 1,
      failures: 0,
      confirmations: 1,
    })
    expect(original.snapshot().counters.lookupInvoice).toBe(1)
    expect(unrelated.snapshot().counters.lookupInvoice).toBe(0)
    const retained = await page.evaluate(() => (window as any).__originalIssued)
    await page.reload()
    await settled(page)
    await page.evaluate((issued) => {
      ;(window as any).__originalIssued = issued
    }, retained)
    expect(await check(true)).toEqual({
      verified: 1,
      failures: 0,
      confirmations: 1,
    })
    expect(original.snapshot().counters.lookupInvoice).toBe(2)
    expect(unrelated.snapshot().counters.lookupInvoice).toBe(0)
  } finally {
    await unrelated.close()
    await original.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} public-address saves and suggestions use the shared Lightning resolver validator @market`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await installRealTestSigner(page, identity, relay)
      await observeController(page, app)
      await page.route(
        "**/packages/core/src/hooks/useWalletAddress.ts*",
        async (route) => {
          const response = await route.fetch()
          let body = await response.text()
          const marker = /return \{\s*owner,/
          if ([...body.matchAll(/return \{\s*owner,/g)].length !== 1)
            throw new Error("Address controller observation seam changed")
          body = body.replace(
            marker,
            "return window.__profileAddressControl = {\n    owner,"
          )
          body = body.replace(
            "const scopedSuggestion =",
            "suggestion = window.__forcedAddressSuggestion ?? suggestion; const scopedSuggestion ="
          )
          await route.fulfill({ response, body })
        }
      )
      await page.goto(apps[app] + "/wallet")
      await settled(page)
      await expect
        .poll(() =>
          page.evaluate(
            () => !!(window as any).__profileAddressControl?.confirmed
          )
        )
        .toBe(true)
      await page
        .getByRole("region", { name: "Nostr profile receiving address" })
        .getByRole("button", { name: "Edit", exact: true })
        .click()
      await page.evaluate(() => {
        const auth = (window as any).__walletLifecycle.auth
        ;(window as any).__forcedAddressSuggestion = {
          ownerPubkey: auth.accountPubkey,
          authGeneration: auth.authGeneration,
          address: "bad@domain..example",
          firstWallet: true,
          imported: false,
        }
        ;(window as any).__profileAddressControl.setDraft(
          "force suggestion render"
        )
      })
      await expect(
        page.getByText(
          "Enter a Lightning address, such as name@conduit.cash.",
          { exact: true }
        )
      ).toBeVisible()
      await page.evaluate(() => {
        ;(window as any).__forcedAddressSuggestion = null
      })
      for (const address of [
        "bad@domain..example",
        "name@.example.com",
        "name@@example.com",
        "name@domain.1",
        "name@例.example",
      ]) {
        expect(
          await page.evaluate(
            async ({ core, address }) => {
              const controller = (window as any).__profileAddressControl
              await controller.save(address)
              return {
                valid: (await import(core)).isValidLud16Address(address),
                saved: (window as any).__profileAddressControl.saved,
              }
            },
            { core, address }
          )
        ).toEqual({ valid: false, saved: false })
        await expect(
          page.getByText(
            "Enter a Lightning address, such as name@conduit.cash.",
            { exact: true }
          )
        ).toBeVisible()
      }
      await page
        .getByLabel("Lightning address", { exact: true })
        .fill(" Mixed.Case@Example.COM ")
      await page
        .getByRole("button", { name: "Save public address", exact: true })
        .click()
      await expect(
        page
          .getByRole("region", { name: "Nostr profile receiving address" })
          .locator("[data-wallet-address]")
      ).toHaveText("mixed.case@example.com")
      await page
        .getByRole("region", { name: "Nostr profile receiving address" })
        .getByRole("button", { name: "Edit", exact: true })
        .click()
      await page.getByLabel("Lightning address", { exact: true }).fill("")
      await page
        .getByRole("button", { name: "Save public address", exact: true })
        .click()
      await expect(
        page
          .getByRole("region", { name: "Nostr profile receiving address" })
          .locator("[data-wallet-address]")
      ).toHaveText("No address set")
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
