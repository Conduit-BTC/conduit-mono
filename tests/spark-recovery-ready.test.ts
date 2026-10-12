import { describe, expect, test } from "bun:test"
import type { WalletDescriptor } from "@conduit/core"
import {
  notifySparkRecoveryReady,
  type SparkRecoveryReady,
} from "../packages/core/src/wallets/spark-recovery-ready"
import type { SignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"

const recoveryMaterial = generateSparkMnemonic()

const wallet: WalletDescriptor = {
  id: "wallet-1",
  kind: "portable",
  providerId: "spark",
  label: "Wallet",
  network: "mainnet",
  capabilities: [],
  status: "ready",
  defaultIntents: [],
  createdAt: 1,
  updatedAt: 1,
}

const stored: SignerSparkRecovery = {
  type: "signer",
  version: 1,
  walletId: wallet.id,
  providerId: "spark",
  network: wallet.network,
  accountNumber: 1,
  ownerPubkey: "owner",
  ciphertext: crypto.randomUUID(),
  identityKey: "identity",
}

function input(
  overrides: Partial<Parameters<typeof notifySparkRecoveryReady>[0]> = {}
) {
  return {
    wallet,
    mnemonic: recoveryMaterial,
    accountNumber: 1,
    recovered: false,
    ownerPubkey: "owner",
    getStoredRecovery: async () => stored,
    isNativeOpen: () => true,
    assertAuthority: () => {},
    onRecoveryReady: () => {},
    ...overrides,
  }
}

describe("locally verified Spark recovery handoff", () => {
  test("reveals the local bundle after credential and native-open verification", async () => {
    let delivered: unknown = null
    await notifySparkRecoveryReady(
      input({ onRecoveryReady: (recovery) => (delivered = recovery) })
    )
    const handoff = delivered as SparkRecoveryReady | null
    expect({
      sameWallet: handoff?.wallet === wallet,
      sameRecovery: handoff?.mnemonic === recoveryMaterial,
      sameAccount: handoff?.accountNumber === 1,
      newlyCreated: handoff?.recovered === false,
    }).toEqual({
      sameWallet: true,
      sameRecovery: true,
      sameAccount: true,
      newlyCreated: true,
    })
    expect(Object.hasOwn(handoff ?? {}, "publicDefaultAllowed")).toBe(false)
  })

  test("does not reveal another owner's or unopened wallet's recovery", async () => {
    let delivered = false
    const onRecoveryReady = () => {
      delivered = true
    }
    await expect(
      notifySparkRecoveryReady(
        input({ ownerPubkey: "different-owner", onRecoveryReady })
      )
    ).rejects.toThrow("Locally verified wallet recovery is unavailable")
    await expect(
      notifySparkRecoveryReady(
        input({ isNativeOpen: () => false, onRecoveryReady })
      )
    ).rejects.toThrow("Locally verified wallet recovery is unavailable")
    expect(delivered).toBe(false)
  })

  test("rechecks signer authority after the credential read and before revealing", async () => {
    let current = true
    let delivered = false
    await expect(
      notifySparkRecoveryReady(
        input({
          getStoredRecovery: async () => {
            current = false
            return stored
          },
          assertAuthority: () => {
            if (!current) throw new Error("sign-in changed")
          },
          onRecoveryReady: () => {
            delivered = true
          },
        })
      )
    ).rejects.toThrow("sign-in changed")
    expect(delivered).toBe(false)
  })
})
