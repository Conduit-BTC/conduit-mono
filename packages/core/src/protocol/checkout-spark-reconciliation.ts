import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

const HEX_64 = /^[0-9a-f]{64}$/
const PLAN_DIGEST_DOMAIN = "conduit:checkout-spark-plan:v1"
const OBLIGATION_ID_DOMAIN = "conduit:checkout-spark-obligation:v1"
const OUTGOING_ID_DOMAIN = "conduit:checkout-spark-outgoing:v1"
const MAX_OPAQUE_ID_LENGTH = 256
const MAX_RECIPIENT_ID_LENGTH = 512
const MAX_PAYMENT_REQUEST_LENGTH = 16_384
const FUNDING_STATES = new Set<CheckoutSparkFundingState>([
  "unreconciled",
  "pending",
  "funded_pending_claim",
  "spendable",
  "unresolved_failure",
  "lookup_unavailable",
  "conflicting_evidence",
])
const OBLIGATION_STATES = new Set<CheckoutSparkObligationState>([
  "unreconciled",
  "not_found",
  "pending",
  "ambiguous",
  "lookup_unavailable",
  "conflicting_evidence",
  "paid",
  "terminal_failure",
])
const FUNDING_EVIDENCE_STATES = new Set<
  Exclude<CheckoutSparkFundingState, "unreconciled">
>([
  "pending",
  "funded_pending_claim",
  "spendable",
  "unresolved_failure",
  "lookup_unavailable",
  "conflicting_evidence",
])
const OBLIGATION_EVIDENCE_STATES = new Set<
  Exclude<CheckoutSparkObligationState, "unreconciled">
>([
  "not_found",
  "pending",
  "ambiguous",
  "lookup_unavailable",
  "conflicting_evidence",
  "paid",
  "terminal_failure",
])

export type CheckoutSparkNetwork = "mainnet" | "regtest"

export type CheckoutSparkObligationKind =
  "merchant" | "supplier" | "organizer" | "conduit"

export interface CheckoutSparkFundingPlanInput {
  requestId: string
  paymentRequest: string
  paymentHash: string
  requiredNetSats: number
  grossFundingSats: number
  createdAt: number
  expiresAt: number
}

export interface CheckoutSparkObligationPlanInput {
  kind: CheckoutSparkObligationKind
  recipientId: string
  paymentRequest: string
  amountSats: number
  maxFeeSats: number
}

export interface FreezeCheckoutSparkPlanInput {
  checkoutId: string
  orderId: string
  merchantPubkey: string
  walletId: string
  network: CheckoutSparkNetwork
  createdAt: number
  takeoverAt: number
  funding: CheckoutSparkFundingPlanInput
  obligations: readonly CheckoutSparkObligationPlanInput[]
}

export type CheckoutSparkFundingPlan = CheckoutSparkFundingPlanInput

export interface CheckoutSparkObligationPlan extends CheckoutSparkObligationPlanInput {
  obligationId: string
  outgoingId: string
  position: number
}

export interface CheckoutSparkPlan {
  schemaVersion: 1
  planDigest: string
  checkoutId: string
  orderId: string
  merchantPubkey: string
  walletId: string
  network: CheckoutSparkNetwork
  createdAt: number
  takeoverAt: number
  funding: CheckoutSparkFundingPlan
  obligations: readonly CheckoutSparkObligationPlan[]
}

export type CheckoutSparkActor = "shopper" | "merchant"

export type CheckoutSparkFundingState =
  | "unreconciled"
  | "pending"
  | "funded_pending_claim"
  | "spendable"
  | "unresolved_failure"
  | "lookup_unavailable"
  | "conflicting_evidence"

export type CheckoutSparkObligationState =
  | "unreconciled"
  | "not_found"
  | "pending"
  | "ambiguous"
  | "lookup_unavailable"
  | "conflicting_evidence"
  | "paid"
  | "terminal_failure"

export interface CheckoutSparkFundingProgress {
  state: CheckoutSparkFundingState
  observedAt: number | null
}

export interface CheckoutSparkObligationProgress {
  obligationId: string
  state: CheckoutSparkObligationState
  observedAt: number | null
}

export interface CheckoutSparkReconciliation {
  schemaVersion: 1
  plan: CheckoutSparkPlan
  funding: CheckoutSparkFundingProgress
  obligations: readonly CheckoutSparkObligationProgress[]
  updatedAt: number
}

export interface CheckoutSparkRetirementTombstone {
  schemaVersion: 1
  planDigest: string
  retiredAt: number
}

export interface CheckoutSparkRetirementEvidence {
  walletId: string
  network: CheckoutSparkNetwork
  observedAt: number
  availableSats: number
  ownedSats: number
  incomingSats: number
  fundingReceiveTerminal: boolean
  sendHistoryTerminal: boolean
  claimsTerminal: boolean
  refundsTerminal: boolean
}

export type CheckoutSparkRetirementPendingReason =
  | "stale_funds_evidence"
  | "funds_remaining"
  | "transfer_in_flight"
  | "funding_receive_open"
  | "send_history_open"
  | "claim_path_open"
  | "refund_path_open"
  | "obligation_open"

export type CheckoutSparkRetirementAssessment =
  | { state: "ready" }
  | {
      state: "retirement_pending"
      reasons: CheckoutSparkRetirementPendingReason[]
    }

export interface CheckoutSparkMerchantRecoveryLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

export class CheckoutSparkMerchantRecoveryLockUnavailableError extends Error {
  constructor(message = "Checkout recovery is already active in another tab.") {
    super(message)
    this.name = "CheckoutSparkMerchantRecoveryLockUnavailableError"
  }
}

export type CheckoutSparkEvidence =
  | {
      type: "funding"
      requestId: string
      paymentRequest: string
      paymentHash: string
      walletId: string
      network: CheckoutSparkNetwork
      requiredNetSats: number
      grossFundingSats: number
      state: Exclude<CheckoutSparkFundingState, "unreconciled">
      observedAt: number
    }
  | {
      type: "obligation"
      obligationId: string
      outgoingId: string
      paymentRequest: string
      amountSats: number
      maxFeeSats: number
      state: Exclude<CheckoutSparkObligationState, "unreconciled">
      observedAt: number
    }

export type CheckoutSparkNextAction =
  | { type: "reconcile_funding" }
  | {
      type: "reconcile_obligation"
      obligationId: string
    }
  | {
      type: "send_obligation"
      obligation: CheckoutSparkObligationPlan
    }
  | {
      type: "wait"
      reason:
        | "funding_not_spendable"
        | "obligation_pending"
        | "obligation_ambiguous"
        | "evidence_unavailable"
        | "evidence_conflicting"
        | "obligation_failed"
        | "execution_authority_transferred"
        | "execution_authority_not_started"
    }
  | { type: "ready_to_retire" }

function hashCanonical(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
}

function normalizeBoundedString(
  value: string,
  label: string,
  maxLength = MAX_OPAQUE_ID_LENGTH
): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeHex64(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeSats(
  value: number,
  label: string,
  options: { allowZero?: boolean } = {}
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!options.allowZero && value === 0)
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function deriveObligationId(input: {
  checkoutId: string
  orderId: string
  position: number
  obligation: CheckoutSparkObligationPlanInput
}): string {
  return hashCanonical([
    OBLIGATION_ID_DOMAIN,
    input.checkoutId,
    input.orderId,
    input.position,
    input.obligation.kind,
    input.obligation.recipientId,
    input.obligation.paymentRequest,
    input.obligation.amountSats,
    input.obligation.maxFeeSats,
  ])
}

function formatUuidFromHex(hex: string): string {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = bytesToHex(bytes)
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-")
}

function deriveOutgoingId(input: {
  checkoutId: string
  orderId: string
  obligationId: string
}): string {
  return formatUuidFromHex(
    hashCanonical([
      OUTGOING_ID_DOMAIN,
      input.checkoutId,
      input.orderId,
      input.obligationId,
    ])
  )
}

function canonicalPlanValue(
  plan: Omit<CheckoutSparkPlan, "planDigest">
): unknown {
  return [
    PLAN_DIGEST_DOMAIN,
    plan.schemaVersion,
    plan.checkoutId,
    plan.orderId,
    plan.merchantPubkey,
    plan.walletId,
    plan.network,
    plan.createdAt,
    plan.takeoverAt,
    [
      plan.funding.requestId,
      plan.funding.paymentRequest,
      plan.funding.paymentHash,
      plan.funding.requiredNetSats,
      plan.funding.grossFundingSats,
      plan.funding.createdAt,
      plan.funding.expiresAt,
    ],
    plan.obligations.map((obligation) => [
      obligation.position,
      obligation.obligationId,
      obligation.outgoingId,
      obligation.kind,
      obligation.recipientId,
      obligation.paymentRequest,
      obligation.amountSats,
      obligation.maxFeeSats,
    ]),
  ]
}

function refreezePlan(plan: CheckoutSparkPlan): CheckoutSparkPlan {
  return freezeCheckoutSparkPlan({
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    merchantPubkey: plan.merchantPubkey,
    walletId: plan.walletId,
    network: plan.network,
    createdAt: plan.createdAt,
    takeoverAt: plan.takeoverAt,
    funding: { ...plan.funding },
    obligations: plan.obligations.map((obligation) => ({
      kind: obligation.kind,
      recipientId: obligation.recipientId,
      paymentRequest: obligation.paymentRequest,
      amountSats: obligation.amountSats,
      maxFeeSats: obligation.maxFeeSats,
    })),
  })
}

function canonicalizePlan(plan: CheckoutSparkPlan): CheckoutSparkPlan {
  if (plan.schemaVersion !== 1) {
    throw new Error("Checkout Spark plan version is invalid.")
  }
  const canonical = refreezePlan(plan)
  if (
    canonical.planDigest !== plan.planDigest ||
    canonical.obligations.length !== plan.obligations.length ||
    canonical.obligations.some((obligation, position) => {
      const candidate = plan.obligations[position]
      return (
        !candidate ||
        candidate.position !== obligation.position ||
        candidate.obligationId !== obligation.obligationId ||
        candidate.outgoingId !== obligation.outgoingId
      )
    })
  ) {
    throw new Error("Checkout Spark plan integrity check failed.")
  }
  return canonical
}

function assertPlanIntegrity(plan: CheckoutSparkPlan): void {
  canonicalizePlan(plan)
}

function freezeReconciliation(
  state: CheckoutSparkReconciliation
): CheckoutSparkReconciliation {
  return Object.freeze({
    ...state,
    funding: Object.freeze({ ...state.funding }),
    obligations: Object.freeze(
      state.obligations.map((obligation) => Object.freeze({ ...obligation }))
    ),
  })
}

function assertReconciliationIntegrity(
  state: CheckoutSparkReconciliation
): void {
  if (state.schemaVersion !== 1) {
    throw new Error("Checkout Spark reconciliation version is invalid.")
  }
  assertPlanIntegrity(state.plan)
  if (
    !Number.isSafeInteger(state.updatedAt) ||
    state.updatedAt < state.plan.createdAt ||
    state.obligations.length !== state.plan.obligations.length ||
    !FUNDING_STATES.has(state.funding.state) ||
    (state.funding.state === "unreconciled") !==
      (state.funding.observedAt === null)
  ) {
    throw new Error("Checkout Spark reconciliation state is invalid.")
  }
  for (let position = 0; position < state.obligations.length; position += 1) {
    const progress = state.obligations[position]!
    const obligation = state.plan.obligations[position]!
    if (
      progress.obligationId !== obligation.obligationId ||
      !OBLIGATION_STATES.has(progress.state) ||
      (progress.state === "unreconciled") !== (progress.observedAt === null) ||
      (progress.observedAt !== null &&
        (!Number.isSafeInteger(progress.observedAt) ||
          progress.observedAt < state.plan.createdAt))
    ) {
      throw new Error("Checkout Spark obligation progress is invalid.")
    }
  }
  if (
    state.funding.observedAt !== null &&
    (!Number.isSafeInteger(state.funding.observedAt) ||
      state.funding.observedAt < state.plan.createdAt)
  ) {
    throw new Error("Checkout Spark funding progress is invalid.")
  }
  const latestObservation = Math.max(
    state.plan.createdAt,
    state.funding.observedAt ?? state.plan.createdAt,
    ...state.obligations.map(
      (obligation) => obligation.observedAt ?? state.plan.createdAt
    )
  )
  if (state.updatedAt < latestObservation) {
    throw new Error("Checkout Spark reconciliation timestamp is stale.")
  }
}

function assertPlanNotRetired(
  plan: CheckoutSparkPlan,
  tombstones: readonly CheckoutSparkRetirementTombstone[]
): void {
  for (const tombstone of tombstones) {
    if (
      tombstone.schemaVersion !== 1 ||
      !HEX_64.test(tombstone.planDigest) ||
      !Number.isSafeInteger(tombstone.retiredAt) ||
      tombstone.retiredAt < 0
    ) {
      throw new Error("Checkout Spark retirement tombstone is invalid.")
    }
    if (tombstone.planDigest === plan.planDigest) {
      throw new Error("Checkout Spark plan is already retired.")
    }
  }
}

function mergeObservedState<T extends string>(input: {
  currentState: T
  currentObservedAt: number | null
  nextState: T
  nextObservedAt: number
  terminalStates: readonly T[]
  dominantStates?: readonly T[]
  conflictState: T
}): { state: T; observedAt: number } {
  if (
    input.currentObservedAt !== null &&
    input.nextObservedAt < input.currentObservedAt
  ) {
    return {
      state: input.currentState,
      observedAt: input.currentObservedAt,
    }
  }
  const currentIsDominant = input.dominantStates?.includes(input.currentState)
  const nextIsDominant = input.dominantStates?.includes(input.nextState)
  if (currentIsDominant || nextIsDominant) {
    return {
      state: currentIsDominant ? input.currentState : input.nextState,
      observedAt: Math.max(input.currentObservedAt ?? 0, input.nextObservedAt),
    }
  }
  if (
    input.terminalStates.includes(input.currentState) &&
    !input.terminalStates.includes(input.nextState)
  ) {
    return {
      state: input.currentState,
      observedAt: Math.max(input.currentObservedAt ?? 0, input.nextObservedAt),
    }
  }
  if (
    input.currentObservedAt === input.nextObservedAt &&
    input.currentState !== input.nextState
  ) {
    return { state: input.conflictState, observedAt: input.nextObservedAt }
  }
  return { state: input.nextState, observedAt: input.nextObservedAt }
}

/**
 * Freeze the exact checkout router plan shared by shopper execution and later
 * Merchant recovery. The digest and stable outgoing IDs contain no wallet key
 * material and are deterministic for the same exact payment terms.
 */
export function freezeCheckoutSparkPlan(
  input: FreezeCheckoutSparkPlanInput
): CheckoutSparkPlan {
  const checkoutId = normalizeBoundedString(input.checkoutId, "Checkout id")
  const orderId = normalizeBoundedString(input.orderId, "Order id")
  const merchantPubkey = normalizeHex64(input.merchantPubkey, "Merchant pubkey")
  const walletId = normalizeBoundedString(input.walletId, "Wallet id")
  if (input.network !== "mainnet" && input.network !== "regtest") {
    throw new Error("Checkout Spark network is invalid.")
  }
  const createdAt = normalizeTimestamp(input.createdAt, "Plan creation time")
  const takeoverAt = normalizeTimestamp(input.takeoverAt, "Takeover time")
  if (takeoverAt <= createdAt) {
    throw new Error("Checkout Spark takeover must follow plan creation.")
  }

  const funding: CheckoutSparkFundingPlan = Object.freeze({
    requestId: normalizeBoundedString(
      input.funding.requestId,
      "Funding request id"
    ),
    paymentRequest: normalizeBoundedString(
      input.funding.paymentRequest,
      "Funding payment request",
      MAX_PAYMENT_REQUEST_LENGTH
    ),
    paymentHash: normalizeHex64(
      input.funding.paymentHash,
      "Funding payment hash"
    ),
    requiredNetSats: normalizeSats(
      input.funding.requiredNetSats,
      "Required funding"
    ),
    grossFundingSats: normalizeSats(
      input.funding.grossFundingSats,
      "Gross funding"
    ),
    createdAt: normalizeTimestamp(
      input.funding.createdAt,
      "Funding creation time"
    ),
    expiresAt: normalizeTimestamp(
      input.funding.expiresAt,
      "Funding expiry time"
    ),
  })
  if (
    funding.createdAt !== createdAt ||
    funding.expiresAt <= funding.createdAt ||
    funding.grossFundingSats < funding.requiredNetSats
  ) {
    throw new Error("Checkout Spark funding terms are inconsistent.")
  }

  if (input.obligations.length === 0) {
    throw new Error("Checkout Spark plan requires an outgoing obligation.")
  }
  const obligations = input.obligations.map((candidate, position) => {
    if (
      candidate.kind !== "merchant" &&
      candidate.kind !== "supplier" &&
      candidate.kind !== "organizer" &&
      candidate.kind !== "conduit"
    ) {
      throw new Error("Checkout Spark obligation kind is invalid.")
    }
    const obligation: CheckoutSparkObligationPlanInput = {
      kind: candidate.kind,
      recipientId: normalizeBoundedString(
        candidate.recipientId,
        "Obligation recipient",
        MAX_RECIPIENT_ID_LENGTH
      ),
      paymentRequest: normalizeBoundedString(
        candidate.paymentRequest,
        "Obligation payment request",
        MAX_PAYMENT_REQUEST_LENGTH
      ),
      amountSats: normalizeSats(candidate.amountSats, "Obligation amount"),
      maxFeeSats: normalizeSats(candidate.maxFeeSats, "Obligation fee", {
        allowZero: true,
      }),
    }
    const obligationId = deriveObligationId({
      checkoutId,
      orderId,
      position,
      obligation,
    })
    return Object.freeze({
      ...obligation,
      position,
      obligationId,
      outgoingId: deriveOutgoingId({ checkoutId, orderId, obligationId }),
    })
  })

  const conduitPositions = obligations.flatMap((obligation) =>
    obligation.kind === "conduit" ? [obligation.position] : []
  )
  if (
    conduitPositions.length !== 1 ||
    conduitPositions[0] !== obligations.length - 1
  ) {
    throw new Error(
      "Checkout Spark plan must pay Conduit exactly once and last."
    )
  }
  const requiredNetSats = obligations.reduce(
    (sum, obligation) => sum + obligation.amountSats + obligation.maxFeeSats,
    0
  )
  if (
    !Number.isSafeInteger(requiredNetSats) ||
    requiredNetSats !== funding.requiredNetSats
  ) {
    throw new Error(
      "Checkout Spark funding does not cover its exact obligations."
    )
  }
  if (
    new Set(obligations.map((obligation) => obligation.paymentRequest)).size !==
    obligations.length
  ) {
    throw new Error(
      "Checkout Spark obligations must use distinct payment requests."
    )
  }

  const planWithoutDigest: Omit<CheckoutSparkPlan, "planDigest"> = {
    schemaVersion: 1,
    checkoutId,
    orderId,
    merchantPubkey,
    walletId,
    network: input.network,
    createdAt,
    takeoverAt,
    funding,
    obligations: Object.freeze(obligations),
  }
  return Object.freeze({
    ...planWithoutDigest,
    planDigest: hashCanonical(canonicalPlanValue(planWithoutDigest)),
  })
}

/** Create the serializable actor-neutral state consumed by either app. */
export function createCheckoutSparkReconciliation(
  plan: CheckoutSparkPlan,
  options: {
    tombstones?: readonly CheckoutSparkRetirementTombstone[]
  } = {}
): CheckoutSparkReconciliation {
  const canonicalPlan = canonicalizePlan(plan)
  assertPlanNotRetired(canonicalPlan, options.tombstones ?? [])
  return freezeReconciliation({
    schemaVersion: 1,
    plan: canonicalPlan,
    funding: { state: "unreconciled", observedAt: null },
    obligations: canonicalPlan.obligations.map((obligation) => ({
      obligationId: obligation.obligationId,
      state: "unreconciled",
      observedAt: null,
    })),
    updatedAt: canonicalPlan.createdAt,
  })
}

/** Restore durable progress after reload or in a later Merchant session. */
export function restoreCheckoutSparkReconciliation(
  state: CheckoutSparkReconciliation,
  options: {
    tombstones?: readonly CheckoutSparkRetirementTombstone[]
  } = {}
): CheckoutSparkReconciliation {
  assertReconciliationIntegrity(state)
  const plan = canonicalizePlan(state.plan)
  assertPlanNotRetired(plan, options.tombstones ?? [])
  return freezeReconciliation({
    ...state,
    plan,
    funding: { ...state.funding },
    obligations: state.obligations.map((obligation) => ({ ...obligation })),
  })
}

/**
 * Merge one exact provider observation. Paid outgoing legs are monotonic; stale
 * or same-time contradictory evidence cannot make them payable again.
 */
export function applyCheckoutSparkEvidence(
  state: CheckoutSparkReconciliation,
  evidence: CheckoutSparkEvidence
): CheckoutSparkReconciliation {
  assertReconciliationIntegrity(state)
  const observedAt = normalizeTimestamp(
    evidence.observedAt,
    "Checkout Spark observation time"
  )
  if (observedAt < state.plan.createdAt) {
    throw new Error("Checkout Spark evidence predates its plan.")
  }

  if (evidence.type === "funding") {
    if (!FUNDING_EVIDENCE_STATES.has(evidence.state)) {
      throw new Error("Checkout Spark funding evidence state is invalid.")
    }
    if (
      evidence.requestId !== state.plan.funding.requestId ||
      evidence.paymentRequest !== state.plan.funding.paymentRequest ||
      normalizeHex64(evidence.paymentHash, "Funding payment hash") !==
        state.plan.funding.paymentHash ||
      evidence.walletId !== state.plan.walletId ||
      evidence.network !== state.plan.network ||
      evidence.requiredNetSats !== state.plan.funding.requiredNetSats ||
      evidence.grossFundingSats !== state.plan.funding.grossFundingSats
    ) {
      throw new Error("Checkout Spark funding evidence is out of scope.")
    }
    const funding = mergeObservedState<CheckoutSparkFundingState>({
      currentState: state.funding.state,
      currentObservedAt: state.funding.observedAt,
      nextState: evidence.state,
      nextObservedAt: observedAt,
      terminalStates: [],
      conflictState: "conflicting_evidence",
    })
    return freezeReconciliation({
      ...state,
      funding,
      updatedAt: Math.max(state.updatedAt, observedAt),
    })
  }

  const position = state.plan.obligations.findIndex(
    (obligation) => obligation.obligationId === evidence.obligationId
  )
  const obligation = state.plan.obligations[position]
  if (!OBLIGATION_EVIDENCE_STATES.has(evidence.state)) {
    throw new Error("Checkout Spark obligation evidence state is invalid.")
  }
  if (
    position < 0 ||
    !obligation ||
    evidence.outgoingId !== obligation.outgoingId ||
    evidence.paymentRequest !== obligation.paymentRequest ||
    evidence.amountSats !== obligation.amountSats ||
    evidence.maxFeeSats !== obligation.maxFeeSats
  ) {
    throw new Error("Checkout Spark obligation evidence is out of scope.")
  }
  const progress = state.obligations[position]!
  const merged = mergeObservedState<CheckoutSparkObligationState>({
    currentState: progress.state,
    currentObservedAt: progress.observedAt,
    nextState: evidence.state,
    nextObservedAt: observedAt,
    terminalStates: ["paid", "terminal_failure"],
    dominantStates: ["paid"],
    conflictState: "conflicting_evidence",
  })
  return freezeReconciliation({
    ...state,
    obligations: state.obligations.map((candidate, index) =>
      index === position ? { ...candidate, ...merged } : candidate
    ),
    updatedAt: Math.max(state.updatedAt, observedAt),
  })
}

function waitReasonForFunding(
  state: CheckoutSparkFundingState
): Extract<CheckoutSparkNextAction, { type: "wait" }>["reason"] {
  if (state === "lookup_unavailable") return "evidence_unavailable"
  if (state === "conflicting_evidence") return "evidence_conflicting"
  return "funding_not_spendable"
}

function waitReasonForObligation(
  state: CheckoutSparkObligationState
): Extract<CheckoutSparkNextAction, { type: "wait" }>["reason"] {
  if (state === "lookup_unavailable") return "evidence_unavailable"
  if (state === "conflicting_evidence") return "evidence_conflicting"
  if (state === "ambiguous") return "obligation_ambiguous"
  if (state === "terminal_failure") return "obligation_failed"
  return "obligation_pending"
}

/** Derive the one safe next action without performing provider I/O. */
export function getCheckoutSparkNextAction(
  state: CheckoutSparkReconciliation,
  input: { actor: CheckoutSparkActor; now: number }
): CheckoutSparkNextAction {
  assertReconciliationIntegrity(state)
  if (input.actor !== "shopper" && input.actor !== "merchant") {
    throw new Error("Checkout Spark actor is invalid.")
  }
  const now = normalizeTimestamp(input.now, "Checkout Spark action time")
  if (state.funding.state === "unreconciled") {
    return { type: "reconcile_funding" }
  }
  if (state.funding.state !== "spendable") {
    return { type: "wait", reason: waitReasonForFunding(state.funding.state) }
  }

  for (let position = 0; position < state.obligations.length; position += 1) {
    const progress = state.obligations[position]!
    const obligation = state.plan.obligations[position]!
    if (progress.state === "paid") continue
    if (progress.state === "unreconciled") {
      return {
        type: "reconcile_obligation",
        obligationId: obligation.obligationId,
      }
    }
    if (progress.state === "not_found") {
      if (input.actor === "shopper" && now >= state.plan.takeoverAt) {
        return { type: "wait", reason: "execution_authority_transferred" }
      }
      if (input.actor === "merchant" && now < state.plan.takeoverAt) {
        return { type: "wait", reason: "execution_authority_not_started" }
      }
      return { type: "send_obligation", obligation }
    }
    return { type: "wait", reason: waitReasonForObligation(progress.state) }
  }
  return { type: "ready_to_retire" }
}

/**
 * Assess whether all provider work is terminal and one fresh funds read proves
 * that the checkout wallet has no spendable, owned, or incoming sats left.
 */
export function assessCheckoutSparkRetirement(
  state: CheckoutSparkReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementAssessment {
  assertReconciliationIntegrity(state)
  if (
    evidence.walletId !== state.plan.walletId ||
    evidence.network !== state.plan.network
  ) {
    throw new Error("Checkout Spark retirement evidence is out of scope.")
  }
  const observedAt = normalizeTimestamp(
    evidence.observedAt,
    "Checkout Spark retirement observation time"
  )
  const availableSats = normalizeSats(
    evidence.availableSats,
    "Available retirement funds",
    { allowZero: true }
  )
  const ownedSats = normalizeSats(
    evidence.ownedSats,
    "Owned retirement funds",
    { allowZero: true }
  )
  const incomingSats = normalizeSats(
    evidence.incomingSats,
    "Incoming retirement funds",
    { allowZero: true }
  )
  if (ownedSats < availableSats) {
    throw new Error("Checkout Spark retirement funds are inconsistent.")
  }

  const reasons: CheckoutSparkRetirementPendingReason[] = []
  if (observedAt < state.updatedAt) reasons.push("stale_funds_evidence")
  if (availableSats > 0 || ownedSats > 0) reasons.push("funds_remaining")
  if (incomingSats > 0) reasons.push("transfer_in_flight")
  if (!evidence.fundingReceiveTerminal) reasons.push("funding_receive_open")
  if (!evidence.sendHistoryTerminal) reasons.push("send_history_open")
  if (!evidence.claimsTerminal) reasons.push("claim_path_open")
  if (!evidence.refundsTerminal) reasons.push("refund_path_open")
  if (
    state.obligations.some(
      (obligation) =>
        obligation.state !== "paid" && obligation.state !== "terminal_failure"
    )
  ) {
    reasons.push("obligation_open")
  }
  return reasons.length > 0
    ? { state: "retirement_pending", reasons }
    : { state: "ready" }
}

/**
 * Produce the minimal non-secret marker that prevents a retired plan from
 * being reconstructed and replayed after local state cleanup.
 */
export function retireCheckoutSparkReconciliation(
  state: CheckoutSparkReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementTombstone {
  const assessment = assessCheckoutSparkRetirement(state, evidence)
  if (assessment.state !== "ready") {
    throw new Error("Checkout Spark reconciliation is not ready to retire.")
  }
  return Object.freeze({
    schemaVersion: 1,
    planDigest: state.plan.planDigest,
    retiredAt: evidence.observedAt,
  })
}

function getCheckoutSparkBrowserLockManager(): CheckoutSparkMerchantRecoveryLockManager | null {
  if (
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    !navigator.locks
  ) {
    return null
  }
  return navigator.locks as unknown as CheckoutSparkMerchantRecoveryLockManager
}

/**
 * Serialize Merchant recovery only within this browser profile. This is not a
 * distributed lease and deliberately does not wait behind another active tab.
 */
export async function runWithCheckoutSparkMerchantRecoveryLock<T>(
  planDigest: string,
  operation: () => Promise<T>,
  lockManager: CheckoutSparkMerchantRecoveryLockManager | null = getCheckoutSparkBrowserLockManager(),
  requireCrossTabLock = typeof window !== "undefined"
): Promise<T> {
  const digest = normalizeHex64(planDigest, "Checkout Spark plan digest")
  if (!lockManager) {
    if (requireCrossTabLock) {
      throw new CheckoutSparkMerchantRecoveryLockUnavailableError(
        "This browser cannot safely coordinate checkout recovery across tabs."
      )
    }
    return operation()
  }
  return lockManager.request(
    `conduit:checkout-spark-merchant-recovery:${digest}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new CheckoutSparkMerchantRecoveryLockUnavailableError()
      }
      return operation()
    }
  )
}
