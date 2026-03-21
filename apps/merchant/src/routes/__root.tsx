import { createRootRoute, Outlet, useRouterState, type ErrorComponentProps } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { KeyRound, ShieldCheck, Store } from "lucide-react"
import { useEffect } from "react"
import type { ReactNode } from "react"
import { useAuth } from "@conduit/core"
import { MerchantHeader, MerchantSidebar } from "../components/MerchantHeader"
import { Badge, Button, ErrorPage, NotFoundPage } from "@conduit/ui"
import { SignerSwitch } from "../components/SignerSwitch"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#090512]">
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
        <MerchantSidebar />
        <div className="min-h-screen">
          <MerchantHeader />
          <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="mx-auto w-full max-w-[1280px]">
              {children}
            </div>
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

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" })
  }, [pathname])

  useEffect(() => {
    const title = signerConnected ? getPageTitle(pathname) : "Connect"
    document.title = `${title} | Conduit Merchant`
  }, [pathname, signerConnected])

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
    <RootShell>
      <ErrorPage
        title="Something went wrong"
        message={error.message || "An unexpected error occurred."}
        showReload
      />
    </RootShell>
  )
}

function RootNotFound() {
  return (
    <RootShell>
      <NotFoundPage backTo="/" backLabel="Go to dashboard" />
    </RootShell>
  )
}

function ConnectGate() {
  const { status } = useAuth()

  return (
    <div className="min-h-screen bg-[#090512]">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1.1fr)_420px]">
          <section className="rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(255,86,164,0.14),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] sm:p-8 lg:p-10">
            <Badge className="border-white/10 bg-white/[0.06] text-[var(--text-primary)]">
              Merchant Portal
            </Badge>
            <h1 className="mt-5 max-w-xl text-4xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              Connect your signer to run your store
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--text-secondary)] sm:text-base">
              Manage listings, receive orders, and continue buyer conversations from one merchant workspace.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.04] p-4">
                <Store className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-medium text-[var(--text-primary)]">Publish listings</div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                  Create and manage products tied to your signer.
                </div>
              </div>
              <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.04] p-4">
                <KeyRound className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-medium text-[var(--text-primary)]">Own your identity</div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                  Use an external signer instead of creating another account.
                </div>
              </div>
              <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.04] p-4">
                <ShieldCheck className="h-5 w-5 text-secondary-300" />
                <div className="mt-3 text-sm font-medium text-[var(--text-primary)]">Stay in the loop</div>
                <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                  Track orders, invoices, and buyer messages in one place.
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] sm:p-7">
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">Get started</div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
              Merchant access requires a signer
            </h2>
            <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
              Conduit currently uses external signers only. Connect with a supported signer to open the merchant workspace.
            </p>

            <div className="mt-6">
              <SignerSwitch />
            </div>

            <div className="mt-5 rounded-[1.25rem] border border-white/10 bg-white/[0.04] p-4 text-sm leading-7 text-[var(--text-secondary)]">
              {status === "connecting"
                ? "Waiting for your signer approval..."
                : "If you are on mobile, use a browser or signer flow that already exposes a supported Nostr signer."}
            </div>

            <div className="mt-5">
              <Button
                variant="ghost"
                className="h-auto px-0 text-sm text-[var(--text-secondary)] hover:bg-transparent hover:text-[var(--text-primary)]"
                disabled
              >
                External signers only for now
              </Button>
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
  return "Merchant"
}
