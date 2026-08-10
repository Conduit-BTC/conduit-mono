import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildFixedShippingOptionEventDrafts,
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  getProductShippingZoneAddress,
  getProductShippingZoneDTag,
  isValidSignedPublicNostrEvent,
  publishWithPlanner,
  requireNdkConnected,
  RelayPublishDiagnosticsError,
  type ProductSchema,
  type ProductFulfillmentIntent,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"

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
  merchantPubkey: string
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
      publishableEvent = new NDKEvent(await requireNdkConnected(), event)
    }

    return await publishWithPlanner(publishableEvent, {
      intent: "author_event",
      authorPubkey: merchantPubkey,
      authenticatedPubkey: merchantPubkey,
      deliveryMode: "critical",
    })
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

export type CanonicalProductPublishDependencies = {
  publishShippingEvent: (
    event: NDKEvent,
    merchantPubkey: string
  ) => Promise<PublishWithPlannerResult>
  cacheProductEvent: (event: NDKEvent) => Promise<void>
  deliverProductEvent: typeof deliverSignedProductEvent
}

const canonicalProductPublishDependencies: CanonicalProductPublishDependencies =
  {
    publishShippingEvent: (event, merchantPubkey) =>
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: merchantPubkey,
        authenticatedPubkey: merchantPubkey,
        deliveryMode: "critical",
      }),
    cacheProductEvent: async (event) => {
      await cacheSignedProductListingEvent(event)
    },
    deliverProductEvent: deliverSignedProductEvent,
  }

export function applyProductFulfillmentIntentForPublication(input: {
  product: ProductSchema
  merchantPubkey: string
  productDTag: string
  intent: ProductFulfillmentIntent
}): ProductSchema {
  if (input.intent.kind !== "fixed_standard") {
    return {
      ...input.product,
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      shippingOptionIds: undefined,
      shippingOptionDTags: undefined,
      shippingOptionLaunchUnsupported: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
      canonicalShippingResolved: false,
      shippingOptionCreatedAt: undefined,
    }
  }

  const shippingOptionIds = input.intent.zones.map((zone) =>
    getProductShippingZoneAddress(
      input.merchantPubkey,
      input.productDTag,
      zone.countries
    )
  )
  const shippingOptionDTags = input.intent.zones.map((zone) =>
    getProductShippingZoneDTag(input.productDTag, zone.countries)
  )
  const countries = Array.from(
    new Set(input.intent.zones.flatMap((zone) => zone.countries))
  ).sort()

  return {
    ...input.product,
    shippingOptionId: shippingOptionIds[0],
    shippingOptionDTag: shippingOptionDTags[0],
    shippingOptionIds,
    shippingOptionDTags,
    shippingOptionLaunchUnsupported: undefined,
    shippingCountries: countries,
    shippingCountryRules: countries.map((code) => ({
      code,
      name: code,
      restrictTo: [],
      exclude: [],
    })),
  }
}

export async function publishCanonicalProductEvents(
  input: {
    productEvent: NDKEvent
    shippingEvents: NDKEvent[]
    merchantPubkey: string
    onSignedLocal: (event: NDKEvent) => Promise<void>
  },
  dependencies: CanonicalProductPublishDependencies = canonicalProductPublishDependencies
): Promise<PublishWithPlannerResult> {
  for (const shippingEvent of input.shippingEvents) {
    const shippingResult = await dependencies.publishShippingEvent(
      shippingEvent,
      input.merchantPubkey
    )
    if (shippingResult.successfulRelayUrls.length === 0) {
      throw new Error(
        "Fixed shipping was not acknowledged by a relay. Product publication was stopped."
      )
    }
  }

  await dependencies.cacheProductEvent(input.productEvent)
  try {
    await input.onSignedLocal(input.productEvent)
    return await dependencies.deliverProductEvent(
      input.productEvent,
      input.merchantPubkey
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
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = (await ndk.signer.user()).pubkey
  if (signerPubkey !== input.merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }
  if (input.product.pubkey !== signerPubkey) {
    throw new Error("Product pubkey does not match current merchant pubkey")
  }

  const now = Date.now()
  const canonicalProduct = applyProductFulfillmentIntentForPublication({
    product: input.product,
    merchantPubkey: signerPubkey,
    productDTag: input.dTag,
    intent: input.fulfillmentIntent,
  })
  const productEvent = new NDKEvent(ndk)
  const draft = buildProductListingEventDraft({
    product: canonicalProduct,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  const eventCreatedAt = Math.max(
    Math.floor(now / 1000),
    (input.previousEventCreatedAt ?? -1) + 1
  )
  productEvent.kind = draft.kind
  productEvent.created_at = eventCreatedAt
  productEvent.content = draft.content
  productEvent.tags = draft.tags

  const shippingEvents =
    input.fulfillmentIntent.kind === "fixed_standard"
      ? buildFixedShippingOptionEventDrafts({
          productDTag: input.dTag,
          intent: input.fulfillmentIntent,
          clientAppId: "merchant",
        }).map((shippingDraft) => {
          const shippingEvent = new NDKEvent(ndk)
          shippingEvent.kind = shippingDraft.kind
          shippingEvent.created_at = eventCreatedAt
          shippingEvent.content = shippingDraft.content
          shippingEvent.tags = shippingDraft.tags
          return shippingEvent
        })
      : []

  for (const shippingEvent of shippingEvents) {
    await shippingEvent.sign(ndk.signer)
  }
  await productEvent.sign(ndk.signer)

  return publishCanonicalProductEvents({
    productEvent,
    shippingEvents,
    merchantPubkey: signerPubkey,
    onSignedLocal: input.onSignedLocal,
  })
}
