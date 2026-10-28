import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  checkoutSparkProviderSendWindowEndsAt,
  getCheckoutSparkSettledLegGeneration,
  isCheckoutSparkNativeTreasuryPlan,
  restoreCheckoutSparkMerchantOrderWitness,
  restoreCheckoutSparkSettledReconciliation,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  checkoutSparkRecoveryTiming,
  checkoutSparkRecoveryTimingMatches,
  restoreCheckoutSparkRecoveryTiming,
} from "@conduit/core/protocol/checkout-spark-recovery-timing"

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
  generation?: 0 | 1
  /** Saved-state inspection only; not live settlement or send authority. */
  inspection?: {
    recipientAttribution:
      "local_origin" | "recipient_verified" | "missing" | "unavailable"
    savedStatus: Leg["status"]
    allocationBudget: "fits" | "exceeds" | "unavailable"
  }
}

export function payoutReview(
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
    ...(getCheckoutSparkSettledLegGeneration(leg) === 1
      ? { generation: 1 as const }
      : {}),
  }
}

export type MerchantCheckoutSparkSignedNextPayoutSelection =
  | { status: "ready"; review: MerchantCheckoutSparkPayoutReview }
  | { status: "native_treasury" }
  | {
      status:
        | "preparation_needed"
        | "renewal_needed"
        | "handoff_wait"
        | "save_required"
        | "retired"
        | "no_unpaid_leg"
        | "recovery_unavailable"
    }

export interface MerchantCheckoutSparkSignedNextPayoutDependencies {
  repository?: SelectionStore
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  now?: () => number
}

type SelectionStore = Pick<
  DexieCheckoutSparkSettledRepository,
  "load" | "loadMerchantOrderWitness"
>
type SelectionScope = {
  principal: string
  selected: MerchantCheckoutSparkRecoveryCandidate
  repository: SelectionStore
  now: () => number
  assertActive: () => void
}
type RecoveryProgress = Parameters<
  NonNullable<
    Parameters<
      typeof withMerchantCheckoutSparkRecovery
    >[2]["consumeMerchantProgress"]
  >
>[2]
type SelectionInitial = Pick<
  CheckoutSparkSettledRecoveryPayload,
  "merchantPubkey" | "senderPubkey" | "handoffId" | "plan" | "state"
> & {
  wallet: Pick<
    CheckoutSparkSettledRecoveryPayload["wallet"],
    "walletId" | "network"
  >
}

function assertSelectionPlan(
  { principal, selected }: SelectionScope,
  state: CheckoutSparkSettledReconciliation,
  initial = false
) {
  const { plan } = state
  if (
    plan.merchantPubkey !== principal ||
    plan.checkoutId !== selected.checkoutId ||
    plan.orderId !== selected.orderId ||
    plan.planDigest !== selected.planDigest ||
    (initial && plan.schemaVersion === 6
      ? state.buyerActivation !== null ||
        selected.executionTiming !== "pay_activation_v1"
      : !checkoutSparkRecoveryTimingMatches(
          selected,
          checkoutSparkRecoveryTiming(plan, state.buyerActivation)
        ))
  ) {
    throw new CheckoutSparkSettledRepositoryConflictError()
  }
}

async function inspectSelectionState(
  scope: SelectionScope
): Promise<MerchantCheckoutSparkSignedNextPayoutSelection | null> {
  const { principal, selected, repository, now, assertActive } = scope
  assertActive()
  const timing = restoreCheckoutSparkRecoveryTiming(selected)
  if (
    !/^[0-9a-f]{64}$/.test(principal) ||
    (timing.takeoverAt !== null && !Number.isSafeInteger(timing.takeoverAt))
  ) {
    throw new Error("Checkout Spark Merchant selection is invalid.")
  }
  if (selected.schemaVersion === 1) return { status: "recovery_unavailable" }
  if (timing.takeoverAt === null || now() < timing.takeoverAt)
    return { status: "handoff_wait" }
  const saved = await repository.load(selected.checkoutId, selected.planDigest)
  assertActive()
  if (saved.status === "retired") return { status: "retired" }
  if (saved.status !== "active") return { status: "save_required" }
  assertSelectionPlan(
    scope,
    restoreCheckoutSparkSettledReconciliation(saved.state)
  )
  return null
}

/**
 * Read-only selection inside one authenticated recovery callback. No credential,
 * callback or send capability leaves this function; dispatch authenticates again.
 */
export async function selectMerchantCheckoutSparkPayoutFromRecovery(
  input: SelectionScope & {
    initial: SelectionInitial
    signedState: CheckoutSparkSettledReconciliation
    assertCurrent: () => void
    progress?: RecoveryProgress
  }
): Promise<MerchantCheckoutSparkSignedNextPayoutSelection> {
  const {
    principal,
    selected,
    repository,
    now,
    assertActive,
    initial,
    signedState,
    assertCurrent,
    progress,
  } = input
  assertCurrent()
  const preflight = await inspectSelectionState(input)
  assertCurrent()
  if (preflight) return preflight
  const assertPlan = (state: CheckoutSparkSettledReconciliation) =>
    assertSelectionPlan(input, state)
  let merchantAuthored = false
  if (progress?.type === "checkout_spark_organizer_execution") {
    if (
      progress.merchantPubkey !== principal ||
      progress.initialMerchantHandoffId !== initial.handoffId
    )
      throw new Error("Checkout Spark Organizer progress selection changed.")
    // Organizer progress never substitutes for the Merchant's own checkpoint.
  } else if (progress) {
    if (
      progress.merchantPubkey !== principal ||
      progress.initialHandoffId !== initial.handoffId ||
      progress.snapshotId !== selected.merchantProgress?.snapshotId ||
      progress.recordedAt !== selected.merchantProgress.recordedAt
    )
      throw new Error("Checkout Spark Merchant progress selection changed.")
    merchantAuthored = true
  }
  const assertEligible = () => {
    assertActive()
    assertCurrent()
    if (selected.takeoverAt === null || now() < selected.takeoverAt) {
      throw new Error("Merchant checkout takeover is not yet available.")
    }
  }
  assertEligible()
  const signed = restoreCheckoutSparkSettledReconciliation(signedState)
  assertPlan(signed)
  assertSelectionPlan(
    input,
    restoreCheckoutSparkSettledReconciliation(initial.state),
    true
  )
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
  const latest = await repository.load(selected.checkoutId, selected.planDigest)
  assertEligible()
  if (latest.status !== "active") {
    throw new CheckoutSparkSettledRepositoryConflictError()
  }
  const state = restoreCheckoutSparkSettledReconciliation(latest.state)
  assertPlan(state)
  assertCheckoutSparkSettledRecoveryProgression(signed, state)
  const next = state.legs.find((leg) => leg.status !== "paid")
  if (!next) {
    return { status: "no_unpaid_leg" }
  }
  if (
    isCheckoutSparkNativeTreasuryPlan(state.plan) &&
    state.plan.recipients.find((recipient) => recipient.legId === next.legId)
      ?.kind === "conduit"
  ) {
    return { status: "native_treasury" }
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
    return { status: "preparation_needed" }
  }
  const endsAt = checkoutSparkProviderSendWindowEndsAt(
    review.intent.paymentRequest
  )
  if (
    getCheckoutSparkSettledLegGeneration(next) === 0 &&
    endsAt !== null &&
    endsAt <= now()
  ) {
    // Selection is read-only. Only a separate current-session operation may
    // establish positive return proof and prepare an acknowledged successor.
    return { status: "renewal_needed" }
  }
  return {
    status: "ready",
    review: { ...review, intent: { ...review.intent } },
  }
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
  const preflight = await inspectSelectionState({
    principal,
    selected,
    repository,
    now,
    assertActive,
  })
  if (preflight) return preflight
  let selection: MerchantCheckoutSparkSignedNextPayoutSelection = {
    status: "recovery_unavailable",
  }
  const inspect = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedState: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void,
    progress?: RecoveryProgress
  ) => {
    selection = await selectMerchantCheckoutSparkPayoutFromRecovery({
      principal,
      selected,
      repository,
      now,
      assertActive,
      assertCurrent,
      initial: {
        merchantPubkey: initial.merchantPubkey,
        senderPubkey: initial.senderPubkey,
        handoffId: initial.handoffId,
        plan: initial.plan,
        state: initial.state,
        wallet: {
          walletId: initial.wallet.walletId,
          network: initial.wallet.network,
        },
      },
      signedState,
      progress,
    })
  }
  const recovery = await consumeRecovery(principal, selected, {
    async consume(initial, assertCurrent) {
      if (initial.schemaVersion !== 2) return
      await inspect(initial, initial.state, assertCurrent)
    },
    async consumeSettled(initial, latest, assertCurrent) {
      await inspect(initial, latest.state, assertCurrent)
    },
    async consumeMerchantProgress(
      initial,
      _latestBuyer,
      progress,
      assertCurrent
    ) {
      await inspect(initial, progress.state, assertCurrent, progress)
    },
  })
  assertActive()
  return recovery.status === "consumed"
    ? selection
    : { status: "recovery_unavailable" }
}
