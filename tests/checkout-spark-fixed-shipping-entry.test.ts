import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  deriveCheckoutSparkSignedCommerceObligations,
  parseProductEvent,
  parseShippingOptionEvent,
} from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { prepareCartFulfillment } from "../apps/market/src/lib/cart-shipping-options"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import {
  CheckoutSparkSettledPayoutPreflightError,
  isCheckoutSparkSettledCart,
  prepareCheckoutSparkSettledOrder,
  type PrepareCheckoutSparkSettledOrderInput,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import type { CartItem } from "../apps/market/src/lib/cart-model"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = NDKPrivateKeySigner.generate()
const ADDRESS = {
  name: "Synthetic Buyer",
  street: "123 Main Street",
  city: "New York",
  state: "NY",
  postalCode: "10001",
  country: "US",
}

async function shippingQuote(
  shippingSats = 9,
  includeDigital = false,
  shippingCurrency = "SAT",
  productCurrency = "SAT",
  variation = false
) {
  const shippingEvent = finalizeEvent(
    {
      kind: 30_406,
      created_at: NOW / 1_000 - 1,
      content: "",
      tags: [
        ["d", "physical-shipping-standard"],
        ["title", "Standard Shipping"],
        ["price", String(shippingSats), shippingCurrency],
        ["country", "US"],
        ["service", "standard"],
      ],
    },
    MERCHANT_SECRET
  )
  const shipping = parseShippingOptionEvent(shippingEvent)!
  const event = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000,
      content: "Synthetic physical listing",
      tags: [
        ["d", variation ? "physical-child" : "physical"],
        ["title", "Synthetic physical item"],
        ["price", "101", productCurrency],
        ["type", variation ? "variation" : "simple", "physical"],
        ["stock", "6"],
        ["shipping_option", shipping.id],
        ...(variation
          ? [
              ["a", `30402:${MERCHANT}:physical-family`],
              ["spec", "Size", "Large"],
            ]
          : []),
      ],
    },
    MERCHANT_SECRET
  )
  const product = { ...parseProductEvent(event), sourceEventId: event.id }
  const products = [product]
  if (includeDigital) {
    const digitalEvent = finalizeEvent(
      {
        kind: 30_402,
        created_at: NOW / 1_000,
        content: "Synthetic digital listing",
        tags: [
          ["d", "digital"],
          ["title", "Synthetic digital item"],
          ["price", "17", "SAT"],
          ["type", "simple", "digital"],
          ["stock", "6"],
        ],
      },
      MERCHANT_SECRET
    )
    products.push({
      ...parseProductEvent(digitalEvent),
      sourceEventId: digitalEvent.id,
    })
  }
  const raw = products.map((candidate) => ({
    ...createCartItemFromProduct(candidate),
    ...(candidate.type === "variation"
      ? { familyProductId: candidate.parentProductId }
      : {}),
    quantity: 3,
  }))
  const selected = { ...shipping, sourceEvent: shippingEvent }
  const reviewed = prepareCartFulfillment(raw, [selected]).items
  const authorization = await authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: reviewed,
    rawItems: raw,
    refreshedProducts: products,
    readShippingOptions: async () => [selected],
  })
  if (authorization.status !== "ok")
    throw new Error("Expected authorized fixed shipping")
  return {
    shippingEvent,
    raw,
    authorizedItems: authorization.items,
    quote: buildCheckoutSparkQuoteAuthority({
      authorization,
      rateInput: null,
      nowMs: NOW,
    }),
  }
}

function request(
  quoteAuthority: PrepareCheckoutSparkSettledOrderInput["quoteAuthority"]
): PrepareCheckoutSparkSettledOrderInput {
  return {
    checkoutId: "shipping-checkout",
    orderId: "shipping-order",
    quoteAuthority,
    buyer: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
    network: "mainnet",
    nowMs: NOW,
    shouldContinue: () => true,
    shippingAddress: structuredClone(ADDRESS),
  }
}

describe("fixed-shipping settled entry", () => {
  it("retains the exact signed selected option beside its priced checkout quote", async () => {
    const { shippingEvent, quote, authorizedItems } = await shippingQuote()
    expect(quote.shippingSourceEvents).toEqual([structuredClone(shippingEvent)])
    expect(Object.isFrozen(quote.shippingSourceEvents?.[0]?.tags)).toBe(true)
    expect(quote.pricing.totalSats).toBe(330)
    expect(quote.lines[0]?.shippingOption?.eventId).toBe(shippingEvent.id)
    expect(authorizedItems[0]?.shippingOptionLaunchUnsupported).toBe(false)
    expect(quote.products[0]?.shippingOptionLaunchUnsupported).toBe(false)
  })

  it.each([
    { shippingSats: 9, mixed: false },
    { shippingSats: 0, mixed: false },
    { shippingSats: 9, mixed: true },
    { shippingSats: 0, mixed: true },
  ])(
    "admits fixed shipping through recipient preflight without creating a wallet: %j",
    async ({ shippingSats, mixed }) => {
      const { quote, raw } = await shippingQuote(shippingSats, mixed)
      expect(isCheckoutSparkSettledCart(raw)).toBe(true)
      expect(quote.pricing.shippingCost.status).toBe(
        shippingSats === 0 ? "included" : "priced"
      )
      expect(quote.pricing.shippingCost.totalSats).toBe(shippingSats * 3)
      let recipientReads = 0
      await expect(
        prepareCheckoutSparkSettledOrder(request(quote), {
          now: () => NOW,
          readRecipientPayout: async () => {
            recipientReads++
            return { state: "unavailable", reason: "profile_unavailable" }
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
      expect(recipientReads).toBe(1)
    }
  )

  it.each([
    undefined,
    { ...ADDRESS, street: " " },
    { ...ADDRESS, postalCode: "not-a-postal-code" },
    {
      ...ADDRESS,
      country: "CA",
      city: "Toronto",
      state: "ON",
      postalCode: "M5V 3A8",
    },
  ])(
    "requires a consistent covered address before recipient reads: %#",
    async (shippingAddress) => {
      const { quote } = await shippingQuote()
      let recipientReads = 0
      await expect(
        prepareCheckoutSparkSettledOrder(
          { ...request(quote), shippingAddress },
          {
            now: () => NOW,
            readRecipientPayout: async () => {
              recipientReads++
              return { state: "unavailable", reason: "profile_unavailable" }
            },
          }
        )
      ).rejects.toThrow()
      expect(recipientReads).toBe(0)
    }
  )

  it.each([
    "missing_source",
    "missing_option",
    "different_shipping_snapshot",
    "wrong_shipping_status",
  ])(
    "requires complete unchanged fixed-shipping evidence before recipient reads: %s",
    async (mode) => {
      const { quote: original } = await shippingQuote()
      const quote = structuredClone(original)
      if (mode === "missing_source") quote.shippingSourceEvents = undefined
      if (mode === "missing_option") quote.lines[0]!.shippingOption = undefined
      if (mode === "different_shipping_snapshot")
        quote.pricing.items[0]!.shippingCountries = ["CA"]
      if (mode === "wrong_shipping_status")
        quote.pricing.shippingCost.status = "not_required"
      let recipientReads = 0
      await expect(
        prepareCheckoutSparkSettledOrder(request(quote), {
          now: () => NOW,
          readRecipientPayout: async () => {
            recipientReads++
            return { state: "unavailable", reason: "profile_unavailable" }
          },
        })
      ).rejects.toThrow()
      expect(recipientReads).toBe(0)
    }
  )

  it("keeps manual, legacy, pickup and missing-format carts outside the mounted entry", async () => {
    const { raw } = await shippingQuote()
    const physical = raw[0]!
    const unsupported: Partial<CartItem>[] = [
      { shippingOptionId: undefined },
      { shippingOptionId: `30406:${MERCHANT}:conduit-default` },
      { shippingOptionLaunchUnsupported: true },
      {
        fulfillment: {
          type: "event_pickup_pending",
          collectionCoordinate: `30405:${MERCHANT}:event`,
        },
      },
      { format: undefined },
    ]
    for (const change of unsupported)
      expect(isCheckoutSparkSettledCart([{ ...physical, ...change }])).toBe(
        false
      )
    expect(isCheckoutSparkSettledCart([])).toBe(false)
  })

  it("keeps fiat carts outside the mounted entry pending independent quote authority", async () => {
    const { raw } = await shippingQuote()
    const physical = raw[0]!
    for (const change of [
      { currency: "USD" },
      {
        sourcePrice: { amount: 1, currency: "USD", normalizedCurrency: "USD" },
      },
    ]) {
      expect(isCheckoutSparkSettledCart([{ ...physical, ...change }])).toBe(
        false
      )
    }
  })

  it("admits an exact signed SAT child variation with fixed shipping through recipient preflight", async () => {
    const { quote, raw, shippingEvent } = await shippingQuote(
      9,
      false,
      "SAT",
      "SAT",
      true
    )
    expect(isCheckoutSparkSettledCart(raw)).toBe(true)
    const evidence = buildCheckoutSparkCommerceEvidence(quote)
    expect(evidence.lines[0]?.variation).toEqual({
      familyCoordinate: `30402:${MERCHANT}:physical-family`,
      specifications: [{ key: "Size", value: "Large" }],
    })
    expect(evidence.lines[0]?.shippingOption?.eventId).toBe(shippingEvent.id)
    expect(evidence.lines[0]?.unitMerchandiseSats).toBe(101)
    expect(evidence.lines[0]?.unitShippingSats).toBe(9)
    expect(evidence.pricing).toBeUndefined()
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote: evidence,
        products: quote.products,
        shippingEvents: quote.shippingSourceEvents,
        merchantPubkey: MERCHANT,
        acceptedAtMs: NOW,
      })
    ).toEqual([{ kind: "merchant", recipientId: MERCHANT, amountSats: 330 }])
    let recipientReads = 0
    await expect(
      prepareCheckoutSparkSettledOrder(request(quote), {
        now: () => NOW,
        readRecipientPayout: async () => {
          recipientReads++
          return { state: "unavailable", reason: "profile_unavailable" }
        },
      })
    ).rejects.toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
    expect(recipientReads).toBe(1)
  })

  it.each([
    ["SAT", "SATS"],
    ["SATS", "SAT"],
  ])(
    "preserves SAT/SATS identity for signed shipping %s and product %s",
    async (shippingCurrency, productCurrency) => {
      const { quote } = await shippingQuote(
        9,
        false,
        shippingCurrency,
        productCurrency
      )
      let recipientReads = 0
      await expect(
        prepareCheckoutSparkSettledOrder(request(quote), {
          now: () => NOW,
          readRecipientPayout: async () => {
            recipientReads++
            return { state: "unavailable", reason: "profile_unavailable" }
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
      expect(recipientReads).toBe(1)
    }
  )
})
