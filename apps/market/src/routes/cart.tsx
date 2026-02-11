import { createFileRoute, Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { formatPubkey } from "@conduit/core"
import { Button } from "@conduit/ui"
import { useCart } from "../hooks/useCart"

export const Route = createFileRoute("/cart")({
  component: CartPage,
})

function CartPage() {
  const cart = useCart()
  const cartsByMerchant = useMemo(() => {
    const byMerchant = new Map<string, typeof cart.items>()
    for (const item of cart.items) {
      const curr = byMerchant.get(item.merchantPubkey) ?? []
      curr.push(item)
      byMerchant.set(item.merchantPubkey, curr)
    }
    return Array.from(byMerchant.entries())
  }, [cart.items])

  const merchantSubtotal = (merchantPubkey: string) =>
    cart.items
      .filter((i) => i.merchantPubkey === merchantPubkey)
      .reduce((sum, item) => sum + item.price * item.quantity, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Cart</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Client-side cart storage with items grouped by merchant.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="muted">
            <Link to="/products">Continue shopping</Link>
          </Button>
          <Button asChild disabled={cart.items.length === 0}>
            <Link to="/checkout" search={{ merchant: undefined }}>
              Checkout
            </Link>
          </Button>
        </div>
      </div>

      {cart.items.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Your cart is empty.
        </div>
      ) : (
        <div className="space-y-3">
          {cartsByMerchant.map(([merchantPubkey, items]) => (
            <div
              key={merchantPubkey}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"
            >
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border)] pb-3">
                <div>
                  <div className="text-xs text-[var(--text-secondary)]">Merchant cart</div>
                  <div className="font-mono text-sm text-[var(--text-primary)]">
                    {formatPubkey(merchantPubkey, 12)}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    {items.length} item{items.length === 1 ? "" : "s"} • subtotal {merchantSubtotal(merchantPubkey)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => cart.clearMerchant(merchantPubkey)}>
                    Clear merchant
                  </Button>
                  <Button asChild size="sm">
                    <Link to="/checkout" search={{ merchant: merchantPubkey }}>
                      Checkout this cart
                    </Link>
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {items.map((i) => (
                  <div
                    key={i.productId}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
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
                          className="w-20 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[var(--text-primary)]"
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
              <Link to="/checkout" search={{ merchant: undefined }}>
                Checkout
              </Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
