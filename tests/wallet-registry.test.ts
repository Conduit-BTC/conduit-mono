import { describe, expect, it } from "bun:test"

import {
  getWalletDefaultReplacement,
  getWalletDefaultUpdates,
  getWalletDisplayLabels,
  getWalletNetworkFromLightningConfig,
  isWalletNetwork,
  resolveWalletPaymentInstance,
  WalletRegistry,
  type SetWalletDefaultInput,
  type WalletDefaultIntent,
  type WalletDescriptor,
  type WalletRegistryStore,
} from "@conduit/core"

function createMemoryStore(): WalletRegistryStore {
  const rows = new Map<string, WalletDescriptor>()

  return {
    async list() {
      return [...rows.values()]
    },
    async put(wallet) {
      rows.set(wallet.id, wallet)
    },
    async setDefault(input) {
      for (const wallet of getWalletDefaultUpdates([...rows.values()], input)) {
        rows.set(wallet.id, wallet)
      }
    },
    async delete(id) {
      rows.delete(id)
    },
  }
}

class InterleavingDefaultStore implements WalletRegistryStore {
  readonly #rows = new Map<string, WalletDescriptor>()
  #readBarrier: Promise<void> | null = null
  #releaseReadBarrier: (() => void) | null = null
  #barrierReaders = 0
  #atomicTail = Promise.resolve()

  armInterleavingReads(): void {
    this.#barrierReaders = 0
    this.#readBarrier = new Promise((resolve) => {
      this.#releaseReadBarrier = resolve
    })
  }

  releaseInterleavingReads(): void {
    this.#releaseReadBarrier?.()
    this.#readBarrier = null
    this.#releaseReadBarrier = null
  }

  async list(): Promise<WalletDescriptor[]> {
    const snapshot = [...this.#rows.values()]
    const barrier = this.#readBarrier
    if (barrier) {
      this.#barrierReaders += 1
      if (this.#barrierReaders === 2) {
        this.#releaseReadBarrier?.()
      }
      await barrier
    }
    return snapshot
  }

  async put(wallet: WalletDescriptor): Promise<void> {
    this.#rows.set(wallet.id, wallet)
  }

  async delete(id: string): Promise<void> {
    this.#rows.delete(id)
  }

  async setDefault(input: SetWalletDefaultInput): Promise<void> {
    const operation = this.#atomicTail.then(() => {
      for (const wallet of getWalletDefaultUpdates(
        [...this.#rows.values()],
        input
      )) {
        this.#rows.set(wallet.id, wallet)
      }
    })
    this.#atomicTail = operation.catch(() => undefined)
    await operation
  }
}

describe("WalletRegistry", () => {
  it("shares canonical wallet network validation and config mapping", () => {
    expect(
      ["mainnet", "testnet", "signet", "regtest"].every(isWalletNetwork)
    ).toBe(true)
    expect(isWalletNetwork("mock")).toBe(false)
    expect(isWalletNetwork(undefined)).toBe(false)
    expect(getWalletNetworkFromLightningConfig("mainnet")).toBe("mainnet")
    expect(getWalletNetworkFromLightningConfig("signet")).toBe("signet")
    expect(getWalletNetworkFromLightningConfig("testnet")).toBe("testnet")
    expect(getWalletNetworkFromLightningConfig("mock")).toBe("regtest")
  })

  it("keeps multiple wallet instances distinct from their provider", async () => {
    const ids = ["wallet-personal", "wallet-spending", "wallet-zeus"]
    const registry = new WalletRegistry(createMemoryStore(), {
      createId: () => ids.shift()!,
      now: () => 1_700_000_000_000,
    })

    await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "Personal",
      network: "mainnet",
      capabilities: ["pay_invoice", "receive", "balance"],
    })
    await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "Spending",
      network: "mainnet",
      capabilities: ["pay_invoice", "receive", "balance"],
    })
    await registry.add({
      kind: "connected",
      providerId: "nwc",
      label: "Zeus",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })

    await expect(registry.list()).resolves.toMatchObject([
      {
        id: "wallet-personal",
        kind: "portable",
        providerId: "spark",
        label: "Personal",
      },
      {
        id: "wallet-spending",
        kind: "portable",
        providerId: "spark",
        label: "Spending",
      },
      {
        id: "wallet-zeus",
        kind: "connected",
        providerId: "nwc",
        label: "Zeus",
      },
    ])
  })

  it("accepts one preallocated credential-bound ID and rejects reuse", async () => {
    const registry = new WalletRegistry(createMemoryStore(), {
      createId: () => "registry-generated-id",
      now: () => 1_700_000_000_000,
    })
    const input = {
      id: "preallocated-spark-id",
      kind: "portable" as const,
      providerId: "spark",
      label: "Portable",
      network: "mainnet" as const,
      capabilities: ["pay_invoice" as const],
    }

    await expect(registry.add(input)).resolves.toMatchObject({
      id: "preallocated-spark-id",
      providerId: "spark",
    })
    await expect(registry.add(input)).rejects.toThrow(
      "Wallet ID is invalid or already registered."
    )
  })

  it("keeps one eligible default per network and intent", async () => {
    const ids = ["wallet-personal", "wallet-spending", "wallet-signet"]
    const registry = new WalletRegistry(createMemoryStore(), {
      createId: () => ids.shift()!,
      now: () => 1_700_000_000_000,
    })

    await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "Personal",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })
    const spending = await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "Spending",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })
    await registry.add({
      kind: "connected",
      providerId: "nwc",
      label: "Signet",
      network: "signet",
      capabilities: ["pay_invoice"],
    })

    await registry.setDefault(spending.id, "pay_invoice")

    await expect(
      registry.listEligible({
        network: "mainnet",
        capability: "pay_invoice",
      })
    ).resolves.toMatchObject([
      { id: "wallet-spending", defaultIntents: ["pay_invoice"] },
      { id: "wallet-personal", defaultIntents: [] },
    ])
  })

  it("keeps concurrent default changes atomic across registry instances", async () => {
    const store = new InterleavingDefaultStore()
    await store.put({
      id: "wallet-personal",
      kind: "portable",
      providerId: "spark",
      label: "Personal",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "ready",
      defaultIntents: [],
      createdAt: 1,
      updatedAt: 1,
    })
    await store.put({
      id: "wallet-zeus",
      kind: "connected",
      providerId: "nwc",
      label: "Zeus",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "ready",
      defaultIntents: [],
      createdAt: 2,
      updatedAt: 2,
    })
    const firstRegistry = new WalletRegistry(store, { now: () => 3 })
    const secondRegistry = new WalletRegistry(store, { now: () => 4 })

    store.armInterleavingReads()
    await Promise.all([
      firstRegistry.setDefault("wallet-personal", "pay_invoice"),
      secondRegistry.setDefault("wallet-zeus", "pay_invoice"),
    ])
    store.releaseInterleavingReads()

    const defaults = (await firstRegistry.list()).filter((wallet) =>
      wallet.defaultIntents.includes("pay_invoice")
    )
    expect(defaults).toMatchObject([
      {
        id: "wallet-zeus",
        providerId: "nwc",
        defaultIntents: ["pay_invoice"],
      },
    ])
  })

  it("changes only the selected default intent", async () => {
    const store = createMemoryStore()
    const registry = new WalletRegistry(store, {
      createId: () => "wallet-new-default",
      now: () => 1_700_000_000_000,
    })
    await store.put({
      id: "wallet-existing",
      kind: "portable",
      providerId: "spark",
      label: "Existing",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "ready",
      defaultIntents: ["pay_invoice", "future_intent" as WalletDefaultIntent],
      createdAt: 1,
      updatedAt: 1,
    })
    const replacement = await registry.add({
      kind: "connected",
      providerId: "nwc",
      label: "Replacement",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })

    await registry.setDefault(replacement.id, "pay_invoice")

    await expect(registry.list()).resolves.toMatchObject([
      {
        id: "wallet-existing",
        defaultIntents: ["future_intent"],
      },
      {
        id: "wallet-new-default",
        defaultIntents: ["pay_invoice"],
      },
    ])
  })

  it("repairs a default from current rows when the removed wallet became default during cleanup", () => {
    const beforeCleanup: WalletDescriptor[] = [
      {
        id: "wallet-removed",
        kind: "portable",
        providerId: "spark",
        label: "Removed",
        network: "mainnet",
        capabilities: ["pay_invoice"],
        status: "ready",
        defaultIntents: [],
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: "wallet-zeus",
        kind: "connected",
        providerId: "nwc",
        label: "Zeus",
        network: "mainnet",
        capabilities: ["pay_invoice"],
        status: "ready",
        defaultIntents: ["pay_invoice"],
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "wallet-blink",
        kind: "connected",
        providerId: "nwc",
        label: "Blink",
        network: "mainnet",
        capabilities: ["pay_invoice"],
        status: "ready",
        defaultIntents: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const afterConcurrentDefault = applyDefaultUpdates(
      beforeCleanup,
      getWalletDefaultUpdates(beforeCleanup, {
        walletId: "wallet-removed",
        intent: "pay_invoice",
        updatedAt: 4,
      })
    )
    const currentRows = afterConcurrentDefault.filter(
      (wallet) => wallet.id !== "wallet-removed"
    )

    expect(
      getWalletDefaultReplacement(currentRows, {
        network: "mainnet",
        intent: "pay_invoice",
      })
    ).toMatchObject({ id: "wallet-blink" })
  })

  it("allocates case- and whitespace-insensitive unique labels", async () => {
    const ids = ["wallet-personal", "wallet-personal-2", "wallet-personal-3"]
    const registry = new WalletRegistry(createMemoryStore(), {
      createId: () => ids.shift()!,
      now: () => 1_700_000_000_000,
    })

    const first = await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "  Personal   wallet  ",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })
    const second = await registry.add({
      kind: "connected",
      providerId: "nwc",
      label: "personal wallet",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })
    const third = await registry.add({
      kind: "portable",
      providerId: "future",
      label: "PERSONAL WALLET",
      network: "regtest",
      capabilities: ["pay_invoice"],
    })

    expect([first.label, second.label, third.label]).toEqual([
      "Personal wallet",
      "personal wallet (2)",
      "PERSONAL WALLET (3)",
    ])
  })

  it("keeps renamed wallets unique without conflicting with their current label", async () => {
    const ids = ["wallet-primary", "wallet-secondary"]
    const registry = new WalletRegistry(createMemoryStore(), {
      createId: () => ids.shift()!,
      now: () => 1_700_000_000_000,
    })
    const primary = await registry.add({
      kind: "portable",
      providerId: "spark",
      label: "Primary",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })
    const secondary = await registry.add({
      kind: "connected",
      providerId: "nwc",
      label: "Secondary",
      network: "mainnet",
      capabilities: ["pay_invoice"],
    })

    await expect(
      registry.updateLabel(secondary.id, " primary ")
    ).resolves.toMatchObject({
      id: secondary.id,
      label: "primary (2)",
    })
    await expect(
      registry.updateLabel(primary.id, " Primary ")
    ).resolves.toMatchObject({
      id: primary.id,
      label: "Primary",
    })
  })

  it("disambiguates legacy duplicate labels without exposing wallet ids", () => {
    const labels = getWalletDisplayLabels([
      {
        id: "opaque-wallet-a",
        kind: "portable",
        providerId: "spark",
        label: "Personal",
        network: "mainnet",
        capabilities: ["pay_invoice"],
        status: "registered",
        defaultIntents: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "opaque-wallet-b",
        kind: "connected",
        providerId: "nwc",
        label: " personal ",
        network: "mainnet",
        capabilities: ["pay_invoice"],
        status: "registered",
        defaultIntents: [],
        createdAt: 2,
        updatedAt: 2,
      },
    ])

    expect(labels.get("opaque-wallet-a")).toBe("Personal (1 of 2)")
    expect(labels.get("opaque-wallet-b")).toBe("personal (2 of 2)")
    expect([...labels.values()].join(" ")).not.toContain("opaque-wallet")
  })
})

function applyDefaultUpdates(
  wallets: WalletDescriptor[],
  updates: WalletDescriptor[]
): WalletDescriptor[] {
  const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]))
  for (const update of updates) {
    byId.set(update.id, update)
  }
  return [...byId.values()]
}

describe("resolveWalletPaymentInstance", () => {
  const wallets: WalletDescriptor[] = [
    {
      id: "wallet-default",
      kind: "portable",
      providerId: "spark",
      label: "Default",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "ready",
      defaultIntents: ["pay_invoice"],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "wallet-order",
      kind: "connected",
      providerId: "nwc",
      label: "Order wallet",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "ready",
      defaultIntents: [],
      createdAt: 2,
      updatedAt: 2,
    },
  ]

  it("resolves the exact stored instance without falling back to the default", () => {
    expect(
      resolveWalletPaymentInstance(wallets, {
        walletId: "wallet-order",
        providerId: "nwc",
        network: "mainnet",
      })
    ).toMatchObject({ id: "wallet-order", providerId: "nwc" })

    expect(
      resolveWalletPaymentInstance(wallets, {
        walletId: "wallet-missing",
        providerId: "nwc",
        network: "mainnet",
      })
    ).toBeNull()
    expect(
      resolveWalletPaymentInstance(wallets, {
        walletId: null,
        providerId: null,
        network: "mainnet",
      })
    ).toBeNull()
  })

  it("rejects a stored instance on the wrong network or without invoice support", () => {
    expect(
      resolveWalletPaymentInstance(wallets, {
        walletId: "wallet-order",
        providerId: "nwc",
        network: "regtest",
      })
    ).toBeNull()
    expect(
      resolveWalletPaymentInstance(
        [
          {
            ...wallets[1]!,
            capabilities: ["receive"],
          },
        ],
        {
          walletId: "wallet-order",
          providerId: "nwc",
          network: "mainnet",
        }
      )
    ).toBeNull()
  })

  it("rejects a reused instance ID when the provider no longer matches", () => {
    expect(
      resolveWalletPaymentInstance(wallets, {
        walletId: "wallet-order",
        providerId: "spark",
        network: "mainnet",
      })
    ).toBeNull()
  })
})
