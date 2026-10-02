import type {
  CheckoutSparkCommerceQuoteLine,
  PricingRateInput,
  Product,
  SignedPublicNostrEvent,
} from "@conduit/core"
import {
  orderPickupFulfillmentSchema,
  resolveCheckoutSparkSignedPickup,
} from "@conduit/core"
import { getCartCommerceFingerprint, type CartItem } from "./cart-model"
import { prepareCartFulfillment } from "./cart-shipping-options"
import type { CheckoutAuthorizationResult } from "./checkout-authorization"
import {
  bindCartItemsToFreshProductPricing,
  buildCheckoutPricingIntent,
  type CheckoutPricingIntent,
} from "./checkout-payment"

type AuthorizedItems = Extract<CheckoutAuthorizationResult, { status: "ok" }>
type PricedIntent = Extract<CheckoutPricingIntent, { status: "ok" }>

export interface CheckoutSparkQuoteLineEvidence {
  productCoordinate: string
  productEventId: string
  merchantPubkey: string
  quantity: number
  shippingOption?: {
    coordinate: string
    eventId: string
  }
  pickup?: CheckoutSparkCommerceQuoteLine["pickup"]
}

/**
 * A submit-time quote paired with the exact signed revisions used to build it.
 * The later allocation resolver must still validate supplier and recipient
 * authority against these product revisions; this bundle does not do that.
 */
export interface CheckoutSparkQuoteAuthority {
  pricing: PricedIntent
  products: readonly Product[]
  lines: readonly CheckoutSparkQuoteLineEvidence[]
  /** Exact selected 30406 revisions, retained from the same authorized read. */
  shippingSourceEvents?: readonly SignedPublicNostrEvent[]
  /** Exact calendar, collection and pickup revisions from current authorization. */
  pickupSourceEvents?: readonly SignedPublicNostrEvent[]
}

const EVENT_ID = /^[0-9a-f]{64}$/

function invalidEvidence(): never {
  throw new Error(
    "Current signed checkout evidence changed. Review checkout before paying."
  )
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeDeep(nested)
    Object.freeze(value)
  }
  return value
}

function requireMatchingProduct(
  item: CartItem,
  listing: Product | undefined,
  resolved: Product | undefined
): Product {
  const eventId = listing?.sourceEventId
  if (
    !listing ||
    !resolved ||
    !eventId ||
    !EVENT_ID.test(eventId) ||
    listing.id !== item.productId ||
    resolved.id !== item.productId ||
    listing.pubkey !== item.merchantPubkey ||
    resolved.pubkey !== item.merchantPubkey ||
    resolved.sourceEventId !== eventId ||
    resolved.updatedAt !== listing.updatedAt ||
    resolved.price !== listing.price ||
    resolved.currency !== listing.currency ||
    resolved.priceSats !== listing.priceSats ||
    JSON.stringify(resolved.sourcePrice) !==
      JSON.stringify(listing.sourcePrice) ||
    resolved.type !== listing.type ||
    listing.type === "variable" ||
    resolved.parentProductId !== listing.parentProductId ||
    JSON.stringify(resolved.specifications) !==
      JSON.stringify(listing.specifications) ||
    resolved.format !== listing.format ||
    (item.format ?? "physical") !== listing.format ||
    (listing.format === "digital" &&
      item.fulfillment !== undefined &&
      item.fulfillment.type !== "digital") ||
    (listing.format === "physical" && item.fulfillment?.type === "digital") ||
    resolved.shippingOptionId !== listing.shippingOptionId ||
    resolved.shippingOptionDTag !== listing.shippingOptionDTag ||
    resolved.shippingOptionLaunchUnsupported !==
      listing.shippingOptionLaunchUnsupported ||
    (item.fulfillment?.type !== "pickup" &&
      (item.shippingOptionLaunchUnsupported === true) !==
        (listing.shippingOptionLaunchUnsupported === true)) ||
    JSON.stringify(resolved.shippingOptionRefs) !==
      JSON.stringify(listing.shippingOptionRefs) ||
    JSON.stringify(resolved.collectionRefs) !==
      JSON.stringify(listing.collectionRefs) ||
    resolved.stock !== listing.stock ||
    item.stock !== listing.stock ||
    resolved.visibility !== listing.visibility ||
    resolved.publicZapEnabled !== listing.publicZapEnabled ||
    resolved.zapMessagePolicy !== listing.zapMessagePolicy ||
    resolved.publicZapPolicyKnown !== listing.publicZapPolicyKnown ||
    item.publicZapEnabled !== listing.publicZapEnabled ||
    item.zapMessagePolicy !== listing.zapMessagePolicy ||
    item.publicZapPolicyKnown !== listing.publicZapPolicyKnown ||
    item.productEventId !== eventId ||
    item.productUpdatedAt !== listing.updatedAt ||
    !Number.isSafeInteger(item.quantity) ||
    item.quantity <= 0 ||
    (listing.stock !== undefined &&
      (!Number.isSafeInteger(listing.stock) ||
        listing.stock < item.quantity)) ||
    listing.priceEvidenceMalformed ||
    resolved.priceEvidenceMalformed
  ) {
    invalidEvidence()
  }
  return listing
}

/**
 * Admit only a fresh, direct-payable quote from the checkout's current signed
 * 30402 and 30406 reads. Pickup catalog projections may differ for browsing,
 * but router funding cannot start until both sources agree on one exact
 * product revision. Core's read boundary remains responsible for verifying
 * signatures, deletion frontiers, and pickup graph authority.
 */
export function buildCheckoutSparkQuoteAuthority(input: {
  authorization: AuthorizedItems
  rateInput: PricingRateInput
  nowMs?: number
}): CheckoutSparkQuoteAuthority {
  const { authorization } = input
  if (
    authorization.items.length === 0 ||
    authorization.shippingOptionEvidence.status === "unavailable_order_first"
  ) {
    invalidEvidence()
  }

  const listingByCoordinate = new Map(
    authorization.listingReadProducts.map((product) => [product.id, product])
  )
  const resolvedByCoordinate = new Map(
    authorization.fulfillmentResolvedProducts.map((product) => [
      product.id,
      product,
    ])
  )
  if (
    listingByCoordinate.size !== authorization.listingReadProducts.length ||
    resolvedByCoordinate.size !==
      authorization.fulfillmentResolvedProducts.length ||
    listingByCoordinate.size !== resolvedByCoordinate.size
  ) {
    invalidEvidence()
  }

  const selectedShipping = new Map(
    authorization.shippingOptionEvidence.options.map((option) => [
      option.id,
      option,
    ])
  )
  if (
    selectedShipping.size !==
    authorization.shippingOptionEvidence.options.length
  ) {
    invalidEvidence()
  }

  const usedProducts = new Set<string>()
  const usedShipping = new Set<string>()
  const lines = authorization.items.map((item) => {
    const listing = requireMatchingProduct(
      item,
      listingByCoordinate.get(item.productId),
      resolvedByCoordinate.get(item.productId)
    )
    if (usedProducts.has(item.productId)) invalidEvidence()
    usedProducts.add(item.productId)

    if (item.fulfillment?.type === "event_pickup_pending") invalidEvidence()
    if (item.fulfillment?.type === "pickup") {
      if (
        authorization.shippingOptionEvidence.status !== "not_required" ||
        item.fulfillment.product.coordinate !== item.productId ||
        item.fulfillment.product.eventId !== listing.sourceEventId ||
        item.fulfillment.product.merchantPubkey !== item.merchantPubkey ||
        item.shippingOptionId !== item.fulfillment.option.coordinate ||
        !EVENT_ID.test(item.fulfillment.option.eventId) ||
        !authorization.pickupSourceEvents?.length
      ) {
        invalidEvidence()
      }
      return {
        productCoordinate: item.productId,
        productEventId: listing.sourceEventId!,
        merchantPubkey: item.merchantPubkey,
        quantity: item.quantity,
        shippingOption: {
          coordinate: item.fulfillment.option.coordinate,
          eventId: item.fulfillment.option.eventId,
        },
        pickup: {
          calendar: {
            coordinate: item.fulfillment.calendar.coordinate,
            eventId: item.fulfillment.calendar.eventId,
          },
          collection: {
            coordinate: item.fulfillment.collection.coordinate,
            eventId: item.fulfillment.collection.eventId,
          },
        },
      }
    }

    if (item.format === "digital") {
      if (item.shippingOptionId) invalidEvidence()
      return {
        productCoordinate: item.productId,
        productEventId: listing.sourceEventId!,
        merchantPubkey: item.merchantPubkey,
        quantity: item.quantity,
      }
    }

    const option = item.shippingOptionId
      ? selectedShipping.get(item.shippingOptionId)
      : undefined
    if (
      !option ||
      item.shippingOptionId !== listing.shippingOptionId ||
      item.canonicalShippingResolved !== true ||
      option.pubkey !== item.merchantPubkey ||
      !EVENT_ID.test(option.eventId)
    ) {
      invalidEvidence()
    }
    usedShipping.add(option.id)
    return {
      productCoordinate: item.productId,
      productEventId: listing.sourceEventId!,
      merchantPubkey: item.merchantPubkey,
      quantity: item.quantity,
      shippingOption: {
        coordinate: option.id,
        eventId: option.eventId,
      },
    }
  })

  if (
    usedProducts.size !== listingByCoordinate.size ||
    usedShipping.size !== selectedShipping.size ||
    (selectedShipping.size > 0 &&
      authorization.shippingOptionEvidence.status !== "verified") ||
    getCartCommerceFingerprint(
      prepareCartFulfillment(
        authorization.items,
        authorization.shippingOptionEvidence.options
      ).items
    ) !== getCartCommerceFingerprint(authorization.items)
  ) {
    invalidEvidence()
  }

  const priceBinding = bindCartItemsToFreshProductPricing(
    authorization.items,
    authorization.listingReadProducts
  )
  if (priceBinding.status !== "ok") invalidEvidence()

  const pricing = buildCheckoutPricingIntent(
    priceBinding.items,
    input.rateInput,
    input.nowMs
  )
  if (
    pricing.status !== "ok" ||
    !pricing.paymentRequired ||
    pricing.shippingCost.status === "manual" ||
    pricing.items.length !== authorization.items.length
  ) {
    invalidEvidence()
  }

  const pickupSources = new Map<string, SignedPublicNostrEvent>()
  for (const line of lines) {
    if (!line.pickup) continue
    const item = authorization.items.find(
      (candidate) => candidate.productId === line.productCoordinate
    )!
    const priced = pricing.items.find(
      (candidate) => candidate.productId === line.productCoordinate
    )!
    const productEvent = listingByCoordinate.get(line.productCoordinate)
      ?.supplierAllocation?.revisionEvent
    if (!productEvent) invalidEvidence()
    try {
      const snapshot = resolveCheckoutSparkSignedPickup({
        productEvent,
        line: {
          ...line,
          unitMerchandiseSats: priced.priceAtPurchase,
          unitShippingSats: priced.shippingCostSats ?? 0,
        },
        sourceEvents: authorization.pickupSourceEvents ?? [],
        acceptedAtMs: input.nowMs ?? Date.now(),
      })
      if (
        !snapshot ||
        JSON.stringify(orderPickupFulfillmentSchema.parse(snapshot)) !==
          JSON.stringify(orderPickupFulfillmentSchema.parse(item.fulfillment))
      ) {
        invalidEvidence()
      }
      for (const id of [
        line.pickup.calendar.eventId,
        line.pickup.collection.eventId,
        line.shippingOption!.eventId,
      ]) {
        const event = authorization.pickupSourceEvents!.find(
          (source) => source.id === id
        )
        if (!event) invalidEvidence()
        pickupSources.set(id, {
          id: event.id,
          pubkey: event.pubkey,
          kind: event.kind,
          created_at: event.created_at,
          tags: event.tags.map((tag) => [...tag]),
          content: event.content,
          sig: event.sig,
        })
      }
    } catch {
      invalidEvidence()
    }
  }

  return freezeDeep({
    pricing: structuredClone(pricing),
    products: structuredClone(authorization.listingReadProducts),
    lines: structuredClone(lines),
    ...(pickupSources.size > 0
      ? { pickupSourceEvents: structuredClone([...pickupSources.values()]) }
      : {}),
    ...(selectedShipping.size > 0
      ? {
          shippingSourceEvents: structuredClone(
            [...selectedShipping.values()].flatMap((option) =>
              option.sourceEvent ? [option.sourceEvent] : []
            )
          ),
        }
      : {}),
  })
}
