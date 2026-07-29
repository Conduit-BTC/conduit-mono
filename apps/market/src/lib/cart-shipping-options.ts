import {
  canonicalizeShippingCost,
  getShippingDestinationEligibility,
  resolveProductFulfillment,
  type ParsedShippingOption,
  type PreparedProductFulfillment,
  type ShippingDestinationEligibility,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

function isPhysicalItem(item: CartItem): boolean {
  return item.format !== "digital"
}

export function getCartShippingOptionCoordinates(items: CartItem[]): string[] {
  return Array.from(
    new Set(
      items
        .filter(isPhysicalItem)
        .flatMap((item) =>
          item.shippingOptionIds?.length
            ? item.shippingOptionIds
            : item.shippingOptionId
              ? [item.shippingOptionId]
              : []
        )
    )
  ).sort()
}

function clearPreparedShipping(item: CartItem): CartItem {
  return {
    ...item,
    shippingCostSats: undefined,
    sourceShippingCost: undefined,
    shippingOptionId: undefined,
    shippingOptionDTag: undefined,
    shippingOptionLaunchUnsupported: undefined,
    shippingCountries: undefined,
    shippingCountryRules: undefined,
    canonicalShippingResolved: false,
  }
}

export type PreparedCartFulfillment = {
  items: CartItem[]
  resolutions: Map<string, PreparedProductFulfillment>
}

export function prepareCartFulfillment(
  items: CartItem[],
  shippingOptions: readonly ParsedShippingOption[],
  destination?: { country: string; postalCode: string }
): PreparedCartFulfillment {
  const resolutions = new Map<string, PreparedProductFulfillment>()
  const preparedItems = items.map((item) => {
    const resolution = resolveProductFulfillment(
      {
        id: item.productId,
        pubkey: item.merchantPubkey,
        format: item.format ?? "physical",
        currency: item.currency,
        sourcePrice: item.sourcePrice,
        shippingCostSats: item.shippingCostSats,
        sourceShippingCost: item.sourceShippingCost,
        shippingOptionId: item.shippingOptionId,
        shippingOptionDTag: item.shippingOptionDTag,
        shippingOptionIds: item.shippingOptionIds,
        shippingOptionDTags: item.shippingOptionDTags,
        shippingOptionLaunchUnsupported: item.shippingOptionLaunchUnsupported,
        shippingCountries: item.shippingCountries,
        shippingCountryRules: item.shippingCountryRules,
        updatedAt: item.productUpdatedAt ?? 0,
      },
      shippingOptions,
      destination
    )
    resolutions.set(item.productId, resolution)

    if (resolution.intent === "digital") {
      return { ...clearPreparedShipping(item), format: "digital" as const }
    }
    if (
      resolution.intent !== "fixed_standard" ||
      resolution.status !== "ready" ||
      !resolution.option
    ) {
      return clearPreparedShipping(item)
    }

    const option = resolution.option
    return {
      ...clearPreparedShipping(item),
      ...canonicalizeShippingCost(option.price, option.currency),
      shippingOptionId: option.id,
      shippingOptionDTag: option.dTag,
      shippingCountries: [...option.countries],
      shippingCountryRules: option.countryRules.map((rule) => ({
        ...rule,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
      })),
      canonicalShippingResolved: true,
    }
  })

  return { items: preparedItems, resolutions }
}

export function hasCartItemShippingSnapshot(item: CartItem): boolean {
  return (
    item.canonicalShippingResolved === true &&
    !!item.shippingOptionId &&
    (item.shippingCountryRules?.length ?? 0) > 0
  )
}

export function getCartShippingOptionSnapshots(
  items: CartItem[]
): ParsedShippingOption[] {
  return items
    .filter(isPhysicalItem)
    .filter(hasCartItemShippingSnapshot)
    .map((item) => ({
      eventId: item.shippingOptionId!,
      id: item.shippingOptionId!,
      pubkey: item.merchantPubkey,
      dTag: item.shippingOptionDTag ?? item.productId,
      title: "Standard Shipping",
      currency: item.sourceShippingCost?.normalizedCurrency ?? "SATS",
      price: item.sourceShippingCost?.amount ?? item.shippingCostSats ?? 0,
      countries:
        item.shippingCountries ??
        item.shippingCountryRules?.map((rule) => rule.code) ??
        [],
      countryRules: item.shippingCountryRules ?? [],
      service: "standard",
      createdAt: 0,
      launchUnsupportedTags: [],
    }))
}

export function hasPhysicalItemsMissingShippingZone(
  items: CartItem[]
): boolean {
  return items.filter(isPhysicalItem).some((item) => {
    return !hasCartItemShippingSnapshot(item)
  })
}

export function hasPhysicalItemsMissingShippingSnapshot(
  items: CartItem[]
): boolean {
  return hasPhysicalItemsMissingShippingZone(items)
}

export function getCartShippingOptionsAvailable(items: CartItem[]): boolean {
  return items.filter(isPhysicalItem).every(hasCartItemShippingSnapshot)
}

export function getCartShippingDestinationEligibility(
  destination: { country: string; postalCode: string },
  items: CartItem[]
): ShippingDestinationEligibility {
  const results = items.filter(isPhysicalItem).map((item) => {
    const itemOptions = getCartShippingOptionSnapshots([item])
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
