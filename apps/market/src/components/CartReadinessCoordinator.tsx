import { useMemo } from "react"
import { useProfiles } from "@conduit/core"
import { useCart } from "../hooks/useCart"
import {
  useCartLnurlPreflights,
  useCartReadiness,
} from "../hooks/useCartReadiness"
import { groupCartItems } from "../lib/cart-model"

/**
 * Root-level cart readiness coordinator.
 *
 * Owns background preparation for every merchant currently in the cart:
 * one availability read per merchant (keyed by merchant plus sorted product
 * coordinates) and one LNURL-pay metadata preflight per merchant Lightning
 * address. The HUD, `/cart`, and `/checkout` are consumers of this prepared
 * state through the same query keys, so route handoff inside the freshness
 * lease starts no new blocking reads.
 */
export function CartReadinessCoordinator() {
  const cart = useCart()
  useCartReadiness(cart.items)

  const merchantPubkeys = useMemo(
    () => groupCartItems(cart.items).map((group) => group.merchantPubkey),
    [cart.items]
  )
  const profiles = useProfiles(merchantPubkeys, {
    priority: "visible",
    maxUnresolvedRefetches: 2,
  })
  const lud16ByMerchant = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const merchantPubkey of merchantPubkeys) {
      map.set(merchantPubkey, profiles.data[merchantPubkey]?.lud16)
    }
    return map
  }, [merchantPubkeys, profiles.data])
  useCartLnurlPreflights(lud16ByMerchant)

  return null
}
