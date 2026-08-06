import { describe, expect, it } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"

import {
  parseStoredSparkWalletRecovery,
  registerNwcWalletAtomically,
  registerSparkWalletAtomically,
  serializeStoredSparkWalletRecovery,
} from "../apps/market/src/lib/wallet-storage"

const ENCRYPTED_RECOVERY = {
  version: 2 as const,
  kdf: "PBKDF2-SHA-256" as const,
  cipher: "AES-GCM" as const,
  iterations: 600_000,
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==",
}

const BOUND_RECOVERY = {
  type: "password" as const,
  walletId: "spark-wallet",
  providerId: "spark" as const,
  network: "mainnet" as const,
  accountNumber: 1,
  recovery: ENCRYPTED_RECOVERY,
}

const SPARK_WALLET: WalletDescriptor = {
  id: "spark-wallet",
  kind: "portable",
  providerId: "spark",
  label: "Spending",
  network: "mainnet",
  capabilities: ["pay_invoice"],
  status: "registered",
  defaultIntents: [],
  createdAt: 1,
  updatedAt: 1,
}

const NWC_URI = "nostr+walletconnect://wallet?relay=wss%3A%2F%2Frelay.example"
const NEXT_NWC_URI = `${NWC_URI}&secret=another-wallet`

const NWC_WALLET: WalletDescriptor = {
  id: "nwc-wallet",
  kind: "connected",
  providerId: "nwc",
  label: "Zeus",
  network: "mainnet",
  capabilities: ["pay_invoice"],
  status: "registered",
  defaultIntents: [],
  createdAt: 1,
  updatedAt: 1,
}

describe("Spark wallet recovery storage", () => {
  it("rejects legacy unbound password records", () => {
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({
          accountNumber: 0,
          recovery: ENCRYPTED_RECOVERY,
        })
      )
    ).toBeNull()
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({
          ...BOUND_RECOVERY,
          recovery: { ...ENCRYPTED_RECOVERY, version: 1 },
        })
      )
    ).toBeNull()
  })

  it("round-trips a password recovery record", () => {
    expect(
      parseStoredSparkWalletRecovery(
        serializeStoredSparkWalletRecovery(BOUND_RECOVERY)
      )
    ).toEqual(BOUND_RECOVERY)
  })

  it("rejects oversized or malformed bound recovery fields before decrypt", () => {
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({ ...BOUND_RECOVERY, ignored: "A".repeat(10_000) })
      )
    ).toBeNull()

    for (const record of [
      {
        ...BOUND_RECOVERY,
        walletId: "w".repeat(129),
      },
      {
        ...BOUND_RECOVERY,
        recovery: {
          ...ENCRYPTED_RECOVERY,
          salt: "A".repeat(10_000),
        },
      },
      {
        ...BOUND_RECOVERY,
        recovery: {
          ...ENCRYPTED_RECOVERY,
          ciphertext: "A".repeat(10_000),
        },
      },
    ]) {
      expect(parseStoredSparkWalletRecovery(JSON.stringify(record))).toBeNull()
    }
  })

  it("rejects pre-release passkey recovery records", () => {
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({
          type: "passkey",
          walletId: SPARK_WALLET.id,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
          credentialId: "AQIDBA",
          derivationLabel: "opaque-id",
          rpPolicyVersion: 1,
        })
      )
    ).toBeNull()
  })

  it("rejects Spark account numbers outside the hardened BIP32 range", () => {
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({
          ...BOUND_RECOVERY,
          accountNumber: 2_147_483_647,
        })
      )?.accountNumber
    ).toBe(2_147_483_647)
    expect(
      parseStoredSparkWalletRecovery(
        JSON.stringify({
          ...BOUND_RECOVERY,
          accountNumber: 2_147_483_648,
        })
      )
    ).toBeNull()
  })

  it("rolls back the descriptor when recovery persistence fails", async () => {
    const state = createTransactionalWalletState()
    state.failRecoveryWrite = true

    await expect(
      registerSparkWalletAtomically({
        store: state.store,
        async register() {
          state.wallets.set(SPARK_WALLET.id, SPARK_WALLET)
          return SPARK_WALLET
        },
        recovery: BOUND_RECOVERY,
      })
    ).rejects.toThrow("simulated recovery write failure")

    expect([...state.wallets.values()]).toEqual([])
    expect([...state.recoveries.values()]).toEqual([])
  })

  it("rolls back both records when recovery readback cannot be verified", async () => {
    const state = createTransactionalWalletState()
    state.returnMissingRecovery = true

    await expect(
      registerSparkWalletAtomically({
        store: state.store,
        async register() {
          state.wallets.set(SPARK_WALLET.id, SPARK_WALLET)
          return SPARK_WALLET
        },
        recovery: BOUND_RECOVERY,
      })
    ).rejects.toThrow("Portable Wallet recovery verification failed")

    expect([...state.wallets.values()]).toEqual([])
    expect([...state.recoveries.values()]).toEqual([])
  })

  it("rejects a recovery record bound to another wallet before persistence", async () => {
    const state = createTransactionalWalletState()

    await expect(
      registerSparkWalletAtomically({
        store: state.store,
        async register() {
          state.wallets.set(SPARK_WALLET.id, SPARK_WALLET)
          return SPARK_WALLET
        },
        recovery: {
          ...BOUND_RECOVERY,
          walletId: "spark-wallet-from-another-record",
        },
      })
    ).rejects.toThrow(
      "Portable Wallet recovery data does not match its registration."
    )

    expect([...state.wallets.values()]).toEqual([])
    expect([...state.recoveries.values()]).toEqual([])
  })
})

describe("NWC wallet credential storage", () => {
  it("reuses an existing wallet for the same normalized credential", async () => {
    const state = createTransactionalNwcWalletState()
    const existingWallet = {
      ...NWC_WALLET,
      label: "Original label",
      defaultIntents: ["pay_invoice" as const],
    }
    state.wallets.set(existingWallet.id, existingWallet)
    state.credentials.set(existingWallet.id, NWC_URI)
    let registerCalls = 0
    let defaultCalls = 0

    const wallet = await registerNwcWalletAtomically({
      store: state.store,
      uri: `  ${NWC_URI}  `,
      listWallets: async () => [...state.wallets.values()],
      register: async () => {
        registerCalls += 1
        return { ...NWC_WALLET, label: "Replacement label" }
      },
      ensureDefault: async () => {
        defaultCalls += 1
      },
    })

    expect(wallet).toEqual(existingWallet)
    expect(registerCalls).toBe(0)
    expect(defaultCalls).toBe(0)
    expect([...state.wallets.values()]).toEqual([existingWallet])
    expect([...state.credentials.values()]).toEqual([NWC_URI])
  })

  it("serializes concurrent registrations for the same credential", async () => {
    const state = createTransactionalNwcWalletState()
    let registerCalls = 0
    let defaultCalls = 0

    const connect = () =>
      registerNwcWalletAtomically({
        store: state.store,
        uri: NWC_URI,
        listWallets: async () => [...state.wallets.values()],
        register: async () => {
          registerCalls += 1
          const wallet = {
            ...NWC_WALLET,
            id: `nwc-wallet-${registerCalls}`,
          }
          state.wallets.set(wallet.id, wallet)
          return wallet
        },
        ensureDefault: async () => {
          defaultCalls += 1
        },
      })

    const [first, second] = await Promise.all([connect(), connect()])

    expect(first.id).toBe("nwc-wallet-1")
    expect(second.id).toBe(first.id)
    expect(registerCalls).toBe(1)
    expect(defaultCalls).toBe(1)
    expect([...state.wallets.values()]).toHaveLength(1)
    expect([...state.credentials.entries()]).toEqual([
      ["nwc-wallet-1", NWC_URI],
    ])
  })

  it("repairs an orphaned credential row before recreating its wallet", async () => {
    const state = createTransactionalNwcWalletState()
    state.credentials.set("missing-wallet", NWC_URI)

    const wallet = await registerNwcWalletAtomically({
      store: state.store,
      uri: NWC_URI,
      listWallets: async () => [...state.wallets.values()],
      register: async () => {
        state.wallets.set(NWC_WALLET.id, NWC_WALLET)
        return NWC_WALLET
      },
      ensureDefault: async () => undefined,
    })

    expect(wallet).toEqual(NWC_WALLET)
    expect(state.credentials.has("missing-wallet")).toBeFalse()
    expect(state.credentials.get(NWC_WALLET.id)).toBe(NWC_URI)
  })

  it("registers a distinct credential as another wallet", async () => {
    const state = createTransactionalNwcWalletState()
    state.wallets.set(NWC_WALLET.id, NWC_WALLET)
    state.credentials.set(NWC_WALLET.id, NWC_URI)
    const nextWallet = {
      ...NWC_WALLET,
      id: "nwc-wallet-2",
      label: "Blink",
    }

    const wallet = await registerNwcWalletAtomically({
      store: state.store,
      uri: NEXT_NWC_URI,
      listWallets: async () => [...state.wallets.values()],
      register: async () => {
        state.wallets.set(nextWallet.id, nextWallet)
        return nextWallet
      },
      ensureDefault: async () => undefined,
    })

    expect(wallet).toEqual(nextWallet)
    expect([...state.wallets.values()]).toHaveLength(2)
    expect(state.credentials.get(nextWallet.id)).toBe(NEXT_NWC_URI)
  })

  it("rolls back a new descriptor when credential readback fails", async () => {
    const state = createTransactionalNwcWalletState()
    state.returnMissingCredential = true

    await expect(
      registerNwcWalletAtomically({
        store: state.store,
        uri: NWC_URI,
        listWallets: async () => [...state.wallets.values()],
        register: async () => {
          state.wallets.set(NWC_WALLET.id, NWC_WALLET)
          return NWC_WALLET
        },
        ensureDefault: async () => undefined,
      })
    ).rejects.toThrow("Connected Wallet credential verification failed.")

    expect([...state.wallets.values()]).toEqual([])
    expect([...state.credentials.values()]).toEqual([])
  })
})

function createTransactionalWalletState() {
  type Recovery = Parameters<typeof serializeStoredSparkWalletRecovery>[0]
  const wallets = new Map<string, WalletDescriptor>()
  const recoveries = new Map<string, Recovery>()
  const state = {
    wallets,
    recoveries,
    failRecoveryWrite: false,
    returnMissingRecovery: false,
    store: {
      async transaction<T>(operation: () => Promise<T>): Promise<T> {
        const walletSnapshot = new Map(wallets)
        const recoverySnapshot = new Map(recoveries)
        try {
          return await operation()
        } catch (error) {
          wallets.clear()
          recoveries.clear()
          for (const [id, wallet] of walletSnapshot) {
            wallets.set(id, wallet)
          }
          for (const [id, recovery] of recoverySnapshot) {
            recoveries.set(id, recovery)
          }
          throw error
        }
      },
      async putSparkRecovery(
        walletId: string,
        recovery: Recovery
      ): Promise<void> {
        if (state.failRecoveryWrite) {
          throw new Error("simulated recovery write failure")
        }
        recoveries.set(walletId, recovery)
      },
      async getSparkRecovery(walletId: string): Promise<Recovery | null> {
        return state.returnMissingRecovery
          ? null
          : (recoveries.get(walletId) ?? null)
      },
    },
  }
  return state
}

function createTransactionalNwcWalletState() {
  const wallets = new Map<string, WalletDescriptor>()
  const credentials = new Map<string, string>()
  let transactionTail: Promise<void> = Promise.resolve()
  const state = {
    wallets,
    credentials,
    returnMissingCredential: false,
    store: {
      async transaction<T>(operation: () => Promise<T>): Promise<T> {
        const run = transactionTail.then(async () => {
          const walletSnapshot = new Map(wallets)
          const credentialSnapshot = new Map(credentials)
          try {
            return await operation()
          } catch (error) {
            wallets.clear()
            credentials.clear()
            for (const [id, wallet] of walletSnapshot) {
              wallets.set(id, wallet)
            }
            for (const [id, uri] of credentialSnapshot) {
              credentials.set(id, uri)
            }
            throw error
          }
        })
        transactionTail = run.then(
          () => undefined,
          () => undefined
        )
        return run
      },
      async findWalletIdByUri(uri: string): Promise<string | null> {
        return (
          [...credentials.entries()].find(
            ([, storedUri]) => storedUri === uri
          )?.[0] ?? null
        )
      },
      async putNwcCredential(walletId: string, uri: string): Promise<void> {
        credentials.set(walletId, uri)
      },
      async getNwcCredential(walletId: string): Promise<string | null> {
        return state.returnMissingCredential
          ? null
          : (credentials.get(walletId) ?? null)
      },
      async deleteNwcCredential(walletId: string): Promise<void> {
        credentials.delete(walletId)
      },
    },
  }
  return state
}
