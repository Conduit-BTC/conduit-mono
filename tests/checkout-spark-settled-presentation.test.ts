import { describe, expect, it } from "bun:test"
import {
  presentSettledRouterHeaderStatus,
  presentSettledRouterTimeline,
} from "../apps/market/src/lib/checkout-spark-settled-order-presentation"

const checkoutRoute = await Bun.file(
  "apps/market/src/routes/checkout.tsx"
).text()
const ordersRoute = await Bun.file("apps/market/src/routes/orders.tsx").text()
const shopperAdvance = await Bun.file(
  "apps/market/src/lib/checkout-spark-settled-shopper-advance.ts"
).text()

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
    expect(ordersRoute).toMatch(
      /presentSettledRouterHeaderStatus\(\s*deriveOrderHeaderStatus\(vm\)/
    )
    expect(ordersRoute).toContain(
      "isRouterOrder={vm.checkoutSparkRouted === true}"
    )
  })

  it("requires the shared deployment capability at route entry and saved-plan actions", () => {
    for (const route of [checkoutRoute, ordersRoute]) {
      expect(route).toContain("isQuantumRouterEnabled")
      expect(route).not.toContain("VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL")
      expect(route).not.toContain("canUseCheckoutSparkLocalRouterCanary")
    }
    expect(checkoutRoute).toContain("!isQuantumRouterEnabled() ||")
    const preparationGuard = checkoutRoute.slice(
      checkoutRoute.indexOf("const canContinueSettledPreparation = () =>"),
      checkoutRoute.indexOf(
        "let published = false",
        checkoutRoute.indexOf("const canContinueSettledPreparation = () =>")
      )
    )
    expect(preparationGuard).toMatch(
      /if \(!shouldContinueBuyerSession\(\) \|\| !isQuantumRouterEnabled\(\)\) \{\s*return false/
    )
    expect(checkoutRoute).toContain(
      "shouldContinue: canContinueSettledPreparation"
    )
    expect(ordersRoute).toMatch(
      /function canContinueRouterSession\(\): boolean \{[\s\S]*?isQuantumRouterEnabled\(\)/
    )
    expect(ordersRoute).toContain("shouldContinue: approvedSessionIsCurrent")
    expect(shopperAdvance).toContain("assertBeforeSend: async (target)")
    expect(shopperAdvance).toContain(
      "repository.assertLocalInvoiceOrigin(plan, target, assertSession)"
    )
  })

  it("keeps foreground pause, limited recovery and no-repeat-payment guidance visible", () => {
    expect(ordersRoute).toMatch(
      /routerBinding &&\s*settledRouterControl\?\.status !== "retired" &&\s*settledRouterControl\?\.status !== "complete" && \([\s\S]*?Keep this page open until payment processing finishes/
    )
    const visibleCopy = ordersRoute.replace(/\s+/g, " ")
    expect(visibleCopy).toContain(
      "return to this order to check its saved status—do not pay again."
    )
    expect(visibleCopy).toContain(
      "pause processing; a submitted payment cannot be cancelled."
    )
    expect(visibleCopy).toContain(
      "Keep recovery details until the checkout wallet can be safely retired."
    )
    expect(ordersRoute).not.toContain("takeover still needs funded validation")
    expect(ordersRoute).toContain(
      '<summary className="cursor-pointer">Payment details</summary>'
    )
  })

  it("keeps optional fee continuation separate from the commerce-paid label", () => {
    const routerSession = ordersRoute.slice(
      ordersRoute.indexOf("function canContinueRouterSession()"),
      ordersRoute.indexOf("async function continueSettledRouterCheckout(")
    )
    expect(routerSession).toContain("current.checkoutSparkRouted === true")
    expect(routerSession).not.toContain("isBuyerOrderPaid")
    expect(ordersRoute).toContain(
      "checkoutSparkSettlement: buyerSettlements.get(orderId)"
    )
    expect(ordersRoute).toContain(
      "checkoutSparkSettlement: buyerSettlements.get(selected.orderId)"
    )
  })
})
