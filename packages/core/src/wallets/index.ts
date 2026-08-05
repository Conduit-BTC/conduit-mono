export type WalletKind = "portable" | "connected"

export type WalletProviderId = "spark" | "nwc" | (string & {})

export type WalletNetwork = "mainnet" | "testnet" | "signet" | "regtest"

export type WalletCapability =
  "pay_invoice" | "receive" | "balance" | "history" | "spark_transfer"

export type WalletDefaultIntent = "pay_invoice"

export type WalletLifecycleStatus =
  "registered" | "connecting" | "ready" | "unavailable" | "locked" | "error"

export interface WalletDescriptor {
  id: string
  kind: WalletKind
  providerId: WalletProviderId
  label: string
  network: WalletNetwork
  capabilities: WalletCapability[]
  status: WalletLifecycleStatus
  defaultIntents: WalletDefaultIntent[]
  createdAt: number
  updatedAt: number
}

export type AddWalletInput = Pick<
  WalletDescriptor,
  "kind" | "providerId" | "label" | "network" | "capabilities"
> & {
  /**
   * Callers that must bind credentials to a descriptor before persistence may
   * preallocate its opaque local ID. Registry-generated IDs remain the default.
   */
  id?: string
}

export interface SetWalletDefaultInput {
  walletId: string
  intent: WalletDefaultIntent
  updatedAt: number
}

export interface WalletRegistryStore {
  list(): Promise<WalletDescriptor[]>
  put(wallet: WalletDescriptor): Promise<void>
  /**
   * Read and update the network-scoped default inside one atomic store
   * transaction so concurrent tabs cannot each commit a different default.
   */
  setDefault(input: SetWalletDefaultInput): Promise<void>
  delete(id: string): Promise<void>
}

export interface WalletRegistryOptions {
  createId?: () => string
  now?: () => number
}

export interface ListEligibleWalletsInput {
  network: WalletNetwork
  capability: WalletCapability
}

export interface GetWalletDefaultReplacementInput {
  network: WalletNetwork
  intent: WalletDefaultIntent
}

export function normalizeWalletLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ")
}

function getWalletLabelComparisonKey(label: string): string {
  return normalizeWalletLabel(label).toLowerCase()
}

export function getAvailableWalletLabel(
  wallets: readonly WalletDescriptor[],
  requestedLabel: string,
  excludeWalletId?: string
): string {
  const label = normalizeWalletLabel(requestedLabel)
  if (!label) {
    throw new Error("Wallet label is required.")
  }

  const usedLabels = new Set(
    wallets
      .filter((wallet) => wallet.id !== excludeWalletId)
      .map((wallet) => getWalletLabelComparisonKey(wallet.label))
  )
  if (!usedLabels.has(getWalletLabelComparisonKey(label))) {
    return label
  }

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${label} (${suffix})`
    if (!usedLabels.has(getWalletLabelComparisonKey(candidate))) {
      return candidate
    }
  }
  throw new Error("Could not allocate a unique wallet label.")
}

/**
 * Stable local-only labels for selection surfaces.
 *
 * New registry writes are unique, but older browser records or concurrent tabs
 * can still contain duplicate labels. Ordinals keep those records selectable
 * without exposing opaque wallet IDs or provider credentials.
 */
export function getWalletDisplayLabels(
  wallets: readonly WalletDescriptor[]
): Map<string, string> {
  const groups = new Map<string, WalletDescriptor[]>()
  for (const wallet of wallets) {
    const label = normalizeWalletLabel(wallet.label) || "Wallet"
    const key = getWalletLabelComparisonKey(label)
    const group = groups.get(key) ?? []
    group.push(wallet)
    groups.set(key, group)
  }

  const labels = new Map<string, string>()
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    for (const [index, wallet] of group.entries()) {
      const label = normalizeWalletLabel(wallet.label) || "Wallet"
      labels.set(
        wallet.id,
        group.length === 1
          ? label
          : `${label} (${index + 1} of ${group.length})`
      )
    }
  }
  return labels
}

/**
 * Resolve an exact local wallet instance for a payment retry.
 *
 * Deliberately does not fall back to a default or first eligible wallet. A
 * missing, removed, wrong-network, or incompatible instance requires a new
 * explicit buyer selection.
 */
export function resolveWalletPaymentInstance(
  wallets: readonly WalletDescriptor[],
  input: {
    walletId: string | null | undefined
    providerId: WalletProviderId | null | undefined
    network: WalletNetwork
  }
): WalletDescriptor | null {
  if (!input.walletId || !input.providerId) return null
  return (
    wallets.find(
      (wallet) =>
        wallet.id === input.walletId &&
        wallet.providerId === input.providerId &&
        wallet.network === input.network &&
        wallet.capabilities.includes("pay_invoice")
    ) ?? null
  )
}

export function getWalletDefaultUpdates(
  wallets: readonly WalletDescriptor[],
  input: SetWalletDefaultInput
): WalletDescriptor[] {
  const selected = wallets.find((wallet) => wallet.id === input.walletId)
  if (!selected) {
    throw new Error("Wallet not found.")
  }
  if (!selected.capabilities.includes(input.intent)) {
    throw new Error(`Wallet does not support ${input.intent}.`)
  }

  return wallets
    .filter((wallet) => wallet.network === selected.network)
    .flatMap((wallet) => {
      const defaultIntents: WalletDefaultIntent[] =
        wallet.id === input.walletId
          ? [...new Set([...wallet.defaultIntents, input.intent])]
          : wallet.defaultIntents.filter(
              (currentIntent) => currentIntent !== input.intent
            )
      if (
        defaultIntents.length === wallet.defaultIntents.length &&
        defaultIntents.every(
          (current, index) => current === wallet.defaultIntents[index]
        )
      ) {
        return []
      }
      return [
        {
          ...wallet,
          defaultIntents,
          updatedAt: input.updatedAt,
        },
      ]
    })
}

/**
 * Selects a deterministic replacement only when the current, network-scoped
 * rows no longer contain a default for the requested intent.
 */
export function getWalletDefaultReplacement(
  wallets: readonly WalletDescriptor[],
  input: GetWalletDefaultReplacementInput
): WalletDescriptor | null {
  const eligible = wallets.filter(
    (wallet) =>
      wallet.network === input.network &&
      wallet.capabilities.includes(input.intent)
  )
  if (eligible.some((wallet) => wallet.defaultIntents.includes(input.intent))) {
    return null
  }
  return (
    eligible
      .slice()
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )[0] ?? null
  )
}

export class WalletRegistry {
  readonly #store: WalletRegistryStore
  readonly #createId: () => string
  readonly #now: () => number

  constructor(store: WalletRegistryStore, options: WalletRegistryOptions = {}) {
    this.#store = store
    this.#createId = options.createId ?? (() => crypto.randomUUID())
    this.#now = options.now ?? Date.now
  }

  async list(): Promise<WalletDescriptor[]> {
    const wallets = await this.#store.list()
    return wallets
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async add(input: AddWalletInput): Promise<WalletDescriptor> {
    const now = this.#now()
    const existingWallets = await this.#store.list()
    const id = input.id ?? this.#createId()
    if (!id || existingWallets.some((wallet) => wallet.id === id)) {
      throw new Error("Wallet ID is invalid or already registered.")
    }
    const wallet: WalletDescriptor = {
      id,
      kind: input.kind,
      providerId: input.providerId,
      label: getAvailableWalletLabel(existingWallets, input.label),
      network: input.network,
      capabilities: [...new Set(input.capabilities)],
      status: "registered",
      defaultIntents: [],
      createdAt: now,
      updatedAt: now,
    }

    await this.#store.put(wallet)
    return wallet
  }

  async updateLabel(
    walletId: string,
    requestedLabel: string
  ): Promise<WalletDescriptor> {
    const wallets = await this.#store.list()
    const wallet = wallets.find((candidate) => candidate.id === walletId)
    if (!wallet) {
      throw new Error("Wallet not found.")
    }
    const updated = {
      ...wallet,
      label: getAvailableWalletLabel(wallets, requestedLabel, walletId),
      updatedAt: this.#now(),
    }
    await this.#store.put(updated)
    return updated
  }

  async remove(walletId: string): Promise<void> {
    await this.#store.delete(walletId)
  }

  async setDefault(
    walletId: string,
    intent: WalletDefaultIntent
  ): Promise<void> {
    await this.#store.setDefault({
      walletId,
      intent,
      updatedAt: this.#now(),
    })
  }

  async listEligible(
    input: ListEligibleWalletsInput
  ): Promise<WalletDescriptor[]> {
    const wallets = await this.list()
    return wallets
      .filter(
        (wallet) =>
          wallet.network === input.network &&
          wallet.capabilities.includes(input.capability)
      )
      .sort((a, b) => {
        const aDefault = a.defaultIntents.includes("pay_invoice") ? 0 : 1
        const bDefault = b.defaultIntents.includes("pay_invoice") ? 0 : 1
        return aDefault - bDefault
      })
  }
}

export * from "./provider"
