import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  applyPreparedProductFulfillment,
  buildFixedShippingOptionEventDrafts,
  buildProductDeletionEventDraft,
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  cacheSignedShippingOptionEvent,
  compileProductFulfillmentIntent,
  EVENT_KINDS,
  getNdk,
  getFixedShippingOptionAddresses,
  getFixedShippingOptionDTags,
  getFixedShippingRateZones,
  getShippingOptionsByCoordinates,
  isValidSignedPublicNostrEvent,
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  resolveProductFulfillment,
  type ProductDeletionEventTarget,
  type ProductFulfillmentIntent,
  type ParsedShippingOption,
  type ProductSchema,
  type PreparedProductFulfillment,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  cacheSignedMerchantDeletionEvent,
  deliverQueuedProductDeletion,
  persistSignedProductDeletion,
  planCurrentProductDeletionWriteRelays,
  type DeliverQueuedProductDeletionOptions,
} from "./product-deletion-delivery"

export class SignedProductDeliveryError extends Error {
  readonly deliveryCause: unknown

  constructor(deliveryCause: unknown) {
    super("Signed product event could not be delivered")
    this.name = "SignedProductDeliveryError"
    this.deliveryCause = deliveryCause
  }
}

function asSignedProductDeliveryError(
  error: unknown
): SignedProductDeliveryError {
  return error instanceof SignedProductDeliveryError
    ? error
    : new SignedProductDeliveryError(error)
}

export function getRelayPublishDiagnosticsError(
  error: unknown
): RelayPublishDiagnosticsError | null {
  const cause =
    error instanceof SignedProductDeliveryError ? error.deliveryCause : error
  return cause instanceof RelayPublishDiagnosticsError ? cause : null
}

export function isDeliverableMerchantProductEvent(
  event: SignedPublicNostrEvent,
  merchantPubkey: string
): boolean {
  return (
    isValidSignedPublicNostrEvent(event) &&
    (event.kind === EVENT_KINDS.PRODUCT ||
      event.kind === EVENT_KINDS.DELETION) &&
    event.pubkey === merchantPubkey
  )
}

export async function deliverSignedProductEvent(
  event: NDKEvent | SignedPublicNostrEvent,
  merchantPubkey: string,
  options: { extraRelayUrls?: readonly string[] } = {}
): Promise<PublishWithPlannerResult> {
  try {
    const rawEvent =
      event instanceof NDKEvent
        ? (event.rawEvent() as SignedPublicNostrEvent)
        : event
    if (!isDeliverableMerchantProductEvent(rawEvent, merchantPubkey)) {
      throw new Error(
        "Expected a valid signed merchant product or deletion event"
      )
    }

    let publishableEvent: NDKEvent
    if (event instanceof NDKEvent) {
      publishableEvent = event
    } else {
      publishableEvent = new NDKEvent(getNdk(), event)
    }

    const delivery = await publishWithPlanner(publishableEvent, {
      intent: "author_event",
      authorPubkey: merchantPubkey,
      authenticatedPubkey: merchantPubkey,
      deliveryMode: "critical",
      extraRelayUrls: options.extraRelayUrls,
    })
    if (rawEvent.kind === EVENT_KINDS.PRODUCT) {
      await cacheSignedProductListingEvent(publishableEvent, {
        sourceRelayUrls: delivery.successfulRelayUrls,
        persistence: "best_effort",
      })
    }
    return delivery
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

function mergeRelayUrls(...groups: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(groups.flat()))
}

export function getPreviousShippingSourceRelayUrls(input: {
  previousShippingOptionIds: readonly string[]
  previousProduct: Pick<ProductSchema, "shippingZones">
  previousProductSourceRelayUrls: readonly string[]
  cachedShippingSourceRelayUrls?: readonly string[]
}): string[] {
  const previousCoordinates = new Set(input.previousShippingOptionIds)
  const exactShippingSources =
    input.previousProduct.shippingZones?.flatMap((zone) =>
      previousCoordinates.has(zone.shippingOptionId)
        ? (zone.sourceRelayUrls ?? [])
        : []
    ) ?? []
  // Product sources are retained only as a compatibility fallback for cache
  // rows written before per-option relay provenance existed.
  return mergeRelayUrls(
    exactShippingSources,
    input.cachedShippingSourceRelayUrls ?? [],
    input.previousProductSourceRelayUrls
  )
}

export async function deliverSignedProductEventBundle(
  events: readonly (NDKEvent | SignedPublicNostrEvent)[],
  merchantPubkey: string
): Promise<PublishWithPlannerResult> {
  if (events.length === 0) {
    throw new Error("At least one signed product event is required")
  }

  const deliveries = await Promise.all(
    events.map((event) => deliverSignedProductEvent(event, merchantPubkey))
  )
  return aggregateProductEventDeliveries(deliveries)
}

function aggregateProductEventDeliveries(
  deliveries: readonly PublishWithPlannerResult[]
): PublishWithPlannerResult {
  if (deliveries.length === 0) {
    throw new Error("At least one product delivery result is required")
  }

  const attemptedRelayUrls = mergeRelayUrls(
    ...deliveries.map((delivery) => delivery.attemptedRelayUrls)
  )
  const knownRelayUrls = mergeRelayUrls(
    attemptedRelayUrls,
    ...deliveries.map((delivery) => delivery.successfulRelayUrls),
    ...deliveries.map((delivery) => delivery.failedRelayUrls)
  )
  const successfulRelayUrls = knownRelayUrls.filter((url) => {
    const relevantDeliveries = deliveries.filter(
      (delivery) =>
        delivery.attemptedRelayUrls.includes(url) ||
        delivery.successfulRelayUrls.includes(url) ||
        delivery.failedRelayUrls.includes(url)
    )
    return (
      relevantDeliveries.length > 0 &&
      relevantDeliveries.every((delivery) =>
        delivery.successfulRelayUrls.includes(url)
      )
    )
  })
  const successfulRelaySet = new Set(successfulRelayUrls)
  const failedRelayUrls = knownRelayUrls.filter(
    (url) => !successfulRelaySet.has(url)
  )

  return {
    plan: deliveries[0]!.plan,
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
    relayFailureMessages: Object.assign(
      {},
      ...deliveries.map((delivery) => delivery.relayFailureMessages)
    ),
  }
}

export interface ProductListingPublishTarget {
  product: ProductSchema
  dTag: string
  previousEventCreatedAt?: number
  previousShippingOptionCreatedAt?: number
  previousShippingOptionIds?: readonly string[]
  previousShippingZones?: ProductSchema["shippingZones"]
  previousShippingSourceRelayUrls?: readonly string[]
  previousShippingAuthorWriteRelayUrls?: readonly string[]
  fulfillmentIntent: ProductFulfillmentIntent
}

type SignedProductWrite = {
  productEvent: NDKEvent
  shippingEvents: NDKEvent[]
}

export interface CanonicalProductPublishDependencies {
  publishShippingEvent: (
    event: NDKEvent,
    merchantPubkey: string
  ) => Promise<PublishWithPlannerResult>
  cacheEvent: (event: NDKEvent) => Promise<void>
  deliverEvents: (
    events: readonly NDKEvent[],
    merchantPubkey: string
  ) => Promise<PublishWithPlannerResult>
}

function getProductShippingDestinations(
  product: Pick<ProductSchema, "shippingCountries" | "shippingCountryRules">,
  fallbackCountries: readonly string[] = []
) {
  if (product.shippingCountryRules?.length) {
    return product.shippingCountryRules
  }

  const countries = product.shippingCountries?.length
    ? product.shippingCountries
    : fallbackCountries
  return countries.map((code) => ({
    code,
    name: code,
    restrictTo: [],
    exclude: [],
  }))
}

export function hasEventPickupReferences(
  product: Pick<
    ProductSchema,
    "collectionRefs" | "shippingOptionRefs" | "shippingZones"
  > &
    Partial<Pick<ProductSchema, "id" | "pubkey">>,
  fixedShippingOwner?: {
    merchantPubkey: string
    productDTag: string
  }
): boolean {
  const shippingOptionCoordinates =
    product.shippingOptionRefs?.map((reference) => reference.coordinate) ?? []
  if (
    (product.collectionRefs?.length ?? 0) === 0 ||
    shippingOptionCoordinates.length === 0
  ) {
    return false
  }

  const merchantPubkey = fixedShippingOwner?.merchantPubkey ?? product.pubkey
  const productDTag =
    fixedShippingOwner?.productDTag ??
    (merchantPubkey && product.id
      ? getAddressDTag(product.id, EVENT_KINDS.PRODUCT, merchantPubkey)
      : null)
  if (!merchantPubkey || !productDTag) return true

  const canonicalCoordinates = getCanonicalFixedShippingOptionCoordinates({
    merchantPubkey,
    productDTag,
    shippingZones: product.shippingZones,
  })

  return shippingOptionCoordinates.some(
    (coordinate) =>
      !isMerchantOwnedFixedShippingOption({
        coordinate,
        merchantPubkey,
        productDTag,
        canonicalCoordinates,
      })
  )
}

export function compileResolvedShippingZones(
  zones: NonNullable<ProductSchema["shippingZones"]>
): ProductFulfillmentIntent | null {
  if (zones.length === 0) return null

  try {
    const compiledZones = zones.map((zone) => {
      const compiled = compileProductFulfillmentIntent({
        format: "physical",
        shippingPricingMode: "fixed",
        amount: zone.usesProductFallback ? zone.amount : undefined,
        currency: zone.currency,
        destinations: zone.countryRules.map((rule) => ({
          ...rule,
          ...(zone.usesProductFallback
            ? {}
            : { rate: { amount: zone.amount, currency: zone.currency } }),
        })),
        allowExperimentalDestinationPolicy: zone.destinationSchema === "1",
      })
      if (compiled.kind !== "fixed_standard" || compiled.zones.length !== 1) {
        throw new Error("Expected one resolved shipping policy")
      }
      return {
        ...compiled.zones[0]!,
        ...(zone.destinationSchema === "1"
          ? { destinationSchema: "1" as const }
          : {}),
      }
    })
    if (new Set(compiledZones.map((zone) => zone.currency)).size !== 1) {
      return null
    }

    const intent: Extract<
      ProductFulfillmentIntent,
      { kind: "fixed_standard" }
    > = { kind: "fixed_standard", zones: compiledZones }
    const policyCoordinates = getFixedShippingOptionDTags(
      "resolved-policy",
      intent
    )
    if (new Set(policyCoordinates).size !== policyCoordinates.length) {
      return null
    }
    return intent
  } catch {
    return null
  }
}

export function prepareResolvedFixedShippingRepublish(input: {
  merchantPubkey: string
  productDTag: string
  product: ProductSchema
  prepared: PreparedProductFulfillment
  previousProductSourceRelayUrls: readonly string[]
}): {
  fulfillmentIntent: ProductFulfillmentIntent
  previousShippingOptionCreatedAt?: number
  previousShippingOptionIds: string[]
  previousShippingZones?: ProductSchema["shippingZones"]
  previousShippingSourceRelayUrls: string[]
} {
  const hydratedProduct = applyPreparedProductFulfillment(
    input.product,
    input.prepared
  )
  const fulfillmentIntent = compileResolvedShippingZones(
    hydratedProduct.shippingZones ?? []
  )
  if (!fulfillmentIntent || fulfillmentIntent.kind !== "fixed_standard") {
    throw new Error(
      "Could not preserve this listing's fixed shipping policies. Review the listing before updating stock."
    )
  }

  const previousShippingOptionIds = getMerchantOwnedFixedShippingOptionIds({
    merchantPubkey: input.merchantPubkey,
    productDTag: input.productDTag,
    product: hydratedProduct,
  })
  return {
    fulfillmentIntent,
    previousShippingOptionCreatedAt: hydratedProduct.shippingOptionCreatedAt,
    previousShippingOptionIds,
    previousShippingZones: hydratedProduct.shippingZones,
    previousShippingSourceRelayUrls: getPreviousShippingSourceRelayUrls({
      previousShippingOptionIds,
      previousProduct: hydratedProduct,
      previousProductSourceRelayUrls: input.previousProductSourceRelayUrls,
    }),
  }
}

export function resolveProductFulfillmentIntentForTarget(input: {
  product: Pick<
    ProductSchema,
    | "format"
    | "shippingCostSats"
    | "sourceShippingCost"
    | "canonicalShippingResolved"
    | "collectionRefs"
    | "shippingOptionRefs"
    | "shippingCountries"
    | "shippingCountryRules"
    | "shippingZones"
  >
  fallbackIntent: ProductFulfillmentIntent
  authoringCountries: readonly string[]
}): ProductFulfillmentIntent {
  if (input.product.format === "digital") return { kind: "digital" }
  if (hasEventPickupReferences(input.product)) {
    return { kind: "coordinate_after_order" }
  }

  if (input.product.shippingZones?.length) {
    const intent = compileResolvedShippingZones(input.product.shippingZones)
    if (!intent) {
      throw new Error("Resolved variation shipping zones are invalid")
    }
    return intent
  }

  const amount =
    input.product.sourceShippingCost?.amount ?? input.product.shippingCostSats
  if (typeof amount !== "number") return input.fallbackIntent

  const destinations = getProductShippingDestinations(
    input.product,
    input.authoringCountries
  )
  if (
    !destinations.some((destination) =>
      /^[A-Z]{2}$/.test(destination.code.trim().toUpperCase())
    )
  ) {
    throw new Error(
      "Fixed variation shipping requires at least one valid country destination"
    )
  }

  return compileProductFulfillmentIntent({
    format: "physical",
    shippingPricingMode: "fixed",
    amount,
    currency: input.product.sourceShippingCost?.currency ?? "SATS",
    destinations,
    allowExperimentalDestinationPolicy:
      input.fallbackIntent.kind === "fixed_standard" &&
      input.fallbackIntent.zones.some((zone) => zone.destinationSchema === "1"),
  })
}

export function resolvePublishedProductFulfillmentIntentForTarget(
  product: Pick<
    ProductSchema,
    | "format"
    | "shippingCostSats"
    | "sourceShippingCost"
    | "shippingOptionId"
    | "shippingOptionIds"
    | "shippingOptionLaunchUnsupported"
    | "shippingOptionRefs"
    | "collectionRefs"
    | "shippingCountries"
    | "shippingCountryRules"
    | "shippingZones"
    | "canonicalShippingResolved"
  >
): ProductFulfillmentIntent | null {
  if (product.format === "digital") return { kind: "digital" }
  if (hasEventPickupReferences(product)) {
    return { kind: "coordinate_after_order" }
  }
  if (product.shippingOptionLaunchUnsupported) return null
  if (product.shippingZones?.length) {
    return compileResolvedShippingZones(product.shippingZones)
  }
  if (
    (product.shippingOptionId || product.shippingOptionIds?.length) &&
    product.canonicalShippingResolved !== true
  ) {
    return null
  }

  const amount = product.sourceShippingCost?.amount ?? product.shippingCostSats
  if (typeof amount !== "number") {
    return product.shippingOptionId ? null : { kind: "coordinate_after_order" }
  }

  const destinations = getProductShippingDestinations(product)
  if (!destinations.length) return null

  try {
    return compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      amount,
      currency: product.sourceShippingCost?.currency ?? "SATS",
      destinations,
    })
  } catch {
    return null
  }
}

export async function publishCanonicalProductEvents(
  input: {
    writes: readonly SignedProductWrite[]
    events: readonly NDKEvent[]
    merchantPubkey: string
    onSignedLocal: (events: readonly NDKEvent[]) => Promise<void>
  },
  dependencies: CanonicalProductPublishDependencies
): Promise<PublishWithPlannerResult> {
  for (const write of input.writes) {
    const legacyShippingEvent = (
      write as SignedProductWrite & { shippingEvent?: NDKEvent | null }
    ).shippingEvent
    const shippingEvents =
      write.shippingEvents ?? (legacyShippingEvent ? [legacyShippingEvent] : [])
    for (const shippingEvent of shippingEvents) {
      const delivery = await dependencies.publishShippingEvent(
        shippingEvent,
        input.merchantPubkey
      )
      if (delivery.successfulRelayUrls.length === 0) {
        throw new Error(
          "Fixed shipping was not acknowledged by a relay. Product publication was stopped."
        )
      }
    }
  }

  for (const event of input.events) {
    await dependencies.cacheEvent(event)
  }

  try {
    await input.onSignedLocal(input.events)
    return await dependencies.deliverEvents(input.events, input.merchantPubkey)
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

export function applyProductFulfillmentIntentForPublication(input: {
  product: ProductSchema
  merchantPubkey: string
  productDTag: string
  intent: ProductFulfillmentIntent
}): ProductSchema {
  if (input.intent.kind !== "fixed_standard") {
    const preserveEventPickup =
      input.intent.kind === "coordinate_after_order" &&
      hasEventPickupReferences(input.product, {
        merchantPubkey: input.merchantPubkey,
        productDTag: input.productDTag,
      })
    return {
      ...input.product,
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: preserveEventPickup
        ? input.product.shippingOptionId
        : undefined,
      shippingOptionDTag: preserveEventPickup
        ? input.product.shippingOptionDTag
        : undefined,
      shippingOptionIds: preserveEventPickup
        ? input.product.shippingOptionIds
        : undefined,
      shippingOptionDTags: preserveEventPickup
        ? input.product.shippingOptionDTags
        : undefined,
      shippingOptionRefs: preserveEventPickup
        ? input.product.shippingOptionRefs
        : undefined,
      collectionRefs: preserveEventPickup
        ? input.product.collectionRefs
        : undefined,
      shippingOptionLaunchUnsupported: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
      shippingZones: undefined,
      canonicalShippingResolved: false,
      shippingOptionCreatedAt: undefined,
    }
  }

  const shippingOptionIds = getFixedShippingOptionAddresses(
    input.merchantPubkey,
    input.productDTag,
    input.intent
  )
  const shippingOptionDTags = getFixedShippingOptionDTags(
    input.productDTag,
    input.intent
  )
  const zones = getFixedShippingRateZones(input.intent)
  const countries = Array.from(
    new Set(zones.flatMap((zone) => zone.countries))
  ).sort()

  return {
    ...input.product,
    shippingCostSats: undefined,
    sourceShippingCost: undefined,
    shippingOptionId: shippingOptionIds[0],
    shippingOptionDTag: shippingOptionDTags[0],
    shippingOptionIds,
    shippingOptionDTags,
    shippingOptionRefs: undefined,
    collectionRefs: input.product.collectionRefs?.length
      ? [...input.product.collectionRefs]
      : undefined,
    shippingOptionLaunchUnsupported: undefined,
    shippingCountries: countries,
    shippingCountryRules: zones.flatMap((zone) =>
      zone.countryRules.map((rule) => ({
        ...rule,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
        ...(rule.includeSubdivisions
          ? { includeSubdivisions: [...rule.includeSubdivisions] }
          : {}),
        ...(rule.excludeSubdivisions
          ? { excludeSubdivisions: [...rule.excludeSubdivisions] }
          : {}),
      }))
    ),
    shippingZones: undefined,
    canonicalShippingResolved: false,
    shippingOptionCreatedAt: undefined,
  }
}

export function getCanonicalProductWriteFingerprint(
  listing: Pick<
    ProductListingPublishTarget,
    "product" | "dTag" | "fulfillmentIntent"
  >
): string {
  const product = applyProductFulfillmentIntentForPublication({
    product: listing.product,
    merchantPubkey: listing.product.pubkey,
    productDTag: listing.dTag,
    intent: listing.fulfillmentIntent,
  })
  const productDraft = buildProductListingEventDraft({
    product,
    dTag: listing.dTag,
    clientAppId: "merchant",
  })
  const shippingDrafts =
    listing.fulfillmentIntent.kind === "fixed_standard"
      ? buildFixedShippingOptionEventDrafts({
          productDTag: listing.dTag,
          intent: listing.fulfillmentIntent,
          clientAppId: "merchant",
        })
      : []
  return JSON.stringify([
    [productDraft.kind, productDraft.content, productDraft.tags],
    shippingDrafts.map((draft) => [draft.kind, draft.content, draft.tags]),
  ])
}

async function signProductWrite(
  ndk: ReturnType<typeof getNdk>,
  signer: NonNullable<ReturnType<typeof getNdk>["signer"]>,
  merchantPubkey: string,
  listing: ProductListingPublishTarget,
  now: number
): Promise<SignedProductWrite> {
  if (listing.product.pubkey !== merchantPubkey) {
    throw new Error("Product pubkey does not match current merchant pubkey")
  }
  const createdAt = Math.max(
    Math.floor(now / 1000),
    (listing.previousEventCreatedAt ?? -1) + 1
  )
  const product = applyProductFulfillmentIntentForPublication({
    product: listing.product,
    merchantPubkey,
    productDTag: listing.dTag,
    intent: listing.fulfillmentIntent,
  })
  const productDraft = buildProductListingEventDraft({
    product,
    dTag: listing.dTag,
    clientAppId: "merchant",
  })
  const productEvent = new NDKEvent(ndk)
  productEvent.kind = productDraft.kind
  productEvent.created_at = createdAt
  productEvent.content = productDraft.content
  productEvent.tags = productDraft.tags

  const shippingEvents: NDKEvent[] = []
  if (listing.fulfillmentIntent.kind === "fixed_standard") {
    const shippingDrafts = buildFixedShippingOptionEventDrafts({
      productDTag: listing.dTag,
      intent: listing.fulfillmentIntent,
      clientAppId: "merchant",
    })
    for (const shippingDraft of shippingDrafts) {
      const shippingEvent = new NDKEvent(ndk)
      shippingEvent.kind = shippingDraft.kind
      shippingEvent.created_at = createdAt
      shippingEvent.content = shippingDraft.content
      shippingEvent.tags = shippingDraft.tags
      await shippingEvent.sign(signer)
      shippingEvents.push(shippingEvent)
    }
  }
  await productEvent.sign(signer)
  return { productEvent, shippingEvents }
}

export interface ProductDeletionPublishTarget extends ProductDeletionEventTarget {
  sourceRelayUrls?: readonly string[]
  acknowledgedAuthorWriteRelayUrls?: readonly string[]
  shippingOptionIds?: readonly string[]
  previousEventCreatedAt?: number
  previousShippingOptionCreatedAt?: number
  previousShippingZones?: ProductSchema["shippingZones"]
}

function toNostrCreatedAtSeconds(timestampMs: number | undefined): number {
  return typeof timestampMs === "number" &&
    Number.isFinite(timestampMs) &&
    timestampMs >= 0
    ? Math.floor(timestampMs / 1000)
    : -1
}

export function getProductDeletionCreatedAt(input: {
  nowMs: number
  newlySignedEvents?: readonly Pick<NDKEvent, "created_at">[]
  listings?: readonly ProductListingPublishTarget[]
  deletions?: readonly ProductDeletionPublishTarget[]
}): number {
  return Math.max(
    Math.floor(input.nowMs / 1000),
    ...(input.newlySignedEvents ?? []).map((event) => event.created_at ?? -1),
    ...(input.listings ?? []).flatMap((listing) => [
      listing.previousEventCreatedAt ?? -1,
      toNostrCreatedAtSeconds(listing.previousShippingOptionCreatedAt),
    ]),
    ...(input.deletions ?? []).flatMap((deletion) => [
      deletion.previousEventCreatedAt ?? -1,
      toNostrCreatedAtSeconds(deletion.previousShippingOptionCreatedAt),
    ])
  )
}

function getAddressDTag(
  coordinate: string,
  kind: number,
  authorPubkey: string
): string | null {
  const prefix = `${kind}:${authorPubkey}:`
  return coordinate.startsWith(prefix) ? coordinate.slice(prefix.length) : null
}

export function isMerchantOwnedFixedShippingOption(input: {
  coordinate: string
  merchantPubkey: string
  productDTag: string
  canonicalCoordinates?: ReadonlySet<string>
}): boolean {
  const optionDTag = getAddressDTag(
    input.coordinate,
    EVENT_KINDS.SHIPPING_OPTION,
    input.merchantPubkey
  )
  if (!optionDTag) return false

  const legacyDTag = `${input.productDTag}-shipping-standard`
  if (optionDTag === legacyDTag) return true
  return input.canonicalCoordinates?.has(input.coordinate) ?? false
}

function getCanonicalFixedShippingOptionCoordinates(input: {
  merchantPubkey: string
  productDTag: string
  shippingZones: ProductSchema["shippingZones"]
}): ReadonlySet<string> {
  const intent = compileResolvedShippingZones(input.shippingZones ?? [])
  return new Set(
    intent?.kind === "fixed_standard"
      ? getFixedShippingOptionAddresses(
          input.merchantPubkey,
          input.productDTag,
          intent
        )
      : []
  )
}

export function getMerchantOwnedFixedShippingOptionIds(input: {
  merchantPubkey: string
  productDTag: string
  product: Pick<
    ProductSchema,
    | "canonicalShippingResolved"
    | "collectionRefs"
    | "shippingOptionId"
    | "shippingOptionIds"
    | "shippingOptionRefs"
    | "shippingZones"
  >
}): string[] {
  // Verified event-pickup references have a separate lifecycle and must never
  // be withdrawn as product-owned fixed shipping. An unrelated collection does
  // not change the ownership of this product's canonical fixed coordinates.
  if (
    hasEventPickupReferences(input.product, {
      merchantPubkey: input.merchantPubkey,
      productDTag: input.productDTag,
    })
  ) {
    return []
  }

  const resolvedFixedCoordinates = getCanonicalFixedShippingOptionCoordinates({
    merchantPubkey: input.merchantPubkey,
    productDTag: input.productDTag,
    shippingZones: input.product.shippingZones,
  })
  const referencedCoordinates = input.product.shippingOptionIds?.length
    ? input.product.shippingOptionIds
    : input.product.shippingOptionId
      ? [input.product.shippingOptionId]
      : []

  // Successful resolution proves that an option is valid and same-author, but
  // it does not prove that this product owns the coordinate. Only withdraw the
  // product-scoped coordinates Merchant creates for this listing.
  return Array.from(
    new Set([...referencedCoordinates, ...resolvedFixedCoordinates])
  ).filter((coordinate) =>
    isMerchantOwnedFixedShippingOption({
      coordinate,
      merchantPubkey: input.merchantPubkey,
      productDTag: input.productDTag,
      canonicalCoordinates: resolvedFixedCoordinates,
    })
  )
}

function getProductTargetDTag(
  target: Pick<ProductDeletionPublishTarget, "addressId">,
  merchantPubkey: string
): string | null {
  if (!target.addressId) return null
  return getAddressDTag(target.addressId, EVENT_KINDS.PRODUCT, merchantPubkey)
}

export function getObsoleteShippingOptionIds(input: {
  merchantPubkey: string
  listings: readonly ProductListingPublishTarget[]
  deletions?: readonly ProductDeletionPublishTarget[]
}): string[] {
  const retainedShippingOptionIds = new Set(
    input.listings.flatMap((listing) =>
      listing.fulfillmentIntent.kind === "fixed_standard"
        ? getFixedShippingOptionAddresses(
            input.merchantPubkey,
            listing.dTag,
            listing.fulfillmentIntent
          )
        : []
    )
  )
  return Array.from(
    new Set([
      ...input.listings.flatMap((listing) => {
        const canonicalCoordinates = getCanonicalFixedShippingOptionCoordinates(
          {
            merchantPubkey: input.merchantPubkey,
            productDTag: listing.dTag,
            shippingZones: listing.previousShippingZones,
          }
        )
        return (listing.previousShippingOptionIds ?? []).filter((coordinate) =>
          isMerchantOwnedFixedShippingOption({
            coordinate,
            merchantPubkey: input.merchantPubkey,
            productDTag: listing.dTag,
            canonicalCoordinates,
          })
        )
      }),
      ...(input.deletions ?? []).flatMap((deletion) => {
        const productDTag = getProductTargetDTag(deletion, input.merchantPubkey)
        if (!productDTag) return []
        const canonicalCoordinates = getCanonicalFixedShippingOptionCoordinates(
          {
            merchantPubkey: input.merchantPubkey,
            productDTag,
            shippingZones: deletion.previousShippingZones,
          }
        )
        return (deletion.shippingOptionIds ?? []).filter((coordinate) =>
          isMerchantOwnedFixedShippingOption({
            coordinate,
            merchantPubkey: input.merchantPubkey,
            productDTag,
            canonicalCoordinates,
          })
        )
      }),
    ])
  ).filter((coordinate) => !retainedShippingOptionIds.has(coordinate))
}

export interface ProductRemovalRecord {
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt?: number
  sourceRelayUrls: readonly string[]
  product?: Pick<
    ProductSchema,
    | "canonicalShippingResolved"
    | "collectionRefs"
    | "shippingOptionId"
    | "shippingOptionIds"
    | "shippingOptionRefs"
    | "shippingZones"
    | "shippingOptionCreatedAt"
  >
  shippingOptionIds?: readonly string[]
  shippingOptionSourceRelayUrls?: readonly string[]
  shippingOptionAuthorWriteRelayUrls?: readonly string[]
}

export interface HydratableProductRemovalRecord extends Omit<
  ProductRemovalRecord,
  "product"
> {
  product?: ProductSchema
}

function getPotentialOwnedShippingOptionIds(
  record: HydratableProductRemovalRecord
): string[] {
  if (!record.dTag || !record.product) return []
  if (
    hasEventPickupReferences(record.product, {
      merchantPubkey: record.product.pubkey,
      productDTag: record.dTag,
    })
  ) {
    return []
  }
  const prefix = `${EVENT_KINDS.SHIPPING_OPTION}:${record.product.pubkey}:${record.dTag}-shipping-standard`
  const references = record.product.shippingOptionIds?.length
    ? record.product.shippingOptionIds
    : record.product.shippingOptionId
      ? [record.product.shippingOptionId]
      : []
  return Array.from(
    new Set(
      references.filter(
        (coordinate) =>
          coordinate === prefix || coordinate.startsWith(`${prefix}-`)
      )
    )
  )
}

export async function prepareProductRemovalDeletionTargets(
  records: readonly HydratableProductRemovalRecord[],
  options: {
    readShippingOptions?: (
      coordinates: readonly string[]
    ) => Promise<ParsedShippingOption[]>
  } = {}
): Promise<ProductDeletionPublishTarget[]> {
  const coordinates = Array.from(
    new Set(records.flatMap(getPotentialOwnedShippingOptionIds))
  )
  if (coordinates.length === 0) {
    return buildProductRemovalDeletionTargets(records)
  }

  let shippingOptions: ParsedShippingOption[]
  try {
    shippingOptions = await (
      options.readShippingOptions ?? getShippingOptionsByCoordinates
    )(coordinates)
  } catch {
    throw new Error(
      "Fixed shipping ownership could not be verified. Refresh the listing and try deletion again."
    )
  }

  const hydratedRecords = records.map((record) => {
    const candidateIds = getPotentialOwnedShippingOptionIds(record)
    if (candidateIds.length === 0 || !record.product) return record
    const candidateIdSet = new Set(candidateIds)
    const ownershipFrontier = Math.max(
      record.product.updatedAt,
      ...shippingOptions
        .filter((option) => candidateIdSet.has(option.id))
        .map((option) => option.createdAt)
    )
    // Checkout rejects an option newer than the product projection. Deletion
    // still has to withdraw that exact signed coordinate, so hydrate ownership
    // against the observed frontier without making it payable.
    const prepared = resolveProductFulfillment(
      { ...record.product, updatedAt: ownershipFrontier },
      shippingOptions
    )
    if (prepared.intent !== "fixed_standard" || prepared.status !== "ready") {
      throw new Error(
        "Fixed shipping ownership could not be verified. Refresh the listing and try deletion again."
      )
    }
    return {
      ...record,
      product: applyPreparedProductFulfillment(record.product, prepared),
    }
  })
  return buildProductRemovalDeletionTargets(hydratedRecords)
}

export function buildProductRemovalDeletionTargets(
  records: readonly ProductRemovalRecord[]
): ProductDeletionPublishTarget[] {
  return records.map((record) => {
    const [kind, merchantPubkey] = record.addressId.split(":", 2)
    const addressDTag =
      kind === String(EVENT_KINDS.PRODUCT) && merchantPubkey
        ? getAddressDTag(record.addressId, EVENT_KINDS.PRODUCT, merchantPubkey)
        : null
    const productDTag =
      record.dTag && record.dTag === addressDTag ? record.dTag : null
    const shippingOptionIds =
      productDTag && merchantPubkey && record.product
        ? getMerchantOwnedFixedShippingOptionIds({
            merchantPubkey,
            productDTag,
            product: record.product,
          })
        : productDTag && merchantPubkey
          ? Array.from(
              new Set(
                (record.shippingOptionIds ?? []).filter((coordinate) =>
                  isMerchantOwnedFixedShippingOption({
                    coordinate,
                    merchantPubkey,
                    productDTag,
                  })
                )
              )
            )
          : []
    return {
      eventId: record.eventId,
      ...(productDTag ? { addressId: record.addressId } : {}),
      sourceRelayUrls: getPreviousShippingSourceRelayUrls({
        previousShippingOptionIds: shippingOptionIds,
        previousProduct: record.product ?? {},
        previousProductSourceRelayUrls: record.sourceRelayUrls,
        cachedShippingSourceRelayUrls:
          record.shippingOptionSourceRelayUrls ?? [],
      }),
      ...(record.shippingOptionAuthorWriteRelayUrls?.length
        ? {
            acknowledgedAuthorWriteRelayUrls:
              record.shippingOptionAuthorWriteRelayUrls,
          }
        : {}),
      ...(shippingOptionIds.length > 0 ? { shippingOptionIds } : {}),
      ...(record.eventCreatedAt !== undefined
        ? { previousEventCreatedAt: record.eventCreatedAt }
        : {}),
      ...(record.product?.shippingOptionCreatedAt !== undefined
        ? {
            previousShippingOptionCreatedAt:
              record.product.shippingOptionCreatedAt,
          }
        : {}),
      ...(shippingOptionIds.length > 0 && record.product?.shippingZones
        ? { previousShippingZones: record.product.shippingZones }
        : {}),
    }
  })
}

export interface SignedProductWriteBundle {
  events: readonly NDKEvent[]
  deletionDeliveryJobId?: string
}

export async function deliverSignedProductWriteBundle(
  bundle: SignedProductWriteBundle,
  merchantPubkey: string,
  deletionDeliveryOptions: DeliverQueuedProductDeletionOptions = {}
): Promise<PublishWithPlannerResult> {
  const deletionEvents = bundle.events.filter(
    (event) => event.kind === EVENT_KINDS.DELETION
  )
  if (deletionEvents.length > 1) {
    throw new Error("Expected at most one signed product deletion event")
  }
  const deletionEvent = deletionEvents[0]
  const rawDeletionEvent = deletionEvent
    ? (deletionEvent.rawEvent() as SignedPublicNostrEvent)
    : null
  if (
    (!!rawDeletionEvent || !!bundle.deletionDeliveryJobId) &&
    (!rawDeletionEvent ||
      !bundle.deletionDeliveryJobId ||
      bundle.deletionDeliveryJobId !== rawDeletionEvent.id ||
      !isDeliverableMerchantProductEvent(rawDeletionEvent, merchantPubkey))
  ) {
    throw new Error(
      "Expected an exact signed merchant deletion with its durable delivery job"
    )
  }

  const deliveryPromises: Promise<PublishWithPlannerResult>[] = []
  for (const event of bundle.events) {
    if (event.kind !== EVENT_KINDS.DELETION) {
      deliveryPromises.push(deliverSignedProductEvent(event, merchantPubkey))
    }
  }
  if (bundle.deletionDeliveryJobId) {
    deliveryPromises.push(
      deliverQueuedProductDeletion(
        bundle.deletionDeliveryJobId,
        deletionDeliveryOptions
      )
    )
  }
  const deliveries = await Promise.all(deliveryPromises)
  return aggregateProductEventDeliveries(deliveries)
}

export async function signAndPublishProductWriteBundle(input: {
  merchantPubkey: string
  listings: readonly ProductListingPublishTarget[]
  deletions?: readonly ProductDeletionPublishTarget[]
  onSignedLocal: (bundle: SignedProductWriteBundle) => Promise<void>
  deletionDeliveryOptions?: DeliverQueuedProductDeletionOptions
}): Promise<PublishWithPlannerResult> {
  const ndk = getNdk()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signer = ndk.signer
  const signerPubkey = (await signer.user()).pubkey
  if (signerPubkey !== input.merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }
  if (input.listings.length === 0 && (input.deletions?.length ?? 0) === 0) {
    throw new Error("No product changes require signing")
  }

  const writes: SignedProductWrite[] = []
  for (const listing of input.listings) {
    writes.push(
      await signProductWrite(ndk, signer, signerPubkey, listing, Date.now())
    )
  }
  const productEvents = writes.map((write) => write.productEvent)
  const events: NDKEvent[] = [...productEvents]
  const obsoleteShippingOptionIds = getObsoleteShippingOptionIds({
    merchantPubkey: signerPubkey,
    listings: input.listings,
    deletions: input.deletions,
  })
  if (
    (input.deletions?.length ?? 0) > 0 ||
    obsoleteShippingOptionIds.length > 0
  ) {
    const draft = buildProductDeletionEventDraft({
      merchantPubkey: signerPubkey,
      targets: input.deletions ?? [],
      shippingOptionCoordinates: obsoleteShippingOptionIds,
      clientAppId: "merchant",
    })
    const deletion = new NDKEvent(ndk)
    deletion.kind = draft.kind
    deletion.created_at = getProductDeletionCreatedAt({
      nowMs: Date.now(),
      newlySignedEvents: writes.flatMap((write) => [
        write.productEvent,
        ...write.shippingEvents,
      ]),
      listings: input.listings,
      deletions: input.deletions,
    })
    deletion.content = draft.content
    deletion.tags = draft.tags
    await deletion.sign(signer)
    events.push(deletion)
  }

  for (const write of writes) {
    for (const shippingEvent of write.shippingEvents) {
      const delivery = await publishWithPlanner(shippingEvent, {
        intent: "author_event",
        authorPubkey: signerPubkey,
        authenticatedPubkey: signerPubkey,
        deliveryMode: "critical",
      })
      if (delivery.successfulRelayUrls.length === 0) {
        throw new Error(
          "Fixed shipping was not acknowledged by a relay. Product publication was stopped."
        )
      }
      await cacheSignedShippingOptionEvent(
        shippingEvent,
        delivery.successfulRelayUrls
      )
    }
  }

  const deletionEvent = events.find(
    (event) => event.kind === EVENT_KINDS.DELETION
  )
  const listingEvents = events.filter(
    (event) => event.kind === EVENT_KINDS.PRODUCT
  )
  await Promise.all(
    listingEvents.map((event) => cacheSignedProductListingEvent(event))
  )

  let deletionDeliveryJobId: string | undefined
  if (deletionEvent) {
    const currentWriteRelayUrls =
      await planCurrentProductDeletionWriteRelays(signerPubkey)
    const sourceRelayUrls = mergeRelayUrls(
      ...(input.deletions ?? []).map(
        (deletion) => deletion.sourceRelayUrls ?? []
      ),
      ...input.listings.map(
        (listing) => listing.previousShippingSourceRelayUrls ?? []
      )
    )
    const acknowledgedAuthorWriteRelayUrls = mergeRelayUrls(
      ...(input.deletions ?? []).map(
        (deletion) => deletion.acknowledgedAuthorWriteRelayUrls ?? []
      ),
      ...input.listings.map(
        (listing) => listing.previousShippingAuthorWriteRelayUrls ?? []
      )
    )
    const deliveryJob = await persistSignedProductDeletion(
      {
        signedEvent: deletionEvent.rawEvent() as SignedPublicNostrEvent,
        currentWriteRelayUrls,
        acknowledgedAuthorWriteRelayUrls,
        sourceRelayUrls,
      },
      input.deletionDeliveryOptions
    )
    deletionDeliveryJobId = deliveryJob.id
    await cacheSignedMerchantDeletionEvent(deletionEvent)
  }

  const signedBundle: SignedProductWriteBundle = {
    events,
    ...(deletionDeliveryJobId ? { deletionDeliveryJobId } : {}),
  }
  try {
    await input.onSignedLocal(signedBundle)
    return await deliverSignedProductWriteBundle(
      signedBundle,
      signerPubkey,
      input.deletionDeliveryOptions
    )
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

export async function signAndPublishProductListing(input: {
  merchantPubkey: string
  product: ProductSchema
  dTag: string
  previousEventCreatedAt?: number
  previousShippingOptionCreatedAt?: number
  previousShippingOptionIds?: readonly string[]
  previousShippingZones?: ProductSchema["shippingZones"]
  previousShippingSourceRelayUrls?: readonly string[]
  previousShippingAuthorWriteRelayUrls?: readonly string[]
  fulfillmentIntent: ProductFulfillmentIntent
  onSignedLocal: (event: NDKEvent) => Promise<void>
}): Promise<PublishWithPlannerResult> {
  return signAndPublishProductWriteBundle({
    merchantPubkey: input.merchantPubkey,
    listings: [
      {
        product: input.product,
        dTag: input.dTag,
        previousEventCreatedAt: input.previousEventCreatedAt,
        previousShippingOptionCreatedAt: input.previousShippingOptionCreatedAt,
        previousShippingOptionIds: input.previousShippingOptionIds,
        previousShippingZones: input.previousShippingZones,
        previousShippingSourceRelayUrls: input.previousShippingSourceRelayUrls,
        previousShippingAuthorWriteRelayUrls:
          input.previousShippingAuthorWriteRelayUrls,
        fulfillmentIntent: input.fulfillmentIntent,
      },
    ],
    onSignedLocal: async ({ events: [event] }) => {
      if (!event) throw new Error("Signed product event is missing")
      await input.onSignedLocal(event)
    },
  })
}
