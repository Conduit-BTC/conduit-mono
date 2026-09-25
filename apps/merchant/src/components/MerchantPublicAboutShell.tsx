import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { useEffect, type ReactNode } from "react"

import { installBrowserClientErrorTelemetry } from "@conduit/core"

import { MerchantBrandLockup } from "./MerchantHeader"

const SHOW_DEVTOOLS =
  import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true"

export function MerchantPublicAboutShell({
  children,
  pageTitle = "About",
}: {
  children: ReactNode
  pageTitle?: string
}) {
  useEffect(() => installBrowserClientErrorTelemetry("merchant"), [])

  useEffect(() => {
    document.title = `${pageTitle} | Conduit Merchant`
  }, [pageTitle])

  return (
    <div className="min-h-dvh bg-[var(--background)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex w-full max-w-[1280px] items-center px-4 py-4 sm:px-6 lg:px-8">
          <a
            href="/"
            aria-label="Conduit Merchant home"
            className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <MerchantBrandLockup />
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
            aria-current={pageTitle === "About" ? "page" : undefined}
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
