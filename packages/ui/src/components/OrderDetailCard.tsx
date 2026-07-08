import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { Badge } from "./Badge"

type OrderItem = {
  productId: string
  title?: string
  quantity: number
  priceAtPurchase: number
  currency: string
  sourcePrice?: {
    amount: number
    currency: string
    normalizedCurrency: string
  }
}

type ShippingAddress = {
  name: string
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export type OrderDetailCardProps = {
  orderId: string
  status: string | null
  counterpartyLabel: string
  counterpartyName?: string
  counterpartyPubkeyLabel: string
  items: OrderItem[]
  subtotal: number
  currency: string
  shippingAddress: ShippingAddress | null
  orderNote: string | null
  invoiceSent: boolean
  invoiceCount: number
  invoiceAmount: number | null
  invoiceCurrency: string | null
  paymentProofReceived?: boolean
  paymentProofCount?: number
  paymentProofAmount?: number | null
  paymentProofCurrency?: string | null
  paymentReportReceived?: boolean
  paymentReportCount?: number
  paymentReportAmount?: number | null
  paymentReportCurrency?: string | null
  trackingCarrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  btcUsdRate?: unknown
}

function formatOrderAmount(amount: number, currency: string): string {
  if (currency.trim().toUpperCase() === "SATS") {
    return `${amount.toLocaleString()} sats`
  }

  return `${amount.toLocaleString()} ${currency.trim().toUpperCase()}`
}

export function OrderDetailCard({
  orderId,
  status,
  counterpartyLabel,
  counterpartyName,
  counterpartyPubkeyLabel,
  items,
  subtotal,
  currency,
  shippingAddress,
  orderNote,
  invoiceSent,
  invoiceCount,
  invoiceAmount,
  invoiceCurrency,
  paymentProofReceived = false,
  paymentProofCount = 0,
  paymentProofAmount = null,
  paymentProofCurrency = null,
  paymentReportReceived = paymentProofReceived,
  paymentReportCount = paymentProofCount,
  paymentReportAmount = paymentProofAmount,
  paymentReportCurrency = paymentProofCurrency,
  trackingCarrier,
  trackingNumber,
  trackingUrl,
}: OrderDetailCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-sm">{orderId}</CardTitle>
          <Badge variant="secondary" className="border-[var(--border)]">
            {status ?? "pending"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {counterpartyLabel}:{" "}
          <span className="text-[var(--text-primary)]">
            {counterpartyName ?? counterpartyPubkeyLabel}
          </span>
          {counterpartyName && (
            <span className="ml-2 font-mono text-[var(--text-muted)]">
              {counterpartyPubkeyLabel}
            </span>
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {items.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Items
            </div>
            <div className="space-y-1">
              {items.map((item, i) => {
                const itemTitle = item.title?.trim()
                return (
                  <div
                    key={`${item.productId}-${i}`}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 text-[var(--text-primary)]">
                      <span className={itemTitle ? "" : "font-mono text-xs"}>
                        {itemTitle || item.productId}
                      </span>
                      <span className="ml-1 text-[var(--text-secondary)]">
                        x{item.quantity}
                      </span>
                      {itemTitle && (
                        <span className="mt-1 block truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {item.productId}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[var(--text-secondary)]">
                      {formatOrderAmount(item.priceAtPurchase, item.currency)}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between border-t border-[var(--border)] pt-2 text-sm font-medium">
              <span className="text-[var(--text-primary)]">Subtotal</span>
              <span className="text-[var(--text-primary)]">
                {formatOrderAmount(subtotal, currency)}
              </span>
            </div>
          </div>
        )}

        {shippingAddress && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Shipping address
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-2 text-xs text-[var(--text-secondary)]">
              <div>{shippingAddress.name}</div>
              <div>{shippingAddress.street}</div>
              <div>
                {shippingAddress.city}
                {shippingAddress.state ? `, ${shippingAddress.state}` : ""}{" "}
                {shippingAddress.postalCode}
              </div>
              <div>{shippingAddress.country}</div>
            </div>
          </div>
        )}

        {orderNote && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Order note
            </div>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-2 text-xs text-[var(--text-secondary)]">
              {orderNote}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
            Payment
          </div>
          {paymentProofReceived ? (
            <div className="space-y-1">
              <div className="text-sm text-[var(--text-primary)]">
                Lightning payment proof received
                {paymentProofAmount != null
                  ? ` - ${paymentProofAmount.toLocaleString()}`
                  : ""}
                {paymentProofCurrency ? ` ${paymentProofCurrency}` : ""}
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                Buyer payment proof is attached.
                {paymentProofCount > 1
                  ? ` ${paymentProofCount} payment proofs are attached to this order.`
                  : ""}
              </div>
            </div>
          ) : paymentReportReceived ? (
            <div className="space-y-1">
              <div className="text-sm text-[var(--text-primary)]">
                External payment reported
                {paymentReportAmount != null
                  ? ` - ${paymentReportAmount.toLocaleString()}`
                  : ""}
                {paymentReportCurrency ? ` ${paymentReportCurrency}` : ""}
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                Buyer reported paying this invoice. Confirm payment before
                fulfillment.
                {paymentReportCount > 1
                  ? ` ${paymentReportCount} payment reports are attached to this order.`
                  : ""}
              </div>
            </div>
          ) : invoiceSent ? (
            <div className="space-y-1">
              <div className="text-sm text-[var(--text-primary)]">
                Sent{invoiceAmount != null ? ` — ${invoiceAmount}` : ""}
                {invoiceCurrency ? ` ${invoiceCurrency}` : ""}
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                {status === "paid"
                  ? "Marked paid."
                  : "Awaiting payment confirmation."}
                {invoiceCount > 1
                  ? ` ${invoiceCount} invoices have been sent on this order.`
                  : ""}
              </div>
            </div>
          ) : (
            <div className="text-sm text-[var(--text-secondary)]">
              Not yet sent
            </div>
          )}
        </div>

        {(trackingCarrier || trackingNumber || trackingUrl) && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Tracking
            </div>
            {trackingCarrier && (
              <div className="text-sm text-[var(--text-primary)]">
                {trackingCarrier}
              </div>
            )}
            {trackingNumber && (
              <div className="font-mono text-xs text-[var(--text-secondary)]">
                {trackingNumber}
              </div>
            )}
            {(() => {
              if (!trackingUrl) return null
              try {
                const u = new URL(trackingUrl)
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
