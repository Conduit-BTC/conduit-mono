import { createRootRoute, Outlet, type ErrorComponentProps } from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/router-devtools"
import { MerchantHeader } from "../components/MerchantHeader"
import { ErrorPage, NotFoundPage } from "@conduit/ui"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFound,
})

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <MerchantHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {children}
      </main>
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
