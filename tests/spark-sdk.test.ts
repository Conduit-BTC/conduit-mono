import { describe, expect, it } from "bun:test"
import {
  manifestFeeSats,
  manifestGrossSats,
  manifestNetSatsFor,
  parseCompressedPublicKeyHex,
  ReceiveQuoteAmountBasis,
  type LightningReceiveQuote,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import {
  Network as SparkProtoNetwork,
  TransferManifest,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/proto/spark.js"

import {
  collectCheckoutSparkNativeRetirementEvidence,
  decodeLightningInvoiceAmount,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
} from "@conduit/core"

import {
  FirstPartySparkSdkFactory,
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkConfigurationForNetwork,
  loadFirstPartySparkModule,
  type SparkNativeModule,
  type SparkNativeWallet,
} from "../apps/market/src/lib/spark-sdk"
import { MemorySparkDirectTransferSafetyStore } from "../apps/market/src/lib/spark-direct-transfer-safety"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  bytesToBolt11Words,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const MNEMONIC = "abandon ".repeat(11) + "about"
const ZERO_PREIMAGE = "00".repeat(32)
const ZERO_PREIMAGE_PAYMENT_HASH =
  "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
const ZERO_PREIMAGE_INVOICE = makeLightningInvoice(ZERO_PREIMAGE_PAYMENT_HASH)
const ZERO_PREIMAGE_FIXED_INVOICE = makeLightningInvoice(
  ZERO_PREIMAGE_PAYMENT_HASH,
  1_000
)
const PAYMENT_ATTEMPT_ID = "c7fb0ad2-c85c-4d93-b542-6dc9d10d8c00"
const CHECKOUT_OUTGOING_ID = "c7fb0ad2-c85c-5d93-b542-6dc9d10d8c00"
const RECEIVE_IDENTITY_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function testReceiveQuote(
  amountSats: number,
  options: { feeSats?: number; receiverIdentityPubkey?: string } = {}
): LightningReceiveQuote {
  const receiver = parseCompressedPublicKeyHex(
    options.receiverIdentityPubkey ?? RECEIVE_IDENTITY_KEY,
    "receiverIdentityPubkey"
  )
  const fee = options.feeSats ?? 0
  const feeReceiver = parseCompressedPublicKeyHex(
    "03" + RECEIVE_IDENTITY_KEY.slice(2),
    "feeReceiverIdentityPubkey"
  )
  const manifest = TransferManifest.fromPartial({
    version: 1,
    network: SparkProtoNetwork.MAINNET,
    transferId: "0197f9a0-0000-7000-8000-000000000001",
    edges: [
      {
        senderIdentityPublicKey: receiver,
        receiverIdentityPublicKey: receiver,
        amount: { amount: { $case: "sats", sats: amountSats } },
      },
      ...(fee > 0
        ? [
            {
              senderIdentityPublicKey: receiver,
              receiverIdentityPublicKey: feeReceiver,
              amount: { amount: { $case: "sats" as const, sats: fee } },
            },
          ]
        : []),
    ],
    fees:
      fee > 0
        ? [
            {
              receiverIdentityPublicKey: feeReceiver,
              amount: { amount: { $case: "sats", sats: fee } },
            },
          ]
        : [],
    quoteExpiryTime: new Date(1_900_000_000_000),
  })
  return {
    serializedManifest: Buffer.from(
      TransferManifest.encode(manifest).finish()
    ).toString("hex"),
    issuerSignature: "aa",
    manifest,
    amountSats,
    amountBasis: ReceiveQuoteAmountBasis.NET,
  }
}

describe("first-party Spark SDK adapter", () => {
  it("keeps exact returned-attempt inspection unavailable when native closure reads are unsupported", async () => {
    const client = await openClient(createFactory(createNativeWallet()))
    expect(
      await client.inspectCheckoutLightningReturnedAttempt!({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        paymentHash: ZERO_PREIMAGE_PAYMENT_HASH,
        amountSats: 1_000,
        maxFeeSats: 4,
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
        minimumAvailableSats: 1_111,
      })
    ).toEqual({ status: "unavailable" })
    await client.disconnect()
  })

  it("inspects terminal checkout history through an authenticated exact-wallet reader without closing the wallet", async () => {
    let readerCleanups = 0
    let walletCleanups = 0
    const wallet = createNativeWallet({
      async cleanup() {
        walletCleanups += 1
      },
      async openRetirementReader() {
        return {
          reader: {
            async getTransfers() {
              return {
                transfers: ["funding-transfer", "payout-transfer"].map(
                  (id) => ({
                    id,
                    type: 1,
                    status: 5,
                    network: 1,
                    totalValue: 1_000,
                  })
                ),
                offset: -1,
              }
            },
            async getPendingTransfers() {
              return []
            },
            async getAvailableBalance() {
              return 0n
            },
            async getOwnedBalance() {
              return 0n
            },
          },
          async cleanup() {
            readerCleanups += 1
          },
        }
      },
    })
    const manager = new SparkWalletManager(
      createFactory(wallet, {
        decodeSparkAddress: () => ({ identityPublicKey: RECEIVE_IDENTITY_KEY }),
      }),
      async () => ({ release: async () => {} }),
      new MemorySparkDirectTransferSafetyStore()
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })
    const session = await manager.openCheckoutRetirementReader(
      "wallet-personal",
      {
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      }
    )
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        authenticatedReader: session.reader,
        sparkAddress: session.sparkAddress,
        walletId: "wallet-personal",
        network: "mainnet",
        stateUpdatedAt: 1_800_000_000_000,
        expectedTransferIds: ["funding-transfer", "payout-transfer"],
        now: () => 1_800_000_000_001,
      })
    ).toMatchObject({
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      claimsTerminal: true,
      refundsTerminal: true,
    })
    await session.cleanup()
    await session.cleanup()
    expect(readerCleanups).toBe(1)
    expect(walletCleanups).toBe(0)
    expect(manager.isOpen("wallet-personal")).toBe(true)
    await manager.close("wallet-personal")
    expect(walletCleanups).toBe(1)
  })

  it("opens retirement inspection only for the frozen identity, wallet and network", async () => {
    let opens = 0
    const wallet = createNativeWallet({
      async openRetirementReader() {
        opens += 1
        return { reader: emptyRetirementReader(), cleanup: async () => {} }
      },
    })
    const client = await openClient(
      createFactory(wallet, {
        decodeSparkAddress: () => ({ identityPublicKey: RECEIVE_IDENTITY_KEY }),
      })
    )
    const target = {
      walletId: "wallet-personal",
      network: "mainnet" as const,
      receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
    }
    for (const changed of [
      { walletId: "another-wallet" },
      { network: "regtest" as const },
      { receiverIdentityPublicKey: "03" + RECEIVE_IDENTITY_KEY.slice(2) },
    ]) {
      await expect(
        client.openCheckoutRetirementReader!({ ...target, ...changed })
      ).rejects.toThrow("does not match")
    }
    expect(opens).toBe(0)
    const session = await client.openCheckoutRetirementReader!(target)
    await expect(
      session.reader.getOwnedBalance("spark1another")
    ).rejects.toThrow("out of scope")
    await session.cleanup()
    await expect(
      session.reader.getOwnedBalance(session.sparkAddress)
    ).rejects.toThrow("out of scope")
    await client.disconnect()
    expect(opens).toBe(1)
  })

  it("exposes internal swap evidence only for this reader's observed exact-wallet history", async () => {
    const evidence = {
      walletIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      sspIdentityPublicKey: "03" + "55".repeat(32),
      transfer: { sparkId: "observed-primary-swap" },
    }
    let evidenceReads = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async openRetirementReader() {
            return {
              reader: {
                ...emptyRetirementReader(),
                getTransfers: async () => ({
                  transfers: [
                    {
                      id: "observed-primary-swap",
                      type: 4,
                      status: 5,
                      network: 1,
                      totalValue: 100,
                    },
                  ],
                  offset: -1,
                }),
                getInternalSwapEvidence: async () => {
                  evidenceReads++
                  return evidence
                },
              },
              cleanup: async () => {},
            }
          },
        }),
        {
          decodeSparkAddress: () => ({
            identityPublicKey: RECEIVE_IDENTITY_KEY,
          }),
        }
      )
    )
    try {
      const session = await client.openCheckoutRetirementReader!({
        walletId: "wallet-personal",
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      })
      const request = {
        sparkAddress: session.sparkAddress,
        transferId: "observed-primary-swap",
      }
      await expect(
        session.reader.getInternalSwapEvidence!(request)
      ).rejects.toThrow()
      await session.reader.getTransfers({
        sparkAddress: session.sparkAddress,
        types: [4, 5],
        limit: 100,
        offset: 0,
      })
      expect(await session.reader.getInternalSwapEvidence!(request)).toEqual(
        evidence
      )
      await expect(
        session.reader.getInternalSwapEvidence!({
          ...request,
          sparkAddress: "spark1another-wallet",
        })
      ).rejects.toThrow()
      await expect(
        session.reader.getInternalSwapEvidence!({
          ...request,
          transferId: "unobserved-swap",
        })
      ).rejects.toThrow()
      await session.cleanup()
      await expect(
        session.reader.getInternalSwapEvidence!(request)
      ).rejects.toThrow()
      expect(evidenceReads).toBe(1)
    } finally {
      await client.disconnect()
    }
  })

  it("preserves internal swap evidence through the wallet manager and revokes an in-flight read on close", async () => {
    const evidence = {
      walletIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      sspIdentityPublicKey: "03" + RECEIVE_IDENTITY_KEY.slice(2),
      transfer: { sparkId: "observed-primary-swap" },
    }
    const pending = deferred<typeof evidence>()
    let stall = false
    const manager = new SparkWalletManager(
      createFactory(
        createNativeWallet({
          async openRetirementReader() {
            return {
              reader: {
                ...emptyRetirementReader(),
                getTransfers: async () => ({
                  transfers: [
                    {
                      id: "observed-primary-swap",
                      type: 4,
                      status: 5,
                      network: 1,
                      totalValue: 100,
                    },
                  ],
                  offset: -1,
                }),
                getInternalSwapEvidence: async () =>
                  stall ? pending.promise : evidence,
              },
              cleanup: async () => {},
            }
          },
        }),
        {
          decodeSparkAddress: () => ({
            identityPublicKey: RECEIVE_IDENTITY_KEY,
          }),
        }
      ),
      async () => ({ release: async () => {} }),
      new MemorySparkDirectTransferSafetyStore()
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })
    try {
      const session = await manager.openCheckoutRetirementReader(
        "wallet-personal",
        {
          network: "mainnet",
          receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
        }
      )
      expect(typeof session.reader.getInternalSwapEvidence).toBe("function")
      await session.reader.getTransfers({
        sparkAddress: session.sparkAddress,
        types: [4, 5],
        limit: 100,
        offset: 0,
      })
      const request = {
        sparkAddress: session.sparkAddress,
        transferId: "observed-primary-swap",
      }
      expect(await session.reader.getInternalSwapEvidence!(request)).toEqual(
        evidence
      )
      stall = true
      const result = session.reader.getInternalSwapEvidence!(request).catch(
        (error: unknown) => error
      )
      await manager.close("wallet-personal")
      pending.resolve(evidence)
      expect(await result).toMatchObject({
        message: "Checkout Spark retirement session is closed.",
      })
      await expect(
        session.reader.getInternalSwapEvidence!(request)
      ).rejects.toThrow("locked")
      await session.cleanup()
    } finally {
      pending.resolve(evidence)
      await manager.close("wallet-personal")
    }
  })

  it("revokes in-flight retirement reads when their wallet session closes", async () => {
    const pending = deferred<bigint>()
    let readerCleanups = 0
    const wallet = createNativeWallet({
      async openRetirementReader() {
        return {
          reader: {
            ...emptyRetirementReader(),
            getOwnedBalance: () => pending.promise,
          },
          async cleanup() {
            readerCleanups += 1
          },
        }
      },
    })
    const manager = new SparkWalletManager(
      createFactory(wallet, {
        decodeSparkAddress: () => ({ identityPublicKey: RECEIVE_IDENTITY_KEY }),
      }),
      async () => ({ release: async () => {} }),
      new MemorySparkDirectTransferSafetyStore()
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })
    const session = await manager.openCheckoutRetirementReader(
      "wallet-personal",
      {
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      }
    )
    const read = session.reader.getOwnedBalance(session.sparkAddress)
    const rejected = read.catch((error: unknown) => error)
    await manager.close("wallet-personal")
    pending.resolve(0n)
    expect(await rejected).toMatchObject({
      message: "Checkout Spark retirement session is closed.",
    })
    expect(readerCleanups).toBe(1)
    await expect(
      session.reader.getAvailableBalance(session.sparkAddress)
    ).rejects.toThrow("locked")
    await session.cleanup()
    expect(readerCleanups).toBe(1)
  })

  it("does not substitute public reads when authenticated retirement inspection is unavailable", async () => {
    const client = await openClient(createFactory(createNativeWallet()))
    await expect(
      client.openCheckoutRetirementReader!({
        walletId: "wallet-personal",
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      })
    ).rejects.toThrow(
      "Authenticated Spark retirement inspection is unavailable"
    )
    await client.disconnect()

    let opens = 0
    const anotherAddress = await openClient(
      createFactory(
        createNativeWallet({
          async openRetirementReader() {
            opens += 1
            return { reader: emptyRetirementReader(), cleanup: async () => {} }
          },
        }),
        {
          decodeSparkAddress: () => ({
            identityPublicKey: "03" + RECEIVE_IDENTITY_KEY.slice(2),
          }),
        }
      )
    )
    await expect(
      anotherAddress.openCheckoutRetirementReader!({
        walletId: "wallet-personal",
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      })
    ).rejects.toThrow("does not match")
    expect(opens).toBe(0)
    await anotherAddress.disconnect()
  })

  it("bounds retirement reads and cleans a reader that finishes opening after timeout", async () => {
    let cleanups = 0
    const opening = deferred<{
      reader: ReturnType<typeof emptyRetirementReader>
      cleanup(): Promise<void>
    }>()
    const client = await openClient(
      createFactory(
        createNativeWallet({
          openRetirementReader: () => opening.promise,
        }),
        {
          decodeSparkAddress: () => ({
            identityPublicKey: RECEIVE_IDENTITY_KEY,
          }),
        },
        "mainnet",
        { retirementReadTimeoutMs: 5 }
      )
    )
    await expect(
      client.openCheckoutRetirementReader!({
        walletId: "wallet-personal",
        network: "mainnet",
        receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
      })
    ).rejects.toThrow("exceeded")
    opening.resolve({
      reader: emptyRetirementReader(),
      async cleanup() {
        cleanups += 1
      },
    })
    await opening.promise
    await Promise.resolve()
    expect(cleanups).toBe(1)
    await client.disconnect()

    const stalled = await openClient(
      createFactory(
        createNativeWallet({
          async openRetirementReader() {
            return {
              reader: {
                ...emptyRetirementReader(),
                getPendingTransfers: () => new Promise(() => {}),
              },
              cleanup: async () => {},
            }
          },
        }),
        {
          decodeSparkAddress: () => ({
            identityPublicKey: RECEIVE_IDENTITY_KEY,
          }),
        },
        "mainnet",
        { retirementReadTimeoutMs: 5 }
      )
    )
    const session = await stalled.openCheckoutRetirementReader!({
      walletId: "wallet-personal",
      network: "mainnet",
      receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
    })
    await expect(
      session.reader.getPendingTransfers(session.sparkAddress)
    ).rejects.toThrow("exceeded")
    await session.cleanup()
    await stalled.disconnect()
  })

  const feeEstimateInvoice = () =>
    makeSignedBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        bolt11PaymentHashField(),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
        { tag: "x", words: numberToBolt11Words(300) },
      ],
    })

  it("reads a numeric fee for only the exact live fixed-amount checkout invoice", async () => {
    const invoice = feeEstimateInvoice()
    const estimateInputs: unknown[] = []
    let paymentCalls = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate(request) {
        estimateInputs.push(request)
        return 3
      },
      async payLightningInvoice() {
        paymentCalls += 1
        throw new Error("fee estimate must not send")
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => 1_800_000_010_000 })
    )
    const request = {
      walletId: "wallet-personal",
      network: "mainnet" as const,
      paymentRequest: invoice,
      paymentHash: "07".repeat(32),
      amountSats: 1_000,
    }

    await expect(client.estimateCheckoutLightningFee?.(request)).resolves.toBe(
      3
    )
    expect(estimateInputs).toEqual([{ encodedInvoice: invoice }])
    expect(paymentCalls).toBe(0)

    for (const changed of [
      { walletId: "another-wallet" },
      { network: "regtest" as const },
      { amountSats: 999 },
      { paymentHash: "f".repeat(64) },
      { paymentRequest: makeSignedBolt11Fixture({ hrp: "lnbcrt10000n" }) },
      { paymentRequest: makeSignedBolt11Fixture({ hrp: "lnbc9990n" }) },
      { paymentRequest: makeReceiveInvoice({ expirySeconds: 300 }) },
      {
        paymentRequest: makeSignedBolt11Fixture({
          hrp: "lnbc10000n",
          fields: [bolt11PaymentSecretField(), bolt11PlainDescriptionField()],
        }),
      },
      { paymentRequest: ` ${invoice}` },
    ]) {
      await expect(
        client.estimateCheckoutLightningFee?.({ ...request, ...changed })
      ).rejects.toThrow("fee-estimate invoice is invalid")
    }
    expect(estimateInputs).toHaveLength(1)
    expect(paymentCalls).toBe(0)
  })

  it("rejects expired or malformed provider fee estimates without sending", async () => {
    const invoice = feeEstimateInvoice()
    const request = {
      walletId: "wallet-personal",
      network: "mainnet" as const,
      paymentRequest: invoice,
      paymentHash: "07".repeat(32),
      amountSats: 1_000,
    }
    let estimateCalls = 0
    const expired = await openClient(
      createFactory(
        createNativeWallet({
          async getLightningSendFeeEstimate() {
            estimateCalls += 1
            return 2
          },
        }),
        {},
        "mainnet",
        { now: () => 1_800_000_300_000 }
      )
    )
    await expect(
      expired.estimateCheckoutLightningFee?.(request)
    ).rejects.toThrow("fee-estimate invoice is invalid")
    expect(estimateCalls).toBe(0)

    let observedAt = 1_800_000_010_000
    const expiresDuringRead = await openClient(
      createFactory(
        createNativeWallet({
          async getLightningSendFeeEstimate() {
            observedAt = 1_800_000_300_000
            return 2
          },
        }),
        {},
        "mainnet",
        { now: () => observedAt }
      )
    )
    await expect(
      expiresDuringRead.estimateCheckoutLightningFee?.(request)
    ).rejects.toThrow("fee-estimate invoice is invalid")

    for (const estimate of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      let paymentCalls = 0
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async getLightningSendFeeEstimate() {
              return estimate
            },
            async payLightningInvoice() {
              paymentCalls += 1
              throw new Error("fee estimate must not send")
            },
          }),
          {},
          "mainnet",
          { now: () => 1_800_000_010_000 }
        )
      )
      await expect(
        client.estimateCheckoutLightningFee?.(request)
      ).rejects.toThrow("invalid Lightning fee estimate")
      expect(paymentCalls).toBe(0)
    }
  })

  it("binds a read-only checkout fee estimate to the opened manager wallet", async () => {
    const invoice = feeEstimateInvoice()
    let estimates = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        estimates += 1
        return 0
      },
    })
    const manager = new SparkWalletManager(
      createFactory(wallet, {}, "mainnet", { now: () => 1_800_000_010_000 }),
      async () => ({ async release() {} })
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })
    const request = {
      walletId: "wallet-personal",
      network: "mainnet" as const,
      paymentRequest: invoice,
      paymentHash: "07".repeat(32),
      amountSats: 1_000,
    }
    await expect(manager.estimateCheckoutLightningFee(request)).resolves.toBe(0)
    await expect(
      manager.estimateCheckoutLightningFee({ ...request, walletId: "other" })
    ).rejects.toThrow("locked")
    await expect(
      manager.estimateCheckoutLightningFee({ ...request, network: "regtest" })
    ).rejects.toThrow("another network")
    expect(estimates).toBe(1)
    await manager.close("wallet-personal")
  })

  it("fails closed on networks without first-party production defaults", () => {
    expect(getSparkConfigurationForNetwork("mainnet")).toEqual({
      status: "ready",
      network: "mainnet",
    })
    expect(getSparkConfigurationForNetwork("regtest")).toEqual({
      status: "ready",
      network: "regtest",
    })
    expect(getSparkConfigurationForNetwork("signet")).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on signet by the installed first-party SDK.",
    })
    expect(getSparkConfigurationForNetwork("testnet")).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on testnet by the installed first-party SDK.",
    })
  })

  it("fails closed when the browser cannot coordinate Spark sessions", () => {
    expect(
      getSparkConfiguration({
        network: "mainnet",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "This browser cannot safely coordinate Portable Wallet sessions across tabs.",
    })
    expect(
      getSparkConfiguration({
        network: "regtest",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "This browser cannot safely coordinate Portable Wallet sessions across tabs.",
    })
    expect(
      getSparkConfiguration({
        network: "signet",
        sessionCoordinationAvailable: false,
      })
    ).toEqual({
      status: "unavailable",
      reason:
        "Spark Portable Wallets are not supported on signet by the installed first-party SDK.",
    })
  })

  it("uses Spark's documented account defaults for supported networks", () => {
    expect(getDefaultSparkAccountNumber("mainnet")).toBe(1)
    expect(getDefaultSparkAccountNumber("regtest")).toBe(0)
  })

  it("creates an exact pure-BOLT11 checkout receive and exposes full funds state", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    let createInput:
      Parameters<SparkNativeWallet["createLightningInvoice"]>[0] | null = null
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 1_400n,
          satsBalance: {
            available: 1_000n,
            owned: 1_250n,
            incoming: 150n,
          },
        }
      },
      async createLightningInvoice(input) {
        createInput = input
        return nativeReceive
      },
      async getLightningReceiveRequest(id) {
        return id === nativeReceive.id ? nativeReceive : null
      },
    })
    const observedAt = 1_800_000_010_000
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => observedAt })
    )

    const request = await client.createCheckoutReceive?.({
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
    })

    expect(createInput).toEqual({
      amountSats: 1_000,
      memo: "Guest checkout",
      expirySeconds: 300,
      includeSparkAddress: false,
      includeSparkInvoice: false,
      receiverIdentityPubkey: RECEIVE_IDENTITY_KEY,
      quote: testReceiveQuote(1_000),
    })
    expect(request).toEqual({
      walletId: "wallet-personal",
      network: "mainnet",
      id: "lightning-receive",
      paymentRequest: invoice,
      paymentHash: "07".repeat(32),
      providerStatus: "INVOICE_CREATED",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
      receiveQuotePolicy: "same-wallet-feeless-net-v1",
    })
    await expect(client.getFundsState?.()).resolves.toEqual({
      availableSats: 1_000,
      ownedSats: 1_250,
      incomingSats: 150,
      observedAt,
    })
    await expect(client.reconcileCheckoutReceive?.(request!)).resolves.toEqual({
      state: "pending",
      providerStatus: "INVOICE_CREATED",
      failureReason: null,
      funds: {
        availableSats: 1_000,
        ownedSats: 1_250,
        incomingSats: 150,
        observedAt,
      },
    })
  })

  it("creates an ordinary settled checkout invoice without a NET quote and proves only its exact credit", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 15 * 60,
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    const transferId = "0197f9a0-0000-7000-8000-000000000007"
    let quoteCalls = 0
    let createInput:
      Parameters<SparkNativeWallet["createLightningInvoice"]>[0] | undefined
    let completed = false
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 50_000n,
          satsBalance: {
            available: 50_000n,
            owned: 50_000n,
            incoming: 0n,
          },
        }
      },
      async getLightningReceiveQuote() {
        quoteCalls += 1
        throw new Error("ordinary receive must not quote")
      },
      async createLightningInvoice(input) {
        createInput = input
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        return completed
          ? {
              ...nativeReceive,
              status: "TRANSFER_COMPLETED",
              transfer: {
                sparkId: transferId,
                userRequestId: nativeReceive.id,
                totalAmount: {
                  originalValue: 900,
                  originalUnit: "SATOSHI",
                },
              },
            }
          : nativeReceive
      },
      async getTransfer(id) {
        expect(id).toBe(transferId)
        return {
          id,
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 900,
          type: "TRANSFER",
          transferDirection: "INCOMING",
          receiverIdentityPublicKey: RECEIVE_IDENTITY_KEY,
          userRequest: { id: nativeReceive.id },
          receivers: [
            {
              identityPublicKey: RECEIVE_IDENTITY_KEY,
              amountSats: 900,
              status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
            },
          ],
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = await client.createCheckoutReceive?.({
      description: "Checkout funding",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 15 * 60,
      receiveMode: "ordinary_settled_v3",
    })
    expect(quoteCalls).toBe(0)
    expect(createInput).toEqual({
      amountSats: 1_000,
      memo: "Checkout funding",
      expirySeconds: 15 * 60,
      includeSparkAddress: false,
      includeSparkInvoice: false,
    })
    expect(request).toMatchObject({
      expirySecs: 15 * 60,
      expiresAt: 1_800_000_900_000,
      receiveSettledPolicy: "ordinary-exact-credit-v3",
    })
    expect(request?.receiverIdentityPublicKey).toBe(RECEIVE_IDENTITY_KEY)
    await expect(
      client.attestCheckoutReceiveCredit?.(request!)
    ).resolves.toBeNull()
    completed = true
    await expect(
      client.attestCheckoutReceiveCredit?.(request!)
    ).resolves.toMatchObject({
      mode: "ordinary_v3",
      requestId: nativeReceive.id,
      transferId,
      grossSats: 1_000,
      creditedSats: 900,
    })
  })

  it("inspects the signed quote bytes rather than a changed advisory manifest", async () => {
    const module = await loadFirstPartySparkModule()
    const quote = testReceiveQuote(1_000)
    const changedAdvisoryManifest = TransferManifest.fromPartial({
      ...quote.manifest,
      edges: [
        {
          ...quote.manifest.edges[0]!,
          amount: { amount: { $case: "sats", sats: 999 } },
        },
      ],
    })
    const inspected = module.inspectLightningReceiveQuote({
      quote: { ...quote, manifest: changedAdvisoryManifest },
      receiverIdentityPubkey: RECEIVE_IDENTITY_KEY,
      network: "MAINNET",
    })
    expect(inspected).toEqual({
      grossSats: 1_000,
      netSats: 1_000,
      feeSats: 0,
      feeComponents: 0,
      expiresAt: 1_900_000_000_000,
    })
    expect(
      module.inspectLightningReceiveQuote({
        quote: testReceiveQuote(1_000, { feeSats: 1 }),
        receiverIdentityPubkey: RECEIVE_IDENTITY_KEY,
        network: "MAINNET",
      })
    ).toMatchObject({
      grossSats: 1_001,
      netSats: 1_000,
      feeSats: 1,
      feeComponents: 1,
    })
    expect(() =>
      module.inspectLightningReceiveQuote({
        quote: { ...quote, serializedManifest: "00" },
        receiverIdentityPubkey: RECEIVE_IDENTITY_KEY,
        network: "MAINNET",
      })
    ).toThrow("Spark checkout receive quote is invalid")
    expect(() =>
      module.inspectLightningReceiveQuote({
        quote,
        receiverIdentityPubkey: RECEIVE_IDENTITY_KEY,
        network: "REGTEST",
      })
    ).toThrow("Spark checkout receive quote is invalid")
  })

  it("refuses a positive or ambiguous receive fee before creating a funding invoice", async () => {
    for (const quote of [
      testReceiveQuote(1_000, { feeSats: 1 }),
      { ...testReceiveQuote(1_000), issuerSignature: "" },
      { ...testReceiveQuote(1_000), amountSats: 999 },
      {
        ...testReceiveQuote(1_000),
        serializedManifest: testReceiveQuote(999).serializedManifest,
      },
    ]) {
      let invoiceCalls = 0
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async getLightningReceiveQuote() {
              return quote
            },
            async createLightningInvoice() {
              invoiceCalls += 1
              throw new Error("must not create an unquoted invoice")
            },
          })
        )
      )
      await expect(
        client.createCheckoutReceive?.({
          description: "Guest checkout",
          requiredNetSats: 1_000,
          grossFundingSats: 1_000,
          expirySecs: 300,
        })
      ).rejects.toThrow()
      expect(invoiceCalls).toBe(0)
    }
  })

  it("hides provider quote errors and never creates an unquoted funding invoice", async () => {
    let invoiceCalls = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async getLightningReceiveQuote() {
            throw new Error(
              "GraphQL receiver_identity_pubkey: synthetic-wallet-identity; trace: synthetic-provider-trace"
            )
          },
          async createLightningInvoice() {
            invoiceCalls += 1
            throw new Error("must not create an unquoted invoice")
          },
        })
      )
    )

    await expect(
      client.createCheckoutReceive?.({
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_000,
        expirySecs: 300,
      })
    ).rejects.toHaveProperty(
      "message",
      "Spark checkout receive quote is unavailable."
    )
    expect(invoiceCalls).toBe(0)
  })

  it("refuses the local unquoted receive mode when its runtime gate is closed", async () => {
    let quoteCalls = 0
    let invoiceCalls = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async getLightningReceiveQuote() {
            quoteCalls += 1
            return testReceiveQuote(1_000)
          },
          async createLightningInvoice() {
            invoiceCalls += 1
            throw new Error("must not create an unquoted invoice")
          },
        })
      )
    )

    await expect(
      client.createCheckoutReceive?.({
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_000,
        expirySecs: 300,
        receiveMode: "local_unquoted_canary",
      })
    ).rejects.toThrow("Spark local unquoted checkout is unavailable.")
    expect(quoteCalls).toBe(0)
    expect(invoiceCalls).toBe(0)
  })

  it("hides provider invoice errors after validating the exact receive quote", async () => {
    let invoiceCalls = 0
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            invoiceCalls += 1
            throw new Error(
              "GraphQL invoice request: synthetic-wallet-identity; trace: synthetic-provider-trace"
            )
          },
        })
      )
    )

    await expect(
      client.createCheckoutReceive?.({
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_000,
        expirySecs: 300,
      })
    ).rejects.toHaveProperty(
      "message",
      "Spark checkout funding invoice is unavailable."
    )
    expect(invoiceCalls).toBe(1)
  })

  it("binds a NET quote and invoice to the same wallet identity", async () => {
    let identityReads = 0
    let quoteCalls = 0
    let invoiceCalls = 0
    const wallet = createNativeWallet({
      async getIdentityPublicKey() {
        identityReads += 1
        return identityReads === 1
          ? RECEIVE_IDENTITY_KEY
          : "03" + RECEIVE_IDENTITY_KEY.slice(2)
      },
      async getLightningReceiveQuote(input) {
        quoteCalls += 1
        expect(input).toEqual({
          amountSats: 1_000,
          amountBasis: "NET",
        })
        return testReceiveQuote(1_000)
      },
      async createLightningInvoice() {
        invoiceCalls += 1
        throw new Error("must not create an invoice for another wallet")
      },
    })
    const client = await openClient(createFactory(wallet))
    await expect(
      client.createCheckoutReceive?.({
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_000,
        expirySecs: 300,
      })
    ).rejects.toThrow("wallet identity changed")
    expect(identityReads).toBe(2)
    expect(quoteCalls).toBe(1)
    expect(invoiceCalls).toBe(0)
  })

  it("canonicalizes fractional provider timestamps while retaining receive identity", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice, {
      createdAt: new Date(1_800_000_000_375).toISOString(),
      expiresAt: new Date(1_800_000_300_375).toISOString(),
    })
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 1_050n,
          satsBalance: {
            available: 1_050n,
            owned: 1_050n,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        return { ...nativeReceive, status: "TRANSFER_COMPLETED" }
      },
    })
    const client = await openClient(createFactory(wallet))

    const request = await client.createCheckoutReceive?.({
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
    })

    expect(request).toMatchObject({
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
    })
    await expect(
      client.reconcileCheckoutReceive?.(request!)
    ).resolves.toMatchObject({
      state: "spendable",
      providerStatus: "TRANSFER_COMPLETED",
      failureReason: null,
    })
  })

  it("reconciles every receive status without treating unrelated balance as proof", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice)
    let availableSats = 50_000n
    let observedAt = 1_800_000_010_000
    let lookup: "record" | "missing" | "throw" = "record"
    let currentReceive = nativeReceive
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: availableSats,
          satsBalance: {
            available: availableSats,
            owned: availableSats,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return nativeReceive
      },
      async getLightningReceiveRequest() {
        if (lookup === "throw") throw new Error("provider unavailable")
        return lookup === "missing" ? null : currentReceive
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => observedAt })
    )
    const request = (await client.createCheckoutReceive?.({
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
    }))!
    const reconcile = () => client.reconcileCheckoutReceive!(request)

    await expect(reconcile()).resolves.toMatchObject({
      state: "pending",
      failureReason: null,
    })

    observedAt = request.expiresAt
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "invoice_expired_unresolved",
    })

    for (const status of [
      "TRANSFER_CREATED",
      "PAYMENT_PREIMAGE_RECOVERED",
      "LIGHTNING_PAYMENT_RECEIVED",
    ]) {
      currentReceive = { ...nativeReceive, status }
      await expect(reconcile()).resolves.toMatchObject({
        state: "funded_pending_claim",
        providerStatus: status,
        failureReason: null,
      })
    }

    currentReceive = { ...nativeReceive, status: "TRANSFER_COMPLETED" }
    availableSats = 1_000n
    await expect(reconcile()).resolves.toMatchObject({
      state: "spendable",
      failureReason: null,
    })
    availableSats = 999n
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "insufficient_available_funds",
    })

    for (const status of [
      "FUTURE_VALUE",
      "TRANSFER_CREATION_FAILED",
      "REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED",
      "REFUND_SIGNING_FAILED",
      "PAYMENT_PREIMAGE_RECOVERING_FAILED",
      "TRANSFER_FAILED",
      "UNKNOWN_STATUS",
    ]) {
      currentReceive = { ...nativeReceive, status }
      await expect(reconcile()).resolves.toMatchObject({
        state: "unresolved_failure",
        providerStatus: status,
        failureReason: "provider_unresolved",
      })
    }

    lookup = "missing"
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: null,
      failureReason: "receive_not_found",
    })
    lookup = "throw"
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: null,
      failureReason: "lookup_unavailable",
    })
    lookup = "record"
    currentReceive = createLightningReceiveResult(invoice, {
      paymentHash: "08".repeat(32),
    })
    await expect(reconcile()).resolves.toMatchObject({
      state: "unresolved_failure",
      providerStatus: "INVOICE_CREATED",
      failureReason: "conflicting_evidence",
    })
  })

  it("rejects conflicting completed transfer amounts despite unrelated available balance", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 131, expirySeconds: 300 })
    const original = createLightningReceiveResult(invoice)
    let current = original
    const wallet = createNativeWallet({
      async getBalance() {
        return {
          balance: 50_000n,
          satsBalance: {
            available: 50_000n,
            owned: 50_000n,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return original
      },
      async getLightningReceiveRequest() {
        return current
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = (await client.createCheckoutReceive?.({
      description: "Checkout",
      requiredNetSats: 131,
      grossFundingSats: 131,
      expirySecs: 300,
    }))!
    const target = {
      walletId: request.walletId,
      network: request.network,
      requestId: request.id,
      paymentRequest: request.paymentRequest,
      paymentHash: request.paymentHash,
      requiredNetSats: request.requiredNetSats,
      grossFundingSats: request.grossFundingSats,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    }

    for (const totalAmount of [
      { originalValue: 130, originalUnit: "SATOSHI" },
      { originalValue: 132, originalUnit: "SATOSHI" },
      { originalValue: 130_000, originalUnit: "MILLISATOSHI" },
      {
        originalValue: Number.MAX_SAFE_INTEGER + 1,
        originalUnit: "MILLISATOSHI",
      },
      { originalValue: 131_000.5, originalUnit: "MILLISATOSHI" },
      { originalValue: 131.5, originalUnit: "SATOSHI" },
      { originalValue: 131, originalUnit: "UNKNOWN" },
    ]) {
      current = createLightningReceiveResult(invoice, {
        status: "TRANSFER_COMPLETED",
        transfer: { totalAmount, userRequestId: original.id },
      })
      await expect(
        client.reconcileCheckoutReceive?.(request)
      ).resolves.toMatchObject({
        state: "unresolved_failure",
        failureReason: "conflicting_evidence",
      })
      await expect(
        client.attestCheckoutReceiveHistory?.(target)
      ).resolves.toMatchObject({
        status: "unconfirmed",
        reason: "conflicting_evidence",
      })
    }

    current = createLightningReceiveResult(invoice, {
      status: "TRANSFER_COMPLETED",
      transfer: {
        totalAmount: { originalValue: 131, originalUnit: "SATOSHI" },
        userRequestId: "another-request",
      },
    })
    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "conflicting_evidence",
    })

    for (const totalAmount of [
      { originalValue: 131, originalUnit: "SATOSHI" },
      { originalValue: 131_000, originalUnit: "MILLISATOSHI" },
    ]) {
      current = createLightningReceiveResult(invoice, {
        status: "TRANSFER_COMPLETED",
        transfer: { totalAmount, userRequestId: original.id },
      })
      await expect(
        client.reconcileCheckoutReceive?.(request)
      ).resolves.toMatchObject({
        state: "spendable",
        failureReason: null,
      })
      await expect(
        client.attestCheckoutReceiveHistory?.(target)
      ).resolves.toMatchObject({
        status: "completed",
      })
    }

    // The pinned SDK permits an absent transfer field. Existing exact-request
    // and available-balance checks remain the fallback until provider coverage
    // of this optional field can be established.
    current = createLightningReceiveResult(invoice, {
      status: "TRANSFER_COMPLETED",
    })
    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "spendable",
    })
  })

  it("waits briefly for exact completed receive funds to become spendable", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 131,
      expirySeconds: 300,
    })
    const completed = {
      ...createLightningReceiveResult(invoice),
      status: "TRANSFER_COMPLETED",
    }
    let balanceReads = 0
    let exactReceiveReads = 0
    const waits: number[] = []
    const wallet = createNativeWallet({
      async getBalance() {
        balanceReads += 1
        const available = balanceReads === 1 ? 130n : 131n
        return {
          balance: available,
          satsBalance: {
            available,
            owned: available,
            incoming: 0n,
          },
        }
      },
      async createLightningInvoice() {
        return completed
      },
      async getLightningReceiveRequest(id) {
        exactReceiveReads += 1
        return id === completed.id ? completed : null
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => 1_800_000_010_000,
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
      })
    )
    const request = (await client.createCheckoutReceive?.({
      description: "Checkout",
      requiredNetSats: 131,
      grossFundingSats: 131,
      expirySecs: 300,
    }))!
    waits.length = 0

    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "spendable",
      providerStatus: "TRANSFER_COMPLETED",
      failureReason: null,
      funds: { availableSats: 131 },
    })
    expect(balanceReads).toBe(2)
    expect(exactReceiveReads).toBe(2)
    expect(waits).toHaveLength(1)
  })

  it("keeps a completed receive unresolved if available funds never catch up", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 131, expirySeconds: 300 })
    const completed = {
      ...createLightningReceiveResult(invoice),
      status: "TRANSFER_COMPLETED",
    }
    let receiveReads = 0
    let balanceReads = 0
    const wallet = createNativeWallet({
      async getBalance() {
        balanceReads += 1
        return {
          balance: 130n,
          satsBalance: { available: 130n, owned: 130n, incoming: 0n },
        }
      },
      async createLightningInvoice() {
        return completed
      },
      async getLightningReceiveRequest() {
        receiveReads += 1
        return completed
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = (await client.createCheckoutReceive?.({
      description: "Checkout",
      requiredNetSats: 131,
      grossFundingSats: 131,
      expirySecs: 300,
    }))!

    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "insufficient_available_funds",
    })
    expect(receiveReads).toBe(11)
    expect(balanceReads).toBe(11)
  })

  it("does not accept unrelated balance when an exact receive reread conflicts", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 131, expirySeconds: 300 })
    const completed = {
      ...createLightningReceiveResult(invoice),
      status: "TRANSFER_COMPLETED",
    }
    let receiveReads = 0
    let balanceReads = 0
    const wallet = createNativeWallet({
      async getBalance() {
        balanceReads += 1
        const available = balanceReads === 1 ? 130n : 131n
        return {
          balance: available,
          satsBalance: { available, owned: available, incoming: 0n },
        }
      },
      async createLightningInvoice() {
        return completed
      },
      async getLightningReceiveRequest() {
        receiveReads += 1
        return receiveReads === 1
          ? completed
          : {
              ...completed,
              invoice: { ...completed.invoice, paymentHash: "08".repeat(32) },
            }
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = (await client.createCheckoutReceive?.({
      description: "Checkout",
      requiredNetSats: 131,
      grossFundingSats: 131,
      expirySecs: 300,
    }))!

    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "conflicting_evidence",
    })
    expect(receiveReads).toBe(2)
    expect(balanceReads).toBe(2)
  })

  it("does not report spendable funds if a completed receive reread becomes unavailable or regresses", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 131, expirySeconds: 300 })
    const completed = {
      ...createLightningReceiveResult(invoice),
      status: "TRANSFER_COMPLETED",
    }

    for (const laterEvidence of ["unavailable", "regressed"] as const) {
      let receiveReads = 0
      let balanceReads = 0
      const wallet = createNativeWallet({
        async getBalance() {
          balanceReads += 1
          const available = balanceReads === 1 ? 130n : 131n
          return {
            balance: available,
            satsBalance: { available, owned: available, incoming: 0n },
          }
        },
        async createLightningInvoice() {
          return completed
        },
        async getLightningReceiveRequest() {
          receiveReads += 1
          if (receiveReads === 1) return completed
          if (laterEvidence === "unavailable") {
            throw new Error("synthetic lookup failure")
          }
          return { ...completed, status: "TRANSFER_CREATED" }
        },
      })
      const client = await openClient(createFactory(wallet))
      const request = (await client.createCheckoutReceive?.({
        description: "Checkout",
        requiredNetSats: 131,
        grossFundingSats: 131,
        expirySecs: 300,
      }))!

      const result = await client.reconcileCheckoutReceive?.(request)
      expect(result?.state).not.toBe("spendable")
      expect(result).toMatchObject(
        laterEvidence === "unavailable"
          ? { state: "unresolved_failure", failureReason: "lookup_unavailable" }
          : {
              state: "funded_pending_claim",
              providerStatus: "TRANSFER_CREATED",
            }
      )
      expect(receiveReads).toBe(2)
      expect(balanceReads).toBe(laterEvidence === "unavailable" ? 1 : 2)
    }
  })

  it("attests an exact completed receive after partial spend without reading current balance", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const original = createLightningReceiveResult(invoice)
    let current = { ...original, status: "TRANSFER_COMPLETED" }
    let lookup: "record" | "missing" | "throw" = "record"
    let balanceReads = 0
    let lookupReads = 0
    let sends = 0
    const wallet = createNativeWallet({
      async getBalance() {
        balanceReads += 1
        return {
          balance: 100n,
          satsBalance: { available: 100n, owned: 100n, incoming: 0n },
        }
      },
      async createLightningInvoice() {
        return original
      },
      async getLightningReceiveRequest(id) {
        lookupReads += 1
        expect(id).toBe(original.id)
        if (lookup === "throw") throw new Error("provider unavailable")
        return lookup === "missing" ? null : current
      },
      async payLightningInvoice() {
        sends += 1
        throw new Error("historical attestation must never send")
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => 1_800_000_010_000 })
    )
    const request = (await client.createCheckoutReceive?.({
      description: "Checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
    }))!
    const target = {
      walletId: request.walletId,
      network: request.network,
      requestId: request.id,
      paymentRequest: request.paymentRequest,
      paymentHash: request.paymentHash,
      requiredNetSats: request.requiredNetSats,
      grossFundingSats: request.grossFundingSats,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    }
    await expect(
      client.reconcileCheckoutReceive?.(request)
    ).resolves.toMatchObject({
      state: "unresolved_failure",
      failureReason: "insufficient_available_funds",
    })
    const readsBeforeAttestation = balanceReads
    await expect(
      client.attestCheckoutReceiveHistory?.(target)
    ).resolves.toEqual({
      status: "completed",
      observedAt: 1_800_000_010_000,
    })
    expect(balanceReads).toBe(readsBeforeAttestation)
    expect(sends).toBe(0)

    current = { ...original, status: "TRANSFER_CREATED" }
    await expect(
      client.attestCheckoutReceiveHistory?.(target)
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "not_completed",
    })
    current = { ...original, status: "UNKNOWN_STATUS" }
    await expect(
      client.attestCheckoutReceiveHistory?.(target)
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "not_completed",
    })
    for (const mismatched of [
      createLightningReceiveResult(invoice, { id: "different-receive" }),
      createLightningReceiveResult(invoice, { network: "REGTEST" }),
      createLightningReceiveResult(invoice, {
        paymentHash: "08".repeat(32),
      }),
      createLightningReceiveResult(
        makeReceiveInvoice({ amountSats: 999, expirySeconds: 300 })
      ),
      createLightningReceiveResult(invoice, {
        expiresAt: new Date(target.expiresAt + 1_000).toISOString(),
      }),
    ]) {
      current = { ...mismatched, status: "TRANSFER_COMPLETED" }
      await expect(
        client.attestCheckoutReceiveHistory?.(target)
      ).resolves.toMatchObject({
        status: "unconfirmed",
        reason: "conflicting_evidence",
      })
    }
    lookup = "missing"
    await expect(
      client.attestCheckoutReceiveHistory?.(target)
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "not_found",
    })
    lookup = "throw"
    await expect(
      client.attestCheckoutReceiveHistory?.(target)
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "lookup_unavailable",
    })
    expect(sends).toBe(0)
    const readsBeforeInvalidTargets = lookupReads

    for (const changed of [
      { walletId: "wallet-other" },
      { network: "regtest" as const },
      { requestId: " different-receive" },
      { paymentHash: "08".repeat(32) },
      { grossFundingSats: 999 },
      { createdAt: target.createdAt + 1_000 },
    ]) {
      await expect(
        client.attestCheckoutReceiveHistory?.({ ...target, ...changed })
      ).rejects.toThrow("historical receive target is invalid")
    }
    expect(lookupReads).toBe(readsBeforeInvalidTargets)
    expect(sends).toBe(0)
  })

  it("rejects conflicting checkout network evidence", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const request = {
      description: "Guest checkout",
      requiredNetSats: 1_000,
      grossFundingSats: 1_000,
      expirySecs: 300,
    }

    for (const nativeReceive of [
      createLightningReceiveResult(invoice, { network: "REGTEST" }),
      createLightningReceiveResult(invoice, { bitcoinNetwork: "REGTEST" }),
    ]) {
      const client = await openClient(
        createFactory(
          createNativeWallet({
            async createLightningInvoice() {
              return nativeReceive
            },
          })
        )
      )
      await expect(client.createCheckoutReceive?.(request)).rejects.toThrow()
    }
  })

  it("rejects a one-second provider expiry mismatch", async () => {
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      expirySeconds: 300,
    })
    const nativeReceive = createLightningReceiveResult(invoice, {
      expiresAt: new Date(1_800_000_301_375).toISOString(),
    })
    const client = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return nativeReceive
          },
        })
      )
    )

    await expect(
      client.createCheckoutReceive?.({
        description: "Guest checkout",
        requiredNetSats: 1_000,
        grossFundingSats: 1_000,
        expirySecs: 300,
      })
    ).rejects.toThrow("Spark returned conflicting checkout expiry evidence.")
  })

  it("validates mainnet receive outputs before returning them", async () => {
    const invoice = makeReceiveInvoice({ amountSats: 2_100 })
    const wallet = createNativeWallet({
      async getSparkAddress() {
        return " spark1receive "
      },
      async createLightningInvoice() {
        return createLightningReceiveResult(invoice)
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).resolves.toEqual({
      paymentRequest: "spark1receive",
      fee: 0n,
    })
    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
          amountSats: 2_100,
        },
      })
    ).resolves.toEqual({
      paymentRequest: invoice,
      fee: 0n,
    })
  })

  it("accepts a valid amountless mainnet receive invoice", async () => {
    const invoice = makeReceiveInvoice()
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(invoice)
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).resolves.toEqual({
      paymentRequest: invoice,
      fee: 0n,
    })
  })

  it("accepts valid amountless and fixed-amount regtest receive invoices", async () => {
    const amountlessInvoice = makeReceiveInvoice({ network: "regtest" })
    const fixedInvoice = makeReceiveInvoice({
      amountSats: 2_100,
      network: "regtest",
    })
    let paymentRequest = amountlessInvoice
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(paymentRequest)
      },
    })
    const client = await openClient(createFactory(wallet, {}, "regtest"))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).resolves.toMatchObject({
      paymentRequest: amountlessInvoice,
    })

    paymentRequest = fixedInvoice
    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
          amountSats: 2_100,
        },
      })
    ).resolves.toMatchObject({
      paymentRequest: fixedInvoice,
    })
  })

  it("rejects invalid, wrong-network, and invoice-form receive addresses", async () => {
    const wallet = createNativeWallet()
    const invalidClient = await openClient(
      createFactory(wallet, {
        isValidSparkAddress: () => false,
      })
    )
    const wrongNetworkClient = await openClient(
      createFactory(wallet, {
        getNetworkFromSparkAddress: () => "REGTEST",
      })
    )
    const sparkInvoiceClient = await openClient(
      createFactory(wallet, {
        decodeSparkAddress: () => ({ sparkInvoiceFields: {} }),
      })
    )

    await expect(
      invalidClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("invalid receive address")
    await expect(
      wrongNetworkClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("different Bitcoin network")
    await expect(
      sparkInvoiceClient.receivePayment({
        paymentMethod: { type: "sparkAddress" },
      })
    ).rejects.toThrow("plain receive address")
  })

  it("rejects wrong-network, wrong-amount, and malformed receive invoices", async () => {
    const paymentMethod = {
      type: "bolt11Invoice" as const,
      description: "Receive",
      amountSats: 2_100,
    }
    const wrongNetworkClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({ amountSats: 2_100, network: "regtest" })
            )
          },
        })
      )
    )
    const wrongAmountClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({ amountSats: 2_200 })
            )
          },
        })
      )
    )
    const missingHashClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeReceiveInvoice({
                amountSats: 2_100,
                includePaymentHash: false,
              })
            )
          },
        })
      )
    )

    await expect(
      wrongNetworkClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("different Bitcoin network")
    await expect(
      wrongAmountClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("different amount")
    await expect(
      missingHashClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("valid payment hash")
  })

  it("rejects an amount-bearing invoice for an amountless receive request", async () => {
    const wallet = createNativeWallet({
      async createLightningInvoice() {
        return createLightningReceiveResult(
          makeReceiveInvoice({ amountSats: 2_100 })
        )
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: "Receive",
        },
      })
    ).rejects.toThrow("amountless Lightning invoice")
  })

  it("rejects invalid amount components instead of treating them as amountless", async () => {
    const mainnetClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeInvalidAmountReceiveInvoice("mainnet")
            )
          },
        })
      )
    )
    const regtestClient = await openClient(
      createFactory(
        createNativeWallet({
          async createLightningInvoice() {
            return createLightningReceiveResult(
              makeInvalidAmountReceiveInvoice("regtest")
            )
          },
        }),
        {},
        "regtest"
      )
    )
    const paymentMethod = {
      type: "bolt11Invoice" as const,
      description: "Receive",
    }

    await expect(
      mainnetClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("amountless Lightning invoice")
    await expect(
      regtestClient.receivePayment({ paymentMethod })
    ).rejects.toThrow("amountless Lightning invoice")
  })

  it("opens the requested account with logging disabled and privacy enabled", async () => {
    const calls: string[] = []
    let initializeInput: Parameters<SparkNativeModule["initialize"]>[0] | null =
      null
    const wallet = createNativeWallet({
      async setPrivacyEnabled(enabled) {
        calls.push(`privacy:${enabled}`)
        return { privateEnabled: enabled }
      },
      async getWalletSettings() {
        calls.push("privacy:verify")
        return { privateEnabled: true }
      },
      async getBalance() {
        return {
          balance: 21_000n,
          satsBalance: {
            available: 21_000n,
            owned: 21_000n,
            incoming: 0n,
          },
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize(input) {
          calls.push("initialize")
          initializeInput = input
          return { wallet }
        },
      }),
      wait: async () => undefined,
    })

    const client = await factory.open({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 7,
    })

    expect(initializeInput).toEqual({
      mnemonicOrSeed: MNEMONIC,
      accountNumber: 7,
      options: {
        log: false,
        network: "MAINNET",
      },
    })
    expect(calls).toEqual(["initialize", "privacy:true", "privacy:verify"])
    await expect(client.getInfo({ ensureSynced: true })).resolves.toEqual({
      balanceSats: 21_000,
    })
  })

  it("waits for spaced public privacy observations before becoming ready", async () => {
    const calls: string[] = []
    const waitResolvers: Array<() => void> = []
    let observations = 0
    let ready = false
    const wallet = createNativeWallet({
      async getSparkAddress() {
        calls.push("wallet:address")
        return "spark1private"
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 250,
      privacyConvergenceTimeoutMs: 2_000,
      privacyReadTimeoutMs: 100,
      wait: (milliseconds) => {
        calls.push(`wait:${milliseconds}`)
        return new Promise<void>((resolve) => {
          waitResolvers.push(resolve)
        })
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient(options) {
          calls.push(`readonly:${options.network}:${options.log}`)
          return {
            async getAvailableBalance() {
              observations += 1
              calls.push(`available:${observations}`)
              return 0n
            },
            async getOwnedBalance() {
              calls.push(`owned:${observations}`)
              return 0n
            },
            async getTransfers() {
              calls.push(`history:${observations}`)
              return { transfers: [], offset: 0 }
            },
          }
        },
        async initialize() {
          calls.push("initialize")
          return { wallet }
        },
      }),
    })

    const open = factory
      .open({
        walletId: "wallet-personal",
        mnemonic: MNEMONIC,
        accountNumber: 1,
      })
      .then((client) => {
        ready = true
        return client
      })

    await waitForTestCondition(
      () => observations === 1 && waitResolvers.length === 1
    )
    expect(ready).toBe(false)
    waitResolvers.shift()?.()

    await waitForTestCondition(
      () => observations === 2 && waitResolvers.length === 1
    )
    expect(ready).toBe(false)
    waitResolvers.shift()?.()

    await open

    expect(ready).toBe(true)
    expect(observations).toBe(3)
    expect(calls).toEqual([
      "initialize",
      "wallet:address",
      "readonly:MAINNET:false",
      "available:1",
      "owned:1",
      "history:1",
      "wait:250",
      "available:2",
      "owned:2",
      "history:2",
      "wait:250",
      "available:3",
      "owned:3",
      "history:3",
    ])
  })

  it("restarts privacy convergence after a public read exposes wallet data", async () => {
    const availableByObservation = [0n, 0n, 21_000n, 0n, 0n, 0n]
    let observation = 0
    const waits: number[] = []
    const wallet = createNativeWallet()
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 400,
      privacyConvergenceTimeoutMs: 4_000,
      privacyReadTimeoutMs: 100,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient: () => ({
          async getAvailableBalance() {
            observation += 1
            return availableByObservation[observation] ?? 0n
          },
          async getOwnedBalance() {
            return availableByObservation[observation] ?? 0n
          },
          async getTransfers() {
            return {
              transfers: observation === 3 ? [{ id: "public-history" }] : [],
              offset: 0,
            }
          },
        }),
        async initialize() {
          return { wallet }
        },
      }),
    })

    await factory.open({
      walletId: "wallet-restored",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    expect(observation).toBe(6)
    expect(waits).toEqual([400, 400, 400, 400, 400])
  })

  it("times out stalled public reads and cleans up without exposing the wallet", async () => {
    let now = 0
    let cleanupCalls = 0
    let readonlyCalls = 0
    const timeoutCalls: Array<{ label: string; timeoutMs: number }> = []
    const wallet = createNativeWallet({
      async cleanup() {
        cleanupCalls += 1
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      privacyRequiredConsecutiveObservations: 3,
      privacyObservationIntervalMs: 250,
      privacyConvergenceTimeoutMs: 1_000,
      privacyReadTimeoutMs: 100,
      privacyReadWithTimeout: async (_read, timeoutMs, label) => {
        timeoutCalls.push({ label, timeoutMs })
        throw new Error(`${label} timed out`)
      },
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "REGTEST",
        isValidSparkAddress: () => true,
        createPublicReadonlyClient: () => {
          readonlyCalls += 1
          return {
            async getAvailableBalance() {
              return new Promise<bigint>(() => undefined)
            },
            async getOwnedBalance() {
              return 0n
            },
            async getTransfers() {
              return { transfers: [], offset: 0 }
            },
          }
        },
        async initialize() {
          return { wallet }
        },
      }),
    })

    await expect(
      factory.open({
        walletId: "wallet-stalled",
        mnemonic: MNEMONIC,
        accountNumber: 0,
      })
    ).rejects.toThrow(
      "Spark private mode could not be confirmed before the readiness deadline."
    )
    expect(readonlyCalls).toBe(1)
    expect(cleanupCalls).toBe(1)
    expect(timeoutCalls).toHaveLength(12)
    expect(timeoutCalls.every(({ timeoutMs }) => timeoutMs === 100)).toBe(true)
    expect([...new Set(timeoutCalls.map(({ label }) => label))]).toEqual([
      "Spark public available-balance read",
      "Spark public owned-balance read",
      "Spark public transfer-history read",
    ])
  })

  it("fails closed and cleans up when private wallet mode cannot be verified", async () => {
    let cleanupCalls = 0
    const wallet = createNativeWallet({
      async setPrivacyEnabled() {
        return { privateEnabled: true }
      },
      async getWalletSettings() {
        return { privateEnabled: false }
      },
      async cleanup() {
        cleanupCalls += 1
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "REGTEST",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
    })

    await expect(
      factory.open({
        walletId: "wallet-personal",
        mnemonic: MNEMONIC,
        accountNumber: 0,
      })
    ).rejects.toThrow("private mode")
    expect(cleanupCalls).toBe(1)
  })

  it("maps direct Spark transfers without inventing provider idempotency", async () => {
    const transferCalls: Array<{
      amountSats: number
      receiverSparkAddress: string
    }> = []
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls.push(input)
        return {
          id: "native-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const factory = createFactory(wallet)
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: {
        type: "input",
        input: "spark1recipient",
      },
      amount: 2_100n,
    })

    expect(prepared).toEqual({
      amount: 2_100n,
      paymentMethod: {
        fee: "0",
        type: "sparkAddress",
      },
    })
    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
        idempotencyKey: "local-safety-marker",
      })
    ).resolves.toEqual({
      payment: {
        fees: 0n,
        id: "native-transfer",
        status: "completed",
      },
    })
    expect(transferCalls).toEqual([
      {
        amountSats: 2_100,
        receiverSparkAddress: "spark1recipient",
      },
    ])
  })

  it("rejects Spark invoices before quoting or creating a transfer safety lock", async () => {
    let transferCalls = 0
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls += 1
        return {
          id: "must-not-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const safetyStore = new MemorySparkDirectTransferSafetyStore()
    const manager = new SparkWalletManager(
      new FirstPartySparkSdkFactory({
        network: "mainnet",
        loadModule: async () => ({
          eventNames: ["balance:update"],
          parseTransferId: parseTestTransferId,
          createPublicReadonlyClient: createHiddenPublicReadonlyClient,
          decodeSparkAddress: () => ({
            sparkInvoiceFields: { version: 1 },
          }),
          getNetworkFromSparkAddress: () => "MAINNET",
          isValidSparkAddress: () => true,
          async initialize() {
            return { wallet }
          },
        }),
        wait: async () => undefined,
      }),
      async () => ({ async release() {} }),
      safetyStore
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: { type: "spark_address", address: "spark1invoice" },
        amount: { type: "exact", amountSats: 2_100 },
      })
    ).rejects.toThrow(
      "Spark invoices are not supported for direct transfers. Use a plain Spark address."
    )
    expect(transferCalls).toBe(0)
    expect(manager.hasUnresolvedSend("wallet-personal")).toBe(false)
  })

  it("keeps a nonterminal direct Spark transfer pending without sending twice", async () => {
    let now = 0
    let transferCalls = 0
    const requestIds: string[] = []
    const wallet = createNativeWallet({
      async transfer(input) {
        transferCalls += 1
        return {
          id: "native-pending",
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
      async getTransfer(id) {
        requestIds.push(id)
        return {
          id,
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          totalValue: 2_100,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
      pollIntervalMs: 100,
      transferCompletionTimeoutSecs: 0.25,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
    })
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: "spark1recipient" },
      amount: 2_100n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
      })
    ).resolves.toMatchObject({
      payment: {
        id: "native-pending",
        status: "pending",
      },
    })
    expect(transferCalls).toBe(1)
    expect(requestIds).toEqual([
      "native-pending",
      "native-pending",
      "native-pending",
    ])
  })

  it("maps a terminal returned direct Spark transfer to failed", async () => {
    const wallet = createNativeWallet({
      async transfer(input) {
        return {
          id: "native-returned",
          status: "TRANSFER_STATUS_RETURNED",
          totalValue: input.amountSats,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: "spark1recipient" },
      amount: 2_100n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: { type: "sparkAddress" },
      })
    ).resolves.toMatchObject({
      payment: {
        id: "native-returned",
        status: "failed",
      },
    })
  })

  it("quotes Spark's recommended fee cap, pays, and reconciles Lightning", async () => {
    const payCalls: Array<{
      invoice: string
      maxFeeSats: number
      preferSpark: boolean
      amountSatsToSend?: number
      transferId?: string
    }> = []
    let requestReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 3
      },
      async payLightningInvoice(input) {
        payCalls.push({
          ...input,
          ...(input.transferId
            ? { transferId: input.transferId.toString() }
            : {}),
        })
        return {
          id: "lightning-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        requestReads += 1
        return {
          id: "lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 2_000, originalUnit: "MILLISATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const factory = createFactory(wallet)
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })
    const response = await client.sendPayment({
      prepareResponse: prepared,
      options: {
        type: "bolt11Invoice",
        preferSpark: false,
        completionTimeoutSecs: 5,
      },
      idempotencyKey: PAYMENT_ATTEMPT_ID,
    })

    expect(prepared).toEqual({
      amount: 1_000n,
      paymentMethod: {
        lightningFeeSats: 5,
        type: "bolt11Invoice",
      },
    })
    expect(payCalls).toEqual([
      {
        amountSatsToSend: 1_000,
        invoice: ZERO_PREIMAGE_INVOICE,
        maxFeeSats: 5,
        preferSpark: false,
        transferId: PAYMENT_ATTEMPT_ID,
      },
    ])
    expect(requestReads).toBe(1)
    expect(response.payment).toMatchObject({
      fees: 2n,
      id: "lightning-request",
      status: "completed",
      details: {
        type: "lightning",
        htlcDetails: {
          preimage: ZERO_PREIMAGE,
        },
      },
    })
    expect(response.payment.details?.htlcDetails?.paymentHash).toBe(
      ZERO_PREIMAGE_PAYMENT_HASH
    )
  })

  it("recovers one frozen checkout leg by the same exact ID after reopening", async () => {
    let sends = 0
    let exactHistoryAvailable = false
    const historyReads: string[] = []
    const nativeSends: Array<{
      invoice: string
      maxFeeSats: number
      preferSpark: boolean
      transferId?: string
    }> = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice(input) {
        sends += 1
        nativeSends.push({
          invoice: input.invoice,
          maxFeeSats: input.maxFeeSats,
          preferSpark: input.preferSpark,
          transferId: input.transferId?.toString(),
        })
        return {
          id: "checkout-lightning-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getTransferFromSsp(id) {
        historyReads.push(id)
        if (sends === 0) return undefined
        if (!exactHistoryAvailable) throw new Error("history still unavailable")
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "checkout-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const obligation = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 3,
      completionTimeoutSecs: 0,
      assertBeforeSend: async () => {},
    }
    const firstClient = await openClient(createFactory(wallet))
    await expect(
      firstClient.sendCheckoutLightningObligation?.(obligation)
    ).resolves.toEqual({ status: "ambiguous" })

    exactHistoryAvailable = true
    const reopenedClient = await openClient(createFactory(wallet))
    await expect(
      reopenedClient.sendCheckoutLightningObligation?.(obligation)
    ).resolves.toMatchObject({
      status: "paid",
      payment: {
        status: "completed",
        fees: 2n,
        details: {
          htlcDetails: {
            paymentHash: ZERO_PREIMAGE_PAYMENT_HASH,
            preimage: ZERO_PREIMAGE,
          },
        },
      },
    })
    expect(nativeSends).toEqual([
      {
        invoice: ZERO_PREIMAGE_FIXED_INVOICE,
        maxFeeSats: 3,
        preferSpark: false,
        transferId: CHECKOUT_OUTGOING_ID,
      },
    ])
    expect(historyReads).toEqual([
      CHECKOUT_OUTGOING_ID,
      CHECKOUT_OUTGOING_ID,
      CHECKOUT_OUTGOING_ID,
    ])
  })

  it("reports an exact matching failed checkout transfer as terminal without sending", async () => {
    let feeReads = 0
    let sendCalls = 0
    const historyReads: string[] = []
    const wallet = createNativeWallet({
      async getTransferFromSsp(id) {
        historyReads.push(id)
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "failed-checkout-lightning-request",
            status: "LIGHTNING_PAYMENT_FAILED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: null,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendFeeEstimate() {
        feeReads += 1
        return 2
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("must not resend a terminal checkout transfer")
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 3,
        completionTimeoutSecs: 0,
        assertBeforeSend: async () => {},
      })
    ).resolves.toEqual({
      status: "terminal_failure",
      payment: {
        id: "failed-checkout-lightning-request",
        status: "failed",
        fees: 2n,
        details: { type: "lightning" },
      },
    })
    expect(historyReads).toEqual([CHECKOUT_OUTGOING_ID])
    expect(feeReads).toBe(0)
    expect(sendCalls).toBe(0)
  })

  it("reports exact terminal failure after one frozen checkout send", async () => {
    let sends = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        sends += 1
        return {
          id: "failed-after-send-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getTransferFromSsp(id) {
        if (sends === 0) return undefined
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "failed-after-send-request",
            status: "LIGHTNING_PAYMENT_FAILED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: null,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 3,
        completionTimeoutSecs: 0,
        assertBeforeSend: async () => {},
      })
    ).resolves.toMatchObject({
      status: "terminal_failure",
      payment: { status: "failed", fees: 2n },
    })
    expect(sends).toBe(1)
  })

  it("reports an over-cap frozen checkout fee as not sent", async () => {
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 6
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("must not send above the frozen cap")
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        assertBeforeSend: async () => {},
      })
    ).resolves.toEqual({ status: "not_sent", reason: "fee_over_cap" })
    expect(sendCalls).toBe(0)
  })

  it("sends a frozen checkout invoice with 59 seconds remaining", async () => {
    const createdAt = 1_800_000_000
    const paymentRequest = makeLightningInvoice(
      ZERO_PREIMAGE_PAYMENT_HASH,
      1_000,
      { createdAt, expirySeconds: 59 }
    )
    const nativeSends: Array<{
      invoice: string
      maxFeeSats: number
      preferSpark: boolean
      transferId?: string
    }> = []
    let authorityChecks = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice(input) {
        nativeSends.push({
          invoice: input.invoice,
          maxFeeSats: input.maxFeeSats,
          preferSpark: input.preferSpark,
          transferId: input.transferId?.toString(),
        })
        return {
          id: "short-lived-checkout-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getTransferFromSsp(id) {
        if (nativeSends.length === 0) return undefined
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "short-lived-checkout-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: paymentRequest,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => createdAt * 1_000 })
    )

    await expect(
      client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest,
        amountSats: 1_000,
        maxFeeSats: 3,
        completionTimeoutSecs: 0,
        assertBeforeSend: async () => {
          authorityChecks += 1
        },
      })
    ).resolves.toMatchObject({
      status: "paid",
      payment: { status: "completed", fees: 2n },
    })
    expect(authorityChecks).toBe(1)
    expect(nativeSends).toEqual([
      {
        invoice: paymentRequest,
        maxFeeSats: 3,
        preferSpark: false,
        transferId: CHECKOUT_OUTGOING_ID,
      },
    ])
  })

  it.each(["exact history", "fee preflight", "final authority"] as const)(
    "does not enter the SDK when a frozen invoice expires during %s",
    async (delayedStage) => {
      const createdAt = 1_800_000_000
      const paymentRequest = makeLightningInvoice(
        ZERO_PREIMAGE_PAYMENT_HASH,
        1_000,
        { createdAt, expirySeconds: 59 }
      )
      let now = createdAt * 1_000
      const expiresAt = (createdAt + 59) * 1_000
      const stageEntered = deferred<void>()
      const releaseStage = deferred<void>()
      const stages: string[] = []
      let sendCalls = 0
      const pauseAtStage = async (stage: string) => {
        stages.push(stage)
        if (stage !== delayedStage) return
        stageEntered.resolve(undefined)
        await releaseStage.promise
      }
      const wallet = createNativeWallet({
        async getTransferFromSsp() {
          await pauseAtStage("exact history")
          return undefined
        },
        async getLightningSendFeeEstimate() {
          await pauseAtStage("fee preflight")
          return 2
        },
        async payLightningInvoice() {
          sendCalls += 1
          throw new Error("expired invoice must not enter the SDK")
        },
      })
      const client = await openClient(
        createFactory(wallet, {}, "mainnet", { now: () => now })
      )
      const sending = client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest,
        amountSats: 1_000,
        maxFeeSats: 3,
        completionTimeoutSecs: 0,
        assertBeforeSend: async () => pauseAtStage("final authority"),
      })

      expect(
        await Promise.race([
          stageEntered.promise.then(() => true),
          sending!.then(() => false),
        ])
      ).toBe(true)
      now = expiresAt
      releaseStage.resolve(undefined)

      await expect(sending).resolves.toEqual({
        status: "not_sent",
        reason: "invoice_expired",
      })
      expect(stages).toEqual([
        "exact history",
        "fee preflight",
        "final authority",
      ])
      expect(sendCalls).toBe(0)
    }
  )

  it("does not classify an SDK error after invoice expiry as not sent", async () => {
    const createdAt = 1_800_000_000
    const paymentRequest = makeLightningInvoice(
      ZERO_PREIMAGE_PAYMENT_HASH,
      1_000,
      { createdAt, expirySeconds: 59 }
    )
    let now = createdAt * 1_000
    const sendEntered = deferred<void>()
    const releaseSend = deferred<void>()
    const sdkError = new Error("invoice expired after SDK admission")
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        sendCalls += 1
        sendEntered.resolve(undefined)
        await releaseSend.promise
        throw sdkError
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => now })
    )
    const sending = client.sendCheckoutLightningObligation?.({
      network: "mainnet",
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest,
      amountSats: 1_000,
      maxFeeSats: 3,
      completionTimeoutSecs: 0,
      assertBeforeSend: async () => {},
    })

    expect(
      await Promise.race([
        sendEntered.promise.then(() => true),
        sending!.then(() => false),
      ])
    ).toBe(true)
    now = (createdAt + 59) * 1_000
    releaseSend.resolve(undefined)

    await expect(sending).rejects.toBe(sdkError)
    expect(sendCalls).toBe(1)
  })

  it("recovers exact paid history after invoice expiry without a second send", async () => {
    const createdAt = 1_800_000_000
    const paymentRequest = makeLightningInvoice(
      ZERO_PREIMAGE_PAYMENT_HASH,
      1_000,
      { createdAt, expirySeconds: 59 }
    )
    let now = createdAt * 1_000
    let sendCalls = 0
    let feeReads = 0
    let authorityChecks = 0
    let exactHistoryAvailable = false
    const historyReads: string[] = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeReads += 1
        return 2
      },
      async payLightningInvoice() {
        sendCalls += 1
        return {
          id: "late-checkout-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getTransferFromSsp(id) {
        historyReads.push(id)
        if (sendCalls === 0) return undefined
        if (!exactHistoryAvailable) throw new Error("exact history delayed")
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "late-checkout-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: paymentRequest,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const request = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest,
      amountSats: 1_000,
      maxFeeSats: 3,
      completionTimeoutSecs: 0,
      assertBeforeSend: async () => {
        authorityChecks += 1
      },
    }
    const firstClient = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => now })
    )
    await expect(
      firstClient.sendCheckoutLightningObligation?.(request)
    ).resolves.toEqual({ status: "ambiguous" })

    now = (createdAt + 60) * 1_000
    exactHistoryAvailable = true
    const reopenedClient = await openClient(
      createFactory(wallet, {}, "mainnet", { now: () => now })
    )
    await expect(
      reopenedClient.sendCheckoutLightningObligation?.(request)
    ).resolves.toMatchObject({
      status: "paid",
      payment: { status: "completed", fees: 2n },
    })
    expect(sendCalls).toBe(1)
    expect(feeReads).toBe(1)
    expect(authorityChecks).toBe(1)
    expect(historyReads).toEqual([
      CHECKOUT_OUTGOING_ID,
      CHECKOUT_OUTGOING_ID,
      CHECKOUT_OUTGOING_ID,
    ])
  })

  it("rechecks buyer authority after delayed exact history before a frozen send", async () => {
    const historyEntered = deferred<void>()
    const releaseHistory = deferred<void>()
    let buyerActive = true
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        historyEntered.resolve(undefined)
        await releaseHistory.promise
        return undefined
      },
      async getLightningSendFeeEstimate() {
        return 1
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("stale buyer must not send")
      },
    })
    const client = await openClient(createFactory(wallet))
    const sending = client.sendCheckoutLightningObligation?.({
      network: "mainnet",
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
      assertBeforeSend: async () => {
        if (!buyerActive) throw new Error("buyer signed out")
      },
    })
    await historyEntered.promise
    buyerActive = false
    releaseHistory.resolve(undefined)
    await expect(sending).rejects.toThrow("buyer signed out")
    expect(sendCalls).toBe(0)
  })

  it("rechecks takeover after delayed fee preflight before a frozen send", async () => {
    const feeEntered = deferred<void>()
    const releaseFee = deferred<void>()
    let now = 10
    const takeoverAt = 11
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        return undefined
      },
      async getLightningSendFeeEstimate() {
        feeEntered.resolve(undefined)
        await releaseFee.promise
        return 1
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("expired authority must not send")
      },
    })
    const client = await openClient(createFactory(wallet))
    const sending = client.sendCheckoutLightningObligation?.({
      network: "mainnet",
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
      assertBeforeSend: async () => {
        if (now >= takeoverAt) throw new Error("shopper takeover elapsed")
      },
    })
    await feeEntered.promise
    now = takeoverAt
    releaseFee.resolve(undefined)
    await expect(sending).rejects.toThrow("shopper takeover elapsed")
    expect(sendCalls).toBe(0)
  })

  it("retries the same frozen ID after fees change 2 to 6 to 2 before SDK send", async () => {
    const feeCapError = new Error("maxFeeSats does not cover fee estimate")
    const feeEstimates = [2, 2, 6, 2, 2, 2]
    const feeReads: number[] = []
    const transferIds: string[] = []
    let irreversibleSends = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        const next = feeEstimates.shift()
        if (next === undefined) throw new Error("unexpected fee estimate")
        feeReads.push(next)
        return next
      },
      async payLightningInvoice(input) {
        // Model the pinned SDK's own fee check, which follows the adapter's
        // second preflight but precedes selectLeavesAndExecute.
        const sdkFee = await wallet.getLightningSendFeeEstimate({
          encodedInvoice: input.invoice,
        })
        if (sdkFee > input.maxFeeSats) throw feeCapError
        irreversibleSends += 1
        transferIds.push(input.transferId?.toString() ?? "")
        return {
          id: "checkout-lightning-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: sdkFee, originalUnit: "SATOSHI" },
        }
      },
      async getTransferFromSsp(id) {
        if (irreversibleSends === 0) return undefined
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "checkout-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: CHECKOUT_OUTGOING_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {
        isPreSendFeeCapError: (error) => error === feeCapError,
      })
    )
    const request = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
      completionTimeoutSecs: 0,
      assertBeforeSend: async () => {},
    }

    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("ready")
    await expect(
      client.sendCheckoutLightningObligation?.(request)
    ).resolves.toEqual({ status: "not_sent", reason: "fee_over_cap" })
    expect(irreversibleSends).toBe(0)

    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("ready")
    await expect(
      client.sendCheckoutLightningObligation?.(request)
    ).resolves.toMatchObject({ status: "paid" })
    expect(feeReads).toEqual([2, 2, 6, 2, 2, 2])
    expect(transferIds).toEqual([CHECKOUT_OUTGOING_ID])
  })

  it.each([
    "SDK internal fee estimate unavailable",
    "response lost after provider send",
  ])("does not classify an unproven SDK error: %s", async (message) => {
    let feeReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeReads += 1
        return 2
      },
      async payLightningInvoice() {
        throw new Error(message)
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
      assertBeforeSend: async () => {},
    }

    await expect(
      client.sendCheckoutLightningObligation?.(request)
    ).rejects.toThrow(message)
    expect(feeReads).toBe(1)
  })

  it("preflights a frozen fee without sending and can recheck the same ID", async () => {
    let fee: number | "unavailable" = 6
    let historyReads = 0
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        historyReads += 1
        return undefined
      },
      async getLightningSendFeeEstimate() {
        if (fee === "unavailable") throw new Error("quote unavailable")
        return fee
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("preflight must never send")
      },
    })
    const client = await openClient(createFactory(wallet))
    const request = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
    }

    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("fee_over_cap")
    fee = "unavailable"
    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("unavailable")
    fee = 0
    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("ready")
    fee = 2
    await expect(
      client.preflightCheckoutLightningObligation?.(request)
    ).resolves.toBe("ready")
    expect(historyReads).toBe(0)
    expect(sendCalls).toBe(0)
  })

  it("does not send a frozen leg when exact history is unavailable", async () => {
    let feeReads = 0
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        throw new Error("exact history unavailable")
      },
      async getLightningSendFeeEstimate() {
        feeReads += 1
        return 1
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("must not send without exact history")
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.sendCheckoutLightningObligation?.({
        network: "mainnet",
        transferId: CHECKOUT_OUTGOING_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        assertBeforeSend: async () => {},
      })
    ).resolves.toEqual({ status: "ambiguous" })
    expect(feeReads).toBe(0)
    expect(sendCalls).toBe(0)
  })

  it("rejects a manager checkout leg with altered network or amount before provider access", async () => {
    let historyReads = 0
    let sendCalls = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        historyReads += 1
        return undefined
      },
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        sendCalls += 1
        throw new Error("must not send an altered checkout leg")
      },
    })
    const manager = new SparkWalletManager(createFactory(wallet), async () => ({
      async release() {},
    }))
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })
    const obligation = {
      network: "mainnet" as const,
      transferId: CHECKOUT_OUTGOING_ID,
      paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
      amountSats: 1_000,
      maxFeeSats: 5,
      assertBeforeSend: async () => {},
    }

    await expect(
      manager.sendCheckoutLightningObligation("wallet-personal", {
        ...obligation,
        network: "regtest",
      })
    ).rejects.toThrow("another network")
    await expect(
      manager.sendCheckoutLightningObligation("wallet-personal", {
        ...obligation,
        amountSats: 1_001,
      })
    ).rejects.toThrow("invalid Lightning invoice")
    await expect(
      manager.preflightCheckoutLightningObligation("wallet-personal", {
        ...obligation,
        network: "regtest",
      })
    ).rejects.toThrow("another network")
    await expect(
      manager.preflightCheckoutLightningObligation("wallet-personal", {
        ...obligation,
        amountSats: 1_001,
      })
    ).rejects.toThrow("invalid Lightning invoice")
    await expect(
      manager.preflightCheckoutLightningObligation(
        "wallet-personal",
        obligation
      )
    ).resolves.toBe("ready")
    expect(historyReads).toBe(0)
    expect(sendCalls).toBe(0)
    await manager.close("wallet-personal")
  })

  it("applies Spark's proportional Lightning fee cap above the minimum", async () => {
    const payCalls: Array<{ maxFeeSats: number }> = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 3
      },
      async payLightningInvoice(input) {
        payCalls.push(input)
        return {
          id: "proportional-fee-request",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        return {
          id: "proportional-fee-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 10_000n,
    })

    expect(prepared.paymentMethod).toEqual({
      lightningFeeSats: 17,
      type: "bolt11Invoice",
    })

    await client.sendPayment({
      prepareResponse: prepared,
      options: {
        type: "bolt11Invoice",
        preferSpark: false,
        completionTimeoutSecs: 5,
      },
    })

    expect(payCalls).toEqual([
      expect.objectContaining({
        maxFeeSats: 17,
      }),
    ])
  })

  it("rejects a regtest Lightning invoice before quoting from a mainnet wallet", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet))
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      network: "regtest",
    })

    await expect(
      client.prepareSendPayment({
        paymentRequest: { type: "input", input: invoice },
        amount: 1_000n,
      })
    ).rejects.toThrow("different Bitcoin network")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects a mainnet Lightning invoice before quoting from a regtest wallet", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet, {}, "regtest"))
    const invoice = makeReceiveInvoice({
      amountSats: 1_000,
      network: "mainnet",
    })

    await expect(
      client.prepareSendPayment({
        paymentRequest: { type: "input", input: invoice },
        amount: 1_000n,
      })
    ).rejects.toThrow("different Bitcoin network")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects an invalid Lightning amount component before quoting", async () => {
    let feeQuoteRequested = false
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        feeQuoteRequested = true
        return 0
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.prepareSendPayment({
        paymentRequest: {
          type: "input",
          input: makeInvalidAmountReceiveInvoice("mainnet"),
        },
        amount: 10n,
      })
    ).rejects.toThrow("invalid amount")
    expect(feeQuoteRequested).toBe(false)
  })

  it("rejects an unexpected native transfer result from a Lightning payment", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "unexpected-direct-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 1_000,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).rejects.toThrow(
      "Spark returned an unexpected direct transfer for a Lightning payment."
    )
    expect(payCalls).toBe(1)
  })

  it("keeps an unexpected Lightning transfer result ambiguous for retries", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "unexpected-direct-transfer",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 1_000,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
        }
      },
    })
    const manager = new SparkWalletManager(createFactory(wallet), async () => ({
      async release() {},
    }))
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    const first = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })

    expect(first).toEqual({
      status: "ambiguous",
      reason:
        "Spark returned an unexpected direct transfer for a Lightning payment. Check the wallet before retrying.",
    })
    expect(duplicate).toEqual(first)
    expect(payCalls).toBe(1)
  })

  it("rejects a completed Lightning proof whose preimage does not match the prepared invoice", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-mismatched-proof",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 0, originalUnit: "SATOSHI" },
          paymentPreimage: "11".repeat(32),
        }
      },
    })
    const client = await openClient(createFactory(wallet))
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).rejects.toThrow(
      "Spark returned a Lightning preimage that does not match the prepared invoice."
    )
    expect(payCalls).toBe(1)
  })

  it("keeps a mismatched Lightning proof ambiguous instead of recording it paid", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-mismatched-proof",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 0, originalUnit: "SATOSHI" },
          paymentPreimage: "11".repeat(32),
        }
      },
    })
    const manager = new SparkWalletManager(createFactory(wallet), async () => ({
      async release() {},
    }))
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    const first = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: PAYMENT_ATTEMPT_ID,
      approveFee: async () => true,
    })

    expect(first).toEqual({
      status: "ambiguous",
      reason:
        "Spark returned a Lightning preimage that does not match the prepared invoice. Check the wallet before retrying.",
    })
    expect(duplicate).toEqual(first)
    expect(payCalls).toBe(1)
  })

  it("polls a pending Lightning request without publishing it again", async () => {
    let now = 0
    let payCalls = 0
    const requestIds: string[] = []
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-pending",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest(id) {
        requestIds.push(id)
        return {
          id,
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress() {
          throw new Error("not a Spark address")
        },
        async initialize() {
          return { wallet }
        },
      }),
      pollIntervalMs: 100,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds
      },
    })
    const client = await openClient(factory)
    const prepared = await client.prepareSendPayment({
      paymentRequest: { type: "input", input: ZERO_PREIMAGE_INVOICE },
      amount: 1_000n,
    })

    await expect(
      client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
          completionTimeoutSecs: 0.25,
        },
        idempotencyKey: PAYMENT_ATTEMPT_ID,
      })
    ).resolves.toMatchObject({
      payment: {
        id: "lightning-pending",
        status: "pending",
      },
    })
    expect(payCalls).toBe(1)
    expect(requestIds).toEqual([
      "lightning-pending",
      "lightning-pending",
      "lightning-pending",
    ])
  })

  it("keeps a live Lightning status lookup failure ambiguous with a useful reason", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 2
      },
      async payLightningInvoice() {
        payCalls += 1
        return {
          id: "lightning-pending",
          status: "LIGHTNING_PAYMENT_INITIATED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        throw new Error("provider unavailable")
      },
    })
    const manager = new SparkWalletManager(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      }),
      async () => ({ async release() {} })
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: MNEMONIC,
      accountNumber: 1,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: ZERO_PREIMAGE_FIXED_INVOICE,
        amountMsats: 1_000_000,
        idempotencyKey: PAYMENT_ATTEMPT_ID,
        completionTimeoutSecs: 1,
        approveFee: async () => true,
      })
    ).resolves.toEqual({
      status: "ambiguous",
      reason:
        "Spark payment status could not be checked. Check the wallet before retrying.",
    })
    expect(payCalls).toBe(1)
    expect(statusReads).toBe(1)
  })

  it("recovers a lost Lightning response by transfer ID without paying again", async () => {
    let payCalls = 0
    const transferReads: string[] = []
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("The original response was lost.")
      },
      async getTransferFromSsp(id) {
        transferReads.push(id)
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      verifiedTransferTotalSats: 1_002,
      payment: {
        id: "recovered-lightning-request",
        status: "completed",
        fees: 2n,
        details: {
          type: "lightning",
          htlcDetails: {
            paymentHash: ZERO_PREIMAGE_PAYMENT_HASH,
            preimage: ZERO_PREIMAGE,
          },
        },
      },
    })
    expect(transferReads).toEqual([PAYMENT_ATTEMPT_ID])
    expect(payCalls).toBe(0)
  })

  it("recovers an uppercase persisted invoice from lowercase Spark evidence", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: {
            originalValue: 1_002_000,
            originalUnit: "MILLISATOSHI",
          },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE.toUpperCase(),
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      payment: { status: "completed" },
    })
    expect(payCalls).toBe(0)
  })

  it("rejects amountless recovery when the recovered amount differs", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 2_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: ZERO_PREIMAGE,
            encodedInvoice: ZERO_PREIMAGE_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 0,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark cannot safely reconcile an amountless Lightning invoice.",
    })
    expect(payCalls).toBe(0)
  })

  it("rejects a fixed invoice that differs from the approved amount", async () => {
    let transferReads = 0
    const wallet = createNativeWallet({
      async getTransferFromSsp() {
        transferReads += 1
        return undefined
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 999,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason:
        "The persisted Lightning invoice does not match the approved amount.",
    })
    expect(transferReads).toBe(0)
  })

  it("rejects missing, malformed, or inconsistent recovered transfer totals", async () => {
    const cases = [
      { name: "missing", totalAmount: undefined },
      {
        name: "unsupported unit",
        totalAmount: { originalValue: 1_002, originalUnit: "BITCOIN" },
      },
      {
        name: "inconsistent amount",
        totalAmount: { originalValue: 2_002, originalUnit: "SATOSHI" },
      },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp(id) {
          return {
            sparkId: id,
            ...(testCase.totalAmount === undefined
              ? {}
              : { totalAmount: testCase.totalAmount }),
            userRequest: {
              id: "recovered-lightning-request",
              status: "LIGHTNING_PAYMENT_SUCCEEDED",
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: ZERO_PREIMAGE,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toEqual({
        status: "conflicting_evidence",
        reason: "Spark returned a conflicting Lightning transfer total.",
      })
      expect(payCalls, testCase.name).toBe(0)
    }
  })

  it("keeps absent Lightning request evidence unresolved while rejecting present malformed evidence", async () => {
    for (const userRequest of [undefined, null, {}, false]) {
      let payCalls = 0
      let statusReads = 0
      const transferReads: string[] = []
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp(id) {
          transferReads.push(id)
          return {
            sparkId: id,
            totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
            ...(userRequest === undefined ? {} : { userRequest }),
          }
        },
        async getLightningSendRequest() {
          statusReads += 1
          throw new Error("must not poll without a recovered request")
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
        })
      ).resolves.toEqual(
        userRequest === undefined || userRequest === null
          ? { status: "lookup_unavailable" }
          : {
              status: "conflicting_evidence",
              reason: "Spark returned invalid Lightning recovery evidence.",
            }
      )
      expect(transferReads).toEqual([PAYMENT_ATTEMPT_ID])
      expect(statusReads).toBe(0)
      expect(payCalls).toBe(0)
    }
  })

  it("keeps a missing transfer unresolved without paying again", async () => {
    let payCalls = 0
    const transferReads: string[] = []
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        transferReads.push(id)
        return undefined
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({ status: "not_found" })
    expect(transferReads).toEqual([PAYMENT_ATTEMPT_ID])
    expect(payCalls).toBe(0)
  })

  it("keeps an unavailable transfer lookup unresolved without paying again", async () => {
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp() {
        throw new Error("provider unavailable")
      },
    })
    const client = await openClient(createFactory(wallet))

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
      })
    ).resolves.toEqual({ status: "lookup_unavailable" })
    expect(payCalls).toBe(0)
  })

  it("keeps an unavailable Lightning status lookup unresolved without paying again", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        throw new Error("provider unavailable")
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({ status: "lookup_unavailable" })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("rejects a polled Lightning fee that conflicts with the recovered transfer total", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        return {
          id: "recovered-lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark returned a conflicting Lightning transfer total.",
    })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("rejects a polled Lightning status for a different recovered request", async () => {
    let now = 0
    let payCalls = 0
    let statusReads = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        statusReads += 1
        return {
          id: "different-lightning-request",
          status: "LIGHTNING_PAYMENT_FAILED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
          paymentPreimage: null,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toEqual({
      status: "conflicting_evidence",
      reason: "Spark returned a conflicting Lightning request identity.",
    })
    expect(statusReads).toBe(1)
    expect(payCalls).toBe(0)
  })

  it("resolves an identity-consistent polled Lightning transition", async () => {
    let now = 0
    let payCalls = 0
    const wallet = createNativeWallet({
      async payLightningInvoice() {
        payCalls += 1
        throw new Error("must not pay during reconciliation")
      },
      async getTransferFromSsp(id) {
        return {
          sparkId: id,
          totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
          userRequest: {
            id: "recovered-lightning-request",
            status: "LIGHTNING_PAYMENT_INITIATED",
            fee: { originalValue: 2, originalUnit: "SATOSHI" },
            paymentPreimage: null,
            encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
            idempotencyKey: PAYMENT_ATTEMPT_ID,
            typename: "LightningSendRequest",
          },
        }
      },
      async getLightningSendRequest() {
        return {
          id: "recovered-lightning-request",
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 2, originalUnit: "SATOSHI" },
          paymentPreimage: ZERO_PREIMAGE,
        }
      },
    })
    const client = await openClient(
      createFactory(wallet, {}, "mainnet", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds
        },
        pollIntervalMs: 100,
      })
    )

    await expect(
      client.reconcileLightningSend?.({
        transferId: PAYMENT_ATTEMPT_ID,
        paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
        amountSats: 1_000,
        maxFeeSats: 5,
        completionTimeoutSecs: 1,
      })
    ).resolves.toMatchObject({
      status: "resolved",
      payment: {
        id: "recovered-lightning-request",
        status: "completed",
      },
    })
    expect(payCalls).toBe(0)
  })

  it("fails closed on conflicting recovered Lightning evidence", async () => {
    const cases = [
      {
        name: "transfer identity",
        transferId: "different-transfer-id",
        request: {},
        message: "Spark returned a conflicting transfer identity.",
      },
      {
        name: "request kind",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { typename: "LightningReceiveRequest" },
        message: "Spark returned invalid Lightning recovery evidence.",
      },
      {
        name: "malformed payment preimage",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { paymentPreimage: 123 },
        message: "Spark returned invalid Lightning recovery evidence.",
      },
      {
        name: "idempotency identity",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { idempotencyKey: "different-attempt-id" },
        message: "Spark returned a conflicting Lightning payment identity.",
      },
      {
        name: "invoice identity",
        transferId: PAYMENT_ATTEMPT_ID,
        request: { encodedInvoice: "lnbc1different" },
        message: "Spark returned a different Lightning invoice.",
      },
      {
        name: "mixed-case invoice",
        transferId: PAYMENT_ATTEMPT_ID,
        request: {
          encodedInvoice: `L${ZERO_PREIMAGE_FIXED_INVOICE.slice(1)}`,
        },
        message: "Spark returned a different Lightning invoice.",
      },
      {
        name: "approved fee cap",
        transferId: PAYMENT_ATTEMPT_ID,
        request: {
          fee: { originalValue: 6, originalUnit: "SATOSHI" },
        },
        message: "Spark returned a Lightning fee above the approved maximum.",
      },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp() {
          return {
            sparkId: testCase.transferId,
            userRequest: {
              id: "recovered-lightning-request",
              status: "LIGHTNING_PAYMENT_SUCCEEDED",
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: ZERO_PREIMAGE,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
              ...testCase.request,
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toEqual({
        status: "conflicting_evidence",
        reason: testCase.message,
      })
      expect(payCalls, testCase.name).toBe(0)
    }
  })

  it("preserves recovered pending and failed Lightning outcomes", async () => {
    const cases = [
      { providerStatus: "LIGHTNING_PAYMENT_INITIATED", status: "pending" },
      { providerStatus: "LIGHTNING_PAYMENT_FAILED", status: "failed" },
    ] as const

    for (const testCase of cases) {
      let payCalls = 0
      const wallet = createNativeWallet({
        async payLightningInvoice() {
          payCalls += 1
          throw new Error("must not pay during reconciliation")
        },
        async getTransferFromSsp(id) {
          return {
            sparkId: id,
            totalAmount: { originalValue: 1_002, originalUnit: "SATOSHI" },
            userRequest: {
              id: "recovered-lightning-request",
              status: testCase.providerStatus,
              fee: { originalValue: 2, originalUnit: "SATOSHI" },
              paymentPreimage: null,
              encodedInvoice: ZERO_PREIMAGE_FIXED_INVOICE,
              idempotencyKey: PAYMENT_ATTEMPT_ID,
              typename: "LightningSendRequest",
            },
          }
        },
      })
      const client = await openClient(createFactory(wallet))

      await expect(
        client.reconcileLightningSend?.({
          transferId: PAYMENT_ATTEMPT_ID,
          paymentRequest: ZERO_PREIMAGE_FIXED_INVOICE,
          amountSats: 1_000,
          maxFeeSats: 5,
          completionTimeoutSecs: 0,
        })
      ).resolves.toMatchObject({
        status: "resolved",
        payment: { status: testCase.status },
      })
      expect(payCalls).toBe(0)
    }
  })

  it("subscribes to concrete native wallet events and removes every listener", async () => {
    const nativeListeners = new Map<string, (...args: unknown[]) => void>()
    const removedEvents: string[] = []
    const wallet = createNativeWallet({
      on(event, listener) {
        nativeListeners.set(event, listener)
      },
      off(event, listener) {
        if (nativeListeners.get(event) === listener) {
          nativeListeners.delete(event)
          removedEvents.push(event)
        }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update", "transfer:claimed"],
        parseTransferId: parseTestTransferId,
        createPublicReadonlyClient: createHiddenPublicReadonlyClient,
        decodeSparkAddress: () => ({}),
        getNetworkFromSparkAddress: () => "MAINNET",
        isValidSparkAddress: () => true,
        async initialize() {
          return { wallet }
        },
      }),
      wait: async () => undefined,
    })
    const client = await openClient(factory)
    let invalidations = 0
    const listenerId = await client.addEventListener?.(() => {
      invalidations += 1
    })

    nativeListeners.get("balance:update")?.({ available: 100n })
    nativeListeners.get("transfer:claimed")?.("transfer-id", 100n)
    expect(invalidations).toBe(2)

    expect(
      await client.removeEventListener?.(listenerId ?? "missing-listener")
    ).toBe(true)
    expect(removedEvents).toEqual(["balance:update", "transfer:claimed"])
    expect(nativeListeners.size).toBe(0)
  })
})

function createHiddenPublicReadonlyClient() {
  return {
    async getAvailableBalance() {
      return 0n
    },
    async getOwnedBalance() {
      return 0n
    },
    async getTransfers() {
      return { transfers: [], offset: 0 }
    },
  }
}

function parseTestTransferId(
  value: string
): ReturnType<SparkNativeModule["parseTransferId"]> {
  return {
    toString: () => value,
  } as ReturnType<SparkNativeModule["parseTransferId"]>
}

async function waitForTestCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error("Timed out waiting for the deterministic test condition.")
}

function createFactory(
  wallet: SparkNativeWallet,
  moduleOverrides: Partial<SparkNativeModule> = {},
  network: "mainnet" | "regtest" = "mainnet",
  options: {
    now?: () => number
    wait?: (milliseconds: number) => Promise<void>
    pollIntervalMs?: number
    retirementReadTimeoutMs?: number
  } = {}
) {
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  return new FirstPartySparkSdkFactory({
    network,
    loadModule: async () => ({
      eventNames: ["balance:update"],
      parseTransferId: parseTestTransferId,
      inspectLightningReceiveQuote({ quote, receiverIdentityPubkey }) {
        const manifest = TransferManifest.decode(
          Buffer.from(quote.serializedManifest, "hex")
        )
        return {
          grossSats: manifestGrossSats(manifest),
          netSats: manifestNetSatsFor(
            manifest,
            parseCompressedPublicKeyHex(
              receiverIdentityPubkey,
              "receiverIdentityPubkey"
            )
          ),
          feeSats: manifestFeeSats(manifest),
          feeComponents: manifest.fees.length,
          expiresAt: manifest.quoteExpiryTime?.getTime() ?? 0,
        }
      },
      isPreSendFeeCapError: () => false,
      createPublicReadonlyClient: createHiddenPublicReadonlyClient,
      decodeSparkAddress: () => ({}),
      getNetworkFromSparkAddress: () => nativeNetwork,
      isValidSparkAddress(address) {
        if (address.startsWith("spark1")) return true
        throw new Error("not a Spark address")
      },
      async initialize() {
        return { wallet }
      },
      ...moduleOverrides,
    }),
    wait: options.wait ?? (async () => undefined),
    now: options.now,
    pollIntervalMs: options.pollIntervalMs,
    retirementReadTimeoutMs: options.retirementReadTimeoutMs,
  })
}

function emptyRetirementReader() {
  return {
    async getTransfers() {
      return { transfers: [], offset: -1 }
    },
    async getPendingTransfers() {
      return []
    },
    async getAvailableBalance() {
      return 0n
    },
    async getOwnedBalance() {
      return 0n
    },
  }
}

async function openClient(factory: FirstPartySparkSdkFactory) {
  return factory.open({
    walletId: "wallet-personal",
    mnemonic: MNEMONIC,
    accountNumber: getDefaultSparkAccountNumber(factory.network),
  })
}

function createNativeWallet(
  overrides: Partial<SparkNativeWallet> = {}
): SparkNativeWallet {
  return {
    on() {},
    off() {},
    async cleanup() {},
    async setPrivacyEnabled(enabled) {
      return { privateEnabled: enabled }
    },
    async getWalletSettings() {
      return { privateEnabled: true }
    },
    async getBalance() {
      return {
        balance: 0n,
        satsBalance: { available: 0n, owned: 0n, incoming: 0n },
      }
    },
    async getTransfers() {
      return { transfers: [], offset: 0 }
    },
    async getSparkAddress() {
      return "spark1receive"
    },
    async getTransfer() {
      return undefined
    },
    async getTransferFromSsp() {
      return undefined
    },
    async transfer(input) {
      return {
        id: "native-transfer",
        status: "TRANSFER_STATUS_COMPLETED",
        totalValue: input.amountSats,
        type: "TRANSFER",
        transferDirection: "OUTGOING",
      }
    },
    async createLightningInvoice() {
      return createLightningReceiveResult(makeReceiveInvoice())
    },
    async getIdentityPublicKey() {
      return RECEIVE_IDENTITY_KEY
    },
    async getLightningReceiveQuote({ amountSats }) {
      return testReceiveQuote(amountSats)
    },
    async getLightningReceiveRequest() {
      return null
    },
    async getLightningSendFeeEstimate() {
      return 0
    },
    async payLightningInvoice() {
      return {
        id: "lightning-request",
        status: "LIGHTNING_PAYMENT_INITIATED",
        fee: { originalValue: 0, originalUnit: "SATOSHI" },
      }
    },
    async getLightningSendRequest() {
      return null
    },
    ...overrides,
  }
}

function makeLightningInvoice(
  paymentHashHex: string,
  amountSats?: number,
  options: { createdAt?: number; expirySeconds?: number } = {}
): string {
  const paymentHash = Uint8Array.from(
    paymentHashHex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  )
  return makeSignedBolt11Fixture({
    hrp: amountSats === undefined ? "lnbc" : `lnbc${amountSats * 10}n`,
    createdAt: options.createdAt,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(paymentHash),
      },
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      ...(options.expirySeconds === undefined
        ? []
        : [{ tag: "x", words: numberToBolt11Words(options.expirySeconds) }]),
    ],
  })
}

function makeReceiveInvoice({
  amountSats,
  createdAt = 1_800_000_000,
  expirySeconds,
  network = "mainnet",
  includePaymentHash = true,
}: {
  amountSats?: number
  createdAt?: number
  expirySeconds?: number
  network?: "mainnet" | "regtest"
  includePaymentHash?: boolean
} = {}): string {
  const prefix = network === "mainnet" ? "lnbc" : "lnbcrt"
  const hrp = amountSats === undefined ? prefix : `${prefix}${amountSats * 10}n`
  return makeBolt11Fixture({
    hrp,
    createdAt,
    fields: [
      ...(includePaymentHash
        ? [
            {
              tag: "p",
              words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
            },
          ]
        : []),
      ...(expirySeconds === undefined
        ? []
        : [{ tag: "x", words: numberToBolt11Words(expirySeconds) }]),
    ],
  })
}

function createLightningReceiveResult(
  paymentRequest: string,
  overrides: {
    id?: string
    status?: string
    network?: string
    bitcoinNetwork?: string
    paymentHash?: string
    createdAt?: string
    expiresAt?: string
    transfer?: {
      totalAmount: { originalValue: number; originalUnit: string }
      userRequestId?: string
      sparkId?: string
    }
  } = {}
) {
  const metadata = decodeLightningInvoiceMetadata(paymentRequest)
  const invoiceNetwork = getLightningInvoiceNetwork(paymentRequest)
  const nativeNetwork = invoiceNetwork === "regtest" ? "REGTEST" : "MAINNET"
  const amount = decodeLightningInvoiceAmount(paymentRequest)
  return {
    id: overrides.id ?? "lightning-receive",
    status: overrides.status ?? "INVOICE_CREATED",
    network: overrides.network ?? nativeNetwork,
    transfer: overrides.transfer,
    invoice: {
      encodedInvoice: paymentRequest,
      bitcoinNetwork: overrides.bitcoinNetwork ?? nativeNetwork,
      paymentHash:
        overrides.paymentHash ??
        decodeLightningInvoicePaymentHash(paymentRequest) ??
        "07".repeat(32),
      amount: {
        originalValue: amount.sats ?? 0,
        originalUnit: "SATOSHI",
      },
      createdAt:
        overrides.createdAt ??
        new Date((metadata.createdAt ?? 0) * 1_000).toISOString(),
      expiresAt:
        overrides.expiresAt ??
        new Date((metadata.expiresAt ?? 0) * 1_000).toISOString(),
    },
  }
}

function numberToBolt11Words(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid BOLT11 numeric fixture")
  }
  const words: number[] = []
  let remaining = BigInt(value)
  do {
    words.unshift(Number(remaining & 31n))
    remaining >>= 5n
  } while (remaining > 0n)
  return words
}

function makeInvalidAmountReceiveInvoice(
  network: "mainnet" | "regtest"
): string {
  return makeBolt11Fixture({
    hrp: `${network === "mainnet" ? "lnbc" : "lnbcrt"}1p`,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
      },
    ],
  })
}
