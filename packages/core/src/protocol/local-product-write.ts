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
import { withLocalProductCoordinateLocks } from "./local-product-coordinate-lock"
import {
  getProductListingDeliveryJobId,
  isTerminalRecoverableProductListingJob,
} from "./product-listing-delivery"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import type { SignedPublicNostrEvent } from "./signed-event"

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
  listingJob?: ProductListingDeliveryJob
  deletionJob?: ProductDeletionDeliveryJob
  shippingJobs?: readonly LocalProductShippingJob[]
  stock?: LocalProductWriteStockInput
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

async function readCurrentProductWriteRevision(addressId: string): Promise<{
  eventId: string | null
  eventCreatedAt: number | null
  deletionCreatedAt: number
}> {
  const [frontier, cached, addressTombstone] = await Promise.all([
    db.localProductWriteFrontiers.get(addressId),
    db.products.get(addressId),
    db.productTombstones.get(`a:${addressId}`),
  ])
  const frontierCreatedAt = frontier?.eventCreatedAt ?? -1
  const cachedCreatedAt = cached?.eventCreatedAt ?? -1
  const frontierWins =
    frontierCreatedAt > cachedCreatedAt ||
    (frontierCreatedAt === cachedCreatedAt &&
      !!frontier?.eventId &&
      (!cached?.eventId || frontier.eventId < cached.eventId))
  return {
    eventId: frontierWins ? frontier!.eventId : (cached?.eventId ?? null),
    eventCreatedAt: frontierWins
      ? frontier!.eventCreatedAt
      : (cached?.eventCreatedAt ?? null),
    deletionCreatedAt: Math.max(
      frontier?.deletionCreatedAt ?? -1,
      addressTombstone?.deletedAt ?? -1
    ),
  }
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

async function assertNoConflictingProductDeliveryJobs(input: {
  merchantPubkey: string
  expected: ReadonlyMap<string, string | null>
  allowedListingJobIds?: ReadonlySet<string>
  allowedDeletionJobIds?: ReadonlySet<string>
}): Promise<void> {
  const listings = await db.productListingOutbox
    .where("merchantPubkey")
    .equals(input.merchantPubkey)
    .toArray()
  if (
    listings.some(
      (job) =>
        job.state !== "delivered" &&
        !input.allowedListingJobIds?.has(job.id) &&
        job.signedEvents.some((event) =>
          input.expected.has(productAddressId(event))
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
 * Bridge an older exact-byte recovery into the same coordinate authority as
 * the atomic writer. The caller must already hold the per-merchant stock lock;
 * stage may do local persistence only, never signer or relay I/O.
 */
export async function withLocalLegacyProductWriteStage<T>(
  input: LocalLegacyProductWriteStageInput,
  stage: () => Promise<T>
): Promise<T> {
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
    ? projectSignedProductDeletionForLocalCommit(deletion)
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
      const oldListing = await db.productListingOutbox.get(
        input.recovery.previousListingJobId
      )
      if (
        deletion ||
        !oldListing ||
        oldListing.merchantPubkey !== merchantPubkey ||
        oldListing.companionDeletionJobId !== undefined ||
        (oldListing.prerequisiteShippingEventIds?.length ?? 0) > 0 ||
        !isTerminalRecoverableProductListingJob(oldListing)
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
    })
    return stage()
  })
}

function prepareLocalProductWrite(input: LocalProductWriteCommitInput): {
  intent: LocalProductWriteIntent
  projections: CachedProduct[]
  tombstones: CachedProductTombstone[]
  frontiers: LocalProductWriteFrontier[]
  stock: LocalProductStockCheckpoint | null
  listingJob: ProductListingDeliveryJob | null
  deletionJob: ProductDeletionDeliveryJob | null
  shippingJobs: LocalProductShippingJob[]
  expected: Map<string, string | null>
} {
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
  const signedListings = listingJob?.signedEvents ?? []
  if (
    listingJob &&
    (listingJob.merchantPubkey !== merchantPubkey ||
      signedListings.length === 0 ||
      listingJob.id !== getProductListingDeliveryJobId(signedListings) ||
      listingJob.state !== "pending" ||
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
  const projections = signedListings.map((event) => {
    if (event.pubkey !== merchantPubkey) {
      throw new Error("Signed listing author does not match the merchant")
    }
    const projection = projectSignedProductListingForLocalCommit(event)
    if (
      projection.id !== productAddressId(event) ||
      projection.eventId !== event.id
    ) {
      throw new Error("Signed listing projection changed its coordinate")
    }
    return projection
  })
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
  if (
    deletionJob &&
    (!signedDeletion ||
      !isValidSignedPublicNostrEvent(signedDeletion) ||
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
  const tombstones = signedDeletion
    ? projectSignedProductDeletionForLocalCommit(signedDeletion)
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
 * One device-local commit for exact signed product bytes and every downstream
 * delivery prerequisite. No network I/O, UI callback, or signer wait occurs in
 * this transaction. Existing route writers must not bypass this seam when they
 * are migrated; legacy jobs remain untouched until explicitly reconciled.
 */
export async function commitLocalProductWrite(
  input: LocalProductWriteCommitInput
): Promise<LocalProductWriteIntent> {
  const prepared = prepareLocalProductWrite(input)
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
  await withLocalProductCoordinateLocks([...expected.keys()], () =>
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
        if (await db.localProductWriteIntents.get(intent.id)) {
          throw new Error("Product write intent was already committed")
        }
        const currentRevisions = new Map<
          string,
          { eventId: string | null; eventCreatedAt: number | null }
        >()
        for (const [addressId, expectedEventId] of expected) {
          const current = await readCurrentProductWriteRevision(addressId)
          currentRevisions.set(addressId, current)
          if (current.eventId !== expectedEventId) {
            throw new Error("Product changed before the signed local commit")
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
        await assertNoConflictingProductDeliveryJobs({
          merchantPubkey: intent.merchantPubkey,
          expected,
          allowedListingJobIds: new Set([
            ...(listingJob ? [listingJob.id] : []),
            ...legacyListings
              .filter(
                (job) =>
                  job.state === "failed" &&
                  job.signedEvents.length === 1 &&
                  replacedStockIds.has(job.signedEvents[0]!.id)
              )
              .map((job) => job.id),
          ]),
          allowedDeletionJobIds: new Set(deletionJob ? [deletionJob.id] : []),
        })
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
        for (const row of frontiers)
          await db.localProductWriteFrontiers.put(row)
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
