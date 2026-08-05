import { describe, expect, it } from "bun:test"
import { getAutomaticMerchantThreadId } from "../apps/market/src/lib/message-route-state"

describe("Market message route state", () => {
  it("selects the first merchant thread only when none is selected", () => {
    expect(getAutomaticMerchantThreadId(undefined, ["first", "second"])).toBe(
      "first"
    )
  })

  it("preserves an existing thread during transient or divergent reads", () => {
    expect(getAutomaticMerchantThreadId("selected", [])).toBeNull()
    expect(getAutomaticMerchantThreadId("selected", ["different"])).toBeNull()
  })

  it("does not navigate when no merchant threads are available", () => {
    expect(getAutomaticMerchantThreadId(undefined, [])).toBeNull()
  })
})
