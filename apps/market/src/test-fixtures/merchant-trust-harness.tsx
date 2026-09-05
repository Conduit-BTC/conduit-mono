import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"

import {
  AuthProvider,
  __setCommerceTestOverrides,
  ConduitSessionProvider,
  getProfileSingletonQueryKey,
  useAuth,
} from "@conduit/core"

import { useMerchantTrustContext } from "../hooks/useMerchantTrustContext"
import { getFastCheckoutUnavailableReasons } from "../lib/checkout-validation"
import { getMerchantPaymentLud16 } from "../lib/merchant-payment-readiness"

export function mountMerchantTrustHarness(
  container: HTMLElement,
  staleViewerPubkey: string,
  merchantPubkey: string,
  options: {
    publicProfileName?: string
    publicProfileLud16?: string
    strictProfileEvidenceUnavailable?: boolean
  } = {}
): () => void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (options.publicProfileName) {
    queryClient.setQueryData(
      getProfileSingletonQueryKey(merchantPubkey, null),
      {
        pubkey: merchantPubkey,
        displayName: options.publicProfileName,
        lud16: options.publicProfileLud16,
      }
    )
  }
  if (options.strictProfileEvidenceUnavailable) {
    __setCommerceTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, requestOptions) => ({
        events: [],
        relays: (
          requestOptions?.relayUrls ?? ["wss://profile-evidence.test"]
        ).map((relayUrl) => ({
          relayUrl,
          status: "failed" as const,
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
    })
  }
  const trustInput = {
    merchantPubkey,
    viewerPubkey: staleViewerPubkey,
    requireCompleteProfileEvidence:
      options.strictProfileEvidenceUnavailable ?? false,
  } as Parameters<typeof useMerchantTrustContext>[0] & {
    viewerPubkey: string
  }

  function TrustProbe() {
    const auth = useAuth()
    const trust = useMerchantTrustContext(trustInput)
    const merchantPaymentLud16 = getMerchantPaymentLud16({
      profileState: trust.profileEvidenceState,
      lud16: trust.profile?.lud16,
    })
    const fastCheckoutReason = getFastCheckoutUnavailableReasons({
      walletPayCapable: true,
      merchantLud16: merchantPaymentLud16,
      merchantProfileLoading: trust.profileEvidenceState === "loading",
      merchantProfileUnavailable: trust.profileEvidenceState === "unavailable",
      lnurlAllowsNostr: false,
    })[0]

    return (
      <>
        <button
          type="button"
          data-testid="merchant-trust-connect"
          onClick={() => void auth.connect({ method: "nip07" })}
        >
          Connect trust harness
        </button>
        <output
          data-testid="merchant-trust-probe"
          data-auth-error={auth.error ?? "none"}
          data-auth-status={auth.status}
          data-profile-name={
            trust.profile?.displayName ?? trust.profile?.name ?? "none"
          }
          data-profile-evidence-state={trust.profileEvidenceState}
          data-profile-state={trust.profileState}
          data-fast-checkout-reason={fastCheckoutReason ?? "none"}
          data-social-state={trust.socialState}
          data-mutual-count={trust.mutualFollowCount ?? "none"}
          data-viewer-follows={String(trust.viewerFollowsMerchant)}
        />
      </>
    )
  }

  const root = createRoot(container)
  root.render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConduitSessionProvider appId="market">
          <TrustProbe />
        </ConduitSessionProvider>
      </AuthProvider>
    </QueryClientProvider>
  )

  return () => root.unmount()
}
