import { createRootRoute, Outlet } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { MarketHeader } from "../components/MarketHeader"

export const Route = createRootRoute({
  component: () => (
    <RootLayout />
  ),
})

function RootLayout() {
  return (
    <div className="min-h-screen">
      <MarketHeader />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}
