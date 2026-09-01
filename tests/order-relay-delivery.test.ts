import { describe, expect, it } from "bun:test"
import {
  deriveOrderLifecyclePhase,
  recordOrderRelayDeliveryUpdate,
  resumePendingOrderRelayDeliveries,
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
  writes: () => OrderLifecycle[]
} {
  let value = structuredClone(initial)
  const writes: OrderLifecycle[] = []
  return {
    repository: {
      get: async () => structuredClone(value),
      list: async () => [structuredClone(value)],
      update: async (_orderId, updater) => {
        value = updater(structuredClone(value))
        writes.push(structuredClone(value))
        return structuredClone(value)
      },
    },
    read: () => structuredClone(value),
    writes: () => structuredClone(writes),
  }
}

function expectEveryWriteToHaveDerivedPhase(
  store: ReturnType<typeof repository>
): void {
  for (const write of store.writes()) {
    expect(write.phase).toBe(deriveOrderLifecyclePhase(write))
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe("order relay delivery retry", () => {
  it("merges first-attempt outcomes without widening the staged plan", async () => {
    const staged = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
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
    expect(store.read().phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
    expect(
      store
        .read()
        .orderRelayDelivery?.relayDelivery.map((target) => target.status)
    ).toEqual(["acked", "timed_out"])
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBe(2)

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
    expect(store.read().phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("keeps a zero-ACK first attempt pending in one coherent write", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery =
      candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "pending",
        attemptCount: 0,
        acknowledgedAt: undefined,
        timedOutAt: undefined,
      }))
    const store = repository(candidate)
    const update = structuredClone(candidate.orderRelayDelivery!)
    update.deliveryAttemptCount = 1
    update.relayDelivery = update.relayDelivery.map((target) => ({
      ...target,
      status: "timed_out",
      attemptCount: 1,
      timedOutAt: 100,
    }))

    await recordOrderRelayDeliveryUpdate("order-id", update, {
      repository: store.repository,
      now: () => 100,
    })

    expect(store.read().orderDeliveryStatus).toBe("pending")
    expect(store.read().phase).toBe("pending")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("fails a zero-ACK first attempt when every immutable target is terminal", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery =
      candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "pending",
        attemptCount: 0,
        acknowledgedAt: undefined,
        timedOutAt: undefined,
      }))
    const store = repository(candidate)
    const update = structuredClone(candidate.orderRelayDelivery!)
    update.deliveryAttemptCount = 1
    update.nextRetryAt = 1_000
    update.relayDelivery = update.relayDelivery.map((target) => ({
      ...target,
      status: "rejected",
      retryable: false,
      attemptCount: 1,
      rejectedAt: 100,
    }))

    await recordOrderRelayDeliveryUpdate("order-id", update, {
      repository: store.repository,
      now: () => 100,
    })

    expect(store.read().orderDeliveryStatus).toBe("failed")
    expect(store.read().phase).toBe("failed")
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("never replays a terminal first attempt after a later timeout", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "pending",
        attemptCount: 0,
        timedOutAt: undefined,
      },
    ]
    candidate.orderRelayDelivery!.deliveryAttemptCount = 0
    const store = repository(candidate)

    const terminal = structuredClone(candidate.orderRelayDelivery!)
    terminal.deliveryAttemptCount = 1
    terminal.relayDelivery[0] = {
      ...terminal.relayDelivery[0]!,
      status: "rejected",
      retryable: false,
      attemptCount: 1,
      rejectedAt: 100,
    }
    await recordOrderRelayDeliveryUpdate("order-id", terminal, {
      repository: store.repository,
      now: () => 100,
    })

    const lateTimeout = structuredClone(candidate.orderRelayDelivery!)
    lateTimeout.deliveryAttemptCount = 2
    lateTimeout.nextRetryAt = 500
    lateTimeout.relayDelivery[0] = {
      ...lateTimeout.relayDelivery[0]!,
      status: "timed_out",
      retryable: true,
      attemptCount: 2,
      timedOutAt: 101,
    }
    await recordOrderRelayDeliveryUpdate("order-id", lateTimeout, {
      repository: store.repository,
      now: () => 101,
    })

    let publishes = 0
    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "terminal-worker",
      now: () => 102,
      publisher: async () => {
        publishes += 1
        return "acked"
      },
    })

    expect(publishes).toBe(0)
    expect(store.read().orderDeliveryStatus).toBe("failed")
    expect(store.read().phase).toBe("failed")
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
    expect(store.read().orderRelayDelivery?.relayDelivery[0]).toMatchObject({
      status: "rejected",
      retryable: false,
      attemptCount: 2,
    })
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("keeps sent provenance but stops retrying a terminal partial remainder", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery =
      candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "pending",
        attemptCount: 0,
        acknowledgedAt: undefined,
        timedOutAt: undefined,
      }))
    const store = repository(candidate)
    const update = structuredClone(candidate.orderRelayDelivery!)
    update.nextRetryAt = 1_000
    update.relayDelivery = [
      {
        ...update.relayDelivery[0]!,
        status: "acked",
        retryable: false,
        attemptCount: 1,
        acknowledgedAt: 100,
      },
      {
        ...update.relayDelivery[1]!,
        status: "rejected",
        retryable: false,
        attemptCount: 1,
        rejectedAt: 100,
      },
    ]

    await recordOrderRelayDeliveryUpdate("order-id", update, {
      repository: store.repository,
      now: () => 100,
    })

    expect(store.read().orderDeliveryStatus).toBe("sent")
    expect(store.read().phase).toBe("in_progress")
    expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
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

  it("never leases or republishes terminal immutable targets", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "failed",
      phase: "failed",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "rejected",
        retryable: false,
        rejectedAt: 50,
      },
    ]
    candidate.orderRelayDelivery!.nextRetryAt = undefined
    const store = repository(candidate)
    let attempts = 0

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async () => {
        attempts += 1
        return "acked"
      },
    })

    expect(attempts).toBe(0)
    expect(store.read()).toEqual(candidate)
  })

  it("stops a claimed retry before publish when its signed-in session aborts", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "timed_out",
        acknowledgedAt: undefined,
      },
    ]
    const store = repository(candidate)
    const controller = new AbortController()
    let updates = 0
    const repositoryWithAbort: OrderRelayDeliveryRepository = {
      ...store.repository,
      update: async (orderId, updater) => {
        const updated = await store.repository.update(orderId, updater)
        updates += 1
        if (updates === 2) controller.abort()
        return updated
      },
    }
    let attempts = 0

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: repositoryWithAbort,
      leaseOwner: "worker",
      now: () => 100,
      signal: controller.signal,
      publisher: async () => {
        attempts += 1
        return "acked"
      },
    })

    expect(attempts).toBe(0)
    expect(store.read().orderRelayDelivery?.deliveryLeaseOwner).toBeUndefined()
    expect(store.read().orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "timed_out"
    )
    expect(store.read().orderDeliveryStatus).toBe("pending")
  })

  it("does no delivery writes when recovery is already aborted", async () => {
    const store = repository(lifecycle())
    const controller = new AbortController()
    controller.abort()
    let attempts = 0

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      signal: controller.signal,
      publisher: async () => {
        attempts += 1
        return "acked"
      },
    })

    expect(attempts).toBe(0)
    expect(store.writes()).toEqual([])
  })

  it("preserves an in-flight ACK then stops before the next target after abort", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery =
      candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "timed_out",
        acknowledgedAt: undefined,
      }))
    const store = repository(candidate)
    const controller = new AbortController()
    const attempts: string[] = []

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      signal: controller.signal,
      publisher: async ({ relayUrl }) => {
        attempts.push(relayUrl)
        controller.abort()
        return "acked"
      },
    })

    expect(attempts).toEqual(["wss://acked.conduit.market"])
    expect(store.read().orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
    expect(store.read().orderRelayDelivery?.relayDelivery[1]?.status).toBe(
      "timed_out"
    )
    expect(store.read().orderRelayDelivery?.deliveryLeaseOwner).toBeUndefined()
  })

  it("atomically advances phase when a signed-in retry gains its first ACK", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery =
      candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
        ...target,
        status: "timed_out",
        acknowledgedAt: undefined,
      }))
    const store = repository(candidate)

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async () => "acked",
    })

    expect(store.read().orderDeliveryStatus).toBe("sent")
    expect(store.read().phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("never lets a concurrent retry timeout overwrite a first-attempt ACK", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "timed_out",
        acknowledgedAt: undefined,
      },
    ]
    candidate.orderRelayDelivery!.expiresAt = 100_000
    const store = repository(candidate)
    const retryOutcome = deferred<"timed_out">()
    const retryStarted = deferred<void>()

    const retry = retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker",
      now: () => 100,
      publisher: async () => {
        retryStarted.resolve()
        return await retryOutcome.promise
      },
    })
    await retryStarted.promise

    const firstAttemptAck = structuredClone(candidate.orderRelayDelivery!)
    firstAttemptAck.deliveryAttemptCount = 1
    firstAttemptAck.relayDelivery[0] = {
      ...firstAttemptAck.relayDelivery[0]!,
      status: "acked",
      attemptCount: 1,
      acknowledgedAt: 150,
    }
    await recordOrderRelayDeliveryUpdate("order-id", firstAttemptAck, {
      repository: store.repository,
      now: () => 150,
    })

    retryOutcome.resolve("timed_out")
    await retry

    expect(store.read().orderRelayDelivery?.relayDelivery[0]?.status).toBe(
      "acked"
    )
    expect(
      store.read().orderRelayDelivery?.relayDelivery[0]?.attemptCount
    ).toBe(2)
    expect(store.read().orderDeliveryStatus).toBe("sent")
    expect(store.read().phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("ignores a stale non-ACK outcome after another worker takes the lease", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "timed_out",
        acknowledgedAt: undefined,
      },
    ]
    candidate.orderRelayDelivery!.expiresAt = 100_000
    const store = repository(candidate)
    const firstOutcome = deferred<"timed_out">()
    const firstStarted = deferred<void>()

    const firstWorker = retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker-a",
      now: () => 100,
      publisher: async () => {
        firstStarted.resolve()
        return await firstOutcome.promise
      },
    })
    await firstStarted.promise

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker-b",
      now: () => 30_101,
      publisher: async () => "rejected",
    })
    const replacement = store.read()

    firstOutcome.resolve("timed_out")
    await firstWorker

    const final = store.read()
    expect(final.orderRelayDelivery?.relayDelivery[0]?.status).toBe("rejected")
    expect(final.orderRelayDelivery?.relayDelivery[0]?.rejectedAt).toBe(30_101)
    expect(final.orderRelayDelivery?.relayDelivery[0]?.attemptCount).toBe(3)
    expect(final.orderRelayDelivery?.nextRetryAt).toBe(
      replacement.orderRelayDelivery?.nextRetryAt
    )
    expect(final.orderRelayDelivery?.updatedAt).toBe(
      replacement.orderRelayDelivery?.updatedAt
    )
    expect(final.orderDeliveryStatus).toBe("pending")
    expect(final.phase).toBe("pending")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("allows a stale worker's late ACK to upgrade the current delivery", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "timed_out",
        acknowledgedAt: undefined,
      },
    ]
    candidate.orderRelayDelivery!.expiresAt = 100_000
    const store = repository(candidate)
    const firstOutcome = deferred<"acked">()
    const firstStarted = deferred<void>()

    const firstWorker = retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker-a",
      now: () => 100,
      publisher: async () => {
        firstStarted.resolve()
        return await firstOutcome.promise
      },
    })
    await firstStarted.promise

    await retryOrderRelayDelivery("order-id", "buyer", {
      repository: store.repository,
      leaseOwner: "worker-b",
      now: () => 30_101,
      publisher: async () => "timed_out",
    })
    firstOutcome.resolve("acked")
    await firstWorker

    const final = store.read()
    expect(final.orderRelayDelivery?.relayDelivery[0]?.status).toBe("acked")
    expect(final.orderRelayDelivery?.relayDelivery[0]?.attemptCount).toBe(3)
    expect(final.orderRelayDelivery?.nextRetryAt).toBeUndefined()
    expect(final.orderRelayDelivery?.updatedAt).toBe(30_101)
    expect(final.orderDeliveryStatus).toBe("sent")
    expect(final.phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
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

  it("refuses background replay and expiry mutation for a guest or different active account", async () => {
    for (const candidate of [
      lifecycle({
        buyerIdentityKind: "guest_ephemeral",
        orderDeliveryStatus: "pending",
        phase: "pending",
        orderRelayDelivery: {
          ...lifecycle().orderRelayDelivery!,
          expiresAt: 50,
        },
      }),
      lifecycle({
        orderDeliveryStatus: "pending",
        phase: "pending",
        orderRelayDelivery: {
          ...lifecycle().orderRelayDelivery!,
          expiresAt: 50,
        },
      }),
    ]) {
      const store = repository(candidate)
      const before = store.read()
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
      expect(store.read()).toEqual(before)
    }
  })

  it("persists no failure strings or message plaintext", () => {
    const serialized = JSON.stringify(lifecycle().orderRelayDelivery)
    expect(serialized).toContain("encrypted-gift-wrap")
    expect(serialized).not.toContain("Order update")
    expect(serialized).not.toMatch(/failureMessage|invoice|nsec|privateKey/)
  })

  it("allows a same-session guest to explicitly retry the exact wrap", async () => {
    const candidate = lifecycle({
      buyerIdentityKind: "guest_ephemeral",
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery!.relayDelivery = [
      {
        ...candidate.orderRelayDelivery!.relayDelivery[1]!,
        status: "timed_out",
        acknowledgedAt: undefined,
      },
    ]
    const store = repository(candidate)
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
    expect(store.read().phase).toBe("in_progress")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("marks an expired zero-ACK delivery failed but preserves partial success", async () => {
    for (const [candidate, expectedStatus, expectedPhase] of [
      [
        lifecycle({
          orderDeliveryStatus: "pending",
          phase: "pending",
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
        "failed",
      ],
      [
        lifecycle({
          orderDeliveryStatus: "pending",
          phase: "pending",
          orderRelayDelivery: {
            ...lifecycle().orderRelayDelivery!,
            expiresAt: 50,
          },
        }),
        "sent",
        "in_progress",
      ],
    ] as const) {
      const store = repository(candidate)
      await retryOrderRelayDelivery("order-id", "buyer", {
        repository: store.repository,
        now: () => 100,
      })
      expect(store.read().orderDeliveryStatus).toBe(expectedStatus)
      expect(store.read().phase).toBe(expectedPhase)
      expect(store.read().orderRelayDelivery?.nextRetryAt).toBeUndefined()
      expect(
        store.read().orderRelayDelivery?.deliveryLeaseOwner
      ).toBeUndefined()
      expect(
        store.read().orderRelayDelivery?.deliveryLeaseExpiresAt
      ).toBeUndefined()
      expectEveryWriteToHaveDerivedPhase(store)
    }
  })

  it("keeps payment and manual-invoice progress when zero-ACK delivery expires", async () => {
    for (const progress of [
      { invoiceStatus: "not_requested", paymentStatus: "paying" },
      { invoiceStatus: "received", paymentStatus: "paid" },
      { invoiceStatus: "manual_required", paymentStatus: "manual_required" },
    ] as const) {
      const candidate = lifecycle({
        orderDeliveryStatus: "pending",
        ...progress,
        phase: "in_progress",
      })
      candidate.orderRelayDelivery = {
        ...candidate.orderRelayDelivery!,
        relayDelivery: candidate.orderRelayDelivery!.relayDelivery.map(
          (target) => ({
            ...target,
            status: "timed_out",
            acknowledgedAt: undefined,
          })
        ),
        expiresAt: 50,
      }
      const store = repository(candidate)

      await retryOrderRelayDelivery("order-id", "buyer", {
        repository: store.repository,
        now: () => 100,
      })

      expect(store.read().orderDeliveryStatus).toBe("failed")
      expect(store.read().phase).toBe("in_progress")
      expectEveryWriteToHaveDerivedPhase(store)
    }
  })

  it("atomically finalizes an expired delivery during signed-in resume", async () => {
    const candidate = lifecycle({
      orderDeliveryStatus: "pending",
      phase: "pending",
    })
    candidate.orderRelayDelivery = {
      ...candidate.orderRelayDelivery!,
      relayDelivery: candidate.orderRelayDelivery!.relayDelivery.map(
        (target) => ({
          ...target,
          status: "timed_out",
          acknowledgedAt: undefined,
        })
      ),
      expiresAt: 50,
    }
    const store = repository(candidate)
    let attempts = 0

    await resumePendingOrderRelayDeliveries("buyer", {
      repository: store.repository,
      now: () => 100,
      publisher: async () => {
        attempts += 1
        return "acked"
      },
    })

    expect(attempts).toBe(0)
    expect(store.read().orderDeliveryStatus).toBe("failed")
    expect(store.read().phase).toBe("failed")
    expectEveryWriteToHaveDerivedPhase(store)
  })

  it("automatically retries signed-in orders but never guest orders", async () => {
    for (const buyerIdentityKind of ["signed_in", "guest_ephemeral"] as const) {
      const candidate = lifecycle({
        buyerIdentityKind,
        orderDeliveryStatus: "pending",
        phase: "pending",
      })
      candidate.orderRelayDelivery!.relayDelivery =
        candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
          ...target,
          status: "timed_out",
          acknowledgedAt: undefined,
        }))
      const store = repository(candidate)
      let attempts = 0

      await resumePendingOrderRelayDeliveries("buyer", {
        repository: store.repository,
        leaseOwner: "worker",
        now: () => 100,
        publisher: async () => {
          attempts += 1
          return "acked"
        },
      })

      expect(attempts).toBe(buyerIdentityKind === "signed_in" ? 2 : 0)
      expect(store.read().orderDeliveryStatus).toBe(
        buyerIdentityKind === "signed_in" ? "sent" : "pending"
      )
      expect(store.read().phase).toBe(
        buyerIdentityKind === "signed_in" ? "in_progress" : "pending"
      )
      expectEveryWriteToHaveDerivedPhase(store)
    }
  })

  it("keeps terminal phases sticky across late first-attempt ACKs", async () => {
    for (const terminalPhase of ["completed", "cancelled"] as const) {
      const candidate = lifecycle({
        orderDeliveryStatus: "pending",
        phase: terminalPhase,
      })
      candidate.orderRelayDelivery!.relayDelivery =
        candidate.orderRelayDelivery!.relayDelivery.map((target) => ({
          ...target,
          status: "pending",
          attemptCount: 0,
          acknowledgedAt: undefined,
          timedOutAt: undefined,
        }))
      const store = repository(candidate)
      const update = structuredClone(candidate.orderRelayDelivery!)
      update.relayDelivery[0] = {
        ...update.relayDelivery[0]!,
        status: "acked",
        attemptCount: 1,
        acknowledgedAt: 100,
      }

      await recordOrderRelayDeliveryUpdate("order-id", update, {
        repository: store.repository,
        now: () => 100,
      })

      expect(store.read().orderDeliveryStatus).toBe("sent")
      expect(store.read().phase).toBe(terminalPhase)
      expectEveryWriteToHaveDerivedPhase(store)
    }
  })
})
