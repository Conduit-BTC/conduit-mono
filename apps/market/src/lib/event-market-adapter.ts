import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  getEventMarket,
  getProductsByIds,
  normalizeCommercePrice,
  resolveEventMarketProductFulfillment,
  resolveEventMarketProductParticipation,
  type EventMarketResolution,
  type EventMarketResolutionState,
  type CommerceProductRecord,
  type PreparedProductFamily,
  type PricingRateInput,
  type Product,
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
  productReadState: "not_requested" | "ready" | "partial" | "unavailable"
  purchaseReady: boolean
}

export type PickupFreshnessResult =
  | { fresh: true }
  | {
      fresh: false
      reason: string
    }

export type ProductEventMarketCandidate = {
  collectionCoordinate: string
  canonicalNaddr: string
  collectionReferencedForFulfillment: boolean
  directPickupCoordinates: string[]
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
    pickups: [],
    productReadState: "not_requested",
    purchaseReady: false,
  }
}

export function buildPickupFulfillmentSnapshot(
  product: Product,
  resolution: EventMarketResolution,
  productEvidence: { eventId: string; eventCreatedAt: number },
  rateInput: PricingRateInput = null
): CartPickupFulfillment | null {
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
  const normalized = normalizeCommercePrice(
    sourceCost.amount,
    sourceCost.normalizedCurrency,
    rateInput
  )
  const costSats =
    sourceCost.amount === 0
      ? 0
      : normalized.status === "ok"
        ? normalized.sats
        : undefined
  if (costSats === undefined) return null

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
    costSats,
    sourceCost,
  }
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
  result: Awaited<ReturnType<typeof getProductsByIds>>,
  productCoordinate: string
): boolean {
  const diagnostic = result.diagnostics.find(
    (entry) => entry.productId === productCoordinate
  )
  return (
    result.meta.source !== "local_cache" &&
    !result.meta.stale &&
    diagnostic?.issue === null &&
    diagnostic.coverage?.listing !== "unavailable"
  )
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
  const recordsByCoordinate = new Map(
    records.map((record) => [record.product.id, record])
  )
  const familyPickupFulfillmentsByParent = new Map<
    string,
    Record<string, CartPickupFulfillment | null>
  >()
  const foldedChildCoordinates = new Set<string>()

  for (const coordinate of requested) {
    const record = recordsByCoordinate.get(coordinate)
    if (!record?.family || !liveCoordinates.has(coordinate)) continue

    const familyPickupFulfillments = buildEventCatalogFamilyPickupFulfillments(
      record.family,
      resolution,
      rateInput
    )
    familyPickupFulfillmentsByParent.set(coordinate, familyPickupFulfillments)
    for (const child of record.family.children) {
      if (
        liveCoordinates.has(child.product.id) &&
        familyPickupFulfillments[child.product.id]
      ) {
        foldedChildCoordinates.add(child.product.id)
      }
    }
  }

  return requested.flatMap<EventCatalogProduct>((coordinate) => {
    const record = recordsByCoordinate.get(coordinate)
    if (
      !record ||
      !liveCoordinates.has(coordinate) ||
      foldedChildCoordinates.has(coordinate)
    ) {
      return []
    }

    const { product } = record
    return [
      {
        product,
        family: record.family,
        participation: resolveEventMarketProductParticipation(
          product,
          resolution
        ),
        pickupFulfillment: buildPickupFulfillmentSnapshot(
          product,
          resolution,
          record,
          rateInput
        ),
        familyPickupFulfillments:
          familyPickupFulfillmentsByParent.get(coordinate),
      },
    ]
  })
}

async function hydrateAcceptedProducts(
  resolution: EventMarketResolution,
  rateInput: PricingRateInput
): Promise<Pick<EventCatalog, "products" | "productReadState">> {
  const requested = resolution.acceptedProductCoordinates
  if (requested.length === 0) {
    return { products: [], productReadState: "ready" }
  }

  const result = await getProductsByIds(requested)
  const recordsByCoordinate = new Map(
    result.data.map((record) => [record.product.id, record])
  )
  const liveCoordinates = new Set(
    requested.filter((coordinate) => {
      const record = recordsByCoordinate.get(coordinate)
      return !!record && productReadIsLive(result, coordinate)
    })
  )
  const products = projectEventCatalogProducts({
    requested,
    records: result.data,
    liveCoordinates,
    resolution,
    rateInput,
  })

  return {
    products,
    productReadState:
      liveCoordinates.size === requested.length
        ? "ready"
        : result.meta.source === "local_cache" || result.meta.stale
          ? "unavailable"
          : "partial",
  }
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

function uniqueCoordinates(values: readonly string[]): string[] {
  return Array.from(new Set(values))
}

/**
 * Find only references that could express the event-market extension. An
 * ordinary kind-30406 option owned by a different author is regular shipping,
 * even when the product also belongs to an unrelated collection.
 */
export function getProductEventMarketCandidates(
  product: Product
): ProductEventMarketCandidate[] {
  if (product.format !== "physical") return []

  const collections = uniqueCoordinates(product.collectionRefs ?? [])
    .map((reference) =>
      decodeEventMarketReference(reference, [EVENT_COLLECTION_KIND])
    )
    .filter((reference): reference is NonNullable<typeof reference> => {
      return reference !== null
    })
  if (collections.length === 0) return []

  const shippingReferences = uniqueCoordinates([
    ...(product.shippingOptionRefs?.map((reference) => reference.coordinate) ??
      []),
    ...(product.shippingOptionId ? [product.shippingOptionId] : []),
  ])

  return collections.flatMap((collection) => {
    let collectionReferencedForFulfillment = false
    const directPickupCoordinates: string[] = []
    for (const reference of shippingReferences) {
      const collectionReference = decodeEventMarketReference(reference, [
        EVENT_COLLECTION_KIND,
      ])
      if (collectionReference?.coordinate === collection.coordinate) {
        collectionReferencedForFulfillment = true
        continue
      }

      const pickupReference = decodeEventMarketReference(reference, [30406])
      if (
        pickupReference &&
        (pickupReference.authorPubkey === collection.authorPubkey ||
          pickupReference.authorPubkey === product.pubkey.toLowerCase()) &&
        pickupReference.coordinate !== collection.coordinate
      ) {
        directPickupCoordinates.push(pickupReference.coordinate)
      }
    }

    if (
      !collectionReferencedForFulfillment &&
      directPickupCoordinates.length === 0
    ) {
      return []
    }

    return [
      {
        collectionCoordinate: collection.coordinate,
        canonicalNaddr: encodeEventMarketNaddr(collection.coordinate),
        collectionReferencedForFulfillment,
        directPickupCoordinates: uniqueCoordinates(directPickupCoordinates),
      },
    ]
  })
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

  if (candidate.collectionReferencedForFulfillment) return true

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

  const declaredPickupCoordinates = catalog.collection?.pickupCoordinates ?? []
  if (declaredPickupCoordinates.length > 0) {
    return candidate.directPickupCoordinates.some((coordinate) =>
      declaredPickupCoordinates.includes(coordinate)
    )
  }

  // Missing/deleted/degraded collection evidence cannot prove that a
  // same-author direct pickup claim is ordinary shipping. Keep it closed until
  // the signed collection can be resolved.
  return true
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
  current: CartPickupFulfillment
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
    snapshot.costSats === current.costSats &&
    pickupSourceCostMatches(snapshot.sourceCost, current.sourceCost)
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
  current: CartPickupFulfillment,
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
    item.shippingCostSats === current.costSats &&
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
  rateInput: PricingRateInput = null,
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

  const productResult = await getProductsByIds([item.productId])
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

  const current = buildPickupFulfillmentSnapshot(
    freshRecord.product,
    resolution,
    freshRecord,
    rateInput
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
  rateInput: PricingRateInput = null,
  expectedMerchantPubkey?: string
): Promise<PickupFreshnessResult> {
  const pickupItems = items.filter(
    (item): item is PickupFreshnessPickupItem =>
      item.fulfillment?.type === "pickup"
  )
  const results = await Promise.all(
    pickupItems.map((item) =>
      verifyPickupFulfillmentFreshness(item, rateInput, expectedMerchantPubkey)
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
