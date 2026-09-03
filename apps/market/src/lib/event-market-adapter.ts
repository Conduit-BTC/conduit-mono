import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  getEventMarket,
  getProductEventMarketFulfillmentClaims,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  hasMarketVisibleListingImage,
  isMerchantHiddenOnlyListingSafetyAllowed,
  normalizeCommercePrice,
  prepareProductCatalog,
  reconcileContextualListingSafety,
  resolveEventMarketProductFulfillment,
  resolveEventMarketProductParticipation,
  type EventMarketResolution,
  type EventMarketResolutionState,
  type CommerceProductRecord,
  type ProductEventMarketFulfillmentClaim,
  type ListingSafetyContext,
  type PreparedProductFamily,
  type PricingRateInput,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import type {
  CartItem,
  CartItemFulfillment,
  CartPickupFulfillment,
} from "./cart-model"

const EVENT_COLLECTION_KIND = 30405

export type EventCatalogProduct = {
  product: Product
  family?: PreparedProductFamily<CommerceProductRecord>
  evidenceState: "live" | "retained"
  participation: ReturnType<typeof resolveEventMarketProductParticipation>
  pickupFulfillment: CartPickupFulfillment | null
  /** Exact child snapshots only; parent acceptance never authorizes a child. */
  familyPickupFulfillments?: Record<string, CartPickupFulfillment | null>
}

export type EventCatalog = {
  state: EventMarketResolutionState
  reference: string
  canonicalNaddr?: string
  organizerPubkey?: string
  collection?: EventMarketResolution["collection"]
  calendar?: EventMarketResolution["calendar"]
  pickup?: EventMarketResolution["pickup"]
  pickups: EventMarketResolution["pickups"]
  products: EventCatalogProduct[]
  /** Organizer-accepted coordinates after stronger known negative evidence. */
  acceptedProductCount: number
  /** Accepted coordinates with neither safe retained nor current product data. */
  unresolvedProductCoordinates: string[]
  productReadState: "not_requested" | "ready" | "partial" | "unavailable"
  purchaseReady: boolean
}

export type PickupFreshnessResult =
  | { fresh: true }
  | {
      fresh: false
      reason: string
    }

export type ProductEventMarketCandidate = ProductEventMarketFulfillmentClaim & {
  canonicalNaddr: string
}

export type ProductCartFulfillmentResolution =
  | {
      status: "standard"
      type: "digital" | "shipping"
      product: Product
    }
  | {
      status: "pickup"
      product: Product
      fulfillment: CartPickupFulfillment
      collectionCoordinate: string
      canonicalNaddr: string
      eventState: EventMarketResolutionState
    }
  | {
      status: "blocked"
      product: Product
      collectionCoordinate: string
      canonicalNaddr: string
      eventState: EventMarketResolutionState | "mismatch"
      reason: string
    }

type EventCatalogLoader = (
  reference: string,
  rateInput?: PricingRateInput
) => Promise<EventCatalog>

function unavailableCatalog(
  reference: string,
  state: EventMarketResolutionState
): EventCatalog {
  return {
    state,
    reference,
    products: [],
    acceptedProductCount: 0,
    unresolvedProductCoordinates: [],
    pickups: [],
    productReadState: "not_requested",
    purchaseReady: false,
  }
}

export type PickupFulfillmentTerms = Omit<CartPickupFulfillment, "costSats">

export function buildPickupFulfillmentTerms(
  product: Product,
  resolution: EventMarketResolution,
  productEvidence: { eventId: string; eventCreatedAt: number }
): PickupFulfillmentTerms | null {
  const { calendar, collection, organizerPubkey } = resolution
  if (
    product.format !== "physical" ||
    !Number.isSafeInteger(productEvidence.eventCreatedAt) ||
    product.createdAt !== productEvidence.eventCreatedAt * 1_000 ||
    !calendar ||
    !collection ||
    !organizerPubkey
  ) {
    return null
  }

  const participation = resolveEventMarketProductParticipation(
    product,
    resolution
  )
  const fulfillmentDecision = resolveEventMarketProductFulfillment(
    product,
    resolution
  )
  if (
    !participation.accepted ||
    !participation.requested ||
    fulfillmentDecision.status !== "resolved"
  ) {
    return null
  }

  const pickup = fulfillmentDecision.selectedPickup

  const sourceCost = fulfillmentDecision.sourceCost
  if (!sourceCost) return null

  return {
    type: "pickup",
    organizerPubkey,
    product: {
      coordinate: product.id,
      eventId: productEvidence.eventId,
      createdAt: product.createdAt,
      merchantPubkey: product.pubkey,
    },
    calendar: {
      coordinate: calendar.coordinate,
      eventId: calendar.eventId,
      createdAt: calendar.createdAt,
    },
    collection: {
      coordinate: collection.coordinate,
      eventId: collection.eventId,
      createdAt: collection.createdAt,
    },
    option: {
      coordinate: pickup.coordinate,
      eventId: pickup.eventId,
      createdAt: pickup.createdAt,
      title: pickup.title,
      location: pickup.location,
      geohash: pickup.geohash,
    },
    handoffMode: fulfillmentDecision.handoffMode,
    handlerPubkey: fulfillmentDecision.handoffPubkey,
    sourceCost,
  }
}

export function buildPickupFulfillmentSnapshot(
  product: Product,
  resolution: EventMarketResolution,
  productEvidence: { eventId: string; eventCreatedAt: number },
  rateInput: PricingRateInput = null
): CartPickupFulfillment | null {
  const terms = buildPickupFulfillmentTerms(
    product,
    resolution,
    productEvidence
  )
  if (!terms) return null

  const normalized = normalizeCommercePrice(
    terms.sourceCost.amount,
    terms.sourceCost.normalizedCurrency,
    rateInput
  )
  const costSats =
    terms.sourceCost.amount === 0
      ? 0
      : normalized.status === "ok"
        ? normalized.sats
        : undefined
  if (costSats === undefined) return null

  return { ...terms, costSats }
}

export function buildEventCatalogFamilyPickupFulfillments(
  family: PreparedProductFamily<CommerceProductRecord>,
  resolution: EventMarketResolution,
  rateInput: PricingRateInput = null
): Record<string, CartPickupFulfillment | null> {
  return Object.fromEntries(
    family.children.map((child) => [
      child.product.id,
      buildPickupFulfillmentSnapshot(
        child.product,
        resolution,
        child,
        rateInput
      ),
    ])
  )
}

function productReadIsLive(
  result: Pick<ProductsByIdsResult, "diagnostics">,
  productCoordinate: string
): boolean {
  const diagnostic = result.diagnostics.find(
    (entry) => entry.productId === productCoordinate
  )
  return hasExactLiveProductAvailabilityEvidence(diagnostic, productCoordinate)
}

function acceptedEvidenceFor(
  resolution: EventMarketResolution,
  productCoordinate: string
) {
  return resolution.acceptedProductEvidence.find(
    (evidence) => evidence.productCoordinate === productCoordinate
  )
}

/**
 * Compare a selected product revision with the exact merchant revision that
 * established two-sided acceptance. Positive means the selected record wins
 * NIP-01 replacement ordering; negative means it predates that evidence.
 */
function compareRecordToAcceptedEvidence(
  record: CommerceProductRecord,
  resolution: EventMarketResolution
): number | null {
  const acceptedEvidence = acceptedEvidenceFor(resolution, record.product.id)
  if (!acceptedEvidence) return null

  const recordCreatedAt = record.eventCreatedAt * 1_000
  if (recordCreatedAt !== acceptedEvidence.createdAt) {
    return recordCreatedAt > acceptedEvidence.createdAt ? 1 : -1
  }

  const recordEventId = record.eventId.toLowerCase()
  const acceptedEventId = acceptedEvidence.eventId.toLowerCase()
  if (recordEventId === acceptedEventId) return 0

  // NIP-01 retains the lexicographically lowest id at equal timestamps.
  return recordEventId < acceptedEventId ? 1 : -1
}

function productRecordIsKnownWithdrawal(
  record: CommerceProductRecord,
  resolution: EventMarketResolution,
  participation: ReturnType<typeof resolveEventMarketProductParticipation>,
  live: boolean
): boolean {
  if (participation.requested) return false

  const comparison = compareRecordToAcceptedEvidence(record, resolution)
  // Without comparable two-sided evidence, only current live product evidence
  // is strong enough to call the participation request withdrawn.
  if (comparison === null) return live
  return comparison > 0
}

function productRecordCanRepresentAcceptedEvidence(
  record: CommerceProductRecord,
  resolution: EventMarketResolution
): boolean {
  const participation = resolveEventMarketProductParticipation(
    record.product,
    resolution
  )
  const comparison = compareRecordToAcceptedEvidence(record, resolution)
  return (
    participation.requested &&
    participation.accepted &&
    comparison !== null &&
    comparison >= 0
  )
}

function hasExactEventCatalogClaim(
  product: Product,
  resolution: EventMarketResolution
): boolean {
  const participation = resolveEventMarketProductParticipation(
    product,
    resolution
  )
  return (
    participation.requested &&
    participation.accepted &&
    resolveEventMarketProductFulfillment(product, resolution).status ===
      "resolved"
  )
}

function getEventCatalogSafety(
  record: CommerceProductRecord,
  context?: ListingSafetyContext
) {
  return reconcileContextualListingSafety(
    record.product,
    record.safety,
    context
  )
}

function isEventCatalogRecordSafetyAllowed(
  record: CommerceProductRecord,
  resolution: EventMarketResolution,
  context?: ListingSafetyContext,
  allowUnacceptedMerchantHidden = false
): boolean {
  const safety = getEventCatalogSafety(record, context)
  if (
    safety.source === "external_decision" ||
    safety.reasons.some(
      (reason) =>
        reason.code === "external_decision" || reason.code === "pending_review"
    )
  ) {
    return false
  }

  if (safety.state === "active" || safety.state === "flagged") return true
  if (
    safety.state !== "hidden" ||
    (safety.source !== "client_rules" &&
      safety.source !== "merchant_visibility") ||
    (!allowUnacceptedMerchantHidden &&
      !hasExactEventCatalogClaim(record.product, resolution))
  ) {
    return false
  }

  return isMerchantHiddenOnlyListingSafetyAllowed(safety)
}

function prepareEventCatalogFamily(
  record: CommerceProductRecord,
  resolution: EventMarketResolution,
  liveCoordinates: ReadonlySet<string>
): CommerceProductRecord | null {
  if (record.product.type !== "variable" || record.family?.state !== "ready") {
    return null
  }

  const structuralParentContext: ListingSafetyContext = {
    variationGroupRole: "parent",
    // Image eligibility is derived below. This pass only establishes that the
    // parent is otherwise safe enough to provide family structure.
    hasGroupImage: true,
  }
  if (
    !isEventCatalogRecordSafetyAllowed(
      record,
      resolution,
      structuralParentContext,
      true
    )
  ) {
    return null
  }

  const ownImageChildContext: ListingSafetyContext = {
    variationGroupRole: "variation",
    hasGroupImage: true,
  }
  const acceptedChildren = record.family.children.filter(
    (child) =>
      hasExactEventCatalogClaim(child.product, resolution) &&
      productRecordCanRepresentAcceptedEvidence(child, resolution)
  )
  const hasEligibleChildImage = acceptedChildren.some(
    (child) =>
      liveCoordinates.has(child.product.id) &&
      hasMarketVisibleListingImage(child.product) &&
      isEventCatalogRecordSafetyAllowed(child, resolution, ownImageChildContext)
  )
  const hasGroupImage =
    (liveCoordinates.has(record.product.id) &&
      hasMarketVisibleListingImage(record.product)) ||
    hasEligibleChildImage
  const parentContext: ListingSafetyContext = {
    variationGroupRole: "parent",
    hasGroupImage,
  }
  if (
    !isEventCatalogRecordSafetyAllowed(record, resolution, parentContext, true)
  ) {
    return null
  }

  const childContext: ListingSafetyContext = {
    variationGroupRole: "variation",
    hasGroupImage,
  }
  const eligibleChildren = acceptedChildren
    .filter((child) =>
      isEventCatalogRecordSafetyAllowed(child, resolution, childContext)
    )
    .map((child) => ({
      ...child,
      safety: getEventCatalogSafety(child, childContext),
    }))
  const prepared = prepareProductCatalog(
    [
      {
        ...record,
        family: undefined,
        safety: getEventCatalogSafety(record, parentContext),
      },
      ...eligibleChildren,
    ],
    record.family.readEvidence
  ).items[0]
  if (prepared?.kind !== "family" || prepared.family.state !== "ready") {
    return null
  }
  return {
    ...prepared.family.parent,
    family: prepared.family,
  }
}

/**
 * Exact event reads may intentionally recover merchant-hidden event products,
 * but they must not bypass the rest of Market's listing-safety decisions.
 */
export function isEventCatalogRecordRenderable(
  record: CommerceProductRecord,
  resolution: EventMarketResolution,
  preparedVariation = false
): boolean {
  if (record.product.type === "variation" && !preparedVariation) return false
  if (record.product.type === "variable" && record.family?.state !== "ready") {
    return false
  }
  return isEventCatalogRecordSafetyAllowed(record, resolution)
}

export function projectEventCatalogProducts({
  requested,
  records,
  liveCoordinates,
  resolution,
  rateInput = null,
}: {
  requested: readonly string[]
  records: readonly CommerceProductRecord[]
  liveCoordinates: ReadonlySet<string>
  resolution: EventMarketResolution
  rateInput?: PricingRateInput
}): EventCatalogProduct[] {
  const recordsByCoordinate = new Map<string, CommerceProductRecord>()
  const familyChildCoordinates = new Set(
    records.flatMap(
      (record) => record.family?.children.map((child) => child.product.id) ?? []
    )
  )
  for (const record of records) {
    if (record.product.type === "simple") {
      if (
        productRecordCanRepresentAcceptedEvidence(record, resolution) &&
        isEventCatalogRecordRenderable(record, resolution)
      ) {
        recordsByCoordinate.set(record.product.id, record)
      }
      continue
    }
    if (record.product.type === "variation") {
      // When family context is available, only the family projection may
      // authorize a child. Raw child records can carry safety contextualized
      // by cache-only siblings that are removed from the exact-live view.
      if (familyChildCoordinates.has(record.product.id)) continue
      // Buyer-scoped exact reads may return an accepted child without its
      // unaccepted parent. Core has already contextualized family safety for
      // this atomic record; keep the exact child instead of requiring the
      // parent coordinate to be accepted too.
      if (
        productRecordCanRepresentAcceptedEvidence(record, resolution) &&
        isEventCatalogRecordRenderable(record, resolution, true)
      ) {
        recordsByCoordinate.set(record.product.id, record)
      }
      continue
    }
    const prepared = prepareEventCatalogFamily(
      record,
      resolution,
      liveCoordinates
    )
    if (!prepared?.family) continue
    if (
      productRecordCanRepresentAcceptedEvidence(prepared, resolution) &&
      isEventCatalogRecordRenderable(prepared, resolution)
    ) {
      recordsByCoordinate.set(prepared.product.id, prepared)
    }
    for (const child of prepared.family.children) {
      if (
        productRecordCanRepresentAcceptedEvidence(child, resolution) &&
        isEventCatalogRecordRenderable(child, resolution, true)
      ) {
        recordsByCoordinate.set(child.product.id, child)
      }
    }
  }
  const familyPickupFulfillmentsByParent = new Map<
    string,
    Record<string, CartPickupFulfillment | null>
  >()
  const foldedChildCoordinates = new Set<string>()

  for (const coordinate of requested) {
    const record = recordsByCoordinate.get(coordinate)
    if (!record?.family) continue

    const familyPickupFulfillments = Object.fromEntries(
      Object.entries(
        buildEventCatalogFamilyPickupFulfillments(
          record.family,
          resolution,
          rateInput
        )
      ).map(([childCoordinate, fulfillment]) => [
        childCoordinate,
        liveCoordinates.has(childCoordinate) ? fulfillment : null,
      ])
    )
    familyPickupFulfillmentsByParent.set(coordinate, familyPickupFulfillments)
    for (const child of record.family.children) {
      if (requested.includes(child.product.id)) {
        foldedChildCoordinates.add(child.product.id)
      }
    }
  }

  return requested.flatMap<EventCatalogProduct>((coordinate) => {
    const record = recordsByCoordinate.get(coordinate)
    if (!record || foldedChildCoordinates.has(coordinate)) {
      return []
    }

    const { product } = record
    const live = liveCoordinates.has(coordinate)
    const participation = resolveEventMarketProductParticipation(
      product,
      resolution
    )
    // A selected signed listing revision that no longer requests this
    // collection is stronger negative evidence than older organizer-retained
    // acceptance, even when the latest relay read could not reconfirm it.
    if (
      productRecordIsKnownWithdrawal(record, resolution, participation, live)
    ) {
      return []
    }

    return [
      {
        product,
        family: record.family,
        evidenceState: live ? "live" : "retained",
        participation,
        pickupFulfillment: live
          ? buildPickupFulfillmentSnapshot(
              product,
              resolution,
              record,
              rateInput
            )
          : null,
        familyPickupFulfillments:
          familyPickupFulfillmentsByParent.get(coordinate),
      },
    ]
  })
}

function productReadIsDefinitivelyAbsent(
  result: ProductsByIdsResult,
  productCoordinate: string
): boolean {
  const issue = result.diagnostics.find(
    (entry) => entry.productId === productCoordinate
  )?.issue
  return issue === "invalid_product_reference" || issue === "listing_filtered"
}

export function projectEventCatalogHydration({
  resolution,
  result,
  rateInput = null,
}: {
  resolution: EventMarketResolution
  result: ProductsByIdsResult
  rateInput?: PricingRateInput
}): Pick<
  EventCatalog,
  | "products"
  | "acceptedProductCount"
  | "unresolvedProductCoordinates"
  | "productReadState"
> {
  const requested = resolution.acceptedProductCoordinates
  if (requested.length === 0) {
    return {
      products: [],
      acceptedProductCount: 0,
      unresolvedProductCoordinates: [],
      productReadState: "ready",
    }
  }

  const recordsByCoordinate = new Map(
    result.data.map((record) => [record.product.id, record])
  )
  const liveCoordinates = new Set(
    requested.filter((coordinate) => {
      const record = recordsByCoordinate.get(coordinate)
      return !!record && productReadIsLive(result, coordinate)
    })
  )
  const omittedCoordinates = new Set(
    requested.filter((coordinate) => {
      if (productReadIsDefinitivelyAbsent(result, coordinate)) return true
      const record = recordsByCoordinate.get(coordinate)
      if (!record) return false
      const participation = resolveEventMarketProductParticipation(
        record.product,
        resolution
      )
      return productRecordIsKnownWithdrawal(
        record,
        resolution,
        participation,
        liveCoordinates.has(coordinate)
      )
    })
  )
  const displayCoordinates = requested.filter(
    (coordinate) => !omittedCoordinates.has(coordinate)
  )
  const products = projectEventCatalogProducts({
    requested: displayCoordinates,
    records: result.data,
    liveCoordinates,
    resolution,
    rateInput,
  })
  const representedCoordinates = new Set(
    products.flatMap((entry) => [
      entry.product.id,
      ...(entry.family?.children.map((child) => child.product.id) ?? []),
    ])
  )
  const unresolvedProductCoordinates = displayCoordinates.filter(
    (coordinate) => !representedCoordinates.has(coordinate)
  )
  const uncertainCoordinates = displayCoordinates.filter(
    (coordinate) => !liveCoordinates.has(coordinate)
  )

  return {
    products,
    acceptedProductCount: displayCoordinates.length,
    unresolvedProductCoordinates,
    productReadState:
      uncertainCoordinates.length === 0 &&
      unresolvedProductCoordinates.length === 0
        ? "ready"
        : liveCoordinates.size === 0 &&
            (result.meta.source === "local_cache" || result.meta.stale)
          ? "unavailable"
          : "partial",
  }
}

async function hydrateAcceptedProducts(
  resolution: EventMarketResolution,
  rateInput: PricingRateInput
): Promise<
  Pick<
    EventCatalog,
    | "products"
    | "acceptedProductCount"
    | "unresolvedProductCoordinates"
    | "productReadState"
  >
> {
  const requested = resolution.acceptedProductCoordinates
  if (requested.length === 0) {
    return {
      products: [],
      acceptedProductCount: 0,
      unresolvedProductCoordinates: [],
      productReadState: "ready",
    }
  }

  const result = await getProductsByIds(requested, {
    includeMerchantHiddenProductIds: requested,
  })
  return projectEventCatalogHydration({
    resolution,
    result,
    rateInput,
  })
}

export async function loadEventCatalog(
  reference: string,
  rateInput: PricingRateInput = null
): Promise<EventCatalog> {
  const decoded = decodeEventMarketReference(reference, [EVENT_COLLECTION_KIND])
  if (!decoded) return unavailableCatalog(reference, "malformed")

  const canonicalNaddr = encodeEventMarketNaddr(
    decoded.coordinate,
    decoded.relayHints
  )
  const resolution = await getEventMarket({ reference: canonicalNaddr })
  const base: EventCatalog = {
    state: resolution.state,
    reference: resolution.reference,
    canonicalNaddr,
    organizerPubkey: resolution.organizerPubkey,
    collection: resolution.collection,
    calendar: resolution.calendar,
    pickup: resolution.pickup,
    pickups: resolution.pickups,
    products: [],
    acceptedProductCount: resolution.acceptedProductCoordinates.length,
    unresolvedProductCoordinates: [],
    productReadState: "not_requested",
    purchaseReady: false,
  }

  if (
    resolution.state !== "active" &&
    resolution.state !== "ended" &&
    resolution.state !== "partial" &&
    resolution.state !== "stale"
  ) {
    return base
  }

  const hydrated = await hydrateAcceptedProducts(resolution, rateInput)
  return {
    ...base,
    ...hydrated,
    // Product hydration is fail-closed per requested coordinate. A degraded
    // batch must not disable a different item that still has exact positive
    // live evidence and a purchase-ready two-sided linkage.
    purchaseReady:
      resolution.state === "active" || resolution.state === "partial",
  }
}

/**
 * Find only references that could express the event-market extension. An
 * ordinary kind-30406 option owned by a different author is regular shipping,
 * even when the product also belongs to an unrelated collection.
 */
export function getProductEventMarketCandidates(
  product: Product
): ProductEventMarketCandidate[] {
  return getProductEventMarketFulfillmentClaims(product).map((claim) => ({
    ...claim,
    canonicalNaddr: encodeEventMarketNaddr(claim.collectionCoordinate),
  }))
}

function directPickupClaimMatchesCollection(
  product: Product,
  candidate: ProductEventMarketCandidate,
  catalog: EventCatalog
): boolean {
  if (catalog.collection && catalog.pickups.length > 0) {
    return (
      resolveEventMarketProductFulfillment(product, catalog).status !== "none"
    )
  }

  // A current ordinary collection with no NIP-52 event link is not an
  // event-market claim, even when it declares a same-author shipping option.
  // Preserve standard Gamma collection shipping instead of forcing it through
  // the event-pickup resolver.
  if (
    catalog.collection &&
    catalog.collection.eventCoordinates.length === 0 &&
    catalog.collection.unsupportedReferences.length === 0
  ) {
    return false
  }

  if (candidate.collectionReferencedForFulfillment) {
    // A resolved collection with event-shaped references is positive evidence.
    // Without collection evidence, only the explicit hidden visibility emitted
    // by Conduit event authoring is strong enough to fail closed; public
    // collection-level shipping remains ordinary shipping until proved eventful.
    return !!catalog.collection || product.visibility !== "public"
  }

  const declaredPickupCoordinates = catalog.collection?.pickupCoordinates ?? []
  if (declaredPickupCoordinates.length > 0) {
    return candidate.directPickupCoordinates.some((coordinate) =>
      declaredPickupCoordinates.includes(coordinate)
    )
  }

  // A same-author kind-30406 reference is also a normal shipping shape. When
  // the collection cannot be resolved, do not convert a public listing into an
  // event listing from absence alone. Newly authored event products are hidden
  // explicitly and remain fail-closed while their graph is unavailable.
  return product.visibility !== "public"
}

function blockedProductResolution(
  product: Product,
  candidate: ProductEventMarketCandidate,
  catalog: EventCatalog
): ProductCartFulfillmentResolution {
  const accepted =
    catalog.collection?.productCoordinates.includes(product.id) ?? false
  const eventState = catalog.state
  let reason: string

  if (eventState === "ended") {
    reason = "This event pickup has ended, so it can no longer be added."
  } else if (eventState === "deleted") {
    reason = "The organizer removed this event pickup."
  } else if (eventState === "unavailable" || eventState === "partial") {
    reason =
      "Current signed event pickup evidence could not be confirmed. Try again when relays recover."
  } else if (eventState === "stale") {
    reason =
      "Only an older event pickup snapshot is available. Refresh the event catalog before ordering."
  } else if (eventState === "missing") {
    reason =
      "The referenced event catalog could not be found on the configured relays."
  } else if (
    eventState === "malformed" ||
    eventState === "conflicting" ||
    eventState === "unsupported"
  ) {
    reason = "The signed event pickup references cannot be reconciled safely."
  } else if (!accepted) {
    reason =
      "The organizer has not currently accepted this product for event pickup."
  } else if (catalog.productReadState !== "ready") {
    reason =
      "The current product revision could not be confirmed for this event pickup."
  } else {
    reason =
      "The merchant pickup reference does not match a current collection-approved event pickup."
  }

  return {
    status: "blocked",
    product,
    collectionCoordinate: candidate.collectionCoordinate,
    canonicalNaddr: catalog.canonicalNaddr ?? candidate.canonicalNaddr,
    eventState:
      eventState === "active" ? "mismatch" : (eventState ?? "mismatch"),
    reason,
  }
}

/**
 * Resolve a generic product surface into its only safe cart fulfillment. The
 * caller must use the returned product revision for pickup so the snapshot and
 * cart price come from the same exact live signed event.
 */
export async function resolveProductCartFulfillment(
  product: Product,
  rateInput: PricingRateInput = null,
  loadCatalog: EventCatalogLoader = loadEventCatalog
): Promise<ProductCartFulfillmentResolution> {
  if (product.format === "digital") {
    return { status: "standard", type: "digital", product }
  }

  const candidates = getProductEventMarketCandidates(product)
  if (candidates.length === 0) {
    return { status: "standard", type: "shipping", product }
  }

  const catalogs = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return {
          candidate,
          catalog: await loadCatalog(candidate.canonicalNaddr, rateInput),
        }
      } catch {
        return {
          candidate,
          catalog: unavailableCatalog(
            candidate.collectionCoordinate,
            "unavailable"
          ),
        }
      }
    })
  )
  const eventClaims = catalogs.filter(({ candidate, catalog }) =>
    directPickupClaimMatchesCollection(product, candidate, catalog)
  )

  if (eventClaims.length === 0) {
    return { status: "standard", type: "shipping", product }
  }
  if (eventClaims.length > 1) {
    const first = eventClaims[0]!
    return {
      status: "blocked",
      product,
      collectionCoordinate: first.candidate.collectionCoordinate,
      canonicalNaddr:
        first.catalog.canonicalNaddr ?? first.candidate.canonicalNaddr,
      eventState: "conflicting",
      reason:
        "This listing references more than one possible event pickup. Open the event catalog and choose an exact listing.",
    }
  }

  const { candidate, catalog } = eventClaims[0]!
  const entry = catalog.products.find(
    ({ product: catalogProduct }) => catalogProduct.id === product.id
  )
  const fulfillmentDecision = resolveEventMarketProductFulfillment(
    entry?.product ?? product,
    catalog
  )
  if (fulfillmentDecision.status === "ambiguous") {
    return {
      status: "blocked",
      product,
      collectionCoordinate: candidate.collectionCoordinate,
      canonicalNaddr: catalog.canonicalNaddr ?? candidate.canonicalNaddr,
      eventState: "conflicting",
      reason:
        "This listing has conflicting event pickup and shipping evidence. Open the event catalog for a supported fulfillment choice.",
    }
  }
  if (
    catalog.purchaseReady &&
    entry?.participation.purchaseReady &&
    entry.pickupFulfillment
  ) {
    return {
      status: "pickup",
      product: entry.product,
      fulfillment: entry.pickupFulfillment,
      collectionCoordinate: candidate.collectionCoordinate,
      canonicalNaddr: catalog.canonicalNaddr ?? candidate.canonicalNaddr,
      eventState: catalog.state,
    }
  }

  return blockedProductResolution(product, candidate, catalog)
}

function pickupSourceCostMatches(
  left: CartPickupFulfillment["sourceCost"] | undefined,
  right: CartPickupFulfillment["sourceCost"]
): boolean {
  return (
    left?.amount === right.amount &&
    left.currency === right.currency &&
    left.normalizedCurrency === right.normalizedCurrency
  )
}

function pickupSnapshotMatches(
  snapshot: CartPickupFulfillment,
  current: PickupFulfillmentTerms
): boolean {
  return (
    snapshot.type === current.type &&
    snapshot.organizerPubkey === current.organizerPubkey &&
    snapshot.handoffMode === current.handoffMode &&
    snapshot.handlerPubkey === current.handlerPubkey &&
    snapshot.product.coordinate === current.product.coordinate &&
    snapshot.product.merchantPubkey === current.product.merchantPubkey &&
    snapshot.product.eventId === current.product.eventId &&
    snapshot.product.createdAt === current.product.createdAt &&
    snapshot.calendar.coordinate === current.calendar.coordinate &&
    snapshot.calendar.eventId === current.calendar.eventId &&
    snapshot.calendar.createdAt === current.calendar.createdAt &&
    snapshot.collection.coordinate === current.collection.coordinate &&
    snapshot.collection.eventId === current.collection.eventId &&
    snapshot.collection.createdAt === current.collection.createdAt &&
    snapshot.option.coordinate === current.option.coordinate &&
    snapshot.option.eventId === current.option.eventId &&
    snapshot.option.createdAt === current.option.createdAt &&
    snapshot.option.title === current.option.title &&
    snapshot.option.location === current.option.location &&
    snapshot.option.geohash === current.option.geohash &&
    pickupSourceCostMatches(snapshot.sourceCost, current.sourceCost)
  )
}

function pickupResolvedCostIsConsistent(
  item: PickupFreshnessPickupItem,
  current: PickupFulfillmentTerms
): boolean {
  if (
    item.shippingCostSats !== item.fulfillment.costSats ||
    !Number.isSafeInteger(item.shippingCostSats) ||
    item.shippingCostSats! < 0
  ) {
    return false
  }

  const normalized = normalizeCommercePrice(
    current.sourceCost.amount,
    current.sourceCost.normalizedCurrency,
    null
  )
  const deterministicCostSats =
    current.sourceCost.amount === 0
      ? 0
      : normalized.status === "ok" && !normalized.approximate
        ? normalized.sats
        : null
  return (
    deterministicCostSats === null ||
    item.shippingCostSats === deterministicCostSats
  )
}

export type PickupFreshnessItem = {
  productId: string
  merchantPubkey?: string
  format?: "physical" | "digital"
  fulfillment?: CartItemFulfillment
  shippingOptionId?: string
  shippingOptionDTag?: string
  shippingCostSats?: number
  sourceShippingCost?: CartPickupFulfillment["sourceCost"]
}

type PickupFreshnessPickupItem = PickupFreshnessItem & {
  fulfillment: CartPickupFulfillment
}

/**
 * Bind the signed pickup graph to every outer cart/order field that can affect
 * routing or payment. Product price remains covered by the normal fresh
 * listing-pricing path; this guard owns pickup identity and cost parity.
 */
export function pickupItemMatchesCanonicalSnapshot(
  item: PickupFreshnessPickupItem,
  current: PickupFulfillmentTerms,
  expectedMerchantPubkey?: string
): boolean {
  const optionDTag = current.option.coordinate.split(":").slice(2).join(":")
  const merchantPubkey = item.merchantPubkey ?? expectedMerchantPubkey
  return (
    item.productId === current.product.coordinate &&
    item.format === "physical" &&
    merchantPubkey === current.product.merchantPubkey &&
    (!item.merchantPubkey ||
      item.merchantPubkey === current.product.merchantPubkey) &&
    (!expectedMerchantPubkey ||
      expectedMerchantPubkey === current.product.merchantPubkey) &&
    item.shippingOptionId === current.option.coordinate &&
    item.shippingOptionDTag === optionDTag &&
    pickupResolvedCostIsConsistent(item, current) &&
    pickupSourceCostMatches(item.sourceShippingCost, current.sourceCost) &&
    pickupSnapshotMatches(item.fulfillment, current)
  )
}

/**
 * Re-read every signed coordinate before direct payment. Any unavailable,
 * stale, deleted, changed, or no-longer-authorized link closes the fast path.
 */
export async function verifyPickupFulfillmentFreshness(
  item: PickupFreshnessPickupItem,
  expectedMerchantPubkey?: string
): Promise<PickupFreshnessResult> {
  const snapshot = item.fulfillment
  const reference = encodeEventMarketNaddr(snapshot.collection.coordinate)
  const resolution = await getEventMarket({
    reference,
    expectedOrganizerPubkey: snapshot.organizerPubkey,
  })
  if (resolution.state !== "active" && resolution.state !== "partial") {
    return {
      fresh: false,
      reason:
        "Signed event pickup evidence is no longer current. Refresh the event catalog before paying.",
    }
  }

  const productResult = await getProductsByIds([item.productId], {
    includeMerchantHiddenProductIds: [item.productId],
  })
  const freshRecord = productResult.data.find(
    (record) => record.product.id === item.productId
  )
  if (!freshRecord || !productReadIsLive(productResult, item.productId)) {
    return {
      fresh: false,
      reason:
        "The product's current event participation could not be verified. Try again when relays recover.",
    }
  }

  const current = buildPickupFulfillmentTerms(
    freshRecord.product,
    resolution,
    freshRecord
  )
  if (
    !current ||
    !pickupItemMatchesCanonicalSnapshot(item, current, expectedMerchantPubkey)
  ) {
    return {
      fresh: false,
      reason:
        "Event pickup details changed after this item was added. Return to the event catalog and add it again.",
    }
  }

  return { fresh: true }
}

export async function verifyPickupCartFreshness(
  items: ReadonlyArray<PickupFreshnessItem>,
  expectedMerchantPubkey?: string
): Promise<PickupFreshnessResult> {
  const pickupItems = items.filter(
    (item): item is PickupFreshnessPickupItem =>
      item.fulfillment?.type === "pickup"
  )
  const results = await Promise.all(
    pickupItems.map((item) =>
      verifyPickupFulfillmentFreshness(item, expectedMerchantPubkey)
    )
  )
  return results.find((result) => !result.fresh) ?? { fresh: true }
}

export type CartEventFulfillmentBlock = {
  productId: string
  message: string
  canonicalNaddr?: string
}

/**
 * Compare persisted cart fulfillment to freshly resolved signed product/event
 * evidence. This catches carts created by older generic surfaces that silently
 * stored an event-pickup listing as shipment.
 */
export function getCartEventFulfillmentBlock(
  items: readonly CartItem[],
  resolutions: ReadonlyMap<string, ProductCartFulfillmentResolution>
): CartEventFulfillmentBlock | null {
  for (const item of items) {
    const resolution = resolutions.get(item.productId)
    if (!resolution) continue

    if (resolution.status === "blocked") {
      return {
        productId: item.productId,
        message: `${item.title}: ${resolution.reason}`,
        canonicalNaddr: resolution.canonicalNaddr,
      }
    }

    if (resolution.status === "pickup") {
      if (
        item.fulfillment?.type !== "pickup" ||
        !pickupItemMatchesCanonicalSnapshot(
          { ...item, fulfillment: item.fulfillment },
          resolution.fulfillment,
          item.merchantPubkey
        )
      ) {
        return {
          productId: item.productId,
          message: `${item.title} must be re-added from its signed event catalog so pickup details replace the old shipping snapshot.`,
          canonicalNaddr: resolution.canonicalNaddr,
        }
      }
      continue
    }

    if (resolution.type === "shipping" && item.fulfillment?.type === "pickup") {
      let canonicalNaddr: string | undefined
      try {
        canonicalNaddr = encodeEventMarketNaddr(
          item.fulfillment.collection.coordinate
        )
      } catch {
        canonicalNaddr = undefined
      }
      return {
        productId: item.productId,
        message: `${item.title}'s signed event pickup is no longer current. Remove it and review the listing again.`,
        ...(canonicalNaddr ? { canonicalNaddr } : {}),
      }
    }
  }

  return null
}
