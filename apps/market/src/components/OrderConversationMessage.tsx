import { useCallback, useState } from "react"
import { Badge, Button } from "@conduit/ui"
import {
  decodeLightningInvoiceAmount,
  getLightningInvoiceNetwork,
  getLightningNetworkMismatchMessage,
  isInvoiceCompatibleWithCurrentNetwork,
  normalizeLightningInvoice,
  type ParsedOrderMessage,
} from "@conduit/core"
import { QRCodeSVG } from "qrcode.react"

export function formatProductReference(productId: string): { title: string; detail: string } {
  const normalized = productId.trim()
  const segments = normalized.split(":").filter(Boolean)
  const rawLabel = segments.length > 0 ? segments[segments.length - 1] : normalized
  const displaySource = rawLabel || normalized

  const title = displaySource
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Product"

  return {
    title,
    detail: normalized,
  }
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
      // no-op
    }
  }, [invoice])

  const bolt11 = normalizeLightningInvoice(invoice)
  const decodedAmount = decodeLightningInvoiceAmount(invoice)
  const invoiceNetwork = getLightningInvoiceNetwork(invoice)
  const invoiceMismatch = getLightningNetworkMismatchMessage(invoice)
  const isCompatible = isInvoiceCompatibleWithCurrentNetwork(invoice)
  const walletUri = invoiceNetwork !== "unknown" && isCompatible ? `lightning:${bolt11}` : null
  const displayAmount = decodedAmount.sats ?? decodedAmount.msats ?? amount ?? null
  const displayCurrency = decodedAmount.currency ?? currency ?? null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--text-primary)]">Lightning invoice</div>
        {displayAmount != null && (
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {displayAmount}{displayCurrency ? ` ${displayCurrency}` : " sats"}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-[var(--border)]">
          {invoiceNetwork}
        </Badge>
        {invoiceMismatch ? (
          <span className="text-xs text-error">{invoiceMismatch}</span>
        ) : (
          <span className="text-xs text-[var(--text-secondary)]">Matches current checkout environment.</span>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-md border border-[var(--border)] bg-white p-3">
          <QRCodeSVG value={bolt11} size={156} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="max-h-24 overflow-auto break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs text-[var(--text-secondary)]">
            {invoice}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={copyInvoice}>
              {copied ? "Copied" : "Copy"}
            </Button>
            {walletUri && (
              <Button asChild size="sm" className="flex-1">
                <a href={walletUri}>Pay</a>
              </Button>
            )}
            {!walletUri && invoiceMismatch && (
              <Button size="sm" className="flex-1" disabled>
                Pay unavailable
              </Button>
            )}
          </div>
        </div>
      </div>

      {note && <div className="text-xs text-[var(--text-secondary)]">{note}</div>}
    </div>
  )
}

export function getConversationPreview(message: ParsedOrderMessage): string {
  switch (message.type) {
    case "order":
      return `Order for ${message.payload.subtotal} ${message.payload.currency}`
    case "payment_request":
      return message.payload.note ?? "Invoice sent"
    case "status_update":
      return message.payload.note ?? `Status updated to ${message.payload.status}`
    case "shipping_update":
      return message.payload.note ?? "Shipping updated"
    case "receipt":
      return message.payload.note ?? "Payment received"
    case "message":
      return message.payload.note
    case "payment_proof":
      return "Payment proof shared"
    default:
      return "Order update"
  }
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

export function OrderConversationMessage({
  message,
  mine,
}: {
  message: ParsedOrderMessage
  mine: boolean
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-[1.1rem] border p-3 text-sm ${
          mine
            ? "border-secondary-500/30 bg-secondary-500/12"
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
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5"
                >
                  <div className="text-sm text-[var(--text-primary)]">{product.title}</div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    Qty {item.quantity} · {item.priceAtPurchase} {item.currency}
                  </div>
                  <div className="mt-1 break-all font-mono text-[11px] leading-5 text-[var(--text-muted)]">
                    {product.detail}
                  </div>
                </div>
              )
            })}
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
          <InvoiceCard
            invoice={message.payload.invoice}
            amount={message.payload.amount}
            currency={message.payload.currency}
            note={message.payload.note}
          />
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
                const url = new URL(raw)
                if (url.protocol !== "http:" && url.protocol !== "https:") return null
                return (
                  <a
                    className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                    href={url.toString()}
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

        {message.type === "message" && (
          <div className="text-[var(--text-primary)]">{message.payload.note}</div>
        )}

        {message.type === "payment_proof" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Lightning payment sent</span>
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2 text-xs">
              {message.payload.invoice && (
                <div className="min-w-0">
                  <div className="text-[var(--text-muted)] mb-0.5">Invoice</div>
                  <div className="break-all font-mono text-[var(--text-secondary)] leading-5 max-h-16 overflow-hidden">
                    {message.payload.invoice.slice(0, 80)}&hellip;
                  </div>
                </div>
              )}
              {message.payload.preimage && (
                <div className="min-w-0 border-t border-[var(--border)] pt-2">
                  <div className="text-[var(--text-muted)] mb-0.5">Payment preimage</div>
                  <div className="break-all font-mono text-[var(--text-secondary)] leading-5">
                    {message.payload.preimage}
                  </div>
                </div>
              )}
              {message.payload.paymentHash && (
                <div className="min-w-0 border-t border-[var(--border)] pt-2">
                  <div className="text-[var(--text-muted)] mb-0.5">Payment hash</div>
                  <div className="break-all font-mono text-[var(--text-secondary)] leading-5">
                    {message.payload.paymentHash}
                  </div>
                </div>
              )}
              {message.payload.feeMsats != null && (
                <div className="border-t border-[var(--border)] pt-2">
                  <div className="text-[var(--text-muted)] mb-0.5">Routing fee</div>
                  <div className="text-[var(--text-secondary)]">
                    {message.payload.feeMsats} msats
                  </div>
                </div>
              )}
            </div>
            {message.payload.note && (
              <div className="text-xs text-[var(--text-secondary)]">
                {message.payload.note}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
