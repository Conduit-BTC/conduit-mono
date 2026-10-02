import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieMerchantCheckoutSparkProgressRepository,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledMerchantPreparationWindow,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkMerchantProgress,
  deriveCheckoutSparkSettledTransferId,
  getAccountSigner,
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  prepareCheckoutSparkSettledOutgoingLegShared,
  proveSparkCheckoutReceiveCredit,
  publishMerchantCheckoutSparkProgress,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkMerchantOrderWitness,
  restoreCheckoutSparkSettledReconciliation,
  retryMerchantCheckoutSparkProgress,
  runWithCheckoutSparkMerchantRecoveryLock,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkSettledLegPreparationDependencies,
  type CheckoutSparkSettledOutgoingTarget,
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
} from "./checkout-spark-settled-recovery"

type Store = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "save"
  | "savePreparedWithInvoiceOrigin"
  | "loadMerchantOrderWitness"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
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
  input: { legId: string; shouldContinue: () => boolean },
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
  input = { legId: input.legId, shouldContinue: input.shouldContinue }
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
    if (target.intent) {
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
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const actualIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (actualIdentity !== identity)
        throw new Error("Checkout Spark wallet identity changed.")
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
      current = await load()
      const credited = recordCheckoutSparkSettledCredit(current.state, {
        requestId: proof.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: proof.transferId,
        receiverIdentityPublicKey: proof.receiverIdentityPublicKey,
        grossSats: proof.grossSats,
        creditedSats: proof.creditedSats,
        observedAt: now(),
      })
      if (!current.state.credit) {
        current = requireActive(
          await repository.save(credited, current.revision, assertEligible)
        )
        assertState(current.state)
      }
      await repository.recordMerchantCredit(plan, proof, now(), assertEligible)
      assertEligible()

      // Re-attest every frozen sibling; buyer-signed paid progress is not proof.
      for (const leg of current.state.legs) {
        if (!leg.intent) continue
        const recipient = plan.recipients.find(
          (item) => item.legId === leg.legId
        )!
        const outgoing: CheckoutSparkSettledOutgoingTarget = {
          walletId: plan.walletId,
          network: plan.network,
          legId: leg.legId,
          recipientId: recipient.recipientId,
          allocationSats: leg.allocationSats!,
          unpaidAllocationSats: leg.allocationSats!,
          intent: leg.intent,
        }
        const observed = await inspectExactMerchantPayout(
          plan,
          outgoing,
          wallet,
          assertEligible
        )
        assertEligible()
        if (observed.status === "not_found" && leg.status === "prepared")
          continue
        if (observed.status !== "paid") {
          preparation = { status: "history_wait" }
          return
        }
        if (
          leg.status === "paid" &&
          (leg.finalFeeSats !== observed.finalFeeSats ||
            leg.finalDebitSats !== observed.finalDebitSats)
        ) {
          preparation = { status: "history_wait" }
          return
        }
        if (leg.status !== "paid") {
          current = requireActive(
            await repository.save(
              recordCheckoutSparkSettledLegStatus(current.state, {
                legId: leg.legId,
                transferId: leg.intent.transferId,
                paymentHash: leg.intent.paymentHash,
                status: "paid",
                finalFeeSats: observed.finalFeeSats,
                finalDebitSats: observed.finalDebitSats,
                observedAt: Math.max(now(), current.state.updatedAt + 1),
              }),
              current.revision,
              assertEligible
            )
          )
          assertState(current.state)
        }
        await repository.recordMerchantPayout(
          plan,
          outgoing,
          observed,
          now(),
          assertEligible
        )
        assertEligible()
      }
      const selectedLeg = current.state.legs.find(
        (leg) => leg.legId === input.legId
      )!
      if (selectedLeg.intent) {
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
          deriveCheckoutSparkSettledTransferId(plan, input.legId)
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
              JSON.stringify(leg) !== JSON.stringify(inspected.legs[index])
          )
        ) {
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
      }
      let accepted = false
      await prepareCheckoutSparkSettledOutgoingLegShared(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: input.legId,
          shouldContinue: input.shouldContinue,
        },
        {
          repository,
          resolveInvoice: dependencies.resolveInvoice,
          estimateFee: ({ paymentRequest }) =>
            wallet.estimateLightningFee!({ paymentRequest }),
          assertAuthority: assertPreparedState,
          nowMs: now,
          async acknowledgeRecoverySnapshot(state) {
            const saved = await load()
            assertPreparedState(saved.state)
            if (JSON.stringify(saved.state) !== JSON.stringify(state)) {
              throw new CheckoutSparkSettledRepositoryConflictError()
            }
            accepted = await retainProgress(state)
          },
        }
      )
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
 * An existing intent is retained unchanged, never skipped or replaced.
 */
export async function prepareNextMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  input: {
    shouldContinue: () => boolean
    stopAndDrain?: () => Promise<void>
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
    { legId: next.legId, shouldContinue },
    { ...dependencies, repository }
  )
  assertActive()
  return { status: "attempted", recovery }
}
