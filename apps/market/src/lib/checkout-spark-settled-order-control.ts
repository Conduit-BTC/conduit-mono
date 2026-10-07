import {
  calculateConduitCheckoutFeeSats,
  checkoutSparkProviderSendWindowEndsAt,
  fingerprintCheckoutSparkSettledLegIntent,
  hasCheckoutSparkProviderSendWindow,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRepositorySnapshot,
  type CheckoutSparkBuyerPrice,
  type OrderLifecycle,
} from "@conduit/core"

import type { StoredCheckoutSparkSettledPreparation } from "./checkout-spark-settled-preparation"
import {
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"

/** Review of the validated v3 intent and its frozen public destination. */
export interface CheckoutSparkSettledPayoutReview {
  readonly recipientKind: "merchant" | "supplier" | "organizer" | "conduit"
  readonly sourceLabel: "Signed recipient profile" | "Conduit allowlist"
  readonly destinationLabel:
    | "Frozen Lightning destination"
    | "Frozen Conduit destination (local test)"
    | "Frozen Conduit destination (production)"
  readonly lightningDestination: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
  readonly allocationSats: number
}

/** Buyer-approved accounting only; provider destinations and requests stay private. */
export interface CheckoutSparkSettledNativeTreasuryReview {
  readonly estimatedBaseConduitAllocationSats: number
  readonly fixedCheckoutTotalSats: number
  readonly prepared: null | {
    readonly baseConduitAllocationSats: number
    readonly unusedCommerceReserveSats: number
    readonly totalSats: number
    readonly sparkFeeCapSats: 0
  }
}

export type CheckoutSparkSettledOrderControlState =
  | { status: "blocked"; reason: string }
  /** A cleanup tombstone is not evidence that any recipient was paid. */
  | { status: "retired" }
  | {
      status: "complete"
      paidLegs: number
      totalLegs: number
      priceSummary: CheckoutSparkBuyerPrice
      nativeTreasury: CheckoutSparkSettledNativeTreasuryReview | null
      /** Eligibility to inspect only; this does not authorize retirement. */
      retirement: {
        checkoutId: string
        planDigest: string
        network: "mainnet" | "regtest"
      } | null
    }
  | {
      status:
        | "pay_funding"
        | "check_funding"
        | "prepare_payout"
        | "route_payout"
        | "payout_window_insufficient"
        | "check_payout"
      checkoutId: string
      planDigest: string
      walletId: string
      network: "mainnet" | "regtest"
      grossFundingSats: number
      priceSummary: CheckoutSparkBuyerPrice
      creditedSats: number | null
      paidLegs: number
      totalLegs: number
      legId: string | null
      recipientKind: "merchant" | "supplier" | "organizer" | "conduit" | null
      allocationSats: number | null
      payoutReview: CheckoutSparkSettledPayoutReview | null
      nativeTreasury: CheckoutSparkSettledNativeTreasuryReview | null
      /** Internal exact-intent comparison; not presentation data. */
      intentFingerprint: string | null
      fundingExpiresAt: number
      /** Offer only a new manual reservation or this checkout's own disclosure. */
      externalFundingAvailable?: boolean
      sendWindowEndsAt: number | null
    }

/** Read-only presentation; the click handler must reload every authority. */
export function assessCheckoutSparkSettledOrderControl(input: {
  lifecycle: OrderLifecycle | null | undefined
  preparation: StoredCheckoutSparkSettledPreparation | null
  snapshot: CheckoutSparkSettledRepositorySnapshot
  buyerPubkey: string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  initialRecoverySenderPubkey: string | null
  initialRecoveryAcked: boolean
  now: number
  routerWalletOpen: boolean
}): CheckoutSparkSettledOrderControlState {
  const blocked = (reason: string): CheckoutSparkSettledOrderControlState => ({
    status: "blocked",
    reason,
  })
  const {
    lifecycle,
    preparation,
    snapshot,
    buyerPubkey,
    initialRecoverySenderPubkey,
    initialRecoveryAcked,
    now,
  } = input
  const binding = lifecycle?.checkoutSparkRouterBinding
  const identityActive =
    lifecycle?.buyerIdentityKind === "signed_in"
      ? !input.guestIdentity
      : lifecycle?.buyerIdentityKind === "guest_ephemeral" &&
        lifecycle.guestSessionExpiresAt === input.guestIdentity?.expiresAt &&
        isCurrentGuestOrderSigningIdentity(
          input.guestIdentity,
          {
            orderId: lifecycle.orderId,
            merchantPubkey: lifecycle.merchantPubkey,
            pubkey: buyerPubkey ?? undefined,
          },
          now
        )
  if (
    !lifecycle ||
    !binding ||
    !buyerPubkey ||
    !identityActive ||
    lifecycle.buyerPubkey !== buyerPubkey ||
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.phase === "cancelled"
  ) {
    return blocked("This order no longer has an active buyer checkout session.")
  }
  if (snapshot.status === "retired") {
    return snapshot.planDigest === binding.planDigest &&
      Number.isSafeInteger(snapshot.retiredAt) &&
      snapshot.retiredAt >= 0 &&
      Number.isSafeInteger(now) &&
      now >= snapshot.retiredAt
      ? { status: "retired" }
      : blocked(
          "The saved checkout and order no longer match. Do not pay again."
        )
  }
  if (initialRecoverySenderPubkey !== buyerPubkey || !initialRecoveryAcked) {
    return blocked("This order no longer has an active buyer checkout session.")
  }
  if (snapshot.status !== "active" || !preparation) {
    return blocked("The saved checkout state is unavailable. Do not pay again.")
  }
  let state
  try {
    state = restoreCheckoutSparkSettledReconciliation(snapshot.state)
  } catch {
    return blocked(
      "The saved checkout evidence is inconsistent. Do not pay again."
    )
  }
  const { plan } = state
  if (
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) ||
    plan.checkoutId !== binding.checkoutId ||
    plan.planDigest !== binding.planDigest ||
    plan.walletId !== binding.walletId ||
    plan.orderId !== lifecycle.orderId ||
    plan.merchantPubkey !== lifecycle.merchantPubkey ||
    plan.commerceQuote.commerceTotalSats !== lifecycle.totalSats ||
    lifecycle.currency !== "SATS" ||
    preparation.schemaVersion !== 3 ||
    preparation.checkoutId !== plan.checkoutId ||
    preparation.planDigest !== plan.planDigest ||
    !preparation.recoveryHandoffId ||
    preparation.fundingInvoiceExposedAt === null ||
    preparation.fundingInvoiceExposedAt >= plan.funding.expiresAt
  ) {
    return blocked(
      "The saved checkout and order no longer match. Do not pay again."
    )
  }
  if (!Number.isSafeInteger(now) || now < plan.createdAt) {
    return blocked(
      "The checkout clock is unavailable. Reopen this order later."
    )
  }
  const paidLegs = state.legs.filter((leg) => leg.status === "paid").length
  const totalLegs = state.legs.length
  const conduitFeeSats = plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )!.weightSats
  // Use validated frozen economics, not a new quote. Historical pre-allowance
  // plans keep their exact saved total and are never repriced on reopen.
  const priceSummary: CheckoutSparkBuyerPrice = Object.freeze({
    itemSubtotalSats: plan.commerceQuote.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitMerchandiseSats,
      0
    ),
    shippingSubtotalSats: plan.commerceQuote.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitShippingSats,
      0
    ),
    commerceTotalSats: plan.commerceQuote.commerceTotalSats,
    conduitFeeSats,
    totalSats: plan.funding.grossFundingSats,
    coordinationFeeSats:
      plan.funding.grossFundingSats - plan.commerceQuote.commerceTotalSats,
    networkAllowanceSats:
      plan.funding.grossFundingSats -
      plan.commerceQuote.commerceTotalSats -
      conduitFeeSats,
    minimumApplies: conduitFeeSats === calculateConduitCheckoutFeeSats(1),
  })
  const treasuryFinalization = state.treasuryFinalization ?? null
  if (plan.schemaVersion === 4 && !treasuryFinalization) {
    return blocked("The saved native treasury state is unavailable.")
  }
  const nativeTreasury: CheckoutSparkSettledNativeTreasuryReview | null =
    plan.schemaVersion === 4
      ? {
          estimatedBaseConduitAllocationSats: conduitFeeSats,
          fixedCheckoutTotalSats: priceSummary.totalSats,
          prepared: treasuryFinalization!.intent
            ? {
                baseConduitAllocationSats:
                  treasuryFinalization!.intent.baseConduitAllocationSats,
                unusedCommerceReserveSats:
                  treasuryFinalization!.intent.unusedCommerceReserveSats,
                totalSats: treasuryFinalization!.intent.amountSats,
                sparkFeeCapSats: 0,
              }
            : null,
        }
      : null
  if (paidLegs === totalLegs) {
    return {
      status: "complete",
      paidLegs,
      totalLegs,
      priceSummary,
      nativeTreasury,
      retirement:
        input.routerWalletOpen && now < plan.takeoverAt
          ? {
              checkoutId: plan.checkoutId,
              planDigest: plan.planDigest,
              network: plan.network,
            }
          : null,
    }
  }
  const nativeTreasuryPending =
    plan.schemaVersion === 4 &&
    state.legs.every((leg, index) =>
      plan.recipients[index]!.kind === "conduit"
        ? leg.status !== "paid"
        : leg.status === "paid"
    )
  if (
    (lifecycle.phase === "completed" || lifecycle.paymentStatus === "paid") &&
    !nativeTreasuryPending
  ) {
    return blocked("This order no longer has an active buyer checkout session.")
  }
  if (state.credit && now >= plan.takeoverAt) {
    return blocked(
      "Shopper routing authority moved to the merchant. Do not pay again."
    )
  }
  if (!input.routerWalletOpen) {
    return blocked(
      "This browser no longer has the temporary Spark wallet open. Coordinate recovery with the merchant."
    )
  }
  const shared = {
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    walletId: plan.walletId,
    network: plan.network,
    grossFundingSats: plan.funding.grossFundingSats,
    priceSummary,
    nativeTreasury,
    creditedSats: state.credit?.creditedSats ?? null,
    paidLegs,
    totalLegs,
    fundingExpiresAt: plan.funding.expiresAt,
    externalFundingAvailable:
      !state.credit &&
      now < plan.funding.expiresAt &&
      (preparation.fundingSubmissionState === "not_started" ||
        preparation.externalFundingExposedAt !== undefined),
    sendWindowEndsAt: null,
  }
  if (!state.credit) {
    if (
      preparation.fundingSubmissionState === "provisional" ||
      now >= plan.funding.expiresAt
    ) {
      return {
        ...shared,
        status: "check_funding",
        legId: null,
        recipientKind: null,
        allocationSats: null,
        payoutReview: null,
        intentFingerprint: null,
      }
    }
    return {
      ...shared,
      status: "pay_funding",
      legId: null,
      recipientKind: null,
      allocationSats: null,
      payoutReview: null,
      intentFingerprint: null,
    }
  }
  const index = state.legs.findIndex((leg) => leg.status !== "paid")
  const leg = state.legs[index]
  const recipient = plan.recipients[index]
  if (!leg || !recipient || leg.legId !== recipient.legId) {
    return blocked("The next payout is not in the saved plan.")
  }
  if (
    leg.status === "terminal_failure" ||
    leg.status === "conflicting_evidence"
  ) {
    return blocked(
      "This payout needs manual recovery. Do not create another invoice or send it again."
    )
  }
  const nativeTreasuryLeg =
    plan.schemaVersion === 4 && recipient.kind === "conduit"
  if (leg.status === "prepared" && !leg.intent && !nativeTreasuryLeg) {
    return blocked("The saved payout invoice is unavailable. Do not send it.")
  }
  if (
    nativeTreasuryLeg &&
    leg.status !== "unprepared" &&
    !treasuryFinalization?.intent
  ) {
    return blocked("The saved native treasury intent is unavailable.")
  }
  const sendWindowAvailable =
    leg.status === "prepared" &&
    leg.intent !== null &&
    hasCheckoutSparkProviderSendWindow({
      paymentRequest: leg.intent.paymentRequest,
      nowMs: now,
    })
  const sendWindowEndsAt =
    leg.status === "prepared" && leg.intent
      ? checkoutSparkProviderSendWindowEndsAt(leg.intent.paymentRequest)
      : null
  const payoutReview: CheckoutSparkSettledPayoutReview | null =
    leg.status === "prepared" && leg.intent && leg.allocationSats !== null
      ? {
          recipientKind: recipient.kind,
          sourceLabel:
            recipient.destination.source.type === "signed_profile"
              ? "Signed recipient profile"
              : "Conduit allowlist",
          destinationLabel:
            recipient.destination.source.type === "signed_profile"
              ? "Frozen Lightning destination"
              : recipient.destination.source.policy === "local_router_canary"
                ? "Frozen Conduit destination (local test)"
                : "Frozen Conduit destination (production)",
          lightningDestination: recipient.destination.value,
          invoiceAmountSats: leg.intent.invoiceAmountSats,
          maxFeeSats: leg.intent.maxFeeSats,
          allocationSats: leg.allocationSats,
        }
      : null
  const intentFingerprint =
    nativeTreasuryLeg && treasuryFinalization?.intent
      ? treasuryFinalization.intent.accountingDigest
      : leg.status === "prepared" && leg.intent
        ? fingerprintCheckoutSparkSettledLegIntent(leg.intent)
        : null
  const siblingPossibleSend = state.legs.some(
    (sibling) =>
      sibling.legId !== leg.legId &&
      (sibling.status === "submitted" ||
        sibling.status === "ambiguous" ||
        sibling.status === "lookup_unavailable" ||
        sibling.status === "conflicting_evidence")
  )
  const status =
    leg.status === "unprepared"
      ? "prepare_payout"
      : leg.status === "prepared"
        ? siblingPossibleSend
          ? "check_payout"
          : nativeTreasuryLeg || sendWindowAvailable
            ? "route_payout"
            : "payout_window_insufficient"
        : "check_payout"
  return {
    ...shared,
    status,
    legId: leg.legId,
    recipientKind: recipient.kind,
    allocationSats: leg.allocationSats,
    payoutReview,
    intentFingerprint,
    sendWindowEndsAt,
  }
}

/** Recheck the exact values the buyer saw before starting an irreversible send. */
export function matchesCheckoutSparkSettledOrderControl(input: {
  displayed: CheckoutSparkSettledOrderControlState | null
  current: CheckoutSparkSettledOrderControlState
  bindingPlanDigest: string | undefined
}): boolean {
  const { displayed, current, bindingPlanDigest } = input
  if (
    !displayed ||
    displayed.status === "blocked" ||
    displayed.status === "complete" ||
    displayed.status === "retired" ||
    current.status === "blocked" ||
    current.status === "complete" ||
    current.status === "retired" ||
    current.status !== displayed.status ||
    current.checkoutId !== displayed.checkoutId ||
    current.planDigest !== displayed.planDigest ||
    current.legId !== displayed.legId ||
    current.planDigest !== bindingPlanDigest
  ) {
    return false
  }
  if (displayed.status !== "route_payout") return true
  const reviewed = displayed.payoutReview
  const fresh = current.payoutReview
  if (displayed.nativeTreasury?.prepared || current.nativeTreasury?.prepared) {
    return Boolean(
      displayed.nativeTreasury?.prepared &&
      current.nativeTreasury?.prepared &&
      displayed.intentFingerprint &&
      displayed.intentFingerprint === current.intentFingerprint &&
      displayed.nativeTreasury.estimatedBaseConduitAllocationSats ===
        current.nativeTreasury.estimatedBaseConduitAllocationSats &&
      displayed.nativeTreasury.fixedCheckoutTotalSats ===
        current.nativeTreasury.fixedCheckoutTotalSats &&
      displayed.nativeTreasury.prepared.baseConduitAllocationSats ===
        current.nativeTreasury.prepared.baseConduitAllocationSats &&
      displayed.nativeTreasury.prepared.unusedCommerceReserveSats ===
        current.nativeTreasury.prepared.unusedCommerceReserveSats &&
      displayed.nativeTreasury.prepared.totalSats ===
        current.nativeTreasury.prepared.totalSats
    )
  }
  return Boolean(
    reviewed &&
    fresh &&
    displayed.intentFingerprint &&
    displayed.intentFingerprint === current.intentFingerprint &&
    reviewed.recipientKind === fresh.recipientKind &&
    reviewed.sourceLabel === fresh.sourceLabel &&
    reviewed.destinationLabel === fresh.destinationLabel &&
    reviewed.lightningDestination === fresh.lightningDestination &&
    reviewed.invoiceAmountSats === fresh.invoiceAmountSats &&
    reviewed.maxFeeSats === fresh.maxFeeSats &&
    reviewed.allocationSats === fresh.allocationSats
  )
}
