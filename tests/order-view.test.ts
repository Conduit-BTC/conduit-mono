import { describe, expect, it } from "bun:test"
import type { KnownOrderStatus, OrderLifecycle } from "@conduit/core"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  computeOrderTimelineStatuses,
  deriveOrderHeaderStatus,
  getOrderFilterPhase,
  getOrderPaymentMethodLabel,
  type OrderViewModel,
} from "../apps/market/src/lib/order-view"

function baseLifecycle(
  overrides: Partial<OrderLifecycle> = {}
): OrderLifecycle {
  return {
    orderId: "order-1",
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    checkoutMode: "public_zap",
    items: [
      {
        productId: "30402:merchant:nostr-hoodie",
        quantity: 1,
        priceAtPurchase: 111,
        currency: "SATS",
      },
    ],
    itemSubtotalSats: 111,
    shippingCostSats: 0,
    totalSats: 111,
    totalMsats: 111_000,
    currency: "SATS",
    addressValidity: "valid",
    shippingZoneEligibility: "eligible",
    orderDeliveryStatus: "sent",
    invoiceStatus: "received",
    paymentStatus: "paid",
    proofDeliveryStatus: "sent",
    zapReceiptStatus: "waiting",
    phase: "in_progress",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function vmFromLifecycle(
  overrides: Partial<OrderLifecycle> = {}
): OrderViewModel {
  return buildOrderViewModel({
    orderId: "order-1",
    lifecycle: baseLifecycle(overrides),
  })
}

function vmWithMerchantStatus(status: KnownOrderStatus): OrderViewModel {
  return buildOrderViewModel({
    orderId: "order-1",
    merchantPubkey: "merchant",
    lifecycle: baseLifecycle(),
    messages: [
      {
        id: `status-${status}`,
        orderId: "order-1",
        createdAt: 2,
        senderPubkey: "merchant",
        recipientPubkey: "buyer",
        rawContent: "{}",
        type: "status_update",
        payload: { status },
      } as never,
    ],
  })
}

describe("buildOrderViewModel", () => {
  it("renders from a durable lifecycle without any relay messages", () => {
    const vm = vmFromLifecycle()
    expect(vm.hasLifecycle).toBe(true)
    expect(vm.items).toHaveLength(1)
    expect(vm.items[0].displayTitle).toBe("Nostr Hoodie")
    expect(vm.totalSats).toBe(111)
    expect(vm.paymentStatus).toBe("paid")
  })

  it("preserves public zap attribution for external-wallet fallback orders", () => {
    const anon = vmFromLifecycle({
      checkoutMode: "external_wallet",
      publicZapSigner: "anon",
    })
    const shopper = vmFromLifecycle({
      checkoutMode: "external_wallet",
      publicZapSigner: "shopper",
    })

    expect(anon.publicZapSigner).toBe("anon")
    expect(getOrderPaymentMethodLabel(anon)).toBe("Anonymous public zap")
    expect(getOrderPaymentMethodLabel(shopper)).toBe("Public zap as shopper")
  })

  it("prefers the lifecycle product title snapshot over a d-tag fallback", () => {
    const vm = vmFromLifecycle({
      items: [
        {
          productId:
            "30402:merchant:cnd26-publicnd26-public-product-ref-testc-product-ref-test-ec3t68",
          title: "CND26 Public Product Ref Test",
          quantity: 1,
          priceAtPurchase: 111,
          currency: "SATS",
        },
      ],
    })

    expect(vm.items[0].displayTitle).toBe("CND26 Public Product Ref Test")
  })

  it("derives statuses from conversation messages when no lifecycle exists", () => {
    const vm = buildOrderViewModel({
      orderId: "order-2",
      merchantPubkey: "merchant",
      messages: [
        {
          id: "m1",
          orderId: "order-2",
          createdAt: 1,
          senderPubkey: "buyer",
          recipientPubkey: "merchant",
          rawContent: "{}",
          type: "order",
          payload: {
            items: [
              {
                productId: "30402:merchant:sticker-pack",
                quantity: 2,
                priceAtPurchase: 250,
                currency: "SATS",
              },
            ],
          },
        } as never,
      ],
    })
    expect(vm.hasLifecycle).toBe(false)
    expect(vm.orderDeliveryStatus).toBe("sent")
    expect(vm.paymentStatus).toBe("not_started")
    expect(vm.items[0].displayTitle).toBe("Sticker Pack")
  })
})

describe("computeOrderTimelineStatuses", () => {
  it("marks paid + receipt-sent through the payment rows, merchant confirmation in progress", () => {
    const statuses = computeOrderTimelineStatuses(vmFromLifecycle())
    expect(statuses.order_sent).toBe("complete")
    expect(statuses.invoice).toBe("complete")
    expect(statuses.payment).toBe("complete")
    expect(statuses.receipt).toBe("complete")
    expect(statuses.merchant_confirmation).toBe("in_progress")
    expect(statuses.fulfillment).toBe("waiting")
    expect(statuses.complete).toBe("waiting")
  })

  it("shows awaiting-invoice state after order send", () => {
    const statuses = computeOrderTimelineStatuses(
      vmFromLifecycle({
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(statuses.order_sent).toBe("complete")
    expect(statuses.invoice).toBe("waiting")
    expect(statuses.payment).toBe("waiting")
  })

  it("flags receipt retry when proof delivery failed after payment moved", () => {
    const statuses = computeOrderTimelineStatuses(
      vmFromLifecycle({ proofDeliveryStatus: "retry_needed" })
    )
    expect(statuses.payment).toBe("complete")
    expect(statuses.receipt).toBe("retry_needed")
  })

  it("treats manual external payment as payment in progress with invoice complete", () => {
    const statuses = computeOrderTimelineStatuses(
      vmFromLifecycle({
        checkoutMode: "external_wallet",
        invoiceStatus: "manual_required",
        paymentStatus: "manual_required",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(statuses.invoice).toBe("complete")
    expect(statuses.payment).toBe("in_progress")
  })

  it("flags an ambiguous payment for review without marking it complete", () => {
    const statuses = computeOrderTimelineStatuses(
      vmFromLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(statuses.payment).toBe("retry_needed")
    expect(statuses.merchant_confirmation).toBe("waiting")
  })
})

describe("buildOrderTimeline", () => {
  it("returns seven rows and injects the sats amount into the paid row", () => {
    const rows = buildOrderTimeline(vmFromLifecycle())
    expect(rows).toHaveLength(7)
    const paymentRow = rows.find((r) => r.key === "payment")
    expect(paymentRow?.subtitle).toContain("111 sats")
  })

  it("rewrites the payment row copy when the payment is ambiguous", () => {
    const rows = buildOrderTimeline(
      vmFromLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
      })
    )
    const paymentRow = rows.find((r) => r.key === "payment")
    expect(paymentRow?.status).toBe("retry_needed")
    expect(paymentRow?.title).toBe("Payment needs review")
    expect(paymentRow?.subtitle).toContain("couldn't confirm")
  })

  it("stops guest timelines at outbound receipt delivery", () => {
    const rows = buildOrderTimeline(
      vmFromLifecycle({ buyerIdentityKind: "guest_ephemeral" })
    )

    expect(rows.map((row) => row.key)).toEqual([
      "order_sent",
      "invoice",
      "payment",
      "receipt",
    ])
  })
})

describe("getOrderFilterPhase", () => {
  it("buckets an unpaid, awaiting-invoice order as pending", () => {
    expect(
      getOrderFilterPhase(
        vmFromLifecycle({
          invoiceStatus: "not_requested",
          paymentStatus: "not_started",
        })
      )
    ).toBe("pending")
  })

  it("buckets a paid order as in progress", () => {
    expect(getOrderFilterPhase(vmFromLifecycle())).toBe("in_progress")
  })

  it("buckets completed and cancelled orders", () => {
    expect(getOrderFilterPhase(vmFromLifecycle({ phase: "completed" }))).toBe(
      "completed"
    )
    expect(getOrderFilterPhase(vmFromLifecycle({ phase: "cancelled" }))).toBe(
      "cancelled"
    )
  })
})

describe("accepted status flows through the buyer view-model", () => {
  it("treats accepted as merchant-confirmed in the timeline", () => {
    const statuses = computeOrderTimelineStatuses({
      ...vmFromLifecycle(),
      merchantStatus: "accepted",
    })
    expect(statuses.merchant_confirmation).toBe("complete")
  })

  it("buckets an accepted (unpaid) order as in progress", () => {
    expect(
      getOrderFilterPhase({
        ...vmFromLifecycle(),
        merchantStatus: "accepted",
        paymentStatus: "not_started",
      })
    ).toBe("in_progress")
  })
})

describe("deriveOrderHeaderStatus", () => {
  it("Paid · Receipt sent when proof delivered and merchant has not confirmed", () => {
    const status = deriveOrderHeaderStatus(vmFromLifecycle())
    expect(status.primaryLabel).toBe("Merchant confirmation")
    expect(status.detailLabel).toBe("Waiting for merchant")
    expect(status.actionNeeded).toBe(false)
    expect(status.showSpinner).toBe(true)
  })

  it("finishes guest tracking when the outbound receipt is delivered", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({ buyerIdentityKind: "guest_ephemeral" })
    )

    expect(status.primaryLabel).toBe("Receipt sent")
    expect(status.detailLabel).toBe("Merchant follow-up uses phone and email")
    expect(status.showSpinner).toBe(false)
  })

  it("Pending · Awaiting invoice after order send", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(status.primaryLabel).toBe("Pending")
    expect(status.detailLabel).toBe("Awaiting invoice")
    expect(status.showSpinner).toBe(false)
  })

  it("Action needed for manual external payment", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({
        checkoutMode: "external_wallet",
        paymentStatus: "manual_required",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(status.primaryLabel).toBe("Action needed")
    expect(status.actionNeeded).toBe(true)
    expect(status.showSpinner).toBe(false)
  })

  it("Payment unclear when the rail leaves payment ambiguous", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(status.primaryLabel).toBe("Payment unclear")
    expect(status.tone).toBe("warning")
    expect(status.actionNeeded).toBe(true)
    expect(status.showSpinner).toBe(false)
  })

  it("prefers the wallet-check warning over normal retry guidance", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(status.detailLabel).toBe("Check wallet before retrying")
  })

  it("Completed · Delivered when the merchant marks the order complete", () => {
    const vm = vmWithMerchantStatus("complete")
    const status = deriveOrderHeaderStatus(vm)
    expect(status.primaryLabel).toBe("Completed")
    expect(status.detailLabel).toBe("Delivered")
    expect(vm.phase).toBe("completed")
    expect(status.showSpinner).toBe(false)
  })

  it("treats delivered as the same terminal completion state", () => {
    const vm = vmWithMerchantStatus("delivered")
    const status = deriveOrderHeaderStatus(vm)

    expect(getOrderFilterPhase(vm)).toBe("completed")
    expect(computeOrderTimelineStatuses(vm).complete).toBe("complete")
    expect(status.primaryLabel).toBe("Completed")
    expect(status.detailLabel).toBe("Delivered")
  })

  it("surfaces a refund request without claiming a payout occurred", () => {
    const status = deriveOrderHeaderStatus(
      vmWithMerchantStatus("refund_requested")
    )

    expect(status.tone).toBe("warning")
    expect(status.primaryLabel).toBe("Refund requested")
    expect(status.detailLabel).toBe("Awaiting merchant response")
  })
})
