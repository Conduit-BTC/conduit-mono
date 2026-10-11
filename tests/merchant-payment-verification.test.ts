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

import { bytesToBolt11Words, makeBolt11Fixture } from "./support/bolt11-fixture"

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
      paymentHash: paymentHash,
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
  it("rejects a settled buyer invoice that replaces a merchant request and its original wallet binding", async () => {
    const input = conversation("substitution")
    const original = invoiceOnlyConversation("substitution").messages![1]!
    if (original.type !== "payment_request") throw new Error("Missing request")
    original.payload.invoice = minimalBolt11Invoice(
      "lnbc1000n",
      "02".repeat(32)
    )
    ;(original.payload as any).receivingWallet = {
      walletId: "original",
      providerId: "spark",
      network: "mainnet",
      requestId: "original",
    }
    input.messages = [input.messages![0]!, original, input.messages![1]!]
    let confirmations = 0
    const result = await verifyMerchantPaymentCandidates({
      candidates: getMerchantPaymentVerificationCandidates([input]),
      confirmedEvidence: new Set(),
      lookupInvoice: async () => ({
        type: "incoming",
        state: "settled",
        invoice,
        paymentHash,
        amountMsats: 100000,
        settledAt: 1700000010,
      }),
      publishConfirmation: async () => {
        confirmations++
      },
    })
    expect(result.verified).toBe(0)
    expect(confirmations).toBe(0)
  })
  it("preserves the exact earlier merchant invoice binding after another request", () => {
    const input = conversation("earlier-invoice")
    const original = invoiceOnlyConversation("earlier-invoice").messages![1]!
    const later = invoiceOnlyConversation("earlier-invoice").messages![1]!
    if (original.type !== "payment_request" || later.type !== "payment_request")
      throw new Error("Missing request")
    ;(original.payload as any).receivingWallet = {
      walletId: "original",
      providerId: "spark",
      network: "mainnet",
    }
    later.payload.invoice = minimalBolt11Invoice("lnbc1000n", "02".repeat(32))
    ;(later.payload as any).receivingWallet = {
      walletId: "later",
      providerId: "spark",
      network: "mainnet",
    }
    input.messages = [input.messages![0]!, original, later, input.messages![1]!]
    const candidate = getMerchantPaymentVerificationCandidates([input])[0]!
    expect(candidate.invoice).toBe(invoice)
    expect(candidate).not.toHaveProperty("receivingWallet")
  })
  it("binds invoice-only settlement to the invoice's encoded hash", () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      invoiceOnlyConversation("hash-binding"),
    ])[0]!
    expect(
      isNwcSettlementMatch(candidate, {
        type: "incoming",
        state: "settled",
        invoice,
        paymentHash: "03".repeat(32),
        amountMsats: 100000,
        settledAt: 1700000010,
      })
    ).toBe(false)
  })
  it("rejects proof hash substitution and amount-only invoices", () => {
    const input = conversation()
    const proof = input.messages![1]!
    if (proof.type !== "payment_proof") throw new Error("Missing proof")
    proof.payload.paymentHash = "03".repeat(32)
    expect(getMerchantPaymentVerificationCandidates([input])).toEqual([])
    proof.payload.paymentHash = undefined
    proof.payload.invoice = makeBolt11Fixture({ hrp: "lnbc1000n", fields: [] })
    expect(getMerchantPaymentVerificationCandidates([input])).toEqual([])
  })

  it("uses the merchant-authored original destination without a buyer proof or current profile address", async () => {
    const original = {
      walletId: "original",
      providerId: "spark" as const,
      network: "mainnet" as const,
      requestId: "original-request",
    }
    const input = invoiceOnlyConversation("bound-order")
    const request = input.messages!.find(
      (message) => message.type === "payment_request"
    )!
    if (request.type !== "payment_request") throw new Error("Missing invoice")
    ;(request.payload as any).receivingWallet = original
    const candidate = getMerchantPaymentVerificationCandidates([input])[0]!
    expect(candidate).not.toHaveProperty("receivingWallet")
    let confirmations = 0
    const result = await verifyMerchantPaymentCandidates({
      candidates: [candidate],
      confirmedEvidence: new Set(),
      lookupInvoice: async (supplied) => {
        expect(supplied).not.toHaveProperty("receivingWallet")
        return {
          type: "incoming",
          state: "settled",
          invoice,
          paymentHash: paymentHash,
          amountMsats: 100000,
          settledAt: 1700000010,
        }
      },
      publishConfirmation: async () => {
        confirmations++
      },
    })
    expect(result.verified).toBe(1)
    expect(confirmations).toBe(1)
  })

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
      paymentHash: paymentHash,
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
        paymentHash: paymentHash,
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
    expect(getMerchantPaymentVerificationCandidates([conversation()])).toEqual([
      expect.objectContaining({
        orderId: "order-1",
        invoice,
        expectedAmountMsats: 100_000,
      }),
    ])

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

  it("uses the order payload date when publication crosses UTC midnight", () => {
    const orderCreatedAt = Date.parse("2026-09-17T23:59:59.000Z")
    const publishedAt = Date.parse("2026-09-18T00:00:01.000Z")
    const input = conversation()
    const order = input.messages?.find((message) => message.type === "order")
    if (order?.type !== "order") throw new Error("Order fixture is missing")
    order.createdAt = publishedAt
    order.payload.createdAt = orderCreatedAt

    expect(getMerchantPaymentVerificationCandidates([input])).toEqual([
      expect.objectContaining({ orderCreatedAt }),
    ])
  })

  it("only accepts incoming, settled, exact, timely wallet results", () => {
    const candidate = getMerchantPaymentVerificationCandidates([
      conversation(),
    ])[0]!
    const settlement = {
      type: "incoming" as const,
      state: "settled" as const,
      invoice,
      paymentHash: paymentHash,
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

function minimalBolt11Invoice(hrp: string, hash = paymentHash): string {
  return makeBolt11Fixture({
    hrp,
    fields: [
      {
        tag: "p",
        words: bytesToBolt11Words(
          Uint8Array.from(hash.match(/.{2}/g)!, (byte) =>
            Number.parseInt(byte, 16)
          )
        ),
      },
    ],
  })
}
const paymentHash = "01".repeat(32)
const invoice = minimalBolt11Invoice("lnbc1000n")
const createdAt = 1_700_000_000_000
