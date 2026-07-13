import {
  decodeLightningInvoiceAmount,
  type MerchantConversationSummary,
  type NwcLookupInvoiceResult,
} from "@conduit/core"
import {
  getMerchantConversationCommunication,
  getMerchantConversationQueue,
} from "./order-phase"

export type MerchantNwcAddressStatus =
  "match" | "mismatch" | "unconfirmed" | "missing_profile"

export interface MerchantPaymentVerificationCandidate {
  orderId: string
  buyerPubkey: string
  evidenceMessageId: string
  invoice: string
  paymentHash?: string
  expectedAmountMsats: number
  orderCreatedAt: number
  delivery: "buyer_and_self" | "self_only"
}

function normalizeLud16(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized || null
}

export function getMerchantNwcAddressStatus({
  profileLud16,
  connectionLud16,
  walletLud16,
}: {
  profileLud16: string | null | undefined
  connectionLud16: string | null | undefined
  walletLud16: string | null | undefined
}): MerchantNwcAddressStatus {
  const profile = normalizeLud16(profileLud16)
  if (!profile) return "missing_profile"

  const reported = [connectionLud16, walletLud16]
    .map(normalizeLud16)
    .filter((value): value is string => !!value)
  if (reported.some((value) => value !== profile)) return "mismatch"
  return reported.length > 0 ? "match" : "unconfirmed"
}

function findCandidate(
  conversation: MerchantConversationSummary
): MerchantPaymentVerificationCandidate | null {
  if (getMerchantConversationQueue(conversation) !== "verify_payment") {
    return null
  }

  const messages = conversation.messages ?? []
  const order = messages.find(
    (message) =>
      message.type === "order" &&
      message.senderPubkey === conversation.buyerPubkey &&
      message.recipientPubkey === conversation.merchantPubkey
  )
  if (order?.type !== "order") return null

  const evidence = [...messages]
    .reverse()
    .find(
      (message) =>
        message.type === "payment_proof" &&
        message.senderPubkey === conversation.buyerPubkey &&
        message.recipientPubkey === conversation.merchantPubkey &&
        !!message.payload.invoice &&
        message.payload.verification?.state !== "verification_failed" &&
        message.payload.verification?.state !== "disputed"
    )
  if (evidence?.type !== "payment_proof" || !evidence.payload.invoice) {
    return null
  }

  const invoice = evidence.payload.invoice.trim()
  const decoded = decodeLightningInvoiceAmount(invoice)
  if (decoded.msats === null || decoded.msats <= 0) return null

  const latestMerchantInvoice = [...messages]
    .reverse()
    .find(
      (message) =>
        message.type === "payment_request" &&
        message.senderPubkey === conversation.merchantPubkey &&
        message.recipientPubkey === conversation.buyerPubkey
    )
  const matchesMerchantInvoice =
    latestMerchantInvoice?.type === "payment_request" &&
    latestMerchantInvoice.payload.invoice.trim().toLowerCase() ===
      invoice.toLowerCase()
  const orderCurrency = order.payload.currency.trim().toUpperCase()
  const matchesSatsOrder =
    (orderCurrency === "SAT" || orderCurrency === "SATS") &&
    order.payload.subtotal * 1000 === decoded.msats

  // Fiat conversion is time-sensitive. Only automate it when the merchant
  // authored the exact invoice; otherwise leave the report for manual review.
  if (!matchesMerchantInvoice && !matchesSatsOrder) return null

  return {
    orderId: conversation.orderId,
    buyerPubkey: conversation.buyerPubkey,
    evidenceMessageId: evidence.id,
    invoice,
    paymentHash: evidence.payload.paymentHash?.trim() || undefined,
    expectedAmountMsats: decoded.msats,
    orderCreatedAt: order.createdAt,
    delivery:
      getMerchantConversationCommunication(conversation) === "nostr_replyable"
        ? "buyer_and_self"
        : "self_only",
  }
}

export function getMerchantPaymentVerificationCandidates(
  conversations: MerchantConversationSummary[]
): MerchantPaymentVerificationCandidate[] {
  const candidates = conversations.flatMap((conversation) => {
    const candidate = findCandidate(conversation)
    return candidate ? [candidate] : []
  })
  const invoiceOrders = new Map<string, Set<string>>()
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      if (
        (message.type !== "payment_proof" &&
          message.type !== "payment_request") ||
        !message.payload.invoice
      ) {
        continue
      }
      const invoice = message.payload.invoice.trim().toLowerCase()
      const orders = invoiceOrders.get(invoice) ?? new Set<string>()
      orders.add(conversation.orderId)
      invoiceOrders.set(invoice, orders)
    }
  }

  return candidates.filter(
    (candidate) =>
      invoiceOrders.get(candidate.invoice.toLowerCase())?.size === 1
  )
}

export function isNwcSettlementMatch(
  candidate: MerchantPaymentVerificationCandidate,
  settlement: NwcLookupInvoiceResult,
  now = Date.now()
): boolean {
  if (settlement.type !== "incoming" || settlement.state !== "settled") {
    return false
  }
  if (
    settlement.invoice.trim().toLowerCase() !== candidate.invoice.toLowerCase()
  ) {
    return false
  }
  if (settlement.amountMsats !== candidate.expectedAmountMsats) return false
  if (
    candidate.paymentHash &&
    settlement.paymentHash.toLowerCase() !== candidate.paymentHash.toLowerCase()
  ) {
    return false
  }
  if (!settlement.settledAt) return false
  const settledAtMs = settlement.settledAt * 1000
  const clockToleranceMs = 5 * 60_000
  return (
    settledAtMs >= candidate.orderCreatedAt - clockToleranceMs &&
    settledAtMs <= now + clockToleranceMs
  )
}
