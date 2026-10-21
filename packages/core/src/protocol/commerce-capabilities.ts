import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/** Explicit extension support, not a client-brand or relay inference. */
export const COMMERCE_CAPABILITIES_TAG = "conduit_commerce"
export const COMMERCE_SUPPORT_TAG = "conduit_commerce_support"
export const COMMERCE_FEATURES = [
  "per_item_shipping",
  "event_pickup",
  "router_checkout",
] as const
export type CommerceFeature = (typeof COMMERCE_FEATURES)[number]

export function requiredCommerceFeatures(
  order: {
    items: readonly {
      shippingOptionId?: string
      fulfillment?: { type: string }
    }[]
  },
  tags: readonly string[][] = []
): CommerceFeature[] {
  return [
    ...(new Set(
      order.items.flatMap((item) =>
        item.shippingOptionId ? [item.shippingOptionId] : []
      )
    ).size > 1
      ? ["per_item_shipping" as const]
      : []),
    ...(order.items.some(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
      ? ["event_pickup" as const]
      : []),
    ...(tags.some((tag) => tag[0] === "conduit_checkout_payment")
      ? ["router_checkout" as const]
      : []),
  ]
}

function supports(
  event: SignedPublicNostrEvent,
  productId: string,
  features: readonly CommerceFeature[]
): boolean {
  if (!isValidSignedPublicNostrEvent(event) || event.kind !== 30402)
    return false
  const d = event.tags.filter((tag) => tag[0] === "d")
  const declarations = event.tags.filter(
    (tag) => tag[0] === COMMERCE_CAPABILITIES_TAG
  )
  const declaration = declarations[0]
  return (
    d.length === 1 &&
    d[0]?.length === 2 &&
    productId === `30402:${event.pubkey}:${d[0]?.[1]}` &&
    declarations.length === 1 &&
    declaration?.[1] === "2" &&
    features.every((feature) => declaration.includes(feature))
  )
}

const unsupported = () =>
  new Error(
    "This seller’s current listings do not declare support for these delivery or payment terms. Ask the seller to update the listings, then refresh checkout."
  )

/** Use the exact freshly authorized listing revisions, never display cache fields. */
export function buildCommerceSupportTags(input: {
  productIds: readonly string[]
  products: readonly { id: string; signedProductEvent?: unknown }[]
  features: readonly CommerceFeature[]
}): string[][] {
  if (!input.features.length) return []
  const events = [...new Set(input.productIds)].map((id) => {
    const event = input.products.find(
      (product) => product.id === id
    )?.signedProductEvent
    if (
      !event ||
      !supports(event as SignedPublicNostrEvent, id, input.features)
    )
      throw unsupported()
    return event
  })
  return [[COMMERCE_SUPPORT_TAG, "2", JSON.stringify(events)]]
}

/** The declaration only selects supported semantics; it grants no payment/stock authority. */
export function assertCommerceSupport(
  order: {
    merchantPubkey: string
    items: readonly {
      productId: string
      shippingOptionId?: string
      fulfillment?: { type: string }
    }[]
  },
  tags: readonly string[][]
): void {
  const features = requiredCommerceFeatures(order, tags)
  if (!features.length) return
  const support = tags.filter((tag) => tag[0] === COMMERCE_SUPPORT_TAG)
  if (
    support.length !== 1 ||
    support[0]?.length !== 3 ||
    support[0]?.[1] !== "2"
  )
    throw unsupported()
  const events: unknown = JSON.parse(support[0]![2]!)
  if (
    !Array.isArray(events) ||
    events.length > 128 ||
    events.length !== new Set(order.items.map((item) => item.productId)).size
  )
    throw unsupported()
  for (const item of order.items) {
    if (
      !item.productId.startsWith(`30402:${order.merchantPubkey}:`) ||
      !events.some((event) => supports(event, item.productId, features))
    )
      throw unsupported()
  }
}

export function buildCommerceSupportTagsFromEvents(
  productIds: readonly string[],
  features: readonly CommerceFeature[],
  events: readonly SignedPublicNostrEvent[]
): string[][] {
  return buildCommerceSupportTags({
    productIds,
    features,
    products: events
      .filter((event) => event.kind === 30402)
      .map((event) => ({
        id: `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`,
        signedProductEvent: event,
      })),
  })
}
