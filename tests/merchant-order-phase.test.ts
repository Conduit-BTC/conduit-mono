import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  getMerchantConversationPhase,
  getMerchantConversationStatusDisplay,
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
  latestAt: 2,
  latestType: "payment_proof",
  status: null,
  totalSummary: "100 SATS",
  preview: "Payment proof",
  messageCount: 2,
  messages: [order, proof],
}

describe("merchant order phase", () => {
  it("uses observed buyer payment evidence consistently across list surfaces", () => {
    expect(getMerchantConversationPhase(conversation)).toBe("in_progress")
    expect(getMerchantConversationStatusDisplay(conversation)).toEqual({
      tone: "info",
      label: "Payment proof received",
    })
    expect(isMerchantConversationActiveFulfillment(conversation)).toBe(true)
  })
})
