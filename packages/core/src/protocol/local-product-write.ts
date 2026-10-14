import {
  db,
  type CachedProduct,
  type CachedProductTombstone,
  type LocalProductShippingJob,
  type LocalProductStockCheckpoint,
  type LocalProductWriteFrontier,
  type LocalProductWriteIntent,
  type ProductDeletionDeliveryJob,
  type ProductListingDeliveryJob,
} from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  projectSignedProductDeletionForLocalCommit,
  projectSignedProductListingForLocalCommit,
} from "./commerce"
import {
  withLocalProductCoordinateLocks,
  readCurrentProductWriteRevision,
} from "./local-product-coordinate-lock"
export {
  readCurrentProductWriteRevision,
  withLocalProductCoordinateLocks,
} from "./local-product-coordinate-lock"
import {
  getProductListingDeliveryJobId,
  hasCommonAcknowledgedRelay,
  isProductListingEventReplayEligible,
  isTerminalRecoverableProductListingJob,
} from "./product-listing-delivery"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  admitPublicEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"

async function admitLocalProductWriteEvent(
  event: SignedPublicNostrEvent
): Promise<VerifiedNostrEvent> {
  const admission = await admitPublicEvent(event)
  if (admission.status !== "verified") {
    throw new Error("Local product write verification " + admission.status)
  }
  return admission.event
}

export interface LocalProductWriteExpectedRevision {
  addressId: string
  /** Null only for a coordinate with no known locally signed revision. */
  eventId: string | null
}

export interface LocalProductWriteStockInput {
  orderId: string
  adjustment: LocalProductStockCheckpoint["adjustment"]
  /** Only a terminally rejected local revision may be re-signed. */
  replacesSignedEventId?: string
}

/** Prepared, exact signed bytes. This function never signs or touches a relay. */
export interface LocalProductWriteCommitInput {
  intentId: string
  merchantPubkey: string
  expectedRevisions: readonly LocalProductWriteExpectedRevision[]
  /** Unchanged captured family members that must still match at local commit. */
  additionalExpectedRevisions?: readonly LocalProductWriteExpectedRevision[]
  listingJob?: ProductListingDeliveryJob
  deletionJob?: ProductDeletionDeliveryJob
  shippingJobs?: readonly LocalProductShippingJob[]
  stock?: LocalProductWriteStockInput
  /** Explicitly reconcile unfinished listing-only deliveries on affected coordinates. */
  reconcileListingJobIds?: readonly string[]
  /** Recheck the pinned account session after waiting for local coordination. */
  shouldContinue?: () => boolean
  now?: () => number
}

export type LocalLegacyProductWriteRecovery =
  | { kind: "mixed_deletion"; previousDeletionEventId: string }
  | { kind: "listing_republish"; previousListingJobId: string }
  | { kind: "stock_republish"; previousStockEventId: string }

export interface LocalLegacyProductWriteStageInput {
  merchantPubkey: string
  expectedRevisions: readonly LocalProductWriteExpectedRevision[]
  signedListings: readonly SignedPublicNostrEvent[]
  signedDeletion?: SignedPublicNostrEvent
  recovery: LocalLegacyProductWriteRecovery
  shouldContinue?: () => boolean
}

function productAddressId(event: SignedPublicNostrEvent): string {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== EVENT_KINDS.PRODUCT
  ) {
    throw new Error("Product write requires an exact signed listing")
  }
  const dTags = event.tags.filter(([name]) => name === "d")
  const dTag = dTags.length === 1 ? dTags[0]?.[1] : undefined
  if (!dTag) throw new Error("Signed product coordinate is missing")
  return `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${dTag}`
}

function shippingAddressId(event: SignedPublicNostrEvent): string {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== EVENT_KINDS.SHIPPING_OPTION
  ) {
    throw new Error("Shipping prerequisite requires an exact signed option")
  }
  const dTags = event.tags.filter(([name]) => name === "d")
  const dTag = dTags.length === 1 ? dTags[0]?.[1] : undefined
  if (!dTag) throw new Error("Signed shipping coordinate is missing")
  return `${EVENT_KINDS.SHIPPING_OPTION}:${event.pubkey}:${dTag}`
}

function assertExactSet(
  actual: readonly string[],
  expected: readonly string[]
): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((value) => !expected.includes(value))
  ) {
    throw new Error("Signed product-write coordinates changed")
  }
}

function assertedExpectedRevisions(
  revisions: readonly LocalProductWriteExpectedRevision[],
  merchantPubkey: string
): Map<string, string | null> {
  const expected = new Map<string, string | null>()
  for (const revision of revisions) {
    if (
      !revision.addressId.startsWith(
        `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:`
      ) ||
      revision.addressId.length <=
        `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:`.length ||
      expected.has(revision.addressId) ||
      (revision.eventId !== null && !/^[0-9a-f]{64}$/.test(revision.eventId))
    ) {
      throw new Error("Expected product-write revision is invalid")
    }
    expected.set(revision.addressId, revision.eventId)
  }
  if (expected.size === 0) throw new Error("No product coordinates to commit")
  return expected
}

function isExactNewerListingSuccessor(
  previous: ProductListingDeliveryJob,
  successor: ProductListingDeliveryJob
): boolean {
  if (
    previous.id === successor.id ||
    previous.merchantPubkey !== successor.merchantPubkey ||
    previous.companionDeletionJobId ||
    successor.companionDeletionJobId ||
    (previous.prerequisiteShippingEventIds?.length ?? 0) > 0 ||
    (successor.prerequisiteShippingEventIds?.length ?? 0) > 0 ||
    successor.replacesRejectedListingJobId !== previous.id ||
    previous.signedEvents.length !== successor.signedEvents.length
  ) {
    return false
  }
  try {
    if (
      previous.id !== getProductListingDeliveryJobId(previous.signedEvents) ||
      successor.id !== getProductListingDeliveryJobId(successor.signedEvents)
    ) {
      return false
    }
    const previousByAddress = new Map<string, SignedPublicNostrEvent>()
    for (const event of previous.signedEvents) {
      if (
        event.pubkey !== previous.merchantPubkey ||
        !isValidSignedPublicNostrEvent(event)
      ) {
        return false
      }
      previousByAddress.set(productAddressId(event), event)
    }
    if (previousByAddress.size !== previous.signedEvents.length) return false
    const nextAddresses = new Set<string>()
    for (const event of successor.signedEvents) {
      if (
        event.pubkey !== successor.merchantPubkey ||
        !isValidSignedPublicNostrEvent(event)
      ) {
        return false
      }
      const addressId = productAddressId(event)
      const source = previousByAddress.get(addressId)
      if (
        !source ||
        nextAddresses.has(addressId) ||
        event.created_at <= source.created_at
      ) {
        return false
      }
      nextAddresses.add(addressId)
    }
    return nextAddresses.size === previousByAddress.size
  } catch {
    return false
  }
}

function getExactRejectedListingSuccessors(
  job: ProductListingDeliveryJob,
  byId: ReadonlyMap<string, ProductListingDeliveryJob>
): ProductListingDeliveryJob[] {
  const descendants: ProductListingDeliveryJob[] = []
  const seen = new Set([job.id])
  let current = job
  while (current.replacedByListingJobId) {
    const successor = byId.get(current.replacedByListingJobId)
    if (
      !successor ||
      seen.has(successor.id) ||
      successor.readyForDelivery !== true ||
      !isExactNewerListingSuccessor(current, successor)
    ) {
      break
    }
    descendants.push(successor)
    seen.add(successor.id)
    current = successor
  }
  return descendants
}

function isExactRejectedRecoveryAncestor(
  job: ProductListingDeliveryJob,
  successorId: string | undefined,
  byId: ReadonlyMap<string, ProductListingDeliveryJob>
): boolean {
  return (
    !!successorId &&
    (isTerminalRecoverableProductListingJob(job) ||
      (job.state === "delivered" &&
        job.replacedByListingJobId !== undefined)) &&
    getExactRejectedListingSuccessors(job, byId).some(
      (successor) => successor.id === successorId
    )
  )
}

function exactListingRecoveryLineage(
  previous: ProductListingDeliveryJob,
  listings: readonly ProductListingDeliveryJob[],
  byId: ReadonlyMap<string, ProductListingDeliveryJob>
): ProductListingDeliveryJob[] | null {
  if (previous.replacesRejectedListingJobId) {
    const source = byId.get(previous.replacesRejectedListingJobId)
    if (
      !source ||
      !getExactRejectedListingSuccessors(source, byId).some(
        (successor) => successor.id === previous.id
      )
    ) {
      return null
    }
  }
  return [
    previous,
    ...listings.filter(
      (ancestor) =>
        ancestor.id !== previous.id &&
        ancestor.merchantPubkey === previous.merchantPubkey &&
        getExactRejectedListingSuccessors(ancestor, byId).some(
          (successor) => successor.id === previous.id
        )
    ),
  ]
}

/**
 * An exact failed listing can be deliberately re-signed onto the current plan.
 * Historical relay targets remain evidence, not required convergence coverage.
 * A delivered tip uses ordinary editing instead of a special recovery action.
 */
export function requiredProductListingRecoveryRelayUrls(
  previousId: string,
  listings: readonly ProductListingDeliveryJob[]
): string[] | null {
  const byId = new Map(listings.map((job) => [job.id, job]))
  const previous = byId.get(previousId)
  if (
    byId.size !== listings.length ||
    !previous ||
    previous.replacedByListingJobId !== undefined ||
    previous.companionDeletionJobId !== undefined ||
    (previous.prerequisiteShippingEventIds?.length ?? 0) > 0 ||
    !isTerminalRecoverableProductListingJob(previous) ||
    previous.signedEvents.some(
      (event) => !isProductListingEventReplayEligible(previous, event.id)
    ) ||
    !exactListingRecoveryLineage(previous, listings, byId)
  )
    return null
  return []
}

/** A read-side guard only; the signed stage rechecks these facts atomically. */
async function isCurrentExactListingRecovery(
  previous: ProductListingDeliveryJob,
  listings: readonly ProductListingDeliveryJob[]
): Promise<boolean> {
  const byId = new Map(listings.map((job) => [job.id, job]))
  const lineage = [
    previous,
    ...listings.filter(
      (job) =>
        job.id !== previous.id &&
        getExactRejectedListingSuccessors(job, byId).some(
          (successor) => successor.id === previous.id
        )
    ),
  ]
  try {
    const addresses = new Set<string>()
    for (const event of previous.signedEvents) {
      const addressId = productAddressId(event)
      if (
        event.pubkey !== previous.merchantPubkey ||
        addresses.has(addressId)
      ) {
        return false
      }
      addresses.add(addressId)
      const [current, exactTombstone, pendingStock] = await Promise.all([
        readCurrentProductWriteRevision(addressId),
        db.productTombstones.get(`e:${previous.merchantPubkey}:${event.id}`),
        db.localProductStockCheckpoints
          .where("productAddressId")
          .equals(addressId)
          .filter((checkpoint) => checkpoint.state === "pending")
          .first(),
      ])
      if (
        current.eventId !== event.id ||
        event.created_at <= current.deletionCreatedAt ||
        exactTombstone ||
        pendingStock
      ) {
        return false
      }
    }
    for (const job of lineage) {
      if (
        job.companionDeletionJobId !== undefined ||
        (job.prerequisiteShippingEventIds?.length ?? 0) > 0
      ) {
        return false
      }
      for (const event of job.signedEvents) {
        const checkpoint = await db.localProductStockCheckpoints
          .where("productAddressId")
          .equals(productAddressId(event))
          .filter((item) => item.signedEventId === event.id)
          .first()
        if (checkpoint) return false
      }
    }
    const deletions = await db.productDeletionOutbox.toArray()
    return !deletions.some(
      (job) =>
        job.signedEvent.pubkey === previous.merchantPubkey &&
        job.state !== "delivered" &&
        job.state !== "superseded_unpublished" &&
        job.signedEvent.tags.some(
          ([name, value]) => name === "a" && addresses.has(value)
        )
    )
  } catch {
    return false
  }
}

export async function getRequiredProductListingRecoveryRelayUrls(
  previousId: string
): Promise<string[]> {
  const previous = await db.productListingOutbox.get(previousId)
  if (!previous) throw new Error("Rejected product recovery is not exact")
  const listings = await db.productListingOutbox
    .where("merchantPubkey")
    .equals(previous.merchantPubkey)
    .toArray()
  const required = requiredProductListingRecoveryRelayUrls(previousId, listings)
  if (
    required === null ||
    !(await isCurrentExactListingRecovery(previous, listings))
  ) {
    throw new Error("Rejected product recovery is not exact")
  }
  return required
}

/**
 * Re-arm one explicitly signed rejected-listing successor only while its
 * predecessor link, exact local projection, and replay authority commit together.
 * Startup must use this path too; ordinary listing readiness may not arm it.
 */
export async function armRecoveredProductListingDelivery(
  previousId: string,
  successorId: string,
  shouldContinue?: () => boolean
): Promise<void> {
  const previous = await db.productListingOutbox.get(previousId)
  if (!previous) throw new Error("Rejected product recovery is not exact")
  await withLocalProductCoordinateLocks(
    previous.signedEvents.map(productAddressId),
    () =>
      armRecoveredProductListingDeliveryUnlocked(
        previousId,
        successorId,
        shouldContinue
      )
  )
}

async function armRecoveredProductListingDeliveryUnlocked(
  previousId: string,
  successorId: string,
  shouldContinue?: () => boolean
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.productListingOutbox,
      db.productDeletionOutbox,
      db.localProductWriteIntents,
      db.localProductWriteFrontiers,
      db.products,
      db.productTombstones,
      db.localProductStockCheckpoints,
    ],
    async () => {
      const [previous, successor] = await Promise.all([
        db.productListingOutbox.get(previousId),
        db.productListingOutbox.get(successorId),
      ])
      if (
        !previous ||
        !successor ||
        successor.signedEvents.some(
          (event) => !isProductListingEventReplayEligible(successor, event.id)
        ) ||
        (!isTerminalRecoverableProductListingJob(previous) &&
          !(
            previous.state === "delivered" &&
            hasCommonAcknowledgedRelay(previous)
          )) ||
        !isExactNewerListingSuccessor(previous, successor) ||
        (previous.replacedByListingJobId !== undefined &&
          previous.replacedByListingJobId !== successorId)
      ) {
        throw new Error("Rejected product successor is not ready")
      }
      const alreadyArmed =
        previous.replacedByListingJobId === successorId &&
        successor.readyForDelivery === true
      if (
        !alreadyArmed &&
        (successor.readyForDelivery !== false ||
          successor.state !== "pending" ||
          successor.deliveryAttemptCount !== 0 ||
          successor.relayDelivery.some(
            (delivery) =>
              delivery.status !== "pending" || delivery.attemptCount !== 0
          ))
      ) {
        throw new Error("Rejected product successor is not staged")
      }
      const listings = await db.productListingOutbox
        .where("merchantPubkey")
        .equals(previous.merchantPubkey)
        .toArray()
      const requiredRelays = requiredProductListingRecoveryRelayUrls(
        previousId,
        listings
      )
      const lineage = exactListingRecoveryLineage(
        previous,
        listings,
        new Map(listings.map((job) => [job.id, job]))
      )
      if (
        !alreadyArmed &&
        (!lineage ||
          // A predecessor may acquire a late common ACK after this exact
          // successor was staged. It can still be linked atomically.
          (requiredRelays === null && previous.state !== "delivered"))
      ) {
        throw new Error("Rejected product recovery source changed")
      }
      for (const event of previous.signedEvents) {
        const addressId = productAddressId(event)
        const current = await readCurrentProductWriteRevision(addressId)
        const replacement = successor.signedEvents.find(
          (candidate) => productAddressId(candidate) === addressId
        )
        const exactTombstone = replacement
          ? await db.productTombstones.get(
              `e:${previous.merchantPubkey}:${replacement.id}`
            )
          : undefined
        const stockCheckpoint = await db.localProductStockCheckpoints
          .where("productAddressId")
          .equals(addressId)
          .filter((checkpoint) => checkpoint.signedEventId === event.id)
          .first()
        if (
          !replacement ||
          current.eventId !== replacement.id ||
          replacement.created_at <= current.deletionCreatedAt ||
          exactTombstone ||
          stockCheckpoint
        ) {
          throw new Error("Rejected product successor is not current")
        }
      }
      if (shouldContinue?.() === false)
        throw new Error("Product write account session changed")
      const sourceRevisions = previous.signedEvents.map((event) => ({
        addressId: productAddressId(event),
        eventId: event.id,
      }))
      const intent: LocalProductWriteIntent = {
        id: `listing-recovery:${successor.id}`,
        merchantPubkey: successor.merchantPubkey,
        productAddressIds: sourceRevisions.map(
          (revision) => revision.addressId
        ),
        sourceRevisions,
        listingJobId: successor.id,
        shippingEventIds: [],
        committedAt: Date.now(),
      }
      const frontiers = successor.signedEvents.map((event) => ({
        id: productAddressId(event),
        merchantPubkey: successor.merchantPubkey,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        intentId: intent.id,
      }))
      const expected = new Map(
        sourceRevisions.map((revision) => [
          revision.addressId,
          revision.eventId,
        ])
      )
      await supersedePriorListingReplay({
        intent,
        listings: listings.filter((job) => job.id !== successor.id),
        frontiers,
        tombstones: [],
        expected,
        reconcileListingJobIds: new Set(
          (lineage ?? [previous]).map((job) => job.id)
        ),
        allowedStockListingJobIds: new Set(),
      })
      await assertNoConflictingProductDeliveryJobs({
        merchantPubkey: successor.merchantPubkey,
        expected,
        allowedListingJobIds: new Set([successor.id]),
      })
      if (shouldContinue?.() === false)
        throw new Error("Product write account session changed")
      if (!(await db.localProductWriteIntents.get(intent.id))) {
        await db.localProductWriteIntents.add(intent)
        for (const frontier of frontiers)
          await putProductWriteFrontier(frontier)
      }
      await db.productListingOutbox.update(previousId, {
        replacedByListingJobId: successorId,
      })
      await db.productListingOutbox.update(successorId, {
        readyForDelivery: true,
        updatedAt: Date.now(),
      })
    }
  )
}

async function assertNoPendingLocalStockCheckpoint(
  addressId: string
): Promise<void> {
  const unresolvedStock = await db.localProductStockCheckpoints
    .where("productAddressId")
    .equals(addressId)
    .filter((checkpoint) => checkpoint.state === "pending")
    .first()
  if (unresolvedStock) {
    throw new Error(
      "A signed stock checkpoint must settle before this product changes"
    )
  }
}

async function putProductWriteFrontier(
  frontier: LocalProductWriteFrontier
): Promise<void> {
  const previous = await db.localProductWriteFrontiers.get(frontier.id)
  await db.localProductWriteFrontiers.put({
    ...frontier,
    ...(previous?.deletionCreatedAt !== undefined
      ? {
          deletionCreatedAt: previous.deletionCreatedAt,
          deletionEventId: previous.deletionEventId,
        }
      : {}),
  })
}

async function assertNoConflictingProductDeliveryJobs(input: {
  merchantPubkey: string
  expected: ReadonlyMap<string, string | null>
  allowedListingJobIds?: ReadonlySet<string>
  allowedDeletionJobIds?: ReadonlySet<string>
  /** Explicit rejected-listing recovery may stage past its verified ancestors. */
  allowedRecoveryPredecessorJobId?: string
}): Promise<void> {
  const listings = await db.productListingOutbox
    .where("merchantPubkey")
    .equals(input.merchantPubkey)
    .toArray()
  const listingsById = new Map(listings.map((job) => [job.id, job]))
  if (
    listings.some(
      (job) =>
        job.state !== "superseded_unpublished" &&
        !input.allowedListingJobIds?.has(job.id) &&
        job.signedEvents.some(
          (event) =>
            input.expected.has(productAddressId(event)) &&
            isProductListingEventReplayEligible(job, event.id)
        ) &&
        (job.state !== "delivered" ||
          (job.replacedByListingJobId !== undefined &&
            getExactRejectedListingSuccessors(job, listingsById).length > 0)) &&
        !isExactRejectedRecoveryAncestor(
          job,
          input.allowedRecoveryPredecessorJobId,
          listingsById
        )
    )
  ) {
    throw new Error(
      "A prior signed product delivery still needs reconciliation"
    )
  }
  const deletions = await db.productDeletionOutbox.toArray()
  if (
    deletions.some(
      (job) =>
        job.state !== "delivered" &&
        job.state !== "superseded_unpublished" &&
        !input.allowedDeletionJobIds?.has(job.id) &&
        job.signedEvent.pubkey === input.merchantPubkey &&
        job.signedEvent.tags.some(
          ([name, value]) => name === "a" && input.expected.has(value)
        )
    )
  ) {
    throw new Error("A prior signed deletion still needs reconciliation")
  }
}

/**
 * Explicitly retire an unattempted listing-only stage when exact signed
 * replacements are already the selected local revisions. Paired deletions
 * retain their original delivery and source-relay authority for manual repair.
 * No signer or relay I/O is allowed.
 */
export async function retireSupersededStagedProductWrite(input: {
  listingJobId: string
  winningSignedEvents: readonly SignedPublicNostrEvent[]
  now?: () => number
  shouldContinue?: () => boolean
}): Promise<void> {
  if (input.shouldContinue?.() === false) {
    throw new Error("Product repair account session changed")
  }
  const staged = await db.productListingOutbox.get(input.listingJobId)
  if (!staged) throw new Error("Staged product delivery was not found")
  if (staged.companionDeletionJobId) {
    throw new Error("Paired product deletion needs manual reconciliation")
  }
  const coordinates = staged.signedEvents.map(productAddressId)
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("Staged product coordinates are ambiguous")
  }
  await withLocalProductCoordinateLocks(coordinates, () =>
    db.transaction(
      "rw",
      [
        db.productListingOutbox,
        db.productDeletionOutbox,
        db.localProductWriteIntents,
        db.localProductWriteFrontiers,
        db.localProductStockCheckpoints,
        db.products,
        db.productTombstones,
      ],
      async () => {
        const current = await db.productListingOutbox.get(input.listingJobId)
        if (
          !current ||
          current.merchantPubkey !== staged.merchantPubkey ||
          current.id !== getProductListingDeliveryJobId(current.signedEvents) ||
          JSON.stringify(current.signedEvents) !==
            JSON.stringify(staged.signedEvents) ||
          current.state !== "pending" ||
          current.readyForDelivery !== false ||
          current.deliveryAttemptCount !== 0 ||
          current.lastAttemptAt !== undefined ||
          current.companionDeletionJobId !== undefined ||
          current.relayTargets.length === 0 ||
          current.relayDelivery.length !==
            current.signedEvents.length * current.relayTargets.length ||
          new Set(
            current.relayDelivery.map(
              (delivery) => `${delivery.eventId}\u0000${delivery.relayUrl}`
            )
          ).size !== current.relayDelivery.length ||
          current.relayDelivery.some(
            (delivery) =>
              delivery.status !== "pending" ||
              delivery.attemptCount !== 0 ||
              delivery.lastAttemptAt !== undefined ||
              !current.signedEvents.some(
                (event) => event.id === delivery.eventId
              ) ||
              !current.relayTargets.some(
                (target) => target.relayUrl === delivery.relayUrl
              )
          )
        ) {
          throw new Error("Staged product delivery is not safely unpublished")
        }
        if (
          await db.productDeletionOutbox
            .filter((job) => job.companionListingJobId === current.id)
            .first()
        ) {
          throw new Error("Paired product deletion needs manual reconciliation")
        }
        assertExactSet(current.signedEvents.map(productAddressId), coordinates)
        const intents = await db.localProductWriteIntents
          .filter((intent) => intent.listingJobId === current.id)
          .toArray()
        if (
          intents.length > 1 ||
          intents.some(
            (intent) =>
              intent.merchantPubkey !== current.merchantPubkey ||
              intent.deletionJobId !== undefined ||
              intent.stockCheckpointId !== undefined ||
              intent.shippingEventIds.length > 0
          ) ||
          (current.prerequisiteShippingEventIds?.length ?? 0) > 0
        ) {
          throw new Error(
            "Staged product prerequisites need manual reconciliation"
          )
        }
        const winners = new Map<string, SignedPublicNostrEvent>()
        for (const event of input.winningSignedEvents) {
          const addressId = productAddressId(event)
          if (winners.has(addressId)) {
            throw new Error("Winning product revisions are ambiguous")
          }
          winners.set(addressId, event)
        }
        assertExactSet([...winners.keys()], coordinates)
        const acknowledgedReplacements = await db.productListingOutbox
          .where("merchantPubkey")
          .equals(current.merchantPubkey)
          .filter(
            (job) =>
              job.state === "delivered" && hasCommonAcknowledgedRelay(job)
          )
          .toArray()
        const losingByAddress = new Map(
          current.signedEvents.map((event) => [productAddressId(event), event])
        )
        for (const addressId of coordinates) {
          const losing = losingByAddress.get(addressId)
          const winner = winners.get(addressId)!
          if (
            !acknowledgedReplacements.some((job) =>
              job.signedEvents.some(
                (event) =>
                  event.id === winner.id &&
                  event.sig === winner.sig &&
                  isValidSignedPublicNostrEvent(event)
              )
            )
          ) {
            throw new Error("No acknowledged signed replacement is saved")
          }
          const selected = await readCurrentProductWriteRevision(addressId)
          const cached = await db.products.get(addressId)
          const exactTombstone = await db.productTombstones.get(
            `e:${current.merchantPubkey}:${winner.id}`
          )
          if (
            winner.pubkey !== current.merchantPubkey ||
            selected.eventId !== winner.id ||
            selected.eventCreatedAt !== winner.created_at ||
            cached?.eventId !== winner.id ||
            cached.eventCreatedAt !== winner.created_at ||
            exactTombstone !== undefined ||
            winner.created_at <= selected.deletionCreatedAt ||
            (losing &&
              (winner.created_at < losing.created_at ||
                (winner.created_at === losing.created_at &&
                  winner.id >= losing.id)))
          ) {
            throw new Error(
              "Signed replacement is not the selected product revision"
            )
          }
          await assertNoPendingLocalStockCheckpoint(addressId)
        }
        if (input.shouldContinue?.() === false) {
          throw new Error("Product repair account session changed")
        }
        await db.productListingOutbox.put({
          ...current,
          state: "superseded_unpublished",
          updatedAt: input.now?.() ?? Date.now(),
        })
      }
    )
  )
}

/**
 * Products' explicit repair action. A locally delivered exact signed family is
 * the only available durable source of replacement bytes; a cache projection
 * by itself is never treated as sufficient evidence to retire an old stage.
 */
export async function retireSupersededStagedProductWriteFromLocalEvidence(input: {
  merchantPubkey: string
  listingJobId: string
  now?: () => number
  shouldContinue?: () => boolean
}): Promise<void> {
  if (input.shouldContinue?.() === false) {
    throw new Error("Product repair account session changed")
  }
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  const staged = await db.productListingOutbox.get(input.listingJobId)
  if (!staged || staged.merchantPubkey !== merchantPubkey) {
    throw new Error("Staged product delivery was not found for this merchant")
  }
  if (staged.companionDeletionJobId) {
    throw new Error("Paired product deletion needs manual reconciliation")
  }
  const coordinates = staged.signedEvents.map(productAddressId)
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("Staged product coordinates are ambiguous")
  }
  const deliveredJobs = await db.productListingOutbox
    .where("merchantPubkey")
    .equals(merchantPubkey)
    .filter(
      (job) => job.state === "delivered" && hasCommonAcknowledgedRelay(job)
    )
    .toArray()
  const winningSignedEvents: SignedPublicNostrEvent[] = []
  for (const addressId of coordinates) {
    const selected = await db.products.get(addressId)
    const winner = deliveredJobs
      .flatMap((job) => job.signedEvents)
      .find((event) => event.id === selected?.eventId)
    if (!winner) {
      throw new Error("No delivered signed replacement is available locally")
    }
    winningSignedEvents.push(winner)
  }
  await retireSupersededStagedProductWrite({
    listingJobId: staged.id,
    winningSignedEvents,
    now: input.now,
    shouldContinue: input.shouldContinue,
  })
}

/**
 * Bridge an older exact-byte recovery into the same coordinate authority as
 * the atomic writer. The caller must already hold the per-merchant stock lock;
 * stage may do local persistence only, never signer or relay I/O.
 */
export async function withLocalLegacyProductWriteStage<T>(
  input: LocalLegacyProductWriteStageInput,
  stage: () => Promise<T>
): Promise<T> {
  // Admission may wait before taking coordinate locks; retain the captured
  // recovery authority and exact bytes across that wait.
  input = {
    ...input,
    expectedRevisions: structuredClone(input.expectedRevisions),
    signedListings: structuredClone(input.signedListings),
    signedDeletion: structuredClone(input.signedDeletion),
    recovery: structuredClone(input.recovery),
  }
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  const expected = assertedExpectedRevisions(
    input.expectedRevisions,
    merchantPubkey
  )
  const listingCoordinates = input.signedListings.map((event) => {
    if (event.pubkey !== merchantPubkey) {
      throw new Error("Signed listing author does not match the merchant")
    }
    return productAddressId(event)
  })
  const deletion = input.signedDeletion
  const deletionCoordinates = deletion
    ? projectSignedProductDeletionForLocalCommit(
        await admitLocalProductWriteEvent(deletion)
      )
        .map((row) => row.addressId)
        .filter((addressId): addressId is string => !!addressId)
    : []
  if (deletion && deletion.pubkey !== merchantPubkey) {
    throw new Error("Signed deletion author does not match the merchant")
  }
  assertExactSet(
    [...new Set([...listingCoordinates, ...deletionCoordinates])],
    [...expected.keys()]
  )
  if (
    listingCoordinates.some((addressId) =>
      deletionCoordinates.includes(addressId)
    )
  ) {
    throw new Error("A product cannot be listed and address-deleted together")
  }

  return withLocalProductCoordinateLocks([...expected.keys()], async () => {
    if (input.shouldContinue?.() === false)
      throw new Error("Product write account session changed")
    let allowedListingJobId: string
    let allowedDeletionJobId: string | undefined
    if (input.recovery.kind === "mixed_deletion") {
      const oldDeletion = await db.productDeletionOutbox.get(
        input.recovery.previousDeletionEventId
      )
      const oldListing = oldDeletion?.companionListingJobId
        ? await db.productListingOutbox.get(oldDeletion.companionListingJobId)
        : undefined
      const oldTargets = oldDeletion?.signedEvent.tags.filter(
        ([name]) => name === "e" || name === "a"
      )
      const newTargets = deletion?.tags.filter(
        ([name]) => name === "e" || name === "a"
      )
      if (
        !oldDeletion ||
        !oldListing ||
        !deletion ||
        !isValidSignedPublicNostrEvent(deletion) ||
        oldDeletion.signedEvent.pubkey !== merchantPubkey ||
        oldDeletion.signedEvent.id !== oldDeletion.id ||
        oldDeletion.state !== "pending" ||
        oldDeletion.deliveryAttemptCount !== 0 ||
        oldDeletion.relayDelivery.some(
          (delivery) =>
            delivery.status !== "pending" || delivery.attemptCount !== 0
        ) ||
        oldListing.merchantPubkey !== merchantPubkey ||
        oldListing.companionDeletionJobId !== oldDeletion.id ||
        !isTerminalRecoverableProductListingJob(oldListing) ||
        deletion.created_at !== oldDeletion.signedEvent.created_at ||
        JSON.stringify(newTargets) !== JSON.stringify(oldTargets) ||
        !deletion.tags.some(
          ([name, eventId]) =>
            name === "conduit_recovery_attempt" && eventId === oldDeletion.id
        )
      ) {
        throw new Error("Rejected mixed product recovery changed")
      }
      assertExactSet(
        listingCoordinates,
        oldListing.signedEvents.map(productAddressId)
      )
      if (
        oldListing.signedEvents.some(
          (event) => expected.get(productAddressId(event)) !== event.id
        )
      ) {
        throw new Error("Rejected mixed product revision is no longer current")
      }
      assertExactSet(
        oldDeletion.signedEvent.tags
          .filter(([name]) => name === "e")
          .map(([, eventId]) => eventId),
        deletionCoordinates
          .map((addressId) => expected.get(addressId))
          .filter((eventId): eventId is string => !!eventId)
      )
      allowedListingJobId = oldListing.id
      allowedDeletionJobId = oldDeletion.id
    } else if (input.recovery.kind === "listing_republish") {
      const previousListingJobId = input.recovery.previousListingJobId
      const existingListings = await db.productListingOutbox
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray()
      const oldListing = existingListings.find(
        (job) => job.id === previousListingJobId
      )
      const requiredRelays = requiredProductListingRecoveryRelayUrls(
        previousListingJobId,
        existingListings
      )
      if (
        deletion ||
        !oldListing ||
        oldListing.merchantPubkey !== merchantPubkey ||
        oldListing.companionDeletionJobId !== undefined ||
        (oldListing.prerequisiteShippingEventIds?.length ?? 0) > 0 ||
        requiredRelays === null
      ) {
        throw new Error("Rejected product recovery is not exact")
      }
      assertExactSet(
        listingCoordinates,
        oldListing.signedEvents.map(productAddressId)
      )
      if (
        oldListing.signedEvents.some(
          (event) => expected.get(productAddressId(event)) !== event.id
        )
      ) {
        throw new Error("Rejected product revision is no longer current")
      }
      for (const event of oldListing.signedEvents) {
        const stockCheckpoint = await db.localProductStockCheckpoints
          .where("productAddressId")
          .equals(productAddressId(event))
          .filter((checkpoint) => checkpoint.signedEventId === event.id)
          .first()
        if (stockCheckpoint) {
          throw new Error("Rejected stock revision needs stock recovery")
        }
      }
      allowedListingJobId = oldListing.id
    } else {
      if (deletion || input.signedListings.length !== 1) {
        throw new Error("Legacy stock recovery needs one signed listing")
      }
      const previousStockEventId = input.recovery.previousStockEventId
      const oldListings = await db.productListingOutbox
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray()
      const oldListing = oldListings.find(
        (job) =>
          job.signedEvents.length === 1 &&
          job.signedEvents[0]?.id === previousStockEventId
      )
      if (
        !oldListing ||
        oldListing.state !== "failed" ||
        expected.get(listingCoordinates[0]!) !== previousStockEventId ||
        productAddressId(oldListing.signedEvents[0]!) !== listingCoordinates[0]
      ) {
        throw new Error("Rejected stock recovery is not exact")
      }
      allowedListingJobId = oldListing.id
    }

    for (const [addressId, expectedEventId] of expected) {
      const current = await readCurrentProductWriteRevision(addressId)
      if (current.eventId !== expectedEventId) {
        throw new Error("Product changed before the signed local commit")
      }
      await assertNoPendingLocalStockCheckpoint(addressId)
      const replacement = input.signedListings.find(
        (event) => productAddressId(event) === addressId
      )
      if (
        replacement &&
        (replacement.created_at <= (current.eventCreatedAt ?? -1) ||
          replacement.created_at <= current.deletionCreatedAt)
      ) {
        throw new Error("Signed product revision does not advance its source")
      }
      if (
        deletionCoordinates.includes(addressId) &&
        deletion!.created_at < (current.eventCreatedAt ?? -1)
      ) {
        throw new Error("Signed product deletion predates its source")
      }
    }
    await assertNoConflictingProductDeliveryJobs({
      merchantPubkey,
      expected,
      allowedListingJobIds: new Set([allowedListingJobId]),
      allowedDeletionJobIds: new Set(
        allowedDeletionJobId ? [allowedDeletionJobId] : []
      ),
      ...(input.recovery.kind === "listing_republish"
        ? { allowedRecoveryPredecessorJobId: allowedListingJobId }
        : {}),
    })
    if (input.shouldContinue?.() === false)
      throw new Error("Product write account session changed")
    const result = await stage()
    if (input.recovery.kind === "listing_republish") {
      await armRecoveredProductListingDeliveryUnlocked(
        input.recovery.previousListingJobId,
        getProductListingDeliveryJobId(input.signedListings),
        input.shouldContinue
      )
    }
    return result
  })
}

async function prepareLocalProductWrite(
  input: LocalProductWriteCommitInput
): Promise<{
  intent: LocalProductWriteIntent
  projections: CachedProduct[]
  tombstones: CachedProductTombstone[]
  frontiers: LocalProductWriteFrontier[]
  stock: LocalProductStockCheckpoint | null
  listingJob: ProductListingDeliveryJob | null
  deletionJob: ProductDeletionDeliveryJob | null
  shippingJobs: LocalProductShippingJob[]
  expected: Map<string, string | null>
}> {
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(merchantPubkey) || !input.intentId.trim()) {
    throw new Error("Product-write identity is invalid")
  }
  const expected = assertedExpectedRevisions(
    input.expectedRevisions,
    merchantPubkey
  )
  // Seal caller-owned objects before the first await in the Dexie transaction.
  // A signer/route must not be able to mutate exact outbox bytes mid-commit.
  const listingJob = input.listingJob ? structuredClone(input.listingJob) : null
  const deletionJob = input.deletionJob
    ? structuredClone(input.deletionJob)
    : null
  if (!listingJob && !deletionJob) {
    throw new Error("Product write has no signed delivery intent")
  }
  if (listingJob?.replacesRejectedListingJobId !== undefined) {
    throw new Error("Rejected listing recovery requires atomic lineage staging")
  }
  const signedListings = listingJob?.signedEvents ?? []
  if (
    listingJob &&
    (listingJob.merchantPubkey !== merchantPubkey ||
      signedListings.length === 0 ||
      listingJob.id !== getProductListingDeliveryJobId(signedListings) ||
      listingJob.state !== "pending" ||
      listingJob.replacedByListingJobId !== undefined ||
      Object.keys(listingJob.localReplaySupersededBy ?? {}).length > 0 ||
      listingJob.deliveryAttemptCount !== 0 ||
      listingJob.relayTargets.length === 0 ||
      new Set(listingJob.relayTargets.map((target) => target.relayUrl)).size !==
        listingJob.relayTargets.length ||
      listingJob.relayDelivery.length !==
        signedListings.length * listingJob.relayTargets.length ||
      new Set(
        listingJob.relayDelivery.map(
          (delivery) => `${delivery.eventId}:${delivery.relayUrl}`
        )
      ).size !== listingJob.relayDelivery.length ||
      listingJob.relayDelivery.some(
        (delivery) =>
          delivery.attemptCount !== 0 ||
          delivery.status !== "pending" ||
          !signedListings.some((event) => event.id === delivery.eventId) ||
          !listingJob.relayTargets.some(
            (target) => target.relayUrl === delivery.relayUrl
          )
      ) ||
      (listingJob.companionDeletionJobId !== undefined && !deletionJob))
  ) {
    throw new Error("Product listing delivery intent is not fresh")
  }
  const projections = await Promise.all(
    signedListings.map(async (event) => {
      if (event.pubkey !== merchantPubkey) {
        throw new Error("Signed listing author does not match the merchant")
      }
      const projection = projectSignedProductListingForLocalCommit(
        await admitLocalProductWriteEvent(event)
      )
      if (
        projection.id !== productAddressId(event) ||
        projection.eventId !== event.id
      ) {
        throw new Error("Signed listing projection changed its coordinate")
      }
      return projection
    })
  )
  const listingCoordinates = projections.map((row) => row.id)
  if (new Set(listingCoordinates).size !== listingCoordinates.length) {
    throw new Error("Product write repeats a coordinate")
  }

  const shippingJobs = structuredClone([...(input.shippingJobs ?? [])])
  const shippingIds = shippingJobs.map((job) => job.id)
  if (new Set(shippingIds).size !== shippingIds.length) {
    throw new Error("Shipping prerequisite is repeated")
  }
  for (const job of shippingJobs) {
    if (
      job.id !== job.signedEvent.id ||
      job.merchantPubkey !== merchantPubkey ||
      job.signedEvent.pubkey !== merchantPubkey ||
      job.acknowledgedRelayUrls.length !== 0 ||
      job.relayUrls.length === 0 ||
      new Set(job.relayUrls).size !== job.relayUrls.length
    ) {
      throw new Error(
        "Shipping prerequisite is not an unsigned-delivery intent"
      )
    }
    const coordinate = shippingAddressId(job.signedEvent)
    if (listingJob) {
      assertExactSet(
        job.relayUrls,
        listingJob.relayTargets.map((target) => target.relayUrl)
      )
    }
    if (
      !signedListings.some((listing) =>
        listing.tags.some(
          ([name, value]) => name === "shipping_option" && value === coordinate
        )
      )
    ) {
      throw new Error("Shipping prerequisite is not referenced by this product")
    }
  }
  if (listingJob) {
    assertExactSet(listingJob.prerequisiteShippingEventIds ?? [], shippingIds)
    if (listingJob.readyForDelivery !== false) {
      throw new Error("Product listing must remain gated until local commit")
    }
  } else if (shippingJobs.length > 0) {
    throw new Error("Shipping prerequisite has no product listing")
  }

  const signedDeletion = deletionJob?.signedEvent
  const admittedDeletion = signedDeletion
    ? await admitLocalProductWriteEvent(signedDeletion)
    : undefined
  if (
    deletionJob &&
    (!signedDeletion ||
      signedDeletion.kind !== EVENT_KINDS.DELETION ||
      signedDeletion.pubkey !== merchantPubkey ||
      deletionJob.id !== signedDeletion.id ||
      deletionJob.state !== "pending" ||
      deletionJob.deliveryAttemptCount !== 0 ||
      deletionJob.retryCount !== 0 ||
      deletionJob.relayPlan.length === 0 ||
      new Set(deletionJob.relayPlan.map((target) => target.relayUrl)).size !==
        deletionJob.relayPlan.length ||
      deletionJob.relayDelivery.length !== deletionJob.relayPlan.length ||
      new Set(deletionJob.relayDelivery.map((delivery) => delivery.relayUrl))
        .size !== deletionJob.relayDelivery.length ||
      deletionJob.relayDelivery.some(
        (delivery) =>
          delivery.attemptCount !== 0 ||
          delivery.status !== "pending" ||
          !deletionJob.relayPlan.some(
            (target) => target.relayUrl === delivery.relayUrl
          )
      ) ||
      deletionJob.companionListingJobId !== (listingJob?.id ?? undefined) ||
      (listingJob !== null &&
        listingJob.companionDeletionJobId !== deletionJob.id))
  ) {
    throw new Error("Product deletion delivery intent is not fresh")
  }
  const tombstones = admittedDeletion
    ? projectSignedProductDeletionForLocalCommit(admittedDeletion)
    : []
  const deletionCoordinates = tombstones
    .map((row) => row.addressId)
    .filter((coordinate): coordinate is string => !!coordinate)
  const deletionEventTargets = tombstones
    .map((row) => row.eventId)
    .filter((eventId): eventId is string => !!eventId)
  const expectedDeletionEventTargets = deletionCoordinates
    .map((addressId) => expected.get(addressId))
    .filter((eventId): eventId is string => !!eventId)
  // An extra NIP-09 `e` target would revoke an unrelated exact revision even
  // when every `a` target is within this mutation's coordinate set.
  assertExactSet(deletionEventTargets, expectedDeletionEventTargets)
  if (
    deletionCoordinates.some((addressId) =>
      listingCoordinates.includes(addressId)
    )
  ) {
    // A same-bundle address deletion could invalidate the fresh listing at
    // the same timestamp. Require a separate, explicitly ordered write.
    throw new Error("A product cannot be listed and address-deleted together")
  }
  assertExactSet(
    [...new Set([...listingCoordinates, ...deletionCoordinates])],
    [...expected.keys()]
  )

  const committedAt = input.now?.() ?? Date.now()
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
    throw new Error("Product-write commit time is invalid")
  }
  const frontiers = projections.map((row) => ({
    id: row.id,
    merchantPubkey,
    eventId: row.eventId!,
    eventCreatedAt: row.eventCreatedAt!,
    intentId: input.intentId,
  }))
  let stock: LocalProductStockCheckpoint | null = null
  if (input.stock) {
    const adjustment = input.stock.adjustment
    const row = projections.find((item) => item.id === adjustment.addressId)
    const expectedRevision = expected.get(adjustment.addressId)
    const replacement = input.stock.replacesSignedEventId
    if (
      !input.stock.orderId.trim() ||
      signedListings.length !== 1 ||
      !row ||
      row.stock !== adjustment.nextStock ||
      (replacement
        ? expectedRevision !== replacement ||
          !/^[0-9a-f]{64}$/.test(replacement)
        : expectedRevision !== adjustment.sourceEventId) ||
      adjustment.key !==
        `${encodeURIComponent(input.stock.orderId.trim())}:${encodeURIComponent(adjustment.addressId.trim())}` ||
      !Number.isSafeInteger(adjustment.nextStock) ||
      adjustment.nextStock < 0 ||
      !Number.isSafeInteger(adjustment.quantity) ||
      adjustment.quantity <= 0 ||
      !Number.isSafeInteger(adjustment.currentStock) ||
      adjustment.currentStock < 0
    ) {
      throw new Error(
        "Signed stock checkpoint does not match its product write"
      )
    }
    stock = {
      id: `${merchantPubkey}:${encodeURIComponent(input.stock.orderId)}:${encodeURIComponent(row.id)}:${row.eventId}`,
      merchantPubkey,
      orderId: input.stock.orderId,
      productAddressId: row.id,
      sourceEventId: adjustment.sourceEventId,
      signedEventId: row.eventId!,
      adjustment: { ...adjustment },
      state: "pending",
      committedAt,
    }
  }
  return {
    intent: {
      id: input.intentId,
      merchantPubkey,
      productAddressIds: [...expected.keys()],
      sourceRevisions: [...expected].map(([addressId, eventId]) => ({
        addressId,
        eventId,
      })),
      ...(listingJob ? { listingJobId: listingJob.id } : {}),
      ...(deletionJob ? { deletionJobId: deletionJob.id } : {}),
      shippingEventIds: shippingIds,
      ...(stock ? { stockCheckpointId: stock.id } : {}),
      committedAt,
    },
    projections,
    tombstones,
    frontiers,
    stock,
    listingJob,
    deletionJob,
    shippingJobs,
    expected,
  }
}

/**
 * Revoke only the affected older event's replay authority. Keep exact signed
 * bytes, planned relays, ACK evidence, and unaffected sibling work intact.
 * This runs inside the same transaction as the new source frontier; no relay
 * coverage or historical ACK pair is an admission requirement.
 */
async function supersedePriorListingReplay(input: {
  intent: LocalProductWriteIntent
  listings: readonly ProductListingDeliveryJob[]
  frontiers: readonly LocalProductWriteFrontier[]
  tombstones: readonly CachedProductTombstone[]
  expected: ReadonlyMap<string, string | null>
  reconcileListingJobIds: ReadonlySet<string>
  allowedStockListingJobIds: ReadonlySet<string>
}): Promise<void> {
  const deletions = await db.productDeletionOutbox.toArray()
  const checkpoints = await db.localProductStockCheckpoints.toArray()
  const byId = new Map(input.listings.map((job) => [job.id, job]))
  for (const id of input.reconcileListingJobIds) {
    const job = input.listings.find((candidate) => candidate.id === id)
    if (
      !job ||
      !job.signedEvents.some((event) =>
        input.expected.has(productAddressId(event))
      )
    ) {
      throw new Error(
        "Explicit listing reconciliation no longer matches this write"
      )
    }
  }
  for (const job of input.listings) {
    const affected = job.signedEvents.filter(
      (event) =>
        input.expected.has(productAddressId(event)) &&
        isProductListingEventReplayEligible(job, event.id)
    )
    if (affected.length === 0 || input.allowedStockListingJobIds.has(job.id))
      continue
    const delivered =
      job.state === "delivered" && hasCommonAcknowledgedRelay(job)
    const explicitlyRecovered = getExactRejectedListingSuccessors(
      job,
      byId
    ).some((successor) =>
      affected.every((event) =>
        successor.signedEvents.some(
          (next) =>
            productAddressId(next) === productAddressId(event) &&
            input.expected.get(productAddressId(next)) === next.id
        )
      )
    )
    if (
      !delivered &&
      !explicitlyRecovered &&
      !input.reconcileListingJobIds.has(job.id)
    ) {
      // Legacy explicit recovery remains handled by its own constrained seam.
      continue
    }
    const companions = deletions.filter(
      (deletion) =>
        deletion.companionListingJobId === job.id ||
        deletion.id === job.companionDeletionJobId
    )
    if (
      (job.companionDeletionJobId &&
        !companions.some(
          (deletion) =>
            deletion.id === job.companionDeletionJobId &&
            deletion.companionListingJobId === job.id
        )) ||
      companions.some((deletion) => deletion.state !== "delivered") ||
      (!delivered &&
        (companions.length > 0 ||
          (job.prerequisiteShippingEventIds?.length ?? 0) > 0)) ||
      checkpoints.some(
        (checkpoint) =>
          affected.some((event) => event.id === checkpoint.signedEventId) &&
          checkpoint.state !== "applied"
      )
    ) {
      throw new Error("Dependent product delivery still needs reconciliation")
    }
    for (const event of affected) {
      const addressId = productAddressId(event)
      const replacement = input.frontiers.find(
        (frontier) => frontier.id === addressId
      )
      const deletion = input.tombstones.find(
        (tombstone) => tombstone.addressId === addressId
      )
      if (
        replacement
          ? replacement.eventCreatedAt! <= event.created_at
          : !deletion || deletion.deletedAt < event.created_at
      ) {
        throw new Error(
          "Signed product revision does not advance prior delivery"
        )
      }
    }
    await db.productListingOutbox.put({
      ...job,
      localReplaySupersededBy: {
        ...job.localReplaySupersededBy,
        ...Object.fromEntries(
          affected.map((event) => [event.id, input.intent.id])
        ),
      },
      updatedAt: input.intent.committedAt,
    })
  }
}

/**
 * One device-local commit for exact signed product bytes and every downstream
 * delivery prerequisite. No network I/O, UI callback, or signer wait occurs in
 * this transaction. Existing route writers must not bypass this seam when they
 * are migrated; legacy jobs remain untouched until explicitly reconciled.
 */
export async function commitLocalProductWrite(
  input: LocalProductWriteCommitInput
): Promise<LocalProductWriteIntent> {
  // Verification can wait on a worker. Seal every mutable input before that
  // wait, preserving the exact signed delivery bytes and CAS authority.
  input = {
    ...input,
    expectedRevisions: structuredClone(input.expectedRevisions),
    additionalExpectedRevisions: structuredClone(
      input.additionalExpectedRevisions
    ),
    listingJob: structuredClone(input.listingJob),
    deletionJob: structuredClone(input.deletionJob),
    shippingJobs: structuredClone(input.shippingJobs),
    stock: structuredClone(input.stock),
    reconcileListingJobIds: structuredClone(input.reconcileListingJobIds),
  }
  const prepared = await prepareLocalProductWrite(input)
  const reconcileListingJobIds = new Set(input.reconcileListingJobIds ?? [])
  const {
    intent,
    projections,
    tombstones,
    frontiers,
    stock,
    listingJob,
    deletionJob,
    shippingJobs,
    expected,
  } = prepared
  const guardedRevisions = new Map(expected)
  if (input.additionalExpectedRevisions?.length) {
    const additional = assertedExpectedRevisions(
      input.additionalExpectedRevisions,
      intent.merchantPubkey
    )
    for (const [addressId, eventId] of additional) {
      if (
        guardedRevisions.has(addressId) &&
        guardedRevisions.get(addressId) !== eventId
      ) {
        throw new Error("Product family source revisions disagree")
      }
      guardedRevisions.set(addressId, eventId)
    }
  }
  intent.sourceRevisions = [...guardedRevisions].map(
    ([addressId, eventId]) => ({ addressId, eventId })
  )
  await withLocalProductCoordinateLocks([...guardedRevisions.keys()], () =>
    db.transaction(
      "rw",
      [
        db.localProductWriteIntents,
        db.localProductWriteFrontiers,
        db.localProductShippingOutbox,
        db.localProductStockCheckpoints,
        db.productListingOutbox,
        db.productDeletionOutbox,
        db.products,
        db.productTombstones,
      ],
      async () => {
        if (input.shouldContinue?.() === false) {
          throw new Error("Product write account session changed")
        }
        if (await db.localProductWriteIntents.get(intent.id)) {
          throw new Error("Product write intent was already committed")
        }
        const currentRevisions = new Map<
          string,
          { eventId: string | null; eventCreatedAt: number | null }
        >()
        for (const [addressId, expectedEventId] of guardedRevisions) {
          const current = await readCurrentProductWriteRevision(addressId)
          currentRevisions.set(addressId, current)
          if (current.eventId !== expectedEventId) {
            throw new Error("Product changed before the signed local commit")
          }
          if (
            !expected.has(addressId) &&
            (current.exactEventDeleted ||
              (current.eventCreatedAt !== null &&
                current.eventCreatedAt <= current.deletionCreatedAt))
          ) {
            throw new Error("Captured product family member was deleted")
          }
          await assertNoPendingLocalStockCheckpoint(addressId)
          const replacement = frontiers.find((row) => row.id === addressId)
          if (
            replacement &&
            (replacement.eventCreatedAt! <= (current.eventCreatedAt ?? -1) ||
              replacement.eventCreatedAt! <= current.deletionCreatedAt)
          ) {
            // NIP-01 equal-second ties and NIP-09 address cutoffs are both
            // fail-closed; a future-dated signer result must be re-signed.
            throw new Error(
              "Signed product revision does not advance its source"
            )
          }
          const addressDeletion = tombstones.find(
            (row) => row.addressId === addressId
          )
          if (
            addressDeletion &&
            addressDeletion.deletedAt < (current.eventCreatedAt ?? -1)
          ) {
            throw new Error("Signed product deletion predates its source")
          }
        }

        const priorStock = stock
          ? await db.localProductStockCheckpoints
              .where("orderId")
              .equals(stock.orderId)
              .filter(
                (checkpoint) =>
                  checkpoint.merchantPubkey === intent.merchantPubkey &&
                  checkpoint.productAddressId === stock.productAddressId
              )
              .toArray()
          : []
        const replacementStock = stock && input.stock?.replacesSignedEventId
        if (stock) {
          const replacedCheckpoint = priorStock.find(
            (checkpoint) =>
              checkpoint.signedEventId === replacementStock &&
              checkpoint.state === "unpublished"
          )
          if (
            (await db.localProductStockCheckpoints.get(stock.id)) ||
            priorStock.some(
              (checkpoint) => checkpoint.state !== "unpublished"
            ) ||
            (replacementStock &&
              priorStock.some(
                (checkpoint) =>
                  JSON.stringify(checkpoint.adjustment) !==
                  JSON.stringify(stock.adjustment)
              )) ||
            (replacementStock
              ? !replacedCheckpoint ||
                JSON.stringify(replacedCheckpoint.adjustment) !==
                  JSON.stringify(stock.adjustment)
              : priorStock.length > 0)
          ) {
            throw new Error("This order already has a durable stock checkpoint")
          }
        }
        const replacedStockIds = new Set(
          replacementStock
            ? priorStock.map((checkpoint) => checkpoint.signedEventId)
            : []
        )
        const legacyListings = await db.productListingOutbox
          .where("merchantPubkey")
          .equals(intent.merchantPubkey)
          .toArray()
        if (
          replacementStock &&
          priorStock.some((checkpoint) => {
            const job = legacyListings.find((candidate) =>
              candidate.signedEvents.some(
                (event) => event.id === checkpoint.signedEventId
              )
            )
            return (
              !job ||
              job.state !== "failed" ||
              job.signedEvents.length !== 1 ||
              productAddressId(job.signedEvents[0]!) !== stock?.productAddressId
            )
          })
        ) {
          throw new Error(
            "Rejected stock revision is not terminally unpublished"
          )
        }
        const allowedStockListingJobIds = new Set(
          legacyListings
            .filter(
              (job) =>
                job.state === "failed" &&
                job.signedEvents.length === 1 &&
                replacedStockIds.has(job.signedEvents[0]!.id)
            )
            .map((job) => job.id)
        )
        await supersedePriorListingReplay({
          intent,
          listings: legacyListings,
          frontiers,
          tombstones,
          expected,
          reconcileListingJobIds,
          allowedStockListingJobIds,
        })
        await assertNoConflictingProductDeliveryJobs({
          merchantPubkey: intent.merchantPubkey,
          expected,
          allowedListingJobIds: new Set([
            ...(listingJob ? [listingJob.id] : []),
            ...allowedStockListingJobIds,
          ]),
          allowedDeletionJobIds: new Set(deletionJob ? [deletionJob.id] : []),
        })
        if (input.shouldContinue?.() === false) {
          throw new Error("Product write account session changed")
        }
        for (const row of projections) {
          const existing = await db.products.get(row.id)
          await db.products.put({
            ...row,
            sourceRelayUrls: [
              ...new Set([
                ...(existing?.sourceRelayUrls ?? []),
                ...(row.sourceRelayUrls ?? []),
              ]),
            ],
          })
        }
        const selectedTombstones = new Map<string, CachedProductTombstone>()
        for (const row of tombstones) {
          const existing = await db.productTombstones.get(row.id)
          const candidateWins =
            !existing ||
            row.deletedAt > existing.deletedAt ||
            (row.deletedAt === existing.deletedAt &&
              row.deletionEventId <= existing.deletionEventId)
          const winner = candidateWins ? row : existing!
          const merged: CachedProductTombstone = {
            ...winner,
            sourceRelayUrls: [
              ...new Set([
                ...(existing?.sourceRelayUrls ?? []),
                ...(row.sourceRelayUrls ?? []),
              ]),
            ],
            observedLocally:
              existing?.observedLocally === true ||
              row.observedLocally === true,
            cachedAt: Math.max(existing?.cachedAt ?? 0, row.cachedAt),
          }
          selectedTombstones.set(row.id, merged)
          if (
            !existing ||
            JSON.stringify(existing) !== JSON.stringify(merged)
          ) {
            await db.productTombstones.put(merged)
          }
        }
        for (const row of frontiers) await putProductWriteFrontier(row)
        for (const row of tombstones) {
          if (!row.addressId) continue
          const selected = selectedTombstones.get(row.id)!
          const current = currentRevisions.get(row.addressId)!
          const previous = await db.localProductWriteFrontiers.get(
            row.addressId
          )
          if (
            previous?.deletionCreatedAt !== undefined &&
            (previous.deletionCreatedAt > selected.deletedAt ||
              (previous.deletionCreatedAt === selected.deletedAt &&
                previous.deletionEventId !== undefined &&
                previous.deletionEventId < selected.deletionEventId))
          ) {
            continue
          }
          await db.localProductWriteFrontiers.put({
            id: row.addressId,
            merchantPubkey: intent.merchantPubkey,
            eventId: current.eventId,
            eventCreatedAt: current.eventCreatedAt,
            deletionEventId: selected.deletionEventId,
            deletionCreatedAt: selected.deletedAt,
            intentId: intent.id,
          })
        }
        for (const job of shippingJobs)
          await db.localProductShippingOutbox.add(job)
        if (stock) await db.localProductStockCheckpoints.add(stock)
        if (listingJob) {
          await db.productListingOutbox.add({
            ...listingJob,
            readyForDelivery: shippingJobs.length === 0,
          })
        }
        if (deletionJob) await db.productDeletionOutbox.add(deletionJob)
        await db.localProductWriteIntents.add(intent)
      }
    )
  )
  return intent
}
