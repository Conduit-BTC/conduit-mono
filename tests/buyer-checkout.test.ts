/**
 * Unit tests for buyer checkout validation, fast-checkout eligibility,
 * LNURL helpers, and NWC URI parsing.
 */
import { describe, expect, it, mock, afterEach } from "bun:test"
import {
  validateShippingFields,
  isFastCheckoutEligible,
  getFastCheckoutUnavailableReasons,
  type ShippingFormState,
} from "../apps/market/src/lib/checkout-validation"
import { payCheckoutInvoice } from "../apps/market/src/lib/payment-rails"
import {
  buildCheckoutPricingIntent,
  buildDefaultZapContent,
  buildPendingCheckoutManualInvoice,
  buildZapRequestContent,
  CHECKOUT_QUOTE_MAX_AGE_MS,
  getLnurlReadyForCheckoutPayment,
  getCheckoutShippingCost,
  requestCheckoutLnurlInvoice,
} from "../apps/market/src/lib/checkout-payment"
import type { CartItem } from "../apps/market/src/hooks/useCart"
import {
  fetchLnurlPayMetadata,
  fetchLnurlInvoice,
  fetchZapInvoice,
} from "../packages/core/src/protocol/lightning"
import { parseNwcUri } from "../packages/core/src/protocol/nwc"
import {
  getShippingDestinationEligibility,
  parseShippingOptionEvent,
} from "../packages/core/src/protocol/shipping"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import { paymentProofMessageSchema } from "../packages/core/src/schemas"

const FAKE_PUBKEY = "a".repeat(64)
const FAKE_SECRET = "b".repeat(64)
const VALID_NWC_URI = `nostr+walletconnect://${FAKE_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com&secret=${FAKE_SECRET}`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validShipping(
  overrides: Partial<ShippingFormState> = {}
): ShippingFormState {
  return {
    firstName: "Alice",
    lastName: "Smith",
    street: "123 Main St",
    line2: "",
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    country: "US",
    name: "Alice Smith",
    phone: "",
    email: "",
    ...overrides,
  }
}

// ─── validateShippingFields ───────────────────────────────────────────────────

describe("validateShippingFields", () => {
  it("returns no errors for a fully valid form", () => {
    expect(validateShippingFields(validShipping())).toEqual([])
  })

  it("requires firstName", () => {
    const errors = validateShippingFields(validShipping({ firstName: "" }))
    expect(errors.some((e) => e.field === "firstName")).toBe(true)
  })

  it("rejects firstName longer than 50 chars", () => {
    const errors = validateShippingFields(
      validShipping({ firstName: "A".repeat(51) })
    )
    expect(errors.some((e) => e.field === "firstName")).toBe(true)
  })

  it("requires lastName", () => {
    const errors = validateShippingFields(validShipping({ lastName: "" }))
    expect(errors.some((e) => e.field === "lastName")).toBe(true)
  })

  it("rejects lastName longer than 50 chars", () => {
    const errors = validateShippingFields(
      validShipping({ lastName: "B".repeat(51) })
    )
    expect(errors.some((e) => e.field === "lastName")).toBe(true)
  })

  it("requires street", () => {
    const errors = validateShippingFields(validShipping({ street: "  " }))
    expect(errors.some((e) => e.field === "street")).toBe(true)
  })

  it("requires city", () => {
    const errors = validateShippingFields(validShipping({ city: "" }))
    expect(errors.some((e) => e.field === "city")).toBe(true)
  })

  it("requires postalCode", () => {
    const errors = validateShippingFields(validShipping({ postalCode: "" }))
    expect(errors.some((e) => e.field === "postalCode")).toBe(true)
  })

  it("rejects invalid country code", () => {
    const errors = validateShippingFields(validShipping({ country: "USA" }))
    expect(errors.some((e) => e.field === "country")).toBe(true)
  })

  it("accepts lowercase country code (normalised internally)", () => {
    const errors = validateShippingFields(validShipping({ country: "gb" }))
    expect(errors.some((e) => e.field === "country")).toBe(false)
  })

  it("rejects malformed email when provided", () => {
    const errors = validateShippingFields(
      validShipping({ email: "not-an-email" })
    )
    expect(errors.some((e) => e.field === "email")).toBe(true)
  })

  it("accepts valid email", () => {
    const errors = validateShippingFields(
      validShipping({ email: "alice@example.com" })
    )
    expect(errors.some((e) => e.field === "email")).toBe(false)
  })

  it("allows blank email (optional field)", () => {
    expect(validateShippingFields(validShipping({ email: "" }))).toEqual([])
  })

  it("rejects malformed phone when provided", () => {
    const errors = validateShippingFields(validShipping({ phone: "abc" }))
    expect(errors.some((e) => e.field === "phone")).toBe(true)
  })

  it("accepts valid phone", () => {
    const errors = validateShippingFields(
      validShipping({ phone: "+1 800 555-1234" })
    )
    expect(errors.some((e) => e.field === "phone")).toBe(false)
  })

  it("allows blank phone (optional field)", () => {
    expect(validateShippingFields(validShipping({ phone: "" }))).toEqual([])
  })

  it("accumulates multiple errors at once", () => {
    const errors = validateShippingFields(
      validShipping({ firstName: "", lastName: "", city: "" })
    )
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── isFastCheckoutEligible ───────────────────────────────────────────────────

describe("isFastCheckoutEligible", () => {
  it("returns true when all conditions met", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
      })
    ).toBe(true)
  })

  it("returns false when wallet is not pay-capable", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: false,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when merchantLud16 is missing", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: undefined,
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when merchantLud16 is empty string", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "",
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when LNURL does not allow Nostr", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: false,
      })
    ).toBe(false)
  })

  it("returns unavailable reasons for pricing and shipping readiness", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        pricingReady: false,
        shippingEligible: false,
        shippingState: "country_unsupported",
      })
    ).toEqual([
      "Refresh price conversion before paying.",
      "Merchant shipping zone does not include this country.",
    ])
  })

  it("reports missing product-level shipping data separately", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        shippingEligible: false,
        shippingState: "missing_product_zone",
      })
    ).toEqual([
      "A product in this cart is missing product-level shipping-zone data.",
    ])
  })

  it("does not report zap support when the merchant has no Lightning Address", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: false,
        merchantLud16: undefined,
        lnurlAllowsNostr: false,
      })
    ).toEqual([
      "Connect a Lightning wallet or browser payment method.",
      "Merchant has not added a Lightning Address.",
    ])
  })

  it("reports zap support only after a Lightning Address exists", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: false,
      })
    ).toEqual([
      "Merchant Lightning Address does not advertise Nostr zap support.",
    ])
  })

  it("does not require public zap support for private LNURL checkout", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        requiresNostrZap: false,
      })
    ).toEqual([])
  })

  it("enables private checkout but disables public zap when LNURL-pay lacks NIP-57", () => {
    expect(
      getLnurlReadyForCheckoutPayment({
        visibility: "private_checkout",
        lnurlPayAvailable: true,
        lnurlAllowsNostr: false,
      })
    ).toBe(true)
    expect(
      getLnurlReadyForCheckoutPayment({
        visibility: "public_zap",
        lnurlPayAvailable: true,
        lnurlAllowsNostr: false,
      })
    ).toBe(false)
  })

  it("shows a generic LNURL readiness reason for private checkout metadata failures", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: false,
        requiresNostrZap: false,
      })
    ).toEqual(["Merchant Lightning Address could not be checked."])
  })

  it("blocks fast checkout when shipping cost is not fixed", () => {
    expect(
      getFastCheckoutUnavailableReasons({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        shippingPriced: false,
      })
    ).toEqual([
      "Shipping cost is coordinated with the merchant, so direct payment is disabled.",
    ])
  })
})

// ─── checkout payment helpers ────────────────────────────────────────────────

function cartItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "product-1",
    merchantPubkey: FAKE_PUBKEY,
    title: "Notebook",
    price: 1000,
    currency: "SATS",
    quantity: 1,
    ...overrides,
  }
}

describe("checkout payment helpers", () => {
  it("creates SATS purchase payload from a fresh non-SATS quote", () => {
    const now = 1_700_000_000_000
    const intent = buildCheckoutPricingIntent(
      [
        cartItem({
          price: 10,
          currency: "USD",
          sourcePrice: {
            amount: 10,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        }),
      ],
      {
        rate: 50_000,
        fetchedAt: now,
        source: "mempool",
      },
      now + 30_000
    )

    expect(intent.status).toBe("ok")
    if (intent.status !== "ok") return
    expect(intent.totalSats).toBe(20_000)
    expect(intent.totalMsats).toBe(20_000_000)
    expect(intent.items[0]).toMatchObject({
      productId: "product-1",
      priceAtPurchase: 20_000,
      currency: "SATS",
      sourcePrice: {
        amount: 10,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(intent.quote?.rate).toBe(50_000)
  })

  it("recomputes cached fiat sats from the fresh quote at click time", () => {
    const now = 1_700_000_000_000
    const intent = buildCheckoutPricingIntent(
      [
        cartItem({
          price: 10,
          currency: "USD",
          priceSats: 99_999,
          sourcePrice: {
            amount: 10,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        }),
      ],
      {
        rate: 50_000,
        fetchedAt: now,
        source: "mempool",
      },
      now
    )

    expect(intent.status).toBe("ok")
    if (intent.status !== "ok") return
    expect(intent.items[0]?.priceAtPurchase).toBe(20_000)
    expect(intent.totalSats).toBe(20_000)
  })

  it("adds known physical shipping costs to checkout totals", () => {
    const intent = buildCheckoutPricingIntent(
      [cartItem({ quantity: 2, shippingCostSats: 500 })],
      null
    )

    expect(intent.status).toBe("ok")
    if (intent.status !== "ok") return
    expect(intent.itemSubtotalSats).toBe(2_000)
    expect(intent.shippingCost).toEqual({
      status: "priced",
      totalSats: 1_000,
      missingProductIds: [],
    })
    expect(intent.totalSats).toBe(3_000)
    expect(intent.items[0]?.shippingCostSats).toBe(500)
  })

  it("summarizes shipping as manual until every physical item is priced", () => {
    expect(getCheckoutShippingCost([cartItem()])).toEqual({
      status: "manual",
      totalSats: 0,
      missingProductIds: ["product-1"],
    })
    expect(getCheckoutShippingCost([cartItem({ format: "digital" })])).toEqual({
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    })
    expect(
      getCheckoutShippingCost([cartItem({ shippingCostSats: 0 })])
    ).toEqual({
      status: "included",
      totalSats: 0,
      missingProductIds: [],
    })
  })

  it("blocks direct payment when a non-SATS quote is stale", () => {
    const now = 1_700_000_000_000
    const intent = buildCheckoutPricingIntent(
      [cartItem({ price: 10, currency: "USD" })],
      {
        rate: 50_000,
        fetchedAt: now - CHECKOUT_QUOTE_MAX_AGE_MS - 1,
        source: "mempool",
      },
      now
    )

    expect(intent).toMatchObject({
      status: "error",
      code: "stale_quote",
    })
  })

  it("keeps digital shipping ready while stale fiat pricing blocks direct payment", () => {
    const now = 1_700_000_000_000
    const items = [
      cartItem({
        format: "digital",
        price: 1,
        currency: "USD",
        priceSats: 1_298,
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
    ]
    const intent = buildCheckoutPricingIntent(
      items,
      {
        rate: 77_041,
        fetchedAt: now - CHECKOUT_QUOTE_MAX_AGE_MS - 1,
        source: "mempool",
      },
      now
    )
    const shippingCost = getCheckoutShippingCost(items)

    expect(shippingCost).toEqual({
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    })
    expect(intent).toMatchObject({
      status: "error",
      code: "stale_quote",
    })
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        pricingReady: intent.status === "ok",
        shippingEligible: true,
        shippingState: "not_required",
        shippingPriced: shippingCost.status !== "manual",
      })
    ).toBe(false)
  })

  it("allows fast checkout for a digital fiat item once pricing is fresh", () => {
    const now = 1_700_000_000_000
    const items = [
      cartItem({
        format: "digital",
        price: 1,
        currency: "USD",
        priceSats: 999_999,
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
    ]
    const intent = buildCheckoutPricingIntent(
      items,
      {
        rate: 77_041,
        fetchedAt: now,
        source: "mempool",
      },
      now
    )
    const shippingCost = getCheckoutShippingCost(items)

    expect(intent.status).toBe("ok")
    if (intent.status !== "ok") return
    expect(intent.totalSats).toBe(1_298)
    expect(shippingCost.status).toBe("not_required")
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
        pricingReady: true,
        shippingEligible: true,
        shippingState: "not_required",
        shippingPriced: shippingCost.status !== "manual",
      })
    ).toBe(true)
  })

  it("builds public zap content from basic cart details only", () => {
    const content = buildDefaultZapContent({
      items: [
        cartItem({
          title: "Notebook",
          quantity: 2,
        }),
      ],
      merchantName: "Merchant",
    })
    expect(content).toBe("Paid for 2 items from Merchant on Conduit.")
    expect(content).not.toContain("Notebook")
    expect(content).not.toContain("order")
    expect(content).not.toContain("Phone")
  })

  it("uses generic item-count copy for single-item public zaps", () => {
    const content = buildDefaultZapContent({
      items: [
        cartItem({
          title: "Private Product Name",
          quantity: 1,
        }),
      ],
      merchantName: "Merchant",
    })

    expect(content).toBe("Paid for 1 item from Merchant on Conduit.")
    expect(content).not.toContain("Private Product Name")
  })

  it("uses empty zap content for private checkout", () => {
    expect(buildZapRequestContent("private_checkout", "hello public")).toBe("")
    expect(buildZapRequestContent("public_zap", "hello\npublic")).toBe(
      "hello public"
    )
  })

  it("requests a private LNURL invoice without signing a zap request or waiting for receipts", async () => {
    const fetchLnurl = mock(async () => ({ invoice: "lnbc1private" }))
    const fetchZap = mock(async () => {
      throw new Error("should not fetch zap invoice")
    })
    const signZapRequest = mock(async () => {
      throw new Error("should not sign zap request")
    })

    const result = await requestCheckoutLnurlInvoice(
      {
        visibility: "private_checkout",
        lnurlCallback: "https://wallet.example/cb",
        amountMsats: 50_000,
        lnurl: "lnurl1test",
        recipientPubkey: FAKE_PUBKEY,
        zapContent: "public note",
        explicitRelayUrls: ["wss://explicit.example"],
        publicRelayUrls: ["wss://public.example"],
      },
      {
        fetchLnurlInvoice: fetchLnurl as never,
        fetchZapInvoice: fetchZap as never,
        signZapRequest: signZapRequest as never,
      }
    )

    expect(result).toEqual({
      invoice: "lnbc1private",
      zapRelayUrls: [],
      shouldWaitForZapReceipt: false,
    })
    expect(fetchLnurl).toHaveBeenCalledWith("https://wallet.example/cb", 50_000)
    expect(fetchZap).toHaveBeenCalledTimes(0)
    expect(signZapRequest).toHaveBeenCalledTimes(0)
  })

  it("requests public zap invoices with a signed request and receipt path", async () => {
    const fetchLnurl = mock(async () => {
      throw new Error("should not fetch plain invoice")
    })
    const fetchZap = mock(async () => ({ invoice: "lnbc1public" }))
    const signZapRequest = mock(async (draft) => ({
      id: "zap-request-id",
      rawEvent: {
        kind: draft.kind,
        content: draft.content,
        tags: draft.tags,
      },
    }))

    const result = await requestCheckoutLnurlInvoice(
      {
        visibility: "public_zap",
        lnurlCallback: "https://wallet.example/cb",
        amountMsats: 50_000,
        lnurl: "lnurl1test",
        recipientPubkey: FAKE_PUBKEY,
        zapContent: "hello\npublic",
        explicitRelayUrls: ["wss://relay.example", "wss://dup.example"],
        publicRelayUrls: ["wss://dup.example", "wss://public.example"],
        nowSeconds: 123,
      },
      {
        fetchLnurlInvoice: fetchLnurl as never,
        fetchZapInvoice: fetchZap as never,
        signZapRequest: signZapRequest as never,
      }
    )

    expect(result).toEqual({
      invoice: "lnbc1public",
      zapRelayUrls: [
        "wss://relay.example",
        "wss://dup.example",
        "wss://public.example",
      ],
      zapRequestId: "zap-request-id",
      shouldWaitForZapReceipt: true,
    })
    expect(signZapRequest).toHaveBeenCalledTimes(1)
    expect(signZapRequest.mock.calls[0]?.[0]).toMatchObject({
      kind: 9734,
      createdAt: 123,
      content: "hello public",
      tags: [
        ["p", FAKE_PUBKEY],
        ["amount", "50000"],
        ["lnurl", "lnurl1test"],
        [
          "relays",
          "wss://relay.example",
          "wss://dup.example",
          "wss://public.example",
        ],
      ],
    })
    expect(fetchZap).toHaveBeenCalledWith(
      "https://wallet.example/cb",
      50_000,
      expect.stringContaining('"kind":9734'),
      "lnurl1test"
    )
    expect(fetchLnurl).toHaveBeenCalledTimes(0)
  })

  it("preserves invoice, amount, and recovery state for manual invoice fallback", () => {
    expect(
      buildPendingCheckoutManualInvoice({
        orderId: "order-1",
        merchantPubkey: FAKE_PUBKEY,
        amountMsats: 50_000,
        amountSats: 50,
        invoice: "lnbc1manual",
        reason: "No automatic Lightning payment rail is currently available.",
        deliveryNotice: "Order delivered to merchant relay only.",
      })
    ).toEqual({
      orderId: "order-1",
      merchantPubkey: FAKE_PUBKEY,
      amountMsats: 50_000,
      amountSats: 50,
      invoice: "lnbc1manual",
      reason: "No automatic Lightning payment rail is currently available.",
      deliveryNotice: "Order delivered to merchant relay only.",
    })
  })
})

// ─── payment proof payload ──────────────────────────────────────────────────

describe("payment proof payload", () => {
  it("accepts private checkout proof without a zap request id", () => {
    expect(
      paymentProofMessageSchema.parse({
        action: "private_checkout",
        invoice: "lnbc1private",
        preimage: "preimage",
      })
    ).toMatchObject({
      action: "private_checkout",
      invoice: "lnbc1private",
      preimage: "preimage",
    })
  })
})

// ─── payment rail routing ────────────────────────────────────────────────────

describe("payCheckoutInvoice", () => {
  const connection = parseNwcUri(VALID_NWC_URI)

  it("uses NWC first when the saved wallet is live", async () => {
    const nwcPay = mock(async () => ({
      status: "paid" as const,
      preimage: "preimage",
      paymentHash: "hash",
      feeMsats: 10,
    }))
    const weblnPay = mock(async () => {
      throw new Error("should not use WebLN")
    })

    const result = await payCheckoutInvoice(
      {
        invoice: "lnbc1test",
        amountMsats: 1000,
        walletConnection: connection,
        tryNwc: true,
        timeoutMs: 60_000,
        appId: "market",
      },
      {
        nwcSessionPayInvoice: nwcPay as never,
        hasWebLN: () => true,
        weblnSendPayment: weblnPay as never,
      }
    )

    expect(result).toEqual({
      status: "paid",
      rail: "nwc",
      preimage: "preimage",
      paymentHash: "hash",
      feeMsats: 10,
    })
    expect(nwcPay).toHaveBeenCalledTimes(1)
    expect(weblnPay).toHaveBeenCalledTimes(0)
  })

  it("falls back to WebLN when NWC fails before payment moves", async () => {
    const nwcPay = mock(async () => ({
      status: "pre_publish_failed" as const,
      phase: "before_publish" as const,
      reason: "Failed to connect to NWC relay(s).",
    }))
    const weblnPay = mock(async () => ({
      preimage: "webln-preimage",
      paymentHash: "webln-hash",
    }))

    const result = await payCheckoutInvoice(
      {
        invoice: "lnbc1test",
        amountMsats: 1000,
        walletConnection: connection,
        tryNwc: true,
        timeoutMs: 60_000,
        appId: "market",
      },
      {
        nwcSessionPayInvoice: nwcPay as never,
        hasWebLN: () => true,
        weblnSendPayment: weblnPay as never,
      }
    )

    expect(result).toEqual({
      status: "paid",
      rail: "webln",
      preimage: "webln-preimage",
      paymentHash: "webln-hash",
    })
    expect(nwcPay).toHaveBeenCalledTimes(1)
    expect(weblnPay).toHaveBeenCalledTimes(1)
  })

  it("returns manual fallback when automatic rails are unavailable", async () => {
    const result = await payCheckoutInvoice(
      {
        invoice: "lnbc1test",
        amountMsats: 1000,
        walletConnection: connection,
        tryNwc: false,
        timeoutMs: 60_000,
        appId: "market",
      },
      {
        nwcSessionPayInvoice: mock(async () => {
          throw new Error("should not use NWC")
        }) as never,
        hasWebLN: () => false,
        weblnSendPayment: mock(async () => {
          throw new Error("should not use WebLN")
        }) as never,
      }
    )

    expect(result).toEqual({
      status: "manual_required",
      reason: "No automatic Lightning payment rail is currently available.",
    })
  })

  it("returns sanitized NWC diagnostics when relay failure falls back to manual invoice", async () => {
    const result = await payCheckoutInvoice(
      {
        invoice: "lnbc1test",
        amountMsats: 1000,
        walletConnection: connection,
        tryNwc: true,
        timeoutMs: 60_000,
        appId: "market",
      },
      {
        nwcSessionPayInvoice: mock(async () => ({
          status: "pre_publish_failed" as const,
          phase: "before_publish" as const,
          reason: "Failed to connect to NWC relay(s).",
        })) as never,
        hasWebLN: () => false,
        weblnSendPayment: mock(async () => {
          throw new Error("should not use WebLN")
        }) as never,
      }
    )

    expect(result).toMatchObject({
      status: "manual_required",
      diagnostics: [
        {
          code: "relay_unreachable",
          relayHosts: ["relay.example.com"],
          safeManualFallback: true,
        },
      ],
    })
    expect(result.reason).toContain("NWC relay unreachable")
    expect(result.reason).not.toContain(connection.secret)
  })

  it("does not fall back after an ambiguous NWC request failure", async () => {
    const weblnPay = mock(async () => ({
      preimage: "should-not-pay",
    }))

    await expect(
      payCheckoutInvoice(
        {
          invoice: "lnbc1test",
          amountMsats: 1000,
          walletConnection: connection,
          tryNwc: true,
          timeoutMs: 60_000,
          appId: "market",
        },
        {
          nwcSessionPayInvoice: mock(async () => {
            return {
              status: "published_timeout" as const,
              phase: "after_publish" as const,
              reason: "NWC pay_invoice response timed out",
            }
          }) as never,
          hasWebLN: () => true,
          weblnSendPayment: weblnPay as never,
        }
      )
    ).rejects.toThrow(/Check your wallet/)
    expect(weblnPay).toHaveBeenCalledTimes(0)
  })

  it("does not offer manual fallback when WebLN may have paid without proof", async () => {
    await expect(
      payCheckoutInvoice(
        {
          invoice: "lnbc1test",
          amountMsats: 1000,
          walletConnection: null,
          tryNwc: false,
          timeoutMs: 60_000,
          appId: "market",
        },
        {
          nwcSessionPayInvoice: mock(async () => {
            throw new Error("should not use NWC")
          }) as never,
          hasWebLN: () => true,
          weblnSendPayment: mock(async () => {
            throw new Error("WebLN payment did not return a payment proof")
          }) as never,
        }
      )
    ).rejects.toThrow(/Check your wallet/)
  })
})

// ─── shipping eligibility ───────────────────────────────────────────────────

describe("shipping destination eligibility", () => {
  it("parses product-level shipping option references and snapshots", () => {
    const product = parseProductEvent({
      id: "product-event",
      pubkey: FAKE_PUBKEY,
      created_at: 1,
      content: "",
      tags: [
        ["d", "notebook"],
        ["title", "Notebook"],
        ["price", "1000", "SATS"],
        ["type", "simple", "physical"],
        ["shipping_cost", "500"],
        ["shipping_option", `30406:${FAKE_PUBKEY}:conduit-default`],
        ["shipping_country", "US", "CA"],
        ["shipping_restrict", "US", "787**"],
        ["shipping_exclude", "US", "78799"],
      ],
    })

    expect(product.shippingOptionId).toBe(
      `30406:${FAKE_PUBKEY}:conduit-default`
    )
    expect(product.shippingCountries).toEqual(["US", "CA"])
    expect(product.shippingCountryRules?.[0]).toMatchObject({
      code: "US",
      restrictTo: ["787**"],
      exclude: ["78799"],
    })
  })

  it("parses postal include and exclude rules", () => {
    const parsed = parseShippingOptionEvent({
      id: "shipping-event",
      pubkey: FAKE_PUBKEY,
      created_at: 1,
      tags: [
        ["d", "conduit-default"],
        ["price", "0", "SATS"],
        ["country", "US", "CA"],
        ["restrict", "US", "787**", "94105"],
        ["exclude", "US", "78799"],
      ],
    })

    expect(parsed?.countries).toEqual(["US", "CA"])
    expect(parsed?.countryRules.find((rule) => rule.code === "US")).toEqual({
      code: "US",
      name: "US",
      restrictTo: ["787**", "94105"],
      exclude: ["78799"],
    })
  })

  it("rejects non-finite shipping prices", () => {
    expect(
      parseShippingOptionEvent({
        id: "shipping-event",
        pubkey: FAKE_PUBKEY,
        created_at: 1,
        tags: [
          ["d", "conduit-default"],
          ["price", "Infinity", "SATS"],
          ["country", "US"],
        ],
      })
    ).toBeNull()
  })

  it("parses empty replacement shipping options as no destinations", () => {
    const parsed = parseShippingOptionEvent({
      id: "shipping-event",
      pubkey: FAKE_PUBKEY,
      created_at: 2,
      tags: [["d", "conduit-default"], ["price", "0", "SATS"], ["country"]],
    })

    expect(parsed).toMatchObject({
      countries: [],
      countryRules: [],
      dTag: "conduit-default",
    })
  })

  it("ignores empty non-default shipping options", () => {
    expect(
      parseShippingOptionEvent({
        id: "shipping-event",
        pubkey: FAKE_PUBKEY,
        created_at: 2,
        tags: [
          ["d", "custom-option"],
          ["price", "0", "SATS"],
        ],
      })
    ).toBeNull()
  })

  it("matches country include, postal include, postal exclude, and unknown readiness", () => {
    const parsed = parseShippingOptionEvent({
      id: "shipping-event",
      pubkey: FAKE_PUBKEY,
      created_at: 1,
      tags: [
        ["d", "conduit-default"],
        ["price", "0", "SATS"],
        ["country", "US"],
        ["restrict", "US", "787**"],
        ["exclude", "US", "78799"],
      ],
    })
    expect(parsed).not.toBeNull()
    const options = parsed ? [parsed] : []

    expect(
      getShippingDestinationEligibility(
        { country: "US", postalCode: "78701" },
        options
      )
    ).toEqual({ eligible: true })
    expect(
      getShippingDestinationEligibility(
        { country: "US", postalCode: "78799" },
        options
      )
    ).toEqual({ eligible: false, reason: "postal_restricted" })
    expect(
      getShippingDestinationEligibility(
        { country: "CA", postalCode: "M5V" },
        options
      )
    ).toEqual({ eligible: false, reason: "country_unsupported" })
    expect(
      getShippingDestinationEligibility(
        { country: "US", postalCode: "78701" },
        []
      )
    ).toEqual({ eligible: null, reason: "unknown" })
  })
})

// ─── parseNwcUri ──────────────────────────────────────────────────────────────

describe("parseNwcUri", () => {
  it("parses a valid NWC URI", () => {
    const conn = parseNwcUri(VALID_NWC_URI)
    expect(conn.walletPubkey).toBe(FAKE_PUBKEY)
    expect(conn.secret).toBe(FAKE_SECRET)
    expect(conn.relays).toEqual(["wss://relay.example.com"])
  })

  it("parses multiple relays", () => {
    const uri = `${VALID_NWC_URI}&relay=wss%3A%2F%2Frelay2.example.com`
    const conn = parseNwcUri(uri)
    expect(conn.relays.length).toBe(2)
  })

  it("parses optional lud16", () => {
    const uri = `${VALID_NWC_URI}&lud16=user%40wallet.example`
    const conn = parseNwcUri(uri)
    expect(conn.lud16).toBe("user@wallet.example")
  })

  it("throws on wrong scheme", () => {
    expect(() => parseNwcUri("https://example.com")).toThrow()
  })

  it("throws on missing secret", () => {
    const uri = `nostr+walletconnect://${FAKE_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com`
    expect(() => parseNwcUri(uri)).toThrow(/secret/)
  })

  it("throws on missing relay", () => {
    const uri = `nostr+walletconnect://${FAKE_PUBKEY}?secret=${FAKE_SECRET}`
    expect(() => parseNwcUri(uri)).toThrow(/relay/)
  })

  it("throws on short pubkey", () => {
    const uri = `nostr+walletconnect://tooshort?relay=wss%3A%2F%2Fr.example.com&secret=${FAKE_SECRET}`
    expect(() => parseNwcUri(uri)).toThrow(/pubkey/)
  })
})

// ─── fetchLnurlPayMetadata ────────────────────────────────────────────────────

describe("fetchLnurlPayMetadata", () => {
  afterEach(() => {
    // restore global fetch after each test
    globalThis.fetch = originalFetch
  })

  const originalFetch = globalThis.fetch

  function mockFetch(response: unknown, ok = true) {
    globalThis.fetch = mock(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
    })) as unknown as typeof fetch
  }

  it("resolves a valid payRequest response", async () => {
    mockFetch({
      tag: "payRequest",
      callback: "https://wallet.example/lnurlp/callback",
      minSendable: 1000,
      maxSendable: 100_000_000,
      metadata: "[]",
      allowsNostr: true,
      nostrPubkey: FAKE_PUBKEY,
    })

    const result = await fetchLnurlPayMetadata("user@wallet.example")
    expect(result.callback).toBe("https://wallet.example/lnurlp/callback")
    expect(result.allowsNostr).toBe(true)
    expect(result.nostrPubkey).toBe(FAKE_PUBKEY)
    expect(result.minSendable).toBe(1000)
  })

  it("throws when tag is not payRequest", async () => {
    mockFetch({ tag: "withdrawRequest" })
    await expect(fetchLnurlPayMetadata("user@wallet.example")).rejects.toThrow(
      /LNURL-pay endpoint/
    )
  })

  it("throws on HTTP error", async () => {
    mockFetch({}, false)
    await expect(fetchLnurlPayMetadata("user@wallet.example")).rejects.toThrow()
  })

  it("throws on malformed lud16 (no @)", async () => {
    await expect(fetchLnurlPayMetadata("invalidemail")).rejects.toThrow(
      /Invalid lud16/
    )
  })

  it("sets allowsNostr false when not declared", async () => {
    mockFetch({
      tag: "payRequest",
      callback: "https://wallet.example/cb",
      minSendable: 1000,
      maxSendable: 1_000_000,
      metadata: "[]",
    })
    const result = await fetchLnurlPayMetadata("user@wallet.example")
    expect(result.allowsNostr).toBe(false)
  })
})

// ─── fetchZapInvoice ──────────────────────────────────────────────────────────

describe("fetchZapInvoice", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: unknown, ok = true) {
    globalThis.fetch = mock(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
    })) as unknown as typeof fetch
  }

  const FAKE_INVOICE = "lnbc100n1pjtest..."
  const FAKE_ZAP_REQUEST = JSON.stringify({ kind: 9734, content: "" })

  it("returns invoice on success", async () => {
    mockFetch({ pr: FAKE_INVOICE })
    const result = await fetchZapInvoice(
      "https://wallet.example/lnurlp/callback",
      100_000,
      FAKE_ZAP_REQUEST
    )
    expect(result.invoice).toBe(FAKE_INVOICE)
  })

  it("throws on LNURL ERROR status", async () => {
    mockFetch({ status: "ERROR", reason: "Amount too low" })
    await expect(
      fetchZapInvoice(
        "https://wallet.example/lnurlp/callback",
        1,
        FAKE_ZAP_REQUEST
      )
    ).rejects.toThrow(/Amount too low/)
  })

  it("preserves zap context on invoice request failures", async () => {
    mockFetch({}, false)
    await expect(
      fetchZapInvoice(
        "https://wallet.example/lnurlp/callback",
        100_000,
        FAKE_ZAP_REQUEST
      )
    ).rejects.toThrow(
      /Failed to fetch zap invoice: Failed to fetch LNURL invoice/
    )
  })

  it("throws when pr field is missing", async () => {
    mockFetch({ status: "OK" })
    await expect(
      fetchZapInvoice(
        "https://wallet.example/lnurlp/callback",
        100_000,
        FAKE_ZAP_REQUEST
      )
    ).rejects.toThrow(/BOLT11/)
  })

  it("appends amount, nostr, and lnurl params to callback URL", async () => {
    let capturedUrl = ""
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return { ok: true, status: 200, json: async () => ({ pr: FAKE_INVOICE }) }
    }) as unknown as typeof fetch

    await fetchZapInvoice(
      "https://wallet.example/cb",
      50_000,
      FAKE_ZAP_REQUEST,
      "lnurl1test"
    )

    expect(capturedUrl).toContain("amount=50000")
    expect(capturedUrl).toContain("nostr=")
    expect(capturedUrl).toContain("lnurl=lnurl1test")
  })

  it("replaces pre-existing NIP-57 params for public zap callbacks", async () => {
    let capturedUrl = ""
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return { ok: true, status: 200, json: async () => ({ pr: FAKE_INVOICE }) }
    }) as unknown as typeof fetch

    await fetchZapInvoice(
      "https://wallet.example/cb?tag=payRequest&nostr=leak&lnurl=leak",
      50_000,
      FAKE_ZAP_REQUEST,
      "lnurl1test"
    )

    const callback = new URL(capturedUrl)
    expect(callback.searchParams.get("amount")).toBe("50000")
    expect(callback.searchParams.get("tag")).toBe("payRequest")
    expect(callback.searchParams.get("nostr")).toBe(FAKE_ZAP_REQUEST)
    expect(callback.searchParams.get("lnurl")).toBe("lnurl1test")
  })

  it("requests a plain LNURL invoice without public zap metadata", async () => {
    let capturedUrl = ""
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return { ok: true, status: 200, json: async () => ({ pr: FAKE_INVOICE }) }
    }) as unknown as typeof fetch

    await fetchLnurlInvoice("https://wallet.example/cb", 50_000)

    expect(capturedUrl).toContain("amount=50000")
    expect(capturedUrl).not.toContain("nostr=")
    expect(capturedUrl).not.toContain("lnurl=")
  })

  it("strips pre-existing NIP-57 params from plain LNURL invoice callbacks", async () => {
    let capturedUrl = ""
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return { ok: true, status: 200, json: async () => ({ pr: FAKE_INVOICE }) }
    }) as unknown as typeof fetch

    await fetchLnurlInvoice(
      "https://wallet.example/cb?tag=payRequest&nostr=leak&lnurl=leak",
      50_000
    )

    const callback = new URL(capturedUrl)
    expect(callback.searchParams.get("amount")).toBe("50000")
    expect(callback.searchParams.get("tag")).toBe("payRequest")
    expect(callback.searchParams.has("nostr")).toBe(false)
    expect(callback.searchParams.has("lnurl")).toBe(false)
  })
})
