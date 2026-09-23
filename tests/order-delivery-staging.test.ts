import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  beginOrderRelayDeliveryAttempt,
  OrderRelayDeliveryStageConflictError,
  recordOrderRelayDeliveryOutcomes,
  stageOrderRelayDelivery,
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type PreparedOrderRelayDelivery,
  type SignedPublicNostrEvent,
  type StagedOrderLifecycleInput,
} from "@conduit/core"

const BUYER = getPublicKey(generateSecretKey())
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const RUMOR_ID = "c".repeat(64)
const RELAY = "wss://orders.conduit.market"
const DECLARATION = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 10_050,
    tags: [["relay", RELAY]],
    content: "",
  },
  MERCHANT_SECRET
)
const WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", MERCHANT]],
    content: "encrypted-order",
  },
  generateSecretKey()
) as SignedPublicNostrEvent
const OTHER_WRAP = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", MERCHANT]],
    content: "different-encrypted-order",
  },
  generateSecretKey()
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

function prepared(
  overrides: Partial<PreparedOrderRelayDelivery> = {}
): PreparedOrderRelayDelivery {
  return {
    rumorId: RUMOR_ID,
    signedRecipientWrap: WRAP,
    route: "declared_inbox",
    routingAuthority: {
      eventId: DECLARATION.id,
      eventCreatedAt: DECLARATION.created_at,
      pubkey: DECLARATION.pubkey,
      kind: 10_050,
      relayUrls: [RELAY],
    },
    relayPlan: [{ relayUrl: RELAY, source: "declared" }],
    ...overrides,
  }
}

describe("durable order delivery staging", () => {
  it("stages the exact wrap, authority, plan, and initial lifecycle atomically", async () => {
    const store = memoryRepository()
    const first = await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared: prepared(),
        leaseOwner: "foreground",
      },
      { repository: store.repository, now: () => 100 }
    )

    expect(first.inserted).toBe(true)
    expect(first.lifecycle).toMatchObject({
      orderDeliveryStatus: "pending",
      orderDeliveryRoute: "declared_inbox",
      checkoutRecoveryPending: true,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
    })
    expect(first.lifecycle.orderRelayDelivery).toMatchObject({
      rumorId: RUMOR_ID,
      signedRecipientWrap: {
        id: WRAP.id,
        content: WRAP.content,
        sig: WRAP.sig,
      },
      route: "declared_inbox",
      routingAuthority: {
        eventId: DECLARATION.id,
        pubkey: MERCHANT,
        relayUrls: [RELAY],
      },
      deliveryAttemptCount: 0,
      deliveryAttemptGeneration: 0,
      relayDelivery: [
        {
          relayUrl: RELAY,
          source: "declared",
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
          prepared: prepared(),
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).resolves.toMatchObject({ inserted: false })

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput({ totalSats: 2 }),
          prepared: prepared(),
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).rejects.toBeInstanceOf(OrderRelayDeliveryStageConflictError)

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput(),
          prepared: prepared({ signedRecipientWrap: OTHER_WRAP }),
          leaseOwner: "another-document",
        },
        { repository: store.repository, now: () => 200 }
      )
    ).rejects.toBeInstanceOf(OrderRelayDeliveryStageConflictError)
  })

  it("rejects missing signed authority, widened plans, and guest plaintext", async () => {
    const invalidAuthority = prepared()
    invalidAuthority.routingAuthority = {
      ...invalidAuthority.routingAuthority,
      pubkey: BUYER,
    }
    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput(),
          prepared: invalidAuthority,
          leaseOwner: "foreground",
        },
        { repository: memoryRepository().repository, now: () => 100 }
      )
    ).rejects.toThrow("signed inbox authority")

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput(),
          prepared: prepared({
            relayPlan: [
              { relayUrl: RELAY, source: "declared" },
              {
                relayUrl: "wss://fallback.conduit.market",
                source: "declared",
              },
            ],
          }),
          leaseOwner: "foreground",
        },
        { repository: memoryRepository().repository, now: () => 100 }
      )
    ).rejects.toThrow("invalid declared order relay plan")

    await expect(
      stageOrderRelayDelivery(
        {
          lifecycle: lifecycleInput({
            buyerIdentityKind: "guest_ephemeral",
            guestContact: "private@example.com",
          }),
          prepared: prepared(),
          leaseOwner: "foreground",
        },
        { repository: memoryRepository().repository, now: () => 100 }
      )
    ).rejects.toThrow("plaintext guest")
  })

  it("fences attempts before I/O and makes every ACK absorbing", async () => {
    const store = memoryRepository()
    await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared: prepared(),
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
    const firstGeneration = first.generationsByRelay[RELAY]!

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
            generation: firstGeneration,
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
    const secondGeneration = second.generationsByRelay[RELAY]!

    await recordOrderRelayDeliveryOutcomes(
      {
        orderId: "order-id",
        buyerPubkey: BUYER,
        leaseOwner: "foreground",
        wrapId: second.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "rejected",
            generation: firstGeneration,
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
        wrapId: second.wrapId,
        outcomes: [
          {
            relayUrl: RELAY,
            status: "acked",
            generation: firstGeneration,
          },
        ],
        releaseLease: true,
      },
      { repository: store.repository, now: () => 150 }
    )
    expect(secondGeneration).toBe(2)
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.checkoutRecoveryPending).toBe(false)
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
            generation: secondGeneration,
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

  it("does not acquire an attempt after the active session changes", async () => {
    const store = memoryRepository()
    await stageOrderRelayDelivery(
      {
        lifecycle: lifecycleInput(),
        prepared: prepared(),
        leaseOwner: "foreground",
      },
      { repository: store.repository, now: () => 100 }
    )
    let sessionCurrent = true
    const repository: OrderRelayDeliveryRepository = {
      ...store.repository,
      update: async (orderId, updater) => {
        sessionCurrent = false
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
          shouldContinue: () => sessionCurrent,
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
})
