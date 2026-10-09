import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieMerchantCheckoutSparkProgressRepository,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledMerchantPreparationWindow,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkMerchantProgress,
  checkoutSparkProviderSendWindowEndsAt,
  deriveCheckoutSparkSettledRenewalTransferId,
  deriveCheckoutSparkSettledTransferId,
  getCheckoutSparkSettledLegGeneration,
  getAccountSigner,
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  proveSparkCheckoutReceiveCredit,
  publishMerchantCheckoutSparkProgress,
  restoreCheckoutSparkMerchantOrderWitness,
  restoreCheckoutSparkSettledReconciliation,
  resolveCheckoutSparkLnurlInvoice,
  retryMerchantCheckoutSparkProgress,
  runWithCheckoutSparkMerchantRecoveryLock,
  runCheckoutSparkFinancialWorkflow,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkSettledLegPreparationDependencies,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkSettledRepositorySnapshot,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryHandoffResult,
  type MerchantCheckoutSparkProgressDeliveryStore,
  type MerchantCheckoutSparkProgressTransport,
  type NostrKeySigner,
} from "@conduit/core"

import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  inspectExactMerchantPayout,
  openMerchantCheckoutSparkRecoveryWallet,
  proveMerchantCheckoutSparkReturnedPayout,
} from "./checkout-spark-settled-recovery"
import { assertMerchantCheckoutSparkDispatchPlan } from "./checkout-spark-recovery-policy"
import { assertCheckoutSparkMerchantPricingAuthority } from "./checkout-spark-pricing-authority"

type Store = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "save"
  | "savePreparedWithInvoiceOrigin"
  | "loadMerchantOrderWitness"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
> &
  Partial<
    Pick<DexieCheckoutSparkSettledRepository, "saveRenewedWithInvoiceOrigin">
  >

export interface MerchantCheckoutSparkPreparationDependencies {
  repository?: Store
  deriveIdentity?: typeof deriveMerchantCheckoutSparkRecoveryIdentity
  openWallet?: typeof openMerchantCheckoutSparkRecoveryWallet
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  resolveInvoice?: CheckoutSparkSettledLegPreparationDependencies["resolveInvoice"]
  now?: () => number
  lockManager?: CheckoutSparkMerchantRecoveryLockManager | null
  requireCrossTabLock?: boolean
  signer?: NostrKeySigner | null
  progressStore?: MerchantCheckoutSparkProgressDeliveryStore &
    Pick<DexieMerchantCheckoutSparkProgressRepository, "list">
  progressTransport?: MerchantCheckoutSparkProgressTransport
}

export interface MerchantCheckoutSparkPreparationResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  /** Preparation and relay delivery only; neither payment proof nor send authority. */
  preparation: {
    status:
      | "prepared"
      | "recovery_pending"
      | "existing_intent"
      | "funding_wait"
      | "history_wait"
      | "allocation_unavailable"
      | "prerequisite_unpaid"
    /** Pending may include a pre-stage failure; it does not promise relay durability. */
    recoveryDelivery?: "relay_accepted" | "pending"
  } | null
}

/**
 * Prepare one never-prepared payout after Merchant takeover. Recovered secrets
 * remain within the strict-inbox callback. This adapter has no outgoing send
 * capability; confirmation separately restores the exact signed intent.
 * Exact recovery publication is retained separately from provider/send authority.
 */
export async function prepareMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  input: {
    legId: string
    shouldContinue: () => boolean
    /** Explicit current-session authorization; never inferred from expiry. */
    allowRenewal?: boolean
  },
  dependencies: MerchantCheckoutSparkPreparationDependencies = {}
): Promise<MerchantCheckoutSparkPreparationResult> {
  const principal = principalPubkey.trim().toLowerCase()
  // Hold the selected order/leg across external signer and local-lock awaits.
  selected = {
    ...selected,
    ...(selected.merchantProgress
      ? { merchantProgress: { ...selected.merchantProgress } }
      : {}),
  }
  input = {
    legId: input.legId,
    shouldContinue: input.shouldContinue,
    allowRenewal: input.allowRenewal === true,
  }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const progressStore =
    dependencies.progressStore ??
    new DexieMerchantCheckoutSparkProgressRepository()
  let preparation: MerchantCheckoutSparkPreparationResult["preparation"] = null
  const assertActive = () => {
    if (input.shouldContinue() !== true) {
      throw new Error("Checkout Spark Merchant preparation session changed.")
    }
  }
  const prepare = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedState: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ) => {
    const { plan } = initial
    const assertEligible = () => {
      assertActive()
      assertCurrent()
      assertMerchantCheckoutSparkDispatchPlan(plan)
      assertCheckoutSparkSettledMerchantPreparationWindow(signedState, now())
    }
    const assertState = (value: CheckoutSparkSettledReconciliation) => {
      assertEligible()
      const state = restoreCheckoutSparkSettledReconciliation(value)
      if (
        principal !== initial.merchantPubkey ||
        principal !== plan.merchantPubkey ||
        plan.checkoutId !== selected.checkoutId ||
        plan.orderId !== selected.orderId ||
        plan.planDigest !== selected.planDigest ||
        plan.planDigest !== state.plan.planDigest ||
        plan.walletId !== initial.wallet.walletId ||
        plan.network !== initial.wallet.network
      ) {
        throw new Error("Checkout Spark Merchant recovery binding is invalid.")
      }
      assertCheckoutSparkSettledRecoveryProgression(signedState, state)
    }
    const requireActive = (current: CheckoutSparkSettledRepositorySnapshot) => {
      assertEligible()
      if (current.status !== "active") {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      assertState(current.state)
      return current
    }
    const load = async () => {
      assertEligible()
      return requireActive(
        await repository.load(plan.checkoutId, plan.planDigest)
      )
    }
    assertState(signedState)
    const witness = await repository.loadMerchantOrderWitness(
      principal,
      plan.checkoutId,
      plan.planDigest
    )
    assertEligible()
    if (
      !witness ||
      restoreCheckoutSparkMerchantOrderWitness(witness, plan).buyerPubkey !==
        initial.senderPubkey
    ) {
      throw new Error(
        "Checkout Spark Merchant preparation requires its authenticated order."
      )
    }
    let current = await load()
    if (!current.state.legs.some((leg) => leg.legId === input.legId)) {
      throw new Error("Checkout Spark payout leg is not in this plan.")
    }
    if (
      plan.schemaVersion === 4 &&
      plan.recipients.find((recipient) => recipient.legId === input.legId)
        ?.kind === "conduit"
    ) {
      throw new Error(
        "Use native treasury finalization, not Lightning invoice preparation."
      )
    }
    const signer =
      dependencies.signer === undefined
        ? getAccountSigner()
        : dependencies.signer
    if (!signer) throw new Error("Merchant signer is not connected.")
    const signerPubkey = await signer.getPublicKey()
    assertEligible()
    if (signerPubkey.toLowerCase() !== principal) {
      throw new Error("Checkout Spark Merchant preparation signer changed.")
    }
    const shouldPublish = () => {
      // Transport invokes this before its own awaited side effects. Preserve the
      // private exact-recovery guard, not merely the route's visible account.
      assertEligible()
      return true
    }
    const pendingDelivery = () => {
      preparation = { status: "recovery_pending", recoveryDelivery: "pending" }
    }
    const pendingProgress = async () => {
      const entries = await progressStore.list(
        principal,
        plan.checkoutId,
        plan.planDigest
      )
      assertEligible()
      for (const entry of entries) {
        const record = parseMerchantCheckoutSparkProgressDeliveryRecord(
          entry.record
        )
        if (
          record.merchantPubkey !== principal ||
          record.checkoutId !== plan.checkoutId ||
          record.planDigest !== plan.planDigest ||
          record.initialHandoffId !== initial.handoffId ||
          typeof entry.relayAccepted !== "boolean"
        )
          throw new Error("Checkout Spark Merchant recovery binding changed.")
      }
      return entries.find((entry) => !entry.relayAccepted)
    }
    // Drain one unresolved exact wrap per invocation before opening a provider
    // or requesting an invoice. Advancing local state cannot replace its bytes.
    const pending = await pendingProgress()
    if (pending) {
      try {
        const delivery = await retryMerchantCheckoutSparkProgress({
          record: pending.record,
          signer,
          store: progressStore,
          shouldContinue: shouldPublish,
          transport: dependencies.progressTransport,
        })
        assertEligible()
        current = await load()
        if (!delivery.relayAccepted || (await pendingProgress())) {
          pendingDelivery()
          return
        }
      } catch {
        assertEligible()
        await load()
        pendingDelivery()
        return
      }
    }
    const retainProgress = async (
      state: CheckoutSparkSettledReconciliation
    ): Promise<boolean> => {
      const saved = await load()
      if (JSON.stringify(saved.state) !== JSON.stringify(state)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      const payload = createCheckoutSparkMerchantProgress({
        initialHandoffId: initial.handoffId,
        state,
      })
      let relayAccepted = false
      try {
        const delivery = await publishMerchantCheckoutSparkProgress({
          payload,
          signer,
          store: progressStore,
          shouldContinue: shouldPublish,
          transport: dependencies.progressTransport,
        })
        assertEligible()
        relayAccepted = delivery.relayAccepted
      } catch {
        assertEligible()
        // The exact local intent survives even if signing/staging/delivery has
        // not finished. No raw transport failure or payment data leaves here.
      }
      const after = await load()
      if (JSON.stringify(after.state) !== JSON.stringify(state)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      return relayAccepted
    }
    const retainExisting = async () => {
      current = await load()
      if (
        !current.state.legs.find((leg) => leg.legId === input.legId)?.intent
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      if (current.state.updatedAt < plan.takeoverAt) {
        // One metadata-only post-handoff snapshot preserves a buyer-prepared
        // intent exactly. Subsequent retries reuse this timestamp and wrapper.
        current = requireActive(
          await repository.save(
            {
              ...current.state,
              updatedAt: Math.max(now(), plan.takeoverAt),
            },
            current.revision,
            assertEligible
          )
        )
      }
      const accepted = await retainProgress(current.state)
      preparation = {
        status: accepted ? "existing_intent" : "recovery_pending",
        recoveryDelivery: accepted ? "relay_accepted" : "pending",
      }
    }
    // Signer and outbox awaits may let another writer advance local state.
    current = await load()
    const target = current.state.legs.find((leg) => leg.legId === input.legId)
    if (!target)
      throw new Error("Checkout Spark payout leg is not in this plan.")
    const endsAt = target.intent
      ? checkoutSparkProviderSendWindowEndsAt(target.intent.paymentRequest)
      : null
    const renewing =
      input.allowRenewal === true &&
      target.intent !== null &&
      getCheckoutSparkSettledLegGeneration(target) === 0 &&
      endsAt !== null &&
      endsAt <= now()
    if (target.intent && !renewing) {
      await retainExisting()
      return
    }
    const identity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(identity) ||
      identity !== plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
      ...(renewing ? { renewal: true as const } : {}),
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const actualIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (actualIdentity !== identity)
        throw new Error("Checkout Spark wallet identity changed.")
      if (renewing && !wallet.inspectReturnedInvoiceAttempt) {
        preparation = { status: "history_wait" }
        return
      }
      const receive = await wallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertEligible()
      if (
        !receive ||
        receive.status !== "TRANSFER_COMPLETED" ||
        !receive.transfer?.sparkId
      ) {
        preparation = { status: "funding_wait" }
        return
      }
      const transfer = await wallet.getTransfer(receive.transfer.sparkId)
      assertEligible()
      if (!transfer) {
        preparation = { status: "funding_wait" }
        return
      }
      const proof = proveSparkCheckoutReceiveCredit({
        expectedRequest: {
          id: plan.funding.requestId,
          network: plan.network,
          paymentRequest: plan.funding.paymentRequest,
          paymentHash: plan.funding.paymentHash,
          grossFundingSats: plan.funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: actualIdentity,
        receive,
        transfer,
      })
      assertCheckoutSparkMerchantPricingAuthority({ plan, fundingProof: proof })
      assertEligible()
      current = await load()
      const workflowStore = {
        load: repository.load.bind(repository),
        save: (state: CheckoutSparkSettledReconciliation, revision: number) =>
          repository.save(state, revision, assertEligible),
      }
      const reconciliation = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          actor: "merchant",
          mode: "reconcile",
          legId: input.legId,
          allowRenewal: renewing,
        },
        {
          store: workflowStore,
          assertCurrent: assertEligible,
          now,
          credit: {
            proof,
            record: (creditPlan, creditProof) =>
              repository.recordMerchantCredit(
                creditPlan,
                creditProof,
                now(),
                assertEligible
              ),
          },
          outgoing: {
            reconcile: (target) =>
              inspectExactMerchantPayout(plan, target, wallet, assertEligible),
            preflight: async () => "unavailable",
            send: async () => ({ status: "not_sent" }),
          },
          recordPaid: async (target, observed) => {
            await repository.recordMerchantPayout(
              plan,
              target,
              observed,
              now(),
              assertEligible
            )
          },
          ...(renewing
            ? {
                proveRenewalReturn: (
                  state: CheckoutSparkSettledReconciliation,
                  legId: string
                ) =>
                  proveMerchantCheckoutSparkReturnedPayout(
                    state,
                    legId,
                    wallet,
                    assertEligible,
                    now
                  ),
              }
            : {}),
          acknowledgeRecoverySnapshot: async () => {},
        }
      )
      if (reconciliation.status !== "reconciled") {
        preparation = { status: "history_wait" }
        return
      }
      current = await load()
      const selectedLeg = current.state.legs.find(
        (leg) => leg.legId === input.legId
      )!
      if (selectedLeg.intent && (!renewing || selectedLeg.status === "paid")) {
        await retainExisting()
        return
      }
      if (
        current.state.legs.find((leg) => leg.status !== "paid")?.legId !==
        input.legId
      ) {
        preparation = { status: "prerequisite_unpaid" }
        return
      }
      if (
        selectedLeg.allocationSats === null ||
        selectedLeg.allocationSats <= 1 ||
        !wallet.estimateLightningFee
      ) {
        preparation = { status: "allocation_unavailable" }
        return
      }
      if (!wallet.getTransferFromSsp) {
        preparation = { status: "history_wait" }
        return
      }
      // Even without a saved invoice, inspect the preassigned provider ID. A
      // returned transfer cannot authorize a different invoice or recipient.
      let priorTransfer: Awaited<
        ReturnType<NonNullable<typeof wallet.getTransferFromSsp>>
      >
      try {
        priorTransfer = await wallet.getTransferFromSsp(
          renewing
            ? deriveCheckoutSparkSettledRenewalTransferId(plan, input.legId)
            : deriveCheckoutSparkSettledTransferId(plan, input.legId)
        )
      } catch {
        assertEligible()
        preparation = { status: "history_wait" }
        return
      }
      assertEligible()
      if (priorTransfer !== undefined) {
        preparation = { status: "history_wait" }
        return
      }
      const inspected = current.state
      const assertPreparedState = (
        state: CheckoutSparkSettledReconciliation
      ) => {
        assertState(state)
        assertCheckoutSparkSettledRecoveryProgression(inspected, state)
        if (
          state.legs.some(
            (leg, index) =>
              leg.legId !== input.legId &&
              JSON.stringify({
                ...leg,
                generation: getCheckoutSparkSettledLegGeneration(leg),
                closedGenerations: leg.closedGenerations ?? [],
              }) !==
                JSON.stringify({
                  ...inspected.legs[index],
                  generation: getCheckoutSparkSettledLegGeneration(
                    inspected.legs[index]!
                  ),
                  closedGenerations:
                    inspected.legs[index]!.closedGenerations ?? [],
                })
          )
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
      }
      let accepted = false
      const acknowledgePrepared = async (
        state: CheckoutSparkSettledReconciliation
      ) => {
        const saved = await load()
        assertPreparedState(saved.state)
        if (JSON.stringify(saved.state) !== JSON.stringify(state))
          throw new CheckoutSparkSettledRepositoryConflictError()
        accepted = await retainProgress(state)
      }
      const execution = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: input.legId,
          actor: "merchant",
          mode: "prepare",
          allowRenewal: renewing,
        },
        {
          store: workflowStore,
          assertCurrent: assertEligible,
          now,
          acknowledgeRecoverySnapshot: acknowledgePrepared,
          preparation: {
            repository,
            async resolveInvoice(request, context) {
              if (
                context.state.plan.merchantPublicZapPolicy &&
                context.recipient.kind === "merchant"
              )
                throw new Error(
                  "Historical public routed payments require exact-attempt recovery."
                )
              return dependencies.resolveInvoice
                ? dependencies.resolveInvoice(request, context)
                : resolveCheckoutSparkLnurlInvoice(request)
            },
            estimateFee: ({ paymentRequest }) =>
              wallet.estimateLightningFee!({ paymentRequest }),
            assertAuthority: assertPreparedState,
            nowMs: now,
            acknowledgeRecoverySnapshot: acknowledgePrepared,
            ...(renewing
              ? {
                  proveRenewalReturn: async (
                    state: CheckoutSparkSettledReconciliation,
                    legId: string
                  ) => {
                    assertPreparedState(state)
                    const proof =
                      await proveMerchantCheckoutSparkReturnedPayout(
                        state,
                        legId,
                        wallet,
                        assertEligible,
                        now
                      )
                    assertPreparedState(state)
                    return proof
                  },
                }
              : {}),
          },
        }
      )
      if (execution.status !== "payout_prepared") {
        preparation = { status: "prerequisite_unpaid" }
        return
      }
      assertEligible()
      preparation = {
        status: accepted ? "prepared" : "recovery_pending",
        recoveryDelivery: accepted ? "relay_accepted" : "pending",
      }
    } finally {
      await wallet.cleanup()
    }
  }
  assertActive()
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      assertActive()
      const result = await consumeRecovery(principal, selected, {
        async consume(initial, assertCurrent) {
          if (initial.schemaVersion !== 2)
            throw new Error("This recovery is not a settled checkout.")
          await prepare(initial, initial.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await prepare(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          await prepare(initial, progress.state, assertCurrent)
        },
      })
      assertActive()
      return {
        ...result,
        preparation: result.status === "consumed" ? preparation : null,
      }
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}

export type MerchantCheckoutSparkNextPreparationResult =
  | {
      status: "save_required" | "retired" | "handoff_wait" | "no_unpaid_leg"
    }
  | {
      status: "attempted"
      recovery: MerchantCheckoutSparkPreparationResult
    }

/**
 * Choose the first unfinished obligation from this device's exact saved plan.
 * Local state only selects the leg; the existing adapter rechecks private
 * recovery, the order witness and provider evidence before invoice preparation.
 * Existing intents are retained unless this current session explicitly permits
 * the separately proven, full-return generation-one renewal path.
 */
export async function prepareNextMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  input: {
    shouldContinue: () => boolean
    stopAndDrain?: () => Promise<void>
    allowRenewal?: boolean
  },
  dependencies: MerchantCheckoutSparkPreparationDependencies = {}
): Promise<MerchantCheckoutSparkNextPreparationResult> {
  const principal = principalPubkey.trim().toLowerCase()
  selected = {
    ...selected,
    ...(selected.merchantProgress
      ? { merchantProgress: { ...selected.merchantProgress } }
      : {}),
  }
  const shouldContinue = input.shouldContinue
  const stopAndDrain = input.stopAndDrain
  const allowRenewal = input.allowRenewal === true
  const assertActive = () => {
    if (shouldContinue() !== true) {
      throw new Error("Checkout Spark Merchant preparation session changed.")
    }
  }
  const now = dependencies.now ?? Date.now
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  assertActive()
  await stopAndDrain?.()
  assertActive()
  if (now() < selected.takeoverAt) return { status: "handoff_wait" }
  const saved = await repository.load(selected.checkoutId, selected.planDigest)
  assertActive()
  if (saved.status === "retired") return { status: "retired" }
  if (saved.status !== "active") return { status: "save_required" }
  const { plan } = saved.state
  if (
    plan.merchantPubkey !== principal ||
    plan.checkoutId !== selected.checkoutId ||
    plan.orderId !== selected.orderId ||
    plan.planDigest !== selected.planDigest ||
    plan.takeoverAt !== selected.takeoverAt
  ) {
    throw new CheckoutSparkSettledRepositoryConflictError()
  }
  if (now() < plan.takeoverAt) return { status: "handoff_wait" }
  const next = saved.state.legs.find((leg) => leg.status !== "paid")
  if (!next) return { status: "no_unpaid_leg" }
  const recovery = await prepareMerchantCheckoutSparkSettledPayout(
    principal,
    selected,
    { legId: next.legId, shouldContinue, allowRenewal },
    { ...dependencies, repository }
  )
  assertActive()
  return { status: "attempted", recovery }
}
