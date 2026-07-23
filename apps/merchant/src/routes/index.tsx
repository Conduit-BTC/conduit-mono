import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  db,
  getCachedMerchantConversationList,
  getCachedMerchantStorefront,
  getMerchantConversationList,
  getMerchantStorefront,
  useAuth,
  useProfiles,
  type ParsedOrderMessage,
} from "@conduit/core"
import {
  ArrowRight,
  Package,
  ShoppingBag,
  Truck,
  UserRound,
  Wallet,
  Wifi,
  type LucideIcon,
} from "lucide-react"
import { useCallback, useMemo, useState, type ComponentType } from "react"
import { Button, StatusPill } from "@conduit/ui"
import {
  DashboardCharts,
  type DashboardChartDataByCard,
  type DashboardChartId,
  type DashboardChartRanges,
} from "../components/DashboardCharts"
import { OrderListItem } from "../components/OrderListItem"
import {
  DEFAULT_DASHBOARD_RANGE,
  buildDashboardChartData,
  resolveDashboardPresetRange,
  type DashboardRangePreset,
} from "../lib/dashboard-charts"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useMerchantReadinessState } from "../hooks/useMerchantReadinessContext"
import {
  getMerchantConversationQueue,
  isMerchantGuestOrder,
  type OrderQueueTab,
} from "../lib/order-phase"
import type { MerchantSetupReadiness } from "../lib/readiness"

export const Route = createFileRoute("/")({
  component: DashboardPage,
})

type MerchantDashboardStats = {
  listings: number
  openOrders: number
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

  let openOrders = 0
  for (const messages of byOrder.values()) {
    // Only orders received as the merchant; skip orders placed as a buyer
    // (the buyer sends the `order`, so a self-sent order is a buyer order).
    const orderMessage = messages.find((message) => message.type === "order")
    if (orderMessage && orderMessage.senderPubkey === pubkey) continue

    openOrders += 1
  }

  const latestOrders = [...parsedMessages]
    .filter(
      (message) =>
        message.type === "order" && message.recipientPubkey === pubkey
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)

  return {
    listings: 0,
    openOrders,
    latestOrders,
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
  to,
  search,
}: {
  label: string
  value: number
  icon: LucideIcon
  to: "/products" | "/orders"
  search?: { queue?: OrderQueueTab }
}) {
  return (
    <Link
      to={to}
      search={search}
      className="block rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)] hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {label}
          </div>
          <div className="mt-3 text-3xl font-semibold tracking-tight text-[var(--text-primary)] tabular-nums">
            {value}
          </div>
        </div>
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]">
          <Icon aria-hidden={true} className="h-5 w-5" />
        </span>
      </div>
    </Link>
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
  const readiness = useMerchantReadinessState()
  const [chartRanges, setChartRanges] = useState<DashboardChartRanges>(() => ({
    orders: DEFAULT_DASHBOARD_RANGE,
    status: DEFAULT_DASHBOARD_RANGE,
    revenue: DEFAULT_DASHBOARD_RANGE,
    products: DEFAULT_DASHBOARD_RANGE,
  }))
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
  const btcRateQuery = useBtcUsdRate()
  const stats = statsQuery.data ?? cachedStatsQuery.data
  const allConversations = useMemo(
    () =>
      conversationsQuery.data?.data ??
      cachedConversationsQuery.data?.data ??
      [],
    [conversationsQuery.data, cachedConversationsQuery.data]
  )
  const latestConversations = useMemo(
    () => allConversations.slice(0, 5),
    [allConversations]
  )
  const queueCounts = useMemo(() => {
    let verifyPayment = 0
    let paidFulfill = 0
    for (const conversation of allConversations) {
      const queue = getMerchantConversationQueue(conversation)
      if (queue === "verify_payment") verifyPayment += 1
      if (queue === "paid_fulfill") paidFulfill += 1
    }
    return { verifyPayment, paidFulfill }
  }, [allConversations])
  const chartData = useMemo<DashboardChartDataByCard>(() => {
    const now = Date.now()
    const cache = new Map<
      DashboardRangePreset,
      ReturnType<typeof buildDashboardChartData>
    >()
    const build = (preset: DashboardRangePreset) => {
      const cached = cache.get(preset)
      if (cached) return cached
      const data = buildDashboardChartData(
        allConversations,
        btcRateQuery.data ?? null,
        resolveDashboardPresetRange(preset, now)
      )
      cache.set(preset, data)
      return data
    }
    return {
      orders: build(chartRanges.orders),
      status: build(chartRanges.status),
      revenue: build(chartRanges.revenue),
      products: build(chartRanges.products),
    }
  }, [allConversations, btcRateQuery.data, chartRanges])
  const changeChartRange = useCallback(
    (chart: DashboardChartId, range: DashboardRangePreset) => {
      setChartRanges((current) => ({ ...current, [chart]: range }))
    },
    []
  )
  const buyerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          latestConversations
            .filter((conversation) => !isMerchantGuestOrder(conversation))
            .map((conversation) => conversation.buyerPubkey)
        )
      ),
    [latestConversations]
  )
  const buyerProfilesQuery = useProfiles(buyerPubkeys, {
    enabled: !!pubkey && buyerPubkeys.length > 0,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Merchant Portal
        </h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-7 text-[var(--text-secondary)]">
          Publish products, manage incoming orders, and keep buyer conversations
          moving.
        </p>
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
          to="/products"
        />
        <StatCard
          label="Open orders"
          value={stats?.openOrders ?? 0}
          icon={ShoppingBag}
          to="/orders"
          search={{}}
        />
        <StatCard
          label="Awaiting payment verification"
          value={queueCounts.verifyPayment}
          icon={Wallet}
          to="/orders"
          search={{ queue: "verify_payment" }}
        />
        <StatCard
          label="Awaiting fulfillment"
          value={queueCounts.paidFulfill}
          icon={Truck}
          to="/orders"
          search={{ queue: "paid_fulfill" }}
        />
      </div>

      {pubkey && <MerchantReadinessPanel readiness={readiness} />}

      {pubkey && allConversations.length > 0 && (
        <DashboardCharts
          data={chartData}
          ranges={chartRanges}
          onRangeChange={changeChartRange}
        />
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <section className="self-start rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-balance text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                Keep your merchant loop moving
              </h2>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Link
              to="/products"
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-elevated)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Manage listings
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Create, edit, and publish products.
                  </div>
                </div>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              </div>
            </Link>

            <Link
              to="/orders"
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-elevated)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Open order inbox
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Review buyer messages, invoices, and status updates.
                  </div>
                </div>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              </div>
            </Link>
          </div>
        </section>

        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-balance text-xl font-semibold text-[var(--text-primary)]">
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
                buyerProfile={buyerProfilesQuery.data[conversation.buyerPubkey]}
                active={false}
                onClick={() =>
                  navigate({
                    to: "/orders",
                    search: { order: conversation.orderId },
                  })
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
