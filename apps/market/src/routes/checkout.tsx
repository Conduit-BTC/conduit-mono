import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge, Button, Input, Label } from "@conduit/ui"
import { EVENT_KINDS, getNdk, useAuth } from "@conduit/core"
import { useCart } from "../hooks/useCart"
import { requireAuth } from "../lib/auth"
import { NDKEvent, NDKUser, giftWrap } from "@nostr-dev-kit/ndk"
import { useMemo, useState } from "react"

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  component: CheckoutPage,
})

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()
  const [note, setNote] = useState("")
  const [sending, setSending] = useState(false)
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const merchants = useMemo(() => {
    const set = new Set(cart.items.map((i) => i.merchantPubkey).filter(Boolean))
    return Array.from(set)
  }, [cart.items])

  const merchantPubkey = merchants.length === 1 ? merchants[0] : null
  const isMultiMerchant = merchants.length > 1

  async function placeOrder(): Promise<void> {
    if (!pubkey) return
    if (!merchantPubkey) return
    if (cart.items.length === 0) return

    setSending(true)
    setError(null)

    try {
      const orderId = crypto.randomUUID()

      // MVP constraint: single merchant per order.
      const currency = cart.items[0]?.currency ?? "USD"
      const items = cart.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        priceAtPurchase: i.price,
        currency: i.currency,
      }))

      const payload = {
        id: orderId,
        merchantPubkey,
        buyerPubkey: pubkey,
        items,
        subtotal: cart.totals.subtotal,
        currency,
        note: note.trim() ? note.trim() : undefined,
        createdAt: Date.now(),
      }

      const ndk = getNdk()
      const rumor = new NDKEvent(ndk)
      rumor.kind = EVENT_KINDS.ORDER
      rumor.created_at = Math.floor(Date.now() / 1000)
      rumor.tags = [
        ["p", merchantPubkey],
        ["type", "order"],
        ["order", orderId],
      ]
      rumor.content = JSON.stringify(payload)

      const merchantUser = new NDKUser({ pubkey: merchantPubkey })
      const wrappedToMerchant = await giftWrap(rumor, merchantUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      })

      // Also publish a copy to self so buyers can recover their own order history
      // even if they change clients later (assuming same relays).
      const buyerUser = new NDKUser({ pubkey })
      const wrappedToSelf = await giftWrap(rumor, buyerUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      })

      await Promise.all([wrappedToMerchant.publish(), wrappedToSelf.publish()])

      setSentOrderId(orderId)
      cart.clear()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send order")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Checkout</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            MVP: send an order to the merchant via NIP-17 (kind {EVENT_KINDS.GIFT_WRAP}) wrapping a kind{" "}
            {EVENT_KINDS.ORDER} rumor.
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

      {sentOrderId && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm text-[var(--text-secondary)]">Order sent</div>
              <div className="mt-1 font-mono text-sm text-[var(--text-primary)]">{sentOrderId}</div>
            </div>
            <Badge variant="secondary" className="border-[var(--border)]">
              Awaiting merchant
            </Badge>
          </div>
        </div>
      )}

      {isMultiMerchant && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Your cart contains items from multiple merchants. MVP supports one merchant per order.
        </div>
      )}

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

          <div className="mt-4 grid gap-2">
            <Label htmlFor="note">Order note (optional)</Label>
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the merchant should know…"
            />
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
              {error}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end">
            <Button disabled={sending || !merchantPubkey} onClick={placeOrder}>
              {sending ? "Sending…" : "Place order"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
