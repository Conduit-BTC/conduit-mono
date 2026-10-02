import { hasCheckoutSparkProviderSendWindow } from "./checkout-spark-invoice-expiry"
import {
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledLegEvidence,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import type { CheckoutSparkSettledRepositorySnapshot } from "./checkout-spark-settled-router-repository"

type Leg = CheckoutSparkSettledReconciliation["legs"][number]
type Intent = NonNullable<Leg["intent"]>

export interface CheckoutSparkSettledOutgoingTarget {
  readonly walletId: string
  readonly network: CheckoutSparkSettledPlan["network"]
  readonly legId: string
  readonly recipientId: string
  readonly allocationSats: number
  /** All unpaid allocations must remain reserved in the current wallet. */
  readonly unpaidAllocationSats: number
  readonly intent: Intent
}

interface CheckoutSparkSettledOutgoingObservationIdentity {
  readonly legId: string
  readonly transferId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
}

export type CheckoutSparkSettledOutgoingObservation =
  CheckoutSparkSettledOutgoingObservationIdentity &
    (
      | {
          readonly status:
            | "not_found"
            | "lookup_unavailable"
            | "conflicting_evidence"
            | "pending"
            | "terminal_failure"
        }
      | {
          readonly status: "paid"
          readonly finalFeeSats: number
          readonly finalDebitSats: number
        }
    )

/** The provider's payment fields needed for exact outgoing reconciliation. */
export interface CheckoutSparkSettledProviderPayment {
  readonly status: string
  readonly fees: unknown
  readonly details?: {
    readonly type: string
    readonly htlcDetails?: {
      readonly paymentHash: string
      readonly preimage?: string
    }
  }
}

function paymentObservation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: CheckoutSparkSettledOutgoingObservation["status"],
  finalFeeSats?: number,
  finalDebitSats?: number
): CheckoutSparkSettledOutgoingObservation {
  const identity = {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
  }
  return status === "paid"
    ? {
        ...identity,
        status,
        finalFeeSats: finalFeeSats!,
        finalDebitSats: finalDebitSats!,
      }
    : { ...identity, status }
}

/** Require the exact provider-verified debit and invoice preimage for a paid leg. */
export async function classifyCheckoutSparkSettledPayment(
  payment: CheckoutSparkSettledProviderPayment,
  target: CheckoutSparkSettledOutgoingTarget,
  verifiedTransferTotalSats?: number
): Promise<CheckoutSparkSettledOutgoingObservation> {
  const fee = payment.fees
  if (
    payment.details?.type !== "lightning" ||
    typeof fee !== "bigint" ||
    fee < 0n ||
    fee > BigInt(target.intent.maxFeeSats)
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  if (payment.status === "pending") return paymentObservation(target, "pending")
  if (payment.status === "failed") {
    return paymentObservation(target, "terminal_failure")
  }
  if (payment.status !== "completed") {
    return paymentObservation(target, "conflicting_evidence")
  }
  if (
    !Number.isSafeInteger(verifiedTransferTotalSats) ||
    verifiedTransferTotalSats !==
      target.intent.invoiceAmountSats + Number(fee) ||
    verifiedTransferTotalSats > target.allocationSats
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  const htlc = payment.details.htlcDetails
  const preimageHex = htlc?.preimage
  if (
    !htlc ||
    htlc.paymentHash?.toLowerCase() !== target.intent.paymentHash ||
    !preimageHex ||
    !/^[0-9a-f]{64}$/i.test(preimageHex) ||
    !globalThis.crypto?.subtle
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  const preimage = Uint8Array.from(preimageHex.match(/.{2}/g)!, (byte) =>
    Number.parseInt(byte, 16)
  )
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", preimage)
  )
  const actualHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return actualHash === target.intent.paymentHash
    ? paymentObservation(target, "paid", Number(fee), verifiedTransferTotalSats)
    : paymentObservation(target, "conflicting_evidence")
}

/** A certified not-sent result is terminal for this frozen invoice in v3. */
export type CheckoutSparkSettledOutgoingSendResult =
  CheckoutSparkSettledOutgoingObservation | { readonly status: "not_sent" }

export interface CheckoutSparkSettledOutgoingProvider {
  /** Exact transfer-ID history; incomplete history must not return not_found. */
  reconcile(
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkSettledOutgoingObservation>
  /** Read-only fee check; the SDK must not send before this returns ready. */
  preflight(
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<
    | "ready"
    | "fee_over_cap"
    | "insufficient_funds"
    | "unavailable"
    | "recipient_unverified"
  >
  /** Must use the frozen transfer ID and fee ceiling in target.intent. */
  send(
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkSettledOutgoingSendResult>
}

export interface CheckoutSparkSettledOutgoingStateStore {
  load(
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkSettledRepositorySnapshot>
  save(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number
  ): Promise<CheckoutSparkSettledRepositorySnapshot>
}

export interface CheckoutSparkSettledOutgoingStepInput {
  checkoutId: string
  planDigest: string
  legId: string
  actor: "shopper" | "merchant"
  /** Reconcile exact history without crossing a provider preflight or send boundary. */
  inspectionOnly?: boolean
  now(): number
  store: CheckoutSparkSettledOutgoingStateStore
  provider: CheckoutSparkSettledOutgoingProvider
  /** Resolves only after the exact encrypted Merchant recovery snapshot is ACKed. */
  acknowledgeRecoverySnapshot(
    state: CheckoutSparkSettledReconciliation
  ): Promise<void>
}

export interface CheckoutSparkSettledOutgoingStepResult {
  readonly state: CheckoutSparkSettledReconciliation
  readonly outcome:
    | "funding_wait"
    | "invoice_needed"
    | "already_paid"
    | "paid"
    | "wait"
    | "send_ambiguous"
  readonly reason?:
    | "authority_not_started"
    | "authority_transferred"
    | "fee_over_cap"
    | "insufficient_funds"
    | "fee_unavailable"
    | "recipient_unverified"
    | "invoice_window_insufficient"
    | "inspection_only"
    | "prior_possible_send"
    | "provider_evidence_unavailable"
    | "provider_evidence_conflicting"
    | "recovery_handoff_unavailable"
    | "terminal_failure"
    | "sibling_possible_send"
    | "prerequisite_unpaid"
  readonly sendAttempted: boolean
}

function observedAt(
  state: CheckoutSparkSettledReconciliation,
  now: number
): number {
  const value = Math.max(now, state.updatedAt + 1)
  if (!Number.isSafeInteger(value)) {
    throw new Error("Checkout Spark observation time is invalid.")
  }
  return value
}

function result(
  state: CheckoutSparkSettledReconciliation,
  outcome: CheckoutSparkSettledOutgoingStepResult["outcome"],
  reason?: CheckoutSparkSettledOutgoingStepResult["reason"],
  sendAttempted = false
): CheckoutSparkSettledOutgoingStepResult {
  return { state, outcome, ...(reason ? { reason } : {}), sendAttempted }
}

function hasAuthority(
  plan: CheckoutSparkSettledPlan,
  actor: CheckoutSparkSettledOutgoingStepInput["actor"],
  now: number
): boolean {
  return actor === "shopper" ? now < plan.takeoverAt : now >= plan.takeoverAt
}

function evidence(
  target: CheckoutSparkSettledOutgoingTarget,
  status: CheckoutSparkSettledLegEvidence["status"],
  observedAt: number,
  finalFeeSats?: number,
  finalDebitSats?: number
): CheckoutSparkSettledLegEvidence {
  return {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentHash: target.intent.paymentHash,
    status,
    observedAt,
    ...(finalFeeSats !== undefined ? { finalFeeSats } : {}),
    ...(finalDebitSats !== undefined ? { finalDebitSats } : {}),
  }
}

function assertObservation(
  observation: CheckoutSparkSettledOutgoingObservation,
  target: CheckoutSparkSettledOutgoingTarget
): void {
  if (
    observation.legId !== target.legId ||
    observation.transferId !== target.intent.transferId ||
    observation.paymentRequest !== target.intent.paymentRequest ||
    observation.paymentHash !== target.intent.paymentHash ||
    observation.invoiceAmountSats !== target.intent.invoiceAmountSats ||
    observation.maxFeeSats !== target.intent.maxFeeSats ||
    (observation.status === "paid" &&
      (!Number.isSafeInteger(observation.finalFeeSats) ||
        observation.finalFeeSats < 0 ||
        observation.finalFeeSats > target.intent.maxFeeSats ||
        !Number.isSafeInteger(observation.finalDebitSats) ||
        observation.finalDebitSats !==
          target.intent.invoiceAmountSats + observation.finalFeeSats ||
        observation.finalDebitSats > target.allocationSats))
  ) {
    throw new Error("Checkout Spark outgoing observation is out of scope.")
  }
}

/**
 * Advance one independently allocated payout. An invoice and transfer ID must
 * already be durably frozen. The write-ahead `submitted` marker is persisted
 * before crossing Spark's send boundary; empty later history never clears it.
 */
export async function runCheckoutSparkSettledOutgoingStep(
  input: CheckoutSparkSettledOutgoingStepInput
): Promise<CheckoutSparkSettledOutgoingStepResult> {
  if (input.actor !== "shopper" && input.actor !== "merchant") {
    throw new Error("Checkout Spark actor is invalid.")
  }
  const loaded = await input.store.load(input.checkoutId, input.planDigest)
  if (loaded.status !== "active") {
    throw new Error("Checkout Spark settled reconciliation is not active.")
  }
  let state = restoreCheckoutSparkSettledReconciliation(loaded.state)
  let revision = loaded.revision
  if (
    state.plan.checkoutId !== input.checkoutId ||
    state.plan.planDigest !== input.planDigest
  ) {
    throw new Error("Checkout Spark settled plan does not match.")
  }
  const position = state.legs.findIndex((leg) => leg.legId === input.legId)
  const recipient = state.plan.recipients[position]
  if (position < 0 || !recipient || recipient.legId !== input.legId) {
    throw new Error("Checkout Spark settled leg is not in the plan.")
  }
  async function persist(next: CheckoutSparkSettledReconciliation) {
    const saved = await input.store.save(next, revision)
    if (
      saved.status !== "active" ||
      saved.revision !== revision + 1 ||
      saved.state.plan.planDigest !== state.plan.planDigest ||
      saved.state.legs[position]?.status !== next.legs[position]?.status ||
      saved.state.updatedAt !== next.updatedAt
    ) {
      throw new Error("Checkout Spark settled state changed during payout.")
    }
    revision = saved.revision
    state = restoreCheckoutSparkSettledReconciliation(saved.state)
  }
  if (!state.credit) return result(state, "funding_wait")
  let leg = state.legs[position]!
  if (leg.status === "paid") return result(state, "already_paid")
  if (
    !input.inspectionOnly &&
    recipient.kind === "conduit" &&
    state.legs.some(
      (candidate, index) =>
        state.plan.recipients[index]?.kind !== "conduit" &&
        candidate.status !== "paid"
    )
  ) {
    return result(state, "wait", "prerequisite_unpaid")
  }
  if (!leg.intent) return result(state, "invoice_needed")
  if (
    !input.inspectionOnly &&
    state.legs.some(
      (sibling) =>
        sibling.legId !== leg.legId &&
        (sibling.status === "submitted" ||
          sibling.status === "ambiguous" ||
          sibling.status === "lookup_unavailable" ||
          sibling.status === "conflicting_evidence")
    )
  ) {
    return result(state, "wait", "sibling_possible_send")
  }
  if (leg.allocationSats === null) {
    throw new Error("Checkout Spark settled allocation is unavailable.")
  }
  const unpaidAllocationSats = state.legs.reduce((total, candidate) => {
    if (candidate.status === "paid") return total
    if (candidate.allocationSats === null) {
      throw new Error("Checkout Spark settled allocation is unavailable.")
    }
    const next = total + candidate.allocationSats
    if (!Number.isSafeInteger(next)) {
      throw new Error("Checkout Spark unpaid allocation is unsafe.")
    }
    return next
  }, 0)
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId: leg.legId,
    recipientId: recipient.recipientId,
    allocationSats: leg.allocationSats,
    unpaidAllocationSats,
    intent: leg.intent,
  }
  if (
    target.intent.invoiceAmountSats + target.intent.maxFeeSats >
    target.allocationSats
  ) {
    throw new Error("Checkout Spark payout exceeds its allocation.")
  }
  // Merchant must have the exact invoice and stable transfer ID before either
  // actor may cross an irreversible provider boundary. An exact-history read
  // is not such a boundary and must remain available during relay failure.
  if (!input.inspectionOnly) {
    try {
      await input.acknowledgeRecoverySnapshot(state)
    } catch {
      return result(state, "wait", "recovery_handoff_unavailable")
    }
  }

  // Positive exact-history evidence may finish a previously ambiguous send.
  // An empty or unavailable read cannot disprove a durable possible-send.
  let observation: CheckoutSparkSettledOutgoingObservation
  try {
    observation = await input.provider.reconcile(target)
  } catch {
    return result(state, "wait", "provider_evidence_unavailable")
  }
  assertObservation(observation, target)
  if (observation.status === "paid") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(
          target,
          "paid",
          observedAt(state, input.now()),
          observation.finalFeeSats,
          observation.finalDebitSats
        )
      )
    )
    return result(state, "paid")
  }
  if (observation.status === "conflicting_evidence") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(target, "conflicting_evidence", observedAt(state, input.now()))
      )
    )
    return result(state, "wait", "provider_evidence_conflicting")
  }
  if (observation.status === "terminal_failure") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(target, "terminal_failure", observedAt(state, input.now()))
      )
    )
    return result(state, "wait", "terminal_failure")
  }
  if (observation.status === "pending") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(target, "ambiguous", observedAt(state, input.now()))
      )
    )
    return result(state, "wait", "prior_possible_send")
  }
  if (leg.status !== "prepared") {
    return result(state, "wait", "prior_possible_send")
  }
  if (observation.status !== "not_found") {
    return result(state, "wait", "provider_evidence_unavailable")
  }
  if (input.inspectionOnly) {
    return result(state, "wait", "inspection_only")
  }
  const now = input.now()
  if (!hasAuthority(state.plan, input.actor, now)) {
    return result(
      state,
      "wait",
      input.actor === "shopper"
        ? "authority_transferred"
        : "authority_not_started"
    )
  }
  if (
    !hasCheckoutSparkProviderSendWindow({
      paymentRequest: target.intent.paymentRequest,
      nowMs: now,
    })
  ) {
    return result(state, "wait", "invoice_window_insufficient")
  }
  let preflight: Awaited<ReturnType<typeof input.provider.preflight>>
  try {
    preflight = await input.provider.preflight(target)
  } catch {
    preflight = "unavailable"
  }
  if (preflight !== "ready") {
    return result(
      state,
      "wait",
      preflight === "fee_over_cap"
        ? "fee_over_cap"
        : preflight === "insufficient_funds"
          ? "insufficient_funds"
          : preflight === "recipient_unverified"
            ? "recipient_unverified"
            : "fee_unavailable"
    )
  }
  const beforeSend = input.now()
  if (!hasAuthority(state.plan, input.actor, beforeSend)) {
    return result(state, "wait", "authority_transferred")
  }
  if (
    !hasCheckoutSparkProviderSendWindow({
      paymentRequest: target.intent.paymentRequest,
      nowMs: beforeSend,
    })
  ) {
    return result(state, "wait", "invoice_window_insufficient")
  }
  await persist(
    recordCheckoutSparkSettledLegStatus(
      state,
      evidence(target, "submitted", observedAt(state, beforeSend))
    )
  )
  leg = state.legs[position]!
  if (leg.status !== "submitted") {
    throw new Error("Checkout Spark payout intent was not persisted.")
  }
  try {
    await input.acknowledgeRecoverySnapshot(state)
  } catch {
    return result(state, "wait", "recovery_handoff_unavailable")
  }
  // A tab dying at this point leaves a conservative possible-send marker.
  const afterWriteAt = input.now()
  if (
    !hasAuthority(state.plan, input.actor, afterWriteAt) ||
    !hasCheckoutSparkProviderSendWindow({
      paymentRequest: target.intent.paymentRequest,
      nowMs: afterWriteAt,
    })
  ) {
    return result(state, "send_ambiguous", "prior_possible_send")
  }
  let sent: CheckoutSparkSettledOutgoingSendResult
  try {
    sent = await input.provider.send(target)
  } catch {
    return result(state, "send_ambiguous", undefined, true)
  }
  if (sent.status !== "not_sent") assertObservation(sent, target)
  if (sent.status === "paid") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(
          target,
          "paid",
          observedAt(state, input.now()),
          sent.finalFeeSats,
          sent.finalDebitSats
        )
      )
    )
    try {
      await input.acknowledgeRecoverySnapshot(state)
    } catch {
      // The exact submitted intent was ACKed before send. Merchant can query
      // that transfer ID even when this later paid-status update is delayed.
    }
    return result(state, "paid", undefined, true)
  }
  if (sent.status === "terminal_failure" || sent.status === "not_sent") {
    await persist(
      recordCheckoutSparkSettledLegStatus(
        state,
        evidence(target, "terminal_failure", observedAt(state, input.now()))
      )
    )
    return result(state, "wait", "terminal_failure", sent.status !== "not_sent")
  }
  return result(state, "send_ambiguous", undefined, true)
}
