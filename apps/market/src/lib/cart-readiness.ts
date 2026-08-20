import type { LnurlPayMetadata } from "@conduit/core"

/**
 * Navigation freshness lease for prepared per-merchant cart evidence.
 *
 * Within this window, HUD -> cart -> checkout handoffs reuse the same
 * prepared availability read instead of remounting a new blocking query.
 * The lease exists for responsive presentation and route handoff only; it
 * never authorizes payment. Checkout still performs one authoritative live
 * listing refresh immediately before order publication.
 */
export const CART_READINESS_LEASE_MS = 30_000

/**
 * Short lease for merchant LNURL-pay metadata warmed while a merchant has
 * items in the cart. Expiry or a changed Lightning address causes a refresh.
 * Invoice creation stays bound to the exact final amount and an explicit
 * payment action; the metadata preflight is a capability read only.
 */
export const LNURL_METADATA_LEASE_MS = 60_000

/** Per-endpoint timeout so one slow LNURL server only affects its merchant. */
export const LNURL_PREFLIGHT_TIMEOUT_MS = 8_000

/** Bounded fanout across merchants for prepared cart reads. */
export const CART_READINESS_MAX_CONCURRENT_READS = 3

/**
 * Explicit per-merchant readiness states. Initial loading and background
 * refresh are never collapsed into one boolean: `checking` means the merchant
 * has no usable evidence yet, while `refreshing` keeps current evidence
 * actionable during a nonblocking revalidation.
 */
export type MerchantCartReadinessState =
  | "not_started"
  | "checking"
  | "ready"
  | "refreshing"
  | "degraded"
  | "stale"
  | "blocked"

export type MerchantCartReadinessStateInput = {
  enabled: boolean
  hasEvidence: boolean
  initialLoading: boolean
  backgroundRefreshing: boolean
  /** Verified complete commerce read (source, coverage, deletion stages). */
  fresh: boolean
  /** Hard availability blocker: sold out, insufficient stock, deletion. */
  blocked: boolean
  evidenceAgeMs: number | null
}

export function deriveMerchantCartReadinessState(
  input: MerchantCartReadinessStateInput
): MerchantCartReadinessState {
  if (!input.enabled) return "not_started"
  if (!input.hasEvidence) {
    return input.initialLoading || input.backgroundRefreshing
      ? "checking"
      : "degraded"
  }
  if (input.blocked) return "blocked"
  if (input.backgroundRefreshing) return "refreshing"
  if (!input.fresh) return "degraded"
  if (
    input.evidenceAgeMs !== null &&
    input.evidenceAgeMs > CART_READINESS_LEASE_MS
  ) {
    return "stale"
  }
  return "ready"
}

/** Named reasons Zap Out is unavailable while ordinary checkout remains open. */
export type MerchantZapBlocker =
  | "listing_freshness_unavailable"
  | "shopper_preset_unavailable"
  | "wallet_unavailable"
  | "price_unavailable"
  | "shipping_unavailable"
  | "merchant_lightning_unavailable"
  | "lnurl_metadata_unavailable"
  | "amount_out_of_range"

export type MerchantCheckoutCapabilityOutcome =
  "preparing" | "zap_candidate" | "checkout_required" | "blocked"

export type MerchantLnurlPreflightStatus =
  "no_address" | "pending" | "ready" | "unavailable"

export type MerchantLnurlPreflight = {
  status: MerchantLnurlPreflightStatus
  metadata: LnurlPayMetadata | null
}

export type MerchantCheckoutCapabilityInput = {
  readiness: MerchantCartReadinessState
  /** Concrete stock/deletion message when availability blocks checkout. */
  blockingMessage: string | null
  listingTermsCurrent: boolean
  shopperPresetReady: boolean
  walletReady: boolean
  itemPricesAvailable: boolean
  shippingReady: boolean
  lnurl: MerchantLnurlPreflight
  totalMsats: number | null
}

export type MerchantCheckoutCapability = {
  outcome: MerchantCheckoutCapabilityOutcome
  blockers: MerchantZapBlocker[]
  /** User-facing reason for `blocked`, otherwise null. */
  blockedReason: string | null
}

/**
 * One pure capability derivation shared by the HUD, the cart route, and
 * checkout so the surfaces cannot disagree about Zap Out eligibility.
 *
 * `zap_candidate` is derived from an empty blocker list rather than stored
 * beside it, so contradictory states cannot be constructed. The payment
 * service remains authoritative for final URL safety, amount range, invoice
 * validation, NIP-57 binding, wallet execution, order-before-funds, and
 * duplicate-payment protection.
 */
export function deriveMerchantCheckoutCapability(
  input: MerchantCheckoutCapabilityInput
): MerchantCheckoutCapability {
  if (input.readiness === "blocked" || input.blockingMessage) {
    return {
      outcome: "blocked",
      blockers: [],
      blockedReason:
        input.blockingMessage ??
        "An item in this cart is unavailable. Review the cart before checkout.",
    }
  }
  if (
    input.readiness === "not_started" ||
    input.readiness === "checking" ||
    input.lnurl.status === "pending"
  ) {
    return { outcome: "preparing", blockers: [], blockedReason: null }
  }

  const blockers: MerchantZapBlocker[] = []
  const listingUsable =
    input.readiness === "ready" || input.readiness === "refreshing"
  if (!listingUsable || !input.listingTermsCurrent) {
    blockers.push("listing_freshness_unavailable")
  }
  if (!input.shopperPresetReady) blockers.push("shopper_preset_unavailable")
  if (!input.walletReady) blockers.push("wallet_unavailable")
  if (!input.itemPricesAvailable) blockers.push("price_unavailable")
  if (!input.shippingReady) blockers.push("shipping_unavailable")
  if (input.lnurl.status === "no_address") {
    blockers.push("merchant_lightning_unavailable")
  } else if (input.lnurl.status === "unavailable" || !input.lnurl.metadata) {
    blockers.push("lnurl_metadata_unavailable")
  } else if (
    input.totalMsats === null ||
    input.totalMsats < input.lnurl.metadata.minSendable ||
    input.totalMsats > input.lnurl.metadata.maxSendable
  ) {
    blockers.push(
      input.totalMsats === null ? "price_unavailable" : "amount_out_of_range"
    )
  }

  return {
    outcome: blockers.length === 0 ? "zap_candidate" : "checkout_required",
    blockers: Array.from(new Set(blockers)),
    blockedReason: null,
  }
}

export function getMerchantCapabilityFallbackMessage(
  capability: MerchantCheckoutCapability
): string {
  if (capability.outcome === "blocked") {
    return (
      capability.blockedReason ??
      "An item in this cart is unavailable. Review the cart before checkout."
    )
  }
  if (capability.outcome === "preparing") {
    return "Checking merchant payment readiness."
  }
  if (capability.outcome === "zap_candidate") {
    return "Ready to zap out. Checkout confirms the merchant payment endpoint before paying."
  }
  if (capability.blockers.includes("price_unavailable")) {
    return "Checkout is needed to refresh the cart total."
  }
  if (capability.blockers.includes("shipping_unavailable")) {
    return "Checkout is needed to confirm shipping."
  }
  if (
    capability.blockers.includes("merchant_lightning_unavailable") ||
    capability.blockers.includes("lnurl_metadata_unavailable")
  ) {
    return "Checkout is needed to choose an available payment path."
  }
  if (capability.blockers.includes("amount_out_of_range")) {
    return "Checkout is needed because this total is outside the merchant's Lightning limits."
  }
  if (capability.blockers.includes("wallet_unavailable")) {
    return "Checkout is needed because an automatic wallet payment is not ready."
  }
  return "Checkout is needed to confirm shipping and payment readiness."
}

/**
 * Bounded-concurrency limiter shared by prepared cart reads so a wide cart
 * cannot start an unbounded relay/network wave. FIFO, no starvation.
 */
export function createBoundedLimiter(
  maxConcurrent: number
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []

  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
  }

  const releaseSlot = (): void => {
    active -= 1
    waiting.shift()?.()
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      releaseSlot()
    }
  }
}
