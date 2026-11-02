import type { LocalProductStockRecovery } from "@conduit/core"
import { hasCommonAcknowledgedRelay } from "@conduit/core/protocol/product-listing-delivery"

export type OrderStockHistory =
  | { status: "checking" }
  | { status: "unavailable" }
  | {
      status: "loaded"
      records: Array<{
        decision: string
        delivery: string
        acknowledged: boolean
        superseded: boolean
      }>
    }

const decisionLabels = new Map<
  LocalProductStockRecovery["checkpoint"]["state"],
  string
>([
  ["pending", "Pending local decision"],
  ["applied", "Applied locally"],
  ["unpublished", "Recorded as unpublished"],
])

const deliveryLabels = new Map<
  LocalProductStockRecovery["listingJob"]["state"],
  string
>([
  ["pending", "Pending delivery"],
  ["partial", "Partial delivery"],
  ["delivered", "Recorded as delivered"],
  ["failed", "Recorded as failed"],
  ["superseded_unpublished", "Superseded before publication"],
])

/** Project validated local history only; never use this display to authorize a write. */
export function getOrderStockHistory(query: {
  status: "pending" | "error" | "success"
  isFetching: boolean
  data?: LocalProductStockRecovery[]
}): OrderStockHistory {
  if (query.status === "error") return { status: "unavailable" }
  if (query.status === "pending" || query.isFetching) {
    return { status: "checking" }
  }
  if (!query.data) return { status: "unavailable" }
  return {
    status: "loaded",
    records: query.data.map(({ checkpoint, listingJob, signedEvent }) => ({
      decision:
        decisionLabels.get(checkpoint.state) ?? "Unknown saved decision",
      delivery:
        deliveryLabels.get(listingJob.state) ?? "Unknown saved delivery",
      acknowledged: hasCommonAcknowledgedRelay(listingJob),
      superseded: Object.prototype.hasOwnProperty.call(
        listingJob.localReplaySupersededBy ?? {},
        signedEvent.id
      ),
    })),
  }
}
