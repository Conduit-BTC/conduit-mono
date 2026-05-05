import { Bell, Grid2x2, Menu, Package, Search, ShoppingBag } from "lucide-react"
import type { ComponentType } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { config, formatPubkey, useAuth, useProfile } from "@conduit/core"
import {
  AccountMenu,
  Badge,
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  cn,
} from "@conduit/ui"
import { SignerSwitch } from "./SignerSwitch"

type NavItem = {
  to: "/" | "/orders" | "/products"
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: "/", label: "Home", icon: Grid2x2 },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/products", label: "Products", icon: Package },
]

function MerchantAvatarFallback({
  iconClassName = "h-4 w-4",
}: {
  iconClassName?: string
}) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]">
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
      <span className="hidden border-l border-[var(--border)] pl-3 font-display text-2xl font-medium tracking-tight text-[var(--text-primary)] md:block">
        merchant
      </span>
    </Link>
  )
}

function MerchantNavLinks({
  onNavigate,
  compact = false,
}: {
  onNavigate?: () => void
  compact?: boolean
}) {
  return (
    <nav className={cn("grid gap-1.5", compact ? "gap-1" : "gap-1.5")}>
      {navItems.map((item) => {
        const Icon = item.icon
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]",
              compact ? "px-3 py-2" : ""
            )}
            activeProps={{
              className:
                "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]",
            }}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function UserMenu() {
  const { pubkey, status, disconnect } = useAuth()
  const navigate = useNavigate()
  const { data: profile } = useProfile(pubkey)

  if (!pubkey || status === "disconnected" || status === "error") return null

  const displayName =
    profile?.displayName ?? profile?.name ?? formatPubkey(pubkey, 6)

  return (
    <AccountMenu
      variant="panel"
      displayName={displayName}
      pubkeyLabel={formatPubkey(pubkey, 12)}
      avatarUrl={profile?.picture}
      fallback={<MerchantAvatarFallback iconClassName="h-4 w-4" />}
      onProfile={() => navigate({ to: "/profile" })}
      onNetwork={() => navigate({ to: "/settings" })}
      onDisconnect={disconnect}
    />
  )
}

function MobileNav() {
  const { pubkey, status } = useAuth()

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
        className="w-[320px] border-r border-[var(--border)] bg-[var(--surface)]"
      >
        <SheetHeader>
          <SheetTitle>
            <Logo variant="full" className="justify-start" />
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <MerchantNavLinks compact />

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
            {config.lightningNetwork !== "mainnet" && (
              <Badge
                variant="secondary"
                className={cn(
                  "mb-3 border",
                  config.lightningNetwork === "mock"
                    ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                    : "border-blue-500/30 bg-blue-500/10 text-blue-400"
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

export function MerchantSidebar() {
  return (
    <aside className="hidden h-screen flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
      <div className="border-b border-[var(--border)] px-5 py-5">
        <Logo />
        {config.lightningNetwork !== "mainnet" && (
          <Badge
            variant="secondary"
            className={cn(
              "mt-4 border",
              config.lightningNetwork === "mock"
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                : "border-blue-500/30 bg-blue-500/10 text-blue-400"
            )}
          >
            {config.lightningNetwork}
          </Badge>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 py-5">
        <MerchantNavLinks />
      </div>
    </aside>
  )
}

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
