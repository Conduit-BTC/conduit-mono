import { useQuery } from "@tanstack/react-query"
import { fetchProfile } from "../protocol/profiles"

export function useProfile(pubkey: string | null | undefined) {
  return useQuery({
    queryKey: ["profile", pubkey],
    enabled: !!pubkey,
    queryFn: () => fetchProfile(pubkey!),
    staleTime: 5 * 60_000,
  })
}
