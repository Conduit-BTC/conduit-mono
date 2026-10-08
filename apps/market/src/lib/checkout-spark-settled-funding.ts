import {
  DexieCheckoutSparkSettledRepository,
  runCheckoutSparkFinancialWorkflow,
  type CheckoutSparkSettledReconciliation,
  type ConduitAppId,
  type WalletPaymentFeeApproval,
} from "@conduit/core"

import {
  payCheckoutInvoice,
  type CheckoutInvoicePaymentResult,
  type CheckoutPaymentTarget,
} from "./payment-rails"
import { getSparkWalletManager } from "./spark-sdk"
import { getCheckoutSparkRecoveryDelivery } from "./checkout-spark-recovery-handoff"
import type { SparkCheckoutReceiveRequest } from "./spark-wallet"
import type { SparkCheckoutReceiveCreditProof } from "./spark-checkout-receive-credit"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  saveCheckoutSparkSettledPreparation,
  type CheckoutSparkSettledPreparationRepository,
  type CheckoutSparkSettledPreparationStorage,
} from "./checkout-spark-settled-preparation"
import { withCheckoutSparkRouterStoreWriteLock } from "./checkout-spark-router-preparation-lock"

export interface CheckoutSparkSettledFundingPaymentInput {
  buyerPubkey: string
  shouldContinue: () => boolean
  /** Exact receive inspection only; never enter a payer rail. */
  inspectionOnly?: boolean
  /** Explicit manual choice. Reserve a possible payment before disclosing it. */
  exposeExternalInvoice?: boolean
  paymentTarget: CheckoutPaymentTarget
  walletPaymentAttemptId?: string
  approveFee?: WalletPaymentFeeApproval
  beforeSend?: () => Promise<void>
  timeoutMs: number
  appId: ConduitAppId
}

export interface CheckoutSparkExternalFundingInvoice {
  readonly checkoutId: string
  readonly planDigest: string
  readonly orderId: string
  readonly buyerPubkey: string
  readonly invoice: string
  readonly amountSats: number
  readonly expiresAt: number
  readonly takeoverAt: number
  readonly exposedAt: number
}

export type CheckoutSparkSettledFundingResult =
  | { status: "funded"; reconciliation: CheckoutSparkSettledReconciliation }
  | {
      status: "external_ready"
      externalInvoice: Readonly<CheckoutSparkExternalFundingInvoice>
      reconciliation: CheckoutSparkSettledReconciliation
    }
  | {
      status: "awaiting_reconciliation"
      paymentSubmission: "accepted" | "unknown"
      reconciliation: CheckoutSparkSettledReconciliation
    }
  | {
      status: "manual_required"
      reason: string
      reconciliation: CheckoutSparkSettledReconciliation
    }
  | {
      status: "payment_retryable"
      reason: string
      reconciliation: CheckoutSparkSettledReconciliation
    }

type SettledRepository = CheckoutSparkSettledPreparationRepository & {
  save: DexieCheckoutSparkSettledRepository["save"]
  recordMerchantCredit: DexieCheckoutSparkSettledRepository["recordMerchantCredit"]
}

export interface CheckoutSparkSettledFundingLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

type PayFundingInvoice = (
  input: Parameters<typeof payCheckoutInvoice>[0]
) => Promise<CheckoutInvoicePaymentResult>

export interface CheckoutSparkSettledFundingDependencies {
  repository?: SettledRepository
  storage?: CheckoutSparkSettledPreparationStorage | null
  recoveryStorage?: CheckoutSparkSettledPreparationStorage | null
  loadAuthorized?: typeof loadAuthorizedCheckoutSparkSettledFunding
  attestCredit?: (
    walletId: string,
    request: SparkCheckoutReceiveRequest
  ) => Promise<SparkCheckoutReceiveCreditProof | null>
  payInvoice?: PayFundingInvoice
  now?: () => number
  lockManager?: CheckoutSparkSettledFundingLockManager | null
  requireCrossTabLock?: boolean
  verifyBuyerAuthority?: (
    initialHandoffId: string,
    buyerPubkey: string,
    storage: CheckoutSparkSettledPreparationStorage | null | undefined
  ) => boolean
  /** Tests may provide the shared local-storage lock; production requires it. */
  withStoreWriteLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

function defaultLockManager(): CheckoutSparkSettledFundingLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null
  return navigator.locks as unknown as CheckoutSparkSettledFundingLockManager
}

function requireSparkManager() {
  const manager = getSparkWalletManager()
  if (!manager) throw new Error("Spark is unavailable in this Market build.")
  return manager
}

/**
 * The payer result is not settlement proof. Only the pinned SDK's exact
 * request+transfer attestation may allocate the frozen gross invoice credit.
 * An ambiguous payer attempt remains durably provisional across reloads;
 * reopening never pays the invoice a second time.
 */
export function createCheckoutSparkSettledFundingBridge(
  checkoutId: string,
  dependencies: CheckoutSparkSettledFundingDependencies = {}
): {
  fund(
    input: CheckoutSparkSettledFundingPaymentInput
  ): Promise<CheckoutSparkSettledFundingResult>
} {
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const loadAuthorized =
    dependencies.loadAuthorized ?? loadAuthorizedCheckoutSparkSettledFunding
  const attestCredit =
    dependencies.attestCredit ??
    ((walletId: string, request: SparkCheckoutReceiveRequest) =>
      requireSparkManager().attestCheckoutReceiveCredit(walletId, request))
  const payInvoice = dependencies.payInvoice ?? payCheckoutInvoice
  const now = dependencies.now ?? Date.now
  const verifyBuyerAuthority =
    dependencies.verifyBuyerAuthority ??
    ((initialHandoffId: string, buyerPubkey: string) => {
      const delivery =
        dependencies.recoveryStorage === undefined
          ? getCheckoutSparkRecoveryDelivery(initialHandoffId)
          : getCheckoutSparkRecoveryDelivery(
              initialHandoffId,
              dependencies.recoveryStorage
            )
      return delivery?.record.senderPubkey === buyerPubkey
    })
  const lockManager =
    dependencies.lockManager === undefined
      ? defaultLockManager()
      : dependencies.lockManager
  const requireCrossTabLock =
    dependencies.requireCrossTabLock ?? typeof window !== "undefined"
  const withStoreWriteLock =
    dependencies.withStoreWriteLock ??
    (<T>(operation: () => Promise<T>): Promise<T> =>
      withCheckoutSparkRouterStoreWriteLock(operation))
  let inFlight: Promise<CheckoutSparkSettledFundingResult> | null = null

  const run = async (
    input: CheckoutSparkSettledFundingPaymentInput
  ): Promise<CheckoutSparkSettledFundingResult> => {
    const exposeExternalInvoice = input.exposeExternalInvoice === true
    if (exposeExternalInvoice && input.paymentTarget.type !== "manual") {
      throw new Error("External funding requires an explicit manual choice.")
    }
    const assertCurrentBuyer = (initialHandoffId?: string) => {
      if (
        !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
        !input.shouldContinue() ||
        (initialHandoffId !== undefined &&
          !verifyBuyerAuthority(
            initialHandoffId,
            input.buyerPubkey,
            dependencies.recoveryStorage
          ))
      ) {
        throw new Error(
          "Settled checkout buyer session or recovery sender changed."
        )
      }
    }
    assertCurrentBuyer()
    const prepared = await loadAuthorized(checkoutId, {
      storage: dependencies.storage,
      recoveryStorage: dependencies.recoveryStorage,
      repository,
      now,
      expectedBuyerPubkey: input.buyerPubkey,
    })
    const { plan } = prepared
    assertCurrentBuyer(prepared.recoveryHandoffId)
    const readMetadata = () => {
      const metadata = getCheckoutSparkSettledPreparation(
        checkoutId,
        dependencies.storage
      )
      if (
        !metadata ||
        metadata.planDigest !== plan.planDigest ||
        metadata.recoveryHandoffId !== prepared.recoveryHandoffId ||
        metadata.fundingInvoiceExposedAt === null
      ) {
        throw new Error("Settled checkout funding is not durably authorized.")
      }
      return metadata
    }
    readMetadata()
    const snapshot = await repository.load(checkoutId, plan.planDigest)
    assertCurrentBuyer(prepared.recoveryHandoffId)
    if (snapshot.status !== "active") {
      throw new Error("Settled checkout funding state is unavailable.")
    }

    let proof: SparkCheckoutReceiveCreditProof | null
    try {
      proof = await attestCredit(plan.walletId, prepared.fundingReceive)
    } catch {
      assertCurrentBuyer(prepared.recoveryHandoffId)
      if (snapshot.state.credit) {
        return { status: "funded", reconciliation: snapshot.state }
      }
      return {
        status: "awaiting_reconciliation",
        paymentSubmission: "unknown",
        reconciliation: snapshot.state,
      }
    }
    assertCurrentBuyer(prepared.recoveryHandoffId)
    if (proof) {
      const admitted = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId,
          planDigest: plan.planDigest,
          actor: "shopper",
          mode: "credit",
        },
        {
          store: repository,
          assertCurrent: () => assertCurrentBuyer(prepared.recoveryHandoffId),
          now,
          credit: {
            proof,
            record: (creditPlan, creditProof) =>
              repository.recordMerchantCredit(
                creditPlan,
                creditProof,
                now(),
                () => assertCurrentBuyer(prepared.recoveryHandoffId)
              ),
          },
          acknowledgeRecoverySnapshot: async () => {},
        }
      )
      if (admitted.status !== "credited")
        throw new Error("Settled checkout credit is unavailable.")
      return { status: "funded", reconciliation: admitted.state }
    }
    if (snapshot.state.credit) {
      // Imported progress is not provider settlement evidence. Keep the
      // existing checkout state usable, but do not manufacture a fact record.
      return { status: "funded", reconciliation: snapshot.state }
    }
    let metadata = readMetadata()
    if (
      metadata.fundingSubmissionState === "provisional" &&
      (!exposeExternalInvoice ||
        metadata.externalFundingExposedAt === undefined)
    ) {
      return {
        status: "awaiting_reconciliation",
        paymentSubmission: "unknown",
        reconciliation: snapshot.state,
      }
    }
    if (input.inspectionOnly) {
      return {
        status: "manual_required",
        reason:
          "Exact funding credit is not confirmed. Inspection made no payment; keep this order for reconciliation.",
        reconciliation: snapshot.state,
      }
    }
    const currentTime = now()
    if (
      !Number.isSafeInteger(currentTime) ||
      currentTime < plan.createdAt ||
      currentTime >= plan.funding.expiresAt
    ) {
      return {
        status: "manual_required",
        reason:
          "This checkout cannot start a funding payment now. Do not pay its invoice or start another checkout until the original order is checked for a late payment.",
        reconciliation: snapshot.state,
      }
    }
    const amountMsats = plan.funding.grossFundingSats * 1_000
    if (!Number.isSafeInteger(amountMsats)) {
      throw new Error("Settled checkout funding amount is unsafe.")
    }
    if (exposeExternalInvoice) {
      const assertDisclosureWindow = () => {
        assertCurrentBuyer(prepared.recoveryHandoffId)
        const time = now()
        if (
          !Number.isSafeInteger(time) ||
          time < plan.createdAt ||
          time >= plan.funding.expiresAt
        ) {
          throw new Error("The external funding invoice is no longer payable.")
        }
      }
      await input.beforeSend?.()
      assertDisclosureWindow()
      metadata = await withStoreWriteLock(async () => {
        assertDisclosureWindow()
        const current = readMetadata()
        if (
          current.fundingSubmissionState === "provisional" &&
          current.externalFundingExposedAt === undefined
        ) {
          throw new Error(
            "Check the original funding attempt before paying again."
          )
        }
        const time = now()
        return saveCheckoutSparkSettledPreparation(
          {
            ...current,
            fundingSubmissionState: "provisional",
            externalFundingExposedAt: current.externalFundingExposedAt ?? time,
            savedAt: time,
          },
          dependencies.storage
        )
      })
      // Recheck recovery ACK and exact saved plan after durable reservation.
      // Closing the panel or failing to launch a wallet cannot undo exposure.
      const authorized = await loadAuthorized(checkoutId, {
        storage: dependencies.storage,
        recoveryStorage: dependencies.recoveryStorage,
        repository,
        now,
        expectedBuyerPubkey: input.buyerPubkey,
      })
      assertDisclosureWindow()
      await input.beforeSend?.()
      assertDisclosureWindow()
      const reserved = readMetadata()
      if (
        authorized.plan.planDigest !== plan.planDigest ||
        authorized.recoveryHandoffId !== prepared.recoveryHandoffId ||
        reserved.fundingSubmissionState !== "provisional" ||
        reserved.externalFundingExposedAt === undefined ||
        reserved.externalFundingExposedAt !== metadata.externalFundingExposedAt
      ) {
        throw new Error(
          "External funding reservation changed before disclosure."
        )
      }
      if (authorized.state.credit) {
        return { status: "funded", reconciliation: authorized.state }
      }
      return {
        status: "external_ready",
        reconciliation: authorized.state,
        externalInvoice: Object.freeze({
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          orderId: plan.orderId,
          buyerPubkey: input.buyerPubkey,
          invoice: plan.funding.paymentRequest,
          amountSats: plan.funding.grossFundingSats,
          expiresAt: plan.funding.expiresAt,
          takeoverAt: plan.takeoverAt,
          exposedAt: reserved.externalFundingExposedAt,
        }),
      }
    }
    if (input.paymentTarget.type === "manual") {
      assertCurrentBuyer(prepared.recoveryHandoffId)
      const manual = await payInvoice({
        invoice: plan.funding.paymentRequest,
        amountMsats,
        paymentTarget: input.paymentTarget,
        timeoutMs: input.timeoutMs,
        appId: input.appId,
      })
      assertCurrentBuyer(prepared.recoveryHandoffId)
      if (manual.status !== "manual_required") {
        throw new Error("Manual funding unexpectedly used an automatic rail.")
      }
      return {
        status: "manual_required",
        reason: manual.reason,
        reconciliation: snapshot.state,
      }
    }

    // Reserve the exact invoice before any payer-provider call. The per-checkout
    // Web Lock serializes this with every other tab; local-storage writes also
    // use the shared store lock to preserve unrelated checkout metadata.
    metadata = await withStoreWriteLock(async () =>
      saveCheckoutSparkSettledPreparation(
        {
          ...readMetadata(),
          fundingSubmissionState: "provisional",
          savedAt: now(),
        },
        dependencies.storage
      )
    )
    if (metadata.fundingSubmissionState !== "provisional") {
      throw new Error("Settled checkout funding was not durably reserved.")
    }
    assertCurrentBuyer(prepared.recoveryHandoffId)
    let payment: CheckoutInvoicePaymentResult | null
    try {
      payment = await payInvoice({
        invoice: plan.funding.paymentRequest,
        amountMsats,
        paymentTarget: input.paymentTarget,
        walletPaymentAttemptId: input.walletPaymentAttemptId,
        approveFee: input.approveFee,
        beforeSend: async () => {
          assertCurrentBuyer(prepared.recoveryHandoffId)
          await input.beforeSend?.()
          assertCurrentBuyer(prepared.recoveryHandoffId)
          // Wallet setup and Spark fee approval can outlive the invoice. This
          // callback runs again at the provider's final pre-publish boundary.
          const sendTime = now()
          if (
            !Number.isSafeInteger(sendTime) ||
            sendTime < plan.createdAt ||
            sendTime >= plan.funding.expiresAt
          ) {
            throw new Error(
              "The funding invoice expired before wallet payment. Check the original order for a late payment."
            )
          }
        },
        timeoutMs: input.timeoutMs,
        appId: input.appId,
      })
    } catch {
      payment = null
    }
    assertCurrentBuyer(prepared.recoveryHandoffId)
    // A provider may report a definitive refusal after publishing a request.
    // That is retryable for ordinary checkout, but cannot prove this exact
    // Spark funding invoice was never paid; keep the durable reservation.
    if (
      payment?.status === "retryable_failure" &&
      payment.phase === "before_publish"
    ) {
      await withStoreWriteLock(async () =>
        saveCheckoutSparkSettledPreparation(
          {
            ...readMetadata(),
            fundingSubmissionState: "not_started",
            savedAt: now(),
          },
          dependencies.storage,
          { allowDefinitePreSendReset: true }
        )
      )
      return {
        status: "payment_retryable",
        reason: payment.reason,
        reconciliation: snapshot.state,
      }
    }
    if (payment?.status === "manual_required") {
      throw new Error("Automatic funding unexpectedly changed payment rails.")
    }
    try {
      proof = await attestCredit(plan.walletId, prepared.fundingReceive)
    } catch {
      proof = null
    }
    assertCurrentBuyer(prepared.recoveryHandoffId)
    if (proof) {
      const admitted = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId,
          planDigest: plan.planDigest,
          actor: "shopper",
          mode: "credit",
        },
        {
          store: repository,
          assertCurrent: () => assertCurrentBuyer(prepared.recoveryHandoffId),
          now,
          credit: {
            proof,
            record: (creditPlan, creditProof) =>
              repository.recordMerchantCredit(
                creditPlan,
                creditProof,
                now(),
                () => assertCurrentBuyer(prepared.recoveryHandoffId)
              ),
          },
          acknowledgeRecoverySnapshot: async () => {},
        }
      )
      if (admitted.status !== "credited")
        throw new Error("Settled checkout credit is unavailable.")
      return { status: "funded", reconciliation: admitted.state }
    }
    return {
      status: "awaiting_reconciliation",
      paymentSubmission: payment?.status === "paid" ? "accepted" : "unknown",
      reconciliation: snapshot.state,
    }
  }

  return {
    fund(input) {
      if (inFlight) return inFlight
      if (!lockManager) {
        if (requireCrossTabLock) {
          return Promise.reject(
            new Error(
              "This browser cannot coordinate settled checkout funding across tabs."
            )
          )
        }
        inFlight = run(input).finally(() => {
          inFlight = null
        })
        return inFlight
      }
      inFlight = lockManager
        .request(
          `conduit:checkout-spark-settled-funding:${checkoutId}`,
          { mode: "exclusive", ifAvailable: true },
          (lock) => {
            if (!lock) {
              throw new Error(
                "Settled checkout funding is active in another tab."
              )
            }
            return run(input)
          }
        )
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}
