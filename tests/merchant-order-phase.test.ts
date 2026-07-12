import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  getMerchantConversationQueue,
  getMerchantConversationPhase,
  getMerchantConversationStatusDisplay,
  getMerchantOrderSummary,
  isMerchantConversationActiveFulfillment,
} from "../apps/merchant/src/lib/order-phase"

const orderId = "proof-only"
const order: ParsedOrderMessage = {
  id: `${orderId}-order`,
  orderId,
  type: "order",
  createdAt: 1,
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
    createdAt: 1,
  },
} as ParsedOrderMessage
const proof: ParsedOrderMessage = {
  id: `${orderId}-proof`,
  orderId,
  type: "payment_proof",
  createdAt: 2,
  senderPubkey: "buyer",
  recipientPubkey: "merchant",
  rawContent: "",
  payload: {
    orderId,
    rail: "lightning",
    action: "private_checkout",
    amount: 100,
    currency: "SATS",
    invoice: "lnbc100n1proof",
    preimage: "paid-preimage",
    paymentHash: "paid-hash",
    proofDeliveryStatus: "pending",
  },
} as ParsedOrderMessage

const conversation: MerchantConversationSummary = {
  id: orderId,
  orderId,
  buyerPubkey: "buyer",
  merchantPubkey: "merchant",
  latestAt: 2,
  latestType: "payment_proof",
  status: null,
  totalSummary: "100 SATS",
  preview: "Payment proof",
  messageCount: 2,
  messages: [order, proof],
}

function merchantStatus(status: string, createdAt: number): ParsedOrderMessage {
  return {
    id: `${orderId}-${status}-${createdAt}`,
    orderId,
    type: "status_update",
    createdAt,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: { orderId, status },
  } as ParsedOrderMessage
}

const externalReport = {
  ...proof,
  id: `${orderId}-external-report`,
  payload: {
    orderId,
    rail: "lightning",
    action: "external_invoice",
    amount: 100,
    currency: "SATS",
    invoice: "lnbc100n1report",
    source: "external",
    verification: {
      state: "needs_merchant_verification",
      checks: [],
    },
  },
} as ParsedOrderMessage

const shippingUpdate = {
  id: `${orderId}-shipping`,
  orderId,
  type: "shipping_update",
  createdAt: 4,
  senderPubkey: "merchant",
  recipientPubkey: "buyer",
  rawContent: "",
  payload: { orderId, carrier: "UPS", trackingNumber: "1Z" },
} as ParsedOrderMessage

describe("merchant order phase", () => {
  it("uses observed buyer payment evidence consistently across list surfaces", () => {
    expect(getMerchantConversationPhase(conversation)).toBe("in_progress")
    expect(getMerchantConversationStatusDisplay(conversation)).toEqual({
      tone: "info",
      label: "Payment proof received",
    })
    expect(isMerchantConversationActiveFulfillment(conversation)).toBe(true)
  })

  it("puts buyer payment evidence in the verification queue", () => {
    expect(getMerchantConversationQueue(conversation)).toBe("verify_payment")
  })

  it("distinguishes an external payment report from strict proof evidence", () => {
    const reported = {
      ...conversation,
      messages: [order, externalReport],
      latestType: "payment_proof",
    }
    expect(getMerchantConversationStatusDisplay(reported)).toEqual({
      tone: "warning",
      label: "Payment reported — verify",
    })
    expect(getMerchantConversationQueue(reported)).toBe("verify_payment")
  })

  it("routes confirmed payment directly to fulfillment", () => {
    const paid = merchantStatus("paid", 3)
    const confirmed = {
      ...conversation,
      status: "paid",
      messages: [order, proof, paid],
      latestType: "status_update",
    }
    expect(getMerchantConversationStatusDisplay(confirmed).label).toBe("Paid")
    expect(getMerchantConversationQueue(confirmed)).toBe("paid_fulfill")
    expect(getMerchantOrderSummary(confirmed).accepted).toBe(true)
  })

  it("treats the shipment event as shipped even without a generic status", () => {
    const shipped = {
      ...conversation,
      status: "paid",
      messages: [order, proof, merchantStatus("paid", 3), shippingUpdate],
      latestType: "shipping_update",
    }
    expect(getMerchantConversationStatusDisplay(shipped).label).toBe("Shipped")
    expect(getMerchantConversationQueue(shipped)).toBe("shipped")
  })

  it("does not let a later generic status resurrect a cancelled order", () => {
    const cancelled = {
      ...conversation,
      status: "processing",
      messages: [
        order,
        merchantStatus("cancelled", 3),
        merchantStatus("processing", 4),
      ],
      latestType: "status_update",
    }
    expect(getMerchantConversationStatusDisplay(cancelled).label).toBe(
      "Cancelled"
    )
    expect(getMerchantConversationQueue(cancelled)).toBe("closed")
  })

  it("preserves the evidence gates when the partial read has no order rumor", () => {
    const partialConversation: MerchantConversationSummary = {
      ...conversation,
      messageCount: 1,
      messages: [proof],
    }

    expect(getMerchantConversationPhase(partialConversation)).toBe(
      "in_progress"
    )
    expect(getMerchantConversationStatusDisplay(partialConversation)).toEqual({
      tone: "info",
      label: "Payment proof received",
    })
    expect(getMerchantOrderSummary(partialConversation)).toMatchObject({
      paymentProofReceived: true,
      invoiceSent: false,
      accepted: false,
    })
    expect(isMerchantConversationActiveFulfillment(partialConversation)).toBe(
      true
    )
  })
})
