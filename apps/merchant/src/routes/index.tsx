import { createFileRoute, Link } from "@tanstack/react-router"
import { useAuth, useNdkState, formatPubkey } from "@conduit/core"
import { Button } from "@conduit/ui"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

function DashboardPage() {
  const { pubkey, status, error } = useAuth()
  const ndk = useNdkState()

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-4xl font-medium text-[var(--text-primary)]">
          Merchant Portal
        </h1>
        <p className="mt-2 text-lg text-[var(--text-secondary)]">
          Manage your products, orders, and customer communications
        </p>
      </div>

      <div className="text-sm text-[var(--text-secondary)]">
        {pubkey ? `Signed in as ${formatPubkey(pubkey)}` : `Status: ${status}`}
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="text-xs text-[var(--text-muted)]">
        Relay: {ndk.status} ({ndk.connectedRelays.length} connected)
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button asChild>
          <Link to="/products">Manage products</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/orders">View orders</Link>
        </Button>
      </div>
    </div>
  )
}
