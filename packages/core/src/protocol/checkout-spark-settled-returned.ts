import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type {
  CheckoutSparkSettledPlan,
  CheckoutSparkSettledLegIntentInput,
} from "./checkout-spark-settled-router"
import type { CheckoutSparkSettledOutgoingTarget } from "./checkout-spark-settled-outgoing"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "./checkout-spark-settled-outgoing-history"

declare const returnedBrand: unique symbol
export interface CheckoutSparkSettledReturnedProof {
  readonly [returnedBrand]: true
}
declare const closedReturnedBrand: unique symbol
/** Retirement-only authority; cannot authorize renewal or dispatch. */
export interface CheckoutSparkSettledClosedReturnedProof {
  readonly [closedReturnedBrand]: true
}

/** Authenticated native adapter facts. Never accept these from a signed snapshot. */
export interface CheckoutSparkSettledReturnedEvidence {
  readonly network: CheckoutSparkSettledPlan["network"]
  readonly walletIdentityPublicKey: string
  readonly transferId: string
  readonly requestId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
  readonly debitedSats: number
  readonly returnedSats: number
  readonly availableSats: number
  readonly sspStatus: string
  readonly operatorStatus: "RETURNED" | "EXPIRED"
  readonly htlcStatus: "RETURNED"
  readonly preimage: string | null
  readonly returnedLeaves: readonly {
    readonly id: string
    readonly valueSats: number
  }[]
  readonly availableLeaves: readonly {
    readonly id: string
    readonly valueSats: number
  }[]
  readonly observedAt: number
}
export type CheckoutSparkSettledClosedReturnedEvidence = Omit<
  CheckoutSparkSettledReturnedEvidence,
  "availableSats" | "availableLeaves"
>

/** Immutable journal metadata, not provider authority. Re-prove before dispatch. */
export interface CheckoutSparkSettledReturnClosure {
  readonly schemaVersion: 1
  readonly planDigest: string
  readonly legId: string
  readonly intentDigest: string
  readonly transferId: string
  readonly requestId: string
  readonly paymentHash: string
  readonly debitedSats: number
  readonly returnedSats: number
  readonly netDebitSats: 0
  readonly observedAt: number
}

const proofs = new WeakMap<
  CheckoutSparkSettledReturnedProof,
  {
    closure: CheckoutSparkSettledReturnClosure
    allocationSats: number
    availableSats: number
  }
>()
const closedProofs = new WeakMap<
  CheckoutSparkSettledClosedReturnedProof,
  {
    closure: CheckoutSparkSettledReturnClosure
    walletId: string
    network: CheckoutSparkSettledPlan["network"]
  }
>()
const invalid = (): never => {
  throw new Error("Checkout Spark returned transfer proof is unavailable.")
}
const validSats = (n: number) => Number.isSafeInteger(n) && n >= 0
const validTime = validSats
const digest = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
function intentDigest(
  plan: CheckoutSparkSettledPlan,
  intent: CheckoutSparkSettledLegIntentInput
): string {
  return digest([
    "conduit:checkout-spark-returned-intent:v1",
    plan.planDigest,
    plan.walletId,
    plan.network,
    intent.legId,
    intent.transferId,
    intent.paymentRequest,
    intent.paymentHash,
    intent.invoiceAmountSats,
    intent.maxFeeSats,
    intent.preparedAt,
  ])
}

export function restoreCheckoutSparkSettledReturnClosure(
  value: CheckoutSparkSettledReturnClosure,
  input: {
    plan: CheckoutSparkSettledPlan
    intent: CheckoutSparkSettledLegIntentInput
  }
): CheckoutSparkSettledReturnClosure {
  const keys = [
    "schemaVersion",
    "planDigest",
    "legId",
    "intentDigest",
    "transferId",
    "requestId",
    "paymentHash",
    "debitedSats",
    "returnedSats",
    "netDebitSats",
    "observedAt",
  ]
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    value.planDigest !== input.plan.planDigest ||
    value.legId !== input.intent.legId ||
    value.intentDigest !== intentDigest(input.plan, input.intent) ||
    value.transferId !== input.intent.transferId ||
    value.paymentHash !== input.intent.paymentHash ||
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    value.requestId.length > 512 ||
    !validSats(value.debitedSats) ||
    value.debitedSats < input.intent.invoiceAmountSats ||
    value.debitedSats >
      input.intent.invoiceAmountSats + input.intent.maxFeeSats ||
    value.returnedSats !== value.debitedSats ||
    value.netDebitSats !== 0 ||
    !validTime(value.observedAt) ||
    value.observedAt < input.intent.preparedAt
  )
    invalid()
  return Object.freeze({ ...value })
}

function exactReturnedClosure(input: {
  plan: CheckoutSparkSettledPlan
  target: CheckoutSparkSettledOutgoingTarget
  evidence: CheckoutSparkSettledClosedReturnedEvidence
}): CheckoutSparkSettledReturnClosure {
  const { plan, target, evidence } = input
  requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  if (target.generation === 1) invalid()
  const recipient = plan.recipients.find((item) => item.legId === target.legId)
  if (
    plan.schemaVersion !== 3 ||
    !recipient ||
    target.walletId !== plan.walletId ||
    target.network !== plan.network ||
    target.recipientId !== recipient.recipientId ||
    target.intent.legId !== target.legId ||
    evidence.network !== plan.network ||
    evidence.walletIdentityPublicKey !==
      plan.funding.receiverIdentityPublicKey ||
    evidence.transferId !== target.intent.transferId ||
    evidence.paymentRequest !== target.intent.paymentRequest ||
    evidence.paymentHash !== target.intent.paymentHash ||
    evidence.invoiceAmountSats !== target.intent.invoiceAmountSats ||
    evidence.maxFeeSats !== target.intent.maxFeeSats ||
    !["USER_SWAP_RETURNED", "LIGHTNING_PAYMENT_FAILED"].includes(
      evidence.sspStatus
    ) ||
    !["RETURNED", "EXPIRED"].includes(evidence.operatorStatus) ||
    evidence.htlcStatus !== "RETURNED" ||
    evidence.preimage !== null
  )
    invalid()
  const returned = new Set<string>()
  let returnedSats = 0
  for (const leaf of evidence.returnedLeaves) {
    if (
      !leaf.id ||
      returned.has(leaf.id) ||
      !validSats(leaf.valueSats) ||
      leaf.valueSats <= 0
    )
      invalid()
    returned.add(leaf.id)
    returnedSats += leaf.valueSats
  }
  if (
    returned.size === 0 ||
    !validSats(returnedSats) ||
    returnedSats !== evidence.debitedSats ||
    evidence.returnedSats !== returnedSats
  )
    invalid()
  return restoreCheckoutSparkSettledReturnClosure(
    {
      schemaVersion: 1,
      planDigest: plan.planDigest,
      legId: target.legId,
      intentDigest: intentDigest(plan, target.intent),
      transferId: evidence.transferId,
      requestId: evidence.requestId,
      paymentHash: evidence.paymentHash,
      debitedSats: evidence.debitedSats,
      returnedSats: evidence.returnedSats,
      netDebitSats: 0,
      observedAt: evidence.observedAt,
    },
    { plan, intent: target.intent }
  )
}

export function proveCheckoutSparkSettledReturnedTransfer(input: {
  plan: CheckoutSparkSettledPlan
  target: CheckoutSparkSettledOutgoingTarget
  evidence: CheckoutSparkSettledReturnedEvidence
}): CheckoutSparkSettledReturnedProof {
  const { target, evidence } = input
  const closure = exactReturnedClosure(input)
  if (
    !validSats(evidence.availableSats) ||
    evidence.availableSats < target.unpaidAllocationSats
  )
    invalid()
  const available = new Map<string, number>()
  for (const leaf of evidence.availableLeaves) {
    if (
      !leaf.id ||
      available.has(leaf.id) ||
      !validSats(leaf.valueSats) ||
      leaf.valueSats <= 0
    )
      invalid()
    available.set(leaf.id, leaf.valueSats)
  }
  let availableSats = 0
  for (const amount of available.values()) availableSats += amount
  for (const leaf of evidence.returnedLeaves) {
    if (available.get(leaf.id) !== leaf.valueSats) invalid()
  }
  if (!validSats(availableSats) || availableSats !== evidence.availableSats)
    invalid()
  const proof = Object.freeze({}) as CheckoutSparkSettledReturnedProof
  proofs.set(proof, {
    closure,
    allocationSats: target.allocationSats,
    availableSats: evidence.availableSats,
  })
  return proof
}

export function assertCheckoutSparkSettledReturnedProof(
  proof: CheckoutSparkSettledReturnedProof,
  input: {
    plan: CheckoutSparkSettledPlan
    target: CheckoutSparkSettledOutgoingTarget
    nowMs: number
  }
): CheckoutSparkSettledReturnClosure {
  requireCheckoutSparkSettledExactOutgoingRequest(input.plan, input.target)
  if (input.target.generation === 1) invalid()
  const observed = proofs.get(proof)
  const closure = observed?.closure
  if (
    !observed ||
    !closure ||
    observed.allocationSats !== input.target.allocationSats ||
    observed.availableSats < input.target.unpaidAllocationSats ||
    !validTime(input.nowMs) ||
    closure.observedAt > input.nowMs ||
    input.nowMs - closure.observedAt > 5_000
  )
    invalid()
  return restoreCheckoutSparkSettledReturnClosure(closure!, {
    plan: input.plan,
    intent: input.target.intent,
  })
}

export function proveCheckoutSparkSettledClosedReturnedTransfer(input: {
  plan: CheckoutSparkSettledPlan
  target: CheckoutSparkSettledOutgoingTarget
  evidence: CheckoutSparkSettledClosedReturnedEvidence
}): CheckoutSparkSettledClosedReturnedProof {
  const closure = exactReturnedClosure(input)
  const proof = Object.freeze({}) as CheckoutSparkSettledClosedReturnedProof
  closedProofs.set(proof, {
    closure,
    walletId: input.plan.walletId,
    network: input.plan.network,
  })
  return proof
}

export function assertCheckoutSparkSettledClosedReturnedProof(
  proof: CheckoutSparkSettledClosedReturnedProof,
  input: {
    walletId: string
    network: CheckoutSparkSettledPlan["network"]
    nowMs: number
  }
): CheckoutSparkSettledReturnClosure {
  const observed = closedProofs.get(proof)
  if (
    !observed ||
    observed.walletId !== input.walletId ||
    observed.network !== input.network ||
    !validTime(input.nowMs) ||
    observed.closure.observedAt > input.nowMs ||
    input.nowMs - observed.closure.observedAt > 5_000
  )
    invalid()
  return observed!.closure
}
