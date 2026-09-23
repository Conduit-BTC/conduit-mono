import { config } from "../config"
import {
  db,
  type ProductListingDeliveryJob,
  type ProductListingDeliveryState,
  type ProductListingRelayDelivery,
  type ProductListingRelayDeliveryStatus,
  type ProductListingRelayTarget,
} from "../db"
import {
  filterEligibleAccountRelayUrls,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { EVENT_KINDS } from "./kinds"
import {
  getConfiguredIsolatedE2eRelayUrl,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const DEFAULT_RETRY_DELAY_MS = 30_000
const MAX_PAIR_DELIVERY_CONCURRENCY = 6
const MAX_JOB_DELIVERY_CONCURRENCY = 3

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        await operation(items[index]!, index)
      }
    })
  )
}

export interface PersistProductListingDeliveryInput {
  merchantPubkey: string
  signedEvents: readonly SignedPublicNostrEvent[]
  relayTargets: readonly ProductListingRelayTarget[]
  companionDeletionJobId?: string
  readyForDelivery?: boolean
}

export type ProductListingPublisherResult = {
  status: Exclude<ProductListingRelayDeliveryStatus, "pending">
}

/**
 * The edge adapter publishes one exact signed event to one persisted target.
 * It reports only structural outcomes so durable diagnostics remain
 * content-free.
 */
export type ProductListingRelayPublisher = (input: {
  relayUrl: string
  ownerSelected: boolean
  signedEvent: SignedPublicNostrEvent
  /** The revalidated author whose local whole-relay cutoff applies. */
  accountPubkey: string
  /** Active account allowed to exercise matching owner-selected ws:// authority. */
  authenticatedPubkey: string | null
  isAuthenticatedPubkeyCurrent?: (pubkey: string) => boolean
  ownerSelectedRelayUrls: string[]
  appRelayUrls: string[]
  personalRelayUrls: string[]
  independentRelayUrls: string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
}) => Promise<ProductListingPublisherResult>

/**
 * The small persistence boundary keeps delivery deterministic and testable.
 * Production uses Dexie; tests and non-browser runtimes may inject another
 * repository with equivalent atomic-update behavior.
 */
export interface ProductListingOutboxRepository {
  add(job: ProductListingDeliveryJob): Promise<void>
  get(id: string): Promise<ProductListingDeliveryJob | undefined>
  listUndelivered(): Promise<ProductListingDeliveryJob[]>
  update(
    id: string,
    updater: (current: ProductListingDeliveryJob) => ProductListingDeliveryJob
  ): Promise<ProductListingDeliveryJob>
}

export interface ProductListingDeliveryOptions {
  repository?: ProductListingOutboxRepository
  authenticatedPubkey?: string | null
  isAuthenticatedPubkeyCurrent?: (pubkey: string) => boolean
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  now?: () => number
  retryDelayMs?: number
  isCompanionDeletionDurable?: (
    eventId: string,
    listingJobId: string
  ) => Promise<boolean>
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

function cloneRelayTargets(
  targets: readonly ProductListingRelayTarget[]
): ProductListingRelayTarget[] {
  return targets.map((target) => ({ ...target }))
}

function cloneRelayDelivery(
  deliveries: readonly ProductListingRelayDelivery[]
): ProductListingRelayDelivery[] {
  return deliveries.map((delivery) => ({ ...delivery }))
}

function cloneJob(job: ProductListingDeliveryJob): ProductListingDeliveryJob {
  return {
    ...job,
    signedEvents: job.signedEvents.map(cloneSignedEvent),
    relayTargets: cloneRelayTargets(job.relayTargets),
    relayDelivery: cloneRelayDelivery(job.relayDelivery),
  }
}

function normalizedCompanionDeletionJobId(
  raw: string | undefined
): string | undefined {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Product listing companion deletion id is invalid")
  }
  return normalized
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

function signedEventsMatch(
  left: readonly SignedPublicNostrEvent[],
  right: readonly SignedPublicNostrEvent[]
): boolean {
  return (
    left.length === right.length &&
    left.every((event, index) =>
      right[index] ? signedEventMatches(event, right[index]) : false
    )
  )
}

function relayTargetsMatch(
  left: readonly ProductListingRelayTarget[],
  right: readonly ProductListingRelayTarget[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeMerchantPubkey(raw: string): string {
  const normalized = raw.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Product listing delivery requires a valid merchant pubkey")
  }
  return normalized
}

function normalizeRelayTargets(
  targets: readonly ProductListingRelayTarget[]
): ProductListingRelayTarget[] {
  if (targets.length === 0) {
    throw new Error(
      "Product listing delivery requires at least one relay target"
    )
  }

  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  const normalizedTargets = new Map<string, ProductListingRelayTarget>()

  for (const target of targets) {
    const normalized = tryNormalizeRelayUrl(target.relayUrl)
    if (!normalized.ok) {
      throw new Error("Product listing delivery relay target is invalid")
    }
    const isIsolatedE2eRelay = normalized.url === isolatedRelayUrl
    const isSecureRelay = normalized.url.startsWith("wss://")
    if (config.e2eRelayIsolationEnabled && !isIsolatedE2eRelay) {
      throw new Error(
        "Product listing delivery target must match the configured E2E relay"
      )
    }
    if (!isSecureRelay && !isIsolatedE2eRelay && !target.ownerSelected) {
      throw new Error(
        "Unencrypted product listing delivery targets must be owner selected"
      )
    }
    if (
      target.appRelay !== true &&
      target.personalRelay !== true &&
      target.independentRelay !== true
    ) {
      throw new Error("Product listing delivery target lacks source provenance")
    }

    const existing = normalizedTargets.get(normalized.url)
    normalizedTargets.set(normalized.url, {
      relayUrl: normalized.url,
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

  return Array.from(normalizedTargets.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, target]) => target)
}

function isApprovedPersistedRelayTarget(
  target: ProductListingRelayTarget | undefined
): target is ProductListingRelayTarget {
  if (!target) return false
  // Pre-provenance jobs cannot infer whether a relay came from a currently
  // disabled layer. Keep their signed bytes local instead of guessing.
  if (
    target.appRelay !== true &&
    target.personalRelay !== true &&
    target.independentRelay !== true
  ) {
    return false
  }
  const normalized = tryNormalizeRelayUrl(target.relayUrl)
  if (!normalized.ok || normalized.url !== target.relayUrl) return false
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (config.e2eRelayIsolationEnabled) {
    return !!isolatedRelayUrl && normalized.url === isolatedRelayUrl
  }
  return (
    normalized.url.startsWith("wss://") ||
    normalized.url === isolatedRelayUrl ||
    target.ownerSelected
  )
}

function assertSignedProductFamily(input: {
  merchantPubkey: string
  signedEvents: readonly SignedPublicNostrEvent[]
}): void {
  if (input.signedEvents.length === 0) {
    throw new Error("Product listing delivery requires a signed product family")
  }

  const eventIds = new Set<string>()
  for (const event of input.signedEvents) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      event.pubkey.toLowerCase() !== input.merchantPubkey ||
      !isValidSignedPublicNostrEvent(event)
    ) {
      throw new Error(
        "Product listing outbox requires valid signed kind-30402 events from one merchant"
      )
    }
    if (eventIds.has(event.id)) {
      throw new Error("Product listing delivery event ids must be unique")
    }
    eventIds.add(event.id)
  }
}

export function getProductListingDeliveryJobId(
  signedEvents: readonly SignedPublicNostrEvent[]
): string {
  if (signedEvents.length === 0) {
    throw new Error("Product listing delivery requires a signed product family")
  }
  return `product-listing:${signedEvents.map((event) => event.id).join(":")}`
}

const dexieProductListingOutboxRepository: ProductListingOutboxRepository = {
  async add(job) {
    await db.productListingOutbox.add(cloneJob(job))
  },

  async get(id) {
    const job = await db.productListingOutbox.get(id)
    return job ? cloneJob(job) : undefined
  },

  async listUndelivered() {
    const jobs = await db.productListingOutbox
      .filter((job) => job.state === "pending" || job.state === "partial")
      .toArray()
    return jobs.map(cloneJob)
  },

  async update(id, updater) {
    return db.transaction("rw", db.productListingOutbox, async () => {
      const current = await db.productListingOutbox.get(id)
      if (!current) {
        throw new Error("Product listing delivery job not found")
      }

      const next = updater(cloneJob(current))
      if (next.id !== id) {
        throw new Error("Product listing delivery job id is immutable")
      }
      if (
        next.merchantPubkey !== current.merchantPubkey ||
        !signedEventsMatch(next.signedEvents, current.signedEvents) ||
        !relayTargetsMatch(next.relayTargets, current.relayTargets) ||
        next.companionDeletionJobId !== current.companionDeletionJobId
      ) {
        throw new Error("Product listing delivery intent is immutable")
      }
      await db.productListingOutbox.put(cloneJob(next))
      return cloneJob(next)
    })
  },
}

function getRepository(
  options?: ProductListingDeliveryOptions
): ProductListingOutboxRepository {
  return options?.repository ?? dexieProductListingOutboxRepository
}

function getNow(options?: ProductListingDeliveryOptions): number {
  return options?.now?.() ?? Date.now()
}

function getRetryDelayMs(options?: ProductListingDeliveryOptions): number {
  const configured = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_RETRY_DELAY_MS
}

function getCurrentAuthenticatedPubkey(
  options: ProductListingDeliveryOptions
): string | null {
  const authenticatedPubkey = options.authenticatedPubkey ?? null
  if (!authenticatedPubkey) return null
  try {
    return options.isAuthenticatedPubkeyCurrent?.(authenticatedPubkey) === false
      ? null
      : authenticatedPubkey
  } catch {
    return null
  }
}

export function hasCommonAcknowledgedRelay(
  job: ProductListingDeliveryJob
): boolean {
  return (
    job.signedEvents.length > 0 &&
    job.relayTargets.some((target) =>
      job.signedEvents.every((event) =>
        job.relayDelivery.some(
          (delivery) =>
            delivery.eventId === event.id &&
            delivery.relayUrl === target.relayUrl &&
            delivery.status === "acked"
        )
      )
    )
  )
}

function isRetryableStatus(status: ProductListingRelayDeliveryStatus): boolean {
  return status === "pending" || status === "timed_out"
}

function deriveDeliveryState(
  job: ProductListingDeliveryJob
): ProductListingDeliveryState {
  if (hasCommonAcknowledgedRelay(job)) return "delivered"
  const hasRetryableDelivery = job.relayDelivery.some((delivery) =>
    isRetryableStatus(delivery.status)
  )
  if (!hasRetryableDelivery) return "failed"
  return job.deliveryAttemptCount > 0 ? "partial" : "pending"
}

function reconcileJob(
  job: ProductListingDeliveryJob,
  timestamp: number,
  retryDelayMs: number
): ProductListingDeliveryJob {
  const state = deriveDeliveryState(job)
  return {
    ...job,
    state,
    nextRetryAt:
      state === "pending" || state === "partial"
        ? timestamp + retryDelayMs
        : undefined,
    updatedAt: timestamp,
  }
}

/** Persist the exact signed family and immutable relay plan before delivery. */
export async function persistProductListingDelivery(
  input: PersistProductListingDeliveryInput,
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob> {
  const merchantPubkey = normalizeMerchantPubkey(input.merchantPubkey)
  assertSignedProductFamily({
    merchantPubkey,
    signedEvents: input.signedEvents,
  })
  const signedEvents = input.signedEvents.map(cloneSignedEvent)
  const relayTargets = normalizeRelayTargets(input.relayTargets)
  const companionDeletionJobId = normalizedCompanionDeletionJobId(
    input.companionDeletionJobId
  )
  const repository = getRepository(options)
  const id = getProductListingDeliveryJobId(signedEvents)
  const existing = await repository.get(id)

  if (existing) {
    if (
      existing.merchantPubkey !== merchantPubkey ||
      !signedEventsMatch(existing.signedEvents, signedEvents) ||
      !relayTargetsMatch(existing.relayTargets, relayTargets) ||
      existing.companionDeletionJobId !== companionDeletionJobId
    ) {
      throw new Error(
        "A product listing delivery job already exists with a different immutable intent"
      )
    }
    return cloneJob(existing)
  }

  const createdAt = getNow(options)
  const job: ProductListingDeliveryJob = {
    id,
    merchantPubkey,
    signedEvents,
    relayTargets,
    relayDelivery: signedEvents.flatMap((event) =>
      relayTargets.map(({ relayUrl }) => ({
        eventId: event.id,
        relayUrl,
        status: "pending" as const,
        attemptCount: 0,
      }))
    ),
    ...(companionDeletionJobId ? { companionDeletionJobId } : {}),
    readyForDelivery:
      input.readyForDelivery ?? companionDeletionJobId === undefined,
    state: "pending",
    deliveryAttemptCount: 0,
    nextRetryAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }

  try {
    await repository.add(job)
  } catch (error) {
    const raced = await repository.get(id)
    if (
      !raced ||
      raced.merchantPubkey !== merchantPubkey ||
      !signedEventsMatch(raced.signedEvents, signedEvents) ||
      !relayTargetsMatch(raced.relayTargets, relayTargets) ||
      raced.companionDeletionJobId !== companionDeletionJobId
    ) {
      throw error
    }
    return cloneJob(raced)
  }

  return cloneJob(job)
}

async function isCompanionDeletionDurable(
  eventId: string,
  listingJobId: string,
  options: ProductListingDeliveryOptions
): Promise<boolean> {
  if (options.isCompanionDeletionDurable) {
    return await options.isCompanionDeletionDurable(eventId, listingJobId)
  }
  const deletion = await db.productDeletionOutbox.get(eventId)
  return deletion?.companionListingJobId === listingJobId
}

/**
 * Make both halves of a mixed product mutation runnable only after the exact
 * companion deletion is durable and both local evidence writes have finished.
 */
export async function markProductListingDeliveryReady(
  id: string,
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob> {
  const repository = getRepository(options)
  const stored = await repository.get(id)
  if (!stored) throw new Error("Product listing delivery job not found")
  if (stored.readyForDelivery !== false) return cloneJob(stored)
  const companionDeletionJobId = stored.companionDeletionJobId
  if (
    companionDeletionJobId &&
    !(await isCompanionDeletionDurable(companionDeletionJobId, id, options))
  ) {
    throw new Error("Companion product deletion is not durable")
  }
  return await repository.update(id, (current) => {
    if (current.companionDeletionJobId !== companionDeletionJobId) {
      throw new Error("Product listing delivery intent is immutable")
    }
    if (current.readyForDelivery !== false) return current
    return { ...current, readyForDelivery: true, updatedAt: getNow(options) }
  })
}

async function markDeliveryRunStarted(
  repository: ProductListingOutboxRepository,
  id: string,
  timestamp: number,
  retryDelayMs: number
): Promise<ProductListingDeliveryJob> {
  return repository.update(id, (current) =>
    reconcileJob(
      {
        ...current,
        deliveryAttemptCount: current.deliveryAttemptCount + 1,
        lastAttemptAt: timestamp,
      },
      timestamp,
      retryDelayMs
    )
  )
}

async function markDeliveryAttemptStarted(
  repository: ProductListingOutboxRepository,
  id: string,
  eventId: string,
  relayUrl: string,
  timestamp: number
): Promise<ProductListingDeliveryJob> {
  return repository.update(id, (current) => ({
    ...current,
    relayDelivery: current.relayDelivery.map((delivery) =>
      delivery.eventId === eventId &&
      delivery.relayUrl === relayUrl &&
      isRetryableStatus(delivery.status)
        ? {
            ...delivery,
            status: "pending",
            attemptCount: delivery.attemptCount + 1,
            lastAttemptAt: timestamp,
          }
        : delivery
    ),
    updatedAt: timestamp,
  }))
}

async function markDeliveryOutcome(
  repository: ProductListingOutboxRepository,
  id: string,
  eventId: string,
  relayUrl: string,
  status: Exclude<ProductListingRelayDeliveryStatus, "pending">,
  timestamp: number,
  retryDelayMs: number
): Promise<ProductListingDeliveryJob> {
  return repository.update(id, (current) => {
    const relayDelivery = current.relayDelivery.map((delivery) => {
      if (delivery.eventId !== eventId || delivery.relayUrl !== relayUrl) {
        return delivery
      }
      // A durable ACK is the strongest outcome and must survive every stale
      // result. A later ACK may upgrade an earlier concurrent rejection, but
      // no timeout or rejection may erase an ACK.
      if (delivery.status === "acked") {
        return delivery
      }
      if (delivery.status === "rejected" && status !== "acked") {
        return delivery
      }
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

const repositoryDeliveryLocks = new WeakMap<
  ProductListingOutboxRepository,
  Map<string, Promise<ProductListingDeliveryJob>>
>()

function getDeliveryLocks(
  repository: ProductListingOutboxRepository
): Map<string, Promise<ProductListingDeliveryJob>> {
  const existing = repositoryDeliveryLocks.get(repository)
  if (existing) return existing

  const created = new Map<string, Promise<ProductListingDeliveryJob>>()
  repositoryDeliveryLocks.set(repository, created)
  return created
}

async function deliverProductListingJobUnlocked(
  id: string,
  publisher: ProductListingRelayPublisher,
  options: ProductListingDeliveryOptions
): Promise<ProductListingDeliveryJob> {
  const repository = getRepository(options)
  const retryDelayMs = getRetryDelayMs(options)
  const stored = await repository.get(id)
  if (!stored) throw new Error("Product listing delivery job not found")
  if (stored.readyForDelivery === false) return cloneJob(stored)
  assertSignedProductFamily(stored)

  const immutableSignedEvents = stored.signedEvents.map(cloneSignedEvent)
  const immutableRelayTargets = cloneRelayTargets(stored.relayTargets)
  const retryablePairs = stored.relayDelivery.filter((delivery) =>
    isRetryableStatus(delivery.status)
  )
  if (retryablePairs.length === 0) {
    return await repository.update(id, (current) =>
      reconcileJob(current, getNow(options), retryDelayMs)
    )
  }

  let deliveryRunStart: Promise<ProductListingDeliveryJob> | null = null
  const ensureDeliveryRunStarted = async () => {
    deliveryRunStart ??= markDeliveryRunStarted(
      repository,
      id,
      getNow(options),
      retryDelayMs
    )
    await deliveryRunStart
  }
  await runWithConcurrency(
    retryablePairs,
    MAX_PAIR_DELIVERY_CONCURRENCY,
    async (pair) => {
      const event = immutableSignedEvents.find(
        (candidate) => candidate.id === pair.eventId
      )
      const target = immutableRelayTargets.find(
        (candidate) => candidate.relayUrl === pair.relayUrl
      )
      if (!event || !target) {
        throw new Error("Product listing delivery matrix is inconsistent")
      }

      const authenticatedPubkey = getCurrentAuthenticatedPubkey(options)
      const ownerSelectedRelayUrls = target.ownerSelected
        ? [target.relayUrl]
        : []
      const appRelayUrls = target.appRelay === true ? [target.relayUrl] : []
      const personalRelayUrls =
        target.personalRelay === true ? [target.relayUrl] : []
      const independentRelayUrls =
        target.independentRelay === true ? [target.relayUrl] : []
      const eligibleRelayUrls = await filterEligibleAccountRelayUrls({
        accountPubkey: stored.merchantPubkey,
        authenticatedPubkey,
        candidateRelayUrls: [target.relayUrl],
        ownerSelectedRelayUrls,
        appRelayUrls,
        personalRelayUrls,
        independentRelayUrls,
        repository: options.accountNetworkLocalStateRepository,
      })
      if (eligibleRelayUrls.length === 0) return

      await ensureDeliveryRunStarted()

      const current = await markDeliveryAttemptStarted(
        repository,
        id,
        event.id,
        target.relayUrl,
        getNow(options)
      )
      if (
        !signedEventsMatch(current.signedEvents, immutableSignedEvents) ||
        !relayTargetsMatch(current.relayTargets, immutableRelayTargets) ||
        current.companionDeletionJobId !== stored.companionDeletionJobId
      ) {
        throw new Error("Product listing delivery intent is immutable")
      }
      const currentDelivery = current.relayDelivery.find(
        (delivery) =>
          delivery.eventId === event.id && delivery.relayUrl === target.relayUrl
      )
      if (!currentDelivery || !isRetryableStatus(currentDelivery.status)) {
        return
      }

      let outcome: ProductListingPublisherResult
      if (!isApprovedPersistedRelayTarget(target)) {
        outcome = { status: "rejected" }
      } else {
        try {
          outcome = await publisher({
            relayUrl: target.relayUrl,
            ownerSelected: target.ownerSelected,
            signedEvent: cloneSignedEvent(event),
            accountPubkey: stored.merchantPubkey,
            authenticatedPubkey,
            isAuthenticatedPubkeyCurrent: options.isAuthenticatedPubkeyCurrent,
            ownerSelectedRelayUrls,
            appRelayUrls,
            personalRelayUrls,
            independentRelayUrls,
            accountNetworkLocalStateRepository:
              options.accountNetworkLocalStateRepository,
          })
        } catch {
          const stillEligible = await filterEligibleAccountRelayUrls({
            accountPubkey: stored.merchantPubkey,
            authenticatedPubkey: getCurrentAuthenticatedPubkey(options),
            candidateRelayUrls: [target.relayUrl],
            ownerSelectedRelayUrls,
            appRelayUrls,
            personalRelayUrls,
            independentRelayUrls,
            repository: options.accountNetworkLocalStateRepository,
          })
          if (stillEligible.length === 0) return
          outcome = { status: "timed_out" }
        }
      }

      const status =
        outcome.status === "acked" ||
        outcome.status === "rejected" ||
        outcome.status === "timed_out"
          ? outcome.status
          : "timed_out"
      await markDeliveryOutcome(
        repository,
        id,
        event.id,
        target.relayUrl,
        status,
        getNow(options),
        retryDelayMs
      )
    }
  )

  const completed = await repository.get(id)
  if (!completed) throw new Error("Product listing delivery job not found")
  return cloneJob(completed)
}

/**
 * Deliver or retry one durable family. Only pending/time-out pairs are retried,
 * and every attempt reuses the exact signed bytes loaded from the outbox.
 */
export async function deliverProductListingJob(
  id: string,
  publisher: ProductListingRelayPublisher,
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob> {
  const repository = getRepository(options)
  const locks = getDeliveryLocks(repository)
  const active = locks.get(id)
  if (active) return active

  const delivery = deliverProductListingJobUnlocked(id, publisher, {
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

export async function getProductListingDelivery(
  id: string,
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob | undefined> {
  const job = await getRepository(options).get(id)
  return job ? cloneJob(job) : undefined
}

export async function getPendingProductListingDeliveries(
  options: ProductListingDeliveryOptions & { dueOnly?: boolean } = {}
): Promise<ProductListingDeliveryJob[]> {
  const timestamp = getNow(options)
  const jobs = await getRepository(options).listUndelivered()
  return jobs
    .filter(
      (job) =>
        (job.state === "pending" || job.state === "partial") &&
        job.readyForDelivery !== false &&
        (!options.dueOnly ||
          job.nextRetryAt === undefined ||
          job.nextRetryAt <= timestamp)
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    .map(cloneJob)
}

/** Load exact signed listing families staged locally but not yet armed for relay delivery. */
export async function getStagedProductListingDeliveries(
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob[]> {
  const jobs = await getRepository(options).listUndelivered()
  return jobs
    .filter((job) => job.readyForDelivery === false)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    .map(cloneJob)
}

/** Retry every due durable family without allowing one job to starve others. */
export async function deliverPendingProductListings(
  publisher: ProductListingRelayPublisher,
  options: ProductListingDeliveryOptions = {}
): Promise<ProductListingDeliveryJob[]> {
  const jobs = await getPendingProductListingDeliveries({
    ...options,
    dueOnly: true,
  })
  const completed: ProductListingDeliveryJob[] = []
  const completedByIndex: Array<ProductListingDeliveryJob | undefined> = []
  await runWithConcurrency(
    jobs,
    MAX_JOB_DELIVERY_CONCURRENCY,
    async (job, index) => {
      try {
        completedByIndex[index] = await deliverProductListingJob(
          job.id,
          publisher,
          options
        )
      } catch {
        // Keep this family durable and continue. One corrupt/unavailable job
        // must not starve later exact signed intents.
      }
    }
  )
  for (const job of completedByIndex) {
    if (job) completed.push(job)
  }
  return completed
}
