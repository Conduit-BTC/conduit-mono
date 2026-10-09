import { config } from "../config"
import {
  db,
  type LocalProductShippingJob,
  type LocalProductWriteFrontier,
  type LocalProductWriteIntent,
  type ProductListingDeliveryJob,
  type ProductListingRelayTarget,
} from "../db"
import {
  filterEligibleAccountRelayTargets,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { EVENT_KINDS } from "./kinds"
import { withLocalProductCoordinateLocks } from "./local-product-coordinate-lock"
import {
  getConfiguredIsolatedE2eRelayUrl,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  getProductListingDeliveryJobId,
  getProductListingDeliveryRelayTarget,
  isProductListingEventReplayEligible,
} from "./product-listing-delivery"
import { readCurrentProductWriteRevision } from "./local-product-write"
import { publishSignedEventToRelay } from "./relay-publish"
import type { RelayTarget } from "./relay-authority"
import type { OwnerRelayListEvidenceRepository } from "./owner-relay-list-evidence"

const DEFAULT_MAX_RELAY_ATTEMPTS = 6
const DEFAULT_MAX_JOBS = 8

export interface CommittedProductShippingDelivery {
  shippingJob: LocalProductShippingJob
  intent: LocalProductWriteIntent
  listingJob: ProductListingDeliveryJob
  currentFrontiers: LocalProductWriteFrontier[]
  currentRevisions: Array<{
    addressId: string
    eventId: string | null
    eventCreatedAt: number | null
    deletionCreatedAt: number
    exactEventDeleted: boolean
  }>
}

/**
 * Implementations must read one committed intent, listing, shipping job, and
 * current product frontiers together. ACK URLs are historical delivery evidence:
 * add them atomically only if the exact committed event and relay plan remain
 * unchanged, even when a newer product intent prevents actionable completion.
 */
export interface ProductShippingOutboxRepository {
  getCommitted(
    eventId: string
  ): Promise<CommittedProductShippingDelivery | undefined>
  listPendingIds(): Promise<string[]>
  acknowledge(
    eventId: string,
    relayUrl: string,
    expected: LocalProductShippingJob
  ): Promise<LocalProductShippingJob>
}

/** Publish an exact kind-30406 frame; this adapter must not cache it as a product. */
export type ProductShippingRelayPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  accountPubkey: string
  authenticatedPubkey: string | null
  isAuthenticatedPubkeyCurrent?: (pubkey: string) => boolean
  ownerSelectedRelayUrls: string[]
  appRelayUrls: string[]
  personalRelayUrls: string[]
  independentRelayUrls: string[]
  /** Exact saved target with independently admitted current write grants. */
  relayTarget: RelayTarget
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  ownerRelayListEvidenceRepository?: Pick<
    OwnerRelayListEvidenceRepository,
    "get"
  >
}) => Promise<{ status: "acked" | "rejected" | "timed_out" }>

/** Core's exact-frame edge adapter; unlike listing delivery, it never caches 30406 as 30402. */
export const publishExactProductShippingRelay: ProductShippingRelayPublisher =
  async (input) => {
    let authenticatedPubkey = input.authenticatedPubkey
    try {
      if (
        authenticatedPubkey &&
        input.isAuthenticatedPubkeyCurrent?.(authenticatedPubkey) === false
      ) {
        authenticatedPubkey = null
      }
    } catch {
      authenticatedPubkey = null
    }
    const needsAuthenticatedOwner = input.relayTarget.grants.every(
      (grant) => grant.kind === "owner_nip65"
    )
    const status = await publishSignedEventToRelay({
      relayUrl: input.relayUrl,
      signedEvent: input.signedEvent,
      authorPubkey: input.signedEvent.pubkey,
      accountPubkey: input.accountPubkey,
      authenticatedPubkey,
      relayTarget: input.relayTarget,
      accountNetworkLocalStateRepository:
        input.accountNetworkLocalStateRepository,
      ownerRelayListEvidenceRepository: input.ownerRelayListEvidenceRepository,
      shouldContinue:
        needsAuthenticatedOwner && authenticatedPubkey
          ? () =>
              input.isAuthenticatedPubkeyCurrent?.(authenticatedPubkey) !==
              false
          : undefined,
    })
    // Authentication defers this exact frame; it is not a terminal rejection.
    return {
      status:
        status === "acked" || status === "rejected" ? status : "timed_out",
    }
  }

export interface ProductShippingDeliveryOptions {
  repository?: ProductShippingOutboxRepository
  authenticatedPubkey?: string | null
  isAuthenticatedPubkeyCurrent?: (pubkey: string) => boolean
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  ownerRelayListEvidenceRepository?: Pick<
    OwnerRelayListEvidenceRepository,
    "get"
  >
  /** One invocation sends each target at most once; callers schedule later retries. */
  maxRelayAttemptsPerRun?: number
  maxJobsPerRun?: number
  /** Test seam; production uses cross-tab Web Locks and fails closed without them. */
  requestCoordinateLock?: <T>(
    name: string,
    operation: () => Promise<T>
  ) => Promise<T>
}

function cloneJob(job: LocalProductShippingJob): LocalProductShippingJob {
  return structuredClone(job)
}

function sameSignedEvent(
  left: SignedPublicNostrEvent,
  right: SignedPublicNostrEvent
): boolean {
  return (
    left.id === right.id &&
    left.pubkey === right.pubkey &&
    left.created_at === right.created_at &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.sig === right.sig &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  )
}

function sameRelayPlan(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((relayUrl) => right.includes(relayUrl))
  )
}

function shippingCoordinate(event: SignedPublicNostrEvent): string {
  const dTags = event.tags.filter(([name]) => name === "d")
  const dTag = dTags.length === 1 ? dTags[0]?.[1] : undefined
  if (!dTag) throw new Error("Signed shipping coordinate is invalid")
  return `${EVENT_KINDS.SHIPPING_OPTION}:${event.pubkey}:${dTag}`
}

function listingCoordinate(event: SignedPublicNostrEvent): string {
  const dTags = event.tags.filter(([name]) => name === "d")
  const dTag = dTags.length === 1 ? dTags[0]?.[1] : undefined
  if (!dTag) throw new Error("Signed product coordinate is invalid")
  return `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${dTag}`
}

function assertApprovedTarget(target: ProductListingRelayTarget): void {
  const normalized = tryNormalizeRelayUrl(target.relayUrl)
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (
    !normalized.ok ||
    normalized.url !== target.relayUrl ||
    (target.appRelay !== true &&
      target.personalRelay !== true &&
      target.independentRelay !== true) ||
    (config.e2eRelayIsolationEnabled && normalized.url !== isolatedRelayUrl) ||
    (!normalized.url.startsWith("wss://") &&
      normalized.url !== isolatedRelayUrl &&
      !target.ownerSelected)
  ) {
    throw new Error("Shipping delivery target lacks approved provenance")
  }
}

/**
 * A shipping row alone is not authority to publish. The committed intent and
 * its immutable listing relay plan must still name this exact prerequisite.
 */
function verifiedContext(
  context: CommittedProductShippingDelivery,
  requireCurrent = true
): CommittedProductShippingDelivery {
  const {
    shippingJob,
    intent,
    listingJob,
    currentFrontiers,
    currentRevisions,
  } = context
  const event = shippingJob.signedEvent
  const coordinate = shippingCoordinate(event)
  const listingCoordinates = listingJob.signedEvents.map(listingCoordinate)
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== EVENT_KINDS.SHIPPING_OPTION ||
    shippingJob.id !== event.id ||
    shippingJob.merchantPubkey !== event.pubkey ||
    intent.merchantPubkey !== event.pubkey ||
    listingJob.merchantPubkey !== event.pubkey ||
    intent.listingJobId !== listingJob.id ||
    listingJob.signedEvents.length === 0 ||
    listingJob.id !== getProductListingDeliveryJobId(listingJob.signedEvents) ||
    listingJob.signedEvents.some(
      (listing) =>
        !isValidSignedPublicNostrEvent(listing) ||
        listing.kind !== EVENT_KINDS.PRODUCT ||
        listing.pubkey !== event.pubkey ||
        (requireCurrent &&
          !isProductListingEventReplayEligible(listingJob, listing.id))
    ) ||
    new Set(listingCoordinates).size !== listingCoordinates.length ||
    (requireCurrent &&
      (currentFrontiers.length !== listingCoordinates.length ||
        currentRevisions.length !== listingCoordinates.length ||
        listingJob.signedEvents.some((listing, index) => {
          const addressId = listingCoordinates[index]
          const frontier = currentFrontiers.find((row) => row.id === addressId)
          const current = currentRevisions.find(
            (row) => row.addressId === addressId
          )
          return (
            !frontier ||
            !current ||
            current.eventId !== listing.id ||
            current.eventCreatedAt !== listing.created_at ||
            current.deletionCreatedAt >= listing.created_at ||
            current.exactEventDeleted ||
            !intent.productAddressIds.includes(addressId!) ||
            frontier.merchantPubkey !== event.pubkey ||
            frontier.intentId !== intent.id ||
            frontier.eventId !== listing.id ||
            frontier.eventCreatedAt !== listing.created_at ||
            (frontier.deletionCreatedAt ?? -1) >= listing.created_at
          )
        }))) ||
    !intent.shippingEventIds.includes(event.id) ||
    !listingJob.prerequisiteShippingEventIds?.includes(event.id) ||
    !listingJob.signedEvents.some((listing) =>
      listing.tags.some(
        ([name, value]) => name === "shipping_option" && value === coordinate
      )
    ) ||
    listingJob.signedEvents.some(
      (listing) =>
        listing.created_at < event.created_at &&
        listing.tags.some(
          ([name, value]) => name === "shipping_option" && value === coordinate
        )
    ) ||
    shippingJob.relayUrls.length === 0 ||
    new Set(shippingJob.relayUrls).size !== shippingJob.relayUrls.length ||
    new Set(listingJob.relayTargets.map((target) => target.relayUrl)).size !==
      listingJob.relayTargets.length ||
    !sameRelayPlan(
      shippingJob.relayUrls,
      listingJob.relayTargets.map((target) => target.relayUrl)
    ) ||
    new Set(shippingJob.acknowledgedRelayUrls).size !==
      shippingJob.acknowledgedRelayUrls.length ||
    shippingJob.acknowledgedRelayUrls.some(
      (relayUrl) => !shippingJob.relayUrls.includes(relayUrl)
    )
  ) {
    throw new Error("Shipping delivery lacks a committed product intent")
  }
  for (const target of listingJob.relayTargets) assertApprovedTarget(target)
  return context
}

async function readCommitted(
  eventId: string,
  requireCurrent = true
): Promise<CommittedProductShippingDelivery | undefined> {
  const shippingJob = await db.localProductShippingOutbox.get(eventId)
  if (!shippingJob) return undefined
  const intents = await db.localProductWriteIntents
    .filter((intent) => intent.shippingEventIds.includes(eventId))
    .toArray()
  if (intents.length !== 1 || !intents[0]?.listingJobId) {
    throw new Error("Shipping delivery lacks a unique committed intent")
  }
  const listingJob = await db.productListingOutbox.get(intents[0].listingJobId)
  if (!listingJob) {
    throw new Error("Shipping delivery companion listing is missing")
  }
  const currentFrontiers = await Promise.all(
    listingJob.signedEvents.map((event) =>
      db.localProductWriteFrontiers.get(listingCoordinate(event))
    )
  )
  const currentRevisions = await Promise.all(
    listingJob.signedEvents.map(async (event) => {
      const addressId = listingCoordinate(event)
      const current = await readCurrentProductWriteRevision(addressId)
      return { addressId, ...current }
    })
  )
  return verifiedContext(
    {
      shippingJob,
      intent: intents[0],
      listingJob,
      currentFrontiers: currentFrontiers.filter(
        (frontier): frontier is LocalProductWriteFrontier =>
          frontier !== undefined
      ),
      currentRevisions,
    },
    requireCurrent
  )
}

const dexieRepository: ProductShippingOutboxRepository = {
  getCommitted(eventId) {
    return db.transaction(
      "r",
      [
        db.localProductShippingOutbox,
        db.localProductWriteIntents,
        db.localProductWriteFrontiers,
        db.productListingOutbox,
        db.products,
        db.productTombstones,
      ],
      () => readCommitted(eventId)
    )
  },
  async listPendingIds() {
    const jobs = await db.localProductShippingOutbox.toArray()
    return jobs
      .filter((job) =>
        job.relayUrls.some(
          (relayUrl) => !job.acknowledgedRelayUrls.includes(relayUrl)
        )
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((job) => job.id)
  },
  acknowledge(eventId, relayUrl, expected) {
    return db.transaction(
      "rw",
      [
        db.localProductShippingOutbox,
        db.localProductWriteIntents,
        db.localProductWriteFrontiers,
        db.productListingOutbox,
        db.products,
        db.productTombstones,
      ],
      async () => {
        const context = await readCommitted(eventId, false)
        if (!context) throw new Error("Shipping delivery job is missing")
        const current = context.shippingJob
        if (
          !sameSignedEvent(current.signedEvent, expected.signedEvent) ||
          !sameRelayPlan(current.relayUrls, expected.relayUrls) ||
          !current.relayUrls.includes(relayUrl)
        ) {
          throw new Error("Signed shipping delivery intent changed")
        }
        if (current.acknowledgedRelayUrls.includes(relayUrl)) {
          return cloneJob(current)
        }
        const updated = {
          ...current,
          acknowledgedRelayUrls: [...current.acknowledgedRelayUrls, relayUrl],
        }
        await db.localProductShippingOutbox.put(updated)
        return cloneJob(updated)
      }
    )
  },
}

function repository(
  options: ProductShippingDeliveryOptions
): ProductShippingOutboxRepository {
  return options.repository ?? dexieRepository
}

function boundedCount(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0
    ? Math.min(value!, fallback)
    : fallback
}

function activeAuthenticatedPubkey(
  options: ProductShippingDeliveryOptions
): string | null {
  const pubkey = options.authenticatedPubkey ?? null
  if (!pubkey) return null
  try {
    return options.isAuthenticatedPubkeyCurrent?.(pubkey) === false
      ? null
      : pubkey
  } catch {
    return null
  }
}

const deliveryLocks = new WeakMap<
  ProductShippingOutboxRepository,
  Map<string, Promise<LocalProductShippingJob>>
>()
const relayCursors = new WeakMap<
  ProductShippingOutboxRepository,
  Map<string, number>
>()

function getDeliveryLocks(
  outbox: ProductShippingOutboxRepository
): Map<string, Promise<LocalProductShippingJob>> {
  const existing = deliveryLocks.get(outbox)
  if (existing) return existing
  const created = new Map<string, Promise<LocalProductShippingJob>>()
  deliveryLocks.set(outbox, created)
  return created
}

/**
 * Return only ACK URLs for an exact shipping event linked to a committed
 * listing intent. It does not claim recipient discovery or global visibility.
 */
export async function getVerifiedProductShippingAcknowledgements(
  eventId: string,
  options: ProductShippingDeliveryOptions = {}
): Promise<string[]> {
  const context = await repository(options).getCommitted(eventId)
  if (!context) return []
  return [...verifiedContext(context).shippingJob.acknowledgedRelayUrls].sort()
}

/** One bounded exact-byte pass. Rejections/timeouts retain the durable job. */
export async function deliverProductShippingJob(
  eventId: string,
  publisher: ProductShippingRelayPublisher,
  options: ProductShippingDeliveryOptions = {}
): Promise<LocalProductShippingJob> {
  const outbox = repository(options)
  const locks = getDeliveryLocks(outbox)
  const active = locks.get(eventId)
  if (active) return active
  const run = (async () => {
    const committed = await outbox.getCommitted(eventId)
    if (!committed) throw new Error("Shipping delivery job is missing")
    const initialContext = verifiedContext(committed)
    const lockCoordinates =
      initialContext.listingJob.signedEvents.map(listingCoordinate)
    const immutableEvent = structuredClone(
      initialContext.shippingJob.signedEvent
    )
    const immutableTargets = [...initialContext.shippingJob.relayUrls]
    const withCurrentContext = <T>(
      operation: (context: CommittedProductShippingDelivery) => Promise<T>
    ): Promise<T> =>
      withLocalProductCoordinateLocks(
        lockCoordinates,
        async () => {
          // Capture or reconcile local authority under the commit lock, but
          // never retain that lock while waiting on relay or signer I/O.
          const locked = await outbox.getCommitted(eventId)
          if (!locked) throw new Error("Shipping delivery job is missing")
          const context = verifiedContext(locked)
          if (
            !sameRelayPlan(
              context.listingJob.signedEvents.map(listingCoordinate),
              lockCoordinates
            )
          ) {
            throw new Error("Shipping delivery product coordinates changed")
          }
          if (
            context.intent.id !== initialContext.intent.id ||
            !sameSignedEvent(context.shippingJob.signedEvent, immutableEvent) ||
            !sameRelayPlan(context.shippingJob.relayUrls, immutableTargets)
          ) {
            throw new Error("Signed shipping delivery intent changed")
          }
          return operation(context)
        },
        { requestLock: options.requestCoordinateLock }
      )
    const targets = initialContext.listingJob.relayTargets
    const cursorMap = relayCursors.get(outbox) ?? new Map<string, number>()
    relayCursors.set(outbox, cursorMap)
    const start = (cursorMap.get(eventId) ?? 0) % targets.length
    const targetCount = Math.min(
      targets.length,
      boundedCount(options.maxRelayAttemptsPerRun, DEFAULT_MAX_RELAY_ATTEMPTS)
    )
    // Rotate the bounded window even when a target rejects or is cut off.
    // Otherwise early bad relays could starve a later healthy one forever.
    cursorMap.set(eventId, (start + targetCount) % targets.length)
    for (let index = 0; index < targetCount; index += 1) {
      const target = targets[(start + index) % targets.length]!
      const current = await withCurrentContext(async (context) =>
        cloneJob(context.shippingJob)
      )
      if (current.acknowledgedRelayUrls.includes(target.relayUrl)) continue

      let authenticatedPubkey = activeAuthenticatedPubkey(options)
      const sources = {
        ownerSelectedRelayUrls: target.ownerSelected ? [target.relayUrl] : [],
        appRelayUrls: target.appRelay ? [target.relayUrl] : [],
        personalRelayUrls: target.personalRelay ? [target.relayUrl] : [],
        independentRelayUrls: target.independentRelay ? [target.relayUrl] : [],
      }
      const relayTarget = getProductListingDeliveryRelayTarget(
        target,
        current.merchantPubkey
      )
      const admission = () =>
        filterEligibleAccountRelayTargets({
          accountPubkey: current.merchantPubkey,
          authenticatedPubkey,
          targets: [relayTarget],
          operation: "write",
          repository: options.accountNetworkLocalStateRepository,
          ownerRelayListEvidenceRepository:
            options.ownerRelayListEvidenceRepository,
        })
      let eligible = await admission()
      const currentAuthenticatedPubkey = activeAuthenticatedPubkey(options)
      if (currentAuthenticatedPubkey !== authenticatedPubkey) {
        authenticatedPubkey = currentAuthenticatedPubkey
        eligible = await admission()
      }
      const admittedTarget = eligible.find(({ url }) => url === target.relayUrl)
      if (!admittedTarget) continue
      let outcome: Awaited<ReturnType<ProductShippingRelayPublisher>>
      try {
        outcome = await publisher({
          relayUrl: target.relayUrl,
          signedEvent: structuredClone(immutableEvent),
          accountPubkey: current.merchantPubkey,
          authenticatedPubkey,
          isAuthenticatedPubkeyCurrent: options.isAuthenticatedPubkeyCurrent,
          ...sources,
          relayTarget: admittedTarget,
          accountNetworkLocalStateRepository:
            options.accountNetworkLocalStateRepository,
          ownerRelayListEvidenceRepository:
            options.ownerRelayListEvidenceRepository,
        })
      } catch {
        // An unavailable relay is not an ACK. Keep the exact job for repair.
        continue
      }
      if (outcome.status === "acked") {
        await withLocalProductCoordinateLocks(
          lockCoordinates,
          async () => {
            // Keep exact historical delivery evidence, but a late result must
            // not restore a superseded prerequisite or finalize stale work.
            await outbox.acknowledge(eventId, target.relayUrl, current)
            const completed = await outbox.getCommitted(eventId)
            if (!completed) throw new Error("Shipping delivery job is missing")
            verifiedContext(completed)
          },
          { requestLock: options.requestCoordinateLock }
        )
      }
    }
    return withCurrentContext(async (context) => cloneJob(context.shippingJob))
  })()
  locks.set(eventId, run)
  try {
    return await run
  } finally {
    if (locks.get(eventId) === run) locks.delete(eventId)
  }
}

/** Merchant's post-commit entry point; the result is verified, relay-scoped ACK evidence. */
export async function deliverLocalProductShippingJob(
  eventId: string,
  publisher: ProductShippingRelayPublisher,
  options: ProductShippingDeliveryOptions = {}
): Promise<string[]> {
  await deliverProductShippingJob(eventId, publisher, options)
  return getVerifiedProductShippingAcknowledgements(eventId, options)
}

const pendingCursors = new WeakMap<ProductShippingOutboxRepository, number>()

/** Startup/manual recovery: cap jobs and attempts so one pass cannot fan out indefinitely. */
export async function deliverPendingProductShippingJobs(
  publisher: ProductShippingRelayPublisher,
  options: ProductShippingDeliveryOptions = {}
): Promise<LocalProductShippingJob[]> {
  const outbox = repository(options)
  const pendingIds = await outbox.listPendingIds()
  if (pendingIds.length === 0) return []
  const start = (pendingCursors.get(outbox) ?? 0) % pendingIds.length
  const count = Math.min(
    pendingIds.length,
    boundedCount(options.maxJobsPerRun, DEFAULT_MAX_JOBS)
  )
  const ids = Array.from(
    { length: count },
    (_, index) => pendingIds[(start + index) % pendingIds.length]!
  )
  // A persistently unavailable first job must not starve later jobs during
  // repeated startup/background passes in the same app session.
  pendingCursors.set(outbox, (start + count) % pendingIds.length)
  const completed: LocalProductShippingJob[] = []
  for (const id of ids) {
    try {
      completed.push(
        await deliverProductShippingJob(id, publisher, {
          ...options,
          repository: outbox,
        })
      )
    } catch {
      // A malformed or unavailable job must not starve the next durable job.
    }
  }
  return completed
}
