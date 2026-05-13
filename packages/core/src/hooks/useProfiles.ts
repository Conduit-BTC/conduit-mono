import { useCallback, useEffect, useMemo, useState } from "react"
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { getProfiles, type CommerceReadPolicy } from "../protocol/commerce"
import {
  hasProfileContent,
  mergeRicherProfile,
  mergeRicherProfiles,
  type ProfileMap,
} from "../protocol/profile-cache"
import type { Profile } from "../types"

const PROFILE_STALE_TIME_MS = 30 * 60_000

type ProfilePriority = "visible" | "background"

export interface UseProfilesOptions {
  enabled?: boolean
  priority?: ProfilePriority
  readPolicy?: CommerceReadPolicy
  relayHintsByPubkey?: Record<string, string[] | undefined>
  refetchUnresolvedMs?: number
  staleTime?: number
}

export interface UseProfilesResult {
  data: ProfileMap
  profiles: ProfileMap
  unresolvedPubkeys: string[]
  isLoading: boolean
  isFetching: boolean
  isHydrating: boolean
  error: unknown
  refetch: UseQueryResult<ProfileMap>["refetch"]
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
    maxRelays: readPolicy?.maxRelays ?? 32,
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
  const pubkeyKey = uniquePubkeys(pubkeys).join("\u0000")
  const unique = useMemo(
    () => (pubkeyKey ? pubkeyKey.split("\u0000") : []),
    [pubkeyKey]
  )
  const relayHintKey = useMemo(
    () => getRelayHintKey(options.relayHintsByPubkey),
    [options.relayHintsByPubkey]
  )
  const [resolvedProfiles, setResolvedProfiles] = useState<ProfileMap>({})
  const enabled = (options.enabled ?? true) && unique.length > 0
  const cacheResolvedProfiles = useCallback(
    (profiles: ProfileMap | undefined) => {
      const richProfiles = Object.fromEntries(
        Object.entries(profiles ?? {}).filter(([, profile]) =>
          hasProfileContent(profile)
        )
      ) as ProfileMap

      if (Object.keys(richProfiles).length === 0) return

      setResolvedProfiles((current) =>
        mergeRicherProfiles(current, richProfiles)
      )

      for (const [pubkey, profile] of Object.entries(richProfiles)) {
        queryClient.setQueryData<Profile | undefined>(
          ["profile", pubkey],
          (current) => mergeRicherProfile(current, profile)
        )
      }
    },
    [queryClient]
  )

  useEffect(() => {
    const cached = Object.fromEntries(
      unique
        .map((pubkey) => [
          pubkey,
          queryClient.getQueryData<Profile>(["profile", pubkey]),
        ])
        .filter(([, profile]) => !!profile)
    ) as ProfileMap

    setResolvedProfiles((current) => mergeRicherProfiles(current, cached))
  }, [queryClient, unique])

  const query = useQuery({
    queryKey: ["profiles", unique, priority, relayHintKey],
    enabled,
    queryFn: async () => {
      const result = await getProfiles({
        pubkeys: unique,
        priority,
        readPolicy: defaultReadPolicy(priority, options.readPolicy),
        relayHintsByPubkey: options.relayHintsByPubkey,
        onProgress: (progress) => cacheResolvedProfiles(progress.data),
      })
      return result.data
    },
    placeholderData: (previousData) => previousData,
    staleTime: options.staleTime ?? PROFILE_STALE_TIME_MS,
    retry: 2,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
    refetchInterval: (state) => {
      const data = state.state.data
      if (!data) return false
      const hasUnresolved = unique.some(
        (pubkey) => !hasProfileContent(data[pubkey])
      )
      if (!hasUnresolved) return false
      return (
        options.refetchUnresolvedMs ?? (priority === "visible" ? 5_000 : 12_000)
      )
    },
  })

  useEffect(() => {
    cacheResolvedProfiles(query.data)
  }, [cacheResolvedProfiles, query.data])

  const profiles = useMemo(
    () =>
      withBareProfiles(
        unique,
        mergeRicherProfiles(resolvedProfiles, query.data)
      ),
    [query.data, resolvedProfiles, unique]
  )
  const unresolvedPubkeys = useMemo(
    () => unique.filter((pubkey) => !hasProfileContent(profiles[pubkey])),
    [profiles, unique]
  )

  return {
    data: profiles,
    profiles,
    unresolvedPubkeys,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isHydrating: query.isFetching || unresolvedPubkeys.length > 0,
    error: query.error,
    refetch: query.refetch,
    getProfile: (pubkey) => profiles[pubkey],
    hasProfile: (pubkey) => hasProfileContent(profiles[pubkey]),
  }
}
