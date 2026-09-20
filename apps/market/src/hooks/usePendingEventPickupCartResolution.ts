import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { useAuth, useConduitSession } from "@conduit/core"
import { useCart } from "./useCart"
import { useShopperPricing } from "./useShopperPricing"
import { getPendingEventPickupCartItems } from "../lib/cart-model"
import { resolvePendingEventPickupCartUpgrades } from "../lib/pending-event-pickup-cart"

/**
 * One app-level owner upgrades reversible event-pickup intent to an exact
 * immutable fulfillment snapshot. Failure leaves the intent non-purchasable.
 */
export function usePendingEventPickupCartResolution() {
  const { items, upgradePendingEventPickupItem } = useCart()
  const pricing = useShopperPricing()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const pendingItems = useMemo(
    () => getPendingEventPickupCartItems(items),
    [items]
  )
  const pendingIdentity = useMemo(
    () =>
      pendingItems.map((item) => [
        item.cartLineId ?? null,
        item.productId,
        item.productUpdatedAt ?? null,
        item.productEventId ?? null,
        item.fulfillment.collectionCoordinate,
      ]),
    [pendingItems]
  )
  const readAuthGeneration = authGeneration
  const query = useQuery({
    queryKey: [
      "pending-event-pickup-cart",
      session.relayScope ?? "no-relay-scope",
      authenticatedPubkey,
      authGeneration,
      pendingIdentity,
      pricing.quote,
    ],
    queryFn: ({ signal }) =>
      resolvePendingEventPickupCartUpgrades(pendingItems, pricing.quote, {
        authenticatedPubkey,
        shouldContinue: () => authGenerationRef.current === readAuthGeneration,
        signal,
      }),
    enabled: session.relaySettingsReady && pendingItems.length > 0,
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    retry: 1,
  })

  useEffect(() => {
    if (!query.data) return
    for (const upgrade of query.data) {
      void upgradePendingEventPickupItem(upgrade.identity, upgrade.item)
    }
  }, [query.data, upgradePendingEventPickupItem])

  return {
    pendingItems,
    isChecking: query.isLoading || query.isFetching,
    retry: query.refetch,
  }
}
