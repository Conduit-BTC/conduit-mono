import {
  createRootRoute,
  Link,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
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
  isProductLegalPath,
} from "@conduit/ui"
import {
  MarketHeader,
  type MarketChromeState,
} from "../components/MarketHeader"
import { MarketCartHud } from "../components/MarketCartHud"
import { EventActorIdentityProvider } from "../hooks/useEventActorIdentity"
import { usePendingEventPickupCartResolution } from "../hooks/usePendingEventPickupCartResolution"

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
  const chromeState = useMarketChromeState()
  const mobileChromeHidden =
    useIsMobileMarketViewport() && chromeState === "hidden"
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const reportBugHref = useMarketBugReportUrl()
  const [footerHeight, setFooterHeight] = useState(0)

  useLayoutEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    const documentRoot = document.documentElement

    const updateFooterHeight = () => {
      const height = Math.ceil(footer.getBoundingClientRect().height)
      setFooterHeight(height)
      documentRoot.style.setProperty(
        "--market-fixed-footer-height",
        `${height}px`
      )
    }

    updateFooterHeight()
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateFooterHeight)
    observer?.observe(footer)
    return () => {
      observer?.disconnect()
      documentRoot.style.removeProperty("--market-fixed-footer-height")
    }
  }, [])

  useEffect(() => {
    const documentRoot = document.documentElement
    documentRoot.style.scrollPaddingBottom = `calc(var(--market-hud-height, 0px) + ${footerHeight}px + 1.5rem)`
    return () => {
      documentRoot.style.removeProperty("scroll-padding-bottom")
    }
  }, [footerHeight])

  return (
    <div
      className="flex min-h-screen min-w-0 flex-col overflow-x-clip"
      style={
        {
          "--market-footer-hidden-shift": mobileChromeHidden
            ? `${footerHeight}px`
            : "0px",
          paddingBottom:
            "calc(var(--market-hud-height, 0px) + var(--market-fixed-footer-height, 0px) + max(1.5rem, env(safe-area-inset-bottom)))",
        } as React.CSSProperties
      }
    >
      <MarketHeader chromeState={chromeState} />
      <main className="mx-auto min-w-0 w-full max-w-7xl flex-1 px-4 pb-12 pt-6">
        {children}
      </main>
      <LegalFooter
        ref={footerRef}
        aboutLink={
          <Link
            to="/about"
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            About
          </Link>
        }
        activeHref={pathname}
        reportBugHref={reportBugHref}
        hidden={mobileChromeHidden}
      />
      {cartHud}
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
    </div>
  )
}

function useMarketChromeState(): MarketChromeState {
  const [chromeState, setChromeState] = useState<MarketChromeState>(() =>
    typeof window !== "undefined" && window.scrollY > 12 ? "scrolled" : "top"
  )

  useEffect(() => {
    let lastScrollY = Math.max(0, window.scrollY)
    let downwardTravel = 0
    let ticking = false

    const updateChromeState = (): void => {
      const currentY = Math.max(0, window.scrollY)
      const delta = currentY - lastScrollY

      if (currentY <= 12) {
        downwardTravel = 0
        setChromeState("top")
      } else if (delta < 0) {
        downwardTravel = 0
        setChromeState("scrolled")
      } else if (delta > 0) {
        downwardTravel += delta
        if (downwardTravel >= 8) setChromeState("hidden")
      }

      lastScrollY = currentY
      ticking = false
    }

    const onScroll = (): void => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(updateChromeState)
    }

    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return chromeState
}

function useIsMobileMarketViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(max-width: 639px)").matches
  )

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 639px)")
    const updateMobileViewport = () => setIsMobile(mobileViewport.matches)
    updateMobileViewport()
    mobileViewport.addEventListener("change", updateMobileViewport)
    return () =>
      mobileViewport.removeEventListener("change", updateMobileViewport)
  }, [])

  return isMobile
}

function ReportBugLink({ className }: { className?: string }) {
  const bugReportUrl = useMarketBugReportUrl()

  return (
    <a
      href={bugReportUrl}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
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
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (isProductLegalPath(pathname)) return <Outlet />

  return <MarketProductRoot pathname={pathname} />
}

function MarketProductRoot({ pathname }: { pathname: string }) {
  const { authUrl, dismissAuthUrl, method, status } = useAuth()
  usePendingEventPickupCartResolution()
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
    <EventActorIdentityProvider>
      <RootShell cartHud={<MarketCartHud pathname={pathname} />}>
        <Outlet />
        {authUrl && (
          <SignerAuthUrlNotice authUrl={authUrl} onDismiss={dismissAuthUrl} />
        )}
      </RootShell>
    </EventActorIdentityProvider>
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
    return "Products"
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
  if (pathname === "/preferences") {
    return "Preferences"
  }
  if (pathname === "/network") {
    return "Relay Settings"
  }
  if (pathname === "/wallet") {
    return "Wallets"
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
  if (pathname === "/events" || pathname === "/events/") {
    return "Events"
  }
  if (pathname.startsWith("/events/")) {
    return "Event"
  }
  if (pathname === "/merchants" || pathname === "/sellers") {
    return "Merchants"
  }
  if (pathname.startsWith("/store/")) {
    return "Merchant"
  }
  return "Not Found"
}

function RootErrorComponent({ error }: ErrorComponentProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (isProductLegalPath(pathname)) {
    return (
      <div className="min-h-dvh bg-[var(--background)] px-4 py-12 text-[var(--text-primary)]">
        <ErrorPage
          title="This legal page could not be displayed"
          message="Reload the page. If the problem continues, use the canonical Shop legal URL."
          showReload
        />
      </div>
    )
  }

  return <MarketProductRootError error={error} />
}

function MarketProductRootError({ error }: { error: Error }) {
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
