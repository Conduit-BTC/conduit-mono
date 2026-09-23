import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useLayoutEffect, useRef } from "react"
import type { ConduitAppId } from "../protocol/nip89"
import type { ProfileBatchResult } from "../protocol/commerce"
import {
  compareSelectedProfileContexts,
  type SelectedProfileContext,
} from "../protocol/profile-cache"
import {
  ProfilePublishSupersededError,
  publishProfileContext,
} from "../protocol/profiles"
import type { Profile } from "../types"
import {
  getProfileQueryPerspectiveKey,
  getProfileSingletonQueryKey,
} from "./useProfiles"

export interface UseUpdateProfileOptions {
  authenticatedPubkey?: string | null
  authGeneration?: number
  shouldContinue?: () => boolean
}

export function updateProfileQueryCache(
  current: ProfileBatchResult | undefined,
  context: SelectedProfileContext
): ProfileBatchResult | undefined {
  if (!current) return current
  const pubkey = context.profile.pubkey
  const currentContext = current.profileContexts?.[pubkey]
  if (
    currentContext &&
    compareSelectedProfileContexts(currentContext, context) > 0
  ) {
    return current
  }
  // Keep the publisher's exact selected context with its projection. A local
  // publish does not refresh the rest of this batch; invalidate its read meta.
  return {
    ...current,
    data: { ...current.data, [pubkey]: context.profile },
    profileContexts: {
      ...current.profileContexts,
      [pubkey]: context,
    },
    meta: {
      ...current.meta,
      source: "local_cache",
      stale: true,
      degraded: true,
      profileFrontierStates: {
        ...current.meta.profileFrontierStates,
        [pubkey]: !context.frontier
          ? "not_observed"
          : context.freshness === "observed"
            ? context.frontier.validity === "valid"
              ? "observed_valid"
              : "observed_malformed"
            : context.frontier.validity === "valid"
              ? "retained_valid"
              : "retained_malformed",
      },
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
            options.shouldContinue?.() !== false &&
            authorityRef.current.authenticatedPubkey === authenticatedPubkey &&
            authorityRef.current.authGeneration === authGeneration
        : undefined
      return publishProfileContext(profile, appId, {
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
    onSuccess: (context) => {
      const profile = context.profile
      const ownerPerspective = getProfileQueryPerspectiveKey(profile.pubkey)
      qc.setQueryData<Profile>(
        getProfileSingletonQueryKey(profile.pubkey, ownerPerspective),
        profile
      )
      qc.setQueriesData<ProfileBatchResult>(
        {
          predicate: ({ queryKey }) =>
            queryKey[0] === "profiles" && queryKey[1] === ownerPerspective,
        },
        (current) => updateProfileQueryCache(current, context)
      )
      void qc.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "profile" || queryKey[0] === "profiles",
      })
    },
  })
}
