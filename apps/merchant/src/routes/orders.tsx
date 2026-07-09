import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  buildOrderStatusTimeline,
  canMockInvoice,
  cacheParsedOrderMessage,
  convertCommerceAmountToSats,
  decodeLightningInvoiceAmount,
  EVENT_KINDS,
  appendConduitClientTag,
  extractOrderSummary,
  formatNpub,
  getOrderStatusDisplay,
  getCachedMerchantConversationList,
  getCurrencyAmountStep,
  getNdk,
  getProfileName,
  getLightningNetworkMismatchMessage,
  getMerchantConversationList,
  getMerchantOrderActions,
  getProductImageCandidates,
  getProductsByIds,
  hasWebLN,
  isInvoiceCompatibleWithCurrentNetwork,
  mockMakeInvoice,
  normalizeCurrencyAmount,
  nwcMakeInvoice,
  parseOrderMessageRumorEvent,
  publishWithPlanner,
  weblnMakeInvoice,
  type MerchantConversationSummary,
  type Profile,
  type StatusUpdateMessageSchema,
  useAuth,
  useProfiles,
} from "@conduit/core"
import {
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
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { getStorefrontUrl } from "../lib/market-links"
import { giftWrap, NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  MessageCircle,
  RotateCw,
  Search,
  ShoppingBag,
  UserRound,
} from "lucide-react"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useNwcConnection } from "../hooks/useNwcConnection"

export const Route = createFileRoute("/orders")({
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

type ActionKind = "invoice" | "status" | "shipping"

const INVOICE_CURRENCY_OPTIONS = ["USD", "SATS"] as const

function normalizeInvoiceCurrencyChoice(
  currency: string | undefined
): (typeof INVOICE_CURRENCY_OPTIONS)[number] | "" {
  const normalized = currency?.trim().toUpperCase()
  if (normalized === "SAT" || normalized === "SATS") return "SATS"
  if (normalized === "USD") return "USD"
  return ""
}

function normalizeTrackingUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("Tracking URL must be a valid http(s) link.")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Tracking URL must start with http:// or https://.")
  }

  return parsed.toString()
}

function getDisplayName(profile: Profile | undefined, pubkey: string): string {
  return getProfileName(profile) || formatNpub(pubkey, 8)
}

const panelCard =
  "rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"

function formatSummaryAmount(amount: number, currency: string): string {
  if (currency.trim().toUpperCase() === "SATS")
    return `${amount.toLocaleString()} sats`
  return `${amount.toLocaleString()} ${currency.trim().toUpperCase()}`
}

function BuyerAvatar({
  name,
  picture,
  size = "md",
}: {
  name: string
  picture?: string
  size?: "sm" | "md"
}) {
  const dim = size === "sm" ? "h-9 w-9" : "h-11 w-11"
  return (
    <div
      className={`${dim} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]`}
    >
      {picture ? (
        <img src={picture} alt={name} className="h-full w-full object-cover" />
      ) : (
        <UserRound className="h-1/2 w-1/2 text-[var(--text-muted)]" />
      )}
    </div>
  )
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search orders"
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
      />
    </div>
  )
}

function OrderListItem({
  conversation,
  buyerName,
  buyerPicture,
  active,
  onClick,
}: {
  conversation: MerchantConversationSummary
  buyerName: string
  buyerPicture?: string
  active: boolean
  onClick: () => void
}) {
  const statusDisplay = getOrderStatusDisplay(conversation.status)
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-[1.1rem] border p-3 text-left transition-[border-color,background-color] ${
        active
          ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <BuyerAvatar name={buyerName} picture={buyerPicture} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {buyerName}
            </div>
            <div className="shrink-0 text-[11px] text-[var(--text-muted)]">
              {new Date(conversation.latestAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
            {conversation.preview || "Order"}
          </div>
          {conversation.totalSummary && (
            <div className="mt-0.5 text-sm font-medium text-secondary-300">
              {conversation.totalSummary}
            </div>
          )}
          <div className="mt-2">
            <StatusPill variant={statusDisplay.tone} className="capitalize">
              {statusDisplay.label}
            </StatusPill>
          </div>
        </div>
      </div>
    </button>
  )
}

function MobileOrdersScroller({
  conversations,
  selectedId,
  buyerName,
  buyerPicture,
  onSelect,
}: {
  conversations: MerchantConversationSummary[]
  selectedId: string | null
  buyerName: (pubkey: string) => string
  buyerPicture: (pubkey: string) => string | undefined
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
              const statusDisplay = getOrderStatusDisplay(conversation.status)
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
                        name={buyerName(conversation.buyerPubkey)}
                        picture={buyerPicture(conversation.buyerPubkey)}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {buyerName(conversation.buyerPubkey)}
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

function prepareMerchantConversationRumor(
  rumor: NDKEvent,
  merchantPubkey: string
): void {
  rumor.pubkey = merchantPubkey
  if (rumor.id) return

  try {
    rumor.id = rumor.getEventHash()
  } catch (error) {
    console.warn("Failed to derive merchant message rumor id", error)
  }
}

async function cacheMerchantConversationRumor(rumor: NDKEvent): Promise<void> {
  try {
    if (!rumor.id) throw new Error("Missing merchant message rumor id")
    const parsed = parseOrderMessageRumorEvent(rumor)
    await cacheParsedOrderMessage(parsed)
  } catch (error) {
    console.warn("Failed to cache merchant message", error)
  }
}

async function publishOrderConversationMessage(params: {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  type:
    | "payment_request"
    | "status_update"
    | "shipping_update"
    | "receipt"
    | "message"
  payload: Record<string, unknown>
  tags?: string[][]
}): Promise<void> {
  const ndk = getNdk()
  if (!ndk.signer) {
    throw new Error("Signer not connected")
  }

  const rumor = new NDKEvent(ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(Date.now() / 1000)
  rumor.tags = [
    ["p", params.buyerPubkey],
    ["type", params.type],
    ["order", params.orderId],
    ...(params.tags ?? []),
  ]
  rumor.tags = appendConduitClientTag(rumor.tags, "merchant")
  rumor.content = JSON.stringify({
    ...params.payload,
    orderId: params.orderId,
    merchantPubkey: params.merchantPubkey,
    buyerPubkey: params.buyerPubkey,
    createdAt: Date.now(),
  })
  prepareMerchantConversationRumor(rumor, params.merchantPubkey)

  const buyerUser = new NDKUser({ pubkey: params.buyerPubkey })
  const merchantUser = new NDKUser({ pubkey: params.merchantPubkey })

  const [wrappedToBuyer, wrappedToMerchant] = await Promise.all([
    giftWrap(rumor, buyerUser, ndk.signer, {
      rumorKind: EVENT_KINDS.ORDER,
    }),
    giftWrap(rumor, merchantUser, ndk.signer, {
      rumorKind: EVENT_KINDS.ORDER,
    }),
  ])

  await publishWithPlanner(wrappedToBuyer, {
    intent: "recipient_event",
    authorPubkey: params.merchantPubkey,
    authenticatedPubkey: params.merchantPubkey,
    recipientPubkeys: [params.buyerPubkey],
    refreshRelayLists: true,
    deliveryMode: "critical",
  })

  try {
    await publishWithPlanner(wrappedToMerchant, {
      intent: "recipient_event",
      authorPubkey: params.merchantPubkey,
      authenticatedPubkey: params.merchantPubkey,
      recipientPubkeys: [params.merchantPubkey],
      refreshRelayLists: true,
      deliveryMode: "critical",
    })
  } catch (error) {
    console.warn("Merchant message self-copy publish failed", error)
  }

  await cacheMerchantConversationRumor(rumor)
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
  productLookup: Map<string, { title: string; imageUrl?: string }>
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
        {items.map((item, index) => {
          const match = productLookup.get(item.productId)
          const image = match?.imageUrl
          const title = item.title || match?.title || "Product"
          return (
            <div
              key={`${item.productId}-${index}`}
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
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const queryClient = useQueryClient()
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [orderSearch, setOrderSearch] = useState("")
  const [ordersSheetOpen, setOrdersSheetOpen] = useState(false)
  const [orderDetailsOpen, setOrderDetailsOpen] = useState(false)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [actionKind, setActionKind] = useState<ActionKind>("invoice")
  const [invoice, setInvoice] = useState("")
  const [invoiceAmount, setInvoiceAmount] = useState("")
  const [invoiceCurrency, setInvoiceCurrency] = useState("USD")
  const [invoiceNote, setInvoiceNote] = useState("")
  const [orderStatus, setOrderStatus] = useState<
    StatusUpdateMessageSchema["status"] | ""
  >("")
  const [statusNote, setStatusNote] = useState("")
  const [carrier, setCarrier] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")
  const [shippingNote, setShippingNote] = useState("")
  const [replyNote, setReplyNote] = useState("")
  const [successFlash, setSuccessFlash] = useState<string | null>(null)
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

  const nwc = useNwcConnection()

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
  const filteredConversations = useMemo(() => {
    const query = orderSearch.trim().toLowerCase()
    if (!query) return conversations
    return conversations.filter((conversation) => {
      const buyerName = getDisplayName(
        buyerProfiles?.[conversation.buyerPubkey],
        conversation.buyerPubkey
      )
      return [
        buyerName,
        conversation.orderId,
        conversation.buyerPubkey,
        conversation.preview,
        conversation.totalSummary ?? "",
        getOrderStatusDisplay(conversation.status).label,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    })
  }, [conversations, orderSearch, buyerProfiles])

  const buyerNameFor = useCallback(
    (pubkey: string) => getDisplayName(buyerProfiles?.[pubkey], pubkey),
    [buyerProfiles]
  )
  const buyerPictureFor = useCallback(
    (pubkey: string) => buyerProfiles?.[pubkey]?.picture,
    [buyerProfiles]
  )

  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedConversationId(null)
      return
    }
    if (
      !selectedConversationId ||
      !conversations.some(
        (conversation) => conversation.id === selectedConversationId
      )
    ) {
      setSelectedConversationId(conversations[0]?.id ?? null)
    }
  }, [conversations, selectedConversationId])

  const selected =
    conversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? null
  const orderActions = selected ? getMerchantOrderActions(selected.status) : []
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
    setActionKind("invoice")
    setOrderStatus("")
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
    () => (selected ? extractOrderSummary(selected.messages ?? []) : null),
    [selected]
  )

  // Order messages carry no image and no reliable title, so resolve each item
  // straight from its product listing (addressId) — independent of whether the
  // listing is still in this merchant's storefront read.
  const orderItemProductIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of orderSummary?.items ?? []) {
      if (item.productId) ids.add(item.productId)
    }
    return [...ids].sort()
  }, [orderSummary])

  // One relay fanout resolves every item on the order (name + image), instead
  // of one read per item — keeps the owned-socket reader from re-dialing relays.
  const orderItemProductsQuery = useQuery({
    queryKey: ["order-item-products", orderItemProductIds],
    enabled: signerConnected && orderItemProductIds.length > 0,
    queryFn: () => getProductsByIds(orderItemProductIds),
    staleTime: 5 * 60_000,
  })

  const productLookup = useMemo(() => {
    const map = new Map<string, { title: string; imageUrl?: string }>()
    for (const record of orderItemProductsQuery.data?.data ?? []) {
      map.set(record.addressId, {
        title: record.product.title,
        imageUrl: getProductImageCandidates(record.product)[0]?.url,
      })
    }
    return map
  }, [orderItemProductsQuery.data])

  const selectedBuyerProfile = selected
    ? buyerProfilesQuery.data?.[selected.buyerPubkey]
    : undefined
  const selectedBuyerName = selected
    ? getDisplayName(selectedBuyerProfile, selected.buyerPubkey)
    : null
  const awaitingInvoiceCount = useMemo(
    () =>
      conversations.filter(
        (conversation) =>
          !(conversation.messages ?? []).some(
            (message) => message.type === "payment_request"
          ) &&
          !(conversation.messages ?? []).some(
            (message) => message.type === "payment_proof"
          )
      ).length,
    [conversations]
  )
  const activeFulfillmentCount = useMemo(
    () =>
      conversations.filter(
        (conversation) =>
          conversation.status === "paid" ||
          conversation.status === "processing" ||
          conversation.status === "shipped"
      ).length,
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
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")

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
      } else if (nwc.connection) {
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
      await publishOrderConversationMessage({
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
      })

      return { invoice: bolt11 }
    },
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice generated and sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const invoiceMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
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
      await publishOrderConversationMessage({
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
      })
    },
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const statusMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "status_update",
        tags: [["status", orderStatus]],
        payload: {
          status: orderStatus,
          note: statusNote.trim() || undefined,
        },
      })
    },
    onSuccess: async () => {
      setStatusNote("")
      flash("Status update sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const advanceStatusMutation = useMutation({
    mutationFn: async (nextStatus: string) => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "status_update",
        tags: [["status", nextStatus]],
        payload: { status: nextStatus },
      })
    },
    onSuccess: async () => {
      flash("Status update sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const shippingMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      const normalizedTrackingUrl = normalizeTrackingUrl(trackingUrl)
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "shipping_update",
        tags: [
          ...(carrier.trim() ? [["carrier", carrier.trim()]] : []),
          ...(trackingNumber.trim()
            ? [["tracking", trackingNumber.trim()]]
            : []),
        ],
        payload: {
          carrier: carrier.trim() || undefined,
          trackingNumber: trackingNumber.trim() || undefined,
          trackingUrl: normalizedTrackingUrl,
          note: shippingNote.trim() || undefined,
        },
      })
    },
    onSuccess: async () => {
      setCarrier("")
      setTrackingNumber("")
      setTrackingUrl("")
      setShippingNote("")
      flash("Shipping update sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const noteMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      if (!replyNote.trim()) throw new Error("Message is required")
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "message",
        payload: {
          note: replyNote.trim(),
        },
      })
    },
    onSuccess: async () => {
      setReplyNote("")
      flash("Message sent to buyer")
      await invalidateOrderQueries()
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 xl:shrink-0">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Orders
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Merchant order inbox
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Review incoming buyer orders, send invoices, update status, and
            share shipping details from one workspace.
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
            </div>
            <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
              {filteredConversations.length === 0 && (
                <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                  No orders match "{orderSearch.trim()}".
                </div>
              )}
              {filteredConversations.map((conversation) => (
                <OrderListItem
                  key={conversation.id}
                  conversation={conversation}
                  buyerName={buyerNameFor(conversation.buyerPubkey)}
                  buyerPicture={buyerPictureFor(conversation.buyerPubkey)}
                  active={conversation.id === selectedConversationId}
                  onClick={() => setSelectedConversationId(conversation.id)}
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
                buyerName={buyerNameFor}
                buyerPicture={buyerPictureFor}
                onSelect={setSelectedConversationId}
              />
              <SheetContent
                side="bottom"
                className="h-[100dvh] overflow-y-auto"
              >
                <SheetHeader>
                  <SheetTitle>Your orders</SheetTitle>
                </SheetHeader>
                <SearchBox value={orderSearch} onChange={setOrderSearch} />
                <div className="mt-4 space-y-2">
                  {filteredConversations.length === 0 && (
                    <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      No orders match "{orderSearch.trim()}".
                    </div>
                  )}
                  {filteredConversations.map((conversation) => (
                    <OrderListItem
                      key={conversation.id}
                      conversation={conversation}
                      buyerName={buyerNameFor(conversation.buyerPubkey)}
                      buyerPicture={buyerPictureFor(conversation.buyerPubkey)}
                      active={conversation.id === selectedConversationId}
                      onClick={() => {
                        setSelectedConversationId(conversation.id)
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
                          rows={buildOrderStatusTimeline(selected.status)}
                          ariaLabel="Order progress"
                        />
                      </div>
                    </section>

                    <section className={panelCard}>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        Actions
                      </h3>
                      <div className="mt-4 space-y-5">
                        {successFlash && (
                          <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
                            {successFlash}
                          </div>
                        )}

                        {orderActions.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                              Respond
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {orderActions.map((action) => (
                                <Button
                                  key={action.label}
                                  size="sm"
                                  variant={
                                    action.kind === "destructive"
                                      ? "outline"
                                      : "primary"
                                  }
                                  disabled={advanceStatusMutation.isPending}
                                  onClick={() =>
                                    advanceStatusMutation.mutate(action.status)
                                  }
                                >
                                  {advanceStatusMutation.isPending &&
                                  advanceStatusMutation.variables ===
                                    action.status
                                    ? "Sending…"
                                    : action.label}
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div
                          className={
                            orderActions.length > 0
                              ? "space-y-3 border-t border-[var(--border)] pt-4"
                              : "space-y-3"
                          }
                        >
                          <div className="grid gap-1">
                            <Label htmlFor="action-kind">Manual action</Label>
                            <Select
                              value={actionKind}
                              onValueChange={(value) =>
                                setActionKind(value as ActionKind)
                              }
                            >
                              <SelectTrigger id="action-kind">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="invoice">
                                  Send invoice
                                </SelectItem>
                                <SelectItem value="status">
                                  Status update
                                </SelectItem>
                                <SelectItem value="shipping">
                                  Shipping update
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {actionKind === "invoice" && (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="grid gap-1">
                                  <Label htmlFor="invoice-amount">Amount</Label>
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
                                    {selectedOrderCurrency}. Choose USD or SATS
                                    before generating a Lightning invoice.
                                  </>
                                ) : invoiceAmountNumber > 0 ? (
                                  invoiceAmountSats ? (
                                    <>
                                      This will generate an invoice for{" "}
                                      {invoiceAmountSats.toLocaleString()} sats.
                                    </>
                                  ) : (
                                    <>
                                      BTC/USD conversion is unavailable right
                                      now, so this amount cannot be converted
                                      yet.
                                    </>
                                  )
                                ) : (
                                  <>
                                    Enter the order amount to generate a
                                    Lightning invoice.
                                  </>
                                )}
                              </div>

                              {weblnAvailable || nwc.connection ? (
                                <div className="space-y-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="w-full"
                                    disabled={
                                      generateInvoiceMutation.isPending ||
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
                                        ? generateInvoiceMutation.error.message
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
                                    disabled={invoiceMutation.isPending}
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
                                  : nwc.connection
                                    ? "Invoice via NWC wallet."
                                    : "Install Alby or configure NWC on Payments for one-click invoicing."}{" "}
                                Conduit shows the parsed amount when the invoice
                                format can be verified.
                              </p>
                            </div>
                          )}

                          {actionKind === "status" && (
                            <form
                              className="space-y-2"
                              onSubmit={(event) => {
                                event.preventDefault()
                                statusMutation.mutate()
                              }}
                            >
                              <Select
                                value={orderStatus}
                                onValueChange={(value) =>
                                  setOrderStatus(
                                    value as StatusUpdateMessageSchema["status"]
                                  )
                                }
                              >
                                <SelectTrigger aria-label="Choose status">
                                  <SelectValue placeholder="Choose status" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="paid">paid</SelectItem>
                                  <SelectItem value="processing">
                                    processing
                                  </SelectItem>
                                  <SelectItem value="shipped">
                                    shipped
                                  </SelectItem>
                                  <SelectItem value="complete">
                                    complete
                                  </SelectItem>
                                  <SelectItem value="cancelled">
                                    cancelled
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <Input
                                value={statusNote}
                                onChange={(event) =>
                                  setStatusNote(event.target.value)
                                }
                                placeholder="Optional note"
                              />
                              <Button
                                type="submit"
                                size="sm"
                                className="w-full"
                                disabled={
                                  statusMutation.isPending || !orderStatus
                                }
                              >
                                {statusMutation.isPending
                                  ? "Sending…"
                                  : "Send status DM"}
                              </Button>
                            </form>
                          )}

                          {actionKind === "shipping" && (
                            <form
                              className="space-y-2"
                              onSubmit={(event) => {
                                event.preventDefault()
                                shippingMutation.mutate()
                              }}
                            >
                              <Input
                                value={carrier}
                                onChange={(event) =>
                                  setCarrier(event.target.value)
                                }
                                placeholder="Carrier (optional)"
                              />
                              <Input
                                value={trackingNumber}
                                onChange={(event) =>
                                  setTrackingNumber(event.target.value)
                                }
                                placeholder="Tracking number"
                              />
                              <Input
                                value={trackingUrl}
                                onChange={(event) =>
                                  setTrackingUrl(event.target.value)
                                }
                                placeholder="Tracking URL (optional)"
                              />
                              <Input
                                value={shippingNote}
                                onChange={(event) =>
                                  setShippingNote(event.target.value)
                                }
                                placeholder="Optional note"
                              />
                              <Button
                                type="submit"
                                size="sm"
                                className="w-full"
                                disabled={shippingMutation.isPending}
                              >
                                {shippingMutation.isPending
                                  ? "Sending…"
                                  : "Send shipping DM"}
                              </Button>
                            </form>
                          )}

                          {(invoiceMutation.error ||
                            statusMutation.error ||
                            shippingMutation.error ||
                            noteMutation.error) && (
                            <div className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
                              {[
                                invoiceMutation.error,
                                statusMutation.error,
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
                      </div>
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
                          {orderSummary.trackingUrl && (
                            <a
                              href={orderSummary.trackingUrl}
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
                        <div className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm">
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
                          <a
                            href={getStorefrontUrl(selected.buyerPubkey)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                          >
                            {selectedBuyerName}
                          </a>
                          <div className="truncate font-mono text-xs text-[var(--text-muted)]">
                            {formatNpub(selected.buyerPubkey, 8)}
                          </div>
                        </div>
                        <StatusPill
                          variant={getOrderStatusDisplay(selected.status).tone}
                          className="shrink-0 capitalize"
                        >
                          {getOrderStatusDisplay(selected.status).label}
                        </StatusPill>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 w-full"
                        onClick={() => setMessagesOpen(true)}
                      >
                        <MessageCircle className="h-4 w-4" />
                        Message
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
                  placeholder="Message the buyer, then press Enter"
                  resolveItem={(id) => productLookup.get(id)}
                />
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
