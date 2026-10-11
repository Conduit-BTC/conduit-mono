import {
  getNwcUriFingerprint,
  getWalletDefaultReplacement,
  isWalletNetwork,
  parseNwcUri,
  type NwcGetInfoResult,
  type WalletCapability,
  type WalletDescriptor,
  type WalletNetwork,
  type WalletRegistry,
  type WalletRegistryStore,
} from "@conduit/core"
import { registerNwcWalletAtomically } from "./wallet-storage"
import { closeBuyerNwcSession } from "./buyer-nwc-session"
import { notifyWalletChangeFallback } from "./wallet-change-fallback"

const LEGACY_NWC_STORAGE_KEY = "conduit:buyer-wallet-nwc"
const LEGACY_NWC_CAPABILITY_STORAGE_KEY = "conduit:buyer-wallet-nwc-capability"

export interface NwcCredentialStore {
  /** Match the parsed NWC identity, not the credential URI's raw spelling. */
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
  "list" | "put" | "setDefault"
> {
  listVisible(ownerPubkey: string | null): Promise<WalletDescriptor[]>
  transaction<T>(operation: () => Promise<T>): Promise<T>
}

export type LegacyNwcMigrationResult =
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "already_migrated"; wallet: WalletDescriptor }
  | { status: "migrated"; wallet: WalletDescriptor }

export interface NwcWalletRegistration {
  wallet: WalletDescriptor
  created: boolean
}

/** Retire the legacy owner after read-back; compensate only this migration's new copy. */
export async function migrateAccountNwcConnection(input: {
  uri: string
  connect(
    onRegistered: (registration: NwcWalletRegistration) => void
  ): Promise<WalletDescriptor>
  credentialStore: NwcCredentialStore
  registry: Pick<WalletRegistry, "list" | "remove">
  shouldContinue(): boolean
  retireLegacy(): boolean
}): Promise<boolean> {
  if (!input.shouldContinue()) return false
  let registration: NwcWalletRegistration | undefined
  let retired = false
  try {
    const wallet = await input.connect((result) => {
      registration = result
    })
    return await input.credentialStore.transaction(async () => {
      if (!input.shouldContinue()) return false
      const credential = await input.credentialStore.getNwcCredential(wallet.id)
      const registered = (await input.registry.list()).find(
        (candidate) => candidate.id === wallet.id
      )
      if (
        !credential ||
        !registered ||
        registered.providerId !== "nwc" ||
        registered.kind !== "connected" ||
        getNwcUriFingerprint(credential) !== getNwcUriFingerprint(input.uri)
      )
        throw new Error("Connected Wallet migration verification failed.")
      if (!input.shouldContinue()) return false
      retired = input.retireLegacy()
      return retired
    })
  } finally {
    if (!retired && registration?.created) {
      const walletId = registration.wallet.id
      const removed = await input.credentialStore.transaction(async () => {
        const registered = (await input.registry.list()).find(
          (candidate) => candidate.id === walletId
        )
        const credential =
          await input.credentialStore.getNwcCredential(walletId)
        if (
          (registered &&
            (registered.providerId !== "nwc" ||
              registered.kind !== "connected")) ||
          (credential &&
            getNwcUriFingerprint(credential) !==
              getNwcUriFingerprint(input.uri))
        )
          return false
        await input.credentialStore.deleteNwcCredential(walletId)
        await input.registry.remove(walletId)
        return true
      })
      if (removed) {
        closeBuyerNwcSession(walletId)
        notifyWalletChangeFallback()
      }
    }
  }
}

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
  const result = await registerNwcWalletAtomically({
    store: input.credentialStore,
    uri: legacy.uri,
    listWallets: () => input.registry.list(),
    register: () =>
      input.registry.add({
        kind: "connected",
        providerId: "nwc",
        label: capability?.alias?.trim() || "Connected wallet",
        network: registration.network,
        capabilities,
      }),
    ensureDefault: async (wallet) => {
      if (capabilities.includes("pay_invoice")) {
        await input.registry.setDefault(wallet.id, "pay_invoice")
      }
    },
  })

  clearLegacyStorage(input.legacyStorage)
  return {
    status: result.created ? "migrated" : "already_migrated",
    wallet: result.wallet,
  }
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
  if (methods.includes("lookup_invoice")) {
    capabilities.push("verify_invoice")
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
  const reportedNetwork = info?.network
  const verifiedNetwork = isWalletNetwork(reportedNetwork)
    ? reportedNetwork
    : null
  return {
    network: verifiedNetwork ?? fallbackNetwork,
    capabilities: getNwcWalletCapabilities(info?.methods ?? []).filter(
      (capability) => capability !== "pay_invoice" || verifiedNetwork !== null
    ),
  }
}

export async function reconcileNwcWalletRegistration(input: {
  walletId: string
  ownerPubkey: string | null
  info: NwcGetInfoResult | null
  store: NwcWalletRegistrationStore
  shouldContinue?: () => boolean
  now?: () => number
}): Promise<boolean> {
  if (!input.info) {
    return false
  }

  const assertCurrent = () => {
    if (input.shouldContinue?.() === false)
      throw new Error("Wallet sign-in changed.")
  }
  return input.store.transaction(async () => {
    assertCurrent()
    const wallets = await input.store.list()
    assertCurrent()
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
    const liveCapabilities = new Set(registration.capabilities)
    const defaultIntents = current.defaultIntents.filter(
      (intent) => !movedNetworks && liveCapabilities.has(intent)
    )
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
      assertCurrent()
    }

    let visible = await input.store.listVisible(input.ownerPubkey)
    assertCurrent()
    for (const network of new Set([current.network, registration.network])) {
      const replacement = getWalletDefaultReplacement(visible, {
        network,
        intent: "pay_invoice",
      })
      if (!replacement) {
        continue
      }
      await input.store.setDefault({
        walletId: replacement.id,
        intent: "pay_invoice",
        updatedAt,
      })
      assertCurrent()
      changed = true
      visible = await input.store.listVisible(input.ownerPubkey)
      assertCurrent()
    }

    return changed
  })
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
