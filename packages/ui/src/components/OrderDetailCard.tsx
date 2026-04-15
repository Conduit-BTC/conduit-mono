import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { Badge } from "./Badge"

type OrderItem = {
  productId: string
  quantity: number
  priceAtPurchase: number
  currency: string
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
  counterpartyPubkey: string
  items: OrderItem[]
  subtotal: number
  currency: string
  shippingAddress: ShippingAddress | null
  orderNote: string | null
  invoiceSent: boolean
  invoiceCount: number
  invoiceAmount: number | null
  invoiceCurrency: string | null
  trackingCarrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
}

export function OrderDetailCard({
  orderId,
  status,
  counterpartyLabel,
  counterpartyName,
  counterpartyPubkey,
  items,
  subtotal,
  currency,
  shippingAddress,
  orderNote,
  invoiceSent,
  invoiceCount,
  invoiceAmount,
  invoiceCurrency,
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
            {counterpartyName ?? counterpartyPubkey}
          </span>
          {counterpartyName && (
            <span className="ml-2 font-mono text-[var(--text-muted)]">
              {counterpartyPubkey}
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
              {items.map((item, i) => (
                <div
                  key={`${item.productId}-${i}`}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-[var(--text-primary)]">
                    <span className="font-mono text-xs">{item.productId}</span>
                    <span className="mx-1 text-[var(--text-secondary)]">
                      x{item.quantity}
                    </span>
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    {item.priceAtPurchase} {item.currency}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-[var(--border)] pt-2 text-sm font-medium">
              <span className="text-[var(--text-primary)]">Subtotal</span>
              <span className="text-[var(--text-primary)]">
                {subtotal} {currency}
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
            Invoice
          </div>
          {invoiceSent ? (
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
