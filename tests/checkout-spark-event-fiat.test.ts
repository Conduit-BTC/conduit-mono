import { expect, it } from "bun:test"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { parseProductEvent } from "@conduit/core"
import {
  freezeCheckoutSparkSettledEventPlan,
  restoreCheckoutSparkSettledPlan,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { validateCheckoutSparkPlanSources } from "@conduit/core/protocol/checkout-spark-plan-sources"
import {
  verifyCheckoutSparkPricingRateAttestation,
  parseCheckoutSparkPricingAuthorityPublicKeys,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { admitFixture } from "./helpers/public-event"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

it.each(["USD", "EUR"] as const)(
  "preserves a signed %s variation quote through event admission and historical plan recovery",
  async (currency) => {
    const commerceTotalSats = currency === "USD" ? 2_000 : 2_500
    const f = checkoutSparkEventMarketFixture({
      commerceTotalSats,
      supplier: false,
      variation: true,
      schedule: true,
    })
    const product = f.signMerchant({
      ...f.events.product,
      tags: f.events.product.tags.map((tag) =>
        tag[0] === "price" ? ["price", "2", currency] : tag
      ),
    })
    const rate = {
      rate: 100_000,
      fetchedAt: AT - 1_000,
      source: "mempool" as const,
      fiatUsdRates: { EUR: 1.25 },
      fiatSource: "mempool" as const,
    }
    // Dedicated test-runner pricing identity; never an app/service credential.
    const privateKeyHex = Buffer.from(generateSecretKey()).toString("hex")
    const attestation = createCheckoutSparkPricingRateAttestation({
      rate,
      keyId: "event-fixture",
      privateKeyHex,
      issuedAtMs: AT - 500,
    })
    const trustedPublicKeys = parseCheckoutSparkPricingAuthorityPublicKeys(
      `event-fixture:${getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)}`
    )
    const sourceEvents = f.sourceEvents.map((event) =>
      event.id === f.events.product.id ? product : event
    )
    const eventMarket = {
      ...f.eventMarket,
      lines: f.eventMarket.lines.map((line) => ({
        ...line,
        productEventId: product.id,
      })),
    }
    const plan = freezeCheckoutSparkSettledEventPlan({
      ...f.input,
      eventMarket,
      commerceQuote: {
        ...f.input.commerceQuote,
        pricing: { version: 1, rate },
        pricingAuthority: attestation,
        lines: f.input.commerceQuote!.lines.map((line) => ({
          ...line,
          productEventId: product.id,
          sourcePrice: { amount: 2, currency, normalizedCurrency: currency },
        })),
      },
    })
    const graph = { ...f, plan, sourceEvents, events: { ...f.events, product } }
    const order = createCheckoutSparkEventMarketFixtureOrder(
      graph,
      getPublicKey(generateSecretKey()),
      AT
    )
    const listing = {
      ...parseProductEvent(await admitFixture(product)),
      sourceEventId: product.id,
    }
    const item = {
      ...createCartItemFromProduct(listing, order.items[0]!.fulfillment),
      familyProductId: listing.parentProductId,
      quantity: 1,
    }
    const authority = buildCheckoutSparkQuoteAuthority({
      authorization: {
        status: "ok",
        items: [item],
        listingReadProducts: [listing],
        fulfillmentResolvedProducts: [listing],
        shippingOptionEvidence: { status: "not_required", options: [] },
        pickupSourceEvents: sourceEvents,
      },
      rateInput: rate,
      pricingAuthority: attestation,
      nowMs: AT,
    })
    const quote = buildCheckoutSparkCommerceEvidence(authority)
    expect(quote.commerceTotalSats).toBe(commerceTotalSats)
    expect(quote.lines[0]!.variation?.familyCoordinate).toBe(
      f.input.commerceQuote!.lines[0]!.variation!.familyCoordinate
    )
    expect(quote.pricingAuthority?.signature).toBe(attestation.signature)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: quote.pricingAuthority,
        pricing: quote.pricing!,
        acceptedAtMs: AT,
        nowMs: AT,
        trustedPublicKeys,
      })
    ).toBe("verified")
    const recovered = restoreCheckoutSparkSettledPlan(
      JSON.parse(JSON.stringify(plan))
    )
    validateCheckoutSparkPlanSources(recovered, sourceEvents)
    expect(recovered.planDigest).toBe(plan.planDigest)
    expect(recovered.commerceQuote.lines[0]!.sourcePrice?.currency).toBe(
      currency
    )
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: recovered.commerceQuote.pricingAuthority,
        pricing: recovered.commerceQuote.pricing!,
        acceptedAtMs: recovered.funding.createdAt,
        trustedPublicKeys,
      })
    ).toBe("verified")
    expect(() =>
      validateCheckoutSparkPlanSources(
        {
          ...plan,
          commerceQuote: {
            ...plan.commerceQuote,
            pricing: { version: 1, rate: { ...rate, rate: 200_000 } },
          },
        },
        sourceEvents
      )
    ).toThrow()
  }
)
