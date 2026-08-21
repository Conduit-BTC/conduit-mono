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
  const { preference, setCurrency, setSatsStandard } =
    useShopperPricePreference()
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

  return {
    preference,
    rateQuery,
    quote,
    formatPrice,
    formatSatsAmount,
    setCurrency,
    setSatsStandard,
  }
}
