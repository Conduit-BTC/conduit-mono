import { expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import type { OrderLifecycle, OrderSchema } from "@conduit/core"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  computeOrderTimelineStatuses,
  isBuyerOrderPaid,
} from "../apps/market/src/lib/order-view"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
} from "./support/checkout-spark-event-market-fixture"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function finiteOrder(price = 1_000) {
  const fixture = checkoutSparkEventMarketFixture({
    mode: "organizer_handoff",
    commerceTotalSats: price,
    stockGrant: { writerId: crypto.randomUUID(), quantity: 4 },
  })
  const order = createCheckoutSparkEventMarketFixtureOrder(
    fixture,
    NDKPrivateKeySigner.generate().pubkey
  )
  return { fixture, order }
}

function viewFor(
  {
    fixture,
    order,
  }: {
    fixture?: ReturnType<typeof finiteOrder>["fixture"]
    order: OrderSchema
  },
  verified = true
) {
  const lifecycle: OrderLifecycle = {
    orderId: order.id,
    buyerPubkey: order.buyerPubkey,
    merchantPubkey: order.merchantPubkey,
    checkoutMode: fixture ? "private_checkout" : "pay_later",
    buyerIdentityKind: "signed_in",
    items: order.items,
    itemSubtotalSats: order.subtotal,
    shippingCostSats: 0,
    totalSats: order.subtotal,
    totalMsats: order.subtotal * 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "received",
    paymentStatus: "paid",
    proofDeliveryStatus: "sent",
    zapReceiptStatus: "waiting",
    phase: "in_progress",
    createdAt: order.createdAt,
    updatedAt: order.createdAt,
    ...(fixture
      ? {
          checkoutSparkRouterBinding: {
            checkoutId: fixture.plan.checkoutId,
            planDigest: fixture.plan.planDigest,
            walletId: fixture.plan.walletId,
          },
        }
      : {}),
  }
  return buildOrderViewModel({
    orderId: order.id,
    lifecycle,
    checkoutSparkSettlement: fixture ? { commerceVerified: verified } : null,
  })
}

it("guides a finite-pool Buyer to the organizer without requiring a live Merchant receipt", () => {
  const vm = viewFor(finiteOrder())
  const rows = buildOrderTimeline(vm)
  expect(rows.some((row) => row.key === "merchant_confirmation")).toBe(false)
  const pickup = rows.find((row) => row.key === "fulfillment")!
  expect(pickup.title).toBe("Pickup from event organizer")
  expect(pickup.subtitle).toContain("private pickup receipt")
  expect(pickup.subtitle).toContain("payment and reserved stock")
  expect(pickup.subtitle).not.toContain("after the merchant")
  expect(pickup.status).toBe("waiting")
  expect(vm.merchantStatus).toBeNull()
  expect(computeOrderTimelineStatuses(vm).merchant_confirmation).toBe(
    "in_progress"
  )
  expect(isBuyerOrderPaid(vm)).toBe(true)
})

it("does not infer paid commerce, Merchant confirmation or pickup completion from a signed pool", () => {
  const vm = viewFor(finiteOrder(), false)
  const rows = buildOrderTimeline(vm)
  expect(isBuyerOrderPaid(vm)).toBe(false)
  expect(vm.merchantStatus).toBeNull()
  expect(rows.find((row) => row.key === "payment")!.status).toBe("waiting")
  expect(rows.find((row) => row.key === "fulfillment")!.status).toBe("waiting")
  expect(rows.find((row) => row.key === "complete")!.status).toBe("waiting")
  expect(computeOrderTimelineStatuses(vm).merchant_confirmation).toBe("waiting")
})

it("keeps Merchant release instructions on historical organizer orders", () => {
  const vm = viewFor({
    order: createEventMarketOrderFixture({ mode: "organizer_handoff" }).order,
  })
  const rows = buildOrderTimeline(vm)
  expect(rows.some((row) => row.key === "merchant_confirmation")).toBe(true)
  expect(rows.find((row) => row.key === "fulfillment")!.subtitle).toContain(
    "after the merchant confirms payment"
  )
})

it("keeps historical free release instructions, but avoids the live Merchant step for finite stock", () => {
  const historical = viewFor({
    order: createEventMarketOrderFixture({
      mode: "organizer_handoff",
      price: 0,
    }).order,
  })
  expect(
    buildOrderTimeline(historical).find((row) => row.key === "fulfillment")!
      .subtitle
  ).toContain("after the merchant sends")
  const finite = viewFor(finiteOrder(0))
  const rows = buildOrderTimeline(finite)
  expect(rows.some((row) => row.key === "merchant_confirmation")).toBe(false)
  expect(rows.find((row) => row.key === "fulfillment")!.subtitle).toContain(
    "check reserved stock"
  )
  expect(rows.find((row) => row.key === "fulfillment")!.status).toBe("waiting")
})

it.each([
  "missing",
  "invalid",
  "absent",
  "closed",
  "wrong_revision",
  "mixed",
] as const)(
  "does not replace the fallback for %s finite-stock evidence",
  (condition) => {
    const f = finiteOrder()
    const vm = viewFor(f)
    const fulfillment = vm.items[0]!.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Expected Event Market snapshot")
    const snapshot = fulfillment.occurrenceAssignment!
    if (condition === "missing") delete fulfillment.occurrenceAssignment
    else if (condition === "invalid")
      snapshot.signedEvent = { ...snapshot.signedEvent, sig: "invalid" }
    else if (condition === "wrong_revision")
      snapshot.eventId = f.fixture.events.market.id
    else if (condition === "mixed")
      vm.items.push({
        ...vm.items[0]!,
        fulfillment: createEventMarketOrderFixture().fulfillment,
      })
    else {
      const event =
        condition === "absent"
          ? f.fixture.originalAssignment
          : f.fixture.signMerchant({
              ...snapshot.signedEvent,
              tags: snapshot.signedEvent.tags.map((tag) =>
                tag[0] === "conduit_stock_pool"
                  ? [tag[0], tag[1]!, "closed", ...tag.slice(3)]
                  : tag
              ),
            })
      snapshot.signedEvent = event
      snapshot.eventId = event.id
      snapshot.createdAt = event.created_at * 1_000
    }
    const rows = buildOrderTimeline(vm)
    expect(rows.some((row) => row.key === "merchant_confirmation")).toBe(true)
    expect(rows.find((row) => row.key === "fulfillment")!.subtitle).toContain(
      "after the merchant"
    )
  }
)
