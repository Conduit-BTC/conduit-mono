import { describe, expect, it } from "bun:test"
import {
  recordOrderRelayDeliveryUpdate,
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
          relayUrl: "wss://acked.conduit.market",
          source: "compatibility_registry",
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 1,
        },
        {
          relayUrl: "wss://failed.conduit.market",
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
  it("merges first-attempt outcomes without widening the staged plan", async () => {
    const staged = lifecycle({ orderDeliveryStatus: "pending" })
    staged.orderRelayDelivery!.relayDelivery =
      staged.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "pending",
        attemptCount: 0,
        acknowledgedAt: undefined,
        timedOutAt: undefined,
      }))
    staged.orderRelayDelivery!.deliveryAttemptCount = 0
    const store = repository(staged)
    const update = structuredClone(staged.orderRelayDelivery!)
    update.deliveryAttemptCount = 1
    update.relayDelivery[0] = {
      ...update.relayDelivery[0]!,
      status: "acked",
      attemptCount: 1,
      acknowledgedAt: 100,
    }
    update.relayDelivery[1] = {
      ...update.relayDelivery[1]!,
      status: "timed_out",
      attemptCount: 1,
      timedOutAt: 100,
    }

    await recordOrderRelayDeliveryUpdate("order-id", update, {
      repository: store.repository,
      now: () => 100,
    })

    expect(store.read().orderDeliveryStatus).toBe("sent")
    expect(
      store
        .read()
        .orderRelayDelivery?.relayDelivery.map((target) => target.status)
    ).toEqual(["acked", "timed_out"])

    const widened = structuredClone(update)
    widened.relayDelivery.push({
      relayUrl: "wss://new.conduit.market",
      source: "declared",
      status: "acked",
      attemptCount: 1,
    })
    await expect(
      recordOrderRelayDeliveryUpdate("order-id", widened, {
        repository: store.repository,
        now: () => 101,
      })
    ).rejects.toThrow("does not match the staged plan")
    expect(store.read().orderRelayDelivery?.relayDelivery).toHaveLength(2)
  })

  it("keeps an ACK monotonic when a stale first-attempt update arrives", async () => {
    const store = repository(lifecycle())
    const stale = structuredClone(store.read().orderRelayDelivery!)
    stale.relayDelivery[0] = {
      ...stale.relayDelivery[0]!,
      status: "timed_out",
      attemptCount: 2,
      timedOutAt: 100,
    }

    await recordOrderRelayDeliveryUpdate("order-id", stale, {
      repository: store.repository,
      now: () => 100,
    })

    expect(store.read().orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
  })

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
      "wss://failed.conduit.market",
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

  it("never replays persisted remote delivery targets on private networks", async () => {
    const unsafe = lifecycle()
    unsafe.orderRelayDelivery!.relayDelivery = [
      {
        relayUrl: "wss://127.0.0.1:8080/inbox",
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
      {
        relayUrl: "wss://192.168.1.10/inbox",
        source: "recipient_nip65",
        status: "timed_out",
        attemptCount: 1,
      },
      {
        relayUrl: "wss://retry.conduit.market/inbox",
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
    ]
    const store = repository(unsafe)
    const attempts: string[] = []

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        return "acked"
      },
    })

    expect(attempts).toEqual(["wss://retry.conduit.market/inbox"])
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

  it("allows a same-session guest to explicitly retry the exact wrap", async () => {
    const store = repository(
      lifecycle({ buyerIdentityKind: "guest_ephemeral" })
    )
    let attempts = 0

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      allowGuestExplicitRetry: true,
      now: () => 100,
      publisher: async () => {
        attempts += 1
        return "acked"
      },
    })

    expect(attempts).toBe(1)
    expect(store.read().orderDeliveryStatus).toBe("sent")
  })

  it("marks an expired zero-ACK delivery failed but preserves partial success", async () => {
    for (const [candidate, expected] of [
      [
        lifecycle({
          orderDeliveryStatus: "pending",
          orderRelayDelivery: {
            ...lifecycle().orderRelayDelivery!,
            relayDelivery: lifecycle().orderRelayDelivery!.relayDelivery.map(
              (target) => ({
                ...target,
                status: "timed_out" as const,
                acknowledgedAt: undefined,
              })
            ),
            expiresAt: 50,
          },
        }),
        "failed",
      ],
      [
        lifecycle({
          orderRelayDelivery: {
            ...lifecycle().orderRelayDelivery!,
            expiresAt: 50,
          },
        }),
        "sent",
      ],
    ] as const) {
      const store = repository(candidate)
      await retryOrderRelayDelivery("order-id", "buyer", {
        repository: store.repository,
        now: () => 100,
      })
      expect(store.read().orderDeliveryStatus).toBe(expected)
      expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
    }
  })
})
