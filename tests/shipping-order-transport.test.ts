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
import {
  publishPrivateMessage,
  wrapPrivateMessage,
} from "../packages/core/src/protocol/messaging"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import { plainTestSigner } from "./helpers/plain-signer"

import { buildUSShippingStarter } from "../apps/merchant/src/lib/usShippingStarter"

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).length

function shippingOrder(
  productCount: number,
  version: 1 | 2 = 1,
  productContent = "a".repeat(4096),
  starterPolicy?: ShippingPolicy
) {
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const buyer = NDKPrivateKeySigner.generate()
  const policy: ShippingPolicy =
    starterPolicy ??
    ({
      version,
      title: "Shipping",
      originCountry: "US",
      currency: version === 1 ? "SATS" : "GBP",
      ...(version === 1 ? { weightAllowanceGrams: 100, handlingMinor: 7 } : {}),
      domestic: {
        rules: [
          {
            country: "US",
            bands: [{ maxWeightGrams: 50_000, priceMinor: 300 }],
          },
        ],
      },
      international: null,
    } as ShippingPolicy)
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
        content: productContent,
        tags: [
          ["d", `product-${index}`],
          ["title", `Product ${index}`],
          ["summary", summary],
          ["type", "simple", "physical"],
          [
            "price",
            version === 1 ? "1000" : "10",
            version === 1 ? "SATS" : "EUR",
          ],
          ["weight", "200", "g"],
          ["shipping_option", policyCoordinate],
          ...(version === 2
            ? [
                [
                  "conduit_shipping_adjustments",
                  "1",
                  JSON.stringify({
                    weightAllowanceGrams: 20,
                    handling: {
                      amount: 1,
                      currency: "EUR",
                      normalizedCurrency: "EUR",
                    },
                  }),
                ],
              ]
            : []),
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
      currency: version === 1 ? "SATS" : "EUR",
      subtotalMinor: 1000,
      ...(version === 2
        ? {
            shippingWeightAllowanceGrams: 20,
            shippingHandling: {
              amount: 1,
              currency: "EUR",
              normalizedCurrency: "EUR",
            },
          }
        : {}),
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
    ...(version === 2
      ? {
          rateInput: {
            rate: 50_000,
            fetchedAt: 1,
            source: "env" as const,
            fiatUsdRates: { EUR: 1.25, GBP: 1.25 },
            fiatSource: "env" as const,
          },
        }
      : {}),
  })
  if (result.status !== "quoted") throw new Error(result.status)
  return {
    policy,
    buyer,
    merchantSigner: new NDKPrivateKeySigner(merchantSecret),
    merchantPubkey,
    quote: result.quote,
    quoteItems,
    policyCoordinate,
  }
}

async function prepareOrder(
  productCount: number,
  compact = false,
  version: 1 | 2 = 1,
  productContent?: string,
  starterPolicy?: ShippingPolicy
) {
  const fixture = shippingOrder(
    productCount,
    version,
    productContent,
    starterPolicy
  )
  const merchant = fixture.merchantSigner
  const buyerUser = await fixture.buyer.user()
  const shippingTotal =
    fixture.quote.version === 2
      ? fixture.quote.amountSats
      : fixture.quote.amountMinor
  const order = orderSchema.parse({
    id: "order",
    merchantPubkey: fixture.merchantPubkey,
    buyerPubkey: buyerUser.pubkey,
    items: fixture.quoteItems.map((item, index) => ({
      productId: item.productId,
      quantity: 1,
      priceAtPurchase: version === 1 ? 1000 : 25000,
      ...(version === 2
        ? {
            sourcePrice: {
              amount: 10,
              currency: "EUR",
              normalizedCurrency: "EUR",
            },
          }
        : {}),
      currency: "SATS",
      format: "physical",
      shippingOptionId: fixture.policyCoordinate,
      shippingPolicyQuote: fixture.quote,
      shippingAllocatedCostSats:
        Math.floor(shippingTotal / productCount) +
        (index < shippingTotal % productCount ? 1 : 0),
    })),
    subtotal: (version === 1 ? 1000 : 25000) * productCount,
    currency: "SATS",
    shippingCostSats: shippingTotal,
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
  return { order, rumor, recipient, fixture }
}

async function encryptedOrder(
  productCount: number,
  compact = false,
  version: 1 | 2 = 1,
  starterPolicy?: ShippingPolicy
) {
  const { order, rumor, recipient, fixture } = await prepareOrder(
    productCount,
    compact,
    version,
    undefined,
    starterPolicy
  )
  // Legacy inline fixtures measure the old wire format, including oversize controls.
  const wrapped = compact
    ? await wrapPrivateMessage(rumor, recipient, plainTestSigner(fixture.buyer))
    : await giftWrap(rumor, recipient, fixture.buyer)
  const unwrapped = await giftUnwrap(wrapped, undefined, fixture.merchantSigner)
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
        JSON.stringify(["EVENT", "test-subscription", wrapped])
      ),
    },
  }
}

describe("shipping order transport", () => {
  it("quotes, signs, encrypts and restores the resolved US starter without carrier calls or current preset lookup", async () => {
    const policy = buildUSShippingStarter("94107")
    for (const count of [1, 2, 6]) {
      const { order, unwrapped, metrics } = await encryptedOrder(
        count,
        true,
        2,
        policy
      )
      expect(parseOrderRumorEvent(unwrapped)).toEqual(order)
      expect(order.items[0]!.shippingPolicyQuote!.amountMinor).toBe(
        { 1: 1225, 2: 1650, 6: 3550 }[count as 1 | 2 | 6]
      )
      expect(metrics.relayMessageBytes).toBeLessThan(512 * 1024)
      expect(order.items[0]!.shippingPolicyQuote!.policyEvent).toBeDefined()
      expect(unwrapped.content).not.toContain("94107")
      console.info(
        `US starter ${count}-item encrypted relay message: ${metrics.relayMessageBytes} bytes`
      )
    }
  }, 30_000)
  it("transports six signed products using the largest conservative origin table", async () => {
    const { order, unwrapped, metrics } = await encryptedOrder(
      6,
      true,
      2,
      buildUSShippingStarter("58701")
    )
    expect(parseOrderRumorEvent(unwrapped)).toEqual(order)
    expect(metrics.relayMessageBytes).toBeLessThan(512 * 1024)
    console.info(
      `Largest US starter six-item relay message: ${metrics.relayMessageBytes} bytes`
    )
  }, 30_000)
  for (const version of [1, 2] as const) {
    it(`rejects omitted same-table lines in v${version} orders and compact recipient parsing`, async () => {
      const { order, fixture, rumor } = await prepareOrder(2, true, version)
      const single = quoteShippingPolicy({
        ...fixture.quote,
        policy: fixture.policy,
        items: fixture.quoteItems.slice(0, 1),
        rateInput: fixture.quote.pricingRate,
      })
      if (single.status !== "quoted") throw new Error(single.status)
      const amount = single.quote.amountSats ?? single.quote.amountMinor
      const omitted = {
        ...order,
        shippingCostSats: amount,
        items: order.items.map((item, index) => ({
          ...item,
          shippingPolicyQuote: index === 0 ? single.quote : undefined,
          shippingAllocatedCostSats: index === 0 ? amount : undefined,
        })),
      }
      expect(orderSchema.safeParse(order).success).toBe(true)
      expect(orderSchema.safeParse(omitted).success).toBe(false)
      const compact = JSON.parse(serializeOrderRumorContent(order))
      compact.shippingPolicyQuotes.groups[0] = single.quote
      compact.shippingCostSats = amount
      compact.items[0].shippingAllocatedCostSats = amount
      delete compact.items[1].shippingPolicyQuoteRef
      delete compact.items[1].shippingAllocatedCostSats
      rumor.content = JSON.stringify(compact)
      expect(() => parseOrderRumorEvent(rumor)).toThrow()
      const nextRevision = await plainTestSigner(
        fixture.merchantSigner
      ).signEvent({
        ...buildShippingPolicyEventDraft({ policy: fixture.policy }),
        pubkey: fixture.merchantPubkey,
        created_at: 101,
      })
      const second = quoteShippingPolicy({
        ...fixture.quote,
        policy: fixture.policy,
        policyEvent: nextRevision,
        policyEventId: nextRevision.id,
        policyCreatedAt: nextRevision.created_at,
        items: fixture.quoteItems.slice(1),
        rateInput: fixture.quote.pricingRate,
      })
      if (second.status !== "quoted") throw new Error(second.status)
      const secondAmount = second.quote.amountSats ?? second.quote.amountMinor
      expect(
        orderSchema.safeParse({
          ...order,
          shippingCostSats: amount + secondAmount,
          items: order.items.map((item, index) => ({
            ...item,
            shippingPolicyQuote: index === 0 ? single.quote : second.quote,
            shippingAllocatedCostSats: index === 0 ? amount : secondAmount,
          })),
        }).success
      ).toBe(false)
      expect(
        orderSchema.safeParse({
          ...order,
          items: [
            ...order.items,
            {
              productId: "digital-extra",
              format: "digital",
              quantity: 1,
              priceAtPurchase: 0,
              currency: "SATS",
              shippingOptionId: fixture.policyCoordinate,
            },
          ],
        }).success
      ).toBe(true)
      expect(
        orderSchema.safeParse({
          ...order,
          shippingCostSats: order.shippingCostSats! + 25,
          items: [
            ...order.items,
            {
              productId: "fixed-extra",
              format: "physical",
              quantity: 1,
              priceAtPurchase: 0,
              currency: "SATS",
              shippingOptionId: `30406:${fixture.merchantPubkey}:fixed-extra`,
              shippingCostSats: 25,
            },
          ],
        }).success
      ).toBe(true)
      const manual = {
        ...order,
        shippingCostStatus: "manual",
        shippingCostSats: undefined,
        items: order.items.map((item) => ({
          ...item,
          shippingPolicyQuote: undefined,
          shippingAllocatedCostSats: undefined,
        })),
      }
      expect(orderSchema.safeParse(manual).success).toBe(true)
      expect(
        orderSchema.safeParse({
          ...manual,
          shippingCostStatus: "priced",
          shippingCostSats: 0,
        }).success
      ).toBe(false)
    })
  }
  it("delivers the last supported NIP-44 padding bucket and rejects its next byte", async () => {
    const rumorBytes = (rumor: NDKEvent, pubkey: string) =>
      utf8Bytes(
        JSON.stringify({
          pubkey,
          kind: rumor.kind,
          created_at: rumor.created_at,
          tags: rumor.tags,
          content: rumor.content,
          id: "0".repeat(64),
        })
      )
    const empty = await prepareOrder(1, true, 1, "")
    // Above 224 KiB, the two padding layers push the outer frame over 512 KiB.
    const maxRumorBytes = 224 * 1024
    const contentChars =
      maxRumorBytes - rumorBytes(empty.rumor, empty.order.buyerPubkey)
    const { order, rumor, recipient, fixture } = await prepareOrder(
      1,
      true,
      1,
      "x".repeat(contentChars)
    )
    rumor.pubkey = order.buyerPubkey
    expect(rumorBytes(rumor, order.buyerPubkey)).toBe(maxRumorBytes)
    const signer = plainTestSigner(fixture.buyer)
    const wrapped = await wrapPrivateMessage(rumor, recipient, signer)
    expect(
      JSON.stringify(["EVENT", "0".repeat(64), wrapped]).length
    ).toBeLessThan(512 * 1024)
    const unwrapped = await giftUnwrap(
      wrapped,
      undefined,
      fixture.merchantSigner
    )
    expect(parseOrderRumorEvent(unwrapped)).toEqual(order)
    // UTF-8 and JSON escaping count too; displayed character counts are insufficient.
    for (const extra of ["xx", "界", '"', "\n"]) {
      const oversized = await prepareOrder(
        1,
        true,
        1,
        "x".repeat(contentChars - 1) + extra
      )
      oversized.rumor.pubkey = oversized.order.buyerPubkey
      expect(
        rumorBytes(oversized.rumor, oversized.order.buyerPubkey)
      ).toBeGreaterThan(maxRumorBytes)
      const outcome = await wrapPrivateMessage(
        oversized.rumor,
        oversized.recipient,
        plainTestSigner(oversized.fixture.buyer)
      ).then(
        () => "accepted",
        (error: Error) => error.message
      )
      expect(outcome).toContain("too large to send securely")
    }
  })
  it.each([1, 2])(
    "rejects an oversized %s-product order before routing, encryption, signing or delivery staging",
    async (productCount) => {
      const { order, rumor, recipient, fixture } = await prepareOrder(
        productCount,
        true,
        1,
        "a".repeat(productCount === 1 ? 300000 : 150000)
      )
      const source = fixture.quoteItems[0]!.productEvent
      expect(
        JSON.stringify(["EVENT", "subscription", source]).length
      ).toBeLessThan(512 * 1024)
      expect(parseProductEvent(new NDKEvent(undefined, source)).id).toBe(
        fixture.quoteItems[0]!.productId
      )
      expect(orderSchema.parse(order)).toEqual(order)
      const buyer = plainTestSigner(fixture.buyer)
      let encryptions = 0
      let signatures = 0
      let routes = 0
      let writes = 0
      let persisted = 0
      const signer = {
        ...buyer,
        pubkey: order.buyerPubkey,
        getPublicKey: () => buyer.getPublicKey(),
        signEvent: async (draft: Parameters<typeof buyer.signEvent>[0]) => {
          signatures += 1
          return buyer.signEvent(draft)
        },
        encryptNip44: async (peer: string, plaintext: string) => {
          encryptions += 1
          return buyer.encryptNip44(peer, plaintext)
        },
      }
      rumor.pubkey = order.buyerPubkey
      const outcome = await publishPrivateMessage({
        rumor,
        senderPubkey: order.buyerPubkey,
        recipientPubkey: recipient.pubkey,
        signer,
        rumorKind: 16,
        selfCopy: false,
        resolveInboxRelays: async () => {
          routes += 1
          throw new Error("Routing was reached")
        },
        publishFn: async () => {
          writes += 1
          throw new Error("Publishing was reached")
        },
        onWrapped: () => {
          persisted += 1
        },
        onRecipientPrepared: () => {
          persisted += 1
        },
      }).then(
        () => "accepted",
        (error: Error) => error.message
      )
      expect(outcome).toContain("too large to send securely")
      expect({ encryptions, signatures, routes, writes, persisted }).toEqual({
        encryptions: 0,
        signatures: 0,
        routes: 0,
        writes: 0,
        persisted: 0,
      })
      const direct = await wrapPrivateMessage(rumor, recipient, signer).then(
        () => "accepted",
        (error: Error) => error.message
      )
      expect(direct).toContain("too large to send securely")
      expect({ encryptions, signatures }).toEqual({
        encryptions: 0,
        signatures: 0,
      })
    }
  )

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

  it("restores mixed-currency v2 rates and signed per-product adjustments through real NIP-44/NIP-59", async () => {
    const fixture = await encryptedOrder(6, true, 2)
    expect(fixture.metrics.relayMessageBytes).toBeLessThan(512 * 1024)
    const parsed = parseOrderRumorEvent(fixture.unwrapped)
    expect(parsed).toEqual(fixture.order)
    const quote = parsed.items[0]!.shippingPolicyQuote!
    expect(quote).toMatchObject({
      version: 2,
      currency: "GBP",
      combinedWeightGrams: 1320,
      handlingMinor: 600,
      amountMinor: 900,
      amountSats: 22500,
      pricingRate: {
        rate: 50000,
        fetchedAt: 1,
        fiatUsdRates: { EUR: 1.25, GBP: 1.25 },
      },
    })
    expect(
      quote.items.every(
        (item) =>
          item.currency === "EUR" &&
          "shippingWeightAllowanceGrams" in item &&
          item.shippingWeightAllowanceGrams === 20 &&
          "shippingHandling" in item &&
          item.shippingHandling?.amount === 1
      )
    ).toBe(true)
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
