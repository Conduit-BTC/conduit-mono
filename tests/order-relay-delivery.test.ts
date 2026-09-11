import { describe, expect, it } from "bun:test"
import {
  emptyAccountNetworkLocalState,
  retryOrderRelayDelivery,
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const BUYER = "e".repeat(64)

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
    buyerPubkey: BUYER,
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

const allowAllAccountNetworkRepository = {
  get: async () => undefined,
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
      accountPubkey: string
    }> = []

    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
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
    expect(attempts[0]?.accountPubkey).toBe(BUYER)
    expect(
      store
        .read()
        .orderRelayDelivery?.relayDelivery.map((target) => target.status)
    ).toEqual(["acked", "acked"])
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
  })

  it("never lets a later timeout overwrite an existing ACK", async () => {
    const store = repository(lifecycle())
    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
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

    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        return "acked"
      },
    })

    expect(attempts).toEqual(["wss://retry.conduit.market/inbox"])
  })

  it("re-reads local eligibility per target and leaves an excluded relay unresolved", async () => {
    const blockedRelayUrl = "wss://blocked.conduit.market"
    const allowedRelayUrl = "wss://allowed.conduit.market"
    const candidate = lifecycle()
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        relayUrl: blockedRelayUrl,
        source: "declared",
        status: "pending",
        attemptCount: 0,
      },
      {
        relayUrl: allowedRelayUrl,
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
    ]
    const store = repository(candidate)
    const accountState = emptyAccountNetworkLocalState(BUYER, () => 1)
    accountState.exclusions = [
      {
        relayUrl: blockedRelayUrl,
        committedAt: 1,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
      },
    ]
    let eligibilityReads = 0
    const accountNetworkLocalStateRepository = {
      get: async (pubkey: string) => {
        eligibilityReads += 1
        expect(pubkey).toBe(BUYER)
        return structuredClone(accountState)
      },
    }
    const attempts: string[] = []

    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async ({
        relayUrl,
        signedEvent,
        accountPubkey,
        accountNetworkLocalStateRepository: publisherRepository,
      }) => {
        attempts.push(relayUrl)
        expect(signedEvent).toEqual(signedWrap)
        expect(accountPubkey).toBe(BUYER)
        expect(publisherRepository).toBe(accountNetworkLocalStateRepository)
        return "acked"
      },
    })

    expect(eligibilityReads).toBe(3)
    expect(attempts).toEqual([allowedRelayUrl])
    expect(store.read().orderRelayDelivery?.relayDelivery).toMatchObject([
      { relayUrl: blockedRelayUrl, status: "pending", attemptCount: 0 },
      { relayUrl: allowedRelayUrl, status: "acked", attemptCount: 2 },
    ])
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
        candidate.buyerIdentityKind === "guest_ephemeral" ? BUYER : "other",
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
