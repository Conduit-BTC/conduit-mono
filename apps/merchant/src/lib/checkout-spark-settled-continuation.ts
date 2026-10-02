import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledNativeOutgoingProvider,
  getAccountSigner,
  hasCheckoutSparkProviderSendWindow,
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  proveSparkCheckoutReceiveCredit,
  publishMerchantCheckoutSparkProgress,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkMerchantOrderWitness,
  restoreCheckoutSparkSettledReconciliation,
  retryMerchantCheckoutSparkProgress,
  runCheckoutSparkSettledOutgoingStep,
  runWithCheckoutSparkMerchantRecoveryLock,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
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
  | "loadMerchantOrderWitness"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
  | "assertLocalInvoiceOrigin"
> &
  Partial<Pick<DexieCheckoutSparkSettledRepository, "assertInvoiceRecipient">>
type Leg = CheckoutSparkSettledReconciliation["legs"][number]

/** Private display data, never diagnostics; no recovery material is included. */
export interface MerchantCheckoutSparkPayoutReview {
  checkoutId: string
  planDigest: string
  legId: string
  recipientId: string
  destination: string
  allocationSats: number
  intent: NonNullable<Leg["intent"]>
}

function payoutReview(
  state: CheckoutSparkSettledReconciliation,
  legId: string
): MerchantCheckoutSparkPayoutReview | null {
  const leg = state.legs.find((candidate) => candidate.legId === legId)
  const recipient = state.plan.recipients.find(
    (candidate) => candidate.legId === legId
  )
  if (!leg?.intent || leg.allocationSats === null || !recipient) return null
  return {
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    legId,
    recipientId: recipient.recipientId,
    destination: recipient.destination.value,
    allocationSats: leg.allocationSats,
    intent: leg.intent,
  }
}

/** Local preview only. Fresh signed authority and provider proof are checked on confirm. */
export async function reviewMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  repository: Pick<Store, "load"> = new DexieCheckoutSparkSettledRepository()
): Promise<MerchantCheckoutSparkPayoutReview | null> {
  const current = await repository.load(
    selected.checkoutId,
    selected.planDigest
  )
  if (
    current.status !== "active" ||
    current.state.plan.merchantPubkey !== principalPubkey.trim().toLowerCase()
  ) {
    throw new Error(
      "Save this checkout recovery state before reviewing a payout."
    )
  }
  const next = current.state.legs.find((leg) => leg.status !== "paid")
  return next ? payoutReview(current.state, next.legId) : null
}

export type MerchantCheckoutSparkSignedNextPayoutSelection =
  | { status: "ready"; review: MerchantCheckoutSparkPayoutReview }
  | {
      status:
        | "preparation_needed"
        | "handoff_wait"
        | "save_required"
        | "retired"
        | "no_unpaid_leg"
        | "recovery_unavailable"
    }

export interface MerchantCheckoutSparkSignedNextPayoutDependencies {
  repository?: Pick<Store, "load" | "loadMerchantOrderWitness">
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  now?: () => number
}

/**
 * Select only an exact next intent restored from Merchant-authored progress.
 * This read-only selection is not provider proof or send authorization. Even
 * `no_unpaid_leg` describes saved state only, never settlement or retirement.
 * Wallet material stays inside the existing private recovery callback.
 */
export async function selectMerchantCheckoutSparkSignedNextPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: MerchantCheckoutSparkSignedNextPayoutDependencies = {}
): Promise<MerchantCheckoutSparkSignedNextPayoutSelection> {
  const principal = principalPubkey.trim().toLowerCase()
  selected = {
    ...selected,
    ...(selected.merchantProgress
      ? { merchantProgress: { ...selected.merchantProgress } }
      : {}),
  }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const assertPlan = (state: CheckoutSparkSettledReconciliation) => {
    const { plan } = state
    if (
      plan.merchantPubkey !== principal ||
      plan.checkoutId !== selected.checkoutId ||
      plan.orderId !== selected.orderId ||
      plan.planDigest !== selected.planDigest ||
      plan.takeoverAt !== selected.takeoverAt
    ) {
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
  }
  assertActive()
  if (
    !/^[0-9a-f]{64}$/.test(principal) ||
    !Number.isSafeInteger(selected.takeoverAt) ||
    selected.takeoverAt < 0
  ) {
    throw new Error("Checkout Spark Merchant selection is invalid.")
  }
  if (selected.schemaVersion === 1) return { status: "recovery_unavailable" }
  if (now() < selected.takeoverAt) return { status: "handoff_wait" }
  const saved = await repository.load(selected.checkoutId, selected.planDigest)
  assertActive()
  if (saved.status === "retired") return { status: "retired" }
  if (saved.status !== "active") return { status: "save_required" }
  assertPlan(restoreCheckoutSparkSettledReconciliation(saved.state))
  let selection: MerchantCheckoutSparkSignedNextPayoutSelection = {
    status: "recovery_unavailable",
  }
  const inspect = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedState: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void,
    merchantAuthored: boolean
  ) => {
    const assertEligible = () => {
      assertActive()
      assertCurrent()
      if (now() < selected.takeoverAt) {
        throw new Error("Merchant checkout takeover is not yet available.")
      }
    }
    assertEligible()
    const signed = restoreCheckoutSparkSettledReconciliation(signedState)
    assertPlan(signed)
    assertPlan(restoreCheckoutSparkSettledReconciliation(initial.state))
    if (
      initial.merchantPubkey !== principal ||
      initial.plan.planDigest !== signed.plan.planDigest ||
      initial.wallet.walletId !== signed.plan.walletId ||
      initial.wallet.network !== signed.plan.network
    ) {
      throw new Error("Checkout Spark Merchant recovery binding is invalid.")
    }
    const witness = await repository.loadMerchantOrderWitness(
      principal,
      selected.checkoutId,
      selected.planDigest
    )
    assertEligible()
    if (
      !witness ||
      restoreCheckoutSparkMerchantOrderWitness(witness, signed.plan)
        .buyerPubkey !== initial.senderPubkey
    ) {
      throw new Error("Checkout Spark Merchant selection requires its order.")
    }
    const latest = await repository.load(
      selected.checkoutId,
      selected.planDigest
    )
    assertEligible()
    if (latest.status !== "active") {
      throw new CheckoutSparkSettledRepositoryConflictError()
    }
    const state = restoreCheckoutSparkSettledReconciliation(latest.state)
    assertPlan(state)
    assertCheckoutSparkSettledRecoveryProgression(signed, state)
    const next = state.legs.find((leg) => leg.status !== "paid")
    if (!next) {
      selection = { status: "no_unpaid_leg" }
      return
    }
    const review = payoutReview(state, next.legId)
    const signedReview = payoutReview(signed, next.legId)
    if (
      !merchantAuthored ||
      !selected.merchantProgress ||
      !review ||
      !signedReview ||
      JSON.stringify(review) !== JSON.stringify(signedReview)
    ) {
      selection = { status: "preparation_needed" }
      return
    }
    selection = {
      status: "ready",
      review: { ...review, intent: { ...review.intent } },
    }
  }
  const recovery = await consumeRecovery(principal, selected, {
    async consume(initial, assertCurrent) {
      if (initial.schemaVersion !== 2) return
      await inspect(initial, initial.state, assertCurrent, false)
    },
    async consumeSettled(initial, latest, assertCurrent) {
      await inspect(initial, latest.state, assertCurrent, false)
    },
    async consumeMerchantProgress(
      initial,
      _latestBuyer,
      progress,
      assertCurrent
    ) {
      if (
        progress.merchantPubkey !== principal ||
        progress.initialHandoffId !== initial.handoffId ||
        progress.snapshotId !== selected.merchantProgress?.snapshotId ||
        progress.recordedAt !== selected.merchantProgress.recordedAt
      ) {
        throw new Error("Checkout Spark Merchant progress selection changed.")
      }
      await inspect(initial, progress.state, assertCurrent, true)
    },
  })
  assertActive()
  return recovery.status === "consumed"
    ? selection
    : { status: "recovery_unavailable" }
}

export interface MerchantCheckoutSparkContinuationDependencies {
  repository?: Store
  deriveIdentity?: typeof deriveMerchantCheckoutSparkRecoveryIdentity
  openWallet?: typeof openMerchantCheckoutSparkRecoveryWallet
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  now?: () => number
  shouldContinue?: () => boolean
  lockManager?: CheckoutSparkMerchantRecoveryLockManager | null
  requireCrossTabLock?: boolean
  signer?: NostrKeySigner | null
  progressStore?: MerchantCheckoutSparkProgressDeliveryStore &
    Pick<DexieMerchantCheckoutSparkProgressRepository, "list">
  progressTransport?: MerchantCheckoutSparkProgressTransport
}

export interface MerchantCheckoutSparkContinuationResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  payout: Pick<
    CheckoutSparkSettledOutgoingStepResult,
    "outcome" | "reason" | "sendAttempted"
  > | null
}

/**
 * Continue exactly one reviewed, privately restored frozen intent after takeover.
 * There is no new invoice, intent, Merchant app ACK, or distributed lease.
 * The same payment ID and parameters also survive another Merchant device.
 */
export async function continueMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  review: MerchantCheckoutSparkPayoutReview,
  dependencies: MerchantCheckoutSparkContinuationDependencies = {}
): Promise<MerchantCheckoutSparkContinuationResult> {
  const principal = principalPubkey.trim().toLowerCase()
  selected = {
    ...selected,
    ...(selected.merchantProgress
      ? { merchantProgress: { ...selected.merchantProgress } }
      : {}),
  }
  review = { ...review, intent: { ...review.intent } }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const progressStore =
    dependencies.progressStore ??
    new DexieMerchantCheckoutSparkProgressRepository()
  let payout: MerchantCheckoutSparkContinuationResult["payout"] = null

  const consume = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedState: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void,
    retainMerchantProgress = false
  ) => {
    const { plan } = initial
    const assertEligible = () => {
      assertCurrent()
      if (
        dependencies.shouldContinue?.() === false ||
        now() < plan.takeoverAt
      ) {
        throw new Error(
          "Merchant checkout continuation is not currently authorized."
        )
      }
    }
    assertEligible()
    if (
      principal !== initial.merchantPubkey ||
      principal !== plan.merchantPubkey ||
      selected.checkoutId !== plan.checkoutId ||
      selected.orderId !== plan.orderId ||
      selected.planDigest !== plan.planDigest ||
      signedState.plan.planDigest !== plan.planDigest ||
      initial.wallet.walletId !== plan.walletId ||
      initial.wallet.network !== plan.network ||
      review.checkoutId !== plan.checkoutId ||
      review.planDigest !== plan.planDigest
    ) {
      throw new Error("Checkout Spark merchant recovery binding is invalid.")
    }
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
        "Checkout Spark Merchant continuation requires its authenticated order."
      )
    }
    // Local-only preparation must not invent an intent another device cannot restore.
    const signedReview = payoutReview(signedState, review.legId)
    if (
      !signedReview ||
      JSON.stringify(signedReview) !== JSON.stringify(review)
    ) {
      throw new Error("Review the exact signed payout before continuing.")
    }
    // Expiry does not erase recovery or prevent the separate history check.
    // This confirmation must not open a wallet that can claim inbound funds
    // when its saved payout already has too little time left to send.
    const pauseIfInvoiceStale = () => {
      if (
        hasCheckoutSparkProviderSendWindow({
          paymentRequest: review.intent.paymentRequest,
          nowMs: now(),
        })
      ) {
        return false
      }
      payout = {
        outcome: "wait",
        reason: "invoice_window_insufficient",
        sendAttempted: false,
      }
      return true
    }
    let expectedState: CheckoutSparkSettledReconciliation
    const load = async () => {
      assertEligible()
      const current = await repository.load(plan.checkoutId, plan.planDigest)
      assertEligible()
      if (
        current.status !== "active" ||
        current.state.plan.merchantPubkey !== principal ||
        current.state.plan.walletId !== plan.walletId ||
        current.state.plan.network !== plan.network
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      assertCheckoutSparkSettledRecoveryProgression(signedState, current.state)
      if (
        JSON.stringify(payoutReview(current.state, review.legId)) !==
        JSON.stringify(review)
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      return current
    }
    const imported = await load()
    expectedState = imported.state
    const assertDurableState = async () => {
      const current = await load()
      if (JSON.stringify(current.state) !== JSON.stringify(expectedState)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
    }
    const shouldPublish = () => {
      assertEligible()
      return true
    }
    let progressSigner: NostrKeySigner | null = null
    if (retainMerchantProgress) {
      progressSigner =
        dependencies.signer === undefined
          ? (getAccountSigner() ?? null)
          : dependencies.signer
      if (!progressSigner) throw new Error("Merchant signer is not connected.")
      const signerPubkey = await progressSigner.getPublicKey()
      assertEligible()
      if (signerPubkey.toLowerCase() !== principal) {
        throw new Error("Checkout Spark Merchant continuation signer changed.")
      }
      // Retrying delivery preserves the original signed bytes even when local
      // progress has advanced. It is not a lease or evidence of payment.
      const entries = await progressStore.list(
        principal,
        plan.checkoutId,
        plan.planDigest
      )
      await assertDurableState()
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
        ) {
          throw new Error("Checkout Spark Merchant recovery binding changed.")
        }
        if (entry.relayAccepted) continue
        const delivery = await retryMerchantCheckoutSparkProgress({
          record,
          signer: progressSigner,
          store: progressStore,
          shouldContinue: shouldPublish,
          transport: dependencies.progressTransport,
        })
        await assertDurableState()
        if (!delivery.relayAccepted) {
          payout = {
            outcome: "wait",
            reason: "recovery_handoff_unavailable",
            sendAttempted: false,
          }
          return
        }
      }
    }
    let attemptedProgressState: string | null = null
    const retainProgress = async (
      state: CheckoutSparkSettledReconciliation
    ) => {
      const serialized = JSON.stringify(state)
      if (serialized !== JSON.stringify(expectedState)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      await assertDurableState()
      if (!progressSigner) return
      attemptedProgressState = serialized
      const delivery = await publishMerchantCheckoutSparkProgress({
        payload: createCheckoutSparkMerchantProgress({
          initialHandoffId: initial.handoffId,
          state,
        }),
        signer: progressSigner,
        store: progressStore,
        shouldContinue: shouldPublish,
        transport: dependencies.progressTransport,
      })
      await assertDurableState()
      if (!delivery.relayAccepted) {
        throw new Error("Checkout Spark Merchant progress needs delivery.")
      }
    }
    const retainVerifiedProgress = async () => {
      if (
        !progressSigner ||
        attemptedProgressState === JSON.stringify(expectedState)
      )
        return
      try {
        await retainProgress(expectedState)
      } catch {
        // Provider-attested paid state stays paid when its private progress
        // delivery fails. No automatic resend or replacement intent follows.
        assertEligible()
      }
    }
    // Delivery repair remains available after invoice expiry. Only provider
    // initialization and an outgoing attempt require a usable send window.
    if (pauseIfInvoiceStale()) return
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
    await assertDurableState()
    if (pauseIfInvoiceStale()) return
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
      outgoing: true,
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const actualIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (actualIdentity !== identity || !wallet.outgoing) {
        throw new Error("Checkout Spark continuation wallet is unavailable.")
      }
      // A signed buyer claim is not settlement. Re-attest the exact receive each run.
      const receive = await wallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertEligible()
      if (
        !receive ||
        receive.status !== "TRANSFER_COMPLETED" ||
        !receive.transfer?.sparkId
      ) {
        payout = { outcome: "funding_wait", sendAttempted: false }
        return
      }
      const transfer = await wallet.getTransfer(receive.transfer.sparkId)
      assertEligible()
      if (!transfer) {
        payout = { outcome: "funding_wait", sendAttempted: false }
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
      recordCheckoutSparkSettledCredit(expectedState, {
        requestId: proof.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: proof.transferId,
        receiverIdentityPublicKey: proof.receiverIdentityPublicKey,
        grossSats: proof.grossSats,
        creditedSats: proof.creditedSats,
        observedAt: now(),
      })
      await repository.recordMerchantCredit(plan, proof, now(), assertEligible)
      assertEligible()
      const store = {
        async load() {
          const current = await load()
          if (JSON.stringify(current.state) !== JSON.stringify(expectedState)) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
          return current
        },
        async save(next: CheckoutSparkSettledReconciliation, revision: number) {
          assertEligible()
          const saved = await repository.save(next, revision, assertEligible)
          assertEligible()
          expectedState = next
          return saved
        },
      }
      // Reconcile every frozen sibling first. In particular, a buyer's `paid`
      // claim cannot release another allocation or unlock the Conduit leg.
      for (const leg of expectedState.legs) {
        if (!leg.intent) continue
        const recipient = plan.recipients.find(
          (item) => item.legId === leg.legId
        )!
        const target: CheckoutSparkSettledOutgoingTarget = {
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
          target,
          wallet,
          assertEligible
        )
        assertEligible()
        if (observed.status === "paid") {
          if (leg.status === "paid") {
            if (
              leg.finalFeeSats !== observed.finalFeeSats ||
              leg.finalDebitSats !== observed.finalDebitSats
            ) {
              payout = {
                outcome: "wait",
                reason: "provider_evidence_conflicting",
                sendAttempted: false,
              }
              return
            }
          } else {
            const current = await store.load()
            await store.save(
              recordCheckoutSparkSettledLegStatus(current.state, {
                legId: leg.legId,
                transferId: leg.intent.transferId,
                paymentHash: leg.intent.paymentHash,
                status: "paid",
                finalFeeSats: observed.finalFeeSats,
                finalDebitSats: observed.finalDebitSats,
                observedAt: Math.max(now(), current.state.updatedAt + 1),
              }),
              current.revision
            )
          }
          await repository.recordMerchantPayout(
            plan,
            target,
            observed,
            now(),
            assertEligible
          )
          assertEligible()
          await retainVerifiedProgress()
        } else if (
          observed.status !== "not_found" ||
          leg.status !== "prepared"
        ) {
          payout = {
            outcome: "wait",
            reason:
              observed.status === "conflicting_evidence"
                ? "provider_evidence_conflicting"
                : observed.status === "lookup_unavailable"
                  ? "provider_evidence_unavailable"
                  : "prior_possible_send",
            sendAttempted: false,
          }
          return
        }
      }
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet.outgoing,
        async reconcile(target) {
          const observed = await inspectExactMerchantPayout(
            plan,
            target,
            wallet,
            assertEligible
          )
          assertEligible()
          if (observed.status === "paid") {
            await repository.recordMerchantPayout(
              plan,
              target,
              observed,
              now(),
              assertEligible
            )
            assertEligible()
          }
          return observed
        },
        async assertBeforeSend() {
          await assertDurableState()
          // A signed recovery preserves an intent, not its recipient. Require
          // local issuance or an independent exact receiving-provider proof.
          // Exact history remains readable above without this attribution.
          await (
            repository.assertInvoiceRecipient ??
            repository.assertLocalInvoiceOrigin
          ).call(
            repository,
            plan,
            {
              walletId: plan.walletId,
              network: plan.network,
              legId: review.legId,
              recipientId: review.recipientId,
              allocationSats: review.allocationSats,
              unpaidAllocationSats: review.allocationSats,
              intent: review.intent,
            },
            assertEligible
          )
          await assertDurableState()
        },
        now,
      })
      const step = await runCheckoutSparkSettledOutgoingStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId: review.legId,
        actor: "merchant",
        now,
        store,
        provider,
        // The original buyer snapshot remains available. Merchant-authored
        // progress additionally uses the existing exact private self-outbox.
        // Neither relay acceptance nor the local write-ahead is a payment proof.
        acknowledgeRecoverySnapshot: retainProgress,
      })
      assertEligible()
      if (step.outcome === "paid" || step.outcome === "already_paid") {
        await retainVerifiedProgress()
      }
      payout = {
        outcome: step.outcome,
        reason: step.reason,
        sendAttempted: step.sendAttempted,
      }
    } finally {
      await wallet.cleanup()
    }
  }
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      const result = await consumeRecovery(principal, selected, {
        async consume(initial, assertCurrent) {
          if (initial.schemaVersion !== 2)
            throw new Error("This recovery is not a settled checkout.")
          await consume(initial, initial.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await consume(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          await consume(initial, progress.state, assertCurrent, true)
        },
      })
      return { ...result, payout: result.status === "consumed" ? payout : null }
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}
