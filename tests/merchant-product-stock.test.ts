import { describe, expect, it } from "bun:test"
import { EVENT_KINDS, type CommerceProductRecord } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  buildOrderStockAdjustments,
  getProductStockDisplay,
  getProductStockInputError,
  isPlainStockInput,
  parseProductStockInput,
  PendingProductStockDeliveryStore,
  ProductStockDecisionStore,
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
    expect(oversold).toMatchObject({ nextStock: 0, shortfall: 3 })
  })

  it("does not prompt for untracked, sold-out, foreign, or variable listings", () => {
    const record = productRecord()
    const build = (candidate: CommerceProductRecord) =>
      buildOrderStockAdjustments({
        orderId: "order-123",
        merchantPubkey: record.product.pubkey,
        items: [{ productId: candidate.addressId, quantity: 1 }],
        productRecords: [candidate],
      })

    expect(build(productRecord({ stock: undefined }))).toEqual([])
    expect(build(productRecord({ stock: 0 }))).toEqual([])
    expect(build(productRecord({ pubkey: "c".repeat(64) }))).toEqual([])
    expect(build(productRecord({ type: "variable" }))).toEqual([])
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

  it("keeps a session decision when browser storage is unavailable", () => {
    const store = new ProductStockDecisionStore(null)
    const merchant = "a".repeat(64)
    const address = `30402:${merchant}:pocket-relay`

    expect(store.set(merchant, "order-1", address, "declined")).toBe(false)
    expect(store.get(merchant, "order-1", address)?.kind).toBe("declined")
  })

  it("restores a pending signed stock delivery after reload", () => {
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
          ["stock", "11"],
        ],
      },
      secretKey
    )
    const adjustment = {
      key: `order-1:${addressId}`,
      addressId,
      sourceEventId: "source-event",
      title: "Pocket Relay",
      quantity: 1,
      currentStock: 12,
      nextStock: 11,
      shortfall: 0,
    }

    const first = new PendingProductStockDeliveryStore(storage)
    expect(
      first.set(merchant, {
        orderId: "order-1",
        adjustment,
        signedEvent,
      })
    ).toBe(true)

    const afterReload = new PendingProductStockDeliveryStore(storage)
    const restored = afterReload.getForOrder(merchant, "order-1")
    expect(restored).toHaveLength(1)
    expect(restored[0]?.orderId).toBe("order-1")
    expect(restored[0]?.adjustment).toEqual(adjustment)
    expect(restored[0]?.signedEvent.id).toBe(signedEvent.id)
    expect(restored[0]?.signedEvent.pubkey).toBe(signedEvent.pubkey)

    expect(afterReload.delete(merchant, "order-1", addressId)).toBe(true)
    expect(
      new PendingProductStockDeliveryStore(storage).getForOrder(
        merchant,
        "order-1"
      )
    ).toEqual([])
  })
})
