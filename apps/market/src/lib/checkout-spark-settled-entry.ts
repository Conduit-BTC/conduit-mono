import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  DexieCheckoutSparkSettledRepository,
  getOrderLifecycle,
  retryOrderRelayDelivery,
  deriveCheckoutSparkSignedCommerceObligations,
  calculateConduitCheckoutFeeSats,
  calculateCheckoutSparkSettledGrossFundingSats,
  checkoutSparkConduitFeeRecipient,
  getNdk,
  getShippingDestinationEligibility,
  matchesCheckoutSparkOrderPrice,
  matchesCheckoutSparkCommerceOrderLine,
  matchesCheckoutSparkOrderShippingSnapshot,
  orderSchema,
  resolveCheckoutSparkSignedShipping,
  shippingAddressSchema,
  snapshotCheckoutSparkPlanSourceEvents,
  validateAddressConsistency,
  type CheckoutSparkSettledRecipientInput,
  type CheckoutSparkNetwork,
  type OrderSchema,
  type OrderLifecycle,
  type SignedPublicNostrEvent,
  type CheckoutSparkMerchantPublicZapPolicy,
} from "@conduit/core"

import { buildCheckoutSparkCommerceEvidence } from "./checkout-spark-commerce-evidence"
import {
  publishCheckoutSparkSettledBoundOrder,
  type PublishedCheckoutSparkBoundOrder,
} from "./checkout-spark-bound-order"
import {
  canUseCheckoutSparkLocalRouterCanary,
  getCheckoutSparkSettledTiming,
} from "./checkout-spark-local-router-canary"
import { readCheckoutSparkRecipientPayoutAddress } from "./checkout-spark-recipient-profile"
import {
  CheckoutSparkSettledFundingMetadataPreflightError,
  CheckoutSparkSettledPreparationAbandonedError,
  prepareCheckoutSparkSettledFunding,
  resumeCheckoutSparkSettledFunding,
  type PreparedCheckoutSparkSettledFunding,
} from "./checkout-spark-settled-preparation"
import type { CheckoutSparkQuoteAuthority } from "./checkout-spark-quote-authority"
import type { CheckoutSparkRecoverySigningIdentity } from "./checkout-spark-recovery-handoff"
import { isCurrentGuestOrderSigningIdentity } from "./guest-order-identity"
import { getMixedFulfillmentBlockingMessage } from "./cart-model"
import { getSparkWalletManager } from "./spark-sdk"
import {
  assertStagedOrderLifecycleMatchesRumor,
  prepareBuyerRumor,
} from "./order-publish"
import {
  clearCheckoutSparkSettledContinuation,
  listCheckoutSparkSettledContinuations,
  saveCheckoutSparkSettledContinuation,
  type CheckoutSparkSettledContinuationStorage,
} from "./checkout-spark-settled-continuation"

export {
  isCheckoutSparkSettledCart,
  isCheckoutSparkSettledDigitalCart,
} from "./checkout-spark-settled-cart"

export interface PrepareCheckoutSparkSettledOrderInput {
  checkoutId: string
  orderId: string
  purchaseClaimDigest?: string
  quoteAuthority: CheckoutSparkQuoteAuthority
  buyer: CheckoutSparkRecoverySigningIdentity
  network: CheckoutSparkNetwork
  nowMs: number
  shouldContinue: () => boolean
  note?: string
  guestContact?: OrderSchema["guestContact"]
  shippingAddress?: OrderSchema["shippingAddress"]
  relayAuthMethod?: "nip07" | "nip46"
  merchantPublicZapPolicy?: CheckoutSparkMerchantPublicZapPolicy
  anonymousPublicZap?: boolean
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/

export interface PreparedCheckoutSparkSettledOrder {
  prepared: PreparedCheckoutSparkSettledFunding
  published: PublishedCheckoutSparkBoundOrder
}

/** This failure occurs before the checkout wallet or private order exists. */
export class CheckoutSparkSettledPayoutPreflightError extends Error {
  constructor(readonly reason: string) {
    super(
      `Checkout Spark recipient payout address is not verified (${reason}).`
    )
    this.name = "CheckoutSparkSettledPayoutPreflightError"
  }
}

export function canRetryCheckoutSparkSettledPayoutPreflight(input: {
  cause: unknown
  recoveryState: "absent" | "present" | "unreadable"
}): boolean {
  return (
    (input.cause instanceof CheckoutSparkSettledPayoutPreflightError ||
      input.cause instanceof
        CheckoutSparkSettledFundingMetadataPreflightError) &&
    input.recoveryState === "absent"
  )
}

/** Retry only a preflight or positively abandoned, unexposed preparation. */
export function canRetryCheckoutSparkSettledPreparation(input: {
  cause: unknown
  recoveryState: "absent" | "present" | "unreadable"
  preparationStarted: boolean
}): boolean {
  return (
    input.recoveryState === "absent" &&
    (!input.preparationStarted ||
      canRetryCheckoutSparkSettledPayoutPreflight(input) ||
      input.cause instanceof CheckoutSparkSettledPreparationAbandonedError)
  )
}

type Dependencies = {
  readRecipientPayout?: typeof readCheckoutSparkRecipientPayoutAddress
  prepareFunding?: typeof prepareCheckoutSparkSettledFunding
  publishOrder?: typeof publishCheckoutSparkSettledBoundOrder
  ndk?: ReturnType<typeof getNdk>
  now?: () => number
  continuationStorage?: CheckoutSparkSettledContinuationStorage | null
}

/**
 * V3 checkout: freeze signed commerce endpoints, not short-lived
 * payout invoices. The buyer's ordinary gross invoice remains unexposed until
 * the exact wallet/plan recovery wrap is persisted and relay-acknowledged.
 */
export async function prepareCheckoutSparkSettledOrder(
  input: PrepareCheckoutSparkSettledOrderInput,
  dependencies: Dependencies = {}
): Promise<PreparedCheckoutSparkSettledOrder> {
  // Retain the old input shape only to explicitly reject deferred public modes.
  // Never silently turn an approved public checkout into a private payment.
  if (input.merchantPublicZapPolicy !== undefined || input.anonymousPublicZap) {
    throw new Error("Public routed zaps are not supported in this checkout.")
  }
  const buyer = { ...input.buyer }
  const now = dependencies.now ?? Date.now
  // Keep all line/product/pricing terms stable across the profile reads below.
  const quote = structuredClone(input.quoteAuthority)
  const merchantPubkey = quote.lines[0]?.merchantPubkey ?? ""
  const shouldContinue = () =>
    input.shouldContinue() &&
    (buyer.kind !== "guest_ephemeral" ||
      isCurrentGuestOrderSigningIdentity(
        buyer,
        {
          orderId: input.orderId,
          merchantPubkey,
        },
        now()
      ))
  const assertCurrent = () => {
    if (!shouldContinue()) {
      throw new Error("Checkout Spark buyer session changed.")
    }
  }
  assertCurrent()
  const commerceQuote = buildCheckoutSparkCommerceEvidence(quote)
  // Old event-pickup snapshots are recovery-only after the event-model cutover.
  // The new event-market flow needs its own current signed admission proof.
  if (commerceQuote.lines.some((line) => line.pickup)) {
    throw new Error("Historical pickup checkout terms cannot fund a new order.")
  }
  if (
    !HEX_PUBKEY.test(buyer.pubkey) ||
    !HEX_PUBKEY.test(merchantPubkey) ||
    quote.pricing.status !== "ok" ||
    !quote.pricing.paymentRequired ||
    quote.pricing.shippingCost.status === "manual" ||
    quote.pricing.shippingCost.missingProductIds.length !== 0 ||
    quote.pricing.totalSats <= 0 ||
    quote.pricing.itemSubtotalSats + quote.pricing.shippingCost.totalSats !==
      quote.pricing.totalSats ||
    quote.pricing.totalMsats !== quote.pricing.totalSats * 1_000 ||
    quote.lines.some((line) => line.merchantPubkey !== merchantPubkey) ||
    quote.products.some(
      (product) =>
        product.pubkey !== merchantPubkey ||
        (product.format !== "digital" && product.format !== "physical") ||
        product.type === "variable"
    ) ||
    quote.pricing.items.some(
      (priced) =>
        (priced.format !== "digital" && priced.format !== "physical") ||
        priced.currency !== "SATS" ||
        !matchesCheckoutSparkOrderPrice(priced, commerceQuote.pricing)
    ) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs <= 0 ||
    !Number.isSafeInteger(quote.pricing.totalSats * 1_000)
  ) {
    throw new Error(
      "Quantum Router requires a current final quote from one merchant."
    )
  }

  // Bind every coordinate, signed revision, quantity, amount and allocation
  // before even reading a payout profile. Same-total substitutions cannot pass.
  const commerce = deriveCheckoutSparkSignedCommerceObligations({
    quote: commerceQuote,
    products: quote.products,
    merchantPubkey,
    shippingEvents: quote.shippingSourceEvents,
    pickupSourceEvents: quote.pickupSourceEvents,
    acceptedAtMs: input.nowMs,
  })
  if (getMixedFulfillmentBlockingMessage(quote.pricing.items)) {
    throw new Error(
      "Checkout Spark requires one compatible fulfillment context."
    )
  }
  let addressValidity: OrderLifecycle["addressValidity"] = "not_required"
  let shippingZoneEligibility: OrderLifecycle["shippingZoneEligibility"] =
    "not_required"
  let shippingAddress: OrderSchema["shippingAddress"]
  let shippingTotalSats = 0
  let requiresShipping = false
  let hasPhysicalFulfillment = false
  for (const line of commerceQuote.lines) {
    const product = quote.products.find(
      (candidate) => candidate.id === line.productCoordinate
    )!
    const priced = quote.pricing.items.find(
      (candidate) => candidate.productId === line.productCoordinate
    )!
    const event = product.supplierAllocation?.revisionEvent
    if (!event) throw new Error("Checkout Spark product source is unavailable.")
    const option = resolveCheckoutSparkSignedShipping({
      productEvent: event,
      line,
      shippingEvents: quote.shippingSourceEvents,
      pricing: commerceQuote.pricing,
      acceptedAtMs: input.nowMs,
    })
    if (
      priced.format !== product.format ||
      (priced.fulfillment !== undefined &&
        priced.fulfillment.type !== (option ? "shipping" : "digital"))
    ) {
      throw new Error("Checkout Spark fulfillment changed after validation.")
    }
    if (!option) {
      if (
        priced.shippingCostSats !== undefined ||
        priced.sourceShippingCost !== undefined ||
        priced.shippingOptionId !== undefined ||
        priced.shippingOptionDTag !== undefined ||
        priced.shippingCountries !== undefined ||
        priced.shippingCountryRules !== undefined
      ) {
        throw new Error(
          "Checkout Spark digital fulfillment includes shipping terms."
        )
      }
      continue
    }
    requiresShipping = true
    hasPhysicalFulfillment = true
    if (!matchesCheckoutSparkOrderShippingSnapshot(priced, option, line)) {
      throw new Error(
        "Checkout Spark shipping snapshot changed after validation."
      )
    }
    shippingAddress ??= shippingAddressSchema.parse(input.shippingAddress)
    const validity = validateAddressConsistency(shippingAddress)
    if (!validity.canDirectPay)
      throw new Error("Checkout Spark requires a consistent shipping address.")
    addressValidity = validity.status
    if (
      getShippingDestinationEligibility(shippingAddress, [option]).eligible !==
      true
    ) {
      throw new Error("Checkout Spark shipping destination is not eligible.")
    }
    shippingZoneEligibility = "eligible"
    shippingTotalSats +=
      line.shippingPolicy?.allocatedCostSats ??
      line.unitShippingSats * line.quantity
  }
  const shippingStatus = hasPhysicalFulfillment
    ? shippingTotalSats === 0
      ? "included"
      : "priced"
    : "not_required"
  if (
    !Number.isSafeInteger(shippingTotalSats) ||
    shippingTotalSats !== quote.pricing.shippingCost.totalSats ||
    shippingStatus !== quote.pricing.shippingCost.status ||
    (!requiresShipping && input.shippingAddress !== undefined)
  ) {
    throw new Error("Checkout Spark shipping totals changed after validation.")
  }
  const timing = getCheckoutSparkSettledTiming()
  const takeoverAt = input.nowMs + timing.takeoverAfterMs
  const grossFundingSats = calculateCheckoutSparkSettledGrossFundingSats(
    commerceQuote.commerceTotalSats
  )
  if (
    !Number.isSafeInteger(takeoverAt) ||
    !Number.isSafeInteger(grossFundingSats) ||
    !Number.isSafeInteger(grossFundingSats * 1_000)
  ) {
    throw new Error("Checkout Spark settled terms are unsafe.")
  }

  // Validate and snapshot private guest contact before any wallet or network work.
  const orderDraft = orderSchema.parse({
    ...(commerceQuote.pricing
      ? { checkoutSparkPricing: commerceQuote.pricing }
      : {}),
    ...(commerceQuote.pricingAuthority
      ? { checkoutSparkPricingAuthority: commerceQuote.pricingAuthority }
      : {}),
    id: input.orderId,
    merchantPubkey,
    buyerPubkey: buyer.pubkey,
    buyerIdentityKind: buyer.kind,
    items: quote.pricing.items,
    subtotal: quote.pricing.totalSats,
    currency: "SATS",
    shippingCostSats: shippingTotalSats,
    shippingCostStatus: shippingStatus,
    shippingAddress,
    note: input.note || undefined,
    guestContact: input.guestContact,
    createdAt: input.nowMs,
  })
  // Historical pickup parsing permits one contact; new guest orders do not.
  if (
    buyer.kind === "guest_ephemeral" &&
    (!orderDraft.guestContact?.email?.trim() ||
      !orderDraft.guestContact.phone?.trim())
  ) {
    throw new Error("Guest orders require both email and phone.")
  }
  const conduitFeeSats = calculateConduitCheckoutFeeSats(
    commerceQuote.commerceTotalSats
  )
  const policy = canUseCheckoutSparkLocalRouterCanary()
    ? ("local_router_canary" as const)
    : ("production" as const)
  const sourcesById = new Map<string, SignedPublicNostrEvent>()
  for (const product of quote.products) {
    const event = product.supplierAllocation?.revisionEvent
    if (!event)
      throw new CheckoutSparkSettledPayoutPreflightError(
        "product_source_unavailable"
      )
    sourcesById.set(event.id, event)
  }
  for (const event of quote.shippingSourceEvents ?? [])
    sourcesById.set(event.id, event)
  for (const event of quote.pickupSourceEvents ?? [])
    sourcesById.set(event.id, event)
  const recipients: CheckoutSparkSettledRecipientInput[] = []
  const readRecipientPayout =
    dependencies.readRecipientPayout ?? readCheckoutSparkRecipientPayoutAddress
  // Core aggregates repeated suppliers and orders each unique recipient once.
  // Read sequentially so cancellation also stops any remaining profile work.
  for (const obligation of commerce) {
    assertCurrent()
    const payout = await readRecipientPayout({
      recipientPubkey: obligation.recipientId,
      accountPubkey: buyer.kind === "signed_in" ? buyer.pubkey : null,
      authenticatedPubkey: buyer.kind === "signed_in" ? buyer.pubkey : null,
      shouldContinue,
    })
    assertCurrent()
    if (payout.state !== "ready") {
      throw new CheckoutSparkSettledPayoutPreflightError(payout.reason)
    }
    if (!payout.signedEvent) {
      throw new CheckoutSparkSettledPayoutPreflightError(
        "profile_source_unavailable"
      )
    }
    // Detach this exact selected revision before awaiting another recipient.
    const [profile] = snapshotCheckoutSparkPlanSourceEvents([
      payout.signedEvent,
    ])
    sourcesById.set(profile!.id, profile!)
    recipients.push({
      kind: obligation.kind,
      recipientId: obligation.recipientId,
      destination: {
        type: "lightning_address",
        value: payout.lud16,
        source: {
          type: "signed_profile",
          profileEventId: payout.profileEventId,
          profileEventCreatedAt: payout.profileEventCreatedAt,
        },
      },
      weightSats: obligation.amountSats,
    })
  }
  const sourceEvents = snapshotCheckoutSparkPlanSourceEvents([
    ...sourcesById.values(),
  ])

  const conduitAddress = checkoutSparkConduitFeeRecipient(policy)
  recipients.push({
    kind: "conduit",
    recipientId: conduitAddress,
    destination: {
      type: "lightning_address",
      value: conduitAddress,
      source: { type: "conduit_allowlist", policy },
    },
    weightSats: conduitFeeSats,
  })
  assertCurrent()

  let continuationPlanDigest: string | null = null
  let prepared: PreparedCheckoutSparkSettledFunding
  try {
    prepared = await (
      dependencies.prepareFunding ?? prepareCheckoutSparkSettledFunding
    )({
      checkoutId: input.checkoutId,
      orderId: input.orderId,
      purchaseClaimDigest: input.purchaseClaimDigest,
      merchantPubkey,
      network: input.network,
      takeoverAt,
      grossFundingSats,
      fundingExpirySecs: timing.fundingExpirySecs,
      identity: buyer,
      shouldContinue,
      quoteAuthority: quote,
      sourceEvents,
      recipients,
      onPlanPrepared: ({ plan, sourceEvents: canonicalSources }) => {
        continuationPlanDigest = plan.planDigest
        saveCheckoutSparkSettledContinuation(
          {
            schemaVersion: 1,
            checkoutId: plan.checkoutId,
            planDigest: plan.planDigest,
            purchaseClaimDigest: input.purchaseClaimDigest,
            buyerPubkey: buyer.pubkey,
            identityKind: buyer.kind,
            createdAt: plan.createdAt,
            expiresAt:
              buyer.kind === "guest_ephemeral"
                ? buyer.expiresAt
                : plan.createdAt + 24 * 60 * 60_000,
            order: orderSchema.parse({
              ...orderDraft,
              createdAt: Math.max(input.nowMs, plan.createdAt),
            }),
            sourceEvents: canonicalSources,
            addressValidity,
            shippingZoneEligibility,
          },
          dependencies.continuationStorage
        )
      },
    })
  } catch (cause) {
    if (
      cause instanceof CheckoutSparkSettledPreparationAbandonedError &&
      continuationPlanDigest
    ) {
      clearCheckoutSparkSettledContinuation(
        input.checkoutId,
        continuationPlanDigest,
        dependencies.continuationStorage
      )
    }
    throw cause
  }
  assertCurrent()
  const order = orderSchema.parse({
    ...orderDraft,
    createdAt: Math.max(input.nowMs, prepared.plan.createdAt),
  })
  const published = await (
    dependencies.publishOrder ?? publishCheckoutSparkSettledBoundOrder
  )({
    checkoutId: input.checkoutId,
    order,
    buyer,
    authenticatedPubkey: buyer.kind === "signed_in" ? buyer.pubkey : null,
    ndk: dependencies.ndk ?? getNdk(),
    shouldContinue,
    sourceEvents,
    addressValidity,
    shippingZoneEligibility,
    relayAuthMethod: input.relayAuthMethod,
  })
  if (continuationPlanDigest) {
    clearCheckoutSparkSettledContinuation(
      input.checkoutId,
      continuationPlanDigest,
      dependencies.continuationStorage
    )
  }
  return { prepared, published }
}

export interface ContinuedCheckoutSparkSettledOrder {
  readonly prepared: PreparedCheckoutSparkSettledFunding
  readonly orderId: string
  /** Continuation never restores a missing RAM wallet or outgoing approval. */
  readonly buyerWalletAvailable: boolean
  readonly nextStep: "review_existing_order" | "merchant_recovery"
}

export class CheckoutSparkSettledContinuationManualRecoveryError extends Error {
  constructor() {
    super(
      "The exact original order needs manual merchant recovery; do not rebuild or pay it again."
    )
    this.name = "CheckoutSparkSettledContinuationManualRecoveryError"
  }
}

/** Continue the original same-tab draft, independently of the current cart. */
export async function resumeCheckoutSparkSettledOrder(
  input: {
    checkoutId: string
    buyer: CheckoutSparkRecoverySigningIdentity
    shouldContinue: () => boolean
    relayAuthMethod?: "nip07" | "nip46"
  },
  dependencies: {
    now?: () => number
    continuationStorage?: CheckoutSparkSettledContinuationStorage | null
    resumeFunding?: typeof resumeCheckoutSparkSettledFunding
    publishOrder?: typeof publishCheckoutSparkSettledBoundOrder
    readOrder?: typeof getOrderLifecycle
    retryOrder?: typeof retryOrderRelayDelivery
    bindBuyerOrder?: DexieCheckoutSparkSettledRepository["bindBuyerOrder"]
    isWalletOpen?: (walletId: string) => boolean
  } = {}
): Promise<ContinuedCheckoutSparkSettledOrder> {
  const buyer = { ...input.buyer }
  const now = dependencies.now ?? Date.now
  const continuation = listCheckoutSparkSettledContinuations(
    buyer.pubkey,
    now(),
    dependencies.continuationStorage
  ).find((row) => row.checkoutId === input.checkoutId)
  if (!continuation || continuation.identityKind !== buyer.kind) {
    throw new Error(
      "The original checkout draft is unavailable for this buyer session."
    )
  }
  const order = continuation.order
  const shouldContinue = () =>
    input.shouldContinue() &&
    (buyer.kind !== "guest_ephemeral" ||
      (buyer.expiresAt === continuation.expiresAt &&
        isCurrentGuestOrderSigningIdentity(
          buyer,
          { orderId: order.id, merchantPubkey: order.merchantPubkey },
          now()
        )))
  const assertCurrent = () => {
    if (!shouldContinue())
      throw new Error("Checkout Spark buyer session changed.")
  }
  assertCurrent()
  const prepared = await (
    dependencies.resumeFunding ?? resumeCheckoutSparkSettledFunding
  )({
    checkoutId: continuation.checkoutId,
    planDigest: continuation.planDigest,
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    buyerPubkey: buyer.pubkey,
    shouldContinue,
  })
  assertCurrent()
  if (
    order.id !== prepared.plan.orderId ||
    order.merchantPubkey !== prepared.plan.merchantPubkey ||
    order.items.length !== prepared.plan.commerceQuote.lines.length ||
    order.items.some(
      (item, index) =>
        !matchesCheckoutSparkCommerceOrderLine(
          item,
          prepared.plan.commerceQuote.lines[index]!
        )
    ) ||
    JSON.stringify(order.checkoutSparkPricing) !==
      JSON.stringify(prepared.plan.commerceQuote.pricing) ||
    JSON.stringify(order.checkoutSparkPricingAuthority) !==
      JSON.stringify(prepared.plan.commerceQuote.pricingAuthority)
  ) {
    throw new CheckoutSparkSettledContinuationManualRecoveryError()
  }
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const existing = await readOrder(order.id)
  assertCurrent()
  const assertOriginalOrder = (lifecycle: OrderLifecycle) => {
    const binding = lifecycle.checkoutSparkRouterBinding
    if (
      lifecycle.orderId !== order.id ||
      lifecycle.buyerPubkey !== buyer.pubkey ||
      lifecycle.merchantPubkey !== order.merchantPubkey ||
      lifecycle.buyerIdentityKind !== buyer.kind ||
      binding?.checkoutId !== prepared.plan.checkoutId ||
      binding.planDigest !== prepared.plan.planDigest ||
      binding.walletId !== prepared.plan.walletId ||
      (buyer.kind === "guest_ephemeral" &&
        lifecycle.guestSessionExpiresAt !== buyer.expiresAt) ||
      lifecycle.phase === "cancelled" ||
      !lifecycle.orderRelayDelivery
    ) {
      throw new CheckoutSparkSettledContinuationManualRecoveryError()
    }
    // Validate the retained original plaintext against the already-staged
    // lifecycle. This local rumor is never signed, wrapped or published.
    const original = new NDKEvent(getNdk())
    original.kind = EVENT_KINDS.ORDER
    original.pubkey = buyer.pubkey
    original.created_at = Math.floor(
      lifecycle.orderRelayDelivery.createdAt / 1_000
    )
    original.tags = [
      ["p", order.merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", String(order.subtotal)],
      ["currency", "SATS"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
      ...order.items.flatMap((item) => [
        ["item", item.productId, String(item.quantity)],
        ...(item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []),
      ]),
    ]
    original.content = JSON.stringify(order)
    prepareBuyerRumor(original, buyer.pubkey)
    try {
      assertStagedOrderLifecycleMatchesRumor(
        lifecycle,
        original,
        buyer.pubkey,
        order.merchantPubkey
      )
    } catch {
      throw new CheckoutSparkSettledContinuationManualRecoveryError()
    }
  }
  if (existing) {
    assertOriginalOrder(existing)
    if (existing.orderDeliveryStatus !== "sent") {
      await (dependencies.retryOrder ?? retryOrderRelayDelivery)(
        order.id,
        buyer.pubkey,
        { shouldContinue, allowGuest: buyer.kind === "guest_ephemeral", now }
      )
      assertCurrent()
    }
    const accepted = await readOrder(order.id)
    assertCurrent()
    if (
      !accepted ||
      accepted.orderDeliveryStatus !== "sent" ||
      accepted.checkoutSparkRouterBinding?.planDigest !==
        prepared.plan.planDigest
    ) {
      throw new Error(
        "The exact original order has not been acknowledged. Keep this checkout for recovery."
      )
    }
    assertOriginalOrder(accepted)
    const repository = new DexieCheckoutSparkSettledRepository()
    await (
      dependencies.bindBuyerOrder ?? repository.bindBuyerOrder.bind(repository)
    )(prepared.plan, buyer.pubkey, assertCurrent)
  } else {
    await (dependencies.publishOrder ?? publishCheckoutSparkSettledBoundOrder)({
      checkoutId: continuation.checkoutId,
      order,
      buyer,
      authenticatedPubkey: buyer.kind === "signed_in" ? buyer.pubkey : null,
      ndk: getNdk(),
      shouldContinue,
      sourceEvents: continuation.sourceEvents,
      addressValidity: continuation.addressValidity,
      shippingZoneEligibility: continuation.shippingZoneEligibility,
      relayAuthMethod: input.relayAuthMethod,
    })
  }
  assertCurrent()
  clearCheckoutSparkSettledContinuation(
    continuation.checkoutId,
    continuation.planDigest,
    dependencies.continuationStorage
  )
  const walletOpen = (
    dependencies.isWalletOpen ??
    ((walletId) => getSparkWalletManager()?.isOpen(walletId) ?? false)
  )(prepared.plan.walletId)
  return {
    prepared,
    orderId: order.id,
    buyerWalletAvailable: walletOpen,
    nextStep: walletOpen ? "review_existing_order" : "merchant_recovery",
  }
}
