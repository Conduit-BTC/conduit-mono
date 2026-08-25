import { describe, expect, it } from "bun:test"
import type {
  Product,
  ProductAvailabilityDiagnostic,
  ProductAvailabilityIssue,
} from "@conduit/core"
import {
  addCartItem,
  cartItemsMatchCurrentProducts,
  clearMerchantCart,
  createCartItemFromProduct,
  getCartAvailabilityBlockingMessage,
  getCartItemStockForAvailability,
  getCartProductAvailability,
  getCartItemKey,
  getCartCostSummary,
  getCartPublicZapPolicy,
  getCartTotals,
  getProductAddAvailability,
  groupCartItems,
  getCartAvailabilityReadDecision,
  getCartAvailabilityVerificationMessage,
  isCartAvailabilityReadComplete,
  isCartProductAvailabilityBlocking,
  parsePersistedCart,
  removeCartItem,
  selectCartItem,
  selectCartItemQuantity,
  setCartItemQuantity,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

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
    let items = addCartItem(
      [],
      item({
        productId: "30402:merchant-a:product-a",
        merchantPubkey: "merchant-a",
        merchantAddedAt: 100,
      }),
      1
    )
    items = addCartItem(
      items,
      item({
        productId: "30402:merchant-b:product-b",
        merchantPubkey: "merchant-b",
        merchantAddedAt: 200,
      }),
      1
    )
    items = addCartItem(
      items,
      item({
        productId: "30402:merchant-a:product-c",
        merchantPubkey: "merchant-a",
        merchantAddedAt: 300,
      }),
      9
    )

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

    items = clearMerchantCart(items, "merchant-b")
    items = addCartItem(
      items,
      item({
        productId: "30402:merchant-b:product-d",
        merchantPubkey: "merchant-b",
        merchantAddedAt: 400,
      }),
      1
    )
    groups = groupCartItems(items)
    expect(groups.map((group) => group.merchantPubkey)).toEqual([
      "merchant-b",
      "merchant-a",
    ])
    expect(groups.map((group) => group.merchantAddedAt)).toEqual([400, 100])
  })

  it("adds new items and increments existing products", () => {
    const first = addCartItem([], item({ quantity: 0 }), 2)
    expect(first).toMatchObject([
      {
        productId: "30402:merchant-a:product-a",
        quantity: 2,
      },
    ])

    const second = addCartItem(
      first,
      item({ title: "Notebook updated", quantity: 0 }),
      3
    )

    expect(second).toMatchObject([
      {
        productId: "30402:merchant-a:product-a",
        title: "Notebook updated",
        quantity: 5,
      },
    ])
  })

  it("does not add a product whose stock snapshot is sold out", () => {
    const items = addCartItem([], item({ stock: 0, quantity: 0 }), 1)

    expect(items).toEqual([])
  })

  it("preserves product stock and shipping-shape safety when creating a cart item snapshot", () => {
    const product: Product = {
      id: "30402:merchant-a:sold-out-tee",
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
      shippingOptionLaunchUnsupported: true,
    })
  })

  it("flags an existing cart item when refreshed product stock reaches zero", () => {
    const cartItems = [item({ stock: 4 })]
    const refreshedProduct: Product = {
      id: cartItems[0]!.productId,
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
        refreshed: true,
      },
    ])

    const incrementedItems = addCartItem(
      cartItems,
      {
        productId: cartItems[0]!.productId,
        merchantPubkey: cartItems[0]!.merchantPubkey,
        title: cartItems[0]!.title,
        price: cartItems[0]!.price,
        currency: cartItems[0]!.currency,
        stock: getCartItemStockForAvailability(cartItems[0]!, availability[0]),
      },
      1
    )

    expect(incrementedItems[0]).toMatchObject({
      quantity: 2,
      stock: undefined,
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

    const items = addCartItem(addCartItem([], merchantA, 1), merchantB, 2)
    expect(items).toHaveLength(2)
    expect(
      selectCartItemQuantity(items, {
        merchantPubkey: "merchant-a",
        productId: "shared-product",
      })
    ).toBe(1)
    expect(
      selectCartItemQuantity(items, {
        merchantPubkey: "merchant-b",
        productId: "shared-product",
      })
    ).toBe(2)
    expect(getCartItemKey(merchantA)).not.toBe(getCartItemKey(merchantB))
  })

  it("mutates only the selected merchant-scoped line", () => {
    const items = [
      item({ productId: "shared", merchantPubkey: "merchant-a" }),
      item({ productId: "shared", merchantPubkey: "merchant-b", quantity: 2 }),
    ]
    const merchantB = { merchantPubkey: "merchant-b", productId: "shared" }
    const updated = setCartItemQuantity(items, merchantB, 5)

    expect(selectCartItem(updated, merchantB)?.quantity).toBe(5)
    expect(
      selectCartItem(updated, {
        merchantPubkey: "merchant-a",
        productId: "shared",
      })?.quantity
    ).toBe(1)
    expect(removeCartItem(updated, merchantB)).toMatchObject([
      { merchantPubkey: "merchant-a", productId: "shared" },
    ])
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

  it("does not add beyond finite tracked stock", () => {
    const current = [item({ stock: 2, quantity: 2 })]
    expect(addCartItem(current, item({ stock: 2 }), 1)).toBe(current)
    expect(addCartItem([], item({ stock: 2 }), 3)).toEqual([])
  })

  it("sets quantities, removes products, and clears one merchant", () => {
    const items = [
      item({ productId: "30402:merchant-a:product-a", merchantPubkey: "a" }),
      item({ productId: "30402:merchant-b:product-b", merchantPubkey: "b" }),
    ]

    expect(
      setCartItemQuantity(
        items,
        { merchantPubkey: "a", productId: "30402:merchant-a:product-a" },
        4
      )[0]?.quantity
    ).toBe(4)
    expect(
      removeCartItem(items, {
        merchantPubkey: "a",
        productId: "30402:merchant-a:product-a",
      })
    ).toHaveLength(1)
    expect(clearMerchantCart(items, "a")).toMatchObject([
      { productId: "30402:merchant-b:product-b" },
    ])
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
