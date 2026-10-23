import { describe, expect, it } from "bun:test"
import {
  checkoutSparkSettledTimingForContext,
  isCheckoutSparkLocalRouterCanaryContext,
} from "../apps/market/src/lib/checkout-spark-local-router-canary"

describe("checkout Spark local router canary gate", () => {
  it("uses a three-minute handoff only for the explicitly opted-in local rehearsal", () => {
    expect(
      checkoutSparkSettledTimingForContext({
        dev: true,
        flag: "true",
        hostname: "127.0.0.1",
        rehearsalFlag: "true",
        fastHandoffFlag: "true",
      })
    ).toEqual({ fundingExpirySecs: 120, takeoverAfterMs: 180_000 })
  })

  it("keeps normal timing unless every demo gate is satisfied", () => {
    const demo = {
      dev: true,
      flag: "true",
      hostname: "127.0.0.1",
      rehearsalFlag: "true",
      fastHandoffFlag: "true",
    }
    for (const context of [
      { ...demo, dev: false },
      { ...demo, deploymentProfile: "preview" },
      { ...demo, deploymentProfile: "production" },
      { ...demo, deploymentProfile: "staging" },
      { ...demo, deploymentProfile: "unknown" },
      { ...demo, flag: undefined },
      { ...demo, rehearsalFlag: undefined },
      { ...demo, fastHandoffFlag: undefined },
      { ...demo, fastHandoffFlag: "false" },
      { ...demo, fastHandoffFlag: "TRUE" },
      { ...demo, hostname: "shop.conduit.market" },
      { ...demo, hostname: "localhost.example.com" },
      { ...demo, hostname: undefined },
    ]) {
      expect(checkoutSparkSettledTimingForContext(context)).toEqual({
        fundingExpirySecs: 900,
        takeoverAfterMs: 120_000,
      })
    }
  })

  it("requires a development build, explicit opt-in, and an exact loopback host", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
      expect(
        isCheckoutSparkLocalRouterCanaryContext({
          dev: true,
          flag: "true",
          hostname,
        })
      ).toBe(true)
    }

    for (const context of [
      { dev: false, flag: "true", hostname: "localhost" },
      {
        dev: true,
        flag: "true",
        hostname: "localhost",
        deploymentProfile: "preview",
      },
      {
        dev: true,
        flag: "true",
        hostname: "localhost",
        deploymentProfile: "production",
      },
      { dev: true, flag: undefined, hostname: "localhost" },
      { dev: true, flag: "TRUE", hostname: "localhost" },
      { dev: true, flag: "true", hostname: "localhost.example.com" },
      { dev: true, flag: "true", hostname: "127.0.0.2" },
      { dev: true, flag: "true", hostname: "shop.conduit.market" },
      { dev: true, flag: "true", hostname: undefined },
    ]) {
      expect(isCheckoutSparkLocalRouterCanaryContext(context)).toBe(false)
    }
  })
})
