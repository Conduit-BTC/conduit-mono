import { hasProfileContent } from "../protocol/profile-cache"
import type { Profile } from "../types"
import {
  useProfiles,
  type UseProfilesOptions,
  type UseProfilesResult,
} from "./useProfiles"

export function useProfile(
  pubkey: string | null | undefined,
  options: UseProfileOptions = {}
): UseProfileResult {
  const { relayHints, ...profilesOptions } = options
  const profilesQuery = useProfiles(pubkey ? [pubkey] : [], {
    ...profilesOptions,
    enabled: !!pubkey && (profilesOptions.enabled ?? true),
    relayHintsByPubkey:
      pubkey && relayHints ? { [pubkey]: relayHints } : undefined,
  })
  const data = pubkey ? (profilesQuery.data[pubkey] ?? { pubkey }) : undefined

  return {
    ...profilesQuery,
    data,
    isPlaceholderData: !!pubkey && !hasProfileContent(data),
  }
}

export type UseProfileOptions = Omit<
  UseProfilesOptions,
  "relayHintsByPubkey"
> & {
  relayHints?: string[]
}

export type UseProfileResult = Omit<
  UseProfilesResult,
  "data" | "profiles" | "getProfile" | "hasProfile"
> & {
  data: Profile | undefined
  profiles: UseProfilesResult["profiles"]
  getProfile: UseProfilesResult["getProfile"]
  hasProfile: UseProfilesResult["hasProfile"]
  isPlaceholderData: boolean
}
