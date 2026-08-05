import { describe, expect, it } from "bun:test"

import {
  SparkWalletManager,
  type SparkPreparedPayment,
  type SparkSdkClient,
  type SparkSdkFactory,
  type SparkSdkPayment,
} from "../apps/market/src/lib/spark-wallet"
import { MemorySparkDirectTransferSafetyStore } from "../apps/market/src/lib/spark-direct-transfer-safety"
import { bytesToBolt11Words, makeBolt11Fixture } from "./support/bolt11-fixture"

describe("SparkWalletManager", () => {
  it("prepares and confirms a fixed-amount Lightning send without spending before review", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(3)),
        },
      ],
    })
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 5_000 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment(request) {
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 5,
              },
              amount: request.amount ?? 1_000n,
            }
          },
          async sendPayment() {
            sendCalls += 1
            return {
              payment: {
                id: "wallet-lightning-send",
                status: "completed",
                fees: 5n,
                details: {
                  type: "lightning",
                  htlcDetails: {
                    paymentHash: "payment-hash",
                    preimage: "payment-preimage",
                  },
                },
              },
            }
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    const quote = await manager.prepareSend("wallet-personal", {
      destination: {
        type: "lightning_invoice",
        invoice,
      },
      amount: { type: "invoice" },
    })

    expect(quote).toMatchObject({
      method: "lightning",
      amountMode: "invoice",
      amountSats: 1_000,
      feeSats: 5,
      totalSats: 1_005,
      remainingSats: 3_995,
    })
    expect(sendCalls).toBe(0)

    await expect(
      manager.confirmSend("wallet-personal", quote.id)
    ).resolves.toEqual({
      status: "sent",
      method: "lightning",
      paymentId: "wallet-lightning-send",
      amountSats: 1_000,
      feeSats: 5,
      preimage: "payment-preimage",
      paymentHash: "payment-hash",
    })
    expect(sendCalls).toBe(1)
  })

  it("uses an explicit amount for an amountless Lightning invoice", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(4)),
        },
      ],
    })
    const preparedAmounts: Array<bigint | undefined> = []
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 500 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment(request) {
            preparedAmounts.push(request.amount)
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 5,
              },
              amount: request.amount ?? 0n,
            }
          },
          async sendPayment() {
            throw new Error("Nothing should send while preparing.")
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: {
          type: "lightning_invoice",
          invoice,
        },
        amount: { type: "exact", amountSats: 250 },
      })
    ).resolves.toMatchObject({
      method: "lightning",
      amountMode: "exact",
      amountSats: 250,
      feeSats: 5,
      totalSats: 255,
      remainingSats: 245,
    })
    expect(preparedAmounts).toEqual([250n])
  })

  it("prepares the largest safe amount for a maximum Lightning send", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(5)),
        },
      ],
    })
    const preparedAmounts: bigint[] = []
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 500 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment(request) {
            const amount = request.amount ?? 0n
            preparedAmounts.push(amount)
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 5,
              },
              amount,
            }
          },
          async sendPayment() {
            throw new Error("Nothing should send while preparing.")
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: {
          type: "lightning_invoice",
          invoice,
        },
        amount: { type: "max" },
      })
    ).resolves.toMatchObject({
      method: "lightning",
      amountMode: "max",
      amountSats: 495,
      feeSats: 5,
      totalSats: 500,
      remainingSats: 0,
    })
    expect(preparedAmounts).toEqual([500n, 495n])
  })

  it("keeps the largest affordable maximum quote when the fee estimate changes", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(6)),
        },
      ],
    })
    const preparedAmounts: bigint[] = []
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          ...createSendTestClient(),
          async getInfo() {
            return { balanceSats: 500 }
          },
          async prepareSendPayment(request) {
            const amount = request.amount ?? 0n
            preparedAmounts.push(amount)
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: amount >= 497n ? 4 : 3,
              },
              amount,
            }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: {
          type: "lightning_invoice",
          invoice,
        },
        amount: { type: "max" },
      })
    ).resolves.toMatchObject({
      amountSats: 496,
      feeSats: 3,
      totalSats: 499,
      remainingSats: 1,
    })
    expect(preparedAmounts).toEqual([500n, 496n, 497n])
  })

  it("keeps direct Spark transfers behind the same reviewed send flow", async () => {
    let sentOptions: string | undefined
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 500 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment(request) {
            return {
              paymentMethod: {
                type: "sparkAddress",
                fee: "0",
              },
              amount: request.amount ?? 0n,
            }
          },
          async sendPayment(request) {
            sentOptions = request.options?.type
            return {
              payment: {
                id: "direct-spark-send",
                status: "completed",
                fees: 0n,
              },
            }
          },
          async receivePayment() {
            return { paymentRequest: "spark1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    const quote = await manager.prepareSend("wallet-personal", {
      destination: {
        type: "spark_address",
        address: "spark1recipient",
      },
      amount: { type: "exact", amountSats: 200 },
    })

    expect(quote).toMatchObject({
      method: "spark",
      amountMode: "exact",
      amountSats: 200,
      feeSats: 0,
      totalSats: 200,
      remainingSats: 300,
    })
    await expect(
      manager.confirmSend("wallet-personal", quote.id)
    ).resolves.toEqual({
      status: "sent",
      method: "spark",
      paymentId: "direct-spark-send",
      amountSats: 200,
      feeSats: 0,
    })
    expect(sentOptions).toBe("sparkAddress")
  })

  it("rejects malformed, expired, hashless, and wrong-network Lightning invoices before preparing", async () => {
    const expiredInvoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      createdAt: 1,
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(8)),
        },
      ],
    })
    const hashlessInvoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [],
    })
    const testnetInvoice = makeBolt11Fixture({
      hrp: "lntb10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(9)),
        },
      ],
    })
    const invalidAmountInvoice = makeBolt11Fixture({
      hrp: "lnbc1p",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(10)),
        },
      ],
    })
    let prepareCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onPrepare(request) {
            prepareCalls += 1
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 1,
              },
              amount: request.amount ?? 0n,
            }
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    for (const [invoice, message] of [
      ["not-an-invoice", "valid BOLT11"],
      [expiredInvoice, "expired"],
      [hashlessInvoice, "payment hash"],
      [testnetInvoice, "different Bitcoin network"],
    ] as const) {
      await expect(
        manager.prepareSend("wallet-personal", {
          destination: { type: "lightning_invoice", invoice },
          amount: { type: "invoice" },
        })
      ).rejects.toThrow(message)
    }
    await expect(
      manager.prepareSend("wallet-personal", {
        destination: {
          type: "lightning_invoice",
          invoice: invalidAmountInvoice,
        },
        amount: { type: "exact", amountSats: 10 },
      })
    ).rejects.toThrow("invalid amount")
    expect(prepareCalls).toBe(0)
  })

  it("only allows maximum send for an amountless Lightning invoice", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(10)),
        },
      ],
    })
    let prepareCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onPrepare(request) {
            prepareCalls += 1
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 1,
              },
              amount: request.amount ?? 0n,
            }
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.prepareSend("wallet-personal", {
        destination: { type: "lightning_invoice", invoice },
        amount: { type: "max" },
      })
    ).rejects.toThrow("amountless Lightning invoice")
    expect(prepareCalls).toBe(0)
  })

  it("discards an unconfirmed quote without sending", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(11)),
        },
      ],
    })
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onSend() {
            sendCalls += 1
            throw new Error("Discarded quote must not send.")
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-personal", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    manager.discardSendQuote("wallet-personal", quote.id)

    await expect(
      manager.confirmSend("wallet-personal", quote.id)
    ).resolves.toMatchObject({ status: "failed" })
    expect(sendCalls).toBe(0)
  })

  it("deduplicates concurrent confirmation of the same send quote", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(12)),
        },
      ],
    })
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          async onSend() {
            sendCalls += 1
            await Promise.resolve()
            return completedLightningPayment()
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-personal", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    const results = await Promise.all([
      manager.confirmSend("wallet-personal", quote.id),
      manager.confirmSend("wallet-personal", quote.id),
    ])

    expect(results.map((result) => result.status)).toEqual(["sent", "sent"])
    expect(sendCalls).toBe(1)
  })

  it("binds each reviewed send quote to the wallet that prepared it", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(14)),
        },
      ],
    })
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onSend() {
            sendCalls += 1
            return completedLightningPayment()
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-one",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await manager.openWithMnemonic({
      walletId: "wallet-two",
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-one", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    await expect(manager.confirmSend("wallet-two", quote.id)).resolves.toEqual({
      status: "failed",
      reason: "This Spark send quote is no longer available.",
    })
    expect(sendCalls).toBe(0)
    await expect(
      manager.confirmSend("wallet-one", quote.id)
    ).resolves.toMatchObject({ status: "sent" })
    expect(sendCalls).toBe(1)
  })

  it("does not expose an in-flight send result to a different wallet", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(16)),
        },
      ],
    })
    let releaseSend: (() => void) | undefined
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          async onSend() {
            await sendGate
            return completedLightningPayment()
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-one",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await manager.openWithMnemonic({
      walletId: "wallet-two",
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-one", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    const correctWalletResult = manager.confirmSend("wallet-one", quote.id)
    const wrongWalletResult = manager.confirmSend("wallet-two", quote.id)
    releaseSend?.()

    await expect(wrongWalletResult).resolves.toEqual({
      status: "failed",
      reason: "This Spark send quote is no longer available.",
    })
    await expect(correctWalletResult).resolves.toMatchObject({ status: "sent" })
  })

  it("refuses a Lightning quote that expires during review without sending", async () => {
    const createdAt = 1_800_000_000
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      createdAt,
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(17)),
        },
      ],
    })
    let nowMs = (createdAt + 3_599) * 1_000
    let sendCalls = 0
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        async open() {
          return createSendTestClient({
            onSend() {
              sendCalls += 1
              return completedLightningPayment()
            },
          })
        },
      },
      undefined,
      undefined,
      () => nowMs
    )
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-personal", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })
    nowMs = (createdAt + 3_600) * 1_000

    await expect(
      manager.confirmSend("wallet-personal", quote.id)
    ).resolves.toEqual({
      status: "failed",
      reason:
        "This Lightning invoice expired during review. Request a new invoice.",
    })
    expect(sendCalls).toBe(0)
    expect(manager.hasUnresolvedSend("wallet-personal")).toBe(false)
  })

  it("clears the safety lock after Spark definitively reports a failed send", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(15)),
        },
      ],
    })
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onSend() {
            return {
              payment: {
                id: "failed-lightning-payment",
                status: "failed",
                fees: 0n,
                details: { type: "lightning" },
              },
            }
          },
        })
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const quote = await manager.prepareSend("wallet-personal", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    await expect(
      manager.confirmSend("wallet-personal", quote.id)
    ).resolves.toMatchObject({ status: "failed" })
    expect(manager.hasUnresolvedSend("wallet-personal")).toBe(false)
    await expect(
      manager.prepareSend("wallet-personal", {
        destination: { type: "lightning_invoice", invoice },
        amount: { type: "invoice" },
      })
    ).resolves.toMatchObject({ method: "lightning" })
  })

  it("persists an unresolved send safety lock across wallet registrations and both rails", async () => {
    const invoice = makeBolt11Fixture({
      hrp: "lnbc10000n",
      fields: [
        {
          tag: "p",
          words: bytesToBolt11Words(new Uint8Array(32).fill(13)),
        },
      ],
    })
    const safetyStore = new MemorySparkDirectTransferSafetyStore()
    const factory: SparkSdkFactory = {
      network: "mainnet",
      async open() {
        return createSendTestClient({
          onSend() {
            throw new Error("Transport disconnected after send.")
          },
        })
      },
    }
    const firstManager = new SparkWalletManager(factory, undefined, safetyStore)
    const mnemonic = "abandon ".repeat(11) + "about"
    await firstManager.openWithMnemonic({
      walletId: "wallet-original",
      mnemonic,
      accountNumber: 0,
    })
    const quote = await firstManager.prepareSend("wallet-original", {
      destination: { type: "lightning_invoice", invoice },
      amount: { type: "invoice" },
    })

    await expect(
      firstManager.confirmSend("wallet-original", quote.id)
    ).resolves.toMatchObject({ status: "ambiguous" })
    expect(firstManager.hasUnresolvedSend("wallet-original")).toBe(true)
    await firstManager.close("wallet-original")

    const restoredManager = new SparkWalletManager(
      factory,
      undefined,
      safetyStore
    )
    await restoredManager.openWithMnemonic({
      walletId: "wallet-restored",
      mnemonic,
      accountNumber: 0,
    })
    expect(restoredManager.hasUnresolvedSend("wallet-restored")).toBe(true)
    await expect(
      restoredManager.prepareSend("wallet-restored", {
        destination: {
          type: "spark_address",
          address: "spark1recipient",
        },
        amount: { type: "exact", amountSats: 50 },
      })
    ).rejects.toThrow("previous Spark payment is unresolved")

    restoredManager.acknowledgeUnresolvedSend("wallet-restored")

    expect(restoredManager.hasUnresolvedSend("wallet-restored")).toBe(false)
    await expect(
      restoredManager.prepareSend("wallet-restored", {
        destination: {
          type: "spark_address",
          address: "spark1recipient",
        },
        amount: { type: "exact", amountSats: 50 },
      })
    ).resolves.toMatchObject({ method: "spark", amountSats: 50 })
  })

  it("isolates each wallet, uses an explicit account, and returns Lightning proof", async () => {
    const openCalls: Array<{
      walletId: string
      accountNumber: number
    }> = []
    const sendCalls: Array<{
      idempotencyKey?: string
      optionsType?: string
    }> = []
    const client: SparkSdkClient = {
      async disconnect() {},
      async getInfo() {
        return { balanceSats: 21_000 }
      },
      async listPayments() {
        return { payments: [] }
      },
      async prepareSendPayment(request) {
        if (request.paymentRequest.input.startsWith("spark")) {
          return {
            paymentMethod: { type: "sparkAddress", fee: "3" },
            amount: request.amount ?? 1_000n,
          }
        }
        return {
          paymentMethod: { type: "bolt11Invoice", lightningFeeSats: 0 },
          amount: request.amount ?? 1_000n,
        }
      },
      async sendPayment(request) {
        sendCalls.push({
          idempotencyKey: request.idempotencyKey,
          optionsType: request.options?.type,
        })
        return {
          payment: {
            id: "spark-payment",
            status: "completed",
            fees: 2n,
            details: {
              type: "lightning",
              htlcDetails: {
                paymentHash: "payment-hash",
                preimage: "payment-preimage",
              },
            },
          },
        }
      },
      async receivePayment() {
        return { paymentRequest: "lnbc1receive", fee: 0n }
      },
    }
    const factory: SparkSdkFactory = {
      network: "mainnet",
      async open(input) {
        openCalls.push({
          walletId: input.walletId,
          accountNumber: input.accountNumber,
        })
        return client
      },
    }
    const manager = new SparkWalletManager(factory)

    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: "lnbc1checkout",
        amountMsats: 1_000_000,
        idempotencyKey: "order-123",
        approveFee: async (quote) => {
          expect(sendCalls).toHaveLength(0)
          expect(quote).toEqual({
            amountSats: 1_000,
            feeSats: 0,
            totalSats: 1_000,
          })
          return true
        },
      })
    ).resolves.toEqual({
      status: "paid",
      paymentId: "spark-payment",
      preimage: "payment-preimage",
      paymentHash: "payment-hash",
      feeMsats: 2_000,
    })
    expect(openCalls).toEqual([
      {
        walletId: "wallet-personal",
        accountNumber: 0,
      },
    ])
    const quote = await manager.prepareSparkTransfer("wallet-personal", {
      address: "spark1recipient",
      amountSats: 2_100,
    })
    expect(quote).toMatchObject({
      amountSats: 2_100,
      feeSats: 3,
    })

    await expect(
      manager.confirmSparkTransfer("wallet-personal", quote.id)
    ).resolves.toEqual({
      status: "sent",
      paymentId: "spark-payment",
      feeSats: 2,
    })

    expect(sendCalls).toEqual([
      {
        idempotencyKey: "order-123",
        optionsType: "bolt11Invoice",
      },
      {
        idempotencyKey: quote.attemptId,
        optionsType: "sparkAddress",
      },
    ])
  })

  it("does not offer a direct-transfer quote when Spark prepares another amount", async () => {
    let sendCalls = 0
    const client: SparkSdkClient = {
      async disconnect() {},
      async getInfo() {
        return { balanceSats: 21_000 }
      },
      async listPayments() {
        return { payments: [] }
      },
      async prepareSendPayment() {
        return {
          paymentMethod: { type: "sparkAddress", fee: "1" },
          amount: 2_101n,
        }
      },
      async sendPayment() {
        sendCalls += 1
        throw new Error("send must not run")
      },
      async receivePayment() {
        return { paymentRequest: "spark1receive", fee: 0n }
      },
    }
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return client
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.prepareSparkTransfer("wallet-personal", {
        address: "spark1recipient",
        amountSats: 2_100,
      })
    ).rejects.toThrow("Spark prepared a different transfer amount.")
    expect(sendCalls).toBe(0)
  })

  it("persists an ambiguous direct-transfer lock until the user acknowledges it", async () => {
    let sendCalls = 0
    const safetyStore = new MemorySparkDirectTransferSafetyStore()
    const createFactory = (
      network: SparkSdkFactory["network"]
    ): SparkSdkFactory => ({
      network,
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 21_000 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment(request) {
            return {
              paymentMethod: { type: "sparkAddress", fee: "2" },
              amount: request.amount ?? 2_100n,
            }
          },
          async sendPayment() {
            sendCalls += 1
            return {
              payment: {
                id: "pending-direct-transfer",
                status: "pending" as const,
                fees: 2n,
              },
            }
          },
          async receivePayment() {
            return { paymentRequest: "spark1receive", fee: 0n }
          },
        }
      },
    })
    const createManager = (network: SparkSdkFactory["network"]) =>
      new SparkWalletManager(
        createFactory(network),
        async () => ({ async release() {} }),
        safetyStore
      )
    const firstManager = createManager("mainnet")
    await firstManager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const quote = await firstManager.prepareSparkTransfer("wallet-personal", {
      address: "spark1recipient",
      amountSats: 2_100,
    })

    const [firstResult, duplicateResult] = await Promise.all([
      firstManager.confirmSparkTransfer("wallet-personal", quote.id),
      firstManager.confirmSparkTransfer("wallet-personal", quote.id),
    ])

    expect(firstResult).toEqual({
      status: "ambiguous",
      reason:
        "Spark payment is still pending. Check wallet history before trying again.",
    })
    expect(duplicateResult).toEqual(firstResult)
    expect(sendCalls).toBe(1)
    firstManager.discardSparkTransferQuote("wallet-personal", quote.id)
    expect(firstManager.hasUnresolvedSparkTransfer("wallet-personal")).toBe(
      true
    )

    await firstManager.close("wallet-personal")
    const regtestManager = createManager("regtest")
    await regtestManager.openWithMnemonic({
      walletId: "wallet-restored-on-regtest",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    expect(
      regtestManager.hasUnresolvedSparkTransfer("wallet-restored-on-regtest")
    ).toBe(false)
    regtestManager.acknowledgeUnresolvedSparkTransfer(
      "wallet-restored-on-regtest"
    )
    const regtestQuote = await regtestManager.prepareSparkTransfer(
      "wallet-restored-on-regtest",
      {
        address: "spark1recipient",
        amountSats: 2_100,
      }
    )
    regtestManager.discardSparkTransferQuote(
      "wallet-restored-on-regtest",
      regtestQuote.id
    )
    await regtestManager.close("wallet-restored-on-regtest")

    const reloadedManager = createManager("mainnet")
    await reloadedManager.openWithMnemonic({
      walletId: "wallet-restored-with-new-registration-id",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await expect(
      reloadedManager.prepareSparkTransfer(
        "wallet-restored-with-new-registration-id",
        {
          address: "spark1recipient",
          amountSats: 2_100,
        }
      )
    ).rejects.toThrow("A previous Spark payment is unresolved.")

    reloadedManager.acknowledgeUnresolvedSparkTransfer(
      "wallet-restored-with-new-registration-id"
    )
    expect(
      reloadedManager.hasUnresolvedSparkTransfer(
        "wallet-restored-with-new-registration-id"
      )
    ).toBe(false)
    await expect(
      reloadedManager.prepareSparkTransfer(
        "wallet-restored-with-new-registration-id",
        {
          address: "spark1recipient",
          amountSats: 2_100,
        }
      )
    ).resolves.toMatchObject({ amountSats: 2_100, feeSats: 2 })
    expect(sendCalls).toBe(1)
  })

  it("does not send a prepared invoice until its fee is approved", async () => {
    const sendCalls: string[] = []
    const approvalQuotes: Array<{
      amountSats: number
      feeSats: number
      totalSats: number
    }> = []
    const client: SparkSdkClient = {
      async disconnect() {},
      async getInfo() {
        return { balanceSats: 21_000 }
      },
      async listPayments() {
        return { payments: [] }
      },
      async prepareSendPayment() {
        return {
          paymentMethod: {
            type: "bolt11Invoice",
            fee: "7",
            lightningFeeSats: 7,
          },
          amount: 1_000n,
        }
      },
      async sendPayment() {
        sendCalls.push("sent")
        return {
          payment: {
            id: "approved-payment",
            status: "completed",
            fees: 7n,
            details: {
              type: "lightning",
              htlcDetails: {
                paymentHash: "approved-hash",
                preimage: "approved-preimage",
              },
            },
          },
        }
      },
      async receivePayment() {
        return { paymentRequest: "lnbc1receive", fee: 0n }
      },
    }
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return client
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: "lnbc1checkout",
        amountMsats: 1_000_000,
        idempotencyKey: "order-declined",
        approveFee: async (quote) => {
          approvalQuotes.push(quote)
          expect(sendCalls).toHaveLength(0)
          return false
        },
      })
    ).resolves.toEqual({
      status: "approval_declined",
      reason: "Spark payment was not approved.",
    })

    expect(approvalQuotes).toEqual([
      {
        amountSats: 1_000,
        feeSats: 7,
        totalSats: 1_007,
      },
    ])
    expect(sendCalls).toHaveLength(0)

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: "lnbc1checkout",
        amountMsats: 1_000_000,
        idempotencyKey: "order-declined",
        approveFee: async () => true,
      })
    ).resolves.toEqual({
      status: "paid",
      paymentId: "approved-payment",
      preimage: "approved-preimage",
      paymentHash: "approved-hash",
      feeMsats: 7_000,
    })
    expect(sendCalls).toEqual(["sent"])
  })

  it("fails closed when Spark prepares a different invoice amount", async () => {
    let approvalCalls = 0
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 21_000 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment() {
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 1,
              },
              amount: 999n,
            }
          },
          async sendPayment() {
            sendCalls += 1
            throw new Error("must not send a mismatched amount")
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: "lnbc1checkout",
        amountMsats: 1_000_000,
        idempotencyKey: "order-amount-mismatch",
        approveFee: async () => {
          approvalCalls += 1
          return true
        },
      })
    ).resolves.toEqual({
      status: "pre_publish_failed",
      reason: "Spark prepared a different invoice amount.",
    })
    expect(approvalCalls).toBe(0)
    expect(sendCalls).toBe(0)
  })

  it("fails closed when no fee approval handler is available", async () => {
    const sendCalls: string[] = []
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 21_000 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment() {
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                fee: "0",
                lightningFeeSats: 0,
              },
              amount: 1_000n,
            }
          },
          async sendPayment() {
            sendCalls.push("sent")
            throw new Error("must not send without approval")
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.payInvoice("wallet-personal", {
        invoice: "lnbc1checkout",
        amountMsats: 1_000_000,
        idempotencyKey: "order-no-handler",
      })
    ).resolves.toEqual({
      status: "pre_publish_failed",
      reason: "Review the Spark fee before sending this payment.",
    })
    expect(sendCalls).toHaveLength(0)
  })

  it("keeps multiple Spark wallet clients isolated", async () => {
    const disconnectedWallets: string[] = []
    const openCalls: string[] = []
    const balances = new Map([
      ["wallet-primary", 21_000],
      ["wallet-travel", 8_000],
    ])
    const factory: SparkSdkFactory = {
      network: "mainnet",
      async open(input) {
        openCalls.push(input.walletId)
        return {
          async disconnect() {
            disconnectedWallets.push(input.walletId)
          },
          async getInfo() {
            return { balanceSats: balances.get(input.walletId) ?? 0 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment() {
            throw new Error("Not needed for this test.")
          },
          async sendPayment() {
            throw new Error("Not needed for this test.")
          },
          async receivePayment() {
            return {
              paymentRequest: `lnbc1${input.walletId}`,
              fee: 0n,
            }
          },
        }
      },
    }
    const manager = new SparkWalletManager(factory)

    await manager.openWithMnemonic({
      walletId: "wallet-primary",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await manager.openWithMnemonic({
      walletId: "wallet-travel",
      mnemonic:
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
      accountNumber: 0,
    })

    await expect(manager.getBalance("wallet-primary")).resolves.toBe(21_000)
    await expect(manager.getBalance("wallet-travel")).resolves.toBe(8_000)
    expect(openCalls).toEqual(["wallet-primary", "wallet-travel"])

    await manager.closeWalletsExcept(new Set(["wallet-travel"]))

    expect(manager.isOpen("wallet-primary")).toBe(false)
    expect(manager.isOpen("wallet-travel")).toBe(true)
    expect(disconnectedWallets).toEqual(["wallet-primary"])
    await expect(manager.getBalance("wallet-travel")).resolves.toBe(8_000)
    await expect(manager.getBalance("wallet-primary")).rejects.toThrow(
      "Portable Wallet is locked on this device."
    )

    await manager.closeWalletsExcept(new Set())
    expect(manager.isOpen("wallet-travel")).toBe(false)
    expect(disconnectedWallets).toEqual(["wallet-primary", "wallet-travel"])
  })

  it("keys session exclusivity by recovery identity rather than registration ID", async () => {
    const acquired: Array<{ walletId: string; identityKey: string }> = []
    const acquireSessionLease = async (
      walletId: string,
      identityKey: string
    ) => {
      acquired.push({ walletId, identityKey })
      return { async release() {} }
    }
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        async open() {
          return createNoopSdkClient()
        },
      },
      acquireSessionLease
    )
    const mnemonic = "abandon ".repeat(11) + "about"

    await manager.openWithMnemonic({
      walletId: "wallet-primary",
      mnemonic,
      accountNumber: 1,
    })
    await manager.openWithMnemonic({
      walletId: "wallet-copy",
      mnemonic,
      accountNumber: 1,
    })
    await manager.openWithMnemonic({
      walletId: "wallet-other-account",
      mnemonic,
      accountNumber: 2,
    })
    const regtestManager = new SparkWalletManager(
      {
        network: "regtest",
        async open() {
          return createNoopSdkClient()
        },
      },
      acquireSessionLease
    )
    await regtestManager.openWithMnemonic({
      walletId: "wallet-same-recovery-regtest",
      mnemonic,
      accountNumber: 1,
    })

    expect(acquired[0]?.identityKey).toBe(acquired[1]?.identityKey)
    expect(acquired[2]?.identityKey).not.toBe(acquired[0]?.identityKey)
    expect(acquired[3]?.identityKey).not.toBe(acquired[0]?.identityKey)
    expect(acquired[0]?.identityKey).toMatch(/^[0-9a-f]{64}$/)
    expect(acquired[0]?.identityKey).not.toContain("abandon")
  })

  it("coalesces SDK events into wallet-only invalidations and ignores late events", async () => {
    const lifecycleCalls: string[] = []
    let onEvent: (() => void) | undefined
    const client: SparkSdkClient = {
      async addEventListener(listener) {
        lifecycleCalls.push("add-listener")
        onEvent = listener
        return "listener-1"
      },
      async removeEventListener(listenerId) {
        lifecycleCalls.push(`remove-listener:${listenerId}`)
        return true
      },
      async disconnect() {
        lifecycleCalls.push("disconnect")
      },
      async getInfo() {
        return { balanceSats: 21_000 }
      },
      async listPayments() {
        return { payments: [] }
      },
      async prepareSendPayment() {
        throw new Error("Not needed for this test.")
      },
      async sendPayment() {
        throw new Error("Not needed for this test.")
      },
      async receivePayment() {
        return { paymentRequest: "lnbc1receive", fee: 0n }
      },
    }
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return client
      },
    })
    const invalidatedWallets: string[] = []
    const unsubscribe = manager.subscribe((walletId) => {
      invalidatedWallets.push(walletId)
    })

    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    expect(lifecycleCalls).toEqual(["add-listener"])

    onEvent?.()
    onEvent?.()
    await Promise.resolve()
    expect(invalidatedWallets).toEqual(["wallet-personal"])

    await manager.close("wallet-personal")
    expect(lifecycleCalls).toEqual([
      "add-listener",
      "remove-listener:listener-1",
      "disconnect",
    ])

    onEvent?.()
    await Promise.resolve()
    expect(invalidatedWallets).toEqual(["wallet-personal"])

    unsubscribe()
  })

  it("holds the wallet session lease from before open until after disconnect", async () => {
    const lifecycleCalls: string[] = []
    let sessionLeaseHeld = false
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        async open() {
          expect(sessionLeaseHeld).toBe(true)
          lifecycleCalls.push("open")
          return {
            async disconnect() {
              expect(sessionLeaseHeld).toBe(true)
              lifecycleCalls.push("disconnect")
            },
            async getInfo() {
              return { balanceSats: 0 }
            },
            async listPayments() {
              return { payments: [] }
            },
            async prepareSendPayment() {
              throw new Error("Not needed for this test.")
            },
            async sendPayment() {
              throw new Error("Not needed for this test.")
            },
            async receivePayment() {
              return { paymentRequest: "lnbc1receive", fee: 0n }
            },
          }
        },
      },
      async (walletId) => {
        lifecycleCalls.push(`acquire:${walletId}`)
        sessionLeaseHeld = true
        return {
          async release() {
            lifecycleCalls.push("release")
            sessionLeaseHeld = false
          },
        }
      }
    )

    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await manager.close("wallet-personal")

    expect(lifecycleCalls).toEqual([
      "acquire:wallet-personal",
      "open",
      "disconnect",
      "release",
    ])
    expect(sessionLeaseHeld).toBe(false)
  })

  it("quarantines the wallet session when disconnect fails and never overlaps a new client", async () => {
    let allowDisconnect = false
    let openCalls = 0
    let releaseCalls = 0
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        async open() {
          openCalls += 1
          return {
            async disconnect() {
              if (!allowDisconnect) {
                throw new Error("disconnect not confirmed")
              }
            },
            async getInfo() {
              return { balanceSats: 0 }
            },
            async listPayments() {
              return { payments: [] }
            },
            async prepareSendPayment() {
              throw new Error("Not needed for this test.")
            },
            async sendPayment() {
              throw new Error("Not needed for this test.")
            },
            async receivePayment() {
              return { paymentRequest: "lnbc1receive", fee: 0n }
            },
          }
        },
      },
      async () => ({
        async release() {
          releaseCalls += 1
        },
      })
    )

    const openInput = {
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    }
    await manager.openWithMnemonic(openInput)

    await expect(manager.close("wallet-personal")).rejects.toThrow(
      "disconnect not confirmed"
    )
    expect(manager.isOpen("wallet-personal")).toBe(false)
    expect(releaseCalls).toBe(0)

    await expect(manager.openWithMnemonic(openInput)).rejects.toThrow(
      "disconnect not confirmed"
    )
    expect(openCalls).toBe(1)
    expect(releaseCalls).toBe(0)

    allowDisconnect = true
    await manager.close("wallet-personal")
    expect(releaseCalls).toBe(1)

    await manager.openWithMnemonic(openInput)
    expect(openCalls).toBe(2)
  })

  it("releases the wallet session lease when SDK open fails", async () => {
    const lifecycleCalls: string[] = []
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        async open() {
          lifecycleCalls.push("open")
          throw new Error("SDK open failed")
        },
      },
      async () => {
        lifecycleCalls.push("acquire")
        return {
          async release() {
            lifecycleCalls.push("release")
          },
        }
      }
    )

    await expect(
      manager.openWithMnemonic({
        walletId: "wallet-personal",
        mnemonic: "abandon ".repeat(11) + "about",
        accountNumber: 0,
      })
    ).rejects.toThrow("SDK open failed")
    expect(lifecycleCalls).toEqual(["acquire", "open", "release"])
  })

  it("reuses one ambiguous Spark invoice attempt for duplicate idempotency keys", async () => {
    let prepareCalls = 0
    let approvalCalls = 0
    let sendCalls = 0
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          async disconnect() {},
          async getInfo() {
            return { balanceSats: 21_000 }
          },
          async listPayments() {
            return { payments: [] }
          },
          async prepareSendPayment() {
            prepareCalls += 1
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 2,
              },
              amount: 1_000n,
            }
          },
          async sendPayment() {
            sendCalls += 1
            return {
              payment: {
                id: "pending-payment",
                status: "pending",
                fees: 2n,
              },
            }
          },
          async receivePayment() {
            return { paymentRequest: "lnbc1receive", fee: 0n }
          },
        }
      },
    })
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    const input = {
      invoice: "lnbc1checkout",
      amountMsats: 1_000_000,
      idempotencyKey: "order-duplicate",
      approveFee: async () => {
        approvalCalls += 1
        return true
      },
    }

    const [first, concurrent] = await Promise.all([
      manager.payInvoice("wallet-personal", input),
      manager.payInvoice("wallet-personal", input),
    ])
    const sequential = await manager.payInvoice("wallet-personal", input)

    expect(first).toEqual({
      status: "ambiguous",
      reason:
        "Spark payment is still pending. Check the wallet before retrying.",
    })
    expect(concurrent).toEqual(first)
    expect(sequential).toEqual(first)
    expect(prepareCalls).toBe(1)
    expect(approvalCalls).toBe(1)
    expect(sendCalls).toBe(1)
  })

  it("purges cached Lightning proofs when the wallet is locked", async () => {
    const manager = new SparkWalletManager({
      network: "mainnet",
      async open() {
        return {
          ...createNoopSdkClient(),
          async prepareSendPayment() {
            return {
              paymentMethod: {
                type: "bolt11Invoice",
                lightningFeeSats: 1,
              },
              amount: 1_000n,
            }
          },
          async sendPayment() {
            return {
              payment: {
                id: "paid-payment",
                status: "completed",
                fees: 1n,
                details: {
                  type: "lightning",
                  htlcDetails: {
                    preimage: "secret-preimage",
                    paymentHash: "payment-hash",
                  },
                },
              },
            }
          },
        }
      },
    })
    const paymentInput = {
      invoice: "lnbc1checkout",
      amountMsats: 1_000_000,
      idempotencyKey: "order-paid",
      approveFee: async () => true,
    }
    await manager.openWithMnemonic({
      walletId: "wallet-personal",
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(
      manager.payInvoice("wallet-personal", paymentInput)
    ).resolves.toMatchObject({
      status: "paid",
      preimage: "secret-preimage",
    })
    await manager.close("wallet-personal")

    await expect(
      manager.payInvoice("wallet-personal", paymentInput)
    ).resolves.toEqual({
      status: "pre_publish_failed",
      reason: "Portable Wallet is locked on this device.",
    })
  })
})

function createNoopSdkClient(): SparkSdkClient {
  return {
    async disconnect() {},
    async getInfo() {
      return { balanceSats: 0 }
    },
    async listPayments() {
      return { payments: [] }
    },
    async prepareSendPayment() {
      throw new Error("Not needed for this test.")
    },
    async sendPayment() {
      throw new Error("Not needed for this test.")
    },
    async receivePayment() {
      return { paymentRequest: "lnbc1receive", fee: 0n }
    },
  }
}

function createSendTestClient(input?: {
  onPrepare?: (
    request: Parameters<SparkSdkClient["prepareSendPayment"]>[0]
  ) => SparkPreparedPayment | Promise<SparkPreparedPayment>
  onSend?: (
    request: Parameters<SparkSdkClient["sendPayment"]>[0]
  ) => { payment: SparkSdkPayment } | Promise<{ payment: SparkSdkPayment }>
}): SparkSdkClient {
  return {
    async disconnect() {},
    async getInfo() {
      return { balanceSats: 2_000 }
    },
    async listPayments() {
      return { payments: [] }
    },
    async prepareSendPayment(request) {
      if (input?.onPrepare) {
        return input.onPrepare(request)
      }
      const isSpark = request.paymentRequest.input.startsWith("spark")
      return {
        paymentMethod: isSpark
          ? { type: "sparkAddress", fee: "0" }
          : { type: "bolt11Invoice", lightningFeeSats: 1 },
        amount: request.amount ?? 0n,
      }
    },
    async sendPayment(request) {
      if (input?.onSend) {
        return input.onSend(request)
      }
      return completedLightningPayment()
    },
    async receivePayment() {
      return { paymentRequest: "lnbc1receive", fee: 0n }
    },
  }
}

function completedLightningPayment(): { payment: SparkSdkPayment } {
  return {
    payment: {
      id: "completed-lightning-payment",
      status: "completed",
      fees: 1n,
      details: {
        type: "lightning",
        htlcDetails: {
          paymentHash: "payment-hash",
          preimage: "payment-preimage",
        },
      },
    },
  }
}
