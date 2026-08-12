import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildProductDeletionEventDraft,
  buildProductListingEventDraft,
  cacheSignedProductDeletionEvent,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  isValidSignedPublicNostrEvent,
  publishWithPlanner,
  requireNdkConnected,
  RelayPublishDiagnosticsError,
  type ProductSchema,
  type ProductDeletionEventTarget,
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
  const attemptedRelayUrls = mergeRelayUrls(
    ...deliveries.map((delivery) => delivery.attemptedRelayUrls)
  )
  const successfulRelayUrls = attemptedRelayUrls.filter((url) =>
    deliveries.every((delivery) => delivery.successfulRelayUrls.includes(url))
  )
  const successfulRelaySet = new Set(successfulRelayUrls)
  const failedRelayUrls = attemptedRelayUrls.filter(
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
}

export async function signAndPublishProductWriteBundle(input: {
  merchantPubkey: string
  listings: readonly ProductListingPublishTarget[]
  deletions?: readonly ProductDeletionEventTarget[]
  onSignedLocal: (events: readonly NDKEvent[]) => Promise<void>
}): Promise<PublishWithPlannerResult> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = (await ndk.signer.user()).pubkey
  if (signerPubkey !== input.merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }
  if (input.listings.length === 0 && (input.deletions?.length ?? 0) === 0) {
    throw new Error("No product changes require signing")
  }

  const now = Date.now()
  const signedEvents: NDKEvent[] = []
  for (const listing of input.listings) {
    if (listing.product.pubkey !== signerPubkey) {
      throw new Error("Product pubkey does not match current merchant pubkey")
    }

    const event = new NDKEvent(ndk)
    const draft = buildProductListingEventDraft({
      product: listing.product,
      dTag: listing.dTag,
      clientAppId: "merchant",
    })
    event.kind = draft.kind
    event.created_at = Math.max(
      Math.floor(now / 1000),
      (listing.previousEventCreatedAt ?? -1) + 1
    )
    event.content = draft.content
    event.tags = draft.tags
    await event.sign(ndk.signer)
    signedEvents.push(event)
  }

  if ((input.deletions?.length ?? 0) > 0) {
    const deletion = new NDKEvent(ndk)
    const draft = buildProductDeletionEventDraft({
      merchantPubkey: signerPubkey,
      targets: input.deletions ?? [],
      clientAppId: "merchant",
    })
    deletion.kind = draft.kind
    deletion.created_at = Math.floor(now / 1000)
    deletion.content = draft.content
    deletion.tags = draft.tags
    await deletion.sign(ndk.signer)
    signedEvents.push(deletion)
  }

  for (const event of signedEvents) {
    if (event.kind === EVENT_KINDS.DELETION) {
      await cacheSignedProductDeletionEvent(event)
    } else {
      await cacheSignedProductListingEvent(event)
    }
  }

  try {
    await input.onSignedLocal(signedEvents)
    return await deliverSignedProductEventBundle(signedEvents, signerPubkey)
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}

export async function signAndPublishProductListing(input: {
  merchantPubkey: string
  product: ProductSchema
  dTag: string
  previousEventCreatedAt?: number
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
  const event = new NDKEvent(ndk)
  const draft = buildProductListingEventDraft({
    product: input.product,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  event.kind = draft.kind
  event.created_at = Math.max(
    Math.floor(now / 1000),
    (input.previousEventCreatedAt ?? -1) + 1
  )
  event.content = draft.content
  event.tags = draft.tags

  await event.sign(ndk.signer)
  await cacheSignedProductListingEvent(event)
  try {
    await input.onSignedLocal(event)
    return await deliverSignedProductEvent(event, signerPubkey)
  } catch (error) {
    throw asSignedProductDeliveryError(error)
  }
}
