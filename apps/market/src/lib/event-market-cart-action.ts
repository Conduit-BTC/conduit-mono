import type { EventCatalog } from "./event-market-adapter"

export interface EventCatalogCartAction {
  enabled: boolean
  disabledLabel: string | null
}

export function getEventCatalogCartAction(input: {
  state: EventCatalog["state"]
  orderAcceptance?: "open" | "closed"
  purchaseReady: boolean
  hasPickupFulfillment: boolean
  isChecking?: boolean
}): EventCatalogCartAction {
  if (input.state === "ended") {
    return {
      enabled: false,
      disabledLabel:
        input.orderAcceptance === "closed" ? "Event closed" : "Event ended",
    }
  }

  if (input.isChecking) {
    return { enabled: false, disabledLabel: "Checking pickup…" }
  }

  if (!input.hasPickupFulfillment) {
    return { enabled: false, disabledLabel: "Pickup unavailable" }
  }

  if (!input.purchaseReady) {
    return {
      enabled: false,
      disabledLabel:
        input.state === "stale" ? "Refresh required" : "Unavailable",
    }
  }

  return { enabled: true, disabledLabel: null }
}
