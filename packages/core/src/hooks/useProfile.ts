import { useQuery } from "@tanstack/react-query"
import { fetchProfile } from "../protocol/profiles"
import type { Profile } from "../types"

function hasProfileContent(profile: Profile | undefined): boolean {
  if (!profile) return false
  return [
    profile.name,
    profile.displayName,
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)
}

export function useProfile(pubkey: string | null | undefined) {
  return useQuery({
    queryKey: ["profile", pubkey],
    enabled: !!pubkey,
    queryFn: () => fetchProfile(pubkey!),
    staleTime: 5 * 60_000,
    retry: 2,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      query.state.data && !hasProfileContent(query.state.data) ? 2_000 : false,
  })
}
