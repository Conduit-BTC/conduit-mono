import { describe, expect, it } from "bun:test"
import {
  clearCoordinatedMerchantHandoffFallback,
  loadCoordinatedMerchantHandoffFallback,
  rememberCoordinatedMerchantHandoffFallback,
} from "../apps/merchant/src/lib/event-market-handoff-fallback"

const MERCHANT = "a".repeat(64)
const ORDER_REF = "b".repeat(64)
const RECEIPT = "c".repeat(64)

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe("coordinated merchant handoff fallback", () => {
  it("binds the local confirmation to the exact order and ready receipt", () => {
    const storage = new MemoryStorage()
    const marker = rememberCoordinatedMerchantHandoffFallback(
      {
        merchantPubkey: MERCHANT,
        orderCorrelationRef: ORDER_REF,
        readyReceiptId: RECEIPT,
        confirmedAt: 10,
      },
      storage
    )

    expect(marker).toMatchObject({ readyReceiptId: RECEIPT, confirmedAt: 10 })
    expect(
      loadCoordinatedMerchantHandoffFallback(
        {
          merchantPubkey: MERCHANT,
          orderCorrelationRef: ORDER_REF,
          readyReceiptId: RECEIPT,
        },
        storage
      )
    ).toEqual(marker)
    expect(
      loadCoordinatedMerchantHandoffFallback(
        {
          merchantPubkey: MERCHANT,
          orderCorrelationRef: ORDER_REF,
          readyReceiptId: "d".repeat(64),
        },
        storage
      )
    ).toBeNull()
  })

  it("clears the marker when the order reaches a terminal state", () => {
    const storage = new MemoryStorage()
    rememberCoordinatedMerchantHandoffFallback(
      {
        merchantPubkey: MERCHANT,
        orderCorrelationRef: ORDER_REF,
        readyReceiptId: RECEIPT,
      },
      storage
    )

    expect(
      clearCoordinatedMerchantHandoffFallback(MERCHANT, ORDER_REF, storage)
    ).toBe(true)
    expect(
      loadCoordinatedMerchantHandoffFallback(
        {
          merchantPubkey: MERCHANT,
          orderCorrelationRef: ORDER_REF,
          readyReceiptId: RECEIPT,
        },
        storage
      )
    ).toBeNull()
  })
})
