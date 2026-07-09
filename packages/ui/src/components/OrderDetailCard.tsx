import { MessageCircle } from "lucide-react"
import { Card } from "./Card"

type OrderItem = {
  productId: string
  title?: string
  imageUrl?: string
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
  counterpartyLabel: string
  counterpartyName?: string
  counterpartyPubkeyLabel: string
  counterpartyHref?: string
  items: OrderItem[]
  subtotal: number
  currency: string
  shippingAddress: ShippingAddress | null
  orderNote: string | null
  trackingCarrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  onOpenMessages?: () => void
  btcUsdRate?: unknown
}

function formatOrderAmount(amount: number, currency: string): string {
  if (currency.trim().toUpperCase() === "SATS") {
    return `${amount.toLocaleString()} sats`
  }

  return `${amount.toLocaleString()} ${currency.trim().toUpperCase()}`
}

const sectionLabel =
  "text-xs uppercase tracking-wide text-[var(--text-secondary)]"
const subCard =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3"

export function OrderDetailCard({
  orderId,
  counterpartyLabel,
  counterpartyName,
  counterpartyPubkeyLabel,
  counterpartyHref,
  items,
  subtotal,
  currency,
  shippingAddress,
  orderNote,
  trackingCarrier,
  trackingNumber,
  trackingUrl,
  onOpenMessages,
}: OrderDetailCardProps) {
  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className={`${subCard} space-y-2`}>
            <div className={sectionLabel}>Items</div>
            {items.length > 0 ? (
              <>
                <div className="space-y-1">
                  {items.map((item, i) => (
                    <div
                      key={`${item.productId}-${i}`}
                      className="flex items-center gap-3 text-sm"
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-md border border-[var(--border)] object-cover"
                        />
                      ) : (
                        <div className="h-10 w-10 shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[var(--text-primary)]">
                          {item.title?.trim() || "Product"}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)]">
                          Qty {item.quantity}
                        </div>
                      </div>
                      <span className="shrink-0 text-[var(--text-secondary)]">
                        {formatOrderAmount(item.priceAtPurchase, item.currency)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-[var(--border)] pt-2 text-sm font-medium">
                  <span className="text-[var(--text-primary)]">Subtotal</span>
                  <span className="text-[var(--text-primary)]">
                    {formatOrderAmount(subtotal, currency)}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">
                No items on this order.
              </div>
            )}
          </div>

          <div className={`${subCard} space-y-4`}>
            <div className="space-y-1">
              <div className={sectionLabel}>{counterpartyLabel}</div>
              <p className="text-sm text-[var(--text-secondary)]">
                {counterpartyHref ? (
                  <a
                    href={counterpartyHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--text-primary)] underline-offset-2 hover:underline"
                  >
                    {counterpartyName ?? counterpartyPubkeyLabel}
                  </a>
                ) : (
                  <span className="text-[var(--text-primary)]">
                    {counterpartyName ?? counterpartyPubkeyLabel}
                  </span>
                )}
                {counterpartyName && (
                  <span className="ml-2 font-mono text-[var(--text-muted)]">
                    {counterpartyPubkeyLabel}
                  </span>
                )}
              </p>
            </div>

            {shippingAddress && (
              <div className="space-y-1">
                <div className={sectionLabel}>Shipping address</div>
                <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
                  <div>{shippingAddress.name}</div>
                  <div>{shippingAddress.street}</div>
                  <div>
                    {shippingAddress.city}
                    {shippingAddress.state
                      ? `, ${shippingAddress.state}`
                      : ""}{" "}
                    {shippingAddress.postalCode}
                  </div>
                  <div>{shippingAddress.country}</div>
                </div>
              </div>
            )}

            {orderNote && (
              <div className="space-y-1">
                <div className={sectionLabel}>Order note</div>
                <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--text-secondary)]">
                  {orderNote}
                </div>
              </div>
            )}

            {(trackingCarrier || trackingNumber || trackingUrl) && (
              <div className="space-y-1">
                <div className={sectionLabel}>Tracking</div>
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
          </div>
        </div>

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-[var(--border)] pt-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
              Order ID
            </div>
            <div className="break-all font-mono text-xs text-[var(--text-secondary)]">
              {orderId}
            </div>
          </div>
          {onOpenMessages && (
            <button
              type="button"
              onClick={onOpenMessages}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              Messages
            </button>
          )}
        </div>
      </div>
    </Card>
  )
}
