import { describe, expect, it } from "bun:test"
import {
  canContinueCheckoutSparkSettledRouteSession,
  type CheckoutSparkSettledRouteSession,
} from "../apps/market/src/lib/checkout-spark-settled-route-session"

function session(): CheckoutSparkSettledRouteSession {
  return {
    enabled: true,
    mounted: true,
    visible: true,
    actionsReady: true,
    identityCurrent: true,
    orderId: "synthetic-order",
    view: {
      orderId: "synthetic-order",
      phase: "in_progress",
      merchantStatus: null,
      checkoutSparkRouted: true,
    },
  }
}

describe("settled checkout foreground route session", () => {
  it("keeps the same visible buyer order eligible for authority checks", () => {
    expect(canContinueCheckoutSparkSettledRouteSession(session())).toBe(true)
  })

  it("leaves completed-commerce payout eligibility to fresh core authority", () => {
    const input = session()
    expect(
      canContinueCheckoutSparkSettledRouteSession({
        ...input,
        view: { ...input.view, phase: "completed" },
      })
    ).toBe(true)
  })

  it.each([
    "enabled",
    "mounted",
    "visible",
    "actionsReady",
    "identityCurrent",
  ] as const)(
    "revokes the foreground gate when %s is false",
    (
      field: Exclude<keyof CheckoutSparkSettledRouteSession, "orderId" | "view">
    ) => {
      expect(
        canContinueCheckoutSparkSettledRouteSession({
          ...session(),
          [field]: false,
        })
      ).toBe(false)
    }
  )

  it.each([
    { orderId: "another-order" },
    { phase: "cancelled" as const },
    { merchantStatus: "cancelled" as const },
    { merchantStatus: "refund_requested" as const },
    { checkoutSparkRouted: false },
  ])(
    "does not continue a changed or cancelled order view %j",
    (change: Partial<CheckoutSparkSettledRouteSession["view"]>) => {
      const input = session()
      expect(
        canContinueCheckoutSparkSettledRouteSession({
          ...input,
          view: { ...input.view, ...change },
        })
      ).toBe(false)
    }
  )
})
