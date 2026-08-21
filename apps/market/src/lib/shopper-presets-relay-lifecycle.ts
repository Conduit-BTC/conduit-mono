import type {
  ShopperPresetsReadResult,
  ShopperPresetsRevision,
} from "@conduit/core"

export type ShopperPresetsRelayLifecycle = {
  identityPubkey: string | null
  relayScope: string | null
  relaySettingsReady: boolean
}

export function shouldApplyShopperPresetsReadResult(
  result: ShopperPresetsReadResult,
  acceptedRevision: ShopperPresetsRevision | null
): boolean {
  if (!acceptedRevision) return true
  if (result.state !== "found") return false
  if (result.revision.createdAt !== acceptedRevision.createdAt) {
    return result.revision.createdAt > acceptedRevision.createdAt
  }
  return result.revision.eventId < acceptedRevision.eventId
}

export function isCurrentShopperPresetsRevision(
  current: ShopperPresetsRevision | null,
  expected: ShopperPresetsRevision
): boolean {
  return (
    current?.createdAt === expected.createdAt &&
    current.eventId === expected.eventId
  )
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
