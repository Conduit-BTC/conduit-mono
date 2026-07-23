import { describe, expect, it } from "bun:test"
import {
  addCartItem,
  clearMerchantCart,
  createCartItemFromProduct,
  getCartAvailabilityBlockingMessage,
  getCartItemStockForAvailability,
  getCartProductAvailability,
  getCartCostSummary,
  getCartPublicZapPolicy,
  getCartTotals,
  groupCartItems,
  isCartAvailabilityReadFresh,
  isCartProductAvailabilityBlocking,
  removeCartItem,
  setCartItemQuantity,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import type { Product } from "@conduit/core"

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

describe("cart model", () => {
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

  it("preserves product stock when creating a cart item snapshot", () => {
    const product: Product = {
      id: "30402:merchant-a:sold-out-tee",
      pubkey: "merchant-a",
      title: "Sold Out Tee",
      price: 2_500,
      currency: "SATS",
      type: "simple",
      format: "physical",
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

  it("requires a fresh complete commerce read before checkout can proceed", () => {
    const cartItems = [item({ stock: 2 })]
    const refreshedProduct: Product = {
      id: cartItems[0]!.productId,
      pubkey: cartItems[0]!.merchantPubkey,
      title: cartItems[0]!.title,
      price: cartItems[0]!.price,
      currency: cartItems[0]!.currency,
      type: "simple",
      format: "physical",
      visibility: "public",
      stock: 2,
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 3,
    }
    const refreshedAvailability = getCartProductAvailability(cartItems, [
      refreshedProduct,
    ])
    const freshMeta = {
      source: "commerce" as const,
      stale: false,
      degraded: false,
    }

    expect(isCartAvailabilityReadFresh(refreshedAvailability, freshMeta)).toBe(
      true
    )
    expect(
      isCartAvailabilityReadFresh(refreshedAvailability, {
        source: "local_cache",
        stale: true,
        degraded: true,
      })
    ).toBe(false)
    expect(
      isCartAvailabilityReadFresh(refreshedAvailability, {
        ...freshMeta,
        degraded: true,
      })
    ).toBe(false)
    expect(
      isCartAvailabilityReadFresh(
        getCartProductAvailability(cartItems, []),
        freshMeta
      )
    ).toBe(false)
  })

  it("sets quantities, removes products, and clears one merchant", () => {
    const items = [
      item({ productId: "30402:merchant-a:product-a", merchantPubkey: "a" }),
      item({ productId: "30402:merchant-b:product-b", merchantPubkey: "b" }),
    ]

    expect(
      setCartItemQuantity(items, "30402:merchant-a:product-a", 4)[0]?.quantity
    ).toBe(4)
    expect(removeCartItem(items, "30402:merchant-a:product-a")).toHaveLength(1)
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
          shippingOptionId: "standard",
          shippingCountryRules: [
            { code: "US", name: "United States", restrictTo: [], exclude: [] },
          ],
        }),
        item({
          productId: "30402:merchant-a:product-b",
          quantity: 1,
          priceSats: 500,
          shippingCostSats: 50,
          shippingOptionId: "standard",
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
      canZapOut: true,
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
      canZapOut: false,
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
      canZapOut: false,
    })
  })

  it("accepts a product shipping snapshot without a preset reference", () => {
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
      shippingTotalSats: 50,
      totalSats: 250,
      itemPricesAvailable: true,
      shippingReadyForZap: true,
      canZapOut: true,
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
      canZapOut: true,
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
