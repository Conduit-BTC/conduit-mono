import {
  compileProductFulfillmentIntent,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  getShippingOptionsByCoordinates,
  hasSamePickupFulfillmentGraph,
  resolveProductFulfillment,
  type OrderPickupFulfillmentSchema,
  type OrderSummary,
  type ParsedShippingOption,
  type ProductFulfillmentIntent,
  type ProductSchema,
} from "@conduit/core"

export function getOrderStockPickupFulfillment(input: {
  items: OrderSummary["items"]
  productAddressId: string
}): OrderPickupFulfillmentSchema | null {
  const matches = input.items.flatMap((item) => {
    const fulfillment = item.fulfillment
    return fulfillment?.type === "pickup" &&
      fulfillment.product.coordinate === input.productAddressId
      ? [fulfillment]
      : []
  })
  const first = matches[0]
  if (!first) return null
  return matches.every((candidate) =>
    hasSamePickupFulfillmentGraph(first, candidate)
  )
    ? first
    : null
}

function matchesVerifiedEventPickup(input: {
  product: ProductSchema
  productAddressId: string
  verifiedPickup: OrderPickupFulfillmentSchema
}): boolean {
  const fulfillmentCoordinates = new Set([
    input.verifiedPickup.collection.coordinate,
    input.verifiedPickup.option.coordinate,
  ])
  const shippingOptionId = input.product.shippingOptionId
  return (
    input.verifiedPickup.product.coordinate === input.productAddressId &&
    input.verifiedPickup.product.merchantPubkey.toLowerCase() ===
      input.product.pubkey.toLowerCase() &&
    input.product.collectionRefs?.includes(
      input.verifiedPickup.collection.coordinate
    ) === true &&
    !!shippingOptionId &&
    fulfillmentCoordinates.has(shippingOptionId) &&
    input.product.shippingOptionRefs?.some(
      (reference) => reference.coordinate === shippingOptionId
    ) === true
  )
}

export async function resolveStockUpdateFulfillmentIntent(
  input: {
    product: ProductSchema
    productAddressId: string
    orderHasPickupClaim?: boolean
    verifiedPickup?: OrderPickupFulfillmentSchema
  },
  dependencies: {
    getShippingOptions: (
      coordinates: string[]
    ) => Promise<ParsedShippingOption[]>
  } = { getShippingOptions: getShippingOptionsByCoordinates }
): Promise<ProductFulfillmentIntent> {
  const { product } = input
  if (product.format === "digital") return { kind: "digital" }

  if (input.orderHasPickupClaim && !input.verifiedPickup) {
    throw new Error(
      "This stock target does not match the order's event pickup evidence. Refresh the order and try again."
    )
  }

  if (input.verifiedPickup) {
    if (
      !matchesVerifiedEventPickup({
        ...input,
        verifiedPickup: input.verifiedPickup,
      })
    ) {
      throw new Error(
        "The current listing no longer matches this order's verified event pickup. Refresh the order before updating stock."
      )
    }
    return { kind: "coordinate_after_order" }
  }

  const legacyShippingAmount =
    product.sourceShippingCost?.amount ?? product.shippingCostSats
  if (
    typeof legacyShippingAmount === "number" &&
    (!product.shippingOptionId ||
      product.shippingOptionDTag === CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG)
  ) {
    const destinations = product.shippingCountryRules?.length
      ? product.shippingCountryRules
      : (product.shippingCountries ?? []).map((code) => ({
          code,
          name: code,
          restrictTo: [],
          exclude: [],
        }))
    return compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      amount: legacyShippingAmount,
      currency:
        product.sourceShippingCost?.normalizedCurrency ??
        product.sourceShippingCost?.currency ??
        "SATS",
      destinations,
    })
  }

  if (product.shippingOptionId) {
    const shippingOptions = await dependencies.getShippingOptions([
      product.shippingOptionId,
    ])
    const prepared = resolveProductFulfillment(product, shippingOptions)
    if (
      prepared.intent !== "fixed_standard" ||
      prepared.status !== "ready" ||
      !prepared.option
    ) {
      throw new Error(
        "Could not verify this listing's fixed shipping option. Review the listing before updating stock."
      )
    }
    return {
      kind: "fixed_standard",
      amount: prepared.option.price,
      currency: prepared.option.currency,
      countries: [...prepared.option.countries],
    }
  }

  return { kind: "coordinate_after_order" }
}
