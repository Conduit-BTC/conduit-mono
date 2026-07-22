import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildProductListingEventDraft,
  cacheSignedProductListingEvent,
  EVENT_KINDS,
  isValidSignedPublicNostrEvent,
  publishWithPlanner,
  requireNdkConnected,
  RelayPublishDiagnosticsError,
  type ProductSchema,
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
