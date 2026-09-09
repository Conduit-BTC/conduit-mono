import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import {
  AuthProvider,
  ConduitSessionProvider,
  pruneShopperTrustSnapshots,
} from "@conduit/core"
import { isProductLegalPath } from "@conduit/ui"
import { initializeTheme } from "@conduit/ui/theme"
import { routeTree } from "./routeTree.gen"
import { startProductDeletionDeliveryWorker } from "./lib/product-deletion-delivery"
import { isMerchantPublicAboutPath } from "./lib/publicRoutes"
import "@conduit/ui/styles/site.css"
import "./styles/index.css"

initializeTheme()

const queryClient = new QueryClient()

const router = createRouter({ routeTree })
const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"
const isPublicEntry =
  isProductLegalPath(window.location.pathname) ||
  isMerchantPublicAboutPath(window.location.pathname)

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

const root = createRoot(document.getElementById("root")!)

if (isPublicEntry) {
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  )
} else {
  startProductDeletionDeliveryWorker()
  void pruneShopperTrustSnapshots()

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider signerClientIcon="/merchant-icon-192.png">
          <ConduitSessionProvider appId="merchant" allowGuest={false}>
            <RouterProvider router={router} />
          </ConduitSessionProvider>
        </AuthProvider>
        {SHOW_DEVTOOLS && <ReactQueryDevtools />}
      </QueryClientProvider>
    </StrictMode>
  )
}
