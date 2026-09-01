import { describe, expect, it } from "bun:test"
import type {
  KnownOrderStatus,
  OrderLifecycle,
  OrderPickupFulfillmentSchema,
} from "@conduit/core"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  canOfferOrderPaymentAction,
  computeOrderTimelineStatuses,
  deriveOrderHeaderStatus,
  getOrderDeliveryEvidenceLabel,
  getOrderFilterPhase,
  getOrderPaymentContinuationCopy,
  getOrderPaymentMethodLabel,
  isZeroCostPickupOrder,
  shouldOfferOrderDeliveryRetry,
  shouldOfferOrderPaymentContinuation,
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

function zeroPickupFulfillment(
  sourceCurrency = "SAT"
): OrderPickupFulfillmentSchema {
  const organizer = "1".repeat(64)
  const merchant = "2".repeat(64)
  return {
    type: "pickup",
    organizerPubkey: organizer,
    handoffMode: "organizer_handoff",
    handlerPubkey: organizer,
    product: {
      coordinate: `30402:${merchant}:free-sticker`,
      eventId: "a".repeat(64),
      createdAt: 1_700_000_000_000,
      merchantPubkey: merchant,
    },
    calendar: {
      coordinate: `31923:${organizer}:market-day`,
      eventId: "b".repeat(64),
      createdAt: 1_700_000_001_000,
    },
    collection: {
      coordinate: `30405:${organizer}:market-catalog`,
      eventId: "c".repeat(64),
      createdAt: 1_700_000_002_000,
    },
    option: {
      coordinate: `30406:${organizer}:market-pickup`,
      eventId: "d".repeat(64),
      createdAt: 1_700_000_003_000,
      title: "Event pickup",
      location: "Public market hall",
    },
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: sourceCurrency,
      normalizedCurrency: sourceCurrency,
    },
  }
}

function zeroPickupVm(
  overrides: Partial<OrderLifecycle> = {},
  productSourceCurrency = "SATS",
  pickupSourceCurrency = "SAT"
): OrderViewModel {
  return vmFromLifecycle({
    checkoutMode: "pay_later",
    items: [
      {
        productId: zeroPickupFulfillment().product.coordinate,
        title: "Free sticker",
        format: "physical",
        quantity: 1,
        priceAtPurchase: 0,
        currency: "SATS",
        sourcePrice: {
          amount: 0,
          currency: productSourceCurrency,
          normalizedCurrency: productSourceCurrency,
        },
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: pickupSourceCurrency,
          normalizedCurrency: pickupSourceCurrency,
        },
        fulfillment: zeroPickupFulfillment(pickupSourceCurrency),
      },
    ],
    itemSubtotalSats: 0,
    shippingCostSats: 0,
    totalSats: 0,
    totalMsats: 0,
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    ...overrides,
  })
}

describe("buildOrderViewModel", () => {
  it("does not let expired relay failure erase stronger payment progress", () => {
    for (const progress of [
      { invoiceStatus: "received", paymentStatus: "paying" },
      { invoiceStatus: "received", paymentStatus: "paid" },
      { invoiceStatus: "received", paymentStatus: "ambiguous" },
      { invoiceStatus: "manual_required", paymentStatus: "manual_required" },
    ] as const) {
      const vm = vmFromLifecycle({
        orderDeliveryStatus: "failed",
        ...progress,
        phase: "failed",
      })

      expect(vm.phase).toBe("in_progress")
      expect(vm.actionNeeded).toBe(
        progress.paymentStatus === "ambiguous" ||
          progress.paymentStatus === "manual_required"
      )
      expect(computeOrderTimelineStatuses(vm).order_sent).not.toBe("failed")
      const header = deriveOrderHeaderStatus(vm)
      expect(header.detailLabel).not.toBe("Order not sent")
      expect(header.detailLabel).not.toBe("Saved locally; waiting for relay")
    }
  })

  it("does not let relay failure erase authenticated merchant observation", () => {
    const vm = buildOrderViewModel({
      orderId: "order-1",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        checkoutMode: "pay_later",
        orderDeliveryStatus: "failed",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        phase: "failed",
      }),
      messages: [
        {
          id: "merchant-response",
          orderId: "order-1",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "status_update",
          payload: { status: "accepted" },
        } as never,
      ],
    })

    expect(vm.orderDeliveryEvidence).toBe("confirmed")
    expect(vm.phase).toBe("in_progress")
    expect(vm.actionNeeded).toBe(false)
    expect(computeOrderTimelineStatuses(vm).order_sent).toBe("complete")
    expect(deriveOrderHeaderStatus(vm).detailLabel).not.toBe("Order not sent")
    const orderSent = buildOrderTimeline(vm)[0]
    expect(orderSent).toMatchObject({
      title: "Merchant confirmed order",
      subtitle:
        "Authenticated merchant activity shows the order reached the merchant; no relay acknowledgement was recorded.",
    })
    expect(orderSent?.subtitle).not.toContain("relay accepted")
  })
  it("renders from a durable lifecycle without any relay messages", () => {
    const vm = vmFromLifecycle()
    expect(vm.hasLifecycle).toBe(true)
    expect(vm.items).toHaveLength(1)
    expect(vm.items[0].displayTitle).toBe("Nostr Hoodie")
    expect(vm.totalSats).toBe(111)
    expect(vm.paymentStatus).toBe("paid")
  })

  it("distinguishes queued, relay-accepted, recipient-observed, and confirmed delivery", () => {
    const queued = vmFromLifecycle({
      orderDeliveryStatus: "pending",
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
    })
    expect(queued.orderDeliveryEvidence).toBe("locally_queued")
    expect(deriveOrderHeaderStatus(queued).detailLabel).toBe(
      "Saved locally; waiting for relay"
    )

    const relayAccepted = vmFromLifecycle({
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
    })
    expect(relayAccepted.orderDeliveryEvidence).toBe("relay_accepted")

    const recipientObserved = buildOrderViewModel({
      orderId: "order-1",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      }),
      messages: [
        {
          id: "invoice",
          orderId: "order-1",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "payment_request",
          payload: { invoice: "invoice" },
        } as never,
      ],
    })
    expect(recipientObserved.orderDeliveryEvidence).toBe("recipient_observed")

    expect(vmWithMerchantStatus("accepted").orderDeliveryEvidence).toBe(
      "confirmed"
    )
    expect(vmWithMerchantStatus("cancelled").orderDeliveryEvidence).toBe(
      "recipient_observed"
    )
    expect(
      getOrderDeliveryEvidenceLabel(
        vmWithMerchantStatus("cancelled").orderDeliveryEvidence
      )
    ).toBe("Merchant responded")
  })

  it("uses authenticated merchant status after a lost ACK without rewriting relay provenance", () => {
    const vm = buildOrderViewModel({
      orderId: "order-1",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        checkoutMode: "private_checkout",
        orderDeliveryStatus: "pending",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        phase: "pending",
      }),
      messages: [
        {
          id: "status-accepted",
          orderId: "order-1",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "status_update",
          payload: { status: "accepted" },
        } as never,
      ],
    })

    expect(vm.orderDeliveryStatus).toBe("pending")
    expect(vm.orderDeliveryEvidence).toBe("confirmed")
    expect(shouldOfferOrderPaymentContinuation(vm)).toBe(true)
    expect(shouldOfferOrderDeliveryRetry(vm)).toBe(false)
    expect(vm.actionNeeded).toBe(true)
    expect(getOrderPaymentContinuationCopy(vm)).toBe(
      "Authenticated merchant activity shows the order reached the merchant. Continue when you are ready to request and pay the Lightning invoice."
    )
  })

  it("does not use a merchant status addressed to another buyer as recipient evidence", () => {
    const vm = buildOrderViewModel({
      orderId: "order-1",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        checkoutMode: "private_checkout",
        orderDeliveryStatus: "pending",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        phase: "pending",
      }),
      messages: [
        {
          id: "status-accepted-other-buyer",
          orderId: "order-1",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "other-buyer",
          rawContent: "{}",
          type: "status_update",
          payload: { status: "accepted" },
        } as never,
      ],
    })

    expect(vm.merchantStatus).toBeNull()
    expect(vm.orderDeliveryEvidence).toBe("locally_queued")
    expect(shouldOfferOrderPaymentContinuation(vm)).toBe(false)
    expect(shouldOfferOrderDeliveryRetry(vm)).toBe(true)
  })

  it("retains the merchant source quote for historical item display", () => {
    const sourcePrice = {
      amount: 10,
      currency: "EUR",
      normalizedCurrency: "EUR",
    }
    const vm = vmFromLifecycle({
      items: [
        {
          productId: "30402:merchant:tea",
          quantity: 1,
          priceAtPurchase: 12_000,
          currency: "SATS",
          sourcePrice,
        },
      ],
    })

    expect(vm.items[0]?.sourcePrice).toEqual(sourcePrice)
  })

  it("skips fulfillment shipping for an explicitly digital-only order", () => {
    const vm = vmFromLifecycle({
      items: [
        {
          productId: "30402:merchant:digital-download",
          format: "digital",
          quantity: 1,
          priceAtPurchase: 111,
          currency: "SATS",
        },
      ],
    })

    expect(vm.requiresShipping).toBe(false)
    expect(buildOrderTimeline(vm).map((row) => row.key)).not.toContain(
      "fulfillment"
    )
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

  it("surfaces an anonymous public-note fallback as a private wallet flow", () => {
    const vm = vmFromLifecycle({
      checkoutMode: "external_wallet",
      publicZapSigner: undefined,
      publicZapFallback: true,
    })

    expect(vm.publicZapFallback).toBe(true)
    expect(vm.publicZapSigner).toBeNull()
    expect(getOrderPaymentMethodLabel(vm)).toBe("External wallet")
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

  it("preserves checkout snapshot parity for a zero pickup cost in any currency", () => {
    const vm = zeroPickupVm({}, "SATS", "USD")

    expect(vm.items[0]).toMatchObject({
      shippingCostSats: 0,
      sourceShippingCost: {
        amount: 0,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      fulfillment: {
        type: "pickup",
        costSats: 0,
        sourceCost: {
          amount: 0,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
    })
    expect(isZeroCostPickupOrder(vm)).toBe(true)
    expect(getOrderPaymentMethodLabel(vm)).toBe("No payment required")
  })

  it("recognizes only an exact all-pickup zero lifecycle as payment-free", () => {
    const pickup = zeroPickupVm()
    expect(isZeroCostPickupOrder(pickup)).toBe(true)
    expect(pickup.requiresPickup).toBe(true)
    expect(pickup.requiresShipping).toBe(false)
    expect(getOrderPaymentMethodLabel(pickup)).toBe("No payment required")
    expect(isZeroCostPickupOrder(zeroPickupVm({}, "BTC"))).toBe(true)
    expect(isZeroCostPickupOrder(zeroPickupVm({}, "MSATS"))).toBe(true)
    expect(isZeroCostPickupOrder(zeroPickupVm({}, "SATS", "USD"))).toBe(true)
    expect(isZeroCostPickupOrder(zeroPickupVm({}, "SATS", "POINTS"))).toBe(true)

    const genericZero = vmFromLifecycle({
      checkoutMode: "pay_later",
      items: [
        {
          productId: "30402:merchant:unverified-zero",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 0,
          currency: "SATS",
        },
      ],
      itemSubtotalSats: 0,
      totalSats: 0,
      totalMsats: 0,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
    })
    expect(isZeroCostPickupOrder(genericZero)).toBe(false)
    expect(getOrderPaymentMethodLabel(genericZero)).toBe("Pay later")

    const missingCanonicalSource = zeroPickupVm()
    delete missingCanonicalSource.items[0]!.sourcePrice
    expect(isZeroCostPickupOrder(missingCanonicalSource)).toBe(false)

    const legacyHandoff = zeroPickupVm()
    const legacyFulfillment = legacyHandoff.items[0]!.fulfillment
    if (legacyFulfillment?.type !== "pickup") {
      throw new Error("Expected pickup fixture")
    }
    delete legacyFulfillment.handoffMode
    delete legacyFulfillment.handlerPubkey
    expect(isZeroCostPickupOrder(legacyHandoff)).toBe(false)

    const missingOuterPickupCost = zeroPickupVm()
    delete missingOuterPickupCost.items[0]!.sourceShippingCost
    expect(isZeroCostPickupOrder(missingOuterPickupCost)).toBe(false)

    const conflictingOuterPickupCost = zeroPickupVm()
    conflictingOuterPickupCost.items[0]!.sourceShippingCost!.currency = "USD"
    expect(isZeroCostPickupOrder(conflictingOuterPickupCost)).toBe(false)

    const positivePickupCost = zeroPickupVm()
    positivePickupCost.items[0]!.shippingCostSats = 1
    expect(isZeroCostPickupOrder(positivePickupCost)).toBe(false)

    expect(isZeroCostPickupOrder(zeroPickupVm({}, "USD"))).toBe(false)
    expect(isZeroCostPickupOrder(zeroPickupVm({}, "POINTS"))).toBe(false)
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

  it("trusts a merchant-paid status when the local payment record is absent", () => {
    const vm = buildOrderViewModel({
      orderId: "relay-only-paid",
      merchantPubkey: "merchant",
      messages: [
        {
          id: "status-paid",
          orderId: "relay-only-paid",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "status_update",
          payload: { status: "paid" },
        } as never,
      ],
    })

    expect(vm.paymentStatus).toBe("not_started")
    expect(vm.phase).toBe("in_progress")
    expect(vm.flow).toBe("invoice")
    expect(computeOrderTimelineStatuses(vm).payment).toBe("complete")
    expect(getOrderFilterPhase(vm)).toBe("in_progress")
    expect(deriveOrderHeaderStatus(vm).primaryLabel).not.toBe("Pending")
    expect(
      buildOrderTimeline(vm).find((row) => row.key === "invoice")?.title
    ).toBe("Invoice received")
  })

  it("lets merchant confirmation supersede a stale local payment failure", () => {
    const vm = buildOrderViewModel({
      orderId: "merchant-confirmed-paid",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
        phase: "failed",
      }),
      messages: [
        {
          id: "status-paid",
          orderId: "merchant-confirmed-paid",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "status_update",
          payload: { status: "paid" },
        } as never,
      ],
    })

    expect(vm.phase).toBe("in_progress")
    expect(vm.actionNeeded).toBe(false)
    expect(computeOrderTimelineStatuses(vm).payment).toBe("complete")
    expect(
      buildOrderTimeline(vm).find((row) => row.key === "payment")?.title
    ).toBe("Payment sent")
    expect(deriveOrderHeaderStatus(vm).primaryLabel).not.toBe("Payment unclear")
  })
})

describe("buildOrderTimeline", () => {
  it("returns seven rows and injects the sats amount into the paid row", () => {
    const rows = buildOrderTimeline(vmFromLifecycle())
    expect(rows).toHaveLength(7)
    const paymentRow = rows.find((r) => r.key === "payment")
    expect(paymentRow?.subtitle).toContain("111 sats")
  })

  it("uses the shopper's Bitcoin label in payment timeline copy", () => {
    const rows = buildOrderTimeline(
      vmFromLifecycle(),
      (sats) => `₿${sats.toLocaleString("en-US")}`
    )

    expect(rows.find((row) => row.key === "payment")?.subtitle).toContain(
      "₿111"
    )
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

  it("warns against paying again when a public receipt is not observed", () => {
    const rows = buildOrderTimeline(
      vmFromLifecycle({
        paymentStatus: "ambiguous",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "receipt_not_observed",
      })
    )
    const paymentRow = rows.find((r) => r.key === "payment")

    expect(paymentRow?.title).toBe("Payment not confirmed")
    expect(paymentRow?.subtitle).toContain("do not pay again")
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

  it("removes invoice, payment, and proof rows from a free pickup order", () => {
    const vm = zeroPickupVm({
      buyerIdentityKind: "guest_ephemeral",
      paymentStatus: "failed",
      proofDeliveryStatus: "failed",
    })

    expect(vm.actionNeeded).toBe(false)
    expect(buildOrderTimeline(vm).map((row) => row.key)).toEqual([
      "order_sent",
      "merchant_confirmation",
      "fulfillment",
      "complete",
    ])
    expect(deriveOrderHeaderStatus(vm)).toMatchObject({
      primaryLabel: "Pending",
      detailLabel: "Awaiting merchant",
      actionNeeded: false,
    })
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

  it("Pending · Awaiting invoice after a pay-later order send", () => {
    const status = deriveOrderHeaderStatus(
      vmFromLifecycle({
        checkoutMode: "pay_later",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      })
    )
    expect(status.primaryLabel).toBe("Pending")
    expect(status.detailLabel).toBe("Awaiting invoice")
    expect(status.showSpinner).toBe(false)
  })

  it("offers payment continuation after a queued pay-now order reaches a relay", () => {
    const vm = vmFromLifecycle({
      checkoutMode: "private_checkout",
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
    })
    const status = deriveOrderHeaderStatus(vm)

    expect(shouldOfferOrderPaymentContinuation(vm)).toBe(true)
    expect(vm.actionNeeded).toBe(true)
    expect(status.primaryLabel).toBe("Action needed")
    expect(status.detailLabel).toBe("Continue payment")
    expect(status.actionNeeded).toBe(true)
  })

  it("blocks recovered payment after settlement, cancellation, completion, or a refund request", () => {
    for (const merchantStatus of [
      "paid",
      "shipped",
      "cancelled",
      "complete",
      "refund_requested",
    ] as const) {
      for (const paymentStatus of ["not_started", "failed"] as const) {
        const vm = buildOrderViewModel({
          orderId: "order-1",
          merchantPubkey: "merchant",
          lifecycle: baseLifecycle({
            checkoutMode: "private_checkout",
            invoiceStatus: "not_requested",
            paymentStatus,
            proofDeliveryStatus: "not_started",
          }),
          messages: [
            {
              id: `status-${merchantStatus}`,
              orderId: "order-1",
              createdAt: 2,
              senderPubkey: "merchant",
              recipientPubkey: "buyer",
              rawContent: "{}",
              type: "status_update",
              payload: { status: merchantStatus },
            } as never,
          ],
        })

        expect(canOfferOrderPaymentAction(vm)).toBe(false)
        expect(shouldOfferOrderPaymentContinuation(vm)).toBe(false)
        expect(vm.actionNeeded).toBe(false)
      }
    }

    for (const phase of ["cancelled", "completed"] as const) {
      const vm = vmFromLifecycle({
        checkoutMode: "private_checkout",
        invoiceStatus: "not_requested",
        paymentStatus: "failed",
        proofDeliveryStatus: "not_started",
        phase,
      })
      expect(canOfferOrderPaymentAction(vm)).toBe(false)
      expect(shouldOfferOrderPaymentContinuation(vm)).toBe(false)
      expect(vm.actionNeeded).toBe(false)
    }
  })

  it("blocks recovered payment after an authenticated merchant shipping update", () => {
    const vm = buildOrderViewModel({
      orderId: "order-1",
      merchantPubkey: "merchant",
      lifecycle: baseLifecycle({
        checkoutMode: "private_checkout",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      }),
      messages: [
        {
          id: "shipping-update",
          orderId: "order-1",
          createdAt: 2,
          senderPubkey: "merchant",
          recipientPubkey: "buyer",
          rawContent: "{}",
          type: "shipping_update",
          payload: { note: "On its way" },
        } as never,
      ],
    })

    expect(vm.merchantShippingUpdated).toBe(true)
    expect(canOfferOrderPaymentAction(vm)).toBe(false)
    expect(shouldOfferOrderPaymentContinuation(vm)).toBe(false)
    expect(vm.actionNeeded).toBe(false)
    expect(computeOrderTimelineStatuses(vm).fulfillment).toBe("complete")
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

  it("does not request another action when a public receipt is not observed", () => {
    const vm = vmFromLifecycle({
      paymentStatus: "ambiguous",
      proofDeliveryStatus: "not_started",
      zapReceiptStatus: "receipt_not_observed",
    })
    const status = deriveOrderHeaderStatus(vm)

    expect(status.primaryLabel).toBe("Payment unclear")
    expect(status.detailLabel).toBe("Do not pay again")
    expect(status.actionNeeded).toBe(false)
    expect(vm.actionNeeded).toBe(false)
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
