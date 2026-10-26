import type { SparkWalletManager } from "./spark-wallet"

/** Provider verification supplies the address; optional metadata delivery runs separately. */
export async function resolveSparkLightningAddress(input: {
  manager: Pick<SparkWalletManager, "getLightningAddress">
  walletId: string
  register?: boolean
  username?: string
  domain?: "breez.tips" | "conduit.cash"
  /** Retire the observation without cancelling or replaying provider operations. */
  signal?: AbortSignal
  assertCurrent(): void
  onRegistered(address: string): void
}) {
  const { manager, walletId, register = false, username, domain } = input
  input.signal?.throwIfAborted()
  const state = domain
    ? await manager.getLightningAddress(walletId, register, username, domain)
    : await (async () => {
        const [breez, existing] = await Promise.all([
          manager.getLightningAddress(walletId, true, undefined, "breez.tips"),
          manager.getLightningAddress(
            walletId,
            false,
            undefined,
            "conduit.cash"
          ),
        ])
        return existing.status === "registered" ? existing : breez
      })()
  input.signal?.throwIfAborted()
  input.assertCurrent()
  if (state.status === "registered" && state.publicLookup === "verified")
    input.onRegistered(state.address)
  return state
}
