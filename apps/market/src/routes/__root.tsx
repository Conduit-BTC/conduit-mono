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
  installBrowserClientErrorTelemetry,
  recordBrowserClientError,
  recordBrowserTelemetryEvent,
  recordBrowserTelemetryPageView,
  useAuth,
} from "@conduit/core"
import {
  ErrorPage,
  LegalFooter,
  NotFoundPage,
  SignerAuthUrlNotice,
} from "@conduit/ui"
import { MarketHeader } from "../components/MarketHeader"
import { MarketCartHud } from "../components/MarketCartHud"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"

function RootShell({
  children,
  cartHud,
}: {
  children: React.ReactNode
  cartHud?: React.ReactNode
}) {
  const footerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const footer = footerRef.current
    if (!footer) return

    const documentRoot = document.documentElement
    const desktopFooter = window.matchMedia("(min-width: 640px)")
    const updateFooterHeight = () => {
      const height = desktopFooter.matches
        ? Math.ceil(footer.getBoundingClientRect().height)
        : 0
      documentRoot.style.setProperty(
        "--market-fixed-footer-height",
        `${height}px`
      )
    }

    updateFooterHeight()
    documentRoot.style.scrollPaddingBottom =
      "calc(var(--market-hud-height, 0px) + var(--market-fixed-footer-height, 0px) + 1.5rem)"
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateFooterHeight)
    observer?.observe(footer)
    if (typeof desktopFooter.addEventListener === "function") {
      desktopFooter.addEventListener("change", updateFooterHeight)
    } else {
      desktopFooter.addListener(updateFooterHeight)
    }

    return () => {
      observer?.disconnect()
      if (typeof desktopFooter.removeEventListener === "function") {
        desktopFooter.removeEventListener("change", updateFooterHeight)
      } else {
        desktopFooter.removeListener(updateFooterHeight)
      }
      documentRoot.style.removeProperty("--market-fixed-footer-height")
      documentRoot.style.removeProperty("scroll-padding-bottom")
    }
  }, [])

  return (
    <div
      className="flex min-h-screen min-w-0 flex-col overflow-x-hidden"
      style={{
        paddingBottom:
          "calc(var(--market-hud-height, 0px) + var(--market-fixed-footer-height, 0px) + max(1.5rem, env(safe-area-inset-bottom)))",
      }}
    >
      <MarketHeader />
      <main className="mx-auto min-w-0 w-full max-w-7xl flex-1 px-4 pb-12 pt-6">
        {children}
      </main>
      <LegalFooter
        footerRef={footerRef}
        aboutLink={
          <Link
            to="/about"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            About
          </Link>
        }
      />
      {cartHud}
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
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
  const { authUrl, dismissAuthUrl, method, status } = useAuth()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const appLoadTelemetrySentRef = useRef(false)
  const previousAuthStatusRef = useRef(status)
  const previousAuthMethodRef = useRef(method)

  useEffect(() => installBrowserClientErrorTelemetry("market"), [])

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
          method: method ?? "nip07",
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
          method: previousAuthMethodRef.current ?? "nip07",
          status: "success",
        },
      })
    }
    previousAuthStatusRef.current = status
    if (method) previousAuthMethodRef.current = method
  }, [method, status])

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

  throwSyntheticClientErrorForTelemetryTest()

  return (
    <RootShell cartHud={<MarketCartHud pathname={pathname} />}>
      <Outlet />
      {authUrl && (
        <SignerAuthUrlNotice authUrl={authUrl} onDismiss={dismissAuthUrl} />
      )}
    </RootShell>
  )
}

function throwSyntheticClientErrorForTelemetryTest(): void {
  if (
    import.meta.env.MODE === "mock" &&
    import.meta.env.VITE_ENABLE_TELEMETRY_TEST_HOOKS === "true" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get(
      "__conduit_telemetry_test"
    ) === "react_error_boundary"
  ) {
    throw new TypeError("Synthetic client error telemetry test")
  }
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
  if (pathname === "/zapouts") {
    return "Zapouts"
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
  useEffect(() => {
    recordBrowserClientError({
      app: "market",
      error,
      source: "react_error_boundary",
    })
  }, [error])

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
