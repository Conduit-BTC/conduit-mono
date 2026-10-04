import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  DexieCheckoutSparkSettledRepository,
  appendConduitClientTag,
  getNdk,
  isSatsLikeCurrency,
  getShippingDestinationEligibility,
  matchesCheckoutSparkOrderShippingSnapshot,
  matchesCheckoutSparkOrderPickupSnapshot,
  resolveCheckoutSparkSignedShipping,
  resolveCheckoutSparkSignedPickup,
  validateAddressConsistency,
  orderSchema,
  type OrderLifecycle,
  type OrderSchema,
  type StagedOrderLifecycleInput,
  type CheckoutSparkSettledPlan,
  type ParsedShippingOption,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  type CheckoutSparkSettledPreparationStorage,
} from "./checkout-spark-settled-preparation"
import {
  publishBuyerOrderMessage,
  type BuyerMessageDeliveryResult,
  type BuyerOrderSigningIdentity,
} from "./order-publish"
import {
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"
import { getMixedFulfillmentBlockingMessage } from "./cart-model"

type RouterOrderIdentity =
  | GuestOrderSigningIdentity
  | Extract<BuyerOrderSigningIdentity, { kind?: "signed_in" }>

export interface PublishCheckoutSparkBoundOrderInput {
  checkoutId: string
  /** A fresh, signed-source-priced order. No private router terms enter its payload. */
  order: OrderSchema
  /** Exact signed product/shipping revisions already bound by the frozen plan. */
  sourceEvents?: readonly SignedPublicNostrEvent[]
  buyer: RouterOrderIdentity
  authenticatedPubkey: string | null
  ndk: ReturnType<typeof getNdk>
  shouldContinue: () => boolean
  addressValidity: OrderLifecycle["addressValidity"]
  shippingZoneEligibility: OrderLifecycle["shippingZoneEligibility"]
  relayAuthMethod?: "nip07" | "nip46"
  storage?: CheckoutSparkSettledPreparationStorage | null
}

export interface PublishedCheckoutSparkBoundOrder {
  orderId: string
  delivery: BuyerMessageDeliveryResult
}

type PublishCheckoutSparkBoundOrderDependencies = {
  publishOrder?: typeof publishBuyerOrderMessage
  bindBuyerOrder?: DexieCheckoutSparkSettledRepository["bindBuyerOrder"]
  now?: () => number
}

/** V3 retains the plain order payload and adds a private routing hint after recovery ACK. */
export async function publishCheckoutSparkSettledBoundOrder(
  input: PublishCheckoutSparkBoundOrderInput,
  dependencies: PublishCheckoutSparkBoundOrderDependencies & {
    loadSettledFunding?: typeof loadAuthorizedCheckoutSparkSettledFunding
  } = {}
): Promise<PublishedCheckoutSparkBoundOrder> {
  // Pin the capability across async reads; a replacement tab session must not
  // publish under a different guest key or extend its original lifetime.
  const buyer = { ...input.buyer }
  const order = orderSchema.parse(input.order)
  // Keep historical one-contact pickup readable, but never emit it anew.
  if (
    buyer.kind === "guest_ephemeral" &&
    (!order.guestContact?.email?.trim() || !order.guestContact.phone?.trim())
  ) {
    throw new Error("Guest orders require both email and phone.")
  }
  const originalShouldContinue = input.shouldContinue
  input = {
    ...input,
    buyer,
    order,
    sourceEvents: input.sourceEvents
      ? structuredClone(input.sourceEvents)
      : undefined,
    shouldContinue: () =>
      originalShouldContinue() &&
      (buyer.kind !== "guest_ephemeral" ||
        isCurrentGuestOrderSigningIdentity(
          buyer,
          {
            orderId: order.id,
            merchantPubkey: order.merchantPubkey,
          },
          (dependencies.now ?? Date.now)()
        )),
  }
  if (!input.shouldContinue()) {
    throw new Error("Checkout Spark buyer session changed.")
  }
  const clock = dependencies.now ?? Date.now
  const stored = getCheckoutSparkSettledPreparation(
    input.checkoutId,
    input.storage
  )
  if (
    !stored ||
    stored.fundingSubmissionState !== "not_started" ||
    stored.fundingInvoiceExposedAt === null
  ) {
    throw new Error("Settled checkout order is not durably prepared.")
  }
  const prepared = await (
    dependencies.loadSettledFunding ?? loadAuthorizedCheckoutSparkSettledFunding
  )(input.checkoutId, {
    storage: input.storage,
    now: clock,
    expectedBuyerPubkey: input.buyer.pubkey,
  })
  const plan = prepared.plan
  const now = clock()
  if (!input.shouldContinue()) {
    throw new Error("Checkout Spark buyer session changed.")
  }
  if (
    prepared.state.credit !== null ||
    plan.checkoutId !== input.checkoutId ||
    stored.planDigest !== plan.planDigest ||
    !Number.isSafeInteger(now) ||
    now < plan.createdAt ||
    now >= plan.funding.expiresAt ||
    now >= plan.takeoverAt
  ) {
    throw new Error("Settled checkout order is not durably prepared.")
  }
  return publishBoundOrderFromFrozenPlan(input, plan, now, dependencies)
}

async function publishBoundOrderFromFrozenPlan(
  input: PublishCheckoutSparkBoundOrderInput,
  plan: CheckoutSparkSettledPlan,
  now: number,
  dependencies: PublishCheckoutSparkBoundOrderDependencies
): Promise<PublishedCheckoutSparkBoundOrder> {
  // Parse into a strict payload so a caller cannot accidentally forward local
  // plan, funding invoice, split details, or other payment metadata to Merchant.
  const order = orderSchema.parse(input.order)
  const buyerPubkey = input.buyer.pubkey.toLowerCase()
  const merchantPubkey = plan.merchantPubkey.toLowerCase()
  const guest = input.buyer.kind === "guest_ephemeral" ? input.buyer : null
  const historicalPickup = order.items.some(
    (item) => item.fulfillment?.type === "pickup"
  )
  const currentFulfillmentItems = order.items.flatMap((item) =>
    item.fulfillment?.type === "pickup"
      ? []
      : [{ format: item.format, fulfillment: item.fulfillment }]
  )
  const mixedHistoricalFulfillment =
    historicalPickup &&
    order.items.some(
      (item) =>
        item.fulfillment?.type === "event_market_pickup" ||
        item.fulfillment?.type === "shipping" ||
        (!item.fulfillment && item.format !== "digital")
    )
  if (
    !/^[0-9a-f]{64}$/.test(buyerPubkey) ||
    (input.buyer.kind !== undefined &&
      input.buyer.kind !== "signed_in" &&
      !guest) ||
    (guest
      ? !isCurrentGuestOrderSigningIdentity(
          guest,
          {
            orderId: plan.orderId,
            merchantPubkey,
            pubkey: buyerPubkey,
          },
          now
        ) || input.authenticatedPubkey !== null
      : input.authenticatedPubkey?.toLowerCase() !== buyerPubkey) ||
    order.buyerIdentityKind !== (guest ? "guest_ephemeral" : "signed_in") ||
    order.buyerPubkey.toLowerCase() !== buyerPubkey ||
    order.id !== plan.orderId ||
    order.merchantPubkey.toLowerCase() !== merchantPubkey ||
    order.currency !== "SATS" ||
    order.createdAt < plan.createdAt ||
    order.createdAt > now ||
    (!guest && order.guestContact !== undefined) ||
    order.subtotal !== plan.commerceQuote.commerceTotalSats ||
    order.items.length !== plan.commerceQuote.lines.length ||
    mixedHistoricalFulfillment ||
    getMixedFulfillmentBlockingMessage(currentFulfillmentItems) !== null
  ) {
    throw new Error("Checkout Spark order does not match its frozen plan.")
  }

  const quoteLines = new Map(
    plan.commerceQuote.lines.map((line) => [line.productCoordinate, line])
  )
  const itemSubtotalSats = order.items.reduce(
    (sum, item) => sum + item.priceAtPurchase * item.quantity,
    0
  )
  const shippingCostSats = order.items.reduce(
    (sum, item) => sum + (item.shippingCostSats ?? 0) * item.quantity,
    0
  )
  const shippingOptions: ParsedShippingOption[] = []
  if (
    !Number.isSafeInteger(itemSubtotalSats) ||
    !Number.isSafeInteger(shippingCostSats) ||
    !Number.isSafeInteger(order.subtotal) ||
    !Number.isSafeInteger(order.subtotal * 1_000) ||
    itemSubtotalSats + shippingCostSats !== order.subtotal ||
    (order.shippingCostSats ?? 0) !== shippingCostSats ||
    new Set(order.items.map((item) => item.productId)).size !==
      quoteLines.size ||
    order.items.some((item) => {
      const line = quoteLines.get(item.productId)
      if (line?.pickup) {
        const productEvent = input.sourceEvents?.find(
          (event) => event.id === line.productEventId
        )
        if (!productEvent) return true
        const pickup = resolveCheckoutSparkSignedPickup({
          productEvent,
          line,
          sourceEvents: input.sourceEvents ?? [],
          acceptedAtMs: plan.createdAt,
        })
        // This is a new order, not recovery of an already-funded one. A
        // scheduled event may have ended since its plan was prepared.
        resolveCheckoutSparkSignedPickup({
          productEvent,
          line,
          sourceEvents: input.sourceEvents ?? [],
          acceptedAtMs: now,
        })
        if (
          !pickup ||
          pickup.handoffMode !== "merchant_handoff" ||
          pickup.handlerPubkey !== merchantPubkey ||
          item.format !== "physical" ||
          !matchesCheckoutSparkOrderPickupSnapshot(item, pickup)
        )
          return true
      } else if (line?.shippingOption) {
        const productEvent = input.sourceEvents?.find(
          (event) => event.id === line.productEventId
        )
        if (!productEvent) return true
        const option = resolveCheckoutSparkSignedShipping({
          productEvent,
          line,
          shippingEvents: input.sourceEvents,
        })
        if (
          !option ||
          item.format !== "physical" ||
          item.fulfillment?.type !== "shipping" ||
          !matchesCheckoutSparkOrderShippingSnapshot(item, option)
        )
          return true
        shippingOptions.push(option)
      } else if (
        item.format !== "digital" ||
        (item.fulfillment !== undefined &&
          item.fulfillment.type !== "digital") ||
        item.sourceShippingCost !== undefined ||
        item.shippingOptionId !== undefined ||
        item.shippingOptionDTag !== undefined ||
        item.shippingCountries !== undefined ||
        item.shippingCountryRules !== undefined ||
        (item.shippingCostSats ?? 0) !== 0
      )
        return true
      return (
        !line ||
        item.familyProductId !== undefined ||
        item.selectedSpecifications !== undefined ||
        (item.sourcePrice !== undefined &&
          (item.sourcePrice.amount !== line.unitMerchandiseSats ||
            !isSatsLikeCurrency(item.sourcePrice.normalizedCurrency))) ||
        item.currency !== "SATS" ||
        line.merchantPubkey !== merchantPubkey ||
        line.quantity !== item.quantity ||
        line.unitMerchandiseSats !== item.priceAtPurchase ||
        line.unitShippingSats !== (item.shippingCostSats ?? 0) ||
        line.shippingOption?.coordinate !== item.shippingOptionId
      )
    })
  ) {
    throw new Error("Checkout Spark order items differ from the signed quote.")
  }
  const hasShipping = shippingOptions.length > 0
  const hasPhysicalFulfillment = order.items.some(
    (item) => item.format === "physical"
  )
  const address = order.shippingAddress
  const addressValidity =
    hasShipping && address ? validateAddressConsistency(address) : undefined
  if (
    order.shippingCostStatus !==
      (hasPhysicalFulfillment
        ? shippingCostSats > 0
          ? "priced"
          : "included"
        : "not_required") ||
    (hasShipping
      ? !address ||
        !addressValidity?.canDirectPay ||
        shippingOptions.some(
          (option) =>
            getShippingDestinationEligibility(address, [option]).eligible !==
            true
        )
      : address !== undefined ||
        input.addressValidity !== "not_required" ||
        input.shippingZoneEligibility !== "not_required")
  ) {
    throw new Error("Checkout Spark fulfillment is not authorized.")
  }

  const lifecycle: StagedOrderLifecycleInput = {
    orderId: plan.orderId,
    buyerPubkey,
    buyerIdentityKind: guest ? "guest_ephemeral" : "signed_in",
    ...(guest ? { guestSessionExpiresAt: guest.expiresAt } : {}),
    merchantPubkey,
    checkoutMode: "private_checkout",
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
    items: order.items.map((item) => ({
      productId: item.productId,
      familyProductId: item.familyProductId,
      selectedSpecifications: item.selectedSpecifications,
      title: item.title,
      format: item.format,
      fulfillment: item.fulfillment,
      quantity: item.quantity,
      priceAtPurchase: item.priceAtPurchase,
      currency: item.currency,
      shippingCostSats: item.shippingCostSats,
      sourceShippingCost: item.sourceShippingCost,
      shippingOptionId: item.shippingOptionId,
      shippingOptionDTag: item.shippingOptionDTag,
      shippingCountryRules: item.shippingCountryRules?.map((rule) => ({
        code: rule.code,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
      })),
      sourcePrice: item.sourcePrice,
    })),
    itemSubtotalSats,
    shippingCostSats,
    totalSats: order.subtotal,
    totalMsats: order.subtotal * 1_000,
    currency: "SATS",
    shippingAddress: guest ? undefined : order.shippingAddress,
    contactNote: guest ? undefined : order.note,
    addressValidity: addressValidity?.status ?? "not_required",
    shippingZoneEligibility: hasShipping ? "eligible" : "not_required",
    createdAt: order.createdAt,
  }

  const rumor = new NDKEvent(input.ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(now / 1_000)
  rumor.tags = appendConduitClientTag(
    [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", String(order.subtotal)],
      ["currency", "SATS"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
      ...order.items.flatMap((item) => [
        ["item", item.productId, String(item.quantity)],
        ...(item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []),
      ]),
    ],
    "market"
  )
  rumor.content = JSON.stringify(order)

  let deliveryAccepted = false
  const shouldContinuePublication = () => {
    if (!input.shouldContinue()) return false
    if (deliveryAccepted) return true
    try {
      const currentTime = (dependencies.now ?? Date.now)()
      for (const line of plan.commerceQuote.lines) {
        if (!line.pickup) continue
        resolveCheckoutSparkSignedPickup({
          productEvent: input.sourceEvents!.find(
            (event) => event.id === line.productEventId
          )!,
          line,
          sourceEvents: input.sourceEvents!,
          acceptedAtMs: currentTime,
        })
      }
      return true
    } catch {
      return false
    }
  }
  const delivery = await (
    dependencies.publishOrder ?? publishBuyerOrderMessage
  )(rumor, input.ndk, merchantPubkey, input.buyer, {
    accountPubkey: guest ? null : buyerPubkey,
    authenticatedPubkey: guest ? null : buyerPubkey,
    // Signing/route preparation can cross the event end. Guard first delivery,
    // then retain only session checks for accepted-order recovery work.
    shouldContinue: shouldContinuePublication,
    ...(input.relayAuthMethod
      ? { relayAuthMethod: input.relayAuthMethod }
      : {}),
    orderLifecycle: lifecycle,
  })
  deliveryAccepted = true
  // Delivery is already committed. A failed local payment-history binding must
  // not make an accepted order look retryable or publish another order.
  try {
    const assertCurrent = () => {
      if (!input.shouldContinue()) {
        throw new Error("Checkout Spark buyer session changed.")
      }
    }
    assertCurrent()
    const repository = new DexieCheckoutSparkSettledRepository()
    await (
      dependencies.bindBuyerOrder ?? repository.bindBuyerOrder.bind(repository)
    )(plan, buyerPubkey, assertCurrent)
    assertCurrent()
  } catch {
    return {
      orderId: plan.orderId,
      delivery: {
        ...delivery,
        localCacheError:
          delivery.localCacheError ??
          "The order was sent, but its local payment-history binding could not be saved.",
      },
    }
  }
  return { orderId: plan.orderId, delivery }
}
