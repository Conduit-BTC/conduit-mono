import { describe, expect, it } from "bun:test"
import {
  checkoutSparkRecoveryTiming,
  checkoutSparkRecoveryTimingMatches,
  compareCheckoutSparkRecoveryTiming,
  restoreCheckoutSparkRecoveryTiming,
} from "../packages/core/src/protocol/checkout-spark-recovery-timing"
import {
  activateCheckoutSparkBuyer,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledTreasuryPlan,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"

describe("private recovery timing descriptors", () => {
  it("preserves historical shape and pins new inactive/activated selections", () => {
    const old = nativeTreasuryFixture().plan
    expect(checkoutSparkRecoveryTiming(old)).toEqual({
      takeoverAt: old.takeoverAt,
    })
    expect(restoreCheckoutSparkRecoveryTiming({ takeoverAt: 0 })).toEqual({
      takeoverAt: 0,
    })
    const { takeoverAt: _oldDeadline, ...prepared } = old
    void _oldDeadline
    const plan = freezeCheckoutSparkSettledTreasuryPlan({
      ...prepared,
      executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
    })
    const inactive = checkoutSparkRecoveryTiming(plan)
    expect(restoreCheckoutSparkRecoveryTiming(inactive)).toEqual(inactive)
    expect(inactive.takeoverAt).toBeNull()
    const state = activateCheckoutSparkBuyer(
      createCheckoutSparkSettledReconciliation(plan),
      {
        buyerPubkey: "f".repeat(64),
        activatedAt: plan.createdAt + 300_000,
      }
    )
    const active = checkoutSparkRecoveryTiming(plan, state.buyerActivation)
    expect(restoreCheckoutSparkRecoveryTiming(active)).toEqual(active)
    expect(checkoutSparkRecoveryTimingMatches(inactive, active)).toBe(false)
    expect(
      checkoutSparkRecoveryTimingMatches(active, {
        ...active,
        buyerActivationId: "a".repeat(64),
      } as typeof active)
    ).toBe(false)
    expect(() =>
      checkoutSparkRecoveryTiming(old, state.buyerActivation)
    ).toThrow()
    expect(compareCheckoutSparkRecoveryTiming(inactive, active)).toBe(1)
    expect(compareCheckoutSparkRecoveryTiming(active, inactive)).toBe(-1)
    expect(compareCheckoutSparkRecoveryTiming(inactive, inactive)).toBe(0)
    expect(
      compareCheckoutSparkRecoveryTiming(
        { takeoverAt: 100 },
        { takeoverAt: 200 }
      )
    ).toBe(-100)
  })

  it.each([
    { takeoverAt: null },
    { takeoverAt: Number.NaN },
    { takeoverAt: Number.POSITIVE_INFINITY },
    { takeoverAt: -1 },
    { executionTiming: "unknown", takeoverAt: 123 },
    { buyerActivationId: "a".repeat(64), takeoverAt: 123 },
    {
      executionTiming: "pay_activation_v1",
      buyerActivationId: null,
      takeoverAt: 123,
    },
    {
      executionTiming: "pay_activation_v1",
      buyerActivationId: "a".repeat(64),
      takeoverAt: null,
    },
    { executionTiming: "pay_activation_v1", takeoverAt: null },
    {
      executionTiming: "pay_activation_v1",
      buyerActivationId: "a".repeat(64),
      takeoverAt: 0,
    },
    {
      executionTiming: "pay_activation_v1",
      buyerActivationId: "invalid",
      takeoverAt: 123,
    },
  ])("rejects incomplete or nonfinite timing metadata %#", (value) => {
    expect(() => restoreCheckoutSparkRecoveryTiming(value)).toThrow()
  })
})
