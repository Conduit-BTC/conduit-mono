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
  type ShippingPolicy,
} from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import {
  createCartItemFromProduct,
  parsePersistedCart,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import {
  getCartShippingDestinationEligibility,
  getCartShippingOptionsAvailable,
  prepareCartFulfillment,
} from "../apps/market/src/lib/cart-shipping-options"
import { buildOrderViewModel } from "../apps/market/src/lib/order-view"

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
  return parsed
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
function priced(items: CartItem[]) {
  const result = buildCheckoutPricingIntent(items, null)
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

  it("retains pickup charges without applying a physical shipping table", () => {
    const pickup = raw("pickup")
    pickup.fulfillment = {
      type: "pickup",
      organizerPubkey: merchant,
      product: {
        coordinate: pickup.productId,
        eventId: pickup.productEventId!,
        createdAt: 2,
        merchantPubkey: merchant,
      },
      calendar: {
        coordinate: `31922:${merchant}:event`,
        eventId: "2".repeat(64),
        createdAt: 2,
      },
      collection: {
        coordinate: `30405:${merchant}:collection`,
        eventId: "3".repeat(64),
        createdAt: 2,
      },
      option: {
        coordinate: `30406:${merchant}:pickup`,
        eventId: "4".repeat(64),
        createdAt: 2,
        title: "Event pickup",
        location: "Synthetic venue",
      },
      handoffMode: "organizer_handoff",
      handlerPubkey: merchant,
      costSats: 3,
      sourceCost: { amount: 3, currency: "SATS", normalizedCurrency: "SATS" },
    }
    pickup.shippingCostSats = pickup.fulfillment.costSats
    pickup.sourceShippingCost = pickup.fulfillment.sourceCost
    const prepared = prepareCartFulfillment([pickup], [option()], destination)
    expect(prepared.items[0]!.shippingPolicyQuote).toBeUndefined()
    expect(priced(prepared.items).shippingCost.totalSats).toBe(3)
    expect(priced(prepared.items).totalSats).toBe(103)
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
