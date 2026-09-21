import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  freezeCheckoutSparkPlan,
  getNdk,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import {
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
  saveCheckoutSparkRecoveryDelivery,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import type { GuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"

const BUYER_SIGNER = NDKPrivateKeySigner.generate()
const MERCHANT = getPublicKey(generateSecretKey())
const WRAP_SECRET = generateSecretKey()
const CREATED_AT = 1_800_000_000_000
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function plan() {
  return freezeCheckoutSparkPlan({
    checkoutId: "checkout-recovery-handoff-1",
    orderId: "order-recovery-handoff-1",
    merchantPubkey: MERCHANT,
    walletId: "spark-checkout-wallet-handoff-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-recovery-handoff-1",
      paymentRequest: "lnbc-router-funding-secret",
      paymentHash: "c".repeat(64),
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

function identity(): GuestOrderSigningIdentity {
  return {
    kind: "guest_ephemeral",
    orderId: plan().orderId,
    merchantPubkey: MERCHANT,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 120_000,
    pubkey: BUYER_SIGNER.pubkey,
    signer: BUYER_SIGNER,
  }
}

function signedWrap(
  recipientPubkey: string,
  content = "opaque-nip59-ciphertext"
): NDKEvent {
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(CREATED_AT / 1_000),
      tags: [["p", recipientPubkey]],
      content,
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

describe("checkout Spark recovery outbox", () => {
  it("durably saves ciphertext before publish and never stores wallet plaintext", async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []
    const relayUrls = ["wss://merchant.inbox.relay.dev"]
    const result = await publishCheckoutSparkRecoveryHandoff({
      plan: plan(),
      recovery: {
        mnemonic: MNEMONIC,
        accountNumber: 0,
        network: "mainnet",
      },
      identity: identity(),
      preparedAt: CREATED_AT + 1_000,
      storage,
      now: () => CREATED_AT + 2_000,
      transport: {
        recipientInboxRelays: relayUrls,
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          calls.push(
            listCheckoutSparkRecoveryDeliveries(storage).length === 1
              ? "persisted-before-publish"
              : "missing-before-publish"
          )
          return delivery(options.exclusiveRelayUrls ?? [])
        }) as never,
      },
    })

    expect(result.canExposeFundingInvoice).toBe(true)
    expect(calls).toEqual(["persisted-before-publish"])
    const raw = Array.from(storage.values.values()).join("")
    expect(raw).not.toContain(MNEMONIC)
    expect(raw).not.toContain("lnbc-router-funding-secret")
    expect(raw).toContain("opaque-nip59-ciphertext")
    expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(1)
  })

  it("resumes a zero-ACK attempt with the exact persisted wrapper", async () => {
    const storage = new MemoryStorage()
    const relayUrls = ["wss://merchant.inbox.relay.dev"]
    await expect(
      publishCheckoutSparkRecoveryHandoff({
        plan: plan(),
        recovery: {
          mnemonic: MNEMONIC,
          accountNumber: 0,
          network: "mainnet",
        },
        identity: identity(),
        preparedAt: CREATED_AT + 1_000,
        storage,
        now: () => CREATED_AT + 2_000,
        transport: {
          recipientInboxRelays: relayUrls,
          giftWrapFn: (async (_rumor, recipient) =>
            signedWrap(recipient.pubkey)) as never,
          publishFn: (async () => delivery(relayUrls, [])) as never,
        },
      })
    ).rejects.toThrow("relay ACK")

    const stored = listCheckoutSparkRecoveryDeliveries(storage)[0]!
    let retriedWrapId = ""
    const retried = await retryStoredCheckoutSparkRecoveryHandoff({
      handoffId: stored.record.handoffId,
      storage,
      recipientInboxRelays: relayUrls,
      now: () => CREATED_AT + 3_000,
      publishFn: (async (event, options) => {
        retriedWrapId = event.id
        return delivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })

    expect(retriedWrapId).toBe(stored.record.signedRecipientWrap.id)
    expect(retried.canExposeFundingInvoice).toBe(true)
    expect(
      getCheckoutSparkRecoveryDelivery(stored.record.handoffId, storage)
        ?.deliveryProgress.acknowledgedRelayRefs
    ).toHaveLength(1)

    saveCheckoutSparkRecoveryDelivery(
      stored.record,
      stored.deliveryProgress,
      storage,
      CREATED_AT + 4_000
    )
    expect(
      getCheckoutSparkRecoveryDelivery(stored.record.handoffId, storage)
        ?.deliveryProgress.acknowledgedRelayRefs
    ).toHaveLength(1)
  })

  it("rejects replacing one handoff with a newly wrapped ciphertext", async () => {
    const storage = new MemoryStorage()
    const relayUrls = ["wss://merchant.inbox.relay.dev"]
    await publishCheckoutSparkRecoveryHandoff({
      plan: plan(),
      recovery: {
        mnemonic: MNEMONIC,
        accountNumber: 0,
        network: "mainnet",
      },
      identity: identity(),
      preparedAt: CREATED_AT + 1_000,
      storage,
      now: () => CREATED_AT + 2_000,
      transport: {
        recipientInboxRelays: relayUrls,
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) =>
          delivery(options.exclusiveRelayUrls ?? [])) as never,
      },
    })
    const stored = listCheckoutSparkRecoveryDeliveries(storage)[0]!
    const replacement = signedWrap(MERCHANT, "different-ciphertext").rawEvent()

    expect(() =>
      saveCheckoutSparkRecoveryDelivery(
        { ...stored.record, signedRecipientWrap: replacement },
        {
          ...stored.deliveryProgress,
          recipientWrapId: replacement.id,
          acknowledgedRelayRefs: [],
        },
        storage,
        CREATED_AT + 3_000
      )
    ).toThrow("different exact delivery wrapper")
  })

  it("fails closed when the Spark recovery or guest identity is out of scope", async () => {
    const storage = new MemoryStorage()
    await expect(
      publishCheckoutSparkRecoveryHandoff({
        plan: plan(),
        recovery: {
          mnemonic: MNEMONIC,
          accountNumber: 0,
          network: "regtest",
        },
        identity: identity(),
        preparedAt: CREATED_AT + 1_000,
        storage,
      })
    ).rejects.toThrow("outside its guest order scope")
    expect(storage.values.size).toBe(0)
  })
})
