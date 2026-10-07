import { describe, expect, it } from "bun:test"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { getMerchantOrderActions, type OrderSchema } from "@conduit/core"
import {
  buildMerchantOrderActionView,
  getMerchantOrderCancellationCopy,
  isAuthorizedZeroCostPickup,
  isMerchantOrderActionSurfacePending,
  runExclusiveOrderAction,
} from "../apps/merchant/src/lib/order-action-view"

describe("merchant order action presentation", () => {
  const fixture = createEventMarketOrderFixture({ price: 0 })
  const merchant = fixture.merchant
  const zeroCostOrder: Pick<
    OrderSchema,
    "items" | "subtotal" | "shippingCostSats"
  > = fixture.order

  it("prioritizes shipment and keeps cancellation in the secondary section", () => {
    const view = buildMerchantOrderActionView({
      actions: getMerchantOrderActions({ status: "paid", paid: true }),
      canSendInvoice: false,
      canRecordShipping: true,
      canRequestPaymentOutOfBand: false,
    })

    expect(view.nextStep).toBe("shipping")
    expect(view.hasNextStep).toBe(true)
    expect(view.primaryButtonActions.map((action) => action.action)).toEqual([
      "manual_complete",
    ])
    expect(view.destructiveActions.map((action) => action.label)).toEqual([
      "Cancel order",
    ])
  })

  it("keeps accepted guest payment requests as an explicit next step", () => {
    const view = buildMerchantOrderActionView({
      actions: getMerchantOrderActions({
        status: "accepted",
        accepted: true,
        buyerReplyable: false,
      }),
      canSendInvoice: false,
      canRecordShipping: false,
      canRequestPaymentOutOfBand: true,
    })

    expect(view.nextStep).toBe("primary_action")
    expect(view.hasNextStep).toBe(true)
    expect(view.primaryButtonActions.map((action) => action.label)).toEqual([
      "Confirm payment received",
    ])
  })

  it("keeps an unverified pickup out of shipping and completion actions", () => {
    const view = buildMerchantOrderActionView({
      actions: [
        {
          action: "complete",
          status: "complete",
          label: "Mark picked up / complete",
          kind: "primary",
        },
        {
          action: "cancel",
          status: "cancelled",
          label: "Cancel order",
          kind: "destructive",
        },
      ],
      canSendInvoice: false,
      canRecordShipping: true,
      canRequestPaymentOutOfBand: false,
      fulfillmentActionsAuthorized: false,
    })

    expect(view.primaryButtonActions).toEqual([])
    expect(view.destructiveActions.map((action) => action.action)).toEqual([
      "cancel",
    ])
    expect(view.nextStep).toBeNull()
    expect(view.hasNextStep).toBe(false)
  })

  it("unlocks accepted zero-cost pickup completion only after exact authorization", () => {
    expect(
      isAuthorizedZeroCostPickup({
        order: zeroCostOrder,
        fulfillmentMode: "pickup",
        requiresShipping: false,
        pickupAuthorizationVerified: true,
      })
    ).toBe(true)

    const actions = getMerchantOrderActions({
      status: "accepted",
      accepted: true,
      fulfillmentMode: "pickup",
      requiresShipping: false,
      isZeroCostPickup: true,
    })
    expect(
      buildMerchantOrderActionView({
        actions,
        canSendInvoice: false,
        canRecordShipping: false,
        canRequestPaymentOutOfBand: false,
        fulfillmentActionsAuthorized: true,
      }).primaryButtonActions.map((action) => action.label)
    ).toEqual(["Mark picked up / complete"])
    expect(
      buildMerchantOrderActionView({
        actions,
        canSendInvoice: false,
        canRecordShipping: false,
        canRequestPaymentOutOfBand: false,
        fulfillmentActionsAuthorized: false,
      }).primaryButtonActions
    ).toEqual([])
  })

  it("does not infer zero-cost pickup from unverified or inconsistent terms", () => {
    for (const input of [
      {
        order: zeroCostOrder,
        fulfillmentMode: "pickup" as const,
        requiresShipping: false,
        pickupAuthorizationVerified: false,
      },
      {
        order: zeroCostOrder,
        fulfillmentMode: "shipping" as const,
        requiresShipping: true,
        pickupAuthorizationVerified: true,
      },
      {
        order: { ...zeroCostOrder, subtotal: 1 },
        fulfillmentMode: "pickup" as const,
        requiresShipping: false,
        pickupAuthorizationVerified: true,
      },
      {
        order: {
          ...zeroCostOrder,
          items: [{ ...zeroCostOrder.items[0]!, shippingCostSats: 1 }],
        },
        fulfillmentMode: "pickup" as const,
        requiresShipping: false,
        pickupAuthorizationVerified: true,
      },
      {
        order: {
          ...zeroCostOrder,
          items: [
            zeroCostOrder.items[0]!,
            {
              productId: `30402:${merchant}:free-download`,
              format: "digital" as const,
              fulfillment: { type: "digital" as const },
              quantity: 1,
              priceAtPurchase: 0,
              currency: "SATS",
            },
          ],
        },
        fulfillmentMode: "pickup" as const,
        requiresShipping: false,
        pickupAuthorizationVerified: true,
      },
    ]) {
      expect(isAuthorizedZeroCostPickup(input)).toBe(false)
    }
  })

  it("preserves decline wording before acceptance", () => {
    const copy = getMerchantOrderCancellationCopy({
      actionLabel: "Decline order",
      buyerInboxKnown: true,
      merchantPaid: false,
      paymentObserved: false,
    })

    expect(copy).toMatchObject({
      title: "Decline this order?",
      confirmLabel: "Decline order",
      description: "This records the order as declined and notifies the buyer.",
      warning: null,
    })
  })

  it("warns about refund risk for both confirmed and reported payment", () => {
    const confirmed = getMerchantOrderCancellationCopy({
      actionLabel: "Cancel order",
      buyerInboxKnown: true,
      merchantPaid: true,
      paymentObserved: true,
    })
    const reported = getMerchantOrderCancellationCopy({
      actionLabel: "Cancel order",
      buyerInboxKnown: true,
      merchantPaid: false,
      paymentObserved: true,
    })

    expect(confirmed.warning).toContain("already paid")
    expect(confirmed.description).toContain("does not return funds")
    expect(reported.warning).toContain("Verify settlement")
    expect(reported.description).toContain("must be refunded separately")
  })

  it("locks every order action while any order mutation is pending", () => {
    expect(
      isMerchantOrderActionSurfacePending({
        generateInvoice: false,
        sendInvoice: false,
        advanceStatus: false,
        recordShipping: true,
      })
    ).toBe(true)
    expect(
      isMerchantOrderActionSurfacePending({
        generateInvoice: false,
        sendInvoice: false,
        advanceStatus: false,
        recordShipping: false,
      })
    ).toBe(false)
  })

  it("rejects concurrent order publications and releases the lock", async () => {
    const lock = { current: false }
    let releaseFirst: (() => void) | undefined
    const first = runExclusiveOrderAction(
      lock,
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("published")
        })
    )

    expect(lock.current).toBe(true)
    await expect(
      runExclusiveOrderAction(lock, async () => "should not publish")
    ).rejects.toThrow("Another order action is already in progress.")
    releaseFirst?.()
    await expect(first).resolves.toBe("published")
    expect(lock.current).toBe(false)
  })
})
