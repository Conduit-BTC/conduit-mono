import type { StatusStepperRow } from "@conduit/ui"
import type { OrderHeaderStatus } from "./order-view"

/** Legacy invoice copy is inapplicable to a routed order. */
export function presentSettledRouterHeaderStatus(
  status: OrderHeaderStatus,
  isRouterOrder: boolean
): OrderHeaderStatus {
  if (
    !isRouterOrder ||
    (status.detailLabel !== "Awaiting invoice" &&
      status.detailLabel !== "Invoice ready")
  ) {
    return status
  }
  return {
    ...status,
    tone: "info",
    detailLabel: "Private Spark routing",
  }
}

/** Routed checkout has no generic merchant invoice or buyer payment-proof step. */
export function presentSettledRouterTimeline(
  rows: StatusStepperRow[],
  isRouterOrder: boolean
): StatusStepperRow[] {
  return isRouterOrder
    ? rows.filter((row) => row.key !== "invoice" && row.key !== "receipt")
    : rows
}
