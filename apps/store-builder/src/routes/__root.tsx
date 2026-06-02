import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useAnonymousPageviewTelemetry } from "@conduit/core"

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useAnonymousPageviewTelemetry({
    appId: "store-builder",
    pathname,
    signerConnected: false,
  })

  return (
    <>
      <Outlet />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </>
  )
}
