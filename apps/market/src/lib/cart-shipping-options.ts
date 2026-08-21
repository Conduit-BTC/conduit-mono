import {
  getShippingDestinationEligibility,
  type ParsedShippingOption,
  type ShippingDestinationEligibility,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

function isPhysicalItem(item: CartItem): boolean {
  return item.format !== "digital"
}

export function hasCartItemShippingSnapshot(item: CartItem): boolean {
  return (item.shippingCountryRules?.length ?? 0) > 0
}

export function getCartShippingOptionSnapshots(
  items: CartItem[]
): ParsedShippingOption[] {
  return items
    .filter(isPhysicalItem)
    .filter(hasCartItemShippingSnapshot)
    .map((item) => ({
      id:
        item.shippingOptionId ??
        `product:${item.merchantPubkey}:${item.productId}`,
      pubkey: item.merchantPubkey,
      dTag: item.shippingOptionDTag ?? item.productId,
      title: item.shippingOptionId
        ? "Product shipping zone"
        : "Product custom shipping zone",
      currency: item.sourceShippingCost?.normalizedCurrency ?? "SATS",
      price: item.sourceShippingCost?.amount ?? item.shippingCostSats ?? 0,
      countries:
        item.shippingCountries ??
        item.shippingCountryRules?.map((rule) => rule.code) ??
        [],
      countryRules: item.shippingCountryRules ?? [],
      service: "standard",
      createdAt: 0,
    }))
}

export function hasPhysicalItemsMissingShippingZone(
  items: CartItem[]
): boolean {
  return items
    .filter(isPhysicalItem)
    .some(
      (item) => !item.shippingOptionId && !hasCartItemShippingSnapshot(item)
    )
}

export function hasPhysicalItemsMissingShippingSnapshot(
  items: CartItem[]
): boolean {
  return items
    .filter(isPhysicalItem)
    .some((item) => !hasCartItemShippingSnapshot(item))
}

export function getCartShippingOptionsAvailable(
  items: CartItem[],
  merchantShippingOptions: ParsedShippingOption[]
): boolean {
  return items
    .filter(isPhysicalItem)
    .every(
      (item) =>
        hasCartItemShippingSnapshot(item) || merchantShippingOptions.length > 0
    )
}

export function getCartShippingDestinationEligibility(
  destination: { country: string; postalCode: string },
  items: CartItem[],
  merchantShippingOptions: ParsedShippingOption[]
): ShippingDestinationEligibility {
  const results = items.filter(isPhysicalItem).map((item) => {
    const itemOptions = hasCartItemShippingSnapshot(item)
      ? getCartShippingOptionSnapshots([item])
      : merchantShippingOptions
    return getShippingDestinationEligibility(destination, itemOptions)
  })

  if (results.length === 0) return { eligible: true }

  const countryUnsupported = results.find(
    (result) =>
      result.eligible === false && result.reason === "country_unsupported"
  )
  if (countryUnsupported) return countryUnsupported

  const postalRestricted = results.find(
    (result) =>
      result.eligible === false && result.reason === "postal_restricted"
  )
  if (postalRestricted) return postalRestricted

  if (results.some((result) => result.eligible === null)) {
    return { eligible: null, reason: "unknown" }
  }

  return { eligible: true }
}
