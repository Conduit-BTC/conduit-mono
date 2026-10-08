import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  assertCheckoutSparkSettledFundingCoverage,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledLegStatus,
} from "./checkout-spark-settled-router"
import {
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import type {
  CheckoutSparkSettledOutgoingStateStore,
  CheckoutSparkSettledOutgoingStepResult,
} from "./checkout-spark-settled-outgoing"
import type { CheckoutSparkSettledRepositorySnapshot } from "./checkout-spark-settled-router-repository"
import { createCheckoutSparkPreProviderCancellationRegistry } from "./checkout-spark-pre-provider-cancellation"

export interface CheckoutSparkNativeTreasuryPlan {
  readonly schemaVersion: 1
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
  readonly senderIdentityPublicKey: string
  readonly invoiceId: string
  /** Canonical unsigned, sender-restricted, open-amount sats invoice. */
  readonly invoiceRequest: string
  readonly feePolicy: "zero_required"
  readonly residualPolicy: "unused_commerce_reserves"
}

export interface CheckoutSparkNativeTreasuryInvoiceIdInput {
  readonly checkoutId: string
  readonly orderId: string
  readonly walletId: string
  readonly network: CheckoutSparkNetwork
  readonly createdAt: number
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
  readonly senderIdentityPublicKey: string
}

export interface CheckoutSparkNativeTreasuryBudget {
  readonly baseConduitAllocationSats: number
  readonly unusedCommerceReserveSats: number
  readonly authorizedDebitSats: number
  readonly accountingDigest: string
}

export interface CheckoutSparkNativeTreasuryIntent extends CheckoutSparkNativeTreasuryBudget {
  readonly invoiceId: string
  readonly invoiceRequest: string
  readonly amountSats: number
  readonly preparedAt: number
}

export interface CheckoutSparkNativeTreasuryFinalization {
  readonly intent: CheckoutSparkNativeTreasuryIntent | null
  readonly status: CheckoutSparkSettledLegStatus
  /** Actual provider ID learned from exact invoice/history reconciliation. */
  readonly providerTransferId: string | null
  readonly observedAt: number | null
  readonly finalFeeSats: number | null
  readonly finalDebitSats: number | null
}

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

function invalid(): never {
  throw new Error("Checkout Spark native treasury evidence is invalid.")
}
const id = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const digest = (value: unknown): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
function exactKeys(value: object, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid()
}

/** Derive before the plan digest: the binding deliberately has no digest cycle. */
export function deriveCheckoutSparkNativeTreasuryInvoiceId(
  input: CheckoutSparkNativeTreasuryInvoiceIdInput
): string {
  if (
    !id(input.checkoutId) ||
    !id(input.orderId) ||
    !id(input.walletId) ||
    !id(input.sparkAddress, 16_384) ||
    !nonnegative(input.createdAt) ||
    !["mainnet", "regtest"].includes(input.network) ||
    !/^(02|03)[0-9a-f]{64}$/.test(input.receiverIdentityPublicKey) ||
    !/^(02|03)[0-9a-f]{64}$/.test(input.senderIdentityPublicKey)
  )
    invalid()
  const identityDigest = digest([
    "conduit:checkout-spark-native-treasury-invoice:v1",
    input.checkoutId,
    input.orderId,
    input.walletId,
    input.network,
    input.createdAt,
    input.sparkAddress,
    input.receiverIdentityPublicKey,
    input.senderIdentityPublicKey,
  ])
  const bytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(identityDigest.slice(index * 2, index * 2 + 2), 16)
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

/** SDK decoding/encoding is an additional adapter gate, never claimed here. */
export function restoreCheckoutSparkNativeTreasuryPlan(
  value: CheckoutSparkNativeTreasuryPlan,
  plan: Pick<
    CheckoutSparkSettledPlan,
    "checkoutId" | "orderId" | "walletId" | "network" | "createdAt" | "funding"
  >
): CheckoutSparkNativeTreasuryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "schemaVersion",
    "sparkAddress",
    "receiverIdentityPublicKey",
    "senderIdentityPublicKey",
    "invoiceId",
    "invoiceRequest",
    "feePolicy",
    "residualPolicy",
  ])
  if (
    value.schemaVersion !== 1 ||
    value.feePolicy !== "zero_required" ||
    value.residualPolicy !== "unused_commerce_reserves" ||
    !id(value.invoiceRequest, 16_384) ||
    value.senderIdentityPublicKey !== plan.funding.receiverIdentityPublicKey ||
    value.invoiceId !==
      deriveCheckoutSparkNativeTreasuryInvoiceId({ ...plan, ...value })
  )
    invalid()
  return Object.freeze({ ...value })
}

export function createCheckoutSparkNativeTreasuryFinalization(): CheckoutSparkNativeTreasuryFinalization {
  return Object.freeze({
    intent: null,
    status: "unprepared",
    providerTransferId: null,
    observedAt: null,
    finalFeeSats: null,
    finalDebitSats: null,
  })
}

function budgetFromExactState(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkNativeTreasuryBudget {
  if (
    state.plan.schemaVersion !== 4 ||
    !state.plan.nativeTreasury ||
    !state.credit
  )
    invalid()
  const fee = state.plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )!
  const feeLeg = state.legs.find((leg) => leg.legId === fee.legId)!
  const commerce = state.legs.filter((leg) => leg.legId !== fee.legId)
  if (
    !nonnegative(feeLeg.allocationSats) ||
    commerce.some(
      (leg) =>
        leg.status !== "paid" ||
        !leg.intent ||
        !nonnegative(leg.finalDebitSats) ||
        leg.finalDebitSats! <= 0 ||
        (leg.closedGenerations ?? []).some(
          (entry) => entry.closure.netDebitSats !== 0
        )
    )
  )
    invalid()
  const debits = commerce.reduce(
    (sum, leg) => sum + BigInt(leg.finalDebitSats!),
    0n
  )
  const authorizedDebitSats = Number(BigInt(state.credit.creditedSats) - debits)
  const unusedCommerceReserveSats = authorizedDebitSats - feeLeg.allocationSats
  if (
    !nonnegative(authorizedDebitSats) ||
    !nonnegative(unusedCommerceReserveSats)
  )
    invalid()
  return Object.freeze({
    baseConduitAllocationSats: feeLeg.allocationSats,
    unusedCommerceReserveSats,
    authorizedDebitSats,
    accountingDigest: digest([
      "conduit:checkout-spark-native-treasury-accounting:v1",
      state.plan.planDigest,
      state.credit.transferId,
      state.credit.creditedSats,
      commerce.map((leg) => [
        leg.legId,
        leg.intent!.transferId,
        leg.finalDebitSats,
        leg.finalFeeSats,
        (leg.closedGenerations ?? []).map((entry) => [
          entry.intent.transferId,
          entry.closure.netDebitSats,
        ]),
      ]),
      feeLeg.allocationSats,
      unusedCommerceReserveSats,
      authorizedDebitSats,
    ]),
  })
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
  for (const legId of record.requiredCommerceLegIds) {
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

/** Called by router restore with already-validated commerce rows. */
export function restoreCheckoutSparkNativeTreasuryFinalization(
  value: CheckoutSparkNativeTreasuryFinalization,
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkNativeTreasuryFinalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "intent",
    "status",
    "providerTransferId",
    "observedAt",
    "finalFeeSats",
    "finalDebitSats",
  ])
  if (value.intent === null) {
    if (
      value.status !== "unprepared" ||
      value.providerTransferId !== null ||
      value.observedAt !== null ||
      value.finalFeeSats !== null ||
      value.finalDebitSats !== null
    )
      invalid()
    return createCheckoutSparkNativeTreasuryFinalization()
  }
  const intent = value.intent
  exactKeys(intent, [
    "invoiceId",
    "invoiceRequest",
    "amountSats",
    "authorizedDebitSats",
    "baseConduitAllocationSats",
    "unusedCommerceReserveSats",
    "accountingDigest",
    "preparedAt",
  ])
  const budget = budgetFromExactState(state)
  if (
    intent.invoiceId !== state.plan.nativeTreasury!.invoiceId ||
    intent.invoiceRequest !== state.plan.nativeTreasury!.invoiceRequest ||
    intent.amountSats <= 0 ||
    intent.amountSats !== budget.authorizedDebitSats ||
    Object.entries(budget).some(
      ([key, expected]) => intent[key as keyof typeof budget] !== expected
    ) ||
    !nonnegative(intent.preparedAt) ||
    intent.preparedAt <
      Math.max(
        state.credit!.observedAt,
        ...state.legs.filter((leg) => leg.intent).map((leg) => leg.observedAt!)
      ) ||
    !nonnegative(value.observedAt) ||
    value.observedAt < intent.preparedAt ||
    ![
      "prepared",
      "submitted",
      "ambiguous",
      "lookup_unavailable",
      "conflicting_evidence",
      "paid",
      "terminal_failure",
    ].includes(value.status) ||
    (value.providerTransferId !== null && !id(value.providerTransferId))
  )
    invalid()
  if (value.status === "paid") {
    if (
      !id(value.providerTransferId) ||
      value.finalFeeSats !== 0 ||
      value.finalDebitSats !== intent.amountSats
    )
      invalid()
  } else if (value.finalFeeSats !== null || value.finalDebitSats !== null)
    invalid()
  return Object.freeze({ ...value, intent: Object.freeze({ ...intent }) })
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
        | "pending"
        | "terminal_failure"
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
  ): Promise<{ readonly status: "submitted" | "not_sent" }>
}

export interface CheckoutSparkNativeTreasuryStateStore extends CheckoutSparkSettledOutgoingStateStore {
  /** Stable for this repository process only; never serialized or imported. */
  readonly nativeAdmissionScope?: object
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
    state.plan.schemaVersion !== 4 ||
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
    if (
      saved.status !== "active" ||
      saved.revision !== revision + 1 ||
      saved.state.plan.planDigest !== state.plan.planDigest ||
      JSON.stringify(saved.state.treasuryFinalization) !==
        JSON.stringify(next.treasuryFinalization) ||
      saved.state.updatedAt !== next.updatedAt
    )
      invalid()
    revision = saved.revision
    state = restoreCheckoutSparkSettledReconciliation(saved.state)
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
  try {
    observation = await input.provider.reconcile(target)
  } catch {
    return result("send_ambiguous", "provider_evidence_unavailable", true)
  }
  const final = await observe(observation, true)
  if (final?.outcome === "paid") {
    try {
      await input.acknowledgeRecoverySnapshot(state)
    } catch {
      /* Exact submitted snapshot already ACKed. */
    }
  }
  return final ?? result("send_ambiguous", "prior_possible_send", true)
}
