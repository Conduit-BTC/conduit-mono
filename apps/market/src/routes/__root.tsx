import { createRootRoute, Link, Outlet } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { SignerSwitch } from "../components/SignerSwitch"
import { useCart } from "../hooks/useCart"

export const Route = createRootRoute({
  component: () => (
    <RootLayout />
  ),
})

function RootLayout() {
  const cart = useCart()

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="font-heading text-sm tracking-wide text-[var(--text-primary)]"
            >
              Conduit Market
            </Link>
            <nav className="hidden items-center gap-3 text-sm text-[var(--text-secondary)] md:flex">
              <Link to="/products" activeProps={{ className: "text-[var(--text-primary)]" }}>
                Products
              </Link>
              <Link to="/cart" activeProps={{ className: "text-[var(--text-primary)]" }}>
                Cart ({cart.totals.count})
              </Link>
              <Link to="/checkout" activeProps={{ className: "text-[var(--text-primary)]" }}>
                Checkout
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/cart" className="text-sm text-[var(--text-secondary)] md:hidden">
              Cart ({cart.totals.count})
            </Link>
            <SignerSwitch />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}
