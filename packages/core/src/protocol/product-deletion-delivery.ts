import {
  db,
  type ProductDeletionDeliveryJob,
  type ProductDeletionDeliveryState,
  type ProductDeletionRelayDelivery,
  type ProductDeletionRelayDeliveryStatus,
  type ProductDeletionRelayRole,
  type ProductDeletionRelayTarget,
} from "../db"
import { validateProductDeletionEvent } from "./product-deletion"
import type { SignedPublicNostrEvent } from "./signed-event"
import { tryNormalizeRelayUrl } from "./relay-settings"

const DEFAULT_RETRY_DELAY_MS = 30_000
const DEFAULT_DELIVERY_LEASE_MS = 30_000
const ROLE_ORDER: readonly ProductDeletionRelayRole[] = [
  "author_write",
  "source",
  "conduit",
]

export interface ProductDeletionRelayPlanInput {
  currentWriteRelayUrls: readonly string[]
  sourceRelayUrls: readonly string[]
  canonicalConduitRelayUrl: string
}

export interface PersistProductDeletionDeliveryInput extends ProductDeletionRelayPlanInput {
  signedEvent: SignedPublicNostrEvent
}

export type ProductDeletionPublisherResult = {
  status: Exclude<ProductDeletionRelayDeliveryStatus, "pending">
}

/**
 * A delivery adapter must classify relay outcomes structurally. Provider error
 * text is intentionally excluded from durable state and diagnostics.
 */
export type ProductDeletionRelayPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
}) => Promise<ProductDeletionPublisherResult>

/**
 * The small persistence boundary keeps delivery deterministic and testable.
 * Production uses Dexie; tests and non-browser runtimes can inject another
 * durable repository with the same atomic-update behavior.
 */
export interface ProductDeletionOutboxRepository {
  add(job: ProductDeletionDeliveryJob): Promise<void>
  get(id: string): Promise<ProductDeletionDeliveryJob | undefined>
  listUndelivered(): Promise<ProductDeletionDeliveryJob[]>
  update(
    id: string,
    updater: (current: ProductDeletionDeliveryJob) => ProductDeletionDeliveryJob
  ): Promise<ProductDeletionDeliveryJob>
}

export interface ProductDeletionDeliveryOptions {
  repository?: ProductDeletionOutboxRepository
  now?: () => number
  retryDelayMs?: number
  deliveryLeaseOwner?: string
  deliveryLeaseMs?: number
  /** Explicit user retry may recover a lease orphaned by a crashed tab. */
  forceDeliveryLeaseRecovery?: boolean
}

function cloneSignedEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

function cloneRelayPlan(
  plan: readonly ProductDeletionRelayTarget[]
): ProductDeletionRelayTarget[] {
  return plan.map((target) => ({
    relayUrl: target.relayUrl,
    roles: [...target.roles],
  }))
}

function cloneRelayDelivery(
  deliveries: readonly ProductDeletionRelayDelivery[]
): ProductDeletionRelayDelivery[] {
  return deliveries.map((delivery) => ({ ...delivery }))
}

function cloneJob(job: ProductDeletionDeliveryJob): ProductDeletionDeliveryJob {
  return {
    ...job,
    signedEvent: cloneSignedEvent(job.signedEvent),
    relayPlan: cloneRelayPlan(job.relayPlan),
    relayDelivery: cloneRelayDelivery(job.relayDelivery),
  }
}

function normalizeSecureRelayUrl(raw: string): string | null {
  const normalized = tryNormalizeRelayUrl(raw)
  if (!normalized.ok) return null

  try {
    return new URL(normalized.url).protocol === "wss:" ? normalized.url : null
  } catch {
    return null
  }
}

function addRelayRole(
  targets: Map<string, Set<ProductDeletionRelayRole>>,
  rawRelayUrl: string,
  role: ProductDeletionRelayRole
): void {
  const relayUrl = normalizeSecureRelayUrl(rawRelayUrl)
  if (!relayUrl) return

  const roles = targets.get(relayUrl) ?? new Set<ProductDeletionRelayRole>()
  roles.add(role)
  targets.set(relayUrl, roles)
}

/**
 * Build the exact, deterministic relay fanout plan recorded with a deletion.
 *
 * Inputs that cannot be normalized to secure `wss://` targets are ignored. The
 * canonical Conduit target is mandatory because it is part of the durable
 * deletion contract, while never being treated as the only source of truth.
 */
export function planProductDeletionRelays(
  input: ProductDeletionRelayPlanInput
): ProductDeletionRelayTarget[] {
  const canonicalRelayUrl = normalizeSecureRelayUrl(
    input.canonicalConduitRelayUrl
  )
  if (!canonicalRelayUrl) {
    throw new Error("Canonical Conduit relay must use a secure wss:// URL")
  }

  const targets = new Map<string, Set<ProductDeletionRelayRole>>()
  for (const relayUrl of input.currentWriteRelayUrls) {
    addRelayRole(targets, relayUrl, "author_write")
  }
  for (const relayUrl of input.sourceRelayUrls) {
    addRelayRole(targets, relayUrl, "source")
  }
  addRelayRole(targets, canonicalRelayUrl, "conduit")

  return Array.from(targets.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([relayUrl, roles]) => ({
      relayUrl,
      roles: ROLE_ORDER.filter((role) => roles.has(role)),
    }))
}

function assertSignedDeletionEvent(event: SignedPublicNostrEvent): void {
  const validated = validateProductDeletionEvent(event)
  if (!validated || validated.evidence.length === 0) {
    throw new Error(
      "Product deletion outbox requires a valid signed kind-5 event with a safe product target"
    )
  }
}

function relayPlanMatches(
  left: readonly ProductDeletionRelayTarget[],
  right: readonly ProductDeletionRelayTarget[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function signedEventMatches(
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
    left.tags.length === right.tags.length &&
    left.tags.every(
      (tag, index) =>
        tag.length === right.tags[index]?.length &&
        tag.every(
          (value, valueIndex) => value === right.tags[index]?.[valueIndex]
        )
    )
  )
}

const dexieProductDeletionOutboxRepository: ProductDeletionOutboxRepository = {
  async add(job) {
    await db.productDeletionOutbox.add(cloneJob(job))
  },

  async get(id) {
    const job = await db.productDeletionOutbox.get(id)
    return job ? cloneJob(job) : undefined
  },

  async listUndelivered() {
    const jobs = await db.productDeletionOutbox
      .filter((job) => job.state !== "delivered")
      .toArray()
    return jobs.map(cloneJob)
  },

  async update(id, updater) {
    return db.transaction("rw", db.productDeletionOutbox, async () => {
      const current = await db.productDeletionOutbox.get(id)
      if (!current) {
        throw new Error("Product deletion delivery job not found")
      }

      const next = updater(cloneJob(current))
      if (next.id !== id) {
        throw new Error("Product deletion delivery job id is immutable")
      }
      await db.productDeletionOutbox.put(cloneJob(next))
      return cloneJob(next)
    })
  },
}

function getRepository(
  options?: ProductDeletionDeliveryOptions
): ProductDeletionOutboxRepository {
  return options?.repository ?? dexieProductDeletionOutboxRepository
}

function getNow(options?: ProductDeletionDeliveryOptions): number {
  return options?.now?.() ?? Date.now()
}

function getRetryDelayMs(options?: ProductDeletionDeliveryOptions): number {
  const configured = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_RETRY_DELAY_MS
}

const defaultDeliveryLeaseOwner =
  globalThis.crypto?.randomUUID?.() ??
  `product-deletion-worker-${Date.now()}-${Math.random()}`

function getDeliveryLeaseOwner(
  options?: ProductDeletionDeliveryOptions
): string {
  return options?.deliveryLeaseOwner?.trim() || defaultDeliveryLeaseOwner
}

function getDeliveryLeaseMs(options?: ProductDeletionDeliveryOptions): number {
  const configured = options?.deliveryLeaseMs ?? DEFAULT_DELIVERY_LEASE_MS
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_DELIVERY_LEASE_MS
}

/**
 * Persist the exact signed event and immutable relay plan before any delivery.
 * Repeated calls for the same event are idempotent only when the event and plan
 * are byte-for-byte equivalent.
 */
export async function persistProductDeletionDelivery(
  input: PersistProductDeletionDeliveryInput,
  options: ProductDeletionDeliveryOptions = {}
): Promise<ProductDeletionDeliveryJob> {
  assertSignedDeletionEvent(input.signedEvent)
  const repository = getRepository(options)
  const relayPlan = planProductDeletionRelays(input)
  const existing = await repository.get(input.signedEvent.id)

  if (existing) {
    if (
      !signedEventMatches(existing.signedEvent, input.signedEvent) ||
      !relayPlanMatches(existing.relayPlan, relayPlan)
    ) {
      throw new Error(
        "A product deletion delivery job already exists with a different immutable plan"
      )
    }
    return cloneJob(existing)
  }

  const createdAt = getNow(options)
  const job: ProductDeletionDeliveryJob = {
    id: input.signedEvent.id,
    signedEvent: cloneSignedEvent(input.signedEvent),
    relayPlan: cloneRelayPlan(relayPlan),
    relayDelivery: relayPlan.map(({ relayUrl }) => ({
      relayUrl,
      status: "pending",
      attemptCount: 0,
    })),
    state: "pending",
    deliveryAttemptCount: 0,
    retryCount: 0,
    nextRetryAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }

  try {
    await repository.add(job)
  } catch (error) {
    // Another route/tab may have won the same idempotent insert race.
    const raced = await repository.get(job.id)
    if (
      !raced ||
      !signedEventMatches(raced.signedEvent, job.signedEvent) ||
      !relayPlanMatches(raced.relayPlan, job.relayPlan)
    ) {
      throw error
    }
    return cloneJob(raced)
  }

  return cloneJob(job)
}

function deriveDeliveryState(
  deliveries: readonly ProductDeletionRelayDelivery[],
  deliveryAttemptCount: number
): ProductDeletionDeliveryState {
  if (deliveries.every((delivery) => delivery.status === "acked")) {
    return "delivered"
  }
  return deliveryAttemptCount > 0 ? "partial" : "pending"
}

function reconcileJob(
  job: ProductDeletionDeliveryJob,
  timestamp: number,
  retryDelayMs: number
): ProductDeletionDeliveryJob {
  const state = deriveDeliveryState(job.relayDelivery, job.deliveryAttemptCount)
  return {
    ...job,
    state,
    nextRetryAt: state === "delivered" ? undefined : timestamp + retryDelayMs,
    updatedAt: timestamp,
  }
}

async function markDeliveryRunStarted(
  repository: ProductDeletionOutboxRepository,
  id: string,
  leaseOwner: string,
  timestamp: number,
  retryDelayMs: number
): Promise<ProductDeletionDeliveryJob> {
  return repository.update(id, (current) => {
    if (current.deliveryLeaseOwner !== leaseOwner) return current
    return reconcileJob(
      {
        ...current,
        deliveryAttemptCount: current.deliveryAttemptCount + 1,
        retryCount: Math.max(0, current.deliveryAttemptCount),
        lastAttemptAt: timestamp,
      },
      timestamp,
      retryDelayMs
    )
  })
}

async function markRelayAttemptStarted(
  repository: ProductDeletionOutboxRepository,
  id: string,
  relayUrl: string,
  leaseOwner: string,
  timestamp: number,
  leaseMs: number
): Promise<ProductDeletionDeliveryJob> {
  return repository.update(id, (current) => {
    if (current.deliveryLeaseOwner !== leaseOwner) return current
    return {
      ...current,
      relayDelivery: current.relayDelivery.map((delivery) =>
        delivery.relayUrl === relayUrl && delivery.status !== "acked"
          ? {
              ...delivery,
              status: "pending",
              attemptCount: delivery.attemptCount + 1,
              lastAttemptAt: timestamp,
            }
          : delivery
      ),
      deliveryLeaseExpiresAt: timestamp + leaseMs,
      updatedAt: timestamp,
    }
  })
}

async function markRelayOutcome(
  repository: ProductDeletionOutboxRepository,
  id: string,
  relayUrl: string,
  leaseOwner: string,
  status: Exclude<ProductDeletionRelayDeliveryStatus, "pending">,
  timestamp: number,
  retryDelayMs: number
): Promise<ProductDeletionDeliveryJob> {
  return repository.update(id, (current) => {
    const currentDelivery = current.relayDelivery.find(
      (delivery) => delivery.relayUrl === relayUrl
    )
    // ACK evidence is monotonic. A stale timeout/rejection from another tab
    // must never overwrite it. A late ACK may safely upgrade durable state.
    if (
      currentDelivery?.status === "acked" ||
      (current.deliveryLeaseOwner !== leaseOwner && status !== "acked")
    ) {
      return current
    }
    const relayDelivery = current.relayDelivery.map((delivery) => {
      if (delivery.relayUrl !== relayUrl) return delivery

      return {
        ...delivery,
        status,
        ...(status === "acked" ? { acknowledgedAt: timestamp } : {}),
        ...(status === "rejected" ? { rejectedAt: timestamp } : {}),
        ...(status === "timed_out" ? { timedOutAt: timestamp } : {}),
      }
    })
    return reconcileJob({ ...current, relayDelivery }, timestamp, retryDelayMs)
  })
}

async function claimDeliveryLease(
  repository: ProductDeletionOutboxRepository,
  id: string,
  leaseOwner: string,
  timestamp: number,
  leaseMs: number,
  forceRecovery: boolean
): Promise<ProductDeletionDeliveryJob> {
  return repository.update(id, (current) => {
    if (current.state === "delivered") return current
    if (
      current.deliveryLeaseOwner &&
      current.deliveryLeaseOwner !== leaseOwner &&
      (current.deliveryLeaseExpiresAt ?? 0) > timestamp &&
      !forceRecovery
    ) {
      return current
    }
    return {
      ...current,
      deliveryLeaseOwner: leaseOwner,
      deliveryLeaseExpiresAt: timestamp + leaseMs,
      updatedAt: timestamp,
    }
  })
}

async function releaseDeliveryLease(
  repository: ProductDeletionOutboxRepository,
  id: string,
  leaseOwner: string
): Promise<ProductDeletionDeliveryJob> {
  return repository.update(id, (current) => {
    if (current.deliveryLeaseOwner !== leaseOwner) return current
    const released = { ...current }
    delete released.deliveryLeaseOwner
    delete released.deliveryLeaseExpiresAt
    return released
  })
}

const repositoryDeliveryLocks = new WeakMap<
  ProductDeletionOutboxRepository,
  Map<string, Promise<ProductDeletionDeliveryJob>>
>()

function getDeliveryLocks(
  repository: ProductDeletionOutboxRepository
): Map<string, Promise<ProductDeletionDeliveryJob>> {
  const existing = repositoryDeliveryLocks.get(repository)
  if (existing) return existing

  const created = new Map<string, Promise<ProductDeletionDeliveryJob>>()
  repositoryDeliveryLocks.set(repository, created)
  return created
}

async function deliverProductDeletionJobUnlocked(
  id: string,
  publisher: ProductDeletionRelayPublisher,
  options: ProductDeletionDeliveryOptions
): Promise<ProductDeletionDeliveryJob> {
  const repository = getRepository(options)
  const retryDelayMs = getRetryDelayMs(options)
  const leaseOwner = getDeliveryLeaseOwner(options)
  const leaseMs = getDeliveryLeaseMs(options)
  const stored = await repository.get(id)
  if (!stored) {
    throw new Error("Product deletion delivery job not found")
  }
  assertSignedDeletionEvent(stored.signedEvent)

  const claimed = await claimDeliveryLease(
    repository,
    id,
    leaseOwner,
    getNow(options),
    leaseMs,
    options.forceDeliveryLeaseRecovery === true
  )
  if (claimed.deliveryLeaseOwner !== leaseOwner) return claimed

  const outstandingRelayUrls = claimed.relayDelivery
    .filter((delivery) => delivery.status !== "acked")
    .map((delivery) => delivery.relayUrl)

  if (outstandingRelayUrls.length === 0) {
    await repository.update(id, (current) =>
      reconcileJob(current, getNow(options), retryDelayMs)
    )
    return await releaseDeliveryLease(repository, id, leaseOwner)
  }

  try {
    await markDeliveryRunStarted(
      repository,
      id,
      leaseOwner,
      getNow(options),
      retryDelayMs
    )

    for (const relayUrl of outstandingRelayUrls) {
      const attemptAt = getNow(options)
      const current = await markRelayAttemptStarted(
        repository,
        id,
        relayUrl,
        leaseOwner,
        attemptAt,
        leaseMs
      )
      const currentDelivery = current.relayDelivery.find(
        (delivery) => delivery.relayUrl === relayUrl
      )
      if (
        current.deliveryLeaseOwner !== leaseOwner ||
        currentDelivery?.status === "acked"
      ) {
        continue
      }
      const exactSignedEvent = cloneSignedEvent(current.signedEvent)

      let outcome: ProductDeletionPublisherResult
      try {
        outcome = await publisher({
          relayUrl,
          signedEvent: exactSignedEvent,
        })
      } catch {
        outcome = { status: "timed_out" }
      }

      const status =
        outcome.status === "acked" ||
        outcome.status === "rejected" ||
        outcome.status === "timed_out"
          ? outcome.status
          : "timed_out"

      await markRelayOutcome(
        repository,
        id,
        relayUrl,
        leaseOwner,
        status,
        getNow(options),
        retryDelayMs
      )
    }

    const completed = await repository.get(id)
    if (!completed) {
      throw new Error("Product deletion delivery job not found")
    }
    return await releaseDeliveryLease(repository, id, leaseOwner)
  } catch (error) {
    await releaseDeliveryLease(repository, id, leaseOwner).catch(() => {
      // An expired lease may already have been recovered by another worker.
    })
    throw error
  }
}

/**
 * Deliver or retry one durable job. Only relays without an ACK are retried, and
 * every attempt reuses the exact signed event loaded from the outbox.
 */
export async function deliverProductDeletionJob(
  id: string,
  publisher: ProductDeletionRelayPublisher,
  options: ProductDeletionDeliveryOptions = {}
): Promise<ProductDeletionDeliveryJob> {
  const repository = getRepository(options)
  const locks = getDeliveryLocks(repository)
  const active = locks.get(id)
  if (active) return active

  const delivery = deliverProductDeletionJobUnlocked(id, publisher, {
    ...options,
    repository,
  })
  locks.set(id, delivery)
  try {
    return await delivery
  } finally {
    if (locks.get(id) === delivery) locks.delete(id)
  }
}

/**
 * Load one durable job by id, including an already-delivered job.
 *
 * Explicit UI retries use this idempotent lookup because a background worker
 * can finish the job after the UI rendered but before the click is handled.
 */
export async function getProductDeletionDelivery(
  id: string,
  options: ProductDeletionDeliveryOptions = {}
): Promise<ProductDeletionDeliveryJob | undefined> {
  const job = await getRepository(options).get(id)
  return job ? cloneJob(job) : undefined
}

/**
 * Query durable pending/partial jobs after reload or browser startup.
 */
export async function getPendingProductDeletionDeliveries(
  options: ProductDeletionDeliveryOptions & { dueOnly?: boolean } = {}
): Promise<ProductDeletionDeliveryJob[]> {
  const timestamp = getNow(options)
  const jobs = await getRepository(options).listUndelivered()
  return jobs
    .filter(
      (job) =>
        !options.dueOnly ||
        ((job.nextRetryAt === undefined || job.nextRetryAt <= timestamp) &&
          (job.deliveryLeaseExpiresAt === undefined ||
            job.deliveryLeaseExpiresAt <= timestamp))
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    .map(cloneJob)
}

/**
 * Startup/background worker entry point. Jobs are independent, so one failure
 * does not prevent later durable jobs from being retried.
 */
export async function deliverPendingProductDeletions(
  publisher: ProductDeletionRelayPublisher,
  options: ProductDeletionDeliveryOptions = {}
): Promise<ProductDeletionDeliveryJob[]> {
  const jobs = await getPendingProductDeletionDeliveries({
    ...options,
    dueOnly: true,
  })
  const completed: ProductDeletionDeliveryJob[] = []
  for (const job of jobs) {
    try {
      completed.push(
        await deliverProductDeletionJob(job.id, publisher, options)
      )
    } catch {
      // Keep this job durable and continue. One corrupt/unavailable job must
      // never starve later deletion work.
    }
  }
  return completed
}
