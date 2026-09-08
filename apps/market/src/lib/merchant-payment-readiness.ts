import { isValidLud16Address, type CommerceQueryMeta } from "@conduit/core"
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
  positiveAddressEvidence: boolean
  error?: unknown
}): MerchantPaymentProfileState {
  if (input.isLoading || input.isFetching || !input.lookupSettled) {
    return "loading"
  }
  if (input.error) return "unavailable"
  if (input.positiveAddressEvidence) return "available"
  return input.evidenceIncomplete ? "unavailable" : "available"
}

/**
 * A live signed Lightning address is positive action evidence even when some
 * planned relays time out or cap their results. Complete relay coverage is
 * still required before an empty read can prove that the address is absent.
 */
export function hasPositiveMerchantPaymentAddressEvidence(input: {
  meta: Pick<CommerceQueryMeta, "source" | "stale"> | null | undefined
  lud16: string | null | undefined
}): boolean {
  return (
    input.meta?.source === "public" &&
    !input.meta.stale &&
    isValidLud16Address(input.lud16?.trim() ?? "")
  )
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
