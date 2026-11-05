import { describe, expect, it } from "bun:test"
import {
  presentSettledRouterHeaderStatus,
  presentSettledRouterTimeline,
} from "../apps/market/src/lib/checkout-spark-settled-order-presentation"

const checkoutRoute = await Bun.file(
  "apps/market/src/routes/checkout.tsx"
).text()
const ordersRoute = await Bun.file("apps/market/src/routes/orders.tsx").text()

describe("settled router buyer presentation", () => {
  it("does not call a bound order 'Awaiting invoice' or show a merchant-invoice milestone", () => {
    const status = {
      tone: "warning" as const,
      primaryLabel: "Pending",
      detailLabel: "Awaiting invoice",
      actionNeeded: false,
      showSpinner: false,
    }
    const rows = [
      {
        key: "order_sent",
        title: "Order sent",
        subtitle: "Order sent",
        status: "complete" as const,
      },
      {
        key: "invoice",
        title: "Merchant invoice",
        subtitle: "Awaiting invoice",
        status: "waiting" as const,
      },
      {
        key: "receipt",
        title: "Receipt sent",
        subtitle: "Generic buyer proof",
        status: "waiting" as const,
      },
    ]

    expect(presentSettledRouterHeaderStatus(status, true).detailLabel).toBe(
      "Private Spark routing"
    )
    expect(
      presentSettledRouterHeaderStatus(
        { ...status, detailLabel: "Invoice ready" },
        true
      ).detailLabel
    ).toBe("Private Spark routing")
    expect(presentSettledRouterTimeline(rows, true)).toEqual([rows[0]])
    expect(presentSettledRouterHeaderStatus(status, false)).toBe(status)
    expect(presentSettledRouterTimeline(rows, false)).toBe(rows)
  })

  it("separates new checkout admission from saved-plan execution and observation", () => {
    for (const route of [checkoutRoute, ordersRoute]) {
      expect(route).not.toContain("VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL")
      expect(route).not.toContain("canUseCheckoutSparkLocalRouterCanary")
    }
  })
})
