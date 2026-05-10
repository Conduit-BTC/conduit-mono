import { describe, expect, it } from "bun:test"
import {
  getProductPriceDisplay,
  normalizeCommercePrice,
  orderSchema,
  parseProductEvent,
} from "@conduit/core"

function expectSats(amount: number, currency: string, sats: number) {
  const normalized = normalizeCommercePrice(amount, currency)
  expect(normalized.status).toBe("ok")
  if (normalized.status === "ok") {
    expect(normalized.sats).toBe(sats)
  }
}

describe("commerce pricing", () => {
  it("normalizes bitcoin-denominated prices into exact integer sats", () => {
    expectSats(250_000, "SAT", 250_000)
    expectSats(250_000, "SATS", 250_000)
    expectSats(0.0025, "BTC", 250_000)
    expectSats(0.025, "BTC", 2_500_000)
    expectSats(0.0025, "XBT", 250_000)
    expectSats(250_000, "MSATS", 250)
  })

  it("rejects ambiguous or unsupported prices instead of guessing", () => {
    expect(normalizeCommercePrice(1.5, "SAT").status).toBe("invalid")
    expect(normalizeCommercePrice(-1, "SATS").status).toBe("invalid")
    expect(normalizeCommercePrice(Number.NaN, "BTC").status).toBe("invalid")
    expect(normalizeCommercePrice(10, "EUR").status).toBe("unsupported")
    expect(normalizeCommercePrice(10, "USD").status).toBe("rate_required")
  })

  it("converts USD only when a reliable BTC/USD rate is supplied", () => {
    const normalized = normalizeCommercePrice(25, "USD", 100_000)
    expect(normalized.status).toBe("ok")
    if (normalized.status === "ok") {
      expect(normalized.sats).toBe(25_000)
      expect(normalized.approximate).toBe(true)
    }
  })

  it("parses tag-only NIP-99 SAT listings as sats-canonical products", () => {
    const product = parseProductEvent({
      id: "event-1",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Pocket clip",
      tags: [
        ["d", "clip"],
        ["title", "Extra Pocket Clip"],
        ["price", "250000", "SAT"],
        ["image", "https://example.com/clip.png"],
      ],
    })

    expect(product.price).toBe(250_000)
    expect(product.currency).toBe("SATS")
    expect(product.priceSats).toBe(250_000)
    expect(product.sourcePrice).toEqual({
      amount: 250_000,
      currency: "SAT",
      normalizedCurrency: "SAT",
    })
  })

  it("parses BTC listings as sats-canonical products", () => {
    const product = parseProductEvent({
      id: "event-2",
      pubkey: "merchant",
      created_at: 1_700_000_000,
      content: "Knife",
      tags: [
        ["d", "knife"],
        ["title", "Cyberita Scandigrind Folder"],
        ["price", "0.0025", "BTC"],
        ["image", "https://example.com/knife.png"],
      ],
    })

    expect(product.price).toBe(250_000)
    expect(product.currency).toBe("SATS")
    expect(product.priceSats).toBe(250_000)
    expect(getProductPriceDisplay(product, 100_000)).toEqual({
      primary: "250,000 sats",
      secondary: "~$250.00",
    })
  })

  it("keeps 0.025 BTC distinct from 250000 sats", () => {
    const normalized = normalizeCommercePrice(0.025, "BTC")
    expect(normalized.status).toBe("ok")
    if (normalized.status === "ok") {
      expect(normalized.sats).toBe(2_500_000)
    }
  })

  it("allows checkout payloads to preserve source quotes while settling in sats", () => {
    const parsed = orderSchema.parse({
      id: "order-1",
      merchantPubkey: "merchant",
      buyerPubkey: "buyer",
      items: [
        {
          productId: "30402:merchant:item",
          quantity: 1,
          priceAtPurchase: 250_000,
          currency: "SATS",
          sourcePrice: {
            amount: 0.0025,
            currency: "BTC",
            normalizedCurrency: "BTC",
          },
        },
      ],
      subtotal: 250_000,
      currency: "SATS",
      createdAt: 1_700_000_000_000,
    })

    expect(parsed.subtotal).toBe(250_000)
    expect(parsed.items[0]?.priceAtPurchase).toBe(250_000)
    expect(parsed.items[0]?.sourcePrice?.normalizedCurrency).toBe("BTC")
  })
})
