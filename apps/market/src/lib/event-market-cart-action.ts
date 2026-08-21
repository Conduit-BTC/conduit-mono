import type { EventCatalog } from "./event-market-adapter"

export interface EventCatalogCartAction {
  enabled: boolean
  disabledLabel: string | null
}

export function getEventCatalogCartAction(input: {
  state: EventCatalog["state"]
  purchaseReady: boolean
  hasPickupFulfillment: boolean
}): EventCatalogCartAction {
  if (input.state === "ended") {
    return { enabled: false, disabledLabel: "Event ended" }
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
