import {
  createRootRoute,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect } from "react"
import { ErrorPage, NotFoundPage } from "@conduit/ui"
import { MarketHeader } from "../components/MarketHeader"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <MarketHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {children}
      </main>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [pathname])

  useEffect(() => {
    const title = getPageTitle(pathname)
    document.title = `${title} | Conduit Market`
  }, [pathname])

  return (
    <RootShell>
      <Outlet />
    </RootShell>
  )
}

function getPageTitle(pathname: string): string {
  if (
    pathname === "/" ||
    pathname === "/products" ||
    pathname === "/products/"
  ) {
    return "Shop"
  }
  if (pathname === "/cart") {
    return "Cart"
  }
  if (pathname === "/checkout") {
    return "Checkout"
  }
  if (pathname === "/orders") {
    return "Orders"
  }
  if (pathname === "/messages") {
    return "Messages"
  }
  if (pathname === "/profile") {
    return "Profile"
  }
  if (pathname === "/network") {
    return "Relay Settings"
  }
  if (pathname.startsWith("/u/")) {
    return "User Profile"
  }
  if (pathname.startsWith("/products/")) {
    return "Product"
  }
  if (pathname.startsWith("/store/")) {
    return "Storefront"
  }
  return "Not Found"
}

function RootErrorComponent({ error }: ErrorComponentProps) {
  return (
    <ErrorPage
      title="Something went wrong"
      message={error.message || "An unexpected error occurred."}
      showReload
    />
  )
}

function RootNotFound() {
  return <NotFoundPage backTo="/" backLabel="Go to marketplace" />
}
