import { expect, it } from "bun:test"
import { orderEventMarketPickupFulfillmentSchema } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { createEventMarketCheckoutFixture } from "./helpers/event-market-checkout-fixture"

type Fixture = Awaited<ReturnType<typeof createEventMarketCheckoutFixture>>

async function authorize(source: Fixture) {
  return authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [source.item],
    rawItems: [source.item],
    refreshedProducts: [source.product],
    readShippingOptions: async () => {
      throw new Error("Event Market pickup does not use a shipping option")
    },
    authorizePickupHandlers: async () => undefined,
    futureEventMarketDependencies: source.futureEventMarketDependencies,
  })
}

it("carries the exact current signed pickup snapshot through submit and quote freezing", async () => {
  const source = await createEventMarketCheckoutFixture()
  const authorization = await authorize(source)
  if (authorization.status !== "ok") throw new Error("Expected authorization")
  const fulfillment = authorization.items[0]!.fulfillment
  if (fulfillment?.type !== "event_market_pickup")
    throw new Error("Expected current Event Market snapshot")
  expect(fulfillment).toEqual(source.fulfillment)
  const publicEvents = JSON.parse(JSON.stringify(source.events))
  expect(fulfillment.market.signedEvent).toEqual(publicEvents[0])
  expect(fulfillment.calendar.signedEvent).toEqual(publicEvents[1])
  expect(fulfillment.grant.signedEvidence.tip).toEqual(publicEvents[2])
  expect(fulfillment.product.signedEvent).toEqual(publicEvents[3])
  // Current Event Market authority is embedded in the immutable fulfillment,
  // not the retired generic pickup graph side channel.
  expect(authorization.pickupSourceEvents).toBeUndefined()
  const quote = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: null,
  })
  const commerce = buildCheckoutSparkCommerceEvidence(quote)
  expect(quote.pricing.items[0]!.fulfillment).toEqual(fulfillment)
  expect(commerce.lines[0]).toMatchObject({
    productCoordinate: source.product.id,
    productEventId: source.product.sourceEventId,
    merchantPubkey: source.merchant,
    unitShippingSats: 0,
  })
  expect(commerce.lines[0]?.pickup).toBeUndefined()
  expect(commerce.lines[0]?.shippingOption).toBeUndefined()
  expect(quote.pickupSourceEvents).toBeUndefined()

  const frozen = JSON.stringify(quote)
  fulfillment.market.signedEvent.tags[0]![1] = "changed-authorized-source"
  source.events[1]!.tags[0]![1] = "changed-live-source"
  expect(JSON.stringify(quote)).toBe(frozen)
  const quoted = quote.pricing.items[0]!.fulfillment
  if (quoted?.type !== "event_market_pickup")
    throw new Error("Missing frozen snapshot")
  expect(Object.isFrozen(quoted.market.signedEvent.tags[0])).toBe(true)
})

it("retains only canonical signed public fields from annotated relay source objects", async () => {
  const source = await createEventMarketCheckoutFixture()
  for (const event of source.events) {
    Object.assign(event, {
      buyerContact: { email: "private-fixture@example.test" },
      note: "Private unsigned annotation",
    })
  }
  const authorization = await authorize(source)
  if (authorization.status !== "ok") throw new Error("Expected authorization")
  const fulfillment = authorization.items[0]!.fulfillment
  if (fulfillment?.type !== "event_market_pickup")
    throw new Error("Missing current snapshot")
  const signed = [
    fulfillment.market.signedEvent,
    fulfillment.calendar.signedEvent,
    fulfillment.product.signedEvent,
    fulfillment.grant.signedEvidence.tip,
    ...fulfillment.grant.signedEvidence.ancestry,
  ]
  for (const event of signed) {
    expect(Object.keys(event).sort().join(",")).toBe(
      "content,created_at,id,kind,pubkey,sig,tags"
    )
  }
  const quote = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: null,
  })
  expect(JSON.stringify(quote)).not.toContain("private-fixture")
  expect(JSON.stringify(quote)).not.toContain("Private unsigned annotation")
})

it.each([30409, 31923, 3841, 30402])(
  "does not promote missing current signed kind %s into checkout authority",
  async (kind) => {
    const source = await createEventMarketCheckoutFixture()
    source.events.splice(
      source.events.findIndex((event) => event.kind === kind),
      1
    )
    expect(await authorize(source)).toEqual({ status: "changed" })
  }
)

it.each(["invalid_signature", "different_revision"] as const)(
  "rejects a %s calendar snapshot before router quote authority",
  async (reason) => {
    const source = await createEventMarketCheckoutFixture()
    const authorization = await authorize(source)
    if (authorization.status !== "ok") throw new Error("Expected authorization")
    const fulfillment = authorization.items[0]!.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing current snapshot")
    if (reason === "invalid_signature") {
      fulfillment.calendar.signedEvent.sig = "0".repeat(128)
    } else {
      fulfillment.calendar.eventId = "0".repeat(64)
    }
    expect(
      orderEventMarketPickupFulfillmentSchema.safeParse(fulfillment).success
    ).toBe(false)
    expect(() =>
      buildCheckoutSparkQuoteAuthority({ authorization, rateInput: null })
    ).toThrow("Current signed checkout evidence changed")
  }
)
