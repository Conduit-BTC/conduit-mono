import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { AuthProvider, ConduitSessionProvider } from "@conduit/core"
import { routeTree } from "./routeTree.gen"
import "@conduit/ui/styles/site.css"
import "./styles/index.css"

const queryClient = new QueryClient()

const router = createRouter({ routeTree })
const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConduitSessionProvider appId="merchant" allowGuest={false}>
          <RouterProvider router={router} />
        </ConduitSessionProvider>
      </AuthProvider>
      {SHOW_DEVTOOLS && <ReactQueryDevtools />}
    </QueryClientProvider>
  </StrictMode>
)
