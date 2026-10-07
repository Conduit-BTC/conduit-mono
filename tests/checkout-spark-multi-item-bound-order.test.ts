import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { Buffer } from "node:buffer"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
  canonicalizeShippingCost,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkSettledReconciliation,
  EVENT_KINDS,
  freezeCheckoutSparkSettledPlan,
  getNdk,
  parseOrderMessageRumorEvent,
  parseProductEvent,
  parseShippingOptionEvent,
  readCheckoutSparkMerchantOrderEvidence,
  unwrapGiftWrap,
  type OrderSchema,
} from "@conduit/core"

import {
  publishCheckoutSparkSettledBoundOrder,
  type PublishCheckoutSparkBoundOrderInput,
} from "../apps/market/src/lib/checkout-spark-bound-order"
import {
  saveCheckoutSparkSettledPreparation,
  type PreparedCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  assertStagedOrderLifecycleMatchesRumor,
  prepareBuyerRumor,
  type BuyerMessageDeliveryResult,
  type publishBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

type IdentityKind = "signed_in" | "guest_ephemeral"
type Dependencies = NonNullable<
  Parameters<typeof publishCheckoutSparkSettledBoundOrder>[1]
>
type PublishArguments = Parameters<typeof publishBuyerOrderMessage>

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

function fixture(
  kind: IdentityKind,
  fixedShippingSats?: number,
  takeoverAfterMs = 45 * 60_000
) {
  const createdAt = Math.floor(Date.now() / 1_000) * 1_000
  const merchantSecret = generateSecretKey()
  const merchant = plainTestSigner(
    new NDKPrivateKeySigner(Buffer.from(merchantSecret).toString("hex"))
  )
  const signer = plainTestSigner(NDKPrivateKeySigner.generate())
  const orderId = `multi-item-${kind}-order`
  const buyer: PublishCheckoutSparkBoundOrderInput["buyer"] =
    kind === "guest_ephemeral"
      ? createSessionGuestOrderSigningIdentity(orderId, merchant.pubkey, {
          storage: new MemoryStorage(),
          nowMs: createdAt - 60_000,
        })
      : { kind: "signed_in", pubkey: signer.pubkey, signer }
  const shippingEvent =
    fixedShippingSats === undefined
      ? undefined
      : finalizeEvent(
          {
            kind: 30_406,
            created_at: createdAt / 1_000 - 1,
            content: "",
            tags: [
              ["d", "standard"],
              ["title", "Standard Shipping"],
              ["price", String(fixedShippingSats), "SAT"],
              ["country", "US"],
              ["service", "standard"],
            ],
          },
          merchantSecret
        )
  const shipping = shippingEvent
    ? parseShippingOptionEvent(shippingEvent)!
    : undefined
  const products = [300, 400].map((amount, index) => {
    const event = finalizeEvent(
      {
        kind: 30_402,
        created_at: createdAt / 1_000,
        tags: [
          ["d", `digital-${index}`],
          ["title", "Synthetic digital item"],
          ["price", String(amount), "SAT"],
          ["type", "simple", shipping && index === 0 ? "physical" : "digital"],
          ...(shipping && index === 0
            ? [["shipping_option", shipping.id]]
            : []),
        ],
        content: "Synthetic test product",
      },
      merchantSecret
    )
    return {
      ...parseProductEvent(event),
      sourceEventId: event.id,
      sourceEvent: event,
    }
  })
  const items: OrderSchema["items"] = [
    {
      productId: products[0]!.id,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 2,
      priceAtPurchase: 300,
      sourcePrice: products[0]!.sourcePrice,
      currency: "SATS",
      shippingCostSats: 0,
    },
    {
      productId: products[1]!.id,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 400,
      sourcePrice: products[1]!.sourcePrice,
      currency: "SATS",
      shippingCostSats: 0,
    },
  ]
  if (shipping) {
    Object.assign(items[0]!, {
      format: "physical",
      fulfillment: { type: "shipping" },
      ...canonicalizeShippingCost(shipping.price, shipping.currency),
      shippingOptionId: shipping.id,
      shippingOptionDTag: shipping.dTag,
      shippingCountries: shipping.countries,
      shippingCountryRules: shipping.countryRules,
    })
  }
  const shippingTotalSats = (fixedShippingSats ?? 0) * 2
  const commerceTotalSats = 1_000 + shippingTotalSats
  const grossFundingSats =
    calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
  const invoice = makeSignedBolt11Fixture({
    hrp: `lnbc${grossFundingSats * 10}n`,
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] }, // 900 seconds: the signed 15-minute expiry.
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: `multi-item-${kind}-checkout`,
    orderId,
    merchantPubkey: merchant.pubkey,
    walletId: `multi-item-${kind}-wallet`,
    network: "mainnet",
    createdAt,
    takeoverAt: createdAt + takeoverAfterMs,
    commerceQuote: {
      commerceTotalSats,
      lines: items.map((item, index) => ({
        productCoordinate: item.productId,
        productEventId: products[index]!.sourceEventId,
        merchantPubkey: merchant.pubkey,
        quantity: item.quantity,
        unitMerchandiseSats: item.priceAtPurchase,
        unitShippingSats: item.shippingCostSats ?? 0,
        ...(shipping && index === 0
          ? {
              shippingOption: {
                coordinate: shipping.id,
                eventId: shipping.eventId,
              },
            }
          : {}),
      })),
    },
    funding: {
      requestId: "multi-item-receive",
      paymentRequest: invoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats,
      createdAt,
      expiresAt: createdAt + 15 * 60_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant.pubkey,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: createdAt / 1_000,
          },
        },
        weightSats: commerceTotalSats,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        destination: {
          type: "lightning_address",
          value: "conduithodlings@strike.me",
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats:
          calculateCheckoutSparkAllocationWeights(commerceTotalSats)
            .conduitWeightSats,
      },
    ],
  })
  const order: OrderSchema = {
    id: orderId,
    buyerPubkey: buyer.pubkey,
    buyerIdentityKind: kind,
    merchantPubkey: merchant.pubkey,
    ...(kind === "guest_ephemeral"
      ? { guestContact: { email: "guest@example.test", phone: "+12025550123" } }
      : {}),
    note: "Synthetic private multi-item note",
    items,
    subtotal: commerceTotalSats,
    currency: "SATS",
    shippingCostSats: shippingTotalSats,
    shippingCostStatus: shipping
      ? shippingTotalSats > 0
        ? "priced"
        : "included"
      : "not_required",
    ...(shipping
      ? {
          shippingAddress: {
            name: "Synthetic Buyer",
            street: "123 Main Street",
            city: "New York",
            state: "NY",
            postalCode: "10001",
            country: "US",
          },
        }
      : {}),
    createdAt,
  }
  const storage = new MemoryStorage()
  saveCheckoutSparkSettledPreparation(
    {
      schemaVersion: 3,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      recoveryHandoffId: "multi-item-handoff",
      fundingInvoiceExposedAt: createdAt,
      fundingSubmissionState: "not_started",
      savedAt: createdAt,
    },
    storage
  )
  const input: PublishCheckoutSparkBoundOrderInput = {
    checkoutId: plan.checkoutId,
    order,
    buyer,
    authenticatedPubkey: kind === "signed_in" ? buyer.pubkey : null,
    ndk: getNdk(),
    shouldContinue: () => true,
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    storage,
    sourceEvents: [
      ...products.map((product) => product.sourceEvent),
      ...(shippingEvent ? [shippingEvent] : []),
    ],
  }
  const prepared = {
    plan,
    state: createCheckoutSparkSettledReconciliation(plan),
  } as PreparedCheckoutSparkSettledFunding
  const calls = { loads: 0, published: [] as PublishArguments[], binds: 0 }
  const dependencies: Dependencies = {
    now: () => createdAt + 100,
    loadSettledFunding: async (checkoutId, options) => {
      calls.loads += 1
      expect(checkoutId).toBe(plan.checkoutId)
      expect(options?.expectedBuyerPubkey).toBe(buyer.pubkey)
      return prepared
    },
    // Transport and persistence are local stubs; construction and the separate
    // NIP-59 round trip below use the real application and crypto boundaries.
    publishOrder: async (...args) => {
      const [rumor, , recipient, , options] = args
      prepareBuyerRumor(rumor, buyer.pubkey)
      assertStagedOrderLifecycleMatchesRumor(
        options!.orderLifecycle!,
        rumor,
        buyer.pubkey,
        recipient
      )
      calls.published.push(args)
      return { localCacheError: null } as BuyerMessageDeliveryResult
    },
    bindBuyerOrder: async (boundPlan, buyerPubkey, assertCurrent) => {
      calls.binds += 1
      assertCurrent()
      expect(boundPlan).toEqual(plan)
      expect(buyerPubkey).toBe(buyer.pubkey)
      return {
        schemaVersion: 1,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        walletId: plan.walletId,
        orderId: plan.orderId,
        merchantPubkey: plan.merchantPubkey,
        buyerPubkey,
        commerceTotalSats,
      }
    },
  }
  return { input, dependencies, buyer, merchant, plan, calls, shippingEvent }
}

it("publishes the first approved order after the buyer dispatch cutoff while its funding invoice remains valid", async () => {
  const f = fixture("signed_in", undefined, 120_000)
  f.dependencies.now = () => f.plan.createdAt + 130_000
  await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
  expect(f.calls.published).toHaveLength(1)
  expect(f.calls.binds).toBe(1)
})

describe.each(["signed_in", "guest_ephemeral"] as const)(
  "%s fixed-shipping bound order",
  (kind) => {
    it.each([0, 50])(
      "binds mixed physical/digital terms with %i SAT unit shipping offline",
      async (shippingSats) => {
        const f = fixture(kind, shippingSats)
        await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        const [rumor, , , , options] = f.calls.published[0]!
        expect(options?.orderLifecycle).toMatchObject({
          itemSubtotalSats: 1_000,
          shippingCostSats: shippingSats * 2,
          totalSats: 1_000 + shippingSats * 2,
          addressValidity: "valid",
          shippingZoneEligibility: "eligible",
        })
        const local = JSON.stringify(options?.orderLifecycle)
        if (kind === "guest_ephemeral") {
          for (const privateValue of [
            f.input.order.shippingAddress!.street,
            f.input.order.shippingAddress!.name,
            f.input.order.guestContact!.email!,
            f.input.order.guestContact!.phone!,
            f.input.order.note!,
          ])
            expect(local).not.toContain(privateValue)
        } else {
          expect(options?.orderLifecycle?.shippingAddress).toEqual(
            f.input.order.shippingAddress
          )
        }
        const wrap = await wrapPrivateMessage(
          rumor,
          new NDKUser({ pubkey: f.merchant.pubkey }),
          f.buyer.signer
        )
        const opened = await unwrapGiftWrap(wrap, f.merchant)
        if (opened.status !== "ok")
          throw new Error("Expected authenticated order")
        expect(parseOrderMessageRumorEvent(opened.rumor)).toMatchObject({
          payload: f.input.order,
        })
        const evidence = readCheckoutSparkMerchantOrderEvidence(opened.rumor)
        expect(evidence).not.toBeNull()
        if (!evidence) throw new Error("Expected shipping order evidence")
        const witness = createCheckoutSparkMerchantOrderWitness(
          f.plan,
          evidence,
          f.buyer.pubkey,
          f.input.sourceEvents
        )
        expect(witness?.planDigest).toBe(f.plan.planDigest)
        expect(
          createCheckoutSparkMerchantOrderWitness(
            f.plan,
            evidence,
            f.buyer.pubkey
          )
        ).toBeNull()
        expect(
          createCheckoutSparkMerchantOrderWitness(
            f.plan,
            evidence,
            f.buyer.pubkey,
            f.input.sourceEvents?.filter((event) => event.kind !== 30_406)
          )
        ).toBeNull()
        for (const privateValue of [
          f.input.order.shippingAddress!.street,
          f.input.order.shippingAddress!.name,
          f.input.order.note!,
        ]) {
          expect(JSON.stringify(evidence)).not.toContain(privateValue)
          expect(JSON.stringify(witness)).not.toContain(privateValue)
        }
      }
    )

    it.each([
      "missing_source",
      "changed_source",
      "country_snapshot",
      "postal_snapshot",
      "cost_currency",
      "coordinate",
      "variation",
    ] as const)("rejects %s before order publication", async (change) => {
      const f = fixture(kind, 50)
      const item = f.input.order.items[0]!
      if (change === "missing_source") f.input.sourceEvents = undefined
      else if (change === "changed_source") {
        f.input.sourceEvents = f.input.sourceEvents!.map((event) =>
          event.kind === 30_406
            ? { ...event, content: "Changed signed terms" }
            : event
        )
      } else if (change === "country_snapshot") item.shippingCountries = ["CA"]
      else if (change === "postal_snapshot")
        item.shippingCountryRules![0]!.restrictTo = ["100*"]
      else if (change === "cost_currency")
        item.sourceShippingCost!.currency = "USD"
      else if (change === "coordinate") item.shippingOptionId += "-replacement"
      else item.familyProductId = item.productId
      await expect(
        publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
      ).rejects.toThrow()
      expect(f.calls.published).toHaveLength(0)
      expect(f.calls.binds).toBe(0)
    })

    it.each(["missing", "inconsistent", "outside_zone"] as const)(
      "rejects %s destination despite caller authorization flags",
      async (change) => {
        const f = fixture(kind, 50)
        f.input.addressValidity = "valid"
        f.input.shippingZoneEligibility = "eligible"
        if (change === "missing") delete f.input.order.shippingAddress
        else if (change === "inconsistent")
          f.input.order.shippingAddress!.postalCode = "invalid"
        else
          f.input.order.shippingAddress = {
            name: "Synthetic Buyer",
            street: "12 High Street",
            city: "London",
            postalCode: "SW1A 1AA",
            country: "GB",
          }
        await expect(
          publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        ).rejects.toThrow("fulfillment is not authorized")
        expect(f.calls.published).toHaveLength(0)
        expect(f.calls.binds).toBe(0)
      }
    )

    it("pins the private destination and signed shipping revision before awaiting funding authorization", async () => {
      const f = fixture(kind, 50)
      const expectedAddress = structuredClone(f.input.order.shippingAddress)
      const load = f.dependencies.loadSettledFunding!
      f.dependencies.loadSettledFunding = async (...args) => {
        f.input.order.shippingAddress!.street = "Changed after authorization"
        f.input.sourceEvents!.find((event) => event.kind === 30_406)!.content =
          "Changed after authorization"
        return load(...args)
      }
      await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
      expect(
        JSON.parse(f.calls.published[0]![0].content).shippingAddress
      ).toEqual(expectedAddress)
    })

    it.each(["country_name", "postal_rule", "shipping_cost_currency"] as const)(
      "does not create a Merchant witness for changed public %s snapshot",
      async (change) => {
        const f = fixture(kind, 50)
        await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        const rumor = f.calls.published[0]![0]
        const payload: OrderSchema = JSON.parse(rumor.content)
        const item = payload.items[0]!
        if (change === "country_name")
          item.shippingCountryRules![0]!.name = "Changed country label"
        else if (change === "postal_rule")
          item.shippingCountryRules![0]!.restrictTo = ["10001"]
        else item.sourceShippingCost!.currency = "SATS"
        rumor.content = JSON.stringify(payload)
        rumor.id = rumor.getEventHash()
        const evidence = readCheckoutSparkMerchantOrderEvidence(rumor)
        expect(evidence).not.toBeNull()
        if (!evidence)
          throw new Error("Expected independently checkable shipping snapshot")
        expect(
          createCheckoutSparkMerchantOrderWitness(
            f.plan,
            evidence,
            f.buyer.pubkey,
            f.input.sourceEvents
          )
        ).toBeNull()
      }
    )

    it.each([
      "invalid_address",
      "ineligible_country",
      "ineligible_postal",
    ] as const)(
      "does not retain Merchant order evidence for %s",
      async (change) => {
        const f = fixture(kind, 50)
        await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        const rumor = f.calls.published[0]![0]
        const payload: OrderSchema = JSON.parse(rumor.content)
        if (change === "invalid_address")
          payload.shippingAddress!.postalCode = "invalid"
        else if (change === "ineligible_country")
          payload.shippingAddress = {
            name: "Synthetic Buyer",
            street: "12 High Street",
            city: "London",
            postalCode: "SW1A 1AA",
            country: "GB",
          }
        else payload.items[0]!.shippingCountryRules![0]!.exclude = ["10001"]
        rumor.content = JSON.stringify(payload)
        rumor.id = rumor.getEventHash()
        expect(readCheckoutSparkMerchantOrderEvidence(rumor)).toBeNull()
      }
    )
  }
)

describe.each(["signed_in", "guest_ephemeral"] as const)(
  "%s multi-item settled bound order",
  (kind) => {
    it("delivers one combined order and authenticates every line against one merchant recovery plan offline", async () => {
      const f = fixture(kind)
      const result = await publishCheckoutSparkSettledBoundOrder(
        f.input,
        f.dependencies
      )
      expect(result.orderId).toBe(f.plan.orderId)
      expect(result.delivery.localCacheError).toBeNull()
      expect(f.calls.loads).toBe(1)
      expect(f.calls.published).toHaveLength(1)
      expect(f.calls.binds).toBe(1)
      const [rumor, , recipient, , options] = f.calls.published[0]!
      expect(recipient).toBe(f.merchant.pubkey)
      expect(rumor.sig).toBeUndefined()
      expect(rumor.tags).toContainEqual([...CHECKOUT_SPARK_ROUTER_ORDER_TAG])
      expect(rumor.tags.filter(([name]) => name === "item")).toEqual(
        f.input.order.items.map((item) => [
          "item",
          item.productId,
          String(item.quantity),
        ])
      )
      expect(rumor.tags).toContainEqual(["amount", "1000"])
      expect(JSON.parse(rumor.content)).toEqual(f.input.order)
      expect(options?.orderLifecycle).toMatchObject({
        orderId: f.plan.orderId,
        buyerIdentityKind: kind,
        totalSats: 1_000,
        totalMsats: 1_000_000,
        items: f.input.order.items,
        checkoutSparkRouterBinding: {
          checkoutId: f.plan.checkoutId,
          planDigest: f.plan.planDigest,
          walletId: f.plan.walletId,
        },
      })
      expect(options?.authenticatedPubkey).toBe(f.input.authenticatedPubkey)
      if (f.buyer.kind === "guest_ephemeral") {
        expect(options?.orderLifecycle?.guestSessionExpiresAt).toBe(
          f.buyer.expiresAt
        )
        const local = JSON.stringify(options?.orderLifecycle)
        expect(local).not.toContain(f.input.order.guestContact!.email!)
        expect(local).not.toContain(f.input.order.guestContact!.phone!)
        expect(local).not.toContain(f.input.order.note!)
      }

      const wrap = await wrapPrivateMessage(
        rumor,
        new NDKUser({ pubkey: f.merchant.pubkey }),
        f.buyer.signer
      )
      expect(wrap.kind).toBe(EVENT_KINDS.GIFT_WRAP)
      expect(wrap.tags).toEqual([["p", f.merchant.pubkey]])
      expect(wrap.pubkey).not.toBe(f.buyer.pubkey)
      expect(wrap.content).not.toContain(f.input.order.note!)
      const opened = await unwrapGiftWrap(wrap, f.merchant)
      expect(opened.status).toBe("ok")
      if (opened.status !== "ok")
        throw new Error("Expected authenticated order")
      expect(opened.rumor.sig).toBeUndefined()
      expect(opened.rumor.pubkey).toBe(f.buyer.pubkey)
      const message = parseOrderMessageRumorEvent(opened.rumor)
      expect(message.type).toBe("order")
      if (message.type !== "order") throw new Error("Expected order")
      expect(message.checkoutPaymentRoute).toBe("spark_router_v1")
      expect(message.payload).toEqual(f.input.order)
      expect(
        message.payload.items.map(
          (item) => item.sourcePrice?.normalizedCurrency
        )
      ).toEqual(["SAT", "SAT"])
      const evidence = readCheckoutSparkMerchantOrderEvidence(opened.rumor)
      expect(evidence).toMatchObject({
        buyerPubkey: f.buyer.pubkey,
        merchantPubkey: f.merchant.pubkey,
        orderId: f.plan.orderId,
        rumorId: opened.rumor.id,
        commerceTotalSats: 1_000,
        lines: f.input.order.items.map((item) => ({
          productCoordinate: item.productId,
          quantity: item.quantity,
          unitMerchandiseSats: item.priceAtPurchase,
          unitShippingSats: 0,
        })),
      })
      if (!evidence) throw new Error("Expected merchant order evidence")
      const witness = createCheckoutSparkMerchantOrderWitness(
        f.plan,
        evidence,
        f.buyer.pubkey
      )
      expect(witness).toEqual({
        schemaVersion: 1,
        merchantPubkey: f.merchant.pubkey,
        buyerPubkey: f.buyer.pubkey,
        orderId: f.plan.orderId,
        rumorId: opened.rumor.id,
        contentHash: evidence.contentHash,
        checkoutId: f.plan.checkoutId,
        planDigest: f.plan.planDigest,
      })
      for (const unsupportedCurrency of ["BTC", "MSAT"]) {
        expect(
          createCheckoutSparkMerchantOrderWitness(
            f.plan,
            {
              ...evidence,
              lines: evidence.lines.map((line) => ({
                ...line,
                sourcePriceCurrency: unsupportedCurrency,
              })),
            },
            f.buyer.pubkey
          )
        ).toBeNull()
      }
      expect(JSON.stringify(evidence)).not.toContain(f.input.order.note!)
      expect(JSON.stringify(witness)).not.toContain(f.input.order.note!)
      for (const secret of [
        f.plan.walletId,
        f.plan.planDigest,
        f.plan.funding.paymentRequest,
      ]) {
        expect(rumor.content).not.toContain(secret)
      }

      const changedPlan = freezeCheckoutSparkSettledPlan({
        ...f.plan,
        commerceQuote: {
          commerceTotalSats: 1_000,
          lines: f.plan.commerceQuote.lines.map((line, index) => ({
            ...line,
            unitMerchandiseSats: index === 0 ? 250 : 500,
          })),
        },
      })
      expect(changedPlan.commerceQuote.commerceTotalSats).toBe(
        evidence.commerceTotalSats
      )
      expect(
        createCheckoutSparkMerchantOrderWitness(
          changedPlan,
          evidence,
          f.buyer.pubkey
        )
      ).toBeNull()
    })

    it.each(["price_allocation", "quantity", "product_coordinate"] as const)(
      "rejects same-total per-line %s drift before publication or binding",
      async (field) => {
        const f = fixture(kind)
        const [first, second] = f.input.order.items
        if (!first || !second) throw new Error("Expected two digital lines")
        if (field === "price_allocation") {
          first.priceAtPurchase = 250
          second.priceAtPurchase = 500
        } else if (field === "quantity") {
          first.quantity = 1
          first.priceAtPurchase = 600
        } else {
          ;[first.productId, second.productId] = [
            second.productId,
            first.productId,
          ]
        }
        expect(
          f.input.order.items.reduce(
            (sum, item) => sum + item.quantity * item.priceAtPurchase,
            0
          )
        ).toBe(f.plan.commerceQuote.commerceTotalSats)
        await expect(
          publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        ).rejects.toThrow("items differ from the signed quote")
        expect(f.calls.published).toHaveLength(0)
        expect(f.calls.binds).toBe(0)
      }
    )
    it.each(["BTC", "MSAT"])(
      "rejects unsupported %s source prices before publication",
      async (currency) => {
        const f = fixture(kind)
        f.input.order.items[1]!.sourcePrice!.normalizedCurrency = currency
        await expect(
          publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
        ).rejects.toThrow()
        expect(f.calls.published).toHaveLength(0)
        expect(f.calls.binds).toBe(0)
      }
    )
  }
)
