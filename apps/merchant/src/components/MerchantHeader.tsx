import {
  Bell,
  Bitcoin,
  Grid2x2,
  Menu,
  Package,
  Search,
  ShoppingBag,
  Truck,
  UserRound,
  Wifi,
} from "lucide-react"
import type { ComponentType } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  config,
  getProfileDisplayLabel,
  useAuth,
  useProfile,
} from "@conduit/core"
import {
  Badge,
  Button,
  Input,
  ProfileSelector,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  cn,
} from "@conduit/ui"
import { SignerSwitch } from "./SignerSwitch"
import { useMerchantReadiness } from "../hooks/useMerchantReadiness"

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

type NavItem = {
  to: NavRoute
  label: string
  icon: ComponentType<{ className?: string }>
  /** If true, this nav item has readiness that can be incomplete */
  hasReadiness?: boolean
}

const mainNavItems: NavItem[] = [
  { to: "/", label: "Home", icon: Grid2x2 },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/products", label: "Products", icon: Package },
]

const setupNavItems: NavItem[] = [
  { to: "/profile", label: "Profile", icon: UserRound, hasReadiness: true },
  { to: "/payments", label: "Payments", icon: Bitcoin, hasReadiness: true },
  { to: "/shipping", label: "Shipping", icon: Truck, hasReadiness: true },
  { to: "/network", label: "Network", icon: Wifi, hasReadiness: true },
]

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

function UserMenu() {
  const { pubkey, status, disconnect } = useAuth()
  const navigate = useNavigate()
  const profileQuery = useProfile(pubkey)
  const profile = profileQuery.data
  const readiness = useMerchantReadiness()

  if (!pubkey || status !== "connected") return null

  const displayName = getProfileDisplayLabel(profile, pubkey, {
    lookupSettled: !profileQuery.isPlaceholderData,
    pendingLabel: "Loading profile",
    chars: 6,
  })

  return (
    <ProfileSelector
      displayName={displayName}
      avatarUrl={profile?.picture}
      avatarFallback={<MerchantAvatarFallback iconClassName="h-4 w-4" />}
      alertLabel={readiness.setupComplete ? undefined : "Needs completion"}
      onProfile={() => navigate({ to: "/profile" })}
      onNetwork={() => navigate({ to: "/network" })}
      onDisconnect={disconnect}
      className="h-12 min-w-[12.75rem] rounded-[16px] px-3"
    />
  )
}

// ---------------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------------

function MobileNav() {
  const { pubkey, status } = useAuth()
  const readiness = useMerchantReadiness()

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
        className="w-[320px] border-r border-[var(--border)] bg-[var(--surface-dialog)]"
      >
        <SheetHeader>
          <SheetTitle>
            <Logo variant="full" className="justify-start" />
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <MerchantNavLinks
            compact
            profileIncomplete={!readiness.profileComplete}
            paymentsIncomplete={!readiness.paymentsComplete}
            shippingIncomplete={!readiness.shippingComplete}
            networkIncomplete={!readiness.networkComplete}
          />

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
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
            {status === "connected" && pubkey ? <UserMenu /> : <SignerSwitch />}
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
  const readiness = useMerchantReadiness()

  return (
    <aside className="hidden h-screen min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
      <div className="shrink-0 border-b border-[var(--border)] px-5 py-5">
        <Logo />
        {config.lightningNetwork !== "mainnet" && (
          <Badge
            variant="secondary"
            className={cn(
              "mt-4 border",
              config.lightningNetwork === "mock"
                ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]"
                : "border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]"
            )}
          >
            {config.lightningNetwork}
          </Badge>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5">
        <MerchantNavLinks
          profileIncomplete={!readiness.profileComplete}
          paymentsIncomplete={!readiness.paymentsComplete}
          shippingIncomplete={!readiness.shippingComplete}
          networkIncomplete={!readiness.networkComplete}
        />
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function MerchantHeader() {
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_84%,transparent)] backdrop-blur">
      <div className="flex h-20 items-center gap-3 px-4 sm:px-6">
        <MobileNav />

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <Input
            className="h-12 rounded-2xl border-[var(--border)] bg-[var(--surface-elevated)] pl-11 pr-4 text-sm shadow-[var(--shadow-glass-inset)]"
            placeholder="Search products, orders, or buyers"
            aria-label="Search merchant portal"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-11 w-11 rounded-xl sm:inline-flex"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
          </Button>
          <div className="hidden lg:block">
            {signerConnected ? <UserMenu /> : <SignerSwitch />}
          </div>
        </div>
      </div>
    </header>
  )
}
