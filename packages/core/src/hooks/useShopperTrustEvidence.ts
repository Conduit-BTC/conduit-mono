import { useEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getShopperTrustEvidence,
  type ShopperTrustEvidence,
} from "../protocol/shopper-trust"
import { subscribeRelaySettingsChanges } from "../protocol/relay-settings"

export interface UseShopperTrustEvidenceOptions {
  enabled?: boolean
  relayScope?: string | null
}

export interface UseShopperTrustEvidenceResult {
  data: ShopperTrustEvidence | undefined
  evidence: ShopperTrustEvidence | undefined
  isLoading: boolean
  isHydrating: boolean
  error: unknown
  refetch: () => void
}

export function useShopperTrustEvidence(
  pair: {
    merchantPubkey: string
    shopperPubkey: string
  } | null,
  options: UseShopperTrustEvidenceOptions = {}
): UseShopperTrustEvidenceResult {
  const queryClient = useQueryClient()
  const forceRefreshRef = useRef(false)
  const merchantPubkey = pair?.merchantPubkey.trim().toLowerCase() ?? ""
  const shopperPubkey = pair?.shopperPubkey.trim().toLowerCase() ?? ""
  const relayScope = options.relayScope?.trim() || "none"
  const queryKey = useMemo(
    () =>
      [
        "shopper-trust",
        "v2",
        relayScope,
        merchantPubkey,
        shopperPubkey,
      ] as const,
    [merchantPubkey, relayScope, shopperPubkey]
  )
  const enabled =
    (options.enabled ?? true) && !!merchantPubkey && !!shopperPubkey

  const query = useQuery({
    queryKey,
    enabled,
    // The core reader owns aggregate-cache freshness. Keeping the React query
    // stale lets a degraded result retry when this shopper is selected again,
    // while a fresh complete Dexie row still returns without relay reads.
    staleTime: 0,
    retry: 0,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const forceRefresh = forceRefreshRef.current
      forceRefreshRef.current = false
      return getShopperTrustEvidence(
        { merchantPubkey, shopperPubkey },
        {
          signal,
          forceRefresh,
          onProgress: (snapshot) => {
            if (signal.aborted) return
            queryClient.setQueryData(queryKey, snapshot)
          },
        }
      )
    },
  })

  useEffect(() => {
    if (!enabled || relayScope === "none") return
    return subscribeRelaySettingsChanges((changedScope) => {
      if (changedScope !== relayScope) return
      forceRefreshRef.current = true
      void queryClient.invalidateQueries({ queryKey })
    })
  }, [enabled, queryClient, queryKey, relayScope])

  return {
    data: query.data,
    evidence: query.data,
    isLoading: enabled && query.isLoading,
    isHydrating: enabled && query.isFetching,
    error: query.error,
    refetch: () => {
      forceRefreshRef.current = true
      void query.refetch()
    },
  }
}
