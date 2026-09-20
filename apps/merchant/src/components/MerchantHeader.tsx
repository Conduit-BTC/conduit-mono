import { Link, useRouterState } from "@tanstack/react-router"
import {
  Bug,
  CalendarDays,
  ChevronDown,
  CreditCard,
  ExternalLink,
  FileText,
  Info,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  ShoppingBag,
  ShieldCheck,
  Store,
  Truck,
  UserRound,
  Wifi,
} from "lucide-react"
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"

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

import { useMerchantReadinessState } from "../hooks/useMerchantReadinessContext"
import { SignerSwitch } from "./SignerSwitch"

type CommerceNavRoute =
  | "/"
  | "/products"
  | "/events"
  | "/orders"
  | "/payments"
  | "/shipping"
  | "/messages"

type CommerceNavItem = {
  to: CommerceNavRoute
  label: string
  icon: ComponentType<{ className?: string }>
  hasReadiness?: boolean
}

const commerceNavItems: CommerceNavItem[] = [
  { to: "/", label: "Home", icon: Store },
  { to: "/products", label: "Products", icon: Package },
  { to: "/events", label: "Events", icon: CalendarDays },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/payments", label: "Payments", icon: CreditCard, hasReadiness: true },
  { to: "/shipping", label: "Shipping", icon: Truck, hasReadiness: true },
  { to: "/messages", label: "Messages", icon: MessageCircle },
]

const navItemClassName =
  "group relative flex min-h-10 items-center gap-3 rounded-xl border border-transparent px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"

function MerchantAvatarFallback() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-[var(--avatar-bg)]">
      <img
        src="/images/logo/logo-icon.svg"
        alt=""
        aria-hidden="true"
        className="h-4 w-auto rotate-180 select-none object-contain brightness-0 invert"
        draggable="false"
      />
    </span>
  )
}

export function MerchantBrandLockup({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-3 select-none",
        className
      )}
    >
      <span className="inline-flex h-8 shrink-0 items-center">
        <img
          src="/images/logo/logo-full.svg"
          alt="Conduit"
          width={386}
          height={115}
          className="hidden h-8 w-[6.75rem] shrink-0 object-contain min-[400px]:block"
          draggable="false"
        />
        <span className="h-8 w-6 shrink-0 overflow-hidden min-[400px]:hidden">
          <img
            src="/images/logo/logo-full.svg"
            alt="Conduit"
            width={386}
            height={115}
            className="h-8 w-[6.75rem] max-w-none object-left"
            draggable="false"
          />
        </span>
      </span>
      <span className="shrink-0 border-l border-[var(--border)] pl-3 pr-1 font-display text-xl font-medium text-[var(--text-primary)]">
        merchant
      </span>
    </span>
  )
}

function MerchantLogoLink() {
  return (
    <Link
      to="/"
      aria-label="Conduit Merchant home"
      className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <MerchantBrandLockup />
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

function CommerceNavLink({
  item,
  incomplete,
  onNavigate,
}: {
  item: CommerceNavItem
  incomplete: boolean
  onNavigate?: () => void
}) {
  const Icon = item.icon

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={navItemClassName}
      activeProps={{
        className:
          "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]",
      }}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {incomplete ? <IncompleteBadge className="ml-auto shrink-0" /> : null}
    </Link>
  )
}

function InformationNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="grid gap-1">
      <Link
        to="/about"
        onClick={onNavigate}
        className={navItemClassName}
        activeProps={{
          className:
            "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]",
        }}
      >
        <Info className="size-4 shrink-0" />
        <span>About</span>
      </Link>
      <a
        href="/terms-of-service"
        onClick={onNavigate}
        className={navItemClassName}
      >
        <FileText className="size-4 shrink-0" />
        <span>Terms</span>
      </a>
      <a
        href="/privacy-policy"
        onClick={onNavigate}
        className={navItemClassName}
      >
        <ShieldCheck className="size-4 shrink-0" />
        <span>Privacy</span>
      </a>
      <a
        href="https://conduit.market/"
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        onClick={onNavigate}
        className={navItemClassName}
      >
        <ExternalLink className="size-4 shrink-0" />
        <span>conduit.market</span>
      </a>
    </div>
  )
}

function MerchantNavLinks({
  onNavigate,
  paymentsIncomplete,
  shippingIncomplete,
}: {
  onNavigate?: () => void
  paymentsIncomplete: boolean
  shippingIncomplete: boolean
}) {
  return (
    <nav aria-label="Merchant navigation" className="grid gap-2">
      <div className="grid gap-1">
        {commerceNavItems.map((item) => (
          <CommerceNavLink
            key={item.to}
            item={item}
            incomplete={
              item.hasReadiness && item.to === "/payments"
                ? paymentsIncomplete
                : item.hasReadiness && item.to === "/shipping"
                  ? shippingIncomplete
                  : false
            }
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <div className="my-1 border-t border-[var(--border)]" />
      <InformationNavLinks onNavigate={onNavigate} />
    </nav>
  )
}

function NetworkBadge() {
  if (config.lightningNetwork === "mainnet") return null

  return (
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
  )
}

function AccountMenuLink({
  to,
  icon,
  children,
  onNavigate,
}: {
  to: "/profile" | "/network"
  icon: ReactNode
  children: ReactNode
  onNavigate: () => void
}) {
  return (
    <DropdownMenuItem
      asChild
      className="min-h-11 cursor-pointer rounded-xl px-3 py-2 text-[15px] font-medium text-[var(--text-primary)] focus:bg-[color-mix(in_srgb,var(--primary-500)_6%,transparent)] focus:text-[var(--text-primary)]"
    >
      <Link to={to} onClick={onNavigate}>
        <span className="mr-3 inline-flex size-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span>{children}</span>
      </Link>
    </DropdownMenuItem>
  )
}

export function MerchantAccountMenu() {
  const { pubkey, status, disconnect, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])

  const authenticatedPubkey = status === "connected" ? pubkey : null
  const profileQuery = useProfile(pubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
  })

  if (!pubkey || status !== "connected") return <SignerSwitch />

  const profile = profileQuery.data
  const displayName = getProfileDisplayLabel(profile, pubkey, {
    lookupSettled: !profileQuery.isPlaceholderData,
    pendingLabel: "Loading profile",
    chars: 6,
  })

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open merchant account menu"
          className="inline-flex h-12 items-center gap-3 rounded-[16px] bg-primary-500 px-3 text-left text-white transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 sm:min-w-[12.75rem]"
        >
          <Avatar className="size-8 shrink-0 border border-[color-mix(in_srgb,var(--on-primary)_24%,transparent)]">
            <AvatarImage
              src={profile?.picture ?? undefined}
              alt={displayName}
            />
            <AvatarFallback className="bg-[var(--avatar-bg)] text-[var(--on-primary)]">
              <MerchantAvatarFallback />
            </AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-1 sm:block">
            <span className="block truncate text-sm font-semibold">
              {displayName}
            </span>
            <span className="block truncate text-[11px] text-white/70">
              {formatNpub(pubkey, 12)}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-white/70 transition-transform duration-150",
              open && "rotate-180"
            )}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="w-[14rem] rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-overlay)] p-3 text-[var(--text-primary)] shadow-[var(--shadow-dialog)]"
      >
        <AccountMenuLink
          to="/profile"
          icon={<UserRound className="size-4" />}
          onNavigate={() => setOpen(false)}
        >
          Profile
        </AccountMenuLink>
        <AccountMenuLink
          to="/network"
          icon={<Wifi className="size-4" />}
          onNavigate={() => setOpen(false)}
        >
          Network
        </AccountMenuLink>
        <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />
        <DropdownMenuItem
          className="min-h-11 cursor-pointer rounded-xl px-3 py-2 text-[15px] font-medium text-[var(--error)] focus:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:text-[var(--error)]"
          onSelect={() => {
            setOpen(false)
            disconnect()
          }}
        >
          <LogOut className="mr-3 size-4" />
          <span>Disconnect</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ReportBugLink({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const bugReportUrl = buildBugReportUrl({ app: "merchant", route: pathname })

  return (
    <a
      href={bugReportUrl}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      onClick={onNavigate}
      className={navItemClassName}
    >
      <Bug className="size-4 shrink-0" />
      <span>Report a Bug</span>
    </a>
  )
}

export function MerchantMobileNav() {
  const readiness = useMerchantReadinessState()
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-md lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex h-dvh w-[min(320px,calc(100vw-1rem))] flex-col border-r border-[var(--border)] bg-[var(--surface-dialog)]"
      >
        <SheetHeader className="shrink-0 text-left">
          <SheetTitle className="text-left">
            <MerchantLogoLink />
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <MerchantNavLinks
            onNavigate={() => setOpen(false)}
            paymentsIncomplete={
              !readiness.paymentsComplete && !readiness.paymentsCheckPending
            }
            shippingIncomplete={
              !readiness.shippingComplete && !readiness.shippingCheckPending
            }
          />
          <NetworkBadge />
        </div>

        <div className="mt-4 shrink-0 border-t border-[var(--border)] pb-[max(0px,env(safe-area-inset-bottom))] pt-4">
          <ReportBugLink onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function MerchantSidebar() {
  const readiness = useMerchantReadinessState()

  return (
    <aside className="hidden h-dvh min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:flex">
      <div className="shrink-0 border-b border-[var(--border)] px-5 py-5">
        <MerchantLogoLink />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
        <MerchantNavLinks
          paymentsIncomplete={
            !readiness.paymentsComplete && !readiness.paymentsCheckPending
          }
          shippingIncomplete={
            !readiness.shippingComplete && !readiness.shippingCheckPending
          }
        />
        <NetworkBadge />
      </div>

      <div className="shrink-0 border-t border-[var(--border)] px-4 py-4">
        <ReportBugLink />
      </div>
    </aside>
  )
}
