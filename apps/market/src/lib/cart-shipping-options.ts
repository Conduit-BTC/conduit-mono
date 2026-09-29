import {
  canonicalizeShippingCost,
  quoteShippingPolicy,
  normalizeShippingPolicyRegion,
  shippingAmountToMinor,
  getShippingDestinationEligibility,
  resolveProductFulfillment,
  type ParsedShippingOption,
  type PricingRateInput,
  type PreparedProductFulfillment,
  type ShippingDestinationEligibility,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

function isPickupItem(item: CartItem): boolean {
  return (
    item.fulfillment?.type === "pickup" ||
    item.fulfillment?.type === "event_market_pickup"
  )
}

function isPhysicalItem(item: CartItem): boolean {
  return item.format !== "digital"
}

export function getCartShippingOptionCoordinates(items: CartItem[]): string[] {
  return Array.from(
    new Set(
      items
        .filter(isPhysicalItem)
        .filter((item) => !isPickupItem(item))
        .flatMap((item) =>
          item.shippingOptionId ? [item.shippingOptionId] : []
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
    shippingPolicyQuote: undefined,
    shippingAllocatedCostSats: undefined,
  }
}

export type PreparedCartFulfillment = {
  items: CartItem[]
  resolutions: Map<string, PreparedProductFulfillment>
}

export function prepareCartFulfillment(
  items: CartItem[],
  shippingOptions: readonly ParsedShippingOption[],
  destination?: { country: string; subdivision?: string; postalCode?: string },
  rateInput: PricingRateInput = null
): PreparedCartFulfillment {
  const resolutions = new Map<string, PreparedProductFulfillment>()
  const policyGroups = new Map<
    string,
    { option: ParsedShippingOption; items: CartItem[] }
  >()
  const preparedItems = items.map((item) => {
    if (item.fulfillment?.type === "pickup") return item
    if (item.fulfillment?.type === "event_market_pickup") {
      return clearPreparedShipping(item)
    }
    const policyOption =
      item.format !== "digital"
        ? shippingOptions.find(
            (option) =>
              option.id === item.shippingOptionId &&
              option.pubkey === item.merchantPubkey &&
              option.shippingPolicy &&
              option.signedEvent
          )
        : undefined
    if (policyOption) {
      const key = `${item.merchantPubkey}:${policyOption.id}:${policyOption.eventId}`
      const group = policyGroups.get(key) ?? { option: policyOption, items: [] }
      group.items.push(item)
      policyGroups.set(key, group)
      return clearPreparedShipping(item)
    }

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
        shippingOptionLaunchUnsupported: item.shippingOptionLaunchUnsupported,
        shippingCountries: item.shippingCountries,
        shippingCountryRules: item.shippingCountryRules,
        updatedAt: item.productUpdatedAt ?? 0,
      },
      shippingOptions
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

  if (destination) {
    for (const { option, items: groupItems } of policyGroups.values()) {
      if (groupItems.some((item) => !item.signedProductEvent)) continue
      const inputs = groupItems.map((item) => {
        const currency = item.sourcePrice?.normalizedCurrency ?? item.currency
        let subtotalMinor = -1
        try {
          subtotalMinor =
            shippingAmountToMinor(
              item.sourcePrice?.amount ?? item.price,
              currency
            ) * item.quantity
        } catch {
          // Invalid source precision requires coordination, never a zero charge.
        }
        return {
          productId: item.productId,
          productEventId: item.productEventId ?? "",
          productEvent: item.signedProductEvent!,
          productCreatedAt: Math.floor((item.productUpdatedAt ?? 0) / 1000),
          quantity: item.quantity,
          weightGrams: item.shippingWeightGrams,
          shippingWeightAllowanceGrams: item.shippingWeightAllowanceGrams,
          shippingHandling: item.shippingHandling,
          currency,
          subtotalMinor,
        }
      })
      const result = quoteShippingPolicy({
        policy: option.shippingPolicy!,
        policyEvent: option.signedEvent!,
        policyCoordinate: option.id,
        policyEventId: option.eventId,
        policyCreatedAt: Math.floor(option.createdAt / 1000),
        merchantPubkey: option.pubkey,
        items: inputs,
        destination,
        rateInput,
      })
      if (result.status !== "quoted") continue
      for (const item of preparedItems) {
        if (
          item.merchantPubkey === option.pubkey &&
          groupItems.some((entry) => entry.productId === item.productId)
        ) {
          item.shippingOptionId = option.id
          item.shippingOptionDTag = option.dTag
          item.shippingPolicyQuote = result.quote
          item.canonicalShippingResolved = true
        }
      }
    }
  }
  return { items: preparedItems, resolutions }
}

export function hasCartItemShippingSnapshot(item: CartItem): boolean {
  return (
    item.canonicalShippingResolved === true &&
    !!item.shippingOptionId &&
    (!!item.shippingPolicyQuote || (item.shippingCountryRules?.length ?? 0) > 0)
  )
}

export function getCartShippingOptionSnapshots(
  items: CartItem[]
): ParsedShippingOption[] {
  return items
    .filter(isPhysicalItem)
    .filter((item) => !isPickupItem(item))
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
  return items
    .filter(isPhysicalItem)
    .filter((item) => !isPickupItem(item))
    .some((item) => {
      return !hasCartItemShippingSnapshot(item)
    })
}

export function hasPhysicalItemsMissingShippingSnapshot(
  items: CartItem[]
): boolean {
  return hasPhysicalItemsMissingShippingZone(items)
}

export function getCartShippingOptionsAvailable(items: CartItem[]): boolean {
  return items
    .filter(isPhysicalItem)
    .every((item) => isPickupItem(item) || hasCartItemShippingSnapshot(item))
}

export function getCartShippingDestinationEligibility(
  destination: { country: string; subdivision?: string; postalCode: string },
  items: CartItem[]
): ShippingDestinationEligibility {
  const results = items
    .filter(isPhysicalItem)
    .filter((item) => !isPickupItem(item))
    .map((item) => {
      if (item.shippingPolicyQuote) {
        const quoted = item.shippingPolicyQuote.destination
        const country = destination.country.trim().toUpperCase()
        let subdivision = normalizeShippingPolicyRegion(
          destination.subdivision ?? ""
        )
        if (subdivision && !subdivision.startsWith(country))
          subdivision = `${country}${subdivision}`
        return quoted.country === country &&
          (quoted.postalCode ?? "") ===
            normalizeShippingPolicyRegion(destination.postalCode) &&
          (quoted.subdivision ?? "") === subdivision
          ? ({ eligible: true } as const)
          : ({ eligible: null, reason: "unknown" } as const)
      }
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
