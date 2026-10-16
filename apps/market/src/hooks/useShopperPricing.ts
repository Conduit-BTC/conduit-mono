import { useCallback } from "react"
import {
  getShopperPriceDisplay,
  getShopperSatsDisplay,
  type CommercePriceLike,
  type ShopperPriceDisplayOptions,
} from "@conduit/core"
import { useBtcUsdRate } from "./useBtcUsdRate"
import { useShopperPricePreference } from "./useShopperPricePreference"
import {
  coordinationPricingEnabled,
  getFeeInclusiveListingPriceDisplay,
} from "../lib/checkout-coordination-pricing"

export function useShopperPricing() {
  const rateQuery = useBtcUsdRate()
  const {
    preference,
    setCurrency,
    setSatsStandard,
    updateExistingDevicePriceOverrideAfterPresetSave,
  } = useShopperPricePreference()
  const quote = rateQuery.data ?? null

  const formatPrice = useCallback(
    (price: CommercePriceLike, options?: ShopperPriceDisplayOptions) =>
      getShopperPriceDisplay(price, preference, quote, options),
    [preference, quote]
  )
  const formatSatsAmount = useCallback(
    (sats: number) => getShopperSatsDisplay(sats, preference, quote),
    [preference, quote]
  )
  const formatListingPrice = useCallback(
    (price: CommercePriceLike, options?: ShopperPriceDisplayOptions) =>
      getFeeInclusiveListingPriceDisplay(
        price,
        preference,
        quote,
        coordinationPricingEnabled(),
        options
      ),
    [preference, quote]
  )

  return {
    preference,
    rateQuery,
    quote,
    formatPrice,
    formatListingPrice,
    formatSatsAmount,
    setCurrency,
    setSatsStandard,
    updateExistingDevicePriceOverrideAfterPresetSave,
  }
}
