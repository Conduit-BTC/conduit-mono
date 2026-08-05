import { useCallback } from "react"
import {
  getShopperPriceDisplay,
  getShopperSatsDisplay,
  type CommercePriceLike,
  type ShopperPriceDisplayOptions,
} from "@conduit/core"
import { useBtcUsdRate } from "./useBtcUsdRate"
import { useShopperPricePreference } from "./useShopperPricePreference"

export function useShopperPricing() {
  const rateQuery = useBtcUsdRate()
  const pricePreference = useShopperPricePreference()
  const quote = rateQuery.data ?? null
  const { preference } = pricePreference

  const formatPrice = useCallback(
    (price: CommercePriceLike, options?: ShopperPriceDisplayOptions) =>
      getShopperPriceDisplay(price, preference, quote, options),
    [preference, quote]
  )
  const formatSatsAmount = useCallback(
    (sats: number) => getShopperSatsDisplay(sats, preference, quote),
    [preference, quote]
  )

  return {
    ...pricePreference,
    rateQuery,
    quote,
    formatPrice,
    formatSatsAmount,
  }
}
