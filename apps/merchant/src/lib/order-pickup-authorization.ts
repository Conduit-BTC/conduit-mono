import {
  decodeEventMarketReference,
  getEventMarket,
  getProductsByIds,
  isFiatCurrencyCode,
  normalizeCommercePrice,
  resolveEventMarketProductFulfillment,
  resolveEventMarketProductParticipation,
  resolveOrderPickupHandoffAuthority,
  type CommerceProductRecord,
  type EventMarketResolution,
  type OrderPickupFulfillmentSchema,
  type OrderSummary,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import { getMerchantOrderFulfillment } from "./order-phase"

type OrderItem = OrderSummary["items"][number]
type PickupOrderItem = OrderItem & {
  fulfillment: OrderPickupFulfillmentSchema
}

export type MerchantPickupAuthorizationFailure =
  | "invalid_snapshot"
  | "network_unavailable"
  | "organizer_evidence_not_current"
  | "product_evidence_not_current"
  | "revision_mismatch"
  | "authorization_missing"
  | "price_mismatch"
  | "cost_mismatch"

export type MerchantPickupAuthorizationResult =
  | { status: "not_required" }
  | {
      status: "verified"
      market: EventMarketResolution
      products: CommerceProductRecord[]
    }
  | {
      status: "unverified"
      reason: MerchantPickupAuthorizationFailure
    }

export interface MerchantPickupAuthorizationInput {
  items: OrderSummary["items"]
  merchantPubkey: string
  nowMs?: number
}

export interface MerchantPickupAuthorizationDependencies {
  getEventMarket: typeof getEventMarket
  getProductsByIds: typeof getProductsByIds
}

const DEFAULT_DEPENDENCIES: MerchantPickupAuthorizationDependencies = {
  getEventMarket,
  getProductsByIds,
}

function canonicalCoordinate(
  value: string,
  allowedKinds: readonly number[]
): string | null {
  return decodeEventMarketReference(value, allowedKinds)?.coordinate ?? null
}

function sameCoordinate(
  left: string,
  right: string,
  allowedKinds: readonly number[]
): boolean {
  const canonicalLeft = canonicalCoordinate(left, allowedKinds)
  return (
    canonicalLeft !== null &&
    canonicalLeft === canonicalCoordinate(right, allowedKinds)
  )
}

function pickupItemsFromOrder(
  items: OrderSummary["items"]
): PickupOrderItem[] | null {
  const pickupItems = items.filter(
    (item): item is PickupOrderItem => item.fulfillment?.type === "pickup"
  )
  if (pickupItems.length === 0) return []

  const fulfillment = getMerchantOrderFulfillment(items)
  if (fulfillment.mode !== "pickup" || !fulfillment.hasPickupClaim) {
    return null
  }
  return pickupItems
}

function sameSourceCost(
  left:
    | {
        amount: number
        currency: string
        normalizedCurrency: string
      }
    | undefined,
  right: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
): boolean {
  return (
    left?.amount === right.amount &&
    left.currency === right.currency &&
    left.normalizedCurrency === right.normalizedCurrency
  )
}

function pickupEnvelopeIsSelfConsistent(item: PickupOrderItem): boolean {
  const fulfillment = item.fulfillment
  const optionDTag = fulfillment.option.coordinate.split(":").slice(2).join(":")
  return (
    item.shippingOptionId === fulfillment.option.coordinate &&
    item.shippingOptionDTag === optionDTag &&
    item.shippingCostSats === fulfillment.costSats &&
    Number.isSafeInteger(fulfillment.costSats) &&
    fulfillment.costSats >= 0 &&
    sameSourceCost(item.sourceShippingCost, fulfillment.sourceCost)
  )
}

function pickupCostMatchesCurrentEvidence(
  item: PickupOrderItem,
  sourceCost: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
): boolean {
  if (!sameSourceCost(item.fulfillment.sourceCost, sourceCost)) return false
  if (sourceCost.amount === 0) return item.fulfillment.costSats === 0

  const deterministic = normalizeCommercePrice(
    sourceCost.amount,
    sourceCost.normalizedCurrency,
    null
  )
  if (deterministic.status === "ok") {
    return item.fulfillment.costSats === deterministic.sats
  }

  // Fiat conversion rates are not signed into the order. Preserve and verify
  // the exact signed raw cost plus the internally consistent conversion
  // snapshot, but never reinterpret it using today's unrelated exchange rate.
  return (
    deterministic.status === "rate_required" &&
    isFiatCurrencyCode(sourceCost.normalizedCurrency) &&
    Number.isSafeInteger(item.fulfillment.costSats) &&
    item.fulfillment.costSats > 0
  )
}

function productPriceMatchesCurrentEvidence(
  item: PickupOrderItem,
  product: Pick<Product, "price" | "currency" | "sourcePrice">
): boolean {
  const currentSource = product.sourcePrice ?? {
    amount: product.price,
    currency: product.currency,
    normalizedCurrency: product.currency.trim().toUpperCase(),
  }
  const snapshotSource = item.sourcePrice

  if (snapshotSource && !sameSourceCost(snapshotSource, currentSource)) {
    return false
  }

  const deterministic = normalizeCommercePrice(
    currentSource.amount,
    currentSource.normalizedCurrency,
    null,
    { allowZero: true }
  )
  if (deterministic.status === "ok") {
    return (
      item.currency.trim().toUpperCase() === "SATS" &&
      item.priceAtPurchase === deterministic.sats
    )
  }

  // A historical fiat-to-sats quote is not part of the public listing. The
  // signed raw amount/currency must therefore be present and exact; applying a
  // current rate would mutate the already-paid order's terms.
  return (
    snapshotSource !== undefined &&
    deterministic.status === "rate_required" &&
    isFiatCurrencyCode(currentSource.normalizedCurrency) &&
    currentSource.amount > 0 &&
    item.currency.trim().toUpperCase() === "SATS" &&
    Number.isSafeInteger(item.priceAtPurchase) &&
    item.priceAtPurchase > 0
  )
}

function hasExactCoordinate(
  values: readonly string[],
  coordinate: string,
  allowedKinds: readonly number[]
): boolean {
  return values.some((value) => sameCoordinate(value, coordinate, allowedKinds))
}

function organizerGraphMatches(
  snapshot: OrderPickupFulfillmentSchema,
  resolution: EventMarketResolution
): boolean {
  const { calendar, collection } = resolution
  const organizerPubkey = snapshot.organizerPubkey.toLowerCase()
  const merchantPubkey = snapshot.product.merchantPubkey.toLowerCase()
  const authority = resolveOrderPickupHandoffAuthority(snapshot)
  const pickups = resolution.pickups?.length
    ? resolution.pickups
    : resolution.pickup
      ? [resolution.pickup]
      : []
  const pickup = pickups.find((candidate) =>
    sameCoordinate(snapshot.option.coordinate, candidate.coordinate, [30406])
  )
  const expectedPickupAuthor =
    authority.mode === "organizer_handoff" ? organizerPubkey : merchantPubkey
  return Boolean(
    !authority.legacySafeDefault &&
    calendar &&
    collection &&
    pickup &&
    resolution.organizerPubkey?.toLowerCase() === organizerPubkey &&
    calendar.authorPubkey.toLowerCase() === organizerPubkey &&
    collection.authorPubkey.toLowerCase() === organizerPubkey &&
    pickup.authorPubkey.toLowerCase() === expectedPickupAuthor &&
    authority.handlerPubkey === expectedPickupAuthor &&
    sameCoordinate(
      snapshot.calendar.coordinate,
      calendar.coordinate,
      [31922, 31923]
    ) &&
    sameCoordinate(
      snapshot.collection.coordinate,
      collection.coordinate,
      [30405]
    ) &&
    sameCoordinate(snapshot.option.coordinate, pickup.coordinate, [30406]) &&
    collection.eventCoordinates.length === 1 &&
    hasExactCoordinate(
      collection.eventCoordinates,
      snapshot.calendar.coordinate,
      [31922, 31923]
    ) &&
    (authority.mode === "merchant_handoff" ||
      (collection.pickupCoordinates.length >= 1 &&
        hasExactCoordinate(
          collection.pickupCoordinates,
          snapshot.option.coordinate,
          [30406]
        ))) &&
    snapshot.option.title === pickup.title &&
    snapshot.option.location === pickup.location &&
    snapshot.option.geohash === pickup.geohash
  )
}

function productDiagnosticIsCurrent(
  result: ProductsByIdsResult,
  productCoordinate: string
): boolean {
  const diagnostic = result.diagnostics.find((entry) =>
    sameCoordinate(entry.productId, productCoordinate, [30402])
  )
  return (
    result.meta.source !== "local_cache" &&
    diagnostic?.issue === null &&
    // A live selected revision is positive evidence. Incomplete deletion
    // discovery cannot invent a tombstone or give one failed relay veto power;
    // known local/live tombstones have already removed the record in Core.
    diagnostic.coverage?.listing !== "unavailable"
  )
}

function productReadWasUnavailable(
  result: ProductsByIdsResult,
  productCoordinate: string
): boolean {
  const diagnostic = result.diagnostics.find((entry) =>
    sameCoordinate(entry.productId, productCoordinate, [30402])
  )
  return (
    result.meta.source === "local_cache" ||
    diagnostic?.issue === "lookup_partial" ||
    diagnostic?.issue === "lookup_unavailable" ||
    diagnostic?.issue === "cached_only" ||
    diagnostic?.coverage?.listing === "unavailable" ||
    diagnostic?.coverage === undefined
  )
}

/**
 * Re-resolve buyer-supplied pickup snapshots against current signed semantic
 * evidence. Replaceable revision metadata is provenance, not authorization;
 * relay/cache uncertainty still cannot authorize the pickup workflow.
 */
export async function verifyMerchantPickupOrderAuthorization(
  input: MerchantPickupAuthorizationInput,
  dependencies: MerchantPickupAuthorizationDependencies = DEFAULT_DEPENDENCIES
): Promise<MerchantPickupAuthorizationResult> {
  const pickupItems = pickupItemsFromOrder(input.items)
  if (pickupItems === null) {
    return { status: "unverified", reason: "invalid_snapshot" }
  }
  if (pickupItems.length === 0) return { status: "not_required" }

  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  const snapshot = pickupItems[0]?.fulfillment
  if (
    !snapshot ||
    pickupItems.some(
      (item) =>
        !pickupEnvelopeIsSelfConsistent(item) ||
        item.fulfillment.product.merchantPubkey.toLowerCase() !==
          merchantPubkey ||
        !sameCoordinate(
          item.productId,
          item.fulfillment.product.coordinate,
          [30402]
        )
    )
  ) {
    return { status: "unverified", reason: "invalid_snapshot" }
  }

  let resolution: EventMarketResolution
  try {
    resolution = await dependencies.getEventMarket({
      reference: snapshot.collection.coordinate,
      expectedOrganizerPubkey: snapshot.organizerPubkey,
      authenticatedPubkey: merchantPubkey,
    })
  } catch {
    return { status: "unverified", reason: "network_unavailable" }
  }

  if (resolution.state === "unavailable" || resolution.state === "stale") {
    return { status: "unverified", reason: "network_unavailable" }
  }
  if (
    resolution.state !== "active" &&
    resolution.state !== "partial" &&
    resolution.state !== "ended"
  ) {
    return {
      status: "unverified",
      reason: "organizer_evidence_not_current",
    }
  }
  if (!organizerGraphMatches(snapshot, resolution)) {
    return { status: "unverified", reason: "revision_mismatch" }
  }

  const decodedProductCoordinates = pickupItems.map((item) =>
    canonicalCoordinate(item.productId, [30402])
  )
  if (decodedProductCoordinates.some((coordinate) => coordinate === null)) {
    return { status: "unverified", reason: "invalid_snapshot" }
  }
  const productCoordinates = Array.from(
    new Set(
      decodedProductCoordinates.filter(
        (coordinate): coordinate is string => coordinate !== null
      )
    )
  )

  let productResult: ProductsByIdsResult
  try {
    productResult = await dependencies.getProductsByIds(productCoordinates, {
      includeMarketHidden: true,
    })
  } catch {
    return { status: "unverified", reason: "network_unavailable" }
  }

  const verifiedProducts: CommerceProductRecord[] = []
  for (const item of pickupItems) {
    const coordinate = canonicalCoordinate(item.productId, [30402])
    if (!coordinate) {
      return { status: "unverified", reason: "invalid_snapshot" }
    }
    if (productReadWasUnavailable(productResult, coordinate)) {
      return { status: "unverified", reason: "network_unavailable" }
    }
    if (!productDiagnosticIsCurrent(productResult, coordinate)) {
      return {
        status: "unverified",
        reason: "product_evidence_not_current",
      }
    }

    const record = productResult.data.find((candidate) =>
      sameCoordinate(candidate.addressId, coordinate, [30402])
    )
    if (
      !record ||
      !sameCoordinate(record.product.id, coordinate, [30402]) ||
      record.product.pubkey.toLowerCase() !== merchantPubkey ||
      record.product.format !== "physical"
    ) {
      return { status: "unverified", reason: "authorization_missing" }
    }
    if (
      !resolution.collection ||
      !hasExactCoordinate(
        resolution.collection.productCoordinates,
        coordinate,
        [30402]
      )
    ) {
      return { status: "unverified", reason: "authorization_missing" }
    }

    const participation = resolveEventMarketProductParticipation(
      record.product,
      resolution
    )
    if (
      !participation.requested ||
      !participation.accepted ||
      (!participation.pickupReferenced &&
        !participation.collectionReferencedForFulfillment)
    ) {
      return { status: "unverified", reason: "authorization_missing" }
    }

    const currentFulfillment = resolveEventMarketProductFulfillment(
      record.product,
      resolution
    )
    const snapshotAuthority = resolveOrderPickupHandoffAuthority(
      item.fulfillment
    )
    if (
      currentFulfillment.status !== "resolved" ||
      currentFulfillment.handoffMode !== snapshotAuthority.mode ||
      currentFulfillment.handoffPubkey !== snapshotAuthority.handlerPubkey ||
      !sameCoordinate(
        currentFulfillment.selectedPickup.coordinate,
        item.fulfillment.option.coordinate,
        [30406]
      )
    ) {
      return { status: "unverified", reason: "revision_mismatch" }
    }

    if (!productPriceMatchesCurrentEvidence(item, record.product)) {
      return { status: "unverified", reason: "price_mismatch" }
    }

    const currentSourceCost = currentFulfillment.sourceCost
    if (
      !currentSourceCost ||
      !pickupCostMatchesCurrentEvidence(item, currentSourceCost)
    ) {
      return { status: "unverified", reason: "cost_mismatch" }
    }
    verifiedProducts.push(record)
  }

  return { status: "verified", market: resolution, products: verifiedProducts }
}

export function getMerchantPickupAuthorizationMessage(
  result: MerchantPickupAuthorizationResult | undefined
): string {
  if (!result) {
    return "Checking current signed organizer and product evidence."
  }
  if (result.status === "verified") {
    return "Current signed organizer and product evidence is verified."
  }
  if (result.status === "not_required") {
    return "Pickup verification is not required."
  }
  if (result.reason === "network_unavailable") {
    return "Current signed pickup evidence could not be verified from relays. Try again when relay access recovers."
  }
  if (result.reason === "organizer_evidence_not_current") {
    return "The organizer event evidence is no longer current, so pickup actions are unavailable."
  }
  if (result.reason === "product_evidence_not_current") {
    return "The product's current signed evidence could not authorize pickup."
  }
  if (result.reason === "revision_mismatch") {
    return "The pickup evidence changed after the order was created. Review the order before continuing."
  }
  if (result.reason === "cost_mismatch") {
    return "The pickup cost does not match current signed organizer and product evidence."
  }
  if (result.reason === "price_mismatch") {
    return "The product price does not match the signed order snapshot."
  }
  return "The order's current signed evidence does not authorize pickup actions."
}
