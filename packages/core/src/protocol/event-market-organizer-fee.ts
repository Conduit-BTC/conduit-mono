import { normalizeCheckoutSparkReceiverAddress } from "./checkout-spark-receiver-capability"
import { parseAddressableCoordinate } from "./event-market"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { isVerifiedNostrEvent } from "./verified-public-event"

/** Conduit extension, not part of the experimental Open Markets Event Market profile. */
export const EVENT_MARKET_ORGANIZER_FEE_TAG = "conduit_event_fee"
export const EVENT_MARKET_ORGANIZER_FEE_VERSION = "1"

const CANONICAL_NONNEGATIVE_INTEGER = /^(0|[1-9]\d*)$/
const MAX_SAFE_MSAT = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_EVENT_BYTES = 65_536

export type EventMarketOrganizerFeeAuthoring =
  | {
      readonly state: "active"
      readonly basisPoints: number
      readonly minimumSats: number
      readonly lightningAddress: string
      /** Unix seconds; omission means no separate fee-term expiry. */
      readonly expiresAt?: number
    }
  | { readonly state: "disabled" | "revoked" }

interface EventMarketOrganizerFeeBinding {
  readonly marketCoordinate: string
  readonly organizerPubkey: string
  readonly eventId: string
  /** Signed market creation time, in Unix seconds. */
  readonly createdAt: number
}

export type EventMarketOrganizerFeeTerms = EventMarketOrganizerFeeBinding &
  (
    | { readonly state: "absent" | "disabled" | "revoked" }
    | Extract<EventMarketOrganizerFeeAuthoring, { state: "active" }>
  )

export type EventMarketOrganizerFeeResolution =
  EventMarketOrganizerFeeTerms | { readonly state: "invalid" }

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function safeSats(value: number): boolean {
  return (
    nonnegativeSafeInteger(value) && BigInt(value) * 1_000n <= MAX_SAFE_MSAT
  )
}

function canonicalInteger(value: string | undefined): number | null {
  if (!value || !CANONICAL_NONNEGATIVE_INTEGER.test(value)) return null
  const number = Number(value)
  return nonnegativeSafeInteger(number) ? number : null
}

function validTimestamp(value: number): boolean {
  return nonnegativeSafeInteger(value) && Number.isSafeInteger(value * 1_000)
}

function validActiveTerms(
  terms: Extract<EventMarketOrganizerFeeAuthoring, { state: "active" }>
): boolean {
  return (
    nonnegativeSafeInteger(terms.basisPoints) &&
    safeSats(terms.minimumSats) &&
    (terms.expiresAt === undefined || validTimestamp(terms.expiresAt))
  )
}

/** Public unsigned tags only. A roster publisher still owns signing and exact retry. */
export function buildEventMarketOrganizerFeeTags(
  input: EventMarketOrganizerFeeAuthoring
): string[][] {
  if (input.state === "disabled" || input.state === "revoked") {
    return [
      [
        EVENT_MARKET_ORGANIZER_FEE_TAG,
        EVENT_MARKET_ORGANIZER_FEE_VERSION,
        input.state,
      ],
    ]
  }
  if (input.state !== "active" || !validActiveTerms(input)) {
    throw new Error("Event Market organizer fee terms are invalid.")
  }
  // Zero terms are an explicit opt-out, not a zero-value payout obligation.
  if (input.basisPoints === 0 && input.minimumSats === 0) {
    return [
      [
        EVENT_MARKET_ORGANIZER_FEE_TAG,
        EVENT_MARKET_ORGANIZER_FEE_VERSION,
        "disabled",
      ],
    ]
  }
  const lightningAddress = normalizeCheckoutSparkReceiverAddress(
    input.lightningAddress
  )
  if (!lightningAddress)
    throw new Error("Event Market organizer receiver is invalid.")
  return [
    [
      EVENT_MARKET_ORGANIZER_FEE_TAG,
      EVENT_MARKET_ORGANIZER_FEE_VERSION,
      "active",
      String(input.basisPoints),
      String(input.minimumSats),
      lightningAddress,
      ...(input.expiresAt === undefined ? [] : [String(input.expiresAt)]),
    ],
  ]
}

/**
 * Parse exact signed fee terms without changing roster browsing/admission.
 * Callers must independently validate the market, merchant grant, occurrence
 * and selected products. Historical parsing deliberately does not apply today's
 * clock; a funded plan retains the original signed revision and destination.
 */
export function parseEventMarketOrganizerFeeTerms(input: {
  readonly marketCoordinate: string
  readonly event: SignedPublicNostrEvent
}): EventMarketOrganizerFeeResolution {
  try {
    const coordinate = parseAddressableCoordinate(
      input.marketCoordinate,
      [30_409]
    )
    const event = input.event
    if (
      !coordinate ||
      event.kind !== 30_409 ||
      event.pubkey !== coordinate.authorPubkey ||
      !validTimestamp(event.created_at) ||
      new TextEncoder().encode(JSON.stringify(event)).byteLength >
        MAX_EVENT_BYTES ||
      (!isVerifiedNostrEvent(event) && !isValidSignedPublicNostrEvent(event))
    )
      return { state: "invalid" }
    const dTags = event.tags.filter((tag) => tag[0] === "d")
    if (
      dTags.length !== 1 ||
      dTags[0]?.length !== 2 ||
      dTags[0][1] !== coordinate.dTag
    ) {
      return { state: "invalid" }
    }
    const binding = {
      marketCoordinate: coordinate.coordinate,
      organizerPubkey: coordinate.authorPubkey,
      eventId: event.id,
      createdAt: event.created_at,
    }
    const tags = event.tags.filter(
      (tag) => tag[0] === EVENT_MARKET_ORGANIZER_FEE_TAG
    )
    if (tags.length === 0) return Object.freeze({ ...binding, state: "absent" })
    const tag = tags[0]!
    if (tags.length !== 1 || tag[1] !== EVENT_MARKET_ORGANIZER_FEE_VERSION) {
      return { state: "invalid" }
    }
    if (tag[2] === "disabled" || tag[2] === "revoked") {
      return tag.length === 3
        ? Object.freeze({ ...binding, state: tag[2] })
        : { state: "invalid" }
    }
    if (tag[2] !== "active" || (tag.length !== 6 && tag.length !== 7)) {
      return { state: "invalid" }
    }
    const basisPoints = canonicalInteger(tag[3])
    const minimumSats = canonicalInteger(tag[4])
    const lightningAddress = normalizeCheckoutSparkReceiverAddress(tag[5] ?? "")
    const expiresAt = tag.length === 7 ? canonicalInteger(tag[6]) : undefined
    if (
      basisPoints === null ||
      minimumSats === null ||
      !safeSats(minimumSats) ||
      !lightningAddress ||
      lightningAddress !== tag[5] ||
      expiresAt === null ||
      (expiresAt !== undefined &&
        (!validTimestamp(expiresAt) || expiresAt <= event.created_at))
    )
      return { state: "invalid" }
    if (basisPoints === 0 && minimumSats === 0) {
      return Object.freeze({ ...binding, state: "disabled" })
    }
    return Object.freeze({
      ...binding,
      state: "active",
      basisPoints,
      minimumSats,
      lightningAddress,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
  } catch {
    return { state: "invalid" }
  }
}

/** Financial admission is clock-bound; retained historical terms are not repriced. */
export function assertCurrentEventMarketOrganizerFeeTerms(
  terms: EventMarketOrganizerFeeResolution,
  atMs: number
): EventMarketOrganizerFeeTerms {
  if (
    terms.state === "invalid" ||
    !nonnegativeSafeInteger(atMs) ||
    terms.createdAt * 1_000 > atMs ||
    (terms.state === "active" &&
      terms.expiresAt !== undefined &&
      atMs >= terms.expiresAt * 1_000)
  )
    throw new Error(
      "Current Event Market organizer fee authority is unavailable."
    )
  return terms
}

/** No fee-on-fee: pass only the final authorized product-plus-shipping total. */
export function calculateEventMarketOrganizerFeeSats(input: {
  readonly commerceTotalSats: number
  readonly basisPoints: number
  readonly minimumSats: number
}): number {
  if (
    !safeSats(input.commerceTotalSats) ||
    !nonnegativeSafeInteger(input.basisPoints) ||
    !safeSats(input.minimumSats)
  )
    throw new Error("Event Market organizer fee calculation is invalid.")
  const proportional =
    (BigInt(input.commerceTotalSats) * BigInt(input.basisPoints) + 9_999n) /
    10_000n
  const fee =
    proportional > BigInt(input.minimumSats)
      ? proportional
      : BigInt(input.minimumSats)
  if ((BigInt(input.commerceTotalSats) + fee) * 1_000n > MAX_SAFE_MSAT) {
    throw new Error("Event Market organizer fee total is unsafe.")
  }
  return Number(fee)
}
