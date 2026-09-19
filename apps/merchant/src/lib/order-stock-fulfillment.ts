import type { CommerceProductRecord, OrderSummary } from "@conduit/core"
import type { ProductPublicationFulfillmentIntent } from "./product-publishing"
import {
  buildOrderStockAdjustments,
  getOrderStockAdjustmentForDisplay,
  type OrderStockAdjustment,
  type ProductStockDecision,
} from "./productStock"

/** Prepare a merchant-owned inventory mutation without reauthorizing fulfillment. */
export function prepareOrderStockUpdate(input: {
  merchantPubkey: string
  orderId: string
  items: OrderSummary["items"]
  adjustment: OrderStockAdjustment
  record: CommerceProductRecord
  persistedDecision?: ProductStockDecision | null
}): {
  adjustment: OrderStockAdjustment
  fulfillmentIntent: ProductPublicationFulfillmentIntent
} {
  const { record, adjustment } = input
  const address = `30402:${input.merchantPubkey}:${record.dTag}`
  if (
    !record.dTag ||
    record.addressId !== address ||
    record.product.id !== address ||
    record.product.pubkey !== input.merchantPubkey ||
    adjustment.addressId !== address
  ) {
    throw new Error("The stock target does not match this merchant's listing.")
  }
  if (!Number.isSafeInteger(adjustment.nextStock) || adjustment.nextStock < 0) {
    throw new Error("Stock must be a non-negative safe integer.")
  }

  const current = buildOrderStockAdjustments({
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    items: input.items,
    productRecords: [record],
  })[0]
  if (!current || current.key !== adjustment.key) {
    throw new Error("The stock target does not match this order's listing.")
  }
  const actionable = getOrderStockAdjustmentForDisplay({
    adjustment: current,
    persistedDecision: input.persistedDecision ?? null,
  })
  if (actionable.quantity !== adjustment.quantity) {
    throw new Error(
      "The order stock adjustment changed. Refresh the order and try again."
    )
  }

  return {
    adjustment: {
      ...actionable,
      ...(adjustment.targetMode === "custom"
        ? { nextStock: adjustment.nextStock, targetMode: "custom" as const }
        : {}),
    },
    fulfillmentIntent: { kind: "preserve_existing", baseline: record.product },
  }
}
