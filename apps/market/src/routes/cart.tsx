import { createFileRoute, Link } from "@tanstack/react-router"
import { Button } from "@conduit/ui"
import { useCart } from "../hooks/useCart"

export const Route = createFileRoute("/cart")({
  component: CartPage,
})

function CartPage() {
  const cart = useCart()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Cart</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Local-only cart stored in `localStorage` (MVP).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="muted">
            <Link to="/products">Continue shopping</Link>
          </Button>
          <Button asChild disabled={cart.items.length === 0}>
            <Link to="/checkout">Checkout</Link>
          </Button>
        </div>
      </div>

      {cart.items.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Your cart is empty.
        </div>
      ) : (
        <div className="space-y-3">
          {cart.items.map((i) => (
            <div
              key={i.productId}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-base font-medium text-[var(--text-primary)]">{i.title}</div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)] font-mono">
                    {i.productId}
                  </div>
                </div>
                <div className="text-right text-sm text-[var(--text-secondary)]">
                  {i.price} {i.currency}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  Qty
                  <input
                    className="w-20 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] px-2 py-1 text-[var(--text-primary)]"
                    type="number"
                    min={1}
                    aria-label={`Quantity for ${i.title}`}
                    value={i.quantity}
                    onChange={(e) => cart.setQuantity(i.productId, Number(e.target.value))}
                  />
                </label>
                <Button variant="outline" onClick={() => cart.removeItem(i.productId)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="text-sm text-[var(--text-secondary)]">Subtotal</div>
            <div className="text-base font-medium text-[var(--text-primary)]">
              {cart.totals.subtotal}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={cart.clear}>
              Clear cart
            </Button>
            <Button asChild>
              <Link to="/checkout">Checkout</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
