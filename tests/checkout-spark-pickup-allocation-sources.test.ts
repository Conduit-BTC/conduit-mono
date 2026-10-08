import { describe, expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  assertCheckoutSparkSignedCommerceAllocations,
  deriveCheckoutSparkSignedCommerceObligations,
} from "@conduit/core/protocol/checkout-spark-signed-allocation"
import {
  CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES,
  canonicalizeCheckoutSparkPlanSourceEvents,
  getCheckoutSparkPlanSourceReferences,
  validateCheckoutSparkPlanSources,
} from "@conduit/core/protocol/checkout-spark-plan-sources"
import {
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkSettledRecoveryPayload,
  parseCheckoutSparkRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-recovery"
import {
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "@conduit/core/protocol/checkout-spark-settled-allocation"
import {
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { parseCheckoutSparkSignedProductFields as parseProductEvent } from "@conduit/core/protocol/checkout-spark-product-fields"
import { createCheckoutSparkPickupFixture } from "./support/checkout-spark-pickup-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const MERCHANT_SECRET = generateSecretKey()
const SUPPLIER_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const SUPPLIER = getPublicKey(SUPPLIER_SECRET)

function pickupAllocationFixture(
  options: Parameters<typeof createCheckoutSparkPickupFixture>[0] = {}
) {
  const fixture = createCheckoutSparkPickupFixture({
    handoffMode: "organizer_handoff",
    collectionAlias: true,
    extraCostSats: 3,
    quantity: 3,
    ...options,
    merchantSecret: MERCHANT_SECRET,
  })
  const productEvent = finalizeEvent(
    {
      kind: fixture.productEvent.kind,
      created_at: fixture.productEvent.created_at,
      content: fixture.productEvent.content,
      tags: [
        ...fixture.productEvent.tags.map((tag) =>
          tag[0] === "price" ? ["price", "101", "SAT"] : [...tag]
        ),
        ["conduit_supplier_allocation", "1"],
        ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
        ["zap", SUPPLIER, "wss://relay.conduit.market", "1"],
      ],
    },
    MERCHANT_SECRET
  )
  const product = {
    ...parseProductEvent(productEvent),
    sourceEventId: productEvent.id,
  }
  const line = {
    ...fixture.line,
    productEventId: productEvent.id,
    unitMerchandiseSats: 101,
  }
  const quote = {
    commerceTotalSats:
      line.quantity * (line.unitMerchandiseSats + line.unitShippingSats),
    lines: [line],
  }
  return {
    ...fixture,
    productEvent,
    product,
    line,
    input: {
      quote,
      products: [product],
      merchantPubkey: MERCHANT,
      pickupSourceEvents: fixture.sourceEvents,
      acceptedAtMs: fixture.acceptedAtMs,
    },
  }
}

function pickupPlanFixture(
  options: Parameters<typeof createCheckoutSparkPickupFixture>[0] = {}
) {
  const fixture = pickupAllocationFixture(options)
  const profile = (secret: Uint8Array, lud16: string) =>
    finalizeEvent(
      {
        kind: 0,
        created_at: fixture.productEvent.created_at,
        tags: [],
        content: JSON.stringify({ lud16 }),
      },
      secret
    )
  const merchantProfile = profile(MERCHANT_SECRET, "merchant@example.test")
  const supplierProfile = profile(SUPPLIER_SECRET, "supplier@example.test")
  const obligations = deriveCheckoutSparkSignedCommerceObligations(
    fixture.input
  )
  const grossFundingSats = calculateCheckoutSparkSettledGrossFundingSats(
    fixture.input.quote.commerceTotalSats
  )
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbcrt${grossFundingSats * 10}n`,
    createdAt: fixture.acceptedAtMs / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(1)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "pickup-source-checkout",
    orderId: "pickup-source-order",
    merchantPubkey: MERCHANT,
    walletId: "pickup-source-wallet",
    network: "regtest",
    createdAt: fixture.acceptedAtMs,
    takeoverAt: fixture.acceptedAtMs + 45 * 60_000,
    commerceQuote: fixture.input.quote,
    funding: {
      requestId: "pickup-source-receive",
      paymentRequest,
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${MERCHANT}`,
      grossFundingSats,
      createdAt: fixture.acceptedAtMs,
      expiresAt: fixture.acceptedAtMs + 3_600_000,
    },
    recipients: [
      ...obligations.map((obligation) => {
        const selected =
          obligation.kind === "merchant" ? merchantProfile : supplierProfile
        return {
          kind: obligation.kind,
          recipientId: obligation.recipientId,
          weightSats: obligation.amountSats,
          destination: {
            type: "lightning_address" as const,
            value:
              obligation.kind === "merchant"
                ? "merchant@example.test"
                : "supplier@example.test",
            source: {
              type: "signed_profile" as const,
              profileEventId: selected.id,
              profileEventCreatedAt: selected.created_at,
            },
          },
        }
      }),
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: calculateCheckoutSparkAllocationWeights(
          fixture.input.quote.commerceTotalSats
        ).conduitWeightSats,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  return {
    ...fixture,
    plan,
    merchantProfile,
    supplierProfile,
    events: [
      fixture.productEvent,
      ...fixture.sourceEvents,
      merchantProfile,
      supplierProfile,
    ],
  }
}

describe("Checkout Spark pickup allocations and historical sources", () => {
  it("splits quantity-adjusted merchandise but gives all pickup cost and residue to the merchant", () => {
    const fixture = pickupAllocationFixture()

    const obligations = deriveCheckoutSparkSignedCommerceObligations(
      fixture.input
    )

    expect(obligations).toEqual([
      { kind: "merchant", recipientId: MERCHANT, amountSats: 267 },
      { kind: "supplier", recipientId: SUPPLIER, amountSats: 75 },
    ])
    expect(() =>
      assertCheckoutSparkSignedCommerceAllocations({
        ...fixture.input,
        commerce: obligations,
      })
    ).not.toThrow()
  })

  it("canonicalizes a complete recovery bundle with exact organizer-authored pickup graph references", () => {
    const fixture = pickupPlanFixture()
    const expectedReferences = [
      { kind: 30402, eventId: fixture.productEvent.id, pubkey: MERCHANT },
      {
        kind: 30406,
        eventId: fixture.pickup.id,
        pubkey: fixture.organizerPubkey,
      },
      {
        kind: 31923,
        eventId: fixture.calendar.id,
        pubkey: fixture.organizerPubkey,
      },
      {
        kind: 30405,
        eventId: fixture.collection.id,
        pubkey: fixture.organizerPubkey,
      },
      { kind: 0, eventId: fixture.merchantProfile.id, pubkey: MERCHANT },
      { kind: 0, eventId: fixture.supplierProfile.id, pubkey: SUPPLIER },
    ]

    expect(getCheckoutSparkPlanSourceReferences(fixture.plan)).toEqual(
      expectedReferences
    )
    const bundle = canonicalizeCheckoutSparkPlanSourceEvents(
      fixture.plan,
      [...fixture.events].reverse()
    )
    expect(bundle.map((event) => event.id)).toEqual(
      fixture.events.map((event) => event.id).sort()
    )
    expect(validateCheckoutSparkPlanSources(fixture.plan, bundle)).toEqual({
      schemaVersion: 1,
      checkoutId: fixture.plan.checkoutId,
      planDigest: fixture.plan.planDigest,
      merchantPubkey: MERCHANT,
    })
  })

  it("keeps merchant-handoff date calendars and zero-cost pickup sources in the complete bundle", () => {
    const fixture = pickupPlanFixture({
      handoffMode: "merchant_handoff",
      collectionAlias: false,
      calendarKind: 31922,
      pickupPriceSats: 0,
      extraCostSats: 0,
    })
    const bundle = canonicalizeCheckoutSparkPlanSourceEvents(
      fixture.plan,
      fixture.events
    )

    expect(getCheckoutSparkPlanSourceReferences(fixture.plan)).toContainEqual({
      kind: 30406,
      eventId: fixture.pickup.id,
      pubkey: MERCHANT,
    })
    expect(getCheckoutSparkPlanSourceReferences(fixture.plan)).toContainEqual({
      kind: 31922,
      eventId: fixture.calendar.id,
      pubkey: fixture.organizerPubkey,
    })
    expect(
      fixture.plan.recipients.map(({ kind, weightSats }) => ({
        kind,
        weightSats,
      }))
    ).toEqual([
      { kind: "merchant", weightSats: 228 },
      { kind: "supplier", weightSats: 75 },
      { kind: "conduit", weightSats: 111 },
    ])
    expect(bundle).toHaveLength(6)
  })

  it("requires the historical pickup graph and acceptance time before deriving any shares", () => {
    const fixture = pickupAllocationFixture()

    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        ...fixture.input,
        pickupSourceEvents: undefined,
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        ...fixture.input,
        acceptedAtMs: undefined,
      })
    ).toThrow("exact signed product allocation evidence")
  })

  it("keeps each missing historical graph, product, or recipient profile source unavailable", () => {
    const fixture = pickupPlanFixture()

    for (const missing of fixture.events) {
      const incomplete = fixture.events.filter(
        (event) => event.id !== missing.id
      )
      expect(() =>
        validateCheckoutSparkPlanSources(fixture.plan, incomplete)
      ).toThrow("Checkout Spark signed plan sources are unavailable.")
      expect(() =>
        canonicalizeCheckoutSparkPlanSourceEvents(fixture.plan, incomplete)
      ).toThrow("Checkout Spark signed plan sources are unavailable.")
    }
  })

  it("validates original pickup history without substituting later signed graph revisions", () => {
    const fixture = pickupPlanFixture()
    const later = createCheckoutSparkPickupFixture({
      merchantSecret: MERCHANT_SECRET,
      handoffMode: "organizer_handoff",
      collectionAlias: true,
      createdAt: fixture.productEvent.created_at + 7_200,
      pickupPriceSats: 15,
      orderAcceptance: "closed",
    })
    const expected = validateCheckoutSparkPlanSources(
      fixture.plan,
      fixture.events
    )

    expect(
      validateCheckoutSparkPlanSources(fixture.plan, [
        ...later.sourceEvents,
        ...fixture.events,
      ])
    ).toEqual(expected)
    for (const name of ["calendar", "collection", "pickup"] as const) {
      expect(() =>
        validateCheckoutSparkPlanSources(
          fixture.plan,
          fixture.events.map((event) =>
            event.id === fixture[name].id ? later[name] : event
          )
        )
      ).toThrow("Checkout Spark signed plan sources are unavailable.")
    }
    expect(() =>
      canonicalizeCheckoutSparkPlanSourceEvents(fixture.plan, [
        ...later.sourceEvents,
        ...fixture.events,
      ])
    ).toThrow("Checkout Spark signed plan sources are unavailable.")
  })

  it("round-trips the exact signed pickup bundle through the existing initial recovery payload", () => {
    const fixture = pickupPlanFixture()
    const payload = createCheckoutSparkSettledRecoveryPayload({
      state: createCheckoutSparkSettledReconciliation(fixture.plan),
      senderPubkey: getPublicKey(generateSecretKey()),
      mnemonic: createRuntimeMnemonic(),
      accountNumber: 1,
      preparedAt: fixture.plan.createdAt + 1_000,
      sourceEvents: [...fixture.events].reverse(),
    })
    const restored = parseCheckoutSparkRecoveryRumor(
      buildCheckoutSparkRecoveryRumor(payload)
    )

    expect(restored).toEqual(payload)
    expect(payload.schemaVersion).toBe(2)
    expect(payload.sourceEvents).toEqual(
      canonicalizeCheckoutSparkPlanSourceEvents(fixture.plan, fixture.events)
    )
    expect(payload.plan.planDigest).toBe(fixture.plan.planDigest)
    expect(payload.plan.recipients.map((recipient) => recipient.kind)).toEqual([
      "merchant",
      "supplier",
      "conduit",
    ])
    expect(CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES).toBe(32 * 1024)
    expect(
      new TextEncoder().encode(JSON.stringify(payload.sourceEvents)).byteLength
    ).toBeLessThan(CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES)
  })
})
