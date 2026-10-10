import {
  db,
  getAccountSigner,
  getNwcUriFingerprint,
  getWalletDefaultUpdates,
  isWalletNetwork,
  WalletRegistry,
  type SetWalletDefaultInput,
  type WalletDescriptor,
  type WalletNetwork,
  type WalletRegistryStore,
} from "@conduit/core"

import type { NwcCredentialStore } from "./wallet-migration"
import {
  isSparkEncryptedRecoveryEnvelope,
  isValidSparkAccountNumber,
  type SparkEncryptedRecovery,
  type SparkRecoveryBinding,
} from "./spark-recovery"

const MAX_STORED_WALLET_ID_LENGTH = 128
const MAX_STORED_SPARK_RECOVERY_LENGTH = 8_192

import type { SignerSparkRecovery } from "./signer-spark-recovery"

export type StoredSparkWalletRecovery =
  | PasswordSparkWalletRecovery
  | (SignerSparkRecovery & { legacyRecovery?: PasswordSparkWalletRecovery })

export interface PasswordSparkWalletRecovery {
  type: "password"
  walletId: string
  providerId: "spark"
  network: WalletNetwork
  accountNumber: number
  recovery: SparkEncryptedRecovery
}

export function findMatchingNwcCredentialWalletIds(
  credentials: readonly {
    walletId: string
    providerId: string
    credential: string
  }[],
  uri: string
): string[] {
  const fingerprint = getNwcUriFingerprint(uri)
  return credentials.flatMap((credential) => {
    if (credential.providerId !== "nwc") return []
    try {
      return getNwcUriFingerprint(credential.credential) === fingerprint
        ? [credential.walletId]
        : []
    } catch {
      return []
    }
  })
}

export interface AtomicSparkWalletRegistrationStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>
  putSparkRecovery(
    walletId: string,
    recovery: StoredSparkWalletRecovery
  ): Promise<void>
  getSparkRecovery(walletId: string): Promise<StoredSparkWalletRecovery | null>
}

/**
 * Keeps the public wallet descriptor and its local recovery reference in one
 * commit. Verification happens before that transaction is allowed to commit.
 */
export async function registerSparkWalletAtomically(input: {
  store: AtomicSparkWalletRegistrationStore
  register(): Promise<WalletDescriptor>
  recovery: StoredSparkWalletRecovery
  findExisting?(): Promise<WalletDescriptor | undefined>
  shouldContinue?: () => boolean
}): Promise<WalletDescriptor> {
  return input.store.transaction(async () => {
    if (input.shouldContinue?.() === false)
      throw new Error("Wallet sign-in changed.")
    const existing = await input.findExisting?.()
    if (existing) return existing
    const wallet = await input.register()
    assertSparkRecoveryMatchesWallet(wallet, input.recovery)
    await input.store.putSparkRecovery(wallet.id, input.recovery)
    const storedRecovery = await input.store.getSparkRecovery(wallet.id)
    if (
      !storedRecovery ||
      serializeStoredSparkWalletRecovery(storedRecovery) !==
        serializeStoredSparkWalletRecovery(input.recovery)
    ) {
      throw new Error("Portable Wallet recovery verification failed.")
    }
    if (input.shouldContinue?.() === false)
      throw new Error("Wallet sign-in changed.")
    return wallet
  })
}

/**
 * Registers one logical Connected Wallet per normalized NWC credential.
 *
 * The duplicate lookup and credential write share the same IndexedDB write
 * transaction so concurrent tabs cannot create two wallet descriptors for the
 * same external wallet connection.
 */
export async function registerNwcWalletAtomically(input: {
  store: NwcCredentialStore
  uri: string
  listWallets(): Promise<WalletDescriptor[]>
  register(): Promise<WalletDescriptor>
  ensureDefault(wallet: WalletDescriptor): Promise<void>
}): Promise<{ wallet: WalletDescriptor; created: boolean }> {
  const normalizedUri = input.uri.trim()
  if (!normalizedUri) {
    throw new Error("Connected Wallet credential is required.")
  }

  return input.store.transaction(async () => {
    const existingWalletIds =
      await input.store.findWalletIdsByUri(normalizedUri)
    const registeredWallets = await input.listWallets()
    let existingWallet: WalletDescriptor | null = null
    for (const existingWalletId of existingWalletIds) {
      const registeredWallet = registeredWallets.find(
        (wallet) => wallet.id === existingWalletId
      )
      if (registeredWallet) {
        if (
          registeredWallet.kind !== "connected" ||
          registeredWallet.providerId !== "nwc" ||
          existingWallet
        ) {
          throw new Error("Connected Wallet registration is inconsistent.")
        }
        existingWallet = registeredWallet
        continue
      }

      // Repair an orphaned credential row inside this transaction before
      // recreating its missing public descriptor.
      await input.store.deleteNwcCredential(existingWalletId)
    }
    if (existingWallet) {
      return { wallet: existingWallet, created: false }
    }

    const wallet = await input.register()
    if (wallet.kind !== "connected" || wallet.providerId !== "nwc") {
      throw new Error("Connected Wallet registration is invalid.")
    }
    await input.store.putNwcCredential(wallet.id, normalizedUri)
    const saved = await input.store.getNwcCredential(wallet.id)
    if (saved !== normalizedUri) {
      throw new Error("Connected Wallet credential verification failed.")
    }
    await input.ensureDefault(wallet)
    const verifiedWallet = (await input.listWallets()).find(
      (candidate) => candidate.id === wallet.id
    )
    if (!verifiedWallet) {
      throw new Error("Connected Wallet descriptor verification failed.")
    }
    return { wallet: verifiedWallet, created: true }
  })
}

export class MarketWalletStore
  implements WalletRegistryStore, NwcCredentialStore
{
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return db.transaction("rw", db.wallets, db.walletCredentials, operation)
  }

  async list(): Promise<WalletDescriptor[]> {
    return db.wallets.toArray()
  }

  async listVisible(ownerPubkey: string | null): Promise<WalletDescriptor[]> {
    const wallets = await this.list()
    const visible = await Promise.all(
      wallets.map(async (wallet) => {
        if (wallet.providerId !== "spark") return true
        const recovery = await this.getSparkRecovery(wallet.id)
        return (
          !recovery ||
          recovery.type === "password" ||
          recovery.ownerPubkey === ownerPubkey
        )
      })
    )
    return wallets.filter((_wallet, index) => visible[index])
  }

  async put(wallet: WalletDescriptor): Promise<void> {
    await db.wallets.put(wallet)
  }

  async setDefault(input: SetWalletDefaultInput): Promise<void> {
    const signer = getAccountSigner()
    await db.transaction("rw", db.wallets, db.walletCredentials, async () => {
      const wallets = await this.listVisible(signer?.pubkey ?? null)
      if (getAccountSigner() !== signer)
        throw new Error("Wallet sign-in changed.")
      const updates = getWalletDefaultUpdates(wallets, input)
      if (updates.length > 0) {
        await db.wallets.bulkPut(updates)
        if (getAccountSigner() !== signer)
          throw new Error("Wallet sign-in changed.")
      }
    })
  }

  async delete(id: string): Promise<void> {
    await db.transaction("rw", db.wallets, db.walletCredentials, async () => {
      await db.walletCredentials.delete(id)
      await db.wallets.delete(id)
    })
  }

  async findWalletIdsByUri(uri: string): Promise<string[]> {
    const credentials = await db.walletCredentials.toArray()
    return findMatchingNwcCredentialWalletIds(credentials, uri)
  }

  async putNwcCredential(walletId: string, uri: string): Promise<void> {
    const existing = await db.walletCredentials.get(walletId)
    const now = Date.now()
    await db.walletCredentials.put({
      walletId,
      providerId: "nwc",
      credential: uri,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  async getNwcCredential(walletId: string): Promise<string | null> {
    const credential = await db.walletCredentials.get(walletId)
    return credential?.providerId === "nwc" ? credential.credential : null
  }

  async deleteNwcCredential(walletId: string): Promise<void> {
    await db.walletCredentials.delete(walletId)
  }

  async putSparkRecovery(
    walletId: string,
    recovery: StoredSparkWalletRecovery
  ): Promise<void> {
    if (recovery.walletId !== walletId || recovery.providerId !== "spark") {
      throw new Error("Portable Wallet recovery binding is invalid.")
    }
    const existing = await db.walletCredentials.get(walletId)
    const now = Date.now()
    await db.walletCredentials.put({
      walletId,
      providerId: "spark",
      credential: serializeStoredSparkWalletRecovery(recovery),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  async getSparkRecovery(
    walletId: string
  ): Promise<StoredSparkWalletRecovery | null> {
    const credential = await db.walletCredentials.get(walletId)
    if (credential?.providerId !== "spark") {
      return null
    }
    const recovery = parseStoredSparkWalletRecovery(credential.credential)
    return recovery?.walletId === walletId && recovery.providerId === "spark"
      ? recovery
      : null
  }
}

let walletStore: MarketWalletStore | null = null
let walletRegistry: WalletRegistry | null = null

export function getMarketWalletStore(): MarketWalletStore {
  walletStore ??= new MarketWalletStore()
  return walletStore
}

export function getMarketWalletRegistry(): WalletRegistry {
  walletRegistry ??= new WalletRegistry(getMarketWalletStore())
  return walletRegistry
}

export function serializeStoredSparkWalletRecovery(
  recovery: StoredSparkWalletRecovery
): string {
  const parsed = parseStoredSparkWalletRecovery(JSON.stringify(recovery))
  if (!parsed) throw new Error("Wallet recovery data is invalid.")
  return JSON.stringify(parsed)
}

export function parseStoredSparkWalletRecovery(
  value: string
): StoredSparkWalletRecovery | null {
  if (!value || value.length > MAX_STORED_SPARK_RECOVERY_LENGTH) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const walletId = parsed.walletId
    const providerId = parsed.providerId
    const network = parsed.network
    const accountNumber = parsed.accountNumber
    if (
      typeof walletId !== "string" ||
      !walletId ||
      walletId.length > MAX_STORED_WALLET_ID_LENGTH ||
      providerId !== "spark" ||
      !isWalletNetwork(network) ||
      !isValidSparkAccountNumber(accountNumber)
    ) {
      return null
    }

    if (
      parsed.type === "signer" &&
      parsed.version === 1 &&
      typeof parsed.ownerPubkey === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.ownerPubkey) &&
      typeof parsed.identityKey === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.identityKey) &&
      typeof parsed.ciphertext === "string" &&
      parsed.ciphertext.length > 0 &&
      parsed.ciphertext.length <= 4096
    ) {
      const legacyRecovery =
        parsed.legacyRecovery === undefined
          ? undefined
          : parseStoredSparkWalletRecovery(
              JSON.stringify(parsed.legacyRecovery)
            )
      if (
        parsed.legacyRecovery !== undefined &&
        (!legacyRecovery ||
          legacyRecovery.type !== "password" ||
          legacyRecovery.walletId !== walletId ||
          legacyRecovery.network !== network ||
          legacyRecovery.accountNumber !== accountNumber)
      )
        return null
      return {
        type: "signer",
        version: 1,
        walletId,
        providerId,
        network,
        accountNumber,
        ownerPubkey: parsed.ownerPubkey,
        identityKey: parsed.identityKey,
        ciphertext: parsed.ciphertext,
        ...(legacyRecovery?.type === "password" ? { legacyRecovery } : {}),
      }
    }
    const recovery = parsed.recovery
    if (
      parsed.type !== "password" ||
      !isSparkEncryptedRecoveryEnvelope(recovery)
    ) {
      return null
    }
    return {
      type: "password",
      walletId,
      providerId,
      network,
      accountNumber,
      recovery,
    }
  } catch {
    return null
  }
}

export function getSparkRecoveryBinding(
  wallet: WalletDescriptor,
  recovery: StoredSparkWalletRecovery
): SparkRecoveryBinding {
  assertSparkRecoveryMatchesWallet(wallet, recovery)
  return {
    walletId: recovery.walletId,
    providerId: recovery.providerId,
    network: recovery.network,
    accountNumber: recovery.accountNumber,
  }
}

function assertSparkRecoveryMatchesWallet(
  wallet: WalletDescriptor,
  recovery: StoredSparkWalletRecovery
): void {
  if (
    wallet.id !== recovery.walletId ||
    wallet.kind !== "portable" ||
    wallet.providerId !== recovery.providerId ||
    wallet.network !== recovery.network
  ) {
    throw new Error(
      "Portable Wallet recovery data does not match its registration."
    )
  }
}
