import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { getFollowPubkeys } from "@conduit/core"
import {
  DEFAULT_MARKET_PERSPECTIVE_NPUB,
  DEFAULT_MARKET_PERSPECTIVE_PUBKEY,
  getDefaultMarketPerspectiveFollowPubkeys,
  storeDefaultMarketPerspectiveFollowPubkeys,
} from "../lib/defaultMarketPerspective"

export interface GuestMarketDiscovery {
  usesGuestMarket: boolean
  perspectivePubkey: string | null
  seedAuthorPubkeys?: string[]
}

export function useGuestMarketDiscovery(input: {
  enabled: boolean
}): GuestMarketDiscovery {
  const [guestFollowPubkeys, setGuestFollowPubkeys] = useState(
    getDefaultMarketPerspectiveFollowPubkeys
  )

  const followRefreshQuery = useQuery({
    queryKey: ["default-market-perspective-follow-refresh"],
    queryFn: () =>
      getFollowPubkeys({ pubkey: DEFAULT_MARKET_PERSPECTIVE_PUBKEY }),
    enabled: input.enabled,
    staleTime: 6 * 60 * 60_000,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    const pubkeys = followRefreshQuery.data?.data
    if (!pubkeys || pubkeys.length === 0) return
    storeDefaultMarketPerspectiveFollowPubkeys(pubkeys)
    setGuestFollowPubkeys(pubkeys)
  }, [followRefreshQuery.data?.data])

  return {
    usesGuestMarket: input.enabled,
    perspectivePubkey: input.enabled ? DEFAULT_MARKET_PERSPECTIVE_NPUB : null,
    seedAuthorPubkeys: input.enabled ? guestFollowPubkeys : undefined,
  }
}
