import { describe, expect, it } from "bun:test"
import {
  addCartItem,
  getCartCostSummary,
  getCartFulfillmentLane,
  getMixedFulfillmentBlockingMessage,
  isSameCartFulfillment,
  type CartItem,
  type CartPickupFulfillment,
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

function pickup(event = "market-a"): CartPickupFulfillment {
  return {
    type: "pickup",
    organizerPubkey: "a".repeat(64),
    product: {
      coordinate: `30402:${"e".repeat(64)}:coffee`,
      eventId: "f".repeat(64),
      createdAt: 99,
      merchantPubkey: "e".repeat(64),
    },
    calendar: {
      coordinate: `31923:${"a".repeat(64)}:${event}`,
      eventId: "b".repeat(64),
      createdAt: 100,
    },
    collection: {
      coordinate: `30405:${"a".repeat(64)}:${event}`,
      eventId: "c".repeat(64),
      createdAt: 101,
    },
    option: {
      coordinate: `30406:${"a".repeat(64)}:${event}-pickup`,
      eventId: "d".repeat(64),
      createdAt: 102,
      title: "Event pickup",
      location: "Public hall entrance",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: "a".repeat(64),
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
  }
}

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: `30402:${"e".repeat(64)}:coffee`,
    merchantPubkey: "e".repeat(64),
    title: "Coffee",
    price: 2_000,
    priceSats: 2_000,
    currency: "SATS",
    sourcePrice: {
      amount: 2_000,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    format: "physical",
    fulfillment: pickup(),
    shippingOptionId: pickup().option.coordinate,
    shippingCostSats: 0,
    sourceShippingCost: pickup().sourceCost,
    quantity: 1,
    ...overrides,
  }
}

function signedProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: `30402:${"e".repeat(64)}:coffee`,
    pubkey: "e".repeat(64),
    title: "Coffee",
    price: 2_000,
    priceSats: 2_000,
    currency: "SATS",
    sourcePrice: {
      amount: 2_000,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 99,
    updatedAt: 99,
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

  it("blocks pickup lines from different organizer event graphs before checkout", () => {
    const first = item()
    const secondProductId = `30402:${"e".repeat(64)}:tea`
    const sameGraphFulfillment: CartPickupFulfillment = {
      ...pickup(),
      product: {
        ...pickup().product,
        coordinate: secondProductId,
        eventId: "1".repeat(64),
      },
      costSats: 250,
      sourceCost: {
        amount: 250,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    }
    const sameGraph = item({
      productId: secondProductId,
      title: "Tea",
      fulfillment: sameGraphFulfillment,
      shippingOptionId: sameGraphFulfillment.option.coordinate,
      shippingCostSats: 250,
      sourceShippingCost: sameGraphFulfillment.sourceCost,
    })
    const digital = item({
      productId: `30402:${"e".repeat(64)}:guide`,
      format: "digital",
      fulfillment: { type: "digital" },
      shippingOptionId: undefined,
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
    })

    expect(
      getMixedFulfillmentBlockingMessage([first, sameGraph, digital])
    ).toBeNull()

    const differentGraphs: CartPickupFulfillment[] = [
      {
        ...sameGraphFulfillment,
        organizerPubkey: "b".repeat(64),
      },
      {
        ...sameGraphFulfillment,
        calendar: {
          ...sameGraphFulfillment.calendar,
          coordinate: `31923:${"a".repeat(64)}:another-market`,
        },
      },
      {
        ...sameGraphFulfillment,
        collection: {
          ...sameGraphFulfillment.collection,
          coordinate: `30405:${"a".repeat(64)}:another-catalog`,
        },
      },
      {
        ...sameGraphFulfillment,
        option: {
          ...sameGraphFulfillment.option,
          coordinate: `30406:${"a".repeat(64)}:another-pickup`,
        },
      },
      {
        ...sameGraphFulfillment,
        collection: {
          ...sameGraphFulfillment.collection,
          eventId: "9".repeat(64),
        },
      },
    ]

    for (const fulfillment of differentGraphs) {
      const conflicting = item({
        productId: secondProductId,
        fulfillment,
        shippingOptionId: fulfillment.option.coordinate,
        shippingCostSats: fulfillment.costSats,
      })
      expect(
        getMixedFulfillmentBlockingMessage([first, conflicting])
      ).toContain("separate orders")
    }
  })

  it("blocks one merchant order when pickup handlers differ", () => {
    const merchantHandoff: CartPickupFulfillment = {
      ...pickup(),
      option: {
        ...pickup().option,
        coordinate: `30406:${"e".repeat(64)}:merchant-booth`,
      },
      handoffMode: "merchant_handoff",
      handlerPubkey: "e".repeat(64),
    }
    const merchantItem = item({
      productId: `30402:${"e".repeat(64)}:merchant-item`,
      fulfillment: {
        ...merchantHandoff,
        product: {
          ...merchantHandoff.product,
          coordinate: `30402:${"e".repeat(64)}:merchant-item`,
        },
      },
      shippingOptionId: merchantHandoff.option.coordinate,
    })

    expect(
      getMixedFulfillmentBlockingMessage([item(), merchantItem])
    ).toContain("different pickup handlers")
  })

  it("never overwrites a product's snapshotted pickup identity", () => {
    const existing = item()
    const differentEvent = item({ fulfillment: pickup("market-b") })
    const differentRevision = item({
      fulfillment: {
        ...pickup(),
        collection: {
          ...pickup().collection,
          eventId: "9".repeat(64),
        },
      },
    })
    const shipped = item({ fulfillment: { type: "shipping" } })

    expect(isSameCartFulfillment(existing, differentEvent)).toBe(false)
    expect(isSameCartFulfillment(existing, differentRevision)).toBe(false)
    expect(addCartItem([existing], differentEvent)).toEqual([existing])
    expect(addCartItem([existing], differentRevision)).toEqual([existing])
    expect(addCartItem([existing], shipped)).toEqual([existing])
    expect(addCartItem([existing], item())[0]?.quantity).toBe(2)
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
            type: "pickup",
            option: { title: "Event pickup" },
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
      shippingOptionDTag: "market-a-pickup",
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
        merchantPubkey: "e".repeat(64),
        buyerPubkey: "f".repeat(64),
        buyerIdentityKind: "guest_ephemeral",
        items: intent.items,
        subtotal: intent.totalSats,
        currency: "SATS",
        shippingCostSats: intent.shippingCost.totalSats,
        shippingCostStatus: intent.shippingCost.status,
        guestContact: { email: "buyer@example.com" },
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

  it("skips signed-in pickup contact and requires only one guest recovery method", () => {
    expect(validatePickupContactFields(contact())).toEqual([])

    const missing = validateGuestPickupContactFields(contact())
    expect(missing.map((error) => error.field)).toEqual(["email"])

    expect(
      validateGuestPickupContactFields(
        contact({
          email: "buyer@example.com",
        })
      )
    ).toEqual([])
    expect(
      validateGuestPickupContactFields(
        contact({
          phone: "+14155552671",
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
    expect(vm.pickupFulfillments[0]?.option.location).toBe(
      "Public hall entrance"
    )
    expect(vm.pickupFulfillments[0]?.product.eventId).toBe("f".repeat(64))
    expect(buildOrderTimeline(vm).map((row) => row.key)).toContain(
      "fulfillment"
    )
    expect(
      buildOrderTimeline(vm).find((row) => row.key === "fulfillment")?.title
    ).toBe("Pickup from event organizer")
  })
})
