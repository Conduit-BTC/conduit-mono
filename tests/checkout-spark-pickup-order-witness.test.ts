import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { OrderSchema } from "@conduit/core/schemas"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  parseOrderMessageRumorEvent,
} from "@conduit/core/protocol/orders"
import {
  createCheckoutSparkMerchantOrderWitness,
  matchesCheckoutSparkOrderPickupSnapshot,
  readCheckoutSparkMerchantOrderEvidence,
} from "@conduit/core/protocol/checkout-spark-merchant-order-witness"
import {
  resolveCheckoutSparkSignedPickup,
  type CheckoutSparkSignedPickup,
} from "@conduit/core/protocol/checkout-spark-pickup-evidence"
import { freezeCheckoutSparkSettledPlan } from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "@conduit/core/protocol/checkout-spark-settled-allocation"
import { createCheckoutSparkPickupFixture } from "./support/checkout-spark-pickup-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const BUYER = "a".repeat(64)

function fixture(
  options: Parameters<typeof createCheckoutSparkPickupFixture>[0] = {},
  planCreatedAtMs?: number
) {
  const f = createCheckoutSparkPickupFixture(options)
  const planCreatedAt = planCreatedAtMs ?? f.acceptedAtMs
  const pickup = resolveCheckoutSparkSignedPickup(f)!
  const commerceTotalSats =
    f.line.quantity * (f.line.unitMerchandiseSats + f.line.unitShippingSats)
  const grossFundingSats =
    calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "pickup-checkout",
    orderId: "pickup-order",
    merchantPubkey: f.merchantPubkey,
    walletId: "pickup-wallet",
    network: "regtest",
    createdAt: planCreatedAt,
    takeoverAt: planCreatedAt + 45 * 60_000,
    commerceQuote: { commerceTotalSats, lines: [f.line] },
    funding: {
      requestId: "pickup-receive",
      paymentRequest: makeSignedBolt11Fixture({
        hrp: `lnbcrt${grossFundingSats * 10}n`,
        createdAt: planCreatedAt / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(1)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${f.merchantPubkey}`,
      grossFundingSats,
      createdAt: planCreatedAt,
      expiresAt: planCreatedAt + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: f.merchantPubkey,
        weightSats: commerceTotalSats,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: Math.floor(planCreatedAt / 1_000),
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats:
          calculateCheckoutSparkAllocationWeights(commerceTotalSats)
            .conduitWeightSats,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  const order: OrderSchema = {
    id: plan.orderId,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: f.merchantPubkey,
    items: [
      {
        productId: f.line.productCoordinate,
        format: "physical",
        fulfillment: pickup,
        quantity: f.line.quantity,
        priceAtPurchase: f.line.unitMerchandiseSats,
        currency: "SATS",
        shippingCostSats: pickup.costSats,
        sourceShippingCost: { ...pickup.sourceCost },
        shippingOptionId: pickup.option.coordinate,
        shippingOptionDTag: pickup.option.coordinate
          .split(":")
          .slice(2)
          .join(":"),
        shippingCountries: [],
        shippingCountryRules: [],
      },
    ],
    subtotal: commerceTotalSats,
    currency: "SATS",
    shippingCostSats: f.line.quantity * f.line.unitShippingSats,
    shippingCostStatus: pickup.costSats > 0 ? "priced" : "included",
    createdAt: f.acceptedAtMs + 1_000,
  }
  return {
    ...f,
    pickup,
    order,
    plan,
    events: [f.productEvent, ...f.sourceEvents],
  }
}

function rumor(order: OrderSchema): NDKEvent {
  const event = new NDKEvent(undefined)
  event.kind = 16
  event.pubkey = order.buyerPubkey
  event.created_at = order.createdAt / 1_000
  event.content = JSON.stringify(order)
  event.tags = [
    ["p", order.merchantPubkey],
    ["type", "order"],
    ["order", order.id],
    ["amount", String(order.subtotal)],
    ["currency", "SATS"],
    ...order.items.flatMap((item) => [
      ["item", item.productId, String(item.quantity)],
      ...(item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []),
    ]),
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  event.id = event.getEventHash()
  return event
}

describe("pickup router order parsing and Merchant witness", () => {
  it("binds a physical pickup order without a delivery address to exact signed historical terms", () => {
    const f = fixture()
    const event = rumor(f.order)
    const parsed = parseOrderMessageRumorEvent(event)
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(parsed.payload.shippingAddress).toBeUndefined()
    const evidence = readCheckoutSparkMerchantOrderEvidence(event)
    expect(evidence).not.toBeNull()
    expect(
      createCheckoutSparkMerchantOrderWitness(
        f.plan,
        evidence!,
        BUYER,
        f.events
      )
    ).toMatchObject({
      orderId: f.order.id,
      rumorId: event.id,
      planDigest: f.plan.planDigest,
    })
  })

  it("does not mistake a well-shaped buyer-claimed public location for signed authority", () => {
    const f = fixture()
    f.order.items[0]!.fulfillment = {
      ...f.pickup,
      option: { ...f.pickup.option, location: "A different public desk" },
    }
    const evidence = readCheckoutSparkMerchantOrderEvidence(rumor(f.order))
    expect(evidence).not.toBeNull()
    expect(
      createCheckoutSparkMerchantOrderWitness(
        f.plan,
        evidence!,
        BUYER,
        f.events
      )
    ).toBeNull()
  })

  it("compares every canonical public pickup field independent of property insertion order", () => {
    const f = fixture()
    const item = f.order.items[0]!
    const reordered = Object.fromEntries(Object.entries(f.pickup).reverse())
    expect(
      matchesCheckoutSparkOrderPickupSnapshot(
        {
          ...item,
          fulfillment: reordered as CheckoutSparkSignedPickup,
        },
        f.pickup
      )
    ).toBe(true)
    const changes: ((value: CheckoutSparkSignedPickup) => void)[] = [
      (value) => {
        value.product.eventId = "1".repeat(64)
      },
      (value) => {
        value.product.createdAt++
      },
      (value) => {
        value.calendar.eventId = "2".repeat(64)
      },
      (value) => {
        value.calendar.createdAt++
      },
      (value) => {
        value.collection.eventId = "3".repeat(64)
      },
      (value) => {
        value.collection.createdAt++
      },
      (value) => {
        value.option.eventId = "4".repeat(64)
      },
      (value) => {
        value.option.createdAt++
      },
      (value) => {
        value.option.title = "Changed public title"
      },
      (value) => {
        value.option.location = "Changed public location"
      },
      (value) => {
        value.option.geohash = "dr5rs"
      },
      (value) => {
        value.costSats++
      },
      (value) => {
        value.sourceCost.currency = "SATS"
      },
      (value) => {
        value.handlerPubkey = f.organizerPubkey
      },
    ]
    for (const change of changes) {
      const changed = structuredClone(f.pickup)
      change(changed)
      expect(
        matchesCheckoutSparkOrderPickupSnapshot(
          {
            ...item,
            fulfillment: changed,
          },
          f.pickup
        )
      ).toBe(false)
    }
  })

  it("requires exact option and source cost with empty delivery-country fields", () => {
    const f = fixture()
    const item = f.order.items[0]!
    const changes: Partial<OrderSchema["items"][number]>[] = [
      { shippingCostSats: f.pickup.costSats + 1 },
      { shippingOptionId: `${f.pickup.option.coordinate}-other` },
      { shippingOptionDTag: "other" },
      { shippingOptionDTag: undefined },
      {
        sourceShippingCost: {
          ...f.pickup.sourceCost,
          amount: f.pickup.costSats + 1,
        },
      },
      { sourceShippingCost: { ...f.pickup.sourceCost, currency: "SATS" } },
      {
        sourceShippingCost: {
          ...f.pickup.sourceCost,
          normalizedCurrency: "SATS",
        },
      },
      { shippingCountries: ["US"] },
      { shippingCountries: undefined },
      {
        shippingCountryRules: [
          { code: "US", name: "United States", restrictTo: [], exclude: [] },
        ],
      },
      { shippingCountryRules: undefined },
    ]
    for (const change of changes) {
      expect(
        matchesCheckoutSparkOrderPickupSnapshot(
          { ...item, ...change },
          f.pickup
        )
      ).toBe(false)
    }
  })

  it("keeps source absence, invalid signatures and substituted revisions out of the witness", () => {
    const f = fixture()
    const evidence = readCheckoutSparkMerchantOrderEvidence(rumor(f.order))!
    expect(
      createCheckoutSparkMerchantOrderWitness(f.plan, evidence, BUYER)
    ).toBeNull()
    for (const source of f.events) {
      expect(
        createCheckoutSparkMerchantOrderWitness(
          f.plan,
          evidence,
          BUYER,
          f.events.filter((event) => event.id !== source.id)
        )
      ).toBeNull()
      expect(
        createCheckoutSparkMerchantOrderWitness(
          f.plan,
          evidence,
          BUYER,
          f.events.map((event) =>
            event.id === source.id
              ? { ...event, content: `${event.content} changed` }
              : event
          )
        )
      ).toBeNull()
    }
    const another = createCheckoutSparkPickupFixture({
      createdAt: f.calendar.created_at - 1,
    })
    expect(
      createCheckoutSparkMerchantOrderWitness(f.plan, evidence, BUYER, [
        f.productEvent,
        ...another.sourceEvents,
      ])
    ).toBeNull()
  })

  it("uses plan acceptance time for historical validation, not later order time", () => {
    const f = fixture()
    f.order.createdAt += 86_400_000
    const evidence = readCheckoutSparkMerchantOrderEvidence(rumor(f.order))!
    expect(
      createCheckoutSparkMerchantOrderWitness(f.plan, evidence, BUYER, f.events)
    ).not.toBeNull()
    const tooEarly = fixture({}, (f.productEvent.created_at - 1) * 1_000)
    expect(
      createCheckoutSparkMerchantOrderWitness(
        tooEarly.plan,
        evidence,
        BUYER,
        f.events
      )
    ).toBeNull()
  })

  it("reads included pickup and organizer-handoff history without adding release or payment authority", () => {
    for (const options of [
      { pickupPriceSats: 0, calendarKind: 31922 as const },
      {
        handoffMode: "organizer_handoff" as const,
        collectionAlias: true,
        extraCostSats: 3,
      },
    ]) {
      const f = fixture(options)
      const evidence = readCheckoutSparkMerchantOrderEvidence(rumor(f.order))!
      const witness = createCheckoutSparkMerchantOrderWitness(
        f.plan,
        evidence,
        BUYER,
        f.events
      )
      expect(witness).not.toBeNull()
      expect(Object.keys(witness!).sort()).toEqual(
        [
          "schemaVersion",
          "merchantPubkey",
          "buyerPubkey",
          "orderId",
          "rumorId",
          "contentHash",
          "checkoutId",
          "planDigest",
        ].sort()
      )
    }
  })

  it("discards guest contact, notes and unsigned annotations from public evidence and durable witness", () => {
    const f = fixture()
    f.order.buyerIdentityKind = "guest_ephemeral"
    f.order.guestContact = {
      email: "private-contact@example.test",
      phone: "+15555550199",
    }
    f.order.note = "Private guest instruction"
    Object.assign(f.order.items[0]!.fulfillment!, {
      privateAnnotation: "Private guest annotation",
    })
    const evidence = readCheckoutSparkMerchantOrderEvidence(rumor(f.order))!
    expect(evidence).not.toBeNull()
    const witness = createCheckoutSparkMerchantOrderWitness(
      f.plan,
      evidence,
      BUYER,
      f.events
    )
    expect(witness).not.toBeNull()
    for (const privateValue of [
      "private-contact@example.test",
      "+15555550199",
      "Private guest instruction",
      "Private guest annotation",
    ]) {
      expect(JSON.stringify({ evidence, witness })).not.toContain(privateValue)
    }
    const snapshot = structuredClone(evidence)
    f.pickup.option.title = "Changed caller snapshot"
    expect(evidence).toEqual(snapshot)
  })

  it("admits compatible digital items but rejects mixed postal shipping or different pickup graphs", () => {
    const f = fixture()
    const digital: OrderSchema["items"][number] = {
      productId: `30402:${f.merchantPubkey}:digital`,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 1,
      currency: "SATS",
      shippingCostSats: 0,
    }
    const mixedDigital = {
      ...f.order,
      items: [...f.order.items, digital],
      subtotal: f.order.subtotal + 1,
    }
    expect(
      readCheckoutSparkMerchantOrderEvidence(rumor(mixedDigital))
    ).not.toBeNull()
    const mixedShipping = structuredClone(f.order)
    mixedShipping.items.push({
      ...digital,
      format: "physical",
      fulfillment: { type: "shipping" },
    })
    expect(() => parseOrderMessageRumorEvent(rumor(mixedShipping))).toThrow()
    const conflicting = structuredClone(f.order)
    const second = structuredClone(conflicting.items[0]!)
    if (second.fulfillment?.type !== "pickup")
      throw new Error("Expected pickup")
    second.fulfillment.calendar.eventId = "e".repeat(64)
    conflicting.items.push(second)
    expect(() => parseOrderMessageRumorEvent(rumor(conflicting))).toThrow()
    expect(() =>
      parseOrderMessageRumorEvent(
        rumor({
          ...f.order,
          shippingAddress: {
            name: "Example",
            street: "1 Example St",
            city: "Example",
            postalCode: "10001",
            country: "US",
          },
        })
      )
    ).toThrow()
  })

  it("rejects fiat, legacy implicit handoff and postal country metadata in the router shape", () => {
    const f = fixture()
    const changes: ((order: OrderSchema) => void)[] = [
      (order) => {
        order.items[0]!.shippingCountries = ["US"]
      },
      (order) => {
        order.items[0]!.shippingCountryRules = undefined
      },
      (order) => {
        const item = order.items[0]!
        if (item.fulfillment?.type !== "pickup")
          throw new Error("Expected pickup")
        delete item.fulfillment.handoffMode
        delete item.fulfillment.handlerPubkey
      },
      (order) => {
        const item = order.items[0]!
        if (item.fulfillment?.type !== "pickup")
          throw new Error("Expected pickup")
        item.sourceShippingCost = {
          amount: 10,
          currency: "USD",
          normalizedCurrency: "USD",
        }
        item.fulfillment.sourceCost = { ...item.sourceShippingCost }
      },
    ]
    for (const change of changes) {
      const order = structuredClone(f.order)
      change(order)
      expect(() => parseOrderMessageRumorEvent(rumor(order))).toThrow(
        "Invalid private checkout payment marker"
      )
    }
  })
})
