import type { PricingRateInput } from "@conduit/core"
import {
  projectRawEventCatalog,
  type RawEventCatalog,
} from "./event-market-adapter"

export function getEventCatalogQueryDisplayState(
  query: {
    data?: RawEventCatalog
    isFetching: boolean
    isError: boolean
    isPaused: boolean
    isPending: boolean
  },
  rateInput: PricingRateInput = null,
  relaySettingsReady = true
) {
  let data = query.data
    ? projectRawEventCatalog(
        query.data,
        rateInput,
        query.data.complete &&
          !query.isFetching &&
          !query.isError &&
          !query.isPaused &&
          relaySettingsReady
      )
    : undefined
  // A retained successful resolution describes the previous read. Once a
  // refresh fails or pauses, show that evidence as stale without changing the
  // shared raw cache or overriding stronger terminal protocol states.
  if (
    data &&
    !query.isFetching &&
    (query.isError || query.isPaused) &&
    (data.state === "active" || data.state === "partial")
  ) {
    data = { ...data, state: "stale" }
  }
  return {
    data,
    isInitialLoading: !query.data && (!relaySettingsReady || query.isPending),
    isHydrating: query.isFetching || !relaySettingsReady,
  }
}
