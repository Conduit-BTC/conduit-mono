import { describe, expect, it } from "bun:test"
import {
  allocateCheckoutSparkSettledSats,
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "@conduit/core"

describe("checkout Spark settled allocation", () => {
  it("calculates the commerce and Conduit weights for the signed plan", () => {
    expect(calculateCheckoutSparkAllocationWeights(100_000)).toEqual({
      commerceWeightSats: 100_000,
      conduitWeightSats: 2_100,
    })
    expect(calculateCheckoutSparkAllocationWeights(10)).toEqual({
      commerceWeightSats: 10,
      conduitWeightSats: 111,
    })
  })

  it("rounds the inbound allowance up from exactly 0.15% of commerce", () => {
    for (const [commerceSats, allowanceSats] of [
      [1, 1],
      [666, 1],
      [667, 2],
      [1_000, 2],
      [100_000, 150],
    ] as const) {
      expect(
        calculateCheckoutSparkInboundNetworkAllowanceSats(commerceSats)
      ).toBe(allowanceSats)
    }
    for (const commerceSats of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        calculateCheckoutSparkInboundNetworkAllowanceSats(commerceSats)
      ).toThrow("inbound allowance base is invalid")
    }
  })

  it("adds the allowance to gross without changing recipient weights", () => {
    expect(calculateCheckoutSparkSettledGrossFundingSats(100_000)).toBe(102_250)
    expect(calculateCheckoutSparkSettledGrossFundingSats(1_000)).toBe(1_113)
    expect(calculateCheckoutSparkSettledGrossFundingSats(10)).toBe(122)
    expect(() =>
      calculateCheckoutSparkSettledGrossFundingSats(10_000_000_000_000)
    ).toThrow("gross funding is unsafe")
  })

  it("preserves the original amounts when the funded receive settles without a fee", () => {
    const allocation = allocateCheckoutSparkSettledSats({
      settledSats: 102_100,
      fundingInvoiceGrossSats: 102_100,
      weights: calculateCheckoutSparkAllocationWeights(100_000),
    })
    expect(allocation).toEqual({
      commerceAllocationSats: 100_000,
      conduitAllocationSats: 2_100,
    })
  })

  it("shares a funded surplus proportionally, with the sat remainder going to commerce", () => {
    const allocation = allocateCheckoutSparkSettledSats({
      settledSats: 102_250,
      fundingInvoiceGrossSats: 102_250,
      weights: calculateCheckoutSparkAllocationWeights(100_000),
    })
    expect(allocation).toEqual({
      commerceAllocationSats: 100_147,
      conduitAllocationSats: 2_103,
    })
  })

  it("allocates the base weights when an allowed funding surplus is consumed inbound", () => {
    expect(
      allocateCheckoutSparkSettledSats({
        settledSats: 102_100,
        fundingInvoiceGrossSats: 102_250,
        weights: calculateCheckoutSparkAllocationWeights(100_000),
      })
    ).toEqual({
      commerceAllocationSats: 100_000,
      conduitAllocationSats: 2_100,
    })
  })

  it("shares an inbound shortfall without overallocating either leg", () => {
    const allocation = allocateCheckoutSparkSettledSats({
      settledSats: 102_050,
      fundingInvoiceGrossSats: 102_100,
      weights: calculateCheckoutSparkAllocationWeights(100_000),
    })
    expect(allocation).toEqual({
      commerceAllocationSats: 99_952,
      conduitAllocationSats: 2_098,
    })
  })

  it("preserves the exact total and commerce remainder at the minimum fee floor", () => {
    const weights = calculateCheckoutSparkAllocationWeights(10)
    for (const settledSats of [1, 120, 121, 122, Number.MAX_SAFE_INTEGER]) {
      const allocation = allocateCheckoutSparkSettledSats({
        settledSats,
        fundingInvoiceGrossSats: Math.max(settledSats, 121),
        weights,
      })
      expect(
        allocation.commerceAllocationSats + allocation.conduitAllocationSats
      ).toBe(settledSats)
      expect(allocation.commerceAllocationSats).toBeGreaterThanOrEqual(0)
      expect(allocation.conduitAllocationSats).toBeGreaterThanOrEqual(0)
    }
    expect(
      allocateCheckoutSparkSettledSats({
        settledSats: 120,
        fundingInvoiceGrossSats: 121,
        weights,
      })
    ).toEqual({ commerceAllocationSats: 10, conduitAllocationSats: 110 })
  })

  it("rejects invalid or unsafe amounts and altered weights", () => {
    for (const commerceSats of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() =>
        calculateCheckoutSparkAllocationWeights(commerceSats)
      ).toThrow()
    }
    const weights = calculateCheckoutSparkAllocationWeights(100_000)
    for (const settledSats of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        allocateCheckoutSparkSettledSats({
          settledSats,
          fundingInvoiceGrossSats: 102_100,
          weights,
        })
      ).toThrow()
    }
    expect(() =>
      allocateCheckoutSparkSettledSats({
        settledSats: 102_101,
        fundingInvoiceGrossSats: 102_100,
        weights,
      })
    ).toThrow("settled amount is invalid")
    expect(() =>
      allocateCheckoutSparkSettledSats({
        settledSats: 102_099,
        fundingInvoiceGrossSats: 102_099,
        weights,
      })
    ).toThrow("funding invoice is below frozen weights")
    expect(() =>
      allocateCheckoutSparkSettledSats({
        settledSats: 102_100,
        fundingInvoiceGrossSats: 102_100,
        weights: { commerceWeightSats: 100_000, conduitWeightSats: 2_099 },
      })
    ).toThrow("weights are invalid")
  })
})
