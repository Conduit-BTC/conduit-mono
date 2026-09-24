import { describe, expect, it, spyOn } from "bun:test"
import { EVENT_KINDS, type CommerceProductRecord } from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  applyOrderStockTarget,
  buildOrderStockAdjustments,
  checkpointSignedOrderStockDelivery,
  confirmExactPendingStockDelivery,
  doesOrderStockDecisionCoverAdjustment,
  getOrderStockAdjustmentForDisplay,
  getOrderStockDecisionKey,
  getUnpublishedOrderStockRepublishAdjustment,
  getProductFamilyStockDisplay,
  getProductStockDisplay,
  getProductStockInputError,
  isOrderStockAdjustmentMutationDisabled,
  isPlainStockInput,
  parseProductStockInput,
  PendingProductStockDeliveryStore,
  ProductStockDecisionStore,
  settleSignedOrderStockDelivery,
  shouldShowOrderStockAdjustment,
  withMerchantStockLock,
  type MerchantStockLockRequest,
} from "../apps/merchant/src/lib/productStock"

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  failWrites = false
  dropWrites = false

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
    if (this.failWrites) throw new Error("storage unavailable")
    if (this.dropWrites) return
    this.values.set(key, value)
  }
}

class TestMerchantStockLocks {
  private readonly queues = new Map<string, Promise<void>>()

  request: MerchantStockLockRequest = async <T>(
    name: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const previous = this.queues.get(name) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.queues.set(
      name,
      previous.then(() => current)
    )
    await previous
    try {
      return await task()
    } finally {
      release()
    }
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

  it("retains a prior durable decision when its same-key replacement fails to persist", () => {
    const storage = new MemoryStorage()
    const store = new ProductStockDecisionStore(storage)
    const merchant = "a".repeat(64)
    const address = `30402:${merchant}:pocket-relay`

    expect(
      store.set(merchant, "order-1", address, "applied", undefined, undefined, {
        requireDurable: true,
      })
    ).toBe(true)
    storage.failWrites = true
    expect(
      store.set(
        merchant,
        "order-1",
        address,
        "declined",
        undefined,
        undefined,
        {
          requireDurable: true,
        }
      )
    ).toBe(false)
    storage.failWrites = false
    storage.dropWrites = true
    expect(
      store.set(
        merchant,
        "order-1",
        address,
        "declined",
        undefined,
        undefined,
        {
          requireDurable: true,
        }
      )
    ).toBe(false)

    expect(store.get(merchant, "order-1", address)?.kind).toBe("applied")
    expect(
      new ProductStockDecisionStore(storage).get(merchant, "order-1", address)
        ?.kind
    ).toBe("applied")
  })

  it("durably records the exact applied and unpublished stock outcomes", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const record = productRecord()
    const adjustment = buildOrderStockAdjustments({
      orderId: "order-applied",
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 2 }],
      productRecords: [record],
    })[0]!
    const unpublishedAdjustment = buildOrderStockAdjustments({
      orderId: "order-unpublished",
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 2 }],
      productRecords: [record],
    })[0]!
    const store = new ProductStockDecisionStore(storage)

    expect(
      store.set(
        merchant,
        "order-applied",
        adjustment.addressId,
        "applied",
        adjustment,
        undefined,
        { requireDurable: true }
      )
    ).toBe(true)
    expect(
      store.set(
        merchant,
        "order-unpublished",
        unpublishedAdjustment.addressId,
        "unpublished",
        unpublishedAdjustment,
        "c".repeat(64),
        { requireDurable: true }
      )
    ).toBe(true)

    const afterReload = new ProductStockDecisionStore(storage)
    expect(
      afterReload.get(merchant, "order-applied", adjustment.addressId)
    ).toMatchObject({ kind: "applied", adjustment })
    expect(
      afterReload.get(
        merchant,
        "order-unpublished",
        unpublishedAdjustment.addressId
      )
    ).toMatchObject({
      kind: "unpublished",
      adjustment: unpublishedAdjustment,
      localEventId: "c".repeat(64),
    })
  })

  it("fails closed without evicting an order decision when durable storage is full", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const address = `30402:${merchant}:pocket-relay`
    const store = new ProductStockDecisionStore(storage)
    expect(
      store.set(merchant, "order-0", address, "applied", undefined, undefined, {
        requireDurable: true,
      })
    ).toBe(true)

    const storageKey = storage.key(0)!
    const fixedTime = 1_700_000_000_000
    const decisions: Record<string, unknown> = {}
    for (let index = 0; index < 500; index += 1) {
      decisions[getOrderStockDecisionKey(`order-${index}`, address)] = {
        kind: "applied",
        decidedAt: fixedTime,
      }
    }
    storage.setItem(storageKey, JSON.stringify({ version: 1, decisions }))

    const clock = spyOn(Date, "now").mockReturnValue(fixedTime)
    try {
      expect(
        store.set(
          merchant,
          "order-500",
          address,
          "applied",
          undefined,
          undefined,
          { requireDurable: true }
        )
      ).toBe(false)
    } finally {
      clock.mockRestore()
    }

    const afterReload = new ProductStockDecisionStore(storage)
    expect(afterReload.get(merchant, "order-500", address)).toBeNull()
    expect(afterReload.get(merchant, "order-0", address)?.kind).toBe("applied")
    const retained = JSON.parse(storage.getItem(storageKey)!) as {
      decisions: Record<string, unknown>
    }
    expect(Object.keys(retained.decisions)).toHaveLength(500)
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
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: oversoldAfterPublish,
        persistedDecision: oversoldDecision,
      })
    ).toBe(true)
  })

  it("persists all-relay rejection as unpublished and re-signs only the already-applied local stock", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const orderId = "order-rejected"
    const original = productRecord({ stock: 12 })
    const adjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: original.addressId, quantity: 2 }],
      productRecords: [original],
    })[0]!
    const rejectedEventId = "c".repeat(64)
    const store = new ProductStockDecisionStore(storage)
    expect(
      store.set(
        merchant,
        orderId,
        adjustment.addressId,
        "unpublished",
        adjustment,
        rejectedEventId
      )
    ).toBe(true)

    const afterReload = new ProductStockDecisionStore(storage)
    const decision = afterReload.get(merchant, orderId, adjustment.addressId)
    expect(decision).toMatchObject({
      kind: "unpublished",
      adjustment,
      localEventId: rejectedEventId,
    })
    const local = {
      ...original,
      eventId: rejectedEventId,
      product: { ...original.product, stock: adjustment.nextStock },
    }
    const current = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: original.addressId, quantity: 2 }],
      productRecords: [local],
    })[0]!
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: current,
        orderStatus: "complete",
        hasSessionDecision: false,
        persistedDecision: decision,
      })
    ).toBe(true)
    expect(
      isOrderStockAdjustmentMutationDisabled({
        adjustment: current,
        persistedDecision: decision,
        hasPendingDelivery: false,
        hasSessionDecision: false,
      })
    ).toBe(true)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: current,
        persistedDecision: decision,
      })
    ).toEqual(adjustment)
    expect(
      getUnpublishedOrderStockRepublishAdjustment({
        adjustment,
        persistedDecision: decision,
        record: local,
      })
    ).toEqual(adjustment)
    expect(() =>
      getUnpublishedOrderStockRepublishAdjustment({
        adjustment,
        persistedDecision: decision,
        record: { ...local, eventId: "d".repeat(64) },
      })
    ).toThrow("no longer current")
    expect(() =>
      getUnpublishedOrderStockRepublishAdjustment({
        adjustment,
        persistedDecision: decision,
        record: {
          ...local,
          product: { ...local.product, stock: 8 },
        },
      })
    ).toThrow("no longer current")

    expect(
      afterReload.set(
        merchant,
        orderId,
        adjustment.addressId,
        "applied",
        adjustment
      )
    ).toBe(true)
    expect(
      new ProductStockDecisionStore(storage).get(
        merchant,
        orderId,
        adjustment.addressId
      )
    ).toMatchObject({ kind: "applied", adjustment })
  })

  it("fails closed on malformed unpublished decisions after reload", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const record = productRecord()
    const adjustment = buildOrderStockAdjustments({
      orderId: "order-1",
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 1 }],
      productRecords: [record],
    })[0]!
    const store = new ProductStockDecisionStore(storage)
    expect(() =>
      store.set(
        merchant,
        "order-1",
        record.addressId,
        "unpublished",
        adjustment
      )
    ).toThrow("exact local revision")
    store.set(
      merchant,
      "order-1",
      record.addressId,
      "unpublished",
      adjustment,
      "c".repeat(64)
    )
    const key = storage.key(0)!
    const data = JSON.parse(storage.getItem(key)!) as {
      decisions: Record<string, { localEventId?: string }>
    }
    delete data.decisions[adjustment.key]!.localEventId
    storage.setItem(key, JSON.stringify(data))
    expect(
      new ProductStockDecisionStore(storage).get(
        merchant,
        "order-1",
        record.addressId
      )
    ).toBeNull()
  })

  it("applies only the unresolved shortfall after restocking", () => {
    const merchant = "a".repeat(64)
    const orderId = "order-replenished"
    const oversoldRecord = productRecord({ stock: 2 })
    const oversold = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: oversoldRecord.addressId, quantity: 5 }],
      productRecords: [oversoldRecord],
    })[0]!
    const persistedDecision = {
      kind: "applied" as const,
      decidedAt: 1,
      adjustment: oversold,
    }

    for (const expected of [
      {
        stock: 2,
        eventId: "c".repeat(64),
        nextStock: 0,
        shortfall: 1,
      },
      {
        stock: 3,
        eventId: "d".repeat(64),
        nextStock: 0,
        shortfall: 0,
      },
      {
        stock: 10,
        eventId: "e".repeat(64),
        nextStock: 7,
        shortfall: 0,
      },
    ] as const) {
      const replenishedRecord = {
        ...productRecord({ stock: expected.stock }),
        eventId: expected.eventId,
      }
      const replenished = buildOrderStockAdjustments({
        orderId,
        merchantPubkey: merchant,
        items: [{ productId: replenishedRecord.addressId, quantity: 5 }],
        productRecords: [replenishedRecord],
      })[0]!
      const followUp = getOrderStockAdjustmentForDisplay({
        adjustment: replenished,
        persistedDecision,
      })

      expect(
        doesOrderStockDecisionCoverAdjustment({
          adjustment: replenished,
          persistedDecision,
        })
      ).toBe(false)
      expect(followUp).toMatchObject({
        sourceEventId: expected.eventId,
        quantity: 3,
        currentStock: expected.stock,
        nextStock: expected.nextStock,
        shortfall: expected.shortfall,
      })
      expect(
        shouldShowOrderStockAdjustment({
          adjustment: replenished,
          orderStatus: "processing",
          hasSessionDecision: false,
          persistedDecision,
        })
      ).toBe(true)
    }

    const ampleRecord = {
      ...productRecord({ stock: 10 }),
      eventId: "e".repeat(64),
    }
    const ample = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: ampleRecord.addressId, quantity: 5 }],
      productRecords: [ampleRecord],
    })[0]!
    expect(
      isOrderStockAdjustmentMutationDisabled({
        adjustment: ample,
        persistedDecision,
        hasPendingDelivery: false,
        hasSessionDecision: false,
      })
    ).toBe(false)
    expect(
      isOrderStockAdjustmentMutationDisabled({
        adjustment: ample,
        persistedDecision,
        hasPendingDelivery: false,
        hasSessionDecision: true,
      })
    ).toBe(true)
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: ample,
        orderStatus: "processing",
        hasSessionDecision: true,
        persistedDecision,
      })
    ).toBe(false)

    const partialRecord = {
      ...productRecord({ stock: 2 }),
      eventId: "c".repeat(64),
    }
    const partial = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: partialRecord.addressId, quantity: 5 }],
      productRecords: [partialRecord],
    })[0]!
    const partialFollowUp = getOrderStockAdjustmentForDisplay({
      adjustment: partial,
      persistedDecision,
    })
    const residualDecision = {
      kind: "applied" as const,
      decidedAt: 2,
      adjustment: partialFollowUp,
    }
    const afterResidualPublish = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: partialRecord.addressId, quantity: 5 }],
      productRecords: [
        {
          ...productRecord({ stock: 0 }),
          eventId: "f".repeat(64),
        },
      ],
    })[0]!
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: afterResidualPublish,
        persistedDecision: residualDecision,
      })
    ).toBe(true)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: afterResidualPublish,
        persistedDecision: residualDecision,
      })
    ).toMatchObject({
      quantity: 3,
      currentStock: 2,
      nextStock: 0,
      shortfall: 1,
    })

    const secondRestockRecord = {
      ...productRecord({ stock: 5 }),
      eventId: "1".repeat(64),
    }
    const secondRestock = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: secondRestockRecord.addressId, quantity: 5 }],
      productRecords: [secondRestockRecord],
    })[0]!
    const finalFollowUp = getOrderStockAdjustmentForDisplay({
      adjustment: secondRestock,
      persistedDecision: residualDecision,
    })
    expect(finalFollowUp).toMatchObject({
      sourceEventId: secondRestockRecord.eventId,
      quantity: 1,
      currentStock: 5,
      nextStock: 4,
      shortfall: 0,
    })
    const completedResidualDecision = {
      kind: "applied" as const,
      decidedAt: 3,
      adjustment: finalFollowUp,
    }
    const afterFinalPublish = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: secondRestockRecord.addressId, quantity: 5 }],
      productRecords: [
        {
          ...productRecord({ stock: 4 }),
          eventId: "2".repeat(64),
        },
      ],
    })[0]!
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: afterFinalPublish,
        persistedDecision: completedResidualDecision,
      })
    ).toBe(true)

    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: ample,
        persistedDecision: { ...persistedDecision, kind: "declined" },
      })
    ).toBe(true)
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: ample,
        persistedDecision: { kind: "applied", decidedAt: 3 },
      })
    ).toBe(true)
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: ample,
        persistedDecision: { kind: "declined", decidedAt: 3 },
      })
    ).toBe(true)
  })

  it("preserves calculated and custom target intent when both publish the same stock", () => {
    const merchant = "a".repeat(64)
    const orderId = "order-matching-custom-stock"
    const record = productRecord({ stock: 2 })
    const adjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 5 }],
      productRecords: [record],
    })[0]!

    const calculated = applyOrderStockTarget(
      adjustment,
      adjustment.nextStock,
      "calculated"
    )
    const custom = applyOrderStockTarget(
      adjustment,
      adjustment.nextStock,
      "custom"
    )

    expect(calculated).toBe(adjustment)
    expect(calculated.targetMode).toBeUndefined()
    expect(custom).toMatchObject({
      nextStock: 0,
      targetMode: "custom",
    })

    const storage = new MemoryStorage()
    const store = new ProductStockDecisionStore(storage)
    expect(
      store.set(merchant, orderId, custom.addressId, "applied", custom)
    ).toBe(true)
    const restoredCustomDecision = new ProductStockDecisionStore(storage).get(
      merchant,
      orderId,
      custom.addressId
    )
    const replenishedRecord = {
      ...productRecord({ stock: 10 }),
      eventId: "f".repeat(64),
    }
    const afterRestock = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: replenishedRecord.addressId, quantity: 5 }],
      productRecords: [replenishedRecord],
    })[0]!

    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: afterRestock,
        persistedDecision: restoredCustomDecision,
      })
    ).toBe(true)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: afterRestock,
        persistedDecision: restoredCustomDecision,
      })
    ).toBe(afterRestock)

    const calculatedDecision = {
      kind: "applied" as const,
      decidedAt: 1,
      adjustment: calculated,
    }
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: afterRestock,
        persistedDecision: calculatedDecision,
      })
    ).toBe(false)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: afterRestock,
        persistedDecision: calculatedDecision,
      })
    ).toMatchObject({
      quantity: 3,
      currentStock: 10,
      nextStock: 7,
      shortfall: 0,
    })
  })

  it("treats a custom published stock value as the merchant's final assertion", () => {
    const storage = new MemoryStorage()
    const merchant = "a".repeat(64)
    const orderId = "order-custom-stock"
    const record = productRecord({ stock: 5 })
    const adjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 2 }],
      productRecords: [record],
    })[0]!
    const custom = applyOrderStockTarget(adjustment, 4, "custom")

    expect(custom).toMatchObject({
      currentStock: 5,
      nextStock: 4,
      targetMode: "custom",
    })

    const store = new ProductStockDecisionStore(storage)
    expect(
      store.set(merchant, orderId, custom.addressId, "applied", custom)
    ).toBe(true)
    const persistedDecision = new ProductStockDecisionStore(storage).get(
      merchant,
      orderId,
      custom.addressId
    )
    expect(persistedDecision?.adjustment).toEqual(custom)

    const laterRecord = {
      ...productRecord({ stock: 10 }),
      eventId: "f".repeat(64),
    }
    const laterAdjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: laterRecord.addressId, quantity: 2 }],
      productRecords: [laterRecord],
    })[0]!
    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: laterAdjustment,
        persistedDecision,
      })
    ).toBe(true)
  })

  it("dismisses an oversold custom assertion after delivery", () => {
    const merchant = "a".repeat(64)
    const orderId = "order-custom-oversold-stock"
    const record = productRecord({ stock: 2 })
    const adjustment = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: record.addressId, quantity: 5 }],
      productRecords: [record],
    })[0]!
    const custom = applyOrderStockTarget(adjustment, 1, "custom")
    const persistedDecision = {
      kind: "applied" as const,
      decidedAt: 1,
      adjustment: custom,
    }
    const deliveredRecord = {
      ...productRecord({ stock: 1 }),
      eventId: "f".repeat(64),
    }
    const afterDelivery = buildOrderStockAdjustments({
      orderId,
      merchantPubkey: merchant,
      items: [{ productId: deliveredRecord.addressId, quantity: 5 }],
      productRecords: [deliveredRecord],
    })[0]!

    expect(
      doesOrderStockDecisionCoverAdjustment({
        adjustment: afterDelivery,
        persistedDecision,
      })
    ).toBe(true)
    expect(
      shouldShowOrderStockAdjustment({
        adjustment: afterDelivery,
        orderStatus: "processing",
        hasSessionDecision: false,
        persistedDecision,
      })
    ).toBe(false)
    expect(
      getOrderStockAdjustmentForDisplay({
        adjustment: afterDelivery,
        persistedDecision,
      })
    ).toBe(afterDelivery)
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
    const previewStored = JSON.parse(storage.getItem(storageKey!)!) as {
      deliveries: Record<string, { adjustment: Record<string, unknown> }>
    }
    for (const delivery of Object.values(previewStored.deliveries)) {
      delivery.adjustment.state = "restocking_required"
    }
    storage.setItem(storageKey!, JSON.stringify(previewStored))

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

  it("does not replace a prior durable stock checkpoint when a later same-key write fails", () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const dTag = "durable-stock-checkpoint"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const signStock = (createdAt: number) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRODUCT,
          created_at: createdAt,
          content: "Stock update",
          tags: [
            ["d", dTag],
            ["title", "Pocket Relay"],
            ["price", "25", "USD"],
            ["stock", "3"],
          ],
        },
        secretKey
      )
    const original = signStock(1_700_000_001)
    const replacement = signStock(1_700_000_002)
    const adjustment = {
      key: getOrderStockDecisionKey("order-1", addressId),
      addressId,
      sourceEventId: "source-event",
      title: "Pocket Relay",
      quantity: 2,
      currentStock: 5,
      nextStock: 3,
      shortfall: 0,
    }
    const store = new PendingProductStockDeliveryStore(storage)
    expect(
      store.set(
        merchant,
        { orderId: "order-1", adjustment, signedEvent: original },
        { requireDurable: true }
      )
    ).toBe(true)

    storage.failWrites = true
    expect(
      store.set(
        merchant,
        { orderId: "order-1", adjustment, signedEvent: replacement },
        { requireDurable: true }
      )
    ).toBe(false)
    storage.failWrites = false
    storage.dropWrites = true
    expect(
      store.set(
        merchant,
        { orderId: "order-1", adjustment, signedEvent: replacement },
        { requireDurable: true }
      )
    ).toBe(false)
    expect(store.getForOrder(merchant, "order-1")[0]?.signedEvent.id).toBe(
      original.id
    )
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-1"
      )[0]?.signedEvent.id
    ).toBe(original.id)
  })

  it("fails closed without evicting another order when the durable checkpoint store is full in the same millisecond", () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const dTag = "durable-stock-cap"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const signedEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_001,
        content: "Stock update",
        tags: [
          ["d", dTag],
          ["title", "Pocket Relay"],
          ["price", "25", "USD"],
          ["stock", "3"],
        ],
      },
      secretKey
    )
    const store = new PendingProductStockDeliveryStore(storage)
    const fixedTime = 1_700_000_000_000
    const deliveryFor = (orderId: string) => ({
      orderId,
      adjustment: {
        key: getOrderStockDecisionKey(orderId, addressId),
        addressId,
        sourceEventId: "source-event",
        title: "Pocket Relay",
        quantity: 2,
        currentStock: 5,
        nextStock: 3,
        shortfall: 0,
      },
      signedEvent,
    })
    expect(
      store.set(merchant, deliveryFor("order-0"), { requireDurable: true })
    ).toBe(true)
    const storageKey = storage.key(0)!
    const deliveries: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) {
      const delivery = deliveryFor(`order-${index}`)
      deliveries[delivery.adjustment.key] = { ...delivery, savedAt: fixedTime }
    }
    storage.setItem(storageKey, JSON.stringify({ version: 1, deliveries }))

    const clock = spyOn(Date, "now").mockReturnValue(fixedTime)
    try {
      expect(
        store.set(merchant, deliveryFor("order-100"), {
          requireDurable: true,
        })
      ).toBe(false)
    } finally {
      clock.mockRestore()
    }

    const afterReload = new PendingProductStockDeliveryStore(storage)
    expect(afterReload.getForOrder(merchant, "order-100")).toEqual([])
    expect(
      afterReload.getForOrder(merchant, "order-0")[0]?.signedEvent.id
    ).toBe(signedEvent.id)
    const retained = JSON.parse(storage.getItem(storageKey)!) as {
      deliveries: Record<string, unknown>
    }
    expect(Object.keys(retained.deliveries)).toHaveLength(100)
  })

  it("serializes two tabs so distinct products survive and a second order cannot stage the same product", async () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const locks = new TestMerchantStockLocks()
    const pendingA = new PendingProductStockDeliveryStore(storage)
    const pendingB = new PendingProductStockDeliveryStore(storage)
    const decisionA = new ProductStockDecisionStore(storage)
    const decisionB = new ProductStockDecisionStore(storage)
    const makeStock = (orderId: string, dTag: string, createdAt: number) => {
      const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
      return {
        adjustment: {
          key: getOrderStockDecisionKey(orderId, addressId),
          addressId,
          sourceEventId: "a".repeat(64),
          title: dTag,
          quantity: 2,
          currentStock: 5,
          nextStock: 3,
          shortfall: 0,
        },
        signedEvent: finalizeEvent(
          {
            kind: EVENT_KINDS.PRODUCT,
            created_at: createdAt,
            content: "Stock update",
            tags: [
              ["d", dTag],
              ["title", dTag],
              ["price", "25", "USD"],
              ["stock", "3"],
            ],
          },
          secretKey
        ),
      }
    }
    const first = makeStock("order-1", "stock-a", 1_700_000_001)
    const second = makeStock("order-2", "stock-b", 1_700_000_002)
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let notifyEntered!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    const baselineChecks: string[] = []
    const firstWrite = checkpointSignedOrderStockDelivery({
      merchantPubkey: merchant,
      orderId: "order-1",
      ...first,
      expectedUnpublishedEventId: null,
      assertCurrentWriteBaseline: async () => {
        baselineChecks.push("first")
        notifyEntered()
        await firstHeld
      },
      decisionStore: decisionA,
      pendingStore: pendingA,
      requestLock: locks.request,
    })
    await firstEntered
    const secondWrite = checkpointSignedOrderStockDelivery({
      merchantPubkey: merchant,
      orderId: "order-2",
      ...second,
      expectedUnpublishedEventId: null,
      assertCurrentWriteBaseline: async () => {
        baselineChecks.push("second")
      },
      decisionStore: decisionB,
      pendingStore: pendingB,
      requestLock: locks.request,
    })
    await Promise.resolve()
    expect(baselineChecks).toEqual(["first"])
    releaseFirst()
    expect(await firstWrite).toBe(true)
    expect(await secondWrite).toBe(true)
    expect(baselineChecks).toEqual(["first", "second"])
    expect(
      new PendingProductStockDeliveryStore(storage)
        .getPersistedForMerchant(merchant)
        .map((delivery) => delivery.orderId)
        .sort()
    ).toEqual(["order-1", "order-2"])

    const competingOrder = makeStock("order-3", "stock-a", 1_700_000_003)
    await expect(
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-3",
        ...competingOrder,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: decisionB,
        pendingStore: pendingB,
        requestLock: locks.request,
      })
    ).rejects.toThrow("Another signed stock update")
    const competingSameOrder = makeStock("order-1", "stock-a", 1_700_000_004)
    await expect(
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        ...competingSameOrder,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: decisionB,
        pendingStore: pendingB,
        requestLock: locks.request,
      })
    ).rejects.toThrow("Another signed stock update")
    expect(pendingA.getForOrder(merchant, "order-1")[0]?.signedEvent.id).toBe(
      first.signedEvent.id
    )

    expect(
      await settleSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        adjustment: first.adjustment,
        signedEventId: first.signedEvent.id,
        kind: "applied",
        decisionStore: decisionA,
        pendingStore: pendingA,
        requestLock: locks.request,
      })
    ).toBe("saved")
    expect(pendingB.getForOrder(merchant, "order-1")).toEqual([])
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-2"
      )
    ).toHaveLength(1)
    expect(
      new ProductStockDecisionStore(storage).getPersisted(
        merchant,
        "order-1",
        first.adjustment.addressId
      )?.kind
    ).toBe("applied")
    await expect(
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-3",
        ...competingOrder,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: decisionB,
        pendingStore: pendingB,
        requestLock: locks.request,
      })
    ).rejects.toThrow("already updated this product revision")
    expect(
      await settleSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-2",
        adjustment: second.adjustment,
        signedEventId: second.signedEvent.id,
        kind: "applied",
        decisionStore: decisionB,
        pendingStore: pendingB,
        requestLock: locks.request,
      })
    ).toBe("saved")
    const afterReload = new ProductStockDecisionStore(storage)
    expect(
      afterReload.getPersisted(merchant, "order-1", first.adjustment.addressId)
        ?.kind
    ).toBe("applied")
    expect(
      afterReload.getPersisted(merchant, "order-2", second.adjustment.addressId)
        ?.kind
    ).toBe("applied")
  })

  it("keeps a newer republish checkpoint when an older tab settles or retries stale bytes", async () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const locks = new TestMerchantStockLocks()
    const pendingStore = new PendingProductStockDeliveryStore(storage)
    const decisionStore = new ProductStockDecisionStore(storage)
    const orderId = "order-1"
    const dTag = "same-order-stock"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const adjustment = {
      key: getOrderStockDecisionKey(orderId, addressId),
      addressId,
      sourceEventId: "a".repeat(64),
      title: dTag,
      quantity: 2,
      currentStock: 5,
      nextStock: 3,
      shortfall: 0,
    }
    const sign = (createdAt: number) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRODUCT,
          created_at: createdAt,
          content: "Stock update",
          tags: [
            ["d", dTag],
            ["title", dTag],
            ["price", "25", "USD"],
            ["stock", "3"],
          ],
        },
        secretKey
      )
    const original = sign(1_700_000_001)
    const replacement = sign(1_700_000_002)
    const reserve = (signedEvent: typeof original, expected: string | null) =>
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId,
        adjustment,
        signedEvent,
        expectedUnpublishedEventId: expected,
        assertCurrentWriteBaseline: async () => {},
        decisionStore,
        pendingStore,
        requestLock: locks.request,
      })

    expect(await reserve(original, null)).toBe(true)
    expect(
      await settleSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId,
        adjustment,
        signedEventId: original.id,
        kind: "unpublished",
        decisionStore,
        pendingStore,
        requestLock: locks.request,
      })
    ).toBe("saved")
    expect(await reserve(replacement, original.id)).toBe(true)
    expect(
      await settleSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId,
        adjustment,
        signedEventId: original.id,
        kind: "applied",
        decisionStore: new ProductStockDecisionStore(storage),
        pendingStore: new PendingProductStockDeliveryStore(storage),
        requestLock: locks.request,
      })
    ).toBe("stale")
    await expect(
      confirmExactPendingStockDelivery({
        merchantPubkey: merchant,
        orderId,
        adjustment,
        signedEventId: original.id,
        pendingStore,
        decisionStore,
        requestLock: locks.request,
      })
    ).rejects.toThrow("no longer awaiting delivery")
    expect(
      await confirmExactPendingStockDelivery({
        merchantPubkey: merchant,
        orderId,
        adjustment,
        signedEventId: replacement.id,
        pendingStore,
        decisionStore,
        requestLock: locks.request,
      })
    ).toBe(true)
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        orderId
      )[0]?.signedEvent.id
    ).toBe(replacement.id)
    expect(
      new ProductStockDecisionStore(storage).getPersisted(
        merchant,
        orderId,
        addressId
      )?.localEventId
    ).toBe(original.id)
  })

  it("does not let a failed settled-checkpoint cleanup block the next order", async () => {
    let protectedStorageKey: string | null = null
    let protectedDeliveryKey: string | null = null
    const storage = new (class extends MemoryStorage {
      setItem(key: string, value: string): void {
        if (key === protectedStorageKey && protectedDeliveryKey) {
          const deliveries = (
            JSON.parse(value) as {
              deliveries: Record<string, unknown>
            }
          ).deliveries
          if (!deliveries[protectedDeliveryKey]) return
        }
        super.setItem(key, value)
      }
    })()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const locks = new TestMerchantStockLocks()
    const pendingStore = new PendingProductStockDeliveryStore(storage)
    const decisionStore = new ProductStockDecisionStore(storage)
    const dTag = "cleanup-failure"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const firstEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_001,
        content: "Stock update",
        tags: [
          ["d", dTag],
          ["title", dTag],
          ["price", "25", "USD"],
          ["stock", "3"],
        ],
      },
      secretKey
    )
    const firstAdjustment = {
      key: getOrderStockDecisionKey("order-1", addressId),
      addressId,
      sourceEventId: "a".repeat(64),
      title: dTag,
      quantity: 2,
      currentStock: 5,
      nextStock: 3,
      shortfall: 0,
    }
    expect(
      await checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        adjustment: firstAdjustment,
        signedEvent: firstEvent,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore,
        pendingStore,
        requestLock: locks.request,
      })
    ).toBe(true)
    protectedStorageKey = storage.key(0)
    protectedDeliveryKey = firstAdjustment.key
    expect(
      await settleSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        adjustment: firstAdjustment,
        signedEventId: firstEvent.id,
        kind: "applied",
        decisionStore,
        pendingStore,
        requestLock: locks.request,
      })
    ).toBe("saved")
    expect(pendingStore.getPersistedForMerchant(merchant)).toHaveLength(1)

    const secondEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_002,
        content: "Stock update",
        tags: [
          ["d", dTag],
          ["title", dTag],
          ["price", "25", "USD"],
          ["stock", "1"],
        ],
      },
      secretKey
    )
    const secondAdjustment = {
      key: getOrderStockDecisionKey("order-2", addressId),
      addressId,
      sourceEventId: firstEvent.id,
      title: dTag,
      quantity: 2,
      currentStock: 3,
      nextStock: 1,
      shortfall: 0,
    }
    expect(
      await checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-2",
        adjustment: secondAdjustment,
        signedEvent: secondEvent,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: new ProductStockDecisionStore(storage),
        pendingStore: new PendingProductStockDeliveryStore(storage),
        requestLock: locks.request,
      })
    ).toBe(true)
    expect(
      pendingStore
        .getPersistedForMerchant(merchant)
        .map((item) => item.orderId)
        .sort()
    ).toEqual(["order-1", "order-2"])
    await expect(
      confirmExactPendingStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        adjustment: firstAdjustment,
        signedEventId: firstEvent.id,
        pendingStore,
        decisionStore,
        requestLock: locks.request,
      })
    ).rejects.toThrow("no longer awaiting delivery")
  })

  it("reserves a decision slot before staging when other orders are pending at capacity", async () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const decisions = new ProductStockDecisionStore(storage)
    const pending = new PendingProductStockDeliveryStore(storage)
    const locks = new TestMerchantStockLocks()
    for (let index = 0; index < 499; index += 1) {
      expect(
        decisions.set(
          merchant,
          `historical-${index}`,
          `${EVENT_KINDS.PRODUCT}:${merchant}:historical-${index}`,
          "applied",
          undefined,
          undefined,
          { requireDurable: true }
        )
      ).toBe(true)
    }

    const signedEvent = (dTag: string) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRODUCT,
          created_at: 1_700_000_001,
          content: "Stock update",
          tags: [
            ["d", dTag],
            ["title", dTag],
            ["price", "25", "USD"],
            ["stock", "3"],
          ],
        },
        secretKey
      )
    const oldAddress = `${EVENT_KINDS.PRODUCT}:${merchant}:reserved-old`
    expect(
      pending.set(
        merchant,
        {
          orderId: "reserved-old-order",
          adjustment: {
            key: getOrderStockDecisionKey("reserved-old-order", oldAddress),
            addressId: oldAddress,
            sourceEventId: "a".repeat(64),
            title: "Reserved old",
            quantity: 1,
            currentStock: 4,
            nextStock: 3,
            shortfall: 0,
          },
          signedEvent: signedEvent("reserved-old"),
        },
        { requireDurable: true }
      )
    ).toBe(true)

    const newAddress = `${EVENT_KINDS.PRODUCT}:${merchant}:reserved-new`
    await expect(
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "reserved-new-order",
        adjustment: {
          key: getOrderStockDecisionKey("reserved-new-order", newAddress),
          addressId: newAddress,
          sourceEventId: "b".repeat(64),
          title: "Reserved new",
          quantity: 1,
          currentStock: 4,
          nextStock: 3,
          shortfall: 0,
        },
        signedEvent: signedEvent("reserved-new"),
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: decisions,
        pendingStore: pending,
        requestLock: locks.request,
      })
    ).rejects.toThrow("Stock decision storage is full")
    expect(pending.getPersistedForMerchant(merchant)).toHaveLength(1)
    expect(decisions.getPersistedForMerchant(merchant)).toHaveLength(499)
  })

  it("refuses to stage a signed stock event when cross-tab locking is unavailable", async () => {
    const storage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const merchant = getPublicKey(secretKey)
    const dTag = "no-lock-stock"
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:${dTag}`
    const signedEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_001,
        content: "Stock update",
        tags: [
          ["d", dTag],
          ["title", dTag],
          ["price", "25", "USD"],
          ["stock", "3"],
        ],
      },
      secretKey
    )
    await expect(
      checkpointSignedOrderStockDelivery({
        merchantPubkey: merchant,
        orderId: "order-1",
        adjustment: {
          key: getOrderStockDecisionKey("order-1", addressId),
          addressId,
          sourceEventId: "a".repeat(64),
          title: dTag,
          quantity: 2,
          currentStock: 5,
          nextStock: 3,
          shortfall: 0,
        },
        signedEvent,
        expectedUnpublishedEventId: null,
        assertCurrentWriteBaseline: async () => {},
        decisionStore: new ProductStockDecisionStore(storage),
        pendingStore: new PendingProductStockDeliveryStore(storage),
        requestLock: null,
      })
    ).rejects.toThrow("cannot coordinate stock updates")
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-1"
      )
    ).toEqual([])
    await expect(
      withMerchantStockLock(merchant, async () => true, null)
    ).rejects.toThrow("cannot coordinate stock updates")
  })

  it("does not overwrite malformed existing stock authority during durable writes", () => {
    const merchant = "a".repeat(64)
    const addressId = `${EVENT_KINDS.PRODUCT}:${merchant}:corrupt-decision`
    const decisionStorage = new MemoryStorage()
    const decisions = new ProductStockDecisionStore(decisionStorage)
    expect(
      decisions.set(
        merchant,
        "order-1",
        addressId,
        "applied",
        undefined,
        undefined,
        { requireDurable: true }
      )
    ).toBe(true)
    const decisionKey = decisionStorage.key(0)!
    const malformedDecisions = JSON.stringify({
      version: 1,
      decisions: { invalid: { kind: "applied", decidedAt: "not-a-date" } },
    })
    decisionStorage.setItem(decisionKey, malformedDecisions)
    expect(
      decisions.set(
        merchant,
        "order-2",
        addressId,
        "applied",
        undefined,
        undefined,
        { requireDurable: true }
      )
    ).toBe(false)
    expect(decisionStorage.getItem(decisionKey)).toBe(malformedDecisions)
    expect(() =>
      decisions.getPersisted(merchant, "order-2", addressId)
    ).toThrow("invalid order evidence")

    const deliveryStorage = new MemoryStorage()
    const secretKey = generateSecretKey()
    const author = getPublicKey(secretKey)
    const dTag = "corrupt-pending"
    const productAddressId = `${EVENT_KINDS.PRODUCT}:${author}:${dTag}`
    const signedEvent = finalizeEvent(
      {
        kind: EVENT_KINDS.PRODUCT,
        created_at: 1_700_000_001,
        content: "Stock update",
        tags: [
          ["d", dTag],
          ["title", dTag],
          ["price", "25", "USD"],
          ["stock", "3"],
        ],
      },
      secretKey
    )
    const pending = new PendingProductStockDeliveryStore(deliveryStorage)
    const delivery = {
      orderId: "order-1",
      adjustment: {
        key: getOrderStockDecisionKey("order-1", productAddressId),
        addressId: productAddressId,
        sourceEventId: "a".repeat(64),
        title: dTag,
        quantity: 2,
        currentStock: 5,
        nextStock: 3,
        shortfall: 0,
      },
      signedEvent,
    }
    expect(pending.set(author, delivery, { requireDurable: true })).toBe(true)
    const deliveryKey = deliveryStorage.key(0)!
    const malformedDeliveries = "{bad-json"
    deliveryStorage.setItem(deliveryKey, malformedDeliveries)
    expect(
      pending.set(
        author,
        {
          ...delivery,
          orderId: "order-2",
          adjustment: {
            ...delivery.adjustment,
            key: getOrderStockDecisionKey("order-2", productAddressId),
          },
        },
        { requireDurable: true }
      )
    ).toBe(false)
    expect(deliveryStorage.getItem(deliveryKey)).toBe(malformedDeliveries)
    expect(() => pending.getPersistedForMerchant(author)).toThrow("unreadable")
  })
})
