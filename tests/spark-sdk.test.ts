import { describe, expect, it } from "bun:test"

import {
  FirstPartySparkSdkFactory,
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkConfigurationForNetwork,
  type SparkNativeModule,
  type SparkNativeWallet,
} from "../apps/market/src/lib/spark-sdk"
import { MemorySparkDirectTransferSafetyStore } from "../apps/market/src/lib/spark-direct-transfer-safety"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { bytesToBolt11Words, makeBolt11Fixture } from "./support/bolt11-fixture"

const MNEMONIC = "abandon ".repeat(11) + "about"
const ZERO_PREIMAGE = "00".repeat(32)
const ZERO_PREIMAGE_PAYMENT_HASH =
  "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
const ZERO_PREIMAGE_INVOICE = makeLightningInvoice(ZERO_PREIMAGE_PAYMENT_HASH)

describe("first-party Spark SDK adapter", () => {
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
        return { balance: 21_000n }
      },
    })
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => ({
        eventNames: ["balance:update"],
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
      seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
        seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
      seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
        seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
        seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
        sparkTransferFeeSats: 0,
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
      idempotencyKey?: string
    }> = []
    let requestReads = 0
    const wallet = createNativeWallet({
      async getLightningSendFeeEstimate() {
        return 3
      },
      async payLightningInvoice(input) {
        payCalls.push(input)
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
      idempotencyKey: "order-123",
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
        idempotencyKey: "order-123",
        invoice: ZERO_PREIMAGE_INVOICE,
        maxFeeSats: 5,
        preferSpark: false,
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
        idempotencyKey: "order-unexpected-transfer",
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
      idempotencyKey: "order-unexpected-transfer",
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: "order-unexpected-transfer",
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
        idempotencyKey: "order-mismatched-proof",
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
      idempotencyKey: "order-mismatched-proof",
      approveFee: async () => true,
    })
    const duplicate = await manager.payInvoice("wallet-personal", {
      invoice: ZERO_PREIMAGE_INVOICE,
      amountMsats: 1_000_000,
      idempotencyKey: "order-mismatched-proof",
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
        idempotencyKey: "order-pending",
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
  network: "mainnet" | "regtest" = "mainnet"
) {
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  return new FirstPartySparkSdkFactory({
    network,
    loadModule: async () => ({
      eventNames: ["balance:update"],
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
    wait: async () => undefined,
  })
}

async function openClient(factory: FirstPartySparkSdkFactory) {
  return factory.open({
    walletId: "wallet-personal",
    seed: { type: "mnemonic", mnemonic: MNEMONIC },
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
      return { balance: 0n }
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
      return {
        id: "lightning-receive",
        status: "INVOICE_CREATED",
        invoice: {
          encodedInvoice: "lnbc1receive",
        },
      }
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

function makeLightningInvoice(paymentHashHex: string): string {
  const paymentHash = Uint8Array.from(
    paymentHashHex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  )
  return makeBolt11Fixture({
    hrp: "lnbc",
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(paymentHash),
      },
    ],
  })
}

function makeReceiveInvoice({
  amountSats,
  network = "mainnet",
  includePaymentHash = true,
}: {
  amountSats?: number
  network?: "mainnet" | "regtest"
  includePaymentHash?: boolean
} = {}): string {
  const prefix = network === "mainnet" ? "lnbc" : "lnbcrt"
  const hrp = amountSats === undefined ? prefix : `${prefix}${amountSats * 10}n`
  return makeBolt11Fixture({
    hrp,
    fields: includePaymentHash
      ? [
          {
            tag: "p",
            words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
          },
        ]
      : [],
  })
}

function createLightningReceiveResult(paymentRequest: string) {
  return {
    id: "lightning-receive",
    status: "INVOICE_CREATED",
    invoice: {
      encodedInvoice: paymentRequest,
    },
  }
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
