import {
  deriveCheckoutSparkSignedCommerceObligations,
  calculateConduitCheckoutFeeSats,
  calculateCheckoutSparkSettledGrossFundingSats,
  checkoutSparkConduitFeeRecipient,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  getNdk,
  getShippingDestinationEligibility,
  isSatsLikeCurrency,
  matchesCheckoutSparkOrderShippingSnapshot,
  matchesCheckoutSparkOrderPickupSnapshot,
  orderSchema,
  parseShippingOptionAddress,
  resolveCheckoutSparkSignedShipping,
  resolveCheckoutSparkSignedPickup,
  shippingAddressSchema,
  snapshotCheckoutSparkPlanSourceEvents,
  validateAddressConsistency,
  type CheckoutSparkSettledRecipientInput,
  type CheckoutSparkNetwork,
  type OrderSchema,
  type OrderLifecycle,
  type SignedPublicNostrEvent,
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
  prepareCheckoutSparkSettledFunding,
  type PreparedCheckoutSparkSettledFunding,
} from "./checkout-spark-settled-preparation"
import type { CheckoutSparkQuoteAuthority } from "./checkout-spark-quote-authority"
import type { CheckoutSparkRecoverySigningIdentity } from "./checkout-spark-recovery-handoff"
import { isCurrentGuestOrderSigningIdentity } from "./guest-order-identity"
import { getMixedFulfillmentBlockingMessage, type CartItem } from "./cart-model"

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
}

export type PrepareCheckoutSparkSettledDigitalOrderInput =
  PrepareCheckoutSparkSettledOrderInput

const HEX_PUBKEY = /^[0-9a-f]{64}$/
/** UI routing only; preparation independently validates every signed term. */
export function isCheckoutSparkSettledDigitalCart(
  items: readonly Pick<
    CartItem,
    "merchantPubkey" | "format" | "currency" | "sourcePrice" | "fulfillment"
  >[]
): boolean {
  const merchantPubkey = items[0]?.merchantPubkey
  return (
    !!merchantPubkey &&
    HEX_PUBKEY.test(merchantPubkey) &&
    items.every(
      (item) =>
        item.merchantPubkey === merchantPubkey &&
        item.format === "digital" &&
        item.currency === "SATS" &&
        (item.sourcePrice === undefined ||
          isSatsLikeCurrency(item.sourcePrice.normalizedCurrency)) &&
        (item.fulfillment === undefined || item.fulfillment.type === "digital")
    )
  )
}

/** Admission hint only: exact signed fulfillment is rechecked before funding. */
export function isCheckoutSparkSettledCart(
  items: readonly Pick<
    CartItem,
    | "merchantPubkey"
    | "format"
    | "currency"
    | "sourcePrice"
    | "fulfillment"
    | "familyProductId"
    | "selectedSpecifications"
    | "shippingOptionId"
    | "shippingOptionLaunchUnsupported"
  >[]
): boolean {
  const merchantPubkey = items[0]?.merchantPubkey
  return (
    !!merchantPubkey &&
    HEX_PUBKEY.test(merchantPubkey) &&
    !getMixedFulfillmentBlockingMessage([...items]) &&
    items.every((item) => {
      if (
        item.merchantPubkey !== merchantPubkey ||
        item.currency !== "SATS" ||
        item.familyProductId !== undefined ||
        item.selectedSpecifications !== undefined ||
        (item.sourcePrice !== undefined &&
          !isSatsLikeCurrency(item.sourcePrice.normalizedCurrency))
      )
        return false
      if (item.format === "digital")
        return (
          item.fulfillment === undefined || item.fulfillment.type === "digital"
        )
      if (item.fulfillment?.type === "pickup") {
        return (
          item.format === "physical" &&
          item.fulfillment.handoffMode === "merchant_handoff" &&
          item.fulfillment.handlerPubkey === merchantPubkey
        )
      }
      const address =
        item.shippingOptionId &&
        parseShippingOptionAddress(item.shippingOptionId)
      return (
        item.format === "physical" &&
        (item.fulfillment === undefined ||
          item.fulfillment.type === "shipping") &&
        item.shippingOptionLaunchUnsupported !== true &&
        !!address &&
        address.pubkey === merchantPubkey &&
        address.dTag !== CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
      )
    })
  )
}

export interface PreparedCheckoutSparkSettledOrder {
  prepared: PreparedCheckoutSparkSettledFunding
  published: PublishedCheckoutSparkBoundOrder
}

export type PreparedCheckoutSparkSettledDigitalOrder =
  PreparedCheckoutSparkSettledOrder

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

/** A failed admission is retryable only before the wallet preparation starts. */
export function canRetryCheckoutSparkSettledPreparation(input: {
  cause: unknown
  recoveryState: "absent" | "present" | "unreadable"
  preparationStarted: boolean
}): boolean {
  return (
    input.recoveryState === "absent" &&
    (!input.preparationStarted ||
      canRetryCheckoutSparkSettledPayoutPreflight(input))
  )
}

type Dependencies = {
  readRecipientPayout?: typeof readCheckoutSparkRecipientPayoutAddress
  prepareFunding?: typeof prepareCheckoutSparkSettledFunding
  publishOrder?: typeof publishCheckoutSparkSettledBoundOrder
  ndk?: ReturnType<typeof getNdk>
  now?: () => number
}

/**
 * V3 branch rehearsal: freeze signed commerce endpoints, not short-lived
 * payout invoices. The buyer's ordinary gross invoice remains unexposed until
 * the exact wallet/plan recovery wrap is persisted and relay-acknowledged.
 */
export async function prepareCheckoutSparkSettledOrder(
  input: PrepareCheckoutSparkSettledOrderInput,
  dependencies: Dependencies = {}
): Promise<PreparedCheckoutSparkSettledOrder> {
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
    quote.pricing.approximate ||
    quote.lines.some((line) => line.merchantPubkey !== merchantPubkey) ||
    quote.products.some(
      (product) =>
        product.pubkey !== merchantPubkey ||
        (product.format !== "digital" && product.format !== "physical") ||
        product.type !== "simple" ||
        product.currency !== "SATS"
    ) ||
    quote.pricing.items.some(
      (priced) =>
        (priced.format !== "digital" && priced.format !== "physical") ||
        priced.currency !== "SATS" ||
        priced.familyProductId !== undefined ||
        priced.selectedSpecifications !== undefined ||
        (priced.sourcePrice !== undefined &&
          (priced.sourcePrice.amount !== priced.priceAtPurchase ||
            !isSatsLikeCurrency(priced.sourcePrice.normalizedCurrency)))
    ) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs <= 0 ||
    !Number.isSafeInteger(quote.pricing.totalSats * 1_000)
  ) {
    throw new Error(
      "This settled checkout rehearsal supports current SAT-priced simple items from one merchant only."
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
    if (line.pickup) {
      const pickup = resolveCheckoutSparkSignedPickup({
        productEvent: event,
        line,
        sourceEvents: quote.pickupSourceEvents ?? [],
        acceptedAtMs: input.nowMs,
      })
      if (
        !pickup ||
        pickup.handoffMode !== "merchant_handoff" ||
        pickup.handlerPubkey !== merchantPubkey ||
        priced.format !== "physical" ||
        priced.fulfillment?.type !== "pickup" ||
        !matchesCheckoutSparkOrderPickupSnapshot(
          { ...priced, fulfillment: priced.fulfillment },
          pickup
        )
      ) {
        throw new Error(
          "Checkout Spark requires verified merchant pickup terms."
        )
      }
      hasPhysicalFulfillment = true
      shippingTotalSats += line.unitShippingSats * line.quantity
      continue
    }
    const option = resolveCheckoutSparkSignedShipping({
      productEvent: event,
      line,
      shippingEvents: quote.shippingSourceEvents,
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
    if (!matchesCheckoutSparkOrderShippingSnapshot(priced, option)) {
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
    shippingTotalSats += line.unitShippingSats * line.quantity
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

  const prepared = await (
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
  })
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
  return { prepared, published }
}

/** Backward-compatible entry name for existing digital callers. */
export const prepareCheckoutSparkSettledDigitalOrder =
  prepareCheckoutSparkSettledOrder
