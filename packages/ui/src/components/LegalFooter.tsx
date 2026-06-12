import { CircleHelp, Github, type LucideIcon } from "lucide-react"
import { cn } from "../utils"

interface LegalFooterBaseIconLink {
  href: string
  label: string
}

export interface LegalFooterLucideIconLink extends LegalFooterBaseIconLink {
  icon: LucideIcon
  imageSrc?: never
}

export interface LegalFooterImageIconLink extends LegalFooterBaseIconLink {
  icon?: never
  imageSrc: string
}

export type LegalFooterIconLink =
  | LegalFooterLucideIconLink
  | LegalFooterImageIconLink

export interface LegalFooterProps {
  className?: string
  logoHref?: string
  logoSrc?: string
  aboutHref?: string
  privacyHref?: string
  termsHref?: string
  iconLinks?: LegalFooterIconLink[]
}

const DEFAULT_ICON_LINKS: LegalFooterIconLink[] = [
  {
    href: "https://github.com/Conduit-BTC/conduit-mono",
    label: "GitHub",
    icon: Github,
  },
  {
    href: "https://njump.me/npub1nkfqwlz7xkhhdaa3ekz88qqqk7a0ks7jpv9zdsv0u206swxjw9rq0g2svu",
    label: "Nostr",
    imageSrc: "/images/logo/nostr-n-logo-white.png",
  },
  {
    href: "https://github.com/Conduit-BTC/conduit-mono/issues",
    label: "Support",
    icon: CircleHelp,
  },
]

export function LegalFooter({
  className,
  logoHref = "https://conduit.market/",
  logoSrc = "/images/logo/logo-full.svg",
  aboutHref = "/about",
  privacyHref = "https://conduit.market/privacy-policy",
  termsHref = "https://conduit.market/terms-of-service",
  iconLinks = DEFAULT_ICON_LINKS,
}: LegalFooterProps) {
  const year = new Date().getFullYear()

  return (
    <footer
      className={cn(
        "fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[var(--text-secondary)] shadow-[0_-1px_0_color-mix(in_srgb,var(--foreground)_8%,transparent)]",
        className
      )}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-center gap-x-4 gap-y-1.5 sm:justify-between">
        <a
          href={logoHref}
          className="flex shrink-0 items-center"
          aria-label="Conduit landing page"
        >
          <img
            src={logoSrc}
            alt="Conduit"
            className="h-5 w-auto select-none object-contain"
            draggable="false"
          />
        </a>

        <p className="m-0 text-center text-[11px] leading-5 sm:text-xs">
          &copy; {year} Conduit
        </p>

        <nav
          className="flex items-center gap-3 text-[11px] font-medium sm:text-xs"
          aria-label="Legal links"
        >
          <a
            href={aboutHref}
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            About
          </a>
          <a
            href={termsHref}
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Terms
          </a>
          <a
            href={privacyHref}
            className="transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Privacy
          </a>
        </nav>

        <nav className="flex items-center gap-1.5" aria-label="Resource links">
          {iconLinks.map((link) => {
            return (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={link.label}
                title={link.label}
                className="grid size-8 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <LegalFooterIcon link={link} />
              </a>
            )
          })}
        </nav>
      </div>
    </footer>
  )
}

function LegalFooterIcon({ link }: { link: LegalFooterIconLink }) {
  if ("imageSrc" in link) {
    return (
      <img
        src={link.imageSrc}
        alt=""
        aria-hidden="true"
        className="size-4 select-none object-contain"
        draggable="false"
      />
    )
  }

  const Icon = link.icon
  return <Icon className="size-4" />
}
