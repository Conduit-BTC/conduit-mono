import path from "node:path"
import { expect, test } from "@playwright/test"
import type {
  AuthContextValue,
  BreezAddressState,
  WalletDescriptor,
} from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"

type RaceFixture = {
  state(): {
    held: boolean
    customRead: boolean
    settled: boolean
    reads: number
    activations: number
    metadataCurrent: boolean
  }
  release(): Promise<void>
}

test.use({ trace: "off", screenshot: "off", video: "off" })
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"

for (const mode of ["automatic", "retry"] as const) {
  for (const outcome of ["default", "unavailable", "rejected"] as const) {
    test(
      "verified activation retires an older " +
        mode +
        " receiving observation with " +
        outcome +
        " result @market",
      async ({ page }) => {
        await page.goto(
          "http://127.0.0.1:" +
            (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000") +
            "/wallet"
        )
        await page.evaluate(
          async ({
            componentUrl,
            resolverUrl,
            reactUrl,
            domUrl,
            mode,
            outcome,
          }) => {
            const React = (await import(reactUrl)).default
            const { createRoot } = (await import(domUrl)).default
            const { Wallets } = await import(componentUrl)
            const { resolveSparkLightningAddress } = await import(resolverUrl)
            const host = document.createElement("div")
            host.id = "activation-race-fixture"
            document.body.append(host)
            const wallet: WalletDescriptor = {
              id: "fixture-wallet",
              kind: "portable",
              providerId: "spark",
              label: "Activation wallet",
              network: "mainnet",
              capabilities: ["receive"],
              status: "ready",
              defaultIntents: [],
              createdAt: 1,
              updatedAt: 1,
            }
            const activated: BreezAddressState = {
              status: "registered",
              username: "fixture",
              address: "fixture@conduit.cash",
              lnurl: "lnurlp://conduit.cash/lnurlp/fixture",
              publicLookup: "verified",
              zapAdvertised: false,
              receiveEvidence: "unverified",
            }
            const unavailable: BreezAddressState = {
              status: "unavailable",
              reason: "provider_unavailable",
            }
            let reads = 0,
              activations = 0,
              held = false,
              customRead = false,
              settled = false
            let metadata = ""
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
              release = resolve
            })
            let pending: Promise<BreezAddressState> | undefined
            const resolve = async (
              _id: string,
              _register?: boolean,
              _username?: string,
              _domain?: string,
              options?: { signal?: AbortSignal }
            ) => {
              reads++
              const delayed = mode === "automatic" || reads > 1
              const result = resolveSparkLightningAddress({
                walletId: wallet.id,
                signal: options?.signal,
                manager: {
                  getLightningAddress: async (
                    _wallet: string,
                    _create: boolean,
                    _name: string | undefined,
                    domain: string
                  ) => {
                    if (domain === "conduit.cash") {
                      if (delayed) customRead = true
                      return { status: "absent" }
                    }
                    if (!delayed) return unavailable
                    held = true
                    await gate
                    if (outcome === "rejected")
                      throw new Error("Older observation failed")
                    return outcome === "unavailable"
                      ? unavailable
                      : {
                          ...activated,
                          address: "fixture@breez.tips",
                          lnurl: "lnurlp://breez.tips/lnurlp/fixture",
                        }
                  },
                },
                assertCurrent: () => {},
                onRegistered: (address: string) => {
                  metadata = address
                },
              })
              if (delayed) pending = result
              try {
                return await result
              } finally {
                if (delayed) settled = true
              }
            }
            const saved = {
              record: {
                phase: "approved",
                payload: JSON.stringify({ desiredName: "fixture" }),
                accountProof: "{}",
              },
              publication: "confirmed",
            }
            const wallets = {
              wallets: [wallet],
              portableWallets: [wallet],
              connectedWallets: [],
              runtime: {
                [wallet.id]: {
                  status: "ready",
                  balanceMsats: null,
                  error: null,
                },
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
              requestAddressName: {
                load: async () => saved,
                activate: async (
                  _id: string,
                  options: { onProgress(value: unknown): void }
                ) => {
                  activations++
                  metadata = activated.address
                  const complete = {
                    ...saved,
                    record: { ...saved.record, phase: "complete" },
                    activation: { step: "profile", address: activated },
                  }
                  options.onProgress(complete)
                  return complete
                },
              },
            } as unknown as UseWalletsReturn
            createRoot(host).render(
              React.createElement(Wallets, {
                auth: {
                  accountPubkey: "fixture-owner",
                  authGeneration: 1,
                  signerReadiness: "ready",
                } as AuthContextValue,
                wallets,
                addressController: {
                  existing: "",
                  confirmed: true,
                  pending: false,
                  signerReady: true,
                },
                onSuggestAddress: () => {},
              })
            )
            Reflect.set(window, "__activationRaceFixture", {
              state: () => ({
                held,
                customRead,
                settled,
                reads,
                activations,
                metadataCurrent: metadata === activated.address,
              }),
              release: async () => {
                release()
                await pending?.catch(() => {})
                await new Promise(requestAnimationFrame)
                await new Promise(requestAnimationFrame)
              },
            } satisfies RaceFixture)
          },
          {
            componentUrl:
              "/@fs" + path.resolve("packages/ui/src/components/Wallets.tsx"),
            resolverUrl:
              "/@fs" +
              path.resolve(
                "packages/core/src/wallets/resolve-spark-lightning-address.ts"
              ),
            reactUrl: "/@id/react",
            domUrl: "/@id/react-dom/client",
            mode,
            outcome,
          }
        )
        const surface = page.locator("#activation-race-fixture")
        const card = surface.getByRole("article", {
          name: "Activation wallet wallet",
          exact: true,
        })
        const state = () =>
          page.evaluate(() =>
            (
              Reflect.get(window, "__activationRaceFixture") as RaceFixture
            ).state()
          )
        if (mode === "retry")
          await card
            .getByRole("button", {
              name: "Retry receiving address",
              exact: true,
            })
            .click()
        await expect
          .poll(async () => {
            const value = await state()
            return value.held && value.customRead
          })
          .toBe(true)
        await card
          .getByRole("button", {
            name: "Activate and use address",
            exact: true,
          })
          .click()
        await expect(
          card.getByLabel("Desired name", { exact: true })
        ).toHaveCount(0)
        await expect(card.locator("[data-wallet-address]")).toHaveText(
          "fixture@conduit.cash"
        )
        await page.evaluate(() =>
          (
            Reflect.get(window, "__activationRaceFixture") as RaceFixture
          ).release()
        )
        await expect(card.locator("[data-wallet-address]")).toHaveText(
          "fixture@conduit.cash"
        )
        await expect(
          card.getByRole("button", { name: "Copy address", exact: true })
        ).toBeVisible()
        await expect(
          card.getByText("Could not refresh the receiving address.", {
            exact: true,
          })
        ).toHaveCount(0)
        await expect(
          card.getByRole("button", { name: "Share address", exact: true })
        ).toBeVisible()
        expect(await state()).toEqual({
          held: true,
          customRead: true,
          settled: true,
          reads: mode === "automatic" ? 1 : 2,
          activations: 1,
          metadataCurrent: true,
        })
      }
    )
  }
}
