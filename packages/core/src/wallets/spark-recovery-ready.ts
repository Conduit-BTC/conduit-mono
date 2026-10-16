import type { WalletDescriptor } from "./index"

import type { StoredSparkWalletRecovery } from "./wallet-storage"

export interface SparkRecoveryReady {
  wallet: WalletDescriptor
  mnemonic: string
  accountNumber: number
  recovered: boolean
}

/** Expose local recovery only after its owner-bound credential and native wallet exist. */
export async function notifySparkRecoveryReady(input: {
  wallet: WalletDescriptor
  mnemonic: string
  accountNumber: number
  recovered: boolean
  ownerPubkey: string
  getStoredRecovery(walletId: string): Promise<StoredSparkWalletRecovery | null>
  isNativeOpen(walletId: string): boolean
  assertAuthority(): void
  onRecoveryReady?(recovery: SparkRecoveryReady): void
}): Promise<void> {
  if (!input.onRecoveryReady) return
  input.assertAuthority()
  const stored = await input.getStoredRecovery(input.wallet.id)
  input.assertAuthority()
  if (
    input.wallet.providerId !== "spark" ||
    stored?.type !== "signer" ||
    stored.walletId !== input.wallet.id ||
    stored.ownerPubkey !== input.ownerPubkey ||
    stored.network !== input.wallet.network ||
    stored.accountNumber !== input.accountNumber ||
    !input.isNativeOpen(input.wallet.id)
  )
    throw new Error("Locally verified wallet recovery is unavailable.")
  input.onRecoveryReady({
    wallet: input.wallet,
    mnemonic: input.mnemonic,
    accountNumber: input.accountNumber,
    recovered: input.recovered,
  })
  input.assertAuthority()
}
