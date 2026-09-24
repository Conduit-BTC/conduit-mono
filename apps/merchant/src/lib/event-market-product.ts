import {
  parseAddressableCoordinate,
  type ParsedEventMarketRoster,
  type ProductSchema,
} from "@conduit/core"

/** Merchant-owned product association. The organizer row supplies event handoff terms. */
export function setEventMarketProductAssociation(input: {
  product: ProductSchema
  market: ParsedEventMarketRoster
  enabled: boolean
}): ProductSchema {
  const product = parseAddressableCoordinate(input.product.id, [30402])
  if (
    !product ||
    product.authorPubkey !== input.product.pubkey ||
    input.product.format !== "physical"
  ) {
    throw new Error("A merchant-owned physical product is required.")
  }
  if (input.enabled) {
    if (input.market.state !== "open") {
      throw new Error("The Event Market is closed.")
    }
    if (
      !input.market.merchants.some(
        (merchant) => merchant.pubkey === product.authorPubkey
      )
    ) {
      throw new Error("This merchant is not approved for the Event Market.")
    }
  }
  const refs = new Set(input.product.eventMarketRefs ?? [])
  if (input.enabled) refs.add(input.market.coordinate)
  else refs.delete(input.market.coordinate)
  return {
    ...input.product,
    eventMarketRefs: [...refs],
  }
}
