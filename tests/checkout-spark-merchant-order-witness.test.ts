import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import { canonicalizeShippingCost } from "@conduit/core"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  DexieCheckoutSparkSettledRepository,
  EVENT_KINDS,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  matchesCheckoutSparkMerchantOrderWitness,
  parseOrderMessageRumorEvent,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkMerchantOrderWitness,
  type OrderSchema,
  parseProductEvent,
  deriveCheckoutSparkSignedCommerceObligations,
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateCheckoutSparkAllocationWeights,
  parseShippingOptionEvent,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const PRODUCT = `30402:${MERCHANT}:digital-item`
const CREATED_AT = 1_800_000_000_000
const ORDER_ID = "bound-order"
let frozenPlan: ReturnType<typeof freezeCheckoutSparkSettledPlan> | undefined

function plan() {
  if (frozenPlan) return frozenPlan
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: "lnbc11130n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(1)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  frozenPlan = freezeCheckoutSparkSettledPlan({
    checkoutId: "bound-checkout",
    orderId: ORDER_ID,
    merchantPubkey: MERCHANT,
    walletId: "bound-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: PRODUCT,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "bound-receive",
      paymentRequest,
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
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
            profileEventCreatedAt: CREATED_AT / 1_000 - 1,
          },
        },
        weightSats: 1_000,
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
        weightSats: 111,
      },
    ],
  })
  return frozenPlan
}

function order(): OrderSchema {
  return {
    id: ORDER_ID,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: PRODUCT,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: CREATED_AT + 1_000,
  }
}

function rumor(payload: OrderSchema = order()): NDKEvent {
  const event = new NDKEvent(undefined)
  event.kind = EVENT_KINDS.ORDER
  event.pubkey = BUYER
  event.created_at = CREATED_AT / 1_000 + 1
  event.content = JSON.stringify(payload)
  event.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", ORDER_ID],
    ["amount", "1000"],
    ["currency", "SATS"],
    ["item", PRODUCT, "1"],
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  event.id = event.getEventHash()
  return event
}

function witness() {
  const evidence = readCheckoutSparkMerchantOrderEvidence(rumor())
  expect(evidence).not.toBeNull()
  const paired = createCheckoutSparkMerchantOrderWitness(
    plan(),
    evidence!,
    BUYER
  )
  expect(paired).not.toBeNull()
  return paired!
}

describe("authenticated Merchant router-order witness", () => {
  it.each([false, true])(
    "pairs signed fiat source and selected child shipping through the shared parser (%s)",
    (withVariationShipping) => {
      const merchantSecret = generateSecretKey()
      const merchant = getPublicKey(merchantSecret)
      const shippingEvent = withVariationShipping
        ? finalizeEvent(
            {
              kind: 30_406,
              created_at: CREATED_AT / 1_000 - 1,
              tags: [
                ["d", "fiat-shipping"],
                ["price", "0.50", "USD"],
                ["title", "Shipping"],
                ["country", "US"],
                ["service", "standard"],
              ],
              content: "",
            },
            merchantSecret
          )
        : undefined
      const shipping = shippingEvent
        ? parseShippingOptionEvent(shippingEvent)!
        : undefined
      const source = finalizeEvent(
        {
          kind: 30_402,
          created_at: CREATED_AT / 1_000,
          tags: [
            ["d", "fiat"],
            ["title", "Fiat"],
            ["price", "1", "USD"],
            [
              "type",
              withVariationShipping ? "variation" : "simple",
              withVariationShipping ? "physical" : "digital",
            ],
            ...(shipping
              ? [
                  ["shipping_option", shipping.id],
                  ["a", `30402:${merchant}:family`],
                  ["spec", "Size", "Large"],
                ]
              : []),
          ],
          content: "",
        },
        merchantSecret
      )
      const product = { ...parseProductEvent(source), sourceEventId: source.id }
      const sourcePrice = product.sourcePrice!
      const pricing = {
        version: 1 as const,
        rate: {
          rate: 100_000,
          fetchedAt: CREATED_AT,
          source: "mempool" as const,
        },
      }
      const original = plan()
      const commerceTotalSats = shipping ? 1_500 : 1_000
      const gross =
        calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
      const frozen = freezeCheckoutSparkSettledPlan({
        ...original,
        merchantPubkey: merchant,
        funding: {
          ...original.funding,
          grossFundingSats: gross,
          paymentRequest: makeSignedBolt11Fixture({
            hrp: `lnbc${gross * 10}n`,
            createdAt: CREATED_AT / 1_000,
            fields: [
              bolt11PaymentHashField(new Uint8Array(32).fill(1)),
              bolt11PaymentSecretField(),
              bolt11PlainDescriptionField(),
            ],
          }),
        },
        commerceQuote: {
          commerceTotalSats,
          pricing,
          lines: [
            {
              ...original.commerceQuote.lines[0]!,
              productCoordinate: product.id,
              productEventId: source.id,
              merchantPubkey: merchant,
              sourcePrice,
              ...(shipping
                ? {
                    unitShippingSats: 500,
                    sourceShippingCost: {
                      amount: 0.5,
                      currency: "USD",
                      normalizedCurrency: "USD",
                    },
                    shippingOption: {
                      coordinate: shipping.id,
                      eventId: shipping.eventId,
                    },
                    variation: {
                      familyCoordinate: product.parentProductId,
                      specifications: product.specifications ?? [],
                    },
                  }
                : {}),
            },
          ],
        },
        recipients: original.recipients.map((recipient) =>
          recipient.kind === "merchant"
            ? {
                ...recipient,
                recipientId: merchant,
                weightSats: commerceTotalSats,
              }
            : {
                ...recipient,
                weightSats:
                  calculateCheckoutSparkAllocationWeights(commerceTotalSats)
                    .conduitWeightSats,
              }
        ),
      })
      expect(
        deriveCheckoutSparkSignedCommerceObligations({
          quote: frozen.commerceQuote,
          products: [product],
          merchantPubkey: merchant,
          shippingEvents: shippingEvent ? [shippingEvent] : undefined,
          acceptedAtMs: CREATED_AT,
        })
      ).toEqual([
        {
          kind: "merchant",
          recipientId: merchant,
          amountSats: commerceTotalSats,
        },
      ])
      const payload = {
        ...order(),
        merchantPubkey: merchant,
        checkoutSparkPricing: pricing,
        subtotal: commerceTotalSats,
        shippingCostSats: shipping ? 500 : 0,
        shippingCostStatus: shipping
          ? ("priced" as const)
          : ("not_required" as const),
        ...(shipping
          ? {
              shippingAddress: {
                name: "Synthetic Buyer",
                street: "123 Main Street",
                city: "New York",
                state: "NY",
                postalCode: "10001",
                country: "US",
              },
            }
          : {}),
        items: [
          {
            ...order().items[0]!,
            productId: product.id,
            sourcePrice,
            ...(shipping
              ? {
                  format: "physical" as const,
                  fulfillment: { type: "shipping" as const },
                  familyProductId: product.parentProductId,
                  selectedSpecifications: product.specifications,
                  ...canonicalizeShippingCost(
                    shipping.price,
                    shipping.currency
                  ),
                  shippingCostSats: 500,
                  shippingOptionId: shipping.id,
                  shippingOptionDTag: shipping.dTag,
                  shippingCountries: shipping.countries,
                  shippingCountryRules: shipping.countryRules,
                }
              : {}),
          },
        ],
      }
      const event = rumor(payload)
      event.tags = event.tags.map((tag) =>
        tag[0] === "p"
          ? ["p", merchant]
          : tag[0] === "item"
            ? ["item", product.id, "1"]
            : tag[0] === "amount"
              ? ["amount", String(commerceTotalSats)]
              : tag
      )
      if (shipping) event.tags.push(["shipping", shipping.id])
      event.id = event.getEventHash()
      const evidence = readCheckoutSparkMerchantOrderEvidence(event)
      expect(evidence).not.toBeNull()
      const sources = [source, ...(shippingEvent ? [shippingEvent] : [])]
      expect(
        createCheckoutSparkMerchantOrderWitness(
          frozen,
          evidence!,
          BUYER,
          sources
        )
      ).not.toBeNull()
      expect(
        createCheckoutSparkMerchantOrderWitness(frozen, evidence!, BUYER)
      ).toBeNull()
      expect(
        createCheckoutSparkMerchantOrderWitness(
          frozen,
          {
            ...evidence!,
            pricing: { ...pricing, rate: { ...pricing.rate, rate: 200_000 } },
          },
          BUYER,
          sources
        )
      ).toBeNull()
      if (shipping)
        expect(
          createCheckoutSparkMerchantOrderWitness(
            frozen,
            {
              ...evidence!,
              lines: [
                {
                  ...evidence!.lines[0]!,
                  variation: {
                    familyCoordinate: product.parentProductId,
                    specifications: [{ key: "Size", value: "Small" }],
                  },
                },
              ],
            },
            BUYER,
            sources
          )
        ).toBeNull()
    }
  )

  it.each([
    "source_cost",
    "option_dtag",
    "countries",
    "country_rules",
  ] as const)("rejects unrelated digital shipping %s metadata", (field) => {
    const payload = order()
    const item = payload.items[0]!
    if (field === "source_cost")
      item.sourceShippingCost = {
        amount: 0,
        currency: "SAT",
        normalizedCurrency: "SAT",
      }
    else if (field === "option_dtag") item.shippingOptionDTag = "standard"
    else if (field === "countries") item.shippingCountries = ["US"]
    else
      item.shippingCountryRules = [
        { code: "US", name: "United States", restrictTo: [], exclude: [] },
      ]
    expect(readCheckoutSparkMerchantOrderEvidence(rumor(payload))).toBeNull()
  })

  it("binds exact hash, private marker, buyer, merchant, and frozen commerce terms", () => {
    const event = rumor()
    const evidence = readCheckoutSparkMerchantOrderEvidence(event)
    expect(evidence).not.toBeNull()
    expect(evidence).not.toHaveProperty("payload")
    expect(evidence).not.toHaveProperty("note")
    expect(
      createCheckoutSparkMerchantOrderWitness(plan(), evidence!, BUYER)
    ).toEqual(witness())
    expect(
      createCheckoutSparkMerchantOrderWitness(plan(), evidence!, MERCHANT)
    ).toBeNull()
    expect(
      createCheckoutSparkMerchantOrderWitness(
        plan(),
        { ...evidence!, commerceTotalSats: 999 },
        BUYER
      )
    ).toBeNull()
    expect(
      createCheckoutSparkMerchantOrderWitness(
        plan(),
        {
          ...evidence!,
          lines: [{ ...evidence!.lines[0]!, quantity: 2 }],
        },
        BUYER
      )
    ).toBeNull()
  })

  it("rejects a changed unsigned rumor hash or missing router marker", () => {
    const changed = rumor()
    changed.content = JSON.stringify({ ...order(), note: "changed" })
    expect(readCheckoutSparkMerchantOrderEvidence(changed)).toBeNull()
    const unmarked = rumor()
    unmarked.tags = unmarked.tags.filter(
      (tag) => tag[0] !== CHECKOUT_SPARK_ROUTER_ORDER_TAG[0]
    )
    unmarked.id = unmarked.getEventHash()
    expect(readCheckoutSparkMerchantOrderEvidence(unmarked)).toBeNull()
  })

  it("does not attach paid state to a forged or altered cached conversation", () => {
    const exact = witness()
    const message = parseOrderMessageRumorEvent(rumor())
    expect(matchesCheckoutSparkMerchantOrderWitness(exact, message)).toBe(true)
    expect(
      matchesCheckoutSparkMerchantOrderWitness(exact, {
        ...message,
        id: "e".repeat(64),
      })
    ).toBe(false)
    if (message.type !== "order") throw new Error("Expected order")
    expect(
      matchesCheckoutSparkMerchantOrderWitness(exact, {
        ...message,
        payload: { ...message.payload, subtotal: 1 },
      })
    ).toBe(false)
    expect(
      matchesCheckoutSparkMerchantOrderWitness(exact, {
        ...message,
        rawContent: JSON.stringify({ ...order(), note: "forged" }),
      })
    ).toBe(false)
    expect(() =>
      restoreCheckoutSparkMerchantOrderWitness({
        ...exact,
        privateSeed: "not-allowed",
      } as typeof exact)
    ).toThrow()
  })

  it("atomically imports a witnessed recovery and keeps its binding through provider updates", async () => {
    const database = new ConduitDB(`witness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const state = createCheckoutSparkSettledReconciliation(frozen)
      const exact = witness()
      await repository.importMerchantOrderRecovery(state, exact, () => {})
      const original = await database.checkoutSparkPlanBindings.get(
        frozen.checkoutId
      )
      expect(original?.orderWitness).toEqual(exact)
      await expect(
        repository.importMerchantOrderRecovery(
          state,
          { ...exact, rumorId: "f".repeat(64) },
          () => {}
        )
      ).rejects.toThrow()
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.orderWitness
      ).toEqual(exact)
      await repository.recordMerchantCredit(
        frozen,
        {
          mode: "ordinary_v3",
          requestId: frozen.funding.requestId,
          transferId: "funded-transfer",
          receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
          grossSats: frozen.funding.grossFundingSats,
          creditedSats: frozen.funding.grossFundingSats - 1,
        },
        CREATED_AT + 2_000
      )
      const matching = await repository.loadMerchantOrderSettlements(MERCHANT, [
        ORDER_ID,
      ])
      // An authenticated order plus provider facts is not independently
      // verified source authority. Legacy rows remain saved but unprojected.
      expect(matching).toHaveLength(0)
      expect(
        (
          await repository.loadMerchantSettlement(
            MERCHANT,
            frozen.checkoutId,
            frozen.planDigest
          )
        )?.credit?.creditedSats
      ).toBe(1_112)
      expect(
        await repository.loadMerchantOrderSettlements("c".repeat(64))
      ).toHaveLength(0)
      expect(
        await repository.loadMerchantOrderSettlements(MERCHANT, ["other"])
      ).toHaveLength(0)
      expect(JSON.stringify(matching)).not.toContain("merchant@example.test")
    } finally {
      await database.delete()
    }
  })

  it("does not project old provider records that lack a buyer-order witness", async () => {
    const database = new ConduitDB(`legacy-witness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.create(frozen)
      await repository.recordMerchantCredit(
        frozen,
        {
          mode: "ordinary_v3",
          requestId: frozen.funding.requestId,
          transferId: "legacy-transfer",
          receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
          grossSats: frozen.funding.grossFundingSats,
          creditedSats: frozen.funding.grossFundingSats - 1,
        },
        CREATED_AT + 2_000
      )
      expect(await repository.loadMerchantOrderSettlements(MERCHANT)).toEqual(
        []
      )
    } finally {
      await database.delete()
    }
  })

  it("loads an exact order witness before credit and after retirement", async () => {
    const database = new ConduitDB(`lookup-witness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const exact = witness()
      await repository.create(frozen)
      expect(
        await repository.loadMerchantOrderWitness(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).toBeNull()
      await repository.importMerchantOrderRecovery(
        createCheckoutSparkSettledReconciliation(frozen),
        exact,
        () => {}
      )
      expect(
        await repository.loadMerchantOrderWitness(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).toEqual(exact)
      await expect(
        repository.loadMerchantOrderWitness(
          BUYER,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).rejects.toThrow()
      await expect(
        repository.loadMerchantOrderWitness(
          MERCHANT,
          frozen.checkoutId,
          "f".repeat(64)
        )
      ).rejects.toThrow()
      await database.transaction(
        "rw",
        database.checkoutSparkReconciliations,
        database.checkoutSparkRetirements,
        async () => {
          await database.checkoutSparkRetirements.add({
            checkoutId: frozen.checkoutId,
            schemaVersion: 1,
            planDigest: frozen.planDigest,
            retiredAt: CREATED_AT + 3_000,
          })
          await database.checkoutSparkReconciliations.delete(frozen.checkoutId)
        }
      )
      expect(
        await repository.loadMerchantOrderWitness(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).toEqual(exact)
    } finally {
      await database.delete()
    }
  })

  it("attaches a later-found order without regressing stronger local provider state", async () => {
    const database = new ConduitDB(`late-witness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const initial = createCheckoutSparkSettledReconciliation(frozen)
      await repository.create(frozen)
      const credited = recordCheckoutSparkSettledCredit(initial, {
        requestId: frozen.funding.requestId,
        paymentHash: frozen.funding.paymentHash,
        transferId: "later-local-provider-credit",
        receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
        grossSats: frozen.funding.grossFundingSats,
        creditedSats: frozen.funding.grossFundingSats - 1,
        observedAt: CREATED_AT + 2_000,
      })
      await repository.save(credited, 1)
      const imported = await repository.importMerchantOrderRecovery(
        initial,
        witness(),
        () => {}
      )
      expect(imported.status).toBe("active")
      if (imported.status !== "active") throw new Error("Expected active")
      expect(imported.state.credit).toEqual(credited.credit)
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.orderWitness
      ).toEqual(witness())
    } finally {
      await database.delete()
    }
  })

  it("attaches a late exact witness after retirement without reviving the wallet", async () => {
    const database = new ConduitDB(`retired-witness-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.create(frozen)
      await repository.recordMerchantCredit(
        frozen,
        {
          mode: "ordinary_v3",
          requestId: frozen.funding.requestId,
          transferId: "retired-provider-credit",
          receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
          grossSats: frozen.funding.grossFundingSats,
          creditedSats: frozen.funding.grossFundingSats - 1,
        },
        CREATED_AT + 2_000
      )
      await database.transaction(
        "rw",
        database.checkoutSparkReconciliations,
        database.checkoutSparkRetirements,
        async () => {
          await database.checkoutSparkRetirements.add({
            checkoutId: frozen.checkoutId,
            schemaVersion: 1,
            planDigest: frozen.planDigest,
            retiredAt: CREATED_AT + 3_000,
          })
          await database.checkoutSparkReconciliations.delete(frozen.checkoutId)
        }
      )
      const imported = await repository.importMerchantOrderRecovery(
        createCheckoutSparkSettledReconciliation(frozen),
        witness(),
        () => {}
      )
      expect(imported.status).toBe("retired")
      expect(
        (await repository.load(frozen.checkoutId, frozen.planDigest)).status
      ).toBe("retired")
      expect(
        await repository.loadMerchantOrderSettlements(MERCHANT)
      ).toHaveLength(0)
    } finally {
      await database.delete()
    }
  })
})
