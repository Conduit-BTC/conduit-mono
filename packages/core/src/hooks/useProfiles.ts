import { useCallback, useEffect, useMemo, useState } from "react"
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import {
  getProfiles,
  type CommerceQueryMeta,
  type CommerceReadPolicy,
  type CommerceResult,
} from "../protocol/commerce"
import {
  hasProfileContent,
  mergeRicherProfile,
  mergeRicherProfiles,
  type ProfileMap,
} from "../protocol/profile-cache"
import type { Profile } from "../types"

const PROFILE_STALE_TIME_MS = 30 * 60_000
const EMPTY_PROFILE_MAP: ProfileMap = {}

type ProfilePriority = "visible" | "background"

export interface UseProfilesOptions {
  authenticatedPubkey?: string | null
  enabled?: boolean
  maxUnresolvedRefetches?: number
  priority?: ProfilePriority
  readPolicy?: CommerceReadPolicy
  relayHintsByPubkey?: Record<string, string[] | undefined>
  refetchUnresolvedMs?: number
  requireCompleteEvidence?: boolean
  skipCache?: boolean
  staleTime?: number
}

export function getProfileQueryPerspectiveKey(
  authenticatedPubkey: string | null | undefined
): string {
  return authenticatedPubkey?.trim().toLowerCase() ?? ""
}

export function getProfileSingletonQueryKey(
  pubkey: string,
  authenticatedPubkey: string | null | undefined
): readonly ["profile", string, string] {
  return ["profile", getProfileQueryPerspectiveKey(authenticatedPubkey), pubkey]
}

export interface UseProfilesResult {
  data: ProfileMap
  profiles: ProfileMap
  unresolvedPubkeys: string[]
  isLoading: boolean
  isFetching: boolean
  isHydrating: boolean
  lookupSettled: boolean
  unresolvedRefetchLimitReached: boolean
  meta: CommerceQueryMeta | null
  error: unknown
  refetch: UseQueryResult<CommerceResult<ProfileMap>>["refetch"]
  getProfile: (pubkey: string) => Profile | undefined
  hasProfile: (pubkey: string) => boolean
}

function uniquePubkeys(
  pubkeys: readonly (string | null | undefined)[]
): string[] {
  return Array.from(
    new Set(pubkeys.map((pubkey) => pubkey?.trim()).filter(Boolean) as string[])
  ).sort()
}

function getRelayHintKey(
  relayHintsByPubkey: Record<string, string[] | undefined> | undefined
): string {
  if (!relayHintsByPubkey) return ""

  return JSON.stringify(
    Object.entries(relayHintsByPubkey)
      .map(([pubkey, relayUrls]) => [pubkey, [...(relayUrls ?? [])].sort()])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  )
}

function defaultReadPolicy(
  priority: ProfilePriority,
  readPolicy: CommerceReadPolicy | undefined
): CommerceReadPolicy {
  return {
    maxRelays: readPolicy?.maxRelays ?? (priority === "visible" ? 8 : 4),
    connectTimeoutMs:
      readPolicy?.connectTimeoutMs ?? (priority === "visible" ? 1_500 : 2_000),
    fetchTimeoutMs:
      readPolicy?.fetchTimeoutMs ?? (priority === "visible" ? 6_000 : 8_000),
  }
}

function withBareProfiles(
  pubkeys: readonly string[],
  profiles: ProfileMap
): ProfileMap {
  const next = { ...profiles }
  for (const pubkey of pubkeys) {
    next[pubkey] = next[pubkey] ?? { pubkey }
  }
  return next
}

export function useProfiles(
  pubkeys: readonly (string | null | undefined)[],
  options: UseProfilesOptions = {}
): UseProfilesResult {
  const queryClient = useQueryClient()
  const priority = options.priority ?? "visible"
  const authenticatedPerspective = getProfileQueryPerspectiveKey(
    options.authenticatedPubkey
  )
  const pubkeyKey = uniquePubkeys(pubkeys).join("\u0000")
  const unique = useMemo(
    () => (pubkeyKey ? pubkeyKey.split("\u0000") : []),
    [pubkeyKey]
  )
  const relayHintKey = useMemo(
    () => getRelayHintKey(options.relayHintsByPubkey),
    [options.relayHintsByPubkey]
  )
  const [resolvedProfileState, setResolvedProfileState] = useState<{
    perspective: string
    profiles: ProfileMap
  }>({ perspective: authenticatedPerspective, profiles: {} })
  const resolvedProfiles =
    resolvedProfileState.perspective === authenticatedPerspective
      ? resolvedProfileState.profiles
      : EMPTY_PROFILE_MAP
  const [unresolvedRefetchCount, setUnresolvedRefetchCount] = useState(0)
  const enabled = (options.enabled ?? true) && unique.length > 0
  const cacheResolvedProfiles = useCallback(
    (profiles: ProfileMap | undefined) => {
      const richProfiles = Object.fromEntries(
        Object.entries(profiles ?? {}).filter(([, profile]) =>
          hasProfileContent(profile)
        )
      ) as ProfileMap

      if (Object.keys(richProfiles).length === 0) return

      setResolvedProfileState((current) => ({
        perspective: authenticatedPerspective,
        profiles: mergeRicherProfiles(
          current.perspective === authenticatedPerspective
            ? current.profiles
            : {},
          richProfiles
        ),
      }))

      for (const [pubkey, profile] of Object.entries(richProfiles)) {
        queryClient.setQueryData<Profile | undefined>(
          getProfileSingletonQueryKey(pubkey, authenticatedPerspective),
          (current) => mergeRicherProfile(current, profile)
        )
      }
    },
    [authenticatedPerspective, queryClient]
  )

  useEffect(() => {
    setUnresolvedRefetchCount(0)
  }, [
    authenticatedPerspective,
    options.skipCache,
    options.requireCompleteEvidence,
    priority,
    pubkeyKey,
    relayHintKey,
  ])

  useEffect(() => {
    const cached: ProfileMap = {}
    for (const pubkey of unique) {
      const profile = queryClient.getQueryData<Profile>(
        getProfileSingletonQueryKey(pubkey, authenticatedPerspective)
      )
      if (profile) cached[pubkey] = profile
    }

    setResolvedProfileState((current) => ({
      perspective: authenticatedPerspective,
      profiles: mergeRicherProfiles(
        current.perspective === authenticatedPerspective
          ? current.profiles
          : {},
        cached
      ),
    }))
  }, [authenticatedPerspective, queryClient, unique])

  const query = useQuery({
    queryKey: [
      "profiles",
      authenticatedPerspective,
      unique,
      priority,
      relayHintKey,
      options.skipCache,
      options.requireCompleteEvidence,
    ],
    enabled,
    queryFn: async () => {
      const result = await getProfiles({
        pubkeys: unique,
        authenticatedPubkey: options.authenticatedPubkey,
        priority,
        skipCache: options.skipCache,
        requireCompleteEvidence: options.requireCompleteEvidence,
        readPolicy: defaultReadPolicy(priority, options.readPolicy),
        relayHintsByPubkey: options.relayHintsByPubkey,
        onProgress: (progress) => cacheResolvedProfiles(progress.data),
      })
      return result
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === authenticatedPerspective
        ? previousData
        : undefined,
    staleTime: options.staleTime ?? PROFILE_STALE_TIME_MS,
    retry: 2,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
    refetchInterval: (state) => {
      const data = state.state.data?.data
      if (!data) return false
      const hasUnresolved = unique.some(
        (pubkey) => !hasProfileContent(data[pubkey])
      )
      if (!hasUnresolved) return false
      if (
        options.maxUnresolvedRefetches !== undefined &&
        unresolvedRefetchCount >= options.maxUnresolvedRefetches
      ) {
        return false
      }
      return (
        options.refetchUnresolvedMs ?? (priority === "visible" ? 5_000 : 12_000)
      )
    },
  })

  useEffect(() => {
    cacheResolvedProfiles(query.data?.data)
  }, [cacheResolvedProfiles, query.data])

  const profiles = useMemo(
    () =>
      withBareProfiles(
        unique,
        mergeRicherProfiles(resolvedProfiles, query.data?.data)
      ),
    [query.data, resolvedProfiles, unique]
  )
  const unresolvedPubkeys = useMemo(
    () => unique.filter((pubkey) => !hasProfileContent(profiles[pubkey])),
    [profiles, unique]
  )
  const unresolvedRefetchLimitReached =
    options.maxUnresolvedRefetches !== undefined &&
    unresolvedRefetchCount >= options.maxUnresolvedRefetches

  useEffect(() => {
    if (!query.data || query.isFetching) return
    const hasUnresolved = unique.some(
      (pubkey) => !hasProfileContent(query.data?.data[pubkey])
    )
    if (!hasUnresolved) {
      setUnresolvedRefetchCount(0)
      return
    }
    setUnresolvedRefetchCount((current) => current + 1)
  }, [query.data, query.dataUpdatedAt, query.isFetching, unique])

  const lookupSettled =
    !enabled ||
    (!query.isLoading &&
      !query.isFetching &&
      (unresolvedPubkeys.length === 0 ||
        unresolvedRefetchLimitReached ||
        !!query.error))

  return {
    data: profiles,
    profiles,
    unresolvedPubkeys,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isHydrating:
      query.isFetching ||
      (unresolvedPubkeys.length > 0 && !unresolvedRefetchLimitReached),
    lookupSettled,
    unresolvedRefetchLimitReached,
    meta: query.data?.meta ?? null,
    error: query.error,
    refetch: query.refetch,
    getProfile: (pubkey) => profiles[pubkey],
    hasProfile: (pubkey) => hasProfileContent(profiles[pubkey]),
  }
}
