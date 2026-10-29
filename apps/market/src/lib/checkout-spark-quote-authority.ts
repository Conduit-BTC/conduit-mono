import type {
  CheckoutSparkCommerceQuoteLine,
  PricingRateInput,
  Product,
  SignedPublicNostrEvent,
  CheckoutSparkPricingRateAttestation,
  OrderEventMarketPickupFulfillmentSchema,
  CheckoutSparkEventMarketBinding,
} from "@conduit/core"
import {
  orderEventMarketPickupFulfillmentSchema,
  parseEventMarketAssignmentEvent,
  parseEventMarketOrganizerFeeTerms,
  assertCurrentEventMarketOrganizerFeeTerms,
  calculateEventMarketOrganizerFeeSats,
  snapshotCheckoutSparkPlanSourceEvents,
} from "@conduit/core"
import { freezeCheckoutSparkEventMarketBinding } from "@conduit/core/protocol/checkout-spark-event-market"
import { assertCheckoutSparkSignedEventMarketSources } from "@conduit/core/protocol/checkout-spark-event-market-sources"
import { buildCheckoutSparkCommerceEvidence } from "./checkout-spark-commerce-evidence"
import { freezeCheckoutSparkPricingRateAttestation } from "@conduit/core/protocol/checkout-spark-pricing-authority"
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
  /** Independently signed rate snapshot retained with the final fiat conversion. */
  pricingAuthority?: CheckoutSparkPricingRateAttestation
  products: readonly Product[]
  lines: readonly CheckoutSparkQuoteLineEvidence[]
  /** Exact selected 30406 revisions, retained from the same authorized read. */
  shippingSourceEvents?: readonly SignedPublicNostrEvent[]
  /** Exact calendar, collection and pickup revisions from current authorization. */
  pickupSourceEvents?: readonly SignedPublicNostrEvent[]
  /** Exact additive fee/source terms; not a separate router or mutable cart projection. */
  eventMarket?: CheckoutSparkEventMarketBinding
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
    (listing.type === "variation" &&
      item.familyProductId !== listing.parentProductId) ||
    (listing.type !== "variation" && item.familyProductId !== undefined) ||
    JSON.stringify(item.selectedSpecifications ?? []) !==
      JSON.stringify(listing.specifications ?? []) ||
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
    (item.fulfillment?.type !== "event_market_pickup" &&
      !item.shippingPolicyQuote &&
      item.shippingOptionLaunchUnsupported !==
        listing.shippingOptionLaunchUnsupported) ||
    JSON.stringify(resolved.shippingOptionRefs) !==
      JSON.stringify(listing.shippingOptionRefs) ||
    JSON.stringify(resolved.collectionRefs) !==
      JSON.stringify(listing.collectionRefs) ||
    resolved.stock !== listing.stock ||
    item.stock !== listing.stock ||
    resolved.visibility !== listing.visibility ||
    Boolean(resolved.eventOnly) !== Boolean(listing.eventOnly) ||
    Boolean(resolved.eventOnlyMalformed) !==
      Boolean(listing.eventOnlyMalformed) ||
    listing.eventOnlyMalformed ||
    (listing.eventOnly === true &&
      item.fulfillment?.type !== "event_market_pickup") ||
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
 * 30402 and ordinary shipping 30406 reads. Router funding requires both
 * projections to agree on one exact product revision. Current Event Market
 * pickup retains its signed roster, date and grant snapshot without inventing
 * a shipping option. Core's live read remains responsible for current authority.
 */
export function buildCheckoutSparkQuoteAuthority(input: {
  authorization: AuthorizedItems
  rateInput: PricingRateInput
  pricingAuthority?: CheckoutSparkPricingRateAttestation
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
  const eventFulfillments: OrderEventMarketPickupFulfillmentSchema[] = []
  const lines = authorization.items.map((item) => {
    const listing = requireMatchingProduct(
      item,
      listingByCoordinate.get(item.productId),
      resolvedByCoordinate.get(item.productId)
    )
    if (usedProducts.has(item.productId)) invalidEvidence()
    usedProducts.add(item.productId)

    if (item.fulfillment?.type === "event_market_pickup") {
      const fulfillment = item.fulfillment
      const parsed =
        orderEventMarketPickupFulfillmentSchema.safeParse(fulfillment)
      if (
        !parsed.success ||
        fulfillment.product.coordinate !== item.productId ||
        fulfillment.product.eventId !== listing.sourceEventId ||
        fulfillment.product.createdAt !== listing.updatedAt ||
        fulfillment.merchantPubkey !== item.merchantPubkey ||
        fulfillment.payeePubkey !== item.merchantPubkey ||
        item.shippingOptionId !== undefined ||
        item.sourceShippingCost !== undefined ||
        (item.shippingCostSats !== undefined && item.shippingCostSats !== 0)
      ) {
        invalidEvidence()
      }
      eventFulfillments.push(parsed.data)
      return {
        productCoordinate: item.productId,
        productEventId: listing.sourceEventId!,
        merchantPubkey: item.merchantPubkey,
        quantity: item.quantity,
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
        authorization.shippingOptionEvidence.options,
        authorization.items.find((item) => item.shippingPolicyQuote)
          ?.shippingPolicyQuote?.destination,
        input.rateInput
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
    (!pricing.paymentRequired && eventFulfillments.length === 0) ||
    pricing.shippingCost.status === "manual" ||
    pricing.items.length !== authorization.items.length
  ) {
    invalidEvidence()
  }

  const authority: CheckoutSparkQuoteAuthority = {
    pricing: structuredClone(pricing),
    ...(input.pricingAuthority
      ? {
          pricingAuthority: freezeCheckoutSparkPricingRateAttestation(
            input.pricingAuthority
          ),
        }
      : {}),
    products: structuredClone(authorization.listingReadProducts),
    lines: structuredClone(lines),
    ...(selectedShipping.size > 0
      ? {
          shippingSourceEvents: structuredClone(
            [...selectedShipping.values()].flatMap((option) =>
              option.sourceEvent
                ? [option.sourceEvent]
                : option.signedEvent
                  ? [option.signedEvent]
                  : []
            )
          ),
        }
      : {}),
    ...(authorization.pickupSourceEvents
      ? {
          pickupSourceEvents: snapshotCheckoutSparkPlanSourceEvents(
            authorization.pickupSourceEvents
          ),
        }
      : {}),
  }
  if (eventFulfillments.length > 0) {
    if (
      eventFulfillments.length !== lines.length ||
      !authority.pickupSourceEvents
    )
      invalidEvidence()
    const first = eventFulfillments[0]!
    if (
      eventFulfillments.some(
        (fulfillment) =>
          fulfillment.merchantPubkey !== first.merchantPubkey ||
          fulfillment.organizerPubkey !== first.organizerPubkey ||
          fulfillment.market.eventId !== first.market.eventId ||
          fulfillment.calendar.eventId !== first.calendar.eventId ||
          fulfillment.schedule?.eventId !== first.schedule?.eventId ||
          fulfillment.grant.eventId !== first.grant.eventId ||
          fulfillment.mode !== first.mode ||
          fulfillment.assignment !== first.assignment
      )
    )
      invalidEvidence()
    const acceptedAtMs = input.nowMs ?? Date.now()
    try {
      const organizerFee = assertCurrentEventMarketOrganizerFeeTerms(
        parseEventMarketOrganizerFeeTerms({
          event: first.market.signedEvent,
          marketCoordinate: first.market.coordinate,
        }),
        acceptedAtMs
      )
      const quote = buildCheckoutSparkCommerceEvidence(authority)
      const eventMarket = freezeCheckoutSparkEventMarketBinding(
        {
          schemaVersion: 1,
          organizerPubkey: first.organizerPubkey,
          marketCoordinate: first.market.coordinate,
          marketEventId: first.market.eventId,
          occurrenceCoordinate: first.calendar.coordinate,
          occurrenceEventId: first.calendar.eventId,
          ...(first.schedule
            ? {
                schedule: {
                  coordinate: first.schedule.coordinate,
                  eventId: first.schedule.eventId,
                },
              }
            : {}),
          grantEventId: first.grant.eventId,
          grantAncestryEventIds: [
            ...new Set(
              eventFulfillments.flatMap(
                (fulfillment) => fulfillment.grant.ancestryEventIds
              )
            ),
          ],
          observedDeletionEventIds: [
            ...new Set(
              eventFulfillments.flatMap(
                (fulfillment) => fulfillment.grant.observedDeletionEventIds
              )
            ),
          ],
          mode: first.mode,
          assignment: first.assignment,
          lines: eventFulfillments.map((fulfillment, index) => {
            const assignment =
              fulfillment.occurrenceAssignment &&
              parseEventMarketAssignmentEvent(
                fulfillment.occurrenceAssignment.signedEvent
              )
            if (!assignment) invalidEvidence()
            const pool = assignment.stockPool
            if (
              first.mode === "organizer_handoff" &&
              (pool.state !== "valid" || pool.pool.state !== "active")
            )
              invalidEvidence()
            return {
              productCoordinate: fulfillment.product.coordinate,
              productEventId: fulfillment.product.eventId,
              assignmentCoordinate: assignment.coordinate,
              assignmentEventId: assignment.eventId,
              quantity: lines[index]!.quantity,
              ...(first.mode === "organizer_handoff" && pool.state === "valid"
                ? { stockPoolId: pool.pool.poolId }
                : {}),
              ...(fulfillment.parentProduct
                ? {
                    parentProduct: {
                      coordinate: fulfillment.parentProduct.coordinate,
                      eventId: fulfillment.parentProduct.eventId,
                    },
                  }
                : {}),
            }
          }),
          organizerFee,
          organizerFeeSats:
            organizerFee.state === "active"
              ? calculateEventMarketOrganizerFeeSats({
                  commerceTotalSats: quote.commerceTotalSats,
                  basisPoints: organizerFee.basisPoints,
                  minimumSats: organizerFee.minimumSats,
                })
              : 0,
        },
        {
          merchantPubkey: first.merchantPubkey,
          commerceQuote: quote,
          acceptedAtMs,
        }
      )
      authority.eventMarket = assertCheckoutSparkSignedEventMarketSources({
        eventMarket,
        commerceQuote: quote,
        merchantPubkey: first.merchantPubkey,
        sourceEvents: authority.pickupSourceEvents,
        acceptedAtMs,
      })
    } catch {
      invalidEvidence()
    }
  }
  return freezeDeep(authority)
}
