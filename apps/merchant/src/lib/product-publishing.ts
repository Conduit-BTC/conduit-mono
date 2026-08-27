import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildFixedShippingOptionEventDraft,
  buildProductDeletionEventDraft,
  buildProductListingEventDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  compileProductFulfillmentIntent,
  EVENT_KINDS,
  getNdk,
  getProductShippingOptionAddress,
  getProductShippingOptionDTag,
  isValidSignedPublicNostrEvent,
  publishWithPlanner,
  RelayPublishDiagnosticsError,
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
  fulfillmentIntent: ProductFulfillmentIntent
}

type SignedProductWrite = {
  productEvent: NDKEvent
  shippingEvent: NDKEvent | null
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
  intent: ProductFulfillmentIntent
}): ProductSchema {
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
    collectionRefs: undefined,
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
    await shippingEvent.sign(signer)
  }
  await productEvent.sign(signer)
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
    await deletion.sign(signer)
    events.push(deletion)
  }

  for (const write of writes) {
    if (!write.shippingEvent) continue
    const delivery = await publishWithPlanner(write.shippingEvent, {
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
      )
    )
    const deliveryJob = await persistSignedProductDeletion(
      {
        signedEvent: deletionEvent.rawEvent() as SignedPublicNostrEvent,
        currentWriteRelayUrls,
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
        fulfillmentIntent: input.fulfillmentIntent,
      },
    ],
    onSignedLocal: async ({ events: [event] }) => {
      if (!event) throw new Error("Signed product event is missing")
      await input.onSignedLocal(event)
    },
  })
}
