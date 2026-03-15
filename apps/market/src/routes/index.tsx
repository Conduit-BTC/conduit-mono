import { Navigate, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const search = Route.useSearch() as Record<string, unknown>
  return <Navigate to="/products" search={search} replace />
}
