import { decodeProductReference } from "@conduit/core"
import {
  isParticipationHandoffVerified,
  isParticipationProductPreviewVerified,
  loadOrganizerEventMarketDeliveryOutbox,
  parseOrganizerEventMarketReference,
  publishMerchantOrganizerMembership,
  reconcileMerchantOrganizerCollectionEvidence,
  resolveOrganizerEventMarket,
  retryMerchantOrganizerRecord,
  saveOrganizerEventMarketDelivery,
  type MerchantOrganizerRecordDelivery,
} from "./event-market"

const acceptanceDependencies = {
  resolve: resolveOrganizerEventMarket,
  publish: publishMerchantOrganizerMembership,
  retry: retryMerchantOrganizerRecord,
  save: saveOrganizerEventMarketDelivery,
  load: loadOrganizerEventMarketDeliveryOutbox,
}

function needsExactRetry(record: MerchantOrganizerRecordDelivery): boolean {
  return record.acknowledgedCount === 0
}

function compareAddressableRevision(
  left: NonNullable<MerchantOrganizerRecordDelivery["signedEvent"]>,
  right: { createdAt: number; eventId: string }
): number {
  const rightCreatedAt = Math.floor(right.createdAt / 1_000)
  if (left.created_at !== rightCreatedAt) {
    return left.created_at - rightCreatedAt
  }
  // NIP-01 selects the lowest event id when timestamps tie.
  return right.eventId.localeCompare(left.id)
}

function newerSignedDelivery(
  left: MerchantOrganizerRecordDelivery,
  right: MerchantOrganizerRecordDelivery
): MerchantOrganizerRecordDelivery {
  const leftEvent = left.signedEvent
  const rightEvent = right.signedEvent
  if (!leftEvent) return right
  if (!rightEvent) return left
  return compareAddressableRevision(leftEvent, {
    createdAt: rightEvent.created_at * 1_000,
    eventId: rightEvent.id,
  }) >= 0
    ? left
    : right
}

/** A product signature requests participation; only a collection signature accepts it. */
export async function acceptOwnEventProduct(
  input: {
    merchantPubkey: string
    /** Active authenticated account; never inferred from the organizer. */
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
    marketReference: string
    productCoordinate: string
    signedAcceptance?: MerchantOrganizerRecordDelivery | null
    onSignedAcceptance?: (record: MerchantOrganizerRecordDelivery) => void
  },
  dependencies = acceptanceDependencies
): Promise<boolean> {
  const reference = parseOrganizerEventMarketReference(input.marketReference)
  const organizer = reference.coordinate.split(":")[1]
  if (organizer !== input.merchantPubkey) return false
  if (
    decodeProductReference(input.productCoordinate)?.authorPubkey !== organizer
  ) {
    throw new Error("Only your own product can be accepted automatically.")
  }
  const market = await dependencies.resolve(
    input.marketReference,
    organizer,
    input.authenticatedPubkey,
    undefined,
    input.shouldContinue
  )
  const item = market.participation.find(
    (candidate) => candidate.productCoordinate === input.productCoordinate
  )
  if (
    !["active", "partial"].includes(market.state) ||
    !item ||
    !isParticipationProductPreviewVerified(item) ||
    !isParticipationHandoffVerified(item, organizer)
  ) {
    throw new Error(
      "Product published. Acceptance needs current signed product and pickup evidence; retry acceptance or open My events."
    )
  }
  const savedDeliveries = dependencies.load(organizer)
  const savedCollection = savedDeliveries[reference.coordinate]?.find(
    (record) => record.record === "collection"
  )
  const retainedCollection =
    input.signedAcceptance && savedCollection
      ? newerSignedDelivery(input.signedAcceptance, savedCollection)
      : (input.signedAcceptance ?? savedCollection ?? null)
  const reconciledMarket = reconcileMerchantOrganizerCollectionEvidence(
    market,
    retainedCollection
  )
  const retainedEvent = retainedCollection?.signedEvent
  const currentCollection = market.source?.collection
  const retainedComparison = retainedEvent
    ? currentCollection
      ? compareAddressableRevision(retainedEvent, currentCollection)
      : 1
    : -1
  const retainedIsCurrent = retainedComparison >= 0
  const retryAcceptance =
    retainedCollection &&
    retainedIsCurrent &&
    (retainedCollection === input.signedAcceptance ||
      needsExactRetry(retainedCollection))
      ? retainedCollection
      : null

  const save = (record: MerchantOrganizerRecordDelivery) => {
    // Persist before delivery so retry can reuse the exact signed collection.
    dependencies.save(organizer, reference.coordinate, record)
    input.onSignedAcceptance?.(record)
  }
  let delivery: MerchantOrganizerRecordDelivery
  if (retryAcceptance) {
    const event = retryAcceptance.signedEvent
    if (
      !event ||
      event.kind !== 30405 ||
      event.pubkey !== organizer ||
      !event.tags.some(
        (tag) =>
          tag[0] === "d" &&
          `30405:${organizer}:${tag[1]}` === reference.coordinate
      ) ||
      !event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === input.productCoordinate
      ) ||
      !reconciledMarket.productCoordinates.includes(input.productCoordinate)
    ) {
      throw new Error(
        "The event collection changed. Review this product in My events before accepting again."
      )
    }
    delivery = await dependencies.retry({
      organizerPubkey: organizer,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      record: retryAcceptance,
    })
  } else if (
    reconciledMarket.productCoordinates.includes(input.productCoordinate)
  ) {
    return true
  } else {
    delivery = await dependencies.publish({
      organizerPubkey: organizer,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      market: reconciledMarket,
      item,
      action: "accept",
      retainedCollection,
      onSignedEvent: save,
    })
  }
  save(delivery)
  if (delivery.acknowledgedCount === 0) {
    throw new Error(
      "Product published. Acceptance is signed but not delivered yet; retry acceptance."
    )
  }
  return true
}
