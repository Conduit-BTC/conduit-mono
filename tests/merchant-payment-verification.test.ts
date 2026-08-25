import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  getMerchantNwcAddressStatus,
  getMerchantPaymentVerificationCandidates,
  isNwcSettlementMatch,
  verifyMerchantPaymentCandidates,
} from "../apps/merchant/src/lib/merchant-payment-verification"

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

function conversation(
  orderId = "order-1",
  proofInvoice = invoice
): MerchantConversationSummary {
  const order = {
    id: `${orderId}-order`,
    orderId,
    type: "order",
    createdAt,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      id: orderId,
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      items: [],
      subtotal: 100,
      currency: "SATS",
      createdAt,
    },
  } as ParsedOrderMessage
  const proof = {
    id: `${orderId}-proof`,
    orderId,
    type: "payment_proof",
    createdAt: createdAt + 1_000,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      orderId,
      rail: "lightning",
      action: "private_checkout",
      amount: 100,
      amountMsats: 100_000,
      currency: "SATS",
      invoice: proofInvoice,
      preimage: "preimage",
      paymentHash: "payment-hash",
    },
  } as ParsedOrderMessage

  return {
    id: orderId,
    orderId,
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    latestAt: createdAt + 1_000,
    latestType: "payment_proof",
    status: null,
    totalSummary: "100 SATS",
    preview: "Payment proof",
    messageCount: 2,
    messages: [order, proof],
  }
}

function invoiceOnlyConversation(orderId: string): MerchantConversationSummary {
  const base = conversation(orderId)
  const order = base.messages![0]!
  const paymentRequest = {
    id: `${orderId}-invoice`,
    orderId,
    type: "payment_request",
    createdAt: createdAt + 500,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: {
      orderId,
      invoice,
      amount: 100,
      currency: "SATS",
    },
  } as ParsedOrderMessage
  return {
    ...base,
    latestType: "payment_request",
    messageCount: 2,
    messages: [order, paymentRequest],
  }
}

describe("merchant NWC payment verification", () => {
  it("retries pending evidence and suppresses a published confirmation", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const confirmedEvidence = new Set<string>()
    let settled = false
    let published = 0
    const lookupInvoice = async () => ({
      type: "incoming" as const,
      state: settled ? ("settled" as const) : ("pending" as const),
      invoice,
      paymentHash: "payment-hash",
      amountMsats: 100_000,
      settledAt: 1_700_000_010,
    })
    const publishConfirmation = async () => {
      published += 1
    }

    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 0, lookupFailures: 0 })
    settled = true
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 1, lookupFailures: 0 })
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 0, verified: 0, lookupFailures: 0 })
    expect(published).toBe(1)
  })

  it("retries lookup and publication failures", async () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const confirmedEvidence = new Set<string>()
    let lookupFails = true
    let publishFails = true
    const lookupInvoice = async () => {
      if (lookupFails) throw new Error("wallet unavailable")
      return {
        type: "incoming" as const,
        state: "settled" as const,
        invoice,
        paymentHash: "payment-hash",
        amountMsats: 100_000,
        settledAt: 1_700_000_010,
      }
    }
    const publishConfirmation = async () => {
      if (publishFails) throw new Error("signer unavailable")
    }

    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 0, verified: 0, lookupFailures: 1 })
    lookupFails = false
    await expect(
      verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).rejects.toThrow("signer unavailable")
    publishFails = false
    expect(
      await verifyMerchantPaymentCandidates({
        candidates: [candidate],
        confirmedEvidence,
        lookupInvoice,
        publishConfirmation,
      })
    ).toEqual({ checked: 1, verified: 1, lookupFailures: 0 })
  })

  it("requires exact order invoices and rejects replay across orders", () => {
    const matchingConversation = conversation()
    const candidates = getMerchantPaymentVerificationCandidates([
      matchingConversation,
    ])
    expect(candidates).toEqual([
      expect.objectContaining({
        orderId: "order-1",
        invoice,
        expectedAmountMsats: 100_000,
        inboundOrder: matchingConversation.messages[0],
      }),
    ])
    expect(candidates[0]?.inboundOrder.type).toBe("order")

    expect(
      getMerchantPaymentVerificationCandidates([
        conversation("order-1"),
        conversation("order-2"),
      ])
    ).toEqual([])
    expect(
      getMerchantPaymentVerificationCandidates([
        conversation("order-1"),
        invoiceOnlyConversation("order-2"),
      ])
    ).toEqual([])
  })

  it("does not authorize a fiat payment from an invoice inside cancellation", () => {
    const base = conversation()
    const order = {
      ...base.messages![0]!,
      payload: {
        ...(base.messages![0] as Extract<ParsedOrderMessage, { type: "order" }>)
          .payload,
        subtotal: 1,
        currency: "USD",
      },
    } as ParsedOrderMessage
    const paymentRequest = {
      id: "invoice-inside-cancellation",
      orderId: base.orderId,
      type: "payment_request",
      createdAt: createdAt + 2_000,
      senderPubkey: "merchant",
      recipientPubkey: "buyer",
      rawContent: "",
      payload: {
        orderId: base.orderId,
        invoice,
        amount: 1,
        currency: "USD",
      },
    } as ParsedOrderMessage
    const cancellation = {
      id: "cancel-pending",
      orderId: base.orderId,
      type: "status_update",
      createdAt: createdAt + 1_000,
      senderPubkey: "merchant",
      recipientPubkey: "buyer",
      rawContent: "",
      payload: { orderId: base.orderId, status: "cancelled" },
    } as ParsedOrderMessage
    const reopen = {
      ...cancellation,
      id: "reopen-pending",
      createdAt: createdAt + 3_000,
      payload: {
        orderId: base.orderId,
        status: "pending",
        reopens: cancellation.id,
      },
    } as ParsedOrderMessage
    const proof = {
      ...base.messages![1]!,
      createdAt: createdAt + 4_000,
    } as ParsedOrderMessage
    const reopenedConversation: MerchantConversationSummary = {
      ...base,
      status: "pending",
      latestAt: createdAt + 4_000,
      messages: [order, cancellation, paymentRequest, reopen, proof],
    }

    expect(
      getMerchantPaymentVerificationCandidates([reopenedConversation])
    ).toEqual([])
  })

  it("only accepts incoming, settled, exact, timely wallet results", () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const settlement = {
      type: "incoming" as const,
      state: "settled" as const,
      invoice,
      paymentHash: "payment-hash",
      amountMsats: 100_000,
      settledAt: 1_700_000_010,
    }

    expect(
      isNwcSettlementMatch(candidate, settlement, createdAt + 20_000)
    ).toBe(true)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, type: "outgoing" },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, state: "pending" },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, amountMsats: 99_000 },
        createdAt + 20_000
      )
    ).toBe(false)
    expect(
      isNwcSettlementMatch(
        candidate,
        { ...settlement, paymentHash: "other-hash" },
        createdAt + 20_000
      )
    ).toBe(false)
  })

  it("blocks explicit address mismatches without trusting an address claim", () => {
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "Merchant@Example.com",
        connectionLud16: "merchant@example.com",
        walletLud16: undefined,
      })
    ).toBe("match")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: "other@example.com",
        walletLud16: undefined,
      })
    ).toBe("mismatch")
    expect(
      getMerchantNwcAddressStatus({
        profileLud16: "merchant@example.com",
        connectionLud16: undefined,
        walletLud16: undefined,
      })
    ).toBe("unconfirmed")
  })
})

function minimalBolt11Invoice(hrp: string): string {
  const words = [0, 0, 0, 0, 0, 0, 1]
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  const checksum = Array.from(
    { length: 6 },
    (_, index) => (polymod >> (5 * (5 - index))) & 31
  )
  return `${hrp}1${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

function hrpExpand(hrp: string): number[] {
  return [
    ...Array.from(hrp, (char) => char.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (char) => char.charCodeAt(0) & 31),
  ]
}

function bech32Polymod(values: number[]): number {
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) checksum ^= BECH32_GENERATORS[index]!
    }
  }
  return checksum
}

const invoice = minimalBolt11Invoice("lnbc1000n")
const createdAt = 1_700_000_000_000
