import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WalletDescriptor } from "@conduit/core/wallets"
import type { AuthContextValue } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type { WalletAddressController } from "@conduit/core/hooks/useWalletAddress"
import {
  Wallets,
  WalletRecoveryNotice,
} from "../packages/ui/src/components/Wallets"

function surface(
  recoverySync: UseWalletsReturn["recoverySync"],
  hasWallet = true,
  recoveryDetails = true
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
  const walletDiagnosis: UseWalletsReturn["recoveryDiagnosisByWallet"][string] =
    {
      backup: {
        ready: recoverySync !== "pending",
        confirmedTargets: 0,
        targetCount: recoverySync === "pending" ? 1 : 0,
        independentCopies: 0,
        issues: recoverySync === "pending" ? ["awaiting_publish"] : [],
      },
      primary: {
        ready: true,
        confirmedTargets: 0,
        targetCount: 0,
        independentCopies: 0,
        issues: [],
      },
    }
  const wallets = {
    wallets: hasWallet ? [wallet] : [],
    portableWallets: hasWallet ? [wallet] : [],
    connectedWallets: [],
    runtime: {},
    recoverySyncByWallet: hasWallet
      ? { wallet: recoverySync === "ready" ? "ready" : "pending" }
      : {},
    recoveryDiagnosisByWallet: hasWallet ? { wallet: walletDiagnosis } : {},
    mainWalletSync: null,
    mainWalletDiagnosis: null,
    recoveryDiscoveryDiagnosis: null,
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
    recoveryDetails ? (
      <WalletRecoveryNotice wallets={wallets} />
    ) : (
      <Wallets
        auth={auth}
        wallets={wallets}
        formatSats={String}
        addressController={
          {
            owner: null,
            existing: "",
            confirmed: false,
            saved: false,
            scopedSuggestion: null,
          } as unknown as WalletAddressController
        }
        onSuggestAddress={() => undefined}
      />
    )
  )
}
describe("shared Wallets recovery delivery wording", () => {
  it("keeps routine backup disclosure in recovery details rather than the wallet card", () => {
    const markup = surface("ready", true, false)
    expect(markup).not.toContain("Encrypted relay recovery is confirmed.")
    expect(markup).not.toContain("Save your phrase, account number and network")
    expect(markup).toContain("Refresh Conduit Wallet balance")
    expect(markup).not.toContain("Sync encrypted wallet recovery")
    expect(markup).toContain("Balance unavailable")
  })
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
  it("pending recovery shows the wallet backup delivery diagnosis", () => {
    const markup = surface("pending")
    expect(markup).toContain("Recovery sync details")
    expect(markup).toContain("Wallet 1 backup:")
    expect(markup).toContain("relay acceptance pending")
    expect(markup).toContain("0/1 fresh target readbacks; 0 independent copies")
  })
})
