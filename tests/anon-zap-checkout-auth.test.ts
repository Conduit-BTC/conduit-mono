import { verifySignedEvents } from "@conduit/core"
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
    title?: string
    createdAt?: number
    price?: number
    currency?: string
    publicZapPolicy?: "true" | "false" | "unknown"
    shippingCost?: number | null
    shippingCurrency?: string
    shippingCountries?: string[]
    canonicalShipping?: boolean
    dTag?: string
  } = {}
): SignedPublicNostrEvent {
  const publicZapPolicy = overrides.publicZapPolicy ?? "true"
  const shippingCost = overrides.shippingCost
  const currency = overrides.currency ?? "SATS"
  const tags: string[][] = [
    ["d", overrides.dTag ?? PRODUCT_D_TAG],
    ["title", overrides.title ?? "CND-150 test product"],
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
      tags.push([
        "shipping_option",
        `30406:${MERCHANT_PUBKEY}:${overrides.dTag ?? PRODUCT_D_TAG}-shipping-standard`,
      ])
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
    omitService?: boolean
  } = {}
): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 30406,
    createdAt: overrides.createdAt,
    tags: [
      ["d", `${overrides.dTag ?? PRODUCT_D_TAG}-shipping-standard`],
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

async function authorize(
  overrides: Partial<
    Omit<
      Parameters<typeof authorizeAnonZapCheckout>[0],
      "productEvents" | "shippingEvents" | "profileEvents" | "deletionEvents"
    > & {
      productEvents: SignedPublicNostrEvent[]
      shippingEvents: SignedPublicNostrEvent[]
      profileEvents: SignedPublicNostrEvent[]
      deletionEvents: SignedPublicNostrEvent[]
    }
  > = {}
) {
  const input = {
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
  }
  return authorizeAnonZapCheckout({
    ...input,
    productEvents: (await verifySignedEvents(input.productEvents)).events,
    shippingEvents: (await verifySignedEvents(input.shippingEvents)).events,
    profileEvents: (await verifySignedEvents(input.profileEvents)).events,
    deletionEvents: (await verifySignedEvents(input.deletionEvents)).events,
  })
}

describe("anonymous public zap checkout authorization", () => {
  it("does not apply client content keywords to valid signed purchase terms", async () => {
    const result = await authorize({
      productEvents: [
        productEvent({ title: "Counterfeit goods display fixture" }),
      ],
    })
    expect(result.pricing.itemSubtotalSats).toBe(10)
    expect(result.authorization.amountMsats).toBe(10_000)
    expect(result.pricing.items[0]?.productAddress).toBe(PRODUCT_ADDRESS)
  })

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

  it("builds a server-owned generic request from signed public state", async () => {
    const result = await authorize({
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

  it("prices canonical fixed shipping only from the exact signed option", async () => {
    const product = productEvent({
      shippingCost: 5,
      canonicalShipping: true,
    })
    const exactOption = shippingEvent({ price: 5 })
    const result = await authorize({
      productEvents: [product],
      shippingEvents: [exactOption],
    })

    expect(result.pricing.shippingCostSats).toBe(5)
    expect(result.pricing.items[0]).toMatchObject({
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}-shipping-standard`,
      unitShippingSats: 5,
    })

    await expect(
      (async () =>
        await authorize({ productEvents: [product], shippingEvents: [] }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
    await expect(
      (async () =>
        await authorize({
          productEvents: [product],
          shippingEvents: [shippingEvent({ omitService: true })],
        }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
    await expect(
      (async () =>
        await authorize({
          productEvents: [product],
          shippingEvents: [shippingEvent({ createdAt: NOW_SECONDS - 59 })],
        }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
  })

  it("rejects a canonical shipping option deleted by address or exact event id", async () => {
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
      await expect(
        (async () =>
          await authorize({
            productEvents: [product],
            shippingEvents: [shipping],
            deletionEvents: [deletion],
          }))()
      ).rejects.toThrow(
        "Checkout product requires merchant-coordinated shipping."
      )
    }
  })

  it("keeps legacy inline fixed shipping on the order-first path", async () => {
    await expect(
      (async () =>
        await authorize({
          productEvents: [productEvent({ shippingCost: 5 })],
          shippingEvents: [],
        }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
  })

  it("derives USD price and shipping from a fresh server rate", async () => {
    const pricingRate: BtcUsdRateQuote = {
      rate: 100_000,
      fetchedAt: NOW_SECONDS * 1000,
      source: "mempool",
    }
    const result = await authorize({
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

  it("uses the server cross-rate for non-USD fiat", async () => {
    const result = await authorize({
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

  it("fails closed when fiat cannot be priced by a fresh server quote", async () => {
    const usdProduct = productEvent({ price: 10, currency: "USD" })
    await expect(
      (async () => await authorize({ productEvents: [usdProduct] }))()
    ).rejects.toThrow("Checkout product price cannot be verified in sats.")
    await expect(
      (async () =>
        await authorize({
          productEvents: [usdProduct],
          pricingRate: {
            rate: 100_000,
            fetchedAt: (NOW_SECONDS - 301) * 1000,
            source: "mempool",
          },
        }))()
    ).rejects.toThrow("Checkout pricing quote is stale.")
  })

  it("requires an explicit current public-zap opt-in", async () => {
    for (const publicZapPolicy of ["false", "unknown"] as const) {
      await expect(
        (async () =>
          await authorize({
            productEvents: [productEvent({ publicZapPolicy })],
          }))()
      ).rejects.toThrow(
        "Checkout product does not explicitly allow public zaps."
      )
    }
  })

  it("rejects invalid signatures and conflicting latest listings", async () => {
    const signed = productEvent()
    const tampered = { ...signed, content: "tampered after signing" }
    await expect(
      (async () => await authorize({ productEvents: [tampered] }))()
    ).rejects.toThrow("Checkout product is unavailable.")

    await expect(
      (async () =>
        await authorize({
          productEvents: [
            productEvent({ createdAt: NOW_SECONDS - 10, price: 10 }),
            productEvent({ createdAt: NOW_SECONDS - 10, price: 11 }),
          ],
        }))()
    ).rejects.toThrow("Checkout product has conflicting latest events.")
  })

  it("rejects products deleted by address or exact event id", async () => {
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
      await expect(
        (async () =>
          await authorize({
            productEvents: [product],
            deletionEvents: [deletion],
          }))()
      ).rejects.toThrow("Checkout product is no longer active.")
    }
  })

  it("rejects coordinated shipping", async () => {
    await expect(
      (async () =>
        await authorize({
          productEvents: [productEvent({ shippingCost: null })],
        }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
  })

  it("rejects fixed physical shipping without a country snapshot", async () => {
    await expect(
      (async () =>
        await authorize({
          productEvents: [
            productEvent({ shippingCost: 5, canonicalShipping: true }),
          ],
          shippingEvents: [shippingEvent({ price: 5, countries: [] })],
        }))()
    ).rejects.toThrow(
      "Checkout product requires merchant-coordinated shipping."
    )
  })

  it("binds authorization to the signed merchant profile LNURL endpoint", async () => {
    const result = await authorize()
    expect(result.authorization.lnurl).toBe(LNURL)
    expect(result.draft.tags).toContainEqual(["lnurl", LNURL])

    await expect(
      (async () =>
        await authorize({
          profileEvents: [
            signMerchantEvent({
              kind: 0,
              content: JSON.stringify({ lud16: "not-an-address" }),
            }),
          ],
        }))()
    ).rejects.toThrow("Merchant Lightning Address is unavailable.")
  })
})
