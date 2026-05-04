import { useQuery } from "@tanstack/react-query"
import { fetchProfile } from "../protocol/profiles"

export function useProfile(
  pubkey: string | null | undefined,
  options: { priority?: "visible" | "background" } = {}
) {
  return useQuery({
    queryKey: ["profile", pubkey],
    enabled: !!pubkey,
    queryFn: () => fetchProfile(pubkey!, { priority: options.priority }),
    staleTime: 5 * 60_000,
  })
}
