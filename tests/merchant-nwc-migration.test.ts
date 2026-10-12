import { randomBytes } from "node:crypto"
import { describe, expect, it, spyOn } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"
import {
  migrateAccountNwcConnection,
  type LegacyNwcRetirement,
  type NwcCredentialStore,
  type NwcWalletRegistration,
} from "../packages/core/src/wallets/wallet-migration"
import { registerNwcWalletAtomically } from "../packages/core/src/wallets/wallet-storage"
import { retireAccountNwcUri } from "../apps/merchant/src/lib/nwc-retirement"
import { NWC_URI_STORAGE_KEY } from "../apps/merchant/src/lib/readiness"

function fixture() {
  const uri =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Fwallet.example&secret=" +
    randomBytes(32).toString("hex")
  const wallets = new Map<string, WalletDescriptor>()
  const credentials = new Map<string, string>()
  const accountStorageKey = `${NWC_URI_STORAGE_KEY}:merchant-account`
  let legacy: string | null = uri
  let unscopedLegacy: string | null = uri
  let currentAccountStorageKey: string | null = accountStorageKey
  let current = true
  let readBack = true
  let retired = 0
  let rejectRetirementCommit = false
  let notificationFails = false
  let notifications = 0
  let storageFailure:
    | "account_read"
    | "unscoped_read"
    | "unscoped_remove_before"
    | "unscoped_remove_after"
    | "account_remove_before"
    | "account_remove_after"
    | "replace_account_during_unscoped_remove"
    | null = null
  const legacyStorage = {
    getItem(key: string) {
      if (key === accountStorageKey) {
        if (storageFailure === "account_read")
          throw new Error("Account read failed")
        return legacy
      }
      if (key === NWC_URI_STORAGE_KEY) {
        if (storageFailure === "unscoped_read")
          throw new Error("Unscoped read failed")
        return unscopedLegacy
      }
      return null
    },
    removeItem(key: string) {
      if (key === accountStorageKey) {
        if (storageFailure === "account_remove_before")
          throw new Error("Account removal failed")
        legacy = null
        if (storageFailure === "account_remove_after")
          throw new Error("Account removal failed after mutation")
      }
      if (key === NWC_URI_STORAGE_KEY) {
        if (storageFailure === "unscoped_remove_before")
          throw new Error("Unscoped removal failed")
        unscopedLegacy = null
        if (storageFailure === "replace_account_during_unscoped_remove")
          legacy = "replacement"
        if (storageFailure === "unscoped_remove_after")
          throw new Error("Unscoped removal failed after mutation")
      }
    },
  }
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
  const migrate = (
    customConnect = connect,
    customRetireLegacy?: () => LegacyNwcRetirement
  ) =>
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
      retireLegacy:
        customRetireLegacy ??
        (() => {
          const result = retireAccountNwcUri({
            storage: legacyStorage,
            accountStorageKey,
            currentAccountStorageKey: () => currentAccountStorageKey,
            expectedUri: uri,
            notifyChange: () => {
              notifications++
              if (notificationFails) throw new Error("Notification failed")
            },
          })
          if (result.status === "completed") retired++
          return result
        }),
    })
  return {
    uri,
    wallets,
    credentials,
    connect,
    migrate,
    setCurrent: (value: boolean) => {
      current = value
    },
    replaceCurrentAccountStorageKey: () => {
      currentAccountStorageKey = `${NWC_URI_STORAGE_KEY}:replacement-account`
    },
    failStorage: (failure: typeof storageFailure) => {
      storageFailure = failure
    },
    failNotification: () => {
      notificationFails = true
    },
    notificationCount: () => notifications,
    replaceLegacy: () => {
      legacy = "replacement"
    },
    replaceUnscopedLegacy: () => {
      unscopedLegacy = "another-connection"
    },
    unscopedReplacementPresent: () => unscopedLegacy === "another-connection",
    removeLegacy: () => {
      legacy = null
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
        uri: f.uri,
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
  it("retains a new shared copy when retirement throws after deleting its legacy owner", async () => {
    const f = fixture()
    await expect(
      f.migrate(f.connect, () => {
        f.removeLegacy()
        throw new Error("Retirement failed after deletion")
      })
    ).rejects.toThrow("Retirement failed after deletion")
    expect(f.snapshot().legacy).toBe(false)
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
  })
  for (const failure of [
    "account_read",
    "unscoped_read",
    "unscoped_remove_before",
    "unscoped_remove_after",
  ] as const) {
    it(`compensates when ${failure} fails before account retirement`, async () => {
      const f = fixture()
      f.failStorage(failure)
      await expect(f.migrate()).rejects.toThrow("legacy storage is unavailable")
      expect(f.snapshot().legacy).toBe(true)
      expect(f.wallets.size).toBe(0)
      expect(f.credentials.size).toBe(0)
    })
  }
  it("reports a preflight storage failure so the same session can retry", async () => {
    const f = fixture()
    f.failStorage("unscoped_read")
    await expect(f.migrate()).rejects.toThrow("legacy storage is unavailable")
    f.failStorage(null)
    expect(await f.migrate()).toBe(true)
    expect(f.snapshot().legacy).toBe(false)
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
  })
  for (const failure of [
    "account_remove_before",
    "account_remove_after",
  ] as const) {
    it(`retains the verified shared copy when ${failure} is uncertain`, async () => {
      const f = fixture()
      f.failStorage(failure)
      await expect(f.migrate()).rejects.toThrow("retirement is uncertain")
      expect(f.snapshot().legacy).toBe(failure === "account_remove_before")
      expect(f.wallets.size).toBe(1)
      expect(f.credentials.size).toBe(1)
    })
  }
  it("compensates when the mounted Merchant account key changes before retirement", async () => {
    const f = fixture()
    expect(
      await f.migrate(async (onRegistered) => {
        const wallet = await f.connect(onRegistered)
        f.replaceCurrentAccountStorageKey()
        return wallet
      })
    ).toBe(false)
    expect(f.snapshot().legacy).toBe(true)
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
  })
  it("preserves a replaced account URI during the final retirement recheck", async () => {
    const f = fixture()
    f.failStorage("replace_account_during_unscoped_remove")
    expect(await f.migrate()).toBe(false)
    expect(f.snapshot().legacy).toBe(true)
    expect(f.wallets.size).toBe(0)
    expect(f.credentials.size).toBe(0)
  })
  it("leaves an unscoped URI that belongs to another connection untouched", async () => {
    const f = fixture()
    f.replaceUnscopedLegacy()
    expect(await f.migrate()).toBe(true)
    expect(f.snapshot().legacy).toBe(false)
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
    expect(f.unscopedReplacementPresent()).toBe(true)
  })
  it("keeps a deduplicated shared wallet after uncertain retirement", async () => {
    const f = fixture()
    await f.connect()
    f.failStorage("account_remove_after")
    await expect(f.migrate()).rejects.toThrow("retirement is uncertain")
    expect(f.snapshot().legacy).toBe(false)
    expect(f.wallets.size).toBe(1)
    expect(f.credentials.size).toBe(1)
  })
  it("does not reclassify completed retirement when its advisory notification fails", async () => {
    const f = fixture()
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      f.failNotification()
      expect(await f.migrate()).toBe(true)
      expect(f.notificationCount()).toBe(1)
      expect(f.snapshot().legacy).toBe(false)
      expect(f.wallets.size).toBe(1)
      expect(f.credentials.size).toBe(1)
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })
  it("checks existing shared registration again before retiring its legacy copy", async () => {
    const f = fixture()
    await f.connect()
    f.failReadBack()
    await expect(f.migrate()).rejects.toThrow("verification")
    expect(f.snapshot()).toEqual({ legacy: true, retired: 0 })
  })
})
