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
  useConduitSession,
} from "@conduit/core"
import { routeTree } from "./routeTree.gen"
import "./styles/index.css"

const queryClient = new QueryClient()

const router = createRouter({ routeTree })

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

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

void pruneCommerceCaches()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConduitSessionProvider appId="market">
          <MarketAuthQueryBoundary>
            <RouterProvider router={router} />
          </MarketAuthQueryBoundary>
        </ConduitSessionProvider>
      </AuthProvider>
      {import.meta.env.DEV && <ReactQueryDevtools />}
    </QueryClientProvider>
  </StrictMode>
)
