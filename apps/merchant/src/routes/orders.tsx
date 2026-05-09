import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  canMockInvoice,
  convertCommerceAmountToSats,
  decodeLightningInvoiceAmount,
  EVENT_KINDS,
  appendConduitClientTag,
  extractOrderSummary,
  formatPubkey,
  getCachedMerchantConversationList,
  getNdk,
  getProfileName,
  getLightningNetworkMismatchMessage,
  getMerchantConversationList,
  hasWebLN,
  isInvoiceCompatibleWithCurrentNetwork,
  mockMakeInvoice,
  nwcMakeInvoice,
  publishWithPlanner,
  weblnMakeInvoice,
  type ParsedOrderMessage,
  type Profile,
  type StatusUpdateMessageSchema,
  useAuth,
  useProfiles,
} from "@conduit/core"
import {
  Badge,
  Button,
  Input,
  Label,
  OrderDetailCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { giftWrap, NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import { CheckCircle2, RotateCw } from "lucide-react"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useNwcConnection } from "../hooks/useNwcConnection"

export const Route = createFileRoute("/orders")({
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
  return getProfileName(profile) || formatPubkey(pubkey, 8)
}

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  order: "Order",
  payment_request: "Invoice",
  status_update: "Status",
  shipping_update: "Shipping",
  receipt: "Receipt",
  message: "Message",
  payment_proof: "Payment",
}

function friendlyTypeLabel(type: string): string {
  return MESSAGE_TYPE_LABELS[type] ?? type.replace(/_/g, " ")
}

function formatProductReference(productId: string): {
  title: string
  detail: string
} {
  const normalized = productId.trim()
  const segments = normalized.split(":").filter(Boolean)
  const rawLabel =
    segments.length > 0 ? segments[segments.length - 1] : normalized
  const displaySource = rawLabel || normalized
  const title =
    displaySource
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || "Product"
  return { title, detail: normalized }
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

  const buyerUser = new NDKUser({ pubkey: params.buyerPubkey })
  const merchantUser = new NDKUser({ pubkey: params.merchantPubkey })

  const wrappedToBuyer = await giftWrap(rumor, buyerUser, ndk.signer, {
    rumorKind: EVENT_KINDS.ORDER,
  })
  const wrappedToMerchant = await giftWrap(rumor, merchantUser, ndk.signer, {
    rumorKind: EVENT_KINDS.ORDER,
  })

  await Promise.all([
    publishWithPlanner(wrappedToBuyer, {
      intent: "recipient_event",
      authorPubkey: params.merchantPubkey,
      recipientPubkeys: [params.buyerPubkey],
      refreshRelayLists: true,
    }),
    publishWithPlanner(wrappedToMerchant, {
      intent: "recipient_event",
      authorPubkey: params.merchantPubkey,
      recipientPubkeys: [params.merchantPubkey],
      refreshRelayLists: true,
    }),
  ])
}

function MessageCard({
  message,
  mine,
}: {
  message: ParsedOrderMessage
  mine: boolean
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-md border p-3 text-sm ${
          mine
            ? "border-[var(--border)] bg-[var(--surface)]"
            : "border-[var(--border)] bg-[var(--surface-elevated)]"
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="outline" className="border-[var(--border)]">
            {friendlyTypeLabel(message.type)}
          </Badge>
          <span className="text-xs text-[var(--text-secondary)]">
            {new Date(message.createdAt).toLocaleString()}
          </span>
        </div>

        {message.type === "order" && (
          <div className="space-y-1.5">
            <div className="text-[var(--text-primary)]">
              Total: {message.payload.subtotal} {message.payload.currency}
            </div>
            {message.payload.items.map((item) => {
              const product = formatProductReference(item.productId)
              return (
                <div
                  key={`${message.id}-${item.productId}`}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2"
                >
                  <div className="text-sm text-[var(--text-primary)]">
                    {product.title}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    Qty {item.quantity} · {item.priceAtPurchase} {item.currency}
                  </div>
                </div>
              )
            })}
            {message.payload.shippingAddress && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
                <div className="font-medium text-[var(--text-primary)]">
                  Ship to:
                </div>
                <div>{message.payload.shippingAddress.name}</div>
                <div>{message.payload.shippingAddress.street}</div>
                <div>
                  {message.payload.shippingAddress.city}
                  {message.payload.shippingAddress.state
                    ? `, ${message.payload.shippingAddress.state}`
                    : ""}{" "}
                  {message.payload.shippingAddress.postalCode}
                </div>
                <div>{message.payload.shippingAddress.country}</div>
              </div>
            )}
            {message.payload.note && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
                {message.payload.note}
              </div>
            )}
          </div>
        )}

        {message.type === "payment_request" && (
          <div className="space-y-2">
            {(() => {
              const decoded = decodeLightningInvoiceAmount(
                message.payload.invoice
              )
              const displayAmount =
                decoded.sats ?? decoded.msats ?? message.payload.amount ?? null
              const displayCurrency =
                decoded.currency ?? message.payload.currency ?? null

              return (
                <>
                  <div className="text-[var(--text-primary)]">
                    Invoice sent
                    {displayAmount != null ? ` · ${displayAmount}` : ""}
                    {displayCurrency ? ` ${displayCurrency}` : ""}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    Awaiting payment confirmation.
                  </div>
                </>
              )
            })()}
            <div className="break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs text-[var(--text-secondary)]">
              {message.payload.invoice}
            </div>
            {message.payload.note && (
              <div className="text-xs text-[var(--text-secondary)]">
                {message.payload.note}
              </div>
            )}
          </div>
        )}

        {message.type === "status_update" && (
          <div className="space-y-1">
            <div className="text-[var(--text-primary)]">
              Status: {message.payload.status}
            </div>
            {message.payload.note && (
              <div className="text-xs text-[var(--text-secondary)]">
                {message.payload.note}
              </div>
            )}
          </div>
        )}

        {message.type === "shipping_update" && (
          <div className="space-y-1">
            {message.payload.carrier && (
              <div className="text-[var(--text-primary)]">
                Carrier: {message.payload.carrier}
              </div>
            )}
            {message.payload.trackingNumber && (
              <div className="font-mono text-xs text-[var(--text-secondary)]">
                Tracking: {message.payload.trackingNumber}
              </div>
            )}
            {(() => {
              const raw = message.payload.trackingUrl
              if (!raw) return null
              try {
                const u = new URL(raw)
                if (u.protocol !== "http:" && u.protocol !== "https:")
                  return null
                return (
                  <a
                    className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                    href={u.toString()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open tracking link
                  </a>
                )
              } catch {
                return null
              }
            })()}
            {message.payload.note && (
              <div className="text-xs text-[var(--text-secondary)]">
                {message.payload.note}
              </div>
            )}
          </div>
        )}

        {message.type === "receipt" && message.payload.note && (
          <div className="text-[var(--text-secondary)]">
            {message.payload.note}
          </div>
        )}

        {message.type === "message" && (
          <div className="text-[var(--text-primary)]">
            {message.payload.note}
          </div>
        )}

        {message.type === "payment_proof" && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
            {JSON.stringify(message.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

function OrdersPage() {
  const { pubkey, status } = useAuth()
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data?.rate ?? null
  const queryClient = useQueryClient()
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [activeTab, setActiveTab] = useState("details")
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
  const invoiceAmountNumber = Number(invoiceAmount) || 0
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
  })

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
    setActiveTab("details")
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
      <div className="flex flex-wrap items-start justify-between gap-4">
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            asChild
            variant={
              canMockInvoice() || weblnAvailable || nwc.connection
                ? "outline"
                : "muted"
            }
            size="sm"
          >
            <Link to="/payments">
              {canMockInvoice()
                ? "Mock mode"
                : weblnAvailable
                  ? "Alby detected"
                  : nwc.connection
                    ? "Wallet connected"
                    : "Payment settings"}
            </Link>
          </Button>
          <Button asChild variant="muted">
            <Link to="/">Home</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Open threads
          </div>
          <div className="mt-3 text-3xl font-semibold text-[var(--text-primary)]">
            {conversations.length}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Awaiting invoice
          </div>
          <div className="mt-3 text-3xl font-semibold text-[var(--text-primary)]">
            {awaitingInvoiceCount}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Active fulfillment
          </div>
          <div className="mt-3 text-3xl font-semibold text-[var(--text-primary)]">
            {activeFulfillmentCount}
          </div>
        </div>
      </div>

      {!signerConnected && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view incoming orders.
        </div>
      )}

      {signerConnected && isOrdersFetching && (
        <div className="text-sm text-[var(--text-secondary)]">
          Checking latest order messages…
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
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-2">
            <div className="mb-2 px-2 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Conversations
            </div>
            <div className="space-y-1">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedConversationId
                const buyerProfile =
                  buyerProfilesQuery.data?.[conversation.buyerPubkey]
                const buyerName = getDisplayName(
                  buyerProfile,
                  conversation.buyerPubkey
                )
                return (
                  <button
                    key={conversation.id}
                    className={`w-full rounded-md border px-3 py-2 text-left transition ${
                      active
                        ? "border-[var(--text-secondary)] bg-[var(--surface)]"
                        : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-elevated)]"
                    }`}
                    onClick={() => setSelectedConversationId(conversation.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-[var(--text-primary)]">
                        {conversation.orderId}
                      </span>
                      <Badge
                        variant="secondary"
                        className="border-[var(--border)]"
                      >
                        {friendlyTypeLabel(conversation.latestType)}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      Buyer: {buyerName}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                      {formatPubkey(conversation.buyerPubkey, 8)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      {conversation.status
                        ? `Status: ${conversation.status}`
                        : "Status: pending"}
                    </div>
                    {conversation.totalSummary && (
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">
                        {conversation.totalSummary}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </aside>

          <section className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
            {selected && orderSummary ? (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="actions">Actions</TabsTrigger>
                  <TabsTrigger value="messages">Messages</TabsTrigger>
                </TabsList>

                <TabsContent value="details">
                  <OrderDetailCard
                    orderId={selected.orderId}
                    status={selected.status}
                    counterpartyLabel="Buyer"
                    counterpartyName={selectedBuyerName ?? undefined}
                    counterpartyPubkey={selected.buyerPubkey}
                    items={orderSummary.items}
                    subtotal={orderSummary.subtotal}
                    currency={orderSummary.currency}
                    shippingAddress={orderSummary.shippingAddress}
                    orderNote={orderSummary.orderNote}
                    invoiceSent={orderSummary.invoiceSent}
                    invoiceCount={orderSummary.invoiceCount}
                    invoiceAmount={orderSummary.invoiceAmount}
                    invoiceCurrency={orderSummary.invoiceCurrency}
                    trackingCarrier={orderSummary.trackingCarrier}
                    trackingNumber={orderSummary.trackingNumber}
                    trackingUrl={orderSummary.trackingUrl}
                  />
                </TabsContent>

                <TabsContent value="actions">
                  <div className="space-y-4">
                    {successFlash && (
                      <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
                        {successFlash}
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                          Send invoice
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="grid gap-1">
                            <Label htmlFor="invoice-amount">Amount</Label>
                            <Input
                              id="invoice-amount"
                              type="number"
                              min="0"
                              step={invoiceCurrency === "USD" ? "0.01" : "1"}
                              value={invoiceAmount}
                              onChange={(event) =>
                                setInvoiceAmount(event.target.value)
                              }
                            />
                          </div>
                          <div className="grid gap-1">
                            <Label htmlFor="invoice-currency">Currency</Label>
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
                                {INVOICE_CURRENCY_OPTIONS.map((currency) => (
                                  <SelectItem key={currency} value={currency}>
                                    {currency}
                                  </SelectItem>
                                ))}
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
                              This order was placed in {selectedOrderCurrency}.
                              Choose USD or SATS before generating a Lightning
                              invoice.
                            </>
                          ) : invoiceAmountNumber > 0 ? (
                            invoiceAmountSats ? (
                              <>
                                This will generate an invoice for{" "}
                                {invoiceAmountSats.toLocaleString()} sats.
                              </>
                            ) : (
                              <>
                                BTC/USD conversion is unavailable right now, so
                                this amount cannot be converted yet.
                              </>
                            )
                          ) : (
                            <>
                              Enter the order amount to generate a Lightning
                              invoice.
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
                              onClick={() => generateInvoiceMutation.mutate()}
                            >
                              {generateInvoiceMutation.isPending
                                ? "Generating…"
                                : "Generate & send invoice"}
                            </Button>
                            {generateInvoiceMutation.error && (
                              <div className="text-xs text-error">
                                {generateInvoiceMutation.error instanceof Error
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

                      <form
                        className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                        onSubmit={(event) => {
                          event.preventDefault()
                          statusMutation.mutate()
                        }}
                      >
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                          Status update
                        </div>
                        <select
                          className="h-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]"
                          value={orderStatus}
                          onChange={(event) =>
                            setOrderStatus(
                              event.target
                                .value as StatusUpdateMessageSchema["status"]
                            )
                          }
                        >
                          <option value="">Choose status</option>
                          <option value="paid">paid</option>
                          <option value="processing">processing</option>
                          <option value="shipped">shipped</option>
                          <option value="complete">complete</option>
                          <option value="cancelled">cancelled</option>
                        </select>
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
                          disabled={statusMutation.isPending || !orderStatus}
                        >
                          {statusMutation.isPending
                            ? "Sending…"
                            : "Send status DM"}
                        </Button>
                      </form>

                      <form
                        className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                        onSubmit={(event) => {
                          event.preventDefault()
                          shippingMutation.mutate()
                        }}
                      >
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                          Shipping update
                        </div>
                        <Input
                          value={carrier}
                          onChange={(event) => setCarrier(event.target.value)}
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
                    </div>

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
                </TabsContent>

                <TabsContent value="messages">
                  <div className="space-y-4">
                    <div className="max-h-[44vh] space-y-3 overflow-auto pr-1">
                      {(selected.messages ?? []).map((message) => (
                        <MessageCard
                          key={message.id}
                          message={message}
                          mine={message.senderPubkey === pubkey}
                        />
                      ))}
                    </div>
                    <form
                      className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        noteMutation.mutate()
                      }}
                    >
                      <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                        Reply to buyer
                      </div>
                      <Input
                        value={replyNote}
                        onChange={(event) => setReplyNote(event.target.value)}
                        placeholder="Send a note to the buyer"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="w-full"
                        disabled={noteMutation.isPending || !replyNote.trim()}
                      >
                        {noteMutation.isPending ? "Sending…" : "Send message"}
                      </Button>
                    </form>
                  </div>
                </TabsContent>
              </Tabs>
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
