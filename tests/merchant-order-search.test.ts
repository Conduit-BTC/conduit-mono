import { describe, expect, it } from "bun:test"
import {
  parseMerchantOrderSearch,
  shouldStartMerchantOrderRecoveryAutomatically,
} from "../apps/merchant/src/lib/order-search"

describe("Merchant Orders search", () => {
  it("keeps the existing order and queue search behavior", () => {
    expect(parseMerchantOrderSearch({})).toEqual({})
    expect(
      parseMerchantOrderSearch({
        order: "saved-order",
        queue: "verify_payment",
      })
    ).toEqual({ order: "saved-order", queue: "verify_payment" })
    expect(parseMerchantOrderSearch({ order: " ", queue: "all" })).toEqual({
      order: " ",
    })
    expect(parseMerchantOrderSearch({ order: "", queue: "invalid" })).toEqual(
      {}
    )
  })

  it("accepts the explicit paused recovery entry without changing order or queue", () => {
    expect(
      parseMerchantOrderSearch({
        order: "saved-order",
        queue: "verify_payment",
        recovery: "paused",
      })
    ).toEqual({
      order: "saved-order",
      queue: "verify_payment",
      recovery: "paused",
    })
  })

  it("keeps default automatic startup bounded by deployment routing eligibility", () => {
    expect(
      shouldStartMerchantOrderRecoveryAutomatically(false, undefined)
    ).toBe(false)
    expect(shouldStartMerchantOrderRecoveryAutomatically(true, undefined)).toBe(
      true
    )
  })

  it("suppresses eligible automatic startup for an explicit paused entry", () => {
    const { recovery } = parseMerchantOrderSearch({ recovery: "paused" })
    expect(shouldStartMerchantOrderRecoveryAutomatically(true, recovery)).toBe(
      false
    )
    expect(shouldStartMerchantOrderRecoveryAutomatically(false, recovery)).toBe(
      false
    )
  })

  it("ignores malformed recovery modes without granting automatic eligibility", () => {
    for (const recovery of [
      undefined,
      null,
      false,
      1,
      "Paused",
      " paused ",
      "automatic",
      ["paused"],
      {},
    ]) {
      const parsed = parseMerchantOrderSearch({ recovery })
      expect(parsed).toEqual({})
      expect(
        shouldStartMerchantOrderRecoveryAutomatically(false, parsed.recovery)
      ).toBe(false)
      expect(
        shouldStartMerchantOrderRecoveryAutomatically(true, parsed.recovery)
      ).toBe(true)
    }
  })

  it("keeps paused mode when selecting another order or changing and clearing the queue", () => {
    const selected = parseMerchantOrderSearch({
      order: "next-order",
      queue: "verify_payment",
      recovery: "paused",
    })
    expect(selected).toEqual({
      order: "next-order",
      queue: "verify_payment",
      recovery: "paused",
    })
    const changedQueue = parseMerchantOrderSearch({
      queue: "closed",
      recovery: selected.recovery,
    })
    expect(changedQueue).toEqual({ queue: "closed", recovery: "paused" })
    expect(
      parseMerchantOrderSearch({
        queue: "all",
        recovery: changedQueue.recovery,
      })
    ).toEqual({ recovery: "paused" })
  })

  it("drops malformed order and queue fields without dropping a valid pause", () => {
    expect(
      parseMerchantOrderSearch({
        order: ["order"],
        queue: false,
        recovery: "paused",
      })
    ).toEqual({ recovery: "paused" })
  })

  it("uses the suppression mode at startup and preserves it in both Orders navigations", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    expect(source).toContain("validateSearch: parseMerchantOrderSearch")
    expect(source).toContain("recovery: recoveryMode")
    expect(source).toMatch(
      /startAutomatically=\{shouldStartMerchantOrderRecoveryAutomatically\(\s*quantumRouterExecutionEnabled,\s*recoveryMode\s*\)\}/
    )
    expect(source).toContain(
      "allowAutomaticPayouts={quantumRouterExecutionEnabled}"
    )
    expect(source).toContain("executionEnabled={quantumRouterExecutionEnabled}")
    const select = source.slice(
      source.indexOf("const selectConversation ="),
      source.indexOf("const changePhaseTab =")
    )
    const changeQueue = source.slice(
      source.indexOf("const changePhaseTab ="),
      source.indexOf("setPhaseTab(selectedQueueFromUrl)")
    )
    for (const navigation of [select, changeQueue]) {
      expect(navigation).toContain("search: parseMerchantOrderSearch({")
      expect(navigation).toContain("recovery: recoveryMode")
    }
  })
})
