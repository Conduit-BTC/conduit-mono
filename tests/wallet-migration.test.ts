import { describe, expect, it } from "bun:test"

import {
  getNwcUriFingerprint,
  getWalletDefaultUpdates,
  WalletRegistry,
  type SetWalletDefaultInput,
  type WalletDescriptor,
  type WalletRegistryStore,
} from "@conduit/core"
import {
  migrateLegacyNwcWallet,
  type NwcCredentialStore,
} from "@conduit/core/wallets/wallet-migration"

const VALID_NWC_URI =
  "nostr+walletconnect://" +
  "a".repeat(64) +
  "?relay=wss%3A%2F%2Fwallet.example&secret=" +
  "b".repeat(64)

function createMemoryStore(): WalletRegistryStore &
  NwcCredentialStore & {
    listVisible(ownerPubkey: string | null): Promise<WalletDescriptor[]>
  } {
  const wallets = new Map<string, WalletDescriptor>()
  const credentials = new Map<string, string>()

  return {
    async list() {
      return [...wallets.values()]
    },
    async listVisible() {
      return [...wallets.values()]
    },
    async put(wallet) {
      wallets.set(wallet.id, wallet)
    },
    async setDefault(input) {
      for (const wallet of getWalletDefaultUpdates(
        [...wallets.values()],
        input
      )) {
        wallets.set(wallet.id, wallet)
      }
    },
    async delete(id) {
      wallets.delete(id)
    },
    async findWalletIdsByUri(uri) {
      const fingerprint = getNwcUriFingerprint(uri)
      return [...credentials.entries()].flatMap(([walletId, savedUri]) =>
        getNwcUriFingerprint(savedUri) === fingerprint ? [walletId] : []
      )
    },
    async putNwcCredential(walletId, uri) {
      credentials.set(walletId, uri)
    },
    async getNwcCredential(walletId) {
      return credentials.get(walletId) ?? null
    },
    async deleteNwcCredential(walletId) {
      credentials.delete(walletId)
    },
    async transaction(operation) {
      const walletSnapshot = new Map(wallets)
      const credentialSnapshot = new Map(credentials)
      try {
        return await operation()
      } catch (error) {
        wallets.clear()
        credentials.clear()
        for (const [id, wallet] of walletSnapshot) wallets.set(id, wallet)
        for (const [id, uri] of credentialSnapshot) credentials.set(id, uri)
        throw error
      }
    },
  }
}

class InterleavingMigrationStore
  implements WalletRegistryStore, NwcCredentialStore
{
  readonly #wallets = new Map<string, WalletDescriptor>()
  readonly #credentials = new Map<string, string>()
  #transactionTail = Promise.resolve()
  #activeTransaction = false
  #outsideReadCount = 0
  #releaseOutsideReads: () => void = () => undefined
  #outsideReadBarrier = new Promise<void>((resolve) => {
    this.#releaseOutsideReads = resolve
  })

  async list(): Promise<WalletDescriptor[]> {
    return [...this.#wallets.values()]
  }

  async put(wallet: WalletDescriptor): Promise<void> {
    this.#wallets.set(wallet.id, wallet)
  }

  async setDefault(input: SetWalletDefaultInput): Promise<void> {
    for (const wallet of getWalletDefaultUpdates(
      [...this.#wallets.values()],
      input
    )) {
      this.#wallets.set(wallet.id, wallet)
    }
  }

  async delete(id: string): Promise<void> {
    this.#wallets.delete(id)
  }

  async findWalletIdsByUri(uri: string): Promise<string[]> {
    const fingerprint = getNwcUriFingerprint(uri)
    const result = [...this.#credentials.entries()].flatMap(
      ([walletId, savedUri]) =>
        getNwcUriFingerprint(savedUri) === fingerprint ? [walletId] : []
    )

    if (!this.#activeTransaction) {
      this.#outsideReadCount += 1
      if (this.#outsideReadCount === 2) {
        this.#releaseOutsideReads()
      }
      await this.#outsideReadBarrier
    }
    return result
  }

  async putNwcCredential(walletId: string, uri: string): Promise<void> {
    this.#credentials.set(walletId, uri)
  }

  async getNwcCredential(walletId: string): Promise<string | null> {
    return this.#credentials.get(walletId) ?? null
  }

  async deleteNwcCredential(walletId: string): Promise<void> {
    this.#credentials.delete(walletId)
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#transactionTail.then(async () => {
      const walletSnapshot = new Map(this.#wallets)
      const credentialSnapshot = new Map(this.#credentials)
      this.#activeTransaction = true
      try {
        return await operation()
      } catch (error) {
        this.#wallets.clear()
        this.#credentials.clear()
        for (const [id, wallet] of walletSnapshot) {
          this.#wallets.set(id, wallet)
        }
        for (const [id, uri] of credentialSnapshot) {
          this.#credentials.set(id, uri)
        }
        throw error
      } finally {
        this.#activeTransaction = false
      }
    })
    this.#transactionTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

describe("legacy NWC wallet migration", () => {
  it("verifies the new wallet and credential before removing legacy storage", async () => {
    const values = new Map<string, string>([
      [
        "conduit:buyer-wallet-nwc",
        JSON.stringify({
          uri: VALID_NWC_URI,
        }),
      ],
      [
        "conduit:buyer-wallet-nwc-capability",
        JSON.stringify({
          walletPubkey: "a".repeat(64),
          info: {
            alias: "Zeus",
            network: "mainnet",
            methods: ["pay_invoice", "get_balance"],
          },
          status: "pay-capable",
          checkedAt: 1_700_000_000_000,
        }),
      ],
    ])
    const legacyStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
    const store = createMemoryStore()
    const registry = new WalletRegistry(store, {
      createId: () => "wallet-zeus",
      now: () => 1_700_000_000_001,
    })

    await expect(
      migrateLegacyNwcWallet({
        legacyStorage,
        registry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      })
    ).resolves.toMatchObject({
      status: "migrated",
      wallet: {
        id: "wallet-zeus",
        kind: "connected",
        providerId: "nwc",
        label: "Zeus",
        capabilities: ["pay_invoice", "balance"],
        defaultIntents: ["pay_invoice"],
      },
    })

    expect(await store.getNwcCredential("wallet-zeus")).toBe(VALID_NWC_URI)
    expect(values.has("conduit:buyer-wallet-nwc")).toBeFalse()
    expect(values.has("conduit:buyer-wallet-nwc-capability")).toBeFalse()
  })

  it("keeps invalid legacy data untouched for safe manual recovery", async () => {
    const values = new Map<string, string>([
      ["conduit:buyer-wallet-nwc", '{"uri":"not-an-nwc-uri"}'],
    ])
    const store = createMemoryStore()
    const registry = new WalletRegistry(store)

    await expect(
      migrateLegacyNwcWallet({
        legacyStorage: {
          getItem: (key) => values.get(key) ?? null,
          removeItem: (key) => {
            values.delete(key)
          },
        },
        registry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      })
    ).resolves.toEqual({ status: "invalid" })

    expect(values.has("conduit:buyer-wallet-nwc")).toBeTrue()
    expect(await registry.list()).toEqual([])
  })

  it("fails closed when a legacy credential points at a non-NWC wallet", async () => {
    const values = new Map<string, string>([
      ["conduit:buyer-wallet-nwc", JSON.stringify({ uri: VALID_NWC_URI })],
    ])
    const store = createMemoryStore()
    await store.put({
      id: "wrong-wallet",
      kind: "portable",
      providerId: "spark",
      label: "Wrong wallet",
      network: "mainnet",
      capabilities: ["pay_invoice"],
      status: "registered",
      defaultIntents: [],
      createdAt: 1,
      updatedAt: 1,
    })
    await store.putNwcCredential("wrong-wallet", VALID_NWC_URI)
    const registry = new WalletRegistry(store)

    await expect(
      migrateLegacyNwcWallet({
        legacyStorage: {
          getItem: (key) => values.get(key) ?? null,
          removeItem: (key) => {
            values.delete(key)
          },
        },
        registry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      })
    ).rejects.toThrow("Connected Wallet registration is inconsistent.")

    expect(await store.getNwcCredential("wrong-wallet")).toBe(VALID_NWC_URI)
    expect(values.has("conduit:buyer-wallet-nwc")).toBeTrue()
  })

  it("creates one connected wallet when two tabs migrate the same legacy URI", async () => {
    const values = new Map<string, string>([
      ["conduit:buyer-wallet-nwc", JSON.stringify({ uri: VALID_NWC_URI })],
    ])
    const legacyStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
    const store = new InterleavingMigrationStore()
    const firstRegistry = new WalletRegistry(store, {
      createId: () => "wallet-tab-a",
      now: () => 1,
    })
    const secondRegistry = new WalletRegistry(store, {
      createId: () => "wallet-tab-b",
      now: () => 2,
    })

    const results = await Promise.all([
      migrateLegacyNwcWallet({
        legacyStorage,
        registry: firstRegistry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      }),
      migrateLegacyNwcWallet({
        legacyStorage,
        registry: secondRegistry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_migrated",
      "migrated",
    ])
    await expect(firstRegistry.list()).resolves.toHaveLength(1)
    expect(new Set(results.map((result) => result.wallet.id))).toEqual(
      new Set(["wallet-tab-a"])
    )
    expect(values.has("conduit:buyer-wallet-nwc")).toBeFalse()
  })

  it("rolls back the descriptor and keeps legacy data when verification fails", async () => {
    const values = new Map<string, string>([
      ["conduit:buyer-wallet-nwc", JSON.stringify({ uri: VALID_NWC_URI })],
    ])
    const store = createMemoryStore()
    store.getNwcCredential = async () => null
    store.delete = async () => {
      throw new Error("descriptor cleanup unavailable")
    }
    store.deleteNwcCredential = async () => {
      throw new Error("credential cleanup unavailable")
    }
    const registry = new WalletRegistry(store, {
      createId: () => "wallet-rollback",
    })

    await expect(
      migrateLegacyNwcWallet({
        legacyStorage: {
          getItem: (key) => values.get(key) ?? null,
          removeItem: (key) => {
            values.delete(key)
          },
        },
        registry,
        credentialStore: store,
        fallbackNetwork: "mainnet",
      })
    ).rejects.toThrow("Connected Wallet credential verification failed.")

    expect(await registry.list()).toEqual([])
    expect(await store.findWalletIdsByUri(VALID_NWC_URI)).toEqual([])
    expect(values.has("conduit:buyer-wallet-nwc")).toBeTrue()
  })
})
