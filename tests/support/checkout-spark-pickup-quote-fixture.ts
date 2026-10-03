import {
  evaluateListingSafety,
  parseProductEvent,
  resolveEventMarketEvidence,
  type ProductsByIdsResult,
} from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../../apps/market/src/lib/checkout-authorization"
import { createCartItemFromProduct } from "../../apps/market/src/lib/cart-model"
import { buildCheckoutSparkQuoteAuthority } from "../../apps/market/src/lib/checkout-spark-quote-authority"
import { assertCartPickupHandlerReady } from "../../apps/market/src/lib/pickup-handoff"
import {
  getProductEventMarketCandidates,
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
} from "../../apps/market/src/lib/event-market-adapter"
import { createCheckoutSparkPickupFixture } from "./checkout-spark-pickup-fixture"

/** Real signed graph, catalog projection, submit authorization and SAT quote. */
export async function createCheckoutSparkPickupQuoteFixture(
  options: Parameters<typeof createCheckoutSparkPickupFixture>[0] = {}
) {
  const f = createCheckoutSparkPickupFixture(options)
  const product = {
    ...parseProductEvent(f.productEvent),
    sourceEventId: f.productEvent.id,
  }
  const result: ProductsByIdsResult = {
    data: [
      {
        product,
        addressId: product.id,
        eventId: f.productEvent.id,
        eventCreatedAt: f.productEvent.created_at,
        dTag: "coffee",
        safety: evaluateListingSafety(product),
      },
    ],
    diagnostics: [
      {
        productId: product.id,
        addressId: product.id,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ],
    meta: {
      source: "commerce",
      degraded: false,
      stale: false,
      capped: false,
      fetchedAt: f.acceptedAtMs,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: true,
        cursorPagination: false,
      },
    },
  }
  const catalog = projectRawEventCatalog({
    reference: f.line.pickup!.collection.coordinate,
    complete: true,
    result,
    resolution: resolveEventMarketEvidence({
      reference: f.line.pickup!.collection.coordinate,
      events: f.sourceEvents,
      productRequestEvents: [f.productEvent],
      livePickupEventIds: new Set([f.pickup.id]),
      nowMs: f.acceptedAtMs,
    }),
  })
  const resolve = () =>
    resolveProductCartFulfillmentFromCatalogs(product, [
      {
        candidate: getProductEventMarketCandidates(product)[0]!,
        catalog,
      },
    ])
  const resolved = resolve()
  if (resolved.status !== "pickup")
    throw new Error("Expected current signed pickup")
  const item = {
    ...createCartItemFromProduct(product, resolved.fulfillment),
    quantity: f.line.quantity,
  }
  const authorization = await authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [item],
    rawItems: [item],
    refreshedProducts: [product],
    resolveProductFulfillment: async () => resolve(),
    readShippingOptions: async () => [],
    authorizePickupHandlers: (items) =>
      assertCartPickupHandlerReady(items, async (organizerPubkey) => ({
        state: "ready",
        organizerPubkey,
        relayUrls: ["wss://organizer.inbox.relay.dev"],
      })),
  })
  if (authorization.status !== "ok")
    throw new Error("Expected authorized pickup")
  const quote = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: null,
    nowMs: f.acceptedAtMs,
  })
  return { ...f, product, item, quote }
}
