import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ConduitAppId } from "../protocol/nip89"
import type { ProfileMap } from "../protocol/profile-cache"
import { publishProfile } from "../protocol/profiles"
import type { Profile } from "../types"

export function useUpdateProfile(appId: ConduitAppId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) =>
      publishProfile(profile, appId),
    onSuccess: (profile) => {
      qc.setQueryData<Profile>(["profile", profile.pubkey], profile)
      qc.setQueriesData<ProfileMap>({ queryKey: ["profiles"] }, (current) => {
        if (!current) return current
        return {
          ...current,
          [profile.pubkey]: profile,
        }
      })
    },
  })
}
