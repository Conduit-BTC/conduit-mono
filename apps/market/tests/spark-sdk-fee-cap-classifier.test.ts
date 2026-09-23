import { describe, expect, it } from "bun:test"

import { SparkValidationError } from "@buildonspark/spark-sdk"

import { loadFirstPartySparkModule } from "../src/lib/spark-sdk"

describe("pinned Spark SDK pre-send fee-cap classifier", () => {
  it("accepts only the exact SDK validation class, field, and message", async () => {
    const { isPreSendFeeCapError } = await loadFirstPartySparkModule()
    const feeCapError = new SparkValidationError(
      "maxFeeSats does not cover fee estimate",
      { field: "maxFeeSats", value: 5, expected: "6 sats" }
    )

    expect(isPreSendFeeCapError(feeCapError)).toBe(true)
    expect(
      isPreSendFeeCapError(
        new SparkValidationError("maxFeeSats does not cover fee estimate", {
          field: "paymentRequest",
        })
      )
    ).toBe(false)
    expect(
      isPreSendFeeCapError(
        new SparkValidationError("Lightning send failed", {
          field: "maxFeeSats",
        })
      )
    ).toBe(false)
    expect(
      isPreSendFeeCapError(new Error("maxFeeSats does not cover fee estimate"))
    ).toBe(false)
    expect(isPreSendFeeCapError(null)).toBe(false)
  })
})
