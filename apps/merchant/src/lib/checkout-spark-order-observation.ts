import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  getCheckoutSparkSettledLegGeneration,
  projectCheckoutSparkMerchantSettlement,
  proveSparkCheckoutReceiveCredit,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkMerchantOrderWitness,
  validateCheckoutSparkPlanSources,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { openMerchantCheckoutSparkObservationWallet } from "./checkout-spark-observation-wallet"
import type { MerchantSparkObservationWallet } from "./checkout-spark-observation-wallet"
import { assertCheckoutSparkMerchantPricingAuthority } from "./checkout-spark-pricing-authority"
import { inspectExactMerchantPayout } from "./checkout-spark-settled-recovery"

type ObservationRepository = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "loadMerchantOrderWitness"
  | "loadMerchantPlanSourceEvents"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
  | "loadMerchantSettlement"
>

/**
 * Immediate exact native observations, never claim-capable initialization.
 * Fresh signed recovery is opened only in the private callback. This records
 * separate provider facts, not reconciliation transitions or outgoing intents.
 */
export async function observeMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: {
    repository?: ObservationRepository
    expectedOrderWitness?: CheckoutSparkMerchantOrderWitness
    openObservationWallet?: typeof openMerchantCheckoutSparkObservationWallet
    consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
    now?: () => number
    /** Test seam may shorten, never extend, the five-second read deadline. */
    readTimeoutMs?: number
  } = {}
): Promise<"verified" | "pending" | "unavailable"> {
  const principal = principalPubkey.trim().toLowerCase()
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const timeoutMs = dependencies.readTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000)
    throw new Error("Checkout Spark observation deadline is invalid.")
  let status: "verified" | "pending" = "pending"
  const observe = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    recoveredState: CheckoutSparkSettledReconciliation,
    assertRecoveryCurrent: () => void
  ) => {
    let expired = false
    const assertCurrent = () => {
      assertActive()
      assertRecoveryCurrent()
      if (expired) throw new Error("Checkout Spark observation is unavailable.")
    }
    const bounded = async <T>(
      read: () => Promise<T>,
      cleanupLate?: (value: T) => Promise<void>
    ): Promise<T> => {
      assertCurrent()
      let timer: ReturnType<typeof setTimeout> | undefined
      const operation = read().then(async (value) => {
        try {
          assertCurrent()
        } catch {
          // An open that resolves after revocation owns no usable authority.
          // Release its inert wallet without letting its callback resume reads.
          await cleanupLate?.(value)
          throw new Error("Checkout Spark observation is unavailable.")
        }
        return value
      })
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true
              reject(new Error("Checkout Spark observation is unavailable."))
            }, timeoutMs)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    assertCurrent()
    const { plan } = initial
    if (
      initial.merchantPubkey !== principal ||
      plan.merchantPubkey !== principal ||
      initial.wallet.walletId !== plan.walletId ||
      initial.wallet.network !== plan.network ||
      candidate.checkoutId !== plan.checkoutId ||
      candidate.orderId !== plan.orderId ||
      candidate.planDigest !== plan.planDigest ||
      candidate.takeoverAt !== plan.takeoverAt ||
      recoveredState.plan.planDigest !== plan.planDigest
    )
      throw new Error("Checkout Spark observation binding changed.")
    const saved = await bounded(() =>
      repository.load(plan.checkoutId, plan.planDigest)
    )
    assertCurrent()
    if (saved.status !== "active")
      throw new CheckoutSparkSettledRepositoryConflictError()
    assertCheckoutSparkSettledRecoveryProgression(recoveredState, saved.state)
    const witness = await bounded(() =>
      repository.loadMerchantOrderWitness(
        principal,
        plan.checkoutId,
        plan.planDigest
      )
    )
    assertCurrent()
    const exactWitness = witness
      ? restoreCheckoutSparkMerchantOrderWitness(witness, plan)
      : null
    if (
      !exactWitness ||
      exactWitness.buyerPubkey !== initial.senderPubkey ||
      (dependencies.expectedOrderWitness &&
        JSON.stringify(exactWitness) !==
          JSON.stringify(
            restoreCheckoutSparkMerchantOrderWitness(
              dependencies.expectedOrderWitness,
              plan
            )
          ))
    )
      throw new Error(
        "Checkout Spark observation requires its exact buyer order."
      )
    const sources = await bounded(() =>
      repository.loadMerchantPlanSourceEvents(plan.checkoutId, plan.planDigest)
    )
    assertCurrent()
    validateCheckoutSparkPlanSources(plan, sources)
    const assertSavedCurrent = async () => {
      const current = await bounded(() =>
        repository.load(plan.checkoutId, plan.planDigest)
      )
      assertCurrent()
      if (current.status !== "active" || current.revision !== saved.revision)
        throw new CheckoutSparkSettledRepositoryConflictError()
    }
    const native = await bounded(
      () =>
        (
          dependencies.openObservationWallet ??
          openMerchantCheckoutSparkObservationWallet
        )({
          mnemonic: initial.wallet.mnemonic,
          accountNumber: initial.wallet.accountNumber,
          network: initial.wallet.network,
          expectedWalletIdentityPubkey: plan.funding.receiverIdentityPublicKey,
          assertActive: assertCurrent,
        }),
      (late) => late.cleanup()
    )
    const wallet: MerchantSparkObservationWallet = {
      getIdentityPublicKey: () => bounded(() => native.getIdentityPublicKey()),
      getLightningReceiveRequest: (id) =>
        bounded(() => native.getLightningReceiveRequest(id)),
      getTransfer: (id) => bounded(() => native.getTransfer(id)),
      ...(native.getTransferFromSsp
        ? {
            getTransferFromSsp: (id: string) =>
              bounded(() => native.getTransferFromSsp!(id)),
          }
        : {}),
      ...(native.getLightningSendRequest
        ? {
            getLightningSendRequest: (id: string) =>
              bounded(() => native.getLightningSendRequest!(id)),
          }
        : {}),
      // Cleanup is drained, not abandoned on another timer. New provider work
      // cannot start while this query-only session's release is unresolved.
      cleanup: () => native.cleanup(),
    }
    try {
      assertCurrent()
      const identity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertCurrent()
      if (identity !== plan.funding.receiverIdentityPublicKey)
        throw new Error("Checkout Spark observation identity changed.")
      const receive = await wallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertCurrent()
      if (
        receive?.status !== "TRANSFER_COMPLETED" ||
        !receive.transfer?.sparkId
      )
        return
      const transfer = await wallet.getTransfer(receive.transfer.sparkId)
      assertCurrent()
      if (!transfer) return
      const proof = proveSparkCheckoutReceiveCredit({
        expectedRequest: {
          id: plan.funding.requestId,
          network: plan.network,
          paymentRequest: plan.funding.paymentRequest,
          paymentHash: plan.funding.paymentHash,
          grossFundingSats: plan.funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: identity,
        receive,
        transfer,
      })
      assertCheckoutSparkMerchantPricingAuthority({ plan, fundingProof: proof })
      // Reuse admission/allocation checks without changing the saved state.
      const attributed = recordCheckoutSparkSettledCredit(saved.state, {
        requestId: proof.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: proof.transferId,
        receiverIdentityPublicKey: proof.receiverIdentityPublicKey,
        grossSats: proof.grossSats,
        creditedSats: proof.creditedSats,
        observedAt: now(),
      })
      await assertSavedCurrent()
      await bounded(() =>
        repository.recordMerchantCredit(plan, proof, now(), assertCurrent)
      )
      assertCurrent()
      for (const recipient of plan.recipients) {
        if (recipient.kind === "conduit") continue
        const leg = attributed.legs.find(
          (item) => item.legId === recipient.legId
        )!
        if (!leg.intent || leg.allocationSats === null) continue
        const target: CheckoutSparkSettledOutgoingTarget = {
          walletId: plan.walletId,
          network: plan.network,
          legId: leg.legId,
          recipientId: recipient.recipientId,
          allocationSats: leg.allocationSats,
          unpaidAllocationSats: leg.allocationSats,
          generation: getCheckoutSparkSettledLegGeneration(leg),
          intent: leg.intent,
        }
        const observation = await inspectExactMerchantPayout(
          plan,
          target,
          wallet,
          assertCurrent
        )
        assertCurrent()
        if (observation.status !== "paid") continue
        if (
          leg.status === "paid" &&
          (leg.finalFeeSats !== observation.finalFeeSats ||
            leg.finalDebitSats !== observation.finalDebitSats)
        )
          continue
        await assertSavedCurrent()
        await bounded(() =>
          repository.recordMerchantPayout(
            plan,
            target,
            observation,
            now(),
            assertCurrent
          )
        )
        assertCurrent()
      }
      const settlement = await bounded(() =>
        repository.loadMerchantSettlement(
          principal,
          plan.checkoutId,
          plan.planDigest
        )
      )
      assertCurrent()
      if (
        settlement &&
        projectCheckoutSparkMerchantSettlement(settlement).commerceVerified
      )
        status = "verified"
    } finally {
      await wallet.cleanup()
    }
  }
  assertActive()
  try {
    const result = await (
      dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
    )(principal, candidate, {
      async consume(payload, assertCurrent) {
        if (payload.schemaVersion !== 2)
          throw new Error("Checkout Spark observation requires a settled plan.")
        await observe(payload, payload.state, assertCurrent)
      },
      async consumeSettled(initial, latest, assertCurrent) {
        await observe(initial, latest.state, assertCurrent)
      },
      async consumeMerchantProgress(initial, _buyer, progress, assertCurrent) {
        await observe(initial, progress.state, assertCurrent)
      },
    })
    assertActive()
    return result.status === "consumed" ? status : "unavailable"
  } catch {
    assertActive()
    return "unavailable"
  }
}
