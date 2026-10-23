import { describe, expect, it, spyOn } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { ConduitDB, type OrderLifecycle } from "@conduit/core/db"
import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  GUEST_ORDER_LOCAL_RETENTION_MS,
  isGuestOrderDataExpired,
  OrderRelayDeliveryStageConflictError,
  retryOrderRelayDelivery,
  stageOrderRelayDelivery,
  type OrderRelayDeliveryRepository,
  type PreparedOrderRelayDelivery,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)

function fixture() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "guest-binding-checkout",
    orderId: "guest-binding-order",
    walletId: "guest-binding-wallet",
    merchantPubkey: MERCHANT,
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:guest-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "guest-binding-receive",
      paymentRequest: makeSignedBolt11Fixture({
        hrp: "lnbc1220n",
        createdAt: NOW / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(3)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 122,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 10,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        destination: {
          type: "lightning_address",
          value: "conduithodlings@strike.me",
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const order: OrderLifecycle = {
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "guest_ephemeral",
    checkoutMode: "private_checkout",
    orderDeliveryStatus: "sent",
    items: [],
    currency: "SATS",
    itemSubtotalSats: 10,
    shippingCostSats: 0,
    totalSats: 10,
    totalMsats: 10_000,
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: NOW + 1,
    updatedAt: NOW + 1,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
  }
  return { plan, order }
}

async function withDatabase(
  run: (context: {
    database: ConduitDB
    repository: DexieCheckoutSparkSettledRepository
    plan: ReturnType<typeof fixture>["plan"]
    order: OrderLifecycle
    clock: { now: number }
  }) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(`guest-router-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const clock = { now: NOW + 2 }
  const now = spyOn(Date, "now").mockImplementation(() => clock.now)
  try {
    const { plan, order } = fixture()
    const repository = new DexieCheckoutSparkSettledRepository(database)
    await repository.create(plan)
    await run({ database, repository, plan, order, clock })
  } finally {
    now.mockRestore()
    database.close()
    await database.delete()
  }
}

function deliveryFixture(database: ConduitDB) {
  const relayUrl = "wss://guest-orders.example.test"
  const prepared: PreparedOrderRelayDelivery = {
    rumorId: "e".repeat(64),
    signedRecipientWrap: finalizeEvent(
      {
        created_at: NOW / 1_000,
        kind: 1059,
        tags: [["p", MERCHANT]],
        content: "synthetic-encrypted-order-fixture",
      },
      generateSecretKey()
    ),
    route: "declared_inbox",
    routingAuthority: {
      eventId: "f".repeat(64),
      eventCreatedAt: NOW / 1_000,
      pubkey: MERCHANT,
      kind: 10_050,
      relayUrls: [relayUrl],
    },
    relayPlan: [{ relayUrl, source: "declared" }],
  }
  const repository: OrderRelayDeliveryRepository = {
    get: (orderId) => database.orderLifecycles.get(orderId),
    list: (buyerPubkey) =>
      database.orderLifecycles
        .where("buyerPubkey")
        .equals(buyerPubkey)
        .toArray(),
    update: (orderId, updater) =>
      database.transaction("rw", database.orderLifecycles, async () => {
        const current = await database.orderLifecycles.get(orderId)
        if (!current) return undefined
        const next = updater(current)
        await database.orderLifecycles.put(next)
        return next
      }),
    stage: (record, assertCompatible) =>
      database.transaction("rw", database.orderLifecycles, async () => {
        const current = await database.orderLifecycles.get(record.orderId)
        if (current) {
          assertCompatible(current)
          return { lifecycle: current, inserted: false }
        }
        await database.orderLifecycles.put(record)
        return { lifecycle: record, inserted: true }
      }),
  }
  return { prepared, repository }
}

describe("guest settled Spark buyer binding", () => {
  it("binds an exact delivered redacted guest row without converting it to an account", async () => {
    await withDatabase(async ({ database, repository, plan, order }) => {
      await database.orderLifecycles.put(order)
      let guards = 0
      const bound = await repository.bindBuyerOrder(plan, BUYER, () => {
        guards += 1
      })
      expect(guards).toBe(4)
      expect(bound.buyerPubkey === BUYER).toBe(true)
      expect(bound.planDigest === plan.planDigest).toBe(true)
      expect(Object.keys(bound).sort()).toEqual([
        "buyerPubkey",
        "checkoutId",
        "commerceTotalSats",
        "merchantPubkey",
        "orderId",
        "planDigest",
        "schemaVersion",
        "walletId",
      ])
      expect(
        (await database.orderLifecycles.get(order.orderId))?.buyerIdentityKind
      ).toBe("guest_ephemeral")
      expect(await repository.bindBuyerOrder(plan, BUYER, () => {})).toEqual(
        bound
      )
      expect(
        await repository.loadBuyerSettlement(
          plan.checkoutId,
          plan.planDigest,
          MERCHANT
        )
      ).toEqual({ status: "absent" })
    })
  })

  it("does not turn a caller's buyer assertion into missing delivered-order authority", async () => {
    await withDatabase(async ({ database, repository, plan }) => {
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
    })
  })

  it("uses the original guest session deadline without extending it from order creation", async () => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      order.guestSessionExpiresAt = NOW + 60_000
      await database.orderLifecycles.put(order)
      expect(
        (await repository.bindBuyerOrder(plan, BUYER, () => {})).buyerPubkey ===
          BUYER
      ).toBe(true)
      clock.now = order.guestSessionExpiresAt
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(
        (await database.orderLifecycles.get(order.orderId))
          ?.guestSessionExpiresAt
      ).toBe(NOW + 60_000)
    })
  })

  it.each([
    "expired",
    "nan",
    "fractional",
    "null",
    "string",
    "before_order",
    "extended",
  ] as const)("rejects an %s explicit guest deadline", async (change) => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      const deadline: unknown =
        change === "expired"
          ? clock.now
          : change === "nan"
            ? Number.NaN
            : change === "fractional"
              ? clock.now + 0.5
              : change === "null"
                ? null
                : change === "string"
                  ? String(clock.now + 60_000)
                  : change === "before_order"
                    ? order.createdAt
                    : order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS + 1
      Object.assign(order, { guestSessionExpiresAt: deadline })
      await database.orderLifecycles.put(order)
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
    })
  })

  it.each([
    "buyer",
    "merchant",
    "order",
    "checkout",
    "digest",
    "wallet",
    "amount",
    "currency",
    "mode",
    "pending",
    "failed",
    "unknown_identity",
    "missing_identity",
  ] as const)(
    "rejects the guest row's mismatched %s authority",
    async (change) => {
      await withDatabase(async ({ database, repository, plan, order }) => {
        const changed = {
          ...order,
          checkoutSparkRouterBinding: { ...order.checkoutSparkRouterBinding! },
        }
        if (change === "buyer") changed.buyerPubkey = MERCHANT
        else if (change === "merchant") changed.merchantPubkey = BUYER
        else if (change === "order") changed.orderId = "different-order"
        else if (change === "checkout")
          changed.checkoutSparkRouterBinding.checkoutId = "different-checkout"
        else if (change === "digest")
          changed.checkoutSparkRouterBinding.planDigest = "e".repeat(64)
        else if (change === "wallet")
          changed.checkoutSparkRouterBinding.walletId = "different-wallet"
        else if (change === "amount") changed.totalSats += 1
        else if (change === "currency")
          Object.assign(changed, { currency: "USD" })
        else if (change === "mode") changed.checkoutMode = "external_wallet"
        else if (change === "pending") changed.orderDeliveryStatus = "pending"
        else if (change === "failed") changed.orderDeliveryStatus = "failed"
        else if (change === "unknown_identity")
          Object.assign(changed, { buyerIdentityKind: "unknown" })
        else delete changed.buyerIdentityKind
        await database.orderLifecycles.put(changed)
        await expect(
          repository.bindBuyerOrder(plan, BUYER, () => {})
        ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
        expect(
          (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
            ?.buyerOrderBinding
        ).toBeUndefined()
      })
    }
  )

  it.each([
    "expired",
    "future",
    "before_plan",
    "missing",
    "nan",
    "clock",
  ] as const)("rejects %s guest lifecycle time", async (change) => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      if (change === "expired")
        clock.now = order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
      else if (change === "future") order.createdAt = clock.now + 1
      else if (change === "before_plan") order.createdAt = plan.createdAt - 1
      else if (change === "missing")
        Object.assign(order, { createdAt: undefined })
      else if (change === "nan") order.createdAt = Number.NaN
      else clock.now = Number.NaN
      await database.orderLifecycles.put(order)
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
    })
  })

  it.each(["shippingAddress", "contactNote", "guestContact"] as const)(
    "rejects retained guest %s plaintext",
    async (field) => {
      await withDatabase(async ({ database, repository, plan, order }) => {
        Object.assign(order, {
          [field]: field === "contactNote" ? "private fixture note" : {},
        })
        await database.orderLifecycles.put(order)
        await expect(
          repository.bindBuyerOrder(plan, BUYER, () => {})
        ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
        expect(
          (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
            ?.buyerOrderBinding
        ).toBeUndefined()
      })
    }
  )

  it.each([1, 3, 4])(
    "rolls back a guest binding revoked at guard %s",
    async (revokeAt) => {
      await withDatabase(async ({ database, repository, plan, order }) => {
        await database.orderLifecycles.put(order)
        let checks = 0
        await expect(
          repository.bindBuyerOrder(plan, BUYER, () => {
            checks += 1
            if (checks === revokeAt) throw new Error("guest session revoked")
          })
        ).rejects.toThrow("guest session revoked")
        expect(
          (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
            ?.buyerOrderBinding
        ).toBeUndefined()
      })
    }
  )

  it("rolls back when guest retention ends across the binding write", async () => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      await database.orderLifecycles.put(order)
      let checks = 0
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {
          checks += 1
          if (checks === 4)
            clock.now = order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(checks).toBe(4)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
    })
  })

  it("rolls back when the original guest deadline ends across the binding write", async () => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      order.guestSessionExpiresAt = NOW + 60_000
      await database.orderLifecycles.put(order)
      let checks = 0
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {
          checks += 1
          if (checks === 4) clock.now = order.guestSessionExpiresAt!
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(checks).toBe(4)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeUndefined()
    })
  })

  it("retains the plan and Merchant evidence when the guest expires and its local lifecycle is removed", async () => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      await database.orderLifecycles.put(order)
      await repository.bindBuyerOrder(plan, BUYER, () => {})
      const proof = {
        mode: "ordinary_v3" as const,
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        transferId: "guest-binding-credit",
        grossSats: 122,
        creditedSats: 121,
      }
      const settlement = await repository.recordMerchantCredit(
        plan,
        proof,
        NOW + 3
      )
      clock.now = order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      await database.orderLifecycles.delete(order.orderId)
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(
        (await repository.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("active")
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual(settlement)
      expect(
        (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
          ?.buyerOrderBinding
      ).toBeDefined()
      expect(await database.checkoutSparkRetirements.count()).toBe(0)
    })
  })

  it("rejects an existing authenticated witness for another buyer", async () => {
    await withDatabase(async ({ database, repository, plan, order }) => {
      await database.orderLifecycles.put(order)
      const binding = (await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      ))!
      await database.checkoutSparkPlanBindings.put({
        ...binding,
        orderWitness: {
          schemaVersion: 1,
          merchantPubkey: MERCHANT,
          buyerPubkey: MERCHANT,
          orderId: plan.orderId,
          rumorId: "e".repeat(64),
          contentHash: "f".repeat(64),
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
        },
      })
      await expect(
        repository.bindBuyerOrder(plan, BUYER, () => {})
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
    })
  })

  it("preserves signed-in binding without applying guest retention or redaction", async () => {
    await withDatabase(async ({ database, repository, plan, order, clock }) => {
      await database.orderLifecycles.put({
        ...order,
        buyerIdentityKind: "signed_in",
        contactNote: "signed-in fixture note",
      })
      clock.now = order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
      const bound = await repository.bindBuyerOrder(plan, BUYER, () => {})
      expect(bound.buyerPubkey === BUYER).toBe(true)
      expect(
        (await database.orderLifecycles.get(order.orderId))?.buyerIdentityKind
      ).toBe("signed_in")
    })
  })
})

describe("guest order original-session retention", () => {
  it("stages the original deadline immutably without extending local order delivery", async () => {
    await withDatabase(async ({ database, order, clock }) => {
      const { repository, prepared } = deliveryFixture(database)
      order.guestSessionExpiresAt = NOW + 60_000
      const input = { lifecycle: order, prepared, leaseOwner: "guest-fixture" }
      const options = { repository, now: () => clock.now }
      const first = await stageOrderRelayDelivery(input, options)
      expect(first.inserted).toBe(true)
      expect(first.lifecycle.guestSessionExpiresAt).toBe(NOW + 60_000)
      expect(first.lifecycle.orderRelayDelivery?.expiresAt).toBe(NOW + 60_000)
      expect((await stageOrderRelayDelivery(input, options)).inserted).toBe(
        false
      )
      for (const deadline of [undefined, NOW + 90_000]) {
        await expect(
          stageOrderRelayDelivery(
            {
              ...input,
              lifecycle: { ...order, guestSessionExpiresAt: deadline },
            },
            options
          )
        ).rejects.toBeInstanceOf(OrderRelayDeliveryStageConflictError)
      }
    })
  })

  it("does not retry a guest order at its original deadline even with allowGuest", async () => {
    await withDatabase(async ({ database, order, clock }) => {
      const { repository, prepared } = deliveryFixture(database)
      order.guestSessionExpiresAt = NOW + 60_000
      await stageOrderRelayDelivery(
        { lifecycle: order, prepared, leaseOwner: "guest-fixture" },
        { repository, now: () => clock.now }
      )
      clock.now = order.guestSessionExpiresAt
      let publishes = 0
      await retryOrderRelayDelivery(order.orderId, BUYER, {
        repository,
        now: () => clock.now,
        leaseOwner: "retry-fixture",
        allowGuest: true,
        accountNetworkLocalStateRepository: { get: async () => undefined },
        publisher: async () => {
          publishes += 1
          return "acked"
        },
      })
      expect(publishes).toBe(0)
      expect(
        (await database.orderLifecycles.get(order.orderId))?.orderRelayDelivery
          ?.deliveryAttemptCount
      ).toBe(0)
    })
  })

  it("keeps older rows bounded by their original 24-hour lifecycle deadline", () => {
    const { order } = fixture()
    const deadline = order.createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
    expect(isGuestOrderDataExpired(order, deadline - 1)).toBe(false)
    expect(isGuestOrderDataExpired(order, deadline)).toBe(true)
  })

  it("expires at the earlier valid session deadline, including the exact boundary", () => {
    const { order } = fixture()
    order.guestSessionExpiresAt = NOW + 60_000
    expect(
      isGuestOrderDataExpired(order, order.guestSessionExpiresAt - 1)
    ).toBe(false)
    expect(isGuestOrderDataExpired(order, order.guestSessionExpiresAt)).toBe(
      true
    )
    expect(isGuestOrderDataExpired(order, order.createdAt + 500, 500)).toBe(
      true
    )
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    NOW + 60_000.5,
    null,
    "1800000060000",
    NOW,
    NOW + GUEST_ORDER_LOCAL_RETENTION_MS + 2,
  ])("fails closed for malformed explicit deadline %#", (deadline) => {
    const { order } = fixture()
    Object.assign(order, { guestSessionExpiresAt: deadline })
    expect(isGuestOrderDataExpired(order, NOW + 2)).toBe(true)
  })

  it("does not apply guest expiry to a signed-in lifecycle", () => {
    const { order } = fixture()
    order.buyerIdentityKind = "signed_in"
    order.guestSessionExpiresAt = Number.NaN
    expect(
      isGuestOrderDataExpired(order, NOW + GUEST_ORDER_LOCAL_RETENTION_MS + 1)
    ).toBe(false)
  })
})
