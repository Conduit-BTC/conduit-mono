import {
  buildEventMarketOrganizerFeeTags,
  normalizeCheckoutSparkReceiverAddress,
  type EventMarketOrganizerFeeAuthoring,
  type EventMarketOrganizerFeeResolution,
} from "@conduit/core"
import { localDateTimeToEpochSeconds } from "./event-market-form"

export interface EventMarketOrganizerFeeFormValues {
  state: "" | "active" | "disabled" | "revoked"
  percent: string
  minimumSats: string
  lightningAddress: string
  expiresAtUtc: string
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
        minimumSats: String(fee.minimumSats),
        lightningAddress: fee.lightningAddress,
        expiresAtUtc:
          fee.expiresAt === undefined
            ? ""
            : new Date(fee.expiresAt * 1_000).toISOString().slice(0, 19),
      }
    : {
        state:
          fee.state === "invalid"
            ? ""
            : fee.state === "absent"
              ? "disabled"
              : fee.state,
        percent: "0",
        minimumSats: "0",
        lightningAddress: "",
        expiresAtUtc: "",
      }
}

/** Form parsing only. The publisher independently binds the exact current signed parent. */
export function parseEventMarketOrganizerFeeForm(
  values: EventMarketOrganizerFeeFormValues,
  nowMs: number
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
  const minimumText = values.minimumSats.trim()
  if (!/^(0|[1-9]\d*)$/.test(minimumText))
    throw new Error("Enter a whole nonnegative minimum in sats.")
  const minimumValue = BigInt(minimumText)
  if (minimumValue * 1_000n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The minimum is too large.")
  const basisPoints = Number(basisPointsValue)
  const minimumSats = Number(minimumValue)
  if (basisPoints === 0 && minimumSats === 0) return { state: "disabled" }
  const lightningAddress = normalizeCheckoutSparkReceiverAddress(
    values.lightningAddress.trim()
  )
  if (!lightningAddress)
    throw new Error("Enter the organizer's receiving Lightning address.")
  const expiresAt = values.expiresAtUtc.trim()
    ? localDateTimeToEpochSeconds(values.expiresAtUtc.trim(), "UTC")
    : undefined
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    (expiresAt !== undefined && expiresAt * 1_000 <= nowMs)
  )
    throw new Error(
      "Choose an expiry later than the current time, or leave it empty."
    )
  const fee: EventMarketOrganizerFeeAuthoring = {
    state: "active",
    basisPoints,
    minimumSats,
    lightningAddress,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
  buildEventMarketOrganizerFeeTags(fee)
  return fee
}
