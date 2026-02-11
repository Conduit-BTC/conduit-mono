import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { EVENT_KINDS, getNdk, parseOrderRumorEvent, useAuth } from "@conduit/core"
import { Badge, Button } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { giftUnwrap, NDKEvent } from "@nostr-dev-kit/ndk"
import type { NDKFilter } from "@nostr-dev-kit/ndk"

export const Route = createFileRoute("/orders")({
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

type ParsedOrder = ReturnType<typeof parseOrderRumorEvent>

async function fetchOrders(merchantPubkey: string): Promise<ParsedOrder[]> {
  const ndk = getNdk()

  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.GIFT_WRAP],
    "#p": [merchantPubkey],
    limit: 50,
  }

  const wrapped = Array.from(await ndk.fetchEvents(filter)) as NDKEvent[]

  const signer = ndk.signer
  if (!signer) {
    throw new Error("No signer configured. Connect your signer to decrypt orders.")
  }

  const unwrapped = await Promise.allSettled(wrapped.map((w) => giftUnwrap(w, undefined, signer, "nip44")))

  const rumors = unwrapped
    .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    .filter((e) => e.kind === EVENT_KINDS.ORDER)

  const parsed: ParsedOrder[] = []
  for (const rumor of rumors) {
    try {
      parsed.push(parseOrderRumorEvent(rumor))
    } catch {
      // ignore malformed
    }
  }

  parsed.sort((a, b) => b.createdAt - a.createdAt)
  return parsed
}

function OrdersPage() {
  const { pubkey } = useAuth()

  const ordersQuery = useQuery({
    queryKey: ["orders", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchOrders(pubkey!),
    refetchInterval: 10_000,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Orders</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Decrypting NIP-17 gift wraps (kind {EVENT_KINDS.GIFT_WRAP}) and extracting kind{" "}
            {EVENT_KINDS.ORDER} rumors.
          </p>
        </div>
        <Button asChild variant="muted">
          <Link to="/">Home</Link>
        </Button>
      </div>

      {!pubkey && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view incoming orders.
        </div>
      )}

      {ordersQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">Loading…</div>
      )}

      {ordersQuery.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load orders:{" "}
          {ordersQuery.error instanceof Error ? ordersQuery.error.message : "Unknown error"}
        </div>
      )}

      {ordersQuery.data && ordersQuery.data.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No orders yet. Place an order from the Market app targeting this merchant pubkey.
        </div>
      )}

      {ordersQuery.data && ordersQuery.data.length > 0 && (
        <div className="space-y-3">
          {ordersQuery.data.map((o) => (
            <div
              key={o.id}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-sm text-[var(--text-primary)]">{o.id}</div>
                    <Badge variant="secondary" className="border-[var(--border)]">
                      MVP
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    Buyer: <span className="font-mono">{o.buyerPubkey}</span>
                  </div>
                </div>
                <div className="text-sm text-[var(--text-secondary)]">
                  {o.subtotal} {o.currency}
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {o.items.map((i) => (
                  <div key={i.productId} className="flex items-center justify-between gap-3 text-sm">
                    <div className="font-mono text-[var(--text-primary)]">{i.productId}</div>
                    <div className="text-[var(--text-secondary)]">
                      {i.quantity} × {i.priceAtPurchase} {i.currency}
                    </div>
                  </div>
                ))}
              </div>

              {o.note && (
                <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm text-[var(--text-secondary)]">
                  {o.note}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

