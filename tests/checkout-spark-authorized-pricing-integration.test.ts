import { describe, expect, it } from "bun:test"
import { admitFixture } from "./helpers/public-event"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  freezeCheckoutSparkSettledPlan,
  buildShippingPolicyEventDraft,
  getMerchantShippingPolicyCoordinate,
  parseProductEvent,
  parseShippingOptionEvent,
  type CheckoutSparkCommerceQuote,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import {
  assessCheckoutSparkCommercePricingAuthority,
  getCheckoutSparkRequiredFiatCurrencies,
} from "@conduit/core/protocol/checkout-spark-commerce-pricing-authority"
import { parseCheckoutSparkPricingConfiguration } from "@conduit/core/protocol/checkout-spark-pricing-config"
import { SIGNED_PRICING_FEED_CURRENCIES } from "@conduit/core/pricing/signed-rate-client"
import type { BtcUsdRateQuote } from "@conduit/core/pricing"
import {
  getSparkCheckoutReceiveFundingTimeAnchor,
  proveSparkCheckoutReceiveCredit,
  type SparkCheckoutReceiveCreditProofInput,
} from "@conduit/core/protocol/checkout-spark-receive-credit"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import {
  fetchCheckoutSparkAuthorizedPricing,
  CheckoutSparkAuthorizedPricingUnavailable,
} from "../apps/market/src/lib/checkout-spark-authorized-pricing"
import { assertCheckoutSparkMerchantPricingAuthority } from "../apps/merchant/src/lib/checkout-spark-pricing-authority"
import { assertCheckoutSparkPrefundingPricingAuthority } from "../apps/market/src/lib/checkout-spark-prefunding-pricing-authority"
import type { SparkCheckoutReceiveRequest } from "../apps/market/src/lib/spark-wallet"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { prepareCartFulfillment } from "../apps/market/src/lib/cart-shipping-options"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

// Disposable test-runner material only; never persisted or deployment keys.
const RATE_KEY = Buffer.from(generateSecretKey()).toString("hex")
const MERCHANT_KEY = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_KEY)
const WALLET_IDENTITY = `02${"a".repeat(64)}`
const NOW = 1_800_000_000_000
const CREATED_AT = NOW + 2_000
const PROVIDER_CREATED_AT = CREATED_AT + 123
const EXPIRES_AT = CREATED_AT + 900_000
const RATE = {
  rate: 100_000,
  fetchedAt: NOW,
  source: "mempool" as const,
  fiatUsdRates: { EUR: 1.25 },
  fiatSource: "mempool" as const,
  fiatSources: { EUR: "mempool" as const },
}

function configuration() {
  return parseCheckoutSparkPricingConfiguration({
    url: "https://pricing.example/api/checkout-spark-pricing",
    publicKeys: `fixture-rate:${getCheckoutSparkPricingAuthorityPublicKey(RATE_KEY)}`,
  })!
}

function snapshot(rate: BtcUsdRateQuote = RATE) {
  const pricingAuthority = createCheckoutSparkPricingRateAttestation({
    rate,
    keyId: "fixture-rate",
    privateKeyHex: RATE_KEY,
    issuedAtMs: NOW + 1_000,
  })
  return { pricing: { version: 1 as const, rate }, pricingAuthority }
}

async function commerceQuote(): Promise<CheckoutSparkCommerceQuote> {
  const source = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000,
      tags: [
        ["d", "fiat-variation"],
        ["title", "Fiat variation"],
        ["price", "0.8", "EUR"],
        ["type", "variation", "digital"],
        ["a", `30402:${MERCHANT}:family`],
        ["spec", "Size", "Large"],
      ],
      content: "",
    },
    MERCHANT_KEY
  )
  const product = {
    ...parseProductEvent(await admitFixture(source)),
    sourceEventId: source.id,
  }
  const item = {
    ...createCartItemFromProduct(product),
    familyProductId: product.parentProductId,
    quantity: 1,
  }
  const authorization = await authorizeCurrentCheckoutItems({
    mode: "direct_payment",
    reviewedItems: [item],
    rawItems: [item],
    refreshedProducts: [product],
    readShippingOptions: async () => [],
    resolveProductFulfillment: async () => ({
      status: "standard",
      type: "digital",
      product,
    }),
    authorizePickupHandlers: async () => undefined,
  })
  if (authorization.status !== "ok")
    throw new Error("Fixture authorization failed.")
  const signed = snapshot()
  const authority = buildCheckoutSparkQuoteAuthority({
    authorization,
    rateInput: signed.pricing.rate,
    pricingAuthority: signed.pricingAuthority,
    nowMs: NOW + 1_500,
  })
  return buildCheckoutSparkCommerceEvidence(authority)
}

async function fiatShippingFixture() {
  const coordinate = getMerchantShippingPolicyCoordinate(MERCHANT)
  const policyEvent = finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({
        policy: {
          version: 2,
          title: "Standard shipping",
          originCountry: "US",
          currency: "USD",
          domestic: {
            rules: [
              {
                country: "US",
                bands: [{ maxWeightGrams: 1_000, priceMinor: 500 }],
              },
            ],
          },
          international: null,
        },
      }),
      created_at: NOW / 1_000 - 10,
    },
    MERCHANT_KEY
  )
  const parsedOption = parseShippingOptionEvent(await admitFixture(policyEvent))
  if (!parsedOption) throw new Error("Fixture shipping policy failed.")
  const option = {
    ...parsedOption,
    sourceEvent: policyEvent,
    readSource: "relay" as const,
    readCoverage: "complete" as const,
  }
  const source = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000 - 10,
      tags: [
        ["d", "fiat-shipping"],
        ["title", "Fiat shipping"],
        ["price", "20", "USD"],
        ["type", "simple", "physical"],
        ["weight", "200", "g"],
        ["shipping_option", coordinate],
      ],
      content: "",
    },
    MERCHANT_KEY
  )
  const product = {
    ...parseProductEvent(await admitFixture(source)),
    sourceEventId: source.id,
  }
  const item = { ...createCartItemFromProduct(product), quantity: 1 }
  const reviewedRate = { ...RATE, fetchedAt: NOW - 1_000 }
  const destination = { country: "US", subdivision: "NY", postalCode: "10001" }
  const reviewedItems = prepareCartFulfillment(
    [item],
    [option],
    destination,
    reviewedRate
  ).items
  return { product, item, option, reviewedRate, reviewedItems, destination }
}

function receiveEvidence(
  plan: CheckoutSparkSettledPlan
): SparkCheckoutReceiveCreditProofInput {
  return {
    expectedRequest: {
      id: plan.funding.requestId,
      network: plan.network,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      grossFundingSats: plan.funding.grossFundingSats,
    },
    expectedReceive: { mode: "ordinary_v3" },
    walletIdentityPublicKey: WALLET_IDENTITY,
    receive: {
      id: plan.funding.requestId,
      status: "TRANSFER_COMPLETED",
      network: "MAINNET",
      invoice: {
        encodedInvoice: plan.funding.paymentRequest,
        bitcoinNetwork: "MAINNET",
        paymentHash: plan.funding.paymentHash,
        amount: {
          originalValue: plan.funding.grossFundingSats,
          originalUnit: "SATOSHI",
        },
        createdAt: new Date(PROVIDER_CREATED_AT).toISOString(),
        expiresAt: new Date(EXPIRES_AT + 123).toISOString(),
      },
      transfer: {
        sparkId: "fixture-transfer",
        userRequestId: plan.funding.requestId,
        totalAmount: {
          originalValue: plan.funding.grossFundingSats,
          originalUnit: "SATOSHI",
        },
      },
    },
    transfer: {
      id: "fixture-transfer",
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: plan.funding.grossFundingSats,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: WALLET_IDENTITY,
      userRequest: { id: plan.funding.requestId },
    },
  }
}

async function preparedPlan() {
  const quote = await commerceQuote()
  const gross = calculateCheckoutSparkSettledGrossFundingSats(
    quote.commerceTotalSats
  )
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${gross * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] },
    ],
  })
  const conduit = checkoutSparkConduitFeeRecipient("production")
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "fiat-checkout",
    orderId: "fiat-order",
    merchantPubkey: MERCHANT,
    walletId: "fiat-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: quote,
    funding: {
      requestId: "fiat-receive",
      paymentRequest,
      paymentHash: "07".repeat(32),
      receiverIdentityPublicKey: WALLET_IDENTITY,
      grossFundingSats: gross,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: quote.commerceTotalSats,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "b".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: conduit,
        weightSats: calculateConduitCheckoutFeeSats(quote.commerceTotalSats),
        destination: {
          type: "lightning_address",
          value: conduit,
          source: { type: "conduit_allowlist", policy: "production" },
        },
      },
    ],
  })
}

describe("authorized fiat checkout integration", () => {
  for (const [source, fiatSource] of [
    ["mempool", "mempool"],
    ["coinbase", "floatrates"],
    ["kraken", "ecb"],
  ] as const) {
    it(`retains ${source}/${fiatSource} authority through unchanged reviewed fiat shipping and final signed evidence`, async () => {
      const fixture = await fiatShippingFixture()
      const signed = snapshot({
        ...RATE,
        source,
        fiatSource,
        fiatSources: { EUR: fiatSource },
      })
      const result = await authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        reviewedItems: fixture.reviewedItems,
        rawItems: [fixture.item],
        refreshedProducts: [fixture.product],
        readShippingOptions: async () => [fixture.option],
        destination: fixture.destination,
        rateInput: signed.pricing.rate,
        reviewedRateInput: fixture.reviewedRate,
        allowPricingRateEvidenceRefresh: true,
        authorizePickupHandlers: async () => undefined,
      })
      expect(result.status).toBe("ok")
      if (result.status !== "ok")
        throw new Error("Fixture authorization failed.")
      expect(result.items[0]?.shippingPolicyQuote?.amountSats).toBe(5_000)
      expect(
        JSON.stringify(result.items[0]?.shippingPolicyQuote?.pricingRate) ===
          JSON.stringify(signed.pricing.rate)
      ).toBe(true)
      expect(
        JSON.stringify(
          fixture.reviewedItems[0]?.shippingPolicyQuote?.pricingRate
        ) === JSON.stringify(fixture.reviewedRate)
      ).toBe(true)
      const quote = buildCheckoutSparkCommerceEvidence(
        buildCheckoutSparkQuoteAuthority({
          authorization: result,
          rateInput: signed.pricing.rate,
          pricingAuthority: signed.pricingAuthority,
          nowMs: NOW + 1_500,
        })
      )
      expect(quote.lines[0]?.unitMerchandiseSats).toBe(20_000)
      expect(quote.lines[0]?.shippingPolicy?.allocatedCostSats).toBe(5_000)
      expect(quote.commerceTotalSats).toBe(25_000)
      expect(
        assessCheckoutSparkCommercePricingAuthority({
          quote,
          acceptedAtMs: PROVIDER_CREATED_AT,
          nowMs: PROVIDER_CREATED_AT,
          trustedPublicKeys: configuration().publicKeys,
        })
      ).toBe("verified")
    })
  }

  it("requests review for normal exchange-rate movement that changes the displayed SAT price or shipping amount", async () => {
    const fixture = await fiatShippingFixture()
    const rate = { ...RATE, rate: 125_000 }
    const pricingAuthority = createCheckoutSparkPricingRateAttestation({
      rate,
      keyId: "fixture-rate",
      privateKeyHex: RATE_KEY,
      issuedAtMs: NOW + 1_000,
    })
    expect(pricingAuthority.rate.rate).toBe(125_000)
    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: fixture.reviewedItems,
      rawItems: [fixture.item],
      refreshedProducts: [fixture.product],
      readShippingOptions: async () => [fixture.option],
      destination: fixture.destination,
      rateInput: rate,
      reviewedRateInput: fixture.reviewedRate,
      allowPricingRateEvidenceRefresh: true,
      authorizePickupHandlers: async () => undefined,
    })
    expect(result.status).toBe("changed")
  })

  it("reuses the common display feed without account credentials or checkout contents", async () => {
    let calls = 0
    const authorized = await fetchCheckoutSparkAuthorizedPricing({
      currencies: ["USD", "EUR", "USD"],
      configuration: configuration(),
      shouldContinue: () => true,
      nowMs: () => NOW + 1_500,
      fetchImpl: (async (url, init) => {
        calls++
        expect(String(url) === configuration().url).toBe(true)
        expect(init?.credentials === "omit").toBe(true)
        expect(init?.cache === "no-store").toBe(true)
        expect(init?.redirect === "error").toBe(true)
        expect(init?.referrerPolicy === "no-referrer").toBe(true)
        expect(
          String(init?.body) ===
            JSON.stringify({ currencies: SIGNED_PRICING_FEED_CURRENCIES })
        ).toBe(true)
        return Response.json(snapshot())
      }) as typeof fetch,
    })
    expect(calls).toBe(1)
    expect(Object.isFrozen(authorized)).toBe(true)
    expect(Object.isFrozen(authorized.pricing.rate)).toBe(true)
    expect(Object.isFrozen(authorized.pricingAuthority)).toBe(true)
  })

  it("fails closed with missing public deployment configuration before any request", async () => {
    let calls = 0
    let code = ""
    try {
      await fetchCheckoutSparkAuthorizedPricing({
        currencies: ["USD"],
        configuration: null,
        shouldContinue: () => true,
        fetchImpl: (async () => {
          calls++
          return Response.json(snapshot())
        }) as typeof fetch,
      })
    } catch (error) {
      if (error instanceof CheckoutSparkAuthorizedPricingUnavailable)
        code = error.code
    }
    expect(code).toBe("unconfigured")
    expect(calls).toBe(0)
  })

  it("reports a normal service outage without forwarding its response contents", async () => {
    let code = ""
    try {
      await fetchCheckoutSparkAuthorizedPricing({
        currencies: ["USD"],
        configuration: configuration(),
        shouldContinue: () => true,
        fetchImpl: (async () =>
          new Response("Provider unavailable", {
            status: 503,
          })) as typeof fetch,
      })
    } catch (error) {
      if (error instanceof CheckoutSparkAuthorizedPricingUnavailable)
        code = error.code
    }
    expect(code).toBe("unavailable")
  })

  it("abandons a legitimate in-flight rate lookup when the shopper leaves checkout", async () => {
    let current = true
    let code = ""
    try {
      await fetchCheckoutSparkAuthorizedPricing({
        currencies: ["USD"],
        configuration: configuration(),
        shouldContinue: () => current,
        nowMs: () => NOW + 1_500,
        fetchImpl: (async () => {
          current = false
          return Response.json(snapshot())
        }) as typeof fetch,
      })
    } catch (error) {
      if (error instanceof CheckoutSparkAuthorizedPricingUnavailable)
        code = error.code
    }
    expect(code).toBe("session_changed")
  })

  it("retains genuine rate authority through variation pricing, freeze and exact provider-backed recovery", async () => {
    const plan = await preparedPlan()
    expect(plan.commerceQuote.commerceTotalSats).toBe(1_000)
    expect(
      getCheckoutSparkRequiredFiatCurrencies(plan.commerceQuote).join(",")
    ).toBe("EUR")
    expect(plan.commerceQuote.lines[0]?.variation?.specifications.length).toBe(
      1
    )
    expect(
      assessCheckoutSparkCommercePricingAuthority({
        quote: plan.commerceQuote,
        acceptedAtMs: NOW + 1_500,
        nowMs: NOW + 1_500,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
    const proof = proveSparkCheckoutReceiveCredit(receiveEvidence(plan))
    const anchor = getSparkCheckoutReceiveFundingTimeAnchor(proof)
    expect(anchor?.createdAtMs).toBe(PROVIDER_CREATED_AT)
    expect(anchor?.invoiceCreatedAtMs).toBe(CREATED_AT)
    expect(anchor?.expiresAtMs).toBe(EXPIRES_AT + 123)
    expect(anchor?.invoiceExpiresAtMs).toBe(EXPIRES_AT)
    expect(Object.isFrozen(anchor)).toBe(true)
    assertCheckoutSparkMerchantPricingAuthority({
      plan,
      fundingProof: proof,
      trustedPublicKeys: configuration().publicKeys,
    })
    expect(
      assessCheckoutSparkCommercePricingAuthority({
        quote: plan.commerceQuote,
        acceptedAtMs: anchor!.createdAtMs,
        trustedPublicKeys: configuration().publicKeys,
        nowMs: NOW + 86_400_000,
      })
    ).toBe("expired")
    expect(
      assessCheckoutSparkCommercePricingAuthority({
        quote: plan.commerceQuote,
        acceptedAtMs: anchor!.createdAtMs,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
  })

  it("admits a normal fresh fiat receive from its RAM-only provider creation precision", async () => {
    const plan = await preparedPlan()
    const receive: SparkCheckoutReceiveRequest = {
      walletId: plan.walletId,
      network: plan.network,
      id: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      providerStatus: "INVOICE_CREATED",
      requiredNetSats: plan.funding.grossFundingSats,
      grossFundingSats: plan.funding.grossFundingSats,
      expirySecs: 900,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    }
    Object.defineProperties(receive, {
      providerCreatedAtMs: { value: PROVIDER_CREATED_AT },
      providerExpiresAtMs: { value: EXPIRES_AT + 123 },
    })
    assertCheckoutSparkPrefundingPricingAuthority({
      quote: plan.commerceQuote,
      receive,
      nowMs: CREATED_AT + 500,
      trustedPublicKeys: configuration().publicKeys,
    })
    const saved: unknown = JSON.parse(JSON.stringify(receive))
    expect(
      !!saved &&
        typeof saved === "object" &&
        !("providerCreatedAtMs" in saved) &&
        !("providerExpiresAtMs" in saved)
    ).toBe(true)
  })

  it("preserves legacy receive proof shape when historical provider snapshots lack time metadata", async () => {
    const evidence = receiveEvidence(await preparedPlan())
    delete evidence.receive.invoice.createdAt
    delete evidence.receive.invoice.expiresAt
    const proof = proveSparkCheckoutReceiveCredit(evidence)
    expect(proof.creditedSats).toBe(evidence.expectedRequest.grossFundingSats)
    expect(getSparkCheckoutReceiveFundingTimeAnchor(proof) === null).toBe(true)
    expect(Object.keys(proof).length).toBe(6)
  })

  it("does not require a shared rate service for deterministic SAT, MSAT or BTC prices", () => {
    for (const [currency, amount] of [
      ["SATS", 1_000],
      ["MSATS", 1_000_000],
      ["BTC", 0.00001],
    ] as const) {
      const quote: CheckoutSparkCommerceQuote = {
        commerceTotalSats: 1_000,
        lines: [
          {
            productCoordinate: `30402:${MERCHANT}:bitcoin-unit`,
            productEventId: "b".repeat(64),
            merchantPubkey: MERCHANT,
            quantity: 1,
            unitMerchandiseSats: 1_000,
            unitShippingSats: 0,
            sourcePrice: { currency, normalizedCurrency: currency, amount },
          },
        ],
      }
      expect(getCheckoutSparkRequiredFiatCurrencies(quote).length).toBe(0)
      expect(
        assessCheckoutSparkCommercePricingAuthority({
          quote,
          acceptedAtMs: CREATED_AT,
          trustedPublicKeys: null,
        })
      ).toBe("deterministic")
    }
  })
})
