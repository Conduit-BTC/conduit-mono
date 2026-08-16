import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ConduitAppId } from "../protocol/nip89"
import type { ProfileMap } from "../protocol/profile-cache"
import { publishProfile } from "../protocol/profiles"
import type { Profile } from "../types"
import {
  getProfileQueryPerspectiveKey,
  getProfileSingletonQueryKey,
} from "./useProfiles"

export function useUpdateProfile(appId: ConduitAppId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) =>
      publishProfile(profile, appId),
    onSuccess: (profile) => {
      const ownerPerspective = getProfileQueryPerspectiveKey(profile.pubkey)
      qc.setQueryData<Profile>(
        getProfileSingletonQueryKey(profile.pubkey, ownerPerspective),
        profile
      )
      qc.setQueriesData<ProfileMap>(
        {
          predicate: ({ queryKey }) =>
            queryKey[0] === "profiles" && queryKey[1] === ownerPerspective,
        },
        (current) => {
          if (!current) return current
          return {
            ...current,
            [profile.pubkey]: profile,
          }
        }
      )
      void qc.invalidateQueries({
        predicate: ({ queryKey }) =>
          (queryKey[0] === "profile" || queryKey[0] === "profiles") &&
          queryKey[1] !== ownerPerspective,
      })
    },
  })
}
