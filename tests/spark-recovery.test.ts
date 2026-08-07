import { describe, expect, it } from "bun:test"

import {
  decryptSparkMnemonic,
  encryptSparkMnemonic,
  type SparkEncryptedRecovery,
  type SparkRecoveryBinding,
} from "../apps/market/src/lib/spark-recovery"

const MNEMONIC = "abandon ".repeat(11) + "about"
const BINDING: SparkRecoveryBinding = {
  walletId: "spark-wallet-a",
  providerId: "spark",
  network: "mainnet",
  accountNumber: 7,
}

describe("Spark Portable Wallet recovery", () => {
  it("persists only a context-bound password-encrypted mnemonic envelope", async () => {
    const envelope = await encryptSparkMnemonic(
      MNEMONIC,
      "correct horse",
      BINDING,
      {
        iterations: 100_000,
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }
    )

    expect(JSON.stringify(envelope)).not.toContain("abandon")
    await expect(
      decryptSparkMnemonic(envelope, "correct horse", BINDING)
    ).resolves.toBe(MNEMONIC)
    await expect(
      decryptSparkMnemonic(envelope, "wrong password", BINDING)
    ).rejects.toThrow("Could not unlock Portable Wallet.")
  })

  it("fails closed when authenticated wallet context is changed or swapped", async () => {
    const envelope = await encryptSparkMnemonic(
      MNEMONIC,
      "correct horse",
      BINDING,
      {
        iterations: 100_000,
        randomBytes: (length) => new Uint8Array(length).fill(9),
      }
    )
    const mismatchedBindings: SparkRecoveryBinding[] = [
      { ...BINDING, walletId: "spark-wallet-b" },
      { ...BINDING, network: "regtest" },
      { ...BINDING, accountNumber: 8 },
      { ...BINDING, providerId: "nwc" as "spark" },
    ]

    for (const binding of mismatchedBindings) {
      await expect(
        decryptSparkMnemonic(envelope, "correct horse", binding)
      ).rejects.toThrow("Could not unlock Portable Wallet.")
    }
  })

  it("rejects the old unbound pre-release envelope version", async () => {
    const legacyEnvelope = {
      version: 1,
      kdf: "PBKDF2-SHA-256",
      cipher: "AES-GCM",
      iterations: 100_000,
      salt: "AA==",
      iv: "AA==",
      ciphertext: "AA==",
    } as unknown as SparkEncryptedRecovery

    await expect(
      decryptSparkMnemonic(legacyEnvelope, "correct horse", BINDING)
    ).rejects.toThrow("Could not unlock Portable Wallet.")
  })

  it("rejects malformed decoded nonce, salt, and ciphertext sizes", async () => {
    const envelope = await encryptSparkMnemonic(
      MNEMONIC,
      "correct horse",
      BINDING,
      {
        iterations: 100_000,
        randomBytes: (length) => new Uint8Array(length).fill(5),
      }
    )

    for (const malformed of [
      { ...envelope, salt: "A".repeat(24) },
      { ...envelope, iv: "AAAAAAAAAAAAAA==" },
      { ...envelope, ciphertext: "A".repeat(20) },
    ]) {
      await expect(
        decryptSparkMnemonic(malformed, "correct horse", BINDING)
      ).rejects.toThrow("Could not unlock Portable Wallet.")
    }
  })
})
