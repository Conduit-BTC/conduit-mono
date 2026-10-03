import { describe, expect, it } from "bun:test"
import {
  readMerchantOrderSort,
  saveMerchantOrderSort,
} from "../apps/merchant/src/lib/order-sort-preference"
import { ORDER_SORT_OPTIONS } from "../apps/merchant/src/lib/order-phase"

describe("merchant order sort preference", () => {
  it("defaults to newest orders and remembers an explicit UI choice", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(readMerchantOrderSort(storage)).toBe("newest")
    saveMerchantOrderSort("priority", storage)
    expect(readMerchantOrderSort(storage)).toBe("priority")
    saveMerchantOrderSort("recent", storage)
    expect(readMerchantOrderSort(storage)).toBe("recent")
    expect(ORDER_SORT_OPTIONS).toEqual([
      { value: "newest", label: "Newest orders" },
      { value: "recent", label: "Recently updated" },
      { value: "priority", label: "Needs attention — oldest first" },
    ])
  })

  it("falls back safely when a stored preference is obsolete or unavailable", () => {
    for (const value of [null, "", "oldest", "unknown-mode"]) {
      expect(readMerchantOrderSort({ getItem: () => value })).toBe("newest")
    }
    expect(readMerchantOrderSort(null)).toBe("newest")
    expect(
      readMerchantOrderSort({
        getItem: () => {
          throw new DOMException("Storage unavailable", "SecurityError")
        },
      })
    ).toBe("newest")
    expect(() => saveMerchantOrderSort("newest", null)).not.toThrow()
    expect(() =>
      saveMerchantOrderSort("recent", {
        setItem: () => {
          throw new DOMException("Storage unavailable", "QuotaExceededError")
        },
      })
    ).not.toThrow()
  })
})
