import type { SparkWalletManager } from "./spark-wallet"

/** Provider verification supplies the address; optional metadata delivery runs separately. */
export async function resolveSparkLightningAddress(input: {
  manager: Pick<SparkWalletManager, "getLightningAddress">
  walletId: string
  register?: boolean
  username?: string
  domain?: "breez.tips" | "conduit.cash"
  assertCurrent(): void
  onRegistered(address: string): void
}) {
  const { manager, walletId, register = false, username, domain } = input
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
  input.assertCurrent()
  if (state.status === "registered") input.onRegistered(state.address)
  return state
}
