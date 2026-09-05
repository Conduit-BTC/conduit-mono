import { isValidLud16Address } from "@conduit/core"
import type { MerchantLnurlPreflightStatus } from "./cart-readiness"

export type MerchantPaymentProfileState =
  "loading" | "available" | "unavailable"

export type MerchantPaymentReadiness =
  | "not_required"
  | "checking_profile"
  | "missing_address"
  | "profile_unavailable"
  | "checking_endpoint"
  | "endpoint_unavailable"
  | "ready"

export function getMerchantPaymentProfileState(input: {
  isLoading: boolean
  isFetching: boolean
  lookupSettled: boolean
  evidenceIncomplete: boolean
  error?: unknown
}): MerchantPaymentProfileState {
  if (input.isLoading || input.isFetching || !input.lookupSettled) {
    return "loading"
  }
  return input.error || input.evidenceIncomplete ? "unavailable" : "available"
}

/**
 * Shopper-facing payment readiness stays separate from product and pickup
 * evidence. A profile address is only a candidate payment destination; the
 * LNURL endpoint must still resolve before direct payment is considered ready.
 */
export function getMerchantPaymentReadiness(input: {
  paymentRequired: boolean
  profileState: MerchantPaymentProfileState
  lud16: string | null | undefined
  lnurlStatus: MerchantLnurlPreflightStatus
}): MerchantPaymentReadiness {
  if (!input.paymentRequired) return "not_required"

  if (input.profileState === "loading") return "checking_profile"
  if (input.profileState === "unavailable") return "profile_unavailable"

  const hasValidAddress = isValidLud16Address(input.lud16?.trim() ?? "")
  if (!hasValidAddress) return "missing_address"

  if (input.lnurlStatus === "pending") return "checking_endpoint"
  if (input.lnurlStatus === "ready") return "ready"
  return "endpoint_unavailable"
}

export function getMerchantPaymentLud16(input: {
  profileState: MerchantPaymentProfileState
  lud16: string | null | undefined
}): string | undefined {
  if (input.profileState !== "available") return undefined
  const lud16 = input.lud16?.trim() ?? ""
  return isValidLud16Address(lud16) ? lud16 : undefined
}
