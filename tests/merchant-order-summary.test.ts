import { describe, expect, it } from "bun:test"
import { extractOrderSummary, parseOrderMessageRumorEvent } from "@conduit/core"

const buyerPubkey = "b".repeat(64)
const merchantPubkey = "a".repeat(64)

function parsedOrder(payload: Record<string, unknown>) {
  return parseOrderMessageRumorEvent({
    id: `event-${String(payload.id)}`,
    pubkey: buyerPubkey,
    created_at: 1,
    content: JSON.stringify({
      merchantPubkey,
      buyerPubkey,
      currency: "SATS",
      createdAt: 1,
      ...payload,
    }),
    tags: [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", String(payload.id)],
    ],
  } as never)
}

describe("merchant order pricing summary", () => {
  it("keeps the item subtotal unknown when there is no order", () => {
    expect(extractOrderSummary([]).itemSubtotal).toBeNull()
  })

  it("separates quantity-extended item subtotal, aggregate shipping, and grand total", () => {
    const order = parsedOrder({
      id: "priced-shipping-order",
      items: [
        {
          productId: "honey",
          title: "Cretan Wildflower Honey",
          quantity: 2,
          priceAtPurchase: 7_724,
          currency: "SATS",
          shippingCostSats: 7_299,
        },
        {
          productId: "olive-oil",
          title: "Costos Extra Virgin Olive Oil",
          quantity: 2,
          priceAtPurchase: 32_441,
          currency: "SATS",
          shippingCostSats: 21_898,
        },
      ],
      subtotal: 138_724,
      shippingCostSats: 58_394,
      shippingCostStatus: "priced",
    })

    const summary = extractOrderSummary([order])

    expect(summary.itemSubtotal).toBe(80_330)
    expect(summary.shippingCostSats).toBe(58_394)
    expect(summary.shippingCostStatus).toBe("priced")
    expect(summary.subtotal).toBe(138_724)
  })

  it("does not infer shipping for a legacy order with missing shipping metadata", () => {
    const order = parsedOrder({
      id: "legacy-order",
      items: [
        {
          productId: "legacy-item",
          title: "Legacy Item",
          quantity: 3,
          priceAtPurchase: 250,
          currency: "SATS",
        },
      ],
      subtotal: 900,
    })

    const summary = extractOrderSummary([order])

    expect(summary.itemSubtotal).toBe(750)
    expect(summary.shippingCostSats).toBeNull()
    expect(summary.shippingCostStatus).toBeNull()
    expect(summary.subtotal).toBe(900)
  })

  it("does not sum item prices across currencies", () => {
    const order = parsedOrder({
      id: "mixed-currency-order",
      items: [
        {
          productId: "sats-item",
          title: "Sats Item",
          quantity: 2,
          priceAtPurchase: 500,
          currency: "SATS",
        },
        {
          productId: "usd-item",
          title: "USD Item",
          quantity: 1,
          priceAtPurchase: 10,
          currency: "USD",
        },
      ],
      subtotal: 1_000,
    })

    const summary = extractOrderSummary([order])

    expect(summary.itemSubtotal).toBeNull()
    expect(summary.subtotal).toBe(1_000)
  })

  it("does not expose an unsafe-integer sats item subtotal", () => {
    const order = parsedOrder({
      id: "unsafe-item-subtotal-order",
      items: [
        {
          productId: "unsafe-item",
          title: "Unsafe Item",
          quantity: 2,
          priceAtPurchase: Number.MAX_SAFE_INTEGER,
          currency: "SATS",
        },
      ],
      subtotal: Number.MAX_SAFE_INTEGER,
    })

    expect(extractOrderSummary([order]).itemSubtotal).toBeNull()
  })
})
