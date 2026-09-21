import { forwardRef, type ReactNode } from "react"
import { Bug } from "lucide-react"
import { cn } from "../utils"

export interface LegalFooterProps {
  className?: string
  aboutLink?: ReactNode
  aboutHref?: string
  activeHref?: string
  privacyHref?: string
  termsHref?: string
  reportBugHref: string
  hidden?: boolean
}

const footerLinkClassName =
  "transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"

function normalizeFooterHref(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? href
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

function CurrentFooterLink({ children }: { children: ReactNode }) {
  return (
    <span
      aria-current="page"
      className="cursor-default text-[var(--text-muted)]"
    >
      {children}
    </span>
  )
}

export const LegalFooter = forwardRef<HTMLElement, LegalFooterProps>(
  function LegalFooter(
    {
      className,
      aboutLink,
      aboutHref = "/about",
      activeHref,
      privacyHref = "/privacy-policy",
      termsHref = "/terms-of-service",
      reportBugHref,
      hidden = false,
    },
    ref
  ) {
    const isActive = (href: string) =>
      activeHref !== undefined &&
      normalizeFooterHref(activeHref) === normalizeFooterHref(href)

    return (
      <footer
        ref={ref}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--background)] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2 text-[var(--text-secondary)] shadow-[0_-1px_0_color-mix(in_srgb,var(--foreground)_8%,transparent)] transition-transform duration-200 ease-out motion-reduce:transition-none",
          hidden ? "translate-y-full" : "translate-y-0",
          className
        )}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-nowrap items-center justify-between gap-3 whitespace-nowrap text-[11px] font-medium sm:text-xs">
          <nav
            className="flex shrink-0 items-center gap-2.5 sm:gap-3"
            aria-label="Legal links"
          >
            {isActive(aboutHref) ? (
              <CurrentFooterLink>About</CurrentFooterLink>
            ) : (
              (aboutLink ?? (
                <a
                  href={aboutHref}
                  referrerPolicy="no-referrer"
                  rel="noopener noreferrer"
                  className={footerLinkClassName}
                >
                  About
                </a>
              ))
            )}
            {isActive(termsHref) ? (
              <CurrentFooterLink>Terms</CurrentFooterLink>
            ) : (
              <a
                href={termsHref}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer"
                className={footerLinkClassName}
              >
                Terms
              </a>
            )}
            {isActive(privacyHref) ? (
              <CurrentFooterLink>Privacy</CurrentFooterLink>
            ) : (
              <a
                href={privacyHref}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer"
                className={footerLinkClassName}
              >
                Privacy
              </a>
            )}
          </nav>
          <a
            href={reportBugHref}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className="inline-flex shrink-0 items-center gap-1.5 text-[var(--text-primary)] transition-colors hover:text-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <Bug className="size-4" aria-hidden="true" />
            <span>Report a Bug</span>
          </a>
        </div>
      </footer>
    )
  }
)
