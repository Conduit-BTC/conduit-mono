import {
  buildProductListingEventDraft,
  decodeProductReference,
  EVENT_HANDOFF_CHANGE_TAG,
  type ProductSchema,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  decodeOrganizerEventMarketReference,
  type MerchantOrganizerEventMarket,
} from "./event-market"
import {
  ensureMerchantBoothPickup,
  type EnsureMerchantBoothPickupInput,
  type EnsuredMerchantBoothPickup,
} from "./event-market-pickup"
import {
  saveMerchantEventHandoffPreference,
  type MerchantEventHandoffSelection,
  type MerchantEventHandoffStorage,
} from "./merchant-event-handoff-arrangement"
import {
  clearMerchantEventHandoffTransition,
  createMerchantEventHandoffTransition,
  getMerchantEventHandoffTransitionSummary,
  loadMerchantEventHandoffTransition,
  recordMerchantEventHandoffListingSignature,
  saveMerchantEventHandoffTransition,
  type MerchantEventHandoffTransitionJournal,
  type MerchantEventHandoffTransitionListing,
  type MerchantEventHandoffTransitionSummary,
} from "./merchant-event-handoff-transition"
import { buildProductLocalPickupMetadata } from "./product-local-pickup"
import {
  applyProductFulfillmentIntentForPublication,
  deliverSignedProductEvent,
  getRelayPublishDiagnosticsError,
  signAndPublishProductListing,
  type ProductSignerRequestProgress,
} from "./product-publishing"

const HEX_64 = /^[0-9a-f]{64}$/

export interface MerchantEventHandoffProductSource {
  /** Exact verified kind-30402 revision represented by product. */
  eventId: string
  createdAt: number
  product: ProductSchema
}

export interface MerchantEventHandoffChangeSourceRead {
  market: MerchantOrganizerEventMarket
  /**
   * All known merchant products may be supplied. Products referencing this
   * collection must agree with the market's exact accepted/pending evidence.
   */
  listings: readonly MerchantEventHandoffProductSource[]
}

export interface MerchantEventHandoffAffectedListing extends MerchantEventHandoffProductSource {
  productCoordinate: string
  status: "accepted" | "pending"
  previousHandoffMode?: "merchant_handoff" | "organizer_handoff"
  previousPickupCoordinate?: string
}

export interface MerchantEventHandoffChangeSourceSnapshot {
  collectionCoordinate: string
  collectionEventId: string
  calendarEventId: string
  organizerPickupCoordinate?: string
  organizerPickupEventId?: string
  listings: readonly {
    productCoordinate: string
    eventId: string
    createdAt: number
    status: "accepted" | "pending"
  }[]
}

export interface MerchantEventHandoffChangeListing extends MerchantEventHandoffTransitionListing {
  sourceEventId: string
  sourceCreatedAt: number
  sourceStatus: "accepted" | "pending"
}

export interface MerchantEventHandoffChangeJournal extends Omit<
  MerchantEventHandoffTransitionJournal,
  "listings"
> {
  source: MerchantEventHandoffChangeSourceSnapshot
  listings: MerchantEventHandoffChangeListing[]
}

export interface MerchantEventHandoffReacceptance {
  productCoordinates: string[]
  state:
    "not_required" | "blocked_by_delivery" | "required" | "requested" | "failed"
  error?: string
}

export interface MerchantEventHandoffChangeFailure {
  productCoordinate: string
  phase: "sign" | "delivery"
  message: string
}

export interface MerchantEventHandoffChangeResult {
  journal: MerchantEventHandoffChangeJournal
  summary: MerchantEventHandoffTransitionSummary
  stoppedReason?: "source_changed" | "signature_failed"
  failures: MerchantEventHandoffChangeFailure[]
  organizerReacceptance: MerchantEventHandoffReacceptance
}

interface SignAndDeliverListingInput {
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  product: ProductSchema
  dTag: string
  previousEventCreatedAt: number
  additionalProductTags: readonly (readonly string[])[]
  persistSignedEvent: (event: SignedPublicNostrEvent) => Promise<void>
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
}

export interface MerchantEventHandoffChangeDependencies {
  ensureMerchantPickup?: (
    input: EnsureMerchantBoothPickupInput
  ) => Promise<EnsuredMerchantBoothPickup>
  signAndDeliverListing?: (
    input: SignAndDeliverListingInput
  ) => Promise<PublishWithPlannerResult>
  deliverSignedEvent?: (
    event: SignedPublicNostrEvent,
    productCoordinate: string
  ) => Promise<PublishWithPlannerResult>
}

export interface MerchantEventHandoffChangeInput {
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  source: MerchantEventHandoffChangeSourceRead
  target: MerchantEventHandoffSelection
  storage?: MerchantEventHandoffStorage | null
  /** Must durably preserve every existing order's original handoff evidence. */
  checkpointExistingOrders: (input: {
    merchantPubkey: string
    source: MerchantEventHandoffChangeSourceSnapshot
    target: MerchantEventHandoffSelection
    affectedListings: readonly MerchantEventHandoffAffectedListing[]
  }) => Promise<void>
  /** Fresh verified source read, used before each irreversible product sign. */
  readCurrentSource: () => Promise<MerchantEventHandoffChangeSourceRead>
  requestOrganizerReacceptance?: (input: {
    merchantPubkey: string
    collectionCoordinate: string
    listings: readonly {
      productCoordinate: string
      signedEvent: SignedPublicNostrEvent
    }[]
  }) => Promise<void>
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
  now?: () => number
  dependencies?: MerchantEventHandoffChangeDependencies
}

export interface RetryMerchantEventHandoffChangeInput {
  journal: MerchantEventHandoffChangeJournal
  storage?: MerchantEventHandoffStorage | null
  readCurrentSource: () => Promise<MerchantEventHandoffChangeSourceRead>
  requestOrganizerReacceptance?: MerchantEventHandoffChangeInput["requestOrganizerReacceptance"]
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  now?: () => number
  dependencies?: Pick<
    MerchantEventHandoffChangeDependencies,
    "deliverSignedEvent"
  >
}

export interface FinalizeMerchantEventHandoffChangeInput {
  journal: MerchantEventHandoffChangeJournal
  current: MerchantEventHandoffChangeSourceRead
  storage?: MerchantEventHandoffStorage | null
  now?: () => number
}

function normalizeMerchantPubkey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) throw new Error("Merchant pubkey is invalid.")
  return normalized
}

function exactEventId(value: string | undefined, label: string): string {
  const normalized = value?.trim().toLowerCase() ?? ""
  if (!HEX_64.test(normalized)) {
    throw new Error(`${label} exact signed revision is unavailable.`)
  }
  return normalized
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function eventProductSourcesForCollection(
  sources: readonly MerchantEventHandoffProductSource[],
  merchantPubkey: string,
  collectionCoordinate: string
): Map<string, MerchantEventHandoffProductSource> {
  const matches = new Map<string, MerchantEventHandoffProductSource>()
  for (const source of sources) {
    if (
      source.product.pubkey.toLowerCase() !== merchantPubkey ||
      source.product.collectionRefs?.includes(collectionCoordinate) !== true
    ) {
      continue
    }
    const decoded = decodeProductReference(source.product.id)
    if (
      !decoded ||
      decoded.authorPubkey !== merchantPubkey ||
      source.product.id !== decoded.addressId ||
      !HEX_64.test(source.eventId) ||
      !Number.isSafeInteger(source.createdAt) ||
      source.createdAt < 0
    ) {
      throw new Error(
        "An event listing source is missing exact verified revision evidence."
      )
    }
    if (matches.has(source.product.id)) {
      throw new Error("Event listing sources must be unique by coordinate.")
    }
    matches.set(source.product.id, source)
  }
  return matches
}

/**
 * Enumerate one exact current kind-30402 revision for every accepted or pending
 * listing owned by this merchant at this event. Partial network evidence is
 * intentionally insufficient for an arrangement-wide change.
 */
export function enumerateMerchantEventHandoffAffectedListings(input: {
  merchantPubkey: string
  source: MerchantEventHandoffChangeSourceRead
}): MerchantEventHandoffAffectedListing[] {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const collectionCoordinate = decodeOrganizerEventMarketReference(
    input.source.market.collectionCoordinate
  )
  if (input.source.market.state !== "active") {
    throw new Error(
      "Complete active event evidence is required before changing handoff."
    )
  }
  exactEventId(input.source.market.collectionEventId, "Event collection")
  exactEventId(input.source.market.calendarEventId, "Event calendar")

  const sourceByCoordinate = eventProductSourcesForCollection(
    input.source.listings,
    merchantPubkey,
    collectionCoordinate
  )
  const participationByCoordinate = new Map<
    string,
    {
      eventId: string
      createdAt: number
      status: "accepted" | "pending"
      previousHandoffMode?: "merchant_handoff" | "organizer_handoff"
      previousPickupCoordinate?: string
    }
  >()

  for (const participation of input.source.market.participation) {
    if (participation.status === "organizer_only") continue
    const decoded = decodeProductReference(participation.productCoordinate)
    const participantMerchant =
      participation.merchantPubkey?.toLowerCase() ?? decoded?.authorPubkey
    if (!decoded || participantMerchant !== merchantPubkey) continue
    const eventId = exactEventId(
      participation.eventId,
      "Event listing participation"
    )
    // Event-market projections expose UI timestamps in milliseconds while
    // signing frontiers use Nostr's raw created_at seconds.
    const createdAt =
      typeof participation.createdAt === "number" &&
      participation.createdAt >= 1_000_000_000_000
        ? Math.floor(participation.createdAt / 1_000)
        : participation.createdAt
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt === undefined ||
      createdAt < 0
    ) {
      throw new Error(
        "Event listing participation is missing its exact signed timestamp."
      )
    }
    const existing = participationByCoordinate.get(
      participation.productCoordinate
    )
    if (
      existing &&
      (existing.eventId !== eventId || existing.createdAt !== createdAt)
    ) {
      throw new Error(
        "Event participation points to conflicting current product revisions."
      )
    }
    participationByCoordinate.set(participation.productCoordinate, {
      eventId,
      createdAt,
      status:
        existing?.status === "accepted" || participation.status === "accepted"
          ? "accepted"
          : "pending",
      ...(participation.handoffMode
        ? { previousHandoffMode: participation.handoffMode }
        : existing?.previousHandoffMode
          ? { previousHandoffMode: existing.previousHandoffMode }
          : {}),
      ...(participation.pickupCoordinate
        ? { previousPickupCoordinate: participation.pickupCoordinate }
        : existing?.previousPickupCoordinate
          ? { previousPickupCoordinate: existing.previousPickupCoordinate }
          : {}),
    })
  }

  if (sourceByCoordinate.size === 0) {
    throw new Error("This merchant has no accepted or pending event listings.")
  }
  if (
    sourceByCoordinate.size !== participationByCoordinate.size ||
    Array.from(sourceByCoordinate.keys()).some(
      (coordinate) => !participationByCoordinate.has(coordinate)
    ) ||
    Array.from(participationByCoordinate.keys()).some(
      (coordinate) => !sourceByCoordinate.has(coordinate)
    )
  ) {
    throw new Error(
      "Merchant product sources and event participation disagree on the affected listing set."
    )
  }

  return Array.from(sourceByCoordinate.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([productCoordinate, source]) => {
      const participation = participationByCoordinate.get(productCoordinate)!
      if (
        source.eventId.toLowerCase() !== participation.eventId ||
        source.createdAt !== participation.createdAt
      ) {
        throw new Error(
          "A merchant product source does not match the event's exact current revision."
        )
      }
      return {
        ...source,
        eventId: source.eventId.toLowerCase(),
        productCoordinate,
        status: participation.status,
        ...(participation.previousHandoffMode
          ? { previousHandoffMode: participation.previousHandoffMode }
          : {}),
        ...(participation.previousPickupCoordinate
          ? {
              previousPickupCoordinate: participation.previousPickupCoordinate,
            }
          : {}),
      }
    })
}

export function snapshotMerchantEventHandoffChangeSource(input: {
  merchantPubkey: string
  source: MerchantEventHandoffChangeSourceRead
}): {
  affectedListings: MerchantEventHandoffAffectedListing[]
  snapshot: MerchantEventHandoffChangeSourceSnapshot
} {
  const affectedListings = enumerateMerchantEventHandoffAffectedListings(input)
  const market = input.source.market
  return {
    affectedListings,
    snapshot: {
      collectionCoordinate: decodeOrganizerEventMarketReference(
        market.collectionCoordinate
      ),
      collectionEventId: exactEventId(
        market.collectionEventId,
        "Event collection"
      ),
      calendarEventId: exactEventId(market.calendarEventId, "Event calendar"),
      ...(market.pickupCoordinate
        ? { organizerPickupCoordinate: market.pickupCoordinate }
        : {}),
      ...(market.pickupEventId
        ? {
            organizerPickupEventId: exactEventId(
              market.pickupEventId,
              "Organizer pickup"
            ),
          }
        : {}),
      listings: affectedListings.map((listing) => ({
        productCoordinate: listing.productCoordinate,
        eventId: listing.eventId,
        createdAt: listing.createdAt,
        status: listing.status,
      })),
    },
  }
}

function productUsesTarget(
  product: ProductSchema,
  collectionCoordinate: string,
  target: MerchantEventHandoffSelection
): boolean {
  const shippingCoordinates = unique([
    ...(product.shippingOptionRefs ?? []).map(
      (reference) => reference.coordinate
    ),
    ...(product.shippingOptionId ? [product.shippingOptionId] : []),
  ])
  return (
    product.collectionRefs?.length === 1 &&
    product.collectionRefs[0] === collectionCoordinate &&
    shippingCoordinates.length === 1 &&
    shippingCoordinates[0] === target.pickupCoordinate
  )
}

/**
 * Commit the new local preference only after every exact product revision is
 * delivered and every listing that was previously accepted is represented by
 * a fresh organizer-authored collection acceptance. The transition journal is
 * retained on every failure so refresh/retry can continue safely.
 */
export function finalizeMerchantEventHandoffChange(
  input: FinalizeMerchantEventHandoffChangeInput
): void {
  const { journal } = input
  if (getMerchantEventHandoffTransitionSummary(journal).state !== "complete") {
    throw new Error(
      "Every affected listing must be delivered before this handoff change can finish."
    )
  }
  const currentListings = assertMerchantEventHandoffChangeSourceUnchanged({
    merchantPubkey: journal.merchantPubkey,
    journal,
    current: input.current,
    allowOrganizerAcceptanceRevision: true,
  })
  const currentByCoordinate = new Map(
    currentListings.map((listing) => [listing.productCoordinate, listing])
  )
  for (const listing of journal.listings) {
    const current = currentByCoordinate.get(listing.productCoordinate)
    if (
      !current ||
      !listing.signedEvent ||
      current.eventId !== listing.signedEvent.id ||
      !productUsesTarget(
        current.product,
        journal.collectionCoordinate,
        journal.target
      )
    ) {
      throw new Error(
        "The current event listing evidence does not yet match this handoff change."
      )
    }
    if (listing.sourceStatus === "accepted" && current.status !== "accepted") {
      throw new Error(
        "Organizer acceptance is still required for the changed event listings."
      )
    }
  }

  saveMerchantEventHandoffPreference(
    {
      version: 1,
      merchantPubkey: journal.merchantPubkey,
      collectionCoordinate: journal.collectionCoordinate,
      ...journal.target,
      savedAt: input.now?.() ?? Date.now(),
    },
    input.storage
  )
  clearMerchantEventHandoffTransition(
    journal.merchantPubkey,
    journal.collectionCoordinate,
    input.storage
  )
}

/** Throws before more signatures or retries when the source moved unexpectedly. */
export function assertMerchantEventHandoffChangeSourceUnchanged(input: {
  merchantPubkey: string
  journal: MerchantEventHandoffChangeJournal
  current: MerchantEventHandoffChangeSourceRead
  /** Finalization may observe the expected newer organizer collection. */
  allowOrganizerAcceptanceRevision?: boolean
}): MerchantEventHandoffAffectedListing[] {
  const current = snapshotMerchantEventHandoffChangeSource({
    merchantPubkey: input.merchantPubkey,
    source: input.current,
  })
  if (
    current.snapshot.collectionCoordinate !==
      input.journal.source.collectionCoordinate ||
    (!input.allowOrganizerAcceptanceRevision &&
      current.snapshot.collectionEventId !==
        input.journal.source.collectionEventId) ||
    current.snapshot.calendarEventId !== input.journal.source.calendarEventId ||
    current.snapshot.organizerPickupCoordinate !==
      input.journal.source.organizerPickupCoordinate ||
    current.snapshot.organizerPickupEventId !==
      input.journal.source.organizerPickupEventId ||
    current.affectedListings.length !== input.journal.listings.length
  ) {
    throw new Error(
      "Event or affected listing evidence changed during the handoff transition."
    )
  }

  const currentByCoordinate = new Map(
    current.affectedListings.map((listing) => [
      listing.productCoordinate,
      listing,
    ])
  )
  for (const listing of input.journal.listings) {
    const currentListing = currentByCoordinate.get(listing.productCoordinate)
    if (!currentListing) {
      throw new Error(
        "The affected event listing set changed during the handoff transition."
      )
    }
    if (currentListing.eventId === listing.sourceEventId) {
      if (
        currentListing.createdAt !== listing.sourceCreatedAt ||
        currentListing.status !== listing.sourceStatus
      ) {
        throw new Error(
          "An affected event listing changed during the handoff transition."
        )
      }
      continue
    }
    if (
      !listing.signedEvent ||
      currentListing.eventId !== listing.signedEvent.id ||
      currentListing.createdAt !== listing.signedEvent.created_at ||
      !productUsesTarget(
        currentListing.product,
        input.journal.collectionCoordinate,
        input.journal.target
      )
    ) {
      throw new Error(
        "An affected event listing changed outside this handoff transition."
      )
    }
  }
  return current.affectedListings
}

function asChangeJournal(
  journal: MerchantEventHandoffTransitionJournal,
  source: MerchantEventHandoffChangeSourceSnapshot,
  affected: readonly MerchantEventHandoffAffectedListing[]
): MerchantEventHandoffChangeJournal {
  return {
    ...journal,
    source,
    listings: journal.listings.map((listing) => {
      const sourceListing = affected.find(
        (candidate) => candidate.productCoordinate === listing.productCoordinate
      )!
      return {
        ...listing,
        sourceEventId: sourceListing.eventId,
        sourceCreatedAt: sourceListing.createdAt,
        sourceStatus: sourceListing.status,
      }
    }),
  }
}

function saveChangeJournal(
  journal: MerchantEventHandoffChangeJournal,
  storage: MerchantEventHandoffStorage | null | undefined
): MerchantEventHandoffChangeJournal {
  saveMerchantEventHandoffTransition(journal, storage)
  return journal
}

/** Load and validate the source snapshot needed for safe post-restart retry. */
export function loadMerchantEventHandoffChange(
  merchantPubkeyInput: string,
  collectionCoordinateInput: string,
  storage?: MerchantEventHandoffStorage | null
): MerchantEventHandoffChangeJournal | null {
  const merchantPubkey = normalizeMerchantPubkey(merchantPubkeyInput)
  const journal = loadMerchantEventHandoffTransition(
    merchantPubkey,
    collectionCoordinateInput,
    storage
  )
  if (!journal) return null
  const candidate = journal as Partial<MerchantEventHandoffChangeJournal>
  const source = candidate.source
  if (
    !source ||
    source.collectionCoordinate !== journal.collectionCoordinate ||
    !HEX_64.test(source.collectionEventId) ||
    !HEX_64.test(source.calendarEventId) ||
    (source.organizerPickupEventId !== undefined &&
      !HEX_64.test(source.organizerPickupEventId)) ||
    !Array.isArray(source.listings) ||
    source.listings.length !== journal.listings.length
  ) {
    throw new Error(
      "Saved event handoff change source is invalid. Retry was stopped."
    )
  }
  const sourceByCoordinate = new Map(
    source.listings.map((listing) => [listing.productCoordinate, listing])
  )
  for (const listing of candidate.listings ?? []) {
    const snapshot = sourceByCoordinate.get(listing.productCoordinate)
    if (
      !HEX_64.test(listing.sourceEventId) ||
      !Number.isSafeInteger(listing.sourceCreatedAt) ||
      (listing.sourceStatus !== "accepted" &&
        listing.sourceStatus !== "pending") ||
      !snapshot ||
      snapshot.eventId !== listing.sourceEventId ||
      snapshot.createdAt !== listing.sourceCreatedAt ||
      snapshot.status !== listing.sourceStatus
    ) {
      throw new Error(
        "Saved event handoff change source is invalid. Retry was stopped."
      )
    }
  }
  return candidate as MerchantEventHandoffChangeJournal
}

function updateListing(
  journal: MerchantEventHandoffChangeJournal,
  productCoordinate: string,
  update: (
    listing: MerchantEventHandoffChangeListing
  ) => MerchantEventHandoffChangeListing,
  now: number
): MerchantEventHandoffChangeJournal {
  let found = false
  const listings = journal.listings.map((listing) => {
    if (listing.productCoordinate !== productCoordinate) return listing
    found = true
    return update(listing)
  })
  if (!found) throw new Error("Affected listing is not in this transition.")
  return { ...journal, updatedAt: now, listings }
}

function recordDeliveryResult(input: {
  journal: MerchantEventHandoffChangeJournal
  productCoordinate: string
  delivery?: PublishWithPlannerResult
  now: number
}): MerchantEventHandoffChangeJournal {
  return updateListing(
    input.journal,
    input.productCoordinate,
    (listing) => {
      const attemptedRelayUrls = unique([
        ...listing.attemptedRelayUrls,
        ...(input.delivery?.attemptedRelayUrls ?? []),
      ])
      const acknowledgedRelayUrls = unique([
        ...listing.acknowledgedRelayUrls,
        ...(input.delivery?.successfulRelayUrls ?? []),
      ])
      const acknowledged = new Set(acknowledgedRelayUrls)
      const failedRelayUrls = unique([
        ...listing.failedRelayUrls,
        ...(input.delivery?.failedRelayUrls ?? []),
      ]).filter((relayUrl) => !acknowledged.has(relayUrl))
      const status =
        acknowledgedRelayUrls.length === 0
          ? ("retry_needed" as const)
          : failedRelayUrls.length > 0
            ? ("partial" as const)
            : ("delivered" as const)
      return {
        ...listing,
        status,
        attemptCount: listing.attemptCount + 1,
        attemptedRelayUrls,
        acknowledgedRelayUrls,
        failedRelayUrls,
        lastAttemptAt: input.now,
      }
    },
    input.now
  )
}

function revisedProductForTarget(input: {
  source: MerchantEventHandoffAffectedListing
  market: MerchantOrganizerEventMarket
  target: MerchantEventHandoffSelection
  now: number
}): ProductSchema {
  const pickup = buildProductLocalPickupMetadata(input.market, {
    handoffMode: input.target.mode,
    ...(input.target.mode === "merchant_handoff"
      ? { merchantPickupCoordinate: input.target.pickupCoordinate }
      : {}),
  })
  return {
    ...input.source.product,
    ...pickup,
    shippingCostSats: undefined,
    sourceShippingCost: undefined,
    shippingOptionDTag: undefined,
    shippingOptionLaunchUnsupported: undefined,
    shippingCountries: undefined,
    shippingCountryRules: undefined,
    canonicalShippingResolved: false,
    shippingOptionCreatedAt: undefined,
    updatedAt: input.now,
  }
}

function assertSignedRevisionMatchesTarget(input: {
  signedEvent: SignedPublicNostrEvent
  product: ProductSchema
  dTag: string
  merchantPubkey: string
  previousCreatedAt: number
  additionalProductTags: readonly (readonly string[])[]
}): void {
  const canonicalProduct = applyProductFulfillmentIntentForPublication({
    product: input.product,
    merchantPubkey: input.merchantPubkey,
    productDTag: input.dTag,
    intent: { kind: "coordinate_after_order" },
  })
  const draft = buildProductListingEventDraft({
    product: canonicalProduct,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  draft.tags.push(...input.additionalProductTags.map((tag) => [...tag]))
  if (
    input.signedEvent.pubkey !== input.merchantPubkey ||
    input.signedEvent.kind !== draft.kind ||
    input.signedEvent.created_at <= input.previousCreatedAt ||
    input.signedEvent.content !== draft.content ||
    JSON.stringify(input.signedEvent.tags) !== JSON.stringify(draft.tags)
  ) {
    throw new Error(
      "The signed product revision does not match the exact handoff transition target."
    )
  }
}

async function defaultSignAndDeliverListing(
  input: SignAndDeliverListingInput
): Promise<PublishWithPlannerResult> {
  return signAndPublishProductListing({
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    product: input.product,
    dTag: input.dTag,
    previousEventCreatedAt: input.previousEventCreatedAt,
    fulfillmentIntent: { kind: "coordinate_after_order" },
    additionalProductTags: input.additionalProductTags,
    onSignerRequest: input.onSignerRequest,
    onSignedLocal: async (event) => {
      await input.persistSignedEvent(event.rawEvent() as SignedPublicNostrEvent)
    },
  })
}

async function prepareTargetPickup(input: {
  merchantPubkey: string
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  market: MerchantOrganizerEventMarket
  target: MerchantEventHandoffSelection
  storage?: MerchantEventHandoffStorage | null
  ensureMerchantPickup: NonNullable<
    MerchantEventHandoffChangeDependencies["ensureMerchantPickup"]
  >
}): Promise<void> {
  if (input.target.mode === "organizer_handoff") {
    if (
      input.target.handlerPubkey.toLowerCase() !==
        input.market.organizerPubkey.toLowerCase() ||
      input.target.pickupCoordinate !== input.market.pickupCoordinate ||
      !input.market.pickupEventId
    ) {
      throw new Error(
        "The organizer's current offered handoff does not match the requested target."
      )
    }
    return
  }
  if (
    input.target.handlerPubkey.toLowerCase() !== input.merchantPubkey ||
    !input.target.merchantPickup
  ) {
    throw new Error("The merchant handoff target is incomplete.")
  }
  const pickup = await input.ensureMerchantPickup({
    authorPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    dTag: input.target.merchantPickup.dTag,
    title: input.target.merchantPickup.title,
    location: input.target.merchantPickup.location,
    geohash: input.target.merchantPickup.geohash,
    countries: input.target.merchantPickup.countries,
    storage: input.storage,
  })
  if (pickup.coordinate !== input.target.pickupCoordinate) {
    throw new Error(
      "The acknowledged merchant pickup does not match the requested transition target."
    )
  }
}

function organizerReacceptanceFor(
  journal: MerchantEventHandoffChangeJournal,
  attempted: boolean,
  error?: string
): MerchantEventHandoffReacceptance {
  const productCoordinates = journal.listings
    .filter((listing) => listing.sourceStatus === "accepted")
    .map((listing) => listing.productCoordinate)
  if (productCoordinates.length === 0) {
    return { productCoordinates, state: "not_required" }
  }
  const complete =
    getMerchantEventHandoffTransitionSummary(journal).state === "complete"
  if (!complete) {
    return { productCoordinates, state: "blocked_by_delivery" }
  }
  if (error) return { productCoordinates, state: "failed", error }
  return { productCoordinates, state: attempted ? "requested" : "required" }
}

function sourceChangedResult(
  journal: MerchantEventHandoffChangeJournal,
  failures: MerchantEventHandoffChangeFailure[]
): MerchantEventHandoffChangeResult {
  return {
    journal,
    summary: getMerchantEventHandoffTransitionSummary(journal),
    stoppedReason: "source_changed",
    failures,
    organizerReacceptance: organizerReacceptanceFor(journal, false),
  }
}

async function requestOrganizerReacceptanceIfReady(input: {
  journal: MerchantEventHandoffChangeJournal
  request?: MerchantEventHandoffChangeInput["requestOrganizerReacceptance"]
}): Promise<MerchantEventHandoffReacceptance> {
  const status = organizerReacceptanceFor(input.journal, false)
  if (status.state !== "required" || !input.request) return status
  const listings = input.journal.listings
    .filter((listing) => listing.sourceStatus === "accepted")
    .map((listing) => {
      if (!listing.signedEvent) {
        throw new Error(
          "A delivered accepted listing lost its signed revision."
        )
      }
      return {
        productCoordinate: listing.productCoordinate,
        signedEvent: listing.signedEvent,
      }
    })
  try {
    await input.request({
      merchantPubkey: input.journal.merchantPubkey,
      collectionCoordinate: input.journal.collectionCoordinate,
      listings,
    })
    return organizerReacceptanceFor(input.journal, true)
  } catch (error) {
    return organizerReacceptanceFor(
      input.journal,
      true,
      error instanceof Error ? error.message : "Organizer re-acceptance failed."
    )
  }
}

/**
 * Change one merchant/event arrangement without claiming success for unsigned
 * or unacknowledged listing revisions. Exact signatures are saved before any
 * product relay I/O and remain the sole retry payload.
 */
export async function executeMerchantEventHandoffChange(
  input: MerchantEventHandoffChangeInput
): Promise<MerchantEventHandoffChangeResult> {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  const initial = snapshotMerchantEventHandoffChangeSource({
    merchantPubkey,
    source: input.source,
  })
  if (
    loadMerchantEventHandoffTransition(
      merchantPubkey,
      initial.snapshot.collectionCoordinate,
      input.storage
    )
  ) {
    throw new Error(
      "An event handoff transition already exists. Resume or clear it before starting another."
    )
  }

  await input.checkpointExistingOrders({
    merchantPubkey,
    source: initial.snapshot,
    target: input.target,
    affectedListings: initial.affectedListings,
  })

  const afterCheckpoint = await input.readCurrentSource()
  const unchangedAfterCheckpoint = snapshotMerchantEventHandoffChangeSource({
    merchantPubkey,
    source: afterCheckpoint,
  })
  if (
    JSON.stringify(unchangedAfterCheckpoint.snapshot) !==
    JSON.stringify(initial.snapshot)
  ) {
    throw new Error(
      "Event or affected listing evidence changed while existing orders were checkpointed."
    )
  }

  await prepareTargetPickup({
    merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    market: afterCheckpoint.market,
    target: input.target,
    storage: input.storage,
    ensureMerchantPickup:
      input.dependencies?.ensureMerchantPickup ?? ensureMerchantBoothPickup,
  })

  const afterPickup = await input.readCurrentSource()
  const unchangedAfterPickup = snapshotMerchantEventHandoffChangeSource({
    merchantPubkey,
    source: afterPickup,
  })
  if (
    JSON.stringify(unchangedAfterPickup.snapshot) !==
    JSON.stringify(initial.snapshot)
  ) {
    throw new Error(
      "Event or affected listing evidence changed while the target pickup was prepared."
    )
  }

  const createdAt = input.now?.() ?? Date.now()
  let journal = asChangeJournal(
    createMerchantEventHandoffTransition({
      merchantPubkey,
      collectionCoordinate: initial.snapshot.collectionCoordinate,
      target: input.target,
      listings: initial.affectedListings.map((listing) => ({
        productCoordinate: listing.productCoordinate,
        title: listing.product.title,
        previousHandoffMode: listing.previousHandoffMode,
        previousPickupCoordinate: listing.previousPickupCoordinate,
      })),
      now: createdAt,
    }),
    initial.snapshot,
    initial.affectedListings
  )
  journal = saveChangeJournal(journal, input.storage)

  const failures: MerchantEventHandoffChangeFailure[] = []
  const signAndDeliver =
    input.dependencies?.signAndDeliverListing ?? defaultSignAndDeliverListing

  for (const affected of initial.affectedListings) {
    try {
      assertMerchantEventHandoffChangeSourceUnchanged({
        merchantPubkey,
        journal,
        current: await input.readCurrentSource(),
      })
    } catch (error) {
      failures.push({
        productCoordinate: affected.productCoordinate,
        phase: "sign",
        message:
          error instanceof Error ? error.message : "Source evidence changed.",
      })
      return sourceChangedResult(journal, failures)
    }

    const decoded = decodeProductReference(affected.productCoordinate)!
    const product = revisedProductForTarget({
      source: affected,
      market: afterPickup.market,
      target: input.target,
      now: input.now?.() ?? Date.now(),
    })
    const additionalProductTags = [
      [
        EVENT_HANDOFF_CHANGE_TAG,
        initial.snapshot.collectionCoordinate,
        affected.eventId,
      ],
    ] as const
    let signedPersisted = false
    try {
      const delivery = await signAndDeliver({
        merchantPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
        product,
        dTag: decoded.dTag,
        previousEventCreatedAt: affected.createdAt,
        additionalProductTags,
        onSignerRequest: input.onSignerRequest,
        persistSignedEvent: async (signedEvent) => {
          assertSignedRevisionMatchesTarget({
            signedEvent,
            product,
            dTag: decoded.dTag,
            merchantPubkey,
            previousCreatedAt: affected.createdAt,
            additionalProductTags,
          })
          journal = recordMerchantEventHandoffListingSignature({
            journal,
            productCoordinate: affected.productCoordinate,
            signedEvent,
            now: input.now?.() ?? Date.now(),
          }) as MerchantEventHandoffChangeJournal
          journal = saveChangeJournal(journal, input.storage)
          signedPersisted = true
        },
      })
      journal = recordDeliveryResult({
        journal,
        productCoordinate: affected.productCoordinate,
        delivery,
        now: input.now?.() ?? Date.now(),
      })
      journal = saveChangeJournal(journal, input.storage)
    } catch (error) {
      failures.push({
        productCoordinate: affected.productCoordinate,
        phase: signedPersisted ? "delivery" : "sign",
        message:
          error instanceof Error
            ? error.message
            : signedPersisted
              ? "Product delivery failed."
              : "Product signing failed.",
      })
      if (!signedPersisted) {
        return {
          journal,
          summary: getMerchantEventHandoffTransitionSummary(journal),
          stoppedReason: "signature_failed",
          failures,
          organizerReacceptance: organizerReacceptanceFor(journal, false),
        }
      }
      journal = recordDeliveryResult({
        journal,
        productCoordinate: affected.productCoordinate,
        delivery: getRelayPublishDiagnosticsError(error)?.diagnostics,
        now: input.now?.() ?? Date.now(),
      })
      journal = saveChangeJournal(journal, input.storage)
    }
  }

  return {
    journal,
    summary: getMerchantEventHandoffTransitionSummary(journal),
    failures,
    organizerReacceptance: await requestOrganizerReacceptanceIfReady({
      journal,
      request: input.requestOrganizerReacceptance,
    }),
  }
}

/** Retry retained exact signed revisions. This path never invokes a signer. */
export async function retryMerchantEventHandoffChange(
  input: RetryMerchantEventHandoffChangeInput
): Promise<MerchantEventHandoffChangeResult> {
  let journal = input.journal
  const failures: MerchantEventHandoffChangeFailure[] = []
  try {
    assertMerchantEventHandoffChangeSourceUnchanged({
      merchantPubkey: journal.merchantPubkey,
      journal,
      current: await input.readCurrentSource(),
    })
  } catch (error) {
    failures.push({
      productCoordinate: journal.listings[0]?.productCoordinate ?? "",
      phase: "delivery",
      message:
        error instanceof Error ? error.message : "Source evidence changed.",
    })
    return sourceChangedResult(journal, failures)
  }

  const deliver =
    input.dependencies?.deliverSignedEvent ??
    ((event: SignedPublicNostrEvent) =>
      deliverSignedProductEvent(event, journal.merchantPubkey, {
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      }))
  for (const listing of journal.listings) {
    if (
      listing.status === "awaiting_signature" ||
      listing.status === "delivered"
    ) {
      continue
    }
    if (!listing.signedEvent) {
      throw new Error("Signed event is unavailable for exact transition retry.")
    }
    try {
      const delivery = await deliver(
        listing.signedEvent,
        listing.productCoordinate
      )
      journal = recordDeliveryResult({
        journal,
        productCoordinate: listing.productCoordinate,
        delivery,
        now: input.now?.() ?? Date.now(),
      })
    } catch (error) {
      failures.push({
        productCoordinate: listing.productCoordinate,
        phase: "delivery",
        message:
          error instanceof Error ? error.message : "Product retry failed.",
      })
      journal = recordDeliveryResult({
        journal,
        productCoordinate: listing.productCoordinate,
        delivery: getRelayPublishDiagnosticsError(error)?.diagnostics,
        now: input.now?.() ?? Date.now(),
      })
    }
    journal = saveChangeJournal(journal, input.storage)
  }

  return {
    journal,
    summary: getMerchantEventHandoffTransitionSummary(journal),
    failures,
    organizerReacceptance: await requestOrganizerReacceptanceIfReady({
      journal,
      request: input.requestOrganizerReacceptance,
    }),
  }
}
