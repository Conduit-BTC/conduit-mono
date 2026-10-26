import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import path from "node:path"
import { expect, test } from "@playwright/test"
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

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const sync =
  "/@fs" + path.resolve("packages/core/src/wallets/portable-wallet-sync.ts")

for (const app of ["market", "merchant"] as const) {
  test(`${app} restores its saved address before provider startup and retains it through provider failures @market @merchant`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const identity = createRuntimeSignerIdentity()
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    try {
      await prepareControlledWallet(page)
      await observeWalletController(page)
      await installRealTestSigner(
        page,
        identity,
        `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
      )
      await page.goto(`http://127.0.0.1:${port}/wallet`)
      await installControlledWallet(page)
      await openWalletSetup(page, "Create wallet")
      await saveWalletRecovery(page)
      await page.evaluate(
        async ({ core, sync }) => {
          const { getAccountSigner } = await import(core)
          const { getPortableWalletSync } = await import(sync)
          const controller = Reflect.get(
            window,
            "__controlledWalletController"
          ) as UseWalletsReturn
          const service = getPortableWalletSync(getAccountSigner())
          await service.update(controller.portableWallets[0].id, {
            lightningAddress: "saved@conduit.cash",
          })
          await service.sync({ priority: "foreground" })
        },
        { core, sync }
      )

      // The provider factory is held until installed below. The address must
      // restore from signed/encrypted storage while provider startup is blocked.
      await page.reload()
      const card = page.getByRole("article", {
        name: /^Conduit Wallet.* wallet$/,
      })
      await expect(card.locator("[data-wallet-address]")).toHaveText(
        "saved@conduit.cash"
      )
      await installControlledWallet(page, false, undefined, { failOpen: true })
      await expect(card).toContainText("Your saved address is unchanged.")
      await expect(
        card.getByRole("button", { name: "Copy address", exact: true })
      ).toBeVisible()

      await page.reload()
      await installControlledWallet(page, false, undefined, {
        addressUnavailableReason: "provider_unavailable",
      })
      await expect(card.locator("[data-wallet-address]")).toHaveText(
        "saved@conduit.cash"
      )
      await expect(
        card.getByRole("button", {
          name: "Retry receiving address",
          exact: true,
        })
      ).toBeVisible()
      await card
        .getByRole("button", { name: "Retry receiving address", exact: true })
        .click()
      await expect(card.locator("[data-wallet-address]")).toHaveText(
        "saved@conduit.cash"
      )
      expect(
        await page.evaluate(
          async ({ core, sync }) => {
            const { getAccountSigner } = await import(core)
            const { getPortableWalletSync } = await import(sync)
            const controller = Reflect.get(
              window,
              "__controlledWalletController"
            ) as UseWalletsReturn
            const probe = Reflect.get(window, "__walletProbe") as {
              addressDomains?: string[]
              registrations: number
            }
            const service = getPortableWalletSync(getAccountSigner())
            await service.sync({ priority: "foreground" })
            return {
              saved:
                (await service.get(controller.portableWallets[0].id))
                  .lightningAddress === "saved@conduit.cash",
              onlySelectedDomain:
                (probe.addressDomains?.length ?? 0) > 0 &&
                probe.addressDomains?.every(
                  (domain: string) => domain === "conduit.cash"
                ),
              registrations: probe.registrations,
            }
          },
          { core, sync }
        )
      ).toEqual({ saved: true, onlySelectedDomain: true, registrations: 0 })
      await card.getByRole("button", { name: "Receive", exact: true }).click()
      const receive = page.getByRole("dialog")
      await expect(
        receive.getByText("saved@conduit.cash", { exact: true })
      ).toBeVisible()
      await expect(
        receive.getByRole("button", { name: "Copy address", exact: true })
      ).toBeVisible()
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("finished address card keeps profile state explicit and setup hidden on desktop and mobile @market", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}/wallet`
  )
  await page.evaluate(
    async ({ componentUrl, reactUrl, domUrl }) => {
      const React = (await import(reactUrl)).default
      const { createRoot } = (await import(domUrl)).default
      const { Wallets } = await import(componentUrl)
      document.getElementById("root")!.style.display = "none"
      const host = document.createElement("div")
      host.id = "finished-wallet-fixture"
      host.className = "mx-auto max-w-6xl p-6"
      document.body.append(host)
      const root = createRoot(host)
      const wallet = {
        id: "finished-wallet",
        kind: "portable",
        providerId: "spark",
        label: "Conduit Wallet",
        network: "mainnet",
        capabilities: ["receive"],
        status: "ready",
        defaultIntents: [],
        createdAt: 1,
        updatedAt: 1,
      }
      let existing = "fixture@conduit.cash",
        mode = "verified",
        generation = 1
      const render = () =>
        root.render(
          React.createElement(Wallets, {
            auth: {
              accountPubkey: "fixture-owner",
              authGeneration: generation,
              signerReadiness: "ready",
            },
            wallets: {
              wallets: [wallet],
              portableWallets: [wallet],
              connectedWallets: [],
              runtime: {
                [wallet.id]: {
                  status: "ready",
                  balanceMsats: 262000,
                  error: null,
                },
              },
              nwcSnapshots: {},
              recoverySyncByWallet: {},
              recoverySync: "ready",
              mainWalletSync: null,
              loading: false,
              signerUnlockSupported: true,
              sparkAvailability: { status: "ready", network: "mainnet" },
              getSparkRecoveryType: async () => "signer",
              getSparkLightningAddress: async () =>
                mode === "verified"
                  ? {
                      status: "registered",
                      address: "fixture@conduit.cash",
                      publicLookup: "verified",
                      username: "fixture",
                      lnurl: "https://conduit.cash/lnurlp/fixture",
                    }
                  : {
                      status: "saved",
                      address: "fixture@conduit.cash",
                      availability: "unavailable",
                    },
              requestAddressName: {
                load: async () => ({
                  record: {
                    phase: "complete",
                    payload: JSON.stringify({ desiredName: "fixture" }),
                  },
                  publication: "confirmed",
                }),
              },
            },
            addressController: {
              owner: "fixture-owner",
              existing,
              confirmed: true,
              pending: false,
              signerReady: true,
              draft: existing,
              saved: false,
              error: null,
              scopedSuggestion: null,
              setSaved() {},
              setDraft() {},
              onDismiss() {},
              save: async () => false,
            },
            onSuggestAddress() {},
          })
        )
      Reflect.set(window, "__finishedWalletFixture", (next: string) => {
        if (next === "mismatch") existing = "external@wallet.example"
        else mode = next
        generation++
        render()
      })
      render()
    },
    {
      componentUrl:
        "/@fs" + path.resolve("packages/ui/src/components/Wallets.tsx"),
      reactUrl: "/@id/react",
      domUrl: "/@id/react-dom/client",
    }
  )
  const surface = page.locator("#finished-wallet-fixture")
  const card = surface.getByRole("article", {
    name: "Conduit Wallet wallet",
    exact: true,
  })
  await expect(card).toContainText("Used on your Nostr profile")
  await expect(surface.locator("[data-wallet-address]")).toHaveCount(1)
  await expect(surface.getByLabel("Desired name", { exact: true })).toHaveCount(
    0
  )
  await expect(
    surface.getByRole("button", { name: "Edit", exact: true })
  ).toHaveCount(0)
  for (const size of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await expect(
      card.getByRole("button", { name: "Copy address", exact: true })
    ).toBeVisible()
    expect(
      await card.evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true)
    // This component-only fixture contains no signer, recovery material or live data.
    for (const theme of ["night-market", "day-market"] as const) {
      await page.evaluate(
        async ({ moduleUrl, theme }) => {
          ;(await import(moduleUrl)).setThemePreference(theme)
          await document.fonts.ready
        },
        {
          moduleUrl: "/@fs" + path.resolve("packages/ui/src/theme/runtime.ts"),
          theme,
        }
      )
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await surface.screenshot({
        path: test.info().outputPath(`finished-${size.width}-${theme}.png`),
      })
    }
  }
  await card.getByText("Manage address", { exact: true }).click()
  await card
    .getByRole("button", { name: "Change public receiving address" })
    .click()
  await expect(
    page.getByRole("dialog", { name: "Public Lightning address" })
  ).toContainText("does not change your wallet’s own address")
  await page.keyboard.press("Escape")
  await expect(
    card.getByRole("button", { name: "Change public receiving address" })
  ).toBeFocused()
  await page.evaluate(() =>
    Reflect.get(window, "__finishedWalletFixture")("mismatch")
  )
  await expect(card.locator("[data-wallet-profile-status]")).toContainText(
    "external@wallet.example"
  )
  await expect(
    card.getByRole("button", { name: "Use this address", exact: true })
  ).toBeVisible()
  await page.evaluate(() =>
    Reflect.get(window, "__finishedWalletFixture")("unavailable")
  )
  await expect(card.locator("[data-wallet-address]")).toHaveText(
    "fixture@conduit.cash"
  )
  await expect(card).toContainText("Your saved address is unchanged.")
  await expect(
    card.getByRole("button", { name: "Use this address", exact: true })
  ).toHaveCount(0)
  await expect(
    card.getByRole("button", { name: "Copy address", exact: true })
  ).toBeVisible()
  await expect(card.getByLabel("Desired name", { exact: true })).toHaveCount(0)
})
