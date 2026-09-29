import {
  applyCheckoutSparkEvidence,
  getCheckoutSparkNextAction,
  restoreCheckoutSparkReconciliation,
  runWithCheckoutSparkMerchantRecoveryLock,
  type CheckoutSparkActor,
  type CheckoutSparkEvidence,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkNextAction,
  type CheckoutSparkObligationPlan,
  type CheckoutSparkReconciliation,
} from "./checkout-spark-reconciliation"
import {
  CheckoutSparkRepositoryConflictError,
  type CheckoutSparkRepositorySnapshot,
} from "./checkout-spark-repository"
import { hasCheckoutSparkProviderSendWindow } from "./checkout-spark-invoice-expiry"

type ObligationEvidence = Extract<CheckoutSparkEvidence, { type: "obligation" }>

export type CheckoutSparkOutgoingObservation = Omit<
  ObligationEvidence,
  "type" | "observedAt"
>

/** Only return this when the current invocation provably never entered send. */
export type CheckoutSparkKnownNotSent = {
  status: "not_sent"
  reason: "fee_over_cap" | "fee_unavailable"
}

function isKnownNotSent(value: unknown): value is CheckoutSparkKnownNotSent {
  if (!value || typeof value !== "object") return false
  if (!("status" in value) || value.status !== "not_sent") return false
  if (!("reason" in value)) return false
  return value.reason === "fee_over_cap" || value.reason === "fee_unavailable"
}

export interface CheckoutSparkOutgoingTarget {
  walletId: string
  network: CheckoutSparkReconciliation["plan"]["network"]
  obligation: CheckoutSparkObligationPlan
  /** The provider's exact transfer ID. It must never change on retry. */
  idempotencyKey: string
}

/**
 * The adapter must query the exact transfer ID and validate the returned
 * invoice, amount, actual fee against the approved limit, and transfer
 * identity. `paid` requires completed Lightning proof for the exact invoice.
 * A partial history page or an unavailable lookup is not `not_found`. `send`
 * must use idempotencyKey as the provider transfer ID, not merely dedupe
 * within one JavaScript session.
 */
export interface CheckoutSparkOutgoingProvider {
  reconcile(
    target: CheckoutSparkOutgoingTarget
  ): Promise<CheckoutSparkOutgoingObservation>
  /** Read-only fee check. No provider send may occur before this returns ready. */
  preflight(
    target: CheckoutSparkOutgoingTarget
  ): Promise<"ready" | "fee_over_cap" | "unavailable">
  send(
    target: CheckoutSparkOutgoingTarget
  ): Promise<CheckoutSparkOutgoingObservation | CheckoutSparkKnownNotSent>
}

/**
 * Each save must compare the revision loaded for this checkout and finish
 * durably before a provider send. A stale writer must reject, not overwrite
 * another tab's possible-send marker. The caller also serializes work on the
 * selected wallet; Merchant additionally acquires its local duplicate-tab lock.
 */
export interface CheckoutSparkOutgoingStateStore {
  load(
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkRepositorySnapshot>
  save(
    state: CheckoutSparkReconciliation,
    expectedRevision: number
  ): Promise<CheckoutSparkRepositorySnapshot>
}

export interface CheckoutSparkOutgoingStepInput {
  checkoutId: string
  planDigest: string
  actor: CheckoutSparkActor
  now(): number
  store: CheckoutSparkOutgoingStateStore
  provider: CheckoutSparkOutgoingProvider
  merchantLockManager?: CheckoutSparkMerchantRecoveryLockManager | null
}

export interface CheckoutSparkOutgoingStepResult {
  state: CheckoutSparkReconciliation
  nextAction: CheckoutSparkNextAction
  sendAttempted: boolean
}

const PRIOR_POSSIBLE_SEND = new Set([
  "pending",
  "ambiguous",
  "conflicting_evidence",
  "terminal_failure",
])

function observationTime(
  state: CheckoutSparkReconciliation,
  now: number
): number {
  const observedAt = Math.max(now, state.updatedAt + 1)
  if (!Number.isSafeInteger(observedAt)) {
    throw new Error("Checkout Spark observation time is invalid.")
  }
  return observedAt
}

function asEvidence(
  observation: CheckoutSparkOutgoingObservation,
  observedAt: number
): ObligationEvidence {
  return { ...observation, type: "obligation", observedAt }
}

function assertTargetObservation(
  observation: CheckoutSparkOutgoingObservation,
  target: CheckoutSparkOutgoingTarget
): void {
  const obligation = target.obligation
  if (
    observation.obligationId !== obligation.obligationId ||
    observation.outgoingId !== target.idempotencyKey ||
    observation.paymentRequest !== obligation.paymentRequest ||
    observation.amountSats !== obligation.amountSats ||
    observation.maxFeeSats !== obligation.maxFeeSats
  ) {
    throw new Error("Checkout Spark outgoing observation is out of scope.")
  }
}

function observationFor(
  obligation: CheckoutSparkObligationPlan,
  state: ObligationEvidence["state"]
): CheckoutSparkOutgoingObservation {
  return {
    obligationId: obligation.obligationId,
    outgoingId: obligation.outgoingId,
    paymentRequest: obligation.paymentRequest,
    amountSats: obligation.amountSats,
    maxFeeSats: obligation.maxFeeSats,
    state,
  }
}

function markPossibleSend(
  state: CheckoutSparkReconciliation,
  position: number,
  observedAt: number
): CheckoutSparkReconciliation {
  const next: CheckoutSparkReconciliation = {
    ...state,
    obligations: state.obligations.map((progress, index) =>
      index === position
        ? { ...progress, state: "ambiguous", observedAt }
        : progress
    ),
    updatedAt: observedAt,
  }
  return restoreCheckoutSparkReconciliation(next)
}

function clearOwnUnsentMarker(
  state: CheckoutSparkReconciliation,
  position: number,
  observedAt: number
): CheckoutSparkReconciliation {
  return restoreCheckoutSparkReconciliation({
    ...state,
    obligations: state.obligations.map((progress, index) =>
      index === position
        ? { ...progress, state: "not_found", observedAt }
        : progress
    ),
    updatedAt: observedAt,
  })
}

function currentResult(
  state: CheckoutSparkReconciliation,
  input: CheckoutSparkOutgoingStepInput,
  sendAttempted: boolean
): CheckoutSparkOutgoingStepResult {
  return {
    state,
    nextAction: getCheckoutSparkNextAction(state, {
      actor: input.actor,
      now: input.now(),
    }),
    sendAttempted,
  }
}

function invoiceWindowWait(
  state: CheckoutSparkReconciliation
): CheckoutSparkOutgoingStepResult {
  return {
    state,
    nextAction: {
      type: "wait",
      reason: "obligation_invoice_window_insufficient",
    },
    sendAttempted: false,
  }
}

function hasSendAuthority(
  state: CheckoutSparkReconciliation,
  actor: CheckoutSparkActor,
  now: number
): boolean {
  return actor === "shopper"
    ? now < state.plan.takeoverAt
    : now >= state.plan.takeoverAt
}

async function step(
  input: CheckoutSparkOutgoingStepInput
): Promise<CheckoutSparkOutgoingStepResult> {
  const stored = await input.store.load(input.checkoutId, input.planDigest)
  if (stored.status === "absent") {
    throw new Error("Checkout Spark reconciliation is not persisted.")
  }
  if (stored.status === "retired") {
    throw new Error("Checkout Spark reconciliation is already retired.")
  }
  let state = restoreCheckoutSparkReconciliation(stored.state)
  let revision = stored.revision
  if (
    state.plan.checkoutId !== input.checkoutId ||
    state.plan.planDigest !== input.planDigest
  ) {
    throw new Error("Checkout Spark reconciliation plan does not match.")
  }
  async function persist(next: CheckoutSparkReconciliation) {
    const saved = await input.store.save(next, revision)
    if (
      saved.status !== "active" ||
      saved.revision !== revision + 1 ||
      saved.state.plan.checkoutId !== input.checkoutId ||
      saved.state.plan.planDigest !== input.planDigest ||
      saved.state.updatedAt !== next.updatedAt ||
      saved.state.funding.state !== next.funding.state ||
      saved.state.funding.observedAt !== next.funding.observedAt ||
      saved.state.obligations.length !== next.obligations.length ||
      saved.state.obligations.some(
        (progress, index) =>
          progress.state !== next.obligations[index]?.state ||
          progress.observedAt !== next.obligations[index]?.observedAt
      )
    ) {
      throw new CheckoutSparkRepositoryConflictError()
    }
    revision = saved.revision
    return restoreCheckoutSparkReconciliation(saved.state)
  }
  if (state.funding.state !== "spendable") {
    return currentResult(state, input, false)
  }

  const position = state.obligations.findIndex(
    (progress) => progress.state !== "paid"
  )
  if (position < 0) return currentResult(state, input, false)

  const obligation = state.plan.obligations[position]!
  const target: CheckoutSparkOutgoingTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    obligation,
    idempotencyKey: obligation.outgoingId,
  }
  const priorState = state.obligations[position]!.state
  let observation: CheckoutSparkOutgoingObservation
  try {
    observation = await input.provider.reconcile(target)
  } catch {
    observation = observationFor(obligation, "lookup_unavailable")
  }
  assertTargetObservation(observation, target)
  const providerEvidence = asEvidence(
    observation,
    observationTime(state, input.now())
  )
  const reconciled = applyCheckoutSparkEvidence(state, providerEvidence)

  // A previously attempted or pending send is not disproven by a later empty
  // provider read. Keep its stronger local evidence; only positive/terminal
  // provider resolution may advance it. This favors manual recovery over a
  // second payment after an interrupted first call.
  if (
    PRIOR_POSSIBLE_SEND.has(priorState) &&
    (observation.state === "not_found" ||
      observation.state === "lookup_unavailable")
  ) {
    return currentResult(state, input, false)
  }

  state = await persist(reconciled)
  const action = getCheckoutSparkNextAction(state, {
    actor: input.actor,
    now: input.now(),
  })
  if (
    action.type !== "send_obligation" ||
    action.obligation.obligationId !== obligation.obligationId
  ) {
    return currentResult(state, input, false)
  }
  if (!hasSendAuthority(state, input.actor, input.now())) {
    return currentResult(state, input, false)
  }
  if (
    !hasCheckoutSparkProviderSendWindow({
      paymentRequest: obligation.paymentRequest,
      nowMs: input.now(),
    })
  ) {
    return invoiceWindowWait(state)
  }

  let preflight: Awaited<ReturnType<CheckoutSparkOutgoingProvider["preflight"]>>
  try {
    preflight = await input.provider.preflight(target)
  } catch {
    preflight = "unavailable"
  }
  if (preflight !== "ready") {
    return {
      state,
      nextAction: {
        type: "wait",
        reason:
          preflight === "fee_over_cap"
            ? "fee_exceeds_frozen_limit"
            : "fee_preflight_unavailable",
      },
      sendAttempted: false,
    }
  }
  if (!hasSendAuthority(state, input.actor, input.now())) {
    return currentResult(state, input, false)
  }
  if (
    !hasCheckoutSparkProviderSendWindow({
      paymentRequest: obligation.paymentRequest,
      nowMs: input.now(),
    })
  ) {
    return invoiceWindowWait(state)
  }

  // Persist uncertainty before crossing the irreversible provider boundary.
  // If the tab dies between this save and send, recovery must not infer that
  // the payment was never attempted from an empty lookup alone.
  const possibleSend = markPossibleSend(
    state,
    position,
    observationTime(state, input.now())
  )
  state = await persist(possibleSend)
  const sendAt = input.now()
  const stillAuthorized = hasSendAuthority(state, input.actor, sendAt)
  const invoiceReady = hasCheckoutSparkProviderSendWindow({
    paymentRequest: obligation.paymentRequest,
    nowMs: sendAt,
  })
  if (!stillAuthorized || !invoiceReady) {
    // This invocation has not called `send`. If it is still alive after the
    // durable write, it can clear its own intent; a crash in this tiny gap
    // intentionally leaves ambiguity rather than risking a duplicate send.
    state = await persist(
      clearOwnUnsentMarker(state, position, observationTime(state, input.now()))
    )
    return stillAuthorized
      ? invoiceWindowWait(state)
      : currentResult(state, input, false)
  }

  let sent: CheckoutSparkOutgoingObservation | CheckoutSparkKnownNotSent
  try {
    sent = await input.provider.send(target)
  } catch {
    return currentResult(state, input, true)
  }
  if (isKnownNotSent(sent)) {
    // Only a provider-certified pre-send rejection can clear this invocation's
    // possible-send marker. A revision race leaves the marker intact.
    state = await persist(
      clearOwnUnsentMarker(state, position, observationTime(state, input.now()))
    )
    return {
      state,
      nextAction: {
        type: "wait",
        reason:
          sent.reason === "fee_over_cap"
            ? "fee_exceeds_frozen_limit"
            : "fee_preflight_unavailable",
      },
      sendAttempted: false,
    }
  }
  // Only positive settlement can clear the write-ahead ambiguity here.
  // Other send responses need an independent exact-history reconciliation.
  try {
    assertTargetObservation(sent, target)
  } catch {
    return currentResult(possibleSend, input, true)
  }
  if (sent.state !== "paid") return currentResult(state, input, true)
  try {
    state = applyCheckoutSparkEvidence(
      state,
      asEvidence(sent, observationTime(state, input.now()))
    )
  } catch {
    return currentResult(possibleSend, input, true)
  }
  state = await persist(state)
  return currentResult(state, input, true)
}

/**
 * Advance at most one outgoing obligation. The same operation is safe to call
 * after reload or from Merchant after the frozen takeover time. It never sends
 * from cached `not_found` alone, and it never retries an ambiguous send.
 */
export function runCheckoutSparkOutgoingStep(
  input: CheckoutSparkOutgoingStepInput
): Promise<CheckoutSparkOutgoingStepResult> {
  if (input.actor !== "shopper" && input.actor !== "merchant") {
    return Promise.reject(new Error("Checkout Spark actor is invalid."))
  }
  if (input.actor !== "merchant") return step(input)
  const operation = () => step(input)
  return input.merchantLockManager === undefined
    ? runWithCheckoutSparkMerchantRecoveryLock(input.planDigest, operation)
    : runWithCheckoutSparkMerchantRecoveryLock(
        input.planDigest,
        operation,
        input.merchantLockManager
      )
}
