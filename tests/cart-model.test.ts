import { describe, expect, it } from "bun:test"
import {
  orderItemFulfillmentSchema,
  type ParsedShippingOption,
  type Product,
  type ProductAvailabilityDiagnostic,
  type ProductAvailabilityIssue,
} from "@conduit/core"
import {
  cartItemsMatchCurrentProducts,
  createPendingEventPickupFulfillment,
  createCartItemFromProduct,
  getCartAvailabilityBlockingMessage,
  getCartFulfillmentLane,
  getCartItemFulfillmentType,
  getCartItemStockEvidenceForAvailability,
  getCartProductAvailability,
  getCartItemKey,
  getPendingEventPickupCartItems,
  getCartPurchaseReference,
  getCartCostSummary,
  getCartCommerceFingerprint,
  getCartPublicZapPolicy,
  getCartTotals,
  getProductAddAvailability,
  groupCartItems,
  groupCartPurchases,
  getCartAvailabilityReadDecision,
  getCartAvailabilityVerificationMessage,
  getMixedFulfillmentBlockingMessage,
  isCartAvailabilityReadComplete,
  isCartProductAvailabilityBlocking,
  isPendingEventPickupCartItem,
  isSameCartLineFulfillment,
  parsePersistedCart,
  selectCartItem,
  type CartPickupFulfillment,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import { prepareCartFulfillment } from "../apps/market/src/lib/cart-shipping-options"
import { getHudZapAuthorizationBindingMismatch } from "../apps/market/src/lib/hud-zap-intent"

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "30402:merchant-a:product-a",
    merchantPubkey: "merchant-a",
    title: "Notebook",
    price: 1_000,
    currency: "SATS",
    quantity: 1,
    ...overrides,
  }
}

function pickupFulfillment(): CartPickupFulfillment {
  const organizer = "a".repeat(64)
  const merchant = "b".repeat(64)
  return {
    type: "pickup",
    organizerPubkey: organizer,
    product: {
      coordinate: `30402:${merchant}:product-a`,
      eventId: "1".repeat(64),
      createdAt: 100,
      merchantPubkey: merchant,
    },
    calendar: {
      coordinate: `31922:${organizer}:event-a`,
      eventId: "2".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: `30405:${organizer}:market-a`,
      eventId: "3".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: `30406:${organizer}:pickup-a`,
      eventId: "4".repeat(64),
      createdAt: 103,
      title: "Main entrance",
      location: "Fixture Hall",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: organizer,
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
  }
}

function refreshedProduct(
  cartItem: CartItem,
  overrides: Partial<Product> = {}
): Product {
  return {
    id: cartItem.productId,
    pubkey: cartItem.merchantPubkey,
    title: cartItem.title,
    price: cartItem.price,
    currency: cartItem.currency,
    type: "simple",
    format: "physical",
    visibility: "public",
    stock: cartItem.stock,
    images: [],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 3,
    ...overrides,
  }
}

function exactLiveDiagnostic(
  productId: string,
  listing: "complete" | "partial" = "complete"
): ProductAvailabilityDiagnostic {
  return {
    productId,
    addressId: productId,
    issue: null,
    coverage: { listing, deletion: "complete" },
  }
}

function unverifiedDecision(
  reason: ProductAvailabilityIssue | "query_failed" | "evidence_mismatch",
  diagnostics: ProductAvailabilityDiagnostic[]
) {
  return {
    status: "unverified" as const,
    reason,
    diagnostics,
  }
}

describe("cart model", () => {
  it("caps product additions at the remaining tracked stock", () => {
    expect(getProductAddAvailability(undefined, 4, 2)).toEqual({
      remainingStock: undefined,
      canAdd: true,
      canIncrement: true,
    })
    expect(getProductAddAvailability(1, 0, 1)).toEqual({
      remainingStock: 1,
      canAdd: true,
      canIncrement: false,
    })
    expect(getProductAddAvailability(1, 1, 1)).toEqual({
      remainingStock: 0,
      canAdd: false,
      canIncrement: false,
    })
    expect(getProductAddAvailability(10, 3, 7)).toEqual({
      remainingStock: 7,
      canAdd: true,
      canIncrement: false,
    })
    expect(getProductAddAvailability(10, 3, 8)).toEqual({
      remainingStock: 7,
      canAdd: false,
      canIncrement: false,
    })
  })

  it("groups items by merchant with newest merchant first, independent of quantity", () => {
    let items = [
      item({
        productId: "30402:merchant-a:product-a",
        merchantPubkey: "merchant-a",
        merchantAddedAt: 100,
        quantity: 1,
      }),
      item({
        productId: "30402:merchant-b:product-b",
        merchantPubkey: "merchant-b",
        merchantAddedAt: 200,
        quantity: 1,
      }),
      item({
        productId: "30402:merchant-a:product-c",
        merchantPubkey: "merchant-a",
        merchantAddedAt: 300,
        quantity: 9,
      }),
    ]

    let groups = groupCartItems(items)

    expect(groups.map((group) => group.merchantPubkey)).toEqual([
      "merchant-b",
      "merchant-a",
    ])
    expect(groups.map((group) => group.totalItems)).toEqual([1, 10])
    expect(groups.map((group) => group.merchantAddedAt)).toEqual([200, 100])
    expect(groups[1]?.items.map((cartItem) => cartItem.productId)).toEqual([
      "30402:merchant-a:product-a",
      "30402:merchant-a:product-c",
    ])

    items = [
      ...items.filter((cartItem) => cartItem.merchantPubkey !== "merchant-b"),
      item({
        productId: "30402:merchant-b:product-d",
        merchantPubkey: "merchant-b",
        merchantAddedAt: 400,
        quantity: 1,
      }),
    ]
    groups = groupCartItems(items)
    expect(groups.map((group) => group.merchantPubkey)).toEqual([
      "merchant-b",
      "merchant-a",
    ])
    expect(groups.map((group) => group.merchantAddedAt)).toEqual([400, 100])
  })

  it("partitions purchases by merchant, delivery, and exact pickup graph", () => {
    const eventA = pickupFulfillment()
    const eventB = {
      ...pickupFulfillment(),
      calendar: {
        ...pickupFulfillment().calendar,
        coordinate: `31922:${"a".repeat(64)}:event-b`,
        eventId: "5".repeat(64),
        createdAt: 201,
      },
    }
    const merchantA = eventA.product.merchantPubkey
    const merchantB = "c".repeat(64)
    const groups = groupCartPurchases([
      item({
        merchantPubkey: merchantA,
        productId: `30402:${merchantA}:shipping`,
        title: "Shipped",
        format: "physical",
        fulfillment: { type: "shipping" },
      }),
      item({
        merchantPubkey: merchantA,
        productId: `30402:${merchantA}:pickup-a-1`,
        title: "Event A first",
        format: "physical",
        fulfillment: eventA,
      }),
      item({
        merchantPubkey: merchantA,
        productId: `30402:${merchantA}:pickup-a-2`,
        title: "Event A second",
        format: "physical",
        fulfillment: {
          ...eventA,
          product: {
            ...eventA.product,
            coordinate: `30402:${merchantA}:pickup-a-2`,
            eventId: "6".repeat(64),
          },
        },
      }),
      item({
        merchantPubkey: merchantA,
        productId: `30402:${merchantA}:pickup-b`,
        title: "Event B",
        format: "physical",
        fulfillment: eventB,
      }),
      item({
        merchantPubkey: merchantB,
        productId: `30402:${merchantB}:digital`,
        title: "Other merchant",
        format: "digital",
        fulfillment: { type: "digital" },
      }),
    ])

    expect(groups).toHaveLength(4)
    expect(
      groups.map((group) => ({
        merchant: group.merchantPubkey,
        kind: group.kind,
        titles: group.items.map((entry) => entry.title),
      }))
    ).toEqual([
      {
        merchant: merchantB,
        kind: "delivery",
        titles: ["Other merchant"],
      },
      { merchant: merchantA, kind: "delivery", titles: ["Shipped"] },
      {
        merchant: merchantA,
        kind: "pickup",
        titles: ["Event A first", "Event A second"],
      },
      { merchant: merchantA, kind: "pickup", titles: ["Event B"] },
    ])
    expect(new Set(groups.map((group) => group.id)).size).toBe(4)
    expect(
      new Set(groups.map((group) => getCartPurchaseReference(group.id))).size
    ).toBe(4)
  })

  it("separates signed pickup revisions so readiness stays one-to-one", () => {
    const originalFulfillment = pickupFulfillment()
    const currentFulfillment: CartPickupFulfillment = {
      ...originalFulfillment,
      product: {
        ...originalFulfillment.product,
        eventId: "9".repeat(64),
        createdAt: originalFulfillment.product.createdAt + 1,
      },
    }
    const baseItem = item({
      merchantPubkey: originalFulfillment.product.merchantPubkey,
      productId: originalFulfillment.product.coordinate,
      format: "physical",
    })
    const originalItem = { ...baseItem, fulfillment: originalFulfillment }
    const currentItem = { ...baseItem, fulfillment: currentFulfillment }
    const groups = groupCartPurchases([originalItem, currentItem])

    expect(groups).toHaveLength(2)
    expect(new Set(groups.map((group) => group.id)).size).toBe(2)

    const currentPurchase = groups.find((group) =>
      group.items.includes(currentItem)
    )!
    const currentReference = getCartPurchaseReference(currentPurchase.id)
    const survivingPurchase = groupCartPurchases([currentItem])[0]!
    expect(survivingPurchase.id).toBe(currentPurchase.id)
    expect(getCartPurchaseReference(survivingPurchase.id)).toBe(
      currentReference
    )
    expect(
      getHudZapAuthorizationBindingMismatch(
        {
          merchantPubkey: currentPurchase.merchantPubkey,
          purchaseId: currentPurchase.id,
          buyerPubkey: "buyer-a",
          cartFingerprint: getCartCommerceFingerprint(currentPurchase.items),
          totalMsats: 1_000_000,
          createdAt: 1_000,
        },
        {
          merchantPubkey: survivingPurchase.merchantPubkey,
          purchaseId: survivingPurchase.id,
          buyerPubkey: "buyer-a",
          items: survivingPurchase.items,
          totalMsats: 1_000_000,
        }
      )
    ).toBeNull()

    const product = refreshedProduct(baseItem, {
      updatedAt: currentFulfillment.product.createdAt,
    })
    for (const group of groups) {
      const availability = getCartProductAvailability(group.items, [product])
      expect(
        getCartAvailabilityReadDecision({
          productIds: [product.id],
          availability,
          meta: { source: "commerce", stale: false, degraded: false },
          diagnostics: [exactLiveDiagnostic(product.id)],
          querySucceeded: true,
        })
      ).toEqual({ status: "verified_at_read", coverage: "complete" })
    }
  })

  it("preserves product stock and shipping-shape safety when creating a cart item snapshot", () => {
    const product: Product = {
      id: "30402:merchant-a:sold-out-tee",
      sourceEventId: "1".repeat(64),
      pubkey: "merchant-a",
      title: "Sold Out Tee",
      price: 2_500,
      currency: "SATS",
      type: "simple",
      format: "physical",
      shippingOptionId: "30406:merchant-a:sold-out-tee-shipping-standard",
      shippingOptionLaunchUnsupported: true,
      visibility: "public",
      stock: 0,
      images: [],
      tags: ["apparel"],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 2,
    }

    expect(createCartItemFromProduct(product)).toMatchObject({
      productId: product.id,
      merchantPubkey: product.pubkey,
      title: product.title,
      stock: 0,
      productEventId: product.sourceEventId,
      shippingOptionLaunchUnsupported: true,
    })
  })

  it("flags an existing cart item when refreshed product stock reaches zero", () => {
    const cartItems = [item({ stock: 4 })]
    const refreshedProduct: Product = {
      id: cartItems[0]!.productId,
      sourceEventId: "3".repeat(64),
      pubkey: cartItems[0]!.merchantPubkey,
      title: cartItems[0]!.title,
      price: cartItems[0]!.price,
      currency: cartItems[0]!.currency,
      type: "simple",
      format: "physical",
      visibility: "public",
      stock: 0,
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 2,
    }

    expect(getCartProductAvailability(cartItems, [refreshedProduct])).toEqual([
      {
        productId: cartItems[0]!.productId,
        merchantPubkey: cartItems[0]!.merchantPubkey,
        status: "sold_out",
        stock: 0,
        productUpdatedAt: 2,
        productEventId: refreshedProduct.sourceEventId,
        refreshed: true,
      },
    ])
    expect(
      isCartProductAvailabilityBlocking(
        getCartProductAvailability(cartItems, [refreshedProduct])[0]
      )
    ).toBe(true)
  })

  it("flags a cart quantity above refreshed product stock", () => {
    const cartItems = [item({ quantity: 10, stock: 10 })]
    const refreshedProduct: Product = {
      id: cartItems[0]!.productId,
      pubkey: cartItems[0]!.merchantPubkey,
      title: cartItems[0]!.title,
      price: cartItems[0]!.price,
      currency: cartItems[0]!.currency,
      type: "simple",
      format: "physical",
      visibility: "public",
      stock: 1,
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 2,
    }

    expect(getCartProductAvailability(cartItems, [refreshedProduct])).toEqual([
      {
        productId: cartItems[0]!.productId,
        merchantPubkey: cartItems[0]!.merchantPubkey,
        status: "insufficient_stock",
        stock: 1,
        productUpdatedAt: 2,
        refreshed: true,
      },
    ])
    expect(
      isCartProductAvailabilityBlocking(
        getCartProductAvailability(cartItems, [refreshedProduct])[0]
      )
    ).toBe(true)
    expect(
      getCartProductAvailability(cartItems, [
        { ...refreshedProduct, stock: cartItems[0]!.quantity },
      ])
    ).toMatchObject([
      {
        status: "available",
        stock: 10,
      },
    ])
    expect(
      getCartAvailabilityBlockingMessage(
        cartItems,
        new Map(
          getCartProductAvailability(cartItems, [refreshedProduct]).map(
            (entry) => [entry.productId, entry]
          )
        )
      )
    ).toBe(
      "Notebook has only 1 available, but your cart contains 10. Reduce the quantity before sending the order."
    )
  })

  it("treats a refreshed listing without a stock tag as untracked", () => {
    const cartItems = [item({ stock: 0 })]
    const refreshedProduct: Product = {
      id: cartItems[0]!.productId,
      sourceEventId: "3".repeat(64),
      pubkey: cartItems[0]!.merchantPubkey,
      title: cartItems[0]!.title,
      price: cartItems[0]!.price,
      currency: cartItems[0]!.currency,
      type: "simple",
      format: "physical",
      visibility: "public",
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 3,
    }

    const availability = getCartProductAvailability(cartItems, [
      refreshedProduct,
    ])

    expect(availability).toEqual([
      {
        productId: cartItems[0]!.productId,
        merchantPubkey: cartItems[0]!.merchantPubkey,
        status: "untracked",
        stock: undefined,
        productUpdatedAt: 3,
        productEventId: refreshedProduct.sourceEventId,
        refreshed: true,
      },
    ])
    expect(getCartItemStockEvidenceForAvailability(availability[0])).toEqual({
      stock: undefined,
      productUpdatedAt: 3,
      productEventId: refreshedProduct.sourceEventId,
    })
  })

  describe("checkout availability read decisions", () => {
    const partialMeta = {
      source: "commerce" as const,
      stale: true,
      degraded: true,
    }

    it("verifies the exact live final unit despite partial relay coverage", () => {
      const cartItems = [item({ stock: 1, quantity: 1 })]
      const availability = getCartProductAvailability(cartItems, [
        refreshedProduct(cartItems[0]!, { stock: 1 }),
      ])

      const decision = getCartAvailabilityReadDecision({
        productIds: [cartItems[0]!.productId],
        availability,
        meta: partialMeta,
        diagnostics: [exactLiveDiagnostic(cartItems[0]!.productId, "partial")],
        querySucceeded: true,
      })

      expect(decision).toEqual({
        status: "verified_at_read",
        coverage: "partial",
      })
      expect(isCartAvailabilityReadComplete(decision)).toBe(false)
      expect(
        isCartAvailabilityReadComplete({
          status: "verified_at_read",
          coverage: "complete",
        })
      ).toBe(true)
      expect(
        getCartAvailabilityBlockingMessage(
          cartItems,
          new Map(availability.map((entry) => [entry.productId, entry]))
        )
      ).toBeNull()
    })

    it("keeps pending evidence unverified without claiming cached or missing terms", () => {
      const cartItems = [item()]
      const availability = getCartProductAvailability(cartItems, [
        refreshedProduct(cartItems[0]!),
      ])
      const decision = getCartAvailabilityReadDecision({
        productIds: [cartItems[0]!.productId],
        availability,
        meta: partialMeta,
        diagnostics: [
          {
            productId: cartItems[0]!.productId,
            addressId: cartItems[0]!.productId,
            issue: "pending",
            coverage: { listing: "unavailable", deletion: "unavailable" },
          },
        ],
        querySucceeded: true,
      })
      expect(decision.status).toBe("unverified")
      expect(isCartAvailabilityReadComplete(decision)).toBe(false)
      expect(getCartAvailabilityVerificationMessage(cartItems, decision)).toBe(
        "Availability for Notebook is still being checked."
      )
    })

    it("keeps sold-out and over-quantity inventory blocks after verification", () => {
      const soldOutItems = [item({ stock: 1, quantity: 1 })]
      const soldOutAvailability = getCartProductAvailability(soldOutItems, [
        refreshedProduct(soldOutItems[0]!, { stock: 0 }),
      ])
      const soldOutDecision = getCartAvailabilityReadDecision({
        productIds: [soldOutItems[0]!.productId],
        availability: soldOutAvailability,
        meta: partialMeta,
        diagnostics: [
          exactLiveDiagnostic(soldOutItems[0]!.productId, "partial"),
        ],
        querySucceeded: true,
      })

      expect(soldOutDecision).toEqual({
        status: "verified_at_read",
        coverage: "partial",
      })
      expect(
        getCartAvailabilityBlockingMessage(
          soldOutItems,
          new Map(soldOutAvailability.map((entry) => [entry.productId, entry]))
        )
      ).toBe(
        "Notebook is sold out. Remove it from your cart before sending the order."
      )

      const overQuantityItems = [item({ stock: 1, quantity: 2 })]
      const overQuantityAvailability = getCartProductAvailability(
        overQuantityItems,
        [refreshedProduct(overQuantityItems[0]!, { stock: 1 })]
      )
      const overQuantityDecision = getCartAvailabilityReadDecision({
        productIds: [overQuantityItems[0]!.productId],
        availability: overQuantityAvailability,
        meta: partialMeta,
        diagnostics: [
          exactLiveDiagnostic(overQuantityItems[0]!.productId, "partial"),
        ],
        querySucceeded: true,
      })

      expect(overQuantityDecision).toEqual({
        status: "verified_at_read",
        coverage: "partial",
      })
      expect(
        getCartAvailabilityBlockingMessage(
          overQuantityItems,
          new Map(
            overQuantityAvailability.map((entry) => [entry.productId, entry])
          )
        )
      ).toBe(
        "Notebook has only 1 available, but your cart contains 2. Reduce the quantity before sending the order."
      )
    })

    it("fails closed when the availability query fails", () => {
      const cartItems = [item({ stock: 1 })]

      expect(
        getCartAvailabilityReadDecision({
          productIds: [cartItems[0]!.productId],
          availability: getCartProductAvailability(cartItems, []),
          meta: undefined,
          diagnostics: [],
          querySucceeded: false,
        })
      ).toEqual({
        status: "unverified",
        reason: "query_failed",
        diagnostics: [],
      })
    })

    it("requires live commerce records while allowing incomplete deletion discovery", () => {
      const cartItems = [item({ stock: 1 })]
      const productId = cartItems[0]!.productId
      const availability = getCartProductAvailability(cartItems, [
        refreshedProduct(cartItems[0]!, { stock: 1 }),
      ])
      const diagnostic = {
        ...exactLiveDiagnostic(productId),
        coverage: {
          listing: "complete" as const,
          deletion: "partial" as const,
        },
      }
      const decide = (
        meta: Parameters<typeof getCartAvailabilityReadDecision>[0]["meta"],
        nextAvailability = availability
      ) =>
        getCartAvailabilityReadDecision({
          productIds: [productId],
          availability: nextAvailability,
          meta,
          diagnostics: [diagnostic],
          querySucceeded: true,
        })

      expect(decide(partialMeta)).toEqual({
        status: "verified_at_read",
        coverage: "partial",
      })
      expect(
        decide({ source: "local_cache", stale: true, degraded: true })
      ).toEqual({
        status: "unverified",
        reason: "evidence_mismatch",
        diagnostics: [diagnostic],
      })
      expect(
        decide(partialMeta, [{ ...availability[0]!, refreshed: false }])
      ).toEqual({
        status: "unverified",
        reason: "evidence_mismatch",
        diagnostics: [diagnostic],
      })
    })

    it("rejects missing, extra, duplicate, and mismatched diagnostics", () => {
      const cartItems = [item({ stock: 1 })]
      const productId = cartItems[0]!.productId
      const availability = getCartProductAvailability(cartItems, [
        refreshedProduct(cartItems[0]!, { stock: 1 }),
      ])
      const decide = (diagnostics: ProductAvailabilityDiagnostic[]) =>
        getCartAvailabilityReadDecision({
          productIds: [productId],
          availability,
          meta: partialMeta,
          diagnostics,
          querySucceeded: true,
        })
      const extraProductId = "30402:merchant-a:extra-product"

      for (const diagnostics of [
        [],
        [
          exactLiveDiagnostic(productId, "partial"),
          exactLiveDiagnostic(extraProductId, "partial"),
        ],
        [
          exactLiveDiagnostic(productId, "partial"),
          exactLiveDiagnostic(productId, "partial"),
        ],
        [exactLiveDiagnostic(extraProductId, "partial")],
      ]) {
        expect(decide(diagnostics)).toEqual({
          status: "unverified",
          reason: "evidence_mismatch",
          diagnostics,
        })
      }
    })

    it("rejects live evidence for a different address coordinate", () => {
      const cartItems = [item({ stock: 1 })]
      const productId = cartItems[0]!.productId
      const availability = getCartProductAvailability(cartItems, [
        refreshedProduct(cartItems[0]!, { stock: 1 }),
      ])
      const diagnostics = [
        {
          ...exactLiveDiagnostic(productId, "partial"),
          addressId: "30402:merchant-b:different-product",
        },
      ]

      expect(
        getCartAvailabilityReadDecision({
          productIds: [productId],
          availability,
          meta: partialMeta,
          diagnostics,
          querySucceeded: true,
        })
      ).toEqual({
        status: "unverified",
        reason: "evidence_mismatch",
        diagnostics,
      })
    })

    it("requires an exact live diagnostic for every item in a multi-item cart", () => {
      const secondProductId = "30402:merchant-b:product-b"
      const cartItems = [
        item({ stock: 1 }),
        item({
          productId: secondProductId,
          merchantPubkey: "merchant-b",
          title: "Poster",
          stock: 3,
        }),
      ]
      const availability = getCartProductAvailability(
        cartItems,
        cartItems.map((cartItem) => refreshedProduct(cartItem))
      )
      const diagnostics = cartItems.map((cartItem) =>
        exactLiveDiagnostic(cartItem.productId)
      )

      expect(
        getCartAvailabilityReadDecision({
          productIds: cartItems.map((cartItem) => cartItem.productId),
          availability,
          meta: partialMeta,
          diagnostics,
          querySucceeded: true,
        })
      ).toEqual({ status: "verified_at_read", coverage: "complete" })

      expect(
        getCartAvailabilityReadDecision({
          productIds: cartItems.map((cartItem) => cartItem.productId),
          availability,
          meta: partialMeta,
          diagnostics: [
            diagnostics[0]!,
            {
              ...diagnostics[1]!,
              issue: "lookup_partial",
            },
          ],
          querySucceeded: true,
        })
      ).toEqual({
        status: "unverified",
        reason: "lookup_partial",
        diagnostics: [
          diagnostics[0]!,
          {
            ...diagnostics[1]!,
            issue: "lookup_partial",
          },
        ],
      })
    })
  })

  it("keeps equal product identifiers from different merchants separate", () => {
    const merchantA = item({
      productId: "shared-product",
      merchantPubkey: "merchant-a",
      title: "Merchant A",
    })
    const merchantB = item({
      productId: "shared-product",
      merchantPubkey: "merchant-b",
      title: "Merchant B",
    })

    const items = [merchantA, { ...merchantB, quantity: 2 }]
    expect(items).toHaveLength(2)
    expect(
      selectCartItem(items, {
        merchantPubkey: "merchant-a",
        productId: "shared-product",
      })?.quantity
    ).toBe(1)
    expect(
      selectCartItem(items, {
        merchantPubkey: "merchant-b",
        productId: "shared-product",
      })?.quantity
    ).toBe(2)
    expect(getCartItemKey(merchantA)).not.toBe(getCartItemKey(merchantB))
  })

  it("migrates legacy storage and preserves cross-merchant collisions", () => {
    const parsed = parsePersistedCart({
      items: [
        item({
          productId: "legacy-d-tag",
          merchantPubkey: "merchant-a",
          priceSats: 1_000,
          sourcePrice: {
            amount: 10,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        }),
        item({
          productId: "legacy-d-tag",
          merchantPubkey: "merchant-b",
          quantity: 2,
        }),
      ],
    })

    expect(parsed.writable).toBe(true)
    expect(parsed.shouldPersist).toBe(true)
    expect(parsed.state.items).toHaveLength(2)
    expect(parsed.state.items.map((entry) => entry.productId)).toEqual([
      "30402:merchant-a:legacy-d-tag",
      "30402:merchant-b:legacy-d-tag",
    ])
    expect(parsed.state.items[0]?.sourcePrice).toEqual({
      amount: 10,
      currency: "USD",
      normalizedCurrency: "USD",
    })
  })

  it("migrates duplicate legacy product rows without merging fulfillment terms", () => {
    const merchantPubkey = "b".repeat(64)
    const productId = `30402:${merchantPubkey}:shared-fulfillment`
    const pickup = {
      ...pickupFulfillment(),
      product: {
        ...pickupFulfillment().product,
        coordinate: productId,
        merchantPubkey,
      },
    }
    const shipping = item({
      merchantPubkey,
      productId,
      format: "physical",
      fulfillment: { type: "shipping" },
    })
    const eventPickup = item({
      merchantPubkey,
      productId,
      format: "physical",
      fulfillment: pickup,
    })

    for (const items of [
      [shipping, eventPickup],
      [eventPickup, shipping],
    ]) {
      const parsed = parsePersistedCart({ version: 2, items })
      expect(parsed.state.items).toHaveLength(2)
      expect(
        parsed.state.items.map((entry) => entry.fulfillment?.type).sort()
      ).toEqual(["pickup", "shipping"])
      expect(parsed.state.items.map((entry) => entry.quantity)).toEqual([1, 1])
    }
  })

  it("parses signed pickup fulfillment from a v2 persisted cart", () => {
    const fulfillment = pickupFulfillment()
    const merchantPubkey = fulfillment.product.merchantPubkey
    const persisted = {
      version: 2,
      items: [
        item({
          productId: fulfillment.product.coordinate,
          merchantPubkey,
          format: "physical",
          fulfillment,
        }),
      ],
    }

    expect(parsePersistedCart(persisted).state.items[0]?.fulfillment).toEqual(
      fulfillment
    )
  })

  it("persists pending event pickup without granting shipping or purchase authority", () => {
    const merchantPubkey = "b".repeat(64)
    const collectionCoordinate = `30405:${"a".repeat(64)}:market-a`
    const fulfillment = createPendingEventPickupFulfillment(
      `30405:${"A".repeat(64)}:market-a`
    )
    expect(fulfillment).toEqual({
      type: "event_pickup_pending",
      collectionCoordinate,
    })

    const parsed = parsePersistedCart({
      version: 2,
      items: [
        item({
          productId: `30402:${merchantPubkey}:product-a`,
          merchantPubkey,
          format: "physical",
          fulfillment: fulfillment!,
        }),
      ],
    })
    const pendingItem = parsed.state.items[0]!

    expect(isPendingEventPickupCartItem(pendingItem)).toBe(true)
    expect(getCartItemFulfillmentType(pendingItem)).toBe("event_pickup_pending")
    expect(getCartFulfillmentLane([pendingItem])).toBe("event_pickup_pending")
    expect(getMixedFulfillmentBlockingMessage([pendingItem])).toBe(
      "Event pickup is still being verified. Review it after verification finishes."
    )
    expect(getPendingEventPickupCartItems([pendingItem])).toEqual([pendingItem])
    expect(groupCartPurchases([pendingItem])).toEqual([])
    expect(getCartTotals([pendingItem])).toEqual({ count: 1, subtotal: 1_000 })
    expect(orderItemFulfillmentSchema.safeParse(fulfillment).success).toBe(
      false
    )
  })

  it("rejects malformed or digital pending event pickup persistence", () => {
    const merchantPubkey = "b".repeat(64)
    const base = item({
      productId: `30402:${merchantPubkey}:product-a`,
      merchantPubkey,
      format: "physical",
    })

    for (const fulfillment of [
      {
        type: "event_pickup_pending",
        collectionCoordinate: "30405:not-a-pubkey:market-a",
      },
      {
        type: "event_pickup_pending",
        collectionCoordinate: `30402:${merchantPubkey}:product-a`,
      },
    ]) {
      expect(
        parsePersistedCart({
          version: 2,
          items: [{ ...base, fulfillment }],
        }).state.items
      ).toEqual([])
    }

    const pending = createPendingEventPickupFulfillment(
      `30405:${"a".repeat(64)}:market-a`
    )!
    expect(
      parsePersistedCart({
        version: 2,
        items: [{ ...base, format: "digital", fulfillment: pending }],
      }).state.items
    ).toEqual([])
  })

  it("drops persisted cart rows with malformed pickup authority", () => {
    const fulfillment = pickupFulfillment()
    const merchantPubkey = fulfillment.product.merchantPubkey
    const parsed = parsePersistedCart({
      version: 2,
      items: [
        {
          ...item({
            productId: fulfillment.product.coordinate,
            merchantPubkey,
            format: "physical",
          }),
          fulfillment: {
            ...fulfillment,
            handlerPubkey: merchantPubkey,
          },
        },
      ],
    })

    expect(parsed.state.items).toEqual([])
  })

  it("deduplicates only exact identities using the latest snapshot", () => {
    const merchantHex = "a".repeat(64)
    const parsed = parsePersistedCart({
      version: 2,
      items: [
        item({
          productId: `30402:${merchantHex}:shared`,
          merchantPubkey: merchantHex,
          merchantAddedAt: 20,
          title: "Old title",
          quantity: 2,
        }),
        item({
          productId: `30402:${merchantHex}:shared`,
          merchantPubkey: merchantHex,
          merchantAddedAt: 10,
          title: "Current title",
          quantity: 3,
        }),
      ],
    })

    expect(parsed.shouldPersist).toBe(false)
    expect(parsed.state.items).toMatchObject([
      { title: "Current title", quantity: 5, merchantAddedAt: 10 },
    ])
  })

  it("drops malformed and merchant-mismatched coordinate rows", () => {
    const parsed = parsePersistedCart({
      version: 2,
      items: [
        item({
          productId: `30402:${"a".repeat(64)}:product-a`,
          merchantPubkey: "b".repeat(64),
        }),
        item({ quantity: Number.NaN }),
        item({ productId: "valid-legacy", quantity: 2.8 }),
      ],
    })

    expect(parsed.shouldPersist).toBe(true)
    expect(parsed.state.items).toMatchObject([
      { productId: "30402:merchant-a:valid-legacy", quantity: 2 },
    ])
  })

  it("fails closed for malformed and unknown future storage versions", () => {
    expect(parsePersistedCart(null)).toEqual({
      state: { items: [] },
      shouldPersist: false,
      writable: true,
    })
    expect(parsePersistedCart({ version: 3, items: [item()] })).toEqual({
      state: { items: [] },
      shouldPersist: false,
      writable: false,
    })
    expect(parsePersistedCart({ version: 3, entries: [item()] })).toEqual({
      state: { items: [] },
      shouldPersist: false,
      writable: false,
    })
  })

  it("requires current product price and fulfillment terms before ordering", () => {
    const cartItem = item({
      price: 2_500,
      priceSats: 2_500,
      format: "digital",
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
    })
    const product: Product = {
      id: cartItem.productId,
      pubkey: cartItem.merchantPubkey,
      title: cartItem.title,
      price: 2_500,
      priceSats: 2_500,
      currency: "SATS",
      type: "simple",
      format: "digital",
      visibility: "public",
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 2,
    }

    expect(cartItemsMatchCurrentProducts([cartItem], [product])).toBe(true)
    expect(
      cartItemsMatchCurrentProducts([cartItem], [{ ...product, price: 3_000 }])
    ).toBe(false)
    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [{ ...product, format: "physical" }]
      )
    ).toBe(false)
    expect(cartItemsMatchCurrentProducts([cartItem], [])).toBe(false)
  })

  it("binds refreshed variation identity before authorizing HUD checkout", () => {
    const familyProductId = "30402:merchant-a:shirt"
    const specifications = [{ key: "size", value: "M" }]
    const product = refreshedProduct(item(), {
      type: "variation",
      parentProductId: familyProductId,
      specifications,
      format: "digital",
    })
    const cartItem: CartItem = {
      ...createCartItemFromProduct(product),
      familyProductId,
      selectedSpecifications: specifications,
      quantity: 2,
    }

    expect(cartItemsMatchCurrentProducts([cartItem], [product])).toBe(true)
    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [{ ...product, parentProductId: "30402:merchant-a:other-shirt" }]
      )
    ).toBe(false)
    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [
          {
            ...product,
            specifications: [{ key: "size", value: "L" }],
          },
        ]
      )
    ).toBe(false)
    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [{ ...product, type: "simple", parentProductId: undefined }]
      )
    ).toBe(false)
  })

  it("compares pickup cart terms against freshly resolved fulfillment", () => {
    const fulfillment = pickupFulfillment()
    const baseItem = item({
      productId: fulfillment.product.coordinate,
      merchantPubkey: fulfillment.product.merchantPubkey,
    })
    const product = refreshedProduct(baseItem)
    const cartItem = {
      ...createCartItemFromProduct(product, fulfillment),
      quantity: 1,
    }
    const reorderedFulfillment: CartPickupFulfillment = {
      sourceCost: { ...fulfillment.sourceCost },
      costSats: fulfillment.costSats,
      handlerPubkey: fulfillment.handlerPubkey,
      handoffMode: fulfillment.handoffMode,
      option: { ...fulfillment.option },
      collection: { ...fulfillment.collection },
      calendar: { ...fulfillment.calendar },
      product: { ...fulfillment.product },
      organizerPubkey: fulfillment.organizerPubkey,
      type: "pickup",
    }

    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [product],
        new Map([[product.id, reorderedFulfillment]])
      )
    ).toBe(true)
    expect(getCartCommerceFingerprint([cartItem])).toBe(
      getCartCommerceFingerprint([
        { ...cartItem, fulfillment: reorderedFulfillment },
      ])
    )
  })

  it("ignores only quote-derived pickup sats when signed source terms match", () => {
    const storedFulfillment: CartPickupFulfillment = {
      ...pickupFulfillment(),
      costSats: 1_000,
      sourceCost: {
        amount: 1,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    }
    const baseItem = item({
      productId: storedFulfillment.product.coordinate,
      merchantPubkey: storedFulfillment.product.merchantPubkey,
    })
    const product = refreshedProduct(baseItem)
    const cartItem = {
      ...createCartItemFromProduct(product, storedFulfillment),
      quantity: 1,
    }
    const refreshedFulfillment: CartPickupFulfillment = {
      ...storedFulfillment,
      costSats: 2_000,
    }

    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [product],
        new Map([[product.id, refreshedFulfillment]])
      )
    ).toBe(true)
    expect(
      cartItemsMatchCurrentProducts(
        [cartItem],
        [product],
        new Map([
          [
            product.id,
            {
              ...refreshedFulfillment,
              sourceCost: {
                ...refreshedFulfillment.sourceCost,
                amount: 2,
              },
            },
          ],
        ])
      )
    ).toBe(false)

    const satsFulfillment: CartPickupFulfillment = {
      ...storedFulfillment,
      costSats: 1_000,
      sourceCost: {
        amount: 1_000,
        currency: "SATS",
        normalizedCurrency: "SATS",
      },
    }
    const satsItem = {
      ...createCartItemFromProduct(product, satsFulfillment),
      quantity: 1,
    }
    expect(
      cartItemsMatchCurrentProducts(
        [satsItem],
        [product],
        new Map([[product.id, { ...satsFulfillment, costSats: 2_000 }]])
      )
    ).toBe(false)
  })

  it("keeps pickup line identity stable only for fiat quote changes", () => {
    const initialFulfillment: CartPickupFulfillment = {
      ...pickupFulfillment(),
      costSats: 1_000,
      sourceCost: {
        amount: 1,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    }
    const refreshedFulfillment: CartPickupFulfillment = {
      ...initialFulfillment,
      costSats: 2_000,
    }
    const product = refreshedProduct(
      item({
        productId: initialFulfillment.product.coordinate,
        merchantPubkey: initialFulfillment.product.merchantPubkey,
      })
    )

    const initialItem = {
      ...createCartItemFromProduct(product, initialFulfillment),
      quantity: 1,
    }
    const refreshedItem = {
      ...createCartItemFromProduct(product, refreshedFulfillment),
      quantity: 2,
    }
    const combined = [refreshedItem]

    expect(isSameCartLineFulfillment(initialItem, refreshedItem)).toBe(true)
    expect(
      cartItemsMatchCurrentProducts(
        combined,
        [product],
        new Map([[product.id, refreshedFulfillment]])
      )
    ).toBe(true)

    const changedSignedCost = createCartItemFromProduct(product, {
      ...refreshedFulfillment,
      sourceCost: { ...refreshedFulfillment.sourceCost, amount: 2 },
    })
    expect(isSameCartLineFulfillment(initialItem, changedSignedCost)).toBe(
      false
    )

    for (const sourceCost of [
      { amount: 1_000, currency: "SATS", normalizedCurrency: "SATS" },
      { amount: 1_000_000, currency: "MSATS", normalizedCurrency: "MSATS" },
      { amount: 0.00001, currency: "BTC", normalizedCurrency: "BTC" },
      { amount: 0, currency: "USD", normalizedCurrency: "USD" },
    ]) {
      const deterministicFulfillment: CartPickupFulfillment = {
        ...initialFulfillment,
        costSats: 1_000,
        sourceCost,
      }
      const initialDeterministicItem = createCartItemFromProduct(
        product,
        deterministicFulfillment
      )
      const changedDeterministicCost = createCartItemFromProduct(product, {
        ...deterministicFulfillment,
        costSats: 2_000,
      })
      expect(
        isSameCartLineFulfillment(
          initialDeterministicItem,
          changedDeterministicCost
        )
      ).toBe(false)
    }
  })

  it("keeps refreshed availability merchant-scoped for legacy identifiers", () => {
    const cartItems = [
      item({ productId: "shared", merchantPubkey: "merchant-a", stock: 1 }),
      item({ productId: "shared", merchantPubkey: "merchant-b", stock: 1 }),
    ]
    const refreshedProduct: Product = {
      id: "shared",
      pubkey: "merchant-b",
      title: "Merchant B item",
      price: 1_000,
      currency: "SATS",
      type: "simple",
      format: "physical",
      visibility: "public",
      stock: 0,
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 2,
    }

    const availability = getCartProductAvailability(cartItems, [
      refreshedProduct,
    ])
    expect(availability).toMatchObject([
      { merchantPubkey: "merchant-a", status: "available", refreshed: false },
      { merchantPubkey: "merchant-b", status: "sold_out", refreshed: true },
    ])
  })

  it("preserves stock through persisted cart parsing", () => {
    expect(
      parsePersistedCart({
        version: 2,
        items: [item({ productId: "product-a", stock: 7 })],
      }).state.items[0]
    ).toMatchObject({ stock: 7 })
  })

  it("preserves canonical shipping authorization through persisted cart parsing", () => {
    const merchantPubkey = "a".repeat(64)
    const cartItem = item({
      productId: `30402:${merchantPubkey}:field-notes`,
      merchantPubkey,
      shippingOptionLaunchUnsupported: true,
      productUpdatedAt: 2_000,
      productEventId: "A".repeat(64),
      canonicalShippingResolved: true,
    })

    const parsed = parsePersistedCart({ version: 2, items: [cartItem] }).state
      .items[0]

    expect(parsed).toMatchObject({
      shippingOptionLaunchUnsupported: true,
      productUpdatedAt: 2_000,
      productEventId: "a".repeat(64),
      canonicalShippingResolved: true,
    })

    const malformed = parsePersistedCart({
      version: 2,
      items: [
        {
          ...cartItem,
          shippingOptionLaunchUnsupported: "true",
          productUpdatedAt: Number.NaN,
          productEventId: "not-an-event-id",
          canonicalShippingResolved: 1,
        },
      ],
    }).state.items[0]

    expect(malformed?.shippingOptionLaunchUnsupported).toBeUndefined()
    expect(malformed?.productUpdatedAt).toBeUndefined()
    expect(malformed?.productEventId).toBeUndefined()
    expect(malformed?.canonicalShippingResolved).toBeUndefined()
  })

  it("keeps fixed shipping ready after parsing a v2 persisted cart", () => {
    const merchantPubkey = "a".repeat(64)
    const productDTag = "field-notes"
    const shippingOptionId = `30406:${merchantPubkey}:${productDTag}-shipping-standard`
    const cartItem = item({
      productId: `30402:${merchantPubkey}:${productDTag}`,
      merchantPubkey,
      currency: "USD",
      format: "physical",
      shippingOptionId,
      shippingOptionDTag: `${productDTag}-shipping-standard`,
      shippingOptionLaunchUnsupported: false,
      productUpdatedAt: 2_000,
      canonicalShippingResolved: true,
    })
    const shippingOption: ParsedShippingOption = {
      eventId: "shipping-event",
      id: shippingOptionId,
      pubkey: merchantPubkey,
      dTag: `${productDTag}-shipping-standard`,
      title: "Standard Shipping",
      currency: "USD",
      price: 5,
      countries: ["US"],
      countryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: [],
        },
      ],
      service: "standard",
      createdAt: 2_000,
      launchUnsupportedTags: [],
    }

    const restoredItems = parsePersistedCart({
      version: 2,
      items: [cartItem],
    }).state.items
    const prepared = prepareCartFulfillment(restoredItems, [shippingOption])

    expect(prepared.resolutions.get(cartItem.productId)).toMatchObject({
      intent: "fixed_standard",
      status: "ready",
    })
    expect(prepared.items[0]).toMatchObject({
      shippingOptionId,
      productUpdatedAt: 2_000,
      canonicalShippingResolved: true,
    })
  })

  it("calculates item count and subtotal from cart items", () => {
    expect(
      getCartTotals([
        item({ quantity: 2, price: 1_000 }),
        item({
          productId: "30402:merchant-b:product-b",
          quantity: 3,
          priceSats: 4_000,
        }),
      ])
    ).toEqual({
      count: 5,
      subtotal: 14_000,
    })
  })

  it("keeps cart totals scoped to item prices before shipping details", () => {
    expect(
      getCartCostSummary([
        item({
          quantity: 2,
          priceSats: 100,
          shippingCostSats: 25,
          shippingOptionId: "30406:merchant-a:product-a-shipping-standard",
          canonicalShippingResolved: true,
          shippingCountryRules: [
            { code: "US", name: "United States", restrictTo: [], exclude: [] },
          ],
        }),
        item({
          productId: "30402:merchant-a:product-b",
          quantity: 1,
          priceSats: 500,
          shippingCostSats: 50,
          shippingOptionId: "30406:merchant-a:product-b-shipping-standard",
          canonicalShippingResolved: true,
          shippingCountryRules: [
            { code: "US", name: "United States", restrictTo: [], exclude: [] },
          ],
        }),
      ])
    ).toMatchObject({
      count: 3,
      itemSubtotalSats: 700,
      shippingTotalSats: 100,
      totalSats: 800,
      itemPricesAvailable: true,
      shippingReadyForZap: true,
    })
  })

  it("blocks cart-level zap-out readiness when physical shipping is not ready", () => {
    expect(
      getCartCostSummary([
        item({
          quantity: 2,
          priceSats: 100,
          shippingCostSats: undefined,
        }),
      ])
    ).toMatchObject({
      count: 2,
      itemSubtotalSats: 200,
      shippingTotalSats: 0,
      totalSats: 200,
      itemPricesAvailable: true,
      shippingReadyForZap: false,
    })
  })

  it("blocks cart-level zap-out readiness when a physical item has no shipping snapshot", () => {
    expect(
      getCartCostSummary([
        item({
          quantity: 2,
          priceSats: 100,
          shippingCostSats: 25,
        }),
      ])
    ).toMatchObject({
      count: 2,
      itemSubtotalSats: 200,
      shippingTotalSats: 0,
      totalSats: 200,
      itemPricesAvailable: true,
      shippingReadyForZap: false,
    })
  })

  it("rejects an unreferenced inline product shipping snapshot", () => {
    expect(
      getCartCostSummary([
        item({
          quantity: 2,
          priceSats: 100,
          shippingCostSats: 25,
          shippingOptionId: undefined,
          shippingCountryRules: [
            { code: "US", name: "United States", restrictTo: [], exclude: [] },
          ],
        }),
      ])
    ).toMatchObject({
      count: 2,
      itemSubtotalSats: 200,
      shippingTotalSats: 0,
      totalSats: 200,
      itemPricesAvailable: true,
      shippingReadyForZap: false,
    })
  })

  it("allows digital carts to be zap-ready without shipping data", () => {
    expect(
      getCartCostSummary([
        item({
          format: "digital",
          quantity: 1,
          priceSats: 100,
        }),
      ])
    ).toMatchObject({
      count: 1,
      itemSubtotalSats: 100,
      shippingTotalSats: 0,
      totalSats: 100,
      itemPricesAvailable: true,
      shippingReadyForZap: true,
    })
  })

  it("allows public zaps only when every cart item carries an allow policy", () => {
    expect(
      getCartPublicZapPolicy([
        item({
          publicZapEnabled: true,
          zapMessagePolicy: "custom",
          publicZapPolicyKnown: true,
        }),
        item({
          productId: "30402:merchant-a:product-b",
          publicZapEnabled: true,
          zapMessagePolicy: "custom",
          publicZapPolicyKnown: true,
        }),
      ])
    ).toEqual({
      publicZapsAllowed: true,
      effectiveZapMessagePolicy: "custom",
      disabledProductIds: [],
      missingPolicyProductIds: [],
    })
  })

  it("forces private checkout when any product disables public zaps", () => {
    expect(
      getCartPublicZapPolicy([
        item({
          publicZapEnabled: true,
          zapMessagePolicy: "custom",
          publicZapPolicyKnown: true,
        }),
        item({
          productId: "30402:merchant-a:private-product",
          publicZapEnabled: false,
          zapMessagePolicy: "custom",
          publicZapPolicyKnown: true,
        }),
      ])
    ).toEqual({
      publicZapsAllowed: false,
      effectiveZapMessagePolicy: "custom",
      disabledProductIds: ["30402:merchant-a:private-product"],
      missingPolicyProductIds: [],
    })
  })

  it("forces private checkout when stored cart metadata is missing", () => {
    expect(getCartPublicZapPolicy([item()])).toEqual({
      publicZapsAllowed: false,
      effectiveZapMessagePolicy: "generic_only",
      disabledProductIds: [],
      missingPolicyProductIds: ["30402:merchant-a:product-a"],
    })
  })

  it("uses the most restrictive public zap message policy across products", () => {
    expect(
      getCartPublicZapPolicy([
        item({
          productId: "30402:merchant-a:custom",
          publicZapEnabled: true,
          zapMessagePolicy: "custom",
          publicZapPolicyKnown: true,
        }),
        item({
          productId: "30402:merchant-a:generic",
          publicZapEnabled: true,
          zapMessagePolicy: "generic_only",
          publicZapPolicyKnown: true,
        }),
      ])
    ).toEqual({
      publicZapsAllowed: true,
      effectiveZapMessagePolicy: "generic_only",
      disabledProductIds: [],
      missingPolicyProductIds: [],
    })
  })

  it("treats legacy product cart policy as generic-only compatibility", () => {
    expect(
      getCartPublicZapPolicy([
        item({
          publicZapEnabled: true,
          zapMessagePolicy:
            "product" as unknown as CartItem["zapMessagePolicy"],
          publicZapPolicyKnown: true,
        }),
      ])
    ).toEqual({
      publicZapsAllowed: true,
      effectiveZapMessagePolicy: "generic_only",
      disabledProductIds: [],
      missingPolicyProductIds: [],
    })
  })
})

describe("getCartAvailabilityVerificationMessage", () => {
  const productId = "30402:merchant-a:product-a"

  it("returns null when every coordinate has an exact live match", () => {
    expect(
      getCartAvailabilityVerificationMessage([item()], {
        status: "verified_at_read",
        coverage: "complete",
      })
    ).toBeNull()
  })

  it("names the item for reference and listing problems", () => {
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("invalid_product_reference", [
          {
            productId,
            addressId: null,
            issue: "invalid_product_reference",
          },
        ])
      )
    ).toBe(
      "Notebook has an invalid product reference. Remove it from your cart and add it again."
    )
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("product_missing", [
          { productId, addressId: productId, issue: "product_missing" },
        ])
      )
    ).toBe(
      "Notebook could not be found on the configured relays. The listing may have been removed."
    )
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("listing_filtered", [
          { productId, addressId: productId, issue: "listing_filtered" },
        ])
      )
    ).toBe("Notebook is not publicly listed right now.")
  })

  it("asks for a retry on degraded lookups without advising relay changes", () => {
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("lookup_unavailable", [
          { productId, addressId: productId, issue: "lookup_unavailable" },
        ])
      )
    ).toBe(
      "Product availability could not be checked because no relay responded. Check your connection and try again."
    )
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("lookup_partial", [
          { productId, addressId: productId, issue: "lookup_partial" },
        ])
      )
    ).toBe(
      "Some relays did not respond, so availability for Notebook could not be confirmed. Try again."
    )
    expect(
      getCartAvailabilityVerificationMessage(
        [item()],
        unverifiedDecision("cached_only", [
          { productId, addressId: productId, issue: "cached_only" },
        ])
      )
    ).toBe(
      "Notebook was confirmed only from a local snapshot. Try again to verify current availability."
    )
  })

  it("surfaces the most actionable issue first for mixed failures", () => {
    const secondId = "30402:merchant-a:product-b"
    expect(
      getCartAvailabilityVerificationMessage(
        [item(), item({ productId: secondId, title: "Poster" })],
        unverifiedDecision("product_missing", [
          { productId, addressId: productId, issue: "lookup_partial" },
          {
            productId: secondId,
            addressId: secondId,
            issue: "product_missing",
          },
        ])
      )
    ).toBe(
      "Poster could not be found on the configured relays. The listing may have been removed."
    )
  })
})
