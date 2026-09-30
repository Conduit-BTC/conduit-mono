import { describe, expect, it } from "bun:test"
import {
  buildMarketCheckoutBuyUrl,
  buildMarketCheckoutCartUrl,
  encodeProductNaddr,
  parseCheckoutIntentFragment,
} from "@conduit/core"

const first = encodeProductNaddr(`30402:${"a".repeat(64)}:first`, [
  "wss://relay.example.com",
])
const second = encodeProductNaddr(`30402:${"a".repeat(64)}:second`)
const firstOtherHint = encodeProductNaddr(`30402:${"a".repeat(64)}:first`, [
  "wss://other.example.com",
])

describe("Checkout with Conduit V1 link", () => {
  it("builds and parses the single-product shortcut", () => {
    const url = buildMarketCheckoutBuyUrl(
      "https://shop.conduit.market",
      first,
      2,
      "marketplace_a"
    )
    const result = parseCheckoutIntentFragment(new URL(url).hash)
    expect(result).toMatchObject({
      status: "valid",
      intent: {
        mode: "buy",
        partner: "marketplace_a",
        items: [{ coordinate: `30402:${"a".repeat(64)}:first`, quantity: 2 }],
      },
    })
  })

  it("builds and parses exact cart quantities", () => {
    const url = buildMarketCheckoutCartUrl("https://shop.conduit.market", [
      { product: first, quantity: 2 },
      { product: second, quantity: 3 },
    ])
    expect(parseCheckoutIntentFragment(new URL(url).hash)).toMatchObject({
      status: "valid",
      intent: { mode: "cart", items: [{ quantity: 2 }, { quantity: 3 }] },
    })
  })

  it("rejects ambiguous and duplicate product coordinates", () => {
    const cart = JSON.stringify({
      v: 1,
      items: [
        { product: first, quantity: 1 },
        { product: firstOtherHint, quantity: 1 },
      ],
    })
    expect(
      parseCheckoutIntentFragment(new URLSearchParams({ cart }).toString())
    ).toEqual({ status: "invalid", error: "invalid_intent" })
    expect(
      parseCheckoutIntentFragment(
        `buy=${first}&cart=${encodeURIComponent(cart)}`
      )
    ).toEqual({ status: "invalid", error: "invalid_intent" })
    expect(parseCheckoutIntentFragment(`buy=${first}&qty=1&qty=2`)).toEqual({
      status: "invalid",
      error: "invalid_intent",
    })
  })

  it("rejects unknown versions, unsafe sizes, malformed encoding, and invalid quantities", () => {
    expect(
      parseCheckoutIntentFragment(
        new URLSearchParams({
          cart: JSON.stringify({ v: 2, items: [] }),
        }).toString()
      )
    ).toEqual({ status: "invalid", error: "unsupported_version" })
    expect(parseCheckoutIntentFragment(`buy=${first}&qty=0`)).toEqual({
      status: "invalid",
      error: "invalid_intent",
    })
    expect(parseCheckoutIntentFragment(`buy=${first}&partner=%ZZ`)).toEqual({
      status: "invalid",
      error: "invalid_intent",
    })
    expect(
      parseCheckoutIntentFragment(`buy=${first}&pad=${"x".repeat(9000)}`)
    ).toEqual({ status: "invalid", error: "invalid_intent" })
  })

  it("does not credit malformed partner claims", () => {
    const result = parseCheckoutIntentFragment(
      `buy=${first}&partner=unique-click-123456789`
    )
    // Registration is a separate bounded lookup; syntax alone never credits a code.
    expect(result.status).toBe("valid")
  })
})
