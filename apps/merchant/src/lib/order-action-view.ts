import type { MerchantOrderAction } from "@conduit/core"

export type MerchantOrderNextStep =
  "primary_action" | "invoice" | "shipping" | "out_of_band_payment" | null

export interface MerchantOrderCancellationCopy {
  title: string
  description: string
  confirmLabel: string
  warning: string | null
}

interface MerchantOrderActionViewInput {
  actions: MerchantOrderAction[]
  canSendInvoice: boolean
  canRecordShipping: boolean
  canRequestPaymentOutOfBand: boolean
}

export interface MerchantOrderActionView {
  primaryButtonActions: MerchantOrderAction[]
  destructiveActions: MerchantOrderAction[]
  nextStep: MerchantOrderNextStep
  hasNextStep: boolean
}

export function buildMerchantOrderActionView({
  actions,
  canSendInvoice,
  canRecordShipping,
  canRequestPaymentOutOfBand,
}: MerchantOrderActionViewInput): MerchantOrderActionView {
  const primaryButtonActions = actions.filter(
    (action) => action.kind === "primary" && action.action !== "record_shipment"
  )
  const destructiveActions = actions.filter(
    (action) => action.kind === "destructive"
  )
  const nextStep: MerchantOrderNextStep =
    primaryButtonActions.length > 0
      ? "primary_action"
      : canRecordShipping
        ? "shipping"
        : canSendInvoice
          ? "invoice"
          : canRequestPaymentOutOfBand
            ? "out_of_band_payment"
            : null

  return {
    primaryButtonActions,
    destructiveActions,
    nextStep,
    hasNextStep: nextStep !== null,
  }
}

interface MerchantOrderCancellationCopyInput {
  actionLabel: string
  buyerInboxKnown: boolean
  merchantPaid: boolean
  paymentObserved: boolean
}

export function getMerchantOrderCancellationCopy({
  actionLabel,
  buyerInboxKnown,
  merchantPaid,
  paymentObserved,
}: MerchantOrderCancellationCopyInput): MerchantOrderCancellationCopy {
  const declining = actionLabel === "Decline order"
  const warning = merchantPaid
    ? "This order is already paid. Cancelling won't return funds — send a manual Lightning refund to the buyer separately."
    : paymentObserved
      ? "Payment has been reported. Verify settlement before cancelling; cancellation won't return funds if the payment settled."
      : null

  let description: string
  if (merchantPaid) {
    description =
      "This records the order as cancelled but does not return funds. Any refund must be sent separately."
  } else if (paymentObserved) {
    description =
      "Payment has been reported. Verify settlement first. Cancelling does not return funds, so any settled payment must be refunded separately."
  } else if (buyerInboxKnown) {
    description = declining
      ? "This records the order as declined and notifies the buyer."
      : "This records the order as cancelled and notifies the buyer."
  } else {
    description = declining
      ? "This records the order as declined in your encrypted order history. Contact the buyer separately if needed."
      : "This records the order as cancelled in your encrypted order history. Contact the buyer separately if needed."
  }

  return {
    title: declining ? "Decline this order?" : "Cancel this order?",
    description,
    confirmLabel: actionLabel,
    warning,
  }
}

export function isMerchantOrderActionSurfacePending(states: {
  generateInvoice: boolean
  sendInvoice: boolean
  advanceStatus: boolean
  recordShipping: boolean
}): boolean {
  return Object.values(states).some(Boolean)
}

export async function runExclusiveOrderAction<T>(
  lock: { current: boolean },
  action: () => Promise<T>
): Promise<T> {
  if (lock.current) {
    throw new Error("Another order action is already in progress.")
  }
  lock.current = true
  try {
    return await action()
  } finally {
    lock.current = false
  }
}
