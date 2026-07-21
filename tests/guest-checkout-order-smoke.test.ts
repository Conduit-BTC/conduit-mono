import "fake-indexeddb/auto"

import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import {
  buildGuestCheckoutOrderRumor,
  formatGuestCheckoutOrderSmokeFailure,
  parseGuestCheckoutOrderSmokeConfig,
  runGuestCheckoutOrderSmoke,
} from "../scripts/smoke/guest_checkout_order_runner"
import type { ReadyCheckoutPricing } from "../apps/market/src/lib/checkout-order"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 7])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const GUEST_SIGNER = new NDKPrivateKeySigner(
  nip19.nsecEncode(Uint8Array.from([...new Uint8Array(31), 8]))
)

function environment(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC: nip19.nsecEncode(MERCHANT_SECRET),
    GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: MERCHANT_PUBKEY,
    GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${MERCHANT_PUBKEY}:fixture`,
    GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY: "US",
    GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE: "00000",
    ...overrides,
  }
}

function pricing(
  format: "physical" | "digital" = "digital"
): ReadyCheckoutPricing {
  return {
    status: "ok",
    itemSubtotalSats: 10,
    totalSats: format === "physical" ? 12 : 10,
    totalMsats: format === "physical" ? 12_000 : 10_000,
    shippingCost: {
      status: format === "physical" ? "priced" : "not_required",
      totalSats: format === "physical" ? 2 : 0,
      missingProductIds: [],
    },
    items: [
      {
        productId: `30402:${MERCHANT_PUBKEY}:fixture`,
        title: "Fixture product",
        format,
        quantity: 1,
        priceAtPurchase: 10,
        currency: "SATS",
        shippingCostSats: format === "physical" ? 2 : undefined,
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        sourceShippingCost:
          format === "physical"
            ? {
                amount: 0.2,
                currency: "USD",
                normalizedCurrency: "USD",
              }
            : undefined,
        shippingOptionId:
          format === "physical"
            ? `30406:${MERCHANT_PUBKEY}:shipping`
            : undefined,
        shippingOptionDTag: format === "physical" ? "shipping" : undefined,
        shippingCountries: format === "physical" ? ["US"] : [],
        shippingCountryRules:
          format === "physical"
            ? [
                {
                  code: "US",
                  name: "United States",
                  restrictTo: [],
                  exclude: [],
                },
              ]
            : [],
      },
    ],
    quote: {
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    },
    approximate: true,
  }
}

function identity(orderId = "smoke-order") {
  return {
    kind: "guest_ephemeral" as const,
    orderId,
    merchantPubkey: MERCHANT_PUBKEY,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    pubkey: GUEST_SIGNER.pubkey,
    signer: GUEST_SIGNER,
  }
}

describe("guest checkout order smoke", () => {
  it("validates that the protected signer owns the product fixture", () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    expect(config.merchantPubkey).toBe(MERCHANT_PUBKEY)
    expect(config.productAddress).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(config.shippingCountry).toBe("US")
  })

  it("rejects signer and product ownership mismatches", () => {
    for (const overrides of [
      { GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: "d".repeat(64) },
      {
        GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${"e".repeat(64)}:fixture`,
      },
    ]) {
      expect(() =>
        parseGuestCheckoutOrderSmokeConfig(environment(overrides))
      ).toThrow()
    }
  })

  it("builds a recognizable, schema-valid ephemeral guest order", () => {
    const rumor = buildGuestCheckoutOrderRumor({
      orderId: "smoke-order",
      identity: identity(),
      merchantPubkey: MERCHANT_PUBKEY,
      pricing: pricing("physical"),
      shippingCountry: "US",
      shippingPostalCode: "00000",
      createdAt: 1_700_000_000_000,
    })
    const payload = JSON.parse(rumor.content)

    expect(rumor.kind).toBe(16)
    expect(rumor.tags).toContainEqual(["type", "order"])
    expect(payload.buyerIdentityKind).toBe("guest_ephemeral")
    expect(payload.guestContact.email).toEndWith(".invalid")
    expect(payload.note).toContain("do not fulfill")
    expect(payload.items[0].productId).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.items[0].sourceShippingCost).toEqual({
      amount: 0.2,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
  })

  it("preserves manual-shipping undefined item costs", () => {
    const manualPricing = pricing("physical")
    manualPricing.totalSats = 10
    manualPricing.totalMsats = 10_000
    manualPricing.shippingCost = {
      status: "manual",
      totalSats: 0,
      missingProductIds: [manualPricing.items[0]!.productId],
    }
    manualPricing.items[0]!.shippingCostSats = undefined
    manualPricing.items[0]!.sourceShippingCost = undefined

    const rumor = buildGuestCheckoutOrderRumor({
      orderId: "smoke-order",
      identity: identity(),
      merchantPubkey: MERCHANT_PUBKEY,
      pricing: manualPricing,
      shippingCountry: "US",
      shippingPostalCode: "00000",
      createdAt: 1_700_000_000_000,
    })
    const payload = JSON.parse(rumor.content)

    expect(payload.shippingCostStatus).toBe("manual")
    expect(payload).not.toHaveProperty("shippingCostSats")
    expect(payload.items[0]).not.toHaveProperty("shippingCostSats")
    expect(payload.items[0]).not.toHaveProperty("sourceShippingCost")
  })

  it("publishes once and proves Merchant recovers the same guest order", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published:
      | Parameters<
          NonNullable<
            Parameters<typeof runGuestCheckoutOrderSmoke>[1]
          >["publishOrder"]
        >[0]
      | null = null

    const result = await runGuestCheckoutOrderSmoke(config, {
      getProduct: async () =>
        ({
          data: {
            addressId: `30402:${MERCHANT_PUBKEY}:fixture`,
            product: {
              pubkey: MERCHANT_PUBKEY,
              title: "Fixture product",
              price: 1,
              currency: "USD",
              sourcePrice: {
                amount: 1,
                currency: "USD",
                normalizedCurrency: "USD",
              },
              format: "digital",
              stock: 1,
              shippingCountryRules: [],
              shippingCountries: [],
            },
          },
        }) as never,
      getPricingRate: async () => ({
        rate: 100_000,
        fetchedAt: 1_700_000_000_000,
        source: "mempool",
        fiatUsdRates: {},
        fiatSource: "frankfurter",
      }),
      createOrderId: () => "smoke-order",
      createGuestIdentity: () => identity(),
      publishOrder: async (rumor) => {
        published = rumor
        return { buyerSelfCopyError: null, localCacheError: null }
      },
      getMerchantOrders: async () => {
        if (!published) throw new Error("Order was not published")
        const payload = JSON.parse(published.content)
        return {
          data: [
            {
              id: "smoke-order",
              orderId: "smoke-order",
              merchantPubkey: MERCHANT_PUBKEY,
              buyerPubkey: GUEST_SIGNER.pubkey,
              latestAt: 1_700_000_000_000,
              latestType: "order",
              status: null,
              totalSummary: "10 SATS",
              preview: "Order for 10 SATS",
              messageCount: 1,
              messages: [
                {
                  id: "rumor-id",
                  orderId: "smoke-order",
                  type: "order",
                  createdAt: 1_700_000_000,
                  senderPubkey: GUEST_SIGNER.pubkey,
                  recipientPubkey: MERCHANT_PUBKEY,
                  rawContent: published.content,
                  payload,
                },
              ],
            },
          ],
          meta: {
            plan: "protected_conversation_list",
            source: "commerce",
            fetchedAt: 1_700_000_000_000,
            stale: false,
            degraded: false,
            capabilities: [],
          },
        } as never
      },
      nowMs: () => 1_700_000_000_000,
      sleep: async () => {},
    })

    expect(result).toEqual({ status: "passed" })
    expect(published).not.toBeNull()
    const payload = JSON.parse(published!.content)
    expect(payload.items[0].priceAtPurchase).toBe(1_000)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
  })

  it("formats only a fixed failure stage without credential details", async () => {
    const merchantSecret = environment().GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC!
    let error: unknown
    try {
      parseGuestCheckoutOrderSmokeConfig(
        environment({ GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC: "private-invalid" })
      )
    } catch (caught) {
      error = caught
    }
    const formatted = formatGuestCheckoutOrderSmokeFailure(error)

    expect(formatted).toBe(
      "Guest checkout order smoke failed at configuration."
    )
    expect(formatted).not.toContain(merchantSecret)
    expect(formatted).not.toContain("private-invalid")
  })
})
