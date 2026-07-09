import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  db,
  formatNpub,
  getCachedMerchantConversationList,
  getCachedMerchantStorefront,
  getMerchantConversationList,
  getMerchantStorefront,
  getProfileName,
  isPaymentProofEvidenceMessage,
  useAuth,
  useNdkState,
  useProfiles,
  type ParsedOrderMessage,
  type Profile,
} from "@conduit/core"
import {
  ArrowRight,
  Package,
  ShoppingBag,
  Truck,
  UserRound,
  Wallet,
  Wifi,
} from "lucide-react"
import { useEffect, useRef, useState, type ComponentType } from "react"
import { Badge, Button, StatusPill, cn } from "@conduit/ui"
import { OrderListItem } from "../components/OrderListItem"
import { useMerchantReadinessState } from "../hooks/useMerchantReadinessContext"
import type { MerchantSetupReadiness } from "../lib/readiness"

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

async function fetchDashboardStats(
  pubkey: string
): Promise<MerchantDashboardStats> {
  const storefront = await getMerchantStorefront({
    merchantPubkey: pubkey,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  const base = await fetchDashboardStatsFromCacheOnly(pubkey)
  return { ...base, listings: storefront.data.length }
}

async function fetchCachedDashboardStats(
  pubkey: string
): Promise<MerchantDashboardStats> {
  const storefront = await getCachedMerchantStorefront({
    merchantPubkey: pubkey,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  const base = await fetchDashboardStatsFromCacheOnly(pubkey)
  return { ...base, listings: storefront.data.length }
}

async function fetchDashboardStatsFromCacheOnly(
  pubkey: string
): Promise<Omit<MerchantDashboardStats, "listings"> & { listings: number }> {
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
    const hasPaymentRequest = messages.some(
      (message) => message.type === "payment_request"
    )
    const hasPaymentProof = messages.some(isPaymentProofEvidenceMessage)
    const latestStatus = [...messages]
      .reverse()
      .find((message) => message.type === "status_update")

    if (!hasPaymentRequest && !hasPaymentProof) awaitingPayment += 1
    if (latestStatus?.type === "status_update") {
      if (
        latestStatus.payload.status === "paid" ||
        latestStatus.payload.status === "processing"
      ) {
        awaitingFulfillment += 1
      }
    } else if (hasPaymentProof) {
      awaitingFulfillment += 1
    }
  }

  const latestOrders = [...parsedMessages]
    .filter((message) => message.type === "order")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)

  return {
    listings: 0,
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
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {label}
          </div>
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

function RelayStatusBadge({ status }: { status: string }) {
  const previousStatusRef = useRef(status)
  const [recentlyConnected, setRecentlyConnected] = useState(false)
  const isConnecting = status === "connecting"
  const isConnected = status === "connected"
  const isError = status === "error"

  useEffect(() => {
    if (status === "connected" && previousStatusRef.current !== "connected") {
      setRecentlyConnected(true)
      const timeoutId = window.setTimeout(() => {
        setRecentlyConnected(false)
      }, 1_200)

      previousStatusRef.current = status
      return () => window.clearTimeout(timeoutId)
    }

    previousStatusRef.current = status
    return undefined
  }, [status])

  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1.5 border transition-colors duration-500",
        isConnecting &&
          "animate-pulse border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info)]",
        recentlyConnected &&
          "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] shadow-[0_0_16px_color-mix(in_srgb,var(--success)_18%,transparent)]",
        isConnected &&
          !recentlyConnected &&
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]",
        isError && "border-error/30 bg-error/10 text-error",
        !isConnecting &&
          !isConnected &&
          !isError &&
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isConnecting && "bg-[var(--info)]",
          isConnected && "bg-[var(--success)]",
          isError && "bg-error",
          !isConnecting && !isConnected && !isError && "bg-[var(--text-muted)]"
        )}
      />
      Relay {status}
    </Badge>
  )
}

function ReadinessRow({
  label,
  complete,
  pending = false,
  to,
  icon: Icon,
}: {
  label: string
  complete: boolean
  pending?: boolean
  to: "/" | "/profile" | "/payments" | "/shipping" | "/network"
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-3 transition-colors hover:bg-[var(--surface)]"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]">
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate text-sm font-medium text-[var(--text-primary)]">
          {label}
        </span>
      </span>
      <StatusPill
        variant={complete ? "success" : pending ? "info" : "warning"}
        className="text-[10px]"
      >
        {complete ? "Ready" : pending ? "Checking" : "Needs completion"}
      </StatusPill>
    </Link>
  )
}

function MerchantReadinessPanel({
  readiness,
}: {
  readiness: MerchantSetupReadiness
}) {
  const setupPending =
    readiness.setupCheckPending && readiness.missingAreas.length === 0

  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Merchant readiness
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            {readiness.setupComplete
              ? "Ready to sell"
              : setupPending
                ? "Checking setup"
                : "Finish setup"}
          </h2>
        </div>
        <StatusPill
          variant={
            readiness.setupComplete
              ? "success"
              : setupPending
                ? "info"
                : "warning"
          }
          className="mt-0.5"
        >
          {readiness.setupComplete
            ? "Complete"
            : setupPending
              ? "Checking"
              : "Incomplete"}
        </StatusPill>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ReadinessRow
          label="Profile"
          complete={readiness.profileComplete}
          pending={readiness.profileCheckPending}
          to="/profile"
          icon={UserRound}
        />
        <ReadinessRow
          label="Payments"
          complete={readiness.paymentsComplete}
          pending={readiness.paymentsCheckPending}
          to="/payments"
          icon={Wallet}
        />
        <ReadinessRow
          label="Shipping"
          complete={readiness.shippingComplete}
          pending={readiness.shippingCheckPending}
          to="/shipping"
          icon={Truck}
        />
        <ReadinessRow
          label="Network"
          complete={readiness.networkComplete}
          to="/network"
          icon={Wifi}
        />
      </div>
    </section>
  )
}

function DashboardPage() {
  const { pubkey, error } = useAuth()
  const navigate = useNavigate()
  const ndk = useNdkState()
  const readiness = useMerchantReadinessState()
  const statsQuery = useQuery({
    queryKey: ["merchant-dashboard-live", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchDashboardStats(pubkey!),
    refetchInterval: 30_000,
  })
  const cachedStatsQuery = useQuery({
    queryKey: ["merchant-dashboard", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchCachedDashboardStats(pubkey!),
    staleTime: 5_000,
  })
  const conversationsQuery = useQuery({
    queryKey: ["merchant-conversations-live", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => getMerchantConversationList({ principalPubkey: pubkey! }),
    refetchInterval: 30_000,
  })
  const cachedConversationsQuery = useQuery({
    queryKey: ["merchant-conversations", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () =>
      getCachedMerchantConversationList({ principalPubkey: pubkey! }),
    staleTime: 5_000,
  })
  const stats = statsQuery.data ?? cachedStatsQuery.data
  const latestConversations = (
    conversationsQuery.data?.data ??
    cachedConversationsQuery.data?.data ??
    []
  ).slice(0, 5)
  const buyerProfilesQuery = useProfiles(
    latestConversations.map((conversation) => conversation.buyerPubkey),
    { enabled: !!pubkey && latestConversations.length > 0 }
  )
  const buyerName = (buyerPubkey: string) =>
    getProfileName(
      (buyerProfilesQuery.data as Record<string, Profile>)?.[buyerPubkey]
    ) || formatNpub(buyerPubkey, 8)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Merchant Portal
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Run your store
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Publish products, manage incoming orders, and keep buyer
            conversations moving from one workspace.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pubkey && (
            <Badge
              variant="secondary"
              className="border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
            >
              {formatNpub(pubkey, 10)}
            </Badge>
          )}
          <RelayStatusBadge status={ndk.status} />
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      {!pubkey && (
        <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Connect your signer to manage listings and orders from this merchant
          workspace.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Listings"
          value={stats?.listings ?? 0}
          icon={Package}
        />
        <StatCard
          label="Open orders"
          value={stats?.openOrders ?? 0}
          icon={ShoppingBag}
        />
        <StatCard
          label="Awaiting payment"
          value={stats?.awaitingPayment ?? 0}
          icon={Wallet}
        />
        <StatCard
          label="Awaiting fulfillment"
          value={stats?.awaitingFulfillment ?? 0}
          icon={ShoppingBag}
        />
      </div>

      {pubkey && <MerchantReadinessPanel readiness={readiness} />}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Things to do next
              </div>
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
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Manage listings
                  </div>
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
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Open order inbox
                  </div>
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
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Recent orders
              </div>
              <h2 className="mt-2 text-xl font-semibold text-[var(--text-primary)]">
                Latest buyer activity
              </h2>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/orders">View all</Link>
            </Button>
          </div>

          <div className="mt-4 space-y-2">
            {conversationsQuery.isLoading &&
              cachedConversationsQuery.isLoading && (
                <div className="text-sm text-[var(--text-secondary)]">
                  Checking cached dashboard state…
                </div>
              )}

            {!cachedConversationsQuery.isLoading &&
              latestConversations.length === 0 && (
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
                  No buyer orders cached yet. Once Market sends an order to this
                  merchant, it will appear here and in Orders.
                </div>
              )}

            {latestConversations.map((conversation) => (
              <OrderListItem
                key={conversation.id}
                conversation={conversation}
                buyerName={buyerName(conversation.buyerPubkey)}
                buyerPicture={
                  (buyerProfilesQuery.data as Record<string, Profile>)?.[
                    conversation.buyerPubkey
                  ]?.picture
                }
                active={false}
                onClick={() => navigate({ to: "/orders" })}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
