import { describe, expect, it } from "bun:test"
import {
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import {
  DEFAULT_CHECKOUT_SHIPPING,
  readCheckoutShippingInitialization,
  reconcileCheckoutShippingSessionForOrderDelivery,
} from "../apps/market/src/lib/checkout-session"
import { retryOrderDeliveryFromOrders } from "../apps/market/src/lib/order-delivery-retry"

const signedWrap: SignedPublicNostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: 1059,
  tags: [["p", "c".repeat(64)]],
  content: "encrypted-gift-wrap",
  sig: "d".repeat(128),
}

function checkoutSessionStorage(): Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function queuedGuestOrder(orderId: string, expiresAt: number): OrderLifecycle {
  return {
    orderId,
    buyerPubkey: "guest-buyer",
    buyerIdentityKind: "guest_ephemeral",
    merchantPubkey: "merchant",
    checkoutMode: "pay_later",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "pending",
    orderDeliveryRoute: "compatibility_order",
    orderRelayDelivery: {
      signedRecipientWrap: signedWrap,
      route: "compatibility_order",
      relayDelivery: [
        {
          relayUrl: "wss://relay.conduit.market",
          source: "compatibility_registry",
          status: "timed_out",
          attemptCount: 1,
          timedOutAt: 1,
        },
      ],
      deliveryAttemptCount: 1,
      retryCount: 0,
      nextRetryAt: 2,
      createdAt: 1,
      updatedAt: 1,
      expiresAt,
    },
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "pending",
    createdAt: 1,
    updatedAt: 1,
  }
}

function repository(initial: OrderLifecycle): OrderRelayDeliveryRepository {
  let value = structuredClone(initial)
  return {
    get: async () => structuredClone(value),
    list: async () => [structuredClone(value)],
    update: async (_orderId, updater) => {
      value = updater(structuredClone(value))
      return structuredClone(value)
    },
  }
}

describe("Orders guest delivery retry", () => {
  it("clears only the matching retained checkout draft after a retry ACK", async () => {
    const now = Date.now() - 1_000
    const matchingStorage = checkoutSessionStorage()
    const matchingDraft = {
      ...DEFAULT_CHECKOUT_SHIPPING,
      street: "Queued order street",
    }
    reconcileCheckoutShippingSessionForOrderDelivery(
      {
        orderId: "order-a",
        buyerIdentityKind: "guest_ephemeral",
        orderDeliveryStatus: "pending",
        value: matchingDraft,
      },
      matchingStorage,
      now
    )

    const delivered = await retryOrderDeliveryFromOrders(
      "order-a",
      "guest-buyer",
      {
        allowGuestExplicitRetry: true,
        leaseOwner: "orders-retry",
        now: () => now + 1,
        publisher: async () => "acked",
        repository: repository(queuedGuestOrder("order-a", now + 60_000)),
        shippingStorage: matchingStorage,
      }
    )

    expect(delivered?.orderDeliveryStatus).toBe("sent")
    expect(
      readCheckoutShippingInitialization(null, matchingStorage, now + 2, null)
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })

    const newerStorage = checkoutSessionStorage()
    const newerDraft = {
      ...DEFAULT_CHECKOUT_SHIPPING,
      street: "Newer order street",
    }
    reconcileCheckoutShippingSessionForOrderDelivery(
      {
        orderId: "order-a",
        buyerIdentityKind: "guest_ephemeral",
        orderDeliveryStatus: "pending",
        value: matchingDraft,
      },
      newerStorage,
      now
    )
    reconcileCheckoutShippingSessionForOrderDelivery(
      {
        orderId: "order-b",
        buyerIdentityKind: "guest_ephemeral",
        orderDeliveryStatus: "pending",
        value: newerDraft,
      },
      newerStorage,
      now + 1
    )

    await retryOrderDeliveryFromOrders("order-a", "guest-buyer", {
      allowGuestExplicitRetry: true,
      leaseOwner: "orders-retry-newer-draft",
      now: () => now + 2,
      publisher: async () => "acked",
      repository: repository(queuedGuestOrder("order-a", now + 60_000)),
      shippingStorage: newerStorage,
    })

    expect(
      readCheckoutShippingInitialization(null, newerStorage, now + 3, null)
    ).toEqual({ value: newerDraft, hasActiveDraft: true })
  })
})
