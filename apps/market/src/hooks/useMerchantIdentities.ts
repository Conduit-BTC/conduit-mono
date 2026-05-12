import { useCallback, useMemo } from "react"
import { mergeRicherProfiles, useProfiles } from "@conduit/core"
import {
  getMerchantIdentityFromMap,
  type MerchantIdentityView,
} from "../lib/marketBrowseModel"

interface UseMerchantIdentitiesInput {
  allMerchantPubkeys: string[]
  visibleMerchantPubkeys: string[]
  relayHintsByPubkey: Record<string, string[]>
}

interface UseMerchantIdentitiesResult {
  identitiesByPubkey: Record<string, MerchantIdentityView>
  getIdentity: (pubkey: string) => MerchantIdentityView
}

export function useMerchantIdentities({
  allMerchantPubkeys,
  visibleMerchantPubkeys,
  relayHintsByPubkey,
}: UseMerchantIdentitiesInput): UseMerchantIdentitiesResult {
  const visibleMerchantProfiles = useProfiles(visibleMerchantPubkeys, {
    priority: "visible",
    relayHintsByPubkey,
    refetchUnresolvedMs: 5_000,
  })
  const visibleMerchantPubkeySet = useMemo(
    () => new Set(visibleMerchantPubkeys),
    [visibleMerchantPubkeys]
  )
  const backgroundMerchantPubkeys = useMemo(
    () =>
      allMerchantPubkeys.filter(
        (pubkey) => !visibleMerchantPubkeySet.has(pubkey)
      ),
    [allMerchantPubkeys, visibleMerchantPubkeySet]
  )
  const backgroundMerchantProfiles = useProfiles(backgroundMerchantPubkeys, {
    priority: "background",
    relayHintsByPubkey,
    refetchUnresolvedMs: 12_000,
  })
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
            relayHintsByPubkey
          ),
        ])
      ),
    [allMerchantPubkeys, merchantProfiles, relayHintsByPubkey]
  )
  const getIdentity = useCallback(
    (pubkey: string) =>
      identitiesByPubkey[pubkey] ??
      getMerchantIdentityFromMap(pubkey, merchantProfiles, relayHintsByPubkey),
    [identitiesByPubkey, merchantProfiles, relayHintsByPubkey]
  )

  return {
    identitiesByPubkey,
    getIdentity,
  }
}
