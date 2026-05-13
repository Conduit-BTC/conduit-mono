import {
  createRootRoute,
  Outlet,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect } from "react"
import { buildBugReportUrl } from "@conduit/core"
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
      <footer className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-5">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 text-sm text-[var(--text-secondary)] sm:flex-row sm:items-center sm:justify-between">
          <ReportBugLink />
          <span className="max-w-2xl text-xs leading-5 text-[var(--text-muted)]">
            Do not include private keys, wallet secrets, payment credentials, or
            sensitive personal information.
          </span>
        </div>
      </footer>
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
  if (pathname === "/settings") {
    return "Relay Settings"
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
