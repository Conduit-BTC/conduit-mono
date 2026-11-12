import {
  type CheckoutSparkPublicZapContext,
  restoreCheckoutSparkPublicZapContext,
} from "./checkout-spark-public-zap"
import {
  type CheckoutSparkReceiverBinding,
  freezeCheckoutSparkReceiverBinding,
  normalizeCheckoutSparkReceiverAddress,
} from "./checkout-spark-receiver-capability"
import {
  type CheckoutSparkSettledReturnClosure,
  restoreCheckoutSparkSettledReturnClosure,
  type CheckoutSparkSettledReturnedProof,
  assertCheckoutSparkSettledReturnedProof,
} from "./checkout-spark-settled-returned"
import {
  type CheckoutSparkNativeTreasuryFinalization,
  isCheckoutSparkNativeTreasuryPlan,
  createCheckoutSparkNativeTreasuryFinalization,
  restoreCheckoutSparkNativeTreasuryFinalization,
} from "./checkout-spark-treasury-model"
import {
  type CheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledPlan,
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
} from "./checkout-spark-settled-plan"
import {
  digest,
  time,
  sats,
  text,
  hex,
  compressedPublicKey,
  normalizeInvoice,
} from "./checkout-spark-settled-validation"
import {
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkAllocationWeights,
  allocateCheckoutSparkEventSettledSats,
  allocateCheckoutSparkSettledSats,
} from "./checkout-spark-settled-allocation"
import { checkoutSparkProviderSendWindowEndsAt } from "./checkout-spark-invoice-expiry"
import type {
  CheckoutSparkRetirementEvidence,
  CheckoutSparkRetirementAssessment,
  CheckoutSparkRetirementPendingReason,
  CheckoutSparkRetirementTombstone,
} from "./checkout-spark-reconciliation"

export {
  type CheckoutSparkSettledDestinationSource,
  type CheckoutSparkSettledDestination,
  type CheckoutSparkSettledRecipientInput,
  type CheckoutSparkSettledRecipient,
  type CheckoutSparkSettledFundingPlan,
  type FreezeCheckoutSparkSettledPlanInput,
  type CheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  freezeCheckoutSparkSettledEventPlan,
  restoreCheckoutSparkSettledPlan,
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
} from "./checkout-spark-settled-plan"
export { isCheckoutSparkNativeTreasuryPlan } from "./checkout-spark-treasury-model"

const INTENT_REVIEW_DOMAIN = "conduit:checkout-spark-settled-intent-review:v3"

export interface CheckoutSparkSettledCreditEvidence {
  readonly requestId: string
  readonly paymentHash: string
  readonly transferId: string
  readonly receiverIdentityPublicKey: string
  readonly grossSats: number
  readonly creditedSats: number
  readonly observedAt: number
}

export interface CheckoutSparkSettledLegIntentInput {
  readonly legId: string
  readonly transferId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
  readonly preparedAt: number
  readonly publicZap?: CheckoutSparkPublicZapContext
  readonly receiverBinding?: CheckoutSparkReceiverBinding
}

export type CheckoutSparkSettledLegStatus =
  | "unprepared"
  | "prepared"
  | "submitted"
  | "ambiguous"
  | "lookup_unavailable"
  | "conflicting_evidence"
  | "paid"
  | "terminal_failure"

export interface CheckoutSparkSettledLegProgress {
  readonly legId: string
  /** Null until one exact provider receive has been proved. */
  readonly allocationSats: number | null
  readonly intent: CheckoutSparkSettledLegIntentInput | null
  readonly status: CheckoutSparkSettledLegStatus
  readonly observedAt: number | null
  readonly finalFeeSats: number | null
  readonly finalDebitSats: number | null
  readonly generation?: 0 | 1
  readonly closedGenerations?: readonly CheckoutSparkSettledClosedGeneration[]
}

export interface CheckoutSparkSettledClosedGeneration {
  readonly generation: 0
  readonly intent: CheckoutSparkSettledLegIntentInput
  readonly status: Exclude<CheckoutSparkSettledLegStatus, "unprepared" | "paid">
  readonly observedAt: number
  readonly finalFeeSats: null
  readonly finalDebitSats: null
  readonly closure: CheckoutSparkSettledReturnClosure
}

export interface CheckoutSparkSettledReconciliation {
  readonly schemaVersion: 3 | 4 | 5 | 6
  readonly treasuryFinalization?: CheckoutSparkNativeTreasuryFinalization
  readonly plan: CheckoutSparkSettledPlan
  /** Exact invoice-attributed credit; never a wallet-balance inference. */
  readonly credit: CheckoutSparkSettledCreditEvidence | null
  readonly legs: readonly CheckoutSparkSettledLegProgress[]
  readonly updatedAt: number
}

export interface CheckoutSparkSettledLegEvidence {
  readonly legId: string
  readonly transferId: string
  readonly paymentHash: string
  readonly status: Exclude<
    CheckoutSparkSettledLegStatus,
    "unprepared" | "prepared"
  >
  readonly observedAt: number
  /** Required for paid; actual provider fee, not a route estimate. */
  readonly finalFeeSats?: number
  /** Required for paid; exact provider transfer debit, not a balance delta. */
  readonly finalDebitSats?: number
}

export function getCheckoutSparkSettledLegGeneration(
  leg: CheckoutSparkSettledLegProgress
): 0 | 1 {
  return leg.generation ?? 0
}

export function getCheckoutSparkSettledClosedGeneration(
  leg: CheckoutSparkSettledLegProgress
): CheckoutSparkSettledClosedGeneration | null {
  return leg.closedGenerations?.[0] ?? null
}

/** Internal stale-review check only; never display or log this fingerprint. */
export function fingerprintCheckoutSparkSettledLegIntent(
  intent: CheckoutSparkSettledLegIntentInput
): string {
  return digest([
    INTENT_REVIEW_DOMAIN,
    intent.legId,
    intent.transferId,
    intent.paymentRequest,
    intent.paymentHash,
    intent.invoiceAmountSats,
    intent.maxFeeSats,
    intent.preparedAt,
    ...(intent.publicZap ? [intent.publicZap] : []),
    ...(intent.receiverBinding ? [intent.receiverBinding] : []),
  ])
}

function allocatedLegs(
  plan: CheckoutSparkSettledPlan,
  creditedSats: number
): readonly CheckoutSparkSettledLegProgress[] {
  const eventMarket = plan.schemaVersion === 5 ? plan.eventMarket! : undefined
  const weights = eventMarket
    ? calculateCheckoutSparkEventAllocationWeights(
        plan.commerceQuote.commerceTotalSats,
        eventMarket.organizerFeeSats,
        plan.conduitFeePolicy
      )
    : calculateCheckoutSparkAllocationWeights(
        plan.commerceQuote.commerceTotalSats,
        plan.conduitFeePolicy
      )
  const allocationInput = {
    settledSats: creditedSats,
    fundingInvoiceGrossSats: plan.funding.grossFundingSats,
    weights,
    conduitFeePolicy: plan.conduitFeePolicy,
  }
  const divided = eventMarket
    ? allocateCheckoutSparkEventSettledSats({
        ...allocationInput,
        weights: calculateCheckoutSparkEventAllocationWeights(
          plan.commerceQuote.commerceTotalSats,
          eventMarket.organizerFeeSats,
          plan.conduitFeePolicy
        ),
      })
    : allocateCheckoutSparkSettledSats(allocationInput)
  const otherCommerceAllocations = new Map<string, number>()
  let assignedOtherCommerce = 0
  for (const recipient of plan.recipients) {
    if (
      recipient.kind === "merchant" ||
      recipient.kind === "conduit" ||
      (eventMarket && recipient.kind === "organizer")
    ) {
      continue
    }
    const share = Number(
      (BigInt(divided.commerceAllocationSats) * BigInt(recipient.weightSats)) /
        BigInt(weights.commerceWeightSats)
    )
    otherCommerceAllocations.set(recipient.legId, share)
    assignedOtherCommerce += share
  }
  return Object.freeze(
    plan.recipients.map((recipient) => {
      let allocationSats: number
      if (recipient.kind === "conduit") {
        allocationSats = divided.conduitAllocationSats
      } else if (eventMarket && recipient.kind === "organizer") {
        allocationSats = eventMarket.organizerFeeSats
      } else if (recipient.kind === "merchant") {
        // Match the signed supplier-allocation rule: merchant gets whole-sat residue.
        allocationSats = divided.commerceAllocationSats - assignedOtherCommerce
      } else {
        allocationSats = otherCommerceAllocations.get(recipient.legId)!
      }
      return Object.freeze({
        legId: recipient.legId,
        allocationSats,
        intent: null,
        status: "unprepared" as const,
        observedAt: null,
        finalFeeSats: null,
        finalDebitSats: null,
        ...(isCheckoutSparkNativeTreasuryPlan(plan)
          ? { generation: 0 as const, closedGenerations: [] }
          : {}),
      })
    })
  )
}

function freezeState(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  return Object.freeze({
    ...state,
    ...(state.treasuryFinalization
      ? {
          treasuryFinalization: Object.freeze({
            ...state.treasuryFinalization,
            intent: state.treasuryFinalization.intent
              ? Object.freeze({ ...state.treasuryFinalization.intent })
              : null,
          }),
        }
      : {}),
    credit: state.credit ? Object.freeze({ ...state.credit }) : null,
    legs: Object.freeze(
      state.legs.map((leg) =>
        Object.freeze({
          ...leg,
          intent: leg.intent ? Object.freeze({ ...leg.intent }) : null,
          ...(leg.closedGenerations
            ? {
                closedGenerations: Object.freeze(
                  leg.closedGenerations.map((entry) =>
                    Object.freeze({
                      ...entry,
                      intent: Object.freeze({ ...entry.intent }),
                      closure: Object.freeze({ ...entry.closure }),
                    })
                  )
                ),
              }
            : {}),
        })
      )
    ),
  })
}

export function createCheckoutSparkSettledReconciliation(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkSettledReconciliation {
  const canonical = restoreCheckoutSparkSettledPlan(plan)
  return freezeState({
    schemaVersion:
      canonical.schemaVersion === 5 ? 6 : canonical.schemaVersion === 4 ? 5 : 3,
    plan: canonical,
    credit: null,
    legs: canonical.recipients.map((recipient) => ({
      legId: recipient.legId,
      allocationSats: null,
      intent: null,
      status: "unprepared",
      observedAt: null,
      finalFeeSats: null,
      finalDebitSats: null,
      ...(isCheckoutSparkNativeTreasuryPlan(canonical)
        ? { generation: 0 as const, closedGenerations: [] }
        : {}),
    })),
    ...(isCheckoutSparkNativeTreasuryPlan(canonical)
      ? {
          treasuryFinalization: createCheckoutSparkNativeTreasuryFinalization(),
        }
      : {}),
    updatedAt: canonical.createdAt,
  })
}

export function restoreCheckoutSparkSettledReconciliation(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  if (
    state.schemaVersion !== 3 &&
    state.schemaVersion !== 4 &&
    state.schemaVersion !== 5 &&
    state.schemaVersion !== 6
  ) {
    throw new Error("Checkout Spark settled state version is invalid.")
  }
  const plan = restoreCheckoutSparkSettledPlan(state.plan)
  if (
    (plan.schemaVersion === 4) !== (state.schemaVersion === 5) ||
    (plan.schemaVersion === 5) !== (state.schemaVersion === 6) ||
    (state.schemaVersion !== 5 &&
      state.schemaVersion !== 6 &&
      Object.hasOwn(state, "treasuryFinalization"))
  ) {
    throw new Error("Checkout Spark treasury state version is invalid.")
  }
  time(state.updatedAt, "Checkout Spark settled update time")
  if (
    state.updatedAt < plan.createdAt ||
    state.legs.length !== plan.recipients.length
  ) {
    throw new Error("Checkout Spark settled state is invalid.")
  }
  let credit: CheckoutSparkSettledCreditEvidence | null = null
  let expected: readonly CheckoutSparkSettledLegProgress[] =
    createCheckoutSparkSettledReconciliation(plan).legs
  if (state.credit) {
    credit = normalizeCredit(plan, state.credit)
    expected = allocatedLegs(plan, credit.creditedSats)
  }
  const legs = state.legs.map((leg, position) => {
    const baseline = expected[position]!
    const generation = getCheckoutSparkSettledLegGeneration(leg)
    if (
      (state.schemaVersion === 3 &&
        (Object.hasOwn(leg, "generation") ||
          Object.hasOwn(leg, "closedGenerations"))) ||
      (state.schemaVersion !== 3 &&
        (![0, 1].includes(leg.generation!) ||
          !Array.isArray(leg.closedGenerations) ||
          leg.closedGenerations.length !== generation))
    ) {
      throw new Error("Checkout Spark settled generation is invalid.")
    }
    if (
      leg.legId !== baseline.legId ||
      leg.allocationSats !== baseline.allocationSats
    ) {
      throw new Error("Checkout Spark settled allocation is invalid.")
    }
    if (
      isCheckoutSparkNativeTreasuryPlan(plan) &&
      plan.recipients[position]!.kind === "conduit"
    ) {
      if (
        leg.intent !== null ||
        generation !== 0 ||
        leg.closedGenerations!.length !== 0
      ) {
        throw new Error(
          "Checkout Spark native treasury cannot contain Lightning intents."
        )
      }
      return { ...leg, generation: 0 as const, closedGenerations: [] }
    }
    if (leg.intent === null) {
      if (
        leg.status !== "unprepared" ||
        leg.observedAt !== null ||
        leg.finalFeeSats !== null ||
        leg.finalDebitSats !== null
      ) {
        throw new Error("Checkout Spark settled empty leg is invalid.")
      }
      if (generation !== 0)
        throw new Error("Checkout Spark renewed leg lacks its intent.")
      return state.schemaVersion !== 3
        ? { ...baseline, generation: 0 as const, closedGenerations: [] }
        : baseline
    }
    if (!credit || baseline.allocationSats === null) {
      throw new Error("Checkout Spark settled leg lacks exact credit.")
    }
    const intent = normalizeIntent(plan, baseline, leg.intent, generation)
    let closed: CheckoutSparkSettledClosedGeneration | null = null
    if (generation === 1) {
      const entry = leg.closedGenerations![0]!
      const keys = [
        "generation",
        "intent",
        "status",
        "observedAt",
        "finalFeeSats",
        "finalDebitSats",
        "closure",
      ]
      if (
        Object.keys(entry).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(entry, key)) ||
        entry.generation !== 0 ||
        ![
          "prepared",
          "submitted",
          "ambiguous",
          "lookup_unavailable",
          "conflicting_evidence",
          "terminal_failure",
        ].includes(entry.status) ||
        entry.finalFeeSats !== null ||
        entry.finalDebitSats !== null
      )
        throw new Error("Checkout Spark closed generation is invalid.")
      const oldIntent = normalizeIntent(plan, baseline, entry.intent)
      const closure = restoreCheckoutSparkSettledReturnClosure(entry.closure, {
        plan,
        intent: oldIntent,
      })
      if (
        !Number.isSafeInteger(entry.observedAt) ||
        entry.observedAt < oldIntent.preparedAt ||
        closure.observedAt < entry.observedAt ||
        closure.observedAt > intent.preparedAt ||
        intent.preparedAt < plan.takeoverAt ||
        intent.paymentHash === oldIntent.paymentHash ||
        intent.paymentRequest === oldIntent.paymentRequest ||
        (checkoutSparkProviderSendWindowEndsAt(oldIntent.paymentRequest) ??
          Infinity) > intent.preparedAt
      )
        throw new Error("Checkout Spark renewal progression is invalid.")
      closed = { ...entry, intent: oldIntent, closure }
    }
    if (
      leg.status === "unprepared" ||
      leg.observedAt === null ||
      !Number.isSafeInteger(leg.observedAt) ||
      leg.observedAt < intent.preparedAt ||
      ![
        "prepared",
        "submitted",
        "ambiguous",
        "lookup_unavailable",
        "conflicting_evidence",
        "paid",
        "terminal_failure",
      ].includes(leg.status)
    ) {
      throw new Error("Checkout Spark settled leg progress is invalid.")
    }
    if (leg.status === "paid") {
      sats(leg.finalFeeSats!, "Checkout Spark final fee", true)
      sats(leg.finalDebitSats!, "Checkout Spark final debit")
      if (
        leg.finalDebitSats !== intent.invoiceAmountSats + leg.finalFeeSats! ||
        leg.finalDebitSats! > baseline.allocationSats
      ) {
        throw new Error("Checkout Spark settled leg exceeded its allocation.")
      }
    } else if (leg.finalFeeSats !== null || leg.finalDebitSats !== null) {
      throw new Error("Checkout Spark unconfirmed fee is invalid.")
    }
    return Object.freeze({
      ...leg,
      intent,
      ...(state.schemaVersion !== 3
        ? { generation, closedGenerations: closed ? [closed] : [] }
        : {}),
    })
  })
  if (
    state.schemaVersion === 4 &&
    !legs.some((leg) => getCheckoutSparkSettledLegGeneration(leg) === 1)
  ) {
    throw new Error("Checkout Spark renewed state lacks a closed generation.")
  }
  const cumulativeDebitSats = legs.reduce((total, leg) => {
    const historical = (leg.closedGenerations ?? []).reduce(
      (sum, entry) => sum + entry.closure.netDebitSats,
      0
    )
    const debit = historical + (leg.finalDebitSats ?? 0)
    const native =
      isCheckoutSparkNativeTreasuryPlan(plan) &&
      plan.recipients.find((recipient) => recipient.legId === leg.legId)
        ?.kind === "conduit"
    if (
      !Number.isSafeInteger(debit) ||
      (!native && debit > (leg.allocationSats ?? 0))
    )
      throw new Error("Checkout Spark cumulative debit exceeds its allocation.")
    return total + debit
  }, 0)
  if (
    !Number.isSafeInteger(cumulativeDebitSats) ||
    cumulativeDebitSats > (credit?.creditedSats ?? 0)
  )
    throw new Error("Checkout Spark cumulative debit exceeds its credit.")
  const latest = Math.max(
    plan.createdAt,
    credit?.observedAt ?? plan.createdAt,
    ...legs.map((leg) => leg.observedAt ?? plan.createdAt)
  )
  if (state.updatedAt < latest) {
    throw new Error("Checkout Spark settled state timestamp is stale.")
  }
  const treasuryFinalization =
    state.schemaVersion === 5 || state.schemaVersion === 6
      ? restoreCheckoutSparkNativeTreasuryFinalization(
          state.treasuryFinalization!,
          { ...state, plan, credit, legs }
        )
      : undefined
  if (treasuryFinalization) {
    const nativeLeg = legs.find(
      (leg) =>
        plan.recipients.find((recipient) => recipient.legId === leg.legId)
          ?.kind === "conduit"
    )!
    if (
      nativeLeg.status !== treasuryFinalization.status ||
      nativeLeg.observedAt !== treasuryFinalization.observedAt ||
      nativeLeg.finalFeeSats !== treasuryFinalization.finalFeeSats ||
      nativeLeg.finalDebitSats !== treasuryFinalization.finalDebitSats
    ) {
      throw new Error("Checkout Spark native treasury mirror is invalid.")
    }
  }
  return freezeState({
    schemaVersion: state.schemaVersion,
    plan,
    credit,
    legs,
    updatedAt: state.updatedAt,
    ...(treasuryFinalization ? { treasuryFinalization } : {}),
  })
}

function normalizeCredit(
  plan: CheckoutSparkSettledPlan,
  evidence: CheckoutSparkSettledCreditEvidence
): CheckoutSparkSettledCreditEvidence {
  const requestId = text(evidence.requestId, "Funding request id")
  const paymentHash = hex(evidence.paymentHash, "Funding payment hash")
  const transferId = text(evidence.transferId, "Funding transfer id")
  if (
    requestId !== plan.funding.requestId ||
    paymentHash !== plan.funding.paymentHash ||
    evidence.grossSats !== plan.funding.grossFundingSats ||
    compressedPublicKey(
      evidence.receiverIdentityPublicKey,
      "Funding receiver identity"
    ) !== plan.funding.receiverIdentityPublicKey
  ) {
    throw new Error("Checkout Spark settled credit is out of scope.")
  }
  const creditedSats = sats(evidence.creditedSats, "Settled credit")
  if (creditedSats > plan.funding.grossFundingSats) {
    throw new Error("Checkout Spark settled credit exceeds invoice.")
  }
  const observedAt = time(evidence.observedAt, "Funding credit time")
  if (observedAt < plan.createdAt) {
    throw new Error("Checkout Spark settled credit predates plan.")
  }
  return Object.freeze({
    requestId,
    paymentHash,
    transferId,
    receiverIdentityPublicKey: evidence.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats,
    observedAt,
  })
}

export function recordCheckoutSparkSettledCredit(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkSettledCreditEvidence
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const credit = normalizeCredit(current.plan, evidence)
  if (current.credit) {
    if (
      current.credit.requestId !== credit.requestId ||
      current.credit.paymentHash !== credit.paymentHash ||
      current.credit.transferId !== credit.transferId ||
      current.credit.receiverIdentityPublicKey !==
        credit.receiverIdentityPublicKey ||
      current.credit.grossSats !== credit.grossSats ||
      current.credit.creditedSats !== credit.creditedSats
    ) {
      throw new Error(
        "Checkout Spark settled credit conflicts with prior evidence."
      )
    }
    return current
  }
  assertCheckoutSparkSettledFundingCoverage(current.plan, credit.creditedSats)
  return freezeState({
    ...current,
    credit,
    legs: allocatedLegs(current.plan, credit.creditedSats),
    updatedAt: Math.max(current.updatedAt, credit.observedAt),
  })
}

/** A short receive is evidence to reconcile, never approval to reduce payouts. */
export function assertCheckoutSparkSettledFundingCoverage(
  plan: CheckoutSparkSettledPlan,
  creditedSats: number
): void {
  const weights =
    plan.schemaVersion === 5
      ? calculateCheckoutSparkEventAllocationWeights(
          plan.commerceQuote.commerceTotalSats,
          plan.eventMarket!.organizerFeeSats,
          plan.conduitFeePolicy
        )
      : calculateCheckoutSparkAllocationWeights(
          plan.commerceQuote.commerceTotalSats,
          plan.conduitFeePolicy
        )
  if (
    !Number.isSafeInteger(creditedSats) ||
    BigInt(creditedSats) <
      BigInt(weights.commerceWeightSats) +
        BigInt(weights.conduitWeightSats) +
        BigInt(
          plan.schemaVersion === 5 ? plan.eventMarket!.organizerFeeSats : 0
        )
  ) {
    throw new Error("Checkout Spark funding shortfall requires reconciliation.")
  }
}

function normalizeIntent(
  plan: CheckoutSparkSettledPlan,
  leg: CheckoutSparkSettledLegProgress,
  input: CheckoutSparkSettledLegIntentInput,
  generation: 0 | 1 = 0
): CheckoutSparkSettledLegIntentInput {
  if (
    input.legId !== leg.legId ||
    input.transferId !==
      (generation === 0
        ? deriveCheckoutSparkSettledTransferId(plan, leg.legId)
        : deriveCheckoutSparkSettledRenewalTransferId(plan, leg.legId)) ||
    leg.allocationSats === null
  ) {
    throw new Error("Checkout Spark settled intent is out of scope.")
  }
  const invoiceAmountSats = sats(input.invoiceAmountSats, "Outgoing invoice")
  const maxFeeSats = sats(input.maxFeeSats, "Outgoing fee cap", true)
  const preparedAt = time(input.preparedAt, "Outgoing preparation time")
  if (
    preparedAt < plan.createdAt ||
    invoiceAmountSats >= leg.allocationSats ||
    maxFeeSats !== leg.allocationSats - invoiceAmountSats
  ) {
    throw new Error("Checkout Spark outgoing invoice exceeds allocation.")
  }
  const normalizedInvoice = normalizeInvoice({
    paymentRequest: input.paymentRequest,
    paymentHash: input.paymentHash,
    amountSats: invoiceAmountSats,
    network: plan.network,
    at: preparedAt,
  })
  const recipient = plan.recipients.find((item) => item.legId === leg.legId)!
  if (
    input.publicZap &&
    (!plan.merchantPublicZapPolicy || recipient.kind !== "merchant")
  ) {
    throw new Error(
      "Checkout Spark public zap is outside the approved Merchant leg."
    )
  }
  const publicZap = input.publicZap
    ? restoreCheckoutSparkPublicZapContext(input.publicZap, {
        policy: plan.merchantPublicZapPolicy!,
        recipientPubkey: plan.merchantPubkey,
        lud16: recipient.destination.value,
        amountSats: invoiceAmountSats,
        paymentRequest: normalizedInvoice.paymentRequest,
        preparedAt,
        planCreatedAt: plan.createdAt,
      })
    : undefined
  const receiverBinding = input.receiverBinding
    ? freezeCheckoutSparkReceiverBinding(input.receiverBinding)
    : undefined
  if (
    receiverBinding &&
    (receiverBinding.lud16 !==
      normalizeCheckoutSparkReceiverAddress(recipient.destination.value) ||
      receiverBinding.mode !== (publicZap ? "public" : "private"))
  ) {
    throw new Error("Checkout Spark receiver binding is out of scope.")
  }
  return Object.freeze({
    legId: leg.legId,
    transferId: input.transferId,
    paymentRequest: normalizedInvoice.paymentRequest,
    paymentHash: normalizedInvoice.paymentHash,
    invoiceAmountSats,
    maxFeeSats,
    preparedAt,
    ...(publicZap ? { publicZap } : {}),
    ...(receiverBinding ? { receiverBinding } : {}),
  })
}

/** Persist this exact invoice and stable transfer ID before provider I/O. */
export function prepareCheckoutSparkSettledLeg(
  state: CheckoutSparkSettledReconciliation,
  input: CheckoutSparkSettledLegIntentInput
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  if (current.credit) {
    assertCheckoutSparkSettledFundingCoverage(
      current.plan,
      current.credit.creditedSats
    )
  }
  if (
    isCheckoutSparkNativeTreasuryPlan(current.plan) &&
    current.plan.recipients.find((leg) => leg.legId === input.legId)?.kind ===
      "conduit"
  ) {
    throw new Error(
      "Checkout Spark native treasury cannot prepare a Lightning invoice."
    )
  }
  const position = current.legs.findIndex((leg) => leg.legId === input.legId)
  if (position < 0 || !current.credit) {
    throw new Error("Checkout Spark settled leg is not funded.")
  }
  const leg = current.legs[position]!
  const intent = normalizeIntent(
    current.plan,
    leg,
    input,
    getCheckoutSparkSettledLegGeneration(leg)
  )
  if (leg.intent) {
    if (JSON.stringify(leg.intent) !== JSON.stringify(intent)) {
      throw new Error("Checkout Spark settled intent cannot be replaced.")
    }
    return current
  }
  if (intent.preparedAt < current.credit.observedAt) {
    throw new Error("Checkout Spark settled intent is stale.")
  }
  const legs = current.legs.map((candidate, index) =>
    index === position
      ? Object.freeze({
          ...candidate,
          intent,
          status: "prepared" as const,
          observedAt: intent.preparedAt,
        })
      : candidate
  )
  return freezeState({
    ...current,
    legs,
    updatedAt: Math.max(current.updatedAt, intent.preparedAt),
  })
}

/** Advance only after exact positive full return; never reset the old attempt. */
export function renewCheckoutSparkSettledLeg(
  state: CheckoutSparkSettledReconciliation,
  input: {
    legId: string
    intent: CheckoutSparkSettledLegIntentInput
    proof: CheckoutSparkSettledReturnedProof
    nowMs: number
  }
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const leg = current.legs.find((item) => item.legId === input.legId)
  const recipient = current.plan.recipients.find(
    (item) => item.legId === input.legId
  )
  if (
    !current.credit ||
    !leg?.intent ||
    !recipient ||
    leg.allocationSats === null ||
    leg.status === "paid" ||
    getCheckoutSparkSettledLegGeneration(leg) !== 0 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < current.plan.takeoverAt ||
    input.nowMs < current.updatedAt ||
    input.intent.preparedAt !== input.nowMs ||
    (checkoutSparkProviderSendWindowEndsAt(leg.intent.paymentRequest) ??
      Infinity) > input.nowMs
  )
    throw new Error("Checkout Spark payout cannot be renewed.")
  const protectedSats = current.legs.reduce(
    (sum, item) =>
      sum + (item.status === "paid" ? 0 : (item.allocationSats ?? 0)),
    0
  )
  const closure = assertCheckoutSparkSettledReturnedProof(input.proof, {
    plan: current.plan,
    target: {
      walletId: current.plan.walletId,
      network: current.plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      unpaidAllocationSats: protectedSats,
      intent: leg.intent,
    },
    nowMs: input.nowMs,
  })
  if (closure.observedAt < (leg.observedAt ?? leg.intent.preparedAt))
    throw new Error("Checkout Spark returned transfer observation is stale.")
  if (leg.intent.publicZap && !input.intent.publicZap) {
    throw new Error(
      "Checkout Spark public payout renewal requires fresh buyer signing."
    )
  }
  const intent = normalizeIntent(current.plan, leg, input.intent, 1)
  const archived: CheckoutSparkSettledClosedGeneration = {
    generation: 0,
    intent: leg.intent,
    status: leg.status as CheckoutSparkSettledClosedGeneration["status"],
    observedAt: leg.observedAt!,
    finalFeeSats: null,
    finalDebitSats: null,
    closure,
  }
  return restoreCheckoutSparkSettledReconciliation({
    ...current,
    schemaVersion:
      current.plan.schemaVersion === 5
        ? 6
        : current.plan.schemaVersion === 4
          ? 5
          : 4,
    legs: current.legs.map((item) =>
      item.legId === input.legId
        ? {
            ...item,
            generation: 1,
            closedGenerations: [archived],
            intent,
            status: "prepared",
            observedAt: intent.preparedAt,
            finalFeeSats: null,
            finalDebitSats: null,
          }
        : {
            ...item,
            generation: getCheckoutSparkSettledLegGeneration(item),
            closedGenerations: item.closedGenerations ?? [],
          }
    ),
    updatedAt: input.nowMs,
  })
}

/** A submitted/ambiguous leg is never re-created or silently made payable. */
export function recordCheckoutSparkSettledLegStatus(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkSettledLegEvidence
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const position = current.legs.findIndex((leg) => leg.legId === evidence.legId)
  const leg = current.legs[position]
  if (
    !leg?.intent ||
    evidence.transferId !== leg.intent.transferId ||
    evidence.paymentHash !== leg.intent.paymentHash ||
    ![
      "submitted",
      "ambiguous",
      "lookup_unavailable",
      "conflicting_evidence",
      "paid",
      "terminal_failure",
    ].includes(evidence.status)
  ) {
    throw new Error("Checkout Spark settled leg evidence is out of scope.")
  }
  const observedAt = time(evidence.observedAt, "Outgoing observation time")
  if (
    observedAt < leg.intent.preparedAt ||
    (leg.observedAt !== null && observedAt < leg.observedAt)
  ) {
    throw new Error("Checkout Spark settled leg observation is stale.")
  }
  if (leg.status === "paid" && evidence.status !== "paid") {
    throw new Error("Checkout Spark paid leg cannot become payable again.")
  }
  if (
    leg.status === "terminal_failure" &&
    evidence.status !== "terminal_failure" &&
    evidence.status !== "paid"
  ) {
    throw new Error("Checkout Spark terminal leg cannot be retried.")
  }
  if (
    leg.status !== "prepared" &&
    evidence.status === "submitted" &&
    leg.status !== "submitted"
  ) {
    throw new Error("Checkout Spark uncertain leg cannot be resubmitted.")
  }
  const finalFeeSats =
    evidence.status === "paid"
      ? sats(evidence.finalFeeSats!, "Checkout Spark final fee", true)
      : null
  const finalDebitSats =
    evidence.status === "paid"
      ? sats(evidence.finalDebitSats!, "Checkout Spark final debit")
      : null
  if (
    evidence.status === "paid" &&
    (finalFeeSats === null ||
      finalDebitSats === null ||
      finalDebitSats !== leg.intent.invoiceAmountSats + finalFeeSats ||
      finalFeeSats > leg.intent.maxFeeSats ||
      finalDebitSats > leg.allocationSats!)
  ) {
    throw new Error("Checkout Spark paid leg exceeded allocation.")
  }
  if (
    evidence.status !== "paid" &&
    (evidence.finalFeeSats !== undefined ||
      evidence.finalDebitSats !== undefined)
  ) {
    throw new Error("Checkout Spark unconfirmed fee is invalid.")
  }
  if (
    leg.status === evidence.status &&
    leg.finalFeeSats === finalFeeSats &&
    leg.finalDebitSats === finalDebitSats
  ) {
    return current
  }
  const legs = current.legs.map((candidate, index) =>
    index === position
      ? Object.freeze({
          ...candidate,
          status: evidence.status,
          observedAt,
          finalFeeSats,
          finalDebitSats,
        })
      : candidate
  )
  return freezeState({
    ...current,
    legs,
    updatedAt: Math.max(current.updatedAt, observedAt),
  })
}

/** A fresh exact-wallet zero-funds read must follow every terminal provider observation. */
export function assessCheckoutSparkSettledRetirement(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementAssessment {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  if (
    evidence.walletId !== current.plan.walletId ||
    evidence.network !== current.plan.network
  ) {
    throw new Error("Checkout Spark retirement evidence is out of scope.")
  }
  const observedAt = time(evidence.observedAt, "Retirement observation time")
  const availableSats = sats(
    evidence.availableSats,
    "Available retirement funds",
    true
  )
  const ownedSats = sats(evidence.ownedSats, "Owned retirement funds", true)
  const incomingSats = sats(
    evidence.incomingSats,
    "Incoming retirement funds",
    true
  )
  if (ownedSats < availableSats) {
    throw new Error("Checkout Spark retirement funds are inconsistent.")
  }
  if (
    typeof evidence.fundingReceiveTerminal !== "boolean" ||
    typeof evidence.sendHistoryTerminal !== "boolean" ||
    typeof evidence.claimsTerminal !== "boolean" ||
    typeof evidence.refundsTerminal !== "boolean"
  ) {
    throw new Error("Checkout Spark retirement terminal evidence is invalid.")
  }

  const reasons: CheckoutSparkRetirementPendingReason[] = []
  if (observedAt <= current.updatedAt) reasons.push("stale_funds_evidence")
  if (availableSats > 0 || ownedSats > 0) reasons.push("funds_remaining")
  if (incomingSats > 0) reasons.push("transfer_in_flight")
  if (!evidence.fundingReceiveTerminal) reasons.push("funding_receive_open")
  if (!evidence.sendHistoryTerminal) reasons.push("send_history_open")
  if (!evidence.claimsTerminal) reasons.push("claim_path_open")
  if (!evidence.refundsTerminal) reasons.push("refund_path_open")
  if (
    current.legs.some(
      (leg) => leg.status !== "paid" && leg.status !== "terminal_failure"
    )
  ) {
    reasons.push("obligation_open")
  }
  return reasons.length > 0
    ? { state: "retirement_pending", reasons }
    : { state: "ready" }
}

/** Keep only a non-secret replay barrier after conclusive v3 retirement. */
export function retireCheckoutSparkSettledReconciliation(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementTombstone {
  const assessment = assessCheckoutSparkSettledRetirement(state, evidence)
  if (assessment.state !== "ready") {
    throw new Error(
      "Checkout Spark settled reconciliation is not ready to retire."
    )
  }
  return Object.freeze({
    schemaVersion: 1,
    planDigest: state.plan.planDigest,
    retiredAt: evidence.observedAt,
  })
}
