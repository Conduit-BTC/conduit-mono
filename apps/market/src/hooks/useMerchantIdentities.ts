import { useCallback, useMemo } from "react"
import { mergeRicherProfiles, useProfiles } from "@conduit/core"
import {
  getMerchantIdentityFromMap,
  type MerchantIdentityView,
} from "../lib/marketBrowseModel"
import { splitMerchantHydrationTargets } from "../lib/clientHydration"

interface UseMerchantIdentitiesInput {
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  allMerchantPubkeys: string[]
  deferBackgroundHydration?: boolean
  /** Merchant rows currently exposed by a menu or search surface. */
  backgroundHydrationPubkeys?: string[]
  visibleMerchantPubkeys: string[]
  relayHintsByPubkey: Record<string, string[]>
}

interface UseMerchantIdentitiesResult {
  identitiesByPubkey: Record<string, MerchantIdentityView>
  getIdentity: (pubkey: string) => MerchantIdentityView
}

export function useMerchantIdentities({
  accountPubkey,
  authenticatedPubkey,
  shouldContinue,
  allMerchantPubkeys,
  deferBackgroundHydration = false,
  backgroundHydrationPubkeys,
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
  const requestedBackgroundPubkeys = useMemo(() => {
    if (deferBackgroundHydration || !backgroundHydrationPubkeys)
      return merchantHydrationTargets.backgroundMerchantPubkeys
    const requested = new Set(backgroundHydrationPubkeys)
    return merchantHydrationTargets.backgroundMerchantPubkeys.filter((pubkey) =>
      requested.has(pubkey)
    )
  }, [
    backgroundHydrationPubkeys,
    deferBackgroundHydration,
    merchantHydrationTargets.backgroundMerchantPubkeys,
  ])
  const requestedBackgroundSet = useMemo(
    () => new Set(requestedBackgroundPubkeys),
    [requestedBackgroundPubkeys]
  )
  const visibleMerchantProfiles = useProfiles(
    merchantHydrationTargets.visibleMerchantPubkeys,
    {
      accountPubkey,
      authenticatedPubkey,
      shouldContinue,
      priority: "visible",
      relayHintsByPubkey,
      refetchUnresolvedMs: 5_000,
      maxUnresolvedRefetches: 2,
    }
  )
  const backgroundMerchantProfiles = useProfiles(requestedBackgroundPubkeys, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue,
    enabled: !deferBackgroundHydration,
    priority: "background",
    relayHintsByPubkey,
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })
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
              requestedBackgroundSet.has(pubkey) &&
              backgroundMerchantProfiles.lookupSettled),
        ])
      ),
    [
      backgroundMerchantProfiles,
      deferBackgroundHydration,
      merchantHydrationTargets.backgroundMerchantPubkeys,
      requestedBackgroundSet,
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
