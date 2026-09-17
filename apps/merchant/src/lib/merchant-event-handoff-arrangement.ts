import {
  decodeProductReference,
  parseAddressableCoordinate,
  type EventMarketHandoffMode,
  type EventMarketResolutionState,
  type ParsedEventMarketPickup,
} from "@conduit/core"
import {
  decodeOrganizerEventMarketReference,
  type MerchantOrganizerEventMarket,
  type MerchantOrganizerParticipation,
} from "./event-market"
import { getMerchantBoothPickupFormError } from "./product-local-pickup"

const PREFERENCE_STORAGE_PREFIX = "conduit:merchant:event-handoff-preference:v1"
const HEX_64 = /^[0-9a-f]{64}$/

export type MerchantEventHandoffCoverage =
  "complete" | "partial" | "unavailable"

export interface MerchantEventPickupConfiguration {
  dTag: string
  title: string
  location?: string
  geohash?: string
  countries: string[]
}

export interface MerchantEventHandoffSelection {
  mode: EventMarketHandoffMode
  handlerPubkey: string
  pickupCoordinate: string
  merchantPickup?: MerchantEventPickupConfiguration
}

export interface MerchantEventHandoffPreference extends MerchantEventHandoffSelection {
  version: 1
  merchantPubkey: string
  collectionCoordinate: string
  savedAt: number
}

export interface MerchantEventHandoffListingEvidence {
  productCoordinate: string
  merchantPubkey?: string
  title?: string
  fulfillmentStatus?: "none" | "ambiguous" | "resolved"
  pickupCoordinate?: string
  pickupAuthorPubkey?: string
  handoffMode?: EventMarketHandoffMode
  handlerPubkey?: string
}

export interface MerchantEventHandoffTransitionProjection {
  target: MerchantEventHandoffSelection
  listings: readonly {
    productCoordinate: string
    status:
      "awaiting_signature" | "signed" | "partial" | "retry_needed" | "delivered"
  }[]
}

interface MerchantEventHandoffResolutionBase {
  merchantPubkey: string
  collectionCoordinate: string
  coverage: MerchantEventHandoffCoverage
  marketState: EventMarketResolutionState
  listings: MerchantEventHandoffListingEvidence[]
}

export type MerchantEventHandoffConflictReason =
  | "mixed_handoff_modes"
  | "invalid_handoff_authority"
  | "organizer_offer_changed"
  | "different_merchant_pickup_terms"
  | "preference_mismatch"

export type MerchantEventHandoffUnresolvedReason =
  | "market_evidence_unavailable"
  | "partial_without_known_arrangement"
  | "listing_handoff_unresolved"
  | "pickup_evidence_unavailable"

export type MerchantEventHandoffArrangement =
  | (MerchantEventHandoffResolutionBase & {
      state: "unconfigured"
    })
  | (MerchantEventHandoffResolutionBase & {
      state: "consistent"
      source: "preference" | "signed_listings"
      selection: MerchantEventHandoffSelection
    })
  | (MerchantEventHandoffResolutionBase & {
      state: "legacy_equivalent"
      selection: MerchantEventHandoffSelection
      pickupCoordinates: string[]
      canonicalPickupCoordinate: string
    })
  | (MerchantEventHandoffResolutionBase & {
      state: "transitioning"
      target: MerchantEventHandoffSelection
      completedListingCount: number
      totalListingCount: number
    })
  | (MerchantEventHandoffResolutionBase & {
      state: "conflicting"
      reasons: MerchantEventHandoffConflictReason[]
    })
  | (MerchantEventHandoffResolutionBase & {
      state: "unresolved"
      reason: MerchantEventHandoffUnresolvedReason
    })

export type MerchantEventHandoffStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

function normalizeMerchantPubkey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) {
    throw new Error("Merchant pubkey is invalid.")
  }
  return normalized
}

function normalizeCollectionCoordinate(value: string): string {
  return decodeOrganizerEventMarketReference(value)
}

function coordinateAuthor(coordinate: string): string {
  return parseAddressableCoordinate(coordinate, [30406])?.authorPubkey ?? ""
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("")
}

function getStorage(
  storage: MerchantEventHandoffStorage | null | undefined
): MerchantEventHandoffStorage | null {
  if (storage !== undefined) return storage
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function preferenceStorageKey(
  merchantPubkey: string,
  collectionCoordinate: string
): string {
  return `${PREFERENCE_STORAGE_PREFIX}:${merchantPubkey}:${encodeURIComponent(collectionCoordinate)}`
}

function normalizeCountries(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((country) => country.trim().toUpperCase()))
  ).sort()
}

function pickupConfigurationFromEvidence(
  pickup: ParsedEventMarketPickup
): MerchantEventPickupConfiguration {
  return {
    dTag: pickup.dTag,
    title: pickup.title,
    ...(pickup.location ? { location: pickup.location } : {}),
    ...(pickup.geohash ? { geohash: pickup.geohash } : {}),
    countries: normalizeCountries(pickup.countries),
  }
}

function pickupTermsKey(pickup: ParsedEventMarketPickup): string {
  return JSON.stringify({
    title: pickup.title.trim(),
    location: pickup.location?.trim() ?? null,
    geohash: pickup.geohash?.trim().toLowerCase() ?? null,
    countries: normalizeCountries(pickup.countries),
    price: pickup.price,
    currency: pickup.currency.trim().toUpperCase(),
  })
}

function preferenceIsValid(
  value: unknown,
  merchantPubkey: string,
  collectionCoordinate: string
): value is MerchantEventHandoffPreference {
  if (!value || typeof value !== "object") return false
  const preference = value as Partial<MerchantEventHandoffPreference>
  if (
    preference.version !== 1 ||
    preference.merchantPubkey !== merchantPubkey ||
    preference.collectionCoordinate !== collectionCoordinate ||
    (preference.mode !== "merchant_handoff" &&
      preference.mode !== "organizer_handoff") ||
    typeof preference.handlerPubkey !== "string" ||
    typeof preference.pickupCoordinate !== "string" ||
    typeof preference.savedAt !== "number" ||
    !Number.isFinite(preference.savedAt)
  ) {
    return false
  }
  const pickupCoordinate = parseAddressableCoordinate(
    preference.pickupCoordinate,
    [30406]
  )
  if (!pickupCoordinate) return false
  if (
    preference.mode === "merchant_handoff" &&
    (!preference.merchantPickup ||
      typeof preference.merchantPickup.dTag !== "string" ||
      typeof preference.merchantPickup.title !== "string" ||
      !Array.isArray(preference.merchantPickup.countries) ||
      preference.merchantPickup.countries.length === 0)
  ) {
    return false
  }
  return (
    pickupCoordinate.authorPubkey === preference.handlerPubkey.toLowerCase() &&
    (preference.mode === "organizer_handoff" ||
      (preference.handlerPubkey.toLowerCase() === merchantPubkey &&
        preference.merchantPickup?.dTag === pickupCoordinate.dTag))
  )
}

function coverageForMarket(
  market: MerchantOrganizerEventMarket
): MerchantEventHandoffCoverage {
  if (market.state === "partial") return "partial"
  if (market.state === "active" || market.state === "ended") return "complete"
  return "unavailable"
}

function listingEvidenceFromParticipation(
  item: MerchantOrganizerParticipation
): MerchantEventHandoffListingEvidence {
  return {
    productCoordinate: item.productCoordinate,
    ...(item.merchantPubkey ? { merchantPubkey: item.merchantPubkey } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.fulfillmentStatus
      ? { fulfillmentStatus: item.fulfillmentStatus }
      : {}),
    ...(item.pickupCoordinate
      ? { pickupCoordinate: item.pickupCoordinate }
      : {}),
    ...(item.pickupAuthorPubkey
      ? { pickupAuthorPubkey: item.pickupAuthorPubkey }
      : {}),
    ...(item.handoffMode ? { handoffMode: item.handoffMode } : {}),
    ...(item.handlerPubkey ? { handlerPubkey: item.handlerPubkey } : {}),
  }
}

function sameSelection(
  left: MerchantEventHandoffSelection,
  right: MerchantEventHandoffSelection
): boolean {
  return (
    left.mode === right.mode &&
    left.handlerPubkey.toLowerCase() === right.handlerPubkey.toLowerCase() &&
    left.pickupCoordinate === right.pickupCoordinate
  )
}

function preferenceSelection(
  preference: MerchantEventHandoffPreference
): MerchantEventHandoffSelection {
  return {
    mode: preference.mode,
    handlerPubkey: preference.handlerPubkey,
    pickupCoordinate: preference.pickupCoordinate,
    ...(preference.merchantPickup
      ? { merchantPickup: preference.merchantPickup }
      : {}),
  }
}

/**
 * Derive the canonical pickup identity for new merchant-owned event handoff.
 * This is only a kind-30406 d-tag convention; it does not add a public kind.
 */
export async function getMerchantEventPickupIdentity(input: {
  merchantPubkey: string
  collectionCoordinate: string
}): Promise<{ dTag: string; coordinate: string }> {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const collectionCoordinate = normalizeCollectionCoordinate(
    input.collectionCoordinate
  )
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure deterministic pickup identity is unavailable.")
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `merchant-event-pickup-v1\0${merchantPubkey}\0${collectionCoordinate}`
    )
  )
  const dTag = `event-pickup-v1-${bytesToHex(digest)}`
  return {
    dTag,
    coordinate: `30406:${merchantPubkey}:${dTag}`,
  }
}

export async function createMerchantEventHandoffPreference(input: {
  merchantPubkey: string
  market: MerchantOrganizerEventMarket
  mode: EventMarketHandoffMode
  merchantPickup?: {
    title?: string
    location?: string
    geohash?: string
    country: string
  }
  now?: number
}): Promise<MerchantEventHandoffPreference> {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const collectionCoordinate = normalizeCollectionCoordinate(
    input.market.collectionCoordinate
  )
  if (input.mode === "organizer_handoff") {
    const pickupCoordinate = input.market.pickupCoordinate
      ? parseAddressableCoordinate(input.market.pickupCoordinate, [30406])
      : null
    if (
      !pickupCoordinate ||
      pickupCoordinate.authorPubkey !==
        input.market.organizerPubkey.toLowerCase()
    ) {
      throw new Error(
        "This event organizer is not offering organizer handoff. Choose merchant handoff instead."
      )
    }
    return {
      version: 1,
      merchantPubkey,
      collectionCoordinate,
      mode: "organizer_handoff",
      handlerPubkey: input.market.organizerPubkey.toLowerCase(),
      pickupCoordinate: pickupCoordinate.coordinate,
      savedAt: input.now ?? Date.now(),
    }
  }

  const merchantPickup = {
    title: input.merchantPickup?.title?.trim() || "Merchant pickup",
    location: input.merchantPickup?.location?.trim() ?? "",
    geohash: input.merchantPickup?.geohash?.trim() ?? "",
    country: input.merchantPickup?.country.trim().toUpperCase() ?? "",
  }
  const pickupError = getMerchantBoothPickupFormError(merchantPickup)
  if (pickupError) throw new Error(pickupError)
  const identity = await getMerchantEventPickupIdentity({
    merchantPubkey,
    collectionCoordinate,
  })
  return {
    version: 1,
    merchantPubkey,
    collectionCoordinate,
    mode: "merchant_handoff",
    handlerPubkey: merchantPubkey,
    pickupCoordinate: identity.coordinate,
    merchantPickup: {
      dTag: identity.dTag,
      title: merchantPickup.title,
      ...(merchantPickup.location ? { location: merchantPickup.location } : {}),
      ...(merchantPickup.geohash ? { geohash: merchantPickup.geohash } : {}),
      countries: [merchantPickup.country],
    },
    savedAt: input.now ?? Date.now(),
  }
}

export function loadMerchantEventHandoffPreference(
  merchantPubkeyInput: string,
  collectionCoordinateInput: string,
  storageInput?: MerchantEventHandoffStorage | null
): MerchantEventHandoffPreference | null {
  const merchantPubkey = normalizeMerchantPubkey(merchantPubkeyInput)
  const collectionCoordinate = normalizeCollectionCoordinate(
    collectionCoordinateInput
  )
  const storage = getStorage(storageInput)
  if (!storage) {
    throw new Error(
      "Durable event handoff preference storage is unavailable. Publishing was stopped before signing."
    )
  }
  const raw = storage.getItem(
    preferenceStorageKey(merchantPubkey, collectionCoordinate)
  )
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!preferenceIsValid(parsed, merchantPubkey, collectionCoordinate)) {
      throw new Error("invalid")
    }
    return parsed
  } catch (error) {
    throw new Error(
      "Saved event handoff preference is invalid. Publishing was stopped before signing.",
      { cause: error }
    )
  }
}

export function saveMerchantEventHandoffPreference(
  preference: MerchantEventHandoffPreference,
  storageInput?: MerchantEventHandoffStorage | null
): MerchantEventHandoffPreference {
  const merchantPubkey = normalizeMerchantPubkey(preference.merchantPubkey)
  const collectionCoordinate = normalizeCollectionCoordinate(
    preference.collectionCoordinate
  )
  if (!preferenceIsValid(preference, merchantPubkey, collectionCoordinate)) {
    throw new Error("Event handoff preference is invalid.")
  }
  const storage = getStorage(storageInput)
  if (!storage) {
    throw new Error(
      "Durable event handoff preference storage is unavailable. Publishing was stopped before signing."
    )
  }
  try {
    storage.setItem(
      preferenceStorageKey(merchantPubkey, collectionCoordinate),
      JSON.stringify(preference)
    )
    return preference
  } catch (error) {
    throw new Error(
      "The event handoff preference could not be saved. Publishing was stopped before signing.",
      { cause: error }
    )
  }
}

export function clearMerchantEventHandoffPreference(
  merchantPubkeyInput: string,
  collectionCoordinateInput: string,
  storageInput?: MerchantEventHandoffStorage | null
): void {
  const merchantPubkey = normalizeMerchantPubkey(merchantPubkeyInput)
  const collectionCoordinate = normalizeCollectionCoordinate(
    collectionCoordinateInput
  )
  const storage = getStorage(storageInput)
  if (!storage) return
  storage.removeItem(preferenceStorageKey(merchantPubkey, collectionCoordinate))
}

export async function resolveMerchantEventHandoffArrangement(input: {
  merchantPubkey: string
  market: MerchantOrganizerEventMarket
  preference?: MerchantEventHandoffPreference | null
  listings?: readonly MerchantEventHandoffListingEvidence[]
  transition?: MerchantEventHandoffTransitionProjection | null
}): Promise<MerchantEventHandoffArrangement> {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const collectionCoordinate = normalizeCollectionCoordinate(
    input.market.collectionCoordinate
  )
  const coverage = coverageForMarket(input.market)
  const listings = (
    input.listings ??
    input.market.participation.map(listingEvidenceFromParticipation)
  ).filter((listing) => {
    const listingMerchant = listing.merchantPubkey?.toLowerCase()
    return listingMerchant
      ? listingMerchant === merchantPubkey
      : decodeProductReference(listing.productCoordinate)?.authorPubkey ===
          merchantPubkey
  })
  const base: MerchantEventHandoffResolutionBase = {
    merchantPubkey,
    collectionCoordinate,
    coverage,
    marketState: input.market.state,
    listings,
  }

  if (
    input.preference &&
    !preferenceIsValid(input.preference, merchantPubkey, collectionCoordinate)
  ) {
    return {
      ...base,
      state: "conflicting",
      reasons: ["preference_mismatch"],
    }
  }

  if (input.transition) {
    return {
      ...base,
      state: "transitioning",
      target: input.transition.target,
      completedListingCount: input.transition.listings.filter(
        (listing) => listing.status === "delivered"
      ).length,
      totalListingCount: input.transition.listings.length,
    }
  }

  if (input.market.state === "conflicting") {
    return {
      ...base,
      state: "conflicting",
      reasons: ["invalid_handoff_authority"],
    }
  }
  if (coverage === "unavailable") {
    return {
      ...base,
      state: "unresolved",
      reason: "market_evidence_unavailable",
    }
  }

  if (listings.length === 0) {
    if (input.preference) {
      const selection = preferenceSelection(input.preference)
      if (
        selection.mode === "organizer_handoff" &&
        selection.pickupCoordinate !== input.market.pickupCoordinate
      ) {
        return {
          ...base,
          state: "conflicting",
          reasons: ["organizer_offer_changed"],
        }
      }
      return {
        ...base,
        state: "consistent",
        source: "preference",
        selection,
      }
    }
    if (coverage === "partial") {
      return {
        ...base,
        state: "unresolved",
        reason: "partial_without_known_arrangement",
      }
    }
    return { ...base, state: "unconfigured" }
  }

  if (
    listings.some(
      (listing) =>
        listing.fulfillmentStatus !== "resolved" ||
        !listing.pickupCoordinate ||
        !listing.pickupAuthorPubkey ||
        !listing.handoffMode ||
        !listing.handlerPubkey
    )
  ) {
    return {
      ...base,
      state: "unresolved",
      reason: "listing_handoff_unresolved",
    }
  }

  const modes = new Set(listings.map((listing) => listing.handoffMode!))
  if (modes.size !== 1) {
    return {
      ...base,
      state: "conflicting",
      reasons: ["mixed_handoff_modes"],
    }
  }

  const mode = listings[0]!.handoffMode!
  const organizerPubkey = input.market.organizerPubkey.toLowerCase()
  if (mode === "organizer_handoff") {
    const invalidAuthority = listings.some(
      (listing) =>
        listing.pickupCoordinate !== input.market.pickupCoordinate ||
        listing.pickupAuthorPubkey?.toLowerCase() !== organizerPubkey ||
        listing.handlerPubkey?.toLowerCase() !== organizerPubkey
    )
    if (invalidAuthority || !input.market.pickupCoordinate) {
      return {
        ...base,
        state: "conflicting",
        reasons: ["organizer_offer_changed"],
      }
    }
    const selection: MerchantEventHandoffSelection = {
      mode,
      handlerPubkey: organizerPubkey,
      pickupCoordinate: input.market.pickupCoordinate,
    }
    if (
      input.preference &&
      !sameSelection(selection, preferenceSelection(input.preference))
    ) {
      return {
        ...base,
        state: "conflicting",
        reasons: ["preference_mismatch"],
      }
    }
    return {
      ...base,
      state: "consistent",
      source: "signed_listings",
      selection,
    }
  }

  const invalidMerchantAuthority = listings.some(
    (listing) =>
      listing.pickupAuthorPubkey?.toLowerCase() !== merchantPubkey ||
      listing.handlerPubkey?.toLowerCase() !== merchantPubkey ||
      coordinateAuthor(listing.pickupCoordinate!) !== merchantPubkey
  )
  if (invalidMerchantAuthority) {
    return {
      ...base,
      state: "conflicting",
      reasons: ["invalid_handoff_authority"],
    }
  }

  const pickupCoordinates = Array.from(
    new Set(listings.map((listing) => listing.pickupCoordinate!))
  ).sort()
  const pickupsByCoordinate = new Map(
    input.market.source.pickups.map((pickup) => [pickup.coordinate, pickup])
  )
  const pickups = pickupCoordinates.map((coordinate) =>
    pickupsByCoordinate.get(coordinate)
  )
  if (
    pickups.some((pickup) => !pickup || pickup.evidenceState === "retained")
  ) {
    return {
      ...base,
      state: "unresolved",
      reason: "pickup_evidence_unavailable",
    }
  }
  const currentPickups = pickups as ParsedEventMarketPickup[]
  const firstPickup = currentPickups[0]!
  const selection: MerchantEventHandoffSelection = {
    mode,
    handlerPubkey: merchantPubkey,
    pickupCoordinate: firstPickup.coordinate,
    merchantPickup: pickupConfigurationFromEvidence(firstPickup),
  }

  if (pickupCoordinates.length === 1) {
    if (
      input.preference &&
      !sameSelection(selection, preferenceSelection(input.preference))
    ) {
      return {
        ...base,
        state: "conflicting",
        reasons: ["preference_mismatch"],
      }
    }
    return {
      ...base,
      state: "consistent",
      source: "signed_listings",
      selection,
    }
  }

  if (
    currentPickups.some(
      (pickup) => pickupTermsKey(pickup) !== pickupTermsKey(firstPickup)
    )
  ) {
    return {
      ...base,
      state: "conflicting",
      reasons: ["different_merchant_pickup_terms"],
    }
  }
  if (
    input.preference &&
    (input.preference.mode !== "merchant_handoff" ||
      !pickupCoordinates.includes(input.preference.pickupCoordinate))
  ) {
    return {
      ...base,
      state: "conflicting",
      reasons: ["preference_mismatch"],
    }
  }
  const canonical = await getMerchantEventPickupIdentity({
    merchantPubkey,
    collectionCoordinate,
  })
  return {
    ...base,
    state: "legacy_equivalent",
    selection,
    pickupCoordinates,
    canonicalPickupCoordinate: canonical.coordinate,
  }
}

function preferenceFromConsistentArrangement(input: {
  arrangement: Extract<MerchantEventHandoffArrangement, { state: "consistent" }>
  now?: number
}): MerchantEventHandoffPreference {
  return {
    version: 1,
    merchantPubkey: input.arrangement.merchantPubkey,
    collectionCoordinate: input.arrangement.collectionCoordinate,
    ...input.arrangement.selection,
    savedAt: input.now ?? Date.now(),
  }
}

/**
 * Resolve the one merchant/event setting used by event-led publication. The
 * first product may establish the durable preference; later products inherit it
 * even if a stale product form still carries a different per-product choice.
 */
export async function ensureMerchantEventHandoffPreference(input: {
  merchantPubkey: string
  market: MerchantOrganizerEventMarket
  requested: {
    mode: EventMarketHandoffMode
    merchantPickup?: {
      title?: string
      location?: string
      geohash?: string
      country: string
    }
  }
  transition?: MerchantEventHandoffTransitionProjection | null
  storage?: MerchantEventHandoffStorage | null
  now?: number
}): Promise<MerchantEventHandoffPreference> {
  const stored = loadMerchantEventHandoffPreference(
    input.merchantPubkey,
    input.market.collectionCoordinate,
    input.storage
  )
  const arrangement = await resolveMerchantEventHandoffArrangement({
    merchantPubkey: input.merchantPubkey,
    market: input.market,
    preference: stored,
    transition: input.transition,
  })

  if (arrangement.state === "consistent") {
    if (stored) return stored
    return saveMerchantEventHandoffPreference(
      preferenceFromConsistentArrangement({ arrangement, now: input.now }),
      input.storage
    )
  }
  if (arrangement.state === "unconfigured") {
    const preference = await createMerchantEventHandoffPreference({
      merchantPubkey: input.merchantPubkey,
      market: input.market,
      mode: input.requested.mode,
      merchantPickup: input.requested.merchantPickup,
      now: input.now,
    })
    return saveMerchantEventHandoffPreference(preference, input.storage)
  }
  if (arrangement.state === "legacy_equivalent") {
    throw new Error(
      "Existing event listings use multiple equivalent merchant pickup records. Reconcile them before publishing another product."
    )
  }
  if (arrangement.state === "transitioning") {
    throw new Error(
      "The event handoff change is still in progress. Retry or finish every affected listing before publishing another product."
    )
  }
  if (arrangement.state === "conflicting") {
    throw new Error(
      "Existing event listings use conflicting handoff arrangements. Reconcile them before publishing another product."
    )
  }
  throw new Error(
    "The current merchant event handoff arrangement could not be verified. Refresh the event evidence before publishing."
  )
}

export function applyMerchantEventHandoffPreference<
  T extends {
    handoffMode: EventMarketHandoffMode
    merchantPickupLocation: string
    merchantPickupCountry: string
  },
>(form: T, preference: MerchantEventHandoffPreference): T {
  return {
    ...form,
    handoffMode: preference.mode,
    merchantPickupLocation:
      preference.merchantPickup?.location ?? form.merchantPickupLocation,
    merchantPickupCountry:
      preference.merchantPickup?.countries[0] ?? form.merchantPickupCountry,
  }
}
