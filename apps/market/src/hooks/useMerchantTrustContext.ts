import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  buildMerchantTrustSocialSummary,
  fetchMerchantTrustSocialSummary,
  formatNpub,
  getProfileDisplayLabel,
  normalizePubkey,
  subscribeRelaySettingsChanges,
  useConduitSession,
  useProfile,
  type MerchantTrustSocialSummary,
  type Profile,
} from "@conduit/core"

type ProfileState = "idle" | "loading" | "available" | "limited"
type SocialState =
  | "disconnected"
  | "own_store"
  | "loading"
  | "available"
  | "limited"
  | "unavailable"

export type MerchantTrustContext = MerchantTrustSocialSummary & {
  merchantPubkey: string | null
  profile: Profile | undefined
  profileState: ProfileState
  socialState: SocialState
  /** Desired state of an exact signed update awaiting an unambiguous ACK. */
  pendingViewerFollowsMerchant: boolean | null
  merchantName: string
  merchantNamePending: boolean
  listingCount?: number
}

export function getMerchantProfileAuthenticatedPubkey(
  merchantPubkey: string | null | undefined,
  viewerPubkey: string | null | undefined
): string | undefined {
  const normalizedMerchant = normalizePubkey(merchantPubkey)
  const normalizedViewer = normalizePubkey(viewerPubkey)
  return normalizedMerchant && normalizedMerchant === normalizedViewer
    ? normalizedViewer
    : undefined
}

export function useMerchantTrustContext({
  merchantPubkey,
  listingCount,
  profileRelayHints,
}: {
  merchantPubkey: string | null | undefined
  listingCount?: number
  profileRelayHints?: string[]
}): MerchantTrustContext {
  const session = useConduitSession()
  const queryClient = useQueryClient()
  const viewerPubkey = session.mode === "signed_in" ? session.pubkey : null
  const profileQuery = useProfile(merchantPubkey ?? null, {
    authenticatedPubkey: getMerchantProfileAuthenticatedPubkey(
      merchantPubkey,
      viewerPubkey
    ),
    relayHints: profileRelayHints,
    refetchUnresolvedMs: 2_000,
    maxUnresolvedRefetches: 2,
  })
  const profile = profileQuery.data

  const socialQueryKey = useMemo(
    () =>
      [
        "merchant-trust-social",
        "v2",
        session.relayScope ?? "none",
        viewerPubkey ?? "none",
        merchantPubkey ?? "none",
      ] as const,
    [merchantPubkey, session.relayScope, viewerPubkey]
  )
  const socialQuery = useQuery({
    queryKey: socialQueryKey,
    enabled:
      session.relaySettingsReady &&
      !!merchantPubkey &&
      !!viewerPubkey &&
      viewerPubkey !== merchantPubkey,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchMerchantTrustSocialSummary(
        {
          merchantPubkey: merchantPubkey!,
          viewerPubkey: viewerPubkey!,
        },
        { signal }
      ),
  })

  useEffect(() => {
    if (!viewerPubkey || !session.relayScope) return
    return subscribeRelaySettingsChanges((changedScope) => {
      if (changedScope !== session.relayScope) return
      void queryClient.invalidateQueries({ queryKey: socialQueryKey })
    })
  }, [queryClient, session.relayScope, socialQueryKey, viewerPubkey])

  const merchantName = merchantPubkey
    ? getProfileDisplayLabel(profile, merchantPubkey, {
        lookupSettled: !profileQuery.isPlaceholderData,
        pendingLabel: `Store ${formatNpub(merchantPubkey, 8)}`,
        emptyPrefix: "Store",
        chars: 8,
      })
    : "this merchant"
  const merchantNamePending =
    !!merchantPubkey &&
    profileQuery.isPlaceholderData &&
    !profileQuery.lookupSettled

  const fallbackSocial = useMemo(
    () =>
      buildMerchantTrustSocialSummary({
        merchantPubkey: merchantPubkey ?? "",
        viewerPubkey,
        viewerFollowPubkeys: null,
        merchantFollowPubkeys: null,
      }),
    [merchantPubkey, viewerPubkey]
  )

  const profileState: ProfileState = !merchantPubkey
    ? "idle"
    : !profileQuery.isPlaceholderData
      ? "available"
      : profileQuery.isLoading || profileQuery.isFetching
        ? "loading"
        : "limited"

  const socialState: SocialState = !merchantPubkey
    ? "unavailable"
    : !viewerPubkey
      ? "disconnected"
      : viewerPubkey === merchantPubkey
        ? "own_store"
        : !session.relaySettingsReady ||
            socialQuery.isLoading ||
            socialQuery.isFetching
          ? "loading"
          : socialQuery.error
            ? "unavailable"
            : (socialQuery.data?.readState ?? "unavailable")

  const socialSummary = socialQuery.data
    ? {
        merchantFollowingCount: socialQuery.data.merchantFollowingCount,
        viewerFollowsMerchant: socialQuery.data.viewerFollowsMerchant,
        merchantFollowsViewer: socialQuery.data.merchantFollowsViewer,
        mutualFollowCount: socialQuery.data.mutualFollowCount,
        pendingViewerFollowsMerchant:
          socialQuery.data.pendingViewerFollowsMerchant,
      }
    : { ...fallbackSocial, pendingViewerFollowsMerchant: null }

  return {
    merchantPubkey: merchantPubkey ?? null,
    profile,
    profileState,
    socialState,
    merchantName,
    merchantNamePending,
    listingCount,
    ...socialSummary,
  }
}
