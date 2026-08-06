import {
  getWalletDefaultReplacement,
  getWalletDefaultUpdates,
  parseNwcUri,
  type NwcGetInfoResult,
  type WalletCapability,
  type WalletDescriptor,
  type WalletNetwork,
  type WalletRegistry,
  type WalletRegistryStore,
} from "@conduit/core"

const LEGACY_NWC_STORAGE_KEY = "conduit:buyer-wallet-nwc"
const LEGACY_NWC_CAPABILITY_STORAGE_KEY = "conduit:buyer-wallet-nwc-capability"

export interface NwcCredentialStore {
  findWalletIdsByUri(uri: string): Promise<string[]>
  putNwcCredential(walletId: string, uri: string): Promise<void>
  getNwcCredential(walletId: string): Promise<string | null>
  deleteNwcCredential(walletId: string): Promise<void>
  transaction<T>(operation: () => Promise<T>): Promise<T>
}

export interface LegacyWalletStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

export interface NwcWalletRegistrationStore extends Pick<
  WalletRegistryStore,
  "list" | "put"
> {
  transaction<T>(operation: () => Promise<T>): Promise<T>
}

export type LegacyNwcMigrationResult =
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "already_migrated"; wallet: WalletDescriptor }
  | { status: "migrated"; wallet: WalletDescriptor }

export async function migrateLegacyNwcWallet(input: {
  legacyStorage: LegacyWalletStorage
  registry: WalletRegistry
  credentialStore: NwcCredentialStore
  fallbackNetwork: WalletNetwork
}): Promise<LegacyNwcMigrationResult> {
  const rawConnection = input.legacyStorage.getItem(LEGACY_NWC_STORAGE_KEY)
  if (!rawConnection) {
    return { status: "not_found" }
  }

  const legacy = parseLegacyConnection(rawConnection)
  if (!legacy) {
    return { status: "invalid" }
  }

  const capability = parseLegacyCapability(
    input.legacyStorage.getItem(LEGACY_NWC_CAPABILITY_STORAGE_KEY)
  )
  const registration = getNwcWalletRegistrationDetails(
    capability,
    input.fallbackNetwork
  )
  const capabilities = registration.capabilities
  const result = await input.credentialStore.transaction(async () => {
    const existingWalletIds = await input.credentialStore.findWalletIdsByUri(
      legacy.uri
    )
    const registeredWallets = await input.registry.list()
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

      // Repair a credential left behind by a partial migration before the
      // replacement descriptor and credential are committed atomically.
      await input.credentialStore.deleteNwcCredential(existingWalletId)
    }
    if (existingWallet) {
      return { status: "already_migrated", wallet: existingWallet } as const
    }

    const wallet = await input.registry.add({
      kind: "connected",
      providerId: "nwc",
      label: capability?.alias?.trim() || "Connected wallet",
      network: registration.network,
      capabilities,
    })
    await input.credentialStore.putNwcCredential(wallet.id, legacy.uri)
    const storedUri = await input.credentialStore.getNwcCredential(wallet.id)
    if (storedUri !== legacy.uri) {
      throw new Error("NWC credential verification failed.")
    }

    if (capabilities.includes("pay_invoice")) {
      await input.registry.setDefault(wallet.id, "pay_invoice")
    }

    const verifiedWallet = (await input.registry.list()).find(
      (candidate) => candidate.id === wallet.id
    )
    if (!verifiedWallet) {
      throw new Error("Wallet descriptor verification failed.")
    }
    return { status: "migrated", wallet: verifiedWallet } as const
  })

  clearLegacyStorage(input.legacyStorage)
  return result
}

function parseLegacyConnection(raw: string): { uri: string } | null {
  try {
    const parsed = JSON.parse(raw) as { uri?: unknown }
    if (typeof parsed.uri !== "string") {
      return null
    }
    parseNwcUri(parsed.uri)
    return { uri: parsed.uri.trim() }
  } catch {
    return null
  }
}

function parseLegacyCapability(
  raw: string | null
): { alias?: string; network?: string; methods: string[] } | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      info?: { alias?: unknown; network?: unknown; methods?: unknown }
    }
    if (!parsed.info || !Array.isArray(parsed.info.methods)) {
      return null
    }
    return {
      ...(typeof parsed.info.alias === "string" && {
        alias: parsed.info.alias,
      }),
      ...(typeof parsed.info.network === "string" && {
        network: parsed.info.network,
      }),
      methods: parsed.info.methods.filter(
        (method): method is string => typeof method === "string"
      ),
    }
  } catch {
    return null
  }
}

export function getNwcWalletCapabilities(
  methods: string[]
): WalletCapability[] {
  const capabilities: WalletCapability[] = []
  if (methods.includes("pay_invoice")) {
    capabilities.push("pay_invoice")
  }
  if (methods.includes("make_invoice")) {
    capabilities.push("receive")
  }
  if (methods.includes("get_balance")) {
    capabilities.push("balance")
  }
  if (methods.includes("list_transactions")) {
    capabilities.push("history")
  }
  return capabilities
}

export function getNwcWalletRegistrationDetails(
  info: Pick<NwcGetInfoResult, "methods" | "network"> | null,
  fallbackNetwork: WalletNetwork
): { network: WalletNetwork; capabilities: WalletCapability[] } {
  const verifiedNetwork = getWalletNetwork(info?.network)
  return {
    network: verifiedNetwork ?? fallbackNetwork,
    capabilities: getNwcWalletCapabilities(info?.methods ?? []).filter(
      (capability) => capability !== "pay_invoice" || verifiedNetwork !== null
    ),
  }
}

export async function reconcileNwcWalletRegistration(input: {
  walletId: string
  info: NwcGetInfoResult | null
  store: NwcWalletRegistrationStore
  now?: () => number
}): Promise<boolean> {
  if (!input.info) {
    return false
  }

  return input.store.transaction(async () => {
    let wallets = await input.store.list()
    const current = wallets.find(
      (wallet) =>
        wallet.id === input.walletId &&
        wallet.kind === "connected" &&
        wallet.providerId === "nwc"
    )
    if (!current) {
      return false
    }

    const registration = getNwcWalletRegistrationDetails(
      input.info,
      current.network
    )
    const movedNetworks = registration.network !== current.network
    const defaultIntents =
      movedNetworks || !registration.capabilities.includes("pay_invoice")
        ? current.defaultIntents.filter((intent) => intent !== "pay_invoice")
        : current.defaultIntents
    const descriptorChanged =
      movedNetworks ||
      !arraysEqual(current.capabilities, registration.capabilities) ||
      !arraysEqual(current.defaultIntents, defaultIntents)
    const updatedAt = input.now?.() ?? Date.now()
    let changed = descriptorChanged

    if (descriptorChanged) {
      const updated: WalletDescriptor = {
        ...current,
        network: registration.network,
        capabilities: registration.capabilities,
        defaultIntents,
        updatedAt,
      }
      await input.store.put(updated)
      wallets = wallets.map((wallet) =>
        wallet.id === updated.id ? updated : wallet
      )
    }

    for (const network of new Set([current.network, registration.network])) {
      const replacement = getWalletDefaultReplacement(wallets, {
        network,
        intent: "pay_invoice",
      })
      if (!replacement) {
        continue
      }
      const updates = getWalletDefaultUpdates(wallets, {
        walletId: replacement.id,
        intent: "pay_invoice",
        updatedAt,
      })
      for (const update of updates) {
        await input.store.put(update)
      }
      if (updates.length > 0) {
        changed = true
        const updatesById = new Map(
          updates.map((wallet) => [wallet.id, wallet])
        )
        wallets = wallets.map((wallet) => updatesById.get(wallet.id) ?? wallet)
      }
    }

    return changed
  })
}

function getWalletNetwork(network: string | undefined): WalletNetwork | null {
  return network === "mainnet" ||
    network === "testnet" ||
    network === "signet" ||
    network === "regtest"
    ? network
    : null
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function clearLegacyStorage(storage: LegacyWalletStorage): void {
  storage.removeItem(LEGACY_NWC_STORAGE_KEY)
  storage.removeItem(LEGACY_NWC_CAPABILITY_STORAGE_KEY)
}
