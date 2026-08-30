import {
  isBtcLikeCurrency,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  normalizeCurrencyCode,
  type SourcePriceQuote,
} from "../pricing"
import type { ProductSchema } from "../schemas"
import type { EventMarketResolution } from "./event-market"

function currencyCompatibilityKey(currency: string): string {
  const normalized = normalizeCurrencyCode(currency)
  if (isSatsLikeCurrency(normalized)) return "SATS"
  if (isMsatsLikeCurrency(normalized)) return "MSATS"
  if (isBtcLikeCurrency(normalized)) return "BTC"
  return normalized
}

export type EventMarketProductFulfillmentAmbiguityReason =
  | "missing_pickup_evidence"
  | "conflicting_pickup_evidence"
  | "pickup_not_accepted_by_collection"
  | "missing_product_identity"
  | "unsupported_handoff_author"
  | "unsupported_shipping_options"
  | "invalid_product_price"
  | "invalid_pickup_price"
  | "unsupported_event_extra_cost"
  | "conflicting_event_extra_costs"

export type EventMarketProductFulfillmentDecision =
  | {
      status: "none"
      pickupReferenced: false
      collectionReferencedForFulfillment: false
      sourceCost: null
    }
  | {
      status: "ambiguous"
      reason: EventMarketProductFulfillmentAmbiguityReason
      pickupReferenced: boolean
      collectionReferencedForFulfillment: boolean
      sourceCost: null
    }
  | {
      status: "resolved"
      pickupReferenced: boolean
      collectionReferencedForFulfillment: boolean
      selectedPickup: NonNullable<EventMarketResolution["pickup"]>
      pickupAuthorPubkey: string
      handoffMode: EventMarketHandoffMode
      handoffPubkey: string
      sourceCost: SourcePriceQuote
    }

export type EventMarketHandoffMode = "merchant_handoff" | "organizer_handoff"

type FulfillmentProduct = Pick<
  ProductSchema,
  "shippingOptionRefs" | "shippingOptionId" | "priceEvidenceMalformed"
> & { id?: string }

function coordinateIdentity(
  value: string | null | undefined
): { kind: number; authorPubkey: string } | null {
  if (!value) return null
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first < 1 || second <= first + 1) return null
  const kind = Number(value.slice(0, first))
  const authorPubkey = value.slice(first + 1, second).toLowerCase()
  return Number.isSafeInteger(kind) && /^[0-9a-f]{64}$/.test(authorPubkey)
    ? { kind, authorPubkey }
    : null
}

function getShippingOptionReferences(product: FulfillmentProduct) {
  const references = [...(product.shippingOptionRefs ?? [])]
  if (
    product.shippingOptionId &&
    !references.some(
      (reference) => reference.coordinate === product.shippingOptionId
    )
  ) {
    references.push({ coordinate: product.shippingOptionId })
  }
  return references
}

function ambiguousDecision(
  reason: EventMarketProductFulfillmentAmbiguityReason,
  pickupReferenced: boolean,
  collectionReferencedForFulfillment: boolean
): EventMarketProductFulfillmentDecision {
  return {
    status: "ambiguous",
    reason,
    pickupReferenced,
    collectionReferencedForFulfillment,
    sourceCost: null,
  }
}

/**
 * Classify all product shipping evidence against one resolved event market and
 * price the only fulfillment choice that generic surfaces can safely make.
 * Repeated collection/pickup aliases are equivalent only when every normalized
 * extra-cost meaning agrees; unrelated options make the choice ambiguous.
 */
export function resolveEventMarketProductFulfillment(
  product: FulfillmentProduct,
  resolution: Pick<
    EventMarketResolution,
    "organizerPubkey" | "collection" | "pickup" | "pickups"
  >
): EventMarketProductFulfillmentDecision {
  const collectionCoordinate = resolution.collection?.coordinate
  const references = getShippingOptionReferences(product)
  const directPickupReferences = references.filter(
    (reference) => coordinateIdentity(reference.coordinate)?.kind === 30406
  )
  const collectionPickupCoordinates = new Set(
    resolution.collection?.pickupCoordinates ??
      (resolution.pickup ? [resolution.pickup.coordinate] : [])
  )
  const resolvedPickupCoordinates = new Set(
    (resolution.pickups?.length
      ? resolution.pickups
      : resolution.pickup
        ? [resolution.pickup]
        : []
    ).map((pickup) => pickup.coordinate)
  )
  const pickupReferenced = directPickupReferences.some(
    (reference) =>
      collectionPickupCoordinates.has(reference.coordinate) ||
      resolvedPickupCoordinates.has(reference.coordinate)
  )
  const collectionReferencedForFulfillment = Boolean(
    collectionCoordinate &&
    references.some(
      (reference) => reference.coordinate === collectionCoordinate
    )
  )
  const eventReferences = references.filter((reference) => {
    const identity = coordinateIdentity(reference.coordinate)
    return (
      identity?.kind === 30406 ||
      (collectionCoordinate && reference.coordinate === collectionCoordinate)
    )
  })

  if (eventReferences.length === 0) {
    return {
      status: "none",
      pickupReferenced: false,
      collectionReferencedForFulfillment: false,
      sourceCost: null,
    }
  }

  const organizerPubkey = resolution.organizerPubkey?.toLowerCase()
  const productIdentity = coordinateIdentity(product.id)
  const directPickupCoordinates = Array.from(
    new Set(directPickupReferences.map((reference) => reference.coordinate))
  )
  const invalidOrganizerCoordinate = directPickupCoordinates.find(
    (coordinate) => {
      const identity = coordinateIdentity(coordinate)
      return (
        identity?.authorPubkey === organizerPubkey &&
        !collectionPickupCoordinates.has(coordinate)
      )
    }
  )
  if (invalidOrganizerCoordinate) {
    return ambiguousDecision(
      "pickup_not_accepted_by_collection",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }
  const unsupportedDirectAuthor = directPickupCoordinates.find((coordinate) => {
    const author = coordinateIdentity(coordinate)?.authorPubkey
    return (
      !author ||
      (author !== organizerPubkey &&
        (!productIdentity || author !== productIdentity.authorPubkey))
    )
  })
  if (unsupportedDirectAuthor) {
    return ambiguousDecision(
      productIdentity
        ? "unsupported_handoff_author"
        : "missing_product_identity",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const selectedCoordinates = Array.from(
    new Set([
      ...directPickupCoordinates,
      ...(collectionReferencedForFulfillment &&
      collectionPickupCoordinates.size === 1
        ? [Array.from(collectionPickupCoordinates)[0]!]
        : []),
    ])
  )
  if (selectedCoordinates.length > 1) {
    return ambiguousDecision(
      "conflicting_pickup_evidence",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const selectedCoordinate = selectedCoordinates[0]
  if (
    !selectedCoordinate &&
    collectionReferencedForFulfillment &&
    collectionPickupCoordinates.size > 1
  ) {
    return ambiguousDecision(
      "conflicting_pickup_evidence",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }
  const pickups = resolution.pickups?.length
    ? resolution.pickups
    : resolution.pickup
      ? [resolution.pickup]
      : []
  const pickup = pickups.find(
    (candidate) => candidate.coordinate === selectedCoordinate
  )
  if (!pickup) {
    return ambiguousDecision(
      "missing_pickup_evidence",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  if (eventReferences.length !== references.length) {
    return ambiguousDecision(
      "unsupported_shipping_options",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const pickupAuthorPubkey = pickup.authorPubkey.toLowerCase()
  let handoffMode: EventMarketHandoffMode
  let handoffPubkey: string
  if (organizerPubkey && pickupAuthorPubkey === organizerPubkey) {
    handoffMode = "organizer_handoff"
    handoffPubkey = organizerPubkey
  } else if (
    productIdentity?.kind === 30402 &&
    pickupAuthorPubkey === productIdentity.authorPubkey
  ) {
    handoffMode = "merchant_handoff"
    handoffPubkey = productIdentity.authorPubkey
  } else if (!productIdentity) {
    return ambiguousDecision(
      "missing_product_identity",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  } else {
    return ambiguousDecision(
      "unsupported_handoff_author",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  if (product.priceEvidenceMalformed) {
    return ambiguousDecision(
      "invalid_product_price",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  if (eventReferences.some((reference) => reference.extraCostMalformed)) {
    return ambiguousDecision(
      "unsupported_event_extra_cost",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const baseCurrency = normalizeCurrencyCode(pickup.currency)
  if (!baseCurrency || !Number.isFinite(pickup.price) || pickup.price < 0) {
    return ambiguousDecision(
      "invalid_pickup_price",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const baseCompatibilityKey = currencyCompatibilityKey(baseCurrency)
  const normalizedExtras = eventReferences.map((reference) => {
    const extraCost = reference.extraCost
    if (!extraCost) {
      return { amount: 0, compatibilityKey: baseCompatibilityKey }
    }

    const extraCurrency = normalizeCurrencyCode(extraCost.currency)
    const extraNormalizedCurrency = normalizeCurrencyCode(
      extraCost.normalizedCurrency
    )
    if (
      !extraCurrency ||
      !extraNormalizedCurrency ||
      currencyCompatibilityKey(extraCurrency) !==
        currencyCompatibilityKey(extraNormalizedCurrency) ||
      currencyCompatibilityKey(extraNormalizedCurrency) !==
        baseCompatibilityKey ||
      !Number.isFinite(extraCost.amount) ||
      extraCost.amount < 0
    ) {
      return null
    }

    return {
      amount: extraCost.amount,
      compatibilityKey: currencyCompatibilityKey(extraNormalizedCurrency),
    }
  })
  if (normalizedExtras.some((extra) => extra === null)) {
    return ambiguousDecision(
      "unsupported_event_extra_cost",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const firstExtra = normalizedExtras[0]!
  if (
    normalizedExtras.some(
      (extra) =>
        extra!.amount !== firstExtra.amount ||
        extra!.compatibilityKey !== firstExtra.compatibilityKey
    )
  ) {
    return ambiguousDecision(
      "conflicting_event_extra_costs",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  const amount = pickup.price + firstExtra.amount
  if (!Number.isFinite(amount) || amount < 0) {
    return ambiguousDecision(
      "invalid_pickup_price",
      pickupReferenced,
      collectionReferencedForFulfillment
    )
  }

  return {
    status: "resolved",
    pickupReferenced,
    collectionReferencedForFulfillment,
    selectedPickup: pickup,
    pickupAuthorPubkey,
    handoffMode,
    handoffPubkey,
    sourceCost: {
      amount,
      currency: pickup.currency,
      normalizedCurrency: baseCurrency,
    },
  }
}

/** Resolve the public raw pickup cost signed by the organizer and merchant. */
export function getEventMarketPickupSourceCost(
  product: FulfillmentProduct,
  resolution: Pick<
    EventMarketResolution,
    "organizerPubkey" | "collection" | "pickup" | "pickups"
  >
): SourcePriceQuote | null {
  const decision = resolveEventMarketProductFulfillment(product, resolution)
  return decision.status === "resolved" ? decision.sourceCost : null
}
