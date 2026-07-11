import { StrictMode } from "react"
import { useEffect, useRef, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import {
  AuthProvider,
  ConduitSessionProvider,
  pruneCommerceCaches,
  pruneExpiredGuestOrderData,
  useBtcUsdRate,
  useConduitSession,
} from "@conduit/core"
import bricolageMediumUrl from "../../../packages/ui/src/assets/fonts/BricolageGrotesque-Medium.ttf?url"
import bricolageRegularUrl from "../../../packages/ui/src/assets/fonts/BricolageGrotesque-Regular.ttf?url"
import bricolageSemiBoldUrl from "../../../packages/ui/src/assets/fonts/BricolageGrotesque-SemiBold.ttf?url"
import { routeTree } from "./routeTree.gen"
import { pruneExpiredSessionGuestOrderSigningIdentities } from "./lib/guest-order-identity"
import "@conduit/ui/styles/site.css"
import "./styles/index.css"

const queryClient = new QueryClient()

const router = createRouter({ routeTree })
const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"
const criticalMarketFontUrls = [
  bricolageRegularUrl,
  bricolageMediumUrl,
  bricolageSemiBoldUrl,
]

function preloadCriticalMarketFonts() {
  for (const url of criticalMarketFontUrls) {
    if (document.head.querySelector(`link[href="${url}"]`)) continue

    const link = document.createElement("link")
    link.rel = "preload"
    link.as = "font"
    link.href = url
    link.type = "font/ttf"
    link.crossOrigin = "anonymous"
    document.head.appendChild(link)
  }
}

function MarketAuthQueryBoundary({ children }: { children: ReactNode }) {
  const session = useConduitSession()
  const queryClient = useQueryClient()
  const identityRef = useRef<string | null>(null)
  const identity =
    session.mode === "signed_in" && session.pubkey
      ? `connected:${session.pubkey}`
      : "anonymous"

  useEffect(() => {
    const previous = identityRef.current
    identityRef.current = identity
    if (previous === null || previous === identity) return

    queryClient.removeQueries({
      predicate: (query) => {
        const root = query.queryKey[0]
        return (
          root === "progressive-products" ||
          root === "market-perspective-follows" ||
          root === "visible-product-card-profiles" ||
          root === "default-market-perspective-follow-refresh"
        )
      },
    })
  }, [identity, queryClient])

  return <>{children}</>
}

function MarketPricingWarmup() {
  useBtcUsdRate()
  return null
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

function pruneGuestRecoveryState() {
  pruneExpiredSessionGuestOrderSigningIdentities()
  void pruneExpiredGuestOrderData().catch(() => {})
}

void pruneCommerceCaches()
pruneGuestRecoveryState()
window.addEventListener("focus", pruneGuestRecoveryState)
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pruneGuestRecoveryState()
})
preloadCriticalMarketFonts()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConduitSessionProvider appId="market">
          <MarketAuthQueryBoundary>
            <MarketPricingWarmup />
            <RouterProvider router={router} />
          </MarketAuthQueryBoundary>
        </ConduitSessionProvider>
      </AuthProvider>
      {SHOW_DEVTOOLS && <ReactQueryDevtools />}
    </QueryClientProvider>
  </StrictMode>
)
