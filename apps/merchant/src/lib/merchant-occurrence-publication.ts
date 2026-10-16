import { sameSignedPublicEvent } from "@conduit/core/protocol/verified-public-event"
import {
  commitLocalProductWrite,
  getProductListingDeliveryJobId,
  hasCommonAcknowledgedRelay,
  isProductListingEventReplayEligible,
  prepareProductListingDeliveryJob,
  readCurrentProductWriteRevision,
  resumeMerchantOccurrencePublication as resumeCoreOccurrencePublication,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { db } from "@conduit/core/db"
import {
  deliverQueuedProductListings,
  planCurrentProductListingRelayTargets,
} from "./product-listing-delivery"

type Session = {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
}

/** Retained acceptance bytes join the existing product writer and delivery owner. */
export async function publishMerchantInventoryProduct(
  input: Session,
  event: SignedPublicNostrEvent,
  dependencies = {
    plan: planCurrentProductListingRelayTargets,
    deliver: deliverQueuedProductListings,
  }
): Promise<boolean | "superseded"> {
  if (
    !input.shouldContinue() ||
    input.authenticatedPubkey !== input.merchantPubkey ||
    event.pubkey !== input.merchantPubkey
  )
    throw new Error("Merchant signer session changed")
  const d = event.tags.filter((tag) => tag[0] === "d")
  if (event.kind !== 30402 || d.length !== 1 || !d[0]?.[1])
    throw new Error("Inventory product projection is invalid")
  const coordinate = `30402:${event.pubkey}:${d[0][1]}`
  const inventory = await db.merchantInventoryProducts.get(coordinate)
  if (
    !inventory?.publicationJobs.some(
      (work) =>
        !!work.signedEvent && sameSignedPublicEvent(work.signedEvent, event)
    )
  )
    throw new Error("Exact retained inventory projection is unavailable")
  const id = getProductListingDeliveryJobId([event])
  let queued = await db.productListingOutbox.get(id)
  if (!queued) {
    const current = await readCurrentProductWriteRevision(coordinate)
    if (
      current.eventId !== event.id &&
      (current.eventCreatedAt ?? -1) >= event.created_at
    ) {
      const frontier = await db.localProductWriteFrontiers.get(coordinate)
      const ownIntent =
        frontier && (await db.localProductWriteIntents.get(frontier.intentId))
      if (
        ownIntent &&
        ownIntent.merchantPubkey === input.merchantPubkey &&
        (inventory.sourceProductEvent.id === current.eventId ||
          inventory.publicationJobs.some(
            (work) => work.signedEvent?.id === current.eventId
          ))
      )
        return "superseded"
      throw new Error("A newer product revision needs inventory reconciliation")
    }
    const relayTargets = await dependencies.plan(
      input.merchantPubkey,
      input.authenticatedPubkey,
      input.shouldContinue
    )
    queued = prepareProductListingDeliveryJob({
      merchantPubkey: input.merchantPubkey,
      signedEvents: [event],
      relayTargets,
      readyForDelivery: false,
    })
    const priorJobs = await db.productListingOutbox
      .where("merchantPubkey")
      .equals(input.merchantPubkey)
      .toArray()
    const retainedIds = new Set(
      inventory.publicationJobs.flatMap((work) =>
        work.signedEvent ? [work.signedEvent.id] : []
      )
    )
    const reconcileListingJobIds = priorJobs
      .filter(
        (job) =>
          job.signedEvents.length === 1 &&
          retainedIds.has(job.signedEvents[0]!.id) &&
          job.signedEvents[0]!.created_at < event.created_at &&
          !job.companionDeletionJobId &&
          !job.prerequisiteShippingEventIds?.length
      )
      .map((job) => job.id)
    await commitLocalProductWrite({
      reconcileListingJobIds,
      intentId: `inventory-product:${event.id}`,
      merchantPubkey: input.merchantPubkey,
      expectedRevisions: [{ addressId: coordinate, eventId: current.eventId }],
      listingJob: queued,
      shouldContinue: input.shouldContinue,
    })
  }
  if (!isProductListingEventReplayEligible(queued, event.id))
    return "superseded"
  await dependencies.deliver(id, {
    authenticatedPubkey: input.authenticatedPubkey,
    isAuthenticatedPubkeyCurrent: () => input.shouldContinue(),
    shouldContinue: input.shouldContinue,
    expectedSignedEvents: [event],
  })
  const delivered = await db.productListingOutbox.get(id)
  if (!delivered)
    throw new Error("Queued inventory product projection is unavailable")
  if (!isProductListingEventReplayEligible(delivered, event.id))
    return "superseded"
  return hasCommonAcknowledgedRelay(delivered)
}

export function resumeMerchantOccurrencePublication(input: Session) {
  return resumeCoreOccurrencePublication({
    ...input,
    publishProduct: (event) => publishMerchantInventoryProduct(input, event),
  })
}
