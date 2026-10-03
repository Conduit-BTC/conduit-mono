import { describe, expect, it } from "bun:test"

import {
  proveSparkCheckoutReceiveCredit,
  type SparkCheckoutReceiveCreditProofInput,
} from "@conduit/core"
import { bytesToBolt11Words, makeBolt11Fixture } from "./support/bolt11-fixture"

const REQUEST_ID = "lightning-receive-1"
const TRANSFER_ID = "0197f9a0-0000-7000-8000-000000000001"
const PAYMENT_HASH = "07".repeat(32)
const WALLET_IDENTITY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

function invoice(amountSats = 1_000): string {
  return makeBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(
          Uint8Array.from(PAYMENT_HASH.match(/.{2}/g)!, (byte) =>
            Number.parseInt(byte, 16)
          )
        ),
      },
    ],
  })
}

function exactEvidence(): SparkCheckoutReceiveCreditProofInput {
  const paymentRequest = invoice()
  return {
    expectedRequest: {
      network: "mainnet" as const,
      id: REQUEST_ID,
      paymentRequest,
      paymentHash: PAYMENT_HASH,
      grossFundingSats: 1_000,
    },
    expectedReceive: { mode: "ordinary_v3" },
    walletIdentityPublicKey: WALLET_IDENTITY,
    receive: {
      id: REQUEST_ID,
      status: "TRANSFER_COMPLETED",
      network: "MAINNET",
      invoice: {
        encodedInvoice: paymentRequest,
        bitcoinNetwork: "MAINNET",
        paymentHash: PAYMENT_HASH,
        amount: {
          originalValue: 1_000_000,
          originalUnit: "MILLISATOSHI",
        },
      },
      transfer: {
        sparkId: TRANSFER_ID,
        userRequestId: REQUEST_ID,
        totalAmount: { originalValue: 1_000, originalUnit: "SATOSHI" },
      },
    },
    transfer: {
      id: TRANSFER_ID,
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 1_000,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: WALLET_IDENTITY,
      userRequest: { id: REQUEST_ID },
    },
  }
}

describe("Spark checkout exact receive credit proof", () => {
  it("returns the exact credited sats for a completed v3 single-receiver transfer", () => {
    const evidence = exactEvidence()
    evidence.receive.transfer!.totalAmount.originalValue = 993
    evidence.transfer.totalValue = 993

    expect(proveSparkCheckoutReceiveCredit(evidence)).toEqual({
      mode: "ordinary_v3",
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      receiverIdentityPublicKey: WALLET_IDENTITY,
      grossSats: 1_000,
      creditedSats: 993,
    })
  })

  it("accepts the provider's explicit ordinary v3 single-receiver row", () => {
    for (const topLevelIdentity of [WALLET_IDENTITY, undefined]) {
      const evidence = exactEvidence()
      evidence.transfer.receiverIdentityPublicKey = topLevelIdentity
      evidence.transfer.receivers = [
        {
          identityPublicKey: WALLET_IDENTITY,
          amountSats: 1_000,
          status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
        },
      ]

      expect(proveSparkCheckoutReceiveCredit(evidence).creditedSats).toBe(1_000)
    }
  })

  it("returns only the checkout wallet's credited leg for a v4 multi-receiver transfer", () => {
    const evidence = exactEvidence()
    evidence.expectedReceive = {
      mode: "committed_quote_v4",
      manifestTransferId: TRANSFER_ID,
    }
    evidence.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 993,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
      {
        identityPublicKey: "03" + "22".repeat(32),
        amountSats: 5,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    expect(proveSparkCheckoutReceiveCredit(evidence)).toEqual({
      mode: "committed_quote_v4",
      requestId: REQUEST_ID,
      transferId: TRANSFER_ID,
      receiverIdentityPublicKey: WALLET_IDENTITY,
      grossSats: 1_000,
      creditedSats: 993,
    })
  })

  it("normalizes exact satoshi and millisatoshi provider amounts without rounding", () => {
    const evidence = exactEvidence()
    evidence.receive.invoice.amount = {
      originalValue: 1_000,
      originalUnit: "SATOSHI",
    }
    evidence.receive.transfer!.totalAmount = {
      originalValue: 1_000_000,
      originalUnit: "MILLISATOSHI",
    }

    expect(proveSparkCheckoutReceiveCredit(evidence).creditedSats).toBe(1_000)
  })

  it("does not use an unrelated aggregate wallet balance as receive evidence", () => {
    const evidence = {
      ...exactEvidence(),
      walletBalanceSats: Number.MAX_SAFE_INTEGER,
    }

    expect(proveSparkCheckoutReceiveCredit(evidence).creditedSats).toBe(1_000)
  })

  it("rejects a completed receive without an exact settling transfer id", () => {
    const evidence = exactEvidence()
    evidence.receive.transfer = undefined

    expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
      "Spark checkout receive credit proof is invalid."
    )
  })

  it("rejects receive evidence that does not match the persisted request", () => {
    const evidence = exactEvidence()
    const mismatches = [
      { ...evidence.receive, id: "another-request" },
      { ...evidence.receive, status: "LIGHTNING_PAYMENT_RECEIVED" },
      { ...evidence.receive, network: "REGTEST" },
      {
        ...evidence.receive,
        invoice: { ...evidence.receive.invoice, encodedInvoice: invoice(999) },
      },
      {
        ...evidence.receive,
        invoice: { ...evidence.receive.invoice, bitcoinNetwork: "REGTEST" },
      },
      {
        ...evidence.receive,
        invoice: { ...evidence.receive.invoice, paymentHash: "08".repeat(32) },
      },
      {
        ...evidence.receive,
        invoice: {
          ...evidence.receive.invoice,
          amount: { originalValue: 999, originalUnit: "SATOSHI" },
        },
      },
      {
        ...evidence.receive,
        transfer: {
          ...evidence.receive.transfer!,
          userRequestId: "another-request",
        },
      },
    ]

    for (const receive of mismatches) {
      expect(() =>
        proveSparkCheckoutReceiveCredit({ ...evidence, receive })
      ).toThrow("Spark checkout receive credit proof is invalid.")
    }
  })

  it("rejects a getTransfer result with the wrong id, direction, or status", () => {
    const evidence = exactEvidence()
    for (const transfer of [
      { ...evidence.transfer, id: "another-transfer" },
      { ...evidence.transfer, transferDirection: "OUTGOING" },
      { ...evidence.transfer, status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED" },
      { ...evidence.transfer, userRequest: undefined },
      { ...evidence.transfer, userRequest: { id: "another-request" } },
    ]) {
      expect(() =>
        proveSparkCheckoutReceiveCredit({ ...evidence, transfer })
      ).toThrow("Spark checkout receive credit proof is invalid.")
    }
  })

  it("rejects malformed persisted invoice evidence instead of trusting copied fields", () => {
    const wrongAmount = exactEvidence()
    wrongAmount.expectedRequest.paymentRequest = invoice(999)

    const wrongHash = exactEvidence()
    wrongHash.expectedRequest.paymentHash = "08".repeat(32)

    for (const evidence of [wrongAmount, wrongHash]) {
      expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
        "Spark checkout receive credit proof is invalid."
      )
    }
  })

  it("rejects missing or conflicting v3 receiver identity evidence", () => {
    const missing = exactEvidence()
    missing.transfer.receiverIdentityPublicKey = undefined

    const wrong = exactEvidence()
    wrong.transfer.receiverIdentityPublicKey = "03" + "11".repeat(32)

    const wrongRowIdentity = exactEvidence()
    wrongRowIdentity.transfer.receivers = [
      {
        identityPublicKey: "03" + "22".repeat(32),
        amountSats: 1_000,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    const wrongRowAmount = exactEvidence()
    wrongRowAmount.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 999,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    const incompleteRow = exactEvidence()
    incompleteRow.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 1_000,
        status: "TRANSFER_RECEIVER_STATUS_CREATED",
      },
    ]

    const multipleRows = exactEvidence()
    multipleRows.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 999,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
      {
        identityPublicKey: "03" + "22".repeat(32),
        amountSats: 1,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    const conflictingTopLevel = exactEvidence()
    conflictingTopLevel.transfer.receiverIdentityPublicKey =
      "03" + "22".repeat(32)
    conflictingTopLevel.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 1_000,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    for (const evidence of [
      missing,
      wrong,
      wrongRowIdentity,
      wrongRowAmount,
      incompleteRow,
      multipleRows,
      conflictingTopLevel,
    ]) {
      expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
        "Spark checkout receive credit proof is invalid."
      )
    }
  })

  it("rejects unsafe or conflicting transfer-wide amounts", () => {
    const zero = exactEvidence()
    zero.transfer.totalValue = 0
    zero.receive.transfer!.totalAmount.originalValue = 0

    const overGross = exactEvidence()
    overGross.transfer.totalValue = 1_001
    overGross.receive.transfer!.totalAmount.originalValue = 1_001

    const mismatched = exactEvidence()
    mismatched.transfer.totalValue = 999

    const fractional = exactEvidence()
    fractional.transfer.totalValue = 999.5
    fractional.receive.transfer!.totalAmount.originalValue = 999.5

    const fractionalInvoiceMsats = exactEvidence()
    fractionalInvoiceMsats.receive.invoice.amount.originalValue = 1_000_001

    const fractionalTransferMsats = exactEvidence()
    fractionalTransferMsats.receive.transfer!.totalAmount = {
      originalValue: 1_000_001,
      originalUnit: "MILLISATOSHI",
    }

    for (const evidence of [
      zero,
      overGross,
      mismatched,
      fractional,
      fractionalInvoiceMsats,
      fractionalTransferMsats,
    ]) {
      expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
        "Spark checkout receive credit proof is invalid."
      )
    }
  })

  it("rejects a missing, duplicate, incomplete, or invalid own receiver leg", () => {
    const receiver = {
      identityPublicKey: WALLET_IDENTITY,
      amountSats: 993,
      status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
    }
    const asV4 = (evidence: SparkCheckoutReceiveCreditProofInput) => {
      evidence.expectedReceive = {
        mode: "committed_quote_v4",
        manifestTransferId: TRANSFER_ID,
      }
      return evidence
    }
    const missing = asV4(exactEvidence())
    missing.transfer.receivers = [
      { ...receiver, identityPublicKey: "03" + "11".repeat(32) },
    ]

    const duplicate = asV4(exactEvidence())
    duplicate.transfer.receivers = [receiver, { ...receiver }]

    const incomplete = asV4(exactEvidence())
    incomplete.transfer.receivers = [
      { ...receiver, status: "TRANSFER_RECEIVER_STATUS_CREATED" },
    ]

    const zero = asV4(exactEvidence())
    zero.transfer.receivers = [{ ...receiver, amountSats: 0 }]

    const overTransfer = asV4(exactEvidence())
    overTransfer.transfer.receivers = [{ ...receiver, amountSats: 1_001 }]

    const malformedOther = asV4(exactEvidence())
    malformedOther.transfer.receivers = [
      receiver,
      {
        ...receiver,
        identityPublicKey: "not-a-compressed-public-key",
        amountSats: 7,
      },
    ]

    const duplicateOther = asV4(exactEvidence())
    duplicateOther.transfer.receivers = [
      { ...receiver, amountSats: 990 },
      {
        ...receiver,
        identityPublicKey: "03" + "11".repeat(32),
        amountSats: 5,
      },
      {
        ...receiver,
        identityPublicKey: "03" + "11".repeat(32),
        amountSats: 5,
      },
    ]

    const zeroOther = asV4(exactEvidence())
    zeroOther.transfer.receivers = [
      receiver,
      {
        ...receiver,
        identityPublicKey: "03" + "11".repeat(32),
        amountSats: 0,
      },
    ]

    const incompleteOther = asV4(exactEvidence())
    incompleteOther.transfer.receivers = [
      receiver,
      {
        ...receiver,
        identityPublicKey: "03" + "11".repeat(32),
        amountSats: 7,
        status: "TRANSFER_RECEIVER_STATUS_CREATED",
      },
    ]

    const rowsExceedTransfer = asV4(exactEvidence())
    rowsExceedTransfer.transfer.receivers = [
      receiver,
      {
        ...receiver,
        identityPublicKey: "03" + "11".repeat(32),
        amountSats: 8,
      },
    ]

    for (const evidence of [
      missing,
      duplicate,
      incomplete,
      zero,
      overTransfer,
      malformedOther,
      duplicateOther,
      zeroOther,
      incompleteOther,
      rowsExceedTransfer,
    ]) {
      expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
        "Spark checkout receive credit proof is invalid."
      )
    }
  })

  it("does not downgrade committed v4 evidence when receiver rows are missing", () => {
    const missingReceivers = exactEvidence()
    missingReceivers.expectedReceive = {
      mode: "committed_quote_v4",
      manifestTransferId: TRANSFER_ID,
    }

    const wrongManifest = exactEvidence()
    wrongManifest.expectedReceive = {
      mode: "committed_quote_v4",
      manifestTransferId: "another-transfer",
    }
    wrongManifest.transfer.receivers = [
      {
        identityPublicKey: WALLET_IDENTITY,
        amountSats: 1_000,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ]

    for (const evidence of [missingReceivers, wrongManifest]) {
      expect(() => proveSparkCheckoutReceiveCredit(evidence)).toThrow(
        "Spark checkout receive credit proof is invalid."
      )
    }
  })
})
