import { createFileRoute } from "@tanstack/react-router"
import { useAuth, useNdkState, formatPubkey } from "@conduit/core"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const search = Route.useSearch() as any
  const { pubkey, status, error } = useAuth()
  const ndk = useNdkState()

  const authRequired =
    search?.authRequired === true ||
    search?.authRequired === "true" ||
    search?.authRequired === 1 ||
    search?.authRequired === "1"

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-4xl font-medium text-[var(--text-primary)]">
          Conduit Market
        </h1>
        <p className="mt-2 text-lg text-[var(--text-secondary)]">
          A decentralized marketplace powered by Nostr
        </p>
      </div>

      <div className="text-sm text-[var(--text-secondary)]">
        {pubkey ? `Signed in as ${formatPubkey(pubkey)}` : `Status: ${status}`}
      </div>

      {authRequired && !pubkey && (
        <p className="text-sm text-[var(--text-secondary)]">
          Connect your signer to continue to checkout.
        </p>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      <div className="text-xs text-[var(--text-muted)]">
        Relay: {ndk.status} ({ndk.connectedRelays.length} connected)
      </div>
    </div>
  )
}
