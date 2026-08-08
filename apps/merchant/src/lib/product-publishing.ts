import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildFixedShippingOptionEventDraft,
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  getProductShippingOptionAddress,
  getProductShippingOptionDTag,
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
      shippingOptionLaunchUnsupported: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
      canonicalShippingResolved: false,
      shippingOptionCreatedAt: undefined,
    }
  }

  return {
    ...input.product,
    shippingOptionId: getProductShippingOptionAddress(
      input.merchantPubkey,
      input.productDTag
    ),
    shippingOptionDTag: getProductShippingOptionDTag(input.productDTag),
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

export async function publishCanonicalProductEvents(
  input: {
    productEvent: NDKEvent
    shippingEvent: NDKEvent | null
    merchantPubkey: string
    onSignedLocal: (event: NDKEvent) => Promise<void>
  },
  dependencies: CanonicalProductPublishDependencies = canonicalProductPublishDependencies
): Promise<PublishWithPlannerResult> {
  if (input.shippingEvent) {
    const shippingResult = await dependencies.publishShippingEvent(
      input.shippingEvent,
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

  const shippingEvent =
    input.fulfillmentIntent.kind === "fixed_standard" ? new NDKEvent(ndk) : null
  if (shippingEvent && input.fulfillmentIntent.kind === "fixed_standard") {
    const shippingDraft = buildFixedShippingOptionEventDraft({
      productDTag: input.dTag,
      intent: input.fulfillmentIntent,
      clientAppId: "merchant",
    })
    shippingEvent.kind = shippingDraft.kind
    shippingEvent.created_at = eventCreatedAt
    shippingEvent.content = shippingDraft.content
    shippingEvent.tags = shippingDraft.tags
  }

  if (shippingEvent) await shippingEvent.sign(ndk.signer)
  await productEvent.sign(ndk.signer)

  return publishCanonicalProductEvents({
    productEvent,
    shippingEvent,
    merchantPubkey: signerPubkey,
    onSignedLocal: input.onSignedLocal,
  })
}
