import type { OrderSchema } from "../schemas"
import {
  restoreCheckoutSparkOrganizerRecoveryPayload,
  createCheckoutSparkOrganizerOrderBinding,
  type CheckoutSparkOrganizerOrderBinding,
  type CheckoutSparkOrganizerRecoveryPayload,
} from "./checkout-spark-organizer-recovery"
import {
  proveSparkCheckoutReceiveCredit,
  type SparkCheckoutReceiveCreditProofInput,
} from "./checkout-spark-receive-credit"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  verifyCheckoutSparkInvoiceRecipient,
  type CheckoutSparkInvoiceRecipientDependencies,
} from "./checkout-spark-invoice-recipient"
import {
  createCheckoutSparkMerchantSettlementRecord,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
  projectCheckoutSparkMerchantSettlement,
} from "./checkout-spark-merchant-settlement"
import {
  restoreCheckoutSparkSettledReconciliation,
  getCheckoutSparkSettledLegGeneration,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import { assertCheckoutSparkSettledRecoveryProgression } from "./checkout-spark-settled-router-repository"
import { validateCheckoutSparkPlanSources } from "./checkout-spark-plan-sources"
import type {
  CheckoutSparkSettledOutgoingTarget,
  CheckoutSparkSettledOutgoingObservation,
} from "./checkout-spark-settled-outgoing"
import {
  assertEventMarketFreePurchaseAuthority,
  assertEventMarketOrganizerPurchaseAuthority,
  type EventMarketFreePurchaseAuthority,
} from "./event-market-organizer-purchase"

declare const organizerCommerceBrand: unique symbol
/** Process-local verification capability; never serialize this as a paid flag. */
export interface CheckoutSparkOrganizerCommerceProof {
  readonly [organizerCommerceBrand]: true
}

const proofs = new WeakMap<
  CheckoutSparkOrganizerCommerceProof,
  {
    binding: {
      handoffId: string
      organizerPubkey: string
      merchantPubkey: string
      orderId: string
      preparedAt: number
      orderBinding: CheckoutSparkOrganizerOrderBinding
    }
    expiresAt: number
    now(): number
    assertCurrent(): void
  }
>()

function unavailable(): never {
  throw new Error("Exact event commerce payment verification is unavailable.")
}

/**
 * Re-attest the exact native receive and every required goods payout. Neither
 * saved state.paid, a relay ACK, organizer fee nor the Conduit transfer grants
 * physical handout. Provider adapters remain the existing Spark/receiver owners.
 */
export async function proveCheckoutSparkOrganizerCommerce(input: {
  initial: CheckoutSparkOrganizerRecoveryPayload
  state: CheckoutSparkSettledReconciliation
  readFunding(): Promise<SparkCheckoutReceiveCreditProofInput>
  inspectPayout(
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkSettledOutgoingObservation>
  assertCurrent(): void
  now?: () => number
  receiverDependencies?: CheckoutSparkInvoiceRecipientDependencies
}): Promise<CheckoutSparkOrganizerCommerceProof> {
  input.assertCurrent()
  const initial = restoreCheckoutSparkOrganizerRecoveryPayload(input.initial)
  const state = restoreCheckoutSparkSettledReconciliation(input.state)
  const now = input.now ?? Date.now
  const startedAt = now()
  if (!Number.isSafeInteger(startedAt) || startedAt < initial.preparedAt)
    unavailable()
  validateCheckoutSparkPlanSources(initial.plan, initial.sourceEvents ?? [])
  assertCheckoutSparkSettledRecoveryProgression(initial.state, state)
  const { plan } = state
  if (plan.planDigest !== initial.plan.planDigest) unavailable()
  const evidence = await input.readFunding()
  input.assertCurrent()
  if (
    evidence.expectedRequest.id !== plan.funding.requestId ||
    evidence.expectedRequest.network !== plan.network ||
    evidence.expectedRequest.paymentHash !== plan.funding.paymentHash ||
    evidence.expectedRequest.paymentRequest !== plan.funding.paymentRequest ||
    evidence.expectedRequest.grossFundingSats !==
      plan.funding.grossFundingSats ||
    evidence.expectedReceive.mode !== "ordinary_v3" ||
    evidence.walletIdentityPublicKey.toLowerCase() !==
      plan.funding.receiverIdentityPublicKey
  )
    unavailable()
  const credit = proveSparkCheckoutReceiveCredit(evidence)
  let settlement = recordCheckoutSparkMerchantCredit(
    createCheckoutSparkMerchantSettlementRecord(plan),
    plan,
    credit,
    now()
  )
  for (const recipient of plan.recipients) {
    if (recipient.kind !== "merchant" && recipient.kind !== "supplier") continue
    const leg = state.legs.find((entry) => entry.legId === recipient.legId)
    if (!leg?.intent || leg.allocationSats === null) unavailable()
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId: plan.walletId,
      network: plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      unpaidAllocationSats: leg.allocationSats,
      intent: leg.intent,
      ...(getCheckoutSparkSettledLegGeneration(leg) === 1
        ? { generation: 1 as const }
        : {}),
    }
    const observation = await input.inspectPayout(target)
    input.assertCurrent()
    if (observation.status !== "paid") unavailable()
    const verified = await verifyCheckoutSparkInvoiceRecipient(
      { plan, target, now: now(), assertCurrent: input.assertCurrent },
      input.receiverDependencies
    )
    input.assertCurrent()
    if (verified.status !== "verified" || !verified.settled) unavailable()
    const recipientRecord = createCheckoutSparkInvoiceRecipientRecord(
      plan,
      target,
      verified.proof
    )
    settlement = recordCheckoutSparkMerchantPayout(
      settlement,
      plan,
      target,
      observation,
      now(),
      undefined,
      recipientRecord
    )
  }
  if (!projectCheckoutSparkMerchantSettlement(settlement).commerceVerified)
    unavailable()
  input.assertCurrent()
  const completedAt = now()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - startedAt > 5 * 60_000
  )
    unavailable()
  const proof = Object.freeze({}) as CheckoutSparkOrganizerCommerceProof
  proofs.set(proof, {
    binding: {
      handoffId: initial.handoffId,
      organizerPubkey: initial.organizerPubkey,
      merchantPubkey: initial.merchantPubkey,
      orderId: initial.plan.orderId,
      preparedAt: initial.preparedAt,
      orderBinding: initial.orderBinding,
    },
    expiresAt: completedAt + 5 * 60_000,
    now,
    assertCurrent: input.assertCurrent,
  })
  return proof
}

/** Exact signed zero-price evidence, never a synthesized paid financial plan. */
export async function proveEventMarketFreeOrganizerCommerce(input: {
  authority: EventMarketFreePurchaseAuthority
  assertCurrent(): void
  now?: () => number
}): Promise<CheckoutSparkOrganizerCommerceProof> {
  input.assertCurrent()
  const purchase = await assertEventMarketFreePurchaseAuthority(input.authority)
  input.assertCurrent()
  if (purchase.kind !== "free") unavailable()
  const now = input.now ?? Date.now
  const observedAt = now()
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt < purchase.orderBinding.createdAt
  )
    unavailable()
  const proof = Object.freeze({}) as CheckoutSparkOrganizerCommerceProof
  proofs.set(proof, {
    binding: {
      handoffId: purchase.handoffId,
      organizerPubkey: purchase.organizerPubkey,
      merchantPubkey: purchase.merchantPubkey,
      orderId: purchase.orderId,
      preparedAt: purchase.orderBinding.createdAt,
      orderBinding: purchase.orderBinding,
    },
    expiresAt: observedAt + 5 * 60_000,
    now,
    assertCurrent: () => {
      input.assertCurrent()
      // The process-local authority's synchronous account/lifetime fence is
      // retained; stock ownership is independently checked in the handout TX.
      assertEventMarketOrganizerPurchaseAuthority(input.authority)
    },
  })
  return proof
}

/** No caller-supplied paid status or deserialized capability can pass this gate. */
export function assertCheckoutSparkOrganizerCommerceProof(
  proof: CheckoutSparkOrganizerCommerceProof,
  input: {
    organizerPubkey: string
    initialHandoffId?: string
  } & (
    | { order: OrderSchema }
    | {
        orderId: string
        merchantPubkey: string
        orderBinding: CheckoutSparkOrganizerOrderBinding
      }
  )
): void {
  const observation = proofs.get(proof)
  if (!observation) unavailable()
  observation.assertCurrent()
  const initial = observation.binding
  const checkedAt = observation.now()
  if (
    !Number.isSafeInteger(checkedAt) ||
    checkedAt < initial.preparedAt ||
    checkedAt >= observation.expiresAt ||
    input.organizerPubkey !== initial.organizerPubkey ||
    (input.initialHandoffId !== undefined &&
      input.initialHandoffId !== initial.handoffId) ||
    (!("order" in input) &&
      (input.orderId !== initial.orderId ||
        input.merchantPubkey !== initial.merchantPubkey)) ||
    JSON.stringify(
      "order" in input
        ? createCheckoutSparkOrganizerOrderBinding(input.order)
        : input.orderBinding
    ) !== JSON.stringify(initial.orderBinding)
  )
    unavailable()
}
