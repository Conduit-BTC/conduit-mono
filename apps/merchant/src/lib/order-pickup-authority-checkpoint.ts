import {
  getCachedEventMarketSignedEvidenceByIds,
  hasSamePickupFulfillmentGraph,
  isValidSignedPublicNostrEvent,
  parseEventMarketCalendarEvent,
  parseEventMarketCollectionEvent,
  parseEventMarketPickupEvent,
  parseProductEvent,
  resolveEventMarketEvidence,
  resolveOrderPickupHandoffAuthority,
  type EventMarketResolution,
  type OrderPickupFulfillmentSchema,
  type OrderSummary,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  verifyMerchantPickupOrderAuthorization,
  type MerchantPickupAuthorizationDependencies,
  type MerchantPickupAuthorizationInput,
  type MerchantPickupAuthorizationResult,
} from "./order-pickup-authorization"

const STORAGE_PREFIX = "conduit:merchant:pickup-order-authority:v1"
const STORAGE_VERSION = 1

type StorageLike = Pick<Storage, "getItem" | "setItem">

export interface VerifiedPickupOrderAuthorityCheckpoint {
  version: typeof STORAGE_VERSION
  orderId: string
  merchantPubkey: string
  verifiedAt: number
  handoffMode: "merchant_handoff" | "organizer_handoff"
  handlerPubkey: string
  calendar: OrderPickupFulfillmentSchema["calendar"]
  collection: OrderPickupFulfillmentSchema["collection"]
  option: OrderPickupFulfillmentSchema["option"]
  items: Array<{
    product: OrderPickupFulfillmentSchema["product"]
    quantity: number
    priceAtPurchase: number
    currency: string
    sourcePrice?: {
      amount: number
      currency: string
      normalizedCurrency: string
    }
    pickupCostSats: number
    pickupSourceCost: OrderPickupFulfillmentSchema["sourceCost"]
  }>
  /** Exact public signatures that made the checkpoint verifiable offline. */
  signedEvidence: SignedPublicNostrEvent[]
}

function storageKey(merchantPubkey: string): string {
  return `${STORAGE_PREFIX}:${merchantPubkey.trim().toLowerCase()}`
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function isExactEvidence(
  value: unknown,
  kind: number,
  authorPubkey?: string
): value is { coordinate: string; eventId: string; createdAt: number } {
  if (!value || typeof value !== "object") return false
  const evidence = value as Record<string, unknown>
  if (
    typeof evidence.coordinate !== "string" ||
    typeof evidence.eventId !== "string" ||
    typeof evidence.createdAt !== "number" ||
    !Number.isSafeInteger(evidence.createdAt) ||
    !new RegExp(`^${kind}:[0-9a-f]{64}:.+`, "i").test(evidence.coordinate) ||
    !/^[0-9a-f]{64}$/i.test(evidence.eventId)
  ) {
    return false
  }
  return (
    !authorPubkey ||
    evidence.coordinate.split(":", 3)[1]?.toLowerCase() ===
      authorPubkey.toLowerCase()
  )
}

function exactEvidenceMatches(
  left: { coordinate: string; eventId: string; createdAt: number },
  right: { coordinate: string; eventId: string; createdAt: number }
): boolean {
  return (
    left.coordinate.toLowerCase() === right.coordinate.toLowerCase() &&
    left.eventId.toLowerCase() === right.eventId.toLowerCase() &&
    left.createdAt === right.createdAt
  )
}

function sourceTermsMatch(
  left:
    | { amount: number; currency: string; normalizedCurrency: string }
    | undefined,
  right:
    { amount: number; currency: string; normalizedCurrency: string } | undefined
): boolean {
  return (
    left?.amount === right?.amount &&
    left?.currency === right?.currency &&
    left?.normalizedCurrency === right?.normalizedCurrency
  )
}

function coordinateIsReferenced(
  values: readonly string[] | undefined,
  coordinate: string
): boolean {
  const expected = coordinate.toLowerCase()
  return (values ?? []).some((value) => value.toLowerCase() === expected)
}

/** Rebuild the checkpoint's authority from its exact signed public events. */
export function checkpointHasValidSignedEvidence(
  checkpoint: VerifiedPickupOrderAuthorityCheckpoint
): boolean {
  const events = checkpoint.signedEvidence
  if (!Array.isArray(events) || events.length === 0 || events.length > 67) {
    return false
  }
  const byId = new Map<string, SignedPublicNostrEvent>()
  for (const event of events) {
    if (!isValidSignedPublicNostrEvent(event)) return false
    const eventId = event.id.toLowerCase()
    if (byId.has(eventId)) return false
    byId.set(eventId, event)
  }
  const calendarEvent = byId.get(checkpoint.calendar.eventId.toLowerCase())
  const collectionEvent = byId.get(checkpoint.collection.eventId.toLowerCase())
  const optionEvent = byId.get(checkpoint.option.eventId.toLowerCase())
  if (!calendarEvent || !collectionEvent || !optionEvent) return false
  const calendar = parseEventMarketCalendarEvent(calendarEvent)
  const collection = parseEventMarketCollectionEvent(collectionEvent)
  const option = parseEventMarketPickupEvent(optionEvent)
  if (
    !calendar ||
    !collection ||
    !option ||
    !exactEvidenceMatches(checkpoint.calendar, calendar) ||
    !exactEvidenceMatches(checkpoint.collection, collection) ||
    !exactEvidenceMatches(checkpoint.option, option) ||
    checkpoint.option.title !== option.title ||
    checkpoint.option.location !== option.location ||
    checkpoint.option.geohash !== option.geohash ||
    !coordinateIsReferenced(
      collection.eventCoordinates,
      checkpoint.calendar.coordinate
    ) ||
    option.authorPubkey.toLowerCase() !== checkpoint.handlerPubkey.toLowerCase()
  ) {
    return false
  }
  if (
    checkpoint.handoffMode === "organizer_handoff" &&
    !coordinateIsReferenced(
      collection.pickupCoordinates,
      checkpoint.option.coordinate
    )
  ) {
    return false
  }
  const expectedEventIds = new Set([
    checkpoint.calendar.eventId.toLowerCase(),
    checkpoint.collection.eventId.toLowerCase(),
    checkpoint.option.eventId.toLowerCase(),
  ])
  for (const item of checkpoint.items) {
    const event = byId.get(item.product.eventId.toLowerCase())
    if (!event) return false
    expectedEventIds.add(event.id.toLowerCase())
    let product
    try {
      product = parseProductEvent(event)
    } catch {
      return false
    }
    const sourcePrice = product.sourcePrice ?? {
      amount: product.price,
      currency: product.currency,
      normalizedCurrency: product.currency.trim().toUpperCase(),
    }
    if (
      product.id.toLowerCase() !== item.product.coordinate.toLowerCase() ||
      product.pubkey.toLowerCase() !==
        item.product.merchantPubkey.toLowerCase() ||
      event.created_at * 1_000 !== item.product.createdAt ||
      !coordinateIsReferenced(
        product.collectionRefs,
        checkpoint.collection.coordinate
      ) ||
      !coordinateIsReferenced(
        product.shippingOptionRefs?.map((reference) => reference.coordinate),
        checkpoint.option.coordinate
      ) ||
      !sourceTermsMatch(item.sourcePrice, sourcePrice) ||
      !sourceTermsMatch(item.pickupSourceCost, {
        amount: option.price,
        currency: option.currency,
        normalizedCurrency: option.currency.trim().toUpperCase(),
      })
    ) {
      return false
    }
  }
  return (
    expectedEventIds.size === byId.size &&
    Array.from(byId.keys()).every((eventId) => expectedEventIds.has(eventId))
  )
}

function normalizeCheckpoint(
  value: unknown,
  merchantPubkey: string
): VerifiedPickupOrderAuthorityCheckpoint | null {
  if (!value || typeof value !== "object") return null
  const checkpoint = value as Partial<VerifiedPickupOrderAuthorityCheckpoint>
  const merchant = merchantPubkey.trim().toLowerCase()
  if (
    checkpoint.version !== STORAGE_VERSION ||
    typeof checkpoint.orderId !== "string" ||
    checkpoint.orderId.length === 0 ||
    checkpoint.merchantPubkey?.toLowerCase() !== merchant ||
    typeof checkpoint.verifiedAt !== "number" ||
    !Number.isSafeInteger(checkpoint.verifiedAt) ||
    checkpoint.verifiedAt < 0 ||
    !["merchant_handoff", "organizer_handoff"].includes(
      checkpoint.handoffMode ?? ""
    ) ||
    typeof checkpoint.handlerPubkey !== "string" ||
    !/^[0-9a-f]{64}$/i.test(checkpoint.handlerPubkey) ||
    (!isExactEvidence(checkpoint.calendar, 31922) &&
      !isExactEvidence(checkpoint.calendar, 31923)) ||
    !isExactEvidence(checkpoint.collection, 30405) ||
    !isExactEvidence(checkpoint.option, 30406) ||
    !Array.isArray(checkpoint.items) ||
    checkpoint.items.length === 0 ||
    checkpoint.items.length > 64 ||
    !Array.isArray(checkpoint.signedEvidence)
  ) {
    return null
  }
  for (const item of checkpoint.items) {
    const sourcePriceValid =
      item?.sourcePrice === undefined ||
      (typeof item.sourcePrice.amount === "number" &&
        Number.isFinite(item.sourcePrice.amount) &&
        item.sourcePrice.amount >= 0 &&
        typeof item.sourcePrice.currency === "string" &&
        item.sourcePrice.currency.length > 0 &&
        typeof item.sourcePrice.normalizedCurrency === "string" &&
        item.sourcePrice.normalizedCurrency.length > 0)
    if (
      !item ||
      typeof item !== "object" ||
      !isExactEvidence(item.product, 30402, merchant) ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      !Number.isFinite(item.priceAtPurchase) ||
      item.priceAtPurchase < 0 ||
      typeof item.currency !== "string" ||
      item.currency.length === 0 ||
      !sourcePriceValid ||
      !Number.isSafeInteger(item.pickupCostSats) ||
      item.pickupCostSats < 0 ||
      !item.pickupSourceCost ||
      typeof item.pickupSourceCost.amount !== "number" ||
      typeof item.pickupSourceCost.currency !== "string" ||
      typeof item.pickupSourceCost.normalizedCurrency !== "string"
    ) {
      return null
    }
  }
  const normalized = structuredClone(
    checkpoint as VerifiedPickupOrderAuthorityCheckpoint
  )
  return checkpointHasValidSignedEvidence(normalized) ? normalized : null
}

function readCheckpoints(
  merchantPubkey: string,
  storage: StorageLike
): VerifiedPickupOrderAuthorityCheckpoint[] {
  try {
    const parsed = JSON.parse(
      storage.getItem(storageKey(merchantPubkey)) ?? "[]"
    ) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      const checkpoint = normalizeCheckpoint(value, merchantPubkey)
      return checkpoint ? [checkpoint] : []
    })
  } catch {
    return []
  }
}

function comparableCheckpoint(
  checkpoint: VerifiedPickupOrderAuthorityCheckpoint
): string {
  return JSON.stringify({
    version: checkpoint.version,
    orderId: checkpoint.orderId,
    merchantPubkey: checkpoint.merchantPubkey.toLowerCase(),
    handoffMode: checkpoint.handoffMode,
    handlerPubkey: checkpoint.handlerPubkey.toLowerCase(),
    calendar: checkpoint.calendar,
    collection: checkpoint.collection,
    option: checkpoint.option,
    items: [...checkpoint.items]
      .map((item) => ({
        ...item,
        product: {
          ...item.product,
          merchantPubkey: item.product.merchantPubkey.toLowerCase(),
        },
      }))
      .sort((left, right) =>
        left.product.coordinate.localeCompare(right.product.coordinate)
      ),
    signedEvidence: [...checkpoint.signedEvidence].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
  })
}

/**
 * Capture only authority fields that were already verified against live signed
 * event evidence. Buyer contact, notes, invoices, proofs, and secrets are never
 * retained here.
 */
export function buildVerifiedPickupOrderAuthorityCheckpoint(input: {
  orderId: string
  merchantPubkey: string
  items: OrderSummary["items"]
  signedEvidence: readonly SignedPublicNostrEvent[]
  verifiedAt?: number
}): VerifiedPickupOrderAuthorityCheckpoint {
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  const pickupItems = input.items.filter(
    (
      item
    ): item is (typeof input.items)[number] & {
      fulfillment: OrderPickupFulfillmentSchema
    } => item.fulfillment?.type === "pickup"
  )
  const first = pickupItems[0]?.fulfillment
  if (
    !input.orderId.trim() ||
    !/^[0-9a-f]{64}$/i.test(merchantPubkey) ||
    !first ||
    pickupItems.length !== input.items.length ||
    pickupItems.some(
      (item) =>
        item.fulfillment.product.merchantPubkey.toLowerCase() !==
          merchantPubkey ||
        !hasSamePickupFulfillmentGraph(first, item.fulfillment)
    )
  ) {
    throw new Error(
      "A verified checkpoint requires one coherent merchant pickup order."
    )
  }
  const authority = resolveOrderPickupHandoffAuthority(first)
  if (authority.legacySafeDefault) {
    throw new Error(
      "Legacy pickup snapshots require explicit reconciliation before checkpointing."
    )
  }
  const checkpoint: VerifiedPickupOrderAuthorityCheckpoint = {
    version: STORAGE_VERSION,
    orderId: input.orderId,
    merchantPubkey,
    verifiedAt: input.verifiedAt ?? Date.now(),
    handoffMode: authority.mode,
    handlerPubkey: authority.handlerPubkey,
    calendar: structuredClone(first.calendar),
    collection: structuredClone(first.collection),
    option: structuredClone(first.option),
    items: pickupItems
      .map((item) => ({
        product: structuredClone(item.fulfillment.product),
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
        ...(item.sourcePrice
          ? { sourcePrice: structuredClone(item.sourcePrice) }
          : {}),
        pickupCostSats: item.fulfillment.costSats,
        pickupSourceCost: structuredClone(item.fulfillment.sourceCost),
      }))
      .sort((left, right) =>
        left.product.coordinate.localeCompare(right.product.coordinate)
      ),
    signedEvidence: input.signedEvidence.map((event) => structuredClone(event)),
  }
  if (!checkpointHasValidSignedEvidence(checkpoint)) {
    throw new Error(
      "The exact signed pickup evidence bundle is incomplete or does not match the order."
    )
  }
  return checkpoint
}

export function checkpointMatchesPickupOrder(
  checkpoint: VerifiedPickupOrderAuthorityCheckpoint,
  input: {
    orderId: string
    merchantPubkey: string
    items: OrderSummary["items"]
    signedEvidence?: readonly SignedPublicNostrEvent[]
  }
): boolean {
  try {
    const expected = buildVerifiedPickupOrderAuthorityCheckpoint({
      ...input,
      signedEvidence: input.signedEvidence ?? checkpoint.signedEvidence,
      verifiedAt: checkpoint.verifiedAt,
    })
    return comparableCheckpoint(checkpoint) === comparableCheckpoint(expected)
  } catch {
    return false
  }
}

export function saveVerifiedPickupOrderAuthorityCheckpoint(
  checkpoint: VerifiedPickupOrderAuthorityCheckpoint,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage) {
    throw new Error(
      "Durable pickup authority storage is unavailable. The handoff change was stopped."
    )
  }
  const normalized = normalizeCheckpoint(checkpoint, checkpoint.merchantPubkey)
  if (!normalized) {
    throw new Error("Verified pickup authority checkpoint is invalid.")
  }
  const current = readCheckpoints(normalized.merchantPubkey, storage).filter(
    (candidate) => candidate.orderId !== normalized.orderId
  )
  // Never evict an older order silently. These records preserve the exact
  // signed handoff authority after a listing changes; quota exhaustion must
  // stop the transition instead of weakening an existing order.
  const next = [...current, normalized].sort(
    (left, right) => right.verifiedAt - left.verifiedAt
  )
  try {
    storage.setItem(storageKey(normalized.merchantPubkey), JSON.stringify(next))
  } catch {
    throw new Error(
      "The verified pickup authority could not be saved. The handoff change was stopped."
    )
  }
}

export function loadMatchingPickupOrderAuthorityCheckpoint(
  input: {
    orderId: string
    merchantPubkey: string
    items: OrderSummary["items"]
  },
  storage: StorageLike | null = defaultStorage()
): VerifiedPickupOrderAuthorityCheckpoint | null {
  if (!storage) return null
  const checkpoint = readCheckpoints(input.merchantPubkey, storage).find(
    (candidate) => candidate.orderId === input.orderId
  )
  return checkpoint && checkpointMatchesPickupOrder(checkpoint, input)
    ? checkpoint
    : null
}

function resolveCheckpointMarket(
  checkpoint: VerifiedPickupOrderAuthorityCheckpoint
): EventMarketResolution | null {
  if (!checkpointHasValidSignedEvidence(checkpoint)) return null
  const market = resolveEventMarketEvidence({
    reference: checkpoint.collection.coordinate,
    expectedOrganizerPubkey:
      checkpoint.collection.coordinate.split(":", 3)[1] ?? "",
    selectedProductCoordinates: checkpoint.items.map(
      (item) => item.product.coordinate
    ),
    events: checkpoint.signedEvidence,
    productRequestEvents: checkpoint.signedEvidence,
    nowMs: checkpoint.verifiedAt,
  })
  if (
    market.state !== "active" &&
    market.state !== "partial" &&
    market.state !== "ended"
  ) {
    return null
  }
  if (
    !market.calendar ||
    !market.collection ||
    !exactEvidenceMatches(checkpoint.calendar, market.calendar) ||
    !exactEvidenceMatches(checkpoint.collection, market.collection) ||
    !market.pickups.some((pickup) =>
      exactEvidenceMatches(checkpoint.option, pickup)
    ) ||
    checkpoint.items.some(
      (item) =>
        !market.acceptedProductEvidence.some((product) =>
          exactEvidenceMatches(item.product, {
            coordinate: product.productCoordinate,
            eventId: product.eventId,
            createdAt: product.createdAt,
          })
        )
    )
  ) {
    return null
  }
  return market
}

/**
 * Verify against current signed evidence first, then durably capture the exact
 * authority that was reviewed. A checkpoint never turns failed live evidence
 * into authority; callers may use a previously matching checkpoint only for a
 * historical order after a deliberate arrangement transition.
 */
export async function verifyAndCheckpointMerchantPickupOrderAuthorization(
  input: MerchantPickupAuthorizationInput & { orderId: string },
  dependencies?: MerchantPickupAuthorizationDependencies,
  options: {
    storage?: StorageLike | null
    requireDurableCheckpoint?: boolean
  } = {}
): Promise<MerchantPickupAuthorizationResult> {
  const result = await verifyMerchantPickupOrderAuthorization(
    input,
    dependencies
  )
  if (result.status !== "verified") {
    const checkpoint = loadMatchingPickupOrderAuthorityCheckpoint(
      input,
      options.storage === undefined ? defaultStorage() : options.storage
    )
    const market = checkpoint ? resolveCheckpointMarket(checkpoint) : null
    return market ? { status: "verified", market, products: [] } : result
  }
  try {
    const pickupItems = input.items.filter(
      (item) => item.fulfillment?.type === "pickup"
    )
    const first = pickupItems[0]?.fulfillment
    if (!first || first.type !== "pickup") {
      throw new Error("Verified pickup evidence is unavailable.")
    }
    const exact = await getCachedEventMarketSignedEvidenceByIds({
      organizerPubkey: first.organizerPubkey,
      eventIds: [
        first.calendar.eventId,
        first.collection.eventId,
        first.option.eventId,
        ...pickupItems.flatMap((item) =>
          item.fulfillment?.type === "pickup"
            ? [item.fulfillment.product.eventId]
            : []
        ),
      ],
    })
    if (exact.missingEventIds.length > 0) {
      throw new Error(
        "The exact signed pickup evidence could not be retained for historical verification."
      )
    }
    const checkpoint = buildVerifiedPickupOrderAuthorityCheckpoint({
      orderId: input.orderId,
      merchantPubkey: input.merchantPubkey,
      items: input.items,
      signedEvidence: exact.events,
    })
    saveVerifiedPickupOrderAuthorityCheckpoint(
      checkpoint,
      options.storage === undefined ? defaultStorage() : options.storage
    )
  } catch (error) {
    if (options.requireDurableCheckpoint) throw error
  }
  return result
}
