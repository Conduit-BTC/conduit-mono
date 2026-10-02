import {
  ConduitDB,
  db,
  type StoredCheckoutSparkPlanBinding,
  type StoredCheckoutSparkReconciliation,
  type StoredCheckoutSparkRetirement,
} from "../db"
import type {
  CheckoutSparkRetirementEvidence,
  CheckoutSparkRetirementTombstone,
} from "./checkout-spark-reconciliation"
import {
  createCheckoutSparkSettledReconciliation,
  retireCheckoutSparkSettledReconciliation,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  getCheckoutSparkSettledLegGeneration,
  renewCheckoutSparkSettledLeg,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  assertCheckoutSparkSettledReturnedProof,
  type CheckoutSparkSettledReturnedProof,
} from "./checkout-spark-settled-returned"
import {
  createCheckoutSparkMerchantSettlementRecord,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement"
import {
  restoreCheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantOrderWitness,
} from "./checkout-spark-merchant-order-witness"
import {
  createCheckoutSparkRetiredSettlementSummary,
  restoreCheckoutSparkBuyerOrderBinding,
  restoreCheckoutSparkRetiredSettlementSummary,
  validateCheckoutSparkRetiredSettlementRecord,
  type CheckoutSparkBuyerOrderBinding,
  type CheckoutSparkRetiredSettlementSummary,
} from "./checkout-spark-retired-settlement"
import type { SparkCheckoutReceiveCreditProof } from "./checkout-spark-receive-credit"
import { getCheckoutSparkSupplierNotifications } from "./checkout-spark-supplier-notification"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingTarget,
} from "./checkout-spark-settled-outgoing"
import { isGuestOrderDataExpired } from "./order-lifecycle"
import {
  getCheckoutSparkPlanSourceReferences,
  restoreCheckoutSparkPlanSourceValidation,
  validateCheckoutSparkPlanSources,
} from "./checkout-spark-plan-sources"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  createCheckoutSparkInvoiceOriginRecord,
  hasCheckoutSparkInvoiceOrigin,
} from "./checkout-spark-invoice-origin"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  hasCheckoutSparkInvoiceRecipient,
  type CheckoutSparkInvoiceRecipientProof,
} from "./checkout-spark-invoice-recipient"
import {
  CheckoutSparkInvoiceOriginUnavailableError,
  type CheckoutSparkLnurlInvoiceOrigin,
} from "./checkout-spark-lnurl-invoice"

const HEX_64 = /^[0-9a-f]{64}$/
const UNCERTAIN_LEG_STATUSES = new Set([
  "ambiguous",
  "lookup_unavailable",
  "conflicting_evidence",
])

export type CheckoutSparkSettledRepositorySnapshot =
  | { status: "absent" }
  | {
      status: "active"
      revision: number
      state: CheckoutSparkSettledReconciliation
    }
  | { status: "retired"; planDigest: string; retiredAt: number }

/** Atomic account-scoped provider facts; the retained summary is not proof. */
export type CheckoutSparkBuyerSettlementRepositorySnapshot =
  | { status: "absent" }
  | {
      status: "active"
      state: CheckoutSparkSettledReconciliation
      settlement: CheckoutSparkMerchantSettlementRecord | null
      buyerBinding: CheckoutSparkBuyerOrderBinding | null
    }
  | {
      status: "retired"
      summary: CheckoutSparkRetiredSettlementSummary
      settlement: CheckoutSparkMerchantSettlementRecord | null
      buyerBinding: CheckoutSparkBuyerOrderBinding
    }

export class CheckoutSparkSettledRepositoryConflictError extends Error {
  constructor() {
    super("Checkout Spark settled state changed; reload before continuing.")
    this.name = "CheckoutSparkSettledRepositoryConflictError"
  }
}

export class CheckoutSparkSettledRepositoryIntegrityError extends Error {
  constructor() {
    super("Checkout Spark settled local recovery state is inconsistent.")
    this.name = "CheckoutSparkSettledRepositoryIntegrityError"
  }
}

function assertKey(checkoutId: string, planDigest: string): void {
  if (
    typeof checkoutId !== "string" ||
    !checkoutId ||
    checkoutId.length > 512 ||
    checkoutId.trim() !== checkoutId ||
    !HEX_64.test(planDigest)
  ) {
    throw new CheckoutSparkSettledRepositoryIntegrityError()
  }
}

function matchesSavedInvoiceTarget(
  state: CheckoutSparkSettledReconciliation,
  target: CheckoutSparkSettledOutgoingTarget
): boolean {
  const leg = state.legs.find((candidate) => candidate.legId === target.legId)
  return (
    !!leg?.intent &&
    leg.allocationSats === target.allocationSats &&
    leg.intent.legId === target.intent.legId &&
    leg.intent.transferId === target.intent.transferId &&
    leg.intent.paymentRequest === target.intent.paymentRequest &&
    leg.intent.paymentHash === target.intent.paymentHash &&
    leg.intent.invoiceAmountSats === target.intent.invoiceAmountSats &&
    leg.intent.maxFeeSats === target.intent.maxFeeSats &&
    leg.intent.preparedAt === target.intent.preparedAt
  )
}

function projectState(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  const valid = restoreCheckoutSparkSettledReconciliation(state)
  return {
    schemaVersion: valid.schemaVersion,
    plan: valid.plan,
    credit: valid.credit ? { ...valid.credit } : null,
    legs: valid.legs.map((leg) => ({
      legId: leg.legId,
      allocationSats: leg.allocationSats,
      intent: leg.intent ? { ...leg.intent } : null,
      status: leg.status,
      observedAt: leg.observedAt,
      finalFeeSats: leg.finalFeeSats,
      finalDebitSats: leg.finalDebitSats,
      ...(valid.schemaVersion === 4
        ? {
            generation: leg.generation!,
            closedGenerations: leg.closedGenerations!.map((entry) => ({
              ...entry,
              intent: { ...entry.intent },
              closure: { ...entry.closure },
            })),
          }
        : {}),
    })),
    updatedAt: valid.updatedAt,
  }
}

function copyPlanSourceEvents(
  plan: CheckoutSparkSettledPlan,
  events: readonly SignedPublicNostrEvent[]
) {
  const references = getCheckoutSparkPlanSourceReferences(plan)
  const wanted = new Set(references.map((reference) => reference.eventId))
  // Persist only the public signed bytes actually needed by this plan. In
  // particular, do not copy unknown fields or unrelated newer profile events.
  const copied = events
    .filter((event) => wanted.has(event.id))
    .map((event) => ({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    }))
  const sourceValidation = validateCheckoutSparkPlanSources(plan, copied)
  const byId = new Map(copied.map((event) => [event.id, event]))
  return {
    sourceValidation,
    sourceEvents: references.map((reference) => byId.get(reference.eventId)!),
  }
}

function snapshotFromRows(
  checkoutId: string,
  binding: StoredCheckoutSparkPlanBinding | undefined,
  active: StoredCheckoutSparkReconciliation | undefined,
  retired: StoredCheckoutSparkRetirement | undefined
): CheckoutSparkSettledRepositorySnapshot {
  if (!binding) {
    if (active || retired)
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    return { status: "absent" }
  }
  if (
    binding.checkoutId !== checkoutId ||
    !HEX_64.test(binding.planDigest) ||
    Boolean(active) === Boolean(retired)
  ) {
    throw new CheckoutSparkSettledRepositoryIntegrityError()
  }
  if (active) {
    if (
      active.checkoutId !== checkoutId ||
      !Number.isSafeInteger(active.revision) ||
      active.revision < 1 ||
      (active.state.schemaVersion !== 3 && active.state.schemaVersion !== 4)
    ) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    const state = projectState(active.state)
    if (
      state.plan.checkoutId !== checkoutId ||
      state.plan.planDigest !== binding.planDigest
    ) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    return { status: "active", revision: active.revision, state }
  }
  if (
    !retired ||
    retired.checkoutId !== checkoutId ||
    retired.schemaVersion !== 1 ||
    retired.planDigest !== binding.planDigest ||
    !Number.isSafeInteger(retired.retiredAt) ||
    retired.retiredAt < 0
  ) {
    throw new CheckoutSparkSettledRepositoryIntegrityError()
  }
  return {
    status: "retired",
    planDigest: retired.planDigest,
    retiredAt: retired.retiredAt,
  }
}

/** Require the local state to contain every fact in the latest signed recovery. */
export function assertCheckoutSparkSettledRecoveryProgression(
  previous: CheckoutSparkSettledReconciliation,
  next: CheckoutSparkSettledReconciliation
): void {
  previous = restoreCheckoutSparkSettledReconciliation(previous)
  next = restoreCheckoutSparkSettledReconciliation(next)
  if (
    (previous.schemaVersion === 4 && next.schemaVersion !== 4) ||
    next.updatedAt < previous.updatedAt ||
    next.plan.planDigest !== previous.plan.planDigest ||
    (previous.credit !== null &&
      JSON.stringify(next.credit) !== JSON.stringify(previous.credit))
  ) {
    throw new CheckoutSparkSettledRepositoryConflictError()
  }
  for (let position = 0; position < previous.legs.length; position += 1) {
    const before = previous.legs[position]!
    const active = next.legs[position]!
    const oldGeneration = getCheckoutSparkSettledLegGeneration(before)
    const newGeneration = getCheckoutSparkSettledLegGeneration(active)
    let after = active
    if (oldGeneration === newGeneration) {
      if (
        JSON.stringify(before.closedGenerations ?? []) !==
        JSON.stringify(active.closedGenerations ?? [])
      )
        throw new CheckoutSparkSettledRepositoryConflictError()
    } else if (oldGeneration === 0 && newGeneration === 1) {
      const closed = active.closedGenerations![0]!
      after = {
        ...active,
        intent: closed.intent,
        status: closed.status,
        observedAt: closed.observedAt,
        finalFeeSats: closed.finalFeeSats,
        finalDebitSats: closed.finalDebitSats,
      }
    } else throw new CheckoutSparkSettledRepositoryConflictError()
    if (
      before.legId !== after.legId ||
      (before.allocationSats !== null &&
        before.allocationSats !== after.allocationSats) ||
      (before.intent !== null &&
        JSON.stringify(before.intent) !== JSON.stringify(after.intent)) ||
      (before.observedAt !== null &&
        (after.observedAt === null ||
          after.observedAt < before.observedAt ||
          (after.observedAt === before.observedAt &&
            after.status !== before.status))) ||
      (before.status !== "unprepared" && after.status === "unprepared") ||
      (before.status !== "unprepared" &&
        before.status !== "prepared" &&
        after.status === "prepared") ||
      (before.status === "paid" && after.status !== "paid") ||
      (before.status === "terminal_failure" &&
        after.status !== "terminal_failure" &&
        after.status !== "paid") ||
      (UNCERTAIN_LEG_STATUSES.has(before.status) &&
        !UNCERTAIN_LEG_STATUSES.has(after.status) &&
        after.status !== "paid" &&
        after.status !== "terminal_failure") ||
      (before.finalFeeSats !== null &&
        after.finalFeeSats !== before.finalFeeSats) ||
      (before.finalDebitSats !== null &&
        after.finalDebitSats !== before.finalDebitSats)
    ) {
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
  }
}

/** Versioned CAS store using the existing checkout binding and state rows. */
export class DexieCheckoutSparkSettledRepository {
  constructor(private readonly database: ConduitDB = db) {}

  /** Historical source cache only; every returned signed event is revalidated. */
  async loadMerchantPlanSourceEvents(
    checkoutId: string,
    planDigest: string
  ): Promise<SignedPublicNostrEvent[]> {
    assertKey(checkoutId, planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        if (snapshot.status === "absent") return []
        const binding =
          await this.database.checkoutSparkPlanBindings.get(checkoutId)
        if (!binding || binding.planDigest !== planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (
          snapshot.status !== "active" ||
          !binding.sourceValidation ||
          !binding.sourceEvents
        )
          return []
        restoreCheckoutSparkPlanSourceValidation(
          binding.sourceValidation,
          snapshot.state.plan
        )
        return copyPlanSourceEvents(snapshot.state.plan, binding.sourceEvents)
          .sourceEvents
      }
    )
  }

  /** Admit exact public sources locally without changing payment/recovery state. */
  async recordMerchantPlanSources(
    plan: CheckoutSparkSettledPlan,
    events: readonly SignedPublicNostrEvent[],
    assertCurrent: () => void
  ): Promise<void> {
    assertCurrent()
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    // Snapshot and verify before the first await; callers cannot change the
    // supplied source objects while this transaction waits for storage.
    const { sourceEvents, sourceValidation } = copyPlanSourceEvents(
      canonical,
      events
    )
    await this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent()
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        assertCurrent()
        if (
          snapshot.status !== "active" ||
          snapshot.state.plan.planDigest !== canonical.planDigest ||
          snapshot.state.plan.merchantPubkey !== canonical.merchantPubkey ||
          !binding ||
          binding.planDigest !== canonical.planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (
          JSON.stringify(binding.sourceValidation) ===
            JSON.stringify(sourceValidation) &&
          JSON.stringify(binding.sourceEvents) === JSON.stringify(sourceEvents)
        )
          return
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          sourceValidation,
          sourceEvents,
        })
        assertCurrent()
      }
    )
    assertCurrent()
  }

  private async recordMerchantSettlement(
    plan: CheckoutSparkSettledPlan,
    update: (
      previous: CheckoutSparkMerchantSettlementRecord,
      binding: StoredCheckoutSparkPlanBinding
    ) => CheckoutSparkMerchantSettlementRecord,
    assertCurrent?: () => void,
    target?: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkMerchantSettlementRecord> {
    assertCurrent?.()
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent?.()
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        assertCurrent?.()
        if (
          snapshot.status !== "active" ||
          snapshot.state.plan.planDigest !== canonical.planDigest ||
          snapshot.state.plan.merchantPubkey !== canonical.merchantPubkey ||
          !binding ||
          binding.planDigest !== canonical.planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (target) {
          const leg = snapshot.state.legs.find(
            (candidate) => candidate.legId === target.legId
          )
          if (
            !leg?.intent ||
            leg.allocationSats !== target.allocationSats ||
            leg.intent.legId !== target.intent.legId ||
            leg.intent.transferId !== target.intent.transferId ||
            leg.intent.paymentRequest !== target.intent.paymentRequest ||
            leg.intent.paymentHash !== target.intent.paymentHash ||
            leg.intent.invoiceAmountSats !== target.intent.invoiceAmountSats ||
            leg.intent.maxFeeSats !== target.intent.maxFeeSats ||
            leg.intent.preparedAt !== target.intent.preparedAt
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        }
        const previous = restoreCheckoutSparkMerchantSettlementRecord(
          binding.merchantSettlement ??
            createCheckoutSparkMerchantSettlementRecord(canonical),
          canonical
        )
        const next = restoreCheckoutSparkMerchantSettlementRecord(
          update(previous, binding),
          canonical
        )
        const supplierNotificationIntents =
          getCheckoutSparkSupplierNotifications(canonical, next, snapshot.state)
        if (
          JSON.stringify(previous) !== JSON.stringify(next) ||
          JSON.stringify(binding.supplierNotificationIntents ?? []) !==
            JSON.stringify(supplierNotificationIntents)
        ) {
          await this.database.checkoutSparkPlanBindings.put({
            ...binding,
            merchantSettlement: next,
            supplierNotificationIntents,
          })
        }
        assertCurrent?.()
        return next
      }
    )
  }

  /** Caller must supply the fresh exact-receive provider proof, not buyer state. */
  async recordMerchantCredit(
    plan: CheckoutSparkSettledPlan,
    proof: SparkCheckoutReceiveCreditProof,
    observedAt: number,
    assertCurrent?: () => void
  ): Promise<CheckoutSparkMerchantSettlementRecord> {
    return this.recordMerchantSettlement(
      plan,
      (previous) =>
        recordCheckoutSparkMerchantCredit(previous, plan, proof, observedAt),
      assertCurrent
    )
  }

  /** Caller must supply exact outgoing provider history; never import paid claims. */
  async recordMerchantPayout(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    observation: CheckoutSparkSettledOutgoingObservation,
    observedAt: number,
    assertCurrent?: () => void
  ): Promise<CheckoutSparkMerchantSettlementRecord> {
    return this.recordMerchantSettlement(
      plan,
      (previous, binding) =>
        recordCheckoutSparkMerchantPayout(
          previous,
          plan,
          target,
          observation,
          observedAt,
          binding.invoiceOrigins?.find((origin) =>
            hasCheckoutSparkInvoiceOrigin(origin, plan, target)
          ),
          binding.invoiceRecipients?.find((recipient) =>
            hasCheckoutSparkInvoiceRecipient(recipient, plan, target)
          )
        ),
      assertCurrent,
      target
    )
  }

  /** Account-scoped private record remains readable after plan retirement. */
  async loadMerchantSettlement(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkMerchantSettlementRecord | null> {
    assertKey(checkoutId, planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        const binding =
          await this.database.checkoutSparkPlanBindings.get(checkoutId)
        if (snapshot.status === "absent" || !binding) return null
        if (binding.planDigest !== planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (!binding.merchantSettlement) return null
        const record =
          snapshot.status === "retired" && binding.retiredSettlementSummary
            ? validateCheckoutSparkRetiredSettlementRecord(
                restoreCheckoutSparkRetiredSettlementSummary(
                  binding.retiredSettlementSummary
                ),
                binding.merchantSettlement
              )
            : restoreCheckoutSparkMerchantSettlementRecord(
                binding.merchantSettlement,
                snapshot.status === "active" ? snapshot.state.plan : undefined
              )
        if (
          record.merchantPubkey !== merchantPubkey ||
          record.checkoutId !== checkoutId ||
          record.planDigest !== planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        return record
      }
    )
  }

  /**
   * Bind only the durable, successfully delivered local buyer order to the
   * frozen plan. A caller-provided buyer assertion alone cannot write this row.
   * Guest callers must additionally revalidate their actual same-tab identity
   * in assertCurrent; a retained binding is not account/session authority.
   */
  async bindBuyerOrder(
    plan: CheckoutSparkSettledPlan,
    buyerPubkey: string,
    assertCurrent: () => void
  ): Promise<CheckoutSparkBuyerOrderBinding> {
    assertCurrent()
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    if (!HEX_64.test(buyerPubkey)) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      this.database.orderLifecycles,
      async () => {
        assertCurrent()
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        const order = await this.database.orderLifecycles.get(canonical.orderId)
        assertCurrent()
        if (
          snapshot.status !== "active" ||
          snapshot.state.plan.planDigest !== canonical.planDigest ||
          !binding ||
          binding.planDigest !== canonical.planDigest ||
          !order ||
          order.orderId !== canonical.orderId ||
          order.buyerPubkey !== buyerPubkey ||
          (order.buyerIdentityKind !== "signed_in" &&
            order.buyerIdentityKind !== "guest_ephemeral") ||
          order.merchantPubkey !== canonical.merchantPubkey ||
          order.checkoutMode !== "private_checkout" ||
          order.orderDeliveryStatus !== "sent" ||
          order.currency !== "SATS" ||
          order.totalSats !== canonical.commerceQuote.commerceTotalSats ||
          order.checkoutSparkRouterBinding?.checkoutId !==
            canonical.checkoutId ||
          order.checkoutSparkRouterBinding.planDigest !==
            canonical.planDigest ||
          order.checkoutSparkRouterBinding.walletId !== canonical.walletId
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const assertGuestOrderCurrent = () => {
          if (order.buyerIdentityKind !== "guest_ephemeral") return
          const now = Date.now()
          if (
            !Number.isSafeInteger(now) ||
            !Number.isSafeInteger(order.createdAt) ||
            order.createdAt < canonical.createdAt ||
            order.createdAt > now ||
            isGuestOrderDataExpired(order, now) ||
            order.shippingAddress !== undefined ||
            order.contactNote !== undefined ||
            order.guestContact !== undefined
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        }
        assertGuestOrderCurrent()
        const next: CheckoutSparkBuyerOrderBinding = {
          schemaVersion: 1,
          checkoutId: canonical.checkoutId,
          planDigest: canonical.planDigest,
          orderId: canonical.orderId,
          merchantPubkey: canonical.merchantPubkey,
          buyerPubkey,
          walletId: canonical.walletId,
          commerceTotalSats: canonical.commerceQuote.commerceTotalSats,
        }
        if (binding.orderWitness) {
          const witness = restoreCheckoutSparkMerchantOrderWitness(
            binding.orderWitness,
            canonical
          )
          if (witness.buyerPubkey !== buyerPubkey) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        }
        if (binding.buyerOrderBinding) {
          const previous = restoreCheckoutSparkBuyerOrderBinding(
            binding.buyerOrderBinding
          )
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        } else {
          await this.database.checkoutSparkPlanBindings.put({
            ...binding,
            buyerOrderBinding: next,
          })
        }
        assertCurrent()
        assertGuestOrderCurrent()
        return next
      }
    )
  }

  /**
   * One local read of active/retired order identity and independent provider
   * facts. A missing retired buyer binding or old tombstone cannot prove paid.
   */
  async loadBuyerSettlement(
    checkoutId: string,
    planDigest: string,
    buyerPubkey: string
  ): Promise<CheckoutSparkBuyerSettlementRepositorySnapshot> {
    assertKey(checkoutId, planDigest)
    if (!HEX_64.test(buyerPubkey)) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        const binding =
          await this.database.checkoutSparkPlanBindings.get(checkoutId)
        if (snapshot.status === "absent" || !binding)
          return { status: "absent" }
        if (binding.planDigest !== planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const buyerBinding = binding.buyerOrderBinding
          ? restoreCheckoutSparkBuyerOrderBinding(binding.buyerOrderBinding)
          : null
        if (
          buyerBinding &&
          (buyerBinding.checkoutId !== checkoutId ||
            buyerBinding.planDigest !== planDigest)
        ) {
          throw new CheckoutSparkSettledRepositoryIntegrityError()
        }
        if (buyerBinding && binding.orderWitness) {
          const witness = restoreCheckoutSparkMerchantOrderWitness(
            binding.orderWitness,
            snapshot.status === "active" ? snapshot.state.plan : undefined
          )
          if (
            witness.buyerPubkey !== buyerBinding.buyerPubkey ||
            witness.merchantPubkey !== buyerBinding.merchantPubkey ||
            witness.orderId !== buyerBinding.orderId ||
            witness.checkoutId !== buyerBinding.checkoutId ||
            witness.planDigest !== buyerBinding.planDigest
          ) {
            throw new CheckoutSparkSettledRepositoryIntegrityError()
          }
        }
        if (buyerBinding && buyerBinding.buyerPubkey !== buyerPubkey) {
          return { status: "absent" }
        }
        if (snapshot.status === "active") {
          const plan = snapshot.state.plan
          if (
            buyerBinding &&
            (buyerBinding.orderId !== plan.orderId ||
              buyerBinding.merchantPubkey !== plan.merchantPubkey ||
              buyerBinding.walletId !== plan.walletId ||
              buyerBinding.commerceTotalSats !==
                plan.commerceQuote.commerceTotalSats)
          ) {
            throw new CheckoutSparkSettledRepositoryIntegrityError()
          }
          const settlement = binding.merchantSettlement
            ? restoreCheckoutSparkMerchantSettlementRecord(
                binding.merchantSettlement,
                plan
              )
            : null
          return {
            status: "active",
            state: snapshot.state,
            settlement,
            buyerBinding,
          }
        }
        if (!buyerBinding || !binding.retiredSettlementSummary) {
          return { status: "absent" }
        }
        const summary = restoreCheckoutSparkRetiredSettlementSummary(
          binding.retiredSettlementSummary
        )
        if (
          summary.checkoutId !== checkoutId ||
          summary.planDigest !== planDigest ||
          buyerBinding.orderId !== summary.orderId ||
          buyerBinding.merchantPubkey !== summary.merchantPubkey ||
          buyerBinding.walletId !== summary.walletId ||
          buyerBinding.commerceTotalSats !== summary.commerceTotalSats
        ) {
          throw new CheckoutSparkSettledRepositoryIntegrityError()
        }
        const settlement = binding.merchantSettlement
          ? validateCheckoutSparkRetiredSettlementRecord(
              summary,
              binding.merchantSettlement
            )
          : null
        return { status: "retired", summary, settlement, buyerBinding }
      }
    )
  }

  /**
   * Exact authenticated order binding is readable before credit is recorded.
   * A missing witness confers no authority; retired plans keep this minimal
   * binding without resurrecting the wallet or reconciliation state.
   */
  async loadMerchantOrderWitness(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkMerchantOrderWitness | null> {
    assertKey(checkoutId, planDigest)
    if (!HEX_64.test(merchantPubkey)) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        const binding =
          await this.database.checkoutSparkPlanBindings.get(checkoutId)
        if (snapshot.status === "absent" || !binding) return null
        if (binding.planDigest !== planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (!binding.orderWitness) return null
        const witness = restoreCheckoutSparkMerchantOrderWitness(
          binding.orderWitness,
          snapshot.status === "active" ? snapshot.state.plan : undefined
        )
        if (
          witness.merchantPubkey !== merchantPubkey ||
          witness.checkoutId !== checkoutId ||
          witness.planDigest !== planDigest ||
          binding.checkoutId !== checkoutId
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        return witness
      }
    )
  }

  /**
   * Device-local, merchant-scoped projection source. A generic order cache is
   * never searched here and records without an authenticated order witness are
   * deliberately omitted, including legacy preparations.
   */
  async loadMerchantOrderSettlements(
    merchantPubkey: string,
    orderIds?: readonly string[]
  ): Promise<
    Array<{
      witness: CheckoutSparkMerchantOrderWitness
      settlement: CheckoutSparkMerchantSettlementRecord
    }>
  > {
    if (!HEX_64.test(merchantPubkey)) {
      throw new CheckoutSparkSettledRepositoryIntegrityError()
    }
    const selectedOrders = orderIds ? new Set(orderIds) : null
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const bindings = await this.database.checkoutSparkPlanBindings.toArray()
        const results: Array<{
          witness: CheckoutSparkMerchantOrderWitness
          settlement: CheckoutSparkMerchantSettlementRecord
        }> = []
        for (const binding of bindings) {
          if (
            !binding.orderWitness ||
            !binding.merchantSettlement ||
            !binding.sourceValidation
          )
            continue
          try {
            const witness = restoreCheckoutSparkMerchantOrderWitness(
              binding.orderWitness
            )
            if (
              witness.merchantPubkey !== merchantPubkey ||
              (selectedOrders && !selectedOrders.has(witness.orderId)) ||
              binding.checkoutId !== witness.checkoutId ||
              binding.planDigest !== witness.planDigest
            ) {
              continue
            }
            restoreCheckoutSparkPlanSourceValidation(
              binding.sourceValidation,
              witness
            )
            const snapshot = await this.readInTransaction(binding.checkoutId)
            if (snapshot.status === "absent") continue
            if (binding.buyerOrderBinding) {
              const buyer = restoreCheckoutSparkBuyerOrderBinding(
                binding.buyerOrderBinding
              )
              if (
                buyer.buyerPubkey !== witness.buyerPubkey ||
                buyer.orderId !== witness.orderId ||
                buyer.merchantPubkey !== witness.merchantPubkey ||
                buyer.checkoutId !== witness.checkoutId ||
                buyer.planDigest !== witness.planDigest
              )
                continue
            }
            let settlement: CheckoutSparkMerchantSettlementRecord
            if (
              snapshot.status === "retired" &&
              binding.retiredSettlementSummary
            ) {
              const summary = restoreCheckoutSparkRetiredSettlementSummary(
                binding.retiredSettlementSummary
              )
              if (
                summary.checkoutId !== witness.checkoutId ||
                summary.planDigest !== witness.planDigest ||
                summary.orderId !== witness.orderId ||
                summary.merchantPubkey !== witness.merchantPubkey
              )
                continue
              settlement = validateCheckoutSparkRetiredSettlementRecord(
                summary,
                binding.merchantSettlement
              )
            } else {
              settlement = restoreCheckoutSparkMerchantSettlementRecord(
                binding.merchantSettlement,
                snapshot.status === "active" ? snapshot.state.plan : undefined
              )
            }
            if (
              settlement.merchantPubkey !== witness.merchantPubkey ||
              settlement.orderId !== witness.orderId ||
              settlement.checkoutId !== witness.checkoutId ||
              settlement.planDigest !== witness.planDigest
            ) {
              continue
            }
            results.push({ witness, settlement })
          } catch {
            // Invalid local rows cannot confer verified status on an order.
          }
        }
        return results
      }
    )
  }

  private async readInTransaction(
    checkoutId: string
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    const binding =
      await this.database.checkoutSparkPlanBindings.get(checkoutId)
    const active =
      await this.database.checkoutSparkReconciliations.get(checkoutId)
    const retired = await this.database.checkoutSparkRetirements.get(checkoutId)
    return snapshotFromRows(checkoutId, binding, active, retired)
  }

  async load(
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    assertKey(checkoutId, planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        if (
          snapshot.status !== "absent" &&
          (snapshot.status === "active"
            ? snapshot.state.plan.planDigest
            : snapshot.planDigest) !== planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        return snapshot
      }
    )
  }

  async create(
    plan: CheckoutSparkSettledPlan
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    const state = projectState(createCheckoutSparkSettledReconciliation(plan))
    const { checkoutId, planDigest } = state.plan
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        if (snapshot.status !== "absent") {
          if (
            snapshot.status === "retired" ||
            snapshot.state.plan.planDigest !== planDigest
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
          return snapshot
        }
        await this.database.checkoutSparkPlanBindings.add({
          checkoutId,
          planDigest,
        })
        await this.database.checkoutSparkReconciliations.add({
          checkoutId,
          revision: 1,
          state,
        })
        return { status: "active" as const, revision: 1, state }
      }
    )
  }

  /**
   * Import an already-authenticated Merchant recovery snapshot. The caller
   * must recheck the active signer through assertCurrent; only the validated
   * wallet-secret-free reconciliation enters this private local store. Invoice
   * and destination facts must never be projected into ordinary app caches.
   */
  async importRecoveryState(
    state: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    return this.importRecoveryStateWithWitness(state, undefined, assertCurrent)
  }

  /** Import exact recovery and its authenticated buyer-order witness atomically. */
  async importMerchantOrderRecovery(
    state: CheckoutSparkSettledReconciliation,
    witness: CheckoutSparkMerchantOrderWitness,
    assertCurrent: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    return this.importRecoveryStateWithWitness(state, witness, assertCurrent)
  }

  private async importRecoveryStateWithWitness(
    state: CheckoutSparkSettledReconciliation,
    witness: CheckoutSparkMerchantOrderWitness | undefined,
    assertCurrent: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    assertCurrent()
    const next = projectState(state)
    const { checkoutId, planDigest } = next.plan
    const exactWitness = witness
      ? restoreCheckoutSparkMerchantOrderWitness(witness, next.plan)
      : undefined
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent()
        const current = await this.readInTransaction(checkoutId)
        assertCurrent()
        if (current.status === "retired" && !exactWitness) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (current.status === "absent") {
          await this.database.checkoutSparkPlanBindings.add({
            checkoutId,
            planDigest,
            ...(exactWitness ? { orderWitness: exactWitness } : {}),
          })
          assertCurrent()
          await this.database.checkoutSparkReconciliations.add({
            checkoutId,
            revision: 1,
            state: next,
          })
          assertCurrent()
          return { status: "active" as const, revision: 1, state: next }
        }
        if (
          (current.status === "retired"
            ? current.planDigest
            : current.state.plan.planDigest) !== planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const binding =
          await this.database.checkoutSparkPlanBindings.get(checkoutId)
        assertCurrent()
        if (!binding || binding.planDigest !== planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        if (exactWitness && binding.buyerOrderBinding) {
          const buyer = restoreCheckoutSparkBuyerOrderBinding(
            binding.buyerOrderBinding
          )
          if (
            buyer.checkoutId !== exactWitness.checkoutId ||
            buyer.planDigest !== exactWitness.planDigest ||
            buyer.orderId !== exactWitness.orderId ||
            buyer.merchantPubkey !== exactWitness.merchantPubkey ||
            buyer.buyerPubkey !== exactWitness.buyerPubkey
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        }
        if (current.status === "retired" && binding.merchantSettlement) {
          const settlement = restoreCheckoutSparkMerchantSettlementRecord(
            binding.merchantSettlement,
            next.plan
          )
          if (
            settlement.merchantPubkey !== exactWitness?.merchantPubkey ||
            settlement.orderId !== exactWitness.orderId ||
            settlement.checkoutId !== exactWitness.checkoutId ||
            settlement.planDigest !== exactWitness.planDigest
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        }
        if (binding.orderWitness) {
          const previous = restoreCheckoutSparkMerchantOrderWitness(
            binding.orderWitness,
            next.plan
          )
          if (
            exactWitness &&
            JSON.stringify(previous) !== JSON.stringify(exactWitness)
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
        } else if (exactWitness) {
          await this.database.checkoutSparkPlanBindings.put({
            ...binding,
            orderWitness: exactWitness,
          })
          assertCurrent()
        }
        if (current.status === "retired") return current
        if (JSON.stringify(current.state) === JSON.stringify(next)) {
          return current
        }
        if (exactWitness) {
          try {
            // A later provider-confirmed local state is stronger than an old
            // signed recovery snapshot; importing its order witness must not
            // roll payment evidence backward.
            assertCheckoutSparkSettledRecoveryProgression(next, current.state)
            return current
          } catch {
            // The signed state may instead be newer; check that direction
            // below. Truly conflicting state still fails closed.
          }
        }
        assertCheckoutSparkSettledRecoveryProgression(current.state, next)
        if (!Number.isSafeInteger(current.revision + 1)) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const revision = current.revision + 1
        await this.database.checkoutSparkReconciliations.put({
          checkoutId,
          revision,
          state: next,
        })
        assertCurrent()
        return { status: "active" as const, revision, state: next }
      }
    )
  }

  async save(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    assertCurrent?: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    return this.saveState(state, expectedRevision, assertCurrent)
  }

  /** Only a freshly resolved local invoice may accompany a new intent. */
  async savePreparedWithInvoiceOrigin(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    evidence: { legId: string; origin: CheckoutSparkLnurlInvoiceOrigin },
    assertCurrent?: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    return this.saveState(state, expectedRevision, assertCurrent, evidence)
  }

  /** Commit one full-return successor and its device-local origin atomically. */
  async saveRenewedWithInvoiceOrigin(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    evidence: {
      legId: string
      origin: CheckoutSparkLnurlInvoiceOrigin
      proof: CheckoutSparkSettledReturnedProof
      nowMs: number
      now: () => number
    },
    assertCurrent?: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    return this.saveState(state, expectedRevision, assertCurrent, evidence)
  }

  async hasInvoiceOrigin(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    assertCurrent?: () => void
  ): Promise<boolean> {
    assertCurrent?.()
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent?.()
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        assertCurrent?.()
        if (
          snapshot.status !== "active" ||
          snapshot.state.plan.planDigest !== canonical.planDigest
        )
          return false
        const leg = snapshot.state.legs.find(
          (candidate) => candidate.legId === target.legId
        )
        if (
          !leg?.intent ||
          leg.allocationSats !== target.allocationSats ||
          leg.intent.legId !== target.intent.legId ||
          leg.intent.transferId !== target.intent.transferId ||
          leg.intent.paymentRequest !== target.intent.paymentRequest ||
          leg.intent.paymentHash !== target.intent.paymentHash ||
          leg.intent.invoiceAmountSats !== target.intent.invoiceAmountSats ||
          leg.intent.maxFeeSats !== target.intent.maxFeeSats ||
          leg.intent.preparedAt !== target.intent.preparedAt
        )
          return false
        return hasCheckoutSparkInvoiceOrigin(
          binding?.invoiceOrigins?.find((origin) =>
            hasCheckoutSparkInvoiceOrigin(origin, canonical, target)
          ),
          canonical,
          target
        )
      }
    )
  }

  async assertLocalInvoiceOrigin(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    assertCurrent?: () => void
  ): Promise<void> {
    if (!(await this.hasInvoiceOrigin(plan, target, assertCurrent))) {
      throw new CheckoutSparkInvoiceOriginUnavailableError()
    }
    assertCurrent?.()
  }

  /** Recipient evidence is local issuance OR independent exact provider lookup. */
  async hasInvoiceRecipient(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    assertCurrent?: () => void
  ): Promise<boolean> {
    target = { ...target, intent: { ...target.intent } }
    if (await this.hasInvoiceOrigin(plan, target, assertCurrent)) return true
    assertCurrent?.()
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        assertCurrent?.()
        if (snapshot.status !== "active" || !binding) return false
        if (
          snapshot.state.plan.planDigest !== canonical.planDigest ||
          !matchesSavedInvoiceTarget(snapshot.state, target)
        )
          return false
        return hasCheckoutSparkInvoiceRecipient(
          binding.invoiceRecipients?.find((recipient) =>
            hasCheckoutSparkInvoiceRecipient(recipient, canonical, target)
          ),
          canonical,
          target
        )
      }
    )
  }

  async assertInvoiceRecipient(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    assertCurrent?: () => void
  ): Promise<void> {
    if (!(await this.hasInvoiceRecipient(plan, target, assertCurrent))) {
      throw new CheckoutSparkInvoiceOriginUnavailableError()
    }
    assertCurrent?.()
  }

  /**
   * Persist only opaque evidence freshly obtained from the receiving provider.
   * This never changes the invoice, transfer ID, payment outcome or local origin.
   */
  async recordInvoiceRecipientVerification(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    proof: CheckoutSparkInvoiceRecipientProof,
    assertCurrent?: () => void
  ): Promise<void> {
    assertCurrent?.()
    target = { ...target, intent: { ...target.intent } }
    const canonical = restoreCheckoutSparkSettledPlan(plan)
    const record = createCheckoutSparkInvoiceRecipientRecord(
      canonical,
      target,
      proof
    )
    await this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(canonical.checkoutId)
        const binding = await this.database.checkoutSparkPlanBindings.get(
          canonical.checkoutId
        )
        assertCurrent?.()
        if (
          snapshot.status !== "active" ||
          snapshot.state.plan.planDigest !== canonical.planDigest ||
          !binding ||
          binding.planDigest !== canonical.planDigest
        )
          throw new CheckoutSparkSettledRepositoryConflictError()
        if (!matchesSavedInvoiceTarget(snapshot.state, target))
          throw new CheckoutSparkSettledRepositoryConflictError()
        const previous = binding.invoiceRecipients?.find(
          (recipient) => recipient.intentDigest === record.intentDigest
        )
        if (
          previous &&
          !hasCheckoutSparkInvoiceRecipient(previous, canonical, target)
        ) {
          throw new CheckoutSparkSettledRepositoryIntegrityError()
        }
        const settlement = binding.merchantSettlement
          ? restoreCheckoutSparkMerchantSettlementRecord(
              binding.merchantSettlement,
              canonical
            )
          : null
        // Independent attribution may upgrade existing provider-paid facts, but
        // cannot create those facts or change their exact amounts/transfer.
        const attributed = settlement
          ? {
              ...settlement,
              paidLegs: settlement.paidLegs.map((paid) =>
                paid.legId === target.legId &&
                paid.transferId === target.intent.transferId &&
                paid.allocationSats === target.allocationSats
                  ? { ...paid, recipientVerified: true as const }
                  : paid
              ),
            }
          : null
        const next = {
          ...binding,
          invoiceRecipients: previous
            ? binding.invoiceRecipients
            : [...(binding.invoiceRecipients ?? []), record],
          ...(attributed
            ? {
                merchantSettlement: attributed,
                supplierNotificationIntents:
                  getCheckoutSparkSupplierNotifications(
                    canonical,
                    attributed,
                    snapshot.state
                  ),
              }
            : {}),
        }
        await this.database.checkoutSparkPlanBindings.put(next)
        assertCurrent?.()
      }
    )
  }

  private async saveState(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    assertCurrent?: () => void,
    evidence?: {
      legId: string
      origin: CheckoutSparkLnurlInvoiceOrigin
      proof?: CheckoutSparkSettledReturnedProof
      nowMs?: number
      now?: () => number
    }
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    assertCurrent?.()
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
    const next = projectState(state)
    const { checkoutId, planDigest } = next.plan
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent?.()
        const current = await this.readInTransaction(checkoutId)
        assertCurrent?.()
        if (
          current.status !== "active" ||
          current.revision !== expectedRevision ||
          current.state.plan.planDigest !== planDigest ||
          !Number.isSafeInteger(current.revision + 1)
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        assertCheckoutSparkSettledRecoveryProgression(current.state, next)
        const advanced = next.legs.filter(
          (leg, index) =>
            getCheckoutSparkSettledLegGeneration(leg) !==
            getCheckoutSparkSettledLegGeneration(current.state.legs[index]!)
        )
        if (advanced.length > 0) {
          const leg = advanced[0]!
          if (
            advanced.length !== 1 ||
            !evidence?.proof ||
            evidence.legId !== leg.legId ||
            evidence.nowMs === undefined ||
            typeof evidence.now !== "function" ||
            !leg.intent ||
            evidence.nowMs !== next.updatedAt
          )
            throw new CheckoutSparkSettledRepositoryConflictError()
          const expected = renewCheckoutSparkSettledLeg(current.state, {
            legId: leg.legId,
            intent: leg.intent,
            proof: evidence.proof,
            nowMs: evidence.nowMs,
          })
          if (JSON.stringify(expected) !== JSON.stringify(next))
            throw new CheckoutSparkSettledRepositoryConflictError()
        } else if (evidence?.proof)
          throw new CheckoutSparkSettledRepositoryConflictError()
        const assertFreshReturn = () => {
          if (!evidence?.proof) return
          const old = current.state.legs.find(
            (leg) => leg.legId === evidence.legId
          )!
          const recipient = current.state.plan.recipients.find(
            (item) => item.legId === old.legId
          )!
          assertCheckoutSparkSettledReturnedProof(evidence.proof, {
            plan: current.state.plan,
            target: {
              walletId: current.state.plan.walletId,
              network: current.state.plan.network,
              legId: old.legId,
              recipientId: recipient.recipientId,
              allocationSats: old.allocationSats!,
              unpaidAllocationSats: current.state.legs.reduce(
                (sum, leg) =>
                  sum + (leg.status === "paid" ? 0 : (leg.allocationSats ?? 0)),
                0
              ),
              intent: old.intent!,
            },
            nowMs: evidence.now!(),
          })
        }
        assertFreshReturn()
        if (evidence) {
          const previousLeg = current.state.legs.find(
            (leg) => leg.legId === evidence.legId
          )
          const leg = next.legs.find(
            (candidate) => candidate.legId === evidence.legId
          )
          const recipient = next.plan.recipients.find(
            (candidate) => candidate.legId === evidence.legId
          )
          if (
            !previousLeg ||
            (previousLeg.intent !== null && !evidence.proof) ||
            !leg?.intent ||
            leg.status !== "prepared" ||
            leg.allocationSats === null ||
            !recipient ||
            !next.credit
          ) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
          const origin = createCheckoutSparkInvoiceOriginRecord(
            next.plan,
            {
              walletId: next.plan.walletId,
              network: next.plan.network,
              legId: leg.legId,
              recipientId: recipient.recipientId,
              allocationSats: leg.allocationSats,
              unpaidAllocationSats: next.credit.creditedSats,
              intent: leg.intent,
              generation: getCheckoutSparkSettledLegGeneration(leg),
            },
            evidence.origin
          )
          const binding =
            await this.database.checkoutSparkPlanBindings.get(checkoutId)
          assertCurrent?.()
          assertFreshReturn()
          if (
            !binding ||
            binding.planDigest !== planDigest ||
            binding.invoiceOrigins?.some(
              (entry) => entry.intentDigest === origin.intentDigest
            )
          ) {
            throw new CheckoutSparkSettledRepositoryIntegrityError()
          }
          await this.database.checkoutSparkPlanBindings.put({
            ...binding,
            invoiceOrigins: [...(binding.invoiceOrigins ?? []), origin],
          })
          assertCurrent?.()
          assertFreshReturn()
        }
        const revision = current.revision + 1
        await this.database.checkoutSparkReconciliations.put({
          checkoutId,
          revision,
          state: next,
        })
        assertCurrent?.()
        assertFreshReturn()
        return { status: "active" as const, revision, state: next }
      }
    )
  }

  async retire(input: {
    checkoutId: string
    planDigest: string
    expectedRevision: number
    evidence: CheckoutSparkRetirementEvidence
    assertCurrent?: () => void
  }): Promise<CheckoutSparkRetirementTombstone> {
    const assertCurrent = input.assertCurrent
    assertCurrent?.()
    assertKey(input.checkoutId, input.planDigest)
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent?.()
        const current = await this.readInTransaction(input.checkoutId)
        assertCurrent?.()
        if (
          current.status !== "active" ||
          current.revision !== input.expectedRevision ||
          current.state.plan.planDigest !== input.planDigest
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const tombstone = retireCheckoutSparkSettledReconciliation(
          current.state,
          input.evidence
        )
        const binding = await this.database.checkoutSparkPlanBindings.get(
          input.checkoutId
        )
        assertCurrent?.()
        if (!binding || binding.planDigest !== input.planDigest) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        const summary = createCheckoutSparkRetiredSettlementSummary(
          current.state
        )
        if (binding.merchantSettlement) {
          validateCheckoutSparkRetiredSettlementRecord(
            summary,
            binding.merchantSettlement
          )
        }
        if (binding.buyerOrderBinding) {
          const buyer = restoreCheckoutSparkBuyerOrderBinding(
            binding.buyerOrderBinding
          )
          if (
            buyer.checkoutId !== summary.checkoutId ||
            buyer.planDigest !== summary.planDigest ||
            buyer.orderId !== summary.orderId ||
            buyer.merchantPubkey !== summary.merchantPubkey ||
            buyer.walletId !== summary.walletId ||
            buyer.commerceTotalSats !== summary.commerceTotalSats
          ) {
            throw new CheckoutSparkSettledRepositoryIntegrityError()
          }
        }
        // Terminal provider evidence has retired this checkout. Keep its
        // minimal order/settlement/source attestation, but not encrypted retry
        // payloads or the public source bodies needed only for active recovery.
        const retainedBinding = { ...binding }
        if (binding.merchantSettlement) {
          // Persist eligibility before discarding the plan even if the signer or
          // supplier inbox was unavailable before the first notification wrap.
          retainedBinding.supplierNotificationIntents =
            getCheckoutSparkSupplierNotifications(
              current.state.plan,
              binding.merchantSettlement,
              current.state
            )
        }
        delete retainedBinding.merchantProgressOutbox
        delete retainedBinding.sourceEvents
        delete retainedBinding.invoiceOrigins
        delete retainedBinding.invoiceRecipients
        await this.database.checkoutSparkPlanBindings.put({
          ...retainedBinding,
          retiredSettlementSummary: summary,
        })
        assertCurrent?.()
        await this.database.checkoutSparkRetirements.add({
          checkoutId: input.checkoutId,
          ...tombstone,
        })
        assertCurrent?.()
        await this.database.checkoutSparkReconciliations.delete(
          input.checkoutId
        )
        assertCurrent?.()
        return tombstone
      }
    )
  }
}
