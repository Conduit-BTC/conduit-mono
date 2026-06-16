import {
  ChevronDown,
  Check,
  CircleHelp,
  Copy,
  CreditCard,
  ExternalLink,
  GitFork,
  Info,
  LogOut,
  Menu,
  Package,
  ShoppingBag,
  Store,
  Truck,
  UserRound,
  Wifi,
} from "lucide-react"
import { useState, type ComponentType } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import {
  buildBugReportUrl,
  config,
  formatNpub,
  getProfileDisplayLabel,
  useAuth,
  useProfile,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  cn,
} from "@conduit/ui"
import { SignerSwitch } from "./SignerSwitch"
import { useMerchantReadinessState } from "../hooks/useMerchantReadinessContext"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NavRoute =
  | "/"
  | "/orders"
  | "/products"
  | "/profile"
  | "/payments"
  | "/shipping"
  | "/network"
  | "/about"

type NavItem = {
  to: NavRoute
  label: string
  icon: ComponentType<{ className?: string }>
  /** If true, this nav item has readiness that can be incomplete */
  hasReadiness?: boolean
}

const mainNavItems: NavItem[] = [
  { to: "/", label: "Home", icon: Store },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/products", label: "Products", icon: Package },
  { to: "/about", label: "About", icon: Info },
]

const setupNavItems: NavItem[] = [
  { to: "/profile", label: "Profile", icon: UserRound, hasReadiness: true },
  { to: "/payments", label: "Payments", icon: CreditCard, hasReadiness: true },
  { to: "/shipping", label: "Shipping", icon: Truck, hasReadiness: true },
  { to: "/network", label: "Network", icon: Wifi, hasReadiness: true },
]

type MerchantResourceLink = {
  label: string
  href: string
} & (
  | { icon: ComponentType<{ className?: string }>; imageSrc?: never }
  | { imageSrc: string; icon?: never }
)

const merchantResourceLinks: readonly MerchantResourceLink[] = [
  {
    label: "conduit.market",
    href: "https://conduit.market/",
    icon: ExternalLink,
  },
  {
    label: "GitHub",
    href: "https://github.com/Conduit-BTC/conduit-mono",
    icon: GitFork,
  },
  {
    label: "Support",
    href: "https://github.com/Conduit-BTC/conduit-mono/issues",
    icon: CircleHelp,
  },
  {
    label: "Nostr",
    href: "https://njump.me/npub1nkfqwlz7xkhhdaa3ekz88qqqk7a0ks7jpv9zdsv0u206swxjw9rq0g2svu",
    imageSrc: "/images/logo/nostr-n-logo-white.png",
  },
  {
    label: "Terms",
    href: "https://conduit.market/terms-of-service",
    icon: ExternalLink,
  },
  {
    label: "Privacy",
    href: "https://conduit.market/privacy-policy",
    icon: ExternalLink,
  },
] as const

// ---------------------------------------------------------------------------
// Avatar / logo helpers
// ---------------------------------------------------------------------------

function MerchantAvatarFallback({
  iconClassName = "h-4 w-4",
}: {
  iconClassName?: string
}) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full bg-[var(--avatar-bg)]">
      <img
        src="/images/logo/logo-icon.svg"
        alt=""
        aria-hidden="true"
        className={`${iconClassName} rotate-180 select-none object-contain brightness-0 invert`}
        draggable="false"
      />
    </div>
  )
}

function Logo({
  variant = "full",
  className,
}: {
  variant?: "full" | "bg" | "icon"
  className?: string
}) {
  const src =
    variant === "bg"
      ? "/images/logo/logo-full-bg.svg"
      : variant === "icon"
        ? "/images/logo/logo-icon.svg"
        : "/images/logo/logo-full.svg"

  return (
    <Link
      to="/"
      className={cn("flex items-center gap-3 select-none", className)}
    >
      <img src={src} alt="Conduit" className="h-8 w-auto" />
      <span className="hidden border-l border-[var(--border)] pl-3 pr-2 font-display text-xl font-medium tracking-tight text-[var(--text-primary)] md:block">
        merchant
      </span>
    </Link>
  )
}

function IncompleteBadge({ className }: { className?: string }) {
  return (
    <StatusPill variant="warning" className={cn("text-[10px]", className)}>
      Needs completion
    </StatusPill>
  )
}

// ---------------------------------------------------------------------------
// Nav links
// ---------------------------------------------------------------------------

function MerchantNavLinks({
  onNavigate,
  compact = false,
  paymentsIncomplete,
  profileIncomplete,
  shippingIncomplete,
  networkIncomplete,
}: {
  onNavigate?: () => void
  compact?: boolean
  profileIncomplete: boolean
  paymentsIncomplete: boolean
  shippingIncomplete: boolean
  networkIncomplete: boolean
}) {
  const setupIncompleteMap: Record<NavRoute, boolean> = {
    "/profile": profileIncomplete,
    "/payments": paymentsIncomplete,
    "/shipping": shippingIncomplete,
    "/network": networkIncomplete,
    "/about": false,
    "/": false,
    "/orders": false,
    "/products": false,
  }

  function renderItem(item: NavItem) {
    const Icon = item.icon
    const incomplete = item.hasReadiness ? setupIncompleteMap[item.to] : false

    return (
      <Link
        key={item.to}
        to={item.to}
        onClick={onNavigate}
        className={cn(
          "group relative flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] hover:text-[var(--text-primary)]",
          compact ? "px-3 py-2" : ""
        )}
        activeProps={{
          className:
            "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]",
        }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {compact ? (
          <>
            <span className="min-w-0 flex-1 truncate text-left">
              {item.label}
            </span>
            {incomplete && <IncompleteBadge className="ml-auto shrink-0" />}
          </>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="whitespace-nowrap">{item.label}</span>
            {incomplete && <IncompleteBadge className="ml-0" />}
          </span>
        )}
      </Link>
    )
  }

  return (
    <nav className={cn("grid gap-1.5", compact ? "gap-1" : "gap-1.5")}>
      {mainNavItems.map(renderItem)}
      <div className="my-1 border-t border-[var(--border)]" />
      <div className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Setup
      </div>
      {setupNavItems.map(renderItem)}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// UserMenu
// ---------------------------------------------------------------------------

function UserMenu({ className }: { className?: string } = {}) {
  const { pubkey, status, disconnect } = useAuth()
  const [npubCopied, setNpubCopied] = useState(false)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const profileQuery = useProfile(pubkey)
  const profile = profileQuery.data
  const readiness = useMerchantReadinessState()
  const bugReportUrl = buildBugReportUrl({ app: "merchant", route: pathname })

  if (!pubkey || status !== "connected") return null

  const displayName = getProfileDisplayLabel(profile, pubkey, {
    lookupSettled: !profileQuery.isPlaceholderData,
    pendingLabel: "Loading profile",
    chars: 6,
  })
  const npub = formatNpub(pubkey, 12)
  const fullNpub = formatNpub(pubkey)
  const setupIncomplete =
    !readiness.setupComplete && readiness.missingAreas.length > 0

  async function handleCopyNpub(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fullNpub)
      setNpubCopied(true)
      window.setTimeout(() => setNpubCopied(false), 1_200)
    } catch {
      setNpubCopied(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-12 min-w-[12.75rem] items-center gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--surface-elevated)] px-3 text-left text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
            className
          )}
        >
          <span className="relative shrink-0">
            <Avatar className="h-8 w-8 border border-[var(--border)]">
              <AvatarImage
                src={profile?.picture ?? undefined}
                alt={displayName}
              />
              <AvatarFallback className="bg-[var(--avatar-bg)] text-[var(--on-primary)]">
                <MerchantAvatarFallback iconClassName="h-4 w-4" />
              </AvatarFallback>
            </Avatar>
            {setupIncomplete ? (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-[var(--surface-elevated)] bg-[var(--warning)]"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {displayName}
            </span>
            <span className="block truncate text-[11px] text-[var(--text-secondary)]">
              {npub}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={12}
        className="w-[16rem] rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-overlay)] p-2 text-[var(--text-primary)] shadow-[var(--shadow-dialog)]"
      >
        <div className="px-2 py-2">
          <div className="text-sm font-semibold">{displayName}</div>
          <div className="mt-1 flex items-start gap-2">
            <div className="min-w-0 flex-1 break-all text-xs leading-5 text-[var(--text-secondary)]">
              {fullNpub}
            </div>
            <button
              type="button"
              aria-label={npubCopied ? "Npub copied" : "Copy npub"}
              title={npubCopied ? "Copied" : "Copy npub"}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void handleCopyNpub()
              }}
            >
              {npubCopied ? (
                <Check className="h-3.5 w-3.5 text-[var(--success)]" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          {setupIncomplete ? (
            <StatusPill variant="warning" className="mt-3 text-[10px]">
              Needs completion
            </StatusPill>
          ) : (
            <StatusPill variant="success" className="mt-3 text-[10px]">
              Ready to sell
            </StatusPill>
          )}
        </div>

        <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />

        {merchantResourceLinks.map((link) => {
          const Icon = "icon" in link ? link.icon : null

          return (
            <DropdownMenuItem
              key={link.href}
              asChild
              className="h-10 rounded-xl px-2 text-sm font-medium text-[var(--text-primary)] focus:bg-[var(--surface-elevated)]"
            >
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {"imageSrc" in link ? (
                  <img
                    src={link.imageSrc}
                    alt=""
                    aria-hidden="true"
                    className="mr-2 h-4 w-4 object-contain opacity-75"
                    draggable="false"
                  />
                ) : Icon ? (
                  <Icon className="mr-2 h-4 w-4 text-[var(--text-secondary)]" />
                ) : null}
                <span>{link.label}</span>
              </a>
            </DropdownMenuItem>
          )
        })}

        <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />

        <DropdownMenuItem
          className="h-10 rounded-xl px-2 text-sm font-medium text-[var(--text-primary)] focus:bg-[var(--surface-elevated)]"
          onSelect={() => {
            window.open(bugReportUrl, "_blank", "noopener,noreferrer")
          }}
        >
          <CircleHelp className="mr-2 h-4 w-4 text-[var(--text-secondary)]" />
          <span>Report a Bug</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />

        <DropdownMenuItem
          className="h-10 rounded-xl px-2 text-sm font-medium text-error focus:bg-[var(--surface-elevated)] focus:text-error"
          onSelect={disconnect}
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>Disconnect</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------------

export function MerchantMobileNav() {
  const { pubkey, status } = useAuth()
  const readiness = useMerchantReadinessState()

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 w-11 rounded-xl lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex h-dvh w-[320px] flex-col border-r border-[var(--border)] bg-[var(--surface-dialog)]"
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>
            <Logo variant="full" className="justify-start" />
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MerchantNavLinks
              compact
              profileIncomplete={
                !readiness.profileComplete && !readiness.profileCheckPending
              }
              paymentsIncomplete={
                !readiness.paymentsComplete && !readiness.paymentsCheckPending
              }
              shippingIncomplete={
                !readiness.shippingComplete && !readiness.shippingCheckPending
              }
              networkIncomplete={!readiness.networkComplete}
            />
          </div>

          <div className="mt-6 shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            {config.lightningNetwork !== "mainnet" && (
              <Badge
                variant="secondary"
                className={cn(
                  "mb-3 border",
                  config.lightningNetwork === "mock"
                    ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]"
                    : "border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]"
                )}
              >
                {config.lightningNetwork}
              </Badge>
            )}
            {status === "connected" && pubkey ? (
              <UserMenu className="w-full min-w-0" />
            ) : (
              <SignerSwitch />
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function MerchantSidebar() {
  const { pubkey, status } = useAuth()
  const readiness = useMerchantReadinessState()

  return (
    <aside className="hidden h-screen min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
      <div className="shrink-0 border-b border-[var(--border)] px-5 py-5">
        <Logo />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5">
        <MerchantNavLinks
          profileIncomplete={
            !readiness.profileComplete && !readiness.profileCheckPending
          }
          paymentsIncomplete={
            !readiness.paymentsComplete && !readiness.paymentsCheckPending
          }
          shippingIncomplete={
            !readiness.shippingComplete && !readiness.shippingCheckPending
          }
          networkIncomplete={!readiness.networkComplete}
        />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] px-4 py-4">
        {config.lightningNetwork !== "mainnet" && (
          <Badge
            variant="secondary"
            className={cn(
              "mb-3 border",
              config.lightningNetwork === "mock"
                ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]"
                : "border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]"
            )}
          >
            {config.lightningNetwork}
          </Badge>
        )}
        {status === "connected" && pubkey ? (
          <UserMenu className="w-full min-w-0" />
        ) : (
          <SignerSwitch />
        )}
      </div>
    </aside>
  )
}
