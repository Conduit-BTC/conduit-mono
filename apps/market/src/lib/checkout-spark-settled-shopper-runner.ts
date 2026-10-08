import {
  DexieCheckoutSparkSettledRepository,
  getOrderLifecycle,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledOutgoingStepResult,
} from "@conduit/core"
import {
  advanceCheckoutSparkSettledShopper,
  type AdvanceCheckoutSparkSettledShopperDependencies,
  type AdvanceCheckoutSparkSettledShopperInput,
} from "./checkout-spark-settled-shopper-advance"
import { assessCheckoutSparkSettledOrderControl } from "./checkout-spark-settled-order-control"
import { getCheckoutSparkSettledPreparation } from "./checkout-spark-settled-preparation"
import { getCheckoutSparkRecoveryDelivery } from "./checkout-spark-recovery-handoff"
import type { CheckoutSparkExternalFundingInvoice } from "./checkout-spark-settled-funding"
import { getSparkConfiguration, getSparkWalletManager } from "./spark-sdk"
import { isCurrentGuestOrderSigningIdentity } from "./guest-order-identity"

export interface CheckoutSparkSettledShopperProgress {
  phase: "funding" | "preparing" | "routing" | "checking"
  paidLegs: number
  totalLegs: number
}

export interface CheckoutSparkSettledShopperRunInput extends Omit<
  AdvanceCheckoutSparkSettledShopperInput,
  "legId" | "inspectionOnly"
> {
  /** Values bound by the buyer's informed, immutable router-plan approval. */
  authorization: {
    planDigest: string
    walletId: string
    grossFundingSats: number
  }
  /** Resume always inspects. Only a new explicit approval can enter a payer. */
  fundingMode: "pay_once" | "inspect"
  onProgress?: (progress: CheckoutSparkSettledShopperProgress) => void
  onExternalInvoice?: (
    invoice: Readonly<CheckoutSparkExternalFundingInvoice>
  ) => void
  /** Bound pending observations in this foreground activation; never retries sends. */
  fundingPoll?: { attempts: number; intervalMs: number }
}

export type CheckoutSparkSettledShopperPauseReason =
  | NonNullable<CheckoutSparkSettledOutgoingStepResult["reason"]>
  | "paused"
  | "busy"
  | "authorization_changed"
  | "unavailable"
  | "funding_action_stopped"
  | "reconciliation_timeout"
  | "step_limit"

export type CheckoutSparkSettledShopperRunResult =
  | { status: "complete" }
  | {
      status: "funding_pending"
      externalInvoice?: Readonly<CheckoutSparkExternalFundingInvoice>
    }
  | { status: "paused"; reason: CheckoutSparkSettledShopperPauseReason }

export interface CheckoutSparkSettledShopperRunnerDependencies extends AdvanceCheckoutSparkSettledShopperDependencies {
  wait?: (milliseconds: number) => Promise<void>
}

class RoutingPaused extends Error {
  constructor(readonly reason: CheckoutSparkSettledShopperPauseReason) {
    super("Checkout routing paused.")
  }
}

// Same-page duplicate mounts are serialized too. Durable CAS and wallet/funding
// Web Locks remain the cross-tab protection; this is not a distributed lease.
const activePlans = new Set<string>()

/**
 * Foreground composition only: the existing one-step engine owns all payment
 * authority, immutable intents, recovery ACKs, reserve checks and send markers.
 * A pause revokes new work immediately but drains an admitted operation rather
 * than pretending a timeout or hidden page can cancel an irreversible send.
 */
export function createCheckoutSparkSettledShopperRunner(
  dependencies: CheckoutSparkSettledShopperRunnerDependencies = {}
): {
  run(
    input: CheckoutSparkSettledShopperRunInput
  ): Promise<CheckoutSparkSettledShopperRunResult>
  pause(): Promise<void>
} {
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const readPreparation =
    dependencies.readPreparation ?? getCheckoutSparkSettledPreparation
  const readInitialRecovery =
    dependencies.readInitialRecovery ?? getCheckoutSparkRecoveryDelivery
  const sparkManager = dependencies.sparkManager ?? getSparkWalletManager
  const sparkConfiguration =
    dependencies.sparkConfiguration ?? getSparkConfiguration
  let epoch = 0
  let work: Promise<CheckoutSparkSettledShopperRunResult> | null = null

  async function execute(
    input: CheckoutSparkSettledShopperRunInput,
    generation: number
  ): Promise<CheckoutSparkSettledShopperRunResult> {
    const reconciliationDeadline = now() + 5 * 60_000
    const sessionCurrent = () => {
      if (generation !== epoch || !input.shouldContinue()) return false
      if (!input.guestIdentity)
        return input.currentBuyerPubkey() === input.buyerPubkey
      const guest = input.currentGuestIdentity?.() ?? null
      const scope = {
        orderId: input.orderId,
        merchantPubkey: input.merchantPubkey,
        pubkey: input.buyerPubkey,
      }
      const time = now()
      return (
        isCurrentGuestOrderSigningIdentity(input.guestIdentity, scope, time) &&
        isCurrentGuestOrderSigningIdentity(guest, scope, time) &&
        guest?.createdAt === input.guestIdentity.createdAt &&
        guest.expiresAt === input.guestIdentity.expiresAt
      )
    }
    // Admission guards must also revoke after a slow pre-send await. An
    // already admitted SDK operation drains with its possible-send marker kept.
    const current = () => sessionCurrent() && now() < reconciliationDeadline
    const assertCurrent = () => {
      if (!sessionCurrent()) throw new RoutingPaused("paused")
      if (now() >= reconciliationDeadline)
        throw new RoutingPaused("reconciliation_timeout")
    }
    const fundingShouldContinue = input.fundingPayment.shouldContinue
    if (input.fundingPayment.buyerPubkey !== input.buyerPubkey) {
      throw new RoutingPaused("authorization_changed")
    }
    const beforeSend = input.fundingPayment.beforeSend
    const acknowledge = input.acknowledgeRecoverySnapshot
    const base: Omit<AdvanceCheckoutSparkSettledShopperInput, "legId"> = {
      ...input,
      shouldContinue: current,
      fundingPayment: {
        ...input.fundingPayment,
        shouldContinue: () => current() && fundingShouldContinue(),
        beforeSend: async () => {
          assertCurrent()
          await beforeSend?.()
          assertCurrent()
        },
      },
      acknowledgeRecoverySnapshot: async (state) => {
        assertCurrent()
        await acknowledge(state)
        assertCurrent()
      },
    }
    const poll = input.fundingPoll ?? { attempts: 63, intervalMs: 2_000 }
    if (
      !Number.isSafeInteger(poll.attempts) ||
      poll.attempts < 1 ||
      poll.attempts > 63 ||
      !Number.isSafeInteger(poll.intervalMs) ||
      poll.intervalMs < 1 ||
      poll.intervalMs > 5_000 ||
      (input.fundingMode !== "pay_once" && input.fundingMode !== "inspect")
    )
      throw new RoutingPaused("authorization_changed")
    let fundingObservations = 0
    let pendingObservations = 0
    async function waitForPendingObservation(): Promise<boolean> {
      pendingObservations += 1
      const remainingMs = reconciliationDeadline - now()
      if (pendingObservations >= poll.attempts || remainingMs <= 0) return false
      await wait(
        Math.min(
          remainingMs,
          5_000,
          poll.intervalMs * 2 ** Math.min(pendingObservations - 1, 2)
        )
      )
      if (!sessionCurrent()) throw new RoutingPaused("paused")
      return now() < reconciliationDeadline
    }
    let remainingSteps: number | undefined
    let externalInvoice:
      Readonly<CheckoutSparkExternalFundingInvoice> | undefined

    while (true) {
      assertCurrent()
      const snapshot = await repository.load(input.checkoutId, input.planDigest)
      assertCurrent()
      if (snapshot.status !== "active") throw new RoutingPaused("unavailable")
      const state = restoreCheckoutSparkSettledReconciliation(snapshot.state)
      const { plan } = state
      if (
        plan.checkoutId !== input.checkoutId ||
        plan.planDigest !== input.planDigest ||
        plan.planDigest !== input.authorization.planDigest ||
        plan.walletId !== input.authorization.walletId ||
        plan.funding.grossFundingSats !==
          input.authorization.grossFundingSats ||
        plan.orderId !== input.orderId ||
        plan.merchantPubkey !== input.merchantPubkey ||
        plan.network !== input.network
      )
        throw new RoutingPaused("authorization_changed")
      const lifecycle = await readOrder(input.orderId)
      assertCurrent()
      const preparation = readPreparation(input.checkoutId)
      const initialRecovery = preparation?.recoveryHandoffId
        ? readInitialRecovery(preparation.recoveryHandoffId)
        : null
      const configuration = sparkConfiguration()
      if (
        configuration.status !== "ready" ||
        configuration.network !== plan.network
      ) {
        throw new RoutingPaused("authorization_changed")
      }
      const control = assessCheckoutSparkSettledOrderControl({
        lifecycle,
        preparation,
        snapshot: { ...snapshot, state },
        buyerPubkey: input.buyerPubkey,
        guestIdentity: input.guestIdentity
          ? input.currentGuestIdentity?.()
          : null,
        initialRecoverySenderPubkey:
          initialRecovery?.record.senderPubkey ?? null,
        initialRecoveryAcked: Boolean(
          initialRecovery?.deliveryProgress.acknowledgedRelayRefs.length
        ),
        routerWalletOpen: sparkManager()?.isOpen(plan.walletId) === true,
        nativeAdmissionScope: repository.nativeTreasuryAdmissionScope,
        now: now(),
      })
      assertCurrent()
      if (control.status === "blocked" || control.status === "retired") {
        throw new RoutingPaused("authorization_changed")
      }
      if (control.status === "complete") return { status: "complete" }
      if (now() >= reconciliationDeadline)
        return { status: "paused", reason: "reconciliation_timeout" }
      remainingSteps ??= state.legs.length * 2 + poll.attempts + 1
      if (remainingSteps-- <= 0) throw new RoutingPaused("step_limit")
      const funding =
        control.status === "pay_funding" || control.status === "check_funding"
      const inspecting =
        control.status === "check_payout" ||
        control.status === "payout_window_insufficient"
      input.onProgress?.({
        phase: funding
          ? "funding"
          : control.status === "prepare_payout"
            ? "preparing"
            : inspecting
              ? "checking"
              : "routing",
        paidLegs: control.paidLegs,
        totalLegs: control.totalLegs,
      })
      assertCurrent()
      const canEnterPayer =
        funding &&
        fundingObservations === 0 &&
        input.fundingMode === "pay_once" &&
        control.status === "pay_funding" &&
        input.fundingPayment.inspectionOnly !== true
      const canExposeExternal =
        funding &&
        fundingObservations === 0 &&
        input.fundingPayment.exposeExternalInvoice === true &&
        input.fundingPayment.paymentTarget.type === "manual" &&
        control.externalFundingAvailable === true &&
        (canEnterPayer || preparation?.externalFundingExposedAt !== undefined)
      if (funding) fundingObservations += 1
      const result = await advanceCheckoutSparkSettledShopper(
        {
          ...base,
          legId: control.legId,
          inspectionOnly: inspecting,
          fundingPayment: canExposeExternal
            ? { ...base.fundingPayment, inspectionOnly: false }
            : canEnterPayer
              ? base.fundingPayment
              : {
                  buyerPubkey: input.buyerPubkey,
                  shouldContinue: base.fundingPayment.shouldContinue,
                  paymentTarget: { type: "manual" },
                  inspectionOnly: true,
                  exposeExternalInvoice: false,
                  timeoutMs: base.fundingPayment.timeoutMs,
                  appId: base.fundingPayment.appId,
                },
        },
        { ...dependencies, repository }
      ).catch((error: unknown) => {
        assertCurrent()
        throw error
      })
      assertCurrent()
      if (result.status === "funding") {
        if (result.funding.status === "funded") continue
        if (result.funding.status === "external_ready") {
          externalInvoice = Object.freeze({ ...result.funding.externalInvoice })
          input.onExternalInvoice?.(externalInvoice)
          assertCurrent()
        } else if (
          result.funding.status === "payment_retryable" ||
          (canEnterPayer && result.funding.status === "manual_required")
        ) {
          return { status: "paused", reason: "funding_action_stopped" }
        }
        if (!(await waitForPendingObservation())) {
          return {
            status: "funding_pending",
            ...(externalInvoice ? { externalInvoice } : {}),
          }
        }
        continue
      }
      if (result.status === "payout_prepared") continue
      if (
        result.step.outcome === "paid" ||
        result.step.outcome === "already_paid"
      )
        continue
      // The one-step engine owns the durable possible-send marker and exact
      // intent. Re-entering it can inspect that same attempt, never replay it.
      // Exact ACK/fee availability outages are also nonterminal. Re-entering still
      // requires the original binding, objective authority and saved intent.
      // Conflicting, failed, expired-authority and fee-policy results stop here.
      if (
        (result.step.reason === "provider_evidence_unavailable" ||
          result.step.reason === "recovery_handoff_unavailable" ||
          result.step.reason === "fee_unavailable" ||
          result.step.reason === "prior_possible_send" ||
          (result.step.outcome === "send_ambiguous" && !result.step.reason)) &&
        (await waitForPendingObservation())
      )
        continue
      return {
        status: "paused",
        reason: result.step.reason ?? "prior_possible_send",
      }
    }
  }

  return {
    run(input) {
      const key = JSON.stringify([input.checkoutId, input.planDigest])
      if (work || activePlans.has(key))
        return Promise.resolve({ status: "paused", reason: "busy" })
      // Detach all mutable caller data before the first await. Callback identity
      // is pinned, while callbacks themselves observe live session/visibility.
      const captured = {
        ...input,
        authorization: { ...input.authorization },
        guestIdentity: input.guestIdentity ? { ...input.guestIdentity } : null,
        fundingPayment: {
          ...input.fundingPayment,
          paymentTarget: { ...input.fundingPayment.paymentTarget },
        },
        ...(input.fundingPoll ? { fundingPoll: { ...input.fundingPoll } } : {}),
      }
      activePlans.add(key)
      work = execute(captured, ++epoch)
        .catch((error: unknown): CheckoutSparkSettledShopperRunResult => ({
          status: "paused",
          reason: error instanceof RoutingPaused ? error.reason : "unavailable",
        }))
        .finally(() => {
          activePlans.delete(key)
          work = null
        })
      return work
    },
    async pause() {
      epoch += 1
      await work
    },
  }
}
