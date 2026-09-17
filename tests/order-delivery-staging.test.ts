import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  beginOrderRelayDeliveryAttempt,
  recordOrderRelayDeliveryOutcomes,
  stageOrderRelayDelivery,
  OrderRelayDeliveryStageConflictError,
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type SignedPublicNostrEvent,
  type StagedOrderLifecycleInput,
} from "@conduit/core"

const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const RUMOR_ID = "c".repeat(64)
const RELAY = "wss://orders.conduit.market"
const WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", MERCHANT]],
    content: "encrypted-order",
  },
  Uint8Array.from([...new Uint8Array(31), 7])
) as SignedPublicNostrEvent
const OTHER_WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", MERCHANT]],
    content: "different-wrap",
  },
  Uint8Array.from([...new Uint8Array(31), 8])
) as SignedPublicNostrEvent
const WRONG_KIND_WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1,
    tags: [["p", MERCHANT]],
    content: "not-a-gift-wrap",
  },
  Uint8Array.from([...new Uint8Array(31), 9])
) as SignedPublicNostrEvent
const WRONG_RECIPIENT_WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", "d".repeat(64)]],
    content: "wrong-recipient",
  },
  Uint8Array.from([...new Uint8Array(31), 10])
) as SignedPublicNostrEvent

function lifecycleInput(
  overrides: Partial<StagedOrderLifecycleInput> = {}
): StagedOrderLifecycleInput {
  return {
    orderId: "order-id",
    createdAt: 10,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    checkoutMode: "pay_later",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    ...overrides,
  }
}

function memoryRepository(): {
  repository: OrderRelayDeliveryRepository
  read: () => OrderLifecycle | undefined
} {
  let value: OrderLifecycle | undefined
  return {
    repository: {
      get: async () => structuredClone(value),
      list: async () => (value ? [structuredClone(value)] : []),
      update: async (_orderId, updater) => {
        if (!value) return undefined
        value = updater(structuredClone(value))
        return structuredClone(value)
      },
      stage: async (record, assertCompatible) => {
        if (value) {
          assertCompatible(structuredClone(value))
          return { lifecycle: structuredClone(value), inserted: false }
        }
        value = structuredClone(record)
        return { lifecycle: structuredClone(value), inserted: true }
      },
    },
    read: () => structuredClone(value),
  }
}

const prepared = {
  rumorId: RUMOR_ID,
  signedRecipientWrap: WRAP,
  route: "declared_inbox" as const,
  relayPlan: [{ relayUrl: RELAY, source: "declared" as const }],
}

describe("durable order delivery staging", () => {
  it("rejects invalid identities, wrap scope, relay aliases, and guest plaintext", async () => {
    for (const candidate of [
      { ...prepared, rumorId: "not-a-rumor-id" },
      { ...prepared, signedRecipientWrap: WRONG_KIND_WRAP },
      { ...prepared, signedRecipientWrap: WRONG_RECIPIENT_WRAP },
      {
        ...prepared,
        relayPlan: [
          { relayUrl: RELAY, source: "declared" as const },
          { relayUrl: `${RELAY}/`, source: "declared" as const },
        ],
      },
    ]) {
      await expect(
        stageOrderRelayDelivery(
          {
            lifecycle: lifecycleInput(),
            prepared: candidate,
            leaseOwner: "foreground",
          },
          { repository: memoryRepository().repository, now: () => 100 }
        )
      ).rejects.toThrow()
    }

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput({
            buyerIdentityKind: "guest_ephemeral",
            shippingAddress: {
              name: "Private Buyer",
              street: "1 Private Way",
              city: "Private",
              postalCode: "00000",
              country: "US",
            },
          }),
          prepared,
          leaseOwner: "foreground",
        },
        { repository: memoryRepository().repository, now: () => 100 }
      )
    ).rejects.toThrow("plaintext guest")
  })

  it("inserts once and accepts only the identical immutable order", async () => {
    const store = memoryRepository()
    const first = await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared,
        leaseOwner: "foreground",
      },
      { repository: store.repository, now: () => 100 }
    )

    expect(first.inserted).toBe(true)
    expect(first.lifecycle.orderDeliveryStatus).toBe("pending")
    expect(first.lifecycle.orderRelayDelivery).toMatchObject({
      rumorId: RUMOR_ID,
      signedRecipientWrap: {
        id: WRAP.id,
        content: WRAP.content,
        sig: WRAP.sig,
      },
      route: "declared_inbox",
      deliveryAttemptCount: 0,
      deliveryAttemptGeneration: 0,
      relayDelivery: [
        {
          relayUrl: RELAY,
          status: "pending",
          attemptCount: 0,
          attemptGeneration: 0,
        },
      ],
    })

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput(),
          prepared,
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).resolves.toMatchObject({ inserted: false })

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput({ totalSats: 2 }),
          prepared,
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).rejects.toBeInstanceOf(OrderRelayDeliveryStageConflictError)

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput(),
          prepared: {
            ...prepared,
            signedRecipientWrap: OTHER_WRAP,
          },
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).rejects.toBeInstanceOf(OrderRelayDeliveryStageConflictError)
  })

  it("commits attempt fencing before outcomes and makes ACK absorbing", async () => {
    const store = memoryRepository()
    await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared,
        leaseOwner: "foreground",
      },
      { repository: store.repository, now: () => 100 }
    )
    const first = await beginOrderRelayDeliveryAttempt(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        relayUrls: [RELAY],
      },
      { repository: store.repository, now: () => 110 }
    )

    expect(first.generationsByRelay[RELAY]).toBe(1)
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]).toMatchObject({
      status: "pending",
      attemptCount: 1,
      attemptGeneration: 1,
      lastAttemptAt: 110,
    })

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        wrapId: first.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "timed_out",
            generation: first.generationsByRelay[RELAY]!,
          },
        ],
      },
      { repository: store.repository, now: () => 120 }
    )
    const second = await beginOrderRelayDeliveryAttempt(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        relayUrls: [RELAY],
      },
      { repository: store.repository, now: () => 130 }
    )

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        wrapId: first.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "rejected",
            generation: first.generationsByRelay[RELAY]!,
          },
        ],
      },
      { repository: store.repository, now: () => 140 }
    )
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "pending"
    )

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        wrapId: first.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "acked",
            generation: first.generationsByRelay[RELAY]!,
          },
        ],
        releaseLease: true,
      },
      { repository: store.repository, now: () => 150 }
    )
    expect(second.generationsByRelay[RELAY]).toBe(2)
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        wrapId: second.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "timed_out",
            generation: second.generationsByRelay[RELAY]!,
          },
        ],
      },
      { repository: store.repository, now: () => 160 }
    )
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
  })

  it("does not begin an attempt when the buyer changes during the durable claim", async () => {
    const store = memoryRepository()
    await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared,
        leaseOwner: "foreground",
      },
      { repository: store.repository, now: () => 100 }
    )
    let current = true
    const repository: OrderRelayDeliveryRepository = {
      ...store.repository,
      update: async (orderId, updater) => {
        current = false
        return await store.repository.update(orderId, updater)
      },
    }

    await expect(
      beginOrderRelayDeliveryAttempt(
        {
          orderId: "order-id",
          buyerPubkey: BUYER,
          leaseOwner: "foreground",
          relayUrls: [RELAY],
          shouldContinue: () => current,
        },
        { repository, now: () => 110 }
      )
    ).rejects.toThrow("could not acquire")
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]).toMatchObject({
      status: "pending",
      attemptCount: 0,
      attemptGeneration: 0,
    })
  })

  it("fences forged, stale, duplicate, wrong-wrap, and wrong-lease outcomes", async () => {
    const secondRelay = "wss://backup-orders.conduit.market"
    const store = memoryRepository()
    await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared: {
          ...prepared,
          relayPlan: [
            prepared.relayPlan[0]!,
            { relayUrl: secondRelay, source: "declared" },
          ],
        },
        leaseOwner: "worker-a",
      },
      { repository: store.repository, now: () => 100 }
    )
    const first = await beginOrderRelayDeliveryAttempt(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        relayUrls: [RELAY],
      },
      { repository: store.repository, now: () => 110 }
    )
    const firstGeneration = first.generationsByRelay[RELAY]!

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        wrapId: "f".repeat(64),
        outcomes: [
          { relayUrl: RELAY, status: "acked", generation: firstGeneration },
        ],
      },
      { repository: store.repository, now: () => 111 }
    )
    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        wrapId: first.wrapId,
        outcomes: [
          { relayUrl: RELAY, status: "acked", generation: Number.NaN },
          { relayUrl: secondRelay, status: "acked", generation: 1 },
        ],
      },
      { repository: store.repository, now: () => 112 }
    )
    expect(store.read()?.orderDeliveryStatus).toBe("pending")
    expect(store.read()?.orderRelayDelivery?.relayDelivery).toMatchObject([
      { relayUrl: RELAY, status: "pending" },
      { relayUrl: secondRelay, status: "pending", attemptCount: 0 },
    ])

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        wrapId: first.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "timed_out",
            generation: firstGeneration,
          },
        ],
        releaseLease: true,
      },
      { repository: store.repository, now: () => 120 }
    )
    const second = await beginOrderRelayDeliveryAttempt(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-b",
        relayUrls: [RELAY],
      },
      { repository: store.repository, now: () => 130 }
    )
    const secondGeneration = second.generationsByRelay[RELAY]!

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        wrapId: second.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "rejected",
            generation: secondGeneration,
          },
        ],
      },
      { repository: store.repository, now: () => 140 }
    )
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "pending"
    )

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "worker-a",
        wrapId: second.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "acked",
            generation: firstGeneration,
          },
          {
            relayUrl: RELAY,
            status: "timed_out",
            generation: secondGeneration,
          },
        ],
        releaseLease: true,
      },
      { repository: store.repository, now: () => 150 }
    )
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
    expect(store.read()?.orderRelayDelivery?.deliveryLeaseOwner).toBe(
      "worker-b"
    )
  })
})
