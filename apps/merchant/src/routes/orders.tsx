import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import {
  EVENT_KINDS,
  formatPubkey,
  getNdk,
  parseOrderMessageRumorEvent,
  type ParsedOrderMessage,
  type StatusUpdateMessageSchema,
  useAuth,
} from "@conduit/core"
import { Badge, Button, Input, Label } from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { giftUnwrap, giftWrap, NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import type { NDKFilter } from "@nostr-dev-kit/ndk"

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

async function fetchMerchantMessages(merchantPubkey: string): Promise<ParsedOrderMessage[]> {
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

  const parsed: ParsedOrderMessage[] = []
  for (const result of unwrapped) {
    if (result.status !== "fulfilled") continue
    const rumor = result.value
    if (rumor.kind !== EVENT_KINDS.ORDER) continue
    try {
      parsed.push(parseOrderMessageRumorEvent(rumor))
    } catch {
      // ignore malformed
    }
  }

  parsed.sort((a, b) => a.createdAt - b.createdAt)
  return parsed
}

function buildMerchantConversations(messages: ParsedOrderMessage[], merchantPubkey: string): Conversation[] {
  const grouped = new Map<string, ParsedOrderMessage[]>()

  for (const message of messages) {
    const buyerPubkey =
      message.senderPubkey === merchantPubkey ? message.recipientPubkey : message.senderPubkey
    const key = `${message.orderId}:${buyerPubkey}`
    const bucket = grouped.get(key) ?? []
    bucket.push(message)
    grouped.set(key, bucket)
  }

  const conversations: Conversation[] = []
  for (const [id, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const firstOrder = bucket.find((message) => message.type === "order")
    const latestStatus = [...bucket]
      .reverse()
      .find((message) => message.type === "status_update")

    const buyerPubkey =
      latest.senderPubkey === merchantPubkey ? latest.recipientPubkey : latest.senderPubkey

    conversations.push({
      id,
      orderId: latest.orderId,
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
            {message.payload.trackingUrl && (
              <a
                className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                href={message.payload.trackingUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open tracking link
              </a>
            )}
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

function OrdersPage() {
  const { pubkey } = useAuth()
  const queryClient = useQueryClient()
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
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

  const ordersQuery = useQuery({
    queryKey: ["merchant-order-messages", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchMerchantMessages(pubkey!),
    refetchInterval: 10_000,
  })

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
    const firstOrder = selected?.messages.find((message) => message.type === "order")
    if (firstOrder?.type !== "order") return
    setInvoiceAmount(String(firstOrder.payload.subtotal))
    setInvoiceCurrency(firstOrder.payload.currency)
  }, [selected?.id])

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
            {selected ? (
              <div className="space-y-4">
                <div className="border-b border-[var(--border)] pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-sm text-[var(--text-primary)]">{selected.orderId}</h2>
                    <Badge variant="secondary" className="border-[var(--border)]">
                      {selected.status ?? "pending"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">
                    Buyer: <span className="font-mono">{selected.buyerPubkey}</span>
                  </p>
                </div>

                <div className="max-h-[52vh] space-y-3 overflow-auto pr-1">
                  {selected.messages.map((message) => (
                    <MessageCard key={message.id} message={message} mine={message.senderPubkey === pubkey} />
                  ))}
                </div>

                <div className="grid gap-3 border-t border-[var(--border)] pt-4 md:grid-cols-3">
                  <form
                    className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      invoiceMutation.mutate()
                    }}
                  >
                    <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Send invoice</div>
                    <div className="grid gap-1">
                      <Label htmlFor="invoice-bolt11">BOLT11</Label>
                      <Input
                        id="invoice-bolt11"
                        value={invoice}
                        onChange={(event) => setInvoice(event.target.value)}
                        placeholder="lnbc..."
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="grid gap-1">
                        <Label htmlFor="invoice-amount">Amount</Label>
                        <Input
                          id="invoice-amount"
                          type="number"
                          min="0"
                          step="0.01"
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
                    <Button type="submit" size="sm" className="w-full" disabled={invoiceMutation.isPending}>
                      {invoiceMutation.isPending ? "Sending…" : "Send invoice DM"}
                    </Button>
                  </form>

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
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">Select a conversation.</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
