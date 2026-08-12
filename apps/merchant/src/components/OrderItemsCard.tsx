import { ShoppingBag } from "lucide-react"
import { useId } from "react"
import type { OrderSummary } from "@conduit/core"
import { formatMerchantOrderAmount } from "../lib/order-summary-display"

type ProductLookup = Map<
  string,
  {
    title: string
    imageUrl?: string
    format: "physical" | "digital"
  }
>

export interface OrderItemsCardProps {
  items: OrderSummary["items"]
  productLookup: ProductLookup
  itemSubtotal: OrderSummary["itemSubtotal"]
  shippingCostSats: OrderSummary["shippingCostSats"]
  shippingCostStatus: OrderSummary["shippingCostStatus"]
  total: OrderSummary["subtotal"]
  currency: OrderSummary["currency"]
}

function getShippingDisplay(
  shippingCostSats: number | null,
  shippingCostStatus: OrderSummary["shippingCostStatus"]
): {
  amount: string
  detail: string | null
  totalLabel: string
  warning: string | null
  reconciledShippingSats: number | null
} {
  const conflict = (detail: string) => ({
    amount: "Conflicting shipping data",
    detail,
    totalLabel: "Recorded total",
    warning: detail,
    reconciledShippingSats: null,
  })

  if (shippingCostStatus === "manual") {
    if (shippingCostSats !== null && shippingCostSats > 0) {
      return conflict(
        `Shipping is marked for manual arrangement but records ${formatMerchantOrderAmount(shippingCostSats, "SATS")}.`
      )
    }
    return {
      amount: "Not included",
      detail: "Shipping will be arranged separately.",
      totalLabel: "Items total (shipping pending)",
      warning: null,
      reconciledShippingSats: null,
    }
  }

  if (shippingCostStatus === "included") {
    if (shippingCostSats !== null && shippingCostSats > 0) {
      return conflict(
        `Shipping is marked as included but records ${formatMerchantOrderAmount(shippingCostSats, "SATS")}.`
      )
    }
    return {
      amount:
        shippingCostSats === 0
          ? formatMerchantOrderAmount(0, "SATS")
          : "Included",
      detail: shippingCostSats === 0 ? "Included" : null,
      totalLabel: "Order total",
      warning: null,
      reconciledShippingSats: 0,
    }
  }

  if (shippingCostStatus === "not_required") {
    if (shippingCostSats !== null && shippingCostSats > 0) {
      return conflict(
        `Shipping is marked as not required but records ${formatMerchantOrderAmount(shippingCostSats, "SATS")}.`
      )
    }
    return {
      amount:
        shippingCostSats === 0
          ? formatMerchantOrderAmount(0, "SATS")
          : "Not required",
      detail: shippingCostSats === 0 ? "Not required" : null,
      totalLabel: "Order total",
      warning: null,
      reconciledShippingSats: 0,
    }
  }

  if (shippingCostStatus === "priced") {
    if (shippingCostSats === null) {
      return {
        amount: "Not recorded",
        detail: "Shipping is marked as priced, but no total was recorded.",
        totalLabel: "Recorded total",
        warning: null,
        reconciledShippingSats: null,
      }
    }
    return {
      amount: formatMerchantOrderAmount(shippingCostSats, "SATS"),
      detail: null,
      totalLabel: "Order total",
      warning: null,
      reconciledShippingSats: shippingCostSats,
    }
  }

  if (shippingCostSats !== null) {
    return {
      amount: formatMerchantOrderAmount(shippingCostSats, "SATS"),
      detail: "Shipping status was not recorded.",
      totalLabel: "Recorded total",
      warning: null,
      reconciledShippingSats: shippingCostSats,
    }
  }

  return {
    amount: "Not recorded",
    detail: "This order has no shipping breakdown.",
    totalLabel: "Recorded total",
    warning: null,
    reconciledShippingSats: null,
  }
}

function isSatsCurrency(currency: string): boolean {
  const normalized = currency.trim().toUpperCase()
  return normalized === "SAT" || normalized === "SATS"
}

export function OrderItemsCard({
  items,
  productLookup,
  itemSubtotal,
  shippingCostSats,
  shippingCostStatus,
  total,
  currency,
}: OrderItemsCardProps) {
  const headingId = useId()
  const shippingDisplay = getShippingDisplay(
    shippingCostSats,
    shippingCostStatus
  )
  const itemCount = items.reduce((total, item) => total + item.quantity, 0)
  const crossCurrencyShipping =
    shippingCostSats !== null &&
    shippingCostSats > 0 &&
    !isSatsCurrency(currency)
  const shippingDetail = [
    shippingDisplay.detail,
    crossCurrencyShipping
      ? `Shipping is recorded separately in sats and cannot be reconciled with the ${currency.trim().toUpperCase()} total.`
      : null,
  ]
    .filter((detail): detail is string => Boolean(detail))
    .join(" ")
  const totalLabel = crossCurrencyShipping
    ? "Recorded total"
    : shippingDisplay.totalLabel
  const hasSatsBreakdown =
    isSatsCurrency(currency) &&
    items.every((item) => isSatsCurrency(item.currency)) &&
    itemSubtotal !== null &&
    shippingDisplay.reconciledShippingSats !== null
  const discrepancySats =
    hasSatsBreakdown &&
    itemSubtotal !== null &&
    shippingDisplay.reconciledShippingSats !== null
      ? total - (itemSubtotal + shippingDisplay.reconciledShippingSats)
      : null
  const itemKeyCounts = new Map<string, number>()
  const keyedItems = items.map((item) => {
    const keyBase = JSON.stringify([
      item.productId,
      item.familyProductId,
      item.selectedSpecifications,
      item.title,
      item.format,
      item.quantity,
      item.priceAtPurchase,
      item.currency,
    ])
    const occurrence = itemKeyCounts.get(keyBase) ?? 0
    itemKeyCounts.set(keyBase, occurrence + 1)
    return { item, key: `${keyBase}:${occurrence}` }
  })

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <h3
        id={headingId}
        className="flex items-center gap-2 text-balance text-sm font-semibold text-[var(--text-primary)]"
      >
        <ShoppingBag className="size-4" aria-hidden="true" />
        Items
      </h3>

      <ul className="mt-3 space-y-3">
        {keyedItems.map(({ item, key }) => {
          const match = productLookup.get(item.productId)
          const image = match?.imageUrl
          const title = item.title || match?.title || "Product"
          const calculatedLineTotal = item.priceAtPurchase * item.quantity
          const lineTotal =
            Number.isFinite(calculatedLineTotal) &&
            (!isSatsCurrency(item.currency) ||
              Number.isSafeInteger(calculatedLineTotal))
              ? calculatedLineTotal
              : null

          return (
            <li key={key} className="flex items-start gap-3 text-sm">
              <div className="size-12 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                {image ? (
                  <img
                    src={image}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-pretty text-[var(--text-primary)]">
                  {title}
                </div>
                {(item.selectedSpecifications?.length ?? 0) > 0 ? (
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    {item.selectedSpecifications
                      ?.map(
                        (specification) =>
                          `${specification.key}: ${specification.value}`
                      )
                      .join(" · ")}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 tabular-nums">
                  <span className="text-xs text-[var(--text-secondary)]">
                    {formatMerchantOrderAmount(
                      item.priceAtPurchase,
                      item.currency
                    )}{" "}
                    each × {item.quantity}
                  </span>
                  <span className="ml-auto whitespace-nowrap text-right font-medium text-[var(--text-primary)]">
                    <span className="mr-1 text-xs font-normal text-[var(--text-muted)]">
                      Line total
                    </span>
                    {lineTotal === null
                      ? "Not available"
                      : formatMerchantOrderAmount(lineTotal, item.currency)}
                  </span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-sm tabular-nums">
        <div className="flex items-start justify-between gap-3 text-[var(--text-secondary)]">
          <dt>
            Items subtotal ({itemCount.toLocaleString()}{" "}
            {itemCount === 1 ? "item" : "items"})
          </dt>
          <dd className="text-right">
            {itemSubtotal === null
              ? "Not available"
              : formatMerchantOrderAmount(itemSubtotal, currency)}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3 text-[var(--text-secondary)]">
          <dt>Shipping</dt>
          <dd className="text-right">
            <div>{shippingDisplay.amount}</div>
            {shippingDetail && (
              <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                {shippingDetail}
              </div>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
          <dt className="font-medium text-[var(--text-secondary)]">
            {totalLabel}
          </dt>
          <dd className="text-base font-semibold text-[var(--text-primary)]">
            {formatMerchantOrderAmount(total, currency)}
          </dd>
        </div>
      </dl>

      {shippingDisplay.warning && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-pretty text-xs leading-5 text-warning"
        >
          {shippingDisplay.warning}
        </p>
      )}

      {discrepancySats !== null && discrepancySats !== 0 && (
        <p
          role="alert"
          className="mt-3 text-pretty rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning"
        >
          This recorded breakdown differs from the order total by{" "}
          {formatMerchantOrderAmount(Math.abs(discrepancySats), "SATS")}. Review
          the recorded amounts.
        </p>
      )}
    </section>
  )
}
