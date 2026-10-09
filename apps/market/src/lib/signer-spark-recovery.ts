import {
  getAccountSigner,
  isWalletNetwork,
  type AccountSigner,
} from "@conduit/core"

import {
  decryptSparkMnemonic,
  isValidSparkAccountNumber,
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
  type SparkRecoveryBinding,
} from "./spark-recovery"

import type { StoredSparkWalletRecovery } from "./wallet-storage"

export interface SignerSparkRecovery extends SparkRecoveryBinding {
  type: "signer"
  version: 1
  ownerPubkey: string
  ciphertext: string
  identityKey: string
}

export function requireWalletSigner(): AccountSigner {
  const signer = getAccountSigner()
  if (!signer?.capabilities.nip44) {
    throw new Error(
      "Connect a Nostr signer with NIP-44 encryption to create or import a wallet. Your signer may ask for permission."
    )
  }
  return signer
}

export function isWalletSignerCurrent(signer: AccountSigner): boolean {
  return getAccountSigner() === signer
}

export function assertWalletSignerCurrent(signer: AccountSigner): void {
  if (!isWalletSignerCurrent(signer))
    throw new Error(
      "Your Nostr sign-in changed. Open the wallet again with its owner."
    )
}

// A random Spark seed is encrypted to the account, never derived from its key.
// The signer sees recovery plaintext. Only bounded ciphertext is stored locally.
export async function sealSignerSparkRecovery(
  mnemonic: string,
  binding: SparkRecoveryBinding,
  signer = requireWalletSigner()
): Promise<SignerSparkRecovery> {
  if (
    !binding.walletId ||
    binding.walletId.length > 128 ||
    binding.providerId !== "spark" ||
    !isWalletNetwork(binding.network) ||
    !isValidSparkAccountNumber(binding.accountNumber)
  )
    throw new Error("Wallet recovery binding is invalid.")
  mnemonic = normalizeSparkMnemonic(mnemonic)
  if (!isValidSparkMnemonic(mnemonic))
    throw new Error("Enter a valid BIP39 recovery phrase.")
  assertWalletSignerCurrent(signer)
  const [ownerPubkey, identityKey] = await Promise.all([
    signer.getPublicKey(),
    sparkRecoveryIdentityKey(mnemonic, binding),
  ])
  assertWalletSignerCurrent(signer)
  const plaintext = JSON.stringify({
    domain: "conduit:local-spark-recovery:v1",
    ...binding,
    ownerPubkey,
    identityKey,
    mnemonic,
  })
  const ciphertext = await signer.encryptNip44(ownerPubkey, plaintext)
  assertWalletSignerCurrent(signer)
  if (!ciphertext || ciphertext.length > 4096)
    throw new Error("The signer returned invalid wallet encryption.")
  const recovery: SignerSparkRecovery = {
    ...binding,
    type: "signer",
    version: 1,
    ownerPubkey,
    identityKey,
    ciphertext,
  }
  // Prove real permission and round-trip recovery before committing credentials.
  if ((await openSignerSparkRecovery(recovery, binding, signer)) !== mnemonic)
    throw new Error("Wallet encryption verification failed.")
  return recovery
}

export async function openSignerSparkRecovery(
  recovery: SignerSparkRecovery,
  binding: SparkRecoveryBinding,
  signer = requireWalletSigner()
): Promise<string> {
  assertWalletSignerCurrent(signer)
  if (recovery.ownerPubkey !== (await signer.getPublicKey()))
    throw new Error("Sign in with this wallet's Nostr identity.")
  const plaintext = await signer.decryptNip44(
    recovery.ownerPubkey,
    recovery.ciphertext
  )
  assertWalletSignerCurrent(signer)
  if (plaintext.length > 2048)
    throw new Error("Wallet recovery data is invalid.")
  let value
  try {
    value = JSON.parse(plaintext)
  } catch {
    throw new Error("Wallet recovery data is invalid.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Wallet recovery data is invalid.")
  if (
    value.domain !== "conduit:local-spark-recovery:v1" ||
    value.ownerPubkey !== recovery.ownerPubkey ||
    value.identityKey !== recovery.identityKey ||
    value.walletId !== binding.walletId ||
    value.providerId !== binding.providerId ||
    value.network !== binding.network ||
    value.accountNumber !== binding.accountNumber ||
    typeof value.mnemonic !== "string" ||
    !isValidSparkMnemonic(value.mnemonic) ||
    (await sparkRecoveryIdentityKey(value.mnemonic, binding)) !==
      recovery.identityKey
  )
    throw new Error("Wallet recovery data does not match this wallet.")
  assertWalletSignerCurrent(signer)
  return normalizeSparkMnemonic(value.mnemonic)
}

/** A migrated wallet retains its verified old encrypted recovery copy. */
export async function recoverStoredSparkMnemonic(
  stored: StoredSparkWalletRecovery,
  binding: SparkRecoveryBinding,
  password = ""
): Promise<{ mnemonic: string; signer?: AccountSigner }> {
  if (stored.type === "password")
    return {
      mnemonic: await decryptSparkMnemonic(stored.recovery, password, binding),
    }
  if (password && stored.legacyRecovery) {
    const signer = getAccountSigner()
    if (!signer || signer.pubkey !== stored.ownerPubkey)
      throw new Error(
        "Sign in with this wallet's Nostr identity before using its previous password."
      )
    const mnemonic = await decryptSparkMnemonic(
      stored.legacyRecovery.recovery,
      password,
      binding
    )
    assertWalletSignerCurrent(signer)
    if (
      (await sparkRecoveryIdentityKey(mnemonic, binding)) !== stored.identityKey
    )
      throw new Error("Wallet recovery data does not match this wallet.")
    assertWalletSignerCurrent(signer)
    return { mnemonic, signer }
  }
  const signer = requireWalletSigner()
  return {
    mnemonic: await openSignerSparkRecovery(stored, binding, signer),
    signer,
  }
}

export async function sparkRecoveryIdentityKey(
  mnemonic: string,
  binding: Pick<SparkRecoveryBinding, "network" | "accountNumber">
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        "conduit:local-spark-identity:v1",
        binding.network,
        binding.accountNumber,
        normalizeSparkMnemonic(mnemonic),
      ])
    )
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
