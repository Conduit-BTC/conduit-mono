import { describe, expect, it } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"

import {
  parseStoredSparkWalletRecovery,
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
