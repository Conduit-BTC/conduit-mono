import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { ConduitDB } from "@conduit/core/db"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  encodeOpenMarketsBuyerMessage,
  decodeConduitCommerceExtension,
  MAX_COMMERCE_EXTENSION_BYTES,
} from "@conduit/core/protocol/commerce-wire"
import {
  buildCommerceSupportTagsFromEvents,
  requiredCommerceFeatures,
} from "@conduit/core/protocol/commerce-capabilities"
import {
  parseOrderMessageRumorEvent,
  getOrderProtocolPayload,
  buildEventMarketOrderRumorTags,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
} from "@conduit/core/protocol/orders"
import {
  pinOrderWireFormat,
  getOrderWireFormat,
  projectOwnedNumericOrderMessages,
} from "@conduit/core/protocol/order-format"
import {
  createPrivateMessageRumor,
  wrapPrivateMessage,
  unwrapPrivateMessageEnvelope,
  assertPrivateMessageFitsTransport,
} from "@conduit/core/protocol/private-message-primitives"
import {
  readCheckoutSparkMerchantOrderEvidence,
  createCheckoutSparkMerchantOrderWitness,
  matchesCheckoutSparkMerchantOrderWitness,
} from "@conduit/core/protocol/checkout-spark-merchant-order-witness"
import { getOrganizerStockOrderBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
} from "./support/checkout-spark-event-market-fixture"
import { plainTestSigner } from "./helpers/plain-signer"

function ordinary(lines = 1, shipping = false) {
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const secret = generateSecretKey()
  const merchantPubkey = getPublicKey(secret)
  const merchant = plainTestSigner(
    new NDKPrivateKeySigner(Buffer.from(secret).toString("hex"))
  )
  const orderId = crypto.randomUUID()
  const items = Array.from({ length: lines }, (_, i) => ({
    productId: `30402:${merchantPubkey}:item-${i}-${"a".repeat(400)}`,
    quantity: 1,
    format: shipping ? ("physical" as const) : ("digital" as const),
    fulfillment: shipping
      ? { type: "shipping" as const }
      : { type: "digital" as const },
    priceAtPurchase: 100,
    currency: "SATS",
    title: "Book",
    ...(shipping
      ? { shippingOptionId: `30406:${merchantPubkey}:option-${i}` }
      : {}),
  }))
  const payload = {
    id: orderId,
    buyerPubkey: buyer.pubkey,
    merchantPubkey,
    buyerIdentityKind: "signed_in",
    items,
    subtotal: lines * 100,
    currency: "SATS",
    createdAt: Date.now(),
  }
  const sources = items.map((item) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["d", item.productId.split(":").slice(2).join(":")],
          [
            "conduit_commerce",
            "2",
            "per_item_shipping",
            "event_pickup",
            "router_checkout",
          ],
        ],
      },
      secret
    )
  )
  const tags = [
    ["p", merchantPubkey],
    ["type", "order"],
    ["order", orderId],
    ["amount", String(payload.subtotal)],
    ["currency", "SATS"],
    ...items.map((item) => ["item", item.productId, String(item.quantity)]),
    ...items.flatMap((item) =>
      item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []
    ),
  ]
  tags.push(
    ...buildCommerceSupportTagsFromEvents(
      items.map((item) => item.productId),
      requiredCommerceFeatures(payload, tags),
      sources
    )
  )
  const canonical = createPrivateMessageRumor({
    kind: 16,
    pubkey: buyer.pubkey,
    created_at: Math.floor(payload.createdAt / 1000),
    content: JSON.stringify(payload),
    tags,
  })
  const scope = { buyerPubkey: buyer.pubkey, merchantPubkey, orderId }
  return { buyer, merchant, canonical, payload, scope, sources }
}

function wire(f: ReturnType<typeof ordinary>) {
  return createPrivateMessageRumor(
    encodeOpenMarketsBuyerMessage(f.canonical, f.scope, 2)
  )
}

describe("unified numeric orders", () => {
  it("retains the exact legacy extension content for historical commitments", () => {
    const f = ordinary()
    const numeric = encodeOpenMarketsBuyerMessage(f.canonical, f.scope, 1)
    const extension = numeric.tags.find((tag) => tag[0] === "conduit")!
    extension[3] = JSON.stringify(f.payload, null, 2)
    expect(decodeConduitCommerceExtension(numeric).content).toBe(extension[3]!)
  })

  it.each([false, true])(
    "preserves complete ordinary terms through actual encryption (multiple shipping=%s)",
    async (shipping) => {
      const f = ordinary(2, shipping)
      const numeric = wire(f)
      expect(numeric.tags.find((tag) => tag[0] === "type")?.[1]).toBe("1")
      expect(numeric.tags.find((tag) => tag[0] === "conduit")?.[1]).toBe("2")
      if (shipping)
        expect(numeric.tags.filter((tag) => tag[0] === "shipping")).toEqual([])
      const wrapped = await wrapPrivateMessage(
        numeric,
        { pubkey: f.scope.merchantPubkey },
        f.buyer
      )
      const opened = await unwrapPrivateMessageEnvelope(wrapped, f.merchant)
      const parsed = parseOrderMessageRumorEvent(opened)
      expect(getOrderProtocolPayload(parsed)).toEqual(f.payload)
      expect(parsed.orderId).not.toBe(f.scope.orderId)
      expect(
        projectOwnedNumericOrderMessages(
          [parsed],
          [{ ...f.scope, orderWireFormat: "open_markets_v2" }],
          f.buyer.pubkey
        )[0]?.orderId
      ).toBe(f.scope.orderId)
    }
  )

  it("preserves snapshots over the old extension limit without fallback", async () => {
    const f = ordinary(64)
    const numeric = wire(f)
    expect(
      numeric.tags.find((tag) => tag[0] === "conduit")![3]!.length
    ).toBeGreaterThan(32768)
    expect(() => assertPrivateMessageFitsTransport(numeric)).not.toThrow()
    const opened = await unwrapPrivateMessageEnvelope(
      await wrapPrivateMessage(
        numeric,
        { pubkey: f.scope.merchantPubkey },
        f.buyer
      ),
      f.merchant
    )
    expect(
      getOrderProtocolPayload(parseOrderMessageRumorEvent(opened)).items
    ).toEqual(f.payload.items)
  })

  it("rejects unsupported, wrong-author and tampered capability evidence before encoding", () => {
    const f = ordinary(2, true)
    const missing = {
      ...f.canonical,
      tags: f.canonical.tags.filter(
        (tag) => tag[0] !== "conduit_commerce_support"
      ),
    }
    expect(() => encodeOpenMarketsBuyerMessage(missing, f.scope, 2)).toThrow(
      "do not declare support"
    )
    const tampered = structuredClone(f.sources)
    tampered[0]!.tags[0]![1] = "different"
    expect(() =>
      buildCommerceSupportTagsFromEvents(
        f.payload.items.map((item) => item.productId),
        ["per_item_shipping"],
        tampered
      )
    ).toThrow()
  })

  it("rejects conflicting common fields, nested envelopes and resource overflow", () => {
    const f = ordinary()
    const numeric = wire(f)
    numeric.tags.find((tag) => tag[0] === "amount")![1] = "200"
    expect(() => parseOrderMessageRumorEvent(numeric)).toThrow()
    const nested = wire(f)
    const extension = nested.tags.find((tag) => tag[0] === "conduit")!
    const value = JSON.parse(extension[3]!)
    value.tags.push(["conduit", "2", "order", "{}"])
    extension[3] = JSON.stringify(value)
    expect(() => decodeConduitCommerceExtension(nested)).toThrow("Nested")
    extension[3] = "é".repeat(MAX_COMMERCE_EXTENSION_BYTES)
    expect(() => decodeConduitCommerceExtension(nested)).toThrow("Unsupported")
  })

  it("retains historical writer choices and refuses changing them", async () => {
    const database = new ConduitDB(crypto.randomUUID(), {
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    })
    try {
      const f = ordinary()
      expect(getOrderWireFormat({})).toBe("conduit")
      for (const format of [
        "conduit",
        "open_markets",
        "open_markets_v2",
      ] as const) {
        const order = {
          ...f.scope,
          orderId: `${f.scope.orderId}-${format}`,
          orderWireFormat: format,
        }
        await pinOrderWireFormat(order, { database })
        await expect(
          pinOrderWireFormat(
            {
              ...order,
              orderWireFormat:
                format === "open_markets_v2" ? "conduit" : "open_markets_v2",
            },
            { database }
          )
        ).rejects.toThrow("cannot change")
        expect(
          (await database.orderWireFormats.get(order.orderId))?.orderWireFormat
        ).toBe(format)
      }
    } finally {
      await database.delete()
    }
  })

  it("retains raw organizer commitments and authentic router witnesses across the numeric envelope", async () => {
    const graph = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
    const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
    const order = createCheckoutSparkEventMarketFixtureOrder(
      graph,
      buyer.pubkey
    )
    order.buyerIdentityKind = "signed_in"
    order.shippingCostStatus = "included"
    const tags = [
      ["p", graph.merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", String(order.subtotal)],
      ["currency", "SATS"],
      ...order.items.map((item) => [
        "item",
        item.productId,
        String(item.quantity),
      ]),
      [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
      ...buildEventMarketOrderRumorTags(order),
    ]
    tags.push(
      ...buildCommerceSupportTagsFromEvents(
        order.items.map((item) => item.productId),
        requiredCommerceFeatures(order, tags),
        graph.sourceEvents
      )
    )
    const canonical = createPrivateMessageRumor({
      kind: 16,
      pubkey: buyer.pubkey,
      created_at: Math.floor(order.createdAt / 1000),
      tags,
      content: JSON.stringify(order),
    })
    const numeric = createPrivateMessageRumor(
      encodeOpenMarketsBuyerMessage(
        canonical,
        {
          buyerPubkey: buyer.pubkey,
          merchantPubkey: graph.merchantPubkey,
          orderId: order.id,
        },
        2
      )
    )
    expect(numeric.id).toBe(getEventHash(numeric))
    const opened = await unwrapPrivateMessageEnvelope(
      await wrapPrivateMessage(
        numeric,
        { pubkey: graph.merchantPubkey },
        buyer
      ),
      graph.merchantSigner
    )
    const message = parseOrderMessageRumorEvent(opened)
    expect(
      getOrganizerStockOrderBindings(getOrderProtocolPayload(message))
    ).toEqual(getOrganizerStockOrderBindings(order))
    const evidence = readCheckoutSparkMerchantOrderEvidence(opened)
    expect(evidence).not.toBeNull()
    expect(evidence!.orderId).toBe(order.id)
    const witness = createCheckoutSparkMerchantOrderWitness(
      graph.plan,
      evidence!,
      buyer.pubkey,
      graph.sourceEvents
    )
    expect(witness).not.toBeNull()
    expect(matchesCheckoutSparkMerchantOrderWitness(witness!, message)).toBe(
      true
    )
    const altered = structuredClone(message)
    if (altered.type === "order") altered.payload.subtotal++
    expect(matchesCheckoutSparkMerchantOrderWitness(witness!, altered)).toBe(
      false
    )
  })
})
