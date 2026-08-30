import {
  resolveEventMarketProductFulfillment,
  type EventMarketHandoffMode,
  type EventMarketResolution,
  type ProductSchema,
} from "@conduit/core"
import {
  decodeOrganizerEventMarketReference,
  type MerchantOrganizerEventMarket,
} from "./event-market"
import type { ProductFulfillmentChoice } from "./productForm"

export type ProductEventParticipationState =
  "will_request" | "pending" | "accepted" | "unavailable"

export type ProductFulfillmentProjectionVerification =
  "not_required" | "verified" | "required" | "ambiguous"

export interface ProductFulfillmentProjection {
  intent: ProductFulfillmentChoice
  eventMarketReference: string
  verification: ProductFulfillmentProjectionVerification
  handoffMode?: EventMarketHandoffMode
  handlerPubkey?: string
  pickupCoordinate?: string
}

export interface MerchantBoothPickupFormValues {
  title: string
  location: string
  geohash: string
  country: string
}

export function getMerchantBoothPickupFormError(
  values: MerchantBoothPickupFormValues
): string | null {
  if (!values.title.trim()) return "Add a public merchant pickup title."
  if (!values.location.trim() && !values.geohash.trim()) {
    return "Add a public merchant pickup location or geohash."
  }
  if (!/^[A-Z]{2}$/.test(values.country.trim().toUpperCase())) {
    return "Use a two-letter country code for merchant pickup."
  }
  return null
}

type ProductFulfillmentEvidence = Pick<
  ProductSchema,
  "format" | "collectionRefs" | "shippingOptionId" | "shippingOptionRefs"
>

export function getProductFulfillmentProjection(
  product: ProductFulfillmentEvidence,
  verifiedMarket?: MerchantOrganizerEventMarket | null
): ProductFulfillmentProjection {
  if (product.format === "digital") {
    return {
      intent: "digital",
      eventMarketReference: "",
      verification: "not_required",
    }
  }

  const collectionCoordinates = Array.from(
    new Set(product.collectionRefs?.filter(Boolean) ?? [])
  )
  const shippingOptionCoordinates = Array.from(
    new Set([
      ...(product.shippingOptionRefs ?? []).map(
        (reference) => reference.coordinate
      ),
      ...(product.shippingOptionId ? [product.shippingOptionId] : []),
    ])
  ).filter(Boolean)

  if (
    collectionCoordinates.length === 0 ||
    shippingOptionCoordinates.length === 0
  ) {
    return {
      intent: "ship",
      eventMarketReference: "",
      verification: "not_required",
    }
  }
  if (
    collectionCoordinates.length !== 1 ||
    shippingOptionCoordinates.length !== 1
  ) {
    return {
      intent: "ship",
      eventMarketReference: "",
      verification: "ambiguous",
    }
  }

  // Collection membership and a kind-30406 coordinate do not identify the
  // handler. Core must resolve the exact signed graph before Merchant projects
  // a local-pickup mode.
  const eventMarketReference = collectionCoordinates[0] ?? ""
  if (
    !verifiedMarket ||
    verifiedMarket.collectionCoordinate !== eventMarketReference ||
    getProductLocalPickupEvidenceError({
      reference: eventMarketReference,
      market: verifiedMarket,
    })
  ) {
    return {
      intent: "ship",
      eventMarketReference,
      verification: "required",
    }
  }

  const fulfillment = resolveEventMarketProductFulfillment(
    product,
    verifiedMarket.source as EventMarketResolution
  )
  if (fulfillment.status !== "resolved") {
    return {
      intent: "ship",
      eventMarketReference,
      verification:
        fulfillment.status === "ambiguous" ? "ambiguous" : "required",
    }
  }

  return {
    intent: "local_pickup",
    eventMarketReference,
    verification: "verified",
    handoffMode: fulfillment.handoffMode,
    handlerPubkey: fulfillment.handoffPubkey,
    pickupCoordinate: fulfillment.selectedPickup.coordinate,
  }
}

export function getProductFulfillmentIntent(
  product: ProductFulfillmentEvidence,
  verifiedMarket?: MerchantOrganizerEventMarket | null
): ProductFulfillmentChoice {
  return getProductFulfillmentProjection(product, verifiedMarket).intent
}

export function getProductEventMarketReference(
  product: ProductFulfillmentEvidence,
  verifiedMarket?: MerchantOrganizerEventMarket | null
): string {
  const projection = getProductFulfillmentProjection(product, verifiedMarket)
  return projection.intent === "local_pickup"
    ? projection.eventMarketReference
    : ""
}

export function canonicalizeProductEventMarketReference(value: string): string {
  return decodeOrganizerEventMarketReference(value)
}

export function getProductLocalPickupEvidenceError(input: {
  reference: string
  market?: MerchantOrganizerEventMarket | null
  handoffMode?: EventMarketHandoffMode
  resolving?: boolean
  readFailed?: boolean
}): string | null {
  if (!input.reference.trim()) {
    return "Import an organizer event catalog before publishing local pickup."
  }
  if (input.resolving) return "Verifying current organizer evidence..."
  if (input.readFailed || !input.market) {
    return "Current organizer event and pickup evidence could not be verified."
  }
  if (input.market.collectionCoordinate !== input.reference.trim()) {
    return "The resolved organizer collection does not match the imported reference."
  }
  if (input.market.state === "ended") {
    return "This event has ended and cannot be selected for a new pickup request."
  }
  if (input.market.state !== "active" && input.market.state !== "partial") {
    return "Current organizer event and pickup evidence is degraded or unsupported."
  }
  if (
    input.handoffMode === "organizer_handoff" &&
    !input.market.pickupCoordinate
  ) {
    return "This event organizer is not offering organizer handoff. Choose merchant handoff instead."
  }
  return null
}

export function buildProductLocalPickupMetadata(
  market: MerchantOrganizerEventMarket,
  selection: {
    handoffMode: EventMarketHandoffMode
    merchantPickupCoordinate?: string
  }
): Pick<
  ProductSchema,
  "format" | "collectionRefs" | "shippingOptionId" | "shippingOptionRefs"
> {
  const evidenceError = getProductLocalPickupEvidenceError({
    reference: market.collectionCoordinate,
    market,
  })
  if (evidenceError) throw new Error(evidenceError)

  const handoffMode = selection.handoffMode
  const pickupCoordinate =
    handoffMode === "merchant_handoff"
      ? selection.merchantPickupCoordinate
      : market.pickupCoordinate
  if (!pickupCoordinate) {
    throw new Error(
      handoffMode === "merchant_handoff"
        ? "Publish and acknowledge the merchant booth pickup before the product."
        : "This event organizer is not offering organizer handoff."
    )
  }

  return {
    format: "physical",
    collectionRefs: [market.collectionCoordinate],
    shippingOptionId: pickupCoordinate,
    shippingOptionRefs: [{ coordinate: pickupCoordinate }],
  }
}

export function getProductEventParticipationState(
  product: Pick<
    ProductSchema,
    "id" | "collectionRefs" | "shippingOptionId" | "shippingOptionRefs"
  > | null,
  market: MerchantOrganizerEventMarket | null
): ProductEventParticipationState {
  if (!market || (market.state !== "active" && market.state !== "partial")) {
    return "unavailable"
  }
  if (!product) return "will_request"

  const shippingReferences = new Set([
    ...(product.shippingOptionRefs ?? []).map(
      (reference) => reference.coordinate
    ),
    ...(product.shippingOptionId ? [product.shippingOptionId] : []),
  ])
  const knownPickupCoordinates = new Set([
    ...market.pickupCoordinates,
    ...market.participation.flatMap((item) =>
      item.pickupCoordinate ? [item.pickupCoordinate] : []
    ),
  ])
  const requested =
    product.collectionRefs?.includes(market.collectionCoordinate) === true &&
    (shippingReferences.has(market.collectionCoordinate) ||
      Array.from(shippingReferences).some((coordinate) =>
        knownPickupCoordinates.has(coordinate)
      ))
  if (!requested) return "will_request"
  return market.participation.some(
    (item) =>
      item.productCoordinate === product.id && item.status === "accepted"
  )
    ? "accepted"
    : "pending"
}
