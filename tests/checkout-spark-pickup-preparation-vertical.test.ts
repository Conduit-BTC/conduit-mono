import { expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  calculateCheckoutSparkSettledGrossFundingSats,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  freezeCheckoutSparkSettledPlan,
  getNdk,
  openCheckoutSparkRecoveryDelivery,
  orderSchema,
  parseOrderMessageRumorEvent,
  publishCheckoutSparkRecovery,
  readCheckoutSparkMerchantOrderEvidence,
  unwrapGiftWrap,
  validateCheckoutSparkPlanSources,
  type CheckoutSparkRecoveryDeliveryRecord,
} from "@conduit/core"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { prepareCheckoutSparkSettledOrder } from "../apps/market/src/lib/checkout-spark-settled-entry"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { plainTestSigner } from "./helpers/plain-signer"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createCheckoutSparkPickupQuoteFixture } from "./support/checkout-spark-pickup-quote-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

it.each([
  { guest: false, pickupPriceSats: 10 },
  { guest: false, pickupPriceSats: 0 },
  { guest: true, pickupPriceSats: 10 },
  { guest: false, pickupPriceSats: 10, eventNearExpiry: true },
  { guest: true, pickupPriceSats: 10, contact: "email_only" },
  { guest: true, pickupPriceSats: 10, contact: "phone_only" },
])(
  "does not prepare new historical pickup funds or publish an order: %j",
  async ({ guest, pickupPriceSats, eventNearExpiry = false, contact }) => {
    const now = Math.floor(Date.now() / 1_000) * 1_000
    const f = await createCheckoutSparkPickupQuoteFixture({
      createdAt: now / 1_000 - (eventNearExpiry ? 3_560 : 120),
      acceptedAtMs: now,
      pickupPriceSats,
    })
    const signer = plainTestSigner(NDKPrivateKeySigner.generate())
    const buyer = guest
      ? createSessionGuestOrderSigningIdentity(
          "cutover-order",
          f.merchantPubkey,
          { storage: null, nowMs: now }
        )
      : { kind: "signed_in" as const, pubkey: signer.pubkey, signer }
    const calls = { recipient: 0, funding: 0, publication: 0 }
    await expect(
      prepareCheckoutSparkSettledOrder(
        {
          checkoutId: "cutover-checkout",
          orderId: "cutover-order",
          quoteAuthority: f.quote,
          buyer,
          network: "mainnet",
          nowMs: now,
          shouldContinue: () => true,
          ...(guest
            ? {
                guestContact:
                  contact === "email_only"
                    ? { email: "guest@example.test" }
                    : contact === "phone_only"
                      ? { phone: "+12025550123" }
                      : { email: "guest@example.test", phone: "+12025550123" },
              }
            : {}),
        },
        {
          now: () => now,
          readRecipientPayout: async () => {
            calls.recipient += 1
            throw new Error("Historical admission must not read a recipient")
          },
          prepareFunding: async () => {
            calls.funding += 1
            throw new Error("Historical admission must not initialize a wallet")
          },
          publishOrder: async () => {
            calls.publication += 1
            throw new Error("Historical admission must not publish an order")
          },
        }
      )
    ).rejects.toThrow("Historical pickup checkout terms")
    expect(calls).toEqual({ recipient: 0, funding: 0, publication: 0 })
  }
)

it.each([
  { guest: false, pickupPriceSats: 10, expiredAtRecovery: false },
  { guest: false, pickupPriceSats: 0, expiredAtRecovery: false },
  { guest: true, pickupPriceSats: 10, expiredAtRecovery: false },
  { guest: false, pickupPriceSats: 10, expiredAtRecovery: true },
])(
  "keeps an existing frozen pickup order and encrypted recovery exact after cutover: %j",
  async ({ guest, pickupPriceSats, expiredAtRecovery }) => {
    // Persisted historical fixtures start below new checkout admission. No wallet
    // is opened and no funding invoice is requested from a provider.
    const secret = generateSecretKey()
    const merchant = plainTestSigner(
      new NDKPrivateKeySigner(Buffer.from(secret).toString("hex"))
    )
    const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
    const now =
      Math.floor(Date.now() / 1_000) * 1_000 -
      (expiredAtRecovery ? 172_800_000 : 0)
    const f = await createCheckoutSparkPickupQuoteFixture({
      merchantSecret: secret,
      createdAt: now / 1_000 - 120,
      acceptedAtMs: now,
      pickupPriceSats,
    })
    const profile = finalizeEvent(
      {
        kind: 0,
        created_at: now / 1_000 - 1,
        tags: [],
        content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
      },
      secret
    )
    const total = 200 + pickupPriceSats * 2
    const gross = calculateCheckoutSparkSettledGrossFundingSats(total)
    const paymentRequest = makeSignedBolt11Fixture({
      hrp: `lnbc${gross * 10}n`,
      createdAt: now / 1_000,
      fields: [
        bolt11PaymentHashField(new Uint8Array(32).fill(3)),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
        { tag: "x", words: [28, 4] },
      ],
    })
    const plan = freezeCheckoutSparkSettledPlan({
      checkoutId: "historical-pickup-checkout",
      orderId: "historical-pickup-order",
      merchantPubkey: merchant.pubkey,
      walletId: "historical-pickup-wallet",
      network: "mainnet",
      createdAt: now,
      takeoverAt: now + 60_000,
      commerceQuote: { commerceTotalSats: total, lines: [f.line] },
      funding: {
        requestId: "historical-receive",
        paymentRequest,
        paymentHash: "03".repeat(32),
        receiverIdentityPublicKey: `02${merchant.pubkey}`,
        grossFundingSats: gross,
        createdAt: now,
        expiresAt: now + 900_000,
      },
      recipients: [
        {
          kind: "merchant",
          recipientId: merchant.pubkey,
          weightSats: total,
          destination: {
            type: "lightning_address",
            value: "merchant@wallet.conduit.market",
            source: {
              type: "signed_profile",
              profileEventId: profile.id,
              profileEventCreatedAt: profile.created_at,
            },
          },
        },
        {
          kind: "conduit",
          recipientId: "conduit-tester@rizful.com",
          weightSats: 111,
          destination: {
            type: "lightning_address",
            value: "conduit-tester@rizful.com",
            source: {
              type: "conduit_allowlist",
              policy: "local_router_canary",
            },
          },
        },
      ],
    })
    const state = createCheckoutSparkSettledReconciliation(plan)
    const mnemonic = createRuntimeMnemonic()
    const sourceEvents = [profile, f.productEvent, ...f.sourceEvents]
    const payload = createCheckoutSparkSettledRecoveryPayload({
      state,
      senderPubkey: buyer.pubkey,
      mnemonic,
      accountNumber: 1,
      preparedAt: now,
      sourceEvents,
    })
    let persisted: CheckoutSparkRecoveryDeliveryRecord | undefined
    const relays = ["wss://merchant.inbox.relay.dev"]
    await publishCheckoutSparkRecovery({
      payload,
      signer: buyer,
      persistExactWrap: async (record) => {
        persisted = record
      },
      transport: {
        recipientInboxRelays: relays,
        publishFn: async () => ({
          attemptedRelayUrls: relays,
          successfulRelayUrls: relays,
          failedRelayUrls: [],
          relayFailureMessages: {},
        }),
      },
    })
    if (!persisted)
      throw new Error("Expected an exact encrypted recovery record")
    const recovery = await openCheckoutSparkRecoveryDelivery({
      record: persisted,
      signer: merchant,
    })
    if (recovery.schemaVersion !== 2)
      throw new Error("Expected settled historical recovery")
    expect(recovery.plan).toEqual(plan)
    expect(recovery.plan.commerceQuote.lines[0]?.pickup).toEqual(f.line.pickup)
    expect(recovery.sourceEvents).toHaveLength(5)
    expect(
      validateCheckoutSparkPlanSources(recovery.plan, recovery.sourceEvents!)
    ).toMatchObject({ planDigest: plan.planDigest })
    expect(recovery.wallet.mnemonic).toBe(mnemonic)
    expect(recovery.state.credit).toBeNull()
    expect(recovery.state.legs.every((leg) => leg.intent === null)).toBe(true)

    const order = orderSchema.parse({
      id: plan.orderId,
      buyerPubkey: buyer.pubkey,
      merchantPubkey: merchant.pubkey,
      buyerIdentityKind: guest ? "guest_ephemeral" : "signed_in",
      items: f.quote.pricing.items.map((item) => ({
        ...item,
        shippingCountries: [],
        shippingCountryRules: [],
      })),
      subtotal: total,
      currency: "SATS",
      createdAt: now,
      shippingCostSats: pickupPriceSats * 2,
      shippingCostStatus: pickupPriceSats > 0 ? "priced" : "included",
      ...(guest
        ? {
            guestContact: {
              email: "guest@example.test",
              phone: "+12025550123",
            },
          }
        : {}),
    })
    const rumor = new NDKEvent(getNdk())
    rumor.kind = 16
    rumor.pubkey = buyer.pubkey
    rumor.created_at = now / 1_000
    rumor.tags = [
      ["p", merchant.pubkey],
      ["type", "order"],
      ["order", plan.orderId],
      ["amount", String(total)],
      ["currency", "SATS"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
      ["item", f.line.productCoordinate, String(f.line.quantity)],
      ["shipping", f.line.shippingOption!.coordinate],
    ]
    rumor.content = JSON.stringify(order)
    const wrapped = await wrapPrivateMessage(
      rumor,
      new NDKUser({ pubkey: merchant.pubkey }),
      buyer
    )
    const opened = await unwrapGiftWrap(wrapped, merchant)
    if (opened.status !== "ok")
      throw new Error("Expected authenticated historical order")
    const parsed = parseOrderMessageRumorEvent(opened.rumor)
    if (parsed.type !== "order")
      throw new Error("Expected parsed historical order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(parsed.payload.items[0]?.fulfillment).toEqual(
      f.quote.pricing.items[0]?.fulfillment
    )
    expect(parsed.payload.shippingAddress).toBeUndefined()
    expect(parsed.payload.shippingCostSats).toBe(pickupPriceSats * 2)
    expect(parsed.payload.buyerIdentityKind).toBe(
      guest ? "guest_ephemeral" : "signed_in"
    )
    const evidence = readCheckoutSparkMerchantOrderEvidence(opened.rumor)
    expect(evidence).not.toBeNull()
    const witness = createCheckoutSparkMerchantOrderWitness(
      plan,
      evidence!,
      buyer.pubkey,
      recovery.sourceEvents
    )
    expect(witness).toMatchObject({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
    })
    expect(
      createCheckoutSparkMerchantOrderWitness(plan, evidence!, buyer.pubkey, [])
    ).toBeNull()
    expect(JSON.stringify(parsed)).not.toContain(mnemonic)
    expect(JSON.stringify(parsed)).not.toContain(plan.funding.paymentRequest)
    expect(JSON.stringify(witness)).not.toContain(mnemonic)
    expect(JSON.stringify(witness)).not.toContain("guest@example.test")
    expect(JSON.stringify(recovery)).not.toContain("guest@example.test")
  }
)
