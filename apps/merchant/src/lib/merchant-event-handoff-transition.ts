import {
  decodeProductReference,
  isValidSignedPublicNostrEvent,
  parseAddressableCoordinate,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { decodeOrganizerEventMarketReference } from "./event-market"
import type {
  MerchantEventHandoffSelection,
  MerchantEventHandoffStorage,
  MerchantEventHandoffTransitionProjection,
} from "./merchant-event-handoff-arrangement"

const TRANSITION_STORAGE_PREFIX = "conduit:merchant:event-handoff-transition:v1"
const HEX_64 = /^[0-9a-f]{64}$/

export type MerchantEventHandoffTransitionListingStatus =
  "awaiting_signature" | "signed" | "partial" | "retry_needed" | "delivered"

export interface MerchantEventHandoffTransitionListing {
  productCoordinate: string
  title?: string
  previousHandoffMode?: "merchant_handoff" | "organizer_handoff"
  previousPickupCoordinate?: string
  status: MerchantEventHandoffTransitionListingStatus
  signedEvent?: SignedPublicNostrEvent
  attemptCount: number
  attemptedRelayUrls: string[]
  acknowledgedRelayUrls: string[]
  failedRelayUrls: string[]
  lastAttemptAt?: number
}

export interface MerchantEventHandoffTransitionJournal extends MerchantEventHandoffTransitionProjection {
  version: 1
  id: string
  merchantPubkey: string
  collectionCoordinate: string
  createdAt: number
  updatedAt: number
  target: MerchantEventHandoffSelection
  listings: MerchantEventHandoffTransitionListing[]
}

export interface MerchantEventHandoffTransitionSummary {
  state: "pending" | "retry_needed" | "partial" | "complete"
  total: number
  awaitingSignature: number
  signed: number
  retryNeeded: number
  partial: number
  delivered: number
}

function normalizeMerchantPubkey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) throw new Error("Merchant pubkey is invalid.")
  return normalized
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

function transitionStorageKey(
  merchantPubkey: string,
  collectionCoordinate: string
): string {
  return `${TRANSITION_STORAGE_PREFIX}:${merchantPubkey}:${encodeURIComponent(collectionCoordinate)}`
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  )
}

function signedProductCoordinate(event: SignedPublicNostrEvent): string | null {
  const dTags = event.tags
    .filter((tag) => tag[0] === "d" && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
  return event.kind === 30402 && dTags.length === 1
    ? `30402:${event.pubkey}:${dTags[0]}`
    : null
}

function selectionIsValid(
  selection: MerchantEventHandoffSelection,
  merchantPubkey: string
): boolean {
  const pickupCoordinate = parseAddressableCoordinate(
    selection.pickupCoordinate,
    [30406]
  )
  if (
    (selection.mode !== "merchant_handoff" &&
      selection.mode !== "organizer_handoff") ||
    !HEX_64.test(selection.handlerPubkey) ||
    !pickupCoordinate ||
    pickupCoordinate.authorPubkey !== selection.handlerPubkey.toLowerCase()
  ) {
    return false
  }
  if (selection.mode !== "merchant_handoff") return true
  return (
    selection.handlerPubkey.toLowerCase() === merchantPubkey &&
    !!selection.merchantPickup &&
    selection.merchantPickup.dTag === pickupCoordinate.dTag &&
    selection.merchantPickup.title.trim().length > 0 &&
    selection.merchantPickup.countries.length > 0
  )
}

function journalIsValid(
  value: unknown,
  merchantPubkey: string,
  collectionCoordinate: string
): value is MerchantEventHandoffTransitionJournal {
  if (!value || typeof value !== "object") return false
  const journal = value as Partial<MerchantEventHandoffTransitionJournal>
  if (
    journal.version !== 1 ||
    typeof journal.id !== "string" ||
    !journal.id ||
    journal.merchantPubkey !== merchantPubkey ||
    journal.collectionCoordinate !== collectionCoordinate ||
    typeof journal.createdAt !== "number" ||
    typeof journal.updatedAt !== "number" ||
    !journal.target ||
    !selectionIsValid(journal.target, merchantPubkey) ||
    !Array.isArray(journal.listings) ||
    journal.listings.length === 0
  ) {
    return false
  }

  const seen = new Set<string>()
  for (const listing of journal.listings) {
    const decoded = decodeProductReference(listing.productCoordinate)
    if (
      !decoded ||
      decoded.authorPubkey !== merchantPubkey ||
      seen.has(listing.productCoordinate) ||
      ![
        "awaiting_signature",
        "signed",
        "partial",
        "retry_needed",
        "delivered",
      ].includes(listing.status) ||
      !Number.isSafeInteger(listing.attemptCount) ||
      listing.attemptCount < 0 ||
      !isStringArray(listing.attemptedRelayUrls) ||
      !isStringArray(listing.acknowledgedRelayUrls) ||
      !isStringArray(listing.failedRelayUrls)
    ) {
      return false
    }
    seen.add(listing.productCoordinate)
    const attempted = new Set(listing.attemptedRelayUrls)
    const acknowledged = new Set(listing.acknowledgedRelayUrls)
    if (
      listing.acknowledgedRelayUrls.some(
        (relayUrl) => !attempted.has(relayUrl)
      ) ||
      listing.failedRelayUrls.some(
        (relayUrl) => !attempted.has(relayUrl) || acknowledged.has(relayUrl)
      )
    ) {
      return false
    }
    if (listing.status === "awaiting_signature") {
      if (
        listing.signedEvent !== undefined ||
        listing.attemptCount !== 0 ||
        attempted.size !== 0
      ) {
        return false
      }
      continue
    }
    if (
      !listing.signedEvent ||
      !isValidSignedPublicNostrEvent(listing.signedEvent) ||
      signedProductCoordinate(listing.signedEvent) !== listing.productCoordinate
    ) {
      return false
    }
    const stateIsCoherent =
      (listing.status === "signed" &&
        listing.attemptCount === 0 &&
        attempted.size === 0) ||
      (listing.status === "retry_needed" &&
        listing.attemptCount > 0 &&
        acknowledged.size === 0) ||
      (listing.status === "partial" &&
        listing.attemptCount > 0 &&
        acknowledged.size > 0 &&
        listing.failedRelayUrls.length > 0) ||
      (listing.status === "delivered" &&
        listing.attemptCount > 0 &&
        acknowledged.size > 0 &&
        listing.failedRelayUrls.length === 0)
    if (!stateIsCoherent) return false
  }
  return true
}

function createTransitionId(now: number): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `event-handoff-${now}`
  }
}

export function createMerchantEventHandoffTransition(input: {
  merchantPubkey: string
  collectionCoordinate: string
  target: MerchantEventHandoffSelection
  listings: readonly {
    productCoordinate: string
    title?: string
    previousHandoffMode?: "merchant_handoff" | "organizer_handoff"
    previousPickupCoordinate?: string
  }[]
  id?: string
  now?: number
}): MerchantEventHandoffTransitionJournal {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const collectionCoordinate = decodeOrganizerEventMarketReference(
    input.collectionCoordinate
  )
  if (!selectionIsValid(input.target, merchantPubkey)) {
    throw new Error("Target event handoff selection is invalid.")
  }
  if (input.listings.length === 0) {
    throw new Error("At least one affected event listing is required.")
  }
  const coordinates = input.listings.map((listing) => {
    const decoded = decodeProductReference(listing.productCoordinate)
    if (!decoded || decoded.authorPubkey !== merchantPubkey) {
      throw new Error("Affected event listing does not belong to the merchant.")
    }
    return listing.productCoordinate
  })
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("Affected event listings must be unique.")
  }
  const now = input.now ?? Date.now()
  return {
    version: 1,
    id: input.id ?? createTransitionId(now),
    merchantPubkey,
    collectionCoordinate,
    target: input.target,
    createdAt: now,
    updatedAt: now,
    listings: input.listings.map((listing) => ({
      productCoordinate: listing.productCoordinate,
      ...(listing.title ? { title: listing.title } : {}),
      ...(listing.previousHandoffMode
        ? { previousHandoffMode: listing.previousHandoffMode }
        : {}),
      ...(listing.previousPickupCoordinate
        ? { previousPickupCoordinate: listing.previousPickupCoordinate }
        : {}),
      status: "awaiting_signature",
      attemptCount: 0,
      attemptedRelayUrls: [],
      acknowledgedRelayUrls: [],
      failedRelayUrls: [],
    })),
  }
}

export function saveMerchantEventHandoffTransition(
  journal: MerchantEventHandoffTransitionJournal,
  storageInput?: MerchantEventHandoffStorage | null
): MerchantEventHandoffTransitionJournal {
  const merchantPubkey = normalizeMerchantPubkey(journal.merchantPubkey)
  const collectionCoordinate = decodeOrganizerEventMarketReference(
    journal.collectionCoordinate
  )
  if (!journalIsValid(journal, merchantPubkey, collectionCoordinate)) {
    throw new Error("Event handoff transition journal is invalid.")
  }
  const storage = getStorage(storageInput)
  if (!storage) {
    throw new Error(
      "Durable event handoff transition storage is unavailable. Delivery was stopped."
    )
  }
  try {
    storage.setItem(
      transitionStorageKey(merchantPubkey, collectionCoordinate),
      JSON.stringify(journal)
    )
    return journal
  } catch (error) {
    throw new Error(
      "The event handoff transition could not be saved. Delivery was stopped.",
      { cause: error }
    )
  }
}

export function loadMerchantEventHandoffTransition(
  merchantPubkeyInput: string,
  collectionCoordinateInput: string,
  storageInput?: MerchantEventHandoffStorage | null
): MerchantEventHandoffTransitionJournal | null {
  const merchantPubkey = normalizeMerchantPubkey(merchantPubkeyInput)
  const collectionCoordinate = decodeOrganizerEventMarketReference(
    collectionCoordinateInput
  )
  const storage = getStorage(storageInput)
  if (!storage) {
    throw new Error(
      "Durable event handoff transition storage is unavailable. Publishing was stopped before signing."
    )
  }
  const raw = storage.getItem(
    transitionStorageKey(merchantPubkey, collectionCoordinate)
  )
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!journalIsValid(parsed, merchantPubkey, collectionCoordinate)) {
      throw new Error("invalid")
    }
    return parsed
  } catch (error) {
    throw new Error(
      "Saved event handoff transition is invalid. Publishing was stopped before signing.",
      { cause: error }
    )
  }
}

export function clearMerchantEventHandoffTransition(
  merchantPubkeyInput: string,
  collectionCoordinateInput: string,
  storageInput?: MerchantEventHandoffStorage | null
): void {
  const merchantPubkey = normalizeMerchantPubkey(merchantPubkeyInput)
  const collectionCoordinate = decodeOrganizerEventMarketReference(
    collectionCoordinateInput
  )
  getStorage(storageInput)?.removeItem(
    transitionStorageKey(merchantPubkey, collectionCoordinate)
  )
}

export function recordMerchantEventHandoffListingSignature(input: {
  journal: MerchantEventHandoffTransitionJournal
  productCoordinate: string
  signedEvent: SignedPublicNostrEvent
  now?: number
}): MerchantEventHandoffTransitionJournal {
  if (
    !isValidSignedPublicNostrEvent(input.signedEvent) ||
    signedProductCoordinate(input.signedEvent) !== input.productCoordinate ||
    input.signedEvent.pubkey !== input.journal.merchantPubkey
  ) {
    throw new Error(
      "The signed product revision does not match the affected event listing."
    )
  }
  let found = false
  const listings = input.journal.listings.map((listing) => {
    if (listing.productCoordinate !== input.productCoordinate) return listing
    found = true
    if (
      listing.signedEvent &&
      listing.signedEvent.id !== input.signedEvent.id
    ) {
      throw new Error(
        "The transition already retains a different signed revision for this listing."
      )
    }
    return {
      ...listing,
      status:
        listing.status === "awaiting_signature"
          ? ("signed" as const)
          : listing.status,
      signedEvent: input.signedEvent,
    }
  })
  if (!found)
    throw new Error("Affected event listing is not in this transition.")
  return {
    ...input.journal,
    updatedAt: input.now ?? Date.now(),
    listings,
  }
}

function mergeDelivery(
  listing: MerchantEventHandoffTransitionListing,
  delivery: PublishWithPlannerResult,
  now: number
): MerchantEventHandoffTransitionListing {
  const attemptedRelayUrls = unique([
    ...listing.attemptedRelayUrls,
    ...delivery.attemptedRelayUrls,
  ])
  const acknowledgedRelayUrls = unique([
    ...listing.acknowledgedRelayUrls,
    ...delivery.successfulRelayUrls,
  ])
  const acknowledged = new Set(acknowledgedRelayUrls)
  const failedRelayUrls = unique([
    ...listing.failedRelayUrls,
    ...delivery.failedRelayUrls,
  ]).filter((relayUrl) => !acknowledged.has(relayUrl))
  const status: MerchantEventHandoffTransitionListingStatus =
    acknowledgedRelayUrls.length === 0
      ? "retry_needed"
      : failedRelayUrls.length > 0
        ? "partial"
        : "delivered"
  return {
    ...listing,
    status,
    attemptCount: listing.attemptCount + 1,
    attemptedRelayUrls,
    acknowledgedRelayUrls,
    failedRelayUrls,
    lastAttemptAt: now,
  }
}

function recordDeliveryFailure(
  listing: MerchantEventHandoffTransitionListing,
  now: number
): MerchantEventHandoffTransitionListing {
  return {
    ...listing,
    status:
      listing.acknowledgedRelayUrls.length > 0 ? "partial" : "retry_needed",
    attemptCount: listing.attemptCount + 1,
    lastAttemptAt: now,
  }
}

export function getMerchantEventHandoffTransitionSummary(
  journal: MerchantEventHandoffTransitionJournal
): MerchantEventHandoffTransitionSummary {
  const counts = {
    awaitingSignature: journal.listings.filter(
      (listing) => listing.status === "awaiting_signature"
    ).length,
    signed: journal.listings.filter((listing) => listing.status === "signed")
      .length,
    retryNeeded: journal.listings.filter(
      (listing) => listing.status === "retry_needed"
    ).length,
    partial: journal.listings.filter((listing) => listing.status === "partial")
      .length,
    delivered: journal.listings.filter(
      (listing) => listing.status === "delivered"
    ).length,
  }
  const state: MerchantEventHandoffTransitionSummary["state"] =
    counts.delivered === journal.listings.length
      ? "complete"
      : counts.delivered > 0 || counts.partial > 0
        ? "partial"
        : counts.retryNeeded > 0
          ? "retry_needed"
          : "pending"
  return { state, total: journal.listings.length, ...counts }
}

/**
 * Deliver only retained signed revisions that still need work. Each per-listing
 * outcome is persisted before moving to the next listing; no retry re-signs.
 */
export async function retryMerchantEventHandoffTransition(input: {
  journal: MerchantEventHandoffTransitionJournal
  deliver: (
    signedEvent: SignedPublicNostrEvent,
    productCoordinate: string
  ) => Promise<PublishWithPlannerResult>
  storage?: MerchantEventHandoffStorage | null
  now?: () => number
}): Promise<MerchantEventHandoffTransitionJournal> {
  let journal = saveMerchantEventHandoffTransition(input.journal, input.storage)
  for (const original of journal.listings) {
    if (
      original.status === "awaiting_signature" ||
      original.status === "delivered"
    ) {
      continue
    }
    if (!original.signedEvent) {
      throw new Error("Signed event is unavailable for exact transition retry.")
    }
    const attemptedAt = input.now?.() ?? Date.now()
    let updated: MerchantEventHandoffTransitionListing
    try {
      const delivery = await input.deliver(
        original.signedEvent,
        original.productCoordinate
      )
      updated = mergeDelivery(original, delivery, attemptedAt)
    } catch {
      updated = recordDeliveryFailure(original, attemptedAt)
    }
    journal = {
      ...journal,
      updatedAt: attemptedAt,
      listings: journal.listings.map((listing) =>
        listing.productCoordinate === updated.productCoordinate
          ? updated
          : listing
      ),
    }
    saveMerchantEventHandoffTransition(journal, input.storage)
  }
  return journal
}
