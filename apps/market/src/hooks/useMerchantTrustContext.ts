import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  EVENT_KINDS,
  buildMerchantTrustSocialSummary,
  formatNpub,
  getFollowListPubkeySet,
  getProfileDisplayLabel,
  requireNdkConnected,
  selectLatestFollowListEvent,
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
  | "unavailable"

export type MerchantTrustContext = MerchantTrustSocialSummary & {
  merchantPubkey: string | null
  profile: Profile | undefined
  profileState: ProfileState
  socialState: SocialState
  merchantName: string
  merchantNamePending: boolean
  listingCount?: number
}

export function useMerchantTrustContext({
  merchantPubkey,
  viewerPubkey,
  listingCount,
  profileRelayHints,
}: {
  merchantPubkey: string | null | undefined
  viewerPubkey?: string | null
  listingCount?: number
  profileRelayHints?: string[]
}): MerchantTrustContext {
  const profileQuery = useProfile(merchantPubkey ?? null, {
    relayHints: profileRelayHints,
    refetchUnresolvedMs: 2_000,
    maxUnresolvedRefetches: 2,
  })
  const profile = profileQuery.data

  const socialQuery = useQuery({
    queryKey: [
      "merchant-trust-social",
      viewerPubkey ?? "none",
      merchantPubkey ?? "none",
    ],
    enabled:
      !!merchantPubkey && !!viewerPubkey && viewerPubkey !== merchantPubkey,
    staleTime: 60_000,
    queryFn: async () => {
      const ndk = await requireNdkConnected()
      const events = await ndk.fetchEvents({
        kinds: [EVENT_KINDS.CONTACT_LIST],
        authors: [viewerPubkey!, merchantPubkey!],
        limit: 20,
      })
      const allEvents = Array.from(events)
      const viewerLatest = selectLatestFollowListEvent(
        allEvents.filter((event) => event.pubkey === viewerPubkey)
      )
      const merchantLatest = selectLatestFollowListEvent(
        allEvents.filter((event) => event.pubkey === merchantPubkey)
      )

      return buildMerchantTrustSocialSummary({
        merchantPubkey: merchantPubkey!,
        viewerPubkey,
        viewerFollowPubkeys: viewerLatest
          ? getFollowListPubkeySet(viewerLatest)
          : null,
        merchantFollowPubkeys: merchantLatest
          ? getFollowListPubkeySet(merchantLatest)
          : null,
      })
    },
  })

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
        : socialQuery.isLoading || socialQuery.isFetching
          ? "loading"
          : socialQuery.error
            ? "unavailable"
            : "available"

  return {
    merchantPubkey: merchantPubkey ?? null,
    profile,
    profileState,
    socialState,
    merchantName,
    merchantNamePending,
    listingCount,
    ...(socialQuery.data ?? fallbackSocial),
  }
}
