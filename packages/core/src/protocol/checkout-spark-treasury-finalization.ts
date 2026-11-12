import { createCheckoutSparkPreProviderCancellationRegistry } from "./checkout-spark-pre-provider-cancellation"
import {
  type CheckoutSparkSettledReconciliation,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledLegStatus,
  assertCheckoutSparkSettledFundingCoverage,
} from "./checkout-spark-settled-router"
import {
  invalid,
  type CheckoutSparkNativeTreasuryBudget,
  budgetFromExactState,
  type CheckoutSparkNativeTreasuryFinalization,
  createCheckoutSparkNativeTreasuryFinalization,
  id,
  type CheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkNativeTreasuryIntent,
  isCheckoutSparkNativeTreasuryPlan,
} from "./checkout-spark-treasury-model"
import {
  type CheckoutSparkMerchantSettlementRecord,
  restoreCheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement-model"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import type { CheckoutSparkNativeTreasurySdkSendResult } from "./checkout-spark-treasury-sdk"
import type {
  CheckoutSparkSettledOutgoingStateStore,
  CheckoutSparkSettledOutgoingStepResult,
} from "./checkout-spark-settled-outgoing"
import type { CheckoutSparkSettledRepositorySnapshot } from "./checkout-spark-settled-router-repository"

export {
  type CheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkNativeTreasuryInvoiceIdInput,
  type CheckoutSparkNativeTreasuryBudget,
  type CheckoutSparkNativeTreasuryIntent,
  type CheckoutSparkNativeTreasuryFinalization,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  restoreCheckoutSparkNativeTreasuryPlan,
  createCheckoutSparkNativeTreasuryFinalization,
  restoreCheckoutSparkNativeTreasuryFinalization,
} from "./checkout-spark-treasury-model"

declare const nativeCancellationBrand: unique symbol

/** Non-serializable authority created only after a positively unsent admission. */
export interface CheckoutSparkNativePreProviderCancellation {
  readonly [nativeCancellationBrand]: true
}

const nativeCancellations =
  createCheckoutSparkPreProviderCancellationRegistry<CheckoutSparkNativePreProviderCancellation>()

const cancellationKey = (state: CheckoutSparkSettledReconciliation) =>
  `${state.plan.checkoutId}:${state.plan.planDigest}`

function rememberPreProviderCancellation(
  scope: object,
  state: CheckoutSparkSettledReconciliation,
  revision: number
): void {
  nativeCancellations.remember(scope, state, revision, cancellationKey(state))
}

function loadPreProviderCancellation(
  scope: object | undefined,
  state: CheckoutSparkSettledReconciliation,
  revision: number
): CheckoutSparkNativePreProviderCancellation | undefined {
  return nativeCancellations.load(
    scope,
    state,
    revision,
    cancellationKey(state)
  )
}

/** Presentation/continuation hint only; the engine and CAS recheck exact proof. */
export function hasCheckoutSparkNativePreProviderCancellation(
  scope: object | undefined,
  state: CheckoutSparkSettledReconciliation,
  revision: number
): boolean {
  return (
    state.treasuryFinalization?.status === "terminal_failure" &&
    Boolean(loadPreProviderCancellation(scope, state, revision))
  )
}

/** A serialized cancellation label, imported progress, or reload is not proof. */
export function assertCheckoutSparkNativePreProviderRetry(
  scope: object,
  previous: CheckoutSparkSettledReconciliation,
  next: CheckoutSparkSettledReconciliation,
  expectedRevision: number,
  capability: CheckoutSparkNativePreProviderCancellation
): void {
  const authority = nativeCancellations.authority(capability)
  if (
    !authority ||
    authority.consumed ||
    authority.scope !== scope ||
    authority.revision !== expectedRevision ||
    authority.state !== JSON.stringify(previous) ||
    previous.treasuryFinalization?.status !== "terminal_failure" ||
    previous.treasuryFinalization.providerTransferId !== null ||
    next.treasuryFinalization?.status !== "submitted" ||
    next.treasuryFinalization.providerTransferId !== null ||
    JSON.stringify(previous.treasuryFinalization.intent) !==
      JSON.stringify(next.treasuryFinalization.intent)
  )
    invalid()
  // All other monotonic fields are checked by the repository against a synthetic
  // submitted predecessor. This exception changes no amount, request or identity.
}

/** Adapter gate for an engine-owned retry; it conveys no cold recovery proof. */
export function isCheckoutSparkNativePreProviderRetry(
  capability: CheckoutSparkNativePreProviderCancellation | undefined,
  target: CheckoutSparkNativeTreasuryTarget
): boolean {
  if (!capability) return false
  const authority = nativeCancellations.authority(capability)
  if (!authority || authority.consumed) return false
  const state = JSON.parse(
    authority.state
  ) as CheckoutSparkSettledReconciliation
  return (
    state.plan.recipients.find((recipient) => recipient.kind === "conduit")
      ?.legId === target.legId &&
    state.plan.planDigest === target.planDigest &&
    state.plan.walletId === target.walletId &&
    state.plan.network === target.network &&
    JSON.stringify(state.plan.nativeTreasury) ===
      JSON.stringify(target.nativeTreasury) &&
    JSON.stringify(state.treasuryFinalization?.intent) ===
      JSON.stringify(target.intent)
  )
}

/** Credit-attributed residual only; wallet balance and extra deposits are absent. */
export function deriveCheckoutSparkNativeTreasuryBudget(
  input: CheckoutSparkSettledReconciliation,
  settlement: CheckoutSparkMerchantSettlementRecord
): CheckoutSparkNativeTreasuryBudget {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  const record = restoreCheckoutSparkMerchantSettlementRecord(
    settlement,
    state.plan
  )
  const budget = budgetFromExactState(state)
  if (
    !record.credit ||
    record.credit.transferId !== state.credit!.transferId ||
    record.credit.creditedSats !== state.credit!.creditedSats
  )
    invalid()
  const requiredPayoutIds =
    state.plan.schemaVersion === 5
      ? state.plan.recipients
          .filter((recipient) => recipient.kind !== "conduit")
          .map((recipient) => recipient.legId)
      : record.requiredCommerceLegIds
  for (const legId of requiredPayoutIds) {
    const leg = state.legs.find((candidate) => candidate.legId === legId)!
    const paid = record.paidLegs.find((candidate) => candidate.legId === legId)
    if (
      !paid ||
      paid.recipientVerified !== true ||
      paid.transferId !== leg.intent!.transferId ||
      paid.allocationSats !== leg.allocationSats ||
      paid.finalDebitSats !== leg.finalDebitSats ||
      paid.finalFeeSats !== leg.finalFeeSats
    )
      invalid()
  }
  return budget
}

function mirror(
  state: CheckoutSparkSettledReconciliation,
  treasuryFinalization: CheckoutSparkNativeTreasuryFinalization
): CheckoutSparkSettledReconciliation {
  const feeId = state.plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )!.legId
  return restoreCheckoutSparkSettledReconciliation({
    ...state,
    treasuryFinalization,
    legs: state.legs.map((leg) =>
      leg.legId === feeId
        ? {
            ...leg,
            status: treasuryFinalization.status,
            observedAt: treasuryFinalization.observedAt,
            finalFeeSats: treasuryFinalization.finalFeeSats,
            finalDebitSats: treasuryFinalization.finalDebitSats,
          }
        : leg
    ),
    updatedAt: Math.max(
      state.updatedAt,
      treasuryFinalization.observedAt ?? state.updatedAt
    ),
  })
}

export function prepareCheckoutSparkNativeTreasury(
  input: CheckoutSparkSettledReconciliation,
  options: {
    settlement: CheckoutSparkMerchantSettlementRecord
    preparedAt: number
  }
): CheckoutSparkSettledReconciliation {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  const budget = deriveCheckoutSparkNativeTreasuryBudget(
    state,
    options.settlement
  )
  if (budget.authorizedDebitSats === 0) {
    throw new Error(
      "Checkout Spark native treasury has zero attributed remainder."
    )
  }
  if (state.treasuryFinalization!.intent) return state
  return mirror(state, {
    ...createCheckoutSparkNativeTreasuryFinalization(),
    status: "prepared",
    observedAt: options.preparedAt,
    intent: {
      ...budget,
      invoiceId: state.plan.nativeTreasury!.invoiceId,
      invoiceRequest: state.plan.nativeTreasury!.invoiceRequest,
      amountSats: budget.authorizedDebitSats,
      preparedAt: options.preparedAt,
    },
  })
}

export interface CheckoutSparkNativeTreasuryEvidence {
  readonly invoiceId: string
  readonly status: Exclude<
    CheckoutSparkSettledLegStatus,
    "unprepared" | "prepared"
  >
  readonly providerTransferId?: string
  readonly observedAt: number
  readonly finalFeeSats?: number
  readonly finalDebitSats?: number
}

/** Persist observations only from exact native invoice + transfer provider history. */
export function recordCheckoutSparkNativeTreasuryStatus(
  input: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkNativeTreasuryEvidence
): CheckoutSparkSettledReconciliation {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  const previous = state.treasuryFinalization
  if (
    !previous?.intent ||
    evidence.invoiceId !== previous.intent.invoiceId ||
    evidence.observedAt < previous.observedAt! ||
    (previous.providerTransferId &&
      evidence.providerTransferId &&
      evidence.providerTransferId !== previous.providerTransferId)
  )
    invalid()
  const next = {
    ...previous,
    status: evidence.status,
    providerTransferId:
      evidence.providerTransferId ?? previous.providerTransferId,
    observedAt: evidence.observedAt,
    finalFeeSats: evidence.finalFeeSats ?? null,
    finalDebitSats: evidence.finalDebitSats ?? null,
  }
  if (
    previous.status === "paid" &&
    (next.status !== "paid" ||
      next.finalFeeSats !== previous.finalFeeSats ||
      next.finalDebitSats !== previous.finalDebitSats)
  )
    invalid()
  return mirror(state, next)
}

/** An admitted SDK response adds a reference, never a payment receipt. */
export function recordCheckoutSparkNativeTreasurySubmittedReference(
  input: CheckoutSparkSettledReconciliation,
  providerTransferId: string,
  observedAt: number
): CheckoutSparkSettledReconciliation {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  const previous = state.treasuryFinalization
  if (
    previous?.status !== "submitted" ||
    !previous.intent ||
    previous.providerTransferId !== null ||
    previous.finalFeeSats !== null ||
    previous.finalDebitSats !== null ||
    !id(providerTransferId)
  )
    invalid()
  return recordCheckoutSparkNativeTreasuryStatus(state, {
    invoiceId: previous.intent.invoiceId,
    status: "submitted",
    providerTransferId,
    observedAt,
  })
}

export interface CheckoutSparkNativeTreasuryTarget {
  readonly walletId: string
  readonly network: CheckoutSparkNetwork
  readonly legId: string
  readonly planDigest: string
  readonly nativeTreasury: CheckoutSparkNativeTreasuryPlan
  readonly intent: CheckoutSparkNativeTreasuryIntent
}

export type CheckoutSparkNativeTreasuryObservation = {
  readonly invoiceId: string
  readonly providerTransferId?: string
} & (
  | {
      readonly status:
        | "not_found"
        | "lookup_unavailable"
        | "conflicting_evidence"
        | "terminal_failure"
    }
  | {
      readonly status: "pending"
      /** Finite exact-transfer progress only; never receipt or retry authority. */
      readonly pendingPhase?: "sender" | "receiver"
    }
  | {
      readonly status: "paid"
      readonly finalFeeSats: number
      readonly finalDebitSats: number
    }
)

/**
 * Ports for one Core-engine invocation, not standalone wallet send actions.
 * App adapters admit send only across that invocation's durable prepared ->
 * submitted transition. Restored possible-send progress is query-only.
 */
export interface CheckoutSparkNativeTreasuryProvider {
  /** Exact canonical invoice query followed by exact provider transfer history. */
  reconcile(
    target: CheckoutSparkNativeTreasuryTarget
  ): Promise<CheckoutSparkNativeTreasuryObservation>
  preflight(
    target: CheckoutSparkNativeTreasuryTarget,
    cancellation?: CheckoutSparkNativePreProviderCancellation
  ): Promise<
    | "ready"
    | "fee_over_cap"
    | "insufficient_funds"
    | "unavailable"
    | "recipient_unverified"
  >
  /** A response is not proof of payment; the engine queries history afterward. */
  send(
    target: CheckoutSparkNativeTreasuryTarget
  ): Promise<CheckoutSparkNativeTreasurySdkSendResult>
}

export interface CheckoutSparkNativeTreasuryStateStore extends CheckoutSparkSettledOutgoingStateStore {
  /** Stable for this repository process only; never serialized or imported. */
  readonly nativeAdmissionScope?: object
  /**
   * Exact submitted predecessor + CAS; only the returned reference and time may
   * change. Captured account/recovery authority, not dispatch permission, guards
   * this facts-only write after an admitted provider promise drains.
   */
  saveSubmittedReference?(
    expectedSubmittedState: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    providerTransferId: string,
    observedAt: number
  ): Promise<CheckoutSparkSettledRepositorySnapshot>
  savePreProviderRetry?(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    cancellation: CheckoutSparkNativePreProviderCancellation
  ): Promise<CheckoutSparkSettledRepositorySnapshot>
  savePrepared(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    settlement: CheckoutSparkMerchantSettlementRecord
  ): Promise<CheckoutSparkSettledRepositorySnapshot>
}

export interface CheckoutSparkNativeTreasuryStepInput {
  readonly checkoutId: string
  readonly planDigest: string
  readonly legId: string
  readonly actor: "shopper" | "merchant"
  readonly inspectionOnly?: boolean
  now(): number
  readonly store: CheckoutSparkNativeTreasuryStateStore
  readonly provider: CheckoutSparkNativeTreasuryProvider
  /** Fresh provider credit, all exact commerce winners and net-zero returns. */
  proveCommerce(
    state: CheckoutSparkSettledReconciliation
  ): Promise<CheckoutSparkMerchantSettlementRecord>
  acknowledgeRecoverySnapshot(
    state: CheckoutSparkSettledReconciliation
  ): Promise<void>
}

/** One native intent, one possible send; absence never clears a durable send. */
export async function runCheckoutSparkNativeTreasuryStep(
  input: CheckoutSparkNativeTreasuryStepInput
): Promise<CheckoutSparkSettledOutgoingStepResult> {
  const loaded = await input.store.load(input.checkoutId, input.planDigest)
  if (loaded.status !== "active") invalid()
  let state = restoreCheckoutSparkSettledReconciliation(loaded.state)
  let revision = loaded.revision
  if (
    !isCheckoutSparkNativeTreasuryPlan(state.plan) ||
    state.plan.checkoutId !== input.checkoutId ||
    state.plan.planDigest !== input.planDigest ||
    state.plan.recipients.find((recipient) => recipient.legId === input.legId)
      ?.kind !== "conduit" ||
    (input.actor !== "shopper" && input.actor !== "merchant")
  )
    invalid()
  const result = (
    outcome: CheckoutSparkSettledOutgoingStepResult["outcome"],
    reason?: CheckoutSparkSettledOutgoingStepResult["reason"],
    sendAttempted = false
  ): CheckoutSparkSettledOutgoingStepResult => ({
    state,
    outcome,
    ...(reason ? { reason } : {}),
    sendAttempted,
  })
  const now = () => Math.max(input.now(), state.updatedAt + 1)
  const authority = () =>
    input.actor === "shopper"
      ? input.now() < state.plan.takeoverAt
      : input.now() >= state.plan.takeoverAt
  const hasFundingCoverage = () => {
    try {
      assertCheckoutSparkSettledFundingCoverage(
        state.plan,
        state.credit!.creditedSats
      )
      return true
    } catch {
      return false
    }
  }
  function acceptSaved(
    saved: CheckoutSparkSettledRepositorySnapshot,
    next: CheckoutSparkSettledReconciliation
  ) {
    if (
      saved.status !== "active" ||
      saved.revision !== revision + 1 ||
      JSON.stringify(saved.state) !== JSON.stringify(next)
    )
      invalid()
    revision = saved.revision
    state = restoreCheckoutSparkSettledReconciliation(saved.state)
  }
  async function persist(
    next: CheckoutSparkSettledReconciliation,
    settlement?: CheckoutSparkMerchantSettlementRecord,
    cancellation?: CheckoutSparkNativePreProviderCancellation
  ) {
    const saved = cancellation
      ? await input.store.savePreProviderRetry!(next, revision, cancellation)
      : settlement
        ? await input.store.savePrepared(next, revision, settlement)
        : await input.store.save(next, revision)
    acceptSaved(saved, next)
  }
  async function cancelPreProviderAdmission(): Promise<void> {
    // Called only while Core has positively not called send, or when the pinned
    // adapter reports its own positive pre-fulfill cancellation. A throw/timeout
    // from send never reaches this path. CAS failure creates no retry authority.
    if (
      state.treasuryFinalization?.status !== "submitted" ||
      state.treasuryFinalization.providerTransferId !== null
    )
      invalid()
    await persist(
      recordCheckoutSparkNativeTreasuryStatus(state, {
        invoiceId: state.treasuryFinalization.intent!.invoiceId,
        status: "terminal_failure",
        observedAt: now(),
      })
    )
    const durable = await input.store.load(input.checkoutId, input.planDigest)
    if (
      durable.status !== "active" ||
      durable.revision !== revision ||
      JSON.stringify(durable.state) !== JSON.stringify(state)
    )
      invalid()
    if (input.store.nativeAdmissionScope && input.store.savePreProviderRetry)
      rememberPreProviderCancellation(
        input.store.nativeAdmissionScope,
        state,
        revision
      )
  }
  if (!state.credit) return result("funding_wait")
  if (state.treasuryFinalization!.status === "paid") {
    if (input.store.nativeAdmissionScope)
      nativeCancellations.forget(
        input.store.nativeAdmissionScope,
        cancellationKey(state)
      )
    return result("already_paid")
  }
  if (
    state.legs.some((leg) => leg.legId !== input.legId && leg.status !== "paid")
  )
    return result("wait", "prerequisite_unpaid")
  if (!state.treasuryFinalization!.intent) {
    if (input.inspectionOnly) return result("invoice_needed", "inspection_only")
    if (!hasFundingCoverage()) return result("wait", "funding_shortfall")
    if (!authority())
      return result(
        "wait",
        input.actor === "shopper"
          ? "authority_transferred"
          : "authority_not_started"
      )
    let settlement: CheckoutSparkMerchantSettlementRecord
    try {
      settlement = await input.proveCommerce(state)
    } catch {
      return result("wait", "provider_evidence_unavailable")
    }
    if (
      deriveCheckoutSparkNativeTreasuryBudget(state, settlement)
        .authorizedDebitSats === 0
    )
      return result("wait", "zero_remainder")
    const prepared = prepareCheckoutSparkNativeTreasury(state, {
      settlement,
      preparedAt: now(),
    })
    await persist(prepared, settlement)
  }
  const target: CheckoutSparkNativeTreasuryTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId: input.legId,
    planDigest: state.plan.planDigest,
    nativeTreasury: state.plan.nativeTreasury!,
    intent: state.treasuryFinalization!.intent!,
  }
  async function observe(
    observation: CheckoutSparkNativeTreasuryObservation,
    attempted = false
  ): Promise<CheckoutSparkSettledOutgoingStepResult | null> {
    if (
      observation.invoiceId !== target.intent.invoiceId ||
      (state.treasuryFinalization!.providerTransferId &&
        observation.providerTransferId &&
        observation.providerTransferId !==
          state.treasuryFinalization!.providerTransferId)
    )
      invalid()
    if (observation.status === "not_found") return null
    if (observation.status === "lookup_unavailable")
      return result("wait", "provider_evidence_unavailable", attempted)
    const status =
      observation.status === "pending" ? "ambiguous" : observation.status
    await persist(
      recordCheckoutSparkNativeTreasuryStatus(state, {
        invoiceId: observation.invoiceId,
        status,
        observedAt: now(),
        ...(observation.providerTransferId
          ? { providerTransferId: observation.providerTransferId }
          : {}),
        ...(observation.status === "paid"
          ? {
              finalFeeSats: observation.finalFeeSats,
              finalDebitSats: observation.finalDebitSats,
            }
          : {}),
      })
    )
    if (observation.status === "paid" && input.store.nativeAdmissionScope)
      nativeCancellations.forget(
        input.store.nativeAdmissionScope,
        cancellationKey(state)
      )
    return observation.status === "paid"
      ? result("paid", undefined, attempted)
      : result(
          "wait",
          observation.status === "conflicting_evidence"
            ? "provider_evidence_conflicting"
            : observation.status === "terminal_failure"
              ? "terminal_failure"
              : "prior_possible_send",
          attempted
        )
  }
  let observation: CheckoutSparkNativeTreasuryObservation
  try {
    observation = await input.provider.reconcile(target)
  } catch {
    return result("wait", "provider_evidence_unavailable")
  }
  const reconciled = await observe(observation)
  if (reconciled) return reconciled
  const cancellation =
    state.treasuryFinalization!.status === "terminal_failure"
      ? loadPreProviderCancellation(
          input.store.nativeAdmissionScope,
          state,
          revision
        )
      : undefined
  if (state.treasuryFinalization!.status !== "prepared" && !cancellation)
    return result("wait", "prior_possible_send")
  if (input.inspectionOnly) return result("wait", "inspection_only")
  if (!hasFundingCoverage()) return result("wait", "funding_shortfall")
  if (!authority())
    return result(
      "wait",
      input.actor === "shopper"
        ? "authority_transferred"
        : "authority_not_started"
    )
  try {
    const settlement = await input.proveCommerce(state)
    const budget = deriveCheckoutSparkNativeTreasuryBudget(state, settlement)
    if (budget.accountingDigest !== target.intent.accountingDigest) invalid()
  } catch {
    return result("wait", "provider_evidence_unavailable")
  }
  try {
    // The positively unsent terminal marker is device-execution evidence only.
    // Do not publish it as cross-device proof or roll signed progress back. The
    // exact fresh submitted snapshot is ACKed below before any provider call.
    if (!cancellation) await input.acknowledgeRecoverySnapshot(state)
  } catch {
    return result("wait", "recovery_handoff_unavailable")
  }
  let preflight: Awaited<
    ReturnType<CheckoutSparkNativeTreasuryProvider["preflight"]>
  >
  try {
    preflight = await input.provider.preflight(target, cancellation)
  } catch {
    preflight = "unavailable"
  }
  if (preflight !== "ready")
    return result(
      "wait",
      preflight === "fee_over_cap"
        ? "fee_over_cap"
        : preflight === "insufficient_funds"
          ? "insufficient_funds"
          : preflight === "recipient_unverified"
            ? "recipient_unverified"
            : "fee_unavailable"
    )
  if (!authority()) return result("wait", "authority_transferred")
  await persist(
    recordCheckoutSparkNativeTreasuryStatus(state, {
      invoiceId: target.intent.invoiceId,
      status: "submitted",
      observedAt: now(),
    }),
    undefined,
    cancellation
  )
  if (cancellation) nativeCancellations.consume(cancellation)
  try {
    await input.acknowledgeRecoverySnapshot(state)
  } catch {
    await cancelPreProviderAdmission()
    return result("wait", "recovery_handoff_unavailable")
  }
  try {
    const settlement = await input.proveCommerce(state)
    if (
      deriveCheckoutSparkNativeTreasuryBudget(state, settlement)
        .accountingDigest !== target.intent.accountingDigest
    )
      invalid()
  } catch {
    await cancelPreProviderAdmission()
    return result("wait", "provider_evidence_unavailable")
  }
  const beforeSend = await input.store.load(input.checkoutId, input.planDigest)
  if (
    beforeSend.status !== "active" ||
    beforeSend.revision !== revision ||
    JSON.stringify(beforeSend.state) !== JSON.stringify(state)
  )
    invalid()
  if (!authority()) {
    await cancelPreProviderAdmission()
    return result("wait", "authority_transferred")
  }
  let sent: Awaited<ReturnType<CheckoutSparkNativeTreasuryProvider["send"]>>
  try {
    sent = await input.provider.send(target)
  } catch {
    return result("send_ambiguous", undefined, true)
  }
  if (sent.status === "not_sent") {
    await cancelPreProviderAdmission()
    return result("wait", "provider_evidence_unavailable")
  }
  if (sent.status === "submitted" && sent.providerTransferId) {
    // The adapter validated this reference against the exact request. Retain
    // it across a later query outage, but only fresh history can prove paid.
    const observedAt = now()
    const next = recordCheckoutSparkNativeTreasurySubmittedReference(
      state,
      sent.providerTransferId,
      observedAt
    )
    if (input.store.saveSubmittedReference) {
      acceptSaved(
        await input.store.saveSubmittedReference(
          state,
          revision,
          sent.providerTransferId,
          observedAt
        ),
        next
      )
    } else await persist(next)
  }
  // A provider rejection is not pre-provider cancellation proof. Keep its
  // possible-send marker; expose only an allowlisted explanation, never an
  // SDK error object, message or caller-supplied string.
  const failureReasons = {
    invoice_rejected: "native_invoice_rejected",
    provider_validation: "native_provider_validation",
    provider_request: "native_provider_request",
    provider_authentication: "native_provider_authentication",
    provider_error: "native_provider_error",
    provider_unavailable: "native_provider_unavailable",
    unrecognized_result: "native_unrecognized_result",
  } as const
  const failureReason =
    sent.reason && Object.hasOwn(failureReasons, sent.reason)
      ? failureReasons[sent.reason]
      : undefined
  try {
    observation = await input.provider.reconcile(target)
  } catch {
    return result(
      "send_ambiguous",
      failureReason ?? "provider_evidence_unavailable",
      true
    )
  }
  const final = await observe(observation, true)
  if (final?.outcome === "paid") {
    try {
      await input.acknowledgeRecoverySnapshot(state)
    } catch {
      /* Exact submitted snapshot already ACKed. */
    }
  }
  if (failureReason && final?.reason === "provider_evidence_unavailable")
    return result("send_ambiguous", failureReason, true)
  return (
    final ??
    result("send_ambiguous", failureReason ?? "prior_possible_send", true)
  )
}
