import { describe, expect, it } from "bun:test"
import {
  assertCheckoutSparkTreasuryAddressAllowed,
  selectCheckoutSparkTreasuryAddress,
} from "../packages/core/src/protocol/checkout-spark-treasury-policy"

describe("compiled checkout treasury policy", () => {
  it("does not invent a destination or reinterpret a missing network setting", () => {
    expect(selectCheckoutSparkTreasuryAddress("mainnet", {})).toBeNull()
    expect(
      selectCheckoutSparkTreasuryAddress("regtest", {
        mainnetAddress: "fixture-mainnet",
      })
    ).toBeNull()
    expect(
      selectCheckoutSparkTreasuryAddress("mainnet", { mainnetAddress: "  " })
    ).toBeNull()
  })
  it("pins the configured address without accepting a saved-plan override", () => {
    const configuration = {
      mainnetAddress: "fixture-current",
      retiredAddresses: "fixture-old",
    }
    expect(selectCheckoutSparkTreasuryAddress("mainnet", configuration)).toBe(
      "fixture-current"
    )
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed(
        "mainnet",
        "fixture-current",
        configuration
      )
    ).not.toThrow()
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed(
        "mainnet",
        "fixture-old",
        configuration
      )
    ).not.toThrow()
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed(
        "mainnet",
        "fixture-other",
        configuration
      )
    ).toThrow()
  })
  it("fails closed on malformed or unbounded configuration", () => {
    expect(() =>
      selectCheckoutSparkTreasuryAddress("mainnet", {
        mainnetAddress: "invalid address",
      })
    ).toThrow()
    expect(() =>
      selectCheckoutSparkTreasuryAddress("mainnet", {
        mainnetAddress: "x".repeat(2049),
      })
    ).toThrow()
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed("mainnet", "allowed", {
        mainnetAddress: "allowed",
        retiredAddresses: Array.from({ length: 17 }, (_, i) => `old-${i}`).join(
          ","
        ),
      })
    ).toThrow()
  })
})
