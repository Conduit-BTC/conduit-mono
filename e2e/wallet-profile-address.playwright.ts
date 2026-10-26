import path from "node:path"
import { expect, test } from "@playwright/test"
import type {
  AuthContextValue,
  BreezAddressState,
  WalletDescriptor,
} from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type {
  WalletAddressController,
  WalletAddressSuggestion,
} from "@conduit/core/hooks/useWalletAddress"

type ProfileAddressFixture = {
  setLookup(value: "verified" | "unavailable"): void
  counts(): { suggestions: number; saves: number }
}

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

for (const app of ["market", "merchant"] as const) {
  test(`${app} wallet profile suggestion requires verified public receiving lookup @market @merchant`, async ({
    page,
  }) => {
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    await page.goto(`http://127.0.0.1:${port}/wallet`)
    await page.evaluate(
      async ({ componentUrl, reactUrl, domUrl }) => {
        const React = (await import(reactUrl)).default
        const { createRoot } = (await import(domUrl)).default
        const { Wallets } = await import(componentUrl)
        const host = document.createElement("div")
        host.id = "profile-suggestion-fixture"
        document.body.append(host)
        const wallet: WalletDescriptor = {
          id: "fixture-wallet",
          kind: "portable",
          providerId: "spark",
          label: "Suggestion wallet",
          network: "mainnet",
          capabilities: ["receive"],
          status: "ready",
          defaultIntents: [],
          createdAt: 1,
          updatedAt: 1,
        }
        const auth = {
          accountPubkey: "fixture-owner",
          authGeneration: 1,
          signerReadiness: "ready",
        } as AuthContextValue
        let suggestions = 0,
          saves = 0
        let lookup: "verified" | "unavailable" = "unavailable"
        let suggestion: WalletAddressSuggestion | null = null
        let existing = ""
        const root = createRoot(host)
        const render = () => {
          const resolve = async (): Promise<BreezAddressState> => ({
            status: "registered",
            username: "fixture",
            address: "fixture@conduit.cash",
            lnurl: "lnurlp://conduit.cash/lnurlp/fixture",
            publicLookup: lookup,
            zapAdvertised: false,
            receiveEvidence: "unverified",
          })
          const wallets = {
            wallets: [wallet],
            portableWallets: [wallet],
            connectedWallets: [],
            runtime: {
              [wallet.id]: { status: "ready", balanceMsats: null, error: null },
            },
            nwcSnapshots: {},
            recoverySyncByWallet: {},
            recoverySync: "ready",
            mainWalletSync: null,
            loading: false,
            initializationError: null,
            signerUnlockSupported: true,
            sparkAvailability: { status: "ready", network: "mainnet" },
            getSparkRecoveryType: async () => "signer",
            getSparkLightningAddress: resolve,
          } as unknown as UseWalletsReturn
          const controller: WalletAddressController = {
            owner: "fixture-owner",
            existing,
            scopedSuggestion: suggestion,
            confirmed: true,
            pending: false,
            signerReady: true,
            draft: "",
            saved: false,
            error: null,
            setDraft: () => {},
            setSaved: () => {},
            onDismiss: () => {
              suggestion = null
              render()
            },
            save: async (address) => {
              saves++
              existing = address
              suggestion = null
              render()
              return true
            },
          }
          root.render(
            React.createElement(Wallets, {
              auth,
              wallets,
              addressController: controller,
              onSuggestAddress: (value: WalletAddressSuggestion) => {
                suggestions++
                suggestion = value
                render()
              },
            })
          )
        }
        Reflect.set(window, "__profileAddressFixture", {
          setLookup: (value: "verified" | "unavailable") => {
            lookup = value
            render()
          },
          counts: () => ({ suggestions, saves }),
        } satisfies ProfileAddressFixture)
        render()
      },
      {
        componentUrl: `/@fs${path.resolve("packages/ui/src/components/Wallets.tsx")}`,
        reactUrl: "/@id/react",
        domUrl: "/@id/react-dom/client",
      }
    )

    const surface = page.locator("#profile-suggestion-fixture")
    const card = surface.getByRole("article", {
      name: "Suggestion wallet wallet",
      exact: true,
    })
    const useAddress = surface.getByRole("button", {
      name: "Use this address",
      exact: true,
    })
    const counts = () =>
      page.evaluate(() =>
        (
          Reflect.get(
            window,
            "__profileAddressFixture"
          ) as ProfileAddressFixture
        ).counts()
      )
    const setLookup = (value: "verified" | "unavailable") =>
      page.evaluate(
        (value) =>
          (
            Reflect.get(
              window,
              "__profileAddressFixture"
            ) as ProfileAddressFixture
          ).setLookup(value),
        value
      )
    await expect(card).toContainText(
      "Receiving availability still needs verification"
    )
    await expect(useAddress).toHaveCount(0)
    await expect(
      card.getByRole("button", { name: "Copy address", exact: true })
    ).toHaveCount(0)
    expect(await counts()).toEqual({ suggestions: 0, saves: 0 })

    await setLookup("verified")
    await expect(useAddress).toBeVisible()
    expect(await counts()).toEqual({ suggestions: 0, saves: 0 })
    await useAddress.click()
    const dialog = page.getByRole("dialog", {
      name: "Public Lightning address",
    })
    await expect(dialog).toContainText(
      "This wallet receives at fixture@conduit.cash"
    )
    expect(await counts()).toEqual({ suggestions: 1, saves: 0 })
    await dialog
      .getByRole("button", { name: "Use the Conduit address", exact: true })
      .click()
    expect(await counts()).toEqual({ suggestions: 1, saves: 1 })
    await expect(dialog).toHaveCount(0)

    await setLookup("unavailable")
    await expect(card).toContainText(
      "Receiving availability still needs verification"
    )
    await expect(surface.locator("[data-wallet-profile-row]")).toHaveCount(0)
    await expect(
      card.getByRole("button", { name: "Copy address", exact: true })
    ).toHaveCount(0)
    expect(await counts()).toEqual({ suggestions: 1, saves: 1 })
    // A failed observation does not erase the separately published profile.
    await expect(card.locator("[data-wallet-profile-status]")).toContainText(
      "fixture@conduit.cash"
    )
  })
}
