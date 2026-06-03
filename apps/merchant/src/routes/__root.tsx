import {
  createRootRoute,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { KeyRound } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useAuth, useNip07Availability } from "@conduit/core"
import {
  ErrorPage,
  LegalFooter,
  NotFoundPage,
  SignerConnectPanel,
} from "@conduit/ui"
import {
  MerchantMobileNav,
  MerchantSidebar,
} from "../components/MerchantHeader"
import { MerchantReadinessProvider } from "../hooks/useMerchantReadinessContext"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

const AUTH_GATE_GRACE_MS = 650

function RootShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)] lg:h-screen lg:overflow-hidden">
      <MerchantReadinessProvider>
        <div className="lg:grid lg:h-full lg:grid-cols-[260px_minmax(0,1fr)]">
          <MerchantSidebar />
          <div className="min-h-screen lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            <div className="fixed left-4 top-4 z-40 lg:hidden">
              <MerchantMobileNav />
            </div>
            <main
              data-merchant-main-scroll
              className="px-4 pb-28 pt-20 sm:px-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:pb-28 lg:pt-8"
            >
              <div className="mx-auto w-full max-w-[1280px]">{children}</div>
            </main>
            <LegalFooter className="lg:left-[260px]" />
          </div>
        </div>
      </MerchantReadinessProvider>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function RootLayout() {
  const { pubkey, status } = useAuth()
  const [authFallbackReady, setAuthFallbackReady] = useState(false)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const signerConnected = status === "connected" && !!pubkey
  const signerRestoring =
    !!pubkey && (status === "restoring" || status === "connecting")
  const shouldDelayAuthFallback =
    !!pubkey && !signerConnected && !authFallbackReady

  useEffect(() => {
    if (!pubkey || signerConnected) {
      setAuthFallbackReady(false)
      return
    }

    const timeoutId = window.setTimeout(() => {
      setAuthFallbackReady(true)
    }, AUTH_GATE_GRACE_MS)

    return () => window.clearTimeout(timeoutId)
  }, [pubkey, signerConnected])

  useEffect(() => {
    document
      .querySelector<HTMLElement>("[data-merchant-main-scroll]")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" })
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [pathname])

  useEffect(() => {
    const title =
      signerConnected || signerRestoring ? getPageTitle(pathname) : "Connect"
    document.title = `${title} | Conduit Merchant`
  }, [pathname, signerConnected, signerRestoring])

  if (shouldDelayAuthFallback) {
    return <AuthGateGrace />
  }

  if (signerRestoring) {
    return (
      <RootShell>
        <AuthRestoring />
      </RootShell>
    )
  }

  if (!signerConnected) {
    return <ConnectGate />
  }

  return (
    <RootShell>
      <Outlet />
    </RootShell>
  )
}

function AuthGateGrace() {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)]">
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function AuthRestoring() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] px-5 py-4 text-center shadow-sm">
        <KeyRound className="mx-auto h-5 w-5 animate-pulse text-secondary-300" />
        <div className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
          Restoring signer
        </div>
        <div className="mt-1 text-sm text-[var(--text-secondary)]">
          Waiting for your browser extension.
        </div>
      </div>
    </div>
  )
}

function RootErrorComponent({ error }: ErrorComponentProps) {
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey
  const errorPage = (
    <ErrorPage
      title="Something went wrong"
      message={error.message || "An unexpected error occurred."}
      showReload
    />
  )

  if (!signerConnected) return errorPage

  return <RootShell>{errorPage}</RootShell>
}

function RootNotFound() {
  return <NotFoundPage backTo="/" backLabel="Go to dashboard" />
}

function ConnectGate() {
  const { status, connect, error } = useAuth()
  const [isWorking, setIsWorking] = useState(false)
  const extensionAvailable = useNip07Availability()
  const authPending = status === "connecting" || status === "restoring"
  const isProbablyMobileBrowser = useMemo(() => {
    if (typeof navigator === "undefined") return false
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
  }, [])
  const mobileSignerUnavailable =
    isProbablyMobileBrowser && !extensionAvailable && status !== "connected"

  async function handleConnect(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await connect()
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--background)] pb-24 text-[var(--text-primary)] sm:pb-16">
      <main className="mx-auto flex min-h-dvh w-full max-w-4xl items-center justify-center px-4 pb-20 pt-8 sm:px-6 lg:px-8">
        <SignerConnectPanel
          title={
            mobileSignerUnavailable
              ? "Signer unavailable here"
              : "Connect a signer"
          }
          description={
            mobileSignerUnavailable
              ? "This browser does not expose a supported Nostr signer."
              : "Use your Nostr signer to open your merchant workspace."
          }
          helperText={
            mobileSignerUnavailable
              ? "Try a desktop browser with a signer extension, or a mobile browser that already exposes one."
              : "Conduit currently supports external signers only."
          }
          unlockLabel="UNLOCK YOUR COMMAND CENTER"
          unlockItems={[
            "Create your store and start publishing products.",
            "Handle orders, customer messages, and product comments from one workspace.",
            "Sell through Conduit, your own storefront, and the wider Nostr network.",
          ]}
          error={error}
          mobileSignerUnavailable={mobileSignerUnavailable}
          connectPending={authPending || isWorking}
          connectDisabled={isWorking || authPending}
          className="w-full max-w-xl"
          onConnect={handleConnect}
        />
      </main>
      <LegalFooter />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function getPageTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard"
  if (pathname === "/products") return "Products"
  if (pathname === "/orders") return "Orders"
  if (pathname === "/profile") return "Profile"
  if (pathname === "/payments") return "Payments"
  if (pathname === "/shipping") return "Shipping"
  if (pathname === "/network") return "Network"
  return "Not Found"
}
