import { isValidLud16Address } from "@conduit/core"

export type ProductPaymentSetupState =
  "checking" | "ready" | "missing" | "unavailable"

export function getProductPaymentSetupState(input: {
  lud16?: string | null
  lookupSettled: boolean
  error?: unknown
}): ProductPaymentSetupState {
  if (isValidLud16Address(input.lud16?.trim() ?? "")) return "ready"
  if (input.error) return "unavailable"
  return input.lookupSettled ? "missing" : "checking"
}
