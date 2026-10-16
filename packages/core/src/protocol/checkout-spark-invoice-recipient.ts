import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  freezeCheckoutSparkReceiverBinding,
  normalizeCheckoutSparkReceiverAddress,
} from "./checkout-spark-receiver-capability"
import {
  verifyCheckoutSparkReceiverInvoice,
  type CheckoutSparkReceiverVerificationDependencies,
} from "./checkout-spark-receiver-verification"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "./checkout-spark-settled-outgoing-history"
import type { CheckoutSparkSettledOutgoingTarget } from "./checkout-spark-settled-outgoing"
import {
  getCheckoutSparkSettledLegGeneration,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import type { CheckoutSparkMerchantSettlementProjection } from "./checkout-spark-merchant-settlement"

const SOURCE = "qualified_receiver_v1" as const

declare const invoiceRecipientBrand: unique symbol
export interface CheckoutSparkInvoiceRecipientProof {
  readonly [invoiceRecipientBrand]: true
}

/** Device-local fresh provider observation; never accept this record from Nostr. */
export interface CheckoutSparkInvoiceRecipientRecord {
  readonly schemaVersion: 1
  readonly source: typeof SOURCE
  readonly legId: string
  readonly intentDigest: string
  readonly verifiedAt: number
  /** Receiver settlement is separate from the exact Spark transfer/debit proof. */
  readonly providerSettled: boolean
}

export type CheckoutSparkInvoiceRecipientResult =
  | {
      readonly status: "verified"
      readonly proof: CheckoutSparkInvoiceRecipientProof
      readonly settled: boolean
    }
  | { readonly status: "unsupported" | "unavailable" | "conflicting" }

export interface CheckoutSparkInvoiceRecipientInput {
  readonly plan: CheckoutSparkSettledPlan
  readonly target: CheckoutSparkSettledOutgoingTarget
  /** Observation time in milliseconds; a paid invoice may already be expired. */
  readonly now: number
  readonly assertCurrent: () => void
}

export type CheckoutSparkInvoiceRecipientDependencies =
  CheckoutSparkReceiverVerificationDependencies

const proofs = new WeakMap<
  CheckoutSparkInvoiceRecipientProof,
  {
    readonly intentDigest: string
    readonly verifiedAt: number
    readonly providerSettled: boolean
  }
>()

function intentDigest(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): string {
  const exact = requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  const recipient = plan.recipients.find((leg) => leg.legId === target.legId)!
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit.checkout-spark.provider-invoice-recipient.v1",
          SOURCE,
          plan.checkoutId,
          plan.planDigest,
          plan.merchantPubkey,
          plan.orderId,
          plan.walletId,
          target.legId,
          target.recipientId,
          target.allocationSats,
          recipient.kind,
          recipient.destination.type,
          recipient.destination.value,
          exact.network,
          exact.transferId,
          exact.paymentRequest,
          target.intent.paymentHash,
          exact.amountSats,
          exact.maxFeeSats,
          target.intent.preparedAt,
          target.intent.receiverBinding
            ? freezeCheckoutSparkReceiverBinding(target.intent.receiverBinding)
            : null,
        ])
      )
    )
  )
}

/** Generic qualified issuer proof, not a provider-specific lookup or payment claim. */
export async function verifyCheckoutSparkInvoiceRecipient(
  input: CheckoutSparkInvoiceRecipientInput,
  dependencies: CheckoutSparkInvoiceRecipientDependencies = {}
): Promise<CheckoutSparkInvoiceRecipientResult> {
  input.assertCurrent()
  if (!input.target.intent.receiverBinding) return { status: "unsupported" }
  let digest: string
  let binding
  let exact
  const observedAt = input.now
  try {
    digest = intentDigest(input.plan, input.target)
    exact = requireCheckoutSparkSettledExactOutgoingRequest(
      input.plan,
      input.target
    )
    binding = freezeCheckoutSparkReceiverBinding(
      input.target.intent.receiverBinding
    )
    const recipient = input.plan.recipients.find(
      (leg) => leg.legId === input.target.legId
    )!
    if (
      !Number.isSafeInteger(observedAt) ||
      observedAt < input.target.intent.preparedAt ||
      !Number.isSafeInteger(input.target.intent.preparedAt) ||
      input.target.intent.preparedAt < input.plan.createdAt ||
      recipient.destination.type !== "lightning_address" ||
      binding.lud16 !==
        normalizeCheckoutSparkReceiverAddress(recipient.destination.value) ||
      binding.mode !== (input.target.intent.publicZap ? "public" : "private")
    )
      return { status: "conflicting" }
  } catch {
    return { status: "conflicting" }
  }
  const verification = await verifyCheckoutSparkReceiverInvoice(
    {
      binding,
      paymentRequest: exact.paymentRequest,
      paymentHash: input.target.intent.paymentHash,
      amountSats: exact.amountSats,
      network: exact.network,
      publicRequestJson: input.target.intent.publicZap?.requestJson,
      assertCurrent: input.assertCurrent,
    },
    dependencies
  )
  input.assertCurrent()
  if (verification.status !== "verified") return verification
  try {
    if (digest !== intentDigest(input.plan, input.target))
      return { status: "conflicting" }
  } catch {
    return { status: "conflicting" }
  }
  const proof = Object.freeze({}) as CheckoutSparkInvoiceRecipientProof
  proofs.set(
    proof,
    Object.freeze({
      intentDigest: digest,
      verifiedAt: observedAt,
      providerSettled: verification.settled,
    })
  )
  return { status: "verified", proof, settled: verification.settled }
}

/** Persist only the opaque exact digest and closed facts, not provider contents. */
export function createCheckoutSparkInvoiceRecipientRecord(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget,
  proof: CheckoutSparkInvoiceRecipientProof
): CheckoutSparkInvoiceRecipientRecord {
  const observation = proofs.get(proof)
  const digest = intentDigest(plan, target)
  if (!observation || observation.intentDigest !== digest)
    throw new Error("Checkout invoice recipient proof is unavailable.")
  return {
    schemaVersion: 1,
    source: SOURCE,
    legId: target.legId,
    intentDigest: digest,
    verifiedAt: observation.verifiedAt,
    providerSettled: observation.providerSettled,
  }
}

/** Accept only records from this device's trusted verification storage. */
export function hasCheckoutSparkInvoiceRecipient(
  record: CheckoutSparkInvoiceRecipientRecord | undefined,
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): boolean {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.source !== SOURCE ||
    record.legId !== target.legId ||
    typeof record.providerSettled !== "boolean" ||
    !Number.isSafeInteger(record.verifiedAt) ||
    record.verifiedAt < target.intent.preparedAt
  )
    return false
  try {
    return record.intentDigest === intentDigest(plan, target)
  } catch {
    return false
  }
}

export function hasCheckoutSparkInvoiceRecipientSettlement(
  record: CheckoutSparkInvoiceRecipientRecord | undefined,
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): boolean {
  return (
    record?.providerSettled === true &&
    hasCheckoutSparkInvoiceRecipient(record, plan, target)
  )
}

/**
 * Informational presentation only. Positive exact ordinary receiver receipts do not
 * attest Spark funding, debit, fees, execution state or retirement authority.
 * Callers must additionally bind this to validated sources and the buyer order.
 */
export function projectCheckoutSparkMerchantRecipientSettlement(
  stateInput: CheckoutSparkSettledReconciliation,
  records: readonly CheckoutSparkInvoiceRecipientRecord[]
): CheckoutSparkMerchantSettlementProjection {
  const state = restoreCheckoutSparkSettledReconciliation(stateInput)
  const commerce = state.plan.recipients.filter(
    (recipient) => recipient.kind !== "conduit"
  )
  const verified = new Set<string>()
  for (const recipient of commerce) {
    const leg = state.legs.find((item) => item.legId === recipient.legId)!
    // Historical public or unbound invoices keep their existing stricter path.
    if (
      !leg.intent?.receiverBinding ||
      leg.intent.publicZap ||
      leg.intent.receiverBinding.mode !== "private" ||
      leg.allocationSats === null
    )
      continue
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId: state.plan.walletId,
      network: state.plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      unpaidAllocationSats: leg.allocationSats,
      intent: leg.intent,
      generation: getCheckoutSparkSettledLegGeneration(leg),
    }
    if (
      records.some((record) =>
        hasCheckoutSparkInvoiceRecipientSettlement(record, state.plan, target)
      )
    )
      verified.add(leg.legId)
  }
  return {
    creditVerified: false,
    merchantVerified: false,
    commerceVerified: false,
    feePending: false,
    recipientUnverified: false,
    receiverSettlementObserved: verified.size > 0,
    receiverCommerceObserved: commerce.every((recipient) =>
      verified.has(recipient.legId)
    ),
  }
}
