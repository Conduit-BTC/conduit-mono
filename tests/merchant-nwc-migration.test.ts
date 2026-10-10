import { describe, expect, it } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"
import {
  migrateAccountNwcConnection,
  type NwcCredentialStore,
  type NwcWalletRegistration,
} from "../packages/core/src/wallets/wallet-migration"
import { registerNwcWalletAtomically } from "../packages/core/src/wallets/wallet-storage"

const uri =
  "nostr+walletconnect://" +
  "a".repeat(64) +
  "?relay=wss%3A%2F%2Fwallet.example&secret=" +
  "b".repeat(64)
function fixture() {
  const wallets = new Map<string, WalletDescriptor>()
  const credentials = new Map<string, string>()
  let legacy: string | null = uri
  let current = true
  let readBack = true
  let retired = 0
  let rejectRetirementCommit = false
  const store: NwcCredentialStore = {
    async transaction(operation) {
      const savedWallets = new Map(wallets)
      const savedCredentials = new Map(credentials)
      try {
        const result = await operation()
        if (rejectRetirementCommit && retired)
          throw new Error("Retirement commit failed")
        return result
      } catch (error) {
        wallets.clear()
        credentials.clear()
        for (const [id, wallet] of savedWallets) wallets.set(id, wallet)
        for (const [id, credential] of savedCredentials)
          credentials.set(id, credential)
        throw error
      }
    },
    async findWalletIdsByUri(value) {
      return [...credentials]
        .filter(([, credential]) => credential === value)
        .map(([id]) => id)
    },
    async putNwcCredential(id, value) {
      credentials.set(id, value)
    },
    async getNwcCredential(id) {
      return readBack ? (credentials.get(id) ?? null) : null
    },
    async deleteNwcCredential(id) {
      credentials.delete(id)
    },
  }
  const connect = async (
    onRegistered?: (registration: NwcWalletRegistration) => void
  ) => {
    const result = await registerNwcWalletAtomically({
      store,
      uri,
      listWallets: async () => [...wallets.values()],
      shouldContinue: () => current && legacy === uri,
      register: async () => {
        const wallet: WalletDescriptor = {
          id: "shared",
          providerId: "nwc",
          kind: "connected",
          label: "Connected wallet",
          network: "mainnet",
          capabilities: ["pay_invoice"],
          defaultIntents: [],
          status: "registered",
          createdAt: 1,
          updatedAt: 1,
        }
        wallets.set(wallet.id, wallet)
        return wallet
      },
      ensureDefault: async () => {},
    })
    onRegistered?.(result)
    return result.wallet
  }
  const migrate = (customConnect = connect) =>
    migrateAccountNwcConnection({
      uri,
      connect: customConnect,
      credentialStore: store,
      registry: {
        list: async () => [...wallets.values()],
        remove: async (id) => {
          wallets.delete(id)
        },
      },
      shouldContinue: () => current && legacy === uri,
      retireLegacy: () => {
        if (!current || legacy !== uri) return false
        legacy = null
        retired++
        return true
      },
    })
  return {
    wallets,
    credentials,
    connect,
    migrate,
    setCurrent: (value: boolean) => {
      current = value
    },
    replaceLegacy: () => {
      legacy = "replacement"
    },
    rejectRetirementCommit: () => {
      rejectRetirementCommit = true
    },
    failReadBack: () => {
      readBack = false
    },
    snapshot: () => ({ legacy: legacy !== null, retired }),
  }
}
describe("Merchant legacy NWC to shared-wallet migration", () => {
  it("rolls back atomic registration when account authority changes before commit", async () => {
    const f = fixture()
    let current = true
    await expect(
      registerNwcWalletAtomically({
        store: {
          async transaction(operation) {
            try {
              return await operation()
            } catch (error) {
              f.wallets.clear()
              f.credentials.clear()
              throw error
            }
          },
          async findWalletIdsByUri() {
            return []
          },
          async putNwcCredential(id, value) {
            f.credentials.set(id, value)
          },
          async getNwcCredential(id) {
            return f.credentials.get(id) ?? null
          },
          async deleteNwcCredential(id) {
            f.credentials.delete(id)
          },
        },
        uri,
        shouldContinue: () => current,
        listWallets: async () => [...f.wallets.values()],
        register: async () => {
          const wallet = await f.connect()
          return wallet
        },
        ensureDefault: async () => {
          current = false
        },
      })
    ).rejects.toThrow("sign-in changed")
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
  it("retires the legacy owner only after atomic registration and exact credential read-back", async () => {
    const f = fixture()
    expect(await f.migrate()).toBe(true)
    expect(f.snapshot()).toEqual({ legacy: false, retired: 1 })
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
    f.wallets.clear()
    f.credentials.clear()
    expect(await f.migrate()).toBe(false)
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
  })
  it("preserves the legacy connection and rolls back shared registration when read-back fails", async () => {
    const f = fixture()
    f.failReadBack()
    await expect(f.migrate()).rejects.toThrow("verification")
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
  })
  it("does not retire legacy state when registration fails", async () => {
    const f = fixture()
    await expect(
      f.migrate(async () => {
        throw new Error("Registration failed")
      })
    ).rejects.toThrow("Registration failed")
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
  for (const change of ["account", "credential"] as const) {
    it(`fences ${change} replacement during asynchronous migration`, async () => {
      const f = fixture()
      expect(
        await f.migrate(async (onRegistered) => {
          const wallet = await f.connect(onRegistered)
          if (change === "account") f.setCurrent(false)
          else f.replaceLegacy()
          return wallet
        })
      ).toBe(false)
      expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
      expect(f.wallets.size).toBe(0)
      expect(f.credentials.size).toBe(0)
    })
  }
  it("compensates a new copy when authority changes before connect returns", async () => {
    const f = fixture()
    await expect(
      f.migrate(async (onRegistered) => {
        await f.connect(onRegistered)
        f.setCurrent(false)
        throw new Error("Wallet sign-in changed.")
      })
    ).rejects.toThrow("sign-in changed")
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
  it("preserves a pre-existing deduplicated wallet when authority changes after connect", async () => {
    const f = fixture()
    await f.connect()
    expect(
      await f.migrate(async (onRegistered) => {
        const wallet = await f.connect(onRegistered)
        f.setCurrent(false)
        return wallet
      })
    ).toBe(false)
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
  it("retains the durable shared copy if retirement has occurred before read-back commit fails", async () => {
    const f = fixture()
    f.rejectRetirementCommit()
    await expect(f.migrate()).rejects.toThrow("Retirement commit failed")
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
    expect(f.snapshot()).toEqual({ legacy: false, retired: 1 })
  })
  it("checks existing shared registration again before retiring its legacy copy", async () => {
    const f = fixture()
    await f.connect()
    f.failReadBack()
    await expect(f.migrate()).rejects.toThrow("verification")
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
})
