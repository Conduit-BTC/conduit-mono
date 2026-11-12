import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  productSchema,
  productShippingAdjustmentsSchema,
  shippingPolicyQuoteSchema as publicShippingQuoteSchema,
} from "../packages/core/src/schemas"
import {
  buildProductListingEventDraft,
  parseProductEvent,
} from "../packages/core/src/protocol/products"
import {
  buildShippingPolicyEventDraft,
  getMerchantShippingPolicyCoordinate,
  parsePrivateOrderShippingPolicyTags,
  parseShippingPolicy,
  quoteShippingPolicy,
  shippingPolicyQuoteSchema,
} from "../packages/core/src/protocol/shipping-policy"
import { admitPublicEvent } from "../packages/core/src/protocol/verified-public-event"

// Disposable deterministic identity for signed offline fixtures only.
const secret = new Uint8Array(32).fill(17)
const merchant = getPublicKey(secret)
const createdAt = 1_800_000_000

async function signedShippingFixture() {
  const policy = parseShippingPolicy({
    version: 2,
    title: "Domestic fixture",
    originCountry: "US",
    currency: "SATS",
    domestic: {
      rules: [
        {
          country: "US",
          bands: [{ maxWeightGrams: 1_000, priceMinor: 25 }],
        },
      ],
    },
    international: null,
  })
  const policyAdmission = await admitPublicEvent(
    finalizeEvent(
      { ...buildShippingPolicyEventDraft({ policy }), created_at: createdAt },
      secret
    )
  )
  if (policyAdmission.status !== "verified") throw new Error("Policy refused")
  const policyEvent = policyAdmission.event
  const policyCoordinate = getMerchantShippingPolicyCoordinate(merchant)
  const product = productSchema.parse({
    id: `30402:${merchant}:physical-fixture`,
    pubkey: merchant,
    title: "Physical fixture",
    price: 100,
    currency: "SATS",
    shippingWeightGrams: 100,
    shippingWeightAllowanceGrams: 20,
    shippingHandling: {
      amount: 3,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    shippingOptionId: policyCoordinate,
    createdAt: createdAt * 1_000,
    updatedAt: createdAt * 1_000,
  })
  const productAdmission = await admitPublicEvent(
    finalizeEvent(
      {
        ...buildProductListingEventDraft({ product, dTag: "physical-fixture" }),
        created_at: createdAt,
      },
      secret
    )
  )
  if (productAdmission.status !== "verified") throw new Error("Product refused")
  const productEvent = productAdmission.event
  const parsed = parseProductEvent(productEvent)
  const input = {
    policy,
    policyCoordinate,
    policyEventId: policyEvent.id,
    policyCreatedAt: policyEvent.created_at,
    merchantPubkey: merchant,
    policyEvent,
    items: [
      {
        productId: parsed.id,
        productEventId: productEvent.id,
        productCreatedAt: productEvent.created_at,
        productEvent,
        quantity: 2,
        weightGrams: parsed.shippingWeightGrams,
        shippingWeightAllowanceGrams: parsed.shippingWeightAllowanceGrams,
        shippingHandling: parsed.shippingHandling,
        currency: "SATS",
        subtotalMinor: 200,
      },
    ],
    destination: { country: "US" },
  }
  return { input, parsed, productEvent }
}

describe("signed product and shipping schema composition", () => {
  it("roundtrips exact signed physical terms through product parsing and shipping validation", async () => {
    const { input, parsed, productEvent } = await signedShippingFixture()
    expect(parsed).toMatchObject({
      format: "physical",
      type: "simple",
      specifications: [],
      shippingWeightGrams: 100,
      shippingWeightAllowanceGrams: 20,
      shippingHandling: { amount: 3, normalizedCurrency: "SATS" },
      sourceEventId: productEvent.id,
    })
    const result = quoteShippingPolicy(input)
    expect(result.status).toBe("quoted")
    if (result.status !== "quoted") throw new Error(result.status)
    expect(result.quote).toMatchObject({
      version: 2,
      combinedWeightGrams: 240,
      bandPriceMinor: 25,
      handlingMinor: 6,
      amountMinor: 31,
      amountSats: 31,
      itemProductIds: [parsed.id],
      pricingRate: null,
    })
    expect(shippingPolicyQuoteSchema.parse(result.quote)).toEqual(result.quote)
    expect(publicShippingQuoteSchema).toBe(shippingPolicyQuoteSchema)
  })

  it("rejects altered quote amounts, product bytes and unsigned action evidence", async () => {
    const { input } = await signedShippingFixture()
    const result = quoteShippingPolicy(input)
    if (result.status !== "quoted") throw new Error(result.status)
    expect(
      shippingPolicyQuoteSchema.safeParse({ ...result.quote, amountSats: 1 })
        .success
    ).toBe(false)
    const changed = structuredClone(result.quote)
    changed.items[0]!.productEvent.content = "Changed signed content"
    expect(shippingPolicyQuoteSchema.safeParse(changed).success).toBe(false)
    expect(
      quoteShippingPolicy({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          productEvent: { ...item.productEvent, sig: "0".repeat(128) },
        })),
      }).status
    ).toBe("invalid_items")
  })

  it("retains exact legacy first-band price summaries but rejects duplicate or changed summaries", () => {
    const policy = parseShippingPolicy({
      version: 1,
      title: "Retained policy",
      originCountry: "US",
      currency: "SATS",
      weightAllowanceGrams: 10,
      handlingMinor: 2,
      domestic: {
        rules: [
          {
            country: "US",
            bands: [{ maxWeightGrams: 1_000, priceMinor: 25 }],
          },
        ],
      },
      international: null,
    })
    const draft = buildShippingPolicyEventDraft({ policy })
    const price = ["price", "25", "SATS"]
    expect(parsePrivateOrderShippingPolicyTags([...draft.tags, price])).toEqual(
      policy
    )
    expect(
      parsePrivateOrderShippingPolicyTags([...draft.tags, price, price])
    ).toBeNull()
    expect(
      parsePrivateOrderShippingPolicyTags([
        ...draft.tags,
        ["price", "26", "SATS"],
      ])
    ).toBeNull()
  })

  it("keeps product shipping handling precision and currency admission", () => {
    expect(
      productShippingAdjustmentsSchema.safeParse({
        handling: { amount: 1.001, currency: "USD", normalizedCurrency: "USD" },
      }).success
    ).toBe(false)
    expect(
      productShippingAdjustmentsSchema.safeParse({
        handling: { amount: 1, currency: "USD", normalizedCurrency: "EUR" },
      }).success
    ).toBe(false)
    expect(
      productShippingAdjustmentsSchema.parse({
        weightAllowanceGrams: 0,
        handling: { amount: 1.01, currency: "USD", normalizedCurrency: "USD" },
      })
    ).toEqual({
      weightAllowanceGrams: 0,
      handling: { amount: 1.01, currency: "USD", normalizedCurrency: "USD" },
    })
  })
})
