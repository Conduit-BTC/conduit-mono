import type { SignerSparkRecovery } from "./signer-spark-recovery"
import {
  serializeStoredSparkWalletRecovery,
  type AtomicSparkWalletRegistrationStore,
  type StoredSparkWalletRecovery,
} from "./wallet-storage"

/** Called after verified decrypt/encrypt, native opening and registration checks. */
export async function commitVerifiedSignerRecovery(input: {
  store: AtomicSparkWalletRegistrationStore
  walletId: string
  original: StoredSparkWalletRecovery
  verified: SignerSparkRecovery
  assertAuthority(): void
}): Promise<void> {
  const { original, verified, store, walletId, assertAuthority } = input
  if (
    verified.walletId !== walletId ||
    original.walletId !== walletId ||
    verified.network !== original.network ||
    verified.accountNumber !== original.accountNumber ||
    (original.type === "signer" &&
      (original.ownerPubkey !== verified.ownerPubkey ||
        original.identityKey !== verified.identityKey))
  )
    throw new Error("Wallet recovery binding changed.")
  // Construct an allowlisted record: old envelopes cannot survive via spreads.
  const replacement: SignerSparkRecovery = {
    type: "signer",
    version: 1,
    walletId,
    providerId: "spark",
    network: verified.network,
    accountNumber: verified.accountNumber,
    ownerPubkey: verified.ownerPubkey,
    identityKey: verified.identityKey,
    ciphertext: verified.ciphertext,
  }
  await store.transaction(async () => {
    assertAuthority()
    const current = await store.getSparkRecovery(walletId)
    if (
      !current ||
      serializeStoredSparkWalletRecovery(current) !==
        serializeStoredSparkWalletRecovery(original)
    )
      throw new Error("Wallet recovery changed. Reopen it before migrating.")
    await store.putSparkRecovery(walletId, replacement)
    const readback = await store.getSparkRecovery(walletId)
    if (
      !readback ||
      serializeStoredSparkWalletRecovery(readback) !==
        serializeStoredSparkWalletRecovery(replacement)
    )
      throw new Error("Wallet migration could not be verified.")
    assertAuthority()
  })
}
