import { matchFilter, type Filter } from "nostr-tools"
import {
  createEventMarketPickupSnapshot,
  parseProductEvent,
  readEventMarketProduct,
  readEventMarketRoster,
} from "@conduit/core"
import { createCartItemFromProduct } from "../../apps/market/src/lib/cart-model"
import { createEventMarketOrderFixture } from "./event-market-order-fixture"

/** Actual signed current authority reads composed with checkout authorization. */
export async function createEventMarketCheckoutFixture() {
  const fixture = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const dependencies: NonNullable<Parameters<typeof readEventMarketRoster>[1]> =
    {
      plan: async () => ({
        relayUrls: ["wss://current.example"],
        candidateRelayUrls: ["wss://current.example"],
        maxRelayAttempts: 1,
        ownerSelectedRelayUrls: [],
        appRelayUrls: ["wss://current.example"],
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayListState: "missing",
        relayHintTruncated: false,
      }),
      fetch: async (filter) => ({
        events: fixture.events.filter((event) =>
          matchFilter(filter as Filter, event)
        ),
        relays: [{ relayUrl: "wss://current.example", status: "success" }],
      }),
      load: async () => [],
      retain: async () => undefined,
    }
  const readMarket = (input: Parameters<typeof readEventMarketRoster>[0]) =>
    readEventMarketRoster(input, dependencies)
  const readProduct = (input: Parameters<typeof readEventMarketProduct>[0]) =>
    readEventMarketProduct(input, dependencies)
  const marketRead = await readMarket({
    reference: fixture.fulfillment.market.coordinate,
  })
  const productRead = await readProduct({
    marketRead,
    productCoordinate: fixture.fulfillment.product.coordinate,
    selectedOccurrenceCoordinate: fixture.fulfillment.calendar.coordinate,
  })
  const fulfillment = createEventMarketPickupSnapshot({
    marketRead,
    productRead,
    selectedOccurrenceCoordinate: fixture.fulfillment.calendar.coordinate,
  })
  const productEvent = fixture.events.find((event) => event.kind === 30402)!
  const product = {
    ...parseProductEvent(productEvent),
    sourceEventId: productEvent.id,
  }
  return {
    ...fixture,
    product,
    fulfillment,
    item: { ...createCartItemFromProduct(product, fulfillment), quantity: 1 },
    futureEventMarketDependencies: {
      readMarket,
      readProduct,
      snapshot: createEventMarketPickupSnapshot,
    },
  }
}
