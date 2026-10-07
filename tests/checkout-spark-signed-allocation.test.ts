import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  assertCheckoutSparkSignedCommerceAllocations,
  deriveCheckoutSparkSignedCommerceObligations,
  parseProductEvent,
  type CheckoutSparkCommerceObligationInput,
  type CheckoutSparkCommerceQuote,
  type CheckoutSparkOrganizerObligationInput,
  type Product,
} from "@conduit/core"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const SUPPLIER = getPublicKey(generateSecretKey())
const OTHER_SUPPLIER = getPublicKey(generateSecretKey())
const RELAY = "wss://relay.conduit.market"
const CREATED_AT = 1_800_000_000

function signedProduct(
  dTag: string,
  unitSats: number,
  allocationTags: string[][] = [],
  shipping?: { coordinate: string }
): Product {
  const event = finalizeEvent(
    {
      kind: 30_402,
      created_at: CREATED_AT,
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["price", String(unitSats), "SAT"],
        ["type", "simple", shipping ? "physical" : "digital"],
        ...(shipping ? [["shipping_option", shipping.coordinate]] : []),
        ...allocationTags,
      ],
      content: "Signed test listing",
    },
    MERCHANT_SECRET
  )
  return { ...parseProductEvent(event), sourceEventId: event.id }
}

function terms(
  merchantWeight: string,
  supplierWeight: string,
  supplier = SUPPLIER
): string[][] {
  return [
    ["conduit_supplier_allocation", "1"],
    ["zap", MERCHANT, RELAY, merchantWeight],
    ["zap", supplier, RELAY, supplierWeight],
  ]
}

function quoteFor(
  lines: readonly { product: Product; quantity: number; unitSats: number }[]
): CheckoutSparkCommerceQuote {
  return {
    commerceTotalSats: lines.reduce(
      (sum, line) => sum + line.quantity * line.unitSats,
      0
    ),
    lines: lines.map(({ product, quantity, unitSats }) => ({
      productCoordinate: product.id,
      productEventId: product.sourceEventId!,
      merchantPubkey: MERCHANT,
      quantity,
      unitMerchandiseSats: unitSats,
      unitShippingSats: 0,
    })),
  }
}

function obligation(
  kind: "merchant" | "supplier",
  recipientId: string,
  amountSats: number
): CheckoutSparkCommerceObligationInput {
  return {
    kind,
    recipientId,
    amountSats,
    paymentRequest: "not-used-by-signed-gate",
    maxFeeSats: 0,
  }
}

function admit(
  products: Product[],
  quote: CheckoutSparkCommerceQuote,
  commerce: CheckoutSparkCommerceObligationInput[],
  organizer?: CheckoutSparkOrganizerObligationInput | null
): void {
  assertCheckoutSparkSignedCommerceAllocations({
    products,
    quote,
    commerce,
    merchantPubkey: MERCHANT,
    organizer,
  })
}

describe("signed checkout Spark supplier allocation", () => {
  it("rejects irrelevant digital shipping evidence and fabricated selection facts", () => {
    const product = signedProduct("irrelevant", 1_000)
    const quote = quoteFor([{ product, quantity: 1, unitSats: 1_000 }])
    for (const extra of [
      {
        sourceShippingCost: {
          amount: 0,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
      { variation: { specifications: [{ key: "Size", value: "Large" }] } },
    ]) {
      const altered = structuredClone(quote)
      Object.assign(altered.lines[0]!, extra)
      expect(() =>
        deriveCheckoutSparkSignedCommerceObligations({
          quote: altered,
          products: [product],
          merchantPubkey: MERCHANT,
        })
      ).toThrow()
    }
  })
  it.each([0, 0.5])(
    "recomputes signed fiat fixed shipping with the same frozen conversion as merchandise (%s)",
    (shippingUsd) => {
      const coordinate = `30406:${MERCHANT}:fiat-shipping`
      const shipping = finalizeEvent(
        {
          kind: 30_406,
          created_at: CREATED_AT - 1,
          tags: [
            ["d", "fiat-shipping"],
            ["price", String(shippingUsd), "USD"],
            ["title", "Shipping"],
            ["country", "US"],
            ["service", "standard"],
          ],
          content: "",
        },
        MERCHANT_SECRET
      )
      const event = finalizeEvent(
        {
          kind: 30_402,
          created_at: CREATED_AT,
          tags: [
            ["d", "fiat-physical"],
            ["title", "Physical"],
            ["price", "1", "USD"],
            ["type", "simple", "physical"],
            ["shipping_option", coordinate],
          ],
          content: "",
        },
        MERCHANT_SECRET
      )
      const product = { ...parseProductEvent(event), sourceEventId: event.id }
      const shippingSats = shippingUsd * 1_000
      const total = 3 * (1_000 + shippingSats)
      const quote: CheckoutSparkCommerceQuote = {
        commerceTotalSats: total,
        pricing: {
          version: 1,
          rate: {
            rate: 100_000,
            fetchedAt: CREATED_AT * 1_000,
            source: "mempool",
          },
        },
        lines: [
          {
            productCoordinate: product.id,
            productEventId: event.id,
            merchantPubkey: MERCHANT,
            quantity: 3,
            unitMerchandiseSats: 1_000,
            unitShippingSats: shippingSats,
            sourcePrice: product.sourcePrice,
            shippingOption: { coordinate, eventId: shipping.id },
          },
        ],
      }
      Object.assign(quote.lines[0]!, {
        sourceShippingCost: {
          amount: shippingUsd,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      })
      expect(
        deriveCheckoutSparkSignedCommerceObligations({
          quote,
          products: [product],
          shippingEvents: [shipping],
          merchantPubkey: MERCHANT,
          acceptedAtMs: CREATED_AT * 1_000,
        })
      ).toEqual([
        { kind: "merchant", recipientId: MERCHANT, amountSats: total },
      ])
    }
  )

  it("binds a selected variation to the exact signed child parent and specifications", () => {
    const event = finalizeEvent(
      {
        kind: 30_402,
        created_at: CREATED_AT,
        tags: [
          ["d", "variation"],
          ["title", "Variation"],
          ["price", "1000", "SAT"],
          ["type", "variation", "digital"],
          ["a", `30402:${MERCHANT}:family`],
          ["spec", "Size", "Large"],
        ],
        content: "",
      },
      MERCHANT_SECRET
    )
    const product = { ...parseProductEvent(event), sourceEventId: event.id }
    const quote = quoteFor([{ product, quantity: 1, unitSats: 1_000 }])
    Object.assign(quote.lines[0]!, {
      variation: {
        familyCoordinate: product.parentProductId,
        specifications: product.specifications,
      },
    })
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: [product],
        merchantPubkey: MERCHANT,
      })
    ).toEqual([{ kind: "merchant", recipientId: MERCHANT, amountSats: 1_000 }])
    const wrong = structuredClone(quote)
    Object.assign(wrong.lines[0]!, {
      variation: {
        familyCoordinate: `30402:${MERCHANT}:other`,
        specifications: product.specifications,
      },
    })
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: wrong,
        products: [product],
        merchantPubkey: MERCHANT,
      })
    ).toThrow()
    const wrongSpec = structuredClone(quote)
    wrongSpec.lines[0]!.variation!.specifications = [
      { key: "Size", value: "Small" },
    ]
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: wrongSpec,
        products: [product],
        merchantPubkey: MERCHANT,
      })
    ).toThrow()
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: quoteFor([{ product, quantity: 1, unitSats: 1_000 }]),
        products: [product],
        merchantPubkey: MERCHANT,
      })
    ).toThrow()
  })

  it("allocates the frozen SAT conversion of an unmarked signed fiat listing", () => {
    const event = finalizeEvent(
      {
        kind: 30_402,
        created_at: CREATED_AT,
        tags: [
          ["d", "fiat-digital"],
          ["title", "Fiat digital"],
          ["price", "2.50", "USD"],
          ["type", "simple", "digital"],
        ],
        content: "Signed external-style fiat listing",
      },
      MERCHANT_SECRET
    )
    const product = { ...parseProductEvent(event), sourceEventId: event.id }
    const quote = quoteFor([{ product, quantity: 2, unitSats: 2_500 }])
    Object.assign(quote, {
      pricing: {
        version: 1,
        rate: {
          rate: 100_000,
          fetchedAt: CREATED_AT * 1_000,
          source: "mempool",
        },
      },
    })
    Object.assign(quote.lines[0]!, { sourcePrice: product.sourcePrice })
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: [product],
        merchantPubkey: MERCHANT,
        acceptedAtMs: CREATED_AT * 1_000,
      })
    ).toEqual([{ kind: "merchant", recipientId: MERCHANT, amountSats: 5_000 }])
    const stale = structuredClone(quote)
    stale.pricing!.rate.fetchedAt -= 300_001
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: stale,
        products: [product],
        merchantPubkey: MERCHANT,
        acceptedAtMs: CREATED_AT * 1_000,
      })
    ).toThrow()
    const changedSource = structuredClone(quote)
    changedSource.lines[0]!.sourcePrice!.amount = 2
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: changedSource,
        products: [product],
        merchantPubkey: MERCHANT,
        acceptedAtMs: CREATED_AT * 1_000,
      })
    ).toThrow()
    for (const rateChange of [
      { source: "unknown" },
      { fetchedAt: CREATED_AT * 1_000 + 0.5 },
      { fiatUsdRates: { usd: 1 } },
      { fiatUsdRates: { XXX: 1 } },
    ]) {
      const malformed = structuredClone(quote)
      Object.assign(malformed.pricing!.rate, rateChange)
      expect(() =>
        deriveCheckoutSparkSignedCommerceObligations({
          quote: malformed,
          products: [product],
          merchantPubkey: MERCHANT,
          acceptedAtMs: CREATED_AT * 1_000,
        })
      ).toThrow()
    }
  })

  it("splits quantity-adjusted merchandise and gives all signed fixed shipping to the merchant", () => {
    const shipping = finalizeEvent(
      {
        kind: 30_406,
        created_at: CREATED_AT - 1,
        tags: [
          ["d", "shipped-shipping-standard"],
          ["title", "Standard shipping"],
          ["price", "20", "SAT"],
          ["country", "US"],
          ["service", "standard"],
        ],
        content: "",
      },
      MERCHANT_SECRET
    )
    const coordinate = `30406:${MERCHANT}:shipped-shipping-standard`
    const product = signedProduct("shipped", 101, terms("3", "1"), {
      coordinate,
    })
    const quote = quoteFor([{ product, quantity: 3, unitSats: 101 }])
    quote.commerceTotalSats += 60
    quote.lines[0]!.unitShippingSats = 20
    quote.lines[0]!.shippingOption = { coordinate, eventId: shipping.id }
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: [product],
        shippingEvents: [shipping],
        merchantPubkey: MERCHANT,
      })
    ).toEqual([
      { kind: "merchant", recipientId: MERCHANT, amountSats: 288 },
      { kind: "supplier", recipientId: SUPPLIER, amountSats: 75 },
    ])
  })

  it("preserves signed listing area and exact supplier revision through allocation derivation", () => {
    const event = finalizeEvent(
      {
        kind: 30_402,
        created_at: CREATED_AT,
        tags: [
          ["d", "supplier-listing-area"],
          ["title", "Supplier listing area"],
          ["price", "1000", "SAT"],
          ["type", "simple", "digital"],
          ["location", "Example listing area"],
          ["g", "dr5r"],
          ...terms("3", "1"),
        ],
        content: "Signed digital listing with supplier allocation and area",
      },
      MERCHANT_SECRET
    )
    const product = { ...parseProductEvent(event), sourceEventId: event.id }
    expect(product).toMatchObject({
      id: `30402:${MERCHANT}:supplier-listing-area`,
      pubkey: MERCHANT,
      format: "digital",
      currency: "SATS",
      priceSats: 1_000,
      location: "Example listing area",
      geohash: "dr5r",
      supplierAllocation: {
        state: "valid",
        issues: [],
        revisionEventId: event.id,
        revisionCreatedAt: CREATED_AT,
      },
    })
    expect(product.supplierAllocation?.revisionEvent).toEqual({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote: quoteFor([{ product, quantity: 3, unitSats: 1_000 }]),
        products: [product],
        merchantPubkey: MERCHANT,
      })
    ).toEqual([
      { kind: "merchant", recipientId: MERCHANT, amountSats: 2_250 },
      { kind: "supplier", recipientId: SUPPLIER, amountSats: 750 },
    ])
  })

  it("derives stable minimal obligations across signed lines and shared suppliers", () => {
    const first = signedProduct("derived-first", 1_000, terms("3", "1"))
    const second = signedProduct("derived-second", 1, terms("2", "1"))
    const unmarked = signedProduct("derived-unmarked", 10)
    const lines = [
      { product: first, quantity: 1, unitSats: 1_000 },
      { product: second, quantity: 3, unitSats: 1 },
      { product: unmarked, quantity: 1, unitSats: 10 },
    ]
    const products = [unmarked, first, second]
    const derived = deriveCheckoutSparkSignedCommerceObligations({
      quote: quoteFor(lines),
      products,
      merchantPubkey: MERCHANT,
    })
    expect(derived).toEqual([
      { kind: "merchant", recipientId: MERCHANT, amountSats: 762 },
      { kind: "supplier", recipientId: SUPPLIER, amountSats: 251 },
    ])
    expect(
      deriveCheckoutSparkSignedCommerceObligations({
        quote: quoteFor([...lines].reverse()),
        products: [...products].reverse(),
        merchantPubkey: MERCHANT,
      })
    ).toEqual(derived)
    expect(Object.isFrozen(derived)).toBe(true)
    expect(derived.every(Object.isFrozen)).toBe(true)
    expect(Object.keys(derived[0]!)).toEqual([
      "kind",
      "recipientId",
      "amountSats",
    ])
    expect(JSON.stringify(derived)).not.toContain(RELAY)
    admit(products, quoteFor(lines), [
      obligation("merchant", MERCHANT, 762),
      obligation("supplier", SUPPLIER, 251),
    ])
  })

  it("sorts multiple suppliers and leaves whole-sat rounding residue with the merchant", () => {
    const product = signedProduct("derived-two-suppliers", 10, [
      ["conduit_supplier_allocation", "1"],
      ["zap", MERCHANT, RELAY, "1"],
      ["zap", OTHER_SUPPLIER, RELAY, "1"],
      ["zap", SUPPLIER, RELAY, "1"],
    ])
    const derived = deriveCheckoutSparkSignedCommerceObligations({
      quote: quoteFor([{ product, quantity: 1, unitSats: 10 }]),
      products: [product],
      merchantPubkey: MERCHANT,
    })
    expect(derived).toEqual([
      { kind: "merchant", recipientId: MERCHANT, amountSats: 4 },
      ...[OTHER_SUPPLIER, SUPPLIER].sort().map((recipientId) => ({
        kind: "supplier",
        recipientId,
        amountSats: 3,
      })),
    ])
  })

  it("accepts exact signed shares, aggregates one supplier across lines, and gives residue to the merchant", () => {
    const first = signedProduct("first", 1_000, terms("3", "1"))
    const second = signedProduct("second", 1, terms("2", "1"))
    const unmarked = signedProduct("unmarked", 10)
    const products = [first, second, unmarked]
    const quote = quoteFor([
      { product: first, quantity: 1, unitSats: 1_000 },
      // Per-line weighting: 3 sats becomes 2 merchant + 1 supplier.
      { product: second, quantity: 3, unitSats: 1 },
      { product: unmarked, quantity: 1, unitSats: 10 },
    ])

    expect(() =>
      admit(products, quote, [
        obligation("merchant", MERCHANT, 762),
        obligation("supplier", SUPPLIER, 251),
      ])
    ).not.toThrow()
  })

  it("accepts multiple signed suppliers with merchant rounding residue", () => {
    const product = signedProduct("two-suppliers", 10, [
      ["conduit_supplier_allocation", "1"],
      ["zap", MERCHANT, RELAY, "1"],
      ["zap", SUPPLIER, RELAY, "1"],
      ["zap", OTHER_SUPPLIER, RELAY, "1"],
    ])
    expect(() =>
      admit([product], quoteFor([{ product, quantity: 1, unitSats: 10 }]), [
        obligation("merchant", MERCHANT, 4),
        obligation("supplier", SUPPLIER, 3),
        obligation("supplier", OTHER_SUPPLIER, 3),
      ])
    ).not.toThrow()
  })

  it("rejects a changed amount, recipient, role, duplicate, or missing commerce leg", () => {
    const product = signedProduct("exact-legs", 1_000, terms("3", "1"))
    const quote = quoteFor([{ product, quantity: 1, unitSats: 1_000 }])
    const cases = [
      [
        obligation("merchant", MERCHANT, 749),
        obligation("supplier", SUPPLIER, 251),
      ],
      [
        obligation("merchant", MERCHANT, 750),
        obligation("supplier", OTHER_SUPPLIER, 250),
      ],
      [
        obligation("merchant", MERCHANT, 750),
        obligation("merchant", SUPPLIER, 250),
      ],
      [
        obligation("merchant", MERCHANT, 750),
        obligation("supplier", SUPPLIER, 250),
        obligation("supplier", SUPPLIER, 250),
      ],
      [obligation("merchant", MERCHANT, 750)],
    ]
    for (const commerce of cases) {
      expect(() => admit([product], quote, commerce)).toThrow(
        "exact signed product allocation evidence"
      )
    }
  })

  it("rejects forged, stale, projected, malformed, and repriced allocation evidence", () => {
    const product = signedProduct("signed-evidence", 1_000, terms("3", "1"))
    const quote = quoteFor([{ product, quantity: 1, unitSats: 1_000 }])
    const commerce = [
      obligation("merchant", MERCHANT, 750),
      obligation("supplier", SUPPLIER, 250),
    ]
    const variants: Product[] = [
      { ...product, supplierAllocation: undefined },
      { ...product, sourceEventId: "a".repeat(64) },
      { ...product, updatedAt: product.updatedAt + 1_000 },
      { ...product, price: 999 },
      { ...product, priceSats: 999 },
      {
        ...product,
        supplierAllocation: {
          ...product.supplierAllocation!,
          recipients: product.supplierAllocation!.recipients.map((recipient) =>
            recipient.role === "supplier"
              ? { ...recipient, weight: recipient.weight + 1 }
              : recipient
          ),
        },
      },
      {
        ...product,
        supplierAllocation: {
          ...product.supplierAllocation!,
          revisionEvent: {
            ...product.supplierAllocation!.revisionEvent!,
            content: "forged change",
          },
        },
      },
    ]
    for (const variant of variants) {
      expect(() => admit([variant], quote, commerce)).toThrow(
        "exact signed product allocation evidence"
      )
    }

    const malformed = signedProduct("invalid-weight", 1_000, terms("3", "0"))
    expect(() =>
      admit(
        [malformed],
        quoteFor([{ product: malformed, quantity: 1, unitSats: 1_000 }]),
        commerce
      )
    ).toThrow("exact signed product allocation evidence")
  })

  it("rejects dust, shipping, organizer legs, and unsafe line multiplication", () => {
    const dust = signedProduct("dust", 1, terms("1", "1"))
    expect(() =>
      admit([dust], quoteFor([{ product: dust, quantity: 1, unitSats: 1 }]), [
        obligation("merchant", MERCHANT, 1),
      ])
    ).toThrow("exact signed product allocation evidence")

    const product = signedProduct("plain", 10)
    const quote = quoteFor([{ product, quantity: 1, unitSats: 10 }])
    const commerce = [obligation("merchant", MERCHANT, 10)]
    expect(() =>
      admit(
        [product],
        { ...quote, lines: [{ ...quote.lines[0]!, unitShippingSats: 1 }] },
        commerce
      )
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      admit([product], quote, commerce, {
        recipientId: SUPPLIER,
        amountSats: 1,
        paymentRequest: "not-used-by-signed-gate",
        maxFeeSats: 0,
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      admit(
        [product],
        {
          ...quote,
          commerceTotalSats: Number.MAX_SAFE_INTEGER,
          lines: [{ ...quote.lines[0]!, quantity: Number.MAX_SAFE_INTEGER }],
        },
        commerce
      )
    ).toThrow("exact signed product allocation evidence")
  })

  it("refuses to derive from forged or stale signed evidence and unsafe totals", () => {
    const product = signedProduct("derived-evidence", 1_000, terms("3", "1"))
    const quote = quoteFor([{ product, quantity: 1, unitSats: 1_000 }])
    const derive = (candidate: Product, candidateQuote = quote) =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: candidateQuote,
        products: [candidate],
        merchantPubkey: MERCHANT,
      })
    const altered = [
      { ...product, sourceEventId: "a".repeat(64) },
      { ...product, updatedAt: product.updatedAt + 1_000 },
      { ...product, priceSats: 999 },
      {
        ...product,
        supplierAllocation: {
          ...product.supplierAllocation!,
          recipients: product.supplierAllocation!.recipients.map((recipient) =>
            recipient.role === "supplier"
              ? { ...recipient, weight: recipient.weight + 1 }
              : recipient
          ),
        },
      },
      {
        ...product,
        supplierAllocation: {
          ...product.supplierAllocation!,
          revisionEvent: {
            ...product.supplierAllocation!.revisionEvent!,
            content: "forged change",
          },
        },
      },
    ]
    for (const candidate of altered) {
      expect(() => derive(candidate)).toThrow(
        "exact signed product allocation evidence"
      )
    }
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: [product],
        merchantPubkey: OTHER_SUPPLIER,
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      derive(product, {
        ...quote,
        lines: [{ ...quote.lines[0]!, unitShippingSats: 1 }],
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: [product],
        merchantPubkey: MERCHANT,
        organizer: {
          recipientId: OTHER_SUPPLIER,
          amountSats: 1,
          paymentRequest: "not-used-by-signed-gate",
          maxFeeSats: 0,
        },
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      derive(product, { ...quote, lines: [...quote.lines, quote.lines[0]!] })
    ).toThrow("exact signed product allocation evidence")
    const dust = signedProduct("derived-dust", 1, terms("1", "1"))
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: quoteFor([{ product: dust, quantity: 1, unitSats: 1 }]),
        products: [dust],
        merchantPubkey: MERCHANT,
      })
    ).toThrow("exact signed product allocation evidence")
    expect(() =>
      derive(product, {
        ...quote,
        commerceTotalSats: Number.MAX_SAFE_INTEGER,
        lines: [{ ...quote.lines[0]!, quantity: Number.MAX_SAFE_INTEGER }],
      })
    ).toThrow("exact signed product allocation evidence")

    const second = signedProduct("derived-overflow", 1_000)
    const aggregateOverflow = quoteFor([
      {
        product,
        quantity: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
        unitSats: 1_000,
      },
      { product: second, quantity: 1, unitSats: 1_000 },
    ])
    expect(() =>
      deriveCheckoutSparkSignedCommerceObligations({
        quote: {
          ...aggregateOverflow,
          commerceTotalSats: Number.MAX_SAFE_INTEGER,
        },
        products: [product, second],
        merchantPubkey: MERCHANT,
      })
    ).toThrow("exact signed product allocation evidence")
  })
})
