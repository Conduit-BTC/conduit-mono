import {
  createRootRoute,
  Link,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect, useRef } from "react"
import {
  buildBugReportUrl,
  recordBrowserTelemetryEvent,
  recordBrowserTelemetryPageView,
  useAuth,
} from "@conduit/core"
import { ErrorPage, LegalFooter, NotFoundPage } from "@conduit/ui"
import { MarketHeader } from "../components/MarketHeader"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden pb-24 sm:pb-16">
      <MarketHeader />
      <main className="mx-auto min-w-0 w-full max-w-7xl flex-1 px-4 pb-12 pt-6">
        {children}
      </main>
      <LegalFooter
        aboutLink={
          <Link
            to="/about"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            About
          </Link>
        }
      />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function ReportBugLink({ className }: { className?: string }) {
  const bugReportUrl = useMarketBugReportUrl()

  return (
    <a
      href={bugReportUrl}
      target="_blank"
      rel="noreferrer"
      className={
        className ??
        "font-medium text-[var(--text-primary)] underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--text-primary)]"
      }
    >
      Report a Bug
    </a>
  )
}

function useMarketBugReportUrl(): string {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return buildBugReportUrl({ app: "market", route: pathname })
}

function RootLayout() {
  const { status } = useAuth()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const appLoadTelemetrySentRef = useRef(false)
  const previousAuthStatusRef = useRef(status)

  useEffect(() => {
    if (appLoadTelemetrySentRef.current) return
    appLoadTelemetrySentRef.current = true
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "app_load_result",
      properties: {
        network: "browser",
        status: "success",
      },
    })
  }, [])

  useEffect(() => {
    if (
      status === "connected" &&
      previousAuthStatusRef.current !== "connected"
    ) {
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "signer_connected",
        properties: {
          method: "nip07",
          status: "success",
        },
      })
    }
    if (
      status === "disconnected" &&
      previousAuthStatusRef.current === "connected"
    ) {
      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "signer_disconnected",
        properties: {
          method: "nip07",
          status: "success",
        },
      })
    }
    previousAuthStatusRef.current = status
  }, [status])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [pathname])

  useEffect(() => {
    const title = getPageTitle(pathname)
    document.title = `${title} | Conduit Market`
  }, [pathname])

  useEffect(() => {
    recordBrowserTelemetryPageView({ app: "market", pathname })
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
    return "Order"
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
  if (pathname === "/wallet") {
    return "Wallet"
  }
  if (pathname === "/about") {
    return "About"
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
    <RootShell>
      <ErrorPage
        title="Something went wrong"
        message={error.message || "An unexpected error occurred."}
        showReload
      >
        <div className="space-y-2 text-sm">
          <ReportBugLink className="font-medium text-primary-500 underline underline-offset-4 hover:text-primary-600" />
          <p className="text-xs leading-5 text-[var(--text-muted)]">
            Do not include private keys, wallet secrets, payment credentials, or
            sensitive personal information.
          </p>
        </div>
      </ErrorPage>
    </RootShell>
  )
}

function RootNotFound() {
  return <NotFoundPage backTo="/" backLabel="Go to marketplace" />
}
