import { useCallback, useMemo } from "react"
import { mergeRicherProfiles, useProfiles } from "@conduit/core"
import {
  getMerchantIdentityFromMap,
  type MerchantIdentityView,
} from "../lib/marketBrowseModel"
import { splitMerchantHydrationTargets } from "../lib/clientHydration"

interface UseMerchantIdentitiesInput {
  allMerchantPubkeys: string[]
  deferBackgroundHydration?: boolean
  visibleMerchantPubkeys: string[]
  relayHintsByPubkey: Record<string, string[]>
}

interface UseMerchantIdentitiesResult {
  identitiesByPubkey: Record<string, MerchantIdentityView>
  getIdentity: (pubkey: string) => MerchantIdentityView
}

export function useMerchantIdentities({
  allMerchantPubkeys,
  deferBackgroundHydration = false,
  visibleMerchantPubkeys,
  relayHintsByPubkey,
}: UseMerchantIdentitiesInput): UseMerchantIdentitiesResult {
  const merchantHydrationTargets = useMemo(
    () =>
      splitMerchantHydrationTargets({
        allMerchantPubkeys,
        visibleMerchantPubkeys,
      }),
    [allMerchantPubkeys, visibleMerchantPubkeys]
  )
  const visibleMerchantProfiles = useProfiles(
    merchantHydrationTargets.visibleMerchantPubkeys,
    {
      priority: "visible",
      relayHintsByPubkey,
      refetchUnresolvedMs: 5_000,
      maxUnresolvedRefetches: 2,
    }
  )
  const backgroundMerchantProfiles = useProfiles(
    merchantHydrationTargets.backgroundMerchantPubkeys,
    {
      enabled: !deferBackgroundHydration,
      priority: "background",
      readPolicy: { maxRelays: 4 },
      relayHintsByPubkey,
      refetchUnresolvedMs: 12_000,
      maxUnresolvedRefetches: 1,
    }
  )
  const visibleLookupSettledByPubkey = useMemo(
    () =>
      Object.fromEntries(
        merchantHydrationTargets.visibleMerchantPubkeys.map((pubkey) => [
          pubkey,
          visibleMerchantProfiles.hasProfile(pubkey) ||
            visibleMerchantProfiles.lookupSettled,
        ])
      ),
    [merchantHydrationTargets.visibleMerchantPubkeys, visibleMerchantProfiles]
  )
  const backgroundLookupSettledByPubkey = useMemo(
    () =>
      Object.fromEntries(
        merchantHydrationTargets.backgroundMerchantPubkeys.map((pubkey) => [
          pubkey,
          backgroundMerchantProfiles.hasProfile(pubkey) ||
            (!deferBackgroundHydration &&
              backgroundMerchantProfiles.lookupSettled),
        ])
      ),
    [
      backgroundMerchantProfiles,
      deferBackgroundHydration,
      merchantHydrationTargets.backgroundMerchantPubkeys,
    ]
  )
  const lookupSettledByPubkey = useMemo(
    () => ({
      ...backgroundLookupSettledByPubkey,
      ...visibleLookupSettledByPubkey,
    }),
    [backgroundLookupSettledByPubkey, visibleLookupSettledByPubkey]
  )
  const merchantProfiles = useMemo(
    () =>
      mergeRicherProfiles(
        backgroundMerchantProfiles.data,
        visibleMerchantProfiles.data
      ),
    [backgroundMerchantProfiles.data, visibleMerchantProfiles.data]
  )
  const identitiesByPubkey = useMemo(
    () =>
      Object.fromEntries(
        allMerchantPubkeys.map((pubkey) => [
          pubkey,
          getMerchantIdentityFromMap(
            pubkey,
            merchantProfiles,
            relayHintsByPubkey,
            lookupSettledByPubkey
          ),
        ])
      ),
    [
      allMerchantPubkeys,
      lookupSettledByPubkey,
      merchantProfiles,
      relayHintsByPubkey,
    ]
  )
  const getIdentity = useCallback(
    (pubkey: string) =>
      identitiesByPubkey[pubkey] ??
      getMerchantIdentityFromMap(
        pubkey,
        merchantProfiles,
        relayHintsByPubkey,
        lookupSettledByPubkey
      ),
    [
      identitiesByPubkey,
      lookupSettledByPubkey,
      merchantProfiles,
      relayHintsByPubkey,
    ]
  )

  return {
    identitiesByPubkey,
    getIdentity,
  }
}
