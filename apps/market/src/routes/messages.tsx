import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  EVENT_KINDS,
  formatPubkey,
  parseOrderMessageRumorEvent,
  requireNdkConnected,
  type ParsedOrderMessage,
  useAuth,
} from "@conduit/core"
import { Badge, Button } from "@conduit/ui"
import { giftUnwrap, NDKEvent, type NDKFilter, type NDKSigner } from "@nostr-dev-kit/ndk"
import { QRCodeSVG } from "qrcode.react"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/messages")({
  beforeLoad: () => {
    requireAuth()
  },
  component: MessagesPage,
})

type Conversation = {
  id: string
  orderId: string
  merchantPubkey: string
  messages: ParsedOrderMessage[]
  latestAt: number
  latestType: ParsedOrderMessage["type"]
  status: string | null
  totalSummary: string | null
}

async function tryUnwrap(event: NDKEvent, signer: NDKSigner) {
  try { return await giftUnwrap(event, undefined, signer, "nip44") } catch {}
  try { return await giftUnwrap(event, undefined, signer, "nip04") } catch {}
  return null
}

async function fetchBuyerMessages(buyerPubkey: string): Promise<ParsedOrderMessage[]> {
  const ndk = await requireNdkConnected()
  const signer = ndk.signer
  if (!signer) {
    throw new Error("Connect your Nostr signer to view messages.")
  }

  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.GIFT_WRAP],
    "#p": [buyerPubkey],
    limit: 200,
  }

  const wrapped = Array.from(await ndk.fetchEvents(filter)) as NDKEvent[]
  const unwrapped = await Promise.all(wrapped.map((event) => tryUnwrap(event, signer)))

  const parsed: ParsedOrderMessage[] = []
  for (const rumor of unwrapped) {
    if (!rumor) continue
    if (rumor.kind !== EVENT_KINDS.ORDER) continue
    try {
      parsed.push(parseOrderMessageRumorEvent(rumor))
    } catch {
      // ignore malformed order conversation rumors
    }
  }

  parsed.sort((a, b) => a.createdAt - b.createdAt)
  return parsed
}

function buildBuyerConversations(messages: ParsedOrderMessage[], buyerPubkey: string): Conversation[] {
  // Group by orderId only to avoid thread splitting when "p" tag is absent on inner rumor
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

    // Derive merchant pubkey from the first non-buyer participant
    const otherParticipants = Array.from(new Set(
      bucket.map((m) => m.senderPubkey === buyerPubkey ? m.recipientPubkey : m.senderPubkey).filter(Boolean)
    ))
    const merchantPubkey = otherParticipants[0] ?? ""

    conversations.push({
      id: orderId,
      orderId,
      merchantPubkey,
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

function InvoiceCard({
  invoice,
  amount,
  currency,
  note,
}: {
  invoice: string
  amount?: number
  currency?: string
  note?: string
}) {
  const [copied, setCopied] = useState(false)

  const copyInvoice = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback: select the text
    }
  }, [invoice])

  // Strip lightning: prefix if present, detect any bolt11 variant (lnbc, lntb, lnbcrt)
  const bolt11 = invoice.replace(/^lightning:/i, "")
  const isBolt11 = /^ln(bc|tb|bcrt)/i.test(bolt11)
  const walletUri = isBolt11 ? `lightning:${bolt11}` : null

  return (
    <div className="space-y-3">
      <div className="text-[var(--text-primary)] font-medium">Lightning Invoice</div>

      {amount != null && (
        <div className="text-sm text-[var(--text-secondary)]">
          Amount: {amount}{currency ? ` ${currency}` : " sats"}
        </div>
      )}

      <div className="flex justify-center rounded-md border border-[var(--border)] bg-white p-4">
        <QRCodeSVG value={bolt11.toUpperCase()} size={200} level="M" />
      </div>

      <div className="break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs text-[var(--text-secondary)]">
        {invoice}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={copyInvoice}>
          {copied ? "Copied" : "Copy invoice"}
        </Button>
        {walletUri && (
          <Button asChild variant="primary" size="sm" className="flex-1">
            <a href={walletUri}>Open in wallet</a>
          </Button>
        )}
      </div>

      {note && <div className="text-xs text-[var(--text-secondary)]">{note}</div>}
    </div>
  )
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
          <InvoiceCard invoice={message.payload.invoice} amount={message.payload.amount} currency={message.payload.currency} note={message.payload.note} />
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
                rel="noopener noreferrer"
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

function MessagesPage() {
  const { pubkey } = useAuth()
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)

  const messagesQuery = useQuery({
    queryKey: ["buyer-messages", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchBuyerMessages(pubkey!),
    refetchInterval: 10_000,
  })

  const conversations = useMemo(
    () => buildBuyerConversations(messagesQuery.data ?? [], pubkey ?? ""),
    [messagesQuery.data, pubkey]
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Messages</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Buyer-side NIP-17 order conversation inbox (kind {EVENT_KINDS.ORDER} rumors in gift wraps).
          </p>
        </div>
        <Button asChild variant="muted">
          <Link to="/checkout" search={{ merchant: undefined }}>
            Go to checkout
          </Link>
        </Button>
      </div>

      {messagesQuery.isLoading && <div className="text-sm text-[var(--text-secondary)]">Loading messages…</div>}

      {messagesQuery.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load messages:{" "}
          {messagesQuery.error instanceof Error ? messagesQuery.error.message : "Unknown error"}
        </div>
      )}

      {!messagesQuery.isLoading && conversations.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No order messages yet. Place an order to start a conversation with a merchant.
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
                      Merchant: {formatPubkey(conversation.merchantPubkey, 8)}
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
                    Merchant: <span className="font-mono">{selected.merchantPubkey}</span>
                  </p>
                </div>

                <div className="max-h-[65vh] space-y-3 overflow-auto pr-1">
                  {selected.messages.map((message) => (
                    <MessageCard key={message.id} message={message} mine={message.senderPubkey === pubkey} />
                  ))}
                </div>
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
