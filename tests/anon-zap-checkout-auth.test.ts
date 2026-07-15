import { describe, expect, it } from "bun:test"
import {
  authorizeAnonZapCheckout,
  parseAnonZapCheckoutIntent,
  type BtcUsdRateQuote,
  type LnurlPayMetadata,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 2])
const RECEIPT_SECRET = Uint8Array.from([...new Uint8Array(31), 3])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const RECEIPT_PUBKEY = getPublicKey(RECEIPT_SECRET)
const NOW_SECONDS = 1_800_000_000
const PRODUCT_D_TAG = "cnd-150-test-product"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`

function signMerchantEvent(input: {
  kind: number
  createdAt?: number
  tags?: string[][]
  content?: string
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt ?? NOW_SECONDS - 60,
      tags: input.tags ?? [],
      content: input.content ?? "",
    },
    MERCHANT_SECRET
  )
}

function productEvent(
  overrides: {
    createdAt?: number
    price?: number
    currency?: string
    publicZapPolicy?: "true" | "false" | "unknown"
    shippingCost?: number | null
    shippingCurrency?: string
    shippingCountries?: string[]
    dTag?: string
  } = {}
): SignedPublicNostrEvent {
  const publicZapPolicy = overrides.publicZapPolicy ?? "true"
  const shippingCost = overrides.shippingCost
  const currency = overrides.currency ?? "SATS"
  const tags: string[][] = [
    ["d", overrides.dTag ?? PRODUCT_D_TAG],
    ["title", "CND-150 test product"],
    ["price", String(overrides.price ?? 10), currency],
    ["type", "simple", shippingCost === undefined ? "digital" : "physical"],
    ["image", "https://cdn.example/cnd-150.png"],
    ["checkout_zap_message_policy", "generic_only"],
  ]
  if (publicZapPolicy !== "unknown") {
    tags.push(["checkout_public_zaps", publicZapPolicy])
  }
  if (shippingCost !== undefined && shippingCost !== null) {
    tags.push([
      "shipping_cost",
      String(shippingCost),
      overrides.shippingCurrency ?? currency,
    ])
  }
  for (const country of overrides.shippingCountries ??
    (shippingCost !== undefined ? ["US"] : [])) {
    tags.push(["shipping_country", country])
  }
  return signMerchantEvent({
    kind: 30402,
    createdAt: overrides.createdAt,
    tags,
    content: "A signed public checkout fixture.",
  })
}

function profileEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 0,
    content: JSON.stringify({ lud16: "merchant@wallet.example" }),
  })
}

function lnurlMetadata(
  overrides: Partial<LnurlPayMetadata> = {}
): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
    lnurl: "lnurl1cnd150test",
    callback: "https://wallet.example/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 100_000_000,
    tag: "payRequest",
    allowsNostr: true,
    nostrPubkey: RECEIPT_PUBKEY,
    metadata: "[]",
    ...overrides,
  }
}

function authorize(
  overrides: Partial<Parameters<typeof authorizeAnonZapCheckout>[0]> = {}
) {
  return authorizeAnonZapCheckout({
    intent: {
      merchantPubkey: MERCHANT_PUBKEY,
      items: [{ productAddress: PRODUCT_ADDRESS, quantity: 1 }],
    },
    productEvents: [productEvent()],
    profileEvents: [profileEvent()],
    deletionEvents: [],
    lnurlMetadata: lnurlMetadata(),
    receiptRelayUrls: ["wss://relay.example"],
    nowSeconds: NOW_SECONDS,
    ...overrides,
  })
}

describe("anonymous public zap checkout authorization", () => {
  it("parses only bounded public product coordinates", () => {
    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY.toUpperCase(),
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
      })
    ).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
    })

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        amountMsats: 20_000,
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
      })
    ).toBeNull()

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        items: [
          {
            productAddress: PRODUCT_ADDRESS,
            quantity: 2,
            note: "private item note",
          },
        ],
      })
    ).toBeNull()

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        items: [
          {
            productAddress: `30402:${RECEIPT_PUBKEY}:${PRODUCT_D_TAG}`,
            quantity: 1,
          },
        ],
      })
    ).toBeNull()

    for (const dTag of ["bad\nvalue", "x".repeat(129)]) {
      expect(
        parseAnonZapCheckoutIntent({
          merchantPubkey: MERCHANT_PUBKEY,
          items: [
            {
              productAddress: `30402:${MERCHANT_PUBKEY}:${dTag}`,
              quantity: 1,
            },
          ],
        })
      ).toBeNull()
    }
  })

  it("builds a server-owned generic request from signed public state", () => {
    const result = authorize({
      intent: {
        merchantPubkey: MERCHANT_PUBKEY,
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
      },
      productEvents: [productEvent({ shippingCost: 5 })],
    })

    expect(result.draft).toEqual({
      kind: 9734,
      createdAt: NOW_SECONDS,
      content: "Zapped out 2 items at https://shop.conduit.market/",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["amount", "30000"],
        ["lnurl", "lnurl1cnd150test"],
        ["relays", "wss://relay.example"],
        ["omf", "zapout"],
        ["omf_provider", RECEIPT_PUBKEY],
        ["client", "conduit-market"],
      ],
    })
    expect(result.authorization).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      amountMsats: 30_000,
      lnurl: "lnurl1cnd150test",
      publicZapPolicy: "anonymous_public_zap_allowed",
    })
    expect(result.lnurlNostrPubkey).toBe(RECEIPT_PUBKEY)
    expect(result.pricing).toEqual({
      itemSubtotalSats: 20,
      shippingCostSats: 10,
      totalSats: 30,
      totalMsats: 30_000,
      items: [
        {
          productAddress: PRODUCT_ADDRESS,
          productEventId: result.pricing.items[0]!.productEventId,
          format: "physical",
          quantity: 2,
          unitPriceSats: 10,
          unitShippingSats: 5,
          lineTotalSats: 30,
          shippingCountryRules: [{ code: "US", restrictTo: [], exclude: [] }],
        },
      ],
    })
  })

  it("derives USD price and shipping from a fresh server rate", () => {
    const pricingRate: BtcUsdRateQuote = {
      rate: 100_000,
      fetchedAt: NOW_SECONDS * 1000,
      source: "mempool",
    }
    const result = authorize({
      productEvents: [
        productEvent({
          price: 10,
          currency: "USD",
          shippingCost: 5,
          shippingCurrency: "USD",
        }),
      ],
      pricingRate,
    })

    expect(result.draft.content).toBe(
      "Zapped out 1 item at https://shop.conduit.market/"
    )
    expect(result.draft.tags).toContainEqual(["amount", "15000000"])
    expect(result.authorization.amountMsats).toBe(15_000_000)
    expect(result.pricing).toEqual({
      itemSubtotalSats: 10_000,
      shippingCostSats: 5_000,
      totalSats: 15_000,
      totalMsats: 15_000_000,
      items: [
        {
          productAddress: PRODUCT_ADDRESS,
          productEventId: result.pricing.items[0]!.productEventId,
          format: "physical",
          quantity: 1,
          unitPriceSats: 10_000,
          unitShippingSats: 5_000,
          lineTotalSats: 15_000,
          shippingCountryRules: [{ code: "US", restrictTo: [], exclude: [] }],
        },
      ],
      quote: {
        rate: 100_000,
        fetchedAt: NOW_SECONDS * 1000,
        source: "mempool",
      },
    })
  })

  it("uses the server cross-rate for non-USD fiat", () => {
    const result = authorize({
      productEvents: [
        productEvent({
          price: 10,
          currency: "EUR",
          shippingCost: 2,
          shippingCurrency: "EUR",
        }),
      ],
      pricingRate: {
        rate: 100_000,
        fetchedAt: NOW_SECONDS * 1000,
        source: "coinbase",
        fiatUsdRates: { EUR: 1.25 },
        fiatSource: "frankfurter",
      },
    })

    expect(result.pricing.totalSats).toBe(15_000)
    expect(result.pricing.items[0]).toMatchObject({
      unitPriceSats: 12_500,
      unitShippingSats: 2_500,
    })
    expect(result.pricing.quote).toMatchObject({
      source: "coinbase",
      fiatSource: "frankfurter",
    })
  })

  it("fails closed when fiat cannot be priced by a fresh server quote", () => {
    const usdProduct = productEvent({ price: 10, currency: "USD" })
    expect(() => authorize({ productEvents: [usdProduct] })).toThrow(
      "Checkout product price cannot be verified in sats."
    )
    expect(() =>
      authorize({
        productEvents: [usdProduct],
        pricingRate: {
          rate: 100_000,
          fetchedAt: (NOW_SECONDS - 301) * 1000,
          source: "mempool",
        },
      })
    ).toThrow("Checkout pricing quote is stale.")
  })

  it("requires an explicit current public-zap opt-in", () => {
    for (const publicZapPolicy of ["false", "unknown"] as const) {
      expect(() =>
        authorize({ productEvents: [productEvent({ publicZapPolicy })] })
      ).toThrow("Checkout product does not explicitly allow public zaps.")
    }
  })

  it("rejects invalid signatures and conflicting latest listings", () => {
    const signed = productEvent()
    const tampered = { ...signed, content: "tampered after signing" }
    expect(() => authorize({ productEvents: [tampered] })).toThrow(
      "Checkout product is unavailable."
    )

    expect(() =>
      authorize({
        productEvents: [
          productEvent({ createdAt: NOW_SECONDS - 10, price: 10 }),
          productEvent({ createdAt: NOW_SECONDS - 10, price: 11 }),
        ],
      })
    ).toThrow("Checkout product has conflicting latest events.")
  })

  it("rejects products deleted by address or exact event id", () => {
    const product = productEvent()
    for (const target of [
      ["a", PRODUCT_ADDRESS],
      ["e", product.id],
    ]) {
      const deletion = signMerchantEvent({
        kind: 5,
        createdAt: NOW_SECONDS,
        tags: [target],
      })
      expect(() =>
        authorize({ productEvents: [product], deletionEvents: [deletion] })
      ).toThrow("Checkout product is no longer active.")
    }
  })

  it("rejects coordinated shipping", () => {
    expect(() =>
      authorize({ productEvents: [productEvent({ shippingCost: null })] })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
  })

  it("rejects fixed physical shipping without a country snapshot", () => {
    expect(() =>
      authorize({
        productEvents: [
          productEvent({ shippingCost: 5, shippingCountries: [] }),
        ],
      })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
  })

  it("binds authorization to the merchant profile LNURL endpoint", () => {
    expect(() =>
      authorize({
        lnurlMetadata: lnurlMetadata({
          payRequestUrl: "https://attacker.example/.well-known/lnurlp/merchant",
        }),
      })
    ).toThrow("Merchant Lightning Address metadata is invalid.")

    expect(() =>
      authorize({
        lnurlMetadata: lnurlMetadata({ allowsNostr: false }),
      })
    ).toThrow("Merchant Lightning Address does not support public zaps.")
  })
})
