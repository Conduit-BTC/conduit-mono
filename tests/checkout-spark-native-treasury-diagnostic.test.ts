import { describe, expect, it } from "bun:test"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../packages/core/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import {
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  inspectCheckoutSparkNativeTreasuryHistory,
  prepareCheckoutSparkNativeTreasuryRequest,
  type CheckoutSparkNativeTreasurySdkInput,
  type CheckoutSparkNativeTreasurySdkInvoiceQuery,
  type CheckoutSparkNativeTreasurySdkTransfer,
} from "../packages/core/src/protocol/checkout-spark-treasury-sdk"

// Public curve points and ordinary in-memory provider fixtures only.
// No SDK wallet, signer, payment, or network connection is opened.
const SENDER =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const RECEIVER = `03${SENDER.slice(2)}`
const TRANSFER_ID = "0197f9a0-0000-7000-8000-000000000002"
const codec = {
  nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
}

function fixture() {
  const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(codec, {
    network: "mainnet",
    sparkAddress: encodeSparkAddress({
      identityPublicKey: RECEIVER,
      network: "MAINNET",
    }),
    senderIdentityPublicKey: SENDER,
    invoiceId: "0197f9a0-0000-5000-8000-000000000001",
  })
  const request: CheckoutSparkNativeTreasurySdkInput = {
    network: "mainnet",
    nativeTreasury,
    amountSats: 57,
    authorizedDebitSats: 57,
  }
  const transfer: CheckoutSparkNativeTreasurySdkTransfer = {
    id: TRANSFER_ID,
    status: "TRANSFER_STATUS_COMPLETED",
    totalValue: 57,
    type: "TRANSFER",
    transferDirection: "OUTGOING",
    sparkInvoice: nativeTreasury.invoiceRequest,
    senderIdentityPublicKey: SENDER,
    receiverIdentityPublicKey: RECEIVER,
    valueSentByWallet: 57,
    valueReceivedByWallet: 0,
    senders: [{ identityPublicKey: SENDER }],
    receivers: [
      {
        identityPublicKey: RECEIVER,
        amountSats: 57,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ],
  }
  const invoiceQuery: CheckoutSparkNativeTreasurySdkInvoiceQuery = {
    invoiceStatuses: [
      {
        invoice: nativeTreasury.invoiceRequest,
        status: 2,
        transferType: {
          $case: "satsTransfer",
          satsTransfer: { transferId: UUID.parse(TRANSFER_ID).bytes },
        },
      },
    ],
  }
  return {
    codec,
    network: "MAINNET" as const,
    request,
    walletIdentityPublicKey: SENDER,
    invoiceQuery,
    transfers: [transfer],
    getTransfer: async () => structuredClone(transfer),
    transfer,
  }
}

describe("native treasury read-only history diagnostic", () => {
  it("reports matching committed history and the finalized exact invoice", async () => {
    const input = fixture()
    expect(await inspectCheckoutSparkNativeTreasuryHistory(input)).toBe(
      "exact_commit_and_finalized_invoice"
    )
  })

  it("keeps an empty bounded lookup distinct from proof that nothing was sent", async () => {
    const input = fixture()
    input.invoiceQuery.invoiceStatuses[0] = {
      invoice: input.request.nativeTreasury.invoiceRequest,
      status: 0,
    }
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: [],
      })
    ).toBe("no_exact_match_in_bounded_history")
  })

  it("reports unavailable when either bounded provider read did not finish", async () => {
    const input = fixture()
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: null,
      })
    ).toBe("unavailable")
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        invoiceQuery: null,
      })
    ).toBe("unavailable")
  })

  it("keeps positive sender history separate from an unresolved invoice lookup", async () => {
    const input = fixture()
    input.invoiceQuery.invoiceStatuses[0] = {
      invoice: input.request.nativeTreasury.invoiceRequest,
      status: 0,
    }
    expect(await inspectCheckoutSparkNativeTreasuryHistory(input)).toBe(
      "history_commit_invoice_unresolved"
    )
  })

  it("reports the exact pending sender attempt without suggesting another send", async () => {
    const input = fixture()
    const pending = {
      ...input.transfer,
      status: "TRANSFER_STATUS_SENDER_KEY_TWEAK_PENDING",
      receivers: input.transfer.receivers!.map((receiver) => ({
        ...receiver,
        status: "TRANSFER_RECEIVER_STATUS_INITIATED",
      })),
    }
    input.invoiceQuery.invoiceStatuses[0]!.status = 1
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: [pending],
        getTransfer: async () => pending,
      })
    ).toBe("exact_pending")
  })

  it("reports an exact returned attempt without granting refund or retry authority", async () => {
    const input = fixture()
    const returned = {
      ...input.transfer,
      status: "TRANSFER_STATUS_RETURNED",
      receivers: input.transfer.receivers!.map((receiver) => ({
        ...receiver,
        status: "TRANSFER_RECEIVER_STATUS_CANCELLED",
      })),
    }
    input.invoiceQuery.invoiceStatuses[0]!.status = 4
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: [returned],
        getTransfer: async () => returned,
      })
    ).toBe("exact_returned")
  })

  it("deduplicates identical observations of the same exact transfer", async () => {
    const input = fixture()
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: [input.transfer, structuredClone(input.transfer)],
      })
    ).toBe("exact_commit_and_finalized_invoice")
  })

  it("recognizes committed sender history while the receiver has not claimed", async () => {
    const input = fixture()
    const committed = {
      ...input.transfer,
      status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
      receivers: input.transfer.receivers!.map((receiver) => ({
        ...receiver,
        status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
      })),
    }
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...input,
        transfers: [committed],
        getTransfer: async () => committed,
      })
    ).toBe("exact_commit_and_finalized_invoice")
  })

  it("reports unavailable when the exact fresh transfer is not returned", async () => {
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...fixture(),
        getTransfer: async () => undefined,
      })
    ).toBe("unavailable")
  })

  it("does not expose an unavailable provider's error text", async () => {
    expect(
      await inspectCheckoutSparkNativeTreasuryHistory({
        ...fixture(),
        getTransfer: async () => {
          throw new Error("Provider read unavailable")
        },
      })
    ).toBe("unavailable")
  })
})
