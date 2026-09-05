import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ConduitAppId } from "../protocol/nip89"
import type { CommerceResult } from "../protocol/commerce"
import type { ProfileMap } from "../protocol/profile-cache"
import {
  ProfilePublishSupersededError,
  publishProfile,
} from "../protocol/profiles"
import type { Profile } from "../types"
import {
  getProfileQueryPerspectiveKey,
  getProfileSingletonQueryKey,
} from "./useProfiles"

export function updateProfileQueryCache(
  current: CommerceResult<ProfileMap> | undefined,
  profile: Profile
): CommerceResult<ProfileMap> | undefined {
  if (!current) return current
  return {
    ...current,
    data: {
      ...current.data,
      [profile.pubkey]: profile,
    },
  }
}

export function useUpdateProfile(appId: ConduitAppId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) =>
      publishProfile(profile, appId),
    onError: (error) => {
      if (!(error instanceof ProfilePublishSupersededError)) return
      void qc.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "profile" || queryKey[0] === "profiles",
      })
    },
    onSuccess: (profile) => {
      const ownerPerspective = getProfileQueryPerspectiveKey(profile.pubkey)
      qc.setQueryData<Profile>(
        getProfileSingletonQueryKey(profile.pubkey, ownerPerspective),
        profile
      )
      qc.setQueriesData<CommerceResult<ProfileMap>>(
        {
          predicate: ({ queryKey }) =>
            queryKey[0] === "profiles" && queryKey[1] === ownerPerspective,
        },
        (current) => updateProfileQueryCache(current, profile)
      )
      void qc.invalidateQueries({
        predicate: ({ queryKey }) =>
          (queryKey[0] === "profile" || queryKey[0] === "profiles") &&
          queryKey[1] !== ownerPerspective,
      })
    },
  })
}
