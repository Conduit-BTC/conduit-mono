import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  buildOrderStatusTimeline,
  canMockInvoice,
  convertCommerceAmountToSats,
  decodeLightningInvoiceAmount,
  formatNpub,
  getCachedMerchantConversationList,
  getCurrencyAmountStep,
  getLightningNetworkMismatchMessage,
  getMerchantConversationList,
  getMerchantOrderActions,
  getProductImageCandidates,
  getProductsByIds,
  hasWebLN,
  isInvoiceCompatibleWithCurrentNetwork,
  isMerchantOrderPaid,
  mockMakeInvoice,
  normalizeCurrencyAmount,
  normalizeSafeHttpUrl,
  nwcMakeInvoice,
  publishMerchantOrderMessage,
  pubkeyToNpub,
  weblnMakeInvoice,
  type MerchantConversationSummary,
  type MerchantOrderAction,
  type MerchantOrderState,
  type KnownOrderStatus,
  type Profile,
  useAuth,
  useProfiles,
} from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  OrderMessagesWidget,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  StatusStepper,
  cn,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { BuyerAvatar, OrderListItem } from "../components/OrderListItem"
import {
  getMerchantBuyerDisplayName,
  getMerchantConversationQueue,
  getMerchantConversationCommunication,
  getMerchantConversationState,
  getMerchantConversationStatusDisplay,
  getMerchantOrderRequiresShipping,
  getMerchantOrderSummary,
  isMerchantGuestOrder,
  isOrderQueueTab,
  isMerchantConversationActiveFulfillment,
  ORDER_PHASE_OPTIONS,
  type OrderQueueTab,
} from "../lib/order-phase"
import {
  buildMerchantOrderActionView,
  getMerchantOrderCancellationCopy,
  isMerchantOrderActionSurfacePending,
  runExclusiveOrderAction,
} from "../lib/order-action-view"
import { getProfileUrl } from "../lib/market-links"
import { prepareShippingUpdate } from "../lib/shipping-update"
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  MessageCircle,
  RotateCw,
  Search,
  ShoppingBag,
} from "lucide-react"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useMerchantPaymentAutomation } from "../hooks/useMerchantPaymentAutomation"

type OrdersSearch = { order?: string; queue?: OrderQueueTab }

const ORDERS_SEARCH_DEFAULT: OrdersSearch = {}

export const Route = createFileRoute("/orders")({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const order = search.order
    const queue = search.queue
    return {
      ...(typeof order === "string" && order.length > 0 ? { order } : {}),
      ...(isOrderQueueTab(queue) && queue !== "all" ? { queue } : {}),
    }
  },
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

const INVOICE_CURRENCY_OPTIONS = ["USD", "SATS"] as const

function normalizeInvoiceCurrencyChoice(
  currency: string | undefined
): (typeof INVOICE_CURRENCY_OPTIONS)[number] | "" {
  const normalized = currency?.trim().toUpperCase()
  if (normalized === "SAT" || normalized === "SATS") return "SATS"
  if (normalized === "USD") return "USD"
  return ""
}

const panelCard =
  "rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"

function formatSummaryAmount(amount: number, currency: string): string {
  if (currency.trim().toUpperCase() === "SATS")
    return `${amount.toLocaleString()} sats`
  return `${amount.toLocaleString()} ${currency.trim().toUpperCase()}`
}

function CopyInline({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
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
        aria-label="Search orders"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search orders"
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
      />
    </div>
  )
}

// Cap how many recent orders' product listings we resolve for search, so the
// batched relay read stays bounded on large inboxes.
const ORDER_SEARCH_PRODUCT_CAP = 100

function emptyOrdersLabel(query: string, phase: OrderQueueTab): string {
  if (query) return `No orders match "${query}".`
  if (phase !== "all") {
    const label =
      ORDER_PHASE_OPTIONS.find((option) => option.value === phase)?.label ?? ""
    return `No ${label.toLowerCase()} orders.`
  }
  return "No orders yet."
}

function OrderPhaseFilter({
  value,
  onChange,
}: {
  value: OrderQueueTab
  onChange: (value: OrderQueueTab) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        const selectedOption = ORDER_PHASE_OPTIONS.find(
          (option) => option.value === nextValue
        )
        if (selectedOption) onChange(selectedOption.value)
      }}
    >
      <SelectTrigger
        aria-label="Filter orders by status"
        className="mt-3 h-11 rounded-xl bg-[var(--surface)] px-3 shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ORDER_PHASE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MobileOrdersScroller({
  conversations,
  selectedId,
  buyerProfiles,
  onSelect,
}: {
  conversations: MerchantConversationSummary[]
  selectedId: string | null
  buyerProfiles: Record<string, Profile | undefined>
  onSelect: (id: string) => void
}) {
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  // Keep the natural order; just scroll the selected order into view.
  useEffect(() => {
    if (!selectedId) return
    cardRefs.current.get(selectedId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    })
  }, [selectedId])

  return (
    <section className="min-w-0 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      {conversations.length === 0 ? (
        <div className="rounded-[1.25rem] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
          No orders match this filter.
        </div>
      ) : (
        <div
          className="min-w-0 touch-pan-x overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            maskImage:
              "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
          }}
        >
          <div className="flex min-w-max snap-x snap-mandatory gap-3 pb-1 pr-14">
            {conversations.map((conversation) => {
              const active = conversation.id === selectedId
              const buyerProfile = isMerchantGuestOrder(conversation)
                ? undefined
                : buyerProfiles[conversation.buyerPubkey]
              const buyerName = getMerchantBuyerDisplayName(
                conversation,
                buyerProfile
              )
              const statusDisplay =
                getMerchantConversationStatusDisplay(conversation)
              return (
                <button
                  key={conversation.id}
                  type="button"
                  ref={(el) => {
                    if (el) cardRefs.current.set(conversation.id, el)
                    else cardRefs.current.delete(conversation.id)
                  }}
                  onClick={() => onSelect(conversation.id)}
                  className={`w-[16.5rem] shrink-0 snap-start rounded-[1.25rem] border p-4 text-left transition-[border-color,background-color,transform] ${
                    active
                      ? "border-[color-mix(in_srgb,var(--primary-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_7%,transparent)]"
                      : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <BuyerAvatar
                        name={buyerName}
                        picture={buyerProfile?.picture}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {buyerName}
                        </div>
                        <div className="mt-1 truncate text-sm text-[var(--text-secondary)]">
                          {conversation.preview || "Order"}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <StatusPill
                      variant={statusDisplay.tone}
                      className="capitalize"
                    >
                      {statusDisplay.label}
                    </StatusPill>
                    {conversation.totalSummary && (
                      <span className="text-xs font-medium text-secondary-300">
                        {conversation.totalSummary}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function OrderItemsCard({
  items,
  productLookup,
  subtotal,
  currency,
}: {
  items: Array<{
    productId: string
    title?: string
    quantity: number
    priceAtPurchase: number
    currency: string
  }>
  productLookup: Map<
    string,
    {
      title: string
      imageUrl?: string
      format: "physical" | "digital"
    }
  >
  subtotal: number
  currency: string
}) {
  return (
    <section className={panelCard}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <ShoppingBag className="h-4 w-4" />
        Items
      </h3>
      <div className="mt-3 space-y-3">
        {items.map((item) => {
          const match = productLookup.get(item.productId)
          const image = match?.imageUrl
          const title = item.title || match?.title || "Product"
          return (
            <div
              key={item.productId}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                  {image ? (
                    <img
                      src={image}
                      alt={title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="text-[var(--text-primary)]">{title}</div>
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    Qty {item.quantity}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right text-[var(--text-secondary)]">
                {formatSummaryAmount(item.priceAtPurchase, item.currency)}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4 text-sm">
        <span className="font-medium text-[var(--text-secondary)]">Total</span>
        <span className="text-base font-semibold text-[var(--text-primary)]">
          {formatSummaryAmount(subtotal, currency)}
        </span>
      </div>
    </section>
  )
}

function OrdersPage() {
  const { pubkey, status } = useAuth()
  const navigate = useNavigate()
  const { order: selectedFromUrl, queue: queueFromUrl } = Route.useSearch()
  const selectedQueueFromUrl = queueFromUrl ?? "all"
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const queryClient = useQueryClient()
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [orderSearch, setOrderSearch] = useState("")
  const [phaseTab, setPhaseTab] = useState<OrderQueueTab>(selectedQueueFromUrl)
  const [ordersSheetOpen, setOrdersSheetOpen] = useState(false)
  const [orderDetailsOpen, setOrderDetailsOpen] = useState(false)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [invoice, setInvoice] = useState("")
  const [invoiceAmount, setInvoiceAmount] = useState("")
  const [invoiceCurrency, setInvoiceCurrency] = useState("USD")
  const [invoiceNote, setInvoiceNote] = useState("")
  const [carrier, setCarrier] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")
  const [shippingNote, setShippingNote] = useState("")
  const [replyNote, setReplyNote] = useState("")
  const [successFlash, setSuccessFlash] = useState<string | null>(null)
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<MerchantOrderAction | null>(null)
  const [confirmingOutOfBandPayment, setConfirmingOutOfBandPayment] =
    useState(false)
  const orderActionLockRef = useRef(false)
  const [weblnAvailable, setWeblnAvailable] = useState(false)
  const [refreshButtonState, setRefreshButtonState] = useState<
    "idle" | "refreshing" | "done"
  >("idle")
  const selectedOrderResetRef = useRef<string | null>(null)
  const refreshResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const signerConnected = status === "connected" && !!pubkey
  const invoiceAmountNumber = useMemo(() => {
    const amount = Number(invoiceAmount)
    if (!Number.isFinite(amount) || amount < 0) return 0
    const normalized = normalizeCurrencyAmount(amount, invoiceCurrency)
    return normalized.status === "ok" ? normalized.amount : 0
  }, [invoiceAmount, invoiceCurrency])
  const invoiceAmountSats = useMemo(
    () =>
      invoiceCurrency
        ? convertCommerceAmountToSats(
            invoiceAmountNumber,
            invoiceCurrency,
            btcUsdRate
          )
        : null,
    [btcUsdRate, invoiceAmountNumber, invoiceCurrency]
  )
  const manualInvoiceDecoded = useMemo(
    () =>
      invoice.trim() ? decodeLightningInvoiceAmount(invoice.trim()) : null,
    [invoice]
  )

  useEffect(() => {
    // Detect WebLN (Alby extension) — may load after page render
    const check = () => setWeblnAvailable(hasWebLN())
    check()
    const timer = setTimeout(check, 1000)
    return () => clearTimeout(timer)
  }, [])

  const flash = useCallback((message: string) => {
    setSuccessFlash(message)
  }, [])

  const nwc = useMerchantPaymentAutomation()

  const ordersQuery = useQuery({
    queryKey: ["merchant-order-messages-live", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => getMerchantConversationList({ principalPubkey: pubkey! }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedOrdersQuery = useQuery({
    queryKey: ["merchant-order-messages", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () =>
      getCachedMerchantConversationList({ principalPubkey: pubkey! }),
    staleTime: 5_000,
  })
  const isOrdersFetching = ordersQuery.isFetching
  const refetchOrders = ordersQuery.refetch

  useEffect(() => {
    if (isOrdersFetching) {
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
  }, [isOrdersFetching, refreshButtonState])

  useEffect(() => {
    return () => {
      if (refreshResetTimerRef.current)
        clearTimeout(refreshResetTimerRef.current)
    }
  }, [])

  const handleRefresh = useCallback(() => {
    if (!signerConnected) return
    if (refreshResetTimerRef.current) {
      clearTimeout(refreshResetTimerRef.current)
      refreshResetTimerRef.current = null
    }
    setRefreshButtonState("refreshing")
    void refetchOrders()
  }, [refetchOrders, signerConnected])

  const conversations = useMemo(
    () => ordersQuery.data?.data ?? cachedOrdersQuery.data?.data ?? [],
    [cachedOrdersQuery.data, ordersQuery.data]
  )
  const buyerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          conversations
            .filter((conversation) => !isMerchantGuestOrder(conversation))
            .map((conversation) => conversation.buyerPubkey)
            .filter(Boolean)
        )
      ),
    [conversations]
  )
  const buyerProfilesQuery = useProfiles(buyerPubkeys, {
    enabled: signerConnected && buyerPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })

  const buyerProfiles = buyerProfilesQuery.data

  // Order messages carry no image and no reliable title, so resolve each item
  // from its product listing (addressId). One batched relay read covers every
  // loaded order (bounded to the most recent), and feeds both the selected
  // order's name/image and item search (title, description, tags).
  const allOrderProductIds = useMemo(() => {
    const ids = new Set<string>()
    for (const conversation of conversations) {
      for (const message of conversation.messages ?? []) {
        if (message.type !== "order") continue
        for (const item of message.payload.items) {
          if (item.productId) ids.add(item.productId)
        }
      }
      if (ids.size >= ORDER_SEARCH_PRODUCT_CAP) break
    }
    return [...ids].sort().slice(0, ORDER_SEARCH_PRODUCT_CAP)
  }, [conversations])

  const orderProductsQuery = useQuery({
    queryKey: ["order-products", allOrderProductIds],
    enabled: signerConnected && allOrderProductIds.length > 0,
    queryFn: () => getProductsByIds(allOrderProductIds),
    staleTime: 5 * 60_000,
  })

  const productLookup = useMemo(() => {
    const map = new Map<
      string,
      {
        title: string
        imageUrl?: string
        format: "physical" | "digital"
      }
    >()
    for (const record of orderProductsQuery.data?.data ?? []) {
      if (record.product.pubkey !== pubkey) continue
      map.set(record.addressId, {
        title: record.product.title,
        imageUrl: getProductImageCandidates(record.product)[0]?.url,
        format: record.product.format,
      })
    }
    return map
  }, [orderProductsQuery.data, pubkey])

  // Searchable text (name + description + tags) per resolved product listing,
  // populated once the listings load; search falls back to order-message item
  // titles until then.
  const productSearchIndex = useMemo(() => {
    const map = new Map<string, string>()
    for (const record of orderProductsQuery.data?.data ?? []) {
      map.set(
        record.addressId,
        [
          record.product.title,
          record.product.summary ?? "",
          record.product.tags.join(" "),
          record.product.location ?? "",
        ]
          .join(" ")
          .toLowerCase()
      )
    }
    return map
  }, [orderProductsQuery.data])

  const filteredConversations = useMemo(() => {
    const query = orderSearch.trim().toLowerCase()
    return conversations.filter((conversation) => {
      if (
        phaseTab !== "all" &&
        getMerchantConversationQueue(conversation) !== phaseTab
      ) {
        return false
      }
      if (!query) return true
      const buyerName = getMerchantBuyerDisplayName(
        conversation,
        buyerProfiles?.[conversation.buyerPubkey]
      )
      const orderMessage = (conversation.messages ?? []).find(
        (message) => message.type === "order"
      )
      const items =
        orderMessage?.type === "order" ? orderMessage.payload.items : []
      const itemText = items
        .map(
          (item) =>
            `${item.title ?? ""} ${productSearchIndex.get(item.productId) ?? ""}`
        )
        .join(" ")
      return [
        buyerName,
        pubkeyToNpub(conversation.buyerPubkey),
        conversation.orderId,
        conversation.buyerPubkey,
        conversation.preview,
        conversation.totalSummary ?? "",
        getMerchantConversationStatusDisplay(conversation).label,
        itemText,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    })
  }, [conversations, orderSearch, phaseTab, buyerProfiles, productSearchIndex])

  const selectConversation = useCallback(
    (conversationId: string) => {
      setSelectedConversationId(conversationId)
      const orderId = conversations.find(
        (conversation) => conversation.id === conversationId
      )?.orderId
      void navigate({
        to: "/orders",
        search: {
          ...(orderId ? { order: orderId } : {}),
          ...(phaseTab !== "all" ? { queue: phaseTab } : {}),
        },
        replace: true,
      })
    },
    [conversations, navigate, phaseTab]
  )

  const changePhaseTab = useCallback(
    (nextPhase: OrderQueueTab) => {
      setPhaseTab(nextPhase)
      void navigate({
        to: "/orders",
        search:
          nextPhase === "all" ? ORDERS_SEARCH_DEFAULT : { queue: nextPhase },
        replace: true,
      })
    },
    [navigate]
  )

  useEffect(() => {
    setPhaseTab(selectedQueueFromUrl)
  }, [selectedQueueFromUrl])

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null)
      return
    }
    const urlConversation = selectedFromUrl
      ? filteredConversations.find(
          (conversation) => conversation.orderId === selectedFromUrl
        )
      : null
    if (urlConversation) {
      setSelectedConversationId(urlConversation.id)
      return
    }
    if (
      !selectedConversationId ||
      !filteredConversations.some(
        (conversation) => conversation.id === selectedConversationId
      )
    ) {
      setSelectedConversationId(filteredConversations[0]?.id ?? null)
    }
  }, [filteredConversations, selectedConversationId, selectedFromUrl])

  const selected =
    filteredConversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? null
  const selectedOrderMessage = selected?.messages?.find(
    (message) => message.type === "order"
  )
  const selectedOrderCurrency =
    selectedOrderMessage?.type === "order"
      ? selectedOrderMessage.payload.currency
      : null
  const invoiceCurrencyUnsupported =
    !!selectedOrderCurrency &&
    normalizeInvoiceCurrencyChoice(selectedOrderCurrency) === ""

  useEffect(() => {
    const selectedId = selected?.id ?? null
    if (selectedOrderResetRef.current === selectedId) return
    selectedOrderResetRef.current = selectedId

    setSuccessFlash(null)
    setOrderDetailsOpen(false)
    setMessagesOpen(false)
    setInvoice("")
    setInvoiceAmount("")
    setInvoiceCurrency("USD")
    setInvoiceNote("")
    setCarrier("")
    setTrackingNumber("")
    setTrackingUrl("")
    setShippingNote("")
    setReplyNote("")
    const firstOrder = selected?.messages?.find(
      (message) => message.type === "order"
    )
    if (firstOrder?.type !== "order") return
    setInvoiceAmount(String(firstOrder.payload.subtotal))
    setInvoiceCurrency(
      normalizeInvoiceCurrencyChoice(firstOrder.payload.currency)
    )
  }, [selected])

  const orderSummary = useMemo(
    () => (selected ? getMerchantOrderSummary(selected) : null),
    [selected]
  )
  const selectedStatusDisplay = useMemo(
    () =>
      selected ? getMerchantConversationStatusDisplay(selected) : undefined,
    [selected]
  )
  const isGuestOrder = selected ? isMerchantGuestOrder(selected) : false
  const communicationState = selected
    ? getMerchantConversationCommunication(selected)
    : "unknown"
  const buyerInboxKnown = communicationState === "nostr_replyable"
  const operationalDelivery = buyerInboxKnown ? "buyer_and_self" : "self_only"
  const assertBuyerHasNostrInbox = useCallback(() => {
    if (!buyerInboxKnown) {
      throw new Error(
        "This order has no confirmed Nostr reply inbox. Follow up using the contact details on the order."
      )
    }
  }, [buyerInboxKnown])

  // Buyer evidence still requires verification. Merchant-confirmed settlement
  // implies acceptance and moves the order directly into fulfillment.
  const merchantOrderState: MerchantOrderState = selected
    ? {
        ...getMerchantConversationState(selected),
        buyerReplyable:
          communicationState === "nostr_replyable"
            ? true
            : communicationState === "guest_out_of_band"
              ? false
              : "unknown",
        requiresShipping: getMerchantOrderRequiresShipping(
          orderSummary?.items ?? [],
          productLookup
        ),
      }
    : { status: null }
  const merchantPaid = isMerchantOrderPaid(merchantOrderState)
  const safeTrackingUrl = normalizeSafeHttpUrl(orderSummary?.trackingUrl)
  const assertPaidForFulfillment = useCallback(() => {
    if (!merchantPaid) {
      throw new Error(
        "Confirm payment before sending shipping updates or marking this order shipped."
      )
    }
  }, [merchantPaid])
  const orderActions = selected
    ? getMerchantOrderActions(merchantOrderState)
    : []
  const selectedQueue = selected ? getMerchantConversationQueue(selected) : null
  const canSendInvoice =
    buyerInboxKnown &&
    selectedQueue === "unpaid_review" &&
    !merchantPaid &&
    !merchantOrderState.paymentObserved &&
    !!merchantOrderState.accepted
  const canRecordShipping =
    selectedQueue === "paid_fulfill" &&
    merchantPaid &&
    merchantOrderState.requiresShipping !== false &&
    !merchantOrderState.shippingUpdated
  const canRequestPaymentOutOfBand =
    communicationState === "guest_out_of_band" &&
    selectedQueue === "unpaid_review" &&
    !merchantPaid &&
    !merchantOrderState.paymentObserved &&
    !!merchantOrderState.accepted
  const actionView = buildMerchantOrderActionView({
    actions: orderActions,
    canSendInvoice,
    canRecordShipping,
    canRequestPaymentOutOfBand,
  })
  const { primaryButtonActions, destructiveActions, hasNextStep } = actionView
  const destructiveCancellationCopy = destructiveActions[0]
    ? getMerchantOrderCancellationCopy({
        actionLabel: destructiveActions[0].label,
        buyerInboxKnown,
        merchantPaid,
        paymentObserved: !!merchantOrderState.paymentObserved,
      })
    : null
  const cancellationCopy = pendingDestructiveAction
    ? getMerchantOrderCancellationCopy({
        actionLabel: pendingDestructiveAction.label,
        buyerInboxKnown,
        merchantPaid,
        paymentObserved: !!merchantOrderState.paymentObserved,
      })
    : null

  const selectedBuyerProfile =
    selected && !isGuestOrder
      ? buyerProfilesQuery.data?.[selected.buyerPubkey]
      : undefined
  const selectedBuyerName = selected
    ? getMerchantBuyerDisplayName(selected, selectedBuyerProfile)
    : null
  const awaitingInvoiceCount = useMemo(
    () =>
      conversations.filter((conversation) => {
        const summary = getMerchantOrderSummary(conversation)
        if (
          getMerchantConversationCommunication(conversation) !==
          "nostr_replyable"
        ) {
          return false
        }
        return (
          !summary.invoiceSent &&
          !summary.paymentProofReceived &&
          !summary.externalPaymentReportReceived &&
          !summary.paymentConfirmed
        )
      }).length,
    [conversations]
  )
  const activeFulfillmentCount = useMemo(
    () => conversations.filter(isMerchantConversationActiveFulfillment).length,
    [conversations]
  )

  const invalidateOrderQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["merchant-order-messages", pubkey ?? "none"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-order-messages-live", pubkey ?? "none"],
      }),
    ])
  }, [pubkey, queryClient])

  // Generate invoice via WebLN (Alby) or NWC, then auto-send as payment_request DM
  const generateInvoiceMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        if (!pubkey || !selected) throw new Error("No conversation selected")
        assertBuyerHasNostrInbox()
        if (!canSendInvoice) {
          throw new Error("This order is not eligible for another invoice.")
        }

        const amountSats = invoiceAmountSats ?? 0
        if (amountSats <= 0) throw new Error("Amount must be greater than 0")

        let bolt11: string

        if (canMockInvoice()) {
          bolt11 = mockMakeInvoice({
            amountSats,
            memo: `Conduit order ${selected.orderId}`,
          }).invoice
        } else if (weblnAvailable) {
          // Primary path: WebLN (Alby browser extension) — zero config
          const result = await weblnMakeInvoice({
            amountSats,
            memo: `Conduit order ${selected.orderId}`,
          })
          bolt11 = result.invoice
        } else if (nwc.connection && nwc.canCreateInvoices) {
          // Fallback: NWC connection URI
          const result = await nwcMakeInvoice(
            nwc.connection,
            {
              amountMsats: amountSats * 1000,
              description: `Conduit order ${selected.orderId}`,
            },
            30_000,
            "merchant"
          )
          bolt11 = result.invoice
        } else {
          throw new Error(
            "No wallet available. Install Alby extension or connect NWC."
          )
        }

        const mismatch = getLightningNetworkMismatchMessage(bolt11)
        if (mismatch) {
          throw new Error(mismatch)
        }

        const decoded = decodeLightningInvoiceAmount(bolt11)
        const actualAmount = decoded.sats ?? decoded.msats ?? amountSats
        const actualCurrency = decoded.currency ?? "SATS"

        // Auto-send the invoice DM to the buyer
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
          type: "payment_request",
          tags: [
            ["amount", String(actualAmount)],
            ["currency", actualCurrency],
            ["payment_method", "lightning"],
          ],
          payload: {
            invoice: bolt11,
            amount: actualAmount,
            currency: actualCurrency,
            note: invoiceNote.trim() || undefined,
          },
          delivery: operationalDelivery,
        })

        return { invoice: bolt11 }
      }),
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice generated and sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const invoiceMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        if (!pubkey || !selected) throw new Error("No conversation selected")
        assertBuyerHasNostrInbox()
        if (!canSendInvoice) {
          throw new Error("This order is not eligible for another invoice.")
        }
        if (!invoice.trim()) throw new Error("Invoice is required")
        const manualInvoice = invoice.trim()
        const mismatch = getLightningNetworkMismatchMessage(manualInvoice)
        if (mismatch) throw new Error(mismatch)
        const decoded = decodeLightningInvoiceAmount(manualInvoice)
        const actualAmount = decoded.sats ?? decoded.msats
        if (!actualAmount || !decoded.currency) {
          throw new Error(
            "Invoice must include a decodable amount before it can be sent."
          )
        }
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
          type: "payment_request",
          tags: [
            ["amount", String(actualAmount)],
            ["currency", decoded.currency],
            ["payment_method", "lightning"],
          ],
          payload: {
            invoice: manualInvoice,
            amount: actualAmount,
            currency: decoded.currency,
            note: invoiceNote.trim() || undefined,
          },
          delivery: operationalDelivery,
        })
      }),
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const advanceStatusMutation = useMutation({
    mutationFn: (nextStatus: KnownOrderStatus) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        if (!pubkey || !selected) throw new Error("No conversation selected")
        if (nextStatus === "shipped" || nextStatus === "complete") {
          assertPaidForFulfillment()
        }
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
          type: "status_update",
          tags: [["status", nextStatus]],
          payload: { status: nextStatus },
          delivery: operationalDelivery,
        })
      }),
    onSuccess: async () => {
      flash(buyerInboxKnown ? "Status update sent to buyer" : "Status recorded")
      await invalidateOrderQueries()
    },
  })

  const shippingMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        if (!pubkey || !selected) throw new Error("No conversation selected")
        assertPaidForFulfillment()
        const prepared = prepareShippingUpdate({
          trackingNumber,
          carrier,
          trackingUrl,
          note: shippingNote,
        })
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
          type: "shipping_update",
          tags: [
            ["tracking", prepared.trackingNumber],
            ["carrier", prepared.carrier],
          ],
          payload: {
            carrier: prepared.carrier,
            trackingNumber: prepared.trackingNumber,
            trackingUrl: prepared.trackingUrl,
            note: prepared.note,
          },
          delivery: operationalDelivery,
        })
      }),
    onSuccess: async () => {
      setCarrier("")
      setTrackingNumber("")
      setTrackingUrl("")
      setShippingNote("")
      flash(
        buyerInboxKnown
          ? "Shipping update sent to buyer"
          : "Shipping update recorded"
      )
      await invalidateOrderQueries()
    },
  })

  const noteMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      assertBuyerHasNostrInbox()
      if (!replyNote.trim()) throw new Error("Message is required")
      await publishMerchantOrderMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "message",
        payload: {
          note: replyNote.trim(),
        },
        delivery: operationalDelivery,
      })
    },
    onSuccess: async () => {
      setReplyNote("")
      flash("Message sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const orderActionPending = isMerchantOrderActionSurfacePending({
    generateInvoice: generateInvoiceMutation.isPending,
    sendInvoice: invoiceMutation.isPending,
    advanceStatus: advanceStatusMutation.isPending,
    recordShipping: shippingMutation.isPending,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 xl:shrink-0">
        <div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Orders
          </h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-7 text-[var(--text-secondary)]">
            Review incoming buyer orders, send invoices, update status, and
            share shipping details.
          </p>
          <div className="mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!signerConnected || isOrdersFetching}
              onClick={handleRefresh}
            >
              <span className="inline-flex items-center gap-1">
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center transition-colors duration-200 ${
                    refreshButtonState === "refreshing"
                      ? "animate-pulse text-[var(--secondary-500)]"
                      : refreshButtonState === "done"
                        ? "text-[var(--success)]"
                        : "text-[var(--text-secondary)]"
                  }`}
                >
                  {refreshButtonState === "done" ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <RotateCw
                      className={`h-3.5 w-3.5 ${refreshButtonState === "refreshing" ? "animate-spin" : ""}`}
                    />
                  )}
                </span>
                <span className="relative inline-flex h-4 min-w-[7rem] items-center justify-center">
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "idle"
                        ? "opacity-100 text-[var(--text-primary)]"
                        : "opacity-0"
                    }`}
                  >
                    Refresh
                  </span>
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "refreshing"
                        ? "animate-pulse opacity-100 text-[var(--secondary-500)]"
                        : "opacity-0"
                    }`}
                  >
                    Refreshing...
                  </span>
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "done"
                        ? "opacity-100 text-[var(--success)]"
                        : "opacity-0"
                    }`}
                  >
                    Updated
                  </span>
                </span>
              </span>
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4 xl:shrink-0">
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Open threads
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {conversations.length}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Awaiting invoice
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {awaitingInvoiceCount}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Active fulfillment
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {activeFulfillmentCount}
          </div>
        </div>
      </div>

      {!signerConnected && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view incoming orders.
        </div>
      )}

      {signerConnected && ordersQuery.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load orders:{" "}
          {ordersQuery.error instanceof Error
            ? ordersQuery.error.message
            : "Unknown error"}
        </div>
      )}

      {signerConnected &&
        !cachedOrdersQuery.isLoading &&
        conversations.length === 0 && (
          <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No orders yet. Place an order from the Market app targeting this
            merchant pubkey.
          </div>
        )}

      {signerConnected && conversations.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start">
          <aside className="hidden rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-2rem)] xl:flex-col xl:overflow-hidden">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
              Orders
            </div>
            <div className="xl:shrink-0">
              <SearchBox value={orderSearch} onChange={setOrderSearch} />
              <OrderPhaseFilter value={phaseTab} onChange={changePhaseTab} />
            </div>
            <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
              {filteredConversations.length === 0 && (
                <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                  {emptyOrdersLabel(orderSearch.trim(), phaseTab)}
                </div>
              )}
              {filteredConversations.map((conversation) => (
                <OrderListItem
                  key={conversation.id}
                  conversation={conversation}
                  buyerProfile={buyerProfiles?.[conversation.buyerPubkey]}
                  active={conversation.id === selectedConversationId}
                  onClick={() => selectConversation(conversation.id)}
                />
              ))}
            </div>
          </aside>

          <div className="min-w-0 space-y-4 xl:hidden">
            <Sheet open={ordersSheetOpen} onOpenChange={setOrdersSheetOpen}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                  Orders
                </div>
                <SheetTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)]"
                  >
                    <Search className="h-4 w-4" />
                    Search
                  </button>
                </SheetTrigger>
              </div>
              <MobileOrdersScroller
                conversations={filteredConversations}
                selectedId={selectedConversationId}
                buyerProfiles={buyerProfiles}
                onSelect={selectConversation}
              />
              <SheetContent
                side="bottom"
                className="h-[100dvh] overflow-y-auto"
              >
                <SheetHeader>
                  <SheetTitle>Your orders</SheetTitle>
                </SheetHeader>
                <SearchBox value={orderSearch} onChange={setOrderSearch} />
                <OrderPhaseFilter value={phaseTab} onChange={changePhaseTab} />
                <div className="mt-4 space-y-2">
                  {filteredConversations.length === 0 && (
                    <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      {emptyOrdersLabel(orderSearch.trim(), phaseTab)}
                    </div>
                  )}
                  {filteredConversations.map((conversation) => (
                    <OrderListItem
                      key={conversation.id}
                      conversation={conversation}
                      buyerProfile={buyerProfiles?.[conversation.buyerPubkey]}
                      active={conversation.id === selectedConversationId}
                      onClick={() => {
                        selectConversation(conversation.id)
                        setOrdersSheetOpen(false)
                      }}
                    />
                  ))}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          <section className="min-w-0">
            {selected && orderSummary ? (
              <div className="space-y-4">
                <div className="xl:hidden">
                  <OrderItemsCard
                    items={orderSummary.items}
                    productLookup={productLookup}
                    subtotal={orderSummary.subtotal}
                    currency={orderSummary.currency}
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="min-w-0 space-y-4">
                    <section className={panelCard}>
                      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        Order progress
                      </h2>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        Track this order through fulfillment.
                      </p>
                      <div className="mt-5">
                        <StatusStepper
                          rows={buildOrderStatusTimeline(merchantOrderState)}
                          ariaLabel="Order progress"
                        />
                      </div>
                    </section>

                    <section className={panelCard}>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {isGuestOrder ? "Guest order" : "Actions"}
                      </h3>
                      <>
                        {!buyerInboxKnown && (
                          <p className="mt-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-warning">
                            {isGuestOrder
                              ? orderSummary.guestContact
                                ? "This guest has no Nostr reply inbox. Contact them by phone or email; fulfillment actions below are recorded to your encrypted order history."
                                : "This guest has no Nostr reply inbox and the order is missing required contact details. Fulfillment actions below are recorded only to your encrypted order history."
                              : "This partial order history does not prove the buyer has a Nostr reply inbox. Actions are recorded to your encrypted order history until the order identity is recovered."}
                          </p>
                        )}
                        <div className="mt-4 space-y-5">
                          {successFlash && (
                            <div
                              role="status"
                              aria-live="polite"
                              className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400"
                            >
                              {successFlash}
                            </div>
                          )}

                          {hasNextStep && (
                            <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                              Next step
                            </h4>
                          )}

                          {canRequestPaymentOutOfBand && (
                            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-warning">
                              <div className="font-semibold">
                                Request payment outside Nostr
                              </div>
                              <p className="mt-1">
                                {orderSummary.guestContact
                                  ? "Use the phone or email on this order to request payment. Confirm it below only after settlement."
                                  : "Recover a buyer contact method before requesting payment. Confirm it below only after settlement."}
                              </p>
                            </div>
                          )}

                          {primaryButtonActions.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex flex-wrap gap-2">
                                {primaryButtonActions.map((action) => (
                                  <Button
                                    key={action.action}
                                    size="sm"
                                    variant="primary"
                                    disabled={orderActionPending}
                                    onClick={() => {
                                      if (
                                        action.action === "confirm_payment" &&
                                        canRequestPaymentOutOfBand
                                      ) {
                                        setConfirmingOutOfBandPayment(true)
                                        return
                                      }
                                      if (action.status) {
                                        advanceStatusMutation.mutate(
                                          action.status
                                        )
                                      }
                                    }}
                                  >
                                    {advanceStatusMutation.isPending &&
                                    advanceStatusMutation.variables ===
                                      action.status
                                      ? buyerInboxKnown
                                        ? "Sending…"
                                        : "Recording…"
                                      : action.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )}

                          {(canSendInvoice ||
                            canRecordShipping ||
                            advanceStatusMutation.error ||
                            invoiceMutation.error ||
                            shippingMutation.error ||
                            noteMutation.error) && (
                            <div className="space-y-3">
                              {canSendInvoice && (
                                <div className="space-y-2">
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="grid gap-1">
                                      <Label htmlFor="invoice-amount">
                                        Amount
                                      </Label>
                                      <Input
                                        id="invoice-amount"
                                        type="number"
                                        min="0"
                                        step={getCurrencyAmountStep(
                                          invoiceCurrency
                                        )}
                                        value={invoiceAmount}
                                        onChange={(event) =>
                                          setInvoiceAmount(event.target.value)
                                        }
                                      />
                                    </div>
                                    <div className="grid gap-1">
                                      <Label htmlFor="invoice-currency">
                                        Currency
                                      </Label>
                                      <Select
                                        value={invoiceCurrency}
                                        onValueChange={(value) =>
                                          setInvoiceCurrency(value)
                                        }
                                      >
                                        <SelectTrigger id="invoice-currency">
                                          <SelectValue placeholder="Choose currency" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {INVOICE_CURRENCY_OPTIONS.map(
                                            (currency) => (
                                              <SelectItem
                                                key={currency}
                                                value={currency}
                                              >
                                                {currency}
                                              </SelectItem>
                                            )
                                          )}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                  <Input
                                    aria-label="Invoice note"
                                    value={invoiceNote}
                                    onChange={(event) =>
                                      setInvoiceNote(event.target.value)
                                    }
                                    placeholder="Optional note"
                                  />
                                  <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                                    {invoiceCurrencyUnsupported ? (
                                      <>
                                        This order was placed in{" "}
                                        {selectedOrderCurrency}. Choose USD or
                                        SATS before generating a Lightning
                                        invoice.
                                      </>
                                    ) : invoiceAmountNumber > 0 ? (
                                      invoiceAmountSats ? (
                                        <>
                                          This will generate an invoice for{" "}
                                          {invoiceAmountSats.toLocaleString()}{" "}
                                          sats.
                                        </>
                                      ) : (
                                        <>
                                          BTC/USD conversion is unavailable
                                          right now, so this amount cannot be
                                          converted yet.
                                        </>
                                      )
                                    ) : (
                                      <>
                                        Enter the order amount to generate a
                                        Lightning invoice.
                                      </>
                                    )}
                                  </div>

                                  {weblnAvailable ||
                                  (nwc.connection && nwc.canCreateInvoices) ? (
                                    <div className="space-y-2">
                                      <Button
                                        type="button"
                                        size="sm"
                                        className="w-full"
                                        disabled={
                                          orderActionPending ||
                                          !(invoiceAmountNumber > 0) ||
                                          !invoiceAmountSats
                                        }
                                        onClick={() =>
                                          generateInvoiceMutation.mutate()
                                        }
                                      >
                                        {generateInvoiceMutation.isPending
                                          ? "Generating…"
                                          : "Generate & send invoice"}
                                      </Button>
                                      {generateInvoiceMutation.error && (
                                        <div className="text-xs text-error">
                                          {generateInvoiceMutation.error instanceof
                                          Error
                                            ? generateInvoiceMutation.error
                                                .message
                                            : "Failed"}
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <form
                                      onSubmit={(event) => {
                                        event.preventDefault()
                                        invoiceMutation.mutate()
                                      }}
                                    >
                                      <div className="mb-2 grid gap-1">
                                        <Label htmlFor="invoice-bolt11">
                                          BOLT11 (paste manually)
                                        </Label>
                                        <Input
                                          id="invoice-bolt11"
                                          value={invoice}
                                          onChange={(event) =>
                                            setInvoice(event.target.value)
                                          }
                                          placeholder="lnbc..."
                                        />
                                        {invoice.trim() &&
                                          !isInvoiceCompatibleWithCurrentNetwork(
                                            invoice.trim()
                                          ) && (
                                            <div className="text-xs text-error">
                                              {getLightningNetworkMismatchMessage(
                                                invoice.trim()
                                              )}
                                            </div>
                                          )}
                                        {invoice.trim() &&
                                          isInvoiceCompatibleWithCurrentNetwork(
                                            invoice.trim()
                                          ) &&
                                          manualInvoiceDecoded?.currency && (
                                            <div className="text-xs text-[var(--text-secondary)]">
                                              Parsed invoice amount:{" "}
                                              {manualInvoiceDecoded.sats ??
                                                manualInvoiceDecoded.msats}{" "}
                                              {manualInvoiceDecoded.currency}
                                            </div>
                                          )}
                                      </div>
                                      <Button
                                        type="submit"
                                        size="sm"
                                        className="w-full"
                                        disabled={orderActionPending}
                                      >
                                        {invoiceMutation.isPending
                                          ? "Sending…"
                                          : "Send invoice DM"}
                                      </Button>
                                    </form>
                                  )}

                                  <p className="text-xs text-[var(--text-secondary)]">
                                    {weblnAvailable
                                      ? "Invoice via Alby extension."
                                      : nwc.connection && nwc.canCreateInvoices
                                        ? "Invoice via NWC wallet."
                                        : "Install Alby or configure NWC on Payments for one-click invoicing."}{" "}
                                    Conduit shows the parsed amount when the
                                    invoice format can be verified.
                                  </p>
                                </div>
                              )}

                              {canRecordShipping && (
                                <form
                                  className="space-y-2"
                                  onSubmit={(event) => {
                                    event.preventDefault()
                                    shippingMutation.mutate()
                                  }}
                                >
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-tracking-code">
                                      Tracking code
                                    </Label>
                                    <Input
                                      id="shipping-tracking-code"
                                      required
                                      pattern=".*\S.*"
                                      title="Enter a tracking code."
                                      value={trackingNumber}
                                      onChange={(event) =>
                                        setTrackingNumber(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-carrier">
                                      Carrier
                                    </Label>
                                    <Input
                                      id="shipping-carrier"
                                      required
                                      pattern=".*\S.*"
                                      title="Enter a carrier."
                                      value={carrier}
                                      onChange={(event) =>
                                        setCarrier(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-tracking-url">
                                      Tracking URL (optional)
                                    </Label>
                                    <Input
                                      id="shipping-tracking-url"
                                      type="url"
                                      inputMode="url"
                                      value={trackingUrl}
                                      onChange={(event) =>
                                        setTrackingUrl(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-additional-notes">
                                      Additional notes (optional)
                                    </Label>
                                    <Input
                                      id="shipping-additional-notes"
                                      maxLength={2000}
                                      value={shippingNote}
                                      onChange={(event) =>
                                        setShippingNote(event.target.value)
                                      }
                                    />
                                  </div>
                                  <Button
                                    type="submit"
                                    size="sm"
                                    className="w-full"
                                    disabled={orderActionPending}
                                  >
                                    {shippingMutation.isPending
                                      ? "Sending…"
                                      : buyerInboxKnown
                                        ? "Send shipping update"
                                        : "Record shipping update"}
                                  </Button>
                                </form>
                              )}

                              {(advanceStatusMutation.error ||
                                invoiceMutation.error ||
                                shippingMutation.error ||
                                noteMutation.error) && (
                                <div
                                  role="alert"
                                  className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error"
                                >
                                  {[
                                    advanceStatusMutation.error,
                                    invoiceMutation.error,
                                    shippingMutation.error,
                                    noteMutation.error,
                                  ]
                                    .filter(Boolean)
                                    .map((error) =>
                                      error instanceof Error
                                        ? error.message
                                        : "Failed to send message"
                                    )
                                    .join(" • ")}
                                </div>
                              )}
                            </div>
                          )}

                          {destructiveActions.length > 0 && (
                            <div
                              className={cn(
                                "space-y-3",
                                hasNextStep &&
                                  "border-t border-[var(--border)] pt-4"
                              )}
                            >
                              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                                Other actions
                              </h4>
                              {destructiveCancellationCopy?.warning && (
                                <p className="text-pretty text-xs leading-5 text-[var(--text-secondary)]">
                                  {destructiveCancellationCopy.warning}
                                </p>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {destructiveActions.map((action) => (
                                  <Button
                                    key={action.action}
                                    size="sm"
                                    variant="destructive"
                                    disabled={orderActionPending}
                                    onClick={() => {
                                      if (action.status) {
                                        setPendingDestructiveAction(action)
                                      }
                                    }}
                                  >
                                    {action.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    </section>
                  </div>

                  <div className="space-y-4">
                    <div className="hidden xl:block">
                      <OrderItemsCard
                        items={orderSummary.items}
                        productLookup={productLookup}
                        subtotal={orderSummary.subtotal}
                        currency={orderSummary.currency}
                      />
                    </div>

                    {orderSummary.shippingAddress && (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Shipping address
                        </h3>
                        <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                          <div className="text-[var(--text-primary)]">
                            {orderSummary.shippingAddress.name}
                          </div>
                          <div>{orderSummary.shippingAddress.street}</div>
                          <div>
                            {orderSummary.shippingAddress.city}
                            {orderSummary.shippingAddress.state
                              ? `, ${orderSummary.shippingAddress.state}`
                              : ""}{" "}
                            {orderSummary.shippingAddress.postalCode}
                          </div>
                          <div>{orderSummary.shippingAddress.country}</div>
                        </div>
                      </section>
                    )}

                    {orderSummary.guestContact && (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Guest contact
                        </h3>
                        <div className="mt-3 space-y-1 text-sm text-[var(--text-secondary)]">
                          <div>Phone: {orderSummary.guestContact.phone}</div>
                          <div>Email: {orderSummary.guestContact.email}</div>
                        </div>
                      </section>
                    )}

                    {orderSummary.orderNote && (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Order note
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                          {orderSummary.orderNote}
                        </p>
                      </section>
                    )}

                    {(orderSummary.trackingCarrier ||
                      orderSummary.trackingNumber ||
                      orderSummary.trackingUrl) && (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Tracking
                        </h3>
                        <div className="mt-3 space-y-1 text-sm text-[var(--text-secondary)]">
                          {orderSummary.trackingCarrier && (
                            <div className="text-[var(--text-primary)]">
                              {orderSummary.trackingCarrier}
                            </div>
                          )}
                          {orderSummary.trackingNumber && (
                            <div className="font-mono text-xs">
                              {orderSummary.trackingNumber}
                            </div>
                          )}
                          {safeTrackingUrl && (
                            <a
                              href={safeTrackingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                            >
                              Open tracking link
                            </a>
                          )}
                        </div>
                      </section>
                    )}

                    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)]">
                      <button
                        type="button"
                        onClick={() => setOrderDetailsOpen((open) => !open)}
                        aria-expanded={orderDetailsOpen}
                        aria-controls="merchant-order-details-panel"
                        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
                      >
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                          Order details
                        </span>
                        <ChevronRight
                          className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${orderDetailsOpen ? "rotate-90" : ""}`}
                        />
                      </button>
                      {orderDetailsOpen && (
                        <div
                          id="merchant-order-details-panel"
                          className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm"
                        >
                          <DetailRow label="Order ID">
                            <span
                              className="max-w-[9rem] truncate font-mono text-xs"
                              title={selected.orderId}
                            >
                              {selected.orderId}
                            </span>
                            <CopyInline
                              value={selected.orderId}
                              label="Copy order id"
                            />
                          </DetailRow>
                          <DetailRow label="Buyer">
                            <span className="font-mono text-xs">
                              {formatNpub(selected.buyerPubkey, 8)}
                            </span>
                            <CopyInline
                              value={selected.buyerPubkey}
                              label="Copy buyer pubkey"
                            />
                          </DetailRow>
                          <DetailRow label="Total">
                            <span>
                              {formatSummaryAmount(
                                orderSummary.subtotal,
                                orderSummary.currency
                              )}
                            </span>
                          </DetailRow>
                          {selectedOrderMessage && (
                            <DetailRow label="Ordered">
                              <span>
                                {new Date(
                                  selectedOrderMessage.createdAt
                                ).toLocaleString()}
                              </span>
                            </DetailRow>
                          )}
                        </div>
                      )}
                    </section>

                    <section className={panelCard}>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        Buyer
                      </h3>
                      <div className="mt-3 flex items-center gap-3">
                        <BuyerAvatar
                          name={selectedBuyerName ?? ""}
                          picture={selectedBuyerProfile?.picture}
                        />
                        <div className="min-w-0 flex-1">
                          {isGuestOrder ? (
                            <div className="truncate font-semibold text-[var(--text-primary)]">
                              {selectedBuyerName}
                            </div>
                          ) : (
                            <a
                              href={getProfileUrl(selected.buyerPubkey)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                            >
                              {selectedBuyerName}
                            </a>
                          )}
                          <div className="truncate font-mono text-xs text-[var(--text-muted)]">
                            {formatNpub(selected.buyerPubkey, 8)}
                          </div>
                        </div>
                        <StatusPill
                          variant={selectedStatusDisplay?.tone ?? "neutral"}
                          className="shrink-0 capitalize"
                        >
                          {selectedStatusDisplay?.label ?? "Unknown"}
                        </StatusPill>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        onClick={() => setMessagesOpen(true)}
                      >
                        <MessageCircle className="size-4" aria-hidden="true" />
                        {buyerInboxKnown ? "Message" : "Order history"}
                        {(selected.messages?.length ?? 0) > 0 && (
                          <span className="ml-1 rounded-full bg-[var(--surface)] px-1.5 text-xs text-[var(--text-secondary)]">
                            {selected.messages?.length}
                          </span>
                        )}
                      </Button>
                    </section>
                  </div>
                </div>

                <OrderMessagesWidget
                  open={messagesOpen}
                  onOpenChange={setMessagesOpen}
                  subtitle={
                    selectedBuyerName ?? formatNpub(selected.buyerPubkey, 8)
                  }
                  messages={selected.messages ?? []}
                  selfPubkey={pubkey}
                  replyValue={replyNote}
                  onReplyChange={setReplyNote}
                  onSend={() => noteMutation.mutate()}
                  sending={noteMutation.isPending}
                  error={
                    noteMutation.error instanceof Error
                      ? noteMutation.error.message
                      : noteMutation.error
                        ? "Failed to send message"
                        : null
                  }
                  placeholder="Message the buyer, then press Enter"
                  readOnly={!buyerInboxKnown}
                  resolveItem={(id) => productLookup.get(id)}
                />

                <AlertDialog
                  open={!!pendingDestructiveAction}
                  onOpenChange={(open) => {
                    if (!open) setPendingDestructiveAction(null)
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {cancellationCopy?.title}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {cancellationCopy?.description}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setPendingDestructiveAction(null)}
                      >
                        Keep order
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={orderActionPending}
                        onClick={() => {
                          if (!pendingDestructiveAction?.status) return
                          advanceStatusMutation.mutate(
                            pendingDestructiveAction.status
                          )
                          setPendingDestructiveAction(null)
                        }}
                      >
                        {advanceStatusMutation.isPending
                          ? buyerInboxKnown
                            ? "Sending…"
                            : "Recording…"
                          : cancellationCopy?.confirmLabel}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog
                  open={confirmingOutOfBandPayment}
                  onOpenChange={setConfirmingOutOfBandPayment}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Confirm payment received?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        Continue only after verifying the buyer's payment
                        outside Nostr. This records payment as confirmed in your
                        encrypted order history and unlocks fulfillment.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setConfirmingOutOfBandPayment(false)}
                      >
                        Keep unpaid
                      </Button>
                      <Button
                        type="button"
                        disabled={orderActionPending}
                        onClick={() => {
                          advanceStatusMutation.mutate("paid")
                          setConfirmingOutOfBandPayment(false)
                        }}
                      >
                        {advanceStatusMutation.isPending
                          ? "Recording…"
                          : "Confirm payment"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">
                Select a conversation.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
