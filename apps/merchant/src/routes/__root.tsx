import {
  createRootRoute,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { KeyRound, ShieldCheck, Store } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  getActiveRelaySettingsScope,
  refreshNdkRelaySettings,
  useAuth,
  useNip07Availability,
} from "@conduit/core"
import { Button, ErrorPage, NotFoundPage } from "@conduit/ui"
import { MerchantHeader, MerchantSidebar } from "../components/MerchantHeader"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)] lg:h-screen lg:overflow-hidden">
      <div className="lg:grid lg:h-full lg:grid-cols-[260px_minmax(0,1fr)]">
        <MerchantSidebar />
        <div className="min-h-screen lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
          <MerchantHeader />
          <main
            data-merchant-main-scroll
            className="px-4 py-6 sm:px-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:py-8"
          >
            <div className="mx-auto w-full max-w-[1280px]">{children}</div>
          </main>
        </div>
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function RootLayout() {
  const { pubkey, status } = useAuth()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const signerConnected = status === "connected" && !!pubkey
  const relaySettingsScope = pubkey ? `merchant:${pubkey}` : "merchant"

  useEffect(() => {
    document
      .querySelector<HTMLElement>("[data-merchant-main-scroll]")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" })
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [pathname])

  useEffect(() => {
    const title = signerConnected ? getPageTitle(pathname) : "Connect"
    document.title = `${title} | Conduit Merchant`
  }, [pathname, signerConnected])

  useEffect(() => {
    if (getActiveRelaySettingsScope() === relaySettingsScope) return
    refreshNdkRelaySettings(relaySettingsScope)
  }, [relaySettingsScope])

  if (!signerConnected) {
    return <ConnectGate />
  }

  return (
    <RootShell>
      <Outlet />
    </RootShell>
  )
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
  return <NotFoundPage backTo="/" backLabel="Go to dashboard" />
}

function ConnectGate() {
  const { status, connect, error } = useAuth()
  const [isWorking, setIsWorking] = useState(false)
  const extensionAvailable = useNip07Availability()
  const isProbablyMobileBrowser = useMemo(() => {
    if (typeof navigator === "undefined") return false
    return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
  }, [])
  const mobileSignerUnavailable =
    isProbablyMobileBrowser && !extensionAvailable && status !== "connected"

  async function handleConnect(): Promise<void> {
    if (status === "connecting") return
    setIsWorking(true)
    try {
      await connect()
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--text-primary)]">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="w-full">
          <section className="rounded-[2rem] border border-[var(--border)] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_16%,transparent),transparent_38%),linear-gradient(180deg,color-mix(in_srgb,var(--surface)_88%,white_12%),var(--surface))] p-7 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_12%,transparent)] sm:p-8 lg:p-10">
            <div className="flex items-center gap-3">
              <img
                src="/images/logo/logo-full.svg"
                alt="Conduit"
                className="h-9 w-auto select-none object-contain"
                draggable="false"
              />
            </div>
            <h1 className="mt-6 max-w-xl text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              Connect your signer to run your store
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-6 text-[var(--text-primary)]/85 sm:text-base">
              Publish listings, manage orders, and stay in sync with buyers from
              one merchant workspace.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3 sm:gap-0">
              <div className="px-0 py-2 sm:px-5">
                <Store className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  Publish listings
                </div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-primary)]/80">
                  Create and manage products tied to your signer.
                </div>
              </div>
              <div className="px-0 py-2 sm:border-l sm:border-[var(--border)] sm:px-5">
                <KeyRound className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  Own your identity
                </div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-primary)]/80">
                  Use an external signer instead of another account.
                </div>
              </div>
              <div className="px-0 py-2 sm:border-l sm:border-[var(--border)] sm:px-5">
                <ShieldCheck className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
                  Stay in the loop
                </div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-primary)]/80">
                  Track orders, invoices, and buyer messages in one place.
                </div>
              </div>
            </div>

            <div className="mt-8 max-w-[28rem] border-t border-[var(--border)] pt-6">
              {!mobileSignerUnavailable && (
                <div className="mt-6">
                  <Button
                    onClick={() => void handleConnect()}
                    disabled={
                      isWorking ||
                      status === "connecting" ||
                      !extensionAvailable
                    }
                    className="h-12 w-full justify-center gap-2 text-base"
                  >
                    <KeyRound className="h-5 w-5" />
                    {status === "connecting" || isWorking
                      ? "Connecting..."
                      : "Connect signer"}
                  </Button>
                </div>
              )}

              <div className="mt-5 text-[15px] leading-6 text-[var(--text-primary)]/80">
                {mobileSignerUnavailable
                  ? "This mobile browser does not expose a supported Nostr signer here yet. Use a desktop browser with a signer extension, or a mobile browser that already exposes one."
                  : status === "connecting" || isWorking
                    ? "Waiting for your signer approval..."
                    : extensionAvailable
                      ? "Use your Nostr signer to open the merchant workspace."
                      : "No signer extension detected. Install a NIP-07 signer such as Alby or nos2x, then refresh and connect."}
              </div>

              {error && (
                <div className="mt-5 rounded-[1.25rem] border border-error/30 bg-error/10 p-4 text-[15px] leading-6 text-error">
                  {error}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function getPageTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard"
  if (pathname === "/products") return "Products"
  if (pathname === "/orders") return "Orders"
  if (pathname === "/profile") return "Profile"
  if (pathname === "/network") return "Network"
  return "Not Found"
}
