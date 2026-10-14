import type { OrderPaymentTarget } from "@conduit/core"
import {
  getCheckoutPaymentTargetValue,
  type CheckoutPaymentTargetOption,
} from "../lib/checkout-payment-target"

/** An obsolete picker value is not permission to select another payment rail. */
export function applyCheckoutSparkFundingChoice(input: {
  selection: OrderPaymentTarget | null
  value: string
  options: readonly CheckoutPaymentTargetOption[]
}): OrderPaymentTarget | null {
  return (
    input.options.find((option) => option.value === input.value)?.target ??
    input.selection
  )
}

/** Presentation only: an unavailable explicit payer never becomes another rail. */
export function resolveCheckoutSparkFundingSelection(input: {
  selection: OrderPaymentTarget | null
  defaultTarget?: OrderPaymentTarget
  options: readonly CheckoutPaymentTargetOption[]
  guestSession: boolean
}): {
  selectedOption: CheckoutPaymentTargetOption | null
  showSelector: boolean
} {
  const target = input.guestSession
    ? ({ type: "manual" } as const)
    : (input.selection ?? input.defaultTarget ?? { type: "manual" })
  const value = getCheckoutPaymentTargetValue(target)
  return {
    selectedOption:
      input.options.find((option) => option.value === value) ?? null,
    showSelector:
      !input.guestSession &&
      (input.options.some((option) => option.target.type !== "manual") ||
        (input.selection !== null && input.selection.type !== "manual")),
  }
}
