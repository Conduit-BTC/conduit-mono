import { NDKEvent } from "@nostr-dev-kit/ndk"
import { db, type OrderLifecycle, type OrderRelayDeliveryStatus } from "../db"
import { publishSignedEventToRelay } from "./relay-publish"
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

export type OrderRelayDeliveryPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
}) => Promise<OrderRelayDeliveryStatus>

export interface RetryOrderRelayDeliveryOptions {
  repository?: OrderRelayDeliveryRepository
  publisher?: OrderRelayDeliveryPublisher
  now?: () => number
  leaseOwner?: string
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
      await db.orderLifecycles.put(next)
      return next
    }),
}

async function defaultPublisher(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
}): Promise<OrderRelayDeliveryStatus> {
  const event = new NDKEvent(undefined, input.signedEvent)
  return await publishSignedEventToRelay({
    event,
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

export async function retryOrderRelayDelivery(
  orderId: string,
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<OrderLifecycle | undefined> {
  const repository = options.repository ?? dexieRepository
  const publisher = options.publisher ?? defaultPublisher
  const now = options.now ?? Date.now
  const leaseOwner = options.leaseOwner ?? nextLeaseOwner()
  const timestamp = now()

  const claimed = await repository.update(orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (
      !delivery ||
      current.buyerIdentityKind === "guest_ephemeral" ||
      current.buyerPubkey !== activeBuyerPubkey ||
      delivery.expiresAt <= timestamp ||
      delivery.relayDelivery.every((target) => target.status === "acked") ||
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
    (target) => target.status !== "acked"
  )

  for (const target of outstanding) {
    const attemptedAt = now()
    let outcome: OrderRelayDeliveryStatus
    try {
      outcome = await publisher({
        relayUrl: target.relayUrl,
        signedEvent: {
          ...signedEvent,
          tags: signedEvent.tags.map((tag) => [...tag]),
        },
      })
    } catch {
      outcome = "timed_out"
    }
    if (outcome === "pending") outcome = "timed_out"

    await repository.update(orderId, (current) => {
      const delivery = current.orderRelayDelivery
      if (!delivery) return current
      const relayDelivery = delivery.relayDelivery.map((entry) => {
        if (entry.relayUrl !== target.relayUrl || entry.status === "acked") {
          return entry
        }
        return {
          ...entry,
          status: outcome,
          attemptCount: entry.attemptCount + 1,
          lastAttemptAt: attemptedAt,
          ...(outcome === "acked" ? { acknowledgedAt: attemptedAt } : {}),
          ...(outcome === "rejected" ? { rejectedAt: attemptedAt } : {}),
          ...(outcome === "timed_out" ? { timedOutAt: attemptedAt } : {}),
        }
      })
      const allAcked = relayDelivery.every((entry) => entry.status === "acked")
      const anyAcked = relayDelivery.some((entry) => entry.status === "acked")
      return {
        ...current,
        orderDeliveryStatus: anyAcked ? "sent" : current.orderDeliveryStatus,
        orderRelayDelivery: {
          ...delivery,
          relayDelivery,
          nextRetryAt: allAcked ? undefined : attemptedAt + RETRY_DELAY_MS,
          updatedAt: attemptedAt,
        },
        updatedAt: attemptedAt,
      }
    })
  }

  return await repository.update(orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (!delivery || delivery.deliveryLeaseOwner !== leaseOwner) return current
    const released = { ...delivery }
    delete released.deliveryLeaseOwner
    delete released.deliveryLeaseExpiresAt
    return { ...current, orderRelayDelivery: released, updatedAt: now() }
  })
}

export async function resumePendingOrderRelayDeliveries(
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<void> {
  const repository = options.repository ?? dexieRepository
  const now = options.now ?? Date.now
  const timestamp = now()
  const lifecycles = await repository.list(activeBuyerPubkey)
  for (const lifecycle of lifecycles) {
    const delivery = lifecycle.orderRelayDelivery
    if (
      !delivery ||
      lifecycle.buyerIdentityKind === "guest_ephemeral" ||
      delivery.expiresAt <= timestamp ||
      (delivery.nextRetryAt ?? 0) > timestamp ||
      delivery.relayDelivery.every((target) => target.status === "acked")
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
