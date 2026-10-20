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
  type MerchantStockCheckpointOutcome,
  type MerchantStockCheckpointFailure,
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

function checkpointFailureNotice(
  failure?: MerchantStockCheckpointFailure
): string {
  if (!failure) return ""
  const copy = {
    authorization_denied: "approval declined",
    timeout: "request timed out",
    unavailable: "unavailable",
    unsupported_operation: "operation unsupported",
    disconnected: "disconnected",
    authority_changed: "authority changed",
    invalid_response: "invalid response",
    identity_changed: "identity changed",
    background_paused: "background work paused",
    queue_full: "queue full",
    provider_unavailable: "provider unavailable",
  } as const
  try {
    const source = failure.source
    if (source === "signer" || source === "session") {
      const code = failure.code
      if (typeof code === "string" && Object.hasOwn(copy, code))
        return `${source === "signer" ? "Signer" : "Session"} report: ${copy[code]}.`
    }
  } catch {
    // A diagnostic cannot replace the stock action's existing notice.
  }
  return "No typed signer/session error code was available."
}

/** Fixed, transient UI copy only; coordinates are used solely for local scope. */
export function merchantStockCheckpointNotice(
  productCoordinates: readonly string[],
  outcomes: readonly MerchantStockCheckpointOutcome[]
): string {
  const products = new Set(productCoordinates)
  const scoped = new Map(
    outcomes
      .filter((outcome) => products.has(outcome.productCoordinate))
      .map((outcome) => [outcome.productCoordinate, outcome])
  )
  if (!scoped.size) return ""
  const pending = [...scoped.values()].filter(
    (outcome) => outcome.status !== "acknowledged"
  )
  if (pending.length) {
    const phases = new Set(pending.map((outcome) => outcome.phase))
    const copy = {
      snapshot:
        "Stock recovery checkpoint pending: local snapshot preparation.",
      wrapping: "Stock recovery checkpoint pending: private message wrapping.",
      delivery_ack: "Stock recovery checkpoint pending: inbox acknowledgement.",
      freshness: "Stock recovery checkpoint pending: current stock recheck.",
    } as const
    const phaseNotice =
      (Object.keys(copy) as (keyof typeof copy)[])
        .filter((phase) => phases.has(phase))
        .map((phase) => copy[phase])
        .join(" ") || "Stock recovery checkpoint status is not confirmed."
    return [
      phaseNotice,
      ...new Set(
        pending
          .map((outcome) => checkpointFailureNotice(outcome.failure))
          .filter(Boolean)
      ),
    ].join(" ")
  }
  return scoped.size === products.size
    ? "This Event's stock recovery checkpoints were acknowledged."
    : "Stock recovery checkpoint status is not confirmed for all current Event stock."
}

export function resumeMerchantOccurrencePublication(
  input: Session & {
    onStockCheckpoint?: (outcome: MerchantStockCheckpointOutcome) => void
  }
) {
  return resumeCoreOccurrencePublication({
    ...input,
    publishProduct: (event) => publishMerchantInventoryProduct(input, event),
  })
}
