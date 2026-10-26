import { useShoppingSettings } from "@conduit/core"

export function useShopperPricePreference() {
  return { preference: useShoppingSettings().preset.display }
}
