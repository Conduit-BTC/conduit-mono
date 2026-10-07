import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import { ConduitDB } from "@conduit/core/db"
import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkRepository,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  fingerprintCheckoutSparkSettledLegIntent,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"

const CREATED_SECONDS = 1_800_000_000
const CREATED_AT = CREATED_SECONDS * 1_000
const EXPIRES_AT = (CREATED_SECONDS + 3_600) * 1_000
const MERCHANT = "a".repeat(64)
const SUPPLIER = "b".repeat(64)

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

const FUNDING_INVOICE = invoice(102_250, 1)

function plan(): CheckoutSparkSettledPlan {
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-settled-1",
    orderId: "order-settled-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-settled-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 100_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:sku-1`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 100_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: FUNDING_INVOICE,
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 102_250,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
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
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_SECONDS - 1,
          },
        },
        weightSats: 80_000,
      },
      {
        kind: "supplier",
        recipientId: SUPPLIER,
        destination: {
          type: "lightning_address",
          value: "supplier@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: CREATED_SECONDS - 1,
          },
        },
        weightSats: 20_000,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: {
            type: "conduit_allowlist",
            policy: "local_router_canary",
          },
        },
        weightSats: 2_100,
      },
    ],
  })
}

it("retains and digest-binds a frozen fiat source and rate without changing legacy plans", () => {
  const legacy = plan()
  const input = structuredClone(legacy)
  input.commerceQuote.pricing = {
    version: 1,
    rate: { rate: 100_000, fetchedAt: CREATED_AT, source: "mempool" },
  }
  input.commerceQuote.lines[0]!.sourcePrice = {
    amount: 100,
    currency: "USD",
    normalizedCurrency: "USD",
  }
  const frozen = freezeCheckoutSparkSettledPlan(input)
  expect(frozen.commerceQuote.pricing).toEqual(input.commerceQuote.pricing)
  expect(frozen.commerceQuote.lines[0]!.sourcePrice).toEqual(
    input.commerceQuote.lines[0]!.sourcePrice
  )
  expect(frozen.planDigest).not.toBe(legacy.planDigest)
  expect(restoreCheckoutSparkSettledPlan(frozen)).toEqual(frozen)
  const altered = structuredClone(frozen)
  altered.commerceQuote.pricing!.rate.rate += 1
  expect(() => restoreCheckoutSparkSettledPlan(altered)).toThrow()
  expect(plan().planDigest).toBe(legacy.planDigest)
})

it("retains frozen conversion evidence through v4 native treasury restoration", () => {
  const original = nativeTreasuryFixture().plan
  const quote = {
    ...original.commerceQuote,
    pricing: {
      version: 1 as const,
      rate: {
        rate: 100_000,
        fetchedAt: original.createdAt,
        source: "mempool" as const,
      },
    },
    lines: original.commerceQuote.lines.map((line) => ({
      ...line,
      sourcePrice: { amount: 1, currency: "USD", normalizedCurrency: "USD" },
    })),
  }
  const frozen = freezeCheckoutSparkSettledTreasuryPlan({
    ...original,
    commerceQuote: quote,
  })
  expect(frozen.schemaVersion).toBe(4)
  expect(frozen.planDigest).not.toBe(original.planDigest)
  expect(restoreCheckoutSparkSettledPlan(frozen).commerceQuote).toEqual(quote)
  const changed = structuredClone(frozen)
  changed.commerceQuote.lines[0]!.sourcePrice!.amount = 2
  expect(() => restoreCheckoutSparkSettledPlan(changed)).toThrow()
  expect(restoreCheckoutSparkSettledPlan(original).planDigest).toBe(
    original.planDigest
  )
})

/** A synthetic plan frozen by the pre-allowance v3 writer. */
function preAllowancePlan(): CheckoutSparkSettledPlan {
  const current = plan()
  const funding = {
    ...current.funding,
    paymentRequest: invoice(102_100, 4),
    paymentHash: "04".repeat(32),
    grossFundingSats: 102_100,
  }
  const canonical = [
    "conduit:checkout-spark-settled-plan:v3",
    current.schemaVersion,
    current.checkoutId,
    current.orderId,
    current.merchantPubkey,
    current.walletId,
    current.network,
    current.createdAt,
    current.takeoverAt,
    [
      current.commerceQuote.commerceTotalSats,
      current.commerceQuote.lines.map((line) => [
        line.productCoordinate,
        line.productEventId,
        line.merchantPubkey,
        line.quantity,
        line.unitMerchandiseSats,
        line.unitShippingSats,
        line.shippingOption
          ? [line.shippingOption.coordinate, line.shippingOption.eventId]
          : null,
      ]),
    ],
    [
      funding.requestId,
      funding.paymentRequest,
      funding.paymentHash,
      funding.receiverIdentityPublicKey,
      funding.grossFundingSats,
      funding.createdAt,
      funding.expiresAt,
    ],
    current.recipients.map((recipient) => [
      recipient.position,
      recipient.legId,
      recipient.kind,
      recipient.recipientId,
      recipient.destination.type,
      recipient.destination.value,
      recipient.destination.source.type === "signed_profile"
        ? [
            "signed_profile",
            recipient.destination.source.profileEventId,
            recipient.destination.source.profileEventCreatedAt,
          ]
        : ["conduit_allowlist", recipient.destination.source.policy],
      recipient.weightSats,
    ]),
  ]
  return {
    ...current,
    funding,
    planDigest: createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex"),
  }
}

function credited(amount = 102_050) {
  const frozen = plan()
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(frozen),
    {
      requestId: frozen.funding.requestId,
      paymentHash: frozen.funding.paymentHash,
      transferId: "spark-receive-1",
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossSats: frozen.funding.grossFundingSats,
      creditedSats: amount,
      observedAt: CREATED_AT + 1,
    }
  )
}

describe("checkout Spark settled plan and progress", () => {
  it("freezes exact event pickup revisions into the plan digest", () => {
    const original = plan()
    const organizer = "9".repeat(64)
    const pickup = {
      calendar: {
        coordinate: `31923:${organizer}:market`,
        eventId: "6".repeat(64),
      },
      collection: {
        coordinate: `30405:${organizer}:market`,
        eventId: "7".repeat(64),
      },
    }
    const input = {
      ...original,
      commerceQuote: {
        ...original.commerceQuote,
        lines: original.commerceQuote.lines.map((line) => ({
          ...line,
          shippingOption: {
            coordinate: `30406:${MERCHANT}:booth`,
            eventId: "8".repeat(64),
          },
          pickup,
        })),
      },
    }
    const frozen = freezeCheckoutSparkSettledPlan(input)
    expect(frozen.commerceQuote.lines[0]).toMatchObject({ pickup })
    expect(restoreCheckoutSparkSettledPlan(frozen)).toEqual(frozen)

    pickup.calendar.eventId = "5".repeat(64)
    expect(frozen.commerceQuote.lines[0]).toMatchObject({
      pickup: { calendar: { eventId: "6".repeat(64) } },
    })
    expect(freezeCheckoutSparkSettledPlan(input).planDigest).not.toBe(
      frozen.planDigest
    )
    const altered = structuredClone(frozen)
    Object.assign(altered.commerceQuote.lines[0]!, { pickup })
    expect(() => restoreCheckoutSparkSettledPlan(altered)).toThrow()
    const stripped = structuredClone(frozen)
    delete stripped.commerceQuote.lines[0]!.pickup
    expect(() => restoreCheckoutSparkSettledPlan(stripped)).toThrow()
  })

  it("rejects pickup references without one organizer and an authorized handler", () => {
    const original = plan()
    const organizer = "9".repeat(64)
    const line = {
      ...original.commerceQuote.lines[0]!,
      shippingOption: {
        coordinate: `30406:${MERCHANT}:booth`,
        eventId: "8".repeat(64),
      },
      pickup: {
        calendar: {
          coordinate: `31923:${organizer}:market`,
          eventId: "6".repeat(64),
        },
        collection: {
          coordinate: `30405:${organizer}:market`,
          eventId: "7".repeat(64),
        },
      },
    }
    const invalid = [
      { ...line, shippingOption: undefined },
      {
        ...line,
        shippingOption: {
          ...line.shippingOption,
          coordinate: `30406:${SUPPLIER}:other`,
        },
      },
      {
        ...line,
        pickup: {
          ...line.pickup,
          calendar: {
            ...line.pickup.calendar,
            coordinate: `30409:${organizer}:market`,
          },
        },
      },
      {
        ...line,
        pickup: {
          ...line.pickup,
          collection: {
            ...line.pickup.collection,
            coordinate: `30405:${MERCHANT}:market`,
          },
        },
      },
      {
        ...line,
        pickup: {
          ...line.pickup,
          collection: { ...line.pickup.collection, eventId: "invalid" },
        },
      },
    ]
    for (const changed of invalid) {
      expect(() =>
        freezeCheckoutSparkSettledPlan({
          ...original,
          commerceQuote: { ...original.commerceQuote, lines: [changed] },
        })
      ).toThrow()
    }
  })

  it("fingerprints every frozen payout intent field for a stale-review check", () => {
    const intent = {
      legId: "leg-1",
      transferId: "transfer-1",
      paymentRequest: "fixture-invoice-1",
      paymentHash: "a".repeat(64),
      invoiceAmountSats: 1_000,
      maxFeeSats: 10,
      preparedAt: CREATED_AT,
    }
    const original = fingerprintCheckoutSparkSettledLegIntent(intent)
    expect(original).toMatch(/^[0-9a-f]{64}$/)

    const changes = [
      { ...intent, legId: "leg-2" },
      { ...intent, transferId: "transfer-2" },
      { ...intent, paymentRequest: "fixture-invoice-2" },
      { ...intent, paymentHash: "b".repeat(64) },
      { ...intent, invoiceAmountSats: 999 },
      { ...intent, maxFeeSats: 11 },
      { ...intent, preparedAt: CREATED_AT + 1 },
    ]
    for (const changed of changes) {
      expect(fingerprintCheckoutSparkSettledLegIntent(changed)).not.toBe(
        original
      )
    }
  })

  it("restores immutable pre-allowance v3 plans but keeps new freezing strict", () => {
    const legacy = preAllowancePlan()
    expect(legacy.planDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(restoreCheckoutSparkSettledPlan(legacy)).toEqual(legacy)
    expect(
      restoreCheckoutSparkSettledReconciliation({
        ...createCheckoutSparkSettledReconciliation(legacy),
      }).plan.planDigest
    ).toBe(legacy.planDigest)
    expect(() =>
      freezeCheckoutSparkSettledPlan({ ...legacy, funding: legacy.funding })
    ).toThrow("gross funding differs from frozen terms")
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...legacy,
        funding: { ...legacy.funding, grossFundingSats: 102_101 },
      })
    ).toThrow("gross funding differs from frozen terms")
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...legacy,
        recipients: legacy.recipients.map((recipient, index) =>
          index === 0
            ? { ...recipient, weightSats: recipient.weightSats + 1 }
            : recipient
        ),
      })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...legacy,
        funding: {
          ...legacy.funding,
          paymentRequest: invoice(102_100, 5),
          paymentHash: "05".repeat(32),
        },
      })
    ).toThrow("integrity check failed")
  })

  it("reloads prior v3 credit without replacing its funding or recipient terms", async () => {
    const database = new ConduitDB(
      `conduit-settled-prior-test-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    const repository = new DexieCheckoutSparkSettledRepository(database)
    try {
      const legacy = preAllowancePlan()
      const created = await repository.create(legacy)
      expect(created.status).toBe("active")
      const credited = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(legacy),
        {
          requestId: legacy.funding.requestId,
          paymentHash: legacy.funding.paymentHash,
          transferId: "prior-receive",
          receiverIdentityPublicKey: legacy.funding.receiverIdentityPublicKey,
          grossSats: legacy.funding.grossFundingSats,
          creditedSats: 102_000,
          observedAt: CREATED_AT + 1,
        }
      )
      const saved = await repository.save(credited, 1)
      const loaded = await repository.load(legacy.checkoutId, legacy.planDigest)
      expect(loaded).toEqual(saved)
      if (loaded.status !== "active")
        throw new Error("Expected active checkout")
      expect(loaded.state.plan).toEqual(legacy)
      expect(loaded.state.credit?.grossSats).toBe(102_100)
      expect(loaded.state.legs.map((leg) => leg.status)).toEqual([
        "unprepared",
        "unprepared",
        "unprepared",
      ])
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("freezes signed quote, recipient witnesses, gross and deterministic leg IDs", () => {
    const frozen = plan()
    expect(frozen.schemaVersion).toBe(3)
    expect(frozen.funding.grossFundingSats).toBe(102_250)
    expect(frozen.recipients.map((recipient) => recipient.weightSats)).toEqual([
      80_000, 20_000, 2_100,
    ])
    expect(restoreCheckoutSparkSettledPlan(frozen)).toEqual(frozen)
    expect(plan().planDigest).toBe(frozen.planDigest)
    expect(
      deriveCheckoutSparkSettledTransferId(frozen, frozen.recipients[0]!.legId)
    ).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("preserves the quote merchant and separate supplier across a v3 round trip", () => {
    const frozen = plan()
    const restored = restoreCheckoutSparkSettledPlan(
      JSON.parse(JSON.stringify(frozen))
    )
    for (const candidate of [frozen, restored]) {
      const merchant = candidate.recipients.find(
        (recipient) => recipient.kind === "merchant"
      )!
      const supplier = candidate.recipients.find(
        (recipient) => recipient.kind === "supplier"
      )!
      expect(merchant.recipientId).toBe(candidate.merchantPubkey)
      expect(
        candidate.commerceQuote.lines.every(
          (line) => line.merchantPubkey === merchant.recipientId
        )
      ).toBe(true)
      expect(supplier.recipientId).toBe(SUPPLIER)
      expect(merchant.weightSats).toBe(80_000)
      expect(supplier.weightSats).toBe(20_000)
      expect(Object.isFrozen(merchant)).toBe(true)
    }
    expect(restored.planDigest).toBe(frozen.planDigest)
    expect(restored.recipients.map((recipient) => recipient.legId)).toEqual(
      frozen.recipients.map((recipient) => recipient.legId)
    )
  })

  it("rejects altered economics, unsigned destination and forged invoice terms", () => {
    const frozen = plan()
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...frozen,
        funding: {
          ...frozen.funding,
          grossFundingSats: 102_100,
          paymentRequest: invoice(102_100, 4),
          paymentHash: "04".repeat(32),
        },
      })
    ).toThrow("integrity check failed")
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        funding: {
          ...frozen.funding,
          grossFundingSats: 102_251,
          paymentRequest: invoice(102_251, 4),
          paymentHash: "04".repeat(32),
        },
      })
    ).toThrow("gross funding differs from frozen terms")
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...frozen,
        recipients: frozen.recipients.map((recipient, index) =>
          index === 0
            ? { ...recipient, weightSats: recipient.weightSats + 1 }
            : recipient
        ),
      })
    ).toThrow()
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        funding: { ...frozen.funding, paymentHash: "f".repeat(64) },
      })
    ).toThrow("invoice amount, hash, or expiry")
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        funding: {
          ...frozen.funding,
          paymentRequest: invoice(102_099, 4),
          paymentHash: "04".repeat(32),
        },
      })
    ).toThrow("invoice amount, hash, or expiry")
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        funding: {
          ...frozen.funding,
          paymentRequest: makeSignedBolt11Fixture({
            hrp: "lnbcrt1021000n",
            createdAt: CREATED_SECONDS,
            fields: [
              bolt11PaymentHashField(new Uint8Array(32).fill(1)),
              bolt11PaymentSecretField(),
              bolt11PlainDescriptionField(),
            ],
          }),
        },
      })
    ).toThrow("network or signature")
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        funding: { ...frozen.funding, expiresAt: EXPIRES_AT + 1_000 },
      })
    ).toThrow("funding window")
    expect(() =>
      freezeCheckoutSparkSettledPlan({
        ...frozen,
        recipients: frozen.recipients.map((recipient, index) =>
          index === 0
            ? {
                ...recipient,
                destination: {
                  ...recipient.destination,
                  source: {
                    type: "conduit_allowlist" as const,
                    policy: "production" as const,
                  },
                },
              }
            : recipient
        ),
      })
    ).toThrow("signed profile")
    expect(() =>
      restoreCheckoutSparkSettledPlan({
        ...frozen,
        recipients: frozen.recipients.map((recipient, index) =>
          index === 0
            ? {
                ...recipient,
                destination: {
                  ...recipient.destination,
                  source: {
                    type: "signed_profile" as const,
                    profileEventId: "f".repeat(64),
                    profileEventCreatedAt: CREATED_SECONDS - 1,
                  },
                },
              }
            : recipient
        ),
      })
    ).toThrow("integrity")
  })

  it("attributes one exact receive and allocates only credited sats", () => {
    const state = credited()
    expect(state.credit?.creditedSats).toBe(102_050)
    expect(state.legs.map((leg) => leg.allocationSats)).toEqual([
      79_962, 19_990, 2_098,
    ])
    expect(
      restoreCheckoutSparkSettledReconciliation(state).legs.map(
        (leg) => leg.allocationSats
      )
    ).toEqual([79_962, 19_990, 2_098])
    expect(() =>
      recordCheckoutSparkSettledCredit(state, {
        ...state.credit!,
        creditedSats: 102_049,
      })
    ).toThrow("conflicts")
    expect(() =>
      recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(state.plan),
        {
          ...state.credit!,
          receiverIdentityPublicKey: `03${"f".repeat(64)}`,
        }
      )
    ).toThrow("out of scope")
  })

  it("persists one exact dynamic invoice before send and never changes it", () => {
    const state = credited()
    const leg = state.legs[0]!
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(state.plan, leg.legId),
      paymentRequest: invoice(79_000, 2),
      paymentHash: "02".repeat(32),
      invoiceAmountSats: 79_000,
      maxFeeSats: leg.allocationSats! - 79_000,
      preparedAt: CREATED_AT + 2,
    }
    const prepared = prepareCheckoutSparkSettledLeg(state, intent)
    expect(prepared.legs[0]?.intent).toEqual(intent)
    expect(() =>
      prepareCheckoutSparkSettledLeg(prepared, {
        ...intent,
        paymentRequest: invoice(78_000, 3),
      })
    ).toThrow()
    expect(() =>
      prepareCheckoutSparkSettledLeg(state, {
        ...intent,
        maxFeeSats: intent.maxFeeSats + 1,
      })
    ).toThrow("exceeds allocation")

    const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "submitted",
      observedAt: CREATED_AT + 3,
    })
    const unavailable = recordCheckoutSparkSettledLegStatus(submitted, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "lookup_unavailable",
      observedAt: CREATED_AT + 4,
    })
    expect(unavailable.legs[0]?.intent).toEqual(intent)
    expect(() =>
      recordCheckoutSparkSettledLegStatus(unavailable, {
        legId: leg.legId,
        transferId: intent.transferId,
        paymentHash: intent.paymentHash,
        status: "submitted",
        observedAt: CREATED_AT + 5,
      })
    ).toThrow("cannot be resubmitted")
    const paid = recordCheckoutSparkSettledLegStatus(unavailable, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "paid",
      finalFeeSats: 250,
      finalDebitSats: 79_250,
      observedAt: CREATED_AT + 5,
    })
    expect(paid.legs[0]?.status).toBe("paid")
    expect(() =>
      recordCheckoutSparkSettledLegStatus(unavailable, {
        legId: leg.legId,
        transferId: intent.transferId,
        paymentHash: intent.paymentHash,
        status: "paid",
        finalFeeSats: intent.maxFeeSats + 1,
        finalDebitSats: intent.invoiceAmountSats + intent.maxFeeSats + 1,
        observedAt: CREATED_AT + 5,
      })
    ).toThrow("exceeded allocation")
    expect(() =>
      recordCheckoutSparkSettledLegStatus(paid, {
        legId: leg.legId,
        transferId: intent.transferId,
        paymentHash: intent.paymentHash,
        status: "lookup_unavailable",
        observedAt: CREATED_AT + 6,
      })
    ).toThrow("cannot become payable")
  })

  it("reloads exact credit and intent while rejecting a stale CAS writer", async () => {
    const database = new ConduitDB(
      `conduit-settled-test-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    const repository = new DexieCheckoutSparkSettledRepository(database)
    try {
      const frozen = plan()
      const first = await repository.create(frozen)
      expect(first.status).toBe("active")
      expect(await repository.create(frozen)).toEqual(first)
      const saved = await repository.save(credited(), 1)
      expect(saved.status).toBe("active")
      if (saved.status !== "active") throw new Error("Expected active checkout")
      const leg = saved.state.legs[0]!
      const intent = {
        legId: leg.legId,
        transferId: deriveCheckoutSparkSettledTransferId(
          saved.state.plan,
          leg.legId
        ),
        paymentRequest: invoice(79_000, 7),
        paymentHash: "07".repeat(32),
        invoiceAmountSats: 79_000,
        maxFeeSats: leg.allocationSats! - 79_000,
        preparedAt: CREATED_AT + 2,
      }
      const prepared = prepareCheckoutSparkSettledLeg(saved.state, intent)
      const written = await repository.save(prepared, saved.revision)
      expect(written).toMatchObject({ status: "active", revision: 3 })
      const reopened = new DexieCheckoutSparkSettledRepository(database)
      expect(await reopened.load(frozen.checkoutId, frozen.planDigest)).toEqual(
        written
      )
      await expect(
        new DexieCheckoutSparkRepository(database).load(
          frozen.checkoutId,
          frozen.planDigest
        )
      ).rejects.toThrow("inconsistent")
      const altered = {
        ...prepared,
        legs: prepared.legs.map((candidate, position) =>
          position === 0
            ? {
                ...candidate,
                intent: { ...intent, paymentRequest: invoice(78_000, 8) },
              }
            : candidate
        ),
      }
      await expect(repository.save(altered, 3)).rejects.toThrow()
      await expect(repository.save(credited(), 1)).rejects.toBeInstanceOf(
        CheckoutSparkSettledRepositoryConflictError
      )
      expect(await database.checkoutSparkPlanBindings.count()).toBe(1)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("rolls back a CAS save if Merchant authority changes during persistence", async () => {
    const database = new ConduitDB(
      `conduit-settled-authority-test-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    const repository = new DexieCheckoutSparkSettledRepository(database)
    try {
      const frozen = plan()
      await repository.create(frozen)
      let current = true
      const assertCurrent = () => {
        if (!current) throw new Error("Merchant authority changed")
      }
      database.checkoutSparkReconciliations.hook("updating", () => {
        current = false
      })
      await expect(
        repository.save(credited(), 1, assertCurrent)
      ).rejects.toThrow("Merchant authority changed")
      const stored = await repository.load(frozen.checkoutId, frozen.planDigest)
      expect(stored.status).toBe("active")
      if (stored.status !== "active")
        throw new Error("Expected active checkout")
      expect(stored.revision).toBe(1)
      expect(stored.state.credit).toBeNull()
    } finally {
      database.close()
      await database.delete()
    }
  })
})
