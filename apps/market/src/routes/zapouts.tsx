import { createFileRoute, Link } from "@tanstack/react-router"

export const Route = createFileRoute("/zapouts")({ component: ZapoutsPage })

function ZapoutsPage() {
  return (
    <section className="mx-auto max-w-3xl space-y-4 py-6">
      <h1 className="font-display text-3xl font-semibold">
        Public zapout feed retired
      </h1>
      <p className="text-[var(--text-secondary)]">
        Conduit no longer signs anonymous public zap messages or verifies this
        feed. Existing receipts on Nostr have not been deleted. Your order
        history remains available, and guests can still pay privately and tip
        Conduit with Lightning.
      </p>
      <Link to="/orders" className="text-primary-400 underline">
        View your orders
      </Link>
    </section>
  )
}
