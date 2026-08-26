import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect, type ReactNode } from "react"

const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"

export function MerchantPublicAboutShell({
  children,
}: {
  children: ReactNode
}) {
  useEffect(() => {
    document.title = "About | Conduit Merchant"
  }, [])

  return (
    <div className="min-h-dvh bg-[var(--background)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <a
            href="/"
            className="flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <img
              src="/images/logo/logo-full.svg"
              alt="Conduit"
              className="h-8 w-auto"
            />
            <span className="hidden border-l border-[var(--border)] pl-3 font-display text-lg font-medium text-[var(--text-primary)] sm:inline">
              merchant
            </span>
          </a>
          <a
            href="/"
            className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <span className="sm:hidden">Open workspace</span>
            <span className="hidden sm:inline">Open merchant workspace</span>
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        {children}
      </main>
      <footer className="border-t border-[var(--border)] px-4 py-6 text-sm text-[var(--text-secondary)]">
        <nav
          aria-label="Merchant information and legal documents"
          className="mx-auto flex w-full max-w-[1280px] flex-wrap justify-center gap-4"
        >
          <a
            href="/about"
            aria-current="page"
            className="rounded-sm underline underline-offset-4 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            About
          </a>
          <a
            href="/terms-of-service"
            className="rounded-sm underline underline-offset-4 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Terms
          </a>
          <a
            href="/privacy-policy"
            className="rounded-sm underline underline-offset-4 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Privacy
          </a>
        </nav>
      </footer>
      {SHOW_DEVTOOLS && <TanStackRouterDevtools />}
    </div>
  )
}
