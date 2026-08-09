import { describe, expect, it } from "bun:test"
import {
  retryOrderRelayDelivery,
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const signedWrap: SignedPublicNostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: 1059,
  tags: [["p", "c".repeat(64)]],
  content: "encrypted-gift-wrap",
  sig: "d".repeat(128),
}

function lifecycle(overrides: Partial<OrderLifecycle> = {}): OrderLifecycle {
  return {
    orderId: "order-id",
    buyerPubkey: "buyer",
    buyerIdentityKind: "signed_in",
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
    orderDeliveryStatus: "sent",
    orderDeliveryRoute: "compatibility_order",
    orderRelayDelivery: {
      signedRecipientWrap: signedWrap,
      route: "compatibility_order",
      relayDelivery: [
        {
          relayUrl: "wss://acked.example",
          source: "compatibility_registry",
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 1,
        },
        {
          relayUrl: "wss://failed.example",
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
      expiresAt: 10_000,
    },
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function repository(initial: OrderLifecycle): {
  repository: OrderRelayDeliveryRepository
  read: () => OrderLifecycle
} {
  let value = structuredClone(initial)
  return {
    repository: {
      get: async () => structuredClone(value),
      list: async () => [structuredClone(value)],
      update: async (_orderId, updater) => {
        value = updater(structuredClone(value))
        return structuredClone(value)
      },
    },
    read: () => structuredClone(value),
  }
}

describe("order relay delivery retry", () => {
  it("replays the exact wrap only to non-ACKed targets and converges", async () => {
    const store = repository(lifecycle())
    const attempts: Array<{
      relayUrl: string
      signedEvent: SignedPublicNostrEvent
    }> = []

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async (input) => {
        attempts.push(input)
        return "acked"
      },
    })

    expect(attempts.map((attempt) => attempt.relayUrl)).toEqual([
      "wss://failed.example",
    ])
    expect(attempts[0]?.signedEvent).toEqual(signedWrap)
    expect(
      store
        .read()
        .orderRelayDelivery?.relayDelivery.map((target) => target.status)
    ).toEqual(["acked", "acked"])
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
  })

  it("never lets a later timeout overwrite an existing ACK", async () => {
    const store = repository(lifecycle())
    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async () => "timed_out",
    })

    expect(store.read().orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
    expect(
      store.read().orderRelayDelivery?.relayDelivery[0]?.attemptCount
    ).toBe(1)
  })

  it("refuses background replay for a guest or different active account", async () => {
    for (const candidate of [
      lifecycle({ buyerIdentityKind: "guest_ephemeral" }),
      lifecycle(),
    ]) {
      const store = repository(candidate)
      let attempts = 0
      await retryOrderRelayDelivery(
        "order-id",
        candidate.buyerIdentityKind === "guest_ephemeral" ? "buyer" : "other",
        {
          repository: store.repository,
          leaseOwner: "worker",
          now: () => 100,
          publisher: async () => {
            attempts += 1
            return "acked"
          },
        }
      )
      expect(attempts).toBe(0)
    }
  })

  it("persists no failure strings or message plaintext", () => {
    const serialized = JSON.stringify(lifecycle().orderRelayDelivery)
    expect(serialized).toContain("encrypted-gift-wrap")
    expect(serialized).not.toContain("Order update")
    expect(serialized).not.toMatch(/failureMessage|invoice|nsec|privateKey/)
  })
})
