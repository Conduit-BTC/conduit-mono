import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { NDKPrivateKeySigner, NDKUser, type NDKEvent } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkMerchantOrderWitness,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
  getNdk,
  openCheckoutSparkRecoveryDelivery,
  parseOrderMessageRumorEvent,
  readCheckoutSparkMerchantOrderEvidence,
  unwrapGiftWrap,
  validateCheckoutSparkPlanSources,
} from "@conduit/core"
import { prepareCheckoutSparkSettledOrder } from "../apps/market/src/lib/checkout-spark-settled-entry"
import { publishCheckoutSparkSettledBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import {
  loadAuthorizedCheckoutSparkSettledFunding,
  getCheckoutSparkSettledPreparation,
  prepareCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  assertStagedOrderLifecycleMatchesRumor,
  prepareBuyerRumor,
  type BuyerMessageDeliveryResult,
} from "../apps/market/src/lib/order-publish"
import { createCheckoutSparkPickupQuoteFixture } from "./support/checkout-spark-pickup-quote-fixture"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

class MemoryStorage {
  private readonly values = new Map<string, string>()
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

it.each([
  { guest: false, pickupPriceSats: 10 },
  { guest: false, pickupPriceSats: 0 },
  { guest: true, pickupPriceSats: 10 },
  { guest: false, pickupPriceSats: 10, expiresDuringAck: true },
  { guest: true, pickupPriceSats: 10, contactAtPublish: "email_only" },
  { guest: true, pickupPriceSats: 10, contactAtPublish: "phone_only" },
  { guest: false, pickupPriceSats: 10, expiryAtPublish: "before_publish" },
  { guest: false, pickupPriceSats: 10, expiryAtPublish: "after_acceptance" },
])(
  "preserves merchant pickup through preparation, encrypted recovery and witness: %j",
  async ({
    guest,
    pickupPriceSats,
    expiresDuringAck = false,
    contactAtPublish,
    expiryAtPublish,
  }) => {
    const secret = generateSecretKey()
    const merchant = plainTestSigner(
      new NDKPrivateKeySigner(Buffer.from(secret).toString("hex"))
    )
    const signer = plainTestSigner(NDKPrivateKeySigner.generate())
    let now = Math.floor(Date.now() / 1_000) * 1_000
    const f = await createCheckoutSparkPickupQuoteFixture({
      merchantSecret: secret,
      createdAt:
        now / 1_000 - (expiresDuringAck || expiryAtPublish ? 3_560 : 120),
      acceptedAtMs: now,
      pickupPriceSats,
    })
    const buyer = guest
      ? createSessionGuestOrderSigningIdentity(
          "pickup-vertical-order",
          merchant.pubkey,
          {
            storage: new MemoryStorage(),
            nowMs: now,
          }
        )
      : { kind: "signed_in" as const, pubkey: signer.pubkey, signer }
    const profile = finalizeEvent(
      {
        kind: 0,
        created_at: now / 1_000 - 1,
        tags: [],
        content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
      },
      secret
    )
    const database = new ConduitDB(`pickup-vertical-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const repository = new DexieCheckoutSparkSettledRepository(database)
    const storage = new MemoryStorage()
    const relays = ["wss://merchant.inbox.relay.dev"]
    const mnemonic = createRuntimeMnemonic()
    let orderWrap: NDKEvent | undefined
    let fundingRequests = 0
    let recoveryPublishes = 0
    let bindingAttempts = 0
    let publicationGuard: (() => boolean) | undefined
    let boundInput:
      Parameters<typeof publishCheckoutSparkSettledBoundOrder>[0] | undefined
    try {
      const attempt = prepareCheckoutSparkSettledOrder(
        {
          checkoutId: "pickup-vertical-checkout",
          orderId: "pickup-vertical-order",
          quoteAuthority: f.quote,
          buyer,
          ...(guest
            ? {
                guestContact: {
                  email: "guest@example.test",
                  phone: "+12025550123",
                },
              }
            : {}),
          network: "mainnet",
          nowMs: now,
          shouldContinue: () => true,
        },
        {
          now: () => now,
          ndk: getNdk(),
          readRecipientPayout: async () => ({
            state: "ready",
            recipientPubkey: merchant.pubkey,
            lud16: "merchant@wallet.conduit.market",
            profileEventId: profile.id,
            profileEventCreatedAt: profile.created_at,
            signedEvent: profile,
          }),
          prepareFunding: (input) =>
            prepareCheckoutSparkSettledFunding(
              {
                ...input,
                storage,
                recoveryStorage: storage,
              },
              {
                now: () => now,
                repository,
                fetchPayoutMetadata: (lud16) =>
                  fetchLnurlPayMetadata(lud16, {
                    fetchImpl: async () =>
                      Response.json({
                        tag: "payRequest",
                        callback: "https://wallet.conduit.market/invoice",
                        minSendable: 1_000,
                        maxSendable: 1_000_000_000,
                        allowsNostr: false,
                        metadata: "[]",
                      }),
                  }),
                createWalletMaterial: () => ({
                  walletId: "pickup-vertical-wallet",
                  network: "mainnet",
                  mnemonic,
                  accountNumber: 1,
                }),
                openWallet: async () => {},
                closeWallet: async () => {},
                createFundingReceive: async (wallet, request) => {
                  fundingRequests++
                  const amount = request.grossFundingSats!
                  return {
                    walletId: wallet.walletId,
                    network: "mainnet",
                    id: "pickup-vertical-receive",
                    paymentRequest: makeSignedBolt11Fixture({
                      hrp: `lnbc${amount * 10}n`,
                      createdAt: now / 1_000,
                      fields: [
                        bolt11PaymentHashField(new Uint8Array(32).fill(3)),
                        bolt11PaymentSecretField(),
                        bolt11PlainDescriptionField(),
                        { tag: "x", words: [28, 4] },
                      ],
                    }),
                    paymentHash: "03".repeat(32),
                    providerStatus: "INVOICE_CREATED",
                    requiredNetSats: amount,
                    grossFundingSats: amount,
                    expirySecs: 900,
                    createdAt: now,
                    expiresAt: now + 900_000,
                    receiveSettledPolicy: "ordinary-exact-credit-v3",
                    receiverIdentityPublicKey: `02${merchant.pubkey}`,
                  }
                },
                publishRecoveryHandoff: async (input) => {
                  const handoff =
                    await publishCheckoutSparkSettledRecoveryHandoff({
                      ...input,
                      now: () => now,
                      transport: {
                        recipientInboxRelays: relays,
                        publishFn: async () => {
                          recoveryPublishes++
                          return {
                            attemptedRelayUrls: relays,
                            successfulRelayUrls: relays,
                            failedRelayUrls: [],
                            relayFailureMessages: {},
                          }
                        },
                      },
                    })
                  if (expiresDuringAck) now += 41_000
                  return handoff
                },
              }
            ),
          publishOrder: (input) => {
            boundInput = { ...input, storage }
            if (contactAtPublish) {
              boundInput.order = {
                ...input.order,
                guestContact:
                  contactAtPublish === "email_only"
                    ? { email: "guest@example.test" }
                    : { phone: "+12025550123" },
              }
            }
            return publishCheckoutSparkSettledBoundOrder(boundInput, {
              now: () => now,
              loadSettledFunding: (id, options) =>
                loadAuthorizedCheckoutSparkSettledFunding(id, {
                  ...options,
                  now: () => now,
                  repository,
                  storage,
                  recoveryStorage: storage,
                }),
              bindBuyerOrder: async (...args) => {
                bindingAttempts++
                return repository.bindBuyerOrder(...args)
              },
              // Only transport is substituted. The real publisher's rumor/lifecycle
              // consistency check and the NIP-59 encryption/verification still run.
              publishOrder: async (rumor, _ndk, recipient, buyer, options) => {
                publicationGuard = options?.shouldContinue
                if (expiryAtPublish === "before_publish") now += 41_000
                // Real delivery rechecks this after route/signing awaits and
                // before its first relay attempt; simulate that external delay.
                if (options?.shouldContinue?.() === false) {
                  throw new Error(
                    "New pickup publication is no longer current."
                  )
                }
                prepareBuyerRumor(rumor, buyer.pubkey)
                assertStagedOrderLifecycleMatchesRumor(
                  options!.orderLifecycle!,
                  rumor,
                  buyer.pubkey,
                  recipient
                )
                orderWrap = await wrapPrivateMessage(
                  rumor,
                  new NDKUser({ pubkey: recipient }),
                  buyer.signer
                )
                if (expiryAtPublish === "after_acceptance") now += 41_000
                return { localCacheError: null } as BuyerMessageDeliveryResult
              },
            })
          },
        }
      )
      if (expiryAtPublish === "before_publish") {
        await expect(attempt).rejects.toThrow(
          "New pickup publication is no longer current."
        )
        expect(fundingRequests).toBe(1)
        expect(recoveryPublishes).toBe(1)
        expect(orderWrap).toBeUndefined()
        return
      }
      if (contactAtPublish) {
        await expect(attempt).rejects.toThrow(
          "Guest orders require both email and phone."
        )
        expect(fundingRequests).toBe(1)
        expect(recoveryPublishes).toBe(1)
        expect(orderWrap).toBeUndefined()
        return
      }
      if (expiresDuringAck) {
        await expect(attempt).rejects.toThrow("pickup")
        expect(fundingRequests).toBe(1)
        expect(recoveryPublishes).toBe(1)
        expect(orderWrap).toBeUndefined()
        expect(
          getCheckoutSparkSettledPreparation(
            "pickup-vertical-checkout",
            storage
          )?.fundingInvoiceExposedAt
        ).toBeNull()
        return
      }
      const result = await attempt
      if (expiryAtPublish === "after_acceptance") {
        expect(publicationGuard?.()).toBe(true)
        expect(bindingAttempts).toBe(1)
        // This transport fixture does not stage the durable ordinary order,
        // so its real repository binding fails. Expiry must still preserve
        // accepted delivery with a repair notice, never throw a retryable error.
        expect(result.published.delivery.localCacheError).toContain(
          "The order was sent"
        )
      }
      const { plan } = result.prepared
      expect(fundingRequests).toBe(1)
      expect(recoveryPublishes).toBe(1)
      const total = 200 + pickupPriceSats * 2
      expect(plan.commerceQuote.commerceTotalSats).toBe(total)
      expect(plan.recipients.map((r) => [r.kind, r.weightSats])).toEqual([
        ["merchant", total],
        ["conduit", 111],
      ])
      expect(plan.commerceQuote.lines[0]?.pickup).toEqual(f.line.pickup)
      const recovery = await openCheckoutSparkRecoveryDelivery({
        record: getCheckoutSparkRecoveryDelivery(
          result.prepared.recoveryHandoffId,
          storage
        )!.record,
        signer: merchant,
      })
      if (recovery.schemaVersion !== 2)
        throw new Error("Expected settled recovery")
      expect(recovery.sourceEvents).toHaveLength(5)
      expect(
        validateCheckoutSparkPlanSources(recovery.plan, recovery.sourceEvents!)
      ).toMatchObject({
        planDigest: plan.planDigest,
      })
      expect(recovery.wallet.mnemonic).toBe(mnemonic)
      const opened = await unwrapGiftWrap(orderWrap!, merchant)
      if (opened.status !== "ok")
        throw new Error("Expected authenticated order")
      const parsed = parseOrderMessageRumorEvent(opened.rumor)
      if (parsed.type !== "order") throw new Error("Expected pickup order")
      expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
      expect(parsed.payload.items[0]?.fulfillment).toEqual(
        f.quote.pricing.items[0]?.fulfillment
      )
      expect(parsed.payload.shippingAddress).toBeUndefined()
      expect(parsed.payload.shippingCostSats).toBe(pickupPriceSats * 2)
      expect(parsed.payload.shippingCostStatus).toBe(
        pickupPriceSats > 0 ? "priced" : "included"
      )
      expect(parsed.payload.buyerIdentityKind).toBe(buyer.kind)
      expect(parsed.payload.guestContact?.email).toBe(
        guest ? "guest@example.test" : undefined
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
      expect(JSON.stringify(parsed)).not.toContain(mnemonic)
      expect(JSON.stringify(witness)).not.toContain(mnemonic)
      expect(JSON.stringify(witness)).not.toContain("guest@example.test")
      expect(JSON.stringify(recovery)).not.toContain("guest@example.test")
      expect(JSON.stringify(parsed)).not.toContain(plan.funding.paymentRequest)
      expect(boundInput?.addressValidity).toBe("not_required")
      expect(boundInput?.shippingZoneEligibility).toBe("not_required")
      // Recovered evidence is historical terms only: missing exact graph cannot
      // produce a witness, and has not marked commerce paid or handed out.
      expect(
        createCheckoutSparkMerchantOrderWitness(
          plan,
          evidence!,
          buyer.pubkey,
          []
        )
      ).toBeNull()
      expect(result.prepared.state.credit).toBeNull()
    } finally {
      await database.delete()
    }
  }
)
