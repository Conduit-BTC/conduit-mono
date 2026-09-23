import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildFixedShippingOptionEventDraft,
  buildProductDeletionEventDraft,
  buildProductListingEventDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  compileProductFulfillmentIntent,
  EVENT_KINDS,
  getEventMarketPickupsByCoordinates,
  getNdk,
  getProductEventMarketFulfillmentClaims,
  getProductShippingOptionAddress,
  getProductShippingOptionDTag,
  getShippingOptionsByCoordinates,
  isValidSignedPublicNostrEvent,
  normalizeCurrencyCode,
  normalizeCurrencyIdentity,
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  resolveProductFulfillment,
  waitForVisibleDocument,
  type ParsedShippingOption,
  type ParsedEventMarketPickup,
  type ProductDeletionEventTarget,
  type ProductFulfillmentIntent,
  type ProductSchema,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
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
  options: {
    extraRelayUrls?: readonly string[]
    /** Active authenticated account; never inferred from merchantPubkey. */
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  } = {}
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
    const authenticatedPubkey = options.authenticatedPubkey
      ?.trim()
      .toLowerCase()

    let publishableEvent: NDKEvent
    if (event instanceof NDKEvent) {
      publishableEvent = event
    } else {
      publishableEvent = new NDKEvent(getNdk(), event)
    }

    const delivery = await publishWithPlanner(publishableEvent, {
      intent: "commerce_author_event",
      authorPubkey: merchantPubkey,
      authenticatedPubkey:
        authenticatedPubkey === merchantPubkey.toLowerCase()
          ? authenticatedPubkey
          : null,
      accountPubkey: merchantPubkey,
      deliveryMode: "critical",
      extraRelayUrls: options.extraRelayUrls,
      shouldContinue: options.shouldContinue,
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

export async function deliverSignedProductEventBundle(
  events: readonly (NDKEvent | SignedPublicNostrEvent)[],
  merchantPubkey: string,
  options: {
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  } = {}
): Promise<PublishWithPlannerResult> {
  if (events.length === 0) {
    throw new Error("At least one signed product event is required")
  }

  const deliveries = await Promise.all(
    events.map((event) =>
      deliverSignedProductEvent(event, merchantPubkey, options)
    )
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

/** Preservation is a merchant write policy, never checkout authorization. */
export type ProductPublicationFulfillmentIntent =
  | ProductFulfillmentIntent
  | { kind: "preserve_existing"; baseline: ProductSchema }

export function getProductPreservedFulfillmentFields(product: ProductSchema) {
  return {
    format: product.format,
    visibility: product.visibility,
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingOptionRefs: product.shippingOptionRefs,
    collectionRefs: product.collectionRefs,
    shippingOptionLaunchUnsupported: product.shippingOptionLaunchUnsupported,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    canonicalShippingResolved: product.canonicalShippingResolved,
    shippingOptionCreatedAt: product.shippingOptionCreatedAt,
  }
}

export interface ProductListingPublishTarget {
  product: ProductSchema
  dTag: string
  previousEventCreatedAt?: number
  fulfillmentIntent: ProductPublicationFulfillmentIntent
}

const VERIFIED_EVENT_PICKUP = Symbol("verified-event-pickup")

type PreparedProductListingPublishTarget = ProductListingPublishTarget & {
  [VERIFIED_EVENT_PICKUP]?: true
}

export interface ProductPublicationDependencies {
  getEventMarketPickups: (
    coordinates: readonly string[],
    options: {
      authenticatedPubkey?: string | null
      shouldContinue?: () => boolean
    }
  ) => Promise<ParsedEventMarketPickup[]>
  getShippingOptions: (
    coordinates: readonly string[],
    options: {
      accountPubkey?: string | null
      authenticatedPubkey?: string | null
      shouldContinue?: () => boolean
    }
  ) => Promise<ParsedShippingOption[]>
}

type SignedProductWrite = {
  productEvent: NDKEvent
  shippingEvent: NDKEvent | null
}

export type ProductSignerRequestKind = "shipping" | "product" | "deletion"

export interface ProductSignerRequestProgress {
  kind: ProductSignerRequestKind
  current: number
  total: number
}

export function getProductSignerRequestMessage(
  progress: ProductSignerRequestProgress
): string {
  const action =
    progress.kind === "shipping"
      ? "Approve shipping details"
      : progress.kind === "deletion"
        ? "Approve product removal"
        : "Approve product"
  return `${action} — ${progress.current} of ${progress.total}`
}

export function getProductSignerRequestCount(input: {
  listings: readonly ProductListingPublishTarget[]
  deletions?: readonly ProductDeletionPublishTarget[]
}): number {
  return (
    input.listings.length +
    input.listings.filter(
      (listing) =>
        listing.fulfillmentIntent.kind === "fixed_standard" ||
        (listing.fulfillmentIntent.kind === "preserve_existing" &&
          hasCanonicalProductShippingReference(
            listing.fulfillmentIntent.baseline,
            listing.dTag
          ))
    ).length +
    ((input.deletions?.length ?? 0) > 0 ? 1 : 0)
  )
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

function hasEventPickupReferences(
  product: Pick<
    ProductSchema,
    "canonicalShippingResolved" | "collectionRefs" | "shippingOptionRefs"
  >
): boolean {
  return (
    product.canonicalShippingResolved !== true &&
    (product.collectionRefs?.length ?? 0) > 0 &&
    (product.shippingOptionRefs?.length ?? 0) > 0
  )
}

function hasCanonicalProductShippingReference(
  product: Pick<
    ProductSchema,
    | "pubkey"
    | "shippingCostSats"
    | "sourceShippingCost"
    | "shippingOptionId"
    | "shippingOptionDTag"
    | "shippingOptionRefs"
    | "shippingOptionLaunchUnsupported"
    | "shippingCountries"
    | "shippingCountryRules"
    | "canonicalShippingResolved"
  >,
  dTag: string
): boolean {
  const expectedDTag = getProductShippingOptionDTag(dTag)
  const expectedAddress = getProductShippingOptionAddress(product.pubkey, dTag)
  const reference = product.shippingOptionRefs?.[0]
  const hasHydratedProjection =
    typeof product.sourceShippingCost?.amount === "number" ||
    typeof product.shippingCostSats === "number" ||
    (product.shippingCountries?.length ?? 0) > 0 ||
    (product.shippingCountryRules?.length ?? 0) > 0
  return (
    product.shippingOptionId === expectedAddress &&
    product.shippingOptionDTag === expectedDTag &&
    product.shippingOptionRefs?.length === 1 &&
    reference?.coordinate === expectedAddress &&
    (reference.dTag === undefined || reference.dTag === expectedDTag) &&
    reference.extraCost === undefined &&
    reference.extraCostMalformed !== true &&
    product.shippingOptionLaunchUnsupported !== true &&
    (!hasHydratedProjection || product.canonicalShippingResolved === true)
  )
}

function getEventProductPreservationStrategy(
  product: ProductSchema
): "product_event" | "event_pickup" | null {
  const reference = product.shippingOptionRefs?.[0]
  const hasExactReference =
    product.visibility !== "public" &&
    product.canonicalShippingResolved !== true &&
    product.shippingOptionRefs?.length === 1 &&
    !!product.shippingOptionId &&
    reference?.coordinate === product.shippingOptionId &&
    reference.extraCostMalformed !== true
  if (!hasExactReference) return null

  const claims = getProductEventMarketFulfillmentClaims(product)
  if (claims.length === 0) return null
  return claims.some((claim) =>
    claim.directPickupCoordinates.includes(product.shippingOptionId!)
  )
    ? "event_pickup"
    : "product_event"
}

function hasLegacyInlineShipping(
  product: Pick<
    ProductSchema,
    | "shippingCostSats"
    | "sourceShippingCost"
    | "shippingOptionRefs"
    | "shippingCountries"
    | "shippingCountryRules"
  >
): boolean {
  const hasSerializedReferenceExtra = product.shippingOptionRefs?.some(
    (reference) => reference.extraCost !== undefined
  )
  return (
    (!hasSerializedReferenceExtra &&
      (typeof product.sourceShippingCost?.amount === "number" ||
        typeof product.shippingCostSats === "number")) ||
    (product.shippingCountries?.length ?? 0) > 0 ||
    (product.shippingCountryRules?.length ?? 0) > 0
  )
}

type PreservedFulfillmentStrategy =
  | "product_event"
  | "event_pickup"
  | "canonical_fixed"
  | "legacy_upgrade"
  | "explicit_change"

function getPreservedFulfillmentStrategy(
  product: ProductSchema,
  dTag: string
): PreservedFulfillmentStrategy {
  if (product.format === "digital") return "product_event"
  if (hasCanonicalProductShippingReference(product, dTag)) {
    return "canonical_fixed"
  }
  if (hasLegacyInlineShipping(product)) return "legacy_upgrade"
  const eventStrategy = getEventProductPreservationStrategy(product)
  if (eventStrategy) return eventStrategy
  return product.shippingOptionId ? "explicit_change" : "product_event"
}

function getProductCurrency(product: ProductSchema): string {
  return product.sourcePrice?.currency ?? product.currency
}

function getCanonicalPreservationError(
  reason: ReturnType<typeof resolveProductFulfillment>["reason"]
): Error {
  if (reason === "stale") {
    return new Error(
      "Fixed shipping changed since this listing was published. Choose Change fulfillment before saving."
    )
  }
  if (reason === "currency_mismatch") {
    return new Error(
      "Fixed shipping no longer matches this product currency. Choose Change fulfillment before saving."
    )
  }
  return new Error(
    "Fixed shipping could not be verified safely. Try again or choose Change fulfillment before saving."
  )
}

function getEventPickupPreservationError(): Error {
  return new Error(
    "Event pickup could not be verified safely. Try again or choose Change fulfillment before saving."
  )
}

async function prepareProductPublicationListings(
  listings: readonly ProductListingPublishTarget[],
  input: {
    merchantPubkey: string
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  },
  dependencies: ProductPublicationDependencies
): Promise<PreparedProductListingPublishTarget[]> {
  const prepared = listings.map((listing) => {
    if (listing.fulfillmentIntent.kind !== "preserve_existing") {
      return { kind: "ready" as const, listing }
    }

    const baseline = listing.fulfillmentIntent.baseline
    const product = applyProductFulfillmentIntentForPublication({
      product: listing.product,
      merchantPubkey: input.merchantPubkey,
      productDTag: listing.dTag,
      intent: listing.fulfillmentIntent,
    })
    const strategy = getPreservedFulfillmentStrategy(baseline, listing.dTag)
    if (strategy === "product_event") {
      return {
        kind: "ready" as const,
        listing: { ...listing, product },
      }
    }
    if (strategy === "legacy_upgrade") {
      throw new Error(
        "Choose Change fulfillment to upgrade legacy shipping before saving this listing."
      )
    }
    if (strategy === "explicit_change") {
      throw new Error(
        "Existing shipping cannot be preserved safely. Choose Change fulfillment before saving."
      )
    }
    return {
      kind:
        strategy === "event_pickup"
          ? ("pickup" as const)
          : ("canonical" as const),
      baseline,
      listing,
      product,
    }
  })
  const evidenceRequired = prepared.filter(
    (
      entry
    ): entry is Extract<
      (typeof prepared)[number],
      { kind: "pickup" | "canonical" }
    > => entry.kind === "pickup" || entry.kind === "canonical"
  )
  if (evidenceRequired.length === 0) {
    return prepared.map((entry) => entry.listing)
  }

  const pickupCoordinates = Array.from(
    new Set(
      evidenceRequired
        .filter((entry) => entry.kind === "pickup")
        .map((entry) => entry.baseline.shippingOptionId!)
    )
  )
  const canonicalCoordinates = Array.from(
    new Set(
      evidenceRequired
        .filter((entry) => entry.kind === "canonical")
        .map((entry) => entry.baseline.shippingOptionId!)
    )
  )
  let eventPickups: ParsedEventMarketPickup[] = []
  if (pickupCoordinates.length > 0) {
    try {
      eventPickups = await dependencies.getEventMarketPickups(
        pickupCoordinates,
        {
          authenticatedPubkey: input.authenticatedPubkey,
          shouldContinue: input.shouldContinue,
        }
      )
    } catch {
      throw getEventPickupPreservationError()
    }
  }
  let shippingOptions: ParsedShippingOption[]
  if (canonicalCoordinates.length > 0) {
    try {
      shippingOptions = await dependencies.getShippingOptions(
        canonicalCoordinates,
        {
          accountPubkey: input.merchantPubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          shouldContinue: input.shouldContinue,
        }
      )
    } catch {
      throw new Error(
        "Fixed shipping could not be verified safely. Try again or choose Change fulfillment before saving."
      )
    }
  } else {
    shippingOptions = []
  }

  return prepared.map((entry): PreparedProductListingPublishTarget => {
    if (entry.kind === "ready") return entry.listing

    if (entry.kind === "pickup") {
      const pickup = eventPickups.find(
        (option) => option.coordinate === entry.baseline.shippingOptionId
      )
      if (!pickup) throw getEventPickupPreservationError()
      return {
        ...entry.listing,
        product: entry.product,
        [VERIFIED_EVENT_PICKUP]: true,
      }
    }

    const fulfillment = resolveProductFulfillment(
      entry.baseline,
      shippingOptions
    )
    if (
      fulfillment.intent !== "fixed_standard" ||
      fulfillment.status !== "ready" ||
      !fulfillment.option
    ) {
      throw getCanonicalPreservationError(fulfillment.reason)
    }
    if (
      normalizeCurrencyIdentity(getProductCurrency(entry.product)) !==
      normalizeCurrencyIdentity(fulfillment.option.currency)
    ) {
      throw new Error(
        "Change fulfillment before changing currency on a fixed-shipping listing."
      )
    }

    return {
      ...entry.listing,
      product: entry.product,
      fulfillmentIntent: compileProductFulfillmentIntent({
        format: "physical",
        shippingPricingMode: "fixed",
        amount: fulfillment.option.price,
        currency: fulfillment.option.currency,
        destinations: fulfillment.option.countryRules,
      }),
    }
  })
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
  >
  fallbackIntent: ProductFulfillmentIntent
  authoringCountries: readonly string[]
}): ProductFulfillmentIntent {
  if (input.product.format === "digital") return { kind: "digital" }
  if (hasEventPickupReferences(input.product)) {
    return { kind: "coordinate_after_order" }
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
  })
}

export function resolvePublishedProductFulfillmentIntentForTarget(
  product: Pick<
    ProductSchema,
    | "format"
    | "shippingCostSats"
    | "sourceShippingCost"
    | "shippingOptionId"
    | "shippingOptionLaunchUnsupported"
    | "shippingOptionRefs"
    | "collectionRefs"
    | "shippingCountries"
    | "shippingCountryRules"
    | "canonicalShippingResolved"
  >
): ProductFulfillmentIntent | null {
  if (product.format === "digital") return { kind: "digital" }
  if (hasEventPickupReferences(product)) {
    return { kind: "coordinate_after_order" }
  }
  if (product.shippingOptionLaunchUnsupported) return null
  if (product.shippingOptionId && product.canonicalShippingResolved !== true) {
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
    if (!write.shippingEvent) continue
    const delivery = await dependencies.publishShippingEvent(
      write.shippingEvent,
      input.merchantPubkey
    )
    if (delivery.successfulRelayUrls.length === 0) {
      throw new Error(
        "Fixed shipping was not acknowledged by a relay. Product publication was stopped."
      )
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
  intent: ProductPublicationFulfillmentIntent
}): ProductSchema {
  if (input.intent.kind === "preserve_existing") {
    const { baseline } = input.intent
    const address = `30402:${input.merchantPubkey}:${input.productDTag}`
    if (
      !input.productDTag.trim() ||
      input.productDTag !== input.productDTag.trim() ||
      baseline.pubkey !== input.merchantPubkey ||
      input.product.pubkey !== input.merchantPubkey ||
      baseline.id !== address ||
      input.product.id !== address
    ) {
      throw new Error(
        "Existing fulfillment must belong to the same merchant product"
      )
    }
    if (
      JSON.stringify(getProductPreservedFulfillmentFields(input.product)) !==
      JSON.stringify(getProductPreservedFulfillmentFields(baseline))
    ) {
      throw new Error(
        "Choose change fulfillment before changing existing fulfillment"
      )
    }
    const price = input.product.sourcePrice?.amount ?? input.product.price
    const previousPrice = baseline.sourcePrice?.amount ?? baseline.price
    const currency =
      input.product.sourcePrice?.currency ?? input.product.currency
    const previousCurrency = baseline.sourcePrice?.currency ?? baseline.currency
    const sameCurrencyUnit =
      normalizeCurrencyIdentity(currency) ===
      normalizeCurrencyIdentity(previousCurrency)
    if (price === 0 && (previousPrice !== 0 || !sameCurrencyUnit)) {
      throw new Error("Verify local pickup before setting a new zero price")
    }
    if (
      !sameCurrencyUnit &&
      baseline.shippingOptionRefs?.some(
        (reference) => reference.extraCost !== undefined
      )
    ) {
      throw new Error(
        "Choose change fulfillment before changing shipping extra-cost currency"
      )
    }
    if (sameCurrencyUnit) {
      // Form normalization may change case or a same-unit alias. Keep the
      // listing's currency spelling so unchanged reference extras still have
      // exactly the currency semantics that the existing draft serializer uses.
      return {
        ...input.product,
        currency: baseline.currency,
        sourcePrice:
          input.product.sourcePrice || baseline.sourcePrice
            ? {
                amount: price,
                currency: previousCurrency,
                normalizedCurrency: normalizeCurrencyCode(previousCurrency),
              }
            : undefined,
      }
    }
    return { ...input.product }
  }
  if (input.intent.kind !== "fixed_standard") {
    const preserveEventPickup =
      input.intent.kind === "coordinate_after_order" &&
      hasEventPickupReferences(input.product)
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
      shippingOptionRefs: preserveEventPickup
        ? input.product.shippingOptionRefs
        : undefined,
      collectionRefs: preserveEventPickup
        ? input.product.collectionRefs
        : undefined,
      shippingOptionLaunchUnsupported: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
      canonicalShippingResolved: false,
      shippingOptionCreatedAt: undefined,
    }
  }

  return {
    ...input.product,
    shippingCostSats: undefined,
    sourceShippingCost: undefined,
    shippingOptionId: getProductShippingOptionAddress(
      input.merchantPubkey,
      input.productDTag
    ),
    shippingOptionDTag: getProductShippingOptionDTag(input.productDTag),
    shippingOptionRefs: undefined,
    shippingOptionLaunchUnsupported: undefined,
    shippingCountries: [...input.intent.countries],
    shippingCountryRules: input.intent.countries.map((code) => ({
      code,
      name: code,
      restrictTo: [],
      exclude: [],
    })),
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
  const shippingDraft =
    listing.fulfillmentIntent.kind === "fixed_standard"
      ? buildFixedShippingOptionEventDraft({
          productDTag: listing.dTag,
          intent: listing.fulfillmentIntent,
          clientAppId: "merchant",
        })
      : null
  return JSON.stringify([
    [productDraft.kind, productDraft.content, productDraft.tags],
    shippingDraft
      ? [shippingDraft.kind, shippingDraft.content, shippingDraft.tags]
      : null,
  ])
}

async function signProductWrite(
  ndk: ReturnType<typeof getNdk>,
  merchantPubkey: string,
  listing: PreparedProductListingPublishTarget,
  now: number,
  signEvent: (event: NDKEvent, kind: ProductSignerRequestKind) => Promise<void>
): Promise<SignedProductWrite> {
  if (listing.product.pubkey !== merchantPubkey) {
    throw new Error("Product pubkey does not match current merchant pubkey")
  }
  if (listing.fulfillmentIntent.kind === "preserve_existing") {
    const strategy = getPreservedFulfillmentStrategy(
      listing.fulfillmentIntent.baseline,
      listing.dTag
    )
    if (
      strategy !== "product_event" &&
      (strategy !== "event_pickup" || listing[VERIFIED_EVENT_PICKUP] !== true)
    ) {
      throw new Error(
        "Existing fulfillment must be prepared before requesting a signature"
      )
    }
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

  let shippingEvent: NDKEvent | null = null
  if (listing.fulfillmentIntent.kind === "fixed_standard") {
    const shippingDraft = buildFixedShippingOptionEventDraft({
      productDTag: listing.dTag,
      intent: listing.fulfillmentIntent,
      clientAppId: "merchant",
    })
    shippingEvent = new NDKEvent(ndk)
    shippingEvent.kind = shippingDraft.kind
    shippingEvent.created_at = createdAt
    shippingEvent.content = shippingDraft.content
    shippingEvent.tags = shippingDraft.tags
    await signEvent(shippingEvent, "shipping")
  }
  await signEvent(productEvent, "product")
  return { productEvent, shippingEvent }
}

export interface ProductDeletionPublishTarget extends ProductDeletionEventTarget {
  sourceRelayUrls?: readonly string[]
}

export function buildProductRemovalDeletionTargets(
  records: readonly {
    eventId: string
    addressId: string
    sourceRelayUrls: readonly string[]
  }[]
): ProductDeletionPublishTarget[] {
  return records.map((record) => ({
    eventId: record.eventId,
    addressId: record.addressId,
    sourceRelayUrls: [...record.sourceRelayUrls],
  }))
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
      deliveryPromises.push(
        deliverSignedProductEvent(event, merchantPubkey, {
          authenticatedPubkey: deletionDeliveryOptions.authenticatedPubkey,
          shouldContinue: deletionDeliveryOptions.shouldContinue,
        })
      )
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

export async function signAndPublishProductWriteBundle(
  input: {
    merchantPubkey: string
    /** Current session identity; a live signer is the fallback auth seam. */
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    listings: readonly ProductListingPublishTarget[]
    deletions?: readonly ProductDeletionPublishTarget[]
    onSignedLocal: (bundle: SignedProductWriteBundle) => Promise<void>
    onSignedEvent?: (
      event: NDKEvent,
      kind: ProductSignerRequestKind
    ) => Promise<void>
    deletionDeliveryOptions?: DeliverQueuedProductDeletionOptions
    onSignerRequest?: (progress: ProductSignerRequestProgress) => void
    onSignerRequestsComplete?: () => void
    waitForSignerVisibility?: () => Promise<void>
  },
  dependencies: Partial<ProductPublicationDependencies> = {}
): Promise<PublishWithPlannerResult> {
  const ndk = getNdk()
  const assertSignerSessionCurrent = () => {
    if (input.shouldContinue?.() === false) {
      throw new Error("Product signer session changed.")
    }
  }
  assertSignerSessionCurrent()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signer = ndk.signer
  assertSignerSessionCurrent()
  const signerPubkey = (await signer.user()).pubkey
  assertSignerSessionCurrent()
  if (signerPubkey !== input.merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }
  const suppliedAuthenticatedPubkey = input.authenticatedPubkey
    ?.trim()
    .toLowerCase()
  const authenticatedPubkey =
    input.authenticatedPubkey === undefined ||
    suppliedAuthenticatedPubkey === signerPubkey
      ? signerPubkey
      : null
  if (input.listings.length === 0 && (input.deletions?.length ?? 0) === 0) {
    throw new Error("No product changes require signing")
  }
  const listings = await prepareProductPublicationListings(
    input.listings,
    {
      merchantPubkey: input.merchantPubkey,
      authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    },
    {
      getEventMarketPickups:
        dependencies.getEventMarketPickups ??
        getEventMarketPickupsByCoordinates,
      getShippingOptions:
        dependencies.getShippingOptions ?? getShippingOptionsByCoordinates,
    }
  )
  assertSignerSessionCurrent()
  const signerRequestTotal = getProductSignerRequestCount({
    listings,
    deletions: input.deletions,
  })
  const waitForSignerVisibility =
    input.waitForSignerVisibility ?? waitForVisibleDocument
  let signerRequestCurrent = 0
  const signEvent = async (
    event: NDKEvent,
    kind: ProductSignerRequestKind
  ): Promise<void> => {
    assertSignerSessionCurrent()
    signerRequestCurrent += 1
    input.onSignerRequest?.({
      kind,
      current: signerRequestCurrent,
      total: signerRequestTotal,
    })
    await waitForSignerVisibility()
    assertSignerSessionCurrent()
    await event.sign(signer)
    const signed = event.rawEvent() as SignedPublicNostrEvent
    if (
      !isValidSignedPublicNostrEvent(signed) ||
      signed.pubkey !== signerPubkey
    ) {
      throw new Error("Signer returned invalid product event evidence.")
    }
    await input.onSignedEvent?.(event, kind)
    assertSignerSessionCurrent()
  }

  const writes: SignedProductWrite[] = []
  for (const listing of listings) {
    writes.push(
      await signProductWrite(ndk, signerPubkey, listing, Date.now(), signEvent)
    )
  }
  const productEvents = writes.map((write) => write.productEvent)
  const events: NDKEvent[] = [...productEvents]
  if ((input.deletions?.length ?? 0) > 0) {
    const draft = buildProductDeletionEventDraft({
      merchantPubkey: signerPubkey,
      targets: input.deletions ?? [],
      clientAppId: "merchant",
    })
    const deletion = new NDKEvent(ndk)
    deletion.kind = draft.kind
    deletion.created_at = Math.floor(Date.now() / 1000)
    deletion.content = draft.content
    deletion.tags = draft.tags
    await signEvent(deletion, "deletion")
    events.push(deletion)
  }

  assertSignerSessionCurrent()
  input.onSignerRequestsComplete?.()
  assertSignerSessionCurrent()

  for (const write of writes) {
    if (!write.shippingEvent) continue
    const delivery = await publishWithPlanner(write.shippingEvent, {
      intent: "commerce_author_event",
      authorPubkey: signerPubkey,
      authenticatedPubkey,
      accountPubkey: signerPubkey,
      deliveryMode: "critical",
      shouldContinue: input.shouldContinue,
    })
    if (delivery.successfulRelayUrls.length === 0) {
      throw new Error(
        "Fixed shipping was not acknowledged by a relay. Product publication was stopped."
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
    const currentWriteRelayPlan = await planCurrentProductDeletionWriteRelays(
      signerPubkey,
      signerPubkey,
      input.shouldContinue
    )
    const sourceRelayUrls = mergeRelayUrls(
      ...(input.deletions ?? []).map(
        (deletion) => deletion.sourceRelayUrls ?? []
      )
    )
    const deliveryJob = await persistSignedProductDeletion(
      {
        signedEvent: deletionEvent.rawEvent() as SignedPublicNostrEvent,
        currentWriteRelayUrls: currentWriteRelayPlan.relayUrls,
        currentAppRelayUrls: currentWriteRelayPlan.appRelayUrls,
        currentPersonalRelayUrls: currentWriteRelayPlan.personalRelayUrls,
        sourceRelayUrls,
      },
      input.deletionDeliveryOptions
    )
    deletionDeliveryJobId = deliveryJob.id
    await cacheSignedProductDeletionEvent(deletionEvent)
  }

  const signedBundle: SignedProductWriteBundle = {
    events,
    ...(deletionDeliveryJobId ? { deletionDeliveryJobId } : {}),
  }
  try {
    await input.onSignedLocal(signedBundle)
    return await deliverSignedProductWriteBundle(signedBundle, signerPubkey, {
      ...input.deletionDeliveryOptions,
      authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

export async function signAndPublishProductListing(input: {
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  product: ProductSchema
  dTag: string
  previousEventCreatedAt?: number
  fulfillmentIntent: ProductPublicationFulfillmentIntent
  onSignedLocal: (event: NDKEvent) => Promise<void>
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
}): Promise<PublishWithPlannerResult> {
  return signAndPublishProductWriteBundle({
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    listings: [
      {
        product: input.product,
        dTag: input.dTag,
        previousEventCreatedAt: input.previousEventCreatedAt,
        fulfillmentIntent: input.fulfillmentIntent,
      },
    ],
    onSignerRequest: input.onSignerRequest,
    onSignedEvent: async (event, kind) => {
      if (kind !== "product") return
      await input.onSignedLocal(event)
    },
    onSignedLocal: async () => undefined,
  })
}
