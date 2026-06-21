import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  db,
  formatNpub,
  formatPubkey,
  getProductPriceDisplay,
  listOrderLifecycles,
  normalizeLightningInvoice,
  pubkeyToNpub,
  useAuth,
  useProfile,
  useProfiles,
  type OrderLifecycle,
} from "@conduit/core"
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusStepper,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@conduit/ui"
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  MessageCircle,
  ReceiptText,
  RotateCw,
  Search,
  ShoppingBag,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { requireAuth } from "../lib/auth"
import { CopyButton } from "../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../components/MerchantIdentity"
import {
  fetchBuyerConversations,
  fetchCachedBuyerConversations,
  type BuyerConversation,
} from "../lib/orderConversations"
import { fetchStoreProducts } from "../lib/storeProducts"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useWallet } from "../hooks/useWallet"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  deriveOrderHeaderStatus,
  type OrderHeaderStatus,
  type OrderViewModel,
} from "../lib/order-view"
import {
  resendOrderProof,
  runOrderPayment,
  submitExternalPaymentProof,
  subscribeOrderPayment,
  type OrderPaymentContext,
} from "../lib/order-payment-service"

const ORDERS_SEARCH_DEFAULT: { order?: string } = {}

export const Route = createFileRoute("/orders")({
  validateSearch: (search: Record<string, unknown>): { order?: string } => {
    const order = search.order
    return typeof order === "string" && order.length > 0
      ? { order }
      : ORDERS_SEARCH_DEFAULT
  },
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

const TONE_CLASS: Record<OrderHeaderStatus["tone"], string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  info: "border-secondary-500/40 bg-secondary-500/10 text-secondary-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  error: "border-error/40 bg-error/10 text-error",
  neutral:
    "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]",
}

/** A merged order: durable local lifecycle and/or relay conversation. */
interface OrderRow {
  orderId: string
  merchantPubkey: string
  lifecycle?: OrderLifecycle
  conversation?: BuyerConversation
  vm: OrderViewModel
  headerStatus: OrderHeaderStatus
  updatedAt: number
}

function StatusPill({ status }: { status: OrderHeaderStatus }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline" className={`capitalize ${TONE_CLASS[status.tone]}`}>
        {status.primaryLabel}
      </Badge>
      <span className="text-xs text-[var(--text-secondary)]">
        · {status.detailLabel}
      </span>
    </span>
  )
}

function MerchantAvatar({
  pubkey,
  name,
  picture,
}: {
  pubkey: string
  name: string
  picture?: string
}) {
  return (
    <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
      {picture ? (
        <img
          src={picture}
          alt={name || formatNpub(pubkey, 8)}
          className="h-full w-full object-cover"
        />
      ) : (
        <MerchantAvatarFallback />
      )}
    </div>
  )
}

function OrderListCard({
  row,
  merchantName,
  merchantPicture,
  active,
  onClick,
}: {
  row: OrderRow
  merchantName: string
  merchantPicture?: string
  active: boolean
  onClick: () => void
}) {
  const itemTitle = row.vm.items[0]?.displayTitle ?? "Order"
  return (
    <button
      type="button"
      onClick={onClick}
      data-order-id={row.orderId}
      className={[
        "w-full rounded-[1.1rem] border p-3 text-left transition-[border-color,background-color]",
        active
          ? "border-[var(--text-secondary)] bg-[var(--surface)]"
          : "border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <MerchantAvatar
          pubkey={row.merchantPubkey}
          name={merchantName}
          picture={merchantPicture}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {merchantName}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {new Date(row.updatedAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
            {itemTitle}
          </div>
          {typeof row.vm.totalSats === "number" && (
            <div className="mt-0.5 text-sm font-medium text-secondary-300">
              {row.vm.totalSats.toLocaleString()} sats
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <StatusPill status={row.headerStatus} />
            {row.headerStatus.actionNeeded && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

function OrderTimeline({ vm }: { vm: OrderViewModel }) {
  const rows = useMemo(() => buildOrderTimeline(vm), [vm])
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        Order progress
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Here's where your order stands.
      </p>
      <div className="mt-5">
        <StatusStepper rows={rows} ariaLabel="Order progress" />
      </div>
    </section>
  )
}

/** External-wallet QR fallback (CND-120): shown when payment is manual_required. */
function ExternalWalletPanel({
  vm,
  onMarkPaid,
  busy,
}: {
  vm: OrderViewModel
  onMarkPaid: () => void
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)
  const invoice = vm.invoice
  if (!invoice) return null
  const bolt11 = normalizeLightningInvoice(invoice)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        Pay with an external wallet
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        No automatic wallet was available. Scan or copy this invoice, pay it in
        your wallet, then send the receipt to the merchant.
      </p>
      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={bolt11} size={156} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild className="h-10 px-4 text-sm">
              <a href={`lightning:${bolt11}`}>
                <ExternalLink className="h-4 w-4" />
                Open in wallet
              </a>
            </Button>
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              onClick={copy}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy invoice"}
            </Button>
          </div>
          <div className="max-h-24 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-secondary)]">
            {invoice}
          </div>
          <Button
            variant="primary"
            className="h-10 px-4 text-sm"
            disabled={busy}
            onClick={onMarkPaid}
          >
            I've paid — send receipt
          </Button>
        </div>
      </div>
    </section>
  )
}

function OrderDetail({
  row,
  pubkey,
}: {
  row: OrderRow
  pubkey: string
}) {
  const { vm, headerStatus } = row
  const wallet = useWallet()
  const btcUsdRateQuery = useBtcUsdRate()
  const { data: profile } = useProfile(row.merchantPubkey, {
    maxUnresolvedRefetches: 1,
  })
  const merchantName = getMerchantDisplayName(profile, row.merchantPubkey)
  const [busy, setBusy] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const productsQuery = useQuery({
    queryKey: ["selected-order-products", row.merchantPubkey],
    enabled: !!row.merchantPubkey,
    queryFn: () => fetchStoreProducts(row.merchantPubkey),
  })
  const productsById = useMemo(() => {
    const map = new Map<
      string,
      Awaited<ReturnType<typeof fetchStoreProducts>>["data"][number]
    >()
    for (const product of productsQuery.data?.data ?? []) map.set(product.id, product)
    return map
  }, [productsQuery.data])

  const canTryNwc =
    !!wallet.connection &&
    wallet.status !== "unsupported" &&
    wallet.status !== "error"

  function buildServiceCtx(): OrderPaymentContext | null {
    const lc = row.lifecycle
    if (!lc) return null
    return {
      orderId: vm.orderId,
      buyerPubkey: pubkey,
      merchantPubkey: row.merchantPubkey,
      merchantLud16: profile?.lud16 ?? null,
      visibility:
        lc.checkoutMode === "private_checkout"
          ? "private_checkout"
          : "public_zap",
      zapContent: "",
      totalSats: lc.totalSats,
      totalMsats: lc.totalMsats,
      walletConnection: wallet.connection,
      tryNwc: canTryNwc,
    }
  }

  const withBusy = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  const showRetryPayment = vm.paymentStatus === "failed"
  const showExternalWallet = vm.paymentStatus === "manual_required"
  const showResendProof =
    vm.paymentStatus === "paid" &&
    (vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed")

  const messageMerchant = (
    <Button asChild variant="outline" className="h-10 px-4 text-sm">
      <Link to="/messages" search={{ tab: "merchants", thread: vm.orderId }}>
        <MessageCircle className="h-4 w-4" />
        Message merchant
      </Link>
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Hero */}
      <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <MerchantAvatar
              pubkey={row.merchantPubkey}
              name={merchantName}
              picture={profile?.picture}
            />
            <div className="min-w-0">
              <Link
                to="/store/$pubkey"
                params={{ pubkey: pubkeyToNpub(row.merchantPubkey) }}
                className="truncate text-lg font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
              >
                {merchantName}
              </Link>
              <div className="mt-0.5 text-sm text-[var(--text-secondary)]">
                {vm.items[0]?.displayTitle ?? "Order"}
              </div>
              {typeof vm.totalSats === "number" && (
                <div className="text-sm font-medium text-secondary-300">
                  {vm.totalSats.toLocaleString()} sats
                </div>
              )}
              <div className="mt-2">
                <StatusPill status={headerStatus} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <Button asChild className="h-10 px-4 text-sm">
              <Link to="/products">
                <ShoppingBag className="h-4 w-4" />
                Keep shopping
              </Link>
            </Button>
            {messageMerchant}
          </div>
        </div>
      </section>

      {showExternalWallet && (
        <ExternalWalletPanel
          vm={vm}
          busy={busy}
          onMarkPaid={() =>
            void withBusy(() => submitExternalPaymentProof(vm.orderId))
          }
        />
      )}

      {(showRetryPayment || showResendProof) && (
        <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            {showRetryPayment && (
              <Button
                className="h-10 px-4 text-sm"
                disabled={busy}
                onClick={() => {
                  const ctx = buildServiceCtx()
                  if (ctx) void withBusy(() => runOrderPayment(ctx))
                }}
              >
                <RotateCw className="h-4 w-4" />
                Try payment again
              </Button>
            )}
            {showResendProof && (
              <Button
                variant="outline"
                className="h-10 px-4 text-sm"
                disabled={busy}
                onClick={() =>
                  void withBusy(() => resendOrderProof(vm.orderId))
                }
              >
                <RotateCw className="h-4 w-4" />
                Resend receipt
              </Button>
            )}
            <span className="text-xs text-[var(--text-secondary)]">
              {showRetryPayment
                ? "No funds moved. You can retry payment for this order."
                : "Payment went through; the receipt didn't reach the merchant."}
            </span>
          </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <OrderTimeline vm={vm} />

        <div className="space-y-4">
          {/* Items */}
          <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <ShoppingBag className="h-4 w-4" /> Items
            </h3>
            <div className="mt-3 space-y-3">
              {vm.items.map((item, index) => {
                const product = productsById.get(item.productId)
                const image = product?.images[0]
                const price = getProductPriceDisplay(
                  {
                    price: item.priceAtPurchase,
                    currency: item.currency,
                    priceSats:
                      item.currency === "SATS" ? item.priceAtPurchase : undefined,
                  },
                  btcUsdRateQuery.data ?? null
                )
                return (
                  <div
                    key={`${item.productId}-${index}`}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                        {image ? (
                          <img
                            src={image.url}
                            alt={image.alt ?? product?.title ?? item.displayTitle}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[var(--text-primary)]">
                          {product?.title ?? item.displayTitle}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                          Qty {item.quantity}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[var(--text-secondary)]">
                      {price.primary}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* Shipping address */}
          {vm.shippingAddress && (
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Shipping address
                </h3>
                <Button asChild variant="ghost" className="h-8 px-3 text-xs">
                  <Link to="/messages" search={{ tab: "merchants", thread: vm.orderId }}>
                    Edit
                  </Link>
                </Button>
              </div>
              <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                <div className="text-[var(--text-primary)]">
                  {vm.shippingAddress.name}
                </div>
                <div>{vm.shippingAddress.street}</div>
                <div>
                  {vm.shippingAddress.city}
                  {vm.shippingAddress.state ? `, ${vm.shippingAddress.state}` : ""}{" "}
                  {vm.shippingAddress.postalCode}
                </div>
                <div>{vm.shippingAddress.country}</div>
              </div>
            </section>
          )}

          {/* Order details (technical, collapsed) */}
          <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)]">
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
            >
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                Order details
              </span>
              <ChevronRight
                className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${detailsOpen ? "rotate-90" : ""}`}
              />
            </button>
            {detailsOpen && (
              <div className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm">
                <DetailRow label="Order ID">
                  <span className="font-mono text-xs">
                    {formatPubkey(vm.orderId, 8)}
                  </span>
                  <CopyButton value={vm.orderId} label="Copy order id" />
                </DetailRow>
                <DetailRow label="Order npub">
                  <span className="font-mono text-xs">
                    {formatNpub(row.merchantPubkey, 8)}
                  </span>
                  <CopyButton value={row.merchantPubkey} label="Copy pubkey" />
                </DetailRow>
                {typeof vm.totalSats === "number" && (
                  <DetailRow label="Payment">
                    <span>{vm.totalSats.toLocaleString()} sats</span>
                  </DetailRow>
                )}
                <DetailRow label="Paid with">
                  <span className="capitalize">
                    {vm.checkoutMode?.replace(/_/g, " ") ?? "—"}
                  </span>
                </DetailRow>
                <DetailRow label="Ordered">
                  <span>{new Date(vm.createdAt).toLocaleString()}</span>
                </DetailRow>
              </div>
            )}
          </section>

          {/* Need help */}
          <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Need help?
            </h3>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Message the merchant for any questions or issues.
            </p>
            <div className="mt-3">{messageMerchant}</div>
          </section>
        </div>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="flex items-center gap-2 text-[var(--text-primary)]">
        {children}
      </span>
    </div>
  )
}

type PhaseTab = "all" | "pending" | "in_progress" | "completed"

function OrdersPage() {
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { order: selectedFromUrl } = Route.useSearch()
  const [searchValue, setSearchValue] = useState("")
  const [tab, setTab] = useState<PhaseTab>("all")
  const [changeOrderOpen, setChangeOrderOpen] = useState(false)
  const [refreshButtonState, setRefreshButtonState] = useState<
    "idle" | "refreshing" | "done"
  >("idle")
  const refreshResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lifecyclesQuery = useQuery({
    queryKey: ["order-lifecycles", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => listOrderLifecycles(pubkey!),
    refetchInterval: 30_000,
  })
  const messagesQuery = useQuery({
    queryKey: ["buyer-messages-live", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchBuyerConversations(pubkey!),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedMessagesQuery = useQuery({
    queryKey: ["buyer-messages", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchCachedBuyerConversations(pubkey!),
    staleTime: 5_000,
  })

  const isFetching = messagesQuery.isFetching || lifecyclesQuery.isFetching
  const refetchAll = useCallback(() => {
    void messagesQuery.refetch()
    void lifecyclesQuery.refetch()
  }, [messagesQuery, lifecyclesQuery])

  useEffect(() => {
    if (isFetching) {
      if (refreshResetTimerRef.current) {
        clearTimeout(refreshResetTimerRef.current)
        refreshResetTimerRef.current = null
      }
      setRefreshButtonState("refreshing")
      return
    }
    if (refreshButtonState === "refreshing") {
      setRefreshButtonState("done")
      refreshResetTimerRef.current = setTimeout(() => {
        setRefreshButtonState("idle")
        refreshResetTimerRef.current = null
      }, 900)
    }
  }, [isFetching, refreshButtonState])

  useEffect(
    () => () => {
      if (refreshResetTimerRef.current) clearTimeout(refreshResetTimerRef.current)
    },
    []
  )

  const handleRefresh = useCallback(() => {
    if (!signerConnected) return
    setRefreshButtonState("refreshing")
    refetchAll()
  }, [refetchAll, signerConnected])

  const conversations = useMemo(
    () => messagesQuery.data?.data ?? cachedMessagesQuery.data?.data ?? [],
    [cachedMessagesQuery.data, messagesQuery.data]
  )
  const lifecycles = useMemo(
    () => lifecyclesQuery.data ?? [],
    [lifecyclesQuery.data]
  )

  // Merge lifecycle records and relay conversations by orderId.
  const orders = useMemo<OrderRow[]>(() => {
    const byId = new Map<
      string,
      { lifecycle?: OrderLifecycle; conversation?: BuyerConversation }
    >()
    for (const lc of lifecycles) {
      byId.set(lc.orderId, { lifecycle: lc })
    }
    for (const conversation of conversations) {
      const entry = byId.get(conversation.orderId) ?? {}
      entry.conversation = conversation
      byId.set(conversation.orderId, entry)
    }
    const rows: OrderRow[] = []
    for (const [orderId, entry] of byId) {
      const merchantPubkey =
        entry.lifecycle?.merchantPubkey ?? entry.conversation?.merchantPubkey ?? ""
      const vm = buildOrderViewModel({
        orderId,
        merchantPubkey,
        lifecycle: entry.lifecycle,
        conversation: entry.conversation,
        messages: entry.conversation?.messages,
      })
      rows.push({
        orderId,
        merchantPubkey,
        lifecycle: entry.lifecycle,
        conversation: entry.conversation,
        vm,
        headerStatus: deriveOrderHeaderStatus(vm),
        updatedAt: vm.updatedAt,
      })
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations, lifecycles])

  const merchantPubkeys = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.merchantPubkey).filter(Boolean))),
    [orders]
  )
  const merchantProfilesQuery = useProfiles(merchantPubkeys, {
    enabled: signerConnected && merchantPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })
  const merchantName = useCallback(
    (pk: string) =>
      getMerchantDisplayName(merchantProfilesQuery.data?.[pk], pk),
    [merchantProfilesQuery.data]
  )

  const filteredOrders = useMemo(() => {
    const query = searchValue.trim().toLowerCase()
    return orders.filter((row) => {
      if (tab !== "all" && row.vm.phase !== tab) {
        // "in_progress" tab also surfaces failed/action-needed active orders.
        if (!(tab === "in_progress" && row.headerStatus.actionNeeded))
          return false
      }
      if (!query) return true
      return (
        merchantName(row.merchantPubkey).toLowerCase().includes(query) ||
        row.orderId.toLowerCase().includes(query) ||
        row.merchantPubkey.toLowerCase().includes(query) ||
        row.headerStatus.primaryLabel.toLowerCase().includes(query) ||
        row.vm.items.some((item) =>
          item.displayTitle.toLowerCase().includes(query)
        )
      )
    })
  }, [merchantName, orders, searchValue, tab])

  const selectedOrderId = useMemo(() => {
    if (selectedFromUrl && orders.some((o) => o.orderId === selectedFromUrl)) {
      return selectedFromUrl
    }
    return filteredOrders[0]?.orderId ?? orders[0]?.orderId ?? null
  }, [filteredOrders, orders, selectedFromUrl])

  const selected = useMemo(
    () => orders.find((o) => o.orderId === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  )

  const selectOrder = useCallback(
    (orderId: string) => {
      setChangeOrderOpen(false)
      void navigate({ to: "/orders", search: { order: orderId }, replace: true })
    },
    [navigate]
  )

  // Attach the stored payment attempt to the selected order's view-model and
  // subscribe to the live payment service so progress refreshes without reload.
  const paymentAttemptQuery = useQuery({
    queryKey: ["buyer-payment-attempt", selected?.orderId ?? "none"],
    enabled: !!selected?.orderId,
    queryFn: async () => (await db.paymentAttempts.get(selected!.orderId)) ?? null,
  })
  useEffect(() => {
    if (!selected?.orderId) return
    const unsub = subscribeOrderPayment(selected.orderId, () => {
      void lifecyclesQuery.refetch()
      void queryClient.invalidateQueries({
        queryKey: ["buyer-payment-attempt", selected.orderId],
      })
    })
    return unsub
  }, [lifecyclesQuery, queryClient, selected?.orderId])

  const selectedRow = useMemo<OrderRow | null>(() => {
    if (!selected) return null
    if (!paymentAttemptQuery.data) return selected
    const vm = buildOrderViewModel({
      orderId: selected.orderId,
      merchantPubkey: selected.merchantPubkey,
      lifecycle: selected.lifecycle,
      conversation: selected.conversation,
      messages: selected.conversation?.messages,
      paymentAttempt: paymentAttemptQuery.data,
    })
    return {
      ...selected,
      vm,
      headerStatus: deriveOrderHeaderStatus(vm),
    }
  }, [paymentAttemptQuery.data, selected])

  const hasOrders = orders.length > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Orders
          </h1>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
            Track your purchases, payment status, and shipping progress.
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 px-4 text-sm"
          disabled={!signerConnected || isFetching}
          onClick={handleRefresh}
        >
          <span className="inline-flex items-center gap-2">
            {refreshButtonState === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <RotateCw
                className={`h-4 w-4 ${refreshButtonState === "refreshing" ? "animate-spin text-amber-300" : ""}`}
              />
            )}
            {refreshButtonState === "refreshing"
              ? "Refreshing…"
              : refreshButtonState === "done"
                ? "Updated"
                : "Refresh"}
          </span>
        </Button>
      </div>

      {!signerConnected && (
        <EmptyState
          title="Connect to view your orders"
          body="Order updates, invoices, and merchant replies are tied to your signer identity."
        />
      )}

      {signerConnected && !lifecyclesQuery.isLoading && !hasOrders && (
        <EmptyState
          title="No orders yet"
          body="Place your first order and it will appear here with live status."
          action={
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/products">Browse products</Link>
            </Button>
          }
        />
      )}

      {signerConnected && hasOrders && (
        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          {/* Desktop left rail */}
          <aside className="hidden xl:block">
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-sm font-medium text-[var(--text-primary)]">
                Your orders
              </div>
              <SearchBox value={searchValue} onChange={setSearchValue} />
              <OrderList
                rows={filteredOrders}
                selectedOrderId={selectedOrderId}
                merchantName={merchantName}
                merchantPicture={(pk) =>
                  merchantProfilesQuery.data?.[pk]?.picture
                }
                onSelect={selectOrder}
              />
            </section>
          </aside>

          {/* Mobile: tabs + current order card + change-order sheet */}
          <div className="space-y-4 xl:hidden">
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as PhaseTab)}
            >
              <TabsList className="w-full">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="pending">Pending</TabsTrigger>
                <TabsTrigger value="in_progress">In progress</TabsTrigger>
                <TabsTrigger value="completed">Completed</TabsTrigger>
              </TabsList>
            </Tabs>
            {selectedRow && (
              <section className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Current order
                </div>
                <div className="mt-2">
                  <OrderListCard
                    row={selectedRow}
                    merchantName={merchantName(selectedRow.merchantPubkey)}
                    merchantPicture={
                      merchantProfilesQuery.data?.[selectedRow.merchantPubkey]
                        ?.picture
                    }
                    active
                    onClick={() => setChangeOrderOpen(true)}
                  />
                </div>
                <Sheet open={changeOrderOpen} onOpenChange={setChangeOrderOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="outline"
                      className="mt-3 h-10 w-full justify-between px-4 text-sm"
                    >
                      Change order
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
                    <SheetHeader>
                      <SheetTitle>Your orders</SheetTitle>
                    </SheetHeader>
                    <SearchBox value={searchValue} onChange={setSearchValue} />
                    <OrderList
                      rows={filteredOrders}
                      selectedOrderId={selectedOrderId}
                      merchantName={merchantName}
                      merchantPicture={(pk) =>
                        merchantProfilesQuery.data?.[pk]?.picture
                      }
                      onSelect={selectOrder}
                    />
                  </SheetContent>
                </Sheet>
              </section>
            )}
          </div>

          {/* Detail */}
          <section>
            {selectedRow ? (
              <OrderDetail row={selectedRow} pubkey={pubkey!} />
            ) : (
              <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--text-secondary)]">
                Select an order to view its status.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search orders"
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
      />
    </div>
  )
}

function OrderList({
  rows,
  selectedOrderId,
  merchantName,
  merchantPicture,
  onSelect,
}: {
  rows: OrderRow[]
  selectedOrderId: string | null
  merchantName: (pk: string) => string
  merchantPicture: (pk: string) => string | undefined
  onSelect: (orderId: string) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-4 rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
        No orders match this filter.
      </div>
    )
  }
  return (
    <div className="mt-4 space-y-2">
      {rows.map((row) => (
        <OrderListCard
          key={row.orderId}
          row={row}
          merchantName={merchantName(row.merchantPubkey)}
          merchantPicture={merchantPicture(row.merchantPubkey)}
          active={row.orderId === selectedOrderId}
          onClick={() => onSelect(row.orderId)}
        />
      ))}
    </div>
  )
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
        <ReceiptText className="h-7 w-7" />
      </div>
      <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
        {title}
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
        {body}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </section>
  )
}
