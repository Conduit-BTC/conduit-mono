import { describe, expect, it } from "bun:test"
import {
  checkoutSparkConduitFeeRecipient,
  freezeCheckoutSparkSettledEventPlan,
} from "@conduit/core"
import {
  assertCheckoutSparkRecoveryDestination,
  assertMerchantCheckoutSparkDispatchPlan,
} from "../apps/merchant/src/lib/checkout-spark-recovery-policy"
import { isLocalCheckoutSparkRecoveryRehearsal } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { checkoutSparkEventMarketFixture } from "./support/checkout-spark-event-market-fixture"

describe("Event recovery preserves all financial actors under the existing destination policy", () => {
  it("keeps production available and local canary hosted-read-only", () => {
    const f = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
    const production = freezeCheckoutSparkSettledEventPlan({
      ...f.input,
      recipients: f.input.recipients.map((recipient) =>
        recipient.kind !== "conduit"
          ? recipient
          : {
              ...recipient,
              recipientId: checkoutSparkConduitFeeRecipient("production"),
              destination: {
                ...recipient.destination,
                value: checkoutSparkConduitFeeRecipient("production"),
                source: { type: "conduit_allowlist", policy: "production" },
              },
            }
      ),
    })
    expect(() =>
      assertCheckoutSparkRecoveryDestination(production, false)
    ).not.toThrow()
    expect(() => assertCheckoutSparkRecoveryDestination(f.plan, false)).toThrow(
      "recovery destination is unavailable"
    )
    expect(() =>
      assertCheckoutSparkRecoveryDestination(f.plan, true)
    ).not.toThrow()
    const regtest = { ...production, network: "regtest" as const }
    expect(() =>
      assertCheckoutSparkRecoveryDestination(regtest, false)
    ).toThrow()
    expect(() =>
      assertCheckoutSparkRecoveryDestination(regtest, true)
    ).not.toThrow()
    const prior = process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
    process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS =
      f.plan.nativeTreasury!.sparkAddress
    try {
      expect(() =>
        assertMerchantCheckoutSparkDispatchPlan(f.plan, true)
      ).not.toThrow()
      expect(() =>
        assertMerchantCheckoutSparkDispatchPlan(production, true)
      ).not.toThrow()
    } finally {
      if (prior === undefined)
        delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
      else process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = prior
    }
  })

  it("rejects destination or policy relabeling even in an isolated rehearsal", () => {
    const f = checkoutSparkEventMarketFixture()
    const changed = structuredClone(f.plan)
    const conduit = changed.recipients.find(
      (recipient) => recipient.kind === "conduit"
    )!
    Object.assign(conduit.destination.source, { policy: "production" })
    expect(() =>
      assertCheckoutSparkRecoveryDestination(changed, true)
    ).toThrow()
    Object.assign(conduit.destination.source, { policy: "local_router_canary" })
    Object.assign(conduit.destination, { value: "other@wallet.conduit.market" })
    expect(() =>
      assertCheckoutSparkRecoveryDestination(changed, true)
    ).toThrow()
  })

  it("requires every existing local gate before enabling compatibility", () => {
    const local = {
      dev: true,
      deploymentProfile: "local",
      rehearsalFlag: "true",
      routerCanaryFlag: "true",
      hostname: "localhost",
    }
    expect(isLocalCheckoutSparkRecoveryRehearsal(local)).toBe(true)
    for (const patch of [
      { dev: false },
      { deploymentProfile: "preview" },
      { deploymentProfile: "production" },
      { rehearsalFlag: undefined },
      { routerCanaryFlag: undefined },
      { hostname: "sell.conduit.market" },
      { hostname: "127.0.0.1.evil.test" },
    ])
      expect(
        isLocalCheckoutSparkRecoveryRehearsal({ ...local, ...patch })
      ).toBe(false)
  })
})
