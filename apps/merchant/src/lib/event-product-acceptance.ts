import { decodeProductReference } from "@conduit/core"
import {
  isParticipationHandoffVerified,
  isParticipationProductPreviewVerified,
  parseOrganizerEventMarketReference,
  publishMerchantOrganizerMembership,
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
}

/** A product signature requests participation; only a collection signature accepts it. */
export async function acceptOwnEventProduct(
  input: {
    merchantPubkey: string
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
    organizer
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
  if (item.status === "accepted") return true

  const save = (record: MerchantOrganizerRecordDelivery) => {
    // Persist before delivery so retry can reuse the exact signed collection.
    dependencies.save(organizer, reference.coordinate, record)
    input.onSignedAcceptance?.(record)
  }
  let delivery: MerchantOrganizerRecordDelivery
  if (input.signedAcceptance) {
    const event = input.signedAcceptance.signedEvent
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
      (market.collectionCreatedAt ?? 0) > event.created_at * 1_000
    ) {
      throw new Error(
        "The event collection changed. Review this product in My events before accepting again."
      )
    }
    delivery = await dependencies.retry({
      organizerPubkey: organizer,
      record: input.signedAcceptance,
    })
  } else {
    delivery = await dependencies.publish({
      organizerPubkey: organizer,
      market,
      item,
      action: "accept",
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
