import { describe, expect, it } from "bun:test"
import {
  extractOrderSummary,
  orderSchema,
  orderItemFulfillmentSchema,
  orderMessageTypeSchema,
  parseOrderMessageRumorEvent,
  type ParsedOrderMessage,
} from "@conduit/core"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

const address = {
  name: "Buyer",
  street: "1 Public Road",
  city: "City",
  postalCode: "00000",
  country: "US",
}

describe("current signed Event Market order fulfillment", () => {
  it("preserves exact signed terms and merchant order summaries without a delivery address", () => {
    const { order, fulfillment, merchant, buyer } =
      createEventMarketOrderFixture()
    const parsed = orderSchema.parse(order)
    expect(parsed.shippingAddress).toBeUndefined()
    expect(parsed.items[0]?.fulfillment).toEqual(
      JSON.parse(JSON.stringify(fulfillment))
    )
    const message: ParsedOrderMessage = {
      id: "order-message",
      orderId: order.id,
      type: "order",
      createdAt: order.createdAt,
      senderPubkey: buyer,
      recipientPubkey: merchant,
      rawContent: JSON.stringify(order),
      payload: parsed,
    }
    const summary = extractOrderSummary([message])
    expect(summary.items[0]?.fulfillment).toEqual(
      JSON.parse(JSON.stringify(fulfillment))
    )
    expect(summary.shippingAddress).toBeNull()
  })

  it("requires one recovery contact for guest event pickup and both contacts for ordinary shipping", () => {
    const { order } = createEventMarketOrderFixture()
    const guest = { ...order, buyerIdentityKind: "guest_ephemeral" }
    expect(orderSchema.safeParse(guest).success).toBe(false)
    for (const guestContact of [
      { email: "buyer@example.test" },
      { phone: "+15555550123" },
    ]) {
      expect(orderSchema.safeParse({ ...guest, guestContact }).success).toBe(
        true
      )
    }
    const shipping = {
      ...guest,
      items: [{ ...order.items[0], fulfillment: { type: "shipping" } }],
      shippingAddress: address,
    }
    expect(
      orderSchema.safeParse({
        ...shipping,
        guestContact: { email: "buyer@example.test" },
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...shipping,
        guestContact: { email: "buyer@example.test", phone: "+15555550123" },
      }).success
    ).toBe(true)
  })

  it("rejects retired pickup snapshots and message types at parsing boundaries", () => {
    const { order } = createEventMarketOrderFixture()
    expect(
      orderItemFulfillmentSchema.safeParse({ type: "pickup" }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...order,
        items: [{ ...order.items[0], fulfillment: { type: "pickup" } }],
      }).success
    ).toBe(false)
    for (const type of [
      "organizer_fulfillment_receipt",
      "organizer_fulfillment_revocation",
      "organizer_handoff_ack",
    ]) {
      expect(orderMessageTypeSchema.safeParse(type).success).toBe(false)
      expect(() =>
        parseOrderMessageRumorEvent({
          id: "rumor",
          pubkey: order.merchantPubkey,
          created_at: 1,
          tags: [
            ["type", type],
            ["p", "a".repeat(64)],
            ["claim", "b".repeat(64)],
          ],
          content: JSON.stringify({ type }),
        })
      ).toThrow()
    }
  })

  it("keeps ordinary shipping and digital orders readable", () => {
    const { order } = createEventMarketOrderFixture()
    for (const format of ["physical", "digital"] as const) {
      const fulfillment = {
        type: format === "physical" ? "shipping" : "digital",
      }
      expect(
        orderSchema.safeParse({
          ...order,
          items: [{ ...order.items[0], format, fulfillment }],
          ...(format === "physical"
            ? {
                shippingAddress: address,
                shippingCostSats: 250,
                shippingCostStatus: "priced",
              }
            : {}),
        }).success
      ).toBe(true)
    }
  })

  it("rejects product, merchant, payee, fee, address, and mixed shipping tampering", () => {
    const { order } = createEventMarketOrderFixture()
    const fulfillment = order.items[0]!.fulfillment!
    for (const invalid of [
      { ...order, merchantPubkey: "a".repeat(64) },
      { ...order, shippingAddress: address },
      { ...order, shippingCostSats: 1 },
      {
        ...order,
        items: [
          {
            ...order.items[0],
            productId: `30402:${order.merchantPubkey}:other`,
          },
        ],
      },
      {
        ...order,
        items: [
          {
            ...order.items[0],
            shippingOptionId: `30406:${order.merchantPubkey}:shipping`,
          },
        ],
      },
      { ...order, items: [{ ...order.items[0], shippingCostSats: 1 }] },
      {
        ...order,
        items: [
          {
            ...order.items[0],
            fulfillment: { ...fulfillment, payeePubkey: "a".repeat(64) },
          },
        ],
      },
      {
        ...order,
        items: [
          ...order.items,
          { ...order.items[0], fulfillment: { type: "shipping" } },
        ],
      },
    ])
      expect(orderSchema.safeParse(invalid).success).toBe(false)
  })

  it("requires one exact signed event and admission across products while allowing digital extras", () => {
    const first = createEventMarketOrderFixture()
    const same = createEventMarketOrderFixture()
    expect(
      orderSchema.safeParse({
        ...first.order,
        items: [...first.order.items, ...same.order.items],
        subtotal: 200,
      }).success
    ).toBe(true)
    const otherDate = createEventMarketOrderFixture({ dTag: "other-date" })
    expect(
      orderSchema.safeParse({
        ...first.order,
        items: [...first.order.items, ...otherDate.order.items],
        subtotal: 200,
      }).success
    ).toBe(false)
    const digital = {
      ...first.order.items[0],
      format: "digital",
      fulfillment: { type: "digital" },
    }
    expect(
      orderSchema.safeParse({
        ...first.order,
        items: [...first.order.items, digital],
        subtotal: 200,
      }).success
    ).toBe(true)
  })
})
