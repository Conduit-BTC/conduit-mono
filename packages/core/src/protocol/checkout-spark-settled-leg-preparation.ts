import { hasCheckoutSparkProviderSendWindow } from "./checkout-spark-invoice-expiry"
import {
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  getCheckoutSparkSettledLegGeneration,
  renewCheckoutSparkSettledLeg,
  prepareCheckoutSparkSettledLeg,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecipient,
} from "./checkout-spark-settled-router"
import {
  assertCheckoutSparkSettledReturnedProof,
  type CheckoutSparkSettledReturnedProof,
} from "./checkout-spark-settled-returned"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import {
  CheckoutSparkSettledRepositoryConflictError,
  type CheckoutSparkSettledRepositorySnapshot,
  type DexieCheckoutSparkSettledRepository,
} from "./checkout-spark-settled-router-repository"
import { decodeLightningInvoiceMetadata } from "./lightning"
import { checkoutSparkProviderSendWindowEndsAt } from "./checkout-spark-invoice-expiry"
import {
  CheckoutSparkLnurlInvoiceRangeError,
  resolveCheckoutSparkLnurlInvoice,
  assertCheckoutSparkLnurlInvoiceOrigin,
  type CheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceInput,
} from "./checkout-spark-lnurl-invoice"

const MAX_INVOICE_ATTEMPTS = 3
const MAX_SAVE_ATTEMPTS = 3
/** Application handoff budget; independent of an invoice's signed expiry. */
export const CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS = 60_000

type ActiveSnapshot = Extract<
  CheckoutSparkSettledRepositorySnapshot,
  { status: "active" }
>

export interface CheckoutSparkSettledLegPreparationInput {
  checkoutId: string
  planDigest: string
  legId: string
  /** Bound by the caller to its authenticated actor and unlocked wallet lease. */
  shouldContinue: () => boolean
  /** Current Merchant action only; omitted/false preserves exact-intent behavior. */
  allowRenewal?: boolean
}

export interface CheckoutSparkSettledFeeEstimateInput {
  walletId: string
  network: CheckoutSparkNetwork
  paymentRequest: string
  paymentHash: string
  amountSats: number
}

export interface CheckoutSparkSettledLegPreparationDependencies {
  repository: Pick<
    DexieCheckoutSparkSettledRepository,
    "load" | "savePreparedWithInvoiceOrigin"
  > &
    Partial<
      Pick<DexieCheckoutSparkSettledRepository, "saveRenewedWithInvoiceOrigin">
    >
  proveRenewalReturn?: (
    state: CheckoutSparkSettledReconciliation,
    legId: string
  ) => Promise<CheckoutSparkSettledReturnedProof>
  estimateFee: (
    request: CheckoutSparkSettledFeeEstimateInput
  ) => Promise<number>
  resolveInvoice?: (
    input: CheckoutSparkLnurlInvoiceInput,
    context: {
      state: CheckoutSparkSettledReconciliation
      recipient: CheckoutSparkSettledRecipient
      renewal: boolean
    }
  ) => Promise<CheckoutSparkLnurlInvoice>
  /** Caller enforces its actor/time/plan authority; this helper cannot grant it. */
  assertAuthority: (
    state: CheckoutSparkSettledReconciliation,
    nowMs: number
  ) => void
  /** Caller-specific durable exact-state acknowledgment, required before use. */
  acknowledgeRecoverySnapshot: (
    state: CheckoutSparkSettledReconciliation
  ) => Promise<void>
  nowMs?: () => number
}

function assertCurrent(input: CheckoutSparkSettledLegPreparationInput): void {
  if (input.shouldContinue() !== true) {
    throw new Error("Checkout Spark payout actor or wallet authority changed.")
  }
}

function requireActive(
  snapshot: CheckoutSparkSettledRepositorySnapshot,
  input: CheckoutSparkSettledLegPreparationInput
): ActiveSnapshot {
  if (snapshot.status !== "active") {
    throw new Error("Checkout Spark settled checkout is not active.")
  }
  const state = restoreCheckoutSparkSettledReconciliation(snapshot.state)
  if (
    state.plan.checkoutId !== input.checkoutId ||
    state.plan.planDigest !== input.planDigest
  ) {
    throw new Error("Checkout Spark payout plan binding changed.")
  }
  return { ...snapshot, state }
}

function requireLeg(snapshot: ActiveSnapshot, legId: string) {
  const leg = snapshot.state.legs.find((candidate) => candidate.legId === legId)
  const recipient = snapshot.state.plan.recipients.find(
    (candidate) => candidate.legId === legId
  )
  if (
    !snapshot.state.credit ||
    !leg ||
    !recipient ||
    leg.allocationSats === null
  ) {
    throw new Error("Checkout Spark payout allocation is not settled.")
  }
  if (leg.status !== "unprepared" && !leg.intent) {
    throw new Error("Checkout Spark payout evidence is incomplete.")
  }
  return { leg, recipient }
}

/** Time-only buyer policy. The caller must also authenticate buyer and wallet. */
export function assertCheckoutSparkSettledBuyerPreparationWindow(
  state: CheckoutSparkSettledReconciliation,
  nowMs: number
): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(nowMs + CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS) ||
    nowMs + CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS >= state.plan.takeoverAt
  ) {
    throw new Error("Checkout Spark buyer payout authority has ended.")
  }
}

/** Time-only Merchant policy. The caller must prove exact signed recovery. */
export function assertCheckoutSparkSettledMerchantPreparationWindow(
  state: CheckoutSparkSettledReconciliation,
  nowMs: number
): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs < state.plan.takeoverAt
  ) {
    throw new Error("Checkout Spark merchant payout authority has not begun.")
  }
}

/**
 * Prepare a fresh invoice only after exact inbound credit is known. This
 * function never sends funds. Each persisted attempt remains immutable; only
 * explicit Merchant renewal with fresh full-return proof appends a successor.
 * The recipient's allocation is the ceiling for invoice plus all send fees.
 */
export async function prepareCheckoutSparkSettledOutgoingLegShared(
  input: CheckoutSparkSettledLegPreparationInput,
  dependencies: CheckoutSparkSettledLegPreparationDependencies
): Promise<ActiveSnapshot> {
  assertCurrent(input)
  const repository = dependencies.repository
  const nowMs = dependencies.nowMs ?? Date.now
  const assertAuthorized = (state: CheckoutSparkSettledReconciliation) => {
    assertCurrent(input)
    dependencies.assertAuthority(state, nowMs())
  }
  const initial = requireActive(
    await repository.load(input.checkoutId, input.planDigest),
    input
  )
  assertAuthorized(initial.state)
  const { leg, recipient } = requireLeg(initial, input.legId)
  const renewal =
    !!leg.intent &&
    input.allowRenewal === true &&
    getCheckoutSparkSettledLegGeneration(leg) === 0
  if (leg.intent) {
    if (renewal) {
      assertCheckoutSparkSettledMerchantPreparationWindow(
        initial.state,
        nowMs()
      )
      if (
        (checkoutSparkProviderSendWindowEndsAt(leg.intent.paymentRequest) ??
          Infinity) > nowMs() ||
        !dependencies.proveRenewalReturn ||
        !repository.saveRenewedWithInvoiceOrigin
      )
        throw new Error("Checkout Spark payout renewal proof is unavailable.")
      const proof = await dependencies.proveRenewalReturn(
        initial.state,
        input.legId
      )
      assertAuthorized(initial.state)
      assertCheckoutSparkSettledReturnedProof(proof, {
        plan: initial.state.plan,
        target: {
          walletId: initial.state.plan.walletId,
          network: initial.state.plan.network,
          legId: leg.legId,
          recipientId: recipient.recipientId,
          allocationSats: leg.allocationSats!,
          unpaidAllocationSats: initial.state.legs.reduce(
            (sum, item) =>
              sum + (item.status === "paid" ? 0 : (item.allocationSats ?? 0)),
            0
          ),
          intent: leg.intent,
        },
        nowMs: nowMs(),
      })
    } else {
      // A page refresh may re-ACK the same intent, but never obtain a new invoice.
      await dependencies.acknowledgeRecoverySnapshot(initial.state)
      assertAuthorized(initial.state)
      return initial
    }
  }
  const allocationSats = leg.allocationSats!
  if (allocationSats <= 1) {
    throw new Error("Checkout Spark allocation cannot cover a payout fee.")
  }
  const resolveInvoice =
    dependencies.resolveInvoice ?? resolveCheckoutSparkLnurlInvoice
  let feeReserveSats = 1
  let invoiceAmountSats = allocationSats - feeReserveSats
  let invoiceRange: { minimumSats: number; maximumSats: number } | null = null
  let selected: CheckoutSparkLnurlInvoice | null = null
  for (let attempt = 0; attempt < MAX_INVOICE_ATTEMPTS; attempt += 1) {
    assertAuthorized(initial.state)
    const currentMs = nowMs()
    dependencies.assertAuthority(initial.state, currentMs)
    let invoice: CheckoutSparkLnurlInvoice
    try {
      invoice = await resolveInvoice(
        {
          lud16: recipient.destination.value,
          amountSats: invoiceAmountSats,
          network: initial.state.plan.network,
          nowSeconds: Math.floor(currentMs / 1_000),
          shouldContinue: input.shouldContinue,
          receiverMode: "private",
        },
        { state: initial.state, recipient, renewal }
      )
    } catch (error) {
      assertAuthorized(initial.state)
      if (
        !(error instanceof CheckoutSparkLnurlInvoiceRangeError) ||
        invoiceAmountSats <= error.maximumSats
      ) {
        throw error
      }
      invoiceRange = {
        minimumSats: error.minimumSats,
        maximumSats: error.maximumSats,
      }
      // Probe an endpoint-valid invoice for its fee. Capacity is not a fee
      // allowance and cannot authorize a smaller principal payment by itself.
      invoiceAmountSats = invoiceRange.maximumSats
      continue
    }
    assertAuthorized(initial.state)
    if (renewal && leg.intent?.publicZap && !invoice.publicZap) {
      throw new Error(
        "Checkout Spark public payout renewal requires fresh buyer signing."
      )
    }
    let validationProof: CheckoutSparkSettledReturnedProof | null = null
    if (renewal) {
      validationProof = await dependencies.proveRenewalReturn!(
        initial.state,
        input.legId
      )
      assertAuthorized(initial.state)
    }
    const validatedAt = nowMs()
    // An injected resolver is not payment authority. Validate its signed BOLT11
    // amount, network, hash and expiry before even asking the fee provider.
    const candidateIntent = {
      legId: input.legId,
      transferId: (renewal
        ? deriveCheckoutSparkSettledRenewalTransferId
        : deriveCheckoutSparkSettledTransferId)(
        initial.state.plan,
        input.legId
      ),
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      invoiceAmountSats,
      maxFeeSats: allocationSats - invoiceAmountSats,
      preparedAt: validatedAt,
      ...(invoice.publicZap ? { publicZap: invoice.publicZap } : {}),
      ...(invoice.receiverBinding
        ? { receiverBinding: invoice.receiverBinding }
        : {}),
    }
    const validated = renewal
      ? renewCheckoutSparkSettledLeg(initial.state, {
          legId: input.legId,
          intent: candidateIntent,
          proof: validationProof!,
          nowMs: validatedAt,
        })
      : prepareCheckoutSparkSettledLeg(initial.state, candidateIntent)
    const canonicalIntent = validated.legs.find(
      (candidate) => candidate.legId === input.legId
    )?.intent
    if (!canonicalIntent) {
      throw new Error("Checkout Spark recipient invoice is invalid.")
    }
    if (
      decodeLightningInvoiceMetadata(invoice.paymentRequest).expiresAt !==
      invoice.expiresAt
    ) {
      throw new Error("Checkout Spark recipient invoice expiry is invalid.")
    }
    if (
      !hasCheckoutSparkProviderSendWindow({
        paymentRequest: canonicalIntent.paymentRequest,
        nowMs: validatedAt,
      })
    ) {
      throw new Error("Checkout Spark payout invoice expires too soon.")
    }
    assertCheckoutSparkLnurlInvoiceOrigin(invoice.origin, {
      lud16: recipient.destination.value,
      network: initial.state.plan.network,
      amountSats: invoiceAmountSats,
      paymentRequest: canonicalIntent.paymentRequest,
      paymentHash: canonicalIntent.paymentHash,
      expiresAt: invoice.expiresAt,
      ...(canonicalIntent.receiverBinding
        ? { receiverBinding: canonicalIntent.receiverBinding }
        : {}),
    })
    const estimateRequest: CheckoutSparkSettledFeeEstimateInput = {
      walletId: initial.state.plan.walletId,
      network: initial.state.plan.network,
      paymentRequest: canonicalIntent.paymentRequest,
      paymentHash: canonicalIntent.paymentHash,
      amountSats: invoiceAmountSats,
    }
    const estimatedFeeSats = await dependencies.estimateFee(estimateRequest)
    assertAuthorized(initial.state)
    if (
      !Number.isSafeInteger(estimatedFeeSats) ||
      estimatedFeeSats < 0 ||
      estimatedFeeSats >= allocationSats
    ) {
      throw new Error("Checkout Spark payout fee estimate is unavailable.")
    }
    feeReserveSats = Math.max(feeReserveSats, estimatedFeeSats)
    const fittedAmountSats = allocationSats - feeReserveSats
    if (
      invoiceRange &&
      (fittedAmountSats < invoiceRange.minimumSats ||
        fittedAmountSats > invoiceRange.maximumSats)
    ) {
      throw new CheckoutSparkLnurlInvoiceRangeError(
        invoiceRange.minimumSats,
        invoiceRange.maximumSats
      )
    }
    // Only actual fee estimates (and the original one-sat headroom) may
    // reduce the invoice. A capped probe is never persisted as a partial leg.
    if (invoiceAmountSats === fittedAmountSats) {
      selected = {
        paymentRequest: canonicalIntent.paymentRequest,
        paymentHash: canonicalIntent.paymentHash,
        expiresAt: invoice.expiresAt,
        origin: invoice.origin,
        ...(canonicalIntent.publicZap
          ? { publicZap: canonicalIntent.publicZap }
          : {}),
        ...(canonicalIntent.receiverBinding
          ? { receiverBinding: canonicalIntent.receiverBinding }
          : {}),
      }
      break
    }
    if (fittedAmountSats <= 0 || fittedAmountSats >= invoiceAmountSats) {
      throw new Error("Checkout Spark payout fee exceeds allocation.")
    }
    invoiceAmountSats = fittedAmountSats
  }
  if (!selected) {
    throw new Error("Checkout Spark payout fee did not fit allocation.")
  }

  for (let saveAttempt = 0; saveAttempt < MAX_SAVE_ATTEMPTS; saveAttempt += 1) {
    assertAuthorized(initial.state)
    const snapshot = requireActive(
      await repository.load(input.checkoutId, input.planDigest),
      input
    )
    assertAuthorized(snapshot.state)
    const current = requireLeg(snapshot, input.legId).leg
    if (
      current.intent &&
      (!renewal || getCheckoutSparkSettledLegGeneration(current) === 1)
    ) {
      // Another tab won the CAS; never replace or send against our invoice.
      await dependencies.acknowledgeRecoverySnapshot(snapshot.state)
      assertAuthorized(snapshot.state)
      return snapshot
    }
    if (current.allocationSats !== allocationSats) {
      throw new Error("Checkout Spark payout allocation changed.")
    }
    if (
      renewal &&
      JSON.stringify(current.intent) !== JSON.stringify(leg.intent)
    )
      throw new CheckoutSparkSettledRepositoryConflictError()
    // Invoice resolution, fee fitting and local source work may outlive proof TTL.
    let commitProof: CheckoutSparkSettledReturnedProof | null = null
    if (renewal) {
      commitProof = await dependencies.proveRenewalReturn!(
        snapshot.state,
        input.legId
      )
      assertAuthorized(snapshot.state)
    }
    const preparedAt = nowMs()
    dependencies.assertAuthority(snapshot.state, preparedAt)
    if (
      !hasCheckoutSparkProviderSendWindow({
        paymentRequest: selected.paymentRequest,
        nowMs: preparedAt,
      })
    ) {
      throw new Error("Checkout Spark payout invoice expires too soon.")
    }
    const finalIntent = {
      legId: input.legId,
      transferId: (renewal
        ? deriveCheckoutSparkSettledRenewalTransferId
        : deriveCheckoutSparkSettledTransferId)(
        snapshot.state.plan,
        input.legId
      ),
      paymentRequest: selected.paymentRequest,
      paymentHash: selected.paymentHash,
      invoiceAmountSats,
      maxFeeSats: allocationSats - invoiceAmountSats,
      preparedAt,
      ...(selected.publicZap ? { publicZap: selected.publicZap } : {}),
      ...(selected.receiverBinding
        ? { receiverBinding: selected.receiverBinding }
        : {}),
    }
    const next = renewal
      ? renewCheckoutSparkSettledLeg(snapshot.state, {
          legId: input.legId,
          intent: finalIntent,
          proof: commitProof!,
          nowMs: preparedAt,
        })
      : prepareCheckoutSparkSettledLeg(snapshot.state, finalIntent)
    try {
      const persisted = requireActive(
        await (renewal
          ? repository.saveRenewedWithInvoiceOrigin!(
              next,
              snapshot.revision,
              {
                legId: input.legId,
                origin: selected.origin!,
                proof: commitProof!,
                nowMs: preparedAt,
                now: nowMs,
              },
              () => assertAuthorized(snapshot.state)
            )
          : repository.savePreparedWithInvoiceOrigin(
              next,
              snapshot.revision,
              { legId: input.legId, origin: selected.origin! },
              () => assertAuthorized(snapshot.state)
            )),
        input
      )
      assertAuthorized(persisted.state)
      await dependencies.acknowledgeRecoverySnapshot(persisted.state)
      assertAuthorized(persisted.state)
      return persisted
    } catch (error) {
      if (!(error instanceof CheckoutSparkSettledRepositoryConflictError)) {
        throw error
      }
    }
  }
  throw new Error("Checkout Spark payout state changed; reload before routing.")
}
