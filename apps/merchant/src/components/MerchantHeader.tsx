import { Link, useRouterState } from "@tanstack/react-router"
import {
  Bug,
  CalendarDays,
  CreditCard,
  ExternalLink,
  FileText,
  Info,
  Menu,
  MessageCircle,
  Package,
  ShoppingBag,
  ShieldCheck,
  Store,
  Truck,
  UserRound,
  Wifi,
  X,
} from "lucide-react"
import {
  useEffect,
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
  Badge,
  Button,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  ThemeToggleButton,
  cn,
  useSignIn,
  AccountMenu,
} from "@conduit/ui"

import { useMerchantReadinessState } from "../hooks/useMerchantReadinessContext"
import { MerchantProjectTip } from "./MerchantProjectTip"

type CommerceNavRoute =
  | "/"
  | "/products"
  | "/events"
  | "/orders"
  | "/wallet"
  | "/shipping"
  | "/messages"

type MerchantInternalNavRoute = CommerceNavRoute | "/about"

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
  { to: "/wallet", label: "Wallets", icon: CreditCard, hasReadiness: true },
  { to: "/shipping", label: "Shipping", icon: Truck, hasReadiness: true },
  { to: "/messages", label: "Messages", icon: MessageCircle },
]

const navItemClassName =
  "group relative flex min-h-10 w-full min-w-0 items-center gap-3 rounded-[var(--radius-md)] border border-transparent px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"

function MerchantAvatarFallback() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-[var(--avatar-bg)]">
      <img
        src="/images/logo/merchant-logo-icon.svg"
        alt=""
        aria-hidden="true"
        className="h-4 w-auto select-none object-contain brightness-0 invert"
        draggable="false"
      />
    </span>
  )
}

export function MerchantBrandLockup() {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 select-none sm:gap-3">
      <span
        data-merchant-brand-logo=""
        className="h-8 w-6 shrink-0 overflow-hidden min-[420px]:w-[6.75rem]"
      >
        <img
          src="/images/logo/merchant-logo-full.svg"
          alt="Conduit"
          width={386}
          height={115}
          className="h-8 w-[6.75rem] max-w-none object-left"
          draggable="false"
        />
      </span>
      <span className="shrink-0 border-l border-[var(--border)] pl-2 pr-1 font-display sm:pl-3 text-xl font-medium text-[var(--text-primary)]">
        merchant
      </span>
    </span>
  )
}

function MerchantLogoLink({ className }: { className?: string }) {
  return (
    <Link
      to="/"
      aria-label="Conduit Merchant home"
      className={cn(
        "inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className
      )}
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
  onNavigate?: (to: CommerceNavRoute) => void
}) {
  const Icon = item.icon

  return (
    <Link
      to={item.to}
      onClick={() => onNavigate?.(item.to)}
      className={navItemClassName}
      activeProps={{
        className:
          "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] ",
      }}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {incomplete ? <IncompleteBadge className="ml-auto shrink-0" /> : null}
    </Link>
  )
}

function InformationNavLinks({
  onInternalNavigate,
  onExternalNavigate,
}: {
  onInternalNavigate?: (to: MerchantInternalNavRoute) => void
  onExternalNavigate?: () => void
}) {
  return (
    <div className="grid gap-1">
      <Link
        to="/about"
        onClick={() => onInternalNavigate?.("/about")}
        className={navItemClassName}
        activeProps={{
          className:
            "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] ",
        }}
      >
        <Info className="size-4 shrink-0" />
        <span>About</span>
      </Link>
      <a href="/terms-of-service" className={navItemClassName}>
        <FileText className="size-4 shrink-0" />
        <span>Terms</span>
      </a>
      <a href="/privacy-policy" className={navItemClassName}>
        <ShieldCheck className="size-4 shrink-0" />
        <span>Privacy</span>
      </a>
      <a
        href="https://conduit.market/"
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        onClick={onExternalNavigate}
        className={navItemClassName}
      >
        <ExternalLink className="size-4 shrink-0" />
        <span>conduit.market</span>
      </a>
    </div>
  )
}

function MerchantNavLinks({
  onInternalNavigate,
  onExternalNavigate,
  paymentsIncomplete,
  shippingIncomplete,
}: {
  onInternalNavigate?: (to: MerchantInternalNavRoute) => void
  onExternalNavigate?: () => void
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
              item.hasReadiness && item.to === "/wallet"
                ? paymentsIncomplete
                : item.hasReadiness && item.to === "/shipping"
                  ? shippingIncomplete
                  : false
            }
            onNavigate={onInternalNavigate}
          />
        ))}
      </div>
      <div className="my-1 border-t border-[var(--border)]" />
      <InformationNavLinks
        onInternalNavigate={onInternalNavigate}
        onExternalNavigate={onExternalNavigate}
      />
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
          ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning-text)]"
          : "border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info-text)]"
      )}
    >
      {config.lightningNetwork}
    </Badge>
  )
}

export function MerchantAccountMenu() {
  const {
    pubkey,
    accountPubkey,
    status,
    connect,
    signerReadiness,
    authGeneration,
  } = useAuth()
  const { requestSignIn, disconnectAccount } = useSignIn()
  const authGenerationRef = useRef(authGeneration)

  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])

  const authenticatedPubkey = status === "connected" ? pubkey : null
  const profileQuery = useProfile(pubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
  })

  const profile = profileQuery.data
  const displayName = getProfileDisplayLabel(profile, pubkey ?? "", {
    lookupSettled: !profileQuery.isPlaceholderData,
    pendingLabel: "Loading profile",
    chars: 6,
  })

  return (
    <AccountMenu
      key={accountPubkey ?? "guest"}
      label="Open merchant account menu"
      accountPresent={!!accountPubkey}
      displayName={displayName}
      pubkeyLabel={pubkey ? formatNpub(pubkey, 12) : undefined}
      avatarUrl={profile?.picture}
      fallback={<MerchantAvatarFallback />}
      pending={status === "connecting" || status === "restoring"}
      recoveryRequired={!!accountPubkey && signerReadiness === "unavailable"}
      incompatible={signerReadiness === "incompatible"}
      onConnect={() => requestSignIn()}
      onReconnect={() => connect({ mode: "restore" })}
      onDisconnect={disconnectAccount}
      items={[
        {
          label: "Profile",
          content: (
            <Link to="/profile">
              <UserRound className="size-4" />
              Profile
            </Link>
          ),
        },
        {
          label: "Network",
          content: (
            <Link to="/network">
              <Wifi className="size-4" />
              Network
            </Link>
          ),
        },
      ]}
    />
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
  const [open, setOpen] = useState(false)
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-11 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="h-dvh w-[min(320px,calc(100vw-1rem))] min-[420px]:w-[360px] gap-0 overflow-hidden border-y-0 border-l-0 border-r border-[var(--border)] bg-[var(--surface-dialog)] p-0"
      >
        <SheetTitle className="sr-only">Conduit Merchant navigation</SheetTitle>
        <MerchantNavigationPanel
          headerAction={
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-11 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
                aria-label="Close"
              >
                <X className="size-5" />
              </Button>
            </SheetClose>
          }
          onInternalNavigate={(to) => {
            if (to === pathname) setOpen(false)
          }}
          onExternalNavigate={() => setOpen(false)}
          onReportBug={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

function MerchantNavigationPanel({
  headerAction,
  onInternalNavigate,
  onExternalNavigate,
  onReportBug,
}: {
  headerAction?: ReactNode
  onInternalNavigate?: (to: MerchantInternalNavRoute) => void
  onExternalNavigate?: () => void
  onReportBug?: () => void
}) {
  const readiness = useMerchantReadinessState()

  return (
    <div
      data-merchant-navigation-panel=""
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--surface-dialog)] pb-6 pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))]"
    >
      <div className="flex h-[calc(5rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 pt-[env(safe-area-inset-top)] min-[360px]:gap-2">
        <MerchantLogoLink className="shrink-0" />
        {headerAction}
      </div>

      <div
        data-merchant-navigation-scroll=""
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1"
      >
        <MerchantNavLinks
          onInternalNavigate={onInternalNavigate}
          onExternalNavigate={onExternalNavigate}
          paymentsIncomplete={
            !readiness.paymentsComplete && !readiness.paymentsCheckPending
          }
          shippingIncomplete={
            !readiness.shippingComplete && !readiness.shippingCheckPending
          }
        />
        <NetworkBadge />
      </div>

      <div className="mt-4 shrink-0 border-t border-[var(--border)] pb-[max(0px,env(safe-area-inset-bottom))] pr-1 pt-4">
        <MerchantProjectTip
          className={cn(
            navItemClassName,
            "mb-1 h-auto justify-start [&>svg]:size-4 [&>svg]:shrink-0"
          )}
        />
        <ReportBugLink onNavigate={onReportBug} />
      </div>
    </div>
  )
}

export function MerchantWorkspaceHeader() {
  return (
    <header
      aria-label="Merchant workspace controls"
      className="fixed inset-x-0 top-0 z-40 flex h-[calc(5rem+env(safe-area-inset-top))] min-w-0 items-center gap-1 bg-[var(--surface-dialog)] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--border)] min-[360px]:gap-2 min-[360px]:pr-[max(0.5rem,env(safe-area-inset-right))] lg:inset-x-auto lg:right-[max(1rem,env(safe-area-inset-right))] lg:top-[max(1rem,env(safe-area-inset-top))] lg:h-auto lg:bg-transparent lg:p-0 lg:after:hidden"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-1 min-[360px]:gap-2 lg:hidden">
        <MerchantLogoLink />
        <MerchantMobileNav />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 min-[360px]:gap-2">
        <ThemeToggleButton />
        <MerchantAccountMenu />
      </div>
    </header>
  )
}

export function MerchantSidebar() {
  return (
    <aside
      aria-label="Merchant navigation"
      className="hidden h-dvh min-h-0 min-w-0 overflow-hidden border-r border-[var(--border)] bg-[var(--surface-dialog)] lg:block"
    >
      <MerchantNavigationPanel />
    </aside>
  )
}
