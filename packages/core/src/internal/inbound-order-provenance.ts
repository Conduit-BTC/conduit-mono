import type { NDKEvent, NDKSigner, giftUnwrap } from "@nostr-dev-kit/ndk"
import {
  parseOrderMessageRumorEvent,
  type ParsedOrderMessage,
} from "../protocol/orders"
import {
  hasProtectedReadAuthority,
  type ProtectedReadAuthorization,
} from "../protocol/protected-read-authorization"
import type { ValidatedInboundOrderLifecycleAnchor } from "../protocol/inbound-order-provenance"

type ParsedInboundOrder = Extract<ParsedOrderMessage, { type: "order" }>

const anchorsByOrder = new WeakMap<
  ParsedInboundOrder,
  {
    anchor: ValidatedInboundOrderLifecycleAnchor
    authorization: ProtectedReadAuthorization | null
  }
>()
const authorizationsByAnchor = new WeakMap<
  ValidatedInboundOrderLifecycleAnchor,
  ProtectedReadAuthorization | null
>()
type GiftUnwrapOverride = (
  event: NDKEvent,
  signer: NDKSigner
) => Promise<Awaited<ReturnType<typeof giftUnwrap>> | null>
const authenticatedGiftUnwrapTestOverrides = new WeakSet<GiftUnwrapOverride>()

/** Internal test seam; unavailable through the package export map. */
export function authorizeGiftUnwrapTestOverride<T extends GiftUnwrapOverride>(
  unwrap: T
): T {
  authenticatedGiftUnwrapTestOverrides.add(unwrap)
  return unwrap
}

export function isAuthorizedGiftUnwrapTestOverride(
  unwrap: GiftUnwrapOverride
): boolean {
  return authenticatedGiftUnwrapTestOverrides.has(unwrap)
}

function bindInboundOrderProvenance(
  order: ParsedInboundOrder,
  authorization: ProtectedReadAuthorization | null
): ParsedInboundOrder {
  const orderId = order.orderId.trim()
  const buyerPubkey = order.senderPubkey.trim().toLowerCase()
  const merchantPubkey = order.recipientPubkey.trim().toLowerCase()
  if (
    !order.id ||
    !orderId ||
    !buyerPubkey ||
    !merchantPubkey ||
    buyerPubkey === merchantPubkey ||
    order.payload.id !== orderId ||
    order.payload.buyerPubkey.trim().toLowerCase() !== buyerPubkey ||
    order.payload.merchantPubkey.trim().toLowerCase() !== merchantPubkey
  ) {
    throw new Error("Inbound order provenance does not match its envelope.")
  }

  const anchor = Object.freeze({
    eventId: order.id,
    orderId,
    buyerPubkey,
    merchantPubkey,
  })
  anchorsByOrder.set(order, { anchor, authorization })
  authorizationsByAnchor.set(anchor, authorization)
  return order
}

/** Package-internal minting boundary. Call only after authenticated unwrap. */
export function parseAuthenticatedInboundOrderRumor(
  rumor: NDKEvent,
  authorization: ProtectedReadAuthorization | null
): ParsedOrderMessage {
  const message = parseOrderMessageRumorEvent(rumor)
  return message.type === "order"
    ? bindInboundOrderProvenance(message, authorization)
    : message
}

export function getValidatedInboundOrderLifecycleAnchor(input: {
  order: ParsedInboundOrder
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
}): ValidatedInboundOrderLifecycleAnchor {
  const binding = anchorsByOrder.get(input.order)
  const anchor = binding?.anchor
  if (
    !anchor ||
    (binding.authorization !== null &&
      !hasProtectedReadAuthority(binding.authorization)) ||
    anchor.orderId !== input.orderId.trim() ||
    anchor.buyerPubkey !== input.buyerPubkey.trim().toLowerCase() ||
    anchor.merchantPubkey !== input.merchantPubkey.trim().toLowerCase()
  ) {
    throw new Error(
      "Cannot authorize a self-record without a validated inbound order."
    )
  }
  return anchor
}

export function hasValidatedInboundOrderLifecycleAnchor(
  order: ParsedInboundOrder
): boolean {
  const binding = anchorsByOrder.get(order)
  return (
    !!binding &&
    (binding.authorization === null ||
      hasProtectedReadAuthority(binding.authorization))
  )
}

export function isValidatedInboundOrderLifecycleAnchor(
  anchor: ValidatedInboundOrderLifecycleAnchor
): boolean {
  const authorization = authorizationsByAnchor.get(anchor)
  return (
    authorization !== undefined &&
    (authorization === null || hasProtectedReadAuthority(authorization))
  )
}
