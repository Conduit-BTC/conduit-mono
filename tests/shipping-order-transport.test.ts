import { describe, expect, it } from "bun:test"
import NDK, {
  giftUnwrap,
  giftWrap,
  NDKEvent,
  NDKPrivateKeySigner,
} from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  parseOrderRumorEvent,
  serializeOrderRumorContent,
} from "../packages/core/src/protocol/orders"
import {
  buildShippingPolicyEventDraft,
  getMerchantShippingPolicyCoordinate,
  quoteShippingPolicy,
  type ShippingPolicy,
} from "../packages/core/src/protocol/shipping-policy"
import { orderSchema } from "../packages/core/src/schemas"

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).length

function shippingOrder(productCount: number) {
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const buyer = NDKPrivateKeySigner.generate()
  const policy: ShippingPolicy = {
    version: 1,
    title: "Shipping",
    originCountry: "US",
    currency: "SATS",
    weightAllowanceGrams: 100,
    handlingMinor: 7,
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 50_000, priceMinor: 300 }] },
      ],
    },
    international: null,
  }
  const policyCoordinate = getMerchantShippingPolicyCoordinate(merchantPubkey)
  const policyEvent = finalizeEvent(
    {
      ...buildShippingPolicyEventDraft({ policy }),
      created_at: 100,
    },
    merchantSecret
  )
  const quoteItems = Array.from({ length: productCount }, (_, index) => {
    const summary = "a".repeat(4096)
    const productEvent = finalizeEvent(
      {
        kind: 30402,
        created_at: 90,
        content: summary,
        tags: [
          ["d", `product-${index}`],
          ["title", `Product ${index}`],
          ["summary", summary],
          ["type", "simple", "physical"],
          ["price", "1000", "SATS"],
          ["weight", "200", "g"],
          ["shipping_option", policyCoordinate],
        ],
      },
      merchantSecret
    )
    return {
      productId: `30402:${merchantPubkey}:product-${index}`,
      productEventId: productEvent.id,
      productCreatedAt: 90,
      productEvent,
      quantity: 1,
      weightGrams: 200,
      currency: "SATS",
      subtotalMinor: 1000,
    }
  })
  const result = quoteShippingPolicy({
    policy,
    policyCoordinate,
    policyEventId: policyEvent.id,
    policyCreatedAt: 100,
    merchantPubkey,
    policyEvent,
    items: quoteItems,
    destination: { country: "US", subdivision: "NY", postalCode: "10001" },
  })
  if (result.status !== "quoted") throw new Error(result.status)
  return {
    buyer,
    merchantSigner: new NDKPrivateKeySigner(merchantSecret),
    merchantPubkey,
    quote: result.quote,
    quoteItems,
    policyCoordinate,
  }
}

async function encryptedOrder(productCount: number, compact = false) {
  const fixture = shippingOrder(productCount)
  const merchant = fixture.merchantSigner
  const buyerUser = await fixture.buyer.user()
  const order = orderSchema.parse({
    id: "order",
    merchantPubkey: fixture.merchantPubkey,
    buyerPubkey: buyerUser.pubkey,
    items: fixture.quoteItems.map((item, index) => ({
      productId: item.productId,
      quantity: 1,
      priceAtPurchase: 1000,
      currency: "SATS",
      format: "physical",
      shippingOptionId: fixture.policyCoordinate,
      shippingPolicyQuote: fixture.quote,
      shippingAllocatedCostSats:
        Math.floor(307 / productCount) + (index < 307 % productCount ? 1 : 0),
    })),
    subtotal: 1000 * productCount,
    currency: "SATS",
    shippingCostSats: 307,
    shippingAddress: {
      name: "Buyer",
      street: "1 Test",
      city: "New York",
      state: "NY",
      postalCode: "10001",
      country: "US",
    },
    createdAt: 100,
  })
  const recipient = await merchant.user()
  const ndk = new NDK()
  const rumor = new NDKEvent(ndk, {
    kind: 16,
    pubkey: buyerUser.pubkey,
    created_at: 100,
    tags: [
      ["p", recipient.pubkey],
      ["type", "order"],
      ["order", "order"],
    ],
    content: compact
      ? serializeOrderRumorContent(order)
      : JSON.stringify(order),
  })
  const wrapped = await giftWrap(rumor, recipient, fixture.buyer)
  const unwrapped = await giftUnwrap(wrapped, undefined, merchant)
  return {
    order,
    unwrapped,
    metrics: {
      productCount,
      summaryBytesEach: 4096,
      quoteBytes: utf8Bytes(JSON.stringify(fixture.quote)),
      orderContentBytes: utf8Bytes(rumor.content),
      inlineOrderContentBytes: utf8Bytes(JSON.stringify(order)),
      rumorPlaintextBytes: utf8Bytes(JSON.stringify(rumor.rawEvent())),
      relayMessageBytes: utf8Bytes(
        JSON.stringify(["EVENT", "test-subscription", wrapped.rawEvent()])
      ),
    },
  }
}

describe("shipping order transport", () => {
  it("imports the shipping-policy submodule in a fresh runtime", () => {
    const path = new URL(
      "../packages/core/src/protocol/shipping-policy.ts",
      import.meta.url
    ).pathname
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const policy = await import(${JSON.stringify(path)}); if (typeof policy.quoteShippingPolicy !== 'function') process.exit(1)`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(child.exitCode).toBe(0)
    expect(child.stderr.toString()).toBe("")
  })

  it("serializes, encrypts, decrypts and parses four signed products with 4 KB summaries", async () => {
    const { order, unwrapped, metrics } = await encryptedOrder(4)
    expect(metrics.orderContentBytes).toBeGreaterThan(65_535)
    expect(metrics.relayMessageBytes).toBeLessThan(512 * 1024)
    expect(parseOrderRumorEvent(unwrapped)).toEqual(order)
    expect(unwrapped.content).toBe(JSON.stringify(order))
  })

  it("deduplicates six full signed products below the real relay-message cap without changing restored orders", async () => {
    const inline = await encryptedOrder(6)
    const compact = await encryptedOrder(6, true)
    expect(inline.metrics.relayMessageBytes).toBeGreaterThan(512 * 1024)
    expect(compact.metrics.relayMessageBytes).toBeLessThan(512 * 1024)
    expect(compact.metrics.orderContentBytes).toBeLessThan(
      compact.metrics.inlineOrderContentBytes / 4
    )
    const transmitted = JSON.parse(compact.unwrapped.content)
    expect(transmitted.shippingPolicyQuotes.version).toBe(1)
    expect(transmitted.shippingPolicyQuotes.groups).toHaveLength(1)
    expect(
      transmitted.items.every(
        (item: Record<string, unknown>) =>
          item.shippingPolicyQuoteRef === 0 &&
          item.shippingPolicyQuote === undefined
      )
    ).toBe(true)
    expect(parseOrderRumorEvent(compact.unwrapped)).toEqual(compact.order)
  })

  it("preserves messages without policy quotes and rejects unsafe or conflicting group references", async () => {
    const fixture = await encryptedOrder(4, true)
    const wire = JSON.parse(fixture.unwrapped.content)
    for (const reference of [-1, 0.5, 1, Number.MAX_SAFE_INTEGER, "0", null]) {
      const malformed = structuredClone(wire)
      malformed.items[0].shippingPolicyQuoteRef = reference
      expect(() =>
        parseOrderRumorEvent({ content: JSON.stringify(malformed) })
      ).toThrow()
    }
    const missing = structuredClone(wire)
    delete missing.shippingPolicyQuotes
    expect(() =>
      parseOrderRumorEvent({ content: JSON.stringify(missing) })
    ).toThrow()
    const conflicting = structuredClone(wire)
    conflicting.items[0].shippingPolicyQuote =
      wire.shippingPolicyQuotes.groups[0]
    expect(() =>
      parseOrderRumorEvent({ content: JSON.stringify(conflicting) })
    ).toThrow()
    const unused = structuredClone(wire)
    unused.shippingPolicyQuotes.groups.push(wire.shippingPolicyQuotes.groups[0])
    expect(() =>
      parseOrderRumorEvent({ content: JSON.stringify(unused) })
    ).toThrow()
    const unsupported = structuredClone(wire)
    unsupported.shippingPolicyQuotes.version = 2
    expect(() =>
      parseOrderRumorEvent({ content: JSON.stringify(unsupported) })
    ).toThrow()
    const extraPayload = {
      ...fixture.order,
      pricingQuote: { btcUsdRate: 100_000, fetchedAt: 100, source: "env" },
    }
    expect(
      JSON.parse(serializeOrderRumorContent(extraPayload)).pricingQuote
    ).toEqual(extraPayload.pricingQuote)
    const legacy = {
      ...fixture.order,
      items: fixture.order.items.map((line) => {
        const item = { ...line }
        delete item.shippingPolicyQuote
        delete item.shippingAllocatedCostSats
        return item
      }),
      shippingCostSats: undefined,
    }
    expect(serializeOrderRumorContent(legacy)).toBe(JSON.stringify(legacy))
  })
})
