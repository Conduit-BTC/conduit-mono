import type { SparkWalletManager } from "./spark-wallet"
import type {
  BreezAddressFailure,
  BreezAddressState,
} from "./breez-lightning-address"

export interface SavedLightningAddressState {
  status: "saved"
  address: string
  availability: "checking" | "unavailable" | "not_found" | "conflicting"
  reason?: BreezAddressFailure | "not_found"
  retryAt?: number
}
export type WalletLightningAddressState =
  BreezAddressState | SavedLightningAddressState

/** Restore the selected address before independently checking receiving availability. */
export async function resolveSparkLightningAddress(input: {
  manager: Pick<SparkWalletManager, "getLightningAddress">
  walletId: string
  register?: boolean
  username?: string
  domain?: "breez.tips" | "conduit.cash"
  /** Retire the observation without cancelling or replaying provider operations. */
  signal?: AbortSignal
  /** Read saved selection even when the provider session cannot be opened. */
  lookupAvailable?: boolean
  loadSavedAddress?(): Promise<string | null>
  onSavedAddress?(state: SavedLightningAddressState): void
  assertCurrent(): void
  onRegistered(address: string): void
}): Promise<WalletLightningAddressState> {
  const { manager, walletId, register = false, username, domain } = input
  const assertCurrent = () => {
    input.signal?.throwIfAborted()
    input.assertCurrent()
  }
  assertCurrent()
  const saved = input.loadSavedAddress ? await input.loadSavedAddress() : null
  assertCurrent()
  if (saved)
    input.onSavedAddress?.({
      status: "saved",
      address: saved,
      availability: "checking",
    })
  if (input.lookupAvailable === false)
    return saved
      ? { status: "saved", address: saved, availability: "unavailable" }
      : { status: "unavailable", reason: "locked" }
  const savedDomain = saved?.split("@")[1]
  // A restored selection never registers or probes an alternate receiving domain.
  if (saved && !["breez.tips", "conduit.cash"].includes(savedDomain ?? ""))
    return { status: "saved", address: saved, availability: "unavailable" }
  let state: BreezAddressState
  try {
    state = saved
      ? await manager.getLightningAddress(
          walletId,
          false,
          undefined,
          savedDomain
        )
      : domain
        ? await manager.getLightningAddress(
            walletId,
            register,
            username,
            domain
          )
        : await (async () => {
            const [breez, existing] = await Promise.all([
              manager.getLightningAddress(
                walletId,
                true,
                undefined,
                "breez.tips"
              ),
              manager.getLightningAddress(
                walletId,
                false,
                undefined,
                "conduit.cash"
              ),
            ])
            return existing.status === "registered" ? existing : breez
          })()
  } catch (error) {
    assertCurrent()
    if (!saved) throw error
    state = { status: "unavailable", reason: "provider_unavailable" }
  }
  assertCurrent()
  // Activation or a synchronized successor may have changed selection during IO.
  const currentSaved = input.loadSavedAddress
    ? await input.loadSavedAddress()
    : saved
  assertCurrent()
  if (
    currentSaved &&
    (state.status !== "registered" ||
      state.address !== currentSaved ||
      state.publicLookup !== "verified")
  )
    return {
      status: "saved",
      address: currentSaved,
      availability:
        state.status === "absent" ||
        (state.status === "registered" &&
          state.address === currentSaved &&
          state.publicFailure === "not_found")
          ? "not_found"
          : state.status === "registered" && state.address !== currentSaved
            ? "conflicting"
            : "unavailable",
      ...(state.status === "unavailable"
        ? { reason: state.reason, retryAt: state.retryAt }
        : state.status === "registered" && state.address === currentSaved
          ? { reason: state.publicFailure, retryAt: state.retryAt }
          : {}),
    }
  if (state.status === "registered" && state.publicLookup === "verified")
    input.onRegistered(state.address)
  return state
}
