import { describe, expect, it } from "bun:test"
import {
  extractOrderSummary,
  orderSchema,
  orderPickupFulfillmentSchema,
  resolveOrderPickupHandoffAuthority,
  type OrderPickupFulfillmentSchema,
  type ParsedOrderMessage,
} from "@conduit/core"

const ORGANIZER = "1".repeat(64)
const MERCHANT = "2".repeat(64)
const BUYER = "3".repeat(64)
const OTHER_MERCHANT = "4".repeat(64)

function pickupFulfillment(): OrderPickupFulfillmentSchema {
  return {
    type: "pickup" as const,
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: `30402:${MERCHANT}:coffee`,
      eventId: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      merchantPubkey: MERCHANT,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:market-day`,
      eventId: "b".repeat(64),
      createdAt: 1_700_000_001_000,
    },
    collection: {
      coordinate: `30405:${ORGANIZER}:market-catalog`,
      eventId: "c".repeat(64),
      createdAt: 1_700_000_002_000,
    },
    option: {
      coordinate: `30406:${ORGANIZER}:market-pickup`,
      eventId: "d".repeat(64),
      createdAt: 1_700_000_003_000,
      title: "Event pickup",
      location: "Public market hall",
    },
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
  }
}

function pickupOrder() {
  return {
    id: "order-1",
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in" as const,
    items: [
      {
        productId: `30402:${MERCHANT}:coffee`,
        title: "Coffee",
        format: "physical" as const,
        fulfillment: pickupFulfillment(),
        quantity: 1,
        priceAtPurchase: 2_000,
        currency: "SATS",
        shippingOptionId: `30406:${ORGANIZER}:market-pickup`,
        shippingOptionDTag: "market-pickup",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
    ],
    subtotal: 2_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "included" as const,
    createdAt: 1_700_000_004_000,
  }
}

function additionalPickupItem(
  fulfillment: OrderPickupFulfillmentSchema = pickupFulfillment()
) {
  const productId = `30402:${MERCHANT}:tea`
  return {
    productId,
    title: "Tea",
    format: "physical" as const,
    fulfillment: {
      ...fulfillment,
      product: {
        ...fulfillment.product,
        coordinate: productId,
        eventId: "e".repeat(64),
      },
    },
    quantity: 1,
    priceAtPurchase: 1_000,
    currency: "SATS",
    shippingOptionId: fulfillment.option.coordinate,
    shippingOptionDTag: fulfillment.option.coordinate.split(":")[2],
    shippingCostSats: fulfillment.costSats,
    sourceShippingCost: { ...fulfillment.sourceCost },
  }
}

describe("pickup order fulfillment evidence", () => {
  it("preserves an organizer's own merchant-pickup snapshot across cart/order parsing", () => {
    const fulfillment = pickupFulfillment()
    const ownPickup = {
      ...fulfillment,
      product: {
        ...fulfillment.product,
        merchantPubkey: ORGANIZER,
        coordinate: `30402:${ORGANIZER}:own-coffee`,
      },
      handoffMode: "merchant_handoff" as const,
      handlerPubkey: ORGANIZER,
    }
    expect(orderPickupFulfillmentSchema.safeParse(ownPickup).success).toBe(true)
    expect(
      orderPickupFulfillmentSchema.safeParse({
        ...ownPickup,
        handoffMode: "organizer_handoff",
      }).success
    ).toBe(true)
    expect(resolveOrderPickupHandoffAuthority(ownPickup).mode).toBe(
      "merchant_handoff"
    )
  })
  it("derives explicit handoff authority and keeps legacy snapshots merchant-only", () => {
    const legacy = pickupFulfillment()
    expect(resolveOrderPickupHandoffAuthority(legacy)).toEqual({
      mode: "merchant_handoff",
      handlerPubkey: MERCHANT,
      legacySafeDefault: true,
    })

    const organizer = pickupFulfillment()
    organizer.handoffMode = "organizer_handoff"
    organizer.handlerPubkey = ORGANIZER
    expect(
      orderSchema.safeParse({
        ...pickupOrder(),
        items: [{ ...pickupOrder().items[0]!, fulfillment: organizer }],
      }).success
    ).toBe(true)
    expect(resolveOrderPickupHandoffAuthority(organizer)).toEqual({
      mode: "organizer_handoff",
      handlerPubkey: ORGANIZER,
      legacySafeDefault: false,
    })

    organizer.handoffMode = "merchant_handoff"
    organizer.handlerPubkey = MERCHANT
    expect(
      orderSchema.safeParse({
        ...pickupOrder(),
        items: [{ ...pickupOrder().items[0]!, fulfillment: organizer }],
      }).success
    ).toBe(false)
  })

  it("accepts a merchant-authored booth pickup only as merchant handoff", () => {
    const fulfillment = pickupFulfillment()
    fulfillment.option.coordinate = `30406:${MERCHANT}:merchant-booth`
    fulfillment.handoffMode = "merchant_handoff"
    fulfillment.handlerPubkey = MERCHANT
    const order = pickupOrder()
    order.items[0]!.fulfillment = fulfillment
    order.items[0]!.shippingOptionId = fulfillment.option.coordinate
    order.items[0]!.shippingOptionDTag = "merchant-booth"

    expect(orderSchema.safeParse(order).success).toBe(true)
    fulfillment.handoffMode = "organizer_handoff"
    fulfillment.handlerPubkey = ORGANIZER
    expect(orderSchema.safeParse(order).success).toBe(false)
  })

  it("preserves the exact signed graph without requiring a delivery address", () => {
    const parsed = orderSchema.parse(pickupOrder())

    expect(parsed.shippingAddress).toBeUndefined()
    expect(parsed.items[0]?.fulfillment).toEqual(pickupFulfillment())
  })

  it("requires one merchant-only recovery method for guest pickup", () => {
    const missing = {
      ...pickupOrder(),
      buyerIdentityKind: "guest_ephemeral" as const,
    }
    expect(orderSchema.safeParse(missing).success).toBe(false)
    expect(
      orderSchema.safeParse({
        ...missing,
        guestContact: { email: "buyer@example.test" },
      }).success
    ).toBe(true)
    expect(
      orderSchema.safeParse({
        ...missing,
        guestContact: { phone: "+15555550123" },
      }).success
    ).toBe(true)
  })

  it("fails closed when a pickup coordinate does not belong to the organizer", () => {
    const order = pickupOrder()
    order.items[0]!.fulfillment.option.coordinate = `30406:${MERCHANT}:forged-pickup`

    expect(orderSchema.safeParse(order).success).toBe(false)
  })

  it("requires deterministic pickup cost evidence", () => {
    const order = pickupOrder()
    delete order.items[0]!.fulfillment.costSats
    delete order.items[0]!.fulfillment.sourceCost
    delete order.items[0]!.shippingCostSats

    expect(orderSchema.safeParse(order).success).toBe(false)
  })

  it("rejects tampered outer pickup identity and source-cost fields", () => {
    const mutations: Array<
      [string, (item: ReturnType<typeof pickupOrder>["items"][number]) => void]
    > = [
      [
        "option",
        (item) => (item.shippingOptionId = `30406:${ORGANIZER}:other-pickup`),
      ],
      ["option d tag", (item) => (item.shippingOptionDTag = "other-pickup")],
      ["sats cost", (item) => (item.shippingCostSats = 1)],
      ["source amount", (item) => (item.sourceShippingCost!.amount = 1)],
      [
        "raw source currency",
        (item) => (item.sourceShippingCost!.currency = "sat"),
      ],
      [
        "normalized source currency",
        (item) => (item.sourceShippingCost!.normalizedCurrency = "BTC"),
      ],
    ]

    for (const [field, mutate] of mutations) {
      const order = pickupOrder()
      mutate(order.items[0]!)
      expect({ field, success: orderSchema.safeParse(order).success }).toEqual({
        field,
        success: false,
      })
    }
  })

  it("binds the pickup product merchant to the order recipient", () => {
    const order = pickupOrder()
    const otherProduct = `30402:${OTHER_MERCHANT}:coffee`
    order.items[0]!.productId = otherProduct
    order.items[0]!.fulfillment.product.coordinate = otherProduct
    order.items[0]!.fulfillment.product.merchantPubkey = OTHER_MERCHANT

    expect(orderSchema.safeParse(order).success).toBe(false)
  })

  it("rejects mismatched product identity, delivery addresses, and mixed shipping", () => {
    const mismatchedProduct = pickupOrder()
    mismatchedProduct.items[0]!.fulfillment.product.coordinate = `30402:${MERCHANT}:different-product`
    expect(orderSchema.safeParse(mismatchedProduct).success).toBe(false)

    const withAddress = {
      ...pickupOrder(),
      shippingAddress: {
        name: "Private buyer",
        street: "1 Private Road",
        city: "Private City",
        postalCode: "00000",
        country: "US",
      },
    }
    expect(orderSchema.safeParse(withAddress).success).toBe(false)

    const mixed = pickupOrder()
    mixed.items.push({
      productId: `30402:${MERCHANT}:shipped`,
      title: "Shipped item",
      format: "physical",
      fulfillment: { type: "shipping" },
      quantity: 1,
      priceAtPurchase: 100,
      currency: "SATS",
      shippingOptionId: `30406:${MERCHANT}:standard`,
      shippingCostSats: 0,
    } as (typeof mixed.items)[number])
    expect(orderSchema.safeParse(mixed).success).toBe(false)
  })

  it("requires one exact organizer event graph across all pickup items", () => {
    const compatible = pickupOrder()
    const extraCostPickup = pickupFulfillment()
    extraCostPickup.costSats = 250
    extraCostPickup.sourceCost.amount = 250
    compatible.items.push(
      additionalPickupItem(extraCostPickup) as (typeof compatible.items)[number]
    )
    compatible.items.push({
      productId: `30402:${MERCHANT}:digital-guide`,
      title: "Digital guide",
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 500,
      currency: "SATS",
    } as (typeof compatible.items)[number])
    expect(orderSchema.safeParse(compatible).success).toBe(true)

    const graphMutations: Array<
      (fulfillment: OrderPickupFulfillmentSchema) => void
    > = [
      (fulfillment) => {
        const otherOrganizer = "5".repeat(64)
        fulfillment.organizerPubkey = otherOrganizer
        fulfillment.calendar.coordinate = `31923:${otherOrganizer}:market-day`
        fulfillment.collection.coordinate = `30405:${otherOrganizer}:market-catalog`
        fulfillment.option.coordinate = `30406:${otherOrganizer}:market-pickup`
      },
      (fulfillment) => {
        fulfillment.calendar.coordinate = `31923:${ORGANIZER}:other-market-day`
      },
      (fulfillment) => {
        fulfillment.collection.coordinate = `30405:${ORGANIZER}:other-market-catalog`
      },
      (fulfillment) => {
        fulfillment.option.coordinate = `30406:${ORGANIZER}:other-market-pickup`
      },
      (fulfillment) => {
        fulfillment.option.eventId = "f".repeat(64)
      },
    ]

    for (const mutate of graphMutations) {
      const conflicting = pickupOrder()
      const fulfillment = pickupFulfillment()
      mutate(fulfillment)
      conflicting.items.push(
        additionalPickupItem(fulfillment) as (typeof conflicting.items)[number]
      )
      expect(orderSchema.safeParse(conflicting).success).toBe(false)
    }
  })

  it("preserves pickup evidence in merchant order summaries", () => {
    const payload = orderSchema.parse(pickupOrder())
    const message: ParsedOrderMessage = {
      id: "message-1",
      orderId: payload.id,
      type: "order",
      createdAt: payload.createdAt,
      senderPubkey: BUYER,
      recipientPubkey: MERCHANT,
      rawContent: "",
      payload,
    }

    const summary = extractOrderSummary([message])
    expect(summary.items[0]?.fulfillment).toEqual(pickupFulfillment())
    expect(summary.shippingAddress).toBeNull()
  })
})
