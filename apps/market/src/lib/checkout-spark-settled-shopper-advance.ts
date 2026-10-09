import {
  DexieCheckoutSparkSettledRepository,
  getOrderLifecycle,
  runCheckoutSparkSettledOutgoingStep,
  runCheckoutSparkNativeTreasuryStep,
  runCheckoutSparkFinancialWorkflow,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkSettledReconciliation,
  type OrderLifecycle,
} from "@conduit/core"

import {
  createCheckoutSparkSettledFundingBridge,
  type CheckoutSparkSettledFundingPaymentInput,
  type CheckoutSparkSettledFundingResult,
} from "./checkout-spark-settled-funding"
import {
  prepareCheckoutSparkSettledOutgoingLeg,
  createBuyerCheckoutSparkLegPreparationPorts,
} from "./checkout-spark-settled-leg-preparation"
import { createCheckoutSparkSettledOutgoingProvider } from "./checkout-spark-settled-outgoing-provider"
import { verifyBuyerCheckoutSparkRecipientSettlement } from "./checkout-spark-invoice-recipient"
import { getCheckoutSparkRecoveryDelivery } from "./checkout-spark-recovery-handoff"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
} from "./checkout-spark-settled-preparation"
import { getSparkConfiguration, getSparkWalletManager } from "./spark-sdk"
import { assertMarketCheckoutSparkDispatchPlan } from "./checkout-spark-dispatch-policy"
import { canInspectCheckoutSparkSettledSubmittedAttempt } from "./checkout-spark-settled-order-control"
import {
  createBuyerCheckoutSparkNativeTreasuryProvider,
  proveBuyerCheckoutSparkTreasuryCommerce,
} from "./checkout-spark-native-treasury"
import {
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"

export interface AdvanceCheckoutSparkSettledShopperInput {
  checkoutId: string
  planDigest: string
  orderId: string
  merchantPubkey: string
  network: "mainnet" | "regtest"
  buyerPubkey: string
  currentBuyerPubkey: () => string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  currentGuestIdentity?: () => GuestOrderSigningIdentity | null
  shouldContinue: () => boolean
  /** Null for a funding step; one exact plan leg otherwise. */
  legId: string | null
  /** Inspect a frozen payout without preparing, preflighting, or sending it. */
  inspectionOnly?: boolean
  fundingPayment: CheckoutSparkSettledFundingPaymentInput
  /** Must resolve only after the exact state update is relay-ACKed to Merchant. */
  acknowledgeRecoverySnapshot: (
    state: CheckoutSparkSettledReconciliation
  ) => Promise<void>
}

export type AdvanceCheckoutSparkSettledShopperResult =
  | { status: "funding"; funding: CheckoutSparkSettledFundingResult }
  | { status: "payout_prepared"; state: CheckoutSparkSettledReconciliation }
  | { status: "outgoing_step"; step: CheckoutSparkSettledOutgoingStepResult }

export interface AdvanceCheckoutSparkSettledShopperDependencies {
  readOrder?: (orderId: string) => Promise<OrderLifecycle | undefined>
  readPreparation?: typeof getCheckoutSparkSettledPreparation
  readInitialRecovery?: typeof getCheckoutSparkRecoveryDelivery
  loadAuthorized?: typeof loadAuthorizedCheckoutSparkSettledFunding
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    | "create"
    | "load"
    | "save"
    | "savePreparedWithInvoiceOrigin"
    | "assertLocalInvoiceOrigin"
    | "recordMerchantPayout"
    | "recordMerchantCredit"
    | "loadMerchantSettlement"
    | "saveTreasuryPrepared"
    | "recordMerchantTreasury"
  > &
    Partial<
      Pick<
        DexieCheckoutSparkSettledRepository,
        | "recordInvoiceRecipientVerification"
        | "hasInvoiceRecipientSettlement"
        | "nativeTreasuryAdmissionScope"
        | "saveTreasuryPreProviderRetry"
        | "outgoingAdmissionScope"
        | "saveOutgoingPreProviderRetry"
      >
    >
  sparkConfiguration?: typeof getSparkConfiguration
  sparkManager?: typeof getSparkWalletManager
  fundingBridge?: typeof createCheckoutSparkSettledFundingBridge
  prepareLeg?: typeof prepareCheckoutSparkSettledOutgoingLeg
  outgoingStep?: typeof runCheckoutSparkSettledOutgoingStep
  outgoingProvider?: typeof createCheckoutSparkSettledOutgoingProvider
  treasuryStep?: typeof runCheckoutSparkNativeTreasuryStep
  now?: () => number
}

/** One guarded step. The authorized foreground runner composes these serially. */
export async function advanceCheckoutSparkSettledShopper(
  input: AdvanceCheckoutSparkSettledShopperInput,
  dependencies: AdvanceCheckoutSparkSettledShopperDependencies = {}
): Promise<AdvanceCheckoutSparkSettledShopperResult> {
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const readPreparation =
    dependencies.readPreparation ?? getCheckoutSparkSettledPreparation
  const readInitialRecovery =
    dependencies.readInitialRecovery ?? getCheckoutSparkRecoveryDelivery
  const now = dependencies.now ?? Date.now
  const guestIdentity = input.guestIdentity ? { ...input.guestIdentity } : null
  const guestScope = {
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    pubkey: input.buyerPubkey,
  }
  const currentGuestIdentity = input.currentGuestIdentity
  function currentSessionMatches(): boolean {
    if (!input.shouldContinue()) return false
    if (!guestIdentity) return input.currentBuyerPubkey() === input.buyerPubkey
    const current = currentGuestIdentity?.() ?? null
    const time = now()
    return (
      isCurrentGuestOrderSigningIdentity(guestIdentity, guestScope, time) &&
      isCurrentGuestOrderSigningIdentity(current, guestScope, time) &&
      current?.createdAt === guestIdentity.createdAt &&
      current.expiresAt === guestIdentity.expiresAt
    )
  }
  function assertSession(): void {
    if (!currentSessionMatches()) {
      throw new Error("Checkout Spark shopper session changed.")
    }
  }
  assertSession()
  const availableManager = (
    dependencies.sparkManager ?? getSparkWalletManager
  )()
  if (
    !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
    !/^[0-9a-f]{64}$/.test(input.merchantPubkey) ||
    !input.shouldContinue() ||
    !availableManager
  ) {
    throw new Error("Checkout Spark shopper identity or wallet is unavailable.")
  }
  const manager = availableManager
  const prepared = await (
    dependencies.loadAuthorized ?? loadAuthorizedCheckoutSparkSettledFunding
  )(input.checkoutId, { repository, now })
  assertSession()
  const { plan } = prepared
  assertMarketCheckoutSparkDispatchPlan(plan)
  if (
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) ||
    plan.checkoutId !== input.checkoutId ||
    plan.planDigest !== input.planDigest ||
    plan.orderId !== input.orderId ||
    plan.merchantPubkey !== input.merchantPubkey ||
    plan.network !== input.network
  ) {
    throw new Error("Checkout Spark shopper plan changed.")
  }
  const snapshot = await repository.load(input.checkoutId, input.planDigest)
  assertSession()
  if (
    snapshot.status !== "active" ||
    snapshot.state.plan.planDigest !== plan.planDigest
  ) {
    throw new Error("Checkout Spark settled state is unavailable.")
  }
  let readOnlyExistingAttempt =
    input.inspectionOnly === true &&
    canInspectCheckoutSparkSettledSubmittedAttempt(snapshot.state, input.legId)
  let admittedProviderDrained = false

  async function assertAuthority(fundingAdmission = false): Promise<void> {
    assertSession()
    if (
      !readOnlyExistingAttempt &&
      admittedProviderDrained &&
      input.legId !== null &&
      now() >= plan.takeoverAt
    ) {
      // This invocation has already drained its provider call. A fresh exact
      // possible-send marker permits only observation of that admitted attempt.
      const current = await repository.load(input.checkoutId, input.planDigest)
      assertSession()
      readOnlyExistingAttempt =
        current.status === "active" &&
        current.state.plan.planDigest === plan.planDigest &&
        canInspectCheckoutSparkSettledSubmittedAttempt(
          current.state,
          input.legId
        )
    }
    const lifecycle = await readOrder(input.orderId)
    assertSession()
    const binding = lifecycle?.checkoutSparkRouterBinding
    const preparation = readPreparation(input.checkoutId)
    const initialRecovery = preparation?.recoveryHandoffId
      ? readInitialRecovery(preparation.recoveryHandoffId)
      : null
    const configuration = (
      dependencies.sparkConfiguration ?? getSparkConfiguration
    )()
    const completingNativeTreasury =
      Boolean(plan.nativeTreasury) &&
      input.legId ===
        plan.recipients.find((recipient) => recipient.kind === "conduit")?.legId
    if (
      !lifecycle ||
      lifecycle.buyerIdentityKind !==
        (guestIdentity ? "guest_ephemeral" : "signed_in") ||
      (guestIdentity !== null &&
        lifecycle.guestSessionExpiresAt !== guestIdentity.expiresAt) ||
      lifecycle.buyerPubkey !== input.buyerPubkey ||
      lifecycle.merchantPubkey !== plan.merchantPubkey ||
      lifecycle.orderDeliveryStatus !== "sent" ||
      lifecycle.phase === "cancelled" ||
      (lifecycle.phase === "completed" && !completingNativeTreasury) ||
      (lifecycle.paymentStatus === "paid" && !completingNativeTreasury) ||
      binding?.checkoutId !== plan.checkoutId ||
      binding.planDigest !== plan.planDigest ||
      binding.walletId !== plan.walletId ||
      preparation?.planDigest !== plan.planDigest ||
      preparation.recoveryHandoffId !== prepared.recoveryHandoffId ||
      preparation.fundingInvoiceExposedAt === null ||
      initialRecovery?.record.senderPubkey !== input.buyerPubkey ||
      initialRecovery.deliveryProgress.acknowledgedRelayRefs.length === 0 ||
      configuration.status !== "ready" ||
      configuration.network !== plan.network ||
      !manager.isOpen(plan.walletId) ||
      !Number.isSafeInteger(now()) ||
      now() < plan.createdAt ||
      // Funding is a separate inbound invoice; a null leg cannot admit a
      // payout. The bridge independently enforces its exact invoice expiry.
      (input.legId !== null &&
        now() >= plan.takeoverAt &&
        !readOnlyExistingAttempt) ||
      (fundingAdmission && now() >= plan.funding.expiresAt)
    ) {
      throw new Error("Checkout Spark shopper order authority changed.")
    }
  }

  async function assertDispatchAuthority(): Promise<void> {
    await assertAuthority()
    if (
      readOnlyExistingAttempt ||
      admittedProviderDrained ||
      now() >= plan.takeoverAt
    ) {
      throw new Error("Checkout Spark inspection cannot admit a payment.")
    }
  }
  await assertAuthority()
  if (input.inspectionOnly && input.legId === null) {
    throw new Error("Checkout Spark inspection requires a payout leg.")
  }
  if (!snapshot.state.credit) {
    if (input.legId !== null) {
      throw new Error("Checkout Spark payout is not yet funded.")
    }
    if (input.fundingPayment.buyerPubkey !== input.buyerPubkey) {
      throw new Error("Checkout Spark funding buyer changed.")
    }
    const bridge = (
      dependencies.fundingBridge ?? createCheckoutSparkSettledFundingBridge
    )(input.checkoutId)
    const originalBeforeSend = input.fundingPayment.beforeSend
    const originalShouldContinue = input.fundingPayment.shouldContinue
    const funding = await bridge.fund({
      ...input.fundingPayment,
      shouldContinue: () => currentSessionMatches() && originalShouldContinue(),
      beforeSend: async () => {
        await assertAuthority(true)
        await originalBeforeSend?.()
        await assertAuthority(true)
      },
    })
    await assertAuthority(funding.status === "external_ready")
    if (funding.reconciliation.plan.planDigest !== plan.planDigest) {
      throw new Error("Checkout Spark funding observation changed plans.")
    }
    return { status: "funding", funding }
  }
  const acknowledgeRecoverySnapshot = async (
    state: CheckoutSparkSettledReconciliation
  ) => {
    await assertAuthority()
    await input.acknowledgeRecoverySnapshot(state)
    await assertAuthority()
  }
  const provider = (
    dependencies.outgoingProvider ?? createCheckoutSparkSettledOutgoingProvider
  )({
    plan,
    manager,
    assertBeforeSend: async (target) => {
      await assertDispatchAuthority()
      await repository.assertLocalInvoiceOrigin(plan, target, assertSession)
      await assertDispatchAuthority()
    },
  })
  const recordPaid = async (
    target: CheckoutSparkSettledOutgoingTarget,
    observation: CheckoutSparkSettledOutgoingObservation
  ) => {
    if (observation.status !== "paid") return true
    await assertAuthority()
    const recipientSettled = await verifyBuyerCheckoutSparkRecipientSettlement({
      plan,
      target,
      repository,
      now,
      assertCurrent: assertSession,
    })
    await assertAuthority()
    await repository.recordMerchantPayout(
      plan,
      target,
      observation,
      now(),
      assertSession
    )
    await assertAuthority()
    return recipientSettled
  }
  const guardedProvider: CheckoutSparkSettledOutgoingProvider = {
    reconcile: provider.reconcile,
    preflight: async (target) => {
      await assertDispatchAuthority()
      return provider.preflight(target)
    },
    send: async (target) => {
      await assertDispatchAuthority()
      try {
        return await provider.send(target)
      } finally {
        admittedProviderDrained = true
      }
    },
  }
  const nativeProvider = plan.nativeTreasury
    ? createBuyerCheckoutSparkNativeTreasuryProvider({
        checkoutId: plan.checkoutId,
        manager,
        repository,
        assertAuthority,
        assertCurrent: assertSession,
        now,
      })
    : null
  const nativeStore = {
    ...(repository.nativeTreasuryAdmissionScope &&
    repository.saveTreasuryPreProviderRetry
      ? {
          nativeAdmissionScope: repository.nativeTreasuryAdmissionScope,
          savePreProviderRetry: (
            state: CheckoutSparkSettledReconciliation,
            revision: number,
            cancellation: Parameters<
              NonNullable<typeof repository.saveTreasuryPreProviderRetry>
            >[2]
          ) =>
            repository.saveTreasuryPreProviderRetry!(
              state,
              revision,
              cancellation,
              assertSession
            ),
        }
      : {}),
    load: repository.load.bind(repository),
    save: (state: CheckoutSparkSettledReconciliation, revision: number) =>
      repository.save(state, revision, assertSession),
    savePrepared: (
      state: CheckoutSparkSettledReconciliation,
      revision: number,
      settlement: Parameters<typeof repository.saveTreasuryPrepared>[2]
    ) =>
      repository.saveTreasuryPrepared(
        state,
        revision,
        settlement,
        assertSession
      ),
  }
  const nextId = input.legId
  if (nextId === null)
    throw new Error("Checkout Spark funding already settled.")
  const outgoingStore = {
    outgoingAdmissionScope: repository.outgoingAdmissionScope,
    ...(repository.saveOutgoingPreProviderRetry
      ? {
          saveOutgoingPreProviderRetry: (
            state: CheckoutSparkSettledReconciliation,
            revision: number,
            cancellation: Parameters<
              NonNullable<typeof repository.saveOutgoingPreProviderRetry>
            >[2]
          ) =>
            repository.saveOutgoingPreProviderRetry!(
              state,
              revision,
              cancellation,
              assertSession
            ),
        }
      : {}),
    load: repository.load.bind(repository),
    save: (state: CheckoutSparkSettledReconciliation, revision: number) =>
      repository.save(state, revision, assertSession),
  }
  const result = await runCheckoutSparkFinancialWorkflow(
    {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      legId: nextId,
      actor: "shopper",
      mode: "advance",
      inspectionOnly: input.inspectionOnly,
    },
    {
      store: outgoingStore,
      assertCurrent: assertAuthority,
      now,
      outgoing: guardedProvider,
      recordPaid,
      preparation: createBuyerCheckoutSparkLegPreparationPorts(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: nextId,
          shouldContinue: () =>
            currentSessionMatches() && now() < plan.takeoverAt,
        },
        {
          repository,
          walletManager: manager,
          acknowledgeRecoverySnapshot,
          nowMs: now,
        }
      ),
      ...(dependencies.prepareLeg
        ? {
            prepareLeg: (legId: string) =>
              dependencies.prepareLeg!(
                {
                  checkoutId: plan.checkoutId,
                  planDigest: plan.planDigest,
                  legId,
                  shouldContinue: () =>
                    currentSessionMatches() && now() < plan.takeoverAt,
                },
                {
                  repository,
                  walletManager: manager,
                  acknowledgeRecoverySnapshot,
                  nowMs: now,
                }
              ),
          }
        : {}),
      ...(nativeProvider
        ? {
            native: {
              store: nativeStore,
              provider: {
                reconcile: nativeProvider.reconcile,
                preflight: async (
                  target: Parameters<typeof nativeProvider.preflight>[0],
                  cancellation: Parameters<typeof nativeProvider.preflight>[1]
                ) => {
                  await assertDispatchAuthority()
                  return nativeProvider.preflight(target, cancellation)
                },
                send: async (
                  target: Parameters<typeof nativeProvider.send>[0]
                ) => {
                  await assertDispatchAuthority()
                  try {
                    return await nativeProvider.send(target)
                  } finally {
                    admittedProviderDrained = true
                  }
                },
              },
              proveCommerce: (state: CheckoutSparkSettledReconciliation) =>
                proveBuyerCheckoutSparkTreasuryCommerce({
                  state,
                  manager,
                  repository,
                  now,
                  assertAuthority,
                  assertCurrent: assertSession,
                }),
            },
          }
        : {}),
      acknowledgeRecoverySnapshot,
      outgoingStep: dependencies.outgoingStep,
      treasuryStep: dependencies.treasuryStep,
    }
  )
  if (result.status === "payout_prepared") return result
  if (result.status !== "outgoing_step")
    throw new Error("Checkout Spark execution state is unavailable.")
  if (result.step.outcome === "paid" || result.step.outcome === "already_paid")
    assertSession()
  else await assertAuthority()
  return result
}
