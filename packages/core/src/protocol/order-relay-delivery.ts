import {
  db,
  type OrderDeliveryStatus,
  type OrderLifecycle,
  type OrderRelayDeliveryStatus,
} from "../db"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { deriveOrderLifecyclePhase } from "./order-lifecycle"
import { publishSignedEventToRelayOutcome } from "./relay-publish"
import type { SignedPublicNostrEvent } from "./signed-event"

const RETRY_DELAY_MS = 60_000
const LEASE_MS = 30_000

export interface OrderRelayDeliveryRepository {
  get(orderId: string): Promise<OrderLifecycle | undefined>
  list(buyerPubkey: string): Promise<OrderLifecycle[]>
  update(
    orderId: string,
    updater: (current: OrderLifecycle) => OrderLifecycle
  ): Promise<OrderLifecycle | undefined>
}

export type OrderRelayDeliveryPublishOutcome = {
  status: OrderRelayDeliveryStatus
  retryable: boolean
}

export type OrderRelayDeliveryPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
}) => Promise<OrderRelayDeliveryStatus | OrderRelayDeliveryPublishOutcome>

export interface RetryOrderRelayDeliveryOptions {
  repository?: OrderRelayDeliveryRepository
  publisher?: OrderRelayDeliveryPublisher
  now?: () => number
  leaseOwner?: string
  /** Same-session user action only; background resume always excludes guests. */
  allowGuestExplicitRetry?: boolean
  /** Cancels background work when the signed-in account/session changes. */
  signal?: AbortSignal
}

export interface RecordOrderRelayDeliveryUpdateOptions {
  repository?: OrderRelayDeliveryRepository
  now?: () => number
}

const dexieRepository: OrderRelayDeliveryRepository = {
  get: async (orderId) => db.orderLifecycles.get(orderId),
  list: async (buyerPubkey) =>
    db.orderLifecycles.where("buyerPubkey").equals(buyerPubkey).toArray(),
  update: async (orderId, updater) =>
    db.transaction("rw", db.orderLifecycles, async () => {
      const current = await db.orderLifecycles.get(orderId)
      if (!current) return undefined
      const next = updater(current)
      if (next === current) return current
      await db.orderLifecycles.put(next)
      return next
    }),
}

async function defaultPublisher(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
}): Promise<OrderRelayDeliveryPublishOutcome> {
  return await publishSignedEventToRelayOutcome({
    signedEvent: input.signedEvent,
    relayUrl: input.relayUrl,
    authorPubkey: input.signedEvent.pubkey,
  })
}

function nextLeaseOwner(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `order-delivery-${Date.now()}-${Math.random()}`
  )
}

function hasRetryablePublicTarget(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): boolean {
  return delivery.relayDelivery.some(
    (target) =>
      target.status !== "acked" &&
      target.retryable !== false &&
      normalizePublicWebSocketUrl(target.relayUrl) !== null
  )
}

function hasRelayAcknowledgement(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): boolean {
  return delivery.relayDelivery.some((target) => target.status === "acked")
}

export function getOrderRelayDeliveryStatus(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): Extract<OrderDeliveryStatus, "pending" | "sent" | "failed"> {
  if (hasRelayAcknowledgement(delivery)) return "sent"
  return hasRetryablePublicTarget(delivery) ? "pending" : "failed"
}

function normalizePublishOutcome(
  outcome: OrderRelayDeliveryStatus | OrderRelayDeliveryPublishOutcome
): OrderRelayDeliveryPublishOutcome {
  if (typeof outcome !== "string") return outcome
  return {
    status: outcome,
    retryable: outcome !== "acked",
  }
}

function withDerivedLifecyclePhase(lifecycle: OrderLifecycle): OrderLifecycle {
  return {
    ...lifecycle,
    phase: deriveOrderLifecyclePhase(lifecycle),
  }
}

function sameSignedWrap(
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

function assertSameStagedPlan(
  current: NonNullable<OrderLifecycle["orderRelayDelivery"]>,
  update: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): void {
  if (
    current.route !== update.route ||
    !sameSignedWrap(current.signedRecipientWrap, update.signedRecipientWrap) ||
    current.relayDelivery.length !== update.relayDelivery.length ||
    current.relayDelivery.some((target, index) => {
      const next = update.relayDelivery[index]
      return (
        !next ||
        target.relayUrl !== next.relayUrl ||
        target.source !== next.source
      )
    })
  ) {
    throw new Error(
      "Order relay delivery update does not match the staged plan."
    )
  }
}

/**
 * Merge a first-attempt outcome into the pre-publish checkpoint. The signed
 * bytes and relay plan are immutable, and an ACK can never be downgraded by a
 * late timeout or a competing worker.
 */
export async function recordOrderRelayDeliveryUpdate(
  orderId: string,
  update: NonNullable<OrderLifecycle["orderRelayDelivery"]>,
  options: RecordOrderRelayDeliveryUpdateOptions = {}
): Promise<OrderLifecycle | undefined> {
  const repository = options.repository ?? dexieRepository
  const now = options.now ?? Date.now
  return await repository.update(orderId, (current) => {
    const staged = current.orderRelayDelivery
    if (!staged) return current
    assertSameStagedPlan(staged, update)
    const relayDelivery = staged.relayDelivery.map((target, index) => {
      const next = update.relayDelivery[index]!
      if (target.status === "acked") {
        return {
          ...target,
          attemptCount: Math.max(target.attemptCount, next.attemptCount),
        }
      }
      if (target.retryable === false && next.status !== "acked") {
        return {
          ...target,
          attemptCount: Math.max(target.attemptCount, next.attemptCount),
        }
      }
      return {
        ...target,
        ...next,
        relayUrl: target.relayUrl,
        source: target.source,
        attemptCount: Math.max(target.attemptCount, next.attemptCount),
      }
    })
    const timestamp = now()
    const nextDelivery = {
      ...staged,
      relayDelivery,
      deliveryAttemptCount: Math.max(
        staged.deliveryAttemptCount,
        update.deliveryAttemptCount
      ),
      retryCount: Math.max(staged.retryCount, update.retryCount),
      updatedAt: Math.max(staged.updatedAt, update.updatedAt, timestamp),
    }
    const orderDeliveryStatus = getOrderRelayDeliveryStatus(nextDelivery)
    const hasRetryableTarget = hasRetryablePublicTarget(nextDelivery)
    return withDerivedLifecyclePhase({
      ...current,
      orderDeliveryStatus,
      orderRelayDelivery: {
        ...nextDelivery,
        nextRetryAt: hasRetryableTarget ? update.nextRetryAt : undefined,
      },
      updatedAt: timestamp,
    })
  })
}

function finalizeExpiredDelivery(
  current: OrderLifecycle,
  timestamp: number
): OrderLifecycle {
  const delivery = current.orderRelayDelivery
  if (!delivery || delivery.expiresAt > timestamp) return current
  const finalized = { ...delivery }
  delete finalized.nextRetryAt
  delete finalized.deliveryLeaseOwner
  delete finalized.deliveryLeaseExpiresAt
  return withDerivedLifecyclePhase({
    ...current,
    orderDeliveryStatus: hasRelayAcknowledgement(delivery) ? "sent" : "failed",
    orderRelayDelivery: { ...finalized, updatedAt: timestamp },
    updatedAt: timestamp,
  })
}

async function releaseDeliveryLease(
  orderId: string,
  leaseOwner: string,
  repository: OrderRelayDeliveryRepository,
  now: () => number
): Promise<OrderLifecycle | undefined> {
  return await repository.update(orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (!delivery || delivery.deliveryLeaseOwner !== leaseOwner) return current
    const released = { ...delivery }
    delete released.deliveryLeaseOwner
    delete released.deliveryLeaseExpiresAt
    const timestamp = now()
    return {
      ...current,
      orderRelayDelivery: { ...released, updatedAt: timestamp },
      updatedAt: timestamp,
    }
  })
}

export async function retryOrderRelayDelivery(
  orderId: string,
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<OrderLifecycle | undefined> {
  const repository = options.repository ?? dexieRepository
  const publisher = options.publisher ?? defaultPublisher
  const now = options.now ?? Date.now
  const leaseOwner = options.leaseOwner ?? nextLeaseOwner()
  if (options.signal?.aborted) return await repository.get(orderId)
  const timestamp = now()

  const claimed = await repository.update(orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (
      options.signal?.aborted ||
      !delivery ||
      (current.buyerIdentityKind === "guest_ephemeral" &&
        !options.allowGuestExplicitRetry) ||
      current.buyerPubkey !== activeBuyerPubkey
    ) {
      return current
    }
    if (delivery.expiresAt <= timestamp) {
      return finalizeExpiredDelivery(current, timestamp)
    }
    if (
      !hasRetryablePublicTarget(delivery) ||
      (delivery.deliveryLeaseOwner &&
        delivery.deliveryLeaseOwner !== leaseOwner &&
        (delivery.deliveryLeaseExpiresAt ?? 0) > timestamp)
    ) {
      return current
    }
    return {
      ...current,
      orderRelayDelivery: {
        ...delivery,
        deliveryLeaseOwner: leaseOwner,
        deliveryLeaseExpiresAt: timestamp + LEASE_MS,
        deliveryAttemptCount: delivery.deliveryAttemptCount + 1,
        retryCount: delivery.retryCount + 1,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }
  })

  if (
    !claimed?.orderRelayDelivery ||
    claimed.orderRelayDelivery.deliveryLeaseOwner !== leaseOwner
  ) {
    return claimed
  }

  const signedEvent = claimed.orderRelayDelivery.signedRecipientWrap
  const outstanding = claimed.orderRelayDelivery.relayDelivery.filter(
    (target) =>
      target.status !== "acked" &&
      target.retryable !== false &&
      normalizePublicWebSocketUrl(target.relayUrl) !== null
  )

  for (const target of outstanding) {
    if (options.signal?.aborted) break
    const attemptedAt = now()
    let attemptAuthorized = false
    await repository.update(orderId, (current) => {
      const delivery = current.orderRelayDelivery
      if (
        options.signal?.aborted ||
        !delivery ||
        delivery.deliveryLeaseOwner !== leaseOwner
      ) {
        return current
      }
      const currentTarget = delivery.relayDelivery.find(
        (entry) => entry.relayUrl === target.relayUrl
      )
      if (
        !currentTarget ||
        currentTarget.status === "acked" ||
        currentTarget.retryable === false
      ) {
        return current
      }
      attemptAuthorized = true
      return {
        ...current,
        orderRelayDelivery: {
          ...delivery,
          relayDelivery: delivery.relayDelivery.map((entry) =>
            entry.relayUrl === target.relayUrl
              ? {
                  ...entry,
                  attemptCount: entry.attemptCount + 1,
                  lastAttemptAt: attemptedAt,
                }
              : entry
          ),
          deliveryLeaseExpiresAt: attemptedAt + LEASE_MS,
          updatedAt: Math.max(delivery.updatedAt, attemptedAt),
        },
        updatedAt: Math.max(current.updatedAt, attemptedAt),
      }
    })
    if (!attemptAuthorized) continue
    if (options.signal?.aborted) {
      await releaseDeliveryLease(orderId, leaseOwner, repository, now)
      return await repository.get(orderId)
    }

    let outcome: OrderRelayDeliveryPublishOutcome
    try {
      outcome = normalizePublishOutcome(
        await publisher({
          relayUrl: target.relayUrl,
          signedEvent: {
            ...signedEvent,
            tags: signedEvent.tags.map((tag) => [...tag]),
          },
        })
      )
    } catch {
      outcome = { status: "timed_out", retryable: true }
    }
    if (outcome.status === "pending") {
      outcome = { status: "timed_out", retryable: true }
    }

    await repository.update(orderId, (current) => {
      const delivery = current.orderRelayDelivery
      if (!delivery) return current
      const currentTarget = delivery.relayDelivery.find(
        (entry) => entry.relayUrl === target.relayUrl
      )
      // ACK evidence is monotonic. A stale timeout/rejection from a worker
      // whose lease was replaced must not overwrite the current worker. A
      // late ACK may still safely upgrade the durable delivery evidence.
      if (
        !currentTarget ||
        currentTarget.status === "acked" ||
        (currentTarget.retryable === false && outcome.status !== "acked") ||
        (delivery.deliveryLeaseOwner !== leaseOwner &&
          outcome.status !== "acked")
      ) {
        return current
      }
      const relayDelivery = delivery.relayDelivery.map((entry) => {
        if (entry.relayUrl !== target.relayUrl) return entry
        return {
          ...entry,
          status: outcome.status,
          retryable: outcome.retryable,
          ...(outcome.status === "acked"
            ? { acknowledgedAt: attemptedAt }
            : {}),
          ...(outcome.status === "rejected" ? { rejectedAt: attemptedAt } : {}),
          ...(outcome.status === "timed_out"
            ? { timedOutAt: attemptedAt }
            : {}),
        }
      })
      const nextDelivery = { ...delivery, relayDelivery }
      const orderDeliveryStatus = getOrderRelayDeliveryStatus(nextDelivery)
      const hasRetryableTarget = hasRetryablePublicTarget(nextDelivery)
      return withDerivedLifecyclePhase({
        ...current,
        orderDeliveryStatus,
        orderRelayDelivery: {
          ...nextDelivery,
          nextRetryAt: hasRetryableTarget
            ? Math.max(delivery.nextRetryAt ?? 0, attemptedAt + RETRY_DELAY_MS)
            : undefined,
          updatedAt: Math.max(delivery.updatedAt, attemptedAt),
        },
        updatedAt: Math.max(current.updatedAt, attemptedAt),
      })
    })
    if (options.signal?.aborted) break
  }

  return await releaseDeliveryLease(orderId, leaseOwner, repository, now)
}

export async function resumePendingOrderRelayDeliveries(
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<void> {
  const repository = options.repository ?? dexieRepository
  const now = options.now ?? Date.now
  if (options.signal?.aborted) return
  const timestamp = now()
  const lifecycles = await repository.list(activeBuyerPubkey)
  for (const lifecycle of lifecycles) {
    if (options.signal?.aborted) return
    const delivery = lifecycle.orderRelayDelivery
    if (
      delivery &&
      lifecycle.buyerIdentityKind !== "guest_ephemeral" &&
      delivery.expiresAt <= timestamp
    ) {
      await repository.update(lifecycle.orderId, (current) =>
        options.signal?.aborted
          ? current
          : finalizeExpiredDelivery(current, timestamp)
      )
      continue
    }
    if (
      !delivery ||
      lifecycle.buyerIdentityKind === "guest_ephemeral" ||
      (delivery.nextRetryAt ?? 0) > timestamp ||
      !hasRetryablePublicTarget(delivery)
    ) {
      continue
    }
    await retryOrderRelayDelivery(lifecycle.orderId, activeBuyerPubkey, {
      ...options,
      repository,
    }).catch(() => {
      // The exact encrypted wrap and per-relay state remain available for a
      // later bounded retry. One failed order must not starve other retries.
    })
  }
}
