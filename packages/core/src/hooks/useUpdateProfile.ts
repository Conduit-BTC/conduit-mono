import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLayoutEffect, useRef } from "react"
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

export interface UseUpdateProfileOptions {
  authenticatedPubkey?: string | null
  authGeneration?: number
}

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

export function useUpdateProfile(
  appId: ConduitAppId,
  options: UseUpdateProfileOptions = {}
) {
  const qc = useQueryClient()
  const authenticatedPubkey =
    options.authenticatedPubkey?.trim().toLowerCase() ?? null
  const authorityRef = useRef({
    authenticatedPubkey,
    authGeneration: options.authGeneration,
  })
  useLayoutEffect(() => {
    authorityRef.current = {
      authenticatedPubkey,
      authGeneration: options.authGeneration,
    }
  }, [authenticatedPubkey, options.authGeneration])
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) => {
      const authGeneration = options.authGeneration
      const shouldContinue = authenticatedPubkey
        ? () =>
            authorityRef.current.authenticatedPubkey === authenticatedPubkey &&
            authorityRef.current.authGeneration === authGeneration
        : undefined
      return publishProfile(profile, appId, {
        authenticatedPubkey,
        shouldContinue,
      })
    },
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
