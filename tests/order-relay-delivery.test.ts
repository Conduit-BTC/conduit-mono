import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  emptyAccountNetworkLocalState,
  resumePendingOrderRelayDeliveries,
  retryOrderRelayDelivery,
  type OrderLifecycle,
  type OrderRelayDeliveryRepository,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { requiresAcceptedOrderPaymentContinuation } from "../apps/market/src/lib/checkout-order-attempt"

const BUYER = getPublicKey(generateSecretKey())
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const WRAP_SECRET = generateSecretKey()
const DEFAULT_RELAY_URLS = [
  "wss://acked.conduit.market",
  "wss://failed.conduit.market",
]
const routingDeclaration = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 10_050,
    tags: DEFAULT_RELAY_URLS.map((relayUrl) => ["relay", relayUrl]),
    content: "",
  },
  MERCHANT_SECRET
)
const signedWrap = finalizeEvent(
  {
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [["p", MERCHANT]],
    content: "encrypted-gift-wrap",
  },
  WRAP_SECRET
)

function lifecycle(overrides: Partial<OrderLifecycle> = {}): OrderLifecycle {
  return {
    orderId: "order-id",
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
    orderDeliveryStatus: "sent",
    orderDeliveryRoute: "declared_inbox",
    orderRelayDelivery: {
      rumorId: "f".repeat(64),
      signedRecipientWrap: signedWrap,
      route: "declared_inbox",
      routingAuthority: {
        eventId: routingDeclaration.id,
        eventCreatedAt: routingDeclaration.created_at,
        pubkey: routingDeclaration.pubkey,
        kind: 10_050,
        relayUrls: [...DEFAULT_RELAY_URLS],
      },
      relayDelivery: [
        {
          relayUrl: "wss://acked.conduit.market",
          source: "declared",
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 1,
        },
        {
          relayUrl: "wss://failed.conduit.market",
          source: "declared",
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
  it("keeps direct payment available after zero-ACK exact-wrap recovery", async () => {
    const initial = lifecycle({
      checkoutMode: "private_checkout",
      orderDeliveryStatus: "pending",
      checkoutRecoveryPending: true,
    })
    initial.orderRelayDelivery!.relayDelivery = DEFAULT_RELAY_URLS.map(
      (relayUrl) => ({
        relayUrl,
        source: "declared" as const,
        status: "timed_out" as const,
        attemptCount: 1,
        timedOutAt: 1,
      })
    )
    const store = repository(initial)
    const attempts: string[] = []

    const retried = await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
      leaseOwner: "direct-checkout-retry",
      now: () => 100,
      publisher: async ({ relayUrl, signedEvent }) => {
        attempts.push(relayUrl)
        expect(signedEvent).toEqual(structuredClone(signedWrap))
        return relayUrl === DEFAULT_RELAY_URLS[0] ? "acked" : "timed_out"
      },
    })

    expect(attempts).toEqual(DEFAULT_RELAY_URLS)
    expect(retried?.orderId).toBe(initial.orderId)
    expect(retried?.orderDeliveryStatus).toBe("sent")
    expect(retried?.checkoutRecoveryPending).toBe(true)
    expect(retried?.orderRelayDelivery?.relayDelivery).toMatchObject([
      { status: "acked" },
      { status: "timed_out" },
    ])
    expect(requiresAcceptedOrderPaymentContinuation(retried!)).toBe(true)

    const paymentStarted = await store.repository.update(
      "order-id",
      (current) => ({
        ...current,
        invoiceStatus: "manual_required",
        paymentStatus: "manual_required",
      })
    )
    expect(paymentStarted?.orderId).toBe(initial.orderId)
    expect(requiresAcceptedOrderPaymentContinuation(paymentStarted!)).toBe(
      false
    )
    expect(attempts).toEqual(DEFAULT_RELAY_URLS)
  })

  it("resumes a base-schema record on only saved, currently eligible targets", async () => {
    const eligibleRelay = "wss://eligible.conduit.market"
    const excludedRelay = "wss://excluded.conduit.market"
    const candidate = lifecycle()
    const delivery = candidate.orderRelayDelivery!
    delete delivery.rumorId
    delete delivery.routingAuthority
    delivery.relayDelivery = [
      delivery.relayDelivery[0]!,
      {
        relayUrl: excludedRelay,
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
      {
        relayUrl: eligibleRelay,
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
    ]
    const store = repository(candidate)
    const attempts: string[] = []
    const accountNetworkLocalStateRepository = {
      get: async (pubkey: string) => ({
        ...emptyAccountNetworkLocalState(pubkey),
        exclusions: [
          {
            relayUrl: excludedRelay,
            committedAt: 1,
            relayListFrontier: { eventId: null, createdAt: null },
            inboxDeclarationFrontier: { eventId: null, createdAt: null },
          },
        ],
      }),
    }

    await resumePendingOrderRelayDeliveries(BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository,
      leaseOwner: "legacy-worker",
      now: () => 100,
      publisher: async ({ relayUrl, signedEvent }) => {
        attempts.push(relayUrl)
        expect(signedEvent).toEqual(structuredClone(signedWrap))
        return "acked"
      },
    })

    expect(attempts).toEqual([eligibleRelay])
    expect(store.read().orderRelayDelivery?.expiresAt).toBe(10_000)
    expect(store.read().orderRelayDelivery?.relayDelivery).toMatchObject([
      { status: "acked" },
      { relayUrl: excludedRelay, status: "timed_out" },
      { relayUrl: eligibleRelay, status: "acked" },
    ])

    const widened = structuredClone(candidate)
    widened.orderRelayDelivery!.relayDelivery.push({
      relayUrl: "wss://new-target.example",
      source: "declared",
      status: "timed_out",
      attemptCount: 1,
    })
    const widenedStore = repository(widened)
    await resumePendingOrderRelayDeliveries(BUYER, {
      repository: widenedStore.repository,
      accountNetworkLocalStateRepository,
      leaseOwner: "widened-worker",
      now: () => 100,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        return "acked"
      },
    })
    expect(attempts).toEqual([eligibleRelay])

    const unsafe = structuredClone(candidate)
    unsafe.orderRelayDelivery!.relayDelivery[2]!.relayUrl =
      "wss://127.0.0.1:8080/inbox"
    await resumePendingOrderRelayDeliveries(BUYER, {
      repository: repository(unsafe).repository,
      accountNetworkLocalStateRepository,
      leaseOwner: "unsafe-legacy-worker",
      now: () => 100,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        return "acked"
      },
    })
    expect(attempts).toEqual([eligibleRelay])
  })

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
    expect(attempts[0]?.signedEvent).toEqual(structuredClone(signedWrap))
    expect(attempts[0]?.accountPubkey).toBe(BUYER)
    expect(
      store
        .read()
        .orderRelayDelivery?.relayDelivery.map((target) => target.status)
    ).toEqual(["acked", "acked"])
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
  })

  it("replays a partial compatibility order only to its original approved target", async () => {
    const relayUrls = ["wss://relay.conduit.market", "wss://relay.ditto.pub"]
    const candidate = lifecycle({ orderDeliveryRoute: "compatibility_order" })
    candidate.orderRelayDelivery = {
      ...candidate.orderRelayDelivery!,
      route: "compatibility_order",
      routingAuthority: undefined,
      compatibilityPlan: { relayUrls },
      relayDelivery: [
        {
          relayUrl: relayUrls[0]!,
          source: "compatibility_registry",
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 1,
        },
        {
          relayUrl: relayUrls[1]!,
          source: "recipient_nip65",
          status: "timed_out",
          attemptCount: 1,
          timedOutAt: 1,
        },
      ],
    }
    const store = repository(candidate)
    const attempts: string[] = []

    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
      leaseOwner: "compatibility-worker",
      now: () => 100,
      publisher: async (input) => {
        attempts.push(input.relayUrl)
        expect(input.signedEvent).toEqual(structuredClone(signedWrap))
        expect(input.appRelayUrls).toEqual([relayUrls[1]])
        expect(input.independentRelayUrls).toEqual([])
        return "acked"
      },
    })

    expect(attempts).toEqual([relayUrls[1]])
    expect(store.read().orderRelayDelivery?.relayDelivery).toMatchObject([
      { relayUrl: relayUrls[0], status: "acked", attemptCount: 1 },
      { relayUrl: relayUrls[1], status: "acked", attemptCount: 2 },
    ])

    const widened = lifecycle({ orderDeliveryRoute: "compatibility_order" })
    widened.orderRelayDelivery = {
      ...candidate.orderRelayDelivery,
      compatibilityPlan: {
        relayUrls: [...relayUrls, "wss://arbitrary.example"],
      },
      relayDelivery: [
        ...candidate.orderRelayDelivery.relayDelivery,
        {
          relayUrl: "wss://arbitrary.example",
          source: "compatibility_registry",
          status: "timed_out",
          attemptCount: 1,
        },
      ],
    }
    const unsafeStore = repository(widened)
    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: unsafeStore.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
      leaseOwner: "unsafe-worker",
      now: () => 100,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        return "acked"
      },
    })
    expect(attempts).toEqual([relayUrls[1]])
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
    unsafe.orderRelayDelivery!.routingAuthority!.relayUrls =
      unsafe.orderRelayDelivery!.relayDelivery.map(({ relayUrl }) => relayUrl)
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
    candidate.orderRelayDelivery!.routingAuthority!.relayUrls = [
      blockedRelayUrl,
      allowedRelayUrl,
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
        expect(signedEvent).toEqual(structuredClone(signedWrap))
        expect(accountPubkey).toBe(BUYER)
        expect(publisherRepository).toBe(accountNetworkLocalStateRepository)
        return "acked"
      },
    })

    expect(eligibilityReads).toBe(3)
    expect(attempts).toEqual([allowedRelayUrl])
    const targets = store.read().orderRelayDelivery?.relayDelivery
    expect(targets?.[0]).toMatchObject({
      relayUrl: blockedRelayUrl,
      status: "pending",
      attemptCount: 0,
    })
    expect(targets?.[1]).toMatchObject({
      relayUrl: allowedRelayUrl,
      status: "acked",
      attemptCount: 2,
    })
  })

  it("blocks App compatibility retries without suppressing declared inbox retries", async () => {
    const relayUrl = "wss://relay.conduit.market"
    const accountState = emptyAccountNetworkLocalState(BUYER, () => 1)
    accountState.routingPolicy = {
      ...accountState.routingPolicy,
      appRelaysEnabled: false,
      appRelaysTouched: true,
    }
    const accountNetworkLocalStateRepository = {
      get: async () => structuredClone(accountState),
    }

    for (const route of ["compatibility_order", "declared_inbox"] as const) {
      const candidate = lifecycle({ orderDeliveryRoute: route })
      candidate.orderRelayDelivery = {
        ...candidate.orderRelayDelivery!,
        route,
        routingAuthority:
          route === "declared_inbox"
            ? {
                ...candidate.orderRelayDelivery!.routingAuthority!,
                relayUrls: [relayUrl],
              }
            : undefined,
        compatibilityPlan:
          route === "compatibility_order"
            ? { relayUrls: [relayUrl] }
            : undefined,
        relayDelivery: [
          {
            relayUrl,
            source:
              route === "compatibility_order"
                ? "compatibility_registry"
                : "declared",
            status: "timed_out",
            attemptCount: 1,
          },
        ],
      }
      const store = repository(candidate)
      const attempts: Array<{
        relayUrl: string
        appRelayUrls?: readonly string[]
      }> = []

      await retryOrderRelayDelivery("order-id", BUYER, {
        repository: store.repository,
        accountNetworkLocalStateRepository,
        leaseOwner: `worker-${route}`,
        now: () => 100,
        publisher: async (input) => {
          attempts.push(input)
          return "acked"
        },
      })

      expect(attempts).toEqual(
        route === "compatibility_order"
          ? []
          : [expect.objectContaining({ relayUrl, appRelayUrls: [] })]
      )
    }
  })

  it("rechecks a local exclusion at the default publisher boundary", async () => {
    const relayUrl = "wss://policy-race.conduit.market"
    const candidate = lifecycle()
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        relayUrl,
        source: "declared",
        status: "timed_out",
        attemptCount: 1,
      },
    ]
    candidate.orderRelayDelivery!.routingAuthority!.relayUrls = [relayUrl]
    const store = repository(candidate)
    const enabledState = emptyAccountNetworkLocalState(BUYER, () => 1)
    const excludedState = structuredClone(enabledState)
    excludedState.exclusions = [
      {
        relayUrl,
        committedAt: 1,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
      },
    ]
    let policyReads = 0
    const accountNetworkLocalStateRepository = {
      get: async () => {
        policyReads += 1
        return structuredClone(policyReads >= 3 ? excludedState : enabledState)
      },
    }
    const openedRelayUrls: string[] = []
    const originalWebSocket = Object.getOwnPropertyDescriptor(
      globalThis,
      "WebSocket"
    )

    class UnexpectedRelaySocket {
      constructor(url: string) {
        openedRelayUrls.push(url)
        throw new Error("Unexpected relay write after the App cutoff changed")
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: UnexpectedRelaySocket,
    })

    try {
      await retryOrderRelayDelivery("order-id", BUYER, {
        repository: store.repository,
        accountNetworkLocalStateRepository,
        leaseOwner: "worker-policy-race",
        now: () => 100,
      })
    } finally {
      if (originalWebSocket) {
        Object.defineProperty(globalThis, "WebSocket", originalWebSocket)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    }

    expect(policyReads).toBeGreaterThanOrEqual(3)
    expect(openedRelayUrls).toEqual([])
    expect(store.read().orderRelayDelivery?.relayDelivery[0]).toMatchObject({
      relayUrl,
      status: "timed_out",
      attemptCount: 2,
    })
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

  it("replays a guest wrap only through an explicit live-session recovery", async () => {
    const guest = lifecycle({ buyerIdentityKind: "guest_ephemeral" })
    const store = repository(guest)
    const attempts: SignedPublicNostrEvent[] = []
    let sessionCurrent = true

    await retryOrderRelayDelivery("order-id", BUYER, {
      repository: store.repository,
      accountNetworkLocalStateRepository: allowAllAccountNetworkRepository,
      leaseOwner: "guest-foreground",
      allowGuest: true,
      shouldContinue: () => sessionCurrent,
      now: () => 100,
      publisher: async ({ signedEvent }) => {
        attempts.push(signedEvent)
        sessionCurrent = false
        return "acked"
      },
    })

    expect(attempts).toEqual([structuredClone(signedWrap)])
    expect(store.read().orderRelayDelivery?.relayDelivery).toMatchObject([
      { status: "acked" },
      { status: "acked" },
    ])
  })

  it("persists no failure strings or message plaintext", () => {
    const serialized = JSON.stringify(lifecycle().orderRelayDelivery)
    expect(serialized).toContain("encrypted-gift-wrap")
    expect(serialized).not.toContain("Order update")
    expect(serialized).not.toMatch(/failureMessage|invoice|nsec|privateKey/)
  })
})
