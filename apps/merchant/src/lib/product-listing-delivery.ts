import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  cacheSignedProductListingEvent,
  cacheSignedProductDeletionEvent,
  config,
  deliverProductListingJob,
  EVENT_KINDS,
  getPendingProductListingDeliveries,
  getProductDeletionDelivery,
  getProductListingDelivery,
  getProductListingDeliveryJobId,
  getStagedProductListingDeliveries,
  getAuthorEventFallbackRelayUrls,
  normalizePublicWebSocketUrl,
  markProductListingDeliveryReady,
  persistProductListingDelivery,
  planPublishRelays,
  publishSignedEventToRelay,
  type ProductListingDeliveryJob,
  type ProductListingDeliveryOptions,
  type ProductDeletionDeliveryOptions,
  type ProductListingRelayPublisher,
  type ProductListingRelayTarget,
  type PublishWithPlannerResult,
  type RelayWritePlan,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const WORKER_INTERVAL_MS = 15_000
const MAX_JOB_DELIVERY_CONCURRENCY = 3

async function runJobsWithConcurrency<T>(
  jobs: readonly T[],
  operation: (job: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_JOB_DELIVERY_CONCURRENCY, jobs.length) },
      async () => {
        while (nextIndex < jobs.length) {
          const index = nextIndex
          nextIndex += 1
          await operation(jobs[index]!)
        }
      }
    )
  )
}

function uniqueRelayTargets(
  targets: readonly ProductListingRelayTarget[]
): ProductListingRelayTarget[] {
  const byUrl = new Map<string, ProductListingRelayTarget>()
  for (const target of targets) {
    const existing = byUrl.get(target.relayUrl)
    byUrl.set(target.relayUrl, {
      relayUrl: target.relayUrl,
      ownerSelected: target.ownerSelected || existing?.ownerSelected === true,
      ...(target.appRelay === true || existing?.appRelay === true
        ? { appRelay: true }
        : {}),
      ...(target.personalRelay === true || existing?.personalRelay === true
        ? { personalRelay: true }
        : {}),
      ...(target.independentRelay === true ||
      existing?.independentRelay === true
        ? { independentRelay: true }
        : {}),
    })
  }
  return Array.from(byUrl.values())
}

async function publishProductListingRelay(
  input: Parameters<ProductListingRelayPublisher>[0]
): Promise<Awaited<ReturnType<ProductListingRelayPublisher>>> {
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
  const requiresAuthenticatedOwnerAuthority =
    !config.e2eRelayIsolationEnabled &&
    !normalizePublicWebSocketUrl(input.relayUrl)

  const status = await publishSignedEventToRelay({
    signedEvent: input.signedEvent,
    relayUrl: input.relayUrl,
    authorPubkey: input.signedEvent.pubkey,
    accountPubkey: input.accountPubkey,
    authenticatedPubkey,
    ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
    appRelayUrls: input.appRelayUrls,
    personalRelayUrls: input.personalRelayUrls,
    independentRelayUrls: input.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue:
      requiresAuthenticatedOwnerAuthority && authenticatedPubkey
        ? () =>
            input.isAuthenticatedPubkeyCurrent?.(authenticatedPubkey) !== false
        : undefined,
  })
  if (status === "acked") {
    // Do not make an ACK terminal in the outbox until its exact relay
    // provenance is durable for later NIP-09 planning after a reload.
    await cacheSignedProductListingEvent(
      new NDKEvent(undefined, input.signedEvent),
      {
        sourceRelayUrls: [input.relayUrl],
        persistence: "required",
      }
    )
  }
  return { status }
}

async function restoreLocalListingEvidence(
  job: ProductListingDeliveryJob
): Promise<void> {
  await Promise.all(
    job.signedEvents.map((signedEvent) => {
      const sourceRelayUrls = job.relayDelivery
        .filter(
          (delivery) =>
            delivery.eventId === signedEvent.id && delivery.status === "acked"
        )
        .map((delivery) => delivery.relayUrl)
      return cacheSignedProductListingEvent(
        new NDKEvent(undefined, signedEvent),
        {
          sourceRelayUrls,
          persistence: "best_effort",
        }
      )
    })
  )
}

export async function planCurrentProductListingRelayTargets(
  merchantPubkey: string,
  authenticatedPubkey: string | null,
  shouldContinue?: () => boolean
): Promise<ProductListingRelayTarget[]> {
  const plan = await planPublishRelays({
    intent: "commerce_author_event",
    authorPubkey: merchantPubkey,
    authenticatedPubkey,
    accountPubkey: merchantPubkey,
    refreshRelayLists: true,
    deliveryMode: "critical",
    skipHealthFilter: true,
    shouldContinue,
  })
  return resolveProductListingRelayTargets(plan)
}

export function resolveProductListingRelayTargets(
  plan: RelayWritePlan
): ProductListingRelayTarget[] {
  const plannedRelayUrls = [
    ...plan.primaryRelayUrls,
    ...plan.broadcastRelayUrls,
    ...plan.parkedRelayUrls,
  ]
  const fallbackRelayUrls =
    plan.signedRelayListAuthoritative === true
      ? []
      : getAuthorEventFallbackRelayUrls({
          eventKind: EVENT_KINDS.PRODUCT,
          intent: "commerce_author_event",
          attemptedRelayUrls: plannedRelayUrls,
        })
  const appRelayUrls = new Set(plan.appRelayUrls ?? [])
  const personalRelayUrls = new Set(plan.personalRelayUrls ?? [])
  const independentRelayUrls = new Set(plan.independentRelayUrls ?? [])
  const commerceFallbackRelayUrls = new Set(fallbackRelayUrls)
  return uniqueRelayTargets(
    [...plannedRelayUrls, ...fallbackRelayUrls].map((relayUrl) => ({
      relayUrl,
      // Private/local targets can only survive author-event planning when the
      // authenticated owner selected them. The configured isolated E2E relay
      // is admitted separately and does not need owner authority.
      ownerSelected:
        !config.e2eRelayIsolationEnabled &&
        !normalizePublicWebSocketUrl(relayUrl),
      ...(appRelayUrls.has(relayUrl) || commerceFallbackRelayUrls.has(relayUrl)
        ? { appRelay: true }
        : {}),
      ...(personalRelayUrls.has(relayUrl) ? { personalRelay: true } : {}),
      ...(independentRelayUrls.has(relayUrl) ? { independentRelay: true } : {}),
    }))
  )
}

export async function persistSignedProductListings(
  input: {
    merchantPubkey: string
    signedEvents: readonly SignedPublicNostrEvent[]
    relayTargets: readonly ProductListingRelayTarget[]
    companionDeletionJobId?: string
    readyForDelivery?: boolean
  },
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob> {
  return await persistProductListingDelivery(input, options)
}

/**
 * Migrate a pre-outbox retry by durably binding its exact signed bytes to one
 * immutable relay plan before any relay I/O. Existing jobs always win so a
 * later tab cannot replace their original targets.
 */
export async function ensureSignedProductListingsQueued(
  input: {
    merchantPubkey: string
    signedEvents: readonly SignedPublicNostrEvent[]
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
  },
  options: ProductListingDeliveryOptions = {},
  dependencies: {
    planRelayTargets?: typeof planCurrentProductListingRelayTargets
  } = {}
): Promise<ProductListingDeliveryJob> {
  const id = getProductListingDeliveryJobId(input.signedEvents)
  const existing = await getProductListingDelivery(id, options)
  if (existing) return existing

  const relayTargets = await (
    dependencies.planRelayTargets ?? planCurrentProductListingRelayTargets
  )(
    input.merchantPubkey,
    input.authenticatedPubkey ?? null,
    input.shouldContinue
  )
  return await persistSignedProductListings(
    {
      merchantPubkey: input.merchantPubkey,
      signedEvents: input.signedEvents,
      relayTargets,
      readyForDelivery: true,
    },
    options
  )
}

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls))
}

export function productListingJobToPublishResult(
  job: ProductListingDeliveryJob
): PublishWithPlannerResult {
  const attemptedRelayUrls = uniqueRelayUrls(
    job.relayDelivery
      .filter((delivery) => delivery.attemptCount > 0)
      .map((delivery) => delivery.relayUrl)
  )
  const successfulRelayUrls = job.relayTargets
    .map((target) => target.relayUrl)
    .filter((relayUrl) =>
      job.signedEvents.every((event) =>
        job.relayDelivery.some(
          (delivery) =>
            delivery.eventId === event.id &&
            delivery.relayUrl === relayUrl &&
            delivery.status === "acked"
        )
      )
    )
  const successfulRelaySet = new Set(successfulRelayUrls)
  const failedRelayUrls = job.relayTargets
    .map((target) => target.relayUrl)
    .filter((relayUrl) => !successfulRelaySet.has(relayUrl))
  const rejectedRelayUrls = failedRelayUrls.filter((relayUrl) => {
    const deliveries = job.relayDelivery.filter(
      (delivery) => delivery.relayUrl === relayUrl
    )
    return (
      deliveries.some((delivery) => delivery.status === "rejected") &&
      deliveries.every(
        (delivery) =>
          delivery.status === "acked" || delivery.status === "rejected"
      )
    )
  })

  return {
    plan: {
      intent: "commerce_author_event",
      primaryRelayUrls: job.relayTargets.map((target) => target.relayUrl),
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
      independentRelayUrls: [],
    },
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
    rejectedRelayUrls,
    relayFailureMessages: Object.fromEntries(
      failedRelayUrls.map((relayUrl) => {
        const deliveries = job.relayDelivery.filter(
          (delivery) => delivery.relayUrl === relayUrl
        )
        const message = deliveries.some(
          (delivery) => delivery.status === "rejected"
        )
          ? "Relay rejected part of the product family"
          : deliveries.some((delivery) => delivery.status === "timed_out")
            ? "No acknowledgement before timeout"
            : "Product-family delivery attempt pending"
        return [relayUrl, message]
      })
    ),
  }
}

export interface DeliverQueuedProductListingOptions extends ProductListingDeliveryOptions {
  publisher?: ProductListingRelayPublisher
  restoreLocalEvidence?: (job: ProductListingDeliveryJob) => Promise<void>
  shouldContinue?: () => boolean
  expectedSignedEvents?: readonly SignedPublicNostrEvent[]
}

function signedEventsMatch(
  left: readonly SignedPublicNostrEvent[],
  right: readonly SignedPublicNostrEvent[]
): boolean {
  return (
    left.length === right.length &&
    left.every((event, index) => {
      const candidate = right[index]
      return (
        !!candidate &&
        event.id === candidate.id &&
        event.pubkey === candidate.pubkey &&
        event.created_at === candidate.created_at &&
        event.kind === candidate.kind &&
        event.content === candidate.content &&
        event.sig === candidate.sig &&
        event.tags.length === candidate.tags.length &&
        event.tags.every(
          (tag, tagIndex) =>
            tag.length === candidate.tags[tagIndex]?.length &&
            tag.every(
              (value, valueIndex) =>
                value === candidate.tags[tagIndex]?.[valueIndex]
            )
        )
      )
    })
  )
}

function bindAuthenticatedProductListingAuthority(
  authenticatedPubkey: string | null | undefined,
  shouldContinue: (() => boolean) | undefined,
  isAuthenticatedPubkeyCurrent: ProductListingDeliveryOptions["isAuthenticatedPubkeyCurrent"]
): ProductListingDeliveryOptions["isAuthenticatedPubkeyCurrent"] {
  if (!authenticatedPubkey || !shouldContinue) {
    return isAuthenticatedPubkeyCurrent
  }
  return (candidatePubkey) =>
    candidatePubkey === authenticatedPubkey &&
    (isAuthenticatedPubkeyCurrent?.(candidatePubkey) ?? true) &&
    shouldContinue()
}

export async function deliverQueuedProductListings(
  jobId: string,
  options: DeliverQueuedProductListingOptions = {}
): Promise<PublishWithPlannerResult> {
  const {
    publisher = publishProductListingRelay,
    restoreLocalEvidence = restoreLocalListingEvidence,
    shouldContinue,
    expectedSignedEvents,
    ...deliveryOptions
  } = options
  const queuedJob = await getProductListingDelivery(jobId, deliveryOptions)
  if (!queuedJob) {
    throw new Error("Product listing delivery job not found")
  }
  if (
    expectedSignedEvents &&
    !signedEventsMatch(queuedJob.signedEvents, expectedSignedEvents)
  ) {
    throw new Error(
      "Product listing delivery job does not match the exact signed family"
    )
  }

  await restoreLocalEvidence(queuedJob)
  const deliveredJob = await deliverProductListingJob(jobId, publisher, {
    ...deliveryOptions,
    isAuthenticatedPubkeyCurrent: bindAuthenticatedProductListingAuthority(
      deliveryOptions.authenticatedPubkey,
      shouldContinue,
      deliveryOptions.isAuthenticatedPubkeyCurrent
    ),
  })
  await restoreLocalEvidence(deliveredJob)
  return productListingJobToPublishResult(deliveredJob)
}

export interface ResumeProductListingDeliveriesOptions extends ProductListingDeliveryOptions {
  publisher?: ProductListingRelayPublisher
  restoreLocalEvidence?: (job: ProductListingDeliveryJob) => Promise<void>
}

export interface ResumeStagedProductListingDeliveriesOptions extends ProductListingDeliveryOptions {
  deletionDeliveryOptions?: ProductDeletionDeliveryOptions
  restoreLocalListingEvidence?: (
    job: ProductListingDeliveryJob
  ) => Promise<void>
  restoreLocalDeletionEvidence?: (
    signedEvent: SignedPublicNostrEvent
  ) => Promise<void>
}

/**
 * Recover the narrow crash window after signed listing evidence became
 * durable but before its delivery gate was armed. Mixed writes also require
 * the exact reciprocal deletion intent before either half is exposed.
 */
export async function resumeStagedProductListingDeliveries(
  options: ResumeStagedProductListingDeliveriesOptions = {}
): Promise<void> {
  const {
    deletionDeliveryOptions,
    restoreLocalListingEvidence: restoreListing = restoreLocalListingEvidence,
    restoreLocalDeletionEvidence: restoreDeletion = async (signedEvent) => {
      await cacheSignedProductDeletionEvent(
        new NDKEvent(undefined, signedEvent)
      )
    },
    ...listingOptions
  } = options
  const jobs = await getStagedProductListingDeliveries(listingOptions)
  for (const job of jobs) {
    const deletionId = job.companionDeletionJobId
    try {
      if (!deletionId) {
        await restoreListing(job)
        await markProductListingDeliveryReady(job.id, listingOptions)
        continue
      }
      const deletion = await getProductDeletionDelivery(
        deletionId,
        deletionDeliveryOptions
      )
      if (
        !deletion ||
        deletion.companionListingJobId !== job.id ||
        deletion.signedEvent.id !== deletionId
      ) {
        continue
      }
      await restoreListing(job)
      await restoreDeletion(deletion.signedEvent)
      await markProductListingDeliveryReady(job.id, {
        ...listingOptions,
        isCompanionDeletionDurable: async (
          candidateId,
          candidateListingJobId
        ) => candidateId === deletion.id && candidateListingJobId === job.id,
      })
    } catch {
      // Leave both exact intents staged. A later startup/online pass can retry
      // local evidence restoration without exposing either half to a relay.
    }
  }
}

export async function resumePendingProductListingDeliveries(
  options: ResumeProductListingDeliveriesOptions = {}
): Promise<void> {
  const {
    publisher = publishProductListingRelay,
    restoreLocalEvidence = restoreLocalListingEvidence,
    ...deliveryOptions
  } = options
  const jobs = await getPendingProductListingDeliveries({
    ...deliveryOptions,
    dueOnly: true,
  })
  await runJobsWithConcurrency(jobs, async (job) => {
    try {
      await restoreLocalEvidence(job)
      const deliveredJob = await deliverProductListingJob(
        job.id,
        publisher,
        deliveryOptions
      )
      await restoreLocalEvidence(deliveredJob)
    } catch {
      // Each exact signed family remains durable and independent. A cache or
      // relay failure must not prevent later jobs from making progress.
    }
  })
}

export function startProductListingDeliveryWorker(
  authenticatedPubkey: string | null = null
): () => void {
  if (typeof window === "undefined") return () => {}

  let stopped = false
  let active: Promise<void> | null = null
  const run = () => {
    if (stopped || active) return
    active = resumeStagedProductListingDeliveries({
      authenticatedPubkey,
      isAuthenticatedPubkeyCurrent: () => !stopped,
    })
      .then(() =>
        resumePendingProductListingDeliveries({
          authenticatedPubkey,
          isAuthenticatedPubkeyCurrent: () => !stopped,
        })
      )
      .catch(() => {
        // The durable family remains queued for a later timer/online/focus run.
      })
      .finally(() => {
        active = null
      })
  }
  const runWhenVisible = () => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    ) {
      run()
    }
  }

  const interval = window.setInterval(runWhenVisible, WORKER_INTERVAL_MS)
  window.addEventListener("online", run)
  window.addEventListener("focus", run)
  document.addEventListener("visibilitychange", runWhenVisible)
  queueMicrotask(run)

  return () => {
    stopped = true
    window.clearInterval(interval)
    window.removeEventListener("online", run)
    window.removeEventListener("focus", run)
    document.removeEventListener("visibilitychange", runWhenVisible)
  }
}
