import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getShopperTrustEvidence,
  type ShopperTrustEvidence,
} from "../protocol/shopper-trust"

export interface UseShopperTrustEvidenceOptions {
  enabled?: boolean
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
  const merchantPubkey = pair?.merchantPubkey.trim().toLowerCase() ?? ""
  const shopperPubkey = pair?.shopperPubkey.trim().toLowerCase() ?? ""
  const queryKey = [
    "shopper-trust",
    "v2",
    merchantPubkey,
    shopperPubkey,
  ] as const
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
    queryFn: ({ signal }) =>
      getShopperTrustEvidence(
        { merchantPubkey, shopperPubkey },
        {
          signal,
          onProgress: (snapshot) => {
            if (signal.aborted) return
            queryClient.setQueryData(queryKey, snapshot)
          },
        }
      ),
  })

  return {
    data: query.data,
    evidence: query.data,
    isLoading: enabled && query.isLoading,
    isHydrating: enabled && query.isFetching,
    error: query.error,
    refetch: () => {
      void query.refetch()
    },
  }
}
