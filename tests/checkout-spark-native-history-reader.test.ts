import { describe, expect, it } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import * as sdk from "../apps/merchant/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { Transfer } from "../apps/merchant/node_modules/@buildonspark/spark-sdk/dist/proto/spark.js"
import {
  prepareCheckoutSparkNativeTreasuryRequest,
  type CheckoutSparkNativeTreasurySdkInvoiceQuery,
} from "@conduit/core"
import {
  inspectMerchantCheckoutSparkNativeHistory,
  type MerchantCheckoutSparkNativeHistoryDependencies,
} from "../apps/merchant/src/lib/checkout-spark-native-history-reader"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const SENDER =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const RECEIVER = `03${SENDER.slice(2)}`

function fixture() {
  const calls: string[] = []
  const seed = randomBytes(64)
  const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(
    { ...sdk, parseTransferId: sdk.UUID.parse },
    {
      network: "mainnet",
      sparkAddress: sdk.encodeSparkAddress({
        network: "MAINNET",
        identityPublicKey: RECEIVER,
      }),
      senderIdentityPublicKey: SENDER,
      invoiceId: randomUUID(),
    }
  )
  const transfer = Transfer.fromPartial({
    id: randomUUID(),
    type: 2,
    network: 1,
    status: 5,
    totalValue: 57,
    sparkInvoice: nativeTreasury.invoiceRequest,
    senderIdentityPublicKey: Buffer.from(SENDER, "hex"),
    receiverIdentityPublicKey: Buffer.from(RECEIVER, "hex"),
    senders: [
      { id: "sender-edge", identityPublicKey: Buffer.from(SENDER, "hex") },
    ],
    receivers: [
      {
        id: "receiver-edge",
        identityPublicKey: Buffer.from(RECEIVER, "hex"),
        amountSats: 57,
        status: 6,
      },
    ],
    leaves: [
      {
        leaf: { id: "synthetic-leaf", value: 57 },
        transferSenderId: "sender-edge",
        transferReceiverId: "receiver-edge",
      },
    ],
  })
  let invoiceQuery: CheckoutSparkNativeTreasurySdkInvoiceQuery & {
    offset: number
  } = {
    invoiceStatuses: [
      {
        invoice: nativeTreasury.invoiceRequest,
        status: 2,
        transferType: {
          $case: "satsTransfer" as const,
          satsTransfer: { transferId: sdk.UUID.parse(transfer.id).bytes },
        },
      },
    ],
    offset: -1,
  }
  let history = [transfer]
  let failRead = false
  let pendingRead: Promise<void> | undefined
  class Signer {
    async mnemonicToSeed() {
      return seed
    }
    async createSparkWalletFromSeed() {
      return SENDER
    }
    async getIdentityPublicKey() {
      return Buffer.from(SENDER, "hex")
    }
    async signMessageWithIdentityKey() {
      return randomBytes(64)
    }
  }
  class Reader {
    protected connectionManager = {
      closeConnections: async () => {
        calls.push("close-connections")
      },
    }
    protected logging = {
      close: async () => {
        calls.push("close-logging")
      },
    }
    static createWithSigner(options: unknown, signer: unknown) {
      expect(options).toEqual({ network: "MAINNET", log: false })
      expect(typeof signer).toBe("object")
      calls.push("open-readonly")
      return new this()
    }
    async getSparkInvoices() {
      calls.push("invoice-query")
      if (failRead) throw new Error("Synthetic read unavailable")
      await pendingRead
      return invoiceQuery
    }
    async getTransfers() {
      calls.push("history-query")
      return { transfers: history, offset: -1 }
    }
    async getTransfersByIds(ids: string[]) {
      calls.push("exact-query")
      expect(ids).toEqual([transfer.id])
      return [transfer]
    }
  }
  const dependencies: MerchantCheckoutSparkNativeHistoryDependencies = {
    loadSdk: async () =>
      ({
        ...sdk,
        SparkReadonlyClient: Reader,
        DefaultSparkSigner: Signer,
      }) as unknown as typeof sdk,
  }
  const input = {
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 1,
    fundingIdentityPublicKey: SENDER,
    request: {
      network: "mainnet" as const,
      nativeTreasury,
      amountSats: 57,
      authorizedDebitSats: 57,
    },
    assertCurrent: () => {},
    checkCurrent: async () => {},
  }
  return {
    input,
    dependencies,
    calls,
    seed,
    absent: () => {
      invoiceQuery = {
        invoiceStatuses: [
          { invoice: nativeTreasury.invoiceRequest, status: 0 },
        ],
        offset: -1,
      }
      history = []
    },
    unavailable: () => {
      failRead = true
    },
    delayRead: (pending: Promise<void>) => {
      pendingRead = pending
    },
  }
}

describe("claim-free native treasury history reader", () => {
  it("reports only exact committed and finalized evidence and closes its reader", async () => {
    const f = fixture()
    expect(
      await inspectMerchantCheckoutSparkNativeHistory(f.input, f.dependencies)
    ).toBe("exact_commit_and_finalized_invoice")
    expect(f.seed.every((byte) => byte === 0)).toBe(true)
    expect(f.calls).toContain("exact-query")
    expect(f.calls).toContain("close-connections")
    expect(f.calls).toContain("close-logging")
  })

  it("reports bounded absence without turning it into payment or retry authority", async () => {
    const f = fixture()
    f.absent()
    expect(
      await inspectMerchantCheckoutSparkNativeHistory(f.input, f.dependencies)
    ).toBe("no_exact_match_in_bounded_history")
    expect(f.calls).not.toContain("exact-query")
    expect(f.calls).toContain("close-connections")
    expect(f.calls).toContain("close-logging")
  })

  it("returns only unavailable when authenticated provider history cannot be read", async () => {
    const f = fixture()
    f.unavailable()
    expect(
      await inspectMerchantCheckoutSparkNativeHistory(f.input, f.dependencies)
    ).toBe("unavailable")
    expect(f.calls).not.toContain("exact-query")
    expect(f.calls).toContain("close-connections")
    expect(f.calls).toContain("close-logging")
  })

  it("bounds an unavailable read and fences its late completion after cleanup", async () => {
    const f = fixture()
    let release: () => void = () => {}
    f.delayRead(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    expect(
      await inspectMerchantCheckoutSparkNativeHistory(f.input, {
        ...f.dependencies,
        timeoutMs: 200,
        readTimeoutMs: 10,
      })
    ).toBe("unavailable")
    release()
    await Promise.resolve()
    expect(f.calls).not.toContain("exact-query")
    expect(f.calls).toContain("close-connections")
    expect(f.calls).toContain("close-logging")
  })
})
