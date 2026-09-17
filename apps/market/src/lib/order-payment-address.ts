import {
  getOrderPaymentAddressReplacementAdmission,
  getOrderPaymentTargetReplacementAdmission,
  getProfiles,
  getProfilePaymentAddress,
  hasFreshProfilePaymentAddress,
  normalizePubkey,
  type OrderLifecycle,
  type SelectedProfileContext,
} from "@conduit/core"
import { getMerchantProfileAuthenticatedPubkey } from "../hooks/useMerchantTrustContext"

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

/** Assess the selected signed authority independently of lifecycle admission. */
export function assessOrderPaymentAddress(
  context: SelectedProfileContext | undefined,
  merchantPubkey: string,
  savedAddress: string
):
  | "unchanged"
  | "unavailable"
  | "current_address_unusable"
  | "current_address_changed" {
  if (context?.persistence === "unavailable") {
    throw new Error(
      "Saved profile authority is unavailable. Restore local storage and check the payment address again."
    )
  }
  if (context?.profile.pubkey !== merchantPubkey || !context.frontier) {
    return "unavailable"
  }
  const address = getProfilePaymentAddress(context)
  if (!address) return "current_address_unusable"
  if (address.toLowerCase() !== savedAddress.trim().toLowerCase()) {
    return "current_address_changed"
  }
  return "unchanged"
}

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

  const context = result.profileContexts[merchantPubkey]
  const assessment = assessOrderPaymentAddress(
    context,
    merchantPubkey,
    snapshot.previousAddress
  )
  if (
    assessment === "current_address_unusable" ||
    assessment === "unavailable"
  ) {
    return { status: assessment }
  }
  const hasPositiveAddress = hasFreshProfilePaymentAddress(context)
  const address = getProfilePaymentAddress(context)
  const newAddress = (address ?? "").toLowerCase()
  const previousAddress = snapshot.previousAddress.trim().toLowerCase()
  if (!hasPositiveAddress) {
    if (assessment === "current_address_changed") {
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
