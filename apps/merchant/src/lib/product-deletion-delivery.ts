import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  cacheSignedProductDeletionEvent,
  CANONICAL_APP_BACKPLANE_RELAYS,
  deliverProductDeletionJob,
  getProductDeletionDelivery,
  getPendingProductDeletionDeliveries,
  persistProductDeletionDelivery,
  planPublishRelays,
  publishSignedEventToRelay,
  type ProductDeletionDeliveryOptions,
  type ProductDeletionDeliveryJob,
  type ProductDeletionRelayPublisher,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const WORKER_INTERVAL_MS = 15_000

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls))
}

async function publishProductDeletionRelay(
  input: Parameters<ProductDeletionRelayPublisher>[0]
): Promise<Awaited<ReturnType<ProductDeletionRelayPublisher>>> {
  return {
    status: await publishSignedEventToRelay({
      signedEvent: input.signedEvent,
      relayUrl: input.relayUrl,
      authorPubkey: input.signedEvent.pubkey,
      authenticatedPubkey: input.roles.includes("author_write")
        ? input.signedEvent.pubkey
        : null,
    }),
  }
}

async function restoreLocalDeletionEvidence(
  job: ProductDeletionDeliveryJob
): Promise<void> {
  await cacheSignedProductDeletionEvent(
    new NDKEvent(undefined, job.signedEvent)
  )
}

export async function planCurrentProductDeletionWriteRelays(
  merchantPubkey: string
): Promise<string[]> {
  const plan = await planPublishRelays({
    intent: "author_event",
    authorPubkey: merchantPubkey,
    authenticatedPubkey: merchantPubkey,
    refreshRelayLists: true,
    deliveryMode: "critical",
    skipHealthFilter: true,
  })
  return uniqueRelayUrls([
    ...plan.primaryRelayUrls,
    ...plan.broadcastRelayUrls,
    ...plan.parkedRelayUrls,
  ])
}

export async function persistSignedProductDeletion(input: {
  signedEvent: SignedPublicNostrEvent
  currentWriteRelayUrls: readonly string[]
  sourceRelayUrls: readonly string[]
}): Promise<ProductDeletionDeliveryJob> {
  const canonicalConduitRelayUrl = CANONICAL_APP_BACKPLANE_RELAYS[0]
  if (!canonicalConduitRelayUrl) {
    throw new Error("Canonical Conduit relay is not configured")
  }
  return await persistProductDeletionDelivery({
    signedEvent: input.signedEvent,
    currentWriteRelayUrls: input.currentWriteRelayUrls,
    sourceRelayUrls: input.sourceRelayUrls,
    canonicalConduitRelayUrl,
  })
}

export function productDeletionJobToPublishResult(
  job: ProductDeletionDeliveryJob
): PublishWithPlannerResult {
  const attemptedRelayUrls = job.relayDelivery
    .filter((delivery) => delivery.attemptCount > 0)
    .map((delivery) => delivery.relayUrl)
  const successfulRelayUrls = job.relayDelivery
    .filter((delivery) => delivery.status === "acked")
    .map((delivery) => delivery.relayUrl)
  const outstandingDeliveries = job.relayDelivery.filter(
    (delivery) => delivery.status !== "acked"
  )

  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: job.relayPlan.map((target) => target.relayUrl),
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls: outstandingDeliveries.map((delivery) => delivery.relayUrl),
    relayFailureMessages: Object.fromEntries(
      outstandingDeliveries.map((delivery) => [
        delivery.relayUrl,
        delivery.status === "rejected"
          ? "Relay rejected the deletion event"
          : delivery.status === "timed_out"
            ? "No acknowledgement before timeout"
            : "Delivery attempt pending",
      ])
    ),
  }
}

export interface DeliverQueuedProductDeletionOptions extends ProductDeletionDeliveryOptions {
  publisher?: ProductDeletionRelayPublisher
  restoreLocalEvidence?: (job: ProductDeletionDeliveryJob) => Promise<void>
}

export async function deliverQueuedProductDeletion(
  jobId: string,
  options: DeliverQueuedProductDeletionOptions = {}
): Promise<PublishWithPlannerResult> {
  const {
    publisher = publishProductDeletionRelay,
    restoreLocalEvidence = restoreLocalDeletionEvidence,
    ...deliveryOptions
  } = options
  const queuedJob = await getProductDeletionDelivery(jobId, deliveryOptions)
  if (!queuedJob) {
    throw new Error("Product deletion delivery job not found")
  }

  // A persisted outbox entry can outlive a transient local tombstone write
  // failure. Never let an explicit Retry finish network delivery until the
  // same signed event is restored to the shared local read frontier.
  await restoreLocalEvidence(queuedJob)

  const deliveredJob = await deliverProductDeletionJob(jobId, publisher, {
    ...deliveryOptions,
    forceDeliveryLeaseRecovery: true,
  })
  return productDeletionJobToPublishResult(deliveredJob)
}

export async function getPendingProductDeletionJobs(
  merchantPubkey?: string
): Promise<ProductDeletionDeliveryJob[]> {
  const jobs = await getPendingProductDeletionDeliveries()
  return merchantPubkey
    ? jobs.filter((job) => job.signedEvent.pubkey === merchantPubkey)
    : jobs
}

export interface ResumeProductDeletionDeliveriesOptions extends ProductDeletionDeliveryOptions {
  publisher?: ProductDeletionRelayPublisher
  restoreLocalEvidence?: (job: ProductDeletionDeliveryJob) => Promise<void>
}

export async function resumePendingProductDeletionDeliveries(
  options: ResumeProductDeletionDeliveriesOptions = {}
): Promise<void> {
  const {
    publisher = publishProductDeletionRelay,
    restoreLocalEvidence = restoreLocalDeletionEvidence,
    ...deliveryOptions
  } = options
  const jobs = await getPendingProductDeletionDeliveries({
    ...deliveryOptions,
    dueOnly: true,
  })
  for (const job of jobs) {
    try {
      await restoreLocalEvidence(job)
    } catch {
      // Keep this job undelivered so local tombstone restoration is retried.
      // Continue with later jobs so one cache failure cannot starve the queue.
      continue
    }
    try {
      await deliverProductDeletionJob(job.id, publisher, deliveryOptions)
    } catch {
      // Jobs are independent. Preserve this one for a later retry and continue
      // so an old/corrupt entry cannot starve newer deletions.
    }
  }
}

export function startProductDeletionDeliveryWorker(): () => void {
  if (typeof window === "undefined") return () => {}

  let stopped = false
  let active: Promise<void> | null = null
  const run = () => {
    if (stopped || active) return
    active = resumePendingProductDeletionDeliveries()
      .catch(() => {
        // The durable job remains queued. A later timer/online/focus event
        // retries without requiring another signature.
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
