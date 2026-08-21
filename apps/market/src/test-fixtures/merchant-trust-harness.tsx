import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"

import {
  AuthProvider,
  ConduitSessionProvider,
  getProfileSingletonQueryKey,
  useAuth,
} from "@conduit/core"

import { useMerchantTrustContext } from "../hooks/useMerchantTrustContext"

export function mountMerchantTrustHarness(
  container: HTMLElement,
  staleViewerPubkey: string,
  merchantPubkey: string,
  options: { publicProfileName?: string } = {}
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
      }
    )
  }
  const trustInput = {
    merchantPubkey,
    viewerPubkey: staleViewerPubkey,
  } as Parameters<typeof useMerchantTrustContext>[0] & {
    viewerPubkey: string
  }

  function TrustProbe() {
    const auth = useAuth()
    const trust = useMerchantTrustContext(trustInput)

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
          data-profile-state={trust.profileState}
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
