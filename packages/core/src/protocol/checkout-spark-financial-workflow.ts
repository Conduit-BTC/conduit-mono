import {
  assertCheckoutSparkSettledFundingCoverage,
  getCheckoutSparkSettledLegGeneration,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  runCheckoutSparkSettledOutgoingStep,
  hasCheckoutSparkOutgoingPreProviderCancellation,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingStateStore,
  type CheckoutSparkSettledOutgoingStepInput,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkSettledOutgoingTarget,
} from "./checkout-spark-settled-outgoing"
import {
  prepareCheckoutSparkSettledOutgoingLegShared,
  type CheckoutSparkSettledLegPreparationDependencies,
} from "./checkout-spark-settled-leg-preparation"
import {
  runCheckoutSparkNativeTreasuryStep,
  type CheckoutSparkNativeTreasuryStepInput,
} from "./checkout-spark-treasury-finalization"
import {
  CheckoutSparkSettledRepositoryConflictError,
  type CheckoutSparkSettledRepositorySnapshot,
} from "./checkout-spark-settled-router-repository"
import type { SparkCheckoutReceiveCreditProof } from "./checkout-spark-receive-credit"
import {
  collectCheckoutSparkNativeRetirementEvidence,
  type CheckoutSparkNativeRetirementReader,
} from "./checkout-spark-native-retirement"
import type { CheckoutSparkRetirementEvidence } from "./checkout-spark-reconciliation"
import type { CheckoutSparkSettledClosedReturnedProof } from "./checkout-spark-settled-returned"

type Active = Extract<
  CheckoutSparkSettledRepositorySnapshot,
  { status: "active" }
>
type Outgoing = CheckoutSparkSettledOutgoingStepInput["provider"]

export interface CheckoutSparkFinancialWorkflowInput {
  checkoutId: string
  planDigest: string
  /** Time policy only. The adapter must authenticate its actual session. */
  actor: "shopper" | "merchant"
  mode: "credit" | "reconcile" | "prepare" | "advance" | "retire"
  /** A reviewed leg fences continuation; omission lets Core select the next. */
  legId?: string
  inspectionOnly?: boolean
  allowRenewal?: boolean
}

export interface CheckoutSparkFinancialWorkflowPorts {
  store: CheckoutSparkSettledOutgoingStateStore
  /** Fresh identity/order/session checks before and after every awaited port. */
  assertCurrent(): void | Promise<void>
  now(): number
  credit?: {
    proof: SparkCheckoutReceiveCreditProof
    /** Independent native fact is committed before its reconciliation projection. */
    record(
      plan: CheckoutSparkSettledPlan,
      proof: SparkCheckoutReceiveCreditProof
    ): Promise<unknown>
  }
  outgoing?: Outgoing
  /** Must independently verify the exact receiving endpoint, not buyer labels. */
  recordPaid?: (
    target: CheckoutSparkSettledOutgoingTarget,
    observation: Extract<
      CheckoutSparkSettledOutgoingObservation,
      { status: "paid" }
    >
  ) => Promise<boolean | void>
  preparation?: CheckoutSparkSettledLegPreparationDependencies
  /** Optional existing adapter seam; production uses the shared preparation ports. */
  prepareLeg?: (legId: string) => Promise<Active>
  native?: Pick<
    CheckoutSparkNativeTreasuryStepInput,
    "provider" | "proveCommerce"
  > & {
    store: CheckoutSparkNativeTreasuryStepInput["store"]
  }
  acknowledgeRecoverySnapshot(
    state: CheckoutSparkSettledReconciliation
  ): Promise<void>
  proveRenewalReturn?: CheckoutSparkSettledOutgoingStepInput["proveRenewalReturn"]
  /** Retry exact terminal cleanup only after loading a positive replay marker. */
  cleanupTerminal?: () => Promise<void>
  retirement?: {
    /** Exact authenticated credit, recipient and treasury proof, never labels. */
    proveSettlement(state: CheckoutSparkSettledReconciliation): Promise<{
      expectedTransferIds: string[]
      closedReturnedProofs: CheckoutSparkSettledClosedReturnedProof[]
    } | null>
    openReader(state: CheckoutSparkSettledReconciliation): Promise<{
      reader: CheckoutSparkNativeRetirementReader
      sparkAddress: string
      cleanup(): Promise<void>
    }>
    /** Atomic replay marker and encrypted-evidence retention; no provider I/O. */
    commit(input: {
      checkoutId: string
      planDigest: string
      expectedRevision: number
      evidence: CheckoutSparkRetirementEvidence
    }): Promise<unknown>
  }
  /** Kept for isolated provider-contract tests; production uses the Core engine. */
  outgoingStep?: typeof runCheckoutSparkSettledOutgoingStep
  treasuryStep?: typeof runCheckoutSparkNativeTreasuryStep
}

export type CheckoutSparkFinancialWorkflowResult =
  | { status: "retired" }
  | {
      status: "credited" | "reconciled"
      state: CheckoutSparkSettledReconciliation
    }
  | { status: "payout_prepared"; state: CheckoutSparkSettledReconciliation }
  | { status: "outgoing_step"; step: CheckoutSparkSettledOutgoingStepResult }

function waiting(
  state: CheckoutSparkSettledReconciliation,
  reason: CheckoutSparkSettledOutgoingStepResult["reason"]
): CheckoutSparkFinancialWorkflowResult {
  return {
    status: "outgoing_step",
    step: { state, outcome: "wait", reason, sendAttempted: false },
  }
}

function assertExactObservation(
  target: CheckoutSparkSettledOutgoingTarget,
  observation: CheckoutSparkSettledOutgoingObservation
): void {
  if (
    observation.legId !== target.legId ||
    observation.transferId !== target.intent.transferId ||
    observation.paymentRequest !== target.intent.paymentRequest ||
    observation.paymentHash !== target.intent.paymentHash ||
    observation.invoiceAmountSats !== target.intent.invoiceAmountSats ||
    observation.maxFeeSats !== target.intent.maxFeeSats
  )
    throw new Error(
      "Checkout Spark outgoing evidence changed its exact intent."
    )
  if (
    observation.status === "paid" &&
    (!Number.isSafeInteger(observation.finalFeeSats) ||
      observation.finalFeeSats < 0 ||
      observation.finalFeeSats > target.intent.maxFeeSats ||
      !Number.isSafeInteger(observation.finalDebitSats) ||
      observation.finalDebitSats !==
        target.intent.invoiceAmountSats + observation.finalFeeSats ||
      observation.finalDebitSats > target.allocationSats)
  )
    throw new Error(
      "Checkout Spark outgoing evidence exceeded its exact budget."
    )
}

/**
 * The shared financial sequence for Buyer execution and claim-capable Merchant
 * recovery. It owns fact/projection ordering, exact sibling reconciliation,
 * obligation selection, preparation, write-ahead outgoing execution and final
 * Conduit collection. Transport, wallet ownership and session authority stay
 * in the adapters. Query-only settlement observation does not enter this seam.
 */
export async function runCheckoutSparkFinancialWorkflow(
  input: CheckoutSparkFinancialWorkflowInput,
  ports: CheckoutSparkFinancialWorkflowPorts
): Promise<CheckoutSparkFinancialWorkflowResult> {
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ports.assertCurrent()
    const value = await operation()
    await ports.assertCurrent()
    return value
  }
  const valid = (snapshot: CheckoutSparkSettledRepositorySnapshot): Active => {
    if (snapshot.status !== "active")
      throw new CheckoutSparkSettledRepositoryConflictError()
    const state = restoreCheckoutSparkSettledReconciliation(snapshot.state)
    if (
      state.plan.checkoutId !== input.checkoutId ||
      state.plan.planDigest !== input.planDigest
    )
      throw new CheckoutSparkSettledRepositoryConflictError()
    return { ...snapshot, state }
  }
  const store: CheckoutSparkSettledOutgoingStateStore = {
    outgoingAdmissionScope: ports.store.outgoingAdmissionScope,
    ...(ports.store.saveOutgoingPreProviderRetry
      ? {
          saveOutgoingPreProviderRetry: (state, revision, cancellation) =>
            checked(() =>
              ports.store.saveOutgoingPreProviderRetry!(
                state,
                revision,
                cancellation
              )
            ),
        }
      : {}),
    load: (checkoutId, planDigest) =>
      checked(() => ports.store.load(checkoutId, planDigest)),
    save: (state, revision) => checked(() => ports.store.save(state, revision)),
  }
  const first = await store.load(input.checkoutId, input.planDigest)
  if (first.status === "retired") {
    if (first.planDigest !== input.planDigest)
      throw new CheckoutSparkSettledRepositoryConflictError()
    if (ports.cleanupTerminal) {
      try {
        await checked(ports.cleanupTerminal)
      } catch {
        await ports.assertCurrent()
      }
    }
    return { status: "retired" }
  }
  let current = valid(first)
  const plan = current.state.plan
  const ack = (state: CheckoutSparkSettledReconciliation) =>
    checked(() => ports.acknowledgeRecoverySnapshot(state))
  if (ports.credit) {
    const proof = ports.credit.proof
    // Validate even an imported credit before admitting an independent fact.
    const next = recordCheckoutSparkSettledCredit(current.state, {
      ...proof,
      paymentHash: plan.funding.paymentHash,
      observedAt: ports.now(),
    })
    await checked(() => ports.credit!.record(plan, proof))
    if (!current.state.credit)
      current = valid(await store.save(next, current.revision))
  }
  if (input.mode === "credit")
    return { status: "credited", state: current.state }
  if (!current.state.credit) {
    return {
      status: "outgoing_step",
      step: {
        state: current.state,
        outcome: "funding_wait",
        sendAttempted: false,
      },
    }
  }
  if (input.mode === "retire") {
    if (
      !ports.retirement ||
      current.state.legs.some((leg) => leg.status !== "paid")
    )
      return waiting(current.state, "prerequisite_unpaid")
    const proved = await checked(() =>
      ports.retirement!.proveSettlement(current.state)
    )
    if (!proved) return waiting(current.state, "provider_evidence_unavailable")
    const expected = [
      current.state.credit.transferId,
      ...current.state.legs.map((leg) => {
        const recipient = plan.recipients.find(
          (row) => row.legId === leg.legId
        )!
        return plan.nativeTreasury && recipient.kind === "conduit"
          ? current.state.treasuryFinalization?.providerTransferId
          : leg.intent?.transferId
      }),
    ]
    if (
      expected.some((id) => !id) ||
      new Set(proved.expectedTransferIds).size !== expected.length ||
      expected.some((id) => !proved.expectedTransferIds.includes(id!))
    )
      return waiting(current.state, "provider_evidence_conflicting")
    const same = valid(await store.load(input.checkoutId, input.planDigest))
    if (same.revision !== current.revision)
      throw new CheckoutSparkSettledRepositoryConflictError()
    await ports.assertCurrent()
    const session = await ports.retirement.openReader(current.state)
    let evidence: CheckoutSparkRetirementEvidence | null
    try {
      await ports.assertCurrent()
      const reader: CheckoutSparkNativeRetirementReader = {
        getTransfers: (request) =>
          checked(() => session.reader.getTransfers(request)),
        getPendingTransfers: (address) =>
          checked(() => session.reader.getPendingTransfers(address)),
        getAvailableBalance: (address) =>
          checked(() => session.reader.getAvailableBalance(address)),
        getOwnedBalance: (address) =>
          checked(() => session.reader.getOwnedBalance(address)),
        ...(session.reader.getInternalSwapEvidence
          ? {
              getInternalSwapEvidence: (request) =>
                checked(() => session.reader.getInternalSwapEvidence!(request)),
            }
          : {}),
      }
      evidence = await collectCheckoutSparkNativeRetirementEvidence({
        authenticatedReader: reader,
        sparkAddress: session.sparkAddress,
        walletId: plan.walletId,
        network: plan.network,
        stateUpdatedAt: current.state.updatedAt,
        expectedTransferIds: proved.expectedTransferIds,
        closedReturnedProofs: proved.closedReturnedProofs,
        ...(plan.nativeTreasury
          ? { requireExactHistoryScope: true as const }
          : {}),
        now: ports.now,
      })
    } finally {
      // Inspection handles close even after revocation, before the durable write.
      await session.cleanup()
    }
    await ports.assertCurrent()
    if (!evidence)
      return waiting(current.state, "provider_evidence_unavailable")
    const fresh = valid(await store.load(input.checkoutId, input.planDigest))
    if (fresh.revision !== current.revision)
      throw new CheckoutSparkSettledRepositoryConflictError()
    await checked(() =>
      ports.retirement!.commit({
        checkoutId: input.checkoutId,
        planDigest: input.planDigest,
        expectedRevision: fresh.revision,
        evidence: evidence!,
      })
    )
    const terminal = await store.load(input.checkoutId, input.planDigest)
    if (
      terminal.status !== "retired" ||
      terminal.planDigest !== input.planDigest
    )
      throw new CheckoutSparkSettledRepositoryConflictError()
    // Cleanup failure never undoes a positive terminal replay marker.
    if (ports.cleanupTerminal) {
      try {
        await checked(ports.cleanupTerminal)
      } catch {
        await ports.assertCurrent()
      }
    }
    return { status: "retired" }
  }

  const provider: Outgoing | undefined = ports.outgoing && {
    reconcile: async (target) => {
      const observation = await checked(() => ports.outgoing!.reconcile(target))
      assertExactObservation(target, observation)
      if (observation.status === "paid" && ports.recordPaid) {
        const verified = await checked(() =>
          ports.recordPaid!(target, observation)
        )
        if (verified === false)
          return { ...observation, status: "lookup_unavailable" as const }
      }
      return observation
    },
    preflight: (target) => checked(() => ports.outgoing!.preflight(target)),
    send: async (target) => {
      const observation = await checked(() => ports.outgoing!.send(target))
      if (observation.status !== "not_sent")
        assertExactObservation(target, observation)
      if (observation.status === "paid" && ports.recordPaid) {
        const verified = await checked(() =>
          ports.recordPaid!(target, observation)
        )
        if (verified === false)
          return { ...observation, status: "lookup_unavailable" as const }
      }
      return observation
    },
  }
  // Every frozen commerce attempt is re-attested, including imported paid rows.
  // A prepared not-found row may proceed under its original exact intent; every
  // possible send stays inspection-only until independent evidence resolves it.
  if (provider) {
    for (const original of current.state.legs) {
      const recipient = plan.recipients.find(
        (row) => row.legId === original.legId
      )!
      if (
        !original.intent ||
        (plan.nativeTreasury && recipient.kind === "conduit")
      )
        continue
      const target: CheckoutSparkSettledOutgoingTarget = {
        walletId: plan.walletId,
        network: plan.network,
        legId: original.legId,
        recipientId: recipient.recipientId,
        allocationSats: original.allocationSats!,
        // Historical inspection still satisfies the exact-request shape. This
        // floor grants no reserve: dispatch computes actual unpaid sums anew.
        unpaidAllocationSats: Math.max(
          original.allocationSats!,
          current.state.legs.reduce(
            (sum, row) =>
              sum + (row.status === "paid" ? 0 : row.allocationSats!),
            0
          )
        ),
        intent: original.intent,
        ...(getCheckoutSparkSettledLegGeneration(original) === 1
          ? { generation: 1 as const }
          : {}),
      }
      const observed = await provider.reconcile(target)
      if (
        observed.status === "not_found" &&
        (original.status === "prepared" ||
          (!input.inspectionOnly &&
            hasCheckoutSparkOutgoingPreProviderCancellation(
              store.outgoingAdmissionScope,
              current.state,
              current.revision,
              original.legId
            )))
      )
        continue
      if (observed.status !== "paid") {
        // A permitted renewal still needs fresh full-return proof; absence is
        // not its evidence. Its proof port is fenced again by Core preparation.
        if (
          (input.mode === "prepare" || input.mode === "reconcile") &&
          input.allowRenewal &&
          original.legId === input.legId &&
          ports.proveRenewalReturn
        ) {
          try {
            await checked(() =>
              ports.proveRenewalReturn!(current.state, original.legId)
            )
            continue
          } catch {
            await ports.assertCurrent()
          }
        }
        return waiting(
          current.state,
          observed.status === "conflicting_evidence"
            ? "provider_evidence_conflicting"
            : observed.status === "lookup_unavailable"
              ? "provider_evidence_unavailable"
              : "prior_possible_send"
        )
      }
      // The pure transition validates exact invoice/attempt identity as well as
      // fee/debit bounds. Existing paid rows must agree with fresh exact facts.
      if (original.status === "paid") {
        if (
          original.finalFeeSats !== observed.finalFeeSats ||
          original.finalDebitSats !== observed.finalDebitSats
        )
          return waiting(current.state, "provider_evidence_conflicting")
      } else {
        const fresh = valid(
          await store.load(input.checkoutId, input.planDigest)
        )
        const next = recordCheckoutSparkSettledLegStatus(fresh.state, {
          legId: target.legId,
          transferId: observed.transferId,
          paymentHash: observed.paymentHash,
          status: "paid",
          finalFeeSats: observed.finalFeeSats,
          finalDebitSats: observed.finalDebitSats,
          observedAt: Math.max(ports.now(), fresh.state.updatedAt + 1),
        })
        current = valid(await store.save(next, fresh.revision))
        try {
          await ack(current.state)
        } catch {
          // The independent fact and paid projection already committed. A lost
          // progress ACK pauses delivery, never undoes payment or admits resend.
          // Do not disguise a revoked session or concurrent durable change as a
          // transport outage: both must still stop this invocation.
          await ports.assertCurrent()
          const retained = valid(
            await store.load(input.checkoutId, input.planDigest)
          )
          if (
            retained.revision !== current.revision ||
            JSON.stringify(retained.state) !== JSON.stringify(current.state)
          )
            throw new CheckoutSparkSettledRepositoryConflictError()
          return waiting(retained.state, "recovery_handoff_unavailable")
        }
      }
    }
  }
  current = valid(await store.load(input.checkoutId, input.planDigest))
  if (input.mode === "reconcile")
    return { status: "reconciled", state: current.state }
  try {
    assertCheckoutSparkSettledFundingCoverage(
      plan,
      current.state.credit!.creditedSats
    )
  } catch {
    return waiting(current.state, "funding_shortfall")
  }
  if (
    input.legId &&
    current.state.legs.find((leg) => leg.legId === input.legId)?.status ===
      "paid"
  )
    return {
      status: "outgoing_step",
      step: {
        state: current.state,
        outcome: "already_paid",
        sendAttempted: false,
      },
    }
  const next = current.state.legs.find((leg) => leg.status !== "paid")
  if (!next)
    return {
      status: "outgoing_step",
      step: {
        state: current.state,
        outcome: "already_paid",
        sendAttempted: false,
      },
    }
  if (input.legId !== undefined && input.legId !== next.legId)
    return waiting(current.state, "prerequisite_unpaid")
  const recipient = plan.recipients.find((row) => row.legId === next.legId)!
  const nativeFinal = Boolean(
    plan.nativeTreasury && recipient.kind === "conduit"
  )
  const locallyCancelled =
    !input.inspectionOnly &&
    hasCheckoutSparkOutgoingPreProviderCancellation(
      store.outgoingAdmissionScope,
      current.state,
      current.revision,
      next.legId
    )
  if (
    !nativeFinal &&
    !locallyCancelled &&
    (!input.allowRenewal || input.mode !== "prepare") &&
    (next.status === "terminal_failure" ||
      next.status === "conflicting_evidence")
  )
    return waiting(
      current.state,
      next.status === "terminal_failure"
        ? "terminal_failure"
        : "provider_evidence_conflicting"
    )

  if (plan.nativeTreasury && recipient.kind === "conduit") {
    if (input.mode === "prepare" || !ports.native)
      return waiting(current.state, "prerequisite_unpaid")
    const nativeStore = ports.native.store
    const step = await (
      ports.treasuryStep ?? runCheckoutSparkNativeTreasuryStep
    )({
      checkoutId: input.checkoutId,
      planDigest: input.planDigest,
      legId: next.legId,
      actor: input.actor,
      inspectionOnly: input.inspectionOnly,
      now: ports.now,
      store: {
        ...nativeStore,
        load: (checkoutId, planDigest) =>
          checked(() => nativeStore.load(checkoutId, planDigest)),
        save: (state, revision) =>
          checked(() => nativeStore.save(state, revision)),
        savePrepared: (state, revision, settlement) =>
          checked(() => nativeStore.savePrepared(state, revision, settlement)),
        ...(nativeStore.savePreProviderRetry
          ? {
              savePreProviderRetry: (state, revision, capability) =>
                checked(() =>
                  nativeStore.savePreProviderRetry!(state, revision, capability)
                ),
            }
          : {}),
      },
      provider: {
        reconcile: (target) =>
          checked(() => ports.native!.provider.reconcile(target)),
        preflight: (...args) =>
          checked(() => ports.native!.provider.preflight(...args)),
        send: (target) => checked(() => ports.native!.provider.send(target)),
      },
      proveCommerce: (state) =>
        checked(() => ports.native!.proveCommerce(state)),
      acknowledgeRecoverySnapshot: ack,
    })
    return { status: "outgoing_step", step }
  }
  // A live cancellation already owns its exact invoice. Preparation may neither
  // renew it nor spend it; the next explicit advance rechecks all send guards.
  if (locallyCancelled && input.mode === "prepare")
    return { status: "payout_prepared", state: current.state }
  if (!next.intent || input.mode === "prepare") {
    if (input.inspectionOnly || !ports.preparation) {
      return {
        status: "outgoing_step",
        step: {
          state: current.state,
          outcome: "invoice_needed",
          sendAttempted: false,
        },
      }
    }
    const preparation = ports.preparation
    const prepared = ports.prepareLeg
      ? await checked(() => ports.prepareLeg!(next.legId))
      : await prepareCheckoutSparkSettledOutgoingLegShared(
          {
            checkoutId: input.checkoutId,
            planDigest: input.planDigest,
            legId: next.legId,
            shouldContinue: () => {
              // The synchronous preparation policy lives in its actor adapter. This
              // callback does not grant authority or restore a revoked session.
              preparation.assertAuthority(current.state, ports.now())
              return true
            },
            allowRenewal: input.allowRenewal,
          },
          {
            ...preparation,
            repository: {
              ...preparation.repository,
              load: (checkoutId, planDigest) =>
                checked(() =>
                  preparation.repository.load(checkoutId, planDigest)
                ),
              savePreparedWithInvoiceOrigin: (...args) =>
                checked(() =>
                  preparation.repository.savePreparedWithInvoiceOrigin(...args)
                ),
              ...(preparation.repository.saveRenewedWithInvoiceOrigin
                ? {
                    saveRenewedWithInvoiceOrigin: (...args) =>
                      checked(() =>
                        preparation.repository.saveRenewedWithInvoiceOrigin!(
                          ...args
                        )
                      ),
                  }
                : {}),
            },
            estimateFee: (request) =>
              checked(() => preparation.estimateFee(request)),
            ...(preparation.resolveInvoice
              ? {
                  resolveInvoice: (...args) =>
                    checked(() => preparation.resolveInvoice!(...args)),
                }
              : {}),
            ...(preparation.proveRenewalReturn
              ? {
                  proveRenewalReturn: (...args) =>
                    checked(() => preparation.proveRenewalReturn!(...args)),
                }
              : {}),
            acknowledgeRecoverySnapshot: ack,
            nowMs: ports.now,
          }
        )
    await ports.assertCurrent()
    return { status: "payout_prepared", state: prepared.state }
  }
  if (!provider) return waiting(current.state, "provider_evidence_unavailable")
  const step = await (
    ports.outgoingStep ?? runCheckoutSparkSettledOutgoingStep
  )({
    checkoutId: input.checkoutId,
    planDigest: input.planDigest,
    legId: next.legId,
    actor: input.actor,
    inspectionOnly: input.inspectionOnly,
    now: ports.now,
    store,
    provider,
    acknowledgeRecoverySnapshot: ack,
    ...(ports.proveRenewalReturn
      ? {
          proveRenewalReturn: (state, legId) =>
            checked(() => ports.proveRenewalReturn!(state, legId)),
        }
      : {}),
  })
  await ports.assertCurrent()
  return { status: "outgoing_step", step }
}
