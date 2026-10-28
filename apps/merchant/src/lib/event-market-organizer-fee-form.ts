import {
  buildEventMarketOrganizerFeeTags,
  getProfilePaymentAddress,
  normalizeCheckoutSparkReceiverAddress,
  observeCheckoutSparkReceiverCapability,
  type CheckoutSparkReceiverDependencies,
  type EventMarketOrganizerFeeAuthoring,
  type EventMarketOrganizerFeeResolution,
  type SelectedProfileContext,
} from "@conduit/core"

export interface EventMarketOrganizerFeeFormValues {
  state: "" | "active" | "disabled" | "revoked"
  percent: string
  lightningAddress: string
}

export type OrganizerFeeProfileReceiver =
  | { status: "supported"; address: string }
  | {
      status:
        "none" | "checking" | "unsupported" | "unavailable" | "conflicting"
    }

/** A suggestion for a new draft, never a replacement for signed or typed terms. */
export function withOrganizerFeeProfileDefault({
  fee,
  values,
  receiver,
  addressEdited,
}: {
  fee: EventMarketOrganizerFeeResolution
  values: EventMarketOrganizerFeeFormValues
  receiver: OrganizerFeeProfileReceiver
  addressEdited: boolean
}): EventMarketOrganizerFeeFormValues {
  if (
    fee.state === "active" ||
    values.state !== "active" ||
    values.lightningAddress !== "" ||
    addressEdited ||
    receiver.status !== "supported"
  )
    return values
  return { ...values, lightningAddress: receiver.address }
}

/** Reuse selected profile evidence, never a richer display-profile fallback. */
export function getOrganizerFeeProfileAddress(
  context: SelectedProfileContext | undefined,
  organizerPubkey: string
): string | undefined {
  if (context?.profile.pubkey !== organizerPubkey) return undefined
  const address = getProfilePaymentAddress(context)
  return address ? normalizeCheckoutSparkReceiverAddress(address) : undefined
}

/** Resolve only this organizer's selected evidence through the shared qualification owner. */
export async function observeOrganizerFeeProfileReceiver(
  input: {
    context: SelectedProfileContext | undefined
    organizerPubkey: string
    assertCurrent: () => void
  },
  dependencies?: CheckoutSparkReceiverDependencies
): Promise<OrganizerFeeProfileReceiver> {
  input.assertCurrent()
  const address = getOrganizerFeeProfileAddress(
    input.context,
    input.organizerPubkey
  )
  if (!address) return { status: "none" }
  const result = await observeCheckoutSparkReceiverCapability(
    { lud16: address, mode: "private", assertCurrent: input.assertCurrent },
    dependencies
  )
  input.assertCurrent()
  return result.status === "supported"
    ? { status: "supported", address }
    : { status: result.status }
}

export function formatOrganizerFeePercent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100)
  const fraction = String(basisPoints % 100)
    .padStart(2, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export function createEventMarketOrganizerFeeFormValues(
  fee: EventMarketOrganizerFeeResolution
): EventMarketOrganizerFeeFormValues {
  return fee.state === "active"
    ? {
        state: "active",
        percent: formatOrganizerFeePercent(fee.basisPoints),
        lightningAddress: fee.lightningAddress,
      }
    : {
        state:
          fee.state === "invalid"
            ? ""
            : fee.state === "absent"
              ? "disabled"
              : fee.state,
        percent: "0",
        lightningAddress: "",
      }
}

/** Form parsing only. The publisher independently binds the exact current signed parent. */
export function parseEventMarketOrganizerFeeForm(
  values: EventMarketOrganizerFeeFormValues
): EventMarketOrganizerFeeAuthoring {
  if (values.state === "disabled" || values.state === "revoked")
    return { state: values.state }
  if (values.state !== "active")
    throw new Error("Choose how this event handles organizer fees.")
  const percent = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(values.percent.trim())
  if (!percent)
    throw new Error(
      "Enter a nonnegative percentage with at most two decimal places."
    )
  const basisPointsValue =
    BigInt(percent[1]!) * 100n + BigInt((percent[2] ?? "").padEnd(2, "0"))
  if (basisPointsValue > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The percentage is too large.")
  const basisPoints = Number(basisPointsValue)
  if (basisPoints === 0) return { state: "disabled" }
  const lightningAddress = normalizeCheckoutSparkReceiverAddress(
    values.lightningAddress.trim()
  )
  if (!lightningAddress)
    throw new Error("Enter the organizer's receiving Lightning address.")
  // Only an explicit save authors percentage-only terms. Signed current and
  // historical terms are still parsed and retained by the existing core owner.
  const fee: EventMarketOrganizerFeeAuthoring = {
    state: "active",
    basisPoints,
    minimumSats: 0,
    lightningAddress,
  }
  buildEventMarketOrganizerFeeTags(fee)
  return fee
}
