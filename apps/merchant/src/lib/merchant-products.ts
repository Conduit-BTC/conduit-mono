import {
  applyPreparedProductFulfillment,
  evaluateListingAvailability,
  getMerchantStorefront,
  getShippingOptionsByCoordinatesDetailed,
  resolveProductFulfillment,
  type CommerceResult,
  type ListingAvailabilityEvaluation,
  type ProductSchema,
  type ShippingOptionsDetailedResult,
  type ShippingOptionReadOptions,
} from "@conduit/core"

export type MerchantProduct = {
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
  sourceRelayUrls: string[]
  product: ProductSchema
  availability: ListingAvailabilityEvaluation
}

export async function fetchMerchantProducts(
  merchantPubkey: string,
  options: ShippingOptionReadOptions
): Promise<
  CommerceResult<MerchantProduct[]> & {
    shippingRead: ShippingOptionsDetailedResult
  }
> {
  const { accountPubkey, authenticatedPubkey, shouldContinue, signal } = options
  const isActive = () => !signal?.aborted && shouldContinue?.() !== false
  const checkActive = () => {
    signal?.throwIfAborted()
    if (!isActive()) throw new Error("Product read was cancelled.")
  }
  checkActive()
  const result = await getMerchantStorefront({
    merchantPubkey,
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: isActive,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  checkActive()
  // This is editor preparation, not a prerequisite for generic catalog reads.
  // Keep the detailed evidence alongside the projection so omission/outage is
  // never confused with signed withdrawal or unsupported terms.
  const shippingRead = await getShippingOptionsByCoordinatesDetailed(
    result.data.flatMap(({ product }) =>
      product.shippingOptionId ? [product.shippingOptionId] : []
    ),
    { ...options, shouldContinue: isActive }
  )
  checkActive()
  return {
    data: result.data.map((record) => {
      const fulfillment = resolveProductFulfillment(
        record.product,
        shippingRead.options
      )
      const product =
        fulfillment.status === "ready" && fulfillment.option
          ? applyPreparedProductFulfillment(record.product, fulfillment)
          : record.product.shippingOptionId
            ? { ...record.product, canonicalShippingResolved: false }
            : record.product
      return {
        eventId: record.eventId,
        addressId: record.addressId,
        dTag: record.dTag,
        eventCreatedAt: record.eventCreatedAt,
        sourceRelayUrls: record.sourceRelayUrls ?? [],
        product,
        availability:
          record.availability ?? evaluateListingAvailability(product),
      }
    }),
    meta: result.meta,
    shippingRead,
  }
}
