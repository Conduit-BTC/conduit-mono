import { describe, expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createHash } from "node:crypto"
import { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { isValidSignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildCheckoutSparkRecoveryRumor,
  canonicalizeCheckoutSparkPlanSourceEvents,
  CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES,
  CHECKOUT_SPARK_RECOVERY_SOURCE_RUMOR_MAX_BYTES,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  freezeCheckoutSparkSettledPlan,
  openCheckoutSparkRecoveryDelivery,
  openCheckoutSparkRecoveryWrap,
  parseCheckoutSparkRecoveryRumor,
  publishCheckoutSparkRecovery,
  retryCheckoutSparkRecoveryDelivery,
  snapshotCheckoutSparkPlanSourceEvents,
  wrapPrivateMessage,
  type CheckoutSparkRecoveryDeliveryRecord,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  createGuestCheckoutSparkRecoverySigner,
  createSessionGuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MERCHANT_SIGNER = plainTestSigner(
  new NDKPrivateKeySigner(Buffer.from(MERCHANT_SECRET).toString("hex"))
)
const BUYER = plainTestSigner(NDKPrivateKeySigner.generate())
const CREATED_AT = 1_800_000_000_000
const MNEMONIC = createRuntimeMnemonic()
const RELAYS = ["wss://merchant.inbox.relay.dev"]
const FUNDING_INVOICE = makeSignedBolt11Fixture({
  hrp: "lnbc1220n",
  createdAt: CREATED_AT / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(3)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
    { tag: "x", words: [28, 4] }, // 900-second funding window.
  ],
})

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function fixture(description = "A signed digital download") {
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: CREATED_AT / 1_000 - 3_600,
      tags: [
        ["d", "source-recovery-fixture"],
        ["title", "Source recovery fixture"],
        ["price", "10", "SAT"],
        ["type", "simple", "digital"],
      ],
      content: description,
    },
    MERCHANT_SECRET
  )
  const profile = finalizeEvent(
    {
      kind: 0,
      created_at: CREATED_AT / 1_000 - 1_800,
      tags: [],
      content: JSON.stringify({ lud16: "merchant@example.test" }),
    },
    MERCHANT_SECRET
  )
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "source-recovery-checkout",
    orderId: "source-recovery-order",
    merchantPubkey: MERCHANT,
    walletId: "source-recovery-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 45 * 60_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:source-recovery-fixture`,
          productEventId: product.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "source-recovery-receive",
      paymentRequest: FUNDING_INVOICE,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${MERCHANT}`,
      grossFundingSats: 122,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 15 * 60_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: profile.id,
            profileEventCreatedAt: profile.created_at,
          },
        },
        weightSats: 10,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
  const input = {
    state: createCheckoutSparkSettledReconciliation(plan),
    senderPubkey: BUYER.pubkey,
    mnemonic: MNEMONIC,
    accountNumber: 1,
    preparedAt: CREATED_AT + 1_000,
  }
  return { input, events: [product, profile], product, profile }
}

describe("initial recovery signed source bundle", () => {
  it("preserves source-less initial serialization and the existing handoff commitment", () => {
    const { input } = fixture()
    const payload = createCheckoutSparkSettledRecoveryPayload(input)
    const plan = input.state.plan
    const handoffId = hash([
      "conduit:checkout-spark-recovery:v1",
      plan.checkoutId,
      plan.orderId,
      plan.planDigest,
      plan.merchantPubkey,
      input.senderPubkey,
      plan.walletId,
      plan.network,
      input.accountNumber,
      input.preparedAt,
      hash(input.state),
    ])
    expect(JSON.stringify(payload)).toBe(
      JSON.stringify({
        schemaVersion: 2,
        type: "checkout_spark_recovery",
        handoffId,
        senderPubkey: input.senderPubkey,
        merchantPubkey: plan.merchantPubkey,
        preparedAt: input.preparedAt,
        plan,
        state: input.state,
        wallet: {
          providerId: "spark",
          walletId: plan.walletId,
          network: plan.network,
          accountNumber: input.accountNumber,
          mnemonic: input.mnemonic,
        },
      })
    )
    expect(
      parseCheckoutSparkRecoveryRumor(buildCheckoutSparkRecoveryRumor(payload))
    ).toEqual(payload)
  })

  it("snapshots canonical signed fields in deterministic order without changing plan authority", () => {
    const { input, events } = fixture()
    const before = JSON.stringify(events)
    const sources = canonicalizeCheckoutSparkPlanSourceEvents(
      input.state.plan,
      events
    )
    const reversed = snapshotCheckoutSparkPlanSourceEvents(
      [...events].reverse()
    )
    expect(sources).toEqual(reversed)
    expect(sources.map((event) => event.id)).toEqual(
      events.map((event) => event.id).sort()
    )
    expect(Object.isFrozen(sources)).toBe(true)
    for (const source of sources) {
      const original = events.find((event) => event.id === source.id)!
      expect(source).not.toBe(original)
      expect(source.tags).not.toBe(original.tags)
      expect(Object.keys(source)).toEqual([
        "id",
        "pubkey",
        "created_at",
        "kind",
        "tags",
        "content",
        "sig",
      ])
      expect(Object.isFrozen(source)).toBe(true)
      expect(Object.isFrozen(source.tags)).toBe(true)
      expect(source.tags.every(Object.isFrozen)).toBe(true)
    }
    const legacy = createCheckoutSparkSettledRecoveryPayload(input)
    const payload = createCheckoutSparkSettledRecoveryPayload({
      ...input,
      sourceEvents: events,
    })
    const reordered = createCheckoutSparkSettledRecoveryPayload({
      ...input,
      sourceEvents: [...events].reverse(),
    })
    expect(payload).toEqual(reordered)
    expect(payload.handoffId).not.toBe(legacy.handoffId)
    expect(payload.handoffId).toBe(
      hash([
        "conduit:checkout-spark-recovery:v1",
        payload.plan.checkoutId,
        payload.plan.orderId,
        payload.plan.planDigest,
        payload.merchantPubkey,
        payload.senderPubkey,
        payload.plan.walletId,
        payload.plan.network,
        payload.wallet.accountNumber,
        payload.preparedAt,
        hash(payload.state),
        hash(["conduit:checkout-spark-recovery-sources:v1", sources]),
      ])
    )
    expect(payload.plan).toEqual(legacy.plan)
    expect(payload.state).toEqual(legacy.state)
    expect(payload.sourceEvents).toEqual(sources)
    expect(JSON.stringify(events)).toBe(before)
    expect(
      parseCheckoutSparkRecoveryRumor(buildCheckoutSparkRecoveryRumor(payload))
    ).toEqual(payload)
  })

  it("requires all original sources rather than accepting a missing profile", () => {
    const { input, product } = fixture()
    expect(() =>
      createCheckoutSparkSettledRecoveryPayload({
        ...input,
        sourceEvents: [product],
      })
    ).toThrow("signed plan sources are unavailable")
  })

  it("keeps later progress state-only while referencing the source-bearing initial", () => {
    const { input, events } = fixture()
    const initial = createCheckoutSparkSettledRecoveryPayload({
      ...input,
      sourceEvents: events,
    })
    const progress = createCheckoutSparkSettledRecoveryProgressPayload({
      initialHandoffId: initial.handoffId,
      state: initial.state,
      senderPubkey: initial.senderPubkey,
      preparedAt: input.preparedAt + 1_000,
    })
    expect(progress.schemaVersion).toBe(3)
    expect(progress.initialHandoffId).toBe(initial.handoffId)
    expect(progress).not.toHaveProperty("sourceEvents")
    expect(progress).not.toHaveProperty("wallet")
    expect(
      parseCheckoutSparkRecoveryRumor(buildCheckoutSparkRecoveryRumor(progress))
    ).toEqual(progress)
  })

  it("bounds signed source UTF-8 bytes before a plan or wallet exists", () => {
    const { events } = fixture("Signed download details. ".repeat(1_500))
    expect(
      new TextEncoder().encode(JSON.stringify(events)).byteLength
    ).toBeGreaterThan(CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES)
    expect(() => snapshotCheckoutSparkPlanSourceEvents(events)).toThrow(
      "signed plan sources are unavailable"
    )
    const unicode = fixture("日本語のダウンロード説明。".repeat(850)).events
    expect(JSON.stringify(unicode).length).toBeLessThan(
      CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES
    )
    expect(
      new TextEncoder().encode(JSON.stringify(unicode)).byteLength
    ).toBeGreaterThan(CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES)
    expect(() => snapshotCheckoutSparkPlanSourceEvents(unicode)).toThrow(
      "signed plan sources are unavailable"
    )
  })

  it("also bounds the complete rumor with plan, state and JSON escaping", () => {
    const { input, events } = fixture(
      'A "quoted" digital download description.\n'.repeat(660)
    )
    const sourceEvents = snapshotCheckoutSparkPlanSourceEvents(events)
    expect(
      new TextEncoder().encode(JSON.stringify(sourceEvents)).byteLength
    ).toBeLessThan(CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES)
    expect(CHECKOUT_SPARK_RECOVERY_SOURCE_RUMOR_MAX_BYTES).toBe(32 * 1024)
    expect(() =>
      createCheckoutSparkSettledRecoveryPayload({ ...input, sourceEvents })
    ).toThrow("source rumor exceeds its resource budget")
  })

  it("encrypts the original sources only for Merchant and retries identical ciphertext", async () => {
    const { input, events } = fixture()
    const payload = createCheckoutSparkSettledRecoveryPayload({
      ...input,
      sourceEvents: events,
    })
    let record: CheckoutSparkRecoveryDeliveryRecord | undefined
    let wraps = 0
    const calls: string[] = []
    const published = await publishCheckoutSparkRecovery({
      payload,
      signer: BUYER,
      persistExactWrap: (value) => {
        calls.push("persist")
        record = value
      },
      transport: {
        recipientInboxRelays: RELAYS,
        giftWrapFn: async (...args) => {
          wraps += 1
          return wrapPrivateMessage(...args)
        },
        publishFn: (async () => {
          calls.push("publish")
          return {
            attemptedRelayUrls: RELAYS,
            successfulRelayUrls: RELAYS,
            failedRelayUrls: [],
            relayFailureMessages: {},
          }
        }) as never,
      },
    })
    expect(calls).toEqual(["persist", "publish"])
    expect(published.canExposeFundingInvoice).toBe(true)
    const exactRecord = record!
    const beforeRetry = JSON.stringify(exactRecord.signedRecipientWrap)
    const opened = await openCheckoutSparkRecoveryDelivery({
      record: exactRecord,
      signer: MERCHANT_SIGNER,
    })
    expect(opened).toEqual(payload)
    expect(JSON.stringify(exactRecord)).not.toContain(MNEMONIC)
    expect(JSON.stringify(exactRecord)).not.toContain("merchant@example.test")
    expect(JSON.stringify(exactRecord)).not.toContain(events[0]!.id)
    let retried: string | undefined
    await retryCheckoutSparkRecoveryDelivery({
      record: exactRecord,
      deliveryProgress: {
        schemaVersion: 1,
        recipientWrapId: exactRecord.signedRecipientWrap.id,
        acknowledgedRelayRefs: [],
      },
      recipientInboxRelays: RELAYS,
      publishFn: (async (event) => {
        retried = JSON.stringify(event)
        return {
          attemptedRelayUrls: RELAYS,
          successfulRelayUrls: RELAYS,
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      }) as never,
    })
    expect(retried).toBe(beforeRetry)
    expect(wraps).toBe(1)
  })

  it("roundtrips original sources with the existing scoped guest signing capability", async () => {
    const { input, events } = fixture()
    const values = new Map<string, string>()
    const identity = createSessionGuestOrderSigningIdentity(
      input.state.plan.orderId,
      MERCHANT,
      {
        nowMs: CREATED_AT,
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => void values.set(key, value),
          removeItem: (key) => void values.delete(key),
        },
      }
    )
    const payload = createCheckoutSparkSettledRecoveryPayload({
      ...input,
      senderPubkey: identity.pubkey,
      sourceEvents: events,
    })
    const signer = createGuestCheckoutSparkRecoverySigner(identity, {
      now: () => CREATED_AT + 2_000,
    })
    const wrapped = await wrapPrivateMessage(
      buildCheckoutSparkRecoveryRumor(payload),
      new NDKUser({ pubkey: MERCHANT }),
      signer
    )
    expect(wrapped.kind).toBe(1059)
    expect(wrapped.pubkey).not.toBe(identity.pubkey)
    expect(isValidSignedPublicNostrEvent(wrapped)).toBe(true)
    expect(wrapped.content).not.toContain(events[0]!.id)
    const opened = await openCheckoutSparkRecoveryWrap({
      signedRecipientWrap: wrapped as SignedPublicNostrEvent,
      signer: MERCHANT_SIGNER,
    })
    expect(opened.payload).toEqual(payload)
    expect(opened.payload.senderPubkey).toBe(identity.pubkey)
    expect(opened.payload.plan.orderId).toBe(identity.orderId)
    expect(opened.payload.merchantPubkey).toBe(identity.merchantPubkey)
    expect(signer).not.toHaveProperty("privateKey")
    expect(signer.encryptNip44).toBeFunction()
    expect(signer).not.toHaveProperty("encrypt")
    await expect(signer.decryptNip44(MERCHANT, "synthetic")).rejects.toThrow(
      "cannot decrypt inbound"
    )
    await expect(signer.decryptLegacy(MERCHANT, "synthetic")).rejects.toThrow(
      "cannot decrypt inbound"
    )
  })
})
