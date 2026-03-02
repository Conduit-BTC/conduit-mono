import { Link, useNavigate } from "@tanstack/react-router"
import { useAuth, useProfile } from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
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
  cn,
} from "@conduit/ui"
import { SignerSwitch } from "./SignerSwitch"

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
    <Link to="/" className={cn("flex items-center gap-3 select-none", className)}>
      <img src={src} alt="Conduit" className="h-8 w-auto" />
      <span className="hidden border-l border-[var(--border)] pl-3 font-display text-2xl font-medium tracking-tight text-[var(--text-primary)] md:block">
        merchant
      </span>
    </Link>
  )
}

function UserMenu() {
  const { pubkey, status, disconnect } = useAuth()
  const profileQuery = useProfile(pubkey)
  const navigate = useNavigate()
  const displayName = profileQuery.data?.displayName || profileQuery.data?.name
  const fallbackLetter = (displayName?.[0] ?? pubkey?.[0] ?? "?").toUpperCase()

  if (!pubkey || status === "disconnected" || status === "error") return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full outline-none ring-primary/20 transition focus-visible:ring-2">
          <Avatar className="h-8 w-8">
            <AvatarImage src={profileQuery.data?.picture} alt={displayName ?? "Profile"} />
            <AvatarFallback className="text-xs">{fallbackLetter}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={() => navigate({ to: "/profile" })}>
          Profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={disconnect}>
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MerchantHeader() {
  const { pubkey } = useAuth()

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
        <Logo />

        <nav className="hidden flex-1 items-center justify-end gap-2 text-sm text-[var(--text-secondary)] lg:flex">
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link to="/products" activeProps={{ className: "text-[var(--text-primary)]" }}>
              Products
            </Link>
          </Button>
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link to="/orders" activeProps={{ className: "text-[var(--text-primary)]" }}>
              Orders
            </Link>
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <div className="hidden lg:block">
            {pubkey ? <UserMenu /> : <SignerSwitch />}
          </div>

          <div className="lg:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Open menu">
                  Menu
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[340px]">
                <SheetHeader>
                  <SheetTitle>
                    <Logo variant="icon" className="justify-start" />
                  </SheetTitle>
                </SheetHeader>

                <div className="mt-6 grid gap-2">
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/products">Products</Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/orders">Orders</Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/profile">Profile</Link>
                  </Button>
                </div>

                <div className="mt-6 border-t border-[var(--border)] pt-4">
                  <SignerSwitch />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  )
}
