import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  getCheckoutSparkPlanSourceReferences,
  canonicalizeCheckoutSparkPlanSourceEvents,
  restoreCheckoutSparkPlanSourceValidation,
  validateCheckoutSparkPlanSources,
} from "../packages/core/src/protocol/checkout-spark-plan-sources"
import {
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "../packages/core/src/protocol/checkout-spark-settled-allocation"
import { freezeCheckoutSparkSettledPlan } from "../packages/core/src/protocol/checkout-spark-settled-router"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
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
const CREATED_SECONDS = 1_800_000_000
const CREATED_AT = CREATED_SECONDS * 1_000
const UNAVAILABLE = "Checkout Spark signed plan sources are unavailable."

function productEvent(input: {
  dTag: string
  unitSats: number
  supplier?: boolean
  createdAt?: number
  currency?: "SAT" | "SATS"
  shippingCoordinate?: string
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30_402,
      created_at: input.createdAt ?? CREATED_SECONDS - 3_600,
      tags: [
        ["d", input.dTag],
        ["title", "Source validation fixture"],
        ["price", String(input.unitSats), input.currency ?? "SAT"],
        ["type", "simple", input.shippingCoordinate ? "physical" : "digital"],
        ...(input.shippingCoordinate
          ? [["shipping_option", input.shippingCoordinate]]
          : []),
        ["location", "Example listing area"],
        ["g", "dr5r"],
        ...(input.supplier
          ? [
              ["conduit_supplier_allocation", "1"],
              ["zap", MERCHANT, "wss://relay.conduit.market", "3"],
              ["zap", SUPPLIER, "wss://relay.conduit.market", "1"],
            ]
          : []),
      ],
      content: "Signed digital listing",
    },
    MERCHANT_SECRET
  )
}

function profileEvent(
  secret: Uint8Array,
  lud16: string,
  createdAt = CREATED_SECONDS - 1_800
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ name: "Source validation fixture", lud16 }),
    },
    secret
  )
}

function fixture(
  input: {
    supplier?: boolean
    multiItem?: boolean
    shippingSats?: number
  } = {}
) {
  const supplier = input.supplier ?? true
  const shipping =
    input.shippingSats === undefined
      ? undefined
      : finalizeEvent(
          {
            kind: 30_406,
            created_at: CREATED_SECONDS - 3_601,
            tags: [
              ["d", "download-shipping-standard"],
              ["title", "Standard shipping"],
              ["price", String(input.shippingSats), "SAT"],
              ["country", "US", "CA"],
              ["service", "standard"],
            ],
            content: "",
          },
          MERCHANT_SECRET
        )
  const shippingCoordinate = shipping
    ? `30406:${MERCHANT}:download-shipping-standard`
    : undefined
  const products = [
    {
      event: productEvent({
        dTag: "download",
        unitSats: 1_000,
        supplier,
        shippingCoordinate,
      }),
      quantity: 3,
      unitSats: 1_000,
    },
    ...(input.multiItem
      ? [
          {
            event: productEvent({
              dTag: "extra",
              unitSats: 200,
              currency: "SATS",
            }),
            quantity: 2,
            unitSats: 200,
          },
        ]
      : []),
  ]
  const merchantProfile = profileEvent(
    MERCHANT_SECRET,
    "  merchant@example.test  "
  )
  const supplierProfile = profileEvent(SUPPLIER_SECRET, "supplier@example.test")
  const commerceTotalSats =
    (input.multiItem ? 3_400 : 3_000) + 3 * (input.shippingSats ?? 0)
  const weights = calculateCheckoutSparkAllocationWeights(commerceTotalSats)
  const grossFundingSats =
    calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${grossFundingSats * 10}n`,
    createdAt: CREATED_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(1)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "source-validation-checkout",
    orderId: "source-validation-order",
    merchantPubkey: MERCHANT,
    walletId: "source-validation-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 45 * 60_000,
    commerceQuote: {
      commerceTotalSats,
      lines: products.map(({ event, quantity, unitSats }) => ({
        productCoordinate: `30402:${MERCHANT}:${event.tags.find((tag) => tag[0] === "d")![1]}`,
        productEventId: event.id,
        merchantPubkey: MERCHANT,
        quantity,
        unitMerchandiseSats: unitSats,
        unitShippingSats:
          shipping && event === products[0]!.event ? input.shippingSats! : 0,
        ...(shipping && event === products[0]!.event
          ? {
              shippingOption: {
                coordinate: shippingCoordinate!,
                eventId: shipping.id,
              },
            }
          : {}),
      })),
    },
    funding: {
      requestId: "source-validation-receive",
      paymentRequest,
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${MERCHANT}`,
      grossFundingSats,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: commerceTotalSats - (supplier ? 750 : 0),
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: merchantProfile.id,
            profileEventCreatedAt: merchantProfile.created_at,
          },
        },
      },
      ...(supplier
        ? [
            {
              kind: "supplier" as const,
              recipientId: SUPPLIER,
              weightSats: 750,
              destination: {
                type: "lightning_address" as const,
                value: "supplier@example.test",
                source: {
                  type: "signed_profile" as const,
                  profileEventId: supplierProfile.id,
                  profileEventCreatedAt: supplierProfile.created_at,
                },
              },
            },
          ]
        : []),
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: weights.conduitWeightSats,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  return {
    plan,
    products,
    merchantProfile,
    supplierProfile,
    shipping,
    events: [
      ...products.map(({ event }) => event),
      ...(shipping ? [shipping] : []),
      merchantProfile,
      ...(supplier ? [supplierProfile] : []),
    ],
  }
}

describe("checkout Spark exact signed plan sources", () => {
  it("restores physical supplier terms and exact shipping sources without a live relay read", () => {
    const { plan, events, shipping } = fixture({
      shippingSats: 20,
      multiItem: true,
    })
    const restored = JSON.parse(
      JSON.stringify(events)
    ) as SignedPublicNostrEvent[]
    expect(getCheckoutSparkPlanSourceReferences(plan)).toContainEqual({
      kind: 30_406,
      pubkey: MERCHANT,
      eventId: shipping!.id,
    })
    const canonical = canonicalizeCheckoutSparkPlanSourceEvents(plan, restored)
    expect(validateCheckoutSparkPlanSources(plan, canonical).planDigest).toBe(
      plan.planDigest
    )
    expect(
      plan.recipients.find((recipient) => recipient.kind === "supplier")!
        .weightSats
    ).toBe(750)
    expect(
      plan.recipients.find((recipient) => recipient.kind === "merchant")!
        .weightSats
    ).toBe(2710)
  })

  it("keeps zero-cost physical shipping authoritative rather than treating it as digital", () => {
    const { plan, events, shipping } = fixture({ shippingSats: 0 })
    expect(validateCheckoutSparkPlanSources(plan, events).planDigest).toBe(
      plan.planDigest
    )
    expect(() =>
      validateCheckoutSparkPlanSources(
        plan,
        events.filter((event) => event !== shipping)
      )
    ).toThrow(UNAVAILABLE)
  })

  it("does not replace the frozen shipping revision with a newer event at the same coordinate", () => {
    const { plan, events, shipping } = fixture({ shippingSats: 20 })
    const newer = finalizeEvent(
      {
        kind: shipping!.kind,
        created_at: CREATED_SECONDS + 60,
        tags: shipping!.tags.map((tag) =>
          tag[0] === "price" ? ["price", "50", "SAT"] : [...tag]
        ),
        content: "",
      },
      MERCHANT_SECRET
    )
    expect(
      validateCheckoutSparkPlanSources(plan, [newer, ...events]).planDigest
    ).toBe(plan.planDigest)
    expect(() =>
      validateCheckoutSparkPlanSources(
        plan,
        events.map((event) => (event === shipping ? newer : event))
      )
    ).toThrow(UNAVAILABLE)
    expect(() =>
      canonicalizeCheckoutSparkPlanSourceEvents(plan, [...events, newer])
    ).toThrow(UNAVAILABLE)
  })

  it("rejects shipping amount substitution even when the commerce total and allocations still add up", () => {
    const { plan, events } = fixture({ shippingSats: 20 })
    const changed = freezeCheckoutSparkSettledPlan({
      ...plan,
      commerceQuote: {
        ...plan.commerceQuote,
        lines: plan.commerceQuote.lines.map((line) => ({
          ...line,
          unitShippingSats: 10,
          unitMerchandiseSats: line.unitMerchandiseSats + 10,
        })),
      },
    })
    expect(() => validateCheckoutSparkPlanSources(changed, events)).toThrow(
      UNAVAILABLE
    )
  })

  it("rejects a changed shipping signature or destination without emitting source contents", () => {
    const { plan, events, shipping } = fixture({ shippingSats: 20 })
    const forged = {
      ...shipping!,
      tags: shipping!.tags.map((tag) =>
        tag[0] === "country" ? ["country", "GB"] : [...tag]
      ),
    }
    expect(() =>
      canonicalizeCheckoutSparkPlanSourceEvents(
        plan,
        events.map((event) => (event === shipping ? forged : event))
      )
    ).toThrow(UNAVAILABLE)
    expect(() =>
      validateCheckoutSparkPlanSources(
        plan,
        events.map((event) => (event === shipping ? forged : event))
      )
    ).toThrow(UNAVAILABLE)
  })

  it("lists only immutable exact product and recipient profile references", () => {
    const { plan, products, merchantProfile, supplierProfile } = fixture({
      multiItem: true,
    })
    const references = getCheckoutSparkPlanSourceReferences(plan)
    expect(references).toEqual([
      ...products.map(({ event }) => ({
        eventId: event.id,
        kind: 30402,
        pubkey: MERCHANT,
      })),
      { eventId: merchantProfile.id, kind: 0, pubkey: MERCHANT },
      { eventId: supplierProfile.id, kind: 0, pubkey: SUPPLIER },
    ])
    expect(Object.isFrozen(references)).toBe(true)
    expect(references.every(Object.isFrozen)).toBe(true)
  })

  it("admits a normal merchant-only signed SAT digital plan", () => {
    const { plan, events } = fixture({ supplier: false })
    const validation = validateCheckoutSparkPlanSources(plan, events)
    expect(validation).toEqual({
      schemaVersion: 1,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      merchantPubkey: MERCHANT,
    })
    expect(Object.isFrozen(validation)).toBe(true)
  })

  it("admits exact signed supplier shares across SAT and SATS products independently of read order", () => {
    const { plan, events } = fixture({ multiItem: true })
    const snapshot = JSON.stringify({ plan, events })
    const validation = validateCheckoutSparkPlanSources(
      plan,
      [...events].reverse()
    )
    expect(
      validateCheckoutSparkPlanSources(plan, [...events, events[0]!])
    ).toEqual(validation)
    expect(JSON.stringify({ plan, events })).toBe(snapshot)
    expect(Object.keys(validation)).toEqual([
      "schemaVersion",
      "checkoutId",
      "planDigest",
      "merchantPubkey",
    ])
  })

  it("retains exact historical sources when newer signed listings and profiles exist", () => {
    const { plan, events } = fixture()
    const later = [
      productEvent({
        dTag: "download",
        unitSats: 2_000,
        supplier: true,
        createdAt: CREATED_SECONDS + 60,
      }),
      profileEvent(
        MERCHANT_SECRET,
        "new-merchant@example.test",
        CREATED_SECONDS + 60
      ),
      profileEvent(
        SUPPLIER_SECRET,
        "new-supplier@example.test",
        CREATED_SECONDS + 60
      ),
    ]
    expect(
      validateCheckoutSparkPlanSources(plan, [...later, ...events])
    ).toEqual(validateCheckoutSparkPlanSources(plan, events))
    expect(() => validateCheckoutSparkPlanSources(plan, later)).toThrow(
      UNAVAILABLE
    )
  })

  it("leaves unavailable or individually missing signed evidence unadmitted", () => {
    const { plan, events } = fixture({ multiItem: true })
    expect(() => validateCheckoutSparkPlanSources(plan, [])).toThrow(
      UNAVAILABLE
    )
    for (const missing of events) {
      expect(() =>
        validateCheckoutSparkPlanSources(
          plan,
          events.filter((event) => event.id !== missing.id)
        )
      ).toThrow(UNAVAILABLE)
    }
  })

  it("restores a minimal local attestation without requiring active plan material", () => {
    const { plan, events } = fixture()
    const validation = validateCheckoutSparkPlanSources(plan, events)
    const scope = {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      merchantPubkey: plan.merchantPubkey,
    }
    const restored = restoreCheckoutSparkPlanSourceValidation(
      JSON.parse(JSON.stringify(validation)),
      scope
    )
    expect(restored).toEqual(validation)
    expect(restored).not.toBe(validation)
    expect(Object.isFrozen(restored)).toBe(true)
    expect(() =>
      restoreCheckoutSparkPlanSourceValidation(undefined, scope)
    ).toThrow(UNAVAILABLE)
  })
})
