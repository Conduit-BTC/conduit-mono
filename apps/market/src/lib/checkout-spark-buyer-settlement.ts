import { queryOptions } from "@tanstack/react-query"
import {
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkRetiredSettlementSummary,
  isGuestOrderDataExpired,
  projectCheckoutSparkMerchantSettlement,
  restoreCheckoutSparkBuyerOrderBinding,
  restoreCheckoutSparkMerchantSettlementRecord,
  restoreCheckoutSparkRetiredSettlementSummary,
  restoreCheckoutSparkSettledReconciliation,
  validateCheckoutSparkRetiredSettlementRecord,
  type CheckoutSparkBuyerOrderBinding,
  type CheckoutSparkBuyerSettlementRepositorySnapshot,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkRetiredSettlementSummary,
  type CheckoutSparkSettledRepositorySnapshot,
  type OrderLifecycle,
} from "@conduit/core"
import {
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"
import {
  createCheckoutSparkPaymentReceipt,
  type CheckoutSparkPaymentReceipt,
} from "./checkout-spark-payment-receipt"

export type { CheckoutSparkPaymentReceipt } from "./checkout-spark-payment-receipt"

export interface CheckoutSparkBuyerSettlement {
  readonly commerceVerified: boolean
  readonly merchantVerified: boolean
  readonly feePending: boolean
  readonly recipientUnverified?: boolean
  readonly receipt?: CheckoutSparkPaymentReceipt | null
}

export const BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY =
  "buyer-spark-order-settlements"
export const NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS: ReadonlyMap<
  string,
  CheckoutSparkBuyerSettlement
> = new Map()

function hasCurrentBuyerIdentity(
  lifecycle: OrderLifecycle | null | undefined,
  buyerPubkey: string | null,
  guestIdentity: GuestOrderSigningIdentity | null | undefined,
  now: number
): boolean {
  if (!lifecycle || lifecycle.buyerPubkey !== buyerPubkey) return false
  if (lifecycle.buyerIdentityKind === "signed_in") return !guestIdentity
  return (
    lifecycle.buyerIdentityKind === "guest_ephemeral" &&
    lifecycle.guestSessionExpiresAt === guestIdentity?.expiresAt &&
    isCurrentGuestOrderSigningIdentity(
      guestIdentity,
      {
        orderId: lifecycle.orderId,
        merchantPubkey: lifecycle.merchantPubkey,
        pubkey: buyerPubkey ?? undefined,
      },
      now
    ) &&
    Number.isSafeInteger(lifecycle.createdAt) &&
    lifecycle.createdAt >= guestIdentity.createdAt &&
    lifecycle.createdAt <= now &&
    !isGuestOrderDataExpired(lifecycle, now) &&
    lifecycle.shippingAddress === undefined &&
    lifecycle.contactNote === undefined &&
    lifecycle.guestContact === undefined
  )
}

/**
 * Buyer-local provider facts, not a buyer message, generic paid status, or
 * inferred wallet balance. The separate settlement record must be written
 * from exact provider observations; V3 reconciliation progress alone does not
 * carry that provenance and is never payment authority here.
 */
export function assessCheckoutSparkBuyerSettlement(input: {
  lifecycle: OrderLifecycle | null | undefined
  buyerPubkey: string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  now?: number
  snapshot:
    | CheckoutSparkSettledRepositorySnapshot
    | CheckoutSparkBuyerSettlementRepositorySnapshot
  settlement: CheckoutSparkMerchantSettlementRecord | null
}): CheckoutSparkBuyerSettlement | null {
  const { lifecycle, buyerPubkey, snapshot, settlement } = input
  const binding = lifecycle?.checkoutSparkRouterBinding
  if (
    !lifecycle ||
    !binding ||
    !buyerPubkey ||
    !/^[0-9a-f]{64}$/.test(buyerPubkey) ||
    !hasCurrentBuyerIdentity(
      lifecycle,
      buyerPubkey,
      input.guestIdentity,
      input.now ?? Date.now()
    ) ||
    lifecycle.buyerPubkey !== buyerPubkey ||
    lifecycle.checkoutMode !== "private_checkout" ||
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.currency !== "SATS" ||
    snapshot.status !== "active" ||
    !settlement
  ) {
    return null
  }

  try {
    const state = restoreCheckoutSparkSettledReconciliation(snapshot.state)
    const { plan } = state
    if (
      plan.schemaVersion !== 3 ||
      plan.checkoutId !== binding.checkoutId ||
      plan.planDigest !== binding.planDigest ||
      plan.walletId !== binding.walletId ||
      plan.orderId !== lifecycle.orderId ||
      plan.merchantPubkey !== lifecycle.merchantPubkey ||
      plan.commerceQuote.commerceTotalSats !== lifecycle.totalSats ||
      (lifecycle.buyerIdentityKind === "guest_ephemeral" &&
        lifecycle.createdAt < plan.createdAt) ||
      !state.credit
    ) {
      return null
    }
    const summary = createCheckoutSparkRetiredSettlementSummary(state)
    const record = validateCheckoutSparkRetiredSettlementRecord(
      summary,
      restoreCheckoutSparkMerchantSettlementRecord(settlement, plan)
    )
    if (
      !record.credit ||
      record.credit.transferId !== state.credit.transferId ||
      record.credit.creditedSats !== state.credit.creditedSats
    ) {
      return null
    }
    const receipt = createCheckoutSparkPaymentReceipt(summary, record)
    if (!receipt) return null
    const verified = projectCheckoutSparkMerchantSettlement(record)
    return {
      commerceVerified: verified.commerceVerified,
      merchantVerified: verified.merchantVerified,
      feePending: verified.feePending,
      recipientUnverified: verified.recipientUnverified,
      receipt,
    }
  } catch {
    return null
  }
}

/** A retained attribution summary cannot replace buyer binding or provider facts. */
export function assessCheckoutSparkRetiredBuyerSettlement(input: {
  lifecycle: OrderLifecycle | null | undefined
  buyerPubkey: string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  now?: number
  buyerBinding: CheckoutSparkBuyerOrderBinding | null
  summary: CheckoutSparkRetiredSettlementSummary | null
  settlement: CheckoutSparkMerchantSettlementRecord | null
}): CheckoutSparkBuyerSettlement | null {
  const { lifecycle, buyerPubkey, buyerBinding, summary, settlement } = input
  const binding = lifecycle?.checkoutSparkRouterBinding
  if (
    !lifecycle ||
    !binding ||
    !buyerPubkey ||
    !/^[0-9a-f]{64}$/.test(buyerPubkey) ||
    !hasCurrentBuyerIdentity(
      lifecycle,
      buyerPubkey,
      input.guestIdentity,
      input.now ?? Date.now()
    ) ||
    lifecycle.buyerPubkey !== buyerPubkey ||
    lifecycle.checkoutMode !== "private_checkout" ||
    lifecycle.orderDeliveryStatus !== "sent" ||
    lifecycle.currency !== "SATS" ||
    !buyerBinding ||
    !summary ||
    !settlement
  ) {
    return null
  }

  try {
    const saved = restoreCheckoutSparkBuyerOrderBinding(buyerBinding)
    const retained = restoreCheckoutSparkRetiredSettlementSummary(summary)
    if (
      saved.buyerPubkey !== buyerPubkey ||
      saved.checkoutId !== binding.checkoutId ||
      saved.planDigest !== binding.planDigest ||
      saved.walletId !== binding.walletId ||
      saved.orderId !== lifecycle.orderId ||
      saved.merchantPubkey !== lifecycle.merchantPubkey ||
      saved.commerceTotalSats !== lifecycle.totalSats ||
      retained.checkoutId !== saved.checkoutId ||
      retained.planDigest !== saved.planDigest ||
      retained.walletId !== saved.walletId ||
      retained.orderId !== saved.orderId ||
      retained.merchantPubkey !== saved.merchantPubkey ||
      retained.commerceTotalSats !== saved.commerceTotalSats
    ) {
      return null
    }
    const record = validateCheckoutSparkRetiredSettlementRecord(
      retained,
      settlement
    )
    const receipt = createCheckoutSparkPaymentReceipt(retained, record)
    // Legacy incomplete records still expose their existing assessment flags.
    // Missing credited funds omit the receipt, not the already validated facts.
    const verified = projectCheckoutSparkMerchantSettlement(record)
    return {
      commerceVerified: verified.commerceVerified,
      merchantVerified: verified.merchantVerified,
      feePending: verified.feePending,
      recipientUnverified: verified.recipientUnverified,
      receipt,
    }
  } catch {
    return null
  }
}

type BuyerSettlementRepository = Pick<
  DexieCheckoutSparkSettledRepository,
  "loadBuyerSettlement"
>

export interface CheckoutSparkBuyerSettlementQueryInput {
  enabled: boolean
  lifecycles: readonly OrderLifecycle[]
  buyerPubkey: string | null
  guestIdentity?: GuestOrderSigningIdentity | null
  currentGuestIdentity?: () => GuestOrderSigningIdentity | null
  now?: () => number
  authGeneration: number
  isAuthGenerationCurrent(generation: number): boolean
  repository?: BuyerSettlementRepository
}

/** Include every exact local order/plan binding so a cached row cannot cross accounts. */
export function getCheckoutSparkBuyerSettlementQueryOptions(
  input: CheckoutSparkBuyerSettlementQueryInput
) {
  const buyerPubkey = input.buyerPubkey
  const guestIdentity = input.guestIdentity ? { ...input.guestIdentity } : null
  const currentGuestIdentity = input.currentGuestIdentity
  const now = input.now ?? Date.now
  const authGeneration = input.authGeneration
  const isAuthGenerationCurrent = input.isAuthGenerationCurrent
  const currentSessionMatches = () => {
    try {
      if (!isAuthGenerationCurrent(authGeneration)) return false
      if (!guestIdentity) return true
      const scope = {
        orderId: guestIdentity.orderId,
        merchantPubkey: guestIdentity.merchantPubkey,
        pubkey: buyerPubkey ?? undefined,
      }
      const current = currentGuestIdentity?.() ?? null
      const time = now()
      return (
        isCurrentGuestOrderSigningIdentity(guestIdentity, scope, time) &&
        isCurrentGuestOrderSigningIdentity(current, scope, time) &&
        current.createdAt === guestIdentity.createdAt &&
        current.expiresAt === guestIdentity.expiresAt
      )
    } catch {
      return false
    }
  }
  const capturedAt = now()
  const candidates = input.lifecycles
    .filter(
      (lifecycle) =>
        lifecycle.checkoutSparkRouterBinding !== undefined &&
        hasCurrentBuyerIdentity(
          lifecycle,
          buyerPubkey,
          guestIdentity,
          capturedAt
        )
    )
    .map((lifecycle) => ({
      ...lifecycle,
      checkoutSparkRouterBinding: { ...lifecycle.checkoutSparkRouterBinding! },
    }))
  const identities = candidates
    .map((lifecycle) => ({
      orderId: lifecycle.orderId,
      buyerPubkey: lifecycle.buyerPubkey,
      merchantPubkey: lifecycle.merchantPubkey,
      checkoutMode: lifecycle.checkoutMode,
      buyerIdentityKind: lifecycle.buyerIdentityKind,
      createdAt: lifecycle.createdAt,
      guestSessionExpiresAt: lifecycle.guestSessionExpiresAt,
      orderDeliveryStatus: lifecycle.orderDeliveryStatus,
      currency: lifecycle.currency,
      totalSats: lifecycle.totalSats,
      checkoutId: lifecycle.checkoutSparkRouterBinding!.checkoutId,
      planDigest: lifecycle.checkoutSparkRouterBinding!.planDigest,
      walletId: lifecycle.checkoutSparkRouterBinding!.walletId,
    }))
    .sort(
      (left, right) =>
        left.orderId.localeCompare(right.orderId) ||
        left.checkoutId.localeCompare(right.checkoutId) ||
        left.planDigest.localeCompare(right.planDigest)
    )
  const readEnabled =
    input.enabled &&
    /^[0-9a-f]{64}$/.test(buyerPubkey ?? "") &&
    candidates.length > 0 &&
    currentSessionMatches()

  return queryOptions({
    queryKey: [
      BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY,
      buyerPubkey,
      authGeneration,
      guestIdentity
        ? {
            orderId: guestIdentity.orderId,
            merchantPubkey: guestIdentity.merchantPubkey,
            pubkey: guestIdentity.pubkey,
            createdAt: guestIdentity.createdAt,
            expiresAt: guestIdentity.expiresAt,
          }
        : null,
      identities,
    ] as const,
    enabled: readEnabled,
    queryFn: async ({ signal }) => {
      const assertCurrent = () => {
        if (
          !readEnabled ||
          !input.enabled ||
          signal.aborted ||
          !currentSessionMatches()
        ) {
          throw new DOMException(
            "Buyer settlement read cancelled",
            "AbortError"
          )
        }
      }
      assertCurrent()
      const repository =
        input.repository ?? new DexieCheckoutSparkSettledRepository()
      const counts = new Map<string, number>()
      for (const candidate of candidates) {
        counts.set(candidate.orderId, (counts.get(candidate.orderId) ?? 0) + 1)
      }
      const byOrder = new Map<string, CheckoutSparkBuyerSettlement>()
      for (const lifecycle of candidates) {
        assertCurrent()
        // Conflicting same-order local rows never select a winner by iteration.
        if (counts.get(lifecycle.orderId) !== 1) continue
        const binding = lifecycle.checkoutSparkRouterBinding!
        const snapshot = await repository.loadBuyerSettlement(
          binding.checkoutId,
          binding.planDigest,
          buyerPubkey!
        )
        assertCurrent()
        if (snapshot.status === "absent") continue
        const projection =
          snapshot.status === "active"
            ? assessCheckoutSparkBuyerSettlement({
                lifecycle,
                buyerPubkey,
                guestIdentity,
                now: now(),
                snapshot,
                settlement: snapshot.settlement,
              })
            : assessCheckoutSparkRetiredBuyerSettlement({
                lifecycle,
                buyerPubkey,
                guestIdentity,
                now: now(),
                buyerBinding: snapshot.buyerBinding,
                summary: snapshot.summary,
                settlement: snapshot.settlement,
              })
        if (projection) byOrder.set(lifecycle.orderId, projection)
      }
      assertCurrent()
      return byOrder as ReadonlyMap<string, CheckoutSparkBuyerSettlement>
    },
    retry: false,
    staleTime: 5_000,
    gcTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}
