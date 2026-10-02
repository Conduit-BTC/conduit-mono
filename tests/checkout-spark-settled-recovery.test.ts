import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  freezeCheckoutSparkSettledPlan,
  getNdk,
  openCheckoutSparkRecoveryDelivery,
  parseCheckoutSparkRecoveryRumor,
  publishCheckoutSparkRecovery,
  recordCheckoutSparkSettledCredit,
  type NostrKeySigner,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const senderSecret = generateSecretKey()
const merchantSecret = generateSecretKey()
const wrapSecret = generateSecretKey()
const senderPubkey = getPublicKey(senderSecret)
const merchantPubkey = getPublicKey(merchantSecret)
const createdAt = 1_800_000_000_000
const mnemonic = createRuntimeMnemonic()

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function signer(pubkey: string): NostrKeySigner {
  const unexpectedKeyOperation = async (): Promise<never> => {
    throw new Error("Unexpected key operation in injected-envelope fixture.")
  }
  return {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: unexpectedKeyOperation,
    encryptNip44: unexpectedKeyOperation,
    decryptNip44: unexpectedKeyOperation,
    decryptLegacy: unexpectedKeyOperation,
  }
}

function settledState() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-settled-recovery",
    orderId: "order-settled-recovery",
    merchantPubkey,
    walletId: "wallet-settled-recovery",
    network: "mainnet",
    createdAt,
    takeoverAt: createdAt + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${merchantPubkey}:recovery-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-settled-recovery",
      paymentRequest: invoice(122, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 122,
      createdAt,
      expiresAt: createdAt + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchantPubkey,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: createdAt / 1_000,
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
          source: {
            type: "conduit_allowlist",
            policy: "local_router_canary",
          },
        },
        weightSats: 111,
      },
    ],
  })
  return createCheckoutSparkSettledReconciliation(plan)
}

function payload() {
  return createCheckoutSparkSettledRecoveryPayload({
    state: settledState(),
    senderPubkey,
    mnemonic,
    accountNumber: 1,
    preparedAt: createdAt + 1_000,
  })
}

function signedWrap(recipientPubkey: string): NDKEvent {
  const event = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(createdAt / 1_000),
      tags: [["p", recipientPubkey]],
      content: "opaque-nip59-ciphertext",
    },
    wrapSecret
  ) as SignedPublicNostrEvent
  return new NDKEvent(getNdk(), event)
}

describe("settled Spark merchant recovery handoff", () => {
  it("round-trips an initial v3 plan and state without a generic order projection", () => {
    const expected = payload()
    const rumor = buildCheckoutSparkRecoveryRumor(expected)
    expect(parseCheckoutSparkRecoveryRumor(rumor)).toEqual(expected)
    expect(expected.schemaVersion).toBe(2)
    expect(expected.state.credit).toBeNull()
    expect(expected.state.legs.every((leg) => leg.intent === null)).toBe(true)

    const tampered = new NDKEvent(getNdk(), rumor.rawEvent())
    const changed = JSON.parse(tampered.content)
    changed.state.plan.recipients[0].weightSats = 11
    tampered.content = JSON.stringify(changed)
    tampered.id = tampered.getEventHash()
    expect(() => parseCheckoutSparkRecoveryRumor(tampered)).toThrow()
  })

  it("binds a later encrypted state-only update to its initial handoff without wallet material", () => {
    const initial = payload()
    const credited = recordCheckoutSparkSettledCredit(initial.state, {
      requestId: initial.plan.funding.requestId,
      paymentHash: initial.plan.funding.paymentHash,
      receiverIdentityPublicKey: initial.plan.funding.receiverIdentityPublicKey,
      transferId: "exact-funded-transfer",
      grossSats: 122,
      creditedSats: 120,
      observedAt: createdAt + 2_000,
    })
    const progress = createCheckoutSparkSettledRecoveryProgressPayload({
      initialHandoffId: initial.handoffId,
      state: credited,
      senderPubkey,
      preparedAt: createdAt + 3_000,
    })
    const rumor = buildCheckoutSparkRecoveryRumor(progress)
    expect(parseCheckoutSparkRecoveryRumor(rumor)).toEqual(progress)
    expect(JSON.stringify(progress)).not.toContain(mnemonic)
    expect(JSON.stringify(progress)).not.toContain("accountNumber")
    const changed = new NDKEvent(getNdk(), rumor.rawEvent())
    const forged = JSON.parse(changed.content)
    forged.initialHandoffId = "a".repeat(64)
    changed.content = JSON.stringify(forged)
    changed.id = changed.getEventHash()
    expect(() => parseCheckoutSparkRecoveryRumor(changed)).toThrow()
  })

  it("persists a ciphertext-only wrap before relay publish and opens only for the merchant", async () => {
    const calls: string[] = []
    const expected = payload()
    let record:
      Parameters<typeof openCheckoutSparkRecoveryDelivery>[0]["record"] | null =
      null
    const relayUrls = ["wss://merchant.inbox.relay.dev"]
    const result = await publishCheckoutSparkRecovery({
      payload: expected,
      signer: signer(senderPubkey),
      persistExactWrap: (prepared) => {
        calls.push("persist")
        record = prepared
      },
      transport: {
        recipientInboxRelays: relayUrls,
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async () => {
          calls.push("publish")
          return {
            attemptedRelayUrls: relayUrls,
            successfulRelayUrls: relayUrls,
            failedRelayUrls: [],
            relayFailureMessages: {},
          }
        }) as never,
      },
    })
    expect(calls).toEqual(["persist", "publish"])
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(JSON.stringify(record)).not.toContain(mnemonic)
    expect(JSON.stringify(record)).not.toContain("merchant@example.test")

    await expect(
      openCheckoutSparkRecoveryDelivery({
        record: record!,
        signer: signer(senderPubkey),
        giftUnwrap: async () => buildCheckoutSparkRecoveryRumor(expected),
      })
    ).rejects.toThrow("merchant")
    await expect(
      openCheckoutSparkRecoveryDelivery({
        record: record!,
        signer: signer(merchantPubkey),
        giftUnwrap: async () => buildCheckoutSparkRecoveryRumor(expected),
      })
    ).resolves.toEqual(expected)
  })
})
