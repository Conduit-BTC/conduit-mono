import { describe, expect, it } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import merchantPackage from "../apps/merchant/package.json"
import {
  openMerchantCheckoutSparkObservationWallet,
  type MerchantSparkObservationWalletDependencies,
} from "../apps/merchant/src/lib/checkout-spark-observation-wallet"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

type Sdk =
  typeof import("../apps/merchant/node_modules/@buildonspark/spark-sdk/dist/index.browser.js")
const identity = () => `02${randomBytes(32).toString("hex")}`

function fixture() {
  const key = identity()
  const calls: string[] = []
  const seed = randomBytes(64)
  const requestId = randomUUID()
  const transferId = randomUUID()
  let walletSigner: InstanceType<Sdk["DefaultSparkSigner"]> | undefined
  let onConstruct: (() => void) | undefined
  let onTransfer: (() => Promise<void>) | undefined
  const nativeTransfer = {
    id: transferId,
    senderIdentityPublicKey: key,
    receiverIdentityPublicKey: identity(),
    transferDirection: "OUTGOING",
    userRequest: { id: requestId },
    totalValue: 101,
    status: "TRANSFER_STATUS_COMPLETED",
  }
  const receive = { id: requestId, network: "REGTEST" }
  class Signer {
    async mnemonicToSeed() {
      calls.push("derive-seed")
      return seed
    }
    async createSparkWalletFromSeed(_seed: Uint8Array, accountNumber: number) {
      expect(accountNumber).toBe(7)
      calls.push("derive-identity")
      return key
    }
    async getIdentityPublicKey() {
      return Buffer.from(key, "hex")
    }
    async signMessageWithIdentityKey() {
      calls.push("authenticate")
      return randomBytes(64)
    }
    async signFrost() {
      throw new Error("Financial signing must not be reachable")
    }
  }
  class Wallet {
    constructor(options: unknown, signer: typeof walletSigner) {
      calls.push("construct")
      walletSigner = signer
      expect(options).toEqual({
        log: false,
        network: "REGTEST",
        optimizationOptions: { auto: false },
        tokenOptimizationOptions: { enabled: false },
      })
      onConstruct?.()
    }
    async getIdentityPublicKey() {
      calls.push("identity")
      return key
    }
    async getLightningReceiveRequest() {
      calls.push("receive-query")
      return receive
    }
    async getLightningSendRequest() {
      calls.push("send-query")
      return { id: requestId }
    }
    async getTransfer() {
      calls.push("transfer-query")
      await onTransfer?.()
      return nativeTransfer
    }
    async getTransferFromSsp() {
      calls.push("ssp-query")
      return { sparkId: transferId, userRequest: { id: requestId } }
    }
    async cleanup() {
      calls.push("cleanup")
    }
    static async initialize() {
      throw new Error("Initialization must not be reachable")
    }
  }
  const input = {
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 7,
    network: "regtest" as const,
    expectedWalletIdentityPubkey: key,
  }
  const dependencies: MerchantSparkObservationWalletDependencies = {
    loadSdk: async () =>
      ({ SparkWallet: Wallet, DefaultSparkSigner: Signer }) as unknown as Sdk,
  }
  return {
    input,
    dependencies,
    calls,
    seed,
    receive,
    nativeTransfer,
    requestId,
    transferId,
    walletSigner: () => walletSigner!,
    onConstruct: (callback: () => void) => (onConstruct = callback),
    onTransfer: (callback: () => Promise<void>) => (onTransfer = callback),
  }
}

describe("claim-free Merchant Spark observation adapter", () => {
  it("exposes only exact query/cleanup capabilities and zeroes the derived seed", async () => {
    const f = fixture()
    const observer = await openMerchantCheckoutSparkObservationWallet(
      f.input,
      f.dependencies
    )
    expect(Object.keys(observer).sort()).toEqual(
      [
        "getIdentityPublicKey",
        "getLightningReceiveRequest",
        "getLightningSendRequest",
        "getTransfer",
        "getTransferFromSsp",
        "cleanup",
      ].sort()
    )
    expect(Object.isFrozen(observer)).toBe(true)
    expect(f.seed.every((value) => value === 0)).toBe(true)
    await observer.getIdentityPublicKey()
    await observer.getLightningReceiveRequest(f.requestId)
    await observer.getTransfer(f.transferId)
    await observer.getTransferFromSsp!(f.transferId)
    await observer.getLightningSendRequest!(f.requestId)
    await f.walletSigner().signMessageWithIdentityKey(randomBytes(32))
    expect(() => f.walletSigner().signFrost).toThrow("unavailable")
    await observer.cleanup()
    await observer.cleanup()
    expect(f.calls).toEqual([
      "derive-seed",
      "derive-identity",
      "construct",
      "identity",
      "receive-query",
      "transfer-query",
      "ssp-query",
      "transfer-query",
      "send-query",
      "authenticate",
      "cleanup",
    ])
    await expect(observer.getTransfer(f.transferId)).rejects.toThrow(
      "unavailable"
    )
  })

  it("fails closed on SDK changes and invalid network/account before constructing", async () => {
    for (const changed of [
      { accountNumber: -1 },
      { accountNumber: 0x80000000 },
      { accountNumber: 0.5 },
      { network: "testnet" as "regtest" },
      { expectedWalletIdentityPubkey: "invalid" },
    ]) {
      const f = fixture()
      await expect(
        openMerchantCheckoutSparkObservationWallet(
          { ...f.input, ...changed },
          f.dependencies
        )
      ).rejects.toThrow("unavailable")
      expect(f.calls).toEqual([])
    }
    const f = fixture()
    await expect(
      openMerchantCheckoutSparkObservationWallet(f.input, {
        ...f.dependencies,
        sdkVersion: "0.13.1",
      })
    ).rejects.toThrow("unavailable")
    expect(f.calls).toEqual([])
  })

  it("requires the exact derived account identity before constructing any client", async () => {
    const f = fixture()
    await expect(
      openMerchantCheckoutSparkObservationWallet(
        { ...f.input, expectedWalletIdentityPubkey: identity() },
        f.dependencies
      )
    ).rejects.toThrow("unavailable")
    expect(f.calls).toEqual(["derive-seed", "derive-identity"])
    expect(f.seed.every((value) => value === 0)).toBe(true)
  })

  it("closes constructed clients when the active order changes during opening", async () => {
    const f = fixture()
    let active = true
    f.onConstruct(() => (active = false))
    await expect(
      openMerchantCheckoutSparkObservationWallet(
        {
          ...f.input,
          assertActive: () => {
            if (!active) throw new Error("Order changed")
          },
        },
        f.dependencies
      )
    ).rejects.toThrow("unavailable")
    expect(f.calls).toEqual([
      "derive-seed",
      "derive-identity",
      "construct",
      "cleanup",
    ])
  })

  it("rejects unrelated native transfers and exact request/network substitutions", async () => {
    const f = fixture()
    const observer = await openMerchantCheckoutSparkObservationWallet(
      f.input,
      f.dependencies
    )
    try {
      await expect(observer.getTransfer(randomUUID())).rejects.toThrow(
        "unavailable"
      )
      await expect(
        observer.getLightningSendRequest!(randomUUID())
      ).rejects.toThrow("unavailable")
      f.receive.network = "MAINNET"
      await expect(
        observer.getLightningReceiveRequest(f.requestId)
      ).rejects.toThrow("unavailable")
      f.nativeTransfer.senderIdentityPublicKey = identity()
      await expect(observer.getTransferFromSsp!(f.transferId)).rejects.toThrow(
        "unavailable"
      )
    } finally {
      await observer.cleanup()
    }
  })

  it("does not return an in-flight read after cleanup or page/account invalidation", async () => {
    const f = fixture()
    let finish!: () => void
    f.onTransfer(() => new Promise<void>((resolve) => (finish = resolve)))
    const observer = await openMerchantCheckoutSparkObservationWallet(
      f.input,
      f.dependencies
    )
    const reading = observer.getTransfer(f.transferId)
    await observer.cleanup()
    finish()
    await expect(reading).rejects.toThrow("unavailable")
  })

  it("audits the installed SDK pin and constructs/cleans the real SDK without network or timers", async () => {
    const installed = JSON.parse(
      readFileSync(
        new URL(
          "../apps/merchant/node_modules/@buildonspark/spark-sdk/package.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { version: string }
    expect(installed.version).toBe("0.13.0")
    expect(merchantPackage.dependencies["@buildonspark/spark-sdk"]).toBe(
      installed.version
    )
    const sdk =
      await import("../apps/merchant/node_modules/@buildonspark/spark-sdk/dist/index.browser.js")
    const mnemonic = createRuntimeMnemonic()
    const signer = new sdk.DefaultSparkSigner()
    const seed = await signer.mnemonicToSeed(mnemonic)
    let expectedWalletIdentityPubkey: string
    try {
      expectedWalletIdentityPubkey = await signer.createSparkWalletFromSeed(
        seed,
        0
      )
    } finally {
      seed.fill(0)
    }
    const previousFetch = globalThis.fetch
    const previousInterval = globalThis.setInterval
    const operations: string[] = []
    globalThis.fetch = (() => {
      operations.push("network")
      throw new Error("No provider access allowed")
    }) as typeof fetch
    globalThis.setInterval = (() => {
      operations.push("background-timer")
      throw new Error("No background worker allowed")
    }) as typeof setInterval
    try {
      const observer = await openMerchantCheckoutSparkObservationWallet(
        {
          mnemonic,
          accountNumber: 0,
          network: "regtest",
          expectedWalletIdentityPubkey,
        },
        { loadSdk: async () => sdk }
      )
      expect(
        (await observer.getIdentityPublicKey()) === expectedWalletIdentityPubkey
      ).toBe(true)
      await observer.cleanup()
      expect(operations).toEqual([])
    } finally {
      globalThis.fetch = previousFetch
      globalThis.setInterval = previousInterval
    }
  })
})
