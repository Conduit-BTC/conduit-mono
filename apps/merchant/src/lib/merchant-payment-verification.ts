import {
  decodeLightningInvoiceAmount,
  isValidLud16Address,
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

export type MerchantPaymentVerificationResult = {
  checked: number
  verified: number
  lookupFailures: number
}

export interface MerchantPaymentVerificationIdentity {
  principalPubkey: string | null
  connectionKey: string
  confirmedDestination: string | null
  hasConfirmedDestination: boolean
}

export interface MerchantPaymentVerificationIdentityObservation {
  principalPubkey: string | null
  connectionKey: string
  /**
   * `undefined` means the profile authority is currently unavailable or being
   * refreshed. `null` means a current, confirmed profile has no valid lud16.
   */
  confirmedDestination: string | null | undefined
}

export interface MerchantPaymentStableSnapshot<T extends object> {
  boundary: string
  identity: string
  value: T
}

/**
 * Reuse a semantically unchanged complete snapshot across background fetches.
 * A principal/session boundary change or a completed unavailable read still
 * clears it immediately, while a changed identity replaces it so active work
 * observes the lifecycle transition.
 */
export function reconcileMerchantPaymentStableSnapshot<
  T extends object,
>(input: {
  current: MerchantPaymentStableSnapshot<T> | null
  boundary: string | null
  identity: string | null
  value: T | null
  fetching: boolean
}): MerchantPaymentStableSnapshot<T> | null {
  if (!input.boundary) return null
  if (input.value && input.identity) {
    if (
      input.current?.boundary === input.boundary &&
      input.current.identity === input.identity
    ) {
      return input.current
    }
    return {
      boundary: input.boundary,
      identity: input.identity,
      value: input.value,
    }
  }
  return input.fetching && input.current?.boundary === input.boundary
    ? input.current
    : null
}

/**
 * Signed event ids commit to every field used to derive payment candidates.
 * Sorting makes an unchanged complete read stable even when relay ordering or
 * the query result wrapper changes during a background refresh.
 */
export function getMerchantPaymentConversationSnapshotIdentity(
  conversations: MerchantConversationSummary[]
): string {
  return JSON.stringify(
    conversations
      .flatMap((conversation) =>
        (conversation.messages ?? []).map((message) => message.id)
      )
      .sort()
  )
}

export type MerchantPaymentVerificationRunState = {
  status: "idle" | "checking" | "complete" | "error"
  checked: number
  verified: number
  message?: string
  blocker?: "conversation_read"
}

export class MerchantPaymentConversationSnapshotChangedError extends Error {
  readonly code = "conversation_snapshot_changed"

  constructor() {
    super(
      "Protected order history changed while payment was being checked. Retry with the latest complete history."
    )
    this.name = "MerchantPaymentConversationSnapshotChangedError"
  }
}

export class MerchantPaymentAuthoritySnapshotChangedError extends Error {
  readonly code = "payment_authority_snapshot_changed"

  constructor() {
    super(
      "Payment verification authority changed while an invoice was checked."
    )
    this.name = "MerchantPaymentAuthoritySnapshotChangedError"
  }
}

export function assertMerchantPaymentVerificationReadsIdle(input: {
  conversation?: "fetching" | "paused" | "idle"
  profile?: "fetching" | "paused" | "idle"
  info?: "fetching" | "paused" | "idle"
}): void {
  if (input.conversation && input.conversation !== "idle") {
    throw new MerchantPaymentConversationSnapshotChangedError()
  }
  if (
    (input.profile && input.profile !== "idle") ||
    (input.info && input.info !== "idle")
  ) {
    throw new MerchantPaymentAuthoritySnapshotChangedError()
  }
}

export function getMerchantPaymentVerificationFailureRunState(input: {
  error: unknown
  checked: number
  verified: number
}): MerchantPaymentVerificationRunState {
  if (input.error instanceof MerchantPaymentConversationSnapshotChangedError) {
    return {
      status: "error",
      checked: input.checked,
      verified: input.verified,
      blocker: "conversation_read",
      message:
        "Protected order history changed while payment was being checked. Retrying with the latest complete history.",
    }
  }
  if (input.error instanceof MerchantPaymentAuthoritySnapshotChangedError) {
    return { status: "idle", checked: 0, verified: 0 }
  }
  return {
    status: "error",
    checked: input.checked,
    verified: input.verified,
    message: "Automatic payment verification stopped.",
  }
}

export function reconcileMerchantPaymentConversationReadRunState(input: {
  current: MerchantPaymentVerificationRunState
  eligible: boolean
  fetching: boolean
  unavailable: boolean
  capped: boolean
}): MerchantPaymentVerificationRunState {
  if (!input.eligible || (!input.fetching && !input.unavailable)) {
    return input.current.blocker === "conversation_read"
      ? { status: "idle", checked: 0, verified: 0 }
      : input.current
  }
  if (input.fetching) return input.current
  return {
    status: "error",
    checked: 0,
    verified: 0,
    blocker: "conversation_read",
    message: input.capped
      ? "Automatic payment confirmation is paused because order history reached the secure read limit."
      : "Protected order history is incomplete. Retry before checking pending invoices.",
  }
}

export function isMerchantPaymentConversationReadComplete(input: {
  error?: unknown
  meta?: {
    stale?: boolean
    degraded?: boolean
    capped?: boolean
    inbox?: {
      coverage?: "complete" | "partial" | "unavailable"
    }
  } | null
}): boolean {
  return (
    !input.error &&
    !!input.meta &&
    !input.meta.stale &&
    !input.meta.degraded &&
    !input.meta.capped &&
    input.meta.inbox?.coverage === "complete"
  )
}

export function getMerchantPaymentVerificationCandidatesForRead(input: {
  conversations: MerchantConversationSummary[]
  error?: unknown
  meta?: Parameters<typeof isMerchantPaymentConversationReadComplete>[0]["meta"]
}): MerchantPaymentVerificationCandidate[] {
  return isMerchantPaymentConversationReadComplete(input)
    ? getMerchantPaymentVerificationCandidates(input.conversations)
    : []
}

export function assertMerchantPaymentConversationSnapshotCurrent(
  expected: object,
  current: object | null
): void {
  if (current !== expected) {
    throw new MerchantPaymentConversationSnapshotChangedError()
  }
}

export function assertMerchantPaymentAuthoritySnapshotCurrent(
  expected: object,
  current: object | null
): void {
  if (current !== expected) {
    throw new MerchantPaymentAuthoritySnapshotChangedError()
  }
}

export function advanceMerchantPaymentVerificationIdentity(
  previous: MerchantPaymentVerificationIdentity | null,
  observation: MerchantPaymentVerificationIdentityObservation
): {
  identity: MerchantPaymentVerificationIdentity
  resetEvidence: boolean
} {
  const principalChanged =
    previous !== null &&
    previous.principalPubkey !== observation.principalPubkey
  const connectionChanged =
    previous !== null && previous.connectionKey !== observation.connectionKey
  const hasConfirmedDestination = observation.confirmedDestination !== undefined
  const destinationChanged =
    previous !== null &&
    !principalChanged &&
    previous.hasConfirmedDestination &&
    hasConfirmedDestination &&
    previous.confirmedDestination !== observation.confirmedDestination

  const preserveConfirmedDestination =
    previous !== null && !principalChanged && !hasConfirmedDestination
  const identity: MerchantPaymentVerificationIdentity = {
    principalPubkey: observation.principalPubkey,
    connectionKey: observation.connectionKey,
    confirmedDestination: preserveConfirmedDestination
      ? previous.confirmedDestination
      : (observation.confirmedDestination ?? null),
    hasConfirmedDestination: preserveConfirmedDestination
      ? previous.hasConfirmedDestination
      : hasConfirmedDestination,
  }

  return {
    identity,
    resetEvidence: principalChanged || connectionChanged || destinationChanged,
  }
}

function getMerchantPaymentEvidenceKey(
  candidate: MerchantPaymentVerificationCandidate
): string {
  return `${candidate.orderId}:${candidate.evidenceMessageId}`
}

export async function verifyMerchantPaymentCandidates({
  candidates,
  confirmedEvidence,
  assertAuthorityCurrent,
  lookupInvoice,
  publishConfirmation,
  onConfirmed,
}: {
  candidates: MerchantPaymentVerificationCandidate[]
  confirmedEvidence: Set<string>
  assertAuthorityCurrent?: () => void
  lookupInvoice: (
    candidate: MerchantPaymentVerificationCandidate
  ) => Promise<NwcLookupInvoiceResult>
  publishConfirmation: (
    candidate: MerchantPaymentVerificationCandidate
  ) => Promise<void>
  onConfirmed?: (candidate: MerchantPaymentVerificationCandidate) => void
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
    try {
      assertAuthorityCurrent?.()
      const settlement = await lookupInvoice(candidate)
      assertAuthorityCurrent?.()
      checked += 1
      if (isNwcSettlementMatch(candidate, settlement)) {
        matches.push({
          candidate,
          paymentHash: settlement.paymentHash.toLowerCase(),
        })
      }
    } catch (error) {
      // Snapshot invalidation is a lifecycle boundary, not a wallet lookup
      // failure. Stop the batch so later private invoices are never queried
      // through an authorization or protected-read snapshot that went stale.
      if (
        error instanceof MerchantPaymentConversationSnapshotChangedError ||
        error instanceof MerchantPaymentAuthoritySnapshotChangedError
      ) {
        throw error
      }
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
    assertAuthorityCurrent?.()
    await publishConfirmation(match.candidate)
    confirmedEvidence.add(getMerchantPaymentEvidenceKey(match.candidate))
    verified += 1
    onConfirmed?.(match.candidate)
  }

  return { checked, verified, lookupFailures }
}

function normalizeLud16(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized || null
}

export function selectAuthoritativeMerchantProfileLud16({
  lud16,
  frontierConfirmed,
  degraded,
  capped,
  isFetching,
  hasError,
}: {
  lud16: string | null | undefined
  frontierConfirmed: boolean
  degraded: boolean
  capped: boolean
  isFetching: boolean
  hasError: boolean
}): string | null {
  if (!frontierConfirmed || degraded || capped || isFetching || hasError) {
    return null
  }
  const normalized = normalizeLud16(lud16)
  return normalized && isValidLud16Address(normalized) ? normalized : null
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

  const connection = normalizeLud16(connectionLud16)
  const liveExtension = normalizeLud16(walletLud16)
  if (!connection) {
    return liveExtension && liveExtension !== profile
      ? "mismatch"
      : "unconfirmed"
  }
  if (connection !== profile) return "mismatch"
  if (liveExtension && liveExtension !== profile) return "mismatch"
  return "match"
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
