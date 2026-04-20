import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  db,
  EVENT_KINDS,
  fetchEventsFanout,
  formatPubkey,
  getEffectiveRelayGroups,
  parseProductEvent,
  useAuth,
  useNdkState,
  type ParsedOrderMessage,
} from "@conduit/core"
import { ArrowRight, Package, Radio, ShoppingBag, Wallet } from "lucide-react"
import type { ComponentType } from "react"
import { Badge, Button } from "@conduit/ui"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

type MerchantDashboardStats = {
  listings: number
  openOrders: number
  awaitingPayment: number
  awaitingFulfillment: number
  latestOrders: ParsedOrderMessage[]
}

async function fetchDashboardStats(pubkey: string): Promise<MerchantDashboardStats> {
  const listingEvents = await fetchEventsFanout(
    {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [pubkey],
      limit: 200,
    },
    {
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 10_000,
    },
  )

  const listingIds = new Set<string>()
  for (const event of listingEvents) {
    try {
      const product = parseProductEvent(event)
      listingIds.add(product.id)
    } catch {
      // ignore malformed listings
    }
  }

  const cachedMessages = await db.orderMessages
    .where("recipientPubkey")
    .equals(pubkey)
    .or("senderPubkey")
    .equals(pubkey)
    .toArray()

  const parsedMessages = cachedMessages.flatMap((row) => {
    try {
      return [JSON.parse(row.rawContent) as ParsedOrderMessage]
    } catch {
      return []
    }
  })

  const byOrder = new Map<string, ParsedOrderMessage[]>()
  for (const message of parsedMessages) {
    const bucket = byOrder.get(message.orderId) ?? []
    bucket.push(message)
    byOrder.set(message.orderId, bucket)
  }

  let awaitingPayment = 0
  let awaitingFulfillment = 0

  for (const messages of byOrder.values()) {
    const hasPaymentRequest = messages.some((message) => message.type === "payment_request")
    const latestStatus = [...messages]
      .reverse()
      .find((message) => message.type === "status_update")

    if (!hasPaymentRequest) awaitingPayment += 1
    if (latestStatus?.type === "status_update") {
      if (latestStatus.payload.status === "paid" || latestStatus.payload.status === "processing") {
        awaitingFulfillment += 1
      }
    }
  }

  const latestOrders = [...parsedMessages]
    .filter((message) => message.type === "order")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)

  return {
    listings: listingIds.size,
    openOrders: byOrder.size,
    awaitingPayment,
    awaitingFulfillment,
    latestOrders,
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: number
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">{label}</div>
          <div className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            {value}
          </div>
        </div>
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]">
          <Icon className="h-5 w-5" />
        </span>
      </div>
    </div>
  )
}

function DashboardPage() {
  const { pubkey, error } = useAuth()
  const ndk = useNdkState()
  const statsQuery = useQuery({
    queryKey: ["merchant-dashboard", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchDashboardStats(pubkey!),
    refetchInterval: 30_000,
  })
  const latestOrders = (statsQuery.data?.latestOrders ?? []).filter(
    (message): message is Extract<ParsedOrderMessage, { type: "order" }> => message.type === "order",
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">Merchant Portal</div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Run your store
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Publish products, manage incoming orders, and keep buyer conversations moving from one workspace.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pubkey && (
            <Badge variant="secondary" className="border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]">
              {formatPubkey(pubkey, 10)}
            </Badge>
          )}
          <Link to="/settings">
            <Badge variant="secondary" className="border-[var(--border)] bg-[var(--surface-elevated)] cursor-pointer hover:border-[var(--text-secondary)]">
              <Radio className="mr-1.5 h-3 w-3" />
              Relay {ndk.status}
              {ndk.connectedRelays.length > 0 && (
                <span className="ml-1.5 text-[var(--text-muted)]">
                  ({ndk.connectedRelays.length})
                </span>
              )}
            </Badge>
          </Link>
          {(() => {
            const groups = getEffectiveRelayGroups()
            const counts = [
              groups.merchant.length > 0 ? `${groups.merchant.length} merchant` : null,
              groups.commerce.length > 0 ? `${groups.commerce.length} commerce` : null,
              groups.general.length > 0 ? `${groups.general.length} general` : null,
            ].filter(Boolean)
            if (counts.length === 0) return null
            return (
              <Badge variant="outline" className="border-[var(--border)] text-[var(--text-muted)]">
                {counts.join(" / ")}
              </Badge>
            )
          })()}
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      {!pubkey && (
        <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Connect your signer to manage listings and orders from this merchant workspace.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Listings" value={statsQuery.data?.listings ?? 0} icon={Package} />
        <StatCard label="Open orders" value={statsQuery.data?.openOrders ?? 0} icon={ShoppingBag} />
        <StatCard label="Awaiting payment" value={statsQuery.data?.awaitingPayment ?? 0} icon={Wallet} />
        <StatCard label="Awaiting fulfillment" value={statsQuery.data?.awaitingFulfillment ?? 0} icon={ShoppingBag} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">Things to do next</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                Keep your merchant loop moving
              </h2>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Link
              to="/products"
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-elevated)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">Manage listings</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Create, edit, and publish products.
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
              </div>
            </Link>

            <Link
              to="/orders"
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-elevated)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">Open order inbox</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Review buyer messages, invoices, and status updates.
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-[var(--text-muted)]" />
              </div>
            </Link>
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">Recent orders</div>
              <h2 className="mt-2 text-xl font-semibold text-[var(--text-primary)]">Latest buyer activity</h2>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/orders">View all</Link>
            </Button>
          </div>

          <div className="mt-4 space-y-3">
            {statsQuery.isLoading && (
              <div className="text-sm text-[var(--text-secondary)]">Loading dashboard…</div>
            )}

            {!statsQuery.isLoading && latestOrders.length === 0 && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
                No buyer orders cached yet. Once Market sends an order to this merchant, it will appear here and in Orders.
              </div>
            )}

            {latestOrders.map((message) => (
              <Link
                key={message.id}
                to="/orders"
                className="block rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-elevated)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      Order {message.orderId.slice(0, 8)}…
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      {message.payload.items.length} item{message.payload.items.length === 1 ? "" : "s"} · {message.payload.subtotal} {message.payload.currency}
                    </div>
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {new Date(message.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
