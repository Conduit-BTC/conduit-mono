import { createFileRoute, Link } from "@tanstack/react-router"
import { NDKEvent, NDKUser, giftWrap } from "@nostr-dev-kit/ndk"
import { useMemo, useState } from "react"
import { EVENT_KINDS, formatPubkey, getNdk, useAuth, type ShippingAddressSchema } from "@conduit/core"
import { Badge, Button, Input, Label } from "@conduit/ui"
import { useCart } from "../hooks/useCart"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (search: Record<string, unknown>) => ({
    merchant: typeof search.merchant === "string" ? search.merchant : undefined,
  }),
  component: CheckoutPage,
})

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()
  const search = Route.useSearch()
  const selectedMerchant = search.merchant
  const [note, setNote] = useState("")
  const [needsShipping, setNeedsShipping] = useState(true)
  const [shipping, setShipping] = useState<ShippingAddressSchema>({
    name: "",
    street: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
  })
  const [sending, setSending] = useState(false)
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const shippingValid = !needsShipping || (shipping.name.trim() !== "" && shipping.street.trim() !== "" && shipping.city.trim() !== "" && shipping.postalCode.trim() !== "" && shipping.country.trim().length >= 2)

  function updateShipping(field: keyof ShippingAddressSchema, value: string) {
    setShipping((prev) => ({ ...prev, [field]: value }))
  }

  const checkoutItems = useMemo(() => {
    if (!selectedMerchant) return cart.items
    return cart.items.filter((i) => i.merchantPubkey === selectedMerchant)
  }, [cart.items, selectedMerchant])

  const merchants = useMemo(() => {
    const set = new Set(checkoutItems.map((i) => i.merchantPubkey).filter(Boolean))
    return Array.from(set)
  }, [checkoutItems])
  const total = useMemo(
    () => checkoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [checkoutItems]
  )
  const currencies = useMemo(
    () => Array.from(new Set(checkoutItems.map((item) => item.currency).filter(Boolean))),
    [checkoutItems]
  )
  const totalCurrency = currencies.length === 1 ? currencies[0] : null

  const merchantPubkey = merchants.length === 1 ? merchants[0] : null
  const isMultiMerchant = merchants.length > 1

  async function placeOrder(): Promise<void> {
    if (!pubkey) return
    if (!merchantPubkey) return
    if (checkoutItems.length === 0) return

    setSending(true)
    setError(null)

    try {
      const orderId = crypto.randomUUID()

      // MVP constraint: single merchant per order.
      const currency = checkoutItems[0]?.currency ?? "USD"
      const items = checkoutItems.map((i) => ({
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
        subtotal: total,
        currency,
        shippingAddress: needsShipping && shippingValid ? {
          name: shipping.name.trim(),
          street: shipping.street.trim(),
          city: shipping.city.trim(),
          state: shipping.state?.trim() || undefined,
          postalCode: shipping.postalCode.trim(),
          country: shipping.country.trim().toUpperCase(),
        } : undefined,
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
      if (selectedMerchant) {
        cart.clearMerchant(selectedMerchant)
      } else {
        cart.clear()
      }
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
            Send the order to the merchant via NIP-17 (kind {EVENT_KINDS.GIFT_WRAP}) wrapping a kind{" "}
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
        <div className="rounded-md border border-green-500/30 bg-green-500/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-green-400">Order sent successfully</div>
              <div className="mt-1 font-mono text-sm text-[var(--text-primary)]">{sentOrderId}</div>
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                The merchant will review your order and send a Lightning invoice. Check your messages for updates.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge variant="secondary" className="border-[var(--border)]">
                Awaiting invoice
              </Badge>
              <Button asChild size="sm">
                <Link to="/orders">View orders</Link>
              </Button>
            </div>
          </div>
        </div>
      )}

      {isMultiMerchant && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Your cart contains items from multiple merchants. MVP supports one merchant per order.
        </div>
      )}

      {checkoutItems.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          {selectedMerchant ? "No items for this merchant." : "Your cart is empty."}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_360px]">
          <div className="space-y-4">
          <section className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-[var(--text-primary)]">Shipping address</div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={needsShipping}
                  onChange={(e) => setNeedsShipping(e.target.checked)}
                  className="rounded border-[var(--border)]"
                />
                Requires shipping
              </label>
            </div>
            {needsShipping ? (
              <div className="mt-3 grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="ship-name">Full name</Label>
                  <Input id="ship-name" value={shipping.name} onChange={(e) => updateShipping("name", e.target.value)} placeholder="Jane Doe" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ship-street">Street address</Label>
                  <Input id="ship-street" value={shipping.street} onChange={(e) => updateShipping("street", e.target.value)} placeholder="123 Main St" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-city">City</Label>
                    <Input id="ship-city" value={shipping.city} onChange={(e) => updateShipping("city", e.target.value)} placeholder="Austin" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-state">State / Province</Label>
                    <Input id="ship-state" value={shipping.state ?? ""} onChange={(e) => updateShipping("state", e.target.value)} placeholder="TX" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-postal">Postal code</Label>
                    <Input id="ship-postal" value={shipping.postalCode} onChange={(e) => updateShipping("postalCode", e.target.value)} placeholder="78701" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-country">Country (ISO)</Label>
                    <Input id="ship-country" value={shipping.country} onChange={(e) => updateShipping("country", e.target.value)} placeholder="US" maxLength={2} />
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-[var(--text-secondary)]">No shipping required for this order (digital product or local pickup).</p>
            )}
          </section>

          <section className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="text-sm text-[var(--text-secondary)]">Order items</div>
            <div className="mt-3 space-y-2">
              {checkoutItems.map((i) => (
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
                {total}
                {totalCurrency ? ` ${totalCurrency}` : ""}
              </div>
            </div>
          </section>
          </div>

          <aside className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 self-start">
            <div className="text-sm text-[var(--text-secondary)]">Merchant</div>
            <div className="mt-1 font-mono text-sm text-[var(--text-primary)]">
              {merchantPubkey ? formatPubkey(merchantPubkey, 12) : "Multiple merchants"}
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
              <Button className="w-full" disabled={sending || !merchantPubkey || !shippingValid} onClick={placeOrder}>
                {sending ? "Sending…" : "Place order"}
              </Button>
              {needsShipping && !shippingValid && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">Fill in shipping address to continue.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
