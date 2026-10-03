import { NDKEvent } from "@nostr-dev-kit/ndk"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildShippingPolicyEventDraft,
  extractOrderSummary,
  getMerchantShippingPolicyCoordinate,
  orderSchema,
  shippingPolicyQuoteSchema,
  parseProductEvent,
  parseShippingOptionEvent,
  parseOrderMessageRumorEvent,
  parseOrderRumorEvent,
  serializeOrderRumorContent,
  type OrderLifecycle,
  type BtcUsdRateQuote,
  type PricingRateInput,
  type ShippingPolicy,
  validateAddressConsistency,
} from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import {
  createCartItemFromProduct,
  getMixedFulfillmentBlockingMessage,
  parsePersistedCart,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import {
  getCartShippingDestinationEligibility,
  getCartShippingOptionCoordinates,
  getCartShippingOptionsAvailable,
  prepareCartFulfillment,
} from "../apps/market/src/lib/cart-shipping-options"
import { buildOrderViewModel } from "../apps/market/src/lib/order-view"

import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
const destination = { country: "US", subdivision: "WA", postalCode: "98101" }
const policy: ShippingPolicy = {
  version: 1,
  title: "Parcel shipping",
  originCountry: "US",
  currency: "SATS",
  weightAllowanceGrams: 100,
  handlingMinor: 1,
  domestic: {
    rules: [
      {
        country: "US",
        bands: [
          { maxWeightGrams: 1000, priceMinor: 6 },
          { maxWeightGrams: 3000, priceMinor: 10 },
        ],
      },
    ],
  },
  international: {
    rules: [
      { country: "CA", bands: [{ maxWeightGrams: 3000, priceMinor: 20 }] },
    ],
    freeShippingThresholdMinor: 5000,
  },
}
function option(revision = 1, changes: Partial<ShippingPolicy> = {}) {
  const event = finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({ policy: { ...policy, ...changes } }),
      created_at: revision,
    },
    secret
  )
  const parsed = parseShippingOptionEvent(new NDKEvent(undefined, event))
  if (!parsed) throw new Error("Signed policy fixture failed parsing")
  return {
    ...parsed,
    readSource: "relay" as const,
    readCoverage: "complete" as const,
  }
}
function product(
  name: string,
  weight: number | undefined = 300,
  format: "physical" | "digital" = "physical",
  owner = merchant,
  key = secret,
  shippingOptionId = getMerchantShippingPolicyCoordinate(owner)
) {
  const event = finalizeEvent(
    {
      kind: 30402,
      created_at: 2,
      content: "Synthetic listing",
      tags: [
        ["d", name],
        ["title", name],
        ["price", "100", "SATS"],
        ["type", "simple", format],
        ...(format === "physical"
          ? [["shipping_option", shippingOptionId]]
          : []),
        ...(weight === undefined ? [] : [["weight", String(weight), "g"]]),
        ["checkout_public_zaps", "true"],
        ["checkout_zap_message_policy", "generic_only"],
      ],
    },
    key
  )
  const parsed = parseProductEvent(new NDKEvent(undefined, event))
  if (!parsed) throw new Error("Signed product fixture failed parsing")
  return { ...parsed, sourceEventId: event.id }
}
function raw(
  name: string,
  quantity = 1,
  weight: number | undefined = 300
): CartItem {
  return { ...createCartItemFromProduct(product(name, weight)), quantity }
}
function priced(items: CartItem[], rateInput: PricingRateInput = null) {
  const result = buildCheckoutPricingIntent(items, rateInput)
  if (result.status !== "ok") throw new Error(result.reason)
  return result
}

function payload(
  items: ReturnType<typeof priced>["items"],
  shippingSats: number
) {
  return {
    id: "shipping-order",
    merchantPubkey: merchant,
    buyerPubkey: "b".repeat(64),
    items,
    subtotal: items.reduce(
      (sum, item) => sum + item.priceAtPurchase * item.quantity,
      shippingSats
    ),
    currency: "SATS",
    shippingCostSats: shippingSats,
    shippingCostStatus: "priced" as const,
    shippingAddress: {
      name: "Synthetic buyer",
      street: "1 Test Way",
      city: "Seattle",
      state: "WA",
      postalCode: "98101",
      country: "US",
    },
    createdAt: 2000,
  }
}

describe("signed shipping policy composed checkout", () => {
  it("keeps accepted region names aligned through pricing, authorization and order replay", async () => {
    const input = raw("region-name")
    const table = option(3, {
      domestic: {
        rules: [
          { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 500 }] },
          {
            country: "US",
            subdivision: "USCA",
            bands: [{ maxWeightGrams: 1000, priceMinor: 2000 }],
          },
        ],
      },
    })
    const address = {
      ...payload([], 0).shippingAddress,
      city: "San Francisco",
      state: "California",
      postalCode: "94103",
    }
    expect(validateAddressConsistency(address).canDirectPay).toBe(true)
    const destination = {
      country: "US",
      subdivision: address.state,
      postalCode: address.postalCode,
    }
    const reviewed = prepareCartFulfillment([input], [table], destination).items
    const coded = prepareCartFulfillment([input], [table], {
      ...destination,
      subdivision: "CA",
    }).items
    expect(reviewed[0]!.shippingPolicyQuote).toEqual(
      coded[0]!.shippingPolicyQuote
    )
    expect(priced(reviewed).shippingCost.totalSats).toBe(2001)
    expect(
      getCartShippingDestinationEligibility(destination, reviewed)
    ).toMatchObject({ eligible: true })
    const authorization = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      rawItems: [input],
      reviewedItems: reviewed,
      refreshedProducts: [product("region-name")],
      readShippingOptions: async () => [table],
      destination,
      resolveProductFulfillment: async (product) => ({
        status: "standard",
        type: "shipping",
        product,
      }),
      authorizePickupHandlers: async () => {},
    })
    expect(authorization.status).toBe("ok")
    const order = {
      ...payload(priced(reviewed).items, 2001),
      shippingAddress: address,
    }
    expect(orderSchema.safeParse(order).success).toBe(true)
    const recovered = parseOrderRumorEvent({
      content: serializeOrderRumorContent(order),
    })
    expect(recovered.items[0]!.shippingPolicyQuote).toEqual(
      reviewed[0]!.shippingPolicyQuote
    )
    expect(
      orderSchema.safeParse({
        ...order,
        shippingAddress: { ...address, state: "CA" },
      }).success
    ).toBe(true)
    expect(
      orderSchema.safeParse({
        ...order,
        shippingAddress: { ...address, state: "Washington" },
      }).success
    ).toBe(false)
  })
  it("charges one combined band and handling for two products and quantities, with integer allocations", () => {
    const prepared = prepareCartFulfillment(
      [raw("a", 2), raw("b")],
      [option()],
      destination
    )
    const checkout = priced(prepared.items)
    expect(checkout.shippingCost).toEqual({
      status: "priced",
      totalSats: 7,
      missingProductIds: [],
    })
    expect(checkout.totalSats).toBe(307)
    expect(
      checkout.items.map((item) => item.shippingAllocatedCostSats)
    ).toEqual([5, 2])
    expect(prepared.items[0]!.shippingPolicyQuote).toMatchObject({
      combinedWeightGrams: 1000,
      amountMinor: 7,
      policyCreatedAt: 1,
    })
    expect(
      getCartShippingDestinationEligibility(destination, prepared.items)
    ).toEqual({ eligible: true })
    const parsedOrder = orderSchema.safeParse(payload(checkout.items, 7))
    if (!parsedOrder.success)
      throw new Error(
        JSON.stringify(
          parsedOrder.error.issues.map(({ path, message }) => ({
            path,
            message,
          }))
        )
      )
    expect(parsedOrder.success).toBe(true)
  })

  it("does not combine merchants and excludes digital items from physical thresholds", () => {
    const otherSecret = generateSecretKey()
    const otherMerchant = getPublicKey(otherSecret)
    const otherPolicyEvent = finalizeEvent(
      { ...buildShippingPolicyEventDraft({ policy }), created_at: 1 },
      otherSecret
    )
    const otherOption = parseShippingOptionEvent(
      new NDKEvent(undefined, otherPolicyEvent)
    )!
    otherOption.readSource = "relay"
    otherOption.readCoverage = "complete"
    const otherItem = {
      ...createCartItemFromProduct(
        product("other", 300, "physical", otherMerchant, otherSecret)
      ),
      quantity: 1,
    }
    const digital = {
      ...createCartItemFromProduct(product("download", undefined, "digital")),
      quantity: 100,
    }
    const prepared = prepareCartFulfillment(
      [raw("a"), otherItem, digital],
      [option(), otherOption],
      destination
    )
    expect(priced(prepared.items).shippingCost.totalSats).toBe(14)
    expect(prepared.items[0]!.shippingPolicyQuote!.shippedSubtotalMinor).toBe(
      100
    )
    expect(prepared.items[2]!.shippingPolicyQuote).toBeUndefined()
  })

  it("excludes current signed Event Market pickup and stale table quotes from parcel shipping", () => {
    const fixture = createEventMarketOrderFixture({ mode: "merchant_present" })
    const signedProduct = fixture.fulfillment.product.signedEvent
    const listing = parseProductEvent(new NDKEvent(undefined, signedProduct))!
    const staleTable = prepareCartFulfillment(
      [raw("stale-table")],
      [option()],
      destination
    ).items[0]!
    const pickup: CartItem = {
      ...createCartItemFromProduct(listing),
      quantity: 1,
      fulfillment: fixture.fulfillment,
      shippingPolicyQuote: staleTable.shippingPolicyQuote,
      shippingAllocatedCostSats: 7,
      shippingOptionId: staleTable.shippingOptionId,
    }
    expect(getCartShippingOptionCoordinates([pickup])).toEqual([])
    const prepared = prepareCartFulfillment(
      [pickup],
      [option()],
      destination
    ).items
    expect(prepared[0]!.shippingPolicyQuote).toBeUndefined()
    expect(getCartShippingOptionsAvailable(prepared)).toBe(true)
    expect(
      getCartShippingDestinationEligibility(destination, prepared)
    ).toEqual({ eligible: true })
    // Pricing also clears stale table evidence when called before preparation.
    for (const items of [[pickup], prepared]) {
      const checkout = priced(items)
      expect(checkout.totalSats).toBe(100)
      expect(checkout.shippingCost).toMatchObject({
        status: "included",
        totalSats: 0,
      })
      expect(checkout.items[0]!.shippingPolicyQuote).toBeUndefined()
      expect(checkout.items[0]!.shippingAllocatedCostSats).toBeUndefined()
      const accepted = orderSchema.parse({
        ...fixture.order,
        items: checkout.items,
        shippingCostStatus: "not_required",
      })
      expect(accepted.items[0]!.fulfillment).toEqual(
        JSON.parse(JSON.stringify(fixture.fulfillment))
      )
    }
    expect(getMixedFulfillmentBlockingMessage(prepared)).toBeNull()
  })

  it("preserves rich authorization evidence while safely rejecting table charges at the Spark router boundary", async () => {
    const input = raw("router-table")
    const shipping = option()
    const reviewed = prepareCartFulfillment(
      [input],
      [shipping],
      destination
    ).items
    const listing = product("router-table")
    const authorization = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      rawItems: [input],
      reviewedItems: reviewed,
      refreshedProducts: [listing],
      destination,
      readShippingOptions: async () => [shipping],
      resolveProductFulfillment: async (current) => ({
        status: "standard",
        type: "shipping",
        product: current,
      }),
      authorizePickupHandlers: async () => {},
    })
    if (authorization.status !== "ok")
      throw new Error("Private table authorization failed")
    expect(authorization.listingReadProducts).toEqual([listing])
    expect(authorization.fulfillmentResolvedProducts).toEqual([listing])
    expect(authorization.shippingOptionEvidence).toEqual({
      status: "verified",
      options: [shipping],
    })
    expect(priced(authorization.items).totalSats).toBe(107)
    expect(() =>
      buildCheckoutSparkQuoteAuthority({ authorization, rateInput: null })
    ).toThrow("Current signed checkout evidence changed")
  })

  it("sends a mixed table and unresolved physical order for coordination without agreeing to a partial charge", () => {
    const manual = createCartItemFromProduct(
      product(
        "manual",
        300,
        "physical",
        merchant,
        secret,
        `30406:${merchant}:unresolved-fixed`
      )
    )
    const prepared = prepareCartFulfillment(
      [raw("a"), { ...manual, quantity: 1 }],
      [option()],
      destination
    )
    expect(prepared.items[0]!.shippingPolicyQuote!.amountMinor).toBe(7)
    expect(getCartShippingOptionsAvailable(prepared.items)).toBe(false)
    expect(
      getCartShippingDestinationEligibility(destination, prepared.items)
        .eligible
    ).not.toBe(true)
    const checkout = priced(prepared.items)
    expect(checkout.shippingCost).toMatchObject({
      status: "manual",
      totalSats: 0,
    })
    expect(checkout.totalSats).toBe(200)
    expect(checkout.items[0]).toMatchObject({
      shippingPolicyQuote: undefined,
      shippingAllocatedCostSats: undefined,
      shippingCostSats: undefined,
      shippingOptionId: undefined,
    })
    const order = orderSchema.parse({
      ...payload(checkout.items, 0),
      shippingCostSats: undefined,
      shippingCostStatus: "manual",
    })
    const received = parseOrderRumorEvent({
      content: serializeOrderRumorContent(order),
    })
    expect(received.shippingCostStatus).toBe("manual")
    expect(received.shippingCostSats).toBeUndefined()
    expect(
      received.items.every(
        (item) =>
          !item.shippingPolicyQuote &&
          item.shippingAllocatedCostSats === undefined &&
          item.shippingCostSats === undefined
      )
    ).toBe(true)
  })

  it("keeps unresolved, missing weight, destination miss and overweight shipping manual before waiving a charge", () => {
    const freeOption = option(1, {
      domestic: { ...policy.domestic!, freeShippingThresholdMinor: 0 },
    })
    for (const [items, options, dest] of [
      [[raw("a")], [], destination],
      [
        [{ ...raw("a"), shippingWeightGrams: undefined }],
        [freeOption],
        destination,
      ],
      [[raw("a")], [freeOption], { ...destination, country: "MX" }],
      [[raw("a", 20)], [freeOption], destination],
    ] as const) {
      const prepared = prepareCartFulfillment([...items], [...options], dest)
      const checkout = priced(prepared.items)
      expect(checkout.shippingCost.status).toBe("manual")
      expect(checkout.items.every((item) => !item.shippingPolicyQuote)).toBe(
        true
      )
    }
    const eligible = prepareCartFulfillment(
      [raw("a")],
      [freeOption],
      destination
    )
    expect(priced(eligible.items).shippingCost).toMatchObject({
      status: "included",
      totalSats: 0,
    })
  })

  it("requires review when a signed policy changes before authorization and refreshes the quote", async () => {
    const input = raw("a")
    const reviewed = prepareCartFulfillment(
      [input],
      [option()],
      destination
    ).items
    const nextOption = option(3, { handlingMinor: 4 })
    const next = prepareCartFulfillment(
      [input],
      [nextOption],
      destination
    ).items
    const authorize = (reviewedItems: CartItem[]) =>
      authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        rawItems: [input],
        reviewedItems,
        refreshedProducts: [product("a")],
        readShippingOptions: async () => [nextOption],
        destination,
        resolveProductFulfillment: async (current) => ({
          status: "standard",
          type: "shipping",
          product: current,
        }),
        authorizePickupHandlers: async () => {},
      })
    expect(await authorize(reviewed)).toEqual({ status: "changed" })
    expect(await authorize(next)).toMatchObject({ status: "ok" })
    expect(priced(next).shippingCost.totalSats).toBe(10)
    expect(reviewed[0]!.shippingPolicyQuote!.amountMinor).toBe(7)
  })

  it("preserves quote inputs through cart restart, encrypted order parsing and lifecycle recovery", () => {
    const prepared = prepareCartFulfillment(
      [raw("a", 2), raw("b")],
      [option()],
      destination
    )
    const validQuote = shippingPolicyQuoteSchema.safeParse(
      prepared.items[0]!.shippingPolicyQuote
    )
    if (!validQuote.success)
      throw new Error(
        JSON.stringify(
          validQuote.error.issues.map(({ path, message }) => ({
            path,
            message,
          }))
        )
      )
    const restarted = parsePersistedCart(
      JSON.parse(JSON.stringify({ version: 2, items: prepared.items }))
    ).state.items
    expect(restarted.map((item) => item.shippingPolicyQuote)).toEqual(
      prepared.items.map((item) => item.shippingPolicyQuote)
    )
    expect(priced(restarted).shippingCost.totalSats).toBe(7)
    const checkout = priced(restarted)
    const order = payload(checkout.items, 7)
    const message = parseOrderMessageRumorEvent({
      id: "1".repeat(64),
      pubkey: order.buyerPubkey,
      kind: 16,
      created_at: 2,
      tags: [
        ["p", merchant],
        ["type", "order"],
        ["order", order.id],
      ],
      content: JSON.stringify(order),
    })
    if (!message) throw new Error("Order parsing failed")
    const summary = extractOrderSummary([message])
    expect(summary.items[0]!.shippingPolicyQuote).toEqual(
      prepared.items[0]!.shippingPolicyQuote
    )
    const lifecycle: OrderLifecycle = {
      orderId: order.id,
      buyerPubkey: order.buyerPubkey,
      merchantPubkey: merchant,
      checkoutMode: "private_checkout",
      items: checkout.items as OrderLifecycle["items"],
      itemSubtotalSats: 300,
      shippingCostSats: 7,
      totalSats: 307,
      totalMsats: 307000,
      currency: "SATS",
      shippingAddress: order.shippingAddress,
      addressValidity: "locality_consistent",
      shippingZoneEligibility: "eligible",
      orderDeliveryStatus: "sent",
      invoiceStatus: "failed",
      paymentStatus: "failed",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "not_applicable",
      phase: "in_progress",
      createdAt: 2000,
      updatedAt: 2000,
    }
    const recovered = buildOrderViewModel({
      orderId: order.id,
      lifecycle: JSON.parse(JSON.stringify(lifecycle)),
    })
    expect(recovered.items[0]!.shippingPolicyQuote).toEqual(
      prepared.items[0]!.shippingPolicyQuote
    )
    expect(
      recovered.items.reduce(
        (sum, item) => sum + (item.shippingAllocatedCostSats ?? 0),
        0
      )
    ).toBe(7)
    expect(option(3, { handlingMinor: 100 }).eventId).not.toBe(
      prepared.items[0]!.shippingPolicyQuote!.policyEventId
    )
    expect(recovered.items[0]!.shippingPolicyQuote!.amountMinor).toBe(7)
  })

  it("rejects altered destinations, group quantities and allocations in saved order evidence", () => {
    const checkout = priced(
      prepareCartFulfillment([raw("a", 2), raw("b")], [option()], destination)
        .items
    )
    const order = payload(checkout.items, 7)
    expect(
      orderSchema.safeParse({
        ...order,
        shippingAddress: { ...order.shippingAddress, postalCode: "90210" },
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({ ...order, shippingCostSats: 8 }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({ ...order, items: order.items.slice(0, 1) })
        .success
    ).toBe(false)
  })
  it("rejects a forged group charge even when the buyer changes the matching order total", () => {
    const checkout = priced(
      prepareCartFulfillment([raw("a", 2), raw("b")], [option()], destination)
        .items
    )
    const order = payload(checkout.items, 7)
    const altered = {
      ...order,
      shippingCostSats: 8,
      subtotal: 308,
      items: order.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              shippingAllocatedCostSats: item.shippingAllocatedCostSats! + 1,
            }
          : item
      ),
    }
    expect(orderSchema.safeParse(altered).success).toBe(false)
    expect(orderSchema.safeParse(order).success).toBe(true)
  })
})

const mixedPolicy: ShippingPolicy = {
  version: 2,
  title: "Mixed currency parcels",
  originCountry: "US",
  currency: "GBP",
  domestic: {
    rules: [
      {
        country: "US",
        bands: [
          { maxWeightGrams: 1000, priceMinor: 250 },
          { maxWeightGrams: 2000, priceMinor: 500 },
        ],
      },
    ],
    freeShippingThresholdMinor: 4000,
  },
  international: null,
}
function mixedOption(changes: Partial<ShippingPolicy> = {}) {
  const event = finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({
        policy: { ...mixedPolicy, ...changes },
      }),
      created_at: 1,
    },
    secret
  )
  return {
    ...parseShippingOptionEvent(new NDKEvent(undefined, event))!,
    readSource: "relay" as const,
    readCoverage: "complete" as const,
  }
}
function mixedProduct(
  name: string,
  changes: {
    currency?: string
    price?: number
    weight?: number
    padding?: number
    handling?: number
    createdAt?: number
  } = {}
) {
  const currency = changes.currency ?? "USD"
  const event = finalizeEvent(
    {
      kind: 30402,
      created_at: changes.createdAt ?? 2,
      content: "Synthetic mixed currency listing",
      tags: [
        ["d", name],
        ["title", name],
        ["price", String(changes.price ?? 12.5), currency],
        ["type", "simple", "physical"],
        ["shipping_option", getMerchantShippingPolicyCoordinate(merchant)],
        ["weight", String(changes.weight ?? 300), "g"],
        [
          "conduit_shipping_adjustments",
          "1",
          JSON.stringify({
            weightAllowanceGrams: changes.padding ?? 50,
            handling: {
              amount: changes.handling ?? 1.25,
              currency,
              normalizedCurrency: currency,
            },
          }),
        ],
      ],
    },
    secret
  )
  const parsed = parseProductEvent(new NDKEvent(undefined, event))
  if (!parsed) throw new Error("Signed mixed currency product did not parse")
  return parsed
}
function mixedProducts() {
  return [
    mixedProduct("mixed-a"),
    mixedProduct("mixed-b", {
      currency: "EUR",
      price: 10,
      weight: 200,
      padding: 100,
      handling: 1,
    }),
  ]
}
function mixedItems(products = mixedProducts()) {
  return products.map((current, index) => ({
    ...createCartItemFromProduct(current),
    quantity: index === 0 ? 2 : 1,
  }))
}
function mixedRate(changes: Partial<BtcUsdRateQuote> = {}): BtcUsdRateQuote {
  return {
    rate: 100000,
    fetchedAt: Date.now(),
    source: "env",
    fiatSource: "env",
    fiatUsdRates: { EUR: 1.25, GBP: 1.25 },
    ...changes,
  }
}

describe("per-product shipping adjustments with saved currency conversions", () => {
  it("combines USD and EUR products with quantities, padding and fees in one GBP table and preserves exact replay", () => {
    const rate = mixedRate()
    const prepared = prepareCartFulfillment(
      mixedItems(),
      [mixedOption()],
      destination,
      rate
    )
    const checkout = priced(prepared.items, rate)
    const quote = prepared.items[0]!.shippingPolicyQuote!
    expect(quote).toMatchObject({
      version: 2,
      currency: "GBP",
      combinedWeightGrams: 1000,
      shippedSubtotalMinor: 3000,
      handlingMinor: 300,
      amountMinor: 550,
      amountSats: 6875,
      pricingRate: rate,
    })
    expect(checkout.shippingCost).toMatchObject({
      status: "priced",
      totalSats: 6875,
    })
    expect(checkout.itemSubtotalSats).toBe(37500)
    expect(checkout.totalSats).toBe(44375)
    expect(
      checkout.items.map((item) => item.shippingAllocatedCostSats)
    ).toEqual([4584, 2291])
    expect(checkout.quote?.fiatUsdRates).toEqual(rate.fiatUsdRates)
    const received = parseOrderRumorEvent({
      content: serializeOrderRumorContent(
        orderSchema.parse(payload(checkout.items, 6875))
      ),
    })
    expect(received.items[0]!.shippingPolicyQuote).toEqual(quote)
    const restarted = parsePersistedCart(
      JSON.parse(JSON.stringify({ version: 2, items: prepared.items }))
    ).state.items
    expect(restarted[0]!.shippingWeightAllowanceGrams).toBe(50)
    expect(restarted[1]!.shippingHandling).toEqual({
      amount: 1,
      currency: "EUR",
      normalizedCurrency: "EUR",
    })
    expect(
      priced(restarted, mixedRate({ fiatUsdRates: { EUR: 1.25, GBP: 1 } }))
        .shippingCost.totalSats
    ).toBe(6875)
    expect(shippingPolicyQuoteSchema.safeParse(quote).success).toBe(true)
    expect(
      shippingPolicyQuoteSchema.safeParse({ ...quote, amountSats: 6876 })
        .success
    ).toBe(false)
  })

  it("requires changed-term review for signed product adjustments and currency rates before authorization", async () => {
    const products = mixedProducts()
    const items = mixedItems(products)
    const rate = mixedRate()
    const table = mixedOption()
    const reviewed = prepareCartFulfillment(
      items,
      [table],
      destination,
      rate
    ).items
    const nextRate = mixedRate({ fiatUsdRates: { EUR: 1.25, GBP: 1 } })
    const afterRate = prepareCartFulfillment(
      items,
      [table],
      destination,
      nextRate
    ).items
    const authorize = (
      current: CartItem[],
      freshProducts = products,
      freshRate = rate,
      rawItems = items
    ) =>
      authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        rawItems,
        reviewedItems: current,
        refreshedProducts: freshProducts,
        readShippingOptions: async () => [table],
        destination,
        rateInput: freshRate,
        resolveProductFulfillment: async (product) => ({
          status: "standard",
          type: "shipping",
          product,
        }),
        authorizePickupHandlers: async () => {},
      })
    expect(await authorize(reviewed, products, nextRate)).toEqual({
      status: "changed",
    })
    expect(priced(afterRate, nextRate).shippingCost.totalSats).toBe(6250)
    expect(await authorize(afterRate, products, nextRate)).toMatchObject({
      status: "ok",
    })
    const nextProducts = [
      mixedProduct("mixed-a", { padding: 70, handling: 2.5, createdAt: 3 }),
      products[1]!,
    ]
    expect(await authorize(reviewed, nextProducts)).toEqual({
      status: "changed",
    })
    const afterProduct = prepareCartFulfillment(
      mixedItems(nextProducts),
      [table],
      destination,
      rate
    ).items
    expect(afterProduct[0]!.shippingPolicyQuote).toMatchObject({
      combinedWeightGrams: 1040,
      handlingMinor: 500,
      amountSats: 12500,
    })
    expect(
      await authorize(
        afterProduct,
        nextProducts,
        rate,
        mixedItems(nextProducts)
      )
    ).toMatchObject({
      status: "ok",
    })
    expect(reviewed[0]!.shippingPolicyQuote).toMatchObject({
      amountMinor: 550,
      amountSats: 6875,
      pricingRate: rate,
    })
  })

  it("converts the physical merchandise threshold before a full eligible shipping and handling waiver", () => {
    const items = mixedItems()
    const rate = mixedRate()
    const table = mixedOption({
      domestic: { ...mixedPolicy.domestic!, freeShippingThresholdMinor: 3500 },
    })
    const below = prepareCartFulfillment(
      items,
      [table],
      destination,
      rate
    ).items
    expect(priced(below, rate).shippingCost.totalSats).toBe(6875)
    const nextRate = mixedRate({ fiatUsdRates: { EUR: 1.25, GBP: 1 } })
    const waived = prepareCartFulfillment(
      items,
      [table],
      destination,
      nextRate
    ).items
    expect(waived[0]!.shippingPolicyQuote).toMatchObject({
      shippedSubtotalMinor: 3750,
      handlingMinor: 375,
      freeShippingApplied: true,
      amountMinor: 0,
      amountSats: 0,
    })
    expect(priced(waived, nextRate).shippingCost).toMatchObject({
      status: "included",
      totalSats: 0,
    })
    expect(
      orderSchema.safeParse(payload(priced(waived, nextRate).items, 0)).success
    ).toBe(true)
    const unsupported = prepareCartFulfillment(
      items,
      [table],
      { ...destination, country: "MX" },
      nextRate
    ).items
    expect(priced(unsupported, nextRate).shippingCost.status).toBe("manual")
  })

  it("keeps a missing policy-currency rate in coordination while merchandise can still be priced", () => {
    const rate = mixedRate({ fiatUsdRates: { EUR: 1.25 } })
    const prepared = prepareCartFulfillment(
      mixedItems(),
      [mixedOption()],
      destination,
      rate
    )
    const checkout = priced(prepared.items, rate)
    expect(checkout.shippingCost.status).toBe("manual")
    expect(checkout.itemSubtotalSats).toBe(37500)
    expect(getCartShippingOptionsAvailable(prepared.items)).toBe(false)
    expect(
      checkout.items.every(
        (item) =>
          !item.shippingPolicyQuote &&
          item.shippingAllocatedCostSats === undefined
      )
    ).toBe(true)
    expect(
      orderSchema.safeParse({
        ...payload(checkout.items, 0),
        shippingCostSats: undefined,
        shippingCostStatus: "manual",
      }).success
    ).toBe(true)
  })
})

describe("shipping review regressions", () => {
  it("prices an explicit zero fiat band without FX, but still requires threshold, handling and positive-charge conversions", () => {
    const zero = mixedOption({
      currency: "USD",
      domestic: {
        rules: [
          { country: "US", bands: [{ maxWeightGrams: 1000, priceMinor: 0 }] },
        ],
      },
    })
    const items = [raw("zero-fiat")]
    const prepared = prepareCartFulfillment(items, [zero], destination, null)
    expect(prepared.items[0]!.shippingPolicyQuote).toMatchObject({
      amountSats: 0,
      pricingRate: null,
    })
    const checkout = priced(prepared.items, null)
    expect(checkout.shippingCost).toMatchObject({
      status: "included",
      totalSats: 0,
    })
    expect(checkout.approximate).toBe(false)
    expect(orderSchema.safeParse(payload(checkout.items, 0)).success).toBe(true)
    for (const table of [
      mixedOption({
        currency: "USD",
        domestic: {
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 1000, priceMinor: 100 }],
            },
          ],
        },
      }),
      mixedOption({
        currency: "USD",
        domestic: {
          ...zero.shippingPolicy!.domestic!,
          freeShippingThresholdMinor: 100,
        },
      }),
    ]) {
      expect(
        prepareCartFulfillment(items, [table], destination, null).items[0]!
          .shippingPolicyQuote
      ).toBeUndefined()
    }
    const stale = mixedRate({ fetchedAt: 1, source: "mempool" })
    const unusedRate = prepareCartFulfillment(items, [zero], destination, stale)
    expect(priced(unusedRate.items, stale).approximate).toBe(false)
    const threshold = mixedOption({
      currency: "USD",
      domestic: {
        ...zero.shippingPolicy!.domestic!,
        freeShippingThresholdMinor: 0,
      },
    })
    const waived = prepareCartFulfillment(
      items,
      [threshold],
      destination,
      stale
    )
    expect(waived.items[0]!.shippingPolicyQuote).toMatchObject({
      amountSats: 0,
      pricingRate: stale,
    })
    expect(buildCheckoutPricingIntent(waived.items, stale)).toMatchObject({
      status: "error",
      code: "stale_quote",
    })
    const handled = [
      createCartItemFromProduct(
        mixedProduct("zero-handled", {
          currency: "SATS",
          price: 100,
          handling: 1,
        })
      ),
    ]
    expect(
      prepareCartFulfillment(handled, [zero], destination, null).items[0]!
        .shippingPolicyQuote
    ).toBeUndefined()
  })
})
