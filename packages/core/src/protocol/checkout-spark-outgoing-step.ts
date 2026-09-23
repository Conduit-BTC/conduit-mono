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

type ObligationEvidence = Extract<CheckoutSparkEvidence, { type: "obligation" }>

export type CheckoutSparkOutgoingObservation = Omit<
  ObligationEvidence,
  "type" | "observedAt"
>

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
  send(
    target: CheckoutSparkOutgoingTarget
  ): Promise<CheckoutSparkOutgoingObservation>
}

/**
 * Saves must finish durably before the caller can attempt a provider send.
 * The caller also serializes work on the selected wallet; the Merchant path
 * additionally acquires its local duplicate-tab lock below.
 */
export interface CheckoutSparkOutgoingStateStore {
  load(planDigest: string): Promise<CheckoutSparkReconciliation | null>
  save(state: CheckoutSparkReconciliation): Promise<void>
}

export interface CheckoutSparkOutgoingStepInput {
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
  const stored = await input.store.load(input.planDigest)
  if (!stored) {
    throw new Error("Checkout Spark reconciliation is not persisted.")
  }
  let state = restoreCheckoutSparkReconciliation(stored)
  if (state.plan.planDigest !== input.planDigest) {
    throw new Error("Checkout Spark reconciliation plan does not match.")
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

  state = reconciled
  await input.store.save(state)
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

  // Persist uncertainty before crossing the irreversible provider boundary.
  // If the tab dies between this save and send, recovery must not infer that
  // the payment was never attempted from an empty lookup alone.
  const possibleSend = markPossibleSend(
    state,
    position,
    observationTime(state, input.now())
  )
  await input.store.save(possibleSend)
  state = possibleSend
  if (!hasSendAuthority(state, input.actor, input.now())) {
    // This invocation has not called `send`. If it is still alive after the
    // durable write, it can clear its own intent; a crash in this tiny gap
    // intentionally leaves ambiguity rather than risking a duplicate send.
    const observedAt = observationTime(state, input.now())
    state = restoreCheckoutSparkReconciliation({
      ...state,
      obligations: state.obligations.map((progress, index) =>
        index === position
          ? {
              ...progress,
              state: "not_found",
              observedAt,
            }
          : progress
      ),
      updatedAt: observedAt,
    })
    await input.store.save(state)
    return currentResult(state, input, false)
  }

  let sent: CheckoutSparkOutgoingObservation
  try {
    sent = await input.provider.send(target)
  } catch {
    return currentResult(state, input, true)
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
  await input.store.save(state)
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
