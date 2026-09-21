import { describe, expect, it, spyOn } from "bun:test"
import * as core from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type {
  CommerceProductRecord,
  OrderSummary,
  ProductSchema,
} from "@conduit/core"
import { applyProductFulfillmentIntentForPublication } from "../apps/merchant/src/lib/product-publishing"
import { prepareOrderStockUpdate } from "../apps/merchant/src/lib/order-stock-fulfillment"
import {
  getOrderStockDecisionKey,
  type OrderStockAdjustment,
} from "../apps/merchant/src/lib/productStock"

const SYNTHETIC_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SYNTHETIC_SECRET)
const ORGANIZER = "b".repeat(64)
const ADDRESS = `30402:${MERCHANT}:event-item`
const PICKUP = `30406:${ORGANIZER}:event-pickup`
const COLLECTION = `30405:${ORGANIZER}:event`
const CATALOG_COLLECTION = `30405:${ORGANIZER}:independent-catalog`

function record(overrides: Partial<ProductSchema> = {}): CommerceProductRecord {
  return {
    addressId: ADDRESS,
    eventId: "9".repeat(64),
    dTag: "event-item",
    eventCreatedAt: 3_000,
    product: {
      id: ADDRESS,
      pubkey: MERCHANT,
      title: "Current item",
      price: 10,
      currency: "SATS",
      type: "simple",
      format: "physical",
      visibility: "private",
      images: [],
      tags: [],
      specifications: [],
      publicZapEnabled: false,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      stock: 5,
      collectionRefs: [COLLECTION],
      shippingOptionId: PICKUP,
      shippingOptionRefs: [
        { coordinate: PICKUP, relayHints: ["wss://relay.example"] },
      ],
      canonicalShippingResolved: false,
      createdAt: 1_000,
      updatedAt: 2_000,
      ...overrides,
    },
  }
}

function adjustment(
  overrides: Partial<OrderStockAdjustment> = {}
): OrderStockAdjustment {
  return {
    key: getOrderStockDecisionKey("order", ADDRESS),
    addressId: ADDRESS,
    sourceEventId: "1".repeat(64),
    title: "Old title",
    quantity: 3,
    currentStock: 10,
    nextStock: 7,
    shortfall: 0,
    ...overrides,
  }
}

function prepare(
  overrides: Partial<Parameters<typeof prepareOrderStockUpdate>[0]> = {}
) {
  return prepareOrderStockUpdate({
    merchantPubkey: MERCHANT,
    orderId: "order",
    items: [{ productId: ADDRESS, quantity: 3 }] as OrderSummary["items"],
    adjustment: adjustment(),
    record: record(),
    ...overrides,
  })
}

describe("merchant-owned order stock mutation", () => {
  it("rebases calculated stock onto the current local listing and preserves its exact fulfillment", () => {
    const baseline = record()
    const result = prepare({ record: baseline })
    expect(result.adjustment).toMatchObject({
      sourceEventId: baseline.eventId,
      title: "Current item",
      currentStock: 5,
      nextStock: 2,
      shortfall: 0,
    })
    expect(result.fulfillmentIntent).toEqual({
      kind: "preserve_existing",
      baseline: baseline.product,
    })
    expect(baseline.product.stock).toBe(5)
    expect(baseline.product.shippingOptionRefs).toEqual([
      { coordinate: PICKUP, relayHints: ["wss://relay.example"] },
    ])
  })

  it("does not contact unavailable organizer or shipping services for pickup, fixed, or digital stock", () => {
    const organizer = spyOn(core, "getEventMarket").mockRejectedValue(
      new Error("Organizer unavailable")
    )
    const shipping = spyOn(
      core,
      "getShippingOptionsByCoordinates"
    ).mockRejectedValue(new Error("Shipping unavailable"))
    try {
      for (const baseline of [
        record(),
        record({
          shippingOptionId: `30406:${MERCHANT}:standard`,
          collectionRefs: [],
        }),
        record({
          format: "digital",
          shippingOptionId: undefined,
          shippingOptionRefs: undefined,
          collectionRefs: [],
        }),
      ]) {
        expect(prepare({ record: baseline }).fulfillmentIntent).toEqual({
          kind: "preserve_existing",
          baseline: baseline.product,
        })
      }
      expect(organizer).not.toHaveBeenCalled()
      expect(shipping).not.toHaveBeenCalled()
    } finally {
      organizer.mockRestore()
      shipping.mockRestore()
    }
  })

  it("signs the rebased stock with unchanged event and pickup references", () => {
    const baseline = record()
    const prepared = prepare({ record: baseline })
    const product = applyProductFulfillmentIntentForPublication({
      merchantPubkey: MERCHANT,
      productDTag: baseline.dTag!,
      product: { ...baseline.product, stock: prepared.adjustment.nextStock },
      intent: prepared.fulfillmentIntent,
    })
    const before = core.buildProductListingEventDraft({
      product: baseline.product,
      dTag: baseline.dTag!,
    })
    const after = core.buildProductListingEventDraft({
      product,
      dTag: baseline.dTag!,
    })
    const signed = finalizeEvent(
      { ...after, created_at: 4_000 },
      SYNTHETIC_SECRET
    )
    expect(core.isValidSignedPublicNostrEvent(signed)).toBe(true)
    expect(after.tags.filter((tag) => tag[0] !== "stock")).toEqual(
      before.tags.filter((tag) => tag[0] !== "stock")
    )
    const parsed = core.parseProductEvent(signed)
    expect(parsed.stock).toBe(2)
    expect(parsed.collectionRefs).toEqual(baseline.product.collectionRefs)
    const previous = core.parseProductEvent(
      finalizeEvent({ ...before, created_at: 3_000 }, SYNTHETIC_SECRET)
    )
    expect(parsed.shippingOptionRefs).toEqual(previous.shippingOptionRefs)
  })

  it("preserves event pickup and independent catalog references during order stock updates", () => {
    const baseline = record({
      collectionRefs: [COLLECTION, CATALOG_COLLECTION],
    })
    const prepared = prepare({ record: baseline })
    const product = applyProductFulfillmentIntentForPublication({
      merchantPubkey: MERCHANT,
      productDTag: baseline.dTag!,
      product: { ...baseline.product, stock: prepared.adjustment.nextStock },
      intent: prepared.fulfillmentIntent,
    })
    const before = core.buildProductListingEventDraft({
      product: baseline.product,
      dTag: baseline.dTag!,
    })
    const after = core.buildProductListingEventDraft({
      product,
      dTag: baseline.dTag!,
    })
    const signed = finalizeEvent(
      { ...after, created_at: 4_000 },
      SYNTHETIC_SECRET
    )
    const parsed = core.parseProductEvent(signed)

    expect(core.isValidSignedPublicNostrEvent(signed)).toBe(true)
    expect(parsed.stock).toBe(2)
    expect(parsed.collectionRefs).toEqual([COLLECTION, CATALOG_COLLECTION])
    expect(parsed.shippingOptionId).toBe(PICKUP)
    expect(after.tags.filter(([name]) => name === "a")).toEqual(
      before.tags.filter(([name]) => name === "a")
    )
    expect(after.tags.filter(([name]) => name === "shipping_option")).toEqual(
      before.tags.filter(([name]) => name === "shipping_option")
    )
    expect(after.tags).toContainEqual(["visibility", "hidden"])
  })

  it("keeps a custom stock assertion while rebasing its source revision", () => {
    expect(
      prepare({
        adjustment: adjustment({ targetMode: "custom", nextStock: 12 }),
      }).adjustment
    ).toMatchObject({
      sourceEventId: "9".repeat(64),
      currentStock: 5,
      nextStock: 12,
      targetMode: "custom",
    })
  })

  it("applies only residual shortfall after a prior partial deduction and restock", () => {
    const prior = adjustment({ currentStock: 1, nextStock: 0, shortfall: 2 })
    expect(
      prepare({
        persistedDecision: { kind: "applied", decidedAt: 1, adjustment: prior },
        adjustment: adjustment({ quantity: 2, currentStock: 5, nextStock: 3 }),
      }).adjustment
    ).toMatchObject({
      quantity: 2,
      currentStock: 5,
      nextStock: 3,
      shortfall: 0,
    })
  })

  it("preserves variation identity and clamps shortages at zero", () => {
    expect(
      prepare({ record: record({ type: "variation", stock: 1 }) }).adjustment
    ).toMatchObject({ nextStock: 0, shortfall: 2 })
  })

  it("rejects missing stock, variable parents, changed ownership, and inconsistent coordinates", () => {
    for (const baseline of [
      record({ stock: undefined }),
      record({ stock: -1 }),
      record({ type: "variable" }),
      record({ pubkey: ORGANIZER }),
      record({ id: `30402:${MERCHANT}:other` }),
      { ...record(), dTag: "other" },
      { ...record(), addressId: `30402:${MERCHANT}:other` },
    ])
      expect(() => prepare({ record: baseline })).toThrow()
  })

  it("rejects order, target, decision-key, and quantity mismatches without trusting the payload", () => {
    for (const override of [
      { orderId: "other-order" },
      {
        items: [
          { productId: `30402:${MERCHANT}:other`, quantity: 3 },
        ] as OrderSummary["items"],
      },
      { adjustment: adjustment({ addressId: `30402:${MERCHANT}:other` }) },
      { adjustment: adjustment({ key: "wrong-key" }) },
      { adjustment: adjustment({ quantity: 4 }) },
      { adjustment: adjustment({ nextStock: -1 }) },
      { adjustment: adjustment({ nextStock: Number.MAX_SAFE_INTEGER + 1 }) },
    ])
      expect(() => prepare(override)).toThrow()
  })

  it("uses the current product fulfillment even when an order carries an obsolete pickup snapshot", () => {
    const baseline = record({
      collectionRefs: [],
      shippingOptionId: `30406:${MERCHANT}:current`,
      shippingOptionRefs: [{ coordinate: `30406:${MERCHANT}:current` }],
    })
    const items = [
      {
        productId: ADDRESS,
        quantity: 3,
        fulfillment: {
          type: "pickup",
          product: { coordinate: `30402:${ORGANIZER}:wrong` },
        },
      },
    ] as OrderSummary["items"]
    expect(prepare({ record: baseline, items }).fulfillmentIntent).toEqual({
      kind: "preserve_existing",
      baseline: baseline.product,
    })
  })
})
