import { describe, expect, it } from "bun:test"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import {
  getCartCostSummary,
  getCartFulfillmentLane,
  getMixedFulfillmentBlockingMessage,
  isSameCartFulfillment,
  isSameCartLineFulfillment,
  type CartItem,
  type CartEventMarketPickupFulfillment,
} from "../apps/market/src/lib/cart-model"
import {
  bindCartItemsToFreshProductPricing,
  buildCheckoutPricingIntent,
} from "../apps/market/src/lib/checkout-payment"
import {
  validateGuestPickupContactFields,
  validatePickupContactFields,
  type ShippingFormState,
} from "../apps/market/src/lib/checkout-validation"
import {
  buildOrderTimeline,
  buildOrderViewModel,
} from "../apps/market/src/lib/order-view"
import { orderSchema, type OrderLifecycle, type Product } from "@conduit/core"

function pickup(event = "market-a"): CartEventMarketPickupFulfillment {
  return createEventMarketOrderFixture({ dTag: event, price: 2_000 })
    .fulfillment
}

function item(overrides: Partial<CartItem> = {}): CartItem {
  const fixture = createEventMarketOrderFixture({
    dTag: "market-a",
    price: overrides.price ?? 2_000,
  })
  const terms = fixture.order.items[0]!
  return {
    productId: terms.productId,
    merchantPubkey: fixture.merchant,
    title: "Coffee",
    price: terms.priceAtPurchase,
    priceSats: terms.priceAtPurchase,
    currency: "SATS",
    sourcePrice: terms.sourcePrice,
    format: "physical",
    fulfillment: fixture.fulfillment,
    shippingCostSats: 0,
    quantity: 1,
    ...overrides,
  }
}

function signedProduct(overrides: Partial<Product> = {}): Product {
  const fixture = createEventMarketOrderFixture({
    dTag: "market-a",
    price: overrides.price ?? 2_000,
  })
  return {
    id: fixture.fulfillment.product.coordinate,
    pubkey: fixture.merchant,
    title: "Coffee",
    price: 2_000,
    priceSats: 2_000,
    currency: "SATS",
    sourcePrice: fixture.order.items[0]!.sourcePrice,
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 101_000,
    updatedAt: 101_000,
    ...overrides,
  }
}

function contact(
  overrides: Partial<ShippingFormState> = {}
): ShippingFormState {
  return {
    firstName: "",
    lastName: "",
    line2: "",
    name: "",
    street: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    phone: "",
    email: "",
    ...overrides,
  }
}

describe("Market event pickup fulfillment", () => {
  it("classifies pickup independently from destination shipping and blocks a mixed lane", () => {
    const pickupItem = item()
    const shippedItem = item({
      productId: `30402:${"e".repeat(64)}:mug`,
      fulfillment: { type: "shipping" },
    })

    expect(getCartFulfillmentLane([pickupItem])).toBe("pickup")
    expect(getCartFulfillmentLane([pickupItem, shippedItem])).toBe(
      "mixed_shipping_pickup"
    )
    expect(
      getMixedFulfillmentBlockingMessage([pickupItem, shippedItem])
    ).toContain("separate orders")
  })

  it("blocks pickup lines from different exact Event Market terms before checkout", () => {
    const first = item()
    const second = createEventMarketOrderFixture({
      dTag: "market-a",
      productDTag: "market-a-tea",
      price: 2_000,
    }).fulfillment
    const sameMarket = item({
      productId: second.product.coordinate,
      fulfillment: second,
    })
    const digital = item({
      productId: `30402:${second.merchantPubkey}:guide`,
      format: "digital",
      fulfillment: { type: "digital" },
      shippingCostSats: undefined,
    })
    expect(
      getMixedFulfillmentBlockingMessage([first, sameMarket, digital])
    ).toBeNull()
    for (const fulfillment of [
      pickup("market-b"),
      createEventMarketOrderFixture({
        dTag: "market-a",
        calendarDTag: "other-date",
        price: 2_000,
      }).fulfillment,
      createEventMarketOrderFixture({
        dTag: "market-a",
        assignment: "Other organizer table",
        price: 2_000,
      }).fulfillment,
    ]) {
      expect(
        getMixedFulfillmentBlockingMessage([
          first,
          item({ productId: fulfillment.product.coordinate, fulfillment }),
        ])
      ).toContain(
        fulfillment.market.coordinate !== pickup().market.coordinate ||
          fulfillment.calendar.coordinate !== pickup().calendar.coordinate
          ? "separate orders"
          : "Review"
      )
    }
  })

  it("blocks one merchant order when signed pickup handlers differ", () => {
    const merchantPickup = createEventMarketOrderFixture({
      dTag: "market-a",
      mode: "merchant_present",
      assignment: "Booth 12",
      price: 2_000,
    }).fulfillment
    expect(
      getMixedFulfillmentBlockingMessage([
        item(),
        item({ fulfillment: merchantPickup }),
      ])
    ).toContain("Review")
  })

  it("keeps dates separate and signed product or roster revisions distinct as cart lines", () => {
    const existing = item()
    const otherDate = item({
      fulfillment: createEventMarketOrderFixture({
        dTag: "market-a",
        calendarDTag: "other-date",
        price: 2_000,
      }).fulfillment,
    })
    const changedAssignment = item({
      fulfillment: createEventMarketOrderFixture({
        dTag: "market-a",
        assignment: "Other organizer table",
        price: 2_000,
      }).fulfillment,
    })
    const newerProduct = item({
      fulfillment: createEventMarketOrderFixture({
        dTag: "market-a",
        productCreatedAt: 199,
        price: 2_000,
      }).fulfillment,
    })
    const shipped = item({ fulfillment: { type: "shipping" } })
    expect(isSameCartFulfillment(existing, otherDate)).toBe(false)
    expect(isSameCartFulfillment(existing, changedAssignment)).toBe(true)
    expect(isSameCartFulfillment(existing, newerProduct)).toBe(true)
    for (const other of [otherDate, changedAssignment, newerProduct, shipped])
      expect(isSameCartLineFulfillment(existing, other)).toBe(false)
    expect(isSameCartLineFulfillment(existing, item())).toBe(true)
    expect(
      getMixedFulfillmentBlockingMessage([existing, changedAssignment])
    ).toContain("Review")
  })

  it("treats a signed zero-cost pickup as resolved checkout cost", () => {
    const summary = getCartCostSummary([item()])
    const pricing = buildCheckoutPricingIntent([item()], null)

    expect(summary.shippingReadyForZap).toBe(true)
    expect(summary.shippingTotalSats).toBe(0)
    expect(summary.totalSats).toBe(2_000)
    expect(pricing).toMatchObject({
      status: "ok",
      totalSats: 2_000,
      shippingCost: { status: "included", totalSats: 0 },
      items: [
        {
          fulfillment: {
            type: "event_market_pickup",
            assignment: "Organizer table",
          },
        },
      ],
    })
  })

  it("binds exact pickup cart pricing to the fresh signed product", () => {
    const binding = bindCartItemsToFreshProductPricing(
      [item()],
      [signedProduct()]
    )

    expect(binding.status).toBe("ok")
    if (binding.status !== "ok") return
    const intent = buildCheckoutPricingIntent(binding.items, null)
    expect(intent).toMatchObject({
      status: "ok",
      itemSubtotalSats: 2_000,
      totalSats: 2_000,
    })
  })

  it("builds an order-only zero-cost intent from exact signed pickup pricing", () => {
    const zeroSource = {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    }
    const zeroItem = item({
      price: 0,
      priceSats: 0,
      sourcePrice: zeroSource,
    })
    const binding = bindCartItemsToFreshProductPricing(
      [zeroItem],
      [
        signedProduct({
          price: 0,
          priceSats: 0,
          sourcePrice: zeroSource,
        }),
      ]
    )

    expect(binding.status).toBe("ok")
    if (binding.status !== "ok") return
    expect(getCartCostSummary(binding.items)).toMatchObject({
      itemPricesAvailable: true,
      itemSubtotalSats: 0,
      shippingTotalSats: 0,
      totalSats: 0,
      shippingReadyForZap: true,
    })
    const intent = buildCheckoutPricingIntent(binding.items, null)
    expect(intent).toMatchObject({
      status: "ok",
      itemSubtotalSats: 0,
      totalSats: 0,
      totalMsats: 0,
      paymentRequired: false,
      items: [{ priceAtPurchase: 0 }],
      shippingCost: { status: "included", totalSats: 0 },
    })
    if (intent.status !== "ok") return
    expect(
      orderSchema.parse({
        id: "zero-cost-order",
        merchantPubkey: zeroItem.merchantPubkey,
        buyerPubkey: "f".repeat(64),
        buyerIdentityKind: "guest_ephemeral",
        items: intent.items,
        subtotal: intent.totalSats,
        currency: "SATS",
        shippingCostSats: intent.shippingCost.totalSats,
        shippingCostStatus: intent.shippingCost.status,
        guestContact: {
          email: "buyer@example.com",
          phone: "+18005551234",
        },
        createdAt: 1_700_000_000_000,
      }).subtotal
    ).toBe(0)
  })

  it("does not widen zero-cost authorization beyond canonical pickup evidence", () => {
    const source = {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    }
    const zeroPickup = item({
      price: 0,
      priceSats: 0,
      sourcePrice: source,
    })
    const invalidItems = [
      {
        ...zeroPickup,
        format: "digital" as const,
        fulfillment: { type: "digital" as const },
        shippingOptionId: undefined,
        shippingCostSats: undefined,
        sourceShippingCost: undefined,
      },
      {
        ...zeroPickup,
        fulfillment: { type: "shipping" as const },
      },
      { ...zeroPickup, priceSats: undefined },
      { ...zeroPickup, sourcePrice: undefined },
      { ...zeroPickup, price: 1 },
      {
        ...zeroPickup,
        sourcePrice: { ...source, amount: 1 },
      },
      {
        ...zeroPickup,
        currency: "USD",
        sourcePrice: {
          amount: 0,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
      {
        ...zeroPickup,
        currency: "POINTS",
        sourcePrice: {
          amount: 0,
          currency: "POINTS",
          normalizedCurrency: "POINTS",
        },
      },
      { ...zeroPickup, price: -1, priceSats: undefined },
    ]

    for (const invalid of invalidItems) {
      expect(buildCheckoutPricingIntent([invalid], null)).toMatchObject({
        status: "error",
        code: "unpriced_items",
      })
    }
  })

  it("blocks checkout payment when fresh signed product price evidence conflicts", () => {
    expect(
      bindCartItemsToFreshProductPricing(
        [item()],
        [signedProduct({ priceEvidenceMalformed: true })]
      )
    ).toMatchObject({
      status: "error",
      code: "pricing_mismatch",
      productId: item().productId,
    })
  })

  it("rejects a lowered pickup price even when event and pickup evidence remain exact", () => {
    const loweredSats = item({ price: 1, priceSats: 1 })
    const coordinatedSourceTamper = item({
      price: 1,
      priceSats: 1,
      sourcePrice: {
        amount: 1,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    })

    for (const cartItem of [loweredSats, coordinatedSourceTamper]) {
      expect(
        bindCartItemsToFreshProductPricing([cartItem], [signedProduct()])
      ).toMatchObject({
        status: "error",
        code: "pricing_mismatch",
        productId: cartItem.productId,
      })
    }
  })

  it("skips signed-in pickup contact and requires one guest contact method", () => {
    expect(validatePickupContactFields(contact())).toEqual([])

    const missing = validateGuestPickupContactFields(contact())
    expect(missing.map((error) => error.field)).toEqual(["email"])

    expect(
      validateGuestPickupContactFields(
        contact({ email: "buyer@example.com" })
      ).map((error) => error.field)
    ).toEqual([])
    expect(
      validateGuestPickupContactFields(contact({ phone: "+14155552671" })).map(
        (error) => error.field
      )
    ).toEqual([])
    expect(
      validateGuestPickupContactFields(
        contact({
          phone: "+14155552671",
          email: "buyer@example.com",
        })
      )
    ).toEqual([])
  })

  it("restores pickup provenance into Orders without presenting shipment", () => {
    const pickupItem = item()
    const lifecycle = {
      orderId: "order-pickup",
      buyerPubkey: "buyer",
      merchantPubkey: pickupItem.merchantPubkey,
      checkoutMode: "private_checkout",
      items: [
        {
          productId: pickupItem.productId,
          title: pickupItem.title,
          format: "physical",
          quantity: 1,
          priceAtPurchase: 2_000,
          currency: "SATS",
          fulfillment: pickupItem.fulfillment,
        },
      ],
      itemSubtotalSats: 2_000,
      shippingCostSats: 0,
      totalSats: 2_000,
      totalMsats: 2_000_000,
      currency: "SATS",
      addressValidity: "not_required",
      shippingZoneEligibility: "not_required",
      orderDeliveryStatus: "sent",
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "sent",
      zapReceiptStatus: "not_applicable",
      phase: "in_progress",
      createdAt: 100,
      updatedAt: 100,
    } as OrderLifecycle
    const vm = buildOrderViewModel({
      orderId: lifecycle.orderId,
      lifecycle,
    })

    expect(vm.requiresShipping).toBe(false)
    expect(vm.requiresPickup).toBe(true)
    expect(vm.futureMarketFulfillments[0]?.assignment).toBe("Organizer table")
    expect(vm.futureMarketFulfillments[0]?.product.eventId).toBe(
      pickup().product.eventId
    )
    expect(buildOrderTimeline(vm).map((row) => row.key)).toContain(
      "fulfillment"
    )
    expect(
      buildOrderTimeline(vm).find((row) => row.key === "fulfillment")?.title
    ).toBe("Pickup from event organizer")
  })
})
