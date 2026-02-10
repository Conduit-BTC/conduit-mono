import { createFileRoute, Link } from "@tanstack/react-router"
import { Button } from "@conduit/ui"
import { useAuth } from "@conduit/core"
import { useCart } from "../hooks/useCart"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  component: CheckoutPage,
})

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Checkout</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            MVP stub. Next step is sending `order` / `payment_proof` messages via NIP-17.
          </p>
        </div>
        <Button asChild variant="muted">
          <Link to="/cart">Back to cart</Link>
        </Button>
      </div>

      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="text-sm text-[var(--text-secondary)]">Buyer</div>
        <div className="mt-1 font-mono text-sm text-[var(--text-primary)]">{pubkey}</div>
      </div>

      {cart.items.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Your cart is empty.
        </div>
      ) : (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-sm text-[var(--text-secondary)]">Items</div>
          <div className="mt-3 space-y-2">
            {cart.items.map((i) => (
              <div key={i.productId} className="flex items-center justify-between gap-3 text-sm">
                <div className="text-[var(--text-primary)]">
                  {i.title} <span className="text-[var(--text-secondary)]">x{i.quantity}</span>
                </div>
                <div className="text-[var(--text-secondary)]">
                  {i.price * i.quantity} {i.currency}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
            <div className="text-sm text-[var(--text-secondary)]">Total</div>
            <div className="text-base font-medium text-[var(--text-primary)]">
              {cart.totals.subtotal}
            </div>
          </div>

          <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm text-[var(--text-secondary)]">
            Next: build and send an order intent via NIP-17 (kind 1059/13 wrapper) with a kind 16
            payload, then support one-way checkout `payment_proof`.
          </div>
        </div>
      )}
    </div>
  )
}

