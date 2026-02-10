import { createRootRoute, Outlet } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { SignerSwitch } from "../components/SignerSwitch"

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="font-heading text-sm tracking-wide text-[var(--text-primary)]">
            Conduit Merchant
          </div>
          <SignerSwitch />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  ),
})
