import { describe, expect, it } from "bun:test"
import { getMerchantOrderActions } from "@conduit/core"
import {
  buildMerchantOrderActionView,
  getMerchantOrderCancellationCopy,
  isMerchantOrderActionSurfacePending,
  runExclusiveOrderAction,
} from "../apps/merchant/src/lib/order-action-view"

describe("merchant order action presentation", () => {
  it("prioritizes shipment and keeps cancellation in the secondary section", () => {
    const view = buildMerchantOrderActionView({
      actions: getMerchantOrderActions({ status: "paid", paid: true }),
      canSendInvoice: false,
      canRecordShipping: true,
      canRequestPaymentOutOfBand: false,
    })

    expect(view.nextStep).toBe("shipping")
    expect(view.hasNextStep).toBe(true)
    expect(view.primaryButtonActions).toEqual([])
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
