import {
  getOrderPaymentAddressReplacementAdmission,
  getOrderPaymentTargetReplacementAdmission,
  getProfiles,
  isValidLud16Address,
  normalizePubkey,
  type OrderLifecycle,
} from "@conduit/core"
import { getMerchantProfileAuthenticatedPubkey } from "../hooks/useMerchantTrustContext"
import { hasPositiveMerchantPaymentAddressEvidence } from "./merchant-payment-readiness"

export type OrderPaymentAddressUpdate = {
  orderId: string
  merchantPubkey: string
  previousAddress: string
  newAddress: string
  expectedUpdatedAt: number
}

type OrderPaymentAddressAuthority = {
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
}

type OrderPaymentAddressDependencies = {
  getProfiles: typeof getProfiles
}

type OrderPaymentAddressCheck =
  | {
      status:
        | "unchanged"
        | "unavailable"
        | "not_eligible"
        | "current_address_unusable"
        | "current_address_changed"
    }
  | { status: "updated"; update: OrderPaymentAddressUpdate }

/** Check current signed payment evidence without changing the saved order. */
export async function checkOrderPaymentAddressUpdate(
  lifecycle: OrderLifecycle,
  authority: OrderPaymentAddressAuthority,
  dependencyOverrides: Partial<OrderPaymentAddressDependencies> = {}
): Promise<OrderPaymentAddressCheck> {
  const assertCurrentSession = () => {
    if (authority.shouldContinue?.() === false) {
      throw new Error(
        "The connected account changed. Check the merchant payment address again."
      )
    }
  }
  assertCurrentSession()
  // Every ordinary retry must inspect current authority, even when retained
  // payment evidence prevents replacing the saved destination.
  if (
    getOrderPaymentTargetReplacementAdmission(lifecycle) !== "replaceable" ||
    !lifecycle.merchantLightningAddress?.trim()
  ) {
    return { status: "not_eligible" }
  }

  const merchantPubkey = normalizePubkey(lifecycle.merchantPubkey)
  if (!merchantPubkey) return { status: "unavailable" }
  const snapshot = {
    orderId: lifecycle.orderId,
    merchantPubkey: lifecycle.merchantPubkey,
    previousAddress: lifecycle.merchantLightningAddress,
    expectedUpdatedAt: lifecycle.updatedAt,
  }
  let result: Awaited<ReturnType<typeof getProfiles>>
  try {
    result = await (dependencyOverrides.getProfiles ?? getProfiles)({
      pubkeys: [merchantPubkey],
      accountPubkey: authority.accountPubkey,
      authenticatedPubkey: getMerchantProfileAuthenticatedPubkey(
        merchantPubkey,
        authority.authenticatedPubkey
      ),
      shouldContinue: authority.shouldContinue,
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })
  } catch {
    assertCurrentSession()
    return { status: "unavailable" }
  }
  assertCurrentSession()

  const profile = result.data[merchantPubkey]
  if (profile?.pubkey !== merchantPubkey) {
    return { status: "unavailable" }
  }
  const frontierState = result.meta.profileFrontierStates?.[merchantPubkey]
  const hasPositiveAddress =
    frontierState !== "retained_valid" &&
    frontierState !== "retained_malformed" &&
    hasPositiveMerchantPaymentAddressEvidence({
      meta: result.meta,
      lud16: profile.lud16,
    })
  const hasKnownFrontier =
    frontierState === "observed_valid" ||
    frontierState === "observed_malformed" ||
    frontierState === "retained_valid" ||
    frontierState === "retained_malformed"
  // Read freshness cannot erase a known contradictory signed frontier. It
  // still controls whether a positive address may authorize replacement.
  if (
    hasKnownFrontier &&
    (frontierState === "observed_malformed" ||
      frontierState === "retained_malformed" ||
      !isValidLud16Address(profile.lud16?.trim() ?? ""))
  ) {
    return { status: "current_address_unusable" }
  }
  const newAddress = (profile.lud16 ?? "").trim().toLowerCase()
  const previousAddress = snapshot.previousAddress.trim().toLowerCase()
  if (!hasPositiveAddress) {
    if (hasKnownFrontier && newAddress !== previousAddress) {
      return { status: "current_address_changed" }
    }
    return { status: "unavailable" }
  }
  if (newAddress === previousAddress) {
    return { status: "unchanged" }
  }
  if (getOrderPaymentAddressReplacementAdmission(lifecycle) !== "replaceable") {
    return { status: "current_address_changed" }
  }
  return { status: "updated", update: { ...snapshot, newAddress } }
}
