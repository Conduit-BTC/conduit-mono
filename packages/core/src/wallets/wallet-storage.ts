import {
  db,
  getAccountSigner,
  getNwcUriFingerprint,
  getWalletDefaultUpdates,
  readAuthSession,
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
  shouldContinue?: () => boolean
}): Promise<{ wallet: WalletDescriptor; created: boolean }> {
  const normalizedUri = input.uri.trim()
  if (!normalizedUri) {
    throw new Error("Connected Wallet credential is required.")
  }

  return input.store.transaction(async () => {
    if (input.shouldContinue?.() === false)
      throw new Error("Wallet sign-in changed.")
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
      if (input.shouldContinue?.() === false)
        throw new Error("Wallet sign-in changed.")
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
    if (input.shouldContinue?.() === false)
      throw new Error("Wallet sign-in changed.")
    return { wallet: verifiedWallet, created: true }
  })
}

export class MarketWalletStore
  implements WalletRegistryStore, NwcCredentialStore
{
  constructor(private readonly database = db) {}

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(
      "rw",
      [
        this.database.wallets,
        this.database.walletCredentials,
        this.database.sparkRecoveryEvidence,
      ],
      operation
    )
  }

  async list(): Promise<WalletDescriptor[]> {
    return this.database.wallets.toArray()
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
    return resolveWalletDefaults(
      wallets.filter((_wallet, index) => visible[index]),
      ownerPubkey
    )
  }

  async put(wallet: WalletDescriptor): Promise<void> {
    await this.database.wallets.put(wallet)
  }

  async rename(walletId: string, label: string): Promise<void> {
    const signer = getAccountSigner()
    const owner = getWalletPreferenceOwner()
    await this.transaction(async () => {
      const [visible, wallet] = await Promise.all([
        this.listVisible(owner),
        this.database.wallets.get(walletId),
      ])
      if (!wallet || !visible.some((candidate) => candidate.id === walletId))
        throw new Error("Wallet is no longer available.")
      if (getAccountSigner() !== signer || getWalletPreferenceOwner() !== owner)
        throw new Error("Wallet sign-in changed.")
      // A projected default is read state; rename changes only the stored label.
      await this.database.wallets.put({ ...wallet, label })
      if (getAccountSigner() !== signer || getWalletPreferenceOwner() !== owner)
        throw new Error("Wallet sign-in changed.")
    })
  }

  async setDefault(input: SetWalletDefaultInput): Promise<void> {
    const signer = getAccountSigner()
    const owner = getWalletPreferenceOwner()
    await this.database.transaction(
      "rw",
      this.database.wallets,
      this.database.walletCredentials,
      async () => {
        const wallets = await this.listVisible(owner)
        if (
          getAccountSigner() !== signer ||
          getWalletPreferenceOwner() !== owner
        )
          throw new Error("Wallet sign-in changed.")
        const updates = new Map(
          getWalletDefaultUpdates(wallets, input).map((wallet) => [
            wallet.id,
            wallet,
          ])
        )
        const selected = wallets.find((wallet) => wallet.id === input.walletId)!
        const originals = new Map(
          (await this.list()).map((wallet) => [wallet.id, wallet])
        )
        const scope = walletDefaultScope(owner, selected.network)
        const scoped = wallets
          .filter((wallet) => wallet.network === selected.network)
          .map((wallet) => {
            const original = originals.get(wallet.id)!
            return {
              ...original,
              defaultIntentsByScope: {
                ...original.defaultIntentsByScope,
                [scope]: [...(updates.get(wallet.id) ?? wallet).defaultIntents],
              },
              updatedAt: input.updatedAt,
            }
          })
        await this.database.wallets.bulkPut(scoped)
        if (
          getAccountSigner() !== signer ||
          getWalletPreferenceOwner() !== owner
        )
          throw new Error("Wallet sign-in changed.")
      }
    )
  }

  async delete(id: string): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.wallets,
      this.database.walletCredentials,
      async () => {
        await this.database.walletCredentials.delete(id)
        await this.database.wallets.delete(id)
      }
    )
  }

  async findWalletIdsByUri(uri: string): Promise<string[]> {
    const credentials = await this.database.walletCredentials.toArray()
    return findMatchingNwcCredentialWalletIds(credentials, uri)
  }

  async putNwcCredential(walletId: string, uri: string): Promise<void> {
    const existing = await this.database.walletCredentials.get(walletId)
    const now = Date.now()
    await this.database.walletCredentials.put({
      walletId,
      providerId: "nwc",
      credential: uri,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  async getNwcCredential(walletId: string): Promise<string | null> {
    const credential = await this.database.walletCredentials.get(walletId)
    return credential?.providerId === "nwc" ? credential.credential : null
  }

  async deleteNwcCredential(walletId: string): Promise<void> {
    await this.database.walletCredentials.delete(walletId)
  }

  async putSparkRecovery(
    walletId: string,
    recovery: StoredSparkWalletRecovery
  ): Promise<void> {
    if (recovery.walletId !== walletId || recovery.providerId !== "spark") {
      throw new Error("Portable Wallet recovery binding is invalid.")
    }
    const existing = await this.database.walletCredentials.get(walletId)
    const now = Date.now()
    await this.database.walletCredentials.put({
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
    const credential = await this.database.walletCredentials.get(walletId)
    if (credential?.providerId !== "spark") {
      return null
    }
    const recovery = parseStoredSparkWalletRecovery(credential.credential)
    return recovery?.walletId === walletId && recovery.providerId === "spark"
      ? recovery
      : null
  }
}

function getWalletPreferenceOwner(): string | null {
  const signer = getAccountSigner()
  if (signer) return signer.pubkey
  // A retained remote account is local identity context, not signer authority.
  const session = readAuthSession()
  return session?.type === "nip46" ? session.userPubkey : null
}

function walletDefaultScope(
  owner: string | null,
  network: WalletNetwork
): string {
  return `${owner ?? "device"}:${network}`
}

function resolveWalletDefaults(
  wallets: WalletDescriptor[],
  owner: string | null
): WalletDescriptor[] {
  const scopedNetworks = new Set(
    wallets
      .filter((wallet) =>
        Object.hasOwn(
          wallet.defaultIntentsByScope ?? {},
          walletDefaultScope(owner, wallet.network)
        )
      )
      .map((wallet) => wallet.network)
  )
  const projected = wallets.map((wallet) => {
    const intents = scopedNetworks.has(wallet.network)
      ? (wallet.defaultIntentsByScope?.[
          walletDefaultScope(owner, wallet.network)
        ] ?? [])
      : wallet.defaultIntents
    return {
      ...wallet,
      defaultIntents: Array.isArray(intents)
        ? [...new Set(intents)].filter(
            (intent) =>
              (intent === "pay_invoice" || intent === "receive") &&
              wallet.capabilities.includes(intent)
          )
        : [],
    }
  })
  const counts = new Map<string, number>()
  for (const wallet of projected)
    for (const intent of wallet.defaultIntents) {
      const key = `${wallet.network}:${intent}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  // Ambiguous legacy markers require an explicit choice, not an arbitrary winner.
  return projected.map((wallet) => ({
    ...wallet,
    defaultIntents: wallet.defaultIntents.filter(
      (intent) => counts.get(`${wallet.network}:${intent}`) === 1
    ),
  }))
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
