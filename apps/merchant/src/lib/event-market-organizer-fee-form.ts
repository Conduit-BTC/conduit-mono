import {
  buildEventMarketOrganizerFeeTags,
  getProfilePaymentAddress,
  normalizeCheckoutSparkReceiverAddress,
  type EventMarketOrganizerFeeAuthoring,
  type EventMarketOrganizerFeeResolution,
  type SelectedProfileContext,
} from "@conduit/core"

export interface EventMarketOrganizerFeeFormValues {
  state: "" | "active" | "disabled" | "revoked"
  percent: string
  lightningAddress: string
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
