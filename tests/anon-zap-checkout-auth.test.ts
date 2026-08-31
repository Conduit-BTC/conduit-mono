import { describe, expect, it } from "bun:test"
import {
  authorizeAnonZapCheckout,
  encodeLnurl,
  parseAnonZapCheckoutIntent,
  type BtcUsdRateQuote,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 2])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const NOW_SECONDS = 1_800_000_000
const PRODUCT_D_TAG = "cnd-150-test-product"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`
const LNURL_PAY_URL =
  "https://wallet.conduit.market/.well-known/lnurlp/merchant"
const LNURL = encodeLnurl(LNURL_PAY_URL)

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
    canonicalShipping?: boolean
    shippingDTags?: string[]
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
    ["image", "https://cdn.conduit.market/cnd-150.png"],
    ["checkout_zap_message_policy", "generic_only"],
  ]
  if (publicZapPolicy !== "unknown") {
    tags.push(["checkout_public_zaps", publicZapPolicy])
  }
  if (shippingCost !== undefined && shippingCost !== null) {
    if (overrides.canonicalShipping) {
      for (const dTag of overrides.shippingDTags ?? [
        `${overrides.dTag ?? PRODUCT_D_TAG}-shipping-standard`,
      ]) {
        tags.push(["shipping_option", `30406:${MERCHANT_PUBKEY}:${dTag}`])
      }
    } else {
      tags.push([
        "shipping_cost",
        String(shippingCost),
        overrides.shippingCurrency ?? currency,
      ])
    }
  }
  if (!overrides.canonicalShipping) {
    for (const country of overrides.shippingCountries ??
      (shippingCost !== undefined ? ["US"] : [])) {
      tags.push(["shipping_country", country])
    }
  }
  return signMerchantEvent({
    kind: 30402,
    createdAt: overrides.createdAt,
    tags,
    content: "A signed public checkout fixture.",
  })
}

function shippingEvent(
  overrides: {
    createdAt?: number
    price?: number
    currency?: string
    countries?: string[]
    dTag?: string
    exactDTag?: string
    omitService?: boolean
  } = {}
): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 30406,
    createdAt: overrides.createdAt,
    tags: [
      [
        "d",
        overrides.exactDTag ??
          `${overrides.dTag ?? PRODUCT_D_TAG}-shipping-standard`,
      ],
      ["title", "Standard Shipping"],
      ["price", String(overrides.price ?? 5), overrides.currency ?? "SATS"],
      ["country", ...(overrides.countries ?? ["US"])],
      ...(overrides.omitService ? [] : [["service", "standard"]]),
    ],
  })
}

function profileEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 0,
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  })
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
    shippingEvents: [],
    profileEvents: [profileEvent()],
    deletionEvents: [],
    receiptRelayUrls: ["wss://relay.conduit.market"],
    nowSeconds: NOW_SECONDS,
    ...overrides,
  })
}

describe("anonymous public zap checkout authorization", () => {
  it("parses only bounded public product coordinates", () => {
    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY.toUpperCase(),
        items: [
          {
            productAddress: PRODUCT_ADDRESS,
            quantity: 2,
            shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
          },
        ],
      })
    ).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      items: [
        {
          productAddress: PRODUCT_ADDRESS,
          quantity: 2,
          shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
        },
      ],
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
            quantity: 1,
            shippingOptionId: `30406:${"c".repeat(64)}:other-merchant`,
          },
        ],
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
            productAddress: `30402:${"c".repeat(64)}:${PRODUCT_D_TAG}`,
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
      productEvents: [
        productEvent({ shippingCost: 5, canonicalShipping: true }),
      ],
      shippingEvents: [shippingEvent({ price: 5 })],
    })

    expect(result.draft).toEqual({
      kind: 9734,
      createdAt: NOW_SECONDS,
      content: "Zapped out 2 items at https://shop.conduit.market/",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["amount", "30000"],
        ["lnurl", LNURL],
        ["relays", "wss://relay.conduit.market"],
        ["omf", "zapout"],
        ["client", "conduit-market"],
      ],
    })
    expect(result.authorization).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      amountMsats: 30_000,
      lnurl: LNURL,
      publicZapPolicy: "anonymous_public_zap_allowed",
    })
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
          shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
          shippingCountryRules: [{ code: "US", restrictTo: [], exclude: [] }],
        },
      ],
    })
  })

  it("prices canonical fixed shipping only from the exact signed option", () => {
    const product = productEvent({
      shippingCost: 5,
      canonicalShipping: true,
    })
    const exactOption = shippingEvent({ price: 5 })
    const result = authorize({
      productEvents: [product],
      shippingEvents: [exactOption],
    })

    expect(result.pricing.shippingCostSats).toBe(5)
    expect(result.pricing.items[0]).toMatchObject({
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
      unitShippingSats: 5,
    })

    expect(() =>
      authorize({ productEvents: [product], shippingEvents: [] })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
    expect(() =>
      authorize({
        productEvents: [product],
        shippingEvents: [shippingEvent({ omitService: true })],
      })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
    expect(() =>
      authorize({
        productEvents: [product],
        shippingEvents: [shippingEvent({ createdAt: NOW_SECONDS - 59 })],
      })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
  })

  it("prices a multi-rate listing from the exact selected public option", () => {
    const usDTag = `${PRODUCT_D_TAG}-shipping-us`
    const caDTag = `${PRODUCT_D_TAG}-shipping-ca`
    const caOptionId = `30406:${MERCHANT_PUBKEY}:${caDTag}`
    const result = authorize({
      intent: {
        merchantPubkey: MERCHANT_PUBKEY,
        items: [
          {
            productAddress: PRODUCT_ADDRESS,
            quantity: 1,
            shippingOptionId: caOptionId,
          },
        ],
      },
      productEvents: [
        productEvent({
          shippingCost: 5,
          canonicalShipping: true,
          shippingDTags: [usDTag, caDTag],
        }),
      ],
      shippingEvents: [
        shippingEvent({ exactDTag: usDTag, price: 5, countries: ["US"] }),
        shippingEvent({ exactDTag: caDTag, price: 9, countries: ["CA"] }),
      ],
    })

    expect(result.pricing).toMatchObject({
      shippingCostSats: 9,
      totalSats: 19,
      items: [
        {
          shippingOptionId: caOptionId,
          unitShippingSats: 9,
          shippingCountryRules: [{ code: "CA", restrictTo: [], exclude: [] }],
        },
      ],
    })
  })

  it("rejects a canonical shipping option deleted by address or exact event id", () => {
    const product = productEvent({
      shippingCost: 5,
      canonicalShipping: true,
    })
    const shipping = shippingEvent({ price: 5 })
    const shippingAddress = `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`

    for (const target of [
      ["a", shippingAddress],
      ["e", shipping.id],
    ]) {
      const deletion = signMerchantEvent({
        kind: 5,
        createdAt: NOW_SECONDS,
        tags: [target],
      })
      expect(() =>
        authorize({
          productEvents: [product],
          shippingEvents: [shipping],
          deletionEvents: [deletion],
        })
      ).toThrow("Checkout product requires merchant-coordinated shipping.")
    }
  })

  it("keeps legacy inline fixed shipping on the order-first path", () => {
    expect(() =>
      authorize({
        productEvents: [productEvent({ shippingCost: 5 })],
        shippingEvents: [],
      })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
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
          canonicalShipping: true,
        }),
      ],
      shippingEvents: [shippingEvent({ price: 5, currency: "USD" })],
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
          shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
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
          canonicalShipping: true,
        }),
      ],
      shippingEvents: [shippingEvent({ price: 2, currency: "EUR" })],
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
          productEvent({ shippingCost: 5, canonicalShipping: true }),
        ],
        shippingEvents: [shippingEvent({ price: 5, countries: [] })],
      })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
  })

  it("binds authorization to the signed merchant profile LNURL endpoint", () => {
    const result = authorize()
    expect(result.authorization.lnurl).toBe(LNURL)
    expect(result.draft.tags).toContainEqual(["lnurl", LNURL])

    expect(() =>
      authorize({
        profileEvents: [
          signMerchantEvent({
            kind: 0,
            content: JSON.stringify({ lud16: "not-an-address" }),
          }),
        ],
      })
    ).toThrow("Merchant Lightning Address is unavailable.")
  })
})
