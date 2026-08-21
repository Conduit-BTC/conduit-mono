export type ShopperPresetsRelayLifecycle = {
  identityPubkey: string | null
  relayScope: string | null
  relaySettingsReady: boolean
}

export function shopperPresetsQueryKey(
  identityPubkey: string | null,
  relayScope: string | null
) {
  return ["shopper-presets-envelope", identityPubkey, relayScope] as const
}

export function isCurrentShopperPresetsRelayLifecycle(
  current: Pick<ShopperPresetsRelayLifecycle, "identityPubkey" | "relayScope">,
  expected: Pick<ShopperPresetsRelayLifecycle, "identityPubkey" | "relayScope">
): boolean {
  return (
    current.identityPubkey === expected.identityPubkey &&
    current.relayScope === expected.relayScope
  )
}

export function shouldRefetchShopperPresetsAfterRelayActivation(
  previous: ShopperPresetsRelayLifecycle | null,
  current: ShopperPresetsRelayLifecycle,
  hasCachedData: boolean
): boolean {
  return (
    previous !== null &&
    hasCachedData &&
    isCurrentShopperPresetsRelayLifecycle(current, previous) &&
    !previous.relaySettingsReady &&
    current.relaySettingsReady
  )
}
