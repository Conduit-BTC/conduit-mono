import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import {
  buildCheckoutSparkOrganizerRecoveryRumor,
  checkoutSparkOrganizerRecoveryPayloadDigest,
  createCheckoutSparkOrganizerOrderBinding,
  createCheckoutSparkOrganizerRecoveryPayload,
  openCheckoutSparkOrganizerRecovery,
  parseCheckoutSparkOrganizerRecoveryRumor,
  publishCheckoutSparkOrganizerRecovery,
  restoreCheckoutSparkOrganizerRecoveryDelivery,
  restoreCheckoutSparkOrganizerRecoveryPayload,
  retryCheckoutSparkOrganizerRecovery,
  type CheckoutSparkOrganizerRecoveryDelivery,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { createCheckoutSparkSettledRecoveryPayload } from "@conduit/core/protocol/checkout-spark-recovery"
import { createCheckoutSparkSettledReconciliation } from "@conduit/core/protocol/checkout-spark-settled-router"
import { getOrganizerStockOrderBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import type { NostrKeySigner } from "@conduit/core/protocol/nostr-event-signer"
import type { publishWithPlanner } from "@conduit/core/protocol/relay-publish"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const relays = ["wss://relay.conduit.market"]

function keySigner(): NostrKeySigner {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (peer, text) =>
      nip44.encrypt(text, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, text) =>
      nip44.decrypt(text, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy decrypt is outside this fixture")
    },
  }
}

function fixture(
  mode: "merchant_present" | "organizer_handoff" = "organizer_handoff"
) {
  const event = checkoutSparkEventMarketFixture({
    mode,
    schedule: true,
    variation: true,
  })
  const buyerSigner = keySigner()
  const plan = event.plan
  const order = createCheckoutSparkEventMarketFixtureOrder(
    event,
    buyerSigner.pubkey
  )
  const mnemonic = createRuntimeMnemonic()
  const merchantRecovery = createCheckoutSparkSettledRecoveryPayload({
    state: createCheckoutSparkSettledReconciliation(plan),
    senderPubkey: buyerSigner.pubkey,
    mnemonic,
    accountNumber: 1,
    preparedAt: AT + 1_000,
    sourceEvents: event.sourceEvents,
  })
  return { ...event, buyerSigner, order, merchantRecovery, mnemonic }
}

function payload() {
  const f = fixture()
  return { ...f, payload: createCheckoutSparkOrganizerRecoveryPayload(f) }
}

const published = (
  success: boolean
): Awaited<ReturnType<typeof publishWithPlanner>> => ({
  attemptedRelayUrls: relays,
  successfulRelayUrls: success ? relays : [],
  failedRelayUrls: success ? [] : relays,
  relayFailureMessages: {},
})

describe("role-bound Event Market organizer recovery", () => {
  it("binds the original order's exact stock journal hashes and survives a historical restore", () => {
    const f = payload()
    const expected = getOrganizerStockOrderBindings(f.order)
    expect(createCheckoutSparkOrganizerOrderBinding(f.order)).toEqual({
      identityHash: expected.identityHash,
      termsHash: expected.termsHash,
      createdAt: f.order.createdAt,
    })
    expect(f.payload.organizerPubkey).toBe(f.organizerPubkey)
    expect(f.payload.merchantHandoffId).toBe(f.merchantRecovery.handoffId)
    expect(f.payload.handoffId).not.toBe(f.payload.merchantHandoffId)
    expect(f.payload.wallet.mnemonic === f.mnemonic).toBe(true)
    expect(
      checkoutSparkOrganizerRecoveryPayloadDigest(
        restoreCheckoutSparkOrganizerRecoveryPayload(f.payload)
      )
    ).toBe(checkoutSparkOrganizerRecoveryPayloadDigest(f.payload))
    const rumor = buildCheckoutSparkOrganizerRecoveryRumor(f.payload)
    expect(
      rumor.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1])
    ).toEqual([f.organizerPubkey])
    expect(
      checkoutSparkOrganizerRecoveryPayloadDigest(
        parseCheckoutSparkOrganizerRecoveryRumor(rumor)
      )
    ).toBe(checkoutSparkOrganizerRecoveryPayloadDigest(f.payload))
    expect(rumor).not.toHaveProperty("sig")
  })

  it("rejects Merchant-present plans and changed order identity, price, quantity or original time", () => {
    const present = fixture("merchant_present")
    expect(() => createCheckoutSparkOrganizerRecoveryPayload(present)).toThrow()
    const f = fixture()
    for (const order of [
      { ...f.order, id: crypto.randomUUID() },
      { ...f.order, buyerPubkey: f.merchantPubkey },
      { ...f.order, merchantPubkey: f.organizerPubkey },
      { ...f.order, createdAt: AT - 1 },
      { ...f.order, createdAt: AT + 1_001 },
      {
        ...f.order,
        items: [
          {
            ...f.order.items[0]!,
            priceAtPurchase: f.order.items[0]!.priceAtPurchase + 1,
          },
        ],
        subtotal: f.order.subtotal + 1,
      },
      {
        ...f.order,
        items: [{ ...f.order.items[0]!, quantity: 2 }],
        subtotal: f.order.subtotal * 2,
      },
    ]) {
      expect(() =>
        createCheckoutSparkOrganizerRecoveryPayload({
          merchantRecovery: f.merchantRecovery,
          order,
        })
      ).toThrow()
    }
  })

  it("rejects tampered plan, wallet, role and hash fields without trusting handoff labels", () => {
    const f = payload()
    for (const changed of [
      { ...f.payload, merchantHandoffId: f.payload.handoffId },
      { ...f.payload, organizerPubkey: f.merchantPubkey },
      {
        ...f.payload,
        orderBinding: {
          ...f.payload.orderBinding,
          identityHash: f.payload.handoffId,
        },
      },
      {
        ...f.payload,
        orderBinding: {
          ...f.payload.orderBinding,
          termsHash: f.payload.handoffId,
        },
      },
      {
        ...f.payload,
        orderBinding: { ...f.payload.orderBinding, createdAt: AT - 1 },
      },
      {
        ...f.payload,
        wallet: { ...f.payload.wallet, walletId: crypto.randomUUID() },
      },
      {
        ...f.payload,
        plan: { ...f.payload.plan, orderId: crypto.randomUUID() },
      },
      {
        ...f.payload,
        sourceEvents: f.payload.sourceEvents!.filter(
          (event) => event.kind !== 3841
        ),
      },
      { ...f.payload, copiedOrder: f.order },
    ]) {
      expect(() =>
        restoreCheckoutSparkOrganizerRecoveryPayload(changed)
      ).toThrow()
    }
    const rumor = buildCheckoutSparkOrganizerRecoveryRumor(f.payload)
    expect(() =>
      parseCheckoutSparkOrganizerRecoveryRumor({
        ...rumor,
        sig: "not-an-unsigned-rumor",
      })
    ).toThrow()
    expect(() =>
      parseCheckoutSparkOrganizerRecoveryRumor({
        ...rumor,
        tags: [...rumor.tags, ["p", f.merchantPubkey]],
      })
    ).toThrow()
  })

  it("decrypts the authentic NIP44/NIP59 wrap only for the designated organizer", async () => {
    const f = payload()
    const rumor = buildCheckoutSparkOrganizerRecoveryRumor(f.payload)
    const wrap = await wrapPrivateMessage(
      rumor,
      { pubkey: f.organizerPubkey },
      f.buyerSigner
    )
    expect(wrap.kind).toBe(1059)
    expect(wrap.content.includes(f.mnemonic)).toBe(false)
    const opened = await openCheckoutSparkOrganizerRecovery({
      signedRecipientWrap: wrap,
      signer: f.organizerSigner,
      shouldContinue: () => true,
    })
    expect(opened.wrapId).toBe(wrap.id)
    expect(opened.rumorId).toBe(rumor.id)
    expect(checkoutSparkOrganizerRecoveryPayloadDigest(opened.payload)).toBe(
      checkoutSparkOrganizerRecoveryPayloadDigest(f.payload)
    )
    await expect(
      openCheckoutSparkOrganizerRecovery({
        signedRecipientWrap: wrap,
        signer: f.merchantSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    await expect(
      openCheckoutSparkOrganizerRecovery({
        signedRecipientWrap: wrap,
        signer: f.buyerSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    await expect(
      openCheckoutSparkOrganizerRecovery({
        signedRecipientWrap: { ...wrap, content: `${wrap.content}a` },
        signer: f.organizerSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
  })

  it("revokes access when the account changes or authority ends while decryption is in flight", async () => {
    const f = payload()
    const wrap = await wrapPrivateMessage(
      buildCheckoutSparkOrganizerRecoveryRumor(f.payload),
      { pubkey: f.organizerPubkey },
      f.buyerSigner
    )
    let checks = 0
    const replaced = {
      ...f.organizerSigner,
      getPublicKey: async () =>
        ++checks >= 3 ? f.merchantPubkey : f.organizerPubkey,
    }
    await expect(
      openCheckoutSparkOrganizerRecovery({
        signedRecipientWrap: wrap,
        signer: replaced,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    let current = true
    const revoked = {
      ...f.organizerSigner,
      decryptNip44: async (peer: string, ciphertext: string) => {
        const plaintext = await f.organizerSigner.decryptNip44(peer, ciphertext)
        current = false
        return plaintext
      },
    }
    await expect(
      openCheckoutSparkOrganizerRecovery({
        signedRecipientWrap: wrap,
        signer: revoked,
        shouldContinue: () => current,
      })
    ).rejects.toThrow()
  })

  it("persists one exact ciphertext envelope before relay I/O and exposes funding only after an ACK", async () => {
    const f = payload()
    const calls: string[] = []
    const records: CheckoutSparkOrganizerRecoveryDelivery[] = []
    const result = await publishCheckoutSparkOrganizerRecovery({
      payload: f.payload,
      signer: f.buyerSigner,
      persistExactWrap: async (record) => {
        calls.push("persist")
        records.push(record)
      },
      transport: {
        recipientInboxRelays: relays,
        shouldContinue: () => true,
        publishFn: async (event) => {
          calls.push("publish")
          expect(records.length).toBe(1)
          expect(event.id).toBe(records[0]!.signedRecipientWrap.id)
          expect(JSON.stringify(records[0]).includes(f.mnemonic)).toBe(false)
          return published(true)
        },
      },
    })
    expect(calls).toEqual(["persist", "publish", "persist"])
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(result.record.acknowledgedRelayRefs).toHaveLength(1)
    expect(result.record.signedRecipientWrap.id).toBe(
      records[0]!.signedRecipientWrap.id
    )
    expect(
      restoreCheckoutSparkOrganizerRecoveryDelivery(result.record).handoffId
    ).toBe(f.payload.handoffId)
  })

  it("keeps the exact envelope for an ACK-less retry without signing or rewrapping", async () => {
    const f = payload()
    const records: CheckoutSparkOrganizerRecoveryDelivery[] = []
    await expect(
      publishCheckoutSparkOrganizerRecovery({
        payload: f.payload,
        signer: f.buyerSigner,
        persistExactWrap: (record) => {
          records.push(record)
        },
        transport: {
          recipientInboxRelays: relays,
          publishFn: async () => published(false),
        },
      })
    ).rejects.toThrow()
    const record = records.at(-1)!
    expect(record.acknowledgedRelayRefs).toHaveLength(0)
    const sentIds: string[] = []
    const retried = await retryCheckoutSparkOrganizerRecovery({
      record,
      recipientInboxRelays: relays,
      shouldContinue: () => true,
      persistExactWrap: (next) => {
        records.push(next)
      },
      publishFn: async (event) => {
        sentIds.push(event.id)
        return published(true)
      },
    })
    expect(sentIds).toEqual([record.signedRecipientWrap.id])
    expect(retried.record.rumorId).toBe(record.rumorId)
    expect(retried.record.signedRecipientWrap.id).toBe(
      record.signedRecipientWrap.id
    )
    expect(retried.canExposeFundingInvoice).toBe(true)
    let calls = 0
    await retryCheckoutSparkOrganizerRecovery({
      record: retried.record,
      recipientInboxRelays: relays,
      persistExactWrap: () => {},
      publishFn: async () => {
        calls++
        return published(true)
      },
    })
    expect(calls).toBe(0)
  })

  it("does not publish when envelope persistence fails and does not accept a wrong-role wrapper", async () => {
    const f = payload()
    let sends = 0
    await expect(
      publishCheckoutSparkOrganizerRecovery({
        payload: f.payload,
        signer: f.buyerSigner,
        persistExactWrap: () => {
          throw new Error("Controlled persistence failure")
        },
        transport: {
          recipientInboxRelays: relays,
          publishFn: async () => {
            sends++
            return published(true)
          },
        },
      })
    ).rejects.toThrow()
    expect(sends).toBe(0)
    const result = await publishCheckoutSparkOrganizerRecovery({
      payload: f.payload,
      signer: f.buyerSigner,
      persistExactWrap: () => {},
      transport: {
        recipientInboxRelays: relays,
        publishFn: async () => published(true),
      },
    })
    expect(() =>
      restoreCheckoutSparkOrganizerRecoveryDelivery({
        ...result.record,
        organizerPubkey: f.merchantPubkey,
      })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkOrganizerRecoveryDelivery({
        ...result.record,
        acknowledgedRelayRefs: [
          ...result.record.acknowledgedRelayRefs,
          ...result.record.acknowledgedRelayRefs,
        ],
      })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkOrganizerRecoveryDelivery({
        ...result.record,
        plaintext: f.payload,
      })
    ).toThrow()
  })

  it("quarantines valid, malformed and future-version organizer recovery before generic message projection", () => {
    const f = payload()
    const rumor = buildCheckoutSparkOrganizerRecoveryRumor(f.payload)
    for (const candidate of [
      rumor,
      { ...rumor, content: "malformed machine payload" },
      {
        ...rumor,
        tags: [],
        content: JSON.stringify({
          type: "checkout_spark_organizer_recovery",
          wallet: f.payload.wallet,
        }),
      },
      {
        ...rumor,
        kind: 14,
        tags: [["type", "checkout_spark_organizer_recovery_future"]],
        content: f.mnemonic,
      },
    ]) {
      const decoded = decodeCommerceMessageRumor(candidate)
      expect(decoded.category).toBe("machine")
      expect(JSON.stringify(decoded).includes(f.mnemonic)).toBe(false)
      expect(decoded).not.toHaveProperty("parsedOrderMessage")
      expect(decoded).not.toHaveProperty("text")
    }
  })
})
