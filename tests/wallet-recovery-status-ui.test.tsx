import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WalletDescriptor } from "@conduit/core/wallets"
import type { AuthContextValue } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { Wallets } from "../packages/ui/src/components/Wallets"

function surface(
  recoverySync: UseWalletsReturn["recoverySync"],
  hasWallet = true
) {
  const wallet: WalletDescriptor = {
    id: "wallet",
    kind: "portable",
    providerId: "spark",
    label: "Conduit Wallet",
    network: "mainnet",
    capabilities: ["receive"],
    status: "locked",
    defaultIntents: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const wallets = {
    portableWallets: hasWallet ? [wallet] : [],
    connectedWallets: [],
    runtime: {},
    nwcSnapshots: {},
    loading: false,
    initializationError: null,
    hasPasswordWallets: false,
    signerUnlockSupported: true,
    sparkAvailability: { status: "ready", network: "mainnet" },
    recoverySync,
  } as unknown as UseWalletsReturn
  const auth = {
    signerReadiness: "ready",
    accountPubkey: "account",
    authGeneration: 1,
  } as AuthContextValue
  return renderToStaticMarkup(
    <Wallets
      auth={auth}
      wallets={wallets}
      formatSats={String}
      renderAddressEditor={() => null}
    />
  )
}
describe("shared Wallets recovery delivery wording", () => {
  for (const status of ["idle", "checking", "pending", "blocked"] as const) {
    it(`${status} never claims confirmed relay storage`, () => {
      const markup = surface(status)
      expect(markup).not.toContain("saved on recovery relays")
      expect(markup).not.toContain("Encrypted relay recovery is confirmed.")
      expect(markup).toContain("Relay recovery is not confirmed yet.")
      expect(markup).toContain("Save your phrase, account number and network")
    })
  }
  it("complete empty discovery does not claim a wallet backup is confirmed", () => {
    const markup = surface("ready", false)
    expect(markup).not.toContain("Encrypted relay recovery is confirmed.")
    expect(markup).toContain("Relay recovery is not confirmed yet.")
  })
  it("ready confirms relay recovery after core readiness", () => {
    const markup = surface("ready")
    expect(markup).toContain("Encrypted relay recovery is confirmed.")
    expect(markup).not.toContain("Relay recovery is not confirmed yet.")
  })
})
