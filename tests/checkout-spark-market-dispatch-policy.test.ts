import { describe, expect, it } from "bun:test"
import {
  checkoutSparkConduitFeeRecipient,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import { assertMarketCheckoutSparkDispatchPlan } from "../apps/market/src/lib/checkout-spark-dispatch-policy"

function plan(
  policy: "production" | "local_router_canary",
  network: "mainnet" | "regtest" = "mainnet"
): Pick<CheckoutSparkSettledPlan, "network" | "recipients"> {
  const recipient = checkoutSparkConduitFeeRecipient(policy)
  return {
    network,
    recipients: [
      {
        kind: "conduit",
        recipientId: recipient,
        destination: {
          type: "lightning_address",
          value: recipient,
          source: { type: "conduit_allowlist", policy },
        },
        weightSats: 111,
      },
    ],
  }
}

describe("Market hosted checkout dispatch policy", () => {
  it("admits the canonical mainnet production recipient", () => {
    expect(() =>
      assertMarketCheckoutSparkDispatchPlan(plan("production"), false)
    ).not.toThrow()
  })
  it("rejects saved local test plans, even though their policy is otherwise valid", () => {
    expect(() =>
      assertMarketCheckoutSparkDispatchPlan(plan("local_router_canary"), false)
    ).toThrow("unavailable")
    expect(() =>
      assertMarketCheckoutSparkDispatchPlan(plan("local_router_canary"), true)
    ).not.toThrow()
  })
  it("rejects regtest and relabeled or changed fee destinations", () => {
    expect(() =>
      assertMarketCheckoutSparkDispatchPlan(
        plan("production", "regtest"),
        false
      )
    ).toThrow("unavailable")
    for (const field of ["value", "recipientId"] as const) {
      const changed = plan("production")
      if (field === "value")
        changed.recipients[0]!.destination.value =
          checkoutSparkConduitFeeRecipient("local_router_canary")
      else
        changed.recipients[0]!.recipientId = checkoutSparkConduitFeeRecipient(
          "local_router_canary"
        )
      expect(() =>
        assertMarketCheckoutSparkDispatchPlan(changed, false)
      ).toThrow("unavailable")
    }
  })
})
