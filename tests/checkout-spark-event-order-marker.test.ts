import { describe, expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  EVENT_KINDS,
  buildEventMarketOrderRumorTags,
  parseOrderMessageRumorEvent,
} from "@conduit/core"
import { assertMerchantCheckoutSparkDispatchPlan } from "../apps/merchant/src/lib/checkout-spark-recovery-policy"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

function fixture(commerceTotalSats = 1_000) {
  const graph = checkoutSparkEventMarketFixture({ commerceTotalSats })
  const order = {
    ...createCheckoutSparkEventMarketFixtureOrder(
      graph,
      graph.organizerPubkey,
      AT
    ),
    buyerIdentityKind: "signed_in" as const,
    shippingCostStatus: "included" as const,
  }
  const tags = [
    ["p", graph.merchantPubkey],
    ["type", "order"],
    ["order", order.id],
    ["amount", String(order.subtotal)],
    ["currency", "SATS"],
    ["item", order.items[0]!.productId, "1"],
    [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
    ...buildEventMarketOrderRumorTags(order),
  ]
  const rumor = (nextTags: string[][] = tags, payload = order) => {
    const value = {
      kind: EVENT_KINDS.ORDER,
      pubkey: graph.organizerPubkey,
      created_at: AT / 1_000,
      tags: nextTags,
      content: JSON.stringify(payload),
    }
    return { ...value, id: getEventHash(value) }
  }
  return { graph, order, tags, rumor }
}

describe("explicit v5 event router order marker", () => {
  it.each([1_000, 0])(
    "parses complete occurrence evidence for %s-sat commerce without shipping tags",
    (amount) => {
      const f = fixture(amount)
      const parsed = parseOrderMessageRumorEvent(f.rumor())
      expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
      expect(parsed.type === "order" && parsed.payload.subtotal).toBe(amount)
    }
  )

  it.each([1_000, 0])(
    "does not reinterpret an event order as historical/ordinary v1 (%s sats)",
    (amount) => {
      const f = fixture(amount)
      const tags = f.tags.map((tag) =>
        tag[0] === CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
          ? [...CHECKOUT_SPARK_ROUTER_ORDER_TAG]
          : tag
      )
      expect(() => parseOrderMessageRumorEvent(f.rumor(tags))).toThrow()
    }
  )

  it("rejects missing, duplicate, tampered and mixed event markers/evidence", () => {
    const f = fixture()
    const firstEvidence = f.tags.findIndex((tag) => tag[0] === "evidence")
    for (const tags of [
      [...f.tags, [...CHECKOUT_SPARK_ROUTER_ORDER_TAG]],
      [...f.tags, [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG]],
      f.tags.filter((_, index) => index !== firstEvidence),
      [...f.tags, f.tags[firstEvidence]!],
      f.tags.map((tag) =>
        tag[0] === "event_occurrence"
          ? [tag[0], tag[1]!, f.graph.events.market.id]
          : tag
      ),
      f.tags.map((tag) =>
        tag[0] === CHECKOUT_SPARK_ROUTER_ORDER_TAG[0] ? [...tag, "extra"] : tag
      ),
    ])
      expect(() => parseOrderMessageRumorEvent(f.rumor(tags))).toThrow()
  })

  it("does not authorize an ordinary zero-priced order through either router marker", () => {
    const f = fixture(0)
    const payload = {
      ...f.order,
      shippingCostStatus: "not_required" as const,
      items: f.order.items.map((item) => ({
        ...item,
        format: "digital" as const,
        fulfillment: { type: "digital" as const },
      })),
    }
    const base = f.tags.filter(
      (tag) =>
        ![
          "openmarkets",
          "event_market",
          "event_occurrence",
          "event_auth",
          "fulfillment",
          "event_assignment",
          "evidence",
          "conduit_checkout_payment",
        ].includes(tag[0]!)
    )
    for (const marker of [
      CHECKOUT_SPARK_ROUTER_ORDER_TAG,
      CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
    ]) {
      expect(() =>
        parseOrderMessageRumorEvent(f.rumor([...base, [...marker]], payload))
      ).toThrow()
    }
  })

  it("preserves Merchant financial fallback for the same organizer-handoff plan", () => {
    const f = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
    expect(f.plan.schemaVersion).toBe(5)
    const prior = process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
    process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS =
      f.plan.nativeTreasury!.sparkAddress
    try {
      expect(() =>
        assertMerchantCheckoutSparkDispatchPlan(f.plan, true)
      ).not.toThrow()
    } finally {
      if (prior === undefined)
        delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
      else process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = prior
    }
  })
})
