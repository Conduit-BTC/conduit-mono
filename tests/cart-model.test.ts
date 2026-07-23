import { describe, expect, it } from "bun:test"
import {
  addCartItem,
  clearMerchantCart,
  getCartItemKey,
  getCartCostSummary,
  getCartPublicZapPolicy,
  getCartTotals,
  groupCartItems,
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

    expect(parsed.supported).toBe(true)
    expect(parsed.writable).toBe(true)
    expect(parsed.shouldPersist).toBe(true)
    expect(parsed.state.items).toHaveLength(2)
    expect(parsed.state.items[0]?.sourcePrice).toEqual({
      amount: 10,
      currency: "USD",
      normalizedCurrency: "USD",
    })
  })

  it("deduplicates only exact identities using the latest snapshot", () => {
    const parsed = parsePersistedCart({
      version: 2,
      items: [
        item({
          productId: "shared",
          merchantPubkey: "merchant-a",
          merchantAddedAt: 20,
          title: "Old title",
          quantity: 2,
        }),
        item({
          productId: "shared",
          merchantPubkey: "merchant-a",
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
          productId: "30402:merchant-a:product-a",
          merchantPubkey: "merchant-b",
        }),
        item({ quantity: Number.NaN }),
        item({ productId: "valid-legacy", quantity: 2.8 }),
      ],
    })

    expect(parsed.state.items).toMatchObject([
      { productId: "valid-legacy", quantity: 2 },
    ])
  })

  it("fails closed for malformed and unknown future storage versions", () => {
    expect(parsePersistedCart(null)).toEqual({
      state: { items: [] },
      shouldPersist: false,
      supported: false,
      writable: true,
    })
    expect(parsePersistedCart({ version: 3, items: [item()] })).toEqual({
      state: { items: [] },
      shouldPersist: false,
      supported: false,
      writable: false,
    })
    expect(parsePersistedCart({ version: 3, entries: [item()] })).toEqual({
      state: { items: [] },
      shouldPersist: false,
      supported: false,
      writable: false,
    })
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
