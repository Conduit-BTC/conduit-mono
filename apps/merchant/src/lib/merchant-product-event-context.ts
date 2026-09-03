import {
  encodeEventMarketNaddr,
  getProductEventMarketFulfillmentClaims,
  type ProductSchema,
} from "@conduit/core"

type EventContextProduct = Pick<
  ProductSchema,
  | "pubkey"
  | "format"
  | "visibility"
  | "collectionRefs"
  | "shippingOptionRefs"
  | "shippingOptionId"
>

export interface MerchantProductEventContext {
  collectionCoordinate: string
  naddr: string
  referenceLabel: string
}

function shortenReference(reference: string): string {
  if (reference.length <= 28) return reference
  return `${reference.slice(0, 16)}…${reference.slice(-8)}`
}

/**
 * Recognize only the exact hidden fulfillment shape emitted for event-led
 * products. Generic hidden listings keep their safety-recovery UI, and
 * ambiguous multi-event references are not presented as a manageable event
 * product until their signed intent is unambiguous.
 */
export function getMerchantProductEventContext(
  product: EventContextProduct
): MerchantProductEventContext | null {
  if (product.visibility === "public") return null

  const claims = getProductEventMarketFulfillmentClaims(product)
  if (claims.length !== 1) return null

  const collectionCoordinate = claims[0]!.collectionCoordinate
  try {
    return {
      collectionCoordinate,
      naddr: encodeEventMarketNaddr(collectionCoordinate),
      referenceLabel: shortenReference(collectionCoordinate),
    }
  } catch {
    return null
  }
}
