import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  createCheckoutSparkSettledReconciliation,
  EVENT_KINDS,
  freezeCheckoutSparkSettledPlan,
  getNdk,
  parseOrderMessageRumorEvent,
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

function fixture() {
  const createdAt = Math.floor(Date.now() / 1_000) * 1_000
  const clock = { now: createdAt + 100 }
  const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
  const identity = createSessionGuestOrderSigningIdentity(
    "guest-bound-order",
    merchant.pubkey,
    { storage: new MemoryStorage(), nowMs: createdAt - 60_000 }
  )
  const product = `30402:${merchant.pubkey}:digital-item`
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc11130n",
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "guest-bound-checkout",
    orderId: identity.orderId,
    merchantPubkey: merchant.pubkey,
    walletId: "guest-bound-wallet",
    network: "mainnet",
    createdAt,
    takeoverAt: createdAt + 2 * 3_600_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: product,
          productEventId: "d".repeat(64),
          merchantPubkey: merchant.pubkey,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "guest-bound-receive",
      paymentRequest: invoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt,
      expiresAt: createdAt + 3_600_000,
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
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        destination: {
          type: "lightning_address",
          value: "conduithodlings@strike.me",
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const order: OrderSchema = {
    id: identity.orderId,
    buyerPubkey: identity.pubkey,
    buyerIdentityKind: "guest_ephemeral",
    merchantPubkey: merchant.pubkey,
    guestContact: { email: "guest@example.test", phone: "+12025550123" },
    note: "Synthetic private buyer note",
    items: [
      {
        productId: product,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt,
  }
  const storage = new MemoryStorage()
  saveCheckoutSparkSettledPreparation(
    {
      schemaVersion: 3,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      recoveryHandoffId: "guest-bound-handoff",
      fundingInvoiceExposedAt: createdAt,
      fundingSubmissionState: "not_started",
      savedAt: createdAt,
    },
    storage
  )
  const input: PublishCheckoutSparkBoundOrderInput = {
    checkoutId: plan.checkoutId,
    order,
    buyer: identity,
    authenticatedPubkey: null,
    ndk: getNdk(),
    shouldContinue: () => true,
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    storage,
  }
  const state = createCheckoutSparkSettledReconciliation(plan)
  const prepared = { plan, state } as PreparedCheckoutSparkSettledFunding
  const calls = { loads: 0, published: [] as PublishArguments[], binds: 0 }
  const dependencies: Dependencies = {
    now: () => clock.now,
    loadSettledFunding: async (_checkoutId, options) => {
      calls.loads += 1
      expect(options?.expectedBuyerPubkey).toBe(identity.pubkey)
      return prepared
    },
    publishOrder: async (...args) => {
      const [rumor, recipient, , options] = args
      prepareBuyerRumor(rumor, identity.pubkey)
      assertStagedOrderLifecycleMatchesRumor(
        options!.orderLifecycle!,
        rumor,
        identity.pubkey,
        recipient
      )
      calls.published.push(args)
      return { localCacheError: null } as BuyerMessageDeliveryResult
    },
    bindBuyerOrder: async (boundPlan, buyerPubkey, assertCurrent) => {
      calls.binds += 1
      assertCurrent()
      expect(boundPlan).toEqual(plan)
      expect(buyerPubkey).toBe(identity.pubkey)
      return {
        schemaVersion: 1,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        walletId: plan.walletId,
        orderId: plan.orderId,
        merchantPubkey: plan.merchantPubkey,
        buyerPubkey,
        commerceTotalSats: 1_000,
      }
    },
  }
  return {
    input,
    dependencies,
    identity,
    merchant,
    plan,
    prepared,
    clock,
    calls,
  }
}

describe("guest settled checkout bound order", () => {
  it("keeps contact and note only in the unsigned merchant order, with the exact guest deadline", async () => {
    const f = fixture()
    const result = await publishCheckoutSparkSettledBoundOrder(
      f.input,
      f.dependencies
    )
    expect(result.delivery.localCacheError).toBeNull()
    expect(f.calls.published).toHaveLength(1)
    expect(f.calls.binds).toBe(1)
    const [event, recipient, buyer, options] = f.calls.published[0]!
    expect(recipient).toBe(f.merchant.pubkey)
    expect(buyer).toMatchObject(f.identity)
    expect(event.sig).toBeUndefined()
    expect(event.tags).toContainEqual([...CHECKOUT_SPARK_ROUTER_ORDER_TAG])
    expect(JSON.parse(event.content)).toEqual(f.input.order)
    expect(options?.accountPubkey).toBeNull()
    expect(options?.authenticatedPubkey).toBeNull()
    expect(options?.orderLifecycle).toMatchObject({
      buyerIdentityKind: "guest_ephemeral",
      guestSessionExpiresAt: f.identity.expiresAt,
      createdAt: f.input.order.createdAt,
    })
    expect(f.input.order.createdAt).toBeGreaterThan(f.identity.createdAt)
    const local = JSON.stringify(options?.orderLifecycle)
    expect(local.includes(f.input.order.guestContact!.email!)).toBe(false)
    expect(local.includes(f.input.order.guestContact!.phone!)).toBe(false)
    expect(local.includes(f.input.order.note!)).toBe(false)
    expect(options?.orderLifecycle?.contactNote).toBeUndefined()
    expect(options?.orderLifecycle?.shippingAddress).toBeUndefined()
    expect(event.content.includes(f.plan.planDigest)).toBe(false)
    expect(event.content.includes(f.plan.funding.paymentRequest)).toBe(false)
    expect(event.content.includes(f.plan.walletId)).toBe(false)
  })

  it("round-trips the real guest seal offline without exposing contact or router terms on its wrapper", async () => {
    const f = fixture()
    await publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
    const [rumor] = f.calls.published[0]!
    const wrap = await wrapPrivateMessage(
      rumor,
      new NDKUser({ pubkey: f.merchant.pubkey }),
      f.identity.signer
    )
    expect(wrap.kind).toBe(EVENT_KINDS.GIFT_WRAP)
    expect(wrap.tags).toEqual([["p", f.merchant.pubkey]])
    expect(wrap.content.includes(f.input.order.guestContact!.email!)).toBe(
      false
    )
    expect(wrap.content.includes(f.input.order.guestContact!.phone!)).toBe(
      false
    )
    expect(wrap.pubkey).not.toBe(f.identity.pubkey)
    const opened = await unwrapGiftWrap(wrap, f.merchant)
    expect(opened.status).toBe("ok")
    if (opened.status !== "ok") throw new Error("Expected merchant-only order")
    expect(opened.rumor.sig).toBeUndefined()
    expect(opened.rumor.pubkey).toBe(f.identity.pubkey)
    const message = parseOrderMessageRumorEvent(opened.rumor)
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected order")
    expect(message.payload.guestContact).toEqual(f.input.order.guestContact)
    expect(message.checkoutPaymentRoute).toBe("spark_router_v1")
    const evidence = readCheckoutSparkMerchantOrderEvidence(opened.rumor)
    expect(evidence).toMatchObject({
      buyerPubkey: f.identity.pubkey,
      merchantPubkey: f.merchant.pubkey,
      orderId: f.identity.orderId,
      rumorId: opened.rumor.id,
      orderCreatedAt: f.input.order.createdAt,
      commerceTotalSats: f.input.order.subtotal,
      lines: [
        {
          productCoordinate: f.input.order.items[0]!.productId,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    })
    expect(evidence?.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const witnessInput = JSON.stringify(evidence)
    expect(witnessInput.includes(f.input.order.guestContact!.email!)).toBe(
      false
    )
    expect(witnessInput.includes(f.input.order.guestContact!.phone!)).toBe(
      false
    )
    expect(witnessInput.includes(f.input.order.note!)).toBe(false)
    expect(witnessInput.includes(f.plan.funding.paymentRequest)).toBe(false)
  })

  it.each(["order", "merchant", "sender", "authenticated_account"] as const)(
    "rejects mismatched guest %s authority before publication",
    async (field) => {
      const f = fixture()
      if (field === "order")
        f.input.buyer = { ...f.identity, orderId: "other-order" }
      if (field === "merchant")
        f.input.buyer = { ...f.identity, merchantPubkey: "a".repeat(64) }
      if (field === "sender")
        f.input.buyer = { ...f.identity, pubkey: "a".repeat(64) }
      if (field === "authenticated_account")
        f.input.authenticatedPubkey = f.identity.pubkey
      await expect(
        publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
      ).rejects.toThrow()
      expect(f.calls.published).toHaveLength(0)
      expect(f.calls.binds).toBe(0)
    }
  )

  it("stops when the guest expires during the authorized funding load", async () => {
    const f = fixture()
    f.dependencies.loadSettledFunding = async () => {
      f.clock.now = f.identity.expiresAt
      return f.prepared
    }
    await expect(
      publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
    ).rejects.toThrow("session changed")
    expect(f.calls.published).toHaveLength(0)
    expect(f.calls.binds).toBe(0)
  })

  it("gives the publisher a live expiry guard before any send", async () => {
    const f = fixture()
    let sends = 0
    f.dependencies.publishOrder = async (
      _event,
      _ndk,
      _recipient,
      _buyer,
      options
    ) => {
      f.clock.now = f.identity.expiresAt
      if (!options?.shouldContinue?.())
        throw new Error("Guest session expired before send")
      sends += 1
      return { localCacheError: null } as BuyerMessageDeliveryResult
    }
    await expect(
      publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
    ).rejects.toThrow("expired before send")
    expect(sends).toBe(0)
    expect(f.calls.binds).toBe(0)
  })

  it.each(["publish", "bind_guard", "bind_result"] as const)(
    "preserves accepted delivery when the guest expires during %s",
    async (stage) => {
      const f = fixture()
      const publish = f.dependencies.publishOrder!
      f.dependencies.publishOrder = async (...args) => {
        const delivery = await publish(...args)
        if (stage === "publish") f.clock.now = f.identity.expiresAt
        return delivery
      }
      const bind = f.dependencies.bindBuyerOrder!
      f.dependencies.bindBuyerOrder = async (...args) => {
        if (stage === "bind_guard") f.clock.now = f.identity.expiresAt
        const binding = await bind(...args)
        if (stage === "bind_result") f.clock.now = f.identity.expiresAt
        return binding
      }
      const result = await publishCheckoutSparkSettledBoundOrder(
        f.input,
        f.dependencies
      )
      expect(f.calls.published).toHaveLength(1)
      expect(f.calls.binds).toBe(stage === "publish" ? 0 : 1)
      expect(result.delivery.localCacheError).toBe(
        "The order was sent, but its local payment-history binding could not be saved."
      )
    }
  )

  it.each([
    "quantity",
    "total",
    "plan_digest",
    "funding_expiry",
    "takeover",
  ] as const)("rejects changed or expired frozen terms: %s", async (field) => {
    const f = fixture()
    if (field === "quantity") f.input.order.items[0]!.quantity = 2
    if (field === "total") f.input.order.subtotal += 1
    if (field === "plan_digest") {
      f.dependencies.loadSettledFunding = async () => ({
        ...f.prepared,
        plan: { ...f.plan, planDigest: "a".repeat(64) },
      })
    }
    if (field === "funding_expiry") f.clock.now = f.plan.funding.expiresAt
    if (field === "takeover") f.clock.now = f.plan.takeoverAt
    await expect(
      publishCheckoutSparkSettledBoundOrder(f.input, f.dependencies)
    ).rejects.toThrow()
    expect(f.calls.published).toHaveLength(0)
    expect(f.calls.binds).toBe(0)
  })
})
