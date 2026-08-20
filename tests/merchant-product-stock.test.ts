import { describe, expect, it } from "bun:test"
import { EVENT_KINDS, type CommerceProductRecord } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  buildOrderStockAdjustments,
  getOrderStockAdjustmentForDisplay,
  getOrderStockDecisionKey,
  getProductFamilyStockDisplay,
  getProductStockDisplay,
  getProductStockInputError,
  isPlainStockInput,
  parseProductStockInput,
  PendingProductStockDeliveryStore,
  ProductStockDecisionStore,
  shouldShowOrderStockAdjustment,
} from "../apps/merchant/src/lib/productStock"

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function productRecord(
  overrides: Partial<CommerceProductRecord["product"]> = {}
): CommerceProductRecord {
  const pubkey = "a".repeat(64)
  const dTag = "pocket-relay"
  return {
    eventId: "b".repeat(64),
    addressId: `30402:${pubkey}:${dTag}`,
    dTag,
    eventCreatedAt: 1_700_000_000,
    product: {
      id: `30402:${pubkey}:${dTag}`,
      pubkey,
      title: "Pocket Relay",
      price: 25,
      currency: "USD",
      type: "simple",
      format: "physical",
      visibility: "public",
      stock: 12,
      images: [{ url: "https://example.com/pocket-relay.png" }],
      tags: ["relay", "hardware", "nostr"],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...overrides,
    },
  }
}

describe("merchant product stock", () => {
  it("parses blank stock as untracked and accepts non-negative integers", () => {
    expect(isPlainStockInput("")).toBe(true)
    expect(isPlainStockInput("120")).toBe(true)
    expect(isPlainStockInput("1.5")).toBe(false)
    expect(parseProductStockInput("")).toBeUndefined()
    expect(parseProductStockInput("0")).toBe(0)
    expect(parseProductStockInput("120")).toBe(120)
    expect(getProductStockInputError("1.5")).toContain("whole number")
    expect(() => parseProductStockInput("1.5")).toThrow("whole number")
  })

  it("provides distinct untracked, sold-out, low, and available summaries", () => {
    expect(getProductStockDisplay(undefined)).toEqual({
      label: "Stock not tracked",
      variant: "neutral",
    })
    expect(getProductStockDisplay(0)).toEqual({
      label: "Sold out",
      variant: "error",
    })
    expect(getProductStockDisplay(5)).toEqual({
      label: "5 left",
      variant: "warning",
    })
    expect(getProductStockDisplay(6)).toEqual({
      label: "6 in stock",
      variant: "success",
    })
    expect(
      getProductFamilyStockDisplay({
        tracking: "tracked",
        availability: "available",
        totalStock: 8,
      })
    ).toEqual({ label: "8 in stock", variant: "success" })
    expect(
      getProductFamilyStockDisplay({
        tracking: "partial",
        availability: "available",
      })
    ).toEqual({ label: "Partially tracked", variant: "warning" })
    expect(
      getProductFamilyStockDisplay({
        tracking: "untracked",
        availability: "unavailable",
      })
    ).toEqual({ label: "No purchasable variants", variant: "error" })
  })

  it("groups repeated order lines and calculates a non-negative decrement", () => {
    const record = productRecord()
    const adjustments = buildOrderStockAdjustments({
      orderId: "order-123",
      merchantPubkey: record.product.pubkey,
      items: [
        { productId: record.addressId, quantity: 1 },
        { productId: encodeURIComponent(record.addressId), quantity: 2 },
      ],
      productRecords: [record],
    })

    expect(adjustments).toHaveLength(1)
    expect(adjustments[0]).toMatchObject({
      state: "stock_update_available",
      quantity: 3,
      currentStock: 12,
      nextStock: 9,
      shortfall: 0,
      sourceEventId: record.eventId,
    })

    const oversold = buildOrderStockAdjustments({
      orderId: "order-456",
      merchantPubkey: record.product.pubkey,
      items: [{ productId: record.addressId, quantity: 15 }],
      productRecords: [record],
    })[0]
    expect(oversold).toMatchObject({
      state: "restocking_required",
      nextStock: 0,
      shortfall: 3,
    })
  })

  it("allows the final tracked unit to transition cleanly to sold out", () => {
    const record = productRecord({ stock: 1 })

    const adjustment = buildOrderStockAdjustments({
      orderId: "order-final-unit",
      merchantPubkey: record.product.pubkey,
      items: [{ productId: record.addressId, quantity: 1 }],
      productRecords: [record],
    })[0]

    expect(adjustment).toMatchObject({
      state: "stock_update_available",
      quantity: 1,
      currentStock: 1,
      nextStock: 0,
      shortfall: 0,
    })
  })

  it("decrements the exact variation child selected by the order", () => {
    const parentId = `30402:${"a".repeat(64)}:shirt`
    const variation = productRecord({
      id: `30402:${"a".repeat(64)}:shirt-large-blue`,
      type: "variation",
      parentProductId: parentId,
      specifications: [
        { key: "size", value: "Large" },
        { key: "color", value: "Blue" },
      ],
      stock: 3,
    })
    variation.addressId = variation.product.id
    variation.dTag = "shirt-large-blue"

    const adjustment = buildOrderStockAdjustments({
      orderId: "order-variation",
      merchantPubkey: variation.product.pubkey,
      items: [{ productId: variation.addressId, quantity: 2 }],
      productRecords: [variation],
    })[0]

    expect(adjustment).toMatchObject({
      addressId: variation.addressId,
      quantity: 2,
      currentStock: 3,
      nextStock: 1,
    })
  })

  it("keeps sold-out tracked listings visible as restocking required", () => {
    const record = productRecord()
    const build = (candidate: CommerceProductRecord) =>
      buildOrderStockAdjustments({
        orderId: "order-123",
        merchantPubkey: record.product.pubkey,
        items: [{ productId: candidate.addressId, quantity: 1 }],
        productRecords: [candidate],
      })

    expect(build(productRecord({ stock: undefined }))).toEqual([])
    expect(build(productRecord({ stock: 0 }))).toEqual([
      expect.objectContaining({
        state: "restocking_required",
        currentStock: 0,
        nextStock: 0,
        shortfall: 1,
      }),
    ])
    expect(build(productRecord({ pubkey: "c".repeat(64) }))).toEqual([])
    expect(build(productRecord({ type: "variable" }))).toEqual([])
  })

  it("does not build an automatic adjustment when grouped quantity overflows", () => {
    const record = productRecord()

    expect(
      buildOrderStockAdjustments({
        orderId: "order-overflow",
        merchantPubkey: record.product.pubkey,
        items: [
          { productId: record.addressId, quantity: Number.MAX_SAFE_INTEGER },
          { productId: record.addressId, quantity: Number.MAX_SAFE_INTEGER },
        ],
        productRecords: [record],
      })
    ).toEqual([])
  })

  it("suppresses legacy decisions and ends prompts for terminal orders", () => {
    const record = productRecord({ stock: 2 })
    const restocking = buildOrderStockAdjustments({
      orderId: "order-restock",
      merchantPubkey: record.product.pubkey,
      items: [{ productId: record.addressId, quantity: 5 }],
      productRecords: [record],
    })[0]!
    const regular = buildOrderStockAdjustments({
      orderId: "order-regular",
      merchantPubkey: record.product.pubkey,
      items: [{ productId: record.addressId, quantity: 1 }],
      productRecords: [record],
    })[0]!
    const applied = { kind: "applied" as const, decidedAt: 1 }
    const declined = { kind: "declined" as const, decidedAt: 1 }

    expect(
      shouldShowOrderStockAdjustment({
        adjustment: restocking,
        orderStatus: "processing",
        hasSessionDecision: false,
        persistedDecision: null,
      })
    ).toBe(true)
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: restocking,
        orderStatus: "processing",
        hasSessionDecision: false,
        persistedDecision: applied,
      })
    ).toBe(false)
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: regular,
        orderStatus: "processing",
        hasSessionDecision: true,
        persistedDecision: null,
      })
    ).toBe(false)
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: regular,
        orderStatus: "processing",
        hasSessionDecision: false,
        persistedDecision: declined,
      })
    ).toBe(false)

    for (const orderStatus of [
      "cancelled",
      "complete",
      "delivered",
      "refund_requested",
    ] as const) {
      expect(
        shouldShowOrderStockAdjustment({
          adjustment: restocking,
          orderStatus,
          hasSessionDecision: false,
          persistedDecision: null,
        })
      ).toBe(false)
    }
  })

  it("persists applied and declined decisions per merchant, order, and product", () => {
    const storage = new MemoryStorage()
    const first = new ProductStockDecisionStore(storage)
    const second = new ProductStockDecisionStore(storage)
    const merchant = "a".repeat(64)
    const address = `30402:${merchant}:pocket-relay`

    expect(first.get(merchant, "order-1", address)).toBeNull()
    expect(first.set(merchant, "order-1", address, "applied")).toBe(true)
    expect(second.get(merchant, "order-1", address)?.kind).toBe("applied")

    expect(first.set(merchant, "order-2", address, "declined")).toBe(true)
    expect(second.get(merchant, "order-2", address)?.kind).toBe("declined")
    expect(second.get(merchant, "order-3", address)).toBeNull()
  })

  it("rejects persisted stock snapshots bound to another product", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const orderId = "order-1"
    const adjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: productRecord().addressId, quantity: 1 }],
      productRecords: [productRecord()],
    })[0]!
    const otherAddress = `30402:${merchant}:other-product`
    const store = new ProductStockDecisionStore(storage)

    expect(() =>
      store.set(merchant, orderId, adjustment.addressId, "applied", {
        ...adjustment,
        addressId: otherAddress,
      })
    ).toThrow("Stock decision adjustment does not match the order product")

    expect(
      store.set(merchant, orderId, adjustment.addressId, "applied", adjustment)
    ).toBe(true)
    const storageKey = storage.key(0)!
    const stored = JSON.parse(storage.getItem(storageKey)!) as {
      decisions: Record<
        string,
        { adjustment: { addressId: string }; kind: string; decidedAt: number }
      >
    }
    stored.decisions[adjustment.key]!.adjustment.addressId = otherAddress
    storage.setItem(storageKey, JSON.stringify(stored))

    expect(
      new ProductStockDecisionStore(storage).get(
        merchant,
        orderId,
        adjustment.addressId
      )
    ).toBeNull()
  })

  it("preserves the original restocking outcome after an applied decrement", () => {
    const storage = new MemoryStorage()
    const store = new ProductStockDecisionStore(storage)
    const merchant = "a".repeat(64)

    const finalUnitRecord = productRecord({ stock: 1 })
    const finalUnit = buildOrderStockAdjustments({
      orderId: "order-final-unit",
      merchantPubkey: merchant,
      items: [{ productId: finalUnitRecord.addressId, quantity: 1 }],
      productRecords: [finalUnitRecord],
    })[0]!
    expect(
      store.set(
        merchant,
        "order-final-unit",
        finalUnit.addressId,
        "applied",
        finalUnit
      )
    ).toBe(true)
    const finalUnitAfterPublish = buildOrderStockAdjustments({
      orderId: "order-final-unit",
      merchantPubkey: merchant,
      items: [{ productId: finalUnitRecord.addressId, quantity: 1 }],
      productRecords: [productRecord({ stock: 0 })],
    })[0]!
    const finalUnitDecision = new ProductStockDecisionStore(storage).get(
      merchant,
      "order-final-unit",
      finalUnit.addressId
    )
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: finalUnitAfterPublish,
        orderStatus: "processing",
        hasSessionDecision: true,
        persistedDecision: finalUnitDecision,
      })
    ).toBe(false)

    const oversoldRecord = productRecord({ stock: 2 })
    const oversold = buildOrderStockAdjustments({
      orderId: "order-oversold",
      merchantPubkey: merchant,
      items: [{ productId: oversoldRecord.addressId, quantity: 5 }],
      productRecords: [oversoldRecord],
    })[0]!
    expect(
      store.set(
        merchant,
        "order-oversold",
        oversold.addressId,
        "applied",
        oversold
      )
    ).toBe(true)
    const oversoldAfterPublish = buildOrderStockAdjustments({
      orderId: "order-oversold",
      merchantPubkey: merchant,
      items: [{ productId: oversoldRecord.addressId, quantity: 5 }],
      productRecords: [productRecord({ stock: 0 })],
    })[0]!
    const oversoldDecision = new ProductStockDecisionStore(storage).get(
      merchant,
      "order-oversold",
      oversold.addressId
    )
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: oversoldAfterPublish,
        orderStatus: "processing",
        hasSessionDecision: true,
        persistedDecision: oversoldDecision,
      })
    ).toBe(true)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: oversoldAfterPublish,
        persistedDecision: oversoldDecision,
      })
    ).toMatchObject({ currentStock: 2, nextStock: 0, shortfall: 3 })
  })

  it("keeps a session decision when browser storage is unavailable", () => {
    const store = new ProductStockDecisionStore(null)
    const merchant = "a".repeat(64)
    const address = `30402:${merchant}:pocket-relay`

    expect(store.set(merchant, "order-1", address, "declined")).toBe(false)
    expect(store.get(merchant, "order-1", address)?.kind).toBe("declined")
  })

  it("restores the original pending oversold adjustment after reload", () => {
    const storage = new MemoryStorage()
    const secretKey = new Uint8Array(32).fill(3)
    const merchant = getPublicKey(secretKey)
    const dTag = "pending-stock-delivery"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const signedEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_001,
        content: "Pending stock update",
        tags: [
          ["d", dTag],
          ["title", "Pocket Relay"],
          ["price", "25", "USD"],
          ["stock", "0"],
        ],
      },
      secretKey
    )
    const adjustment = {
      key: getOrderStockDecisionKey("order-1", addressId),
      addressId,
      sourceEventId: "source-event",
      title: "Pocket Relay",
      state: "restocking_required" as const,
      quantity: 5,
      currentStock: 2,
      nextStock: 0,
      shortfall: 3,
    }

    const first = new PendingProductStockDeliveryStore(storage)
    expect(() =>
      first.set(merchant, {
        orderId: "order-1",
        adjustment: { ...adjustment, key: "not-canonical" },
        signedEvent,
      })
    ).toThrow("valid signed product stock delivery")
    expect(() =>
      first.set(merchant, {
        orderId: "order-1",
        adjustment: {
          ...adjustment,
          quantity: 4,
          shortfall: 1,
        },
        signedEvent,
      })
    ).toThrow("valid signed product stock delivery")
    expect(
      first.set(merchant, {
        orderId: "order-1",
        adjustment,
        signedEvent,
      })
    ).toBe(true)

    const storageKey = storage.key(0)
    expect(storageKey).not.toBeNull()
    const legacyStored = JSON.parse(storage.getItem(storageKey!)!) as {
      deliveries: Record<string, { adjustment: Record<string, unknown> }>
    }
    for (const delivery of Object.values(legacyStored.deliveries)) {
      delete delivery.adjustment.state
    }
    storage.setItem(storageKey!, JSON.stringify(legacyStored))

    const afterReload = new PendingProductStockDeliveryStore(storage)
    const restored = afterReload.getForOrder(merchant, "order-1")
    expect(restored).toHaveLength(1)
    expect(restored[0]?.orderId).toBe("order-1")
    expect(restored[0]?.adjustment).toEqual(adjustment)
    expect(restored[0]?.adjustment).toMatchObject({
      currentStock: 2,
      nextStock: 0,
      shortfall: 3,
    })
    expect(restored[0]?.signedEvent.id).toBe(signedEvent.id)
    expect(restored[0]?.signedEvent.pubkey).toBe(signedEvent.pubkey)

    const validStored = storage.getItem(storageKey!)!

    expect(afterReload.delete(merchant, "order-1", addressId)).toBe(true)
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-1"
      )
    ).toEqual([])

    const invalidOuterKey = JSON.parse(validStored) as {
      version: 1
      deliveries: Record<string, unknown>
    }
    const storedDelivery = Object.values(invalidOuterKey.deliveries)[0]
    invalidOuterKey.deliveries = { "not-canonical": storedDelivery }
    storage.setItem(storageKey!, JSON.stringify(invalidOuterKey))
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-1"
      )
    ).toEqual([])
  })
})
