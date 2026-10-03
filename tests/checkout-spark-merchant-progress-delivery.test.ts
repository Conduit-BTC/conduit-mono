import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  createCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressPayload,
} from "../packages/core/src/protocol/checkout-spark-merchant-progress"
import {
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  publishMerchantCheckoutSparkProgress,
  retryMerchantCheckoutSparkProgress,
  type MerchantCheckoutSparkProgressDelivery,
  type MerchantCheckoutSparkProgressDeliveryRecord,
  type MerchantCheckoutSparkProgressDeliveryStore,
} from "../packages/core/src/protocol/checkout-spark-merchant-progress-delivery"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { getNdk } from "../packages/core/src/protocol/ndk"
import {
  makeSignedBolt11Fixture,
  bolt11PaymentSecretField,
} from "./support/signed-bolt11-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const MERCHANT_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const INBOX = "wss://merchant.inbox.relay.dev"
const OTHER_INBOX = "wss://merchant.backup.relay.dev"
const ROGUE = "wss://unplanned.relay.dev"
const networkState = { get: async () => undefined }

function signer(pubkey = MERCHANT): NostrKeySigner {
  return {
    pubkey,
    getPublicKey: async () => pubkey,
  } as NostrKeySigner
}

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function payload(): CheckoutSparkMerchantProgressPayload {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-progress-delivery-checkout",
    orderId: "merchant-progress-delivery-order",
    merchantPubkey: MERCHANT,
    walletId: "merchant-progress-delivery-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:progress-delivery`,
          productEventId: "a".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-progress-delivery-receive",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "b".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
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
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  const credit = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "synthetic-receive-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 2_000,
    }
  )
  const leg = credit.legs[0]!
  const prepared = prepareCheckoutSparkSettledLeg(credit, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
    paymentRequest: invoice(995, 8),
    paymentHash: "08".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: TAKEOVER_AT,
  })
  return createCheckoutSparkMerchantProgress({
    initialHandoffId: "c".repeat(64),
    state: prepared,
  })
}

function signedWrap(
  recipient: string,
  content = "synthetic-opaque-nip59-wrap"
): NDKEvent {
  return new NDKEvent(
    getNdk(),
    finalizeEvent(
      {
        kind: 1_059,
        created_at: CREATED_AT / 1_000,
        tags: [["p", recipient]],
        content,
      },
      WRAP_SECRET
    )
  )
}

function delivery(
  attempted: readonly string[],
  successful: readonly string[] = attempted
) {
  return {
    attemptedRelayUrls: [...attempted],
    successfulRelayUrls: [...successful],
    failedRelayUrls: attempted.filter((url) => !successful.includes(url)),
    relayFailureMessages: {},
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resume) => {
    resolve = resume
  })
  return { promise, resolve }
}

function memoryStore(
  calls: string[] = []
): MerchantCheckoutSparkProgressDeliveryStore & {
  entries: Map<string, MerchantCheckoutSparkProgressDelivery>
} {
  const entries = new Map<string, MerchantCheckoutSparkProgressDelivery>()
  return {
    entries,
    async load(_principal, _checkoutId, _planDigest, snapshotId) {
      calls.push("load")
      return entries.get(snapshotId) ?? null
    },
    async stage(record, assertCurrent) {
      calls.push("stage")
      assertCurrent()
      const parsed = parseMerchantCheckoutSparkProgressDeliveryRecord(record)
      const previous = entries.get(parsed.snapshotId)
      if (
        previous &&
        JSON.stringify(previous.record) !== JSON.stringify(parsed)
      ) {
        throw new Error("Conflicting exact wrap")
      }
      const saved = previous ?? { record: parsed, relayAccepted: false }
      entries.set(parsed.snapshotId, saved)
      return saved
    },
    async markAccepted(
      _principal,
      _checkoutId,
      _planDigest,
      snapshotId,
      assertCurrent
    ) {
      calls.push("markAccepted")
      assertCurrent()
      const previous = entries.get(snapshotId)
      if (!previous) throw new Error("Missing staged wrap")
      const saved = { ...previous, relayAccepted: true }
      entries.set(snapshotId, saved)
      return saved
    },
  }
}

describe("Merchant Spark progress exact ciphertext delivery", () => {
  it("stages the one signed self-addressed wrap before the first relay write", async () => {
    const calls: string[] = []
    const store = memoryStore(calls)
    const expected = payload()
    const result = await publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport: {
        accountNetworkLocalStateRepository: networkState,
        recipientInboxRelays: [INBOX],
        giftWrapFn: (async (_rumor, recipient) => {
          calls.push("wrap")
          expect(recipient.pubkey).toBe(MERCHANT)
          return signedWrap(recipient.pubkey)
        }) as never,
        publishFn: (async (event, options) => {
          calls.push("publish")
          expect(
            store.entries.get(expected.snapshotId)?.record.signedRecipientWrap
              .id
          ).toBe(event.id)
          expect(options.exclusiveRelayUrls).toEqual([INBOX])
          expect(options.appRelayUrls).toEqual([])
          return delivery([INBOX])
        }) as never,
      },
    })
    expect(calls.indexOf("stage")).toBeLessThan(calls.indexOf("publish"))
    expect(calls.indexOf("markAccepted")).toBeGreaterThan(
      calls.indexOf("publish")
    )
    expect(calls.filter((call) => call === "wrap")).toHaveLength(1)
    expect(result.relayAccepted).toBe(true)
    expect(result.record.signedRecipientWrap.tags).toEqual([["p", MERCHANT]])
    expect(Object.keys(result.record)).not.toContain("payload")
    expect(JSON.stringify(result.record)).not.toContain("merchant@example.test")
    expect(JSON.stringify(result.record)).not.toContain("lnbc")
  })

  it("retries only the same staged ciphertext without wrapping or signing again", async () => {
    const store = memoryStore()
    const expected = payload()
    let wraps = 0
    let writes = 0
    let firstWrapId = ""
    const transport = {
      accountNetworkLocalStateRepository: networkState,
      recipientInboxRelays: [INBOX],
      giftWrapFn: (async (_rumor: NDKEvent, recipient: NDKUser) => {
        wraps += 1
        return signedWrap(recipient.pubkey)
      }) as never,
      publishFn: (async (event: NDKEvent) => {
        writes += 1
        if (writes === 1) {
          firstWrapId = event.id
          return delivery([INBOX], [])
        }
        expect(event.id).toBe(firstWrapId)
        return delivery([INBOX])
      }) as never,
    }
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: expected,
        signer: signer(),
        store,
        shouldContinue: () => true,
        transport,
      })
    ).rejects.toThrow("relay ACK")
    expect(store.entries.get(expected.snapshotId)?.relayAccepted).toBe(false)
    expect(
      store.entries.get(expected.snapshotId)?.record.signedRecipientWrap.id
    ).toBe(firstWrapId)
    const retry = await publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport,
    })
    expect(retry.relayAccepted).toBe(true)
    expect(retry.record.signedRecipientWrap.id).toBe(firstWrapId)
    expect(wraps).toBe(1)
    expect(writes).toBe(2)
  })

  it("retries an older staged wrap after local state advances without rebuilding its payload", async () => {
    const store = memoryStore()
    const first = payload()
    const later = createCheckoutSparkMerchantProgress({
      initialHandoffId: first.initialHandoffId,
      state: { ...first.state, updatedAt: first.state.updatedAt + 1 },
    })
    expect(later.snapshotId).not.toBe(first.snapshotId)
    let wraps = 0
    let writes = 0
    const transport = {
      accountNetworkLocalStateRepository: networkState,
      recipientInboxRelays: [INBOX],
      giftWrapFn: (async (_rumor: NDKEvent, recipient: NDKUser) => {
        wraps += 1
        return signedWrap(recipient.pubkey)
      }) as never,
      publishFn: (async (event: NDKEvent) => {
        writes += 1
        expect(event.id).toBe(
          store.entries.get(first.snapshotId)?.record.signedRecipientWrap.id
        )
        return writes === 1 ? delivery([INBOX], []) : delivery([INBOX])
      }) as never,
    }
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: first,
        signer: signer(),
        store,
        shouldContinue: () => true,
        transport,
      })
    ).rejects.toThrow("relay ACK")
    const staged = store.entries.get(first.snapshotId)!.record

    const retried = await retryMerchantCheckoutSparkProgress({
      record: staged,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport,
    })
    expect(retried.relayAccepted).toBe(true)
    expect(retried.record).toEqual(staged)
    expect(store.entries.has(later.snapshotId)).toBe(false)
    expect(wraps).toBe(1)
    expect(writes).toBe(2)
  })

  it("requires the exact persisted slot before a record-keyed retry", async () => {
    const store = memoryStore()
    const expected = payload()
    const wrap = signedWrap(MERCHANT).rawEvent()
    const record = parseMerchantCheckoutSparkProgressDeliveryRecord({
      schemaVersion: 1,
      merchantPubkey: MERCHANT,
      checkoutId: expected.state.plan.checkoutId,
      planDigest: expected.state.plan.planDigest,
      snapshotId: expected.snapshotId,
      initialHandoffId: expected.initialHandoffId,
      rumorId: "f".repeat(64),
      signedRecipientWrap: wrap,
      recordedAt: expected.recordedAt,
    })
    let writes = 0
    const input = {
      record,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport: {
        accountNetworkLocalStateRepository: networkState,
        recipientInboxRelays: [INBOX],
        giftWrapFn: (async () => {
          throw new Error("must not wrap")
        }) as never,
        publishFn: (async () => {
          writes += 1
          return delivery([INBOX])
        }) as never,
      },
    }
    await expect(retryMerchantCheckoutSparkProgress(input)).rejects.toThrow(
      "wrap is missing"
    )
    store.entries.set(record.snapshotId, {
      record: {
        ...record,
        signedRecipientWrap: signedWrap(
          MERCHANT,
          "different-valid-opaque-wrap"
        ).rawEvent(),
      },
      relayAccepted: false,
    })
    await expect(retryMerchantCheckoutSparkProgress(input)).rejects.toThrow(
      "persisted wrap changed"
    )
    expect(writes).toBe(0)
  })

  it("cancels a record-keyed retry after the relay-resolution await", async () => {
    const store = memoryStore()
    const expected = payload()
    const record = parseMerchantCheckoutSparkProgressDeliveryRecord({
      schemaVersion: 1,
      merchantPubkey: MERCHANT,
      checkoutId: expected.state.plan.checkoutId,
      planDigest: expected.state.plan.planDigest,
      snapshotId: expected.snapshotId,
      initialHandoffId: expected.initialHandoffId,
      rumorId: "f".repeat(64),
      signedRecipientWrap: signedWrap(MERCHANT).rawEvent(),
      recordedAt: expected.recordedAt,
    })
    store.entries.set(record.snapshotId, { record, relayAccepted: false })
    const relayGate = deferred<string[]>()
    const relayStarted = deferred<void>()
    let current = true
    let writes = 0
    const retrying = retryMerchantCheckoutSparkProgress({
      record,
      signer: signer(),
      store,
      shouldContinue: () => current,
      transport: {
        accountNetworkLocalStateRepository: networkState,
        resolveInboxRelays: async () => {
          relayStarted.resolve()
          return relayGate.promise
        },
        publishFn: (async () => {
          writes += 1
          return delivery([INBOX])
        }) as never,
      },
    })
    await relayStarted.promise
    current = false
    relayGate.resolve([INBOX])
    await expect(retrying).rejects.toThrow("session changed")
    expect(writes).toBe(0)
    expect(store.entries.get(record.snapshotId)?.relayAccepted).toBe(false)
  })

  it("does not publish when stage fails or the snapshot is malformed", async () => {
    const expected = payload()
    const store = memoryStore()
    let wraps = 0
    let writes = 0
    const transport = {
      accountNetworkLocalStateRepository: networkState,
      recipientInboxRelays: [INBOX],
      giftWrapFn: (async (_rumor: NDKEvent, recipient: NDKUser) => {
        wraps += 1
        return signedWrap(recipient.pubkey)
      }) as never,
      publishFn: (async () => {
        writes += 1
        return delivery([INBOX])
      }) as never,
    }
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: { ...expected, snapshotId: "0".repeat(64) },
        signer: signer(),
        store,
        shouldContinue: () => true,
        transport,
      })
    ).rejects.toThrow("progress is invalid")
    expect(wraps).toBe(0)
    expect(writes).toBe(0)
    const failedStore: MerchantCheckoutSparkProgressDeliveryStore = {
      ...store,
      stage: async () => {
        throw new Error("disk write failed")
      },
    }
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: expected,
        signer: signer(),
        store: failedStore,
        shouldContinue: () => true,
        transport,
      })
    ).rejects.toThrow("disk write failed")
    expect(wraps).toBe(1)
    expect(writes).toBe(0)
    expect(store.entries.size).toBe(0)
  })

  it("rejects a store that swaps or mutates the exact signed wrap during staging", async () => {
    const expected = payload()
    for (const mutate of [false, true]) {
      const store = memoryStore()
      let writes = 0
      const corruptStore: MerchantCheckoutSparkProgressDeliveryStore = {
        ...store,
        stage: async (record) => {
          const changedWrap = signedWrap(
            MERCHANT,
            "different-valid-ciphertext"
          ).rawEvent()
          if (mutate) {
            record.signedRecipientWrap = changedWrap
            return { record, relayAccepted: false }
          }
          return {
            record: { ...record, signedRecipientWrap: changedWrap },
            relayAccepted: false,
          }
        },
      }
      await expect(
        publishMerchantCheckoutSparkProgress({
          payload: expected,
          signer: signer(),
          store: corruptStore,
          shouldContinue: () => true,
          transport: {
            accountNetworkLocalStateRepository: networkState,
            recipientInboxRelays: [INBOX],
            giftWrapFn: (async (_rumor, recipient) =>
              signedWrap(recipient.pubkey)) as never,
            publishFn: (async () => {
              writes += 1
              return delivery([INBOX])
            }) as never,
          },
        })
      ).rejects.toThrow()
      expect(writes).toBe(0)
    }
  })

  it("cancels if account authority changes across signer, store or relay awaits", async () => {
    const expected = payload()
    const signerGate = deferred<string>()
    const signerStarted = deferred<void>()
    let current = true
    const store = memoryStore()
    let wraps = 0
    let writes = 0
    const transport = {
      accountNetworkLocalStateRepository: networkState,
      recipientInboxRelays: [INBOX],
      giftWrapFn: (async (_rumor: NDKEvent, recipient: NDKUser) => {
        wraps += 1
        return signedWrap(recipient.pubkey)
      }) as never,
      publishFn: (async () => {
        writes += 1
        return delivery([INBOX])
      }) as never,
    }
    const pending = publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: {
        getPublicKey: async () => {
          signerStarted.resolve()
          return signerGate.promise
        },
      } as NostrKeySigner,
      store,
      shouldContinue: () => current,
      transport,
    })
    await signerStarted.promise
    current = false
    signerGate.resolve(MERCHANT)
    await expect(pending).rejects.toThrow("session changed")
    expect(wraps).toBe(0)
    expect(writes).toBe(0)

    current = true
    const loadGate = deferred<MerchantCheckoutSparkProgressDelivery | null>()
    const loadStarted = deferred<void>()
    const heldStore = {
      ...store,
      load: async () => {
        loadStarted.resolve()
        return loadGate.promise
      },
    }
    const heldLoad = publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store: heldStore,
      shouldContinue: () => current,
      transport,
    })
    await loadStarted.promise
    current = false
    loadGate.resolve(null)
    await expect(heldLoad).rejects.toThrow("session changed")
    expect(wraps).toBe(0)
    expect(writes).toBe(0)

    current = true
    const relayGate = deferred<string[]>()
    const relayStarted = deferred<void>()
    const heldRelay = publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store,
      shouldContinue: () => current,
      transport: {
        ...transport,
        recipientInboxRelays: undefined,
        resolveInboxRelays: async () => {
          relayStarted.resolve()
          return relayGate.promise
        },
      },
    })
    await relayStarted.promise
    current = false
    relayGate.resolve([INBOX])
    await expect(heldRelay).rejects.toThrow()
    expect(wraps).toBe(0)
    expect(store.entries.size).toBe(0)
    expect(writes).toBe(0)
  })

  it("does not accept an ACK for an unattempted or unauthorized relay", async () => {
    const expected = payload()
    const store = memoryStore()
    let writes = 0
    await publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport: {
        accountNetworkLocalStateRepository: networkState,
        recipientInboxRelays: [INBOX, OTHER_INBOX],
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async () => {
          writes += 1
          return delivery([INBOX], [])
        }) as never,
      },
    }).catch(() => {})
    expect(store.entries.get(expected.snapshotId)?.relayAccepted).toBe(false)
    const result = await publishMerchantCheckoutSparkProgress({
      payload: expected,
      signer: signer(),
      store,
      shouldContinue: () => true,
      transport: {
        accountNetworkLocalStateRepository: networkState,
        recipientInboxRelays: [INBOX, OTHER_INBOX],
        publishFn: (async () => {
          writes += 1
          return delivery([ROGUE], [ROGUE])
        }) as never,
      },
    })
    expect(writes).toBe(2)
    expect(result.relayAccepted).toBe(false)
    expect(store.entries.get(expected.snapshotId)?.relayAccepted).toBe(false)
  })

  it("rejects an invalid staged record before retrying or marking it accepted", async () => {
    const expected = payload()
    const store = memoryStore()
    const wrap = signedWrap(MERCHANT).rawEvent()
    const bad = {
      schemaVersion: 1 as const,
      merchantPubkey: MERCHANT,
      checkoutId: expected.state.plan.checkoutId,
      planDigest: expected.state.plan.planDigest,
      snapshotId: expected.snapshotId,
      initialHandoffId: expected.initialHandoffId,
      rumorId: "f".repeat(64),
      signedRecipientWrap: { ...wrap, tags: [["p", "0".repeat(64)]] },
      recordedAt: expected.recordedAt,
    } satisfies MerchantCheckoutSparkProgressDeliveryRecord
    let writes = 0
    for (const invalid of [
      bad,
      { ...bad, signedRecipientWrap: wrap },
      { ...bad, rumorId: "not-a-rumor", signedRecipientWrap: wrap },
    ]) {
      store.entries.set(expected.snapshotId, {
        record: invalid,
        relayAccepted: false,
      })
      await expect(
        publishMerchantCheckoutSparkProgress({
          payload: expected,
          signer: signer(),
          store,
          shouldContinue: () => true,
          transport: {
            accountNetworkLocalStateRepository: networkState,
            recipientInboxRelays: [INBOX],
            publishFn: (async () => {
              writes += 1
              return delivery([INBOX])
            }) as never,
          },
        })
      ).rejects.toThrow()
    }
    expect(writes).toBe(0)
    expect(store.entries.get(expected.snapshotId)?.relayAccepted).toBe(false)
  })
})
