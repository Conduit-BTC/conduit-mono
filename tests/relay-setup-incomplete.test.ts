import { describe, expect, it } from "bun:test"
import { isRelaySetupIncomplete } from "../packages/core/src/config"
import type { RelayEntry, RelayGroups } from "../packages/core/src/types"

function entry(
  url: string,
  role: RelayEntry["role"],
  overrides: Partial<RelayEntry> = {}
): RelayEntry {
  return {
    url,
    role,
    source: "custom",
    out: false,
    in: false,
    find: false,
    dm: false,
    ...overrides,
  }
}

function groups(partial: Partial<RelayGroups>): RelayGroups {
  return {
    merchant: partial.merchant ?? [],
    commerce: partial.commerce ?? [],
    general: partial.general ?? [],
  }
}

describe("isRelaySetupIncomplete", () => {
  it("is true when no commerce or general relays have in/find enabled", () => {
    expect(isRelaySetupIncomplete("shopper", groups({}))).toBe(true)
  })

  it("is false for shopper when at least one commerce relay has in=true", () => {
    expect(
      isRelaySetupIncomplete(
        "shopper",
        groups({ commerce: [entry("wss://c", "commerce", { in: true })] })
      )
    ).toBe(false)
  })

  it("is false for shopper when at least one general relay has find=true", () => {
    expect(
      isRelaySetupIncomplete(
        "shopper",
        groups({ general: [entry("wss://g", "general", { find: true })] })
      )
    ).toBe(false)
  })

  it("is true for shopper when commerce/general entries exist but are disabled", () => {
    expect(
      isRelaySetupIncomplete(
        "shopper",
        groups({
          commerce: [entry("wss://c", "commerce", { out: true })],
          general: [entry("wss://g", "general", { dm: true })],
        })
      )
    ).toBe(true)
  })

  it("is true for merchant when commerce is ok but no merchant relays exist", () => {
    expect(
      isRelaySetupIncomplete(
        "merchant",
        groups({ commerce: [entry("wss://c", "commerce", { in: true })] })
      )
    ).toBe(true)
  })

  it("is false for merchant when both commerce and merchant relays are usable", () => {
    expect(
      isRelaySetupIncomplete(
        "merchant",
        groups({
          commerce: [entry("wss://c", "commerce", { in: true })],
          merchant: [entry("wss://m", "merchant", { out: true })],
        })
      )
    ).toBe(false)
  })

  it("treats merchant relay in-only as sufficient for merchant", () => {
    expect(
      isRelaySetupIncomplete(
        "merchant",
        groups({
          commerce: [entry("wss://c", "commerce", { find: true })],
          merchant: [entry("wss://m", "merchant", { in: true })],
        })
      )
    ).toBe(false)
  })
})
