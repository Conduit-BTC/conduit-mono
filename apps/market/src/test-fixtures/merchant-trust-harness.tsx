import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"

import { AuthProvider, ConduitSessionProvider } from "@conduit/core"

import { useMerchantTrustContext } from "../hooks/useMerchantTrustContext"

export function mountMerchantTrustHarness(
  container: HTMLElement,
  staleViewerPubkey: string,
  merchantPubkey: string
): () => void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const trustInput = {
    merchantPubkey,
    viewerPubkey: staleViewerPubkey,
  } as Parameters<typeof useMerchantTrustContext>[0] & {
    viewerPubkey: string
  }

  function TrustProbe() {
    const trust = useMerchantTrustContext(trustInput)

    return (
      <output
        data-testid="merchant-trust-probe"
        data-social-state={trust.socialState}
        data-mutual-count={trust.mutualFollowCount ?? "none"}
        data-viewer-follows={String(trust.viewerFollowsMerchant)}
      />
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
