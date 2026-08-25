import {
  decodeLightningInvoiceAmount,
  getAppliedMerchantOrderMessages,
  type MerchantConversationSummary,
  type NwcLookupInvoiceResult,
  type ParsedOrderMessage,
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
  inboundOrder: Extract<ParsedOrderMessage, { type: "order" }>
  evidenceMessageId: string
  invoice: string
  paymentHash?: string
  expectedAmountMsats: number
  orderCreatedAt: number
  delivery: "buyer_and_self" | "self_only"
}

export type MerchantPaymentVerificationResult = {
  checked: number
  verified: number
  lookupFailures: number
}

export class MerchantPaymentVerificationAuthorityRevokedError extends Error {
  constructor() {
    super("Payment verification authority was revoked")
    this.name = "MerchantPaymentVerificationAuthorityRevokedError"
  }
}

export type MerchantPaymentVerificationAuthorityKey = {
  authGeneration: number
  connectionKey: string
}

export type MerchantPaymentVerificationAuthorityRun =
  MerchantPaymentVerificationAuthorityKey & {
    isCurrent: () => boolean
    finish: () => void
  }

export class MerchantPaymentVerificationAuthority {
  private generation = 0
  private activeRun: symbol | null = null

  revoke(): void {
    this.generation += 1
    this.activeRun = null
  }

  begin({
    authGeneration,
    connectionKey,
  }: MerchantPaymentVerificationAuthorityKey): MerchantPaymentVerificationAuthorityRun | null {
    if (this.activeRun) return null

    const generation = this.generation
    const token = Symbol("merchant-payment-verification")
    this.activeRun = token

    return {
      authGeneration,
      connectionKey,
      isCurrent: () =>
        this.generation === generation && this.activeRun === token,
      finish: () => {
        if (this.activeRun === token) this.activeRun = null
      },
    }
  }
}

function assertVerificationAuthority(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new MerchantPaymentVerificationAuthorityRevokedError()
  }
}

function getMerchantPaymentEvidenceKey(
  candidate: MerchantPaymentVerificationCandidate
): string {
  return `${candidate.buyerPubkey}:${candidate.orderId}:${candidate.invoice.toLowerCase()}`
}

export async function verifyMerchantPaymentCandidates({
  candidates,
  confirmedEvidence,
  lookupInvoice,
  publishConfirmation,
  isCurrent = () => true,
}: {
  candidates: MerchantPaymentVerificationCandidate[]
  confirmedEvidence: Set<string>
  lookupInvoice: (
    candidate: MerchantPaymentVerificationCandidate
  ) => Promise<NwcLookupInvoiceResult>
  publishConfirmation: (
    candidate: MerchantPaymentVerificationCandidate,
    controls: { markPublishStarted: () => void }
  ) => Promise<void>
  isCurrent?: () => boolean
}): Promise<MerchantPaymentVerificationResult> {
  const pendingCandidates = candidates.filter(
    (candidate) =>
      !confirmedEvidence.has(getMerchantPaymentEvidenceKey(candidate))
  )
  let checked = 0
  let verified = 0
  let lookupFailures = 0
  const matches: Array<{
    candidate: MerchantPaymentVerificationCandidate
    paymentHash: string
  }> = []

  for (const candidate of pendingCandidates) {
    assertVerificationAuthority(isCurrent)
    try {
      const settlement = await lookupInvoice(candidate)
      assertVerificationAuthority(isCurrent)
      checked += 1
      if (isNwcSettlementMatch(candidate, settlement)) {
        matches.push({
          candidate,
          paymentHash: settlement.paymentHash.toLowerCase(),
        })
      }
    } catch {
      assertVerificationAuthority(isCurrent)
      lookupFailures += 1
    }
  }

  const paymentHashCounts = new Map<string, number>()
  for (const match of matches) {
    paymentHashCounts.set(
      match.paymentHash,
      (paymentHashCounts.get(match.paymentHash) ?? 0) + 1
    )
  }

  for (const match of matches) {
    if (paymentHashCounts.get(match.paymentHash) !== 1) continue
    assertVerificationAuthority(isCurrent)
    const evidenceKey = getMerchantPaymentEvidenceKey(match.candidate)
    await publishConfirmation(match.candidate, {
      // Once the signed event reaches a relay attempt, ACK loss or authority
      // churn is ambiguous. Retain the evidence key so a replacement run does
      // not emit a second paid status for the same proof.
      markPublishStarted: () => confirmedEvidence.add(evidenceKey),
    })
    assertVerificationAuthority(isCurrent)
    confirmedEvidence.add(evidenceKey)
    verified += 1
  }

  assertVerificationAuthority(isCurrent)
  return { checked, verified, lookupFailures }
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

  const messages = getAppliedMerchantOrderMessages(
    conversation.messages ?? [],
    {
      buyerPubkey: conversation.buyerPubkey,
      merchantPubkey: conversation.merchantPubkey,
    },
    conversation.status
  )
  const order = messages.find(
    (message) =>
      message.type === "order" &&
      message.senderPubkey === conversation.buyerPubkey &&
      message.recipientPubkey === conversation.merchantPubkey
  )
  if (order?.type !== "order") return null

  const delivery =
    getMerchantConversationCommunication(conversation) === "nostr_replyable"
      ? "buyer_and_self"
      : "self_only"
  if (delivery === "self_only" && !conversation.lifecycleWriteReady) {
    return null
  }

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
    inboundOrder: order,
    evidenceMessageId: evidence.id,
    invoice,
    paymentHash: evidence.payload.paymentHash?.trim() || undefined,
    expectedAmountMsats: decoded.msats,
    orderCreatedAt: order.createdAt,
    delivery,
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
    const messages = getAppliedMerchantOrderMessages(
      conversation.messages ?? [],
      {
        buyerPubkey: conversation.buyerPubkey,
        merchantPubkey: conversation.merchantPubkey,
      },
      conversation.status
    )
    for (const message of messages) {
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
