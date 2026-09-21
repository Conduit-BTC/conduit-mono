import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  freezeCheckoutSparkPlan,
  getNdk,
  inspectCheckoutSparkRecoveryWrap,
  openCheckoutSparkRecoveryDelivery,
  openCheckoutSparkRecoveryWrap,
  parseCheckoutSparkRecoveryDeliveryRecord,
  parseCheckoutSparkRecoveryRumor,
  parseOrderMessageRumorEvent,
  publishCheckoutSparkRecovery,
  retryCheckoutSparkRecoveryDelivery,
  type CheckoutSparkRecoveryDeliveryProgress,
  type CheckoutSparkRecoveryDeliveryRecord,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const SENDER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const SENDER = getPublicKey(SENDER_SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const CREATED_AT = 1_800_000_000_000
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

function signer(pubkey: string): NDKSigner {
  return {
    pubkey,
    user: async () => new NDKUser({ pubkey }),
  } as NDKSigner
}

const senderSigner = signer(SENDER)
const merchantSigner = signer(MERCHANT)

function plan() {
  return freezeCheckoutSparkPlan({
    checkoutId: "checkout-recovery-1",
    orderId: "order-recovery-1",
    merchantPubkey: MERCHANT,
    walletId: "spark-checkout-wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-recovery-1",
      paymentRequest: "lnbc-router-funding",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        paymentRequest: "lnbc-merchant",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "lnbc-conduit",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
  })
}

function payload() {
  return createCheckoutSparkRecoveryPayload({
    plan: plan(),
    senderPubkey: SENDER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
  })
}

function signedWrap(recipientPubkey: string): NDKEvent {
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(CREATED_AT / 1_000),
      tags: [["p", recipientPubkey]],
      content: "opaque-nip59-ciphertext",
    },
    WRAP_SECRET
  ) as SignedPublicNostrEvent
  return new NDKEvent(getNdk(), event)
}

function delivery(relays: readonly string[], successful = relays) {
  const successes = new Set(successful)
  return {
    attemptedRelayUrls: [...relays],
    successfulRelayUrls: [...successful],
    failedRelayUrls: relays.filter((relay) => !successes.has(relay)),
    relayFailureMessages: Object.fromEntries(
      relays
        .filter((relay) => !successes.has(relay))
        .map((relay) => [relay, "No acknowledgement before timeout"])
    ),
  }
}

async function publishFixture(
  options: {
    successfulRelays?: readonly string[]
    onCall?: (call: string) => void
  } = {}
) {
  let persisted: CheckoutSparkRecoveryDeliveryRecord | null = null
  let progress: CheckoutSparkRecoveryDeliveryProgress | null = null
  const relayUrls = [
    "wss://merchant.inbox.relay.dev",
    "wss://merchant.backup.relay.dev",
  ]
  const result = await publishCheckoutSparkRecovery({
    payload: payload(),
    signer: senderSigner,
    persistExactWrap: async (record, initialProgress) => {
      options.onCall?.("persist")
      persisted = record
      progress = initialProgress
    },
    transport: {
      recipientInboxRelays: relayUrls,
      giftWrapFn: (async (_rumor, recipient) =>
        signedWrap(recipient.pubkey)) as never,
      publishFn: (async (_event, publishOptions) => {
        options.onCall?.("publish")
        const targets = publishOptions.exclusiveRelayUrls ?? []
        return delivery(targets, options.successfulRelays ?? [targets[0]!])
      }) as never,
    },
  })
  return {
    persisted: persisted!,
    initialProgress: progress!,
    result,
    relayUrls,
  }
}

describe("checkout Spark merchant recovery", () => {
  it("binds the full recovery material to one immutable plan in a machine-only rumor", () => {
    const expected = payload()
    const rumor = buildCheckoutSparkRecoveryRumor(expected)

    expect(parseCheckoutSparkRecoveryRumor(rumor)).toEqual(expected)
    expect(rumor.pubkey).toBe(SENDER)
    expect(rumor.tags).toContainEqual(["p", MERCHANT])
    expect(rumor.tags).toContainEqual(["type", "checkout_spark_recovery"])
    expect(rumor.content).toContain(MNEMONIC)
    expect(() => parseOrderMessageRumorEvent(rumor)).toThrow()

    const tampered = new NDKEvent(getNdk(), rumor.rawEvent())
    const decoded = JSON.parse(tampered.content)
    decoded.plan.planDigest = "0".repeat(64)
    tampered.content = JSON.stringify(decoded)
    tampered.id = tampered.getEventHash()
    expect(() => parseCheckoutSparkRecoveryRumor(tampered)).toThrow(
      "recovery rumor"
    )
  })

  it("persists the exact signed wrapper before relay I/O and gates invoice exposure on an ACK", async () => {
    const calls: string[] = []
    const { persisted, result } = await publishFixture({
      onCall: (call) => calls.push(call),
    })

    expect(calls[0]).toBe("persist")
    expect(calls[1]).toBe("publish")
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(Object.keys(result)).not.toContain("orderRelayDelivery")
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
    expect(persisted.signedRecipientWrap.kind).toBe(1059)
    expect(persisted.merchantPubkey).toBe(MERCHANT)
    expect(persisted.planDigest).toBe(plan().planDigest)
    expect(Object.keys(persisted)).not.toContain("payload")
    expect(JSON.stringify(persisted)).not.toContain(MNEMONIC)
    expect(JSON.stringify(persisted)).not.toContain("lnbc-router-funding")
    expect(JSON.stringify(result.deliveryProgress)).not.toContain("wss://")
  })

  it("whitelists the strict transport boundary and never creates a sender copy", async () => {
    const recipients: string[] = []
    await publishCheckoutSparkRecovery({
      payload: payload(),
      signer: senderSigner,
      persistExactWrap: async () => {},
      transport: {
        recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) => {
          recipients.push(recipient.pubkey)
          return signedWrap(recipient.pubkey)
        }) as never,
        publishFn: (async (_event, options) =>
          delivery(options.exclusiveRelayUrls ?? [])) as never,
        // Runtime callers cannot smuggle ordinary-order compatibility or a
        // sender-copy request through this machine-only boundary.
        selfCopy: true,
        compatibilityOrderRoute: {
          enabled: true,
          relayUrls: ["wss://compatibility.relay.dev"],
        },
      } as never,
    })

    expect(recipients).toEqual([MERCHANT])
  })

  it("keeps the persisted exact wrapper retryable and blocks funding when no relay ACKs", async () => {
    let persisted: CheckoutSparkRecoveryDeliveryRecord | null = null
    let initialProgress: CheckoutSparkRecoveryDeliveryProgress | null = null
    const relayUrls = ["wss://merchant.inbox.relay.dev"]

    await expect(
      publishCheckoutSparkRecovery({
        payload: payload(),
        signer: senderSigner,
        persistExactWrap: (record, progress) => {
          persisted = record
          initialProgress = progress
        },
        transport: {
          recipientInboxRelays: relayUrls,
          giftWrapFn: (async (_rumor, recipient) =>
            signedWrap(recipient.pubkey)) as never,
          publishFn: (async () => delivery(relayUrls, [])) as never,
        },
      })
    ).rejects.toThrow("relay ACK")

    expect(persisted).not.toBeNull()
    expect(initialProgress?.acknowledgedRelayRefs).toEqual([])

    let retriedWrapId = ""
    const retried = await retryCheckoutSparkRecoveryDelivery({
      record: persisted!,
      deliveryProgress: initialProgress!,
      recipientInboxRelays: relayUrls,
      publishFn: (async (event, options) => {
        retriedWrapId = event.id
        return delivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })

    expect(retriedWrapId).toBe(persisted!.signedRecipientWrap.id)
    expect(retried.canExposeFundingInvoice).toBe(true)
    expect(retried.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
  })

  it("unwraps only for the exact merchant and validates the recovered plan", async () => {
    const { persisted } = await publishFixture()
    const rumor = buildCheckoutSparkRecoveryRumor(payload())

    await expect(
      openCheckoutSparkRecoveryDelivery({
        record: persisted,
        signer: senderSigner,
        giftUnwrap: async () => rumor,
      })
    ).rejects.toThrow("merchant")

    await expect(
      openCheckoutSparkRecoveryDelivery({
        record: persisted,
        signer: merchantSigner,
        giftUnwrap: async () => rumor,
      })
    ).resolves.toEqual(payload())
  })

  it("lets the merchant discover the recovery wrap without a sender-local descriptor", async () => {
    const recoveryRumor = buildCheckoutSparkRecoveryRumor(payload())
    const wrap = signedWrap(MERCHANT).rawEvent() as SignedPublicNostrEvent

    await expect(
      openCheckoutSparkRecoveryWrap({
        signedRecipientWrap: wrap,
        signer: merchantSigner,
        giftUnwrap: async () => recoveryRumor,
      })
    ).resolves.toMatchObject({
      wrapId: wrap.id,
      rumorId: recoveryRumor.id,
      payload: payload(),
    })

    const unrelated = new NDKEvent(getNdk())
    unrelated.kind = 14
    unrelated.pubkey = SENDER
    unrelated.created_at = Math.floor(CREATED_AT / 1_000)
    unrelated.tags = [["p", MERCHANT]]
    unrelated.content = "ordinary private message"
    unrelated.id = unrelated.getEventHash()
    await expect(
      inspectCheckoutSparkRecoveryWrap({
        signedRecipientWrap: wrap,
        signer: merchantSigner,
        giftUnwrap: async () => unrelated,
      })
    ).resolves.toEqual({ status: "ignored", wrapId: wrap.id })
  })

  it("rejects descriptors that try to persist recovery plaintext", async () => {
    const { persisted } = await publishFixture()
    expect(() =>
      parseCheckoutSparkRecoveryDeliveryRecord({
        ...persisted,
        mnemonic: MNEMONIC,
      })
    ).toThrow("record is invalid")
  })
})
