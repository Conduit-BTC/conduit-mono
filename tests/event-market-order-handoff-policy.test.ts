import { expect, it } from "bun:test"
import { classifyEventMarketOrderHandoff } from "@conduit/core/protocol/event-market-order-handoff-policy"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
} from "./support/checkout-spark-event-market-fixture"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"

const buyer = () => getPublicKey(generateSecretKey())
function legacyOrder() {
  const f = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
  const order = createCheckoutSparkEventMarketFixtureOrder(f, buyer())
  const pickup = order.items[0]!.fulfillment!
  if (pickup.type !== "event_market_pickup")
    throw new Error("Expected event fixture")
  const signedEvent = f.signMerchant({
    ...f.events.assignment,
    tags: f.events.assignment.tags.filter(
      (tag) => tag[0] !== "conduit_stock_pool"
    ),
  })
  pickup.occurrenceAssignment = {
    ...pickup.occurrenceAssignment!,
    eventId: signedEvent.id,
    signedEvent,
  }
  return order
}
it("keeps the historical ready-receipt flow only for organizer orders without a stock commitment", () => {
  const order = legacyOrder()
  expect(classifyEventMarketOrderHandoff(order)).toBe("legacy_merchant_release")
  const present = checkoutSparkEventMarketFixture()
  expect(
    classifyEventMarketOrderHandoff(
      createCheckoutSparkEventMarketFixtureOrder(present, buyer())
    )
  ).toBe("not_organizer_handoff")
  expect(classifyEventMarketOrderHandoff(null)).toBe("not_organizer_handoff")
})

it("uses the organizer stock/import path, not a new live Merchant release, for a valid exact committed pool", () => {
  const f = checkoutSparkEventMarketFixture({
    mode: "organizer_handoff",
    stockGrant: { writerId: crypto.randomUUID(), quantity: 5 },
  })
  const order = createCheckoutSparkEventMarketFixtureOrder(f, buyer())
  expect(classifyEventMarketOrderHandoff(order)).toBe(
    "reserved_organizer_stock"
  )
})

it("does not fall back to a legacy release when a marker is malformed, mixed or bound to different sources", () => {
  const f = checkoutSparkEventMarketFixture({
    mode: "organizer_handoff",
    stockGrant: { writerId: crypto.randomUUID(), quantity: 5 },
  })
  const base = createCheckoutSparkEventMarketFixtureOrder(f, buyer())
  for (const tags of [
    [...f.events.assignment.tags, ["conduit_stock_pool", "99"]],
    f.events.assignment.tags.map((tag) =>
      tag[0] === "conduit_stock_pool" ? ["conduit_stock_pool", "1"] : tag
    ),
  ]) {
    const signedEvent = f.signMerchant({ ...f.events.assignment, tags })
    const order = structuredClone(base)
    const fulfillment = order.items[0]!.fulfillment!
    if (fulfillment.type !== "event_market_pickup")
      throw new Error("Expected event fixture")
    fulfillment.occurrenceAssignment = {
      ...fulfillment.occurrenceAssignment!,
      signedEvent,
      eventId: signedEvent.id,
    }
    expect(classifyEventMarketOrderHandoff(order)).toBe(
      "stock_reconciliation_required"
    )
  }
  const mixed = structuredClone(base)
  mixed.items.push(legacyOrder().items[0]!)
  expect(classifyEventMarketOrderHandoff(mixed)).toBe(
    "stock_reconciliation_required"
  )
  const different = structuredClone(base)
  const pickup = different.items[0]!.fulfillment!
  if (pickup.type !== "event_market_pickup")
    throw new Error("Expected event fixture")
  pickup.product.coordinate += "-other"
  expect(classifyEventMarketOrderHandoff(different)).toBe(
    "stock_reconciliation_required"
  )
})
