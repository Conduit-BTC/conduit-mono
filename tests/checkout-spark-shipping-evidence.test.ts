import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  resolveCheckoutSparkSignedShipping,
  type CheckoutSparkCommerceQuoteLine,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const NOW = 1_800_000_000
const COORDINATE = `30406:${MERCHANT}:physical-shipping-standard`
const UNAVAILABLE = "Checkout Spark signed fulfillment evidence is unavailable."

function fixture(
  input: {
    price?: number
    shippingTags?: string[][]
    shippingCreatedAt?: number
    shippingSecret?: Uint8Array
    productTags?: string[][]
  } = {}
) {
  const productEvent = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW,
      content: "Physical listing fixture",
      tags: input.productTags ?? [
        ["d", "physical"],
        ["title", "Physical fixture"],
        ["price", "100", "SAT"],
        ["type", "simple", "physical"],
        ["shipping_option", COORDINATE],
      ],
    },
    SECRET
  )
  const shipping = finalizeEvent(
    {
      kind: 30_406,
      created_at: input.shippingCreatedAt ?? NOW - 1,
      content: "",
      tags: input.shippingTags ?? [
        ["d", "physical-shipping-standard"],
        ["title", "Standard shipping"],
        ["price", String(input.price ?? 20), "SAT"],
        ["country", "US", "CA"],
        ["service", "standard"],
      ],
    },
    input.shippingSecret ?? SECRET
  )
  const line: CheckoutSparkCommerceQuoteLine = {
    productCoordinate: `30402:${MERCHANT}:physical`,
    productEventId: productEvent.id,
    merchantPubkey: MERCHANT,
    quantity: 2,
    unitMerchandiseSats: 100,
    unitShippingSats: input.price ?? 20,
    shippingOption: { coordinate: COORDINATE, eventId: shipping.id },
  }
  return { productEvent, line, shippingEvents: [shipping] }
}

describe("checkout Spark signed fixed fulfillment", () => {
  it("does not treat event pickup graph references as fixed-shipping authority", () => {
    const input = fixture()
    const organizer = "f".repeat(64)
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        line: {
          ...input.line,
          pickup: {
            calendar: {
              coordinate: `31923:${organizer}:event`,
              eventId: "a".repeat(64),
            },
            collection: {
              coordinate: `30405:${organizer}:event`,
              eventId: "b".repeat(64),
            },
          },
        },
      })
    ).toThrow(UNAVAILABLE)
  })

  it.each([0, 20])(
    "reconstructs the exact historical %s-sat option and country rules",
    (price) => {
      const input = fixture({ price })
      const option = resolveCheckoutSparkSignedShipping(input)!
      expect(option.eventId).toBe(input.line.shippingOption!.eventId)
      expect(option.id).toBe(COORDINATE)
      expect(option.price).toBe(price)
      expect(option.countries).toEqual(["US", "CA"])
      expect(
        option.countryRules.every(
          (rule) => rule.restrictTo.length === 0 && rule.exclude.length === 0
        )
      ).toBe(true)
      option.countries.push("GB")
      expect(resolveCheckoutSparkSignedShipping(input)!.countries).toEqual([
        "US",
        "CA",
      ])
    }
  )

  it("does not infer shipping authority from a coordinate, projection, or different event ID", () => {
    const input = fixture()
    expect(() =>
      resolveCheckoutSparkSignedShipping({ ...input, shippingEvents: [] })
    ).toThrow(UNAVAILABLE)
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        shippingEvents: undefined,
      })
    ).toThrow(UNAVAILABLE)
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        line: { ...input.line, shippingOption: undefined },
      })
    ).toThrow(UNAVAILABLE)
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        line: {
          ...input.line,
          shippingOption: { coordinate: COORDINATE, eventId: "f".repeat(64) },
        },
      })
    ).toThrow(UNAVAILABLE)
  })

  it("rejects revised terms, malformed signed bytes, and a different author", () => {
    const input = fixture()
    expect(() =>
      resolveCheckoutSparkSignedShipping(
        fixture({ shippingCreatedAt: NOW + 1 })
      )
    ).toThrow(UNAVAILABLE)
    expect(() =>
      resolveCheckoutSparkSignedShipping(
        fixture({ shippingSecret: generateSecretKey() })
      )
    ).toThrow(UNAVAILABLE)
    const changed = { ...input.shippingEvents[0]!, sig: "0".repeat(128) }
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        shippingEvents: [changed],
      })
    ).toThrow(UNAVAILABLE)
    const forgedProduct = {
      ...input.productEvent,
      tags: input.productEvent.tags.filter(
        (tag) => tag[0] !== "shipping_option"
      ),
    }
    expect(() =>
      resolveCheckoutSparkSignedShipping({
        ...input,
        productEvent: forgedProduct,
      })
    ).toThrow(UNAVAILABLE)
  })

  it.each([
    ["service", "pickup"],
    ["service", "express"],
    ["price", "20", "USD"],
    ["d", "different-shipping-standard"],
    ["country"],
    ["carrier", "unsupported carrier"],
    ["restrict", "US", "902"],
  ])("does not widen canonical fixed shipping for %j", (...changedTag) => {
    const tags = fixture()
      .shippingEvents[0]!.tags.filter((tag) => tag[0] !== changedTag[0])
      .concat([changedTag])
    expect(() =>
      resolveCheckoutSparkSignedShipping(fixture({ shippingTags: tags }))
    ).toThrow(UNAVAILABLE)
  })

  it("rejects a caller-priced shipping amount including unsafe or fractional amounts", () => {
    const input = fixture()
    for (const amount of [-1, 0, 19, 20.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        resolveCheckoutSparkSignedShipping({
          ...input,
          line: { ...input.line, unitShippingSats: amount },
        })
      ).toThrow(UNAVAILABLE)
    }
  })

  it("preserves digital shipping absence and rejects unproven variable/variation product forms", () => {
    const input = fixture()
    const baseTags = input.productEvent.tags.filter(
      (tag) => tag[0] !== "type" && tag[0] !== "shipping_option"
    )
    const digital = fixture({
      productTags: [...baseTags, ["type", "simple", "digital"]],
    })
    const digitalLine = {
      ...digital.line,
      shippingOption: undefined,
      unitShippingSats: 0,
    }
    expect(
      resolveCheckoutSparkSignedShipping({ ...digital, line: digitalLine })
    ).toBeUndefined()
    for (const kind of ["variable", "variation"]) {
      const variant = fixture({
        productTags: [
          ...input.productEvent.tags.filter((tag) => tag[0] !== "type"),
          ["type", kind, "physical"],
        ],
      })
      expect(() => resolveCheckoutSparkSignedShipping(variant)).toThrow(
        "Checkout Spark frozen product pricing is unavailable."
      )
    }
    const missing = fixture({
      productTags: [...baseTags, ["type", "simple", "physical"]],
    })
    expect(() => resolveCheckoutSparkSignedShipping(missing)).toThrow(
      UNAVAILABLE
    )
  })

  it("retains frozen terms without interpreting unrelated newer shipping as replacement authority", () => {
    const input = fixture()
    const newer: SignedPublicNostrEvent = fixture({
      shippingCreatedAt: NOW + 10,
    }).shippingEvents[0]!
    expect(
      resolveCheckoutSparkSignedShipping({
        ...input,
        shippingEvents: [newer, ...input.shippingEvents],
      })!.eventId
    ).toBe(input.shippingEvents[0]!.id)
  })
})
