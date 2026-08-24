import type { ShopperPresetsValue } from "@conduit/core"
import type { ShopperPresetsUnlockState } from "../hooks/useShopperPresets"

type ShopperPresetsUiState = {
  hasRemotePreset: boolean
  unlockState: ShopperPresetsUnlockState
  preset: ShopperPresetsValue
}

export function isClearedRemoteShopperPreset({
  hasRemotePreset,
  unlockState,
  preset,
}: ShopperPresetsUiState): boolean {
  return hasRemotePreset && unlockState === "unlocked" && !preset.shipping
}
