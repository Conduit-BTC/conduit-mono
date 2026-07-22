import {
  createRootRoute,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { KeyRound } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  buildBugReportUrl,
  installBrowserClientErrorTelemetry,
  recordBrowserClientError,
  recordBrowserTelemetryEvent,
  recordBrowserTelemetryPageView,
  useAuth,
  useNip07Availability,
} from "@conduit/core"
import {
  ErrorPage,
  NotFoundPage,
  SignerAuthUrlNotice,
  SignerConnectPanel,
  isMobileSignerEnvironment,
} from "@conduit/ui"
import {
  MerchantMobileNav,
  MerchantSidebar,
} from "../components/MerchantHeader"
import { MerchantReadinessProvider } from "../hooks/useMerchantReadinessContext"
import { MerchantPaymentAutomationProvider } from "../hooks/useMerchantPaymentAutomation"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

const AUTH_GATE_GRACE_MS = 650
const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"

function RootShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)] lg:h-screen lg:overflow-hidden">
      <MerchantReadinessProvider>
        <MerchantPaymentAutomationProvider>
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
            </div>
          </div>
        </MerchantPaymentAutomationProvider>
      </MerchantReadinessProvider>
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
    </div>
  )
}

function RootLayout() {
  const { authUrl, dismissAuthUrl, pubkey, method, status } = useAuth()
  const [authFallbackReady, setAuthFallbackReady] = useState(false)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const appLoadTelemetrySentRef = useRef(false)
  const previousAuthStatusRef = useRef(status)
  const previousAuthMethodRef = useRef(method)
  const signerConnected = status === "connected" && !!pubkey
  const signerRestoring = !!pubkey && status === "restoring"
  const shouldDelayAuthFallback =
    !!pubkey && !signerConnected && !authFallbackReady

  useEffect(() => installBrowserClientErrorTelemetry("merchant"), [])

  useEffect(() => {
    if (appLoadTelemetrySentRef.current) return
    appLoadTelemetrySentRef.current = true
    recordBrowserTelemetryEvent({
      app: "merchant",
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
        app: "merchant",
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
        app: "merchant",
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

  useEffect(() => {
    recordBrowserTelemetryPageView({ app: "merchant", pathname })
  }, [pathname])

  if (shouldDelayAuthFallback) {
    return (
      <>
        <AuthGateGrace />
        {authUrl && (
          <SignerAuthUrlNotice authUrl={authUrl} onDismiss={dismissAuthUrl} />
        )}
      </>
    )
  }

  if (signerRestoring) {
    return (
      <RootShell>
        <AuthRestoring method={method} />
        {authUrl && (
          <SignerAuthUrlNotice authUrl={authUrl} onDismiss={dismissAuthUrl} />
        )}
      </RootShell>
    )
  }

  if (!signerConnected) {
    return <ConnectGate />
  }

  return (
    <RootShell>
      <Outlet />
      {authUrl && (
        <SignerAuthUrlNotice authUrl={authUrl} onDismiss={dismissAuthUrl} />
      )}
    </RootShell>
  )
}

function AuthGateGrace() {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)]">
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
    </div>
  )
}

function AuthRestoring({ method }: { method: "nip07" | "nip46" | null }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] px-5 py-4 text-center shadow-sm">
        <KeyRound className="mx-auto h-5 w-5 animate-pulse text-secondary-300" />
        <div className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
          Restoring signer
        </div>
        <div className="mt-1 text-sm text-[var(--text-secondary)]">
          {method === "nip46"
            ? "Reconnecting to your remote signer."
            : "Waiting for your browser extension."}
        </div>
      </div>
    </div>
  )
}

function RootErrorComponent({ error }: ErrorComponentProps) {
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey

  useEffect(() => {
    recordBrowserClientError({
      app: "merchant",
      error,
      source: "react_error_boundary",
    })
  }, [error])

  const errorPage = (
    <ErrorPage
      title="Something went wrong"
      message={error.message || "An unexpected error occurred."}
      showReload
    >
      <ReportBugAction />
    </ErrorPage>
  )

  if (!signerConnected) return errorPage

  return <RootShell>{errorPage}</RootShell>
}

function RootNotFound() {
  return <NotFoundPage backTo="/" backLabel="Go to dashboard" />
}

function ReportBugAction() {
  const bugReportUrl = useMerchantBugReportUrl()

  return (
    <div className="space-y-2 text-sm">
      <a
        href={bugReportUrl}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary-500 underline underline-offset-4 hover:text-primary-600"
      >
        Report a Bug
      </a>
      <p className="text-xs leading-5 text-[var(--text-muted)]">
        Do not include private keys, wallet secrets, payment credentials, or
        sensitive personal information.
      </p>
    </div>
  )
}

function useMerchantBugReportUrl(): string {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return buildBugReportUrl({ app: "merchant", route: pathname })
}

function ConnectGate() {
  const {
    status,
    method,
    connect,
    cancelConnect,
    disconnect,
    error,
    authUrl,
    nostrConnectUri,
    rememberedMethod,
  } = useAuth()
  const [isWorking, setIsWorking] = useState(false)
  const extensionAvailable = useNip07Availability()
  const authPending = status === "connecting" || status === "restoring"
  const isProbablyMobileBrowser = useMemo(isMobileSignerEnvironment, [])
  const extensionNotice =
    !extensionAvailable && !isProbablyMobileBrowser
      ? "No complete NIP-07 signer detected yet. Install or unlock a signer such as Alby or nos2x, then try Connect signer again."
      : null

  async function handleConnectExtension(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await connect({ method: "nip07" })
    } finally {
      setIsWorking(false)
    }
  }

  async function handleConnectRemote(bunkerUri: string): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await connect({ method: "nip46", nip46Flow: "bunker", bunkerUri })
    } finally {
      setIsWorking(false)
    }
  }

  async function handleConnectNostrConnect(): Promise<void> {
    if (authPending) return
    setIsWorking(true)
    try {
      await connect({ method: "nip46", nip46Flow: "nostrconnect" })
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--background)] pb-24 text-[var(--text-primary)] sm:pb-16">
      <main className="mx-auto flex min-h-dvh w-full max-w-4xl items-center justify-center px-4 pb-20 pt-8 sm:px-6 lg:px-8">
        <SignerConnectPanel
          title="Connect a signer"
          description="Use your Nostr signer to open your merchant workspace."
          helperText={
            isProbablyMobileBrowser
              ? "Connect a remote signer to continue securely on mobile."
              : "Choose a browser extension or remote signer."
          }
          unlockLabel="UNLOCK YOUR COMMAND CENTER"
          unlockItems={[
            "Create your store and start publishing products.",
            "Handle orders, customer messages, and product comments from one workspace.",
            "Sell through Conduit, your own storefront, and the wider Nostr network.",
          ]}
          error={error}
          authUrl={authUrl}
          nostrConnectUri={nostrConnectUri}
          rememberedMethod={rememberedMethod}
          connectingMethod={method}
          extensionNotice={extensionNotice}
          mobile={isProbablyMobileBrowser}
          extensionAvailable={extensionAvailable}
          connectPending={authPending || isWorking}
          connectDisabled={isWorking || authPending}
          className="w-full max-w-xl"
          onConnectExtension={handleConnectExtension}
          onConnectNostrConnect={handleConnectNostrConnect}
          onConnectRemote={handleConnectRemote}
          onCancelConnect={cancelConnect}
          onReconnect={() => connect({ mode: "restore" })}
          onForget={disconnect}
        />
      </main>
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
    </div>
  )
}

function getPageTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard"
  if (pathname === "/products") return "Products"
  if (pathname === "/orders") return "Orders"
  if (pathname === "/messages") return "Messages"
  if (pathname === "/profile") return "Profile"
  if (pathname === "/payments") return "Payments"
  if (pathname === "/shipping") return "Shipping"
  if (pathname === "/network") return "Network"
  if (pathname === "/about") return "About"
  return "Not Found"
}
