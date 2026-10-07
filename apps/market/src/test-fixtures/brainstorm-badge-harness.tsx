import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Nip05TrustIndicator } from "../components/MerchantIdentity"

export function mountBrainstormBadgeHarness(
  container: HTMLElement,
  pubkey: string
): () => void {
  const queryClient = new QueryClient()
  const root = createRoot(container)
  root.render(
    <QueryClientProvider client={queryClient}>
      <div className="inline-flex flex-col gap-6 p-6">
        <div data-testid="full-badge">
          <Nip05TrustIndicator
            pubkey={pubkey}
            nip05="merchant@nip05-badge.conduit.market"
          />
        </div>
        <div data-testid="icon-badge">
          <Nip05TrustIndicator
            pubkey={pubkey}
            nip05="merchant@nip05-badge.conduit.market"
            display="icon"
          />
        </div>
      </div>
    </QueryClientProvider>
  )
  return () => {
    root.unmount()
    queryClient.clear()
  }
}
