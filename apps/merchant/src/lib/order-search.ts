import { isOrderQueueTab, type OrderQueueTab } from "./order-phase"

export type MerchantOrdersSearch = {
  order?: string
  queue?: OrderQueueTab
  recovery?: "paused"
}

export function parseMerchantOrderSearch(
  search: Record<string, unknown>
): MerchantOrdersSearch {
  const order = search.order
  const queue = search.queue
  return {
    ...(typeof order === "string" && order.length > 0 ? { order } : {}),
    ...(isOrderQueueTab(queue) && queue !== "all" ? { queue } : {}),
    ...(search.recovery === "paused" ? { recovery: "paused" as const } : {}),
  }
}

export function shouldStartMerchantOrderRecoveryAutomatically(
  rehearsalEnabled: boolean,
  recovery: MerchantOrdersSearch["recovery"]
): boolean {
  return rehearsalEnabled && recovery !== "paused"
}
