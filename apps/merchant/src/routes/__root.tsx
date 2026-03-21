import { createRootRoute, Outlet, type ErrorComponentProps } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import type { ReactNode } from "react"
import { MerchantHeader, MerchantSidebar } from "../components/MerchantHeader"
import { ErrorPage, NotFoundPage } from "@conduit/ui"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#090512]">
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
        <MerchantSidebar />
        <div className="min-h-screen">
          <MerchantHeader />
          <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="mx-auto w-full max-w-[1280px]">
              {children}
            </div>
          </main>
        </div>
      </div>
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </div>
  )
}

function RootLayout() {
  return (
    <RootShell>
      <Outlet />
    </RootShell>
  )
}

function RootErrorComponent({ error }: ErrorComponentProps) {
  return (
    <RootShell>
      <ErrorPage
        title="Something went wrong"
        message={error.message || "An unexpected error occurred."}
        showReload
      />
    </RootShell>
  )
}

function RootNotFound() {
  return (
    <RootShell>
      <NotFoundPage backTo="/" backLabel="Go to dashboard" />
    </RootShell>
  )
}
