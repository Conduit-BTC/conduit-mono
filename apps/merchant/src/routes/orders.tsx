import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  canMockInvoice,
  db,
  EVENT_KINDS,
  extractOrderSummary,
  fetchEventsFanout,
  formatPubkey,
  getNdk,
  hasWebLN,
  mockMakeInvoice,
  nwcMakeInvoice,
  parseNwcUri,
  parseOrderMessageRumorEvent,
  requireNdkConnected,
  weblnMakeInvoice,
  type NwcConnection,
  type ParsedOrderMessage,
  type StatusUpdateMessageSchema,
  useAuth,
} from "@conduit/core"
import { Badge, Button, Input, Label, OrderDetailCard, Tabs, TabsContent, TabsList, TabsTrigger } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { giftUnwrap, giftWrap, NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import type { NDKFilter, NDKSigner } from "@nostr-dev-kit/ndk"

export const Route = createFileRoute("/orders")({
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

type Conversation = {
  id: string
  orderId: string
  buyerPubkey: string
  messages: ParsedOrderMessage[]
  latestAt: number
  latestType: ParsedOrderMessage["type"]
  status: string | null
  totalSummary: string | null
}

function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function tryUnwrap(event: NDKEvent, signer: NDKSigner) {
  try {
    return await raceTimeout(
      (async () => {
        try { return await giftUnwrap(event, undefined, signer, "nip44") } catch { /* nip44 failed */ }
        try { return await giftUnwrap(event, undefined, signer, "nip04") } catch { /* nip04 failed */ }
        return null
      })(),
      8_000,
      null,
    )
  } catch {
    return null
  }
}

// Unwrap events in sequential batches to avoid overwhelming the signer extension.
async function unwrapBatch(events: NDKEvent[], signer: NDKSigner, batchSize = 5): Promise<Array<Awaited<ReturnType<typeof tryUnwrap>>>> {
  const results: Array<Awaited<ReturnType<typeof tryUnwrap>>> = []
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map((e) => tryUnwrap(e, signer)))
    results.push(...batchResults)
  }
  return results
}

// Set of gift-wrap event IDs already unwrapped and cached this session.
const knownWrapIds = new Set<string>()

async function fetchMerchantMessages(merchantPubkey: string): Promise<ParsedOrderMessage[]> {
  // Load cached messages from Dexie first
  const cached = await db.orderMessages
    .where("recipientPubkey").equals(merchantPubkey)
    .or("senderPubkey").equals(merchantPubkey)
    .toArray()

  const cachedById = new Map<string, ParsedOrderMessage>()
  for (const row of cached) {
    try {
      cachedById.set(row.id, JSON.parse(row.rawContent) as ParsedOrderMessage)
    } catch { /* skip corrupt */ }
  }

  // Fetch fresh from relays
  try {
    const ndk = await requireNdkConnected()
    const signer = ndk.signer
    if (!signer) {
      if (cachedById.size > 0) {
        const result = Array.from(cachedById.values())
        result.sort((a, b) => a.createdAt - b.createdAt)
        return result
      }
      throw new Error("Connect your Nostr signer to view orders.")
    }

    const filter: NDKFilter = {
      kinds: [EVENT_KINDS.GIFT_WRAP],
      "#p": [merchantPubkey],
      limit: 50,
    }

    const wrapped = await fetchEventsFanout(filter, {
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 12_000,
    }) as NDKEvent[]

    // Only unwrap events we haven't seen before
    const newWrapped = wrapped.filter((e) => !knownWrapIds.has(e.id))

    // Unwrap in small batches so the signer extension isn't flooded
    const unwrapped = await unwrapBatch(newWrapped, signer)

    const newRows: Array<{ id: string; orderId: string; type: string; senderPubkey: string; recipientPubkey: string; createdAt: number; rawContent: string; cachedAt: number }> = []
    for (const rumor of unwrapped) {
      if (!rumor) continue
      if (rumor.kind !== EVENT_KINDS.ORDER) continue
      try {
        const parsed = parseOrderMessageRumorEvent(rumor)
        if (!cachedById.has(parsed.id)) {
          newRows.push({
            id: parsed.id,
            orderId: parsed.orderId,
            type: parsed.type,
            senderPubkey: parsed.senderPubkey,
            recipientPubkey: parsed.recipientPubkey,
            createdAt: parsed.createdAt,
            rawContent: JSON.stringify(parsed),
            cachedAt: Date.now(),
          })
        }
        cachedById.set(parsed.id, parsed)
      } catch {
        // ignore malformed
      }
    }

    // Mark all fetched wrap IDs as known (even ones that failed to unwrap)
    for (const e of wrapped) knownWrapIds.add(e.id)

    // Persist new messages to Dexie
    if (newRows.length > 0) {
      await db.orderMessages.bulkPut(newRows)
    }
  } catch (err) {
    // If relay fetch fails but we have cache, return cached data
    if (cachedById.size > 0) {
      const result = Array.from(cachedById.values())
      result.sort((a, b) => a.createdAt - b.createdAt)
      return result
    }
    throw err
  }

  const result = Array.from(cachedById.values())
  result.sort((a, b) => a.createdAt - b.createdAt)
  return result
}

function buildMerchantConversations(messages: ParsedOrderMessage[], merchantPubkey: string): Conversation[] {
  const grouped = new Map<string, ParsedOrderMessage[]>()

  for (const message of messages) {
    const bucket = grouped.get(message.orderId) ?? []
    bucket.push(message)
    grouped.set(message.orderId, bucket)
  }

  const conversations: Conversation[] = []
  for (const [orderId, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const firstOrder = bucket.find((message) => message.type === "order")
    const latestStatus = [...bucket]
      .reverse()
      .find((message) => message.type === "status_update")

    const otherParticipants = Array.from(new Set(
      bucket.map((m) => m.senderPubkey === merchantPubkey ? m.recipientPubkey : m.senderPubkey).filter(Boolean)
    ))
    const buyerPubkey = otherParticipants[0] ?? ""

    conversations.push({
      id: orderId,
      orderId,
      buyerPubkey,
      messages: bucket,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status: latestStatus?.type === "status_update" ? latestStatus.payload.status : null,
      totalSummary:
        firstOrder?.type === "order" ? `${firstOrder.payload.subtotal} ${firstOrder.payload.currency}` : null,
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}

async function publishOrderConversationMessage(params: {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  type: "payment_request" | "status_update" | "shipping_update" | "receipt"
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

  await Promise.all([wrappedToBuyer.publish(), wrappedToMerchant.publish()])
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
            {message.type}
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
            {message.payload.items.map((item) => (
              <div key={`${message.id}-${item.productId}`} className="text-xs text-[var(--text-secondary)]">
                {item.productId} · {item.quantity} x {item.priceAtPurchase} {item.currency}
              </div>
            ))}
            {message.payload.shippingAddress && (
              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
                <div className="font-medium text-[var(--text-primary)]">Ship to:</div>
                <div>{message.payload.shippingAddress.name}</div>
                <div>{message.payload.shippingAddress.street}</div>
                <div>
                  {message.payload.shippingAddress.city}
                  {message.payload.shippingAddress.state ? `, ${message.payload.shippingAddress.state}` : ""}{" "}
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
            <div className="text-[var(--text-primary)]">Invoice sent.</div>
            <div className="break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs text-[var(--text-secondary)]">
              {message.payload.invoice}
            </div>
            {message.payload.note && <div className="text-xs text-[var(--text-secondary)]">{message.payload.note}</div>}
          </div>
        )}

        {message.type === "status_update" && (
          <div className="space-y-1">
            <div className="text-[var(--text-primary)]">Status: {message.payload.status}</div>
            {message.payload.note && <div className="text-xs text-[var(--text-secondary)]">{message.payload.note}</div>}
          </div>
        )}

        {message.type === "shipping_update" && (
          <div className="space-y-1">
            {message.payload.carrier && (
              <div className="text-[var(--text-primary)]">Carrier: {message.payload.carrier}</div>
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
                if (u.protocol !== "http:" && u.protocol !== "https:") return null
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
            {message.payload.note && <div className="text-xs text-[var(--text-secondary)]">{message.payload.note}</div>}
          </div>
        )}

        {message.type === "receipt" && message.payload.note && (
          <div className="text-[var(--text-secondary)]">{message.payload.note}</div>
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

const NWC_URI_KEY = "conduit:merchant:nwc_uri"

function useNwcConnection(): {
  connection: NwcConnection | null
  rawUri: string
  setUri: (uri: string) => void
  error: string | null
} {
  const [rawUri, setRawUri] = useState(() => localStorage.getItem(NWC_URI_KEY) ?? "")
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<NwcConnection | null>(() => {
    const stored = localStorage.getItem(NWC_URI_KEY)
    if (!stored) return null
    try {
      return parseNwcUri(stored)
    } catch {
      return null
    }
  })

  function setUri(uri: string) {
    setRawUri(uri)
    if (!uri.trim()) {
      localStorage.removeItem(NWC_URI_KEY)
      setConnection(null)
      setError(null)
      return
    }
    try {
      const conn = parseNwcUri(uri.trim())
      localStorage.setItem(NWC_URI_KEY, uri.trim())
      setConnection(conn)
      setError(null)
    } catch (err) {
      setConnection(null)
      setError(err instanceof Error ? err.message : "Invalid NWC URI")
    }
  }

  return { connection, rawUri, setUri, error }
}

function OrdersPage() {
  const { pubkey } = useAuth()
  const queryClient = useQueryClient()
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("details")
  const [invoice, setInvoice] = useState("")
  const [invoiceAmount, setInvoiceAmount] = useState("")
  const [invoiceCurrency, setInvoiceCurrency] = useState("USD")
  const [invoiceNote, setInvoiceNote] = useState("")
  const [status, setStatus] = useState<StatusUpdateMessageSchema["status"]>("invoiced")
  const [statusNote, setStatusNote] = useState("")
  const [carrier, setCarrier] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")
  const [shippingNote, setShippingNote] = useState("")
  const [showNwcSetup, setShowNwcSetup] = useState(false)
  const [successFlash, setSuccessFlash] = useState<string | null>(null)
  const [weblnAvailable, setWeblnAvailable] = useState(false)
  const autoInvoicedRef = useRef(new Set<string>())
  const [refreshButtonState, setRefreshButtonState] = useState<"idle" | "refreshing" | "done">("idle")
  const refreshResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    queryKey: ["merchant-order-messages", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchMerchantMessages(pubkey!),
    staleTime: 30_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: true,
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
      if (refreshResetTimerRef.current) clearTimeout(refreshResetTimerRef.current)
    }
  }, [])

  const handleRefresh = useCallback(() => {
    if (refreshResetTimerRef.current) {
      clearTimeout(refreshResetTimerRef.current)
      refreshResetTimerRef.current = null
    }
    setRefreshButtonState("refreshing")
    void refetchOrders()
  }, [refetchOrders])

  const conversations = useMemo(
    () => buildMerchantConversations(ordersQuery.data ?? [], pubkey ?? ""),
    [ordersQuery.data, pubkey]
  )

  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedConversationId(null)
      return
    }
    if (!selectedConversationId || !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(conversations[0]?.id ?? null)
    }
  }, [conversations, selectedConversationId])

  const selected = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null

  useEffect(() => {
    setSuccessFlash(null)
    setActiveTab("details")
    const firstOrder = selected?.messages.find((message) => message.type === "order")
    if (firstOrder?.type !== "order") return
    setInvoiceAmount(String(firstOrder.payload.subtotal))
    setInvoiceCurrency(firstOrder.payload.currency)
  }, [selected?.id])

  const orderSummary = useMemo(
    () => selected ? extractOrderSummary(selected.messages) : null,
    [selected]
  )

  // Auto-invoice: when a new order arrives and a wallet is connected (or mock mode),
  // generate and send the invoice automatically without merchant intervention.
  useEffect(() => {
    if (!pubkey) return
    const mock = canMockInvoice()
    const wallet = mock ? "mock" : weblnAvailable ? "webln" : nwc.connection ? "nwc" : null
    if (!wallet) return

    const pending = conversations.filter((c) => {
      if (autoInvoicedRef.current.has(c.orderId)) return false
      const hasOrder = c.messages.some((m) => m.type === "order")
      const hasInvoice = c.messages.some((m) => m.type === "payment_request")
      return hasOrder && !hasInvoice
    })

    if (pending.length === 0) return

    async function autoInvoice(conv: Conversation) {
      const orderMsg = conv.messages.find((m) => m.type === "order")
      if (orderMsg?.type !== "order") return

      const amountSats = orderMsg.payload.subtotal
      if (!amountSats || amountSats <= 0) return

      autoInvoicedRef.current.add(conv.orderId)

      try {
        let bolt11: string
        if (wallet === "mock") {
          bolt11 = mockMakeInvoice({ amountSats, memo: `Conduit order ${conv.orderId}` }).invoice
        } else if (wallet === "webln") {
          const result = await weblnMakeInvoice({
            amountSats,
            memo: `Conduit order ${conv.orderId}`,
          })
          bolt11 = result.invoice
        } else {
          const result = await nwcMakeInvoice(nwc.connection!, {
            amountMsats: amountSats * 1000,
            description: `Conduit order ${conv.orderId}`,
          })
          bolt11 = result.invoice
        }

        await publishOrderConversationMessage({
          merchantPubkey: pubkey!,
          buyerPubkey: conv.buyerPubkey,
          orderId: conv.orderId,
          type: "payment_request",
          tags: [
            ["amount", String(amountSats)],
            ["currency", orderMsg.payload.currency?.toUpperCase() || "USD"],
            ["payment_method", "lightning"],
          ],
          payload: {
            invoice: bolt11,
            amount: amountSats,
            currency: orderMsg.payload.currency?.toUpperCase() || "USD",
          },
        })

        flash(`Auto-invoiced order ${conv.orderId.slice(0, 8)}...`)
        queryClient.invalidateQueries({ queryKey: ["merchant-order-messages", pubkey ?? "none"] })
      } catch (err) {
        // Remove from set so it can be retried on next poll
        autoInvoicedRef.current.delete(conv.orderId)
        console.error(`Auto-invoice failed for ${conv.orderId}:`, err)
      }
    }

    // Process one at a time to avoid wallet rate limits
    ;(async () => {
      for (const conv of pending) {
        await autoInvoice(conv)
      }
    })()
  }, [conversations, pubkey, weblnAvailable, nwc.connection, flash, queryClient])

  // Generate invoice via WebLN (Alby) or NWC, then auto-send as payment_request DM
  const generateInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")

      const amountSats = Number(invoiceAmount) || 0
      if (amountSats <= 0) throw new Error("Amount must be greater than 0")

      let bolt11: string

      if (canMockInvoice()) {
        bolt11 = mockMakeInvoice({ amountSats, memo: `Conduit order ${selected.orderId}` }).invoice
      } else if (weblnAvailable) {
        // Primary path: WebLN (Alby browser extension) — zero config
        const result = await weblnMakeInvoice({
          amountSats,
          memo: `Conduit order ${selected.orderId}`,
        })
        bolt11 = result.invoice
      } else if (nwc.connection) {
        // Fallback: NWC connection URI
        const result = await nwcMakeInvoice(nwc.connection, {
          amountMsats: amountSats * 1000,
          description: `Conduit order ${selected.orderId}`,
        })
        bolt11 = result.invoice
      } else {
        throw new Error("No wallet available. Install Alby extension or connect NWC.")
      }

      // Auto-send the invoice DM to the buyer
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "payment_request",
        tags: [
          ["amount", String(amountSats)],
          ["currency", invoiceCurrency.trim().toUpperCase() || "USD"],
          ["payment_method", "lightning"],
        ],
        payload: {
          invoice: bolt11,
          amount: amountSats,
          currency: invoiceCurrency.trim().toUpperCase() || "USD",
          note: invoiceNote.trim() || undefined,
        },
      })

      return { invoice: bolt11 }
    },
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice generated and sent to buyer")
      await queryClient.invalidateQueries({ queryKey: ["merchant-order-messages", pubkey ?? "none"] })
    },
  })

  const invoiceMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      if (!invoice.trim()) throw new Error("Invoice is required")
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "payment_request",
        tags: [
          ["amount", invoiceAmount.trim() || "0"],
          ["currency", invoiceCurrency.trim().toUpperCase() || "USD"],
          ["payment_method", "lightning"],
        ],
        payload: {
          invoice: invoice.trim(),
          amount: Number(invoiceAmount) || undefined,
          currency: invoiceCurrency.trim().toUpperCase() || "USD",
          note: invoiceNote.trim() || undefined,
        },
      })
    },
    onSuccess: async () => {
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice sent to buyer")
      await queryClient.invalidateQueries({ queryKey: ["merchant-order-messages", pubkey ?? "none"] })
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
        tags: [["status", status]],
        payload: {
          status,
          note: statusNote.trim() || undefined,
        },
      })
    },
    onSuccess: async () => {
      setStatusNote("")
      flash("Status update sent to buyer")
      await queryClient.invalidateQueries({ queryKey: ["merchant-order-messages", pubkey ?? "none"] })
    },
  })

  const shippingMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selected) throw new Error("No conversation selected")
      await publishOrderConversationMessage({
        merchantPubkey: pubkey,
        buyerPubkey: selected.buyerPubkey,
        orderId: selected.orderId,
        type: "shipping_update",
        tags: [
          ...(carrier.trim() ? [["carrier", carrier.trim()]] : []),
          ...(trackingNumber.trim() ? [["tracking", trackingNumber.trim()]] : []),
        ],
        payload: {
          carrier: carrier.trim() || undefined,
          trackingNumber: trackingNumber.trim() || undefined,
          trackingUrl: trackingUrl.trim() || undefined,
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
      await queryClient.invalidateQueries({ queryKey: ["merchant-order-messages", pubkey ?? "none"] })
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Orders</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Two-column merchant inbox for MVP order conversations and invoice/status/shipping actions.
          </p>
          <div className="mt-3">
            <Button variant="outline" size="sm" disabled={isOrdersFetching} onClick={handleRefresh}>
              <span className="inline-flex items-center gap-2">
                <span className="relative inline-flex h-4 w-4 items-center justify-center">
                  <span
                    className={`absolute h-3.5 w-3.5 rounded-full border-2 border-[var(--text-secondary)] border-t-transparent transition-opacity duration-200 ${
                      refreshButtonState === "refreshing" ? "animate-spin opacity-100" : "opacity-0"
                    }`}
                  />
                  <span
                    className={`absolute h-2 w-2 rounded-full bg-[var(--text-secondary)] transition-opacity duration-200 ${
                      refreshButtonState === "idle" ? "opacity-70" : "opacity-0"
                    }`}
                  />
                  <span
                    className={`absolute h-2.5 w-2.5 rounded-full bg-green-400 transition-opacity duration-200 ${
                      refreshButtonState === "done" ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </span>
                <span className="relative inline-flex h-4 min-w-[7rem] items-center justify-center">
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "idle" ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    Refresh
                  </span>
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "refreshing" ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    Refreshing...
                  </span>
                  <span
                    className={`absolute transition-opacity duration-200 ${
                      refreshButtonState === "done" ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    Updated
                  </span>
                </span>
              </span>
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={canMockInvoice() || weblnAvailable || nwc.connection ? "outline" : "muted"} size="sm" onClick={() => setShowNwcSetup(!showNwcSetup)}>
            {canMockInvoice() ? "Mock mode" : weblnAvailable ? "Alby detected" : nwc.connection ? "NWC connected" : "Connect wallet"}
          </Button>
          <Button asChild variant="muted">
            <Link to="/">Home</Link>
          </Button>
        </div>
      </div>

      {showNwcSetup && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
          {weblnAvailable && (
            <div className="mb-3 flex items-center gap-2 text-xs text-green-400">
              <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
              Alby extension detected — invoices will be generated via WebLN (no NWC URI needed).
            </div>
          )}

          <div className="text-sm font-medium text-[var(--text-primary)]">Nostr Wallet Connect (NIP-47)</div>

          {nwc.connection ? (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-2 text-xs text-green-400">
                <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
                Connected to wallet <span className="font-mono">{formatPubkey(nwc.connection.walletPubkey, 8)}</span> via {nwc.connection.relays[0]}
              </div>
              <div className="grid gap-2">
                <Input
                  value={nwc.rawUri}
                  onChange={(e) => nwc.setUri(e.target.value)}
                  placeholder="nostr+walletconnect://..."
                  type="password"
                />
                <Button variant="muted" size="sm" onClick={() => nwc.setUri("")}>
                  Disconnect wallet
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-[var(--text-secondary)]">
                Connect a Lightning wallet to generate invoices with one click. Without NWC, you can still paste BOLT11 invoices manually.
              </p>

              <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
                <div className="text-xs font-medium text-[var(--text-primary)]">How to get a connection URI:</div>
                <ol className="mt-2 space-y-1.5 text-xs text-[var(--text-secondary)]">
                  <li>1. Set up a Lightning wallet that supports NWC (NIP-47)</li>
                  <li>2. Create a new NWC connection with <span className="font-medium text-[var(--text-primary)]">make_invoice</span> permission</li>
                  <li>3. Copy the <span className="font-mono">nostr+walletconnect://</span> URI and paste below</li>
                </ol>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href="https://albyhub.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface)]">
                    Alby Hub
                  </a>
                  <a href="https://lnbits.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface)]">
                    LNbits
                  </a>
                  <a href="https://nwc.dev" target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--surface)]">
                    nwc.dev
                  </a>
                </div>
              </div>

              <div className="grid gap-2">
                <Input
                  value={nwc.rawUri}
                  onChange={(e) => nwc.setUri(e.target.value)}
                  placeholder="nostr+walletconnect://..."
                  type="password"
                />
                {nwc.error && (
                  <div className="text-xs text-error">{nwc.error}</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

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

      {!ordersQuery.isLoading && conversations.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No orders yet. Place an order from the Market app targeting this merchant pubkey.
        </div>
      )}

      {conversations.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
            <div className="mb-2 px-2 text-xs uppercase tracking-wide text-[var(--text-secondary)]">Conversations</div>
            <div className="space-y-1">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedConversationId
                return (
                  <button
                    key={conversation.id}
                    className={`w-full rounded-md border px-3 py-2 text-left transition ${
                      active
                        ? "border-[var(--accent)] bg-[var(--surface-elevated)]"
                        : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-elevated)]"
                    }`}
                    onClick={() => setSelectedConversationId(conversation.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-[var(--text-primary)]">{conversation.orderId}</span>
                      <Badge variant="secondary" className="border-[var(--border)]">
                        {conversation.latestType}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      Buyer: {formatPubkey(conversation.buyerPubkey, 8)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      {conversation.status ? `Status: ${conversation.status}` : "Status: pending"}
                    </div>
                    {conversation.totalSummary && (
                      <div className="mt-1 text-xs text-[var(--text-secondary)]">{conversation.totalSummary}</div>
                    )}
                  </button>
                )
              })}
            </div>
          </aside>

          <section className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
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
                    counterpartyPubkey={selected.buyerPubkey}
                    items={orderSummary.items}
                    subtotal={orderSummary.subtotal}
                    currency={orderSummary.currency}
                    shippingAddress={orderSummary.shippingAddress}
                    orderNote={orderSummary.orderNote}
                    invoiceSent={orderSummary.invoiceSent}
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
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Send invoice</div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="grid gap-1">
                            <Label htmlFor="invoice-amount">Amount (sats)</Label>
                            <Input
                              id="invoice-amount"
                              type="number"
                              min="0"
                              step="1"
                              value={invoiceAmount}
                              onChange={(event) => setInvoiceAmount(event.target.value)}
                            />
                          </div>
                          <div className="grid gap-1">
                            <Label htmlFor="invoice-currency">Currency</Label>
                            <Input
                              id="invoice-currency"
                              value={invoiceCurrency}
                              onChange={(event) => setInvoiceCurrency(event.target.value.toUpperCase())}
                            />
                          </div>
                        </div>
                        <Input
                          value={invoiceNote}
                          onChange={(event) => setInvoiceNote(event.target.value)}
                          placeholder="Optional note"
                        />

                        {weblnAvailable || nwc.connection ? (
                          <div className="space-y-2">
                            <Button
                              type="button"
                              size="sm"
                              className="w-full"
                              disabled={generateInvoiceMutation.isPending || !(Number(invoiceAmount) > 0)}
                              onClick={() => generateInvoiceMutation.mutate()}
                            >
                              {generateInvoiceMutation.isPending ? "Generating…" : "Generate & send invoice"}
                            </Button>
                            {generateInvoiceMutation.error && (
                              <div className="text-xs text-error">
                                {generateInvoiceMutation.error instanceof Error ? generateInvoiceMutation.error.message : "Failed"}
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
                              <Label htmlFor="invoice-bolt11">BOLT11 (paste manually)</Label>
                              <Input
                                id="invoice-bolt11"
                                value={invoice}
                                onChange={(event) => setInvoice(event.target.value)}
                                placeholder="lnbc..."
                              />
                            </div>
                            <Button type="submit" size="sm" className="w-full" disabled={invoiceMutation.isPending}>
                              {invoiceMutation.isPending ? "Sending…" : "Send invoice DM"}
                            </Button>
                          </form>
                        )}

                        <p className="text-xs text-[var(--text-secondary)]">
                          {weblnAvailable ? "Invoice via Alby extension." : nwc.connection ? "Invoice via NWC wallet." : "Install Alby or connect NWC for one-click invoicing."}
                        </p>
                      </div>

                      <form
                        className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                        onSubmit={(event) => {
                          event.preventDefault()
                          statusMutation.mutate()
                        }}
                      >
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Status update</div>
                        <select
                          className="h-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]"
                          value={status}
                          onChange={(event) => setStatus(event.target.value as StatusUpdateMessageSchema["status"])}
                        >
                          <option value="invoiced">invoiced</option>
                          <option value="paid">paid</option>
                          <option value="processing">processing</option>
                          <option value="shipped">shipped</option>
                          <option value="complete">complete</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                        <Input
                          value={statusNote}
                          onChange={(event) => setStatusNote(event.target.value)}
                          placeholder="Optional note"
                        />
                        <Button type="submit" size="sm" className="w-full" disabled={statusMutation.isPending}>
                          {statusMutation.isPending ? "Sending…" : "Send status DM"}
                        </Button>
                      </form>

                      <form
                        className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                        onSubmit={(event) => {
                          event.preventDefault()
                          shippingMutation.mutate()
                        }}
                      >
                        <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Shipping update</div>
                        <Input
                          value={carrier}
                          onChange={(event) => setCarrier(event.target.value)}
                          placeholder="Carrier (optional)"
                        />
                        <Input
                          value={trackingNumber}
                          onChange={(event) => setTrackingNumber(event.target.value)}
                          placeholder="Tracking number"
                        />
                        <Input
                          value={trackingUrl}
                          onChange={(event) => setTrackingUrl(event.target.value)}
                          placeholder="Tracking URL (optional)"
                        />
                        <Input
                          value={shippingNote}
                          onChange={(event) => setShippingNote(event.target.value)}
                          placeholder="Optional note"
                        />
                        <Button type="submit" size="sm" className="w-full" disabled={shippingMutation.isPending}>
                          {shippingMutation.isPending ? "Sending…" : "Send shipping DM"}
                        </Button>
                      </form>
                    </div>

                    {(invoiceMutation.error || statusMutation.error || shippingMutation.error) && (
                      <div className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
                        {[invoiceMutation.error, statusMutation.error, shippingMutation.error]
                          .filter(Boolean)
                          .map((error) => (error instanceof Error ? error.message : "Failed to send message"))
                          .join(" • ")}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="messages">
                  <div className="max-h-[52vh] space-y-3 overflow-auto pr-1">
                    {selected.messages.map((message) => (
                      <MessageCard key={message.id} message={message} mine={message.senderPubkey === pubkey} />
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">Select a conversation.</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
