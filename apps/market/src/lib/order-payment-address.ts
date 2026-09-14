import {
  getOrderPaymentAddressReplacementAdmission,
  getOrderPaymentTargetReplacementAdmission,
  getProfiles,
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
  const hasPositiveAddress = hasPositiveMerchantPaymentAddressEvidence({
    meta: result.meta,
    lud16: profile.lud16,
  })
  if (!hasPositiveAddress) {
    const frontierState = result.meta.profileFrontierStates?.[merchantPubkey]
    if (
      result.meta.source === "public" &&
      !result.meta.stale &&
      (frontierState === "observed_valid" ||
        frontierState === "observed_malformed")
    ) {
      return { status: "current_address_unusable" }
    }
    return { status: "unavailable" }
  }
  const newAddress = profile.lud16!.trim().toLowerCase()
  if (newAddress === snapshot.previousAddress.trim().toLowerCase()) {
    return { status: "unchanged" }
  }
  if (getOrderPaymentAddressReplacementAdmission(lifecycle) !== "replaceable") {
    return { status: "current_address_changed" }
  }
  return { status: "updated", update: { ...snapshot, newAddress } }
}
