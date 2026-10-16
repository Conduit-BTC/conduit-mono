import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import {
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  openCheckoutSparkRecoveryDelivery,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkRecoveryTransportOptions,
} from "@conduit/core"

import {
  acknowledgeCheckoutSparkSettledSnapshot,
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  assertCheckoutSparkRecoverySigningIdentity,
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  createSessionGuestOrderSigningIdentity,
  GUEST_ORDER_SESSION_TTL_MS,
} from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MNEMONIC = createRuntimeMnemonic()
const RELAYS = ["wss://merchant.inbox.relay.dev"]

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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function fixture() {
  const createdAt = Math.floor(Date.now() / 1_000) * 1_000
  const clock = { now: createdAt + 100 }
  const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
  const storage = new MemoryStorage()
  const identity = createSessionGuestOrderSigningIdentity(
    "guest-router-order",
    merchant.pubkey,
    { storage: new MemoryStorage(), nowMs: createdAt - 1_000 }
  )
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc1220n",
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "guest-router-checkout",
    orderId: identity.orderId,
    merchantPubkey: merchant.pubkey,
    walletId: "guest-router-wallet",
    network: "mainnet",
    createdAt,
    takeoverAt: createdAt + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${merchant.pubkey}:guest-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: merchant.pubkey,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "guest-router-receive",
      paymentRequest: invoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 122,
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
        weightSats: 10,
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
  const state = createCheckoutSparkSettledReconciliation(plan)
  const calls = { wraps: 0, publishes: 0, persistedBeforePublish: false }
  const relay = { ack: true }
  const transport: CheckoutSparkRecoveryTransportOptions = {
    recipientInboxRelays: RELAYS,
    giftWrapFn: async (...args) => {
      calls.wraps += 1
      return wrapPrivateMessage(...args)
    },
    publishFn: async (_event, options) => {
      calls.publishes += 1
      calls.persistedBeforePublish =
        listCheckoutSparkRecoveryDeliveries(storage).length > 0
      const attempted = options.exclusiveRelayUrls ?? []
      return {
        attemptedRelayUrls: attempted,
        successfulRelayUrls: relay.ack ? attempted : [],
        failedRelayUrls: relay.ack ? [] : attempted,
        relayFailureMessages: {},
      }
    },
  }
  const input = {
    state,
    identity,
    recovery: {
      mnemonic: MNEMONIC,
      accountNumber: 0,
      network: "mainnet" as const,
    },
    preparedAt: clock.now,
    now: () => clock.now,
    storage,
    transport,
  }
  const credited = () =>
    recordCheckoutSparkSettledCredit(state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      transferId: "guest-funding-credit",
      grossSats: 122,
      creditedSats: 121,
      observedAt: clock.now,
    })
  return {
    input,
    identity,
    plan,
    state,
    merchant,
    storage,
    clock,
    calls,
    relay,
    credited,
  }
}

describe("guest settled Spark recovery handoff", () => {
  it("persists one real merchant-only wrap before publication without wallet plaintext", async () => {
    const f = fixture()
    const result = await publishCheckoutSparkSettledRecoveryHandoff(f.input)
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(f.calls).toEqual({
      wraps: 1,
      publishes: 1,
      persistedBeforePublish: true,
    })
    const saved = getCheckoutSparkRecoveryDelivery(result.handoffId, f.storage)!
    const opened = await openCheckoutSparkRecoveryDelivery({
      record: saved.record,
      signer: f.merchant,
    })
    expect(opened.schemaVersion).toBe(2)
    expect(opened.senderPubkey === f.identity.pubkey).toBe(true)
    expect(opened.plan.planDigest === f.plan.planDigest).toBe(true)
    expect(
      saved.record.signedRecipientWrap.tags.filter((tag) => tag[0] === "p")
        .length
    ).toBe(1)
    const raw = [...f.storage.values.values()].join("")
    expect(raw.includes(MNEMONIC)).toBe(false)
    expect(raw.includes(f.plan.funding.paymentRequest)).toBe(false)
    expect(raw.includes("merchant@example.test")).toBe(false)
    await expect(
      openCheckoutSparkRecoveryDelivery({
        record: saved.record,
        signer: plainTestSigner(NDKPrivateKeySigner.generate()),
      })
    ).rejects.toThrow("merchant")
  })

  it("keeps legacy recovery signing restricted to an external signed-in identity", () => {
    expect(() =>
      assertCheckoutSparkRecoverySigningIdentity(fixture().identity)
    ).toThrow("signed-in external signer")
  })

  it.each([
    "order",
    "merchant",
    "sender",
    "expired",
    "future",
    "ttl",
    "prepared_before",
    "prepared_future",
    "clock",
  ] as const)(
    "rejects %s scope before wrapping, storage, or publication",
    async (change) => {
      const f = fixture()
      const identity = { ...f.identity }
      let preparedAt = f.input.preparedAt
      if (change === "order") identity.orderId = "different-order"
      else if (change === "merchant") identity.merchantPubkey = "a".repeat(64)
      else if (change === "sender") identity.pubkey = "a".repeat(64)
      else if (change === "expired") f.clock.now = identity.expiresAt
      else if (change === "future") {
        identity.createdAt = f.clock.now + 1
        identity.expiresAt = identity.createdAt + GUEST_ORDER_SESSION_TTL_MS
      } else if (change === "ttl") identity.expiresAt += 1
      else if (change === "prepared_before") preparedAt = identity.createdAt - 1
      else if (change === "prepared_future") preparedAt = f.clock.now + 1
      else f.clock.now = Number.NaN
      await expect(
        publishCheckoutSparkSettledRecoveryHandoff({
          ...f.input,
          identity,
          preparedAt,
        })
      ).rejects.toThrow()
      expect(f.calls.wraps).toBe(0)
      expect(f.calls.publishes).toBe(0)
      expect(f.storage.values.size).toBe(0)
    }
  )

  it("retains and retries the identical zero-ACK wrap without the expired guest key", async () => {
    const f = fixture()
    f.relay.ack = false
    await expect(
      publishCheckoutSparkSettledRecoveryHandoff(f.input)
    ).rejects.toThrow("relay ACK")
    const original = listCheckoutSparkRecoveryDeliveries(f.storage)[0]!
    f.clock.now = f.identity.expiresAt
    let sameWrap = false
    const retry = await retryStoredCheckoutSparkRecoveryHandoff({
      handoffId: original.record.handoffId,
      storage: f.storage,
      recipientInboxRelays: RELAYS,
      now: f.input.now,
      publishFn: async (event, options) => {
        sameWrap = event.id === original.record.signedRecipientWrap.id
        return {
          attemptedRelayUrls: options.exclusiveRelayUrls ?? [],
          successfulRelayUrls: RELAYS,
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
    })
    expect(retry.canExposeFundingInvoice).toBe(true)
    expect(sameWrap).toBe(true)
    expect(f.calls.wraps).toBe(1)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(1)
  })

  it.each(["signer", "route", "wrapped", "persisted"] as const)(
    "stops new publication when the guest expires during the awaited %s step",
    async (stage) => {
      const f = fixture()
      const entered = deferred()
      const release = deferred()
      const hold = async () => {
        entered.resolve()
        await release.promise
      }
      const input = { ...f.input, transport: { ...f.input.transport } }
      if (stage === "signer") {
        input.identity = {
          ...f.identity,
          signer: {
            ...f.identity.signer,
            getPublicKey: async () => {
              await hold()
              return f.identity.signer.getPublicKey()
            },
          },
        }
      } else if (stage === "route") {
        input.transport.recipientInboxRelays = undefined
        input.transport.resolveInboxRelays = async () => {
          await hold()
          return RELAYS
        }
      } else if (stage === "wrapped") {
        input.transport.giftWrapFn = async (...args) => {
          f.calls.wraps += 1
          const wrapped = await wrapPrivateMessage(...args)
          await hold()
          return wrapped
        }
      }
      const publishing = publishCheckoutSparkSettledRecoveryHandoff({
        ...input,
        ...(stage === "persisted" ? { onPersisted: hold } : {}),
      })
      await entered.promise
      f.clock.now = f.identity.expiresAt
      release.resolve()
      await expect(publishing).rejects.toThrow()
      expect(f.calls.publishes).toBe(0)
      expect(listCheckoutSparkRecoveryDeliveries(f.storage).length).toBe(
        stage === "persisted" ? 1 : 0
      )
    }
  )

  it("preserves a late relay ACK but does not authorize invoice exposure after expiry", async () => {
    const f = fixture()
    const entered = deferred()
    const release = deferred()
    const publishing = publishCheckoutSparkSettledRecoveryHandoff({
      ...f.input,
      transport: {
        ...f.input.transport,
        publishFn: async (event, options) => {
          entered.resolve()
          await release.promise
          return f.input.transport.publishFn!(event, options)
        },
      },
    })
    await entered.promise
    f.clock.now = f.identity.expiresAt
    release.resolve()
    await expect(publishing).rejects.toThrow()
    expect(
      listCheckoutSparkRecoveryDeliveries(f.storage)[0]!.deliveryProgress
        .acknowledgedRelayRefs
    ).toHaveLength(1)
  })

  it.each(["expired", "revoked"] as const)(
    "links the exact saved wrap once before rejecting a guest %s during storage",
    async (change) => {
      const f = fixture()
      let active = true
      const linked: string[] = []
      const originalSetItem = f.storage.setItem.bind(f.storage)
      f.storage.setItem = (key, value) => {
        originalSetItem(key, value)
        if (change === "expired") f.clock.now = f.identity.expiresAt
        else active = false
      }
      await expect(
        publishCheckoutSparkSettledRecoveryHandoff({
          ...f.input,
          transport: { ...f.input.transport, shouldContinue: () => active },
          onPersisted: (handoffId) => {
            expect(
              getCheckoutSparkRecoveryDelivery(handoffId, f.storage)
            ).not.toBeNull()
            linked.push(handoffId)
          },
        })
      ).rejects.toThrow()
      const saved = listCheckoutSparkRecoveryDeliveries(f.storage)
      expect(saved).toHaveLength(1)
      expect(linked).toEqual([saved[0]!.record.handoffId])
      expect(saved[0]!.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      expect(f.calls.wraps).toBe(1)
      expect(f.calls.publishes).toBe(0)
      const opened = await openCheckoutSparkRecoveryDelivery({
        record: saved[0]!.record,
        signer: f.merchant,
      })
      expect(opened.plan.planDigest === f.plan.planDigest).toBe(true)
    }
  )

  it("retains the progress retry mapping when its storage write revokes the guest", async () => {
    const f = fixture()
    const initial = await publishCheckoutSparkSettledRecoveryHandoff(f.input)
    let active = true
    const originalSetItem = f.storage.setItem.bind(f.storage)
    f.storage.setItem = (key, value) => {
      originalSetItem(key, value)
      if (listCheckoutSparkRecoveryDeliveries(f.storage).length === 2)
        active = false
    }
    const input = {
      initialHandoffId: initial.handoffId,
      state: f.credited(),
      identity: f.identity,
      storage: f.storage,
      transport: { ...f.input.transport, shouldContinue: () => active },
      now: f.input.now,
      requireCrossTabLock: false,
    }
    await expect(
      acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    ).rejects.toThrow()
    const saved = listCheckoutSparkRecoveryDeliveries(f.storage)
    expect(saved).toHaveLength(2)
    expect(f.calls.publishes).toBe(1)
    const progress = saved.find(
      (delivery) => delivery.record.handoffId !== initial.handoffId
    )!
    const originalWrap = JSON.stringify(progress.record.signedRecipientWrap)
    f.storage.setItem = originalSetItem
    active = true
    const retried = await acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    expect(retried.mode).toBe("retried")
    expect(retried.handoffId).toBe(progress.record.handoffId)
    expect(f.calls.wraps).toBe(2)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(2)
    expect(
      JSON.stringify(
        getCheckoutSparkRecoveryDelivery(retried.handoffId, f.storage)!.record
          .signedRecipientWrap
      )
    ).toBe(originalWrap)
  })

  it("composes caller cancellation with the guest lifetime guard", async () => {
    const f = fixture()
    await expect(
      publishCheckoutSparkSettledRecoveryHandoff({
        ...f.input,
        transport: { ...f.input.transport, shouldContinue: () => false },
      })
    ).rejects.toThrow("session changed")
    expect(f.calls.wraps).toBe(0)
    expect(f.calls.publishes).toBe(0)
  })

  it("rechecks caller cancellation after held route discovery", async () => {
    const f = fixture()
    const entered = deferred()
    const release = deferred()
    let active = true
    const publishing = publishCheckoutSparkSettledRecoveryHandoff({
      ...f.input,
      transport: {
        ...f.input.transport,
        recipientInboxRelays: undefined,
        shouldContinue: () => active,
        resolveInboxRelays: async () => {
          entered.resolve()
          await release.promise
          return RELAYS
        },
      },
    })
    await entered.promise
    active = false
    release.resolve()
    await expect(publishing).rejects.toThrow()
    expect(f.calls.wraps).toBe(0)
    expect(f.calls.publishes).toBe(0)
  })

  it("pins guest order identity before awaiting the signer", async () => {
    const f = fixture()
    const entered = deferred()
    const release = deferred()
    const identity = {
      ...f.identity,
      signer: {
        ...f.identity.signer,
        getPublicKey: async () => {
          entered.resolve()
          await release.promise
          return f.identity.signer.getPublicKey()
        },
      },
    }
    const publishing = publishCheckoutSparkSettledRecoveryHandoff({
      ...f.input,
      identity,
    })
    await entered.promise
    identity.orderId = "different-order"
    identity.merchantPubkey = "a".repeat(64)
    release.resolve()
    const result = await publishing
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(f.calls.wraps).toBe(1)
    expect(f.calls.publishes).toBe(1)
  })

  it("publishes real state-only progress for the same ACKed guest handoff", async () => {
    const f = fixture()
    const initial = await publishCheckoutSparkSettledRecoveryHandoff(f.input)
    f.clock.now += 100
    const progress = await acknowledgeCheckoutSparkSettledSnapshot({
      initialHandoffId: initial.handoffId,
      state: f.credited(),
      identity: f.identity,
      storage: f.storage,
      transport: f.input.transport,
      now: f.input.now,
    })
    const saved = getCheckoutSparkRecoveryDelivery(
      progress.handoffId,
      f.storage
    )!
    const opened = await openCheckoutSparkRecoveryDelivery({
      record: saved.record,
      signer: f.merchant,
    })
    expect(opened.type).toBe("checkout_spark_recovery_progress")
    expect("walletRecovery" in opened).toBe(false)
    expect(JSON.stringify(opened).includes(MNEMONIC)).toBe(false)
    expect(f.calls.wraps).toBe(2)
  })

  it.each(["sender", "expired", "missing_ack"] as const)(
    "rejects %s progress authority without another wrap",
    async (change) => {
      const f = fixture()
      if (change === "missing_ack") {
        f.relay.ack = false
        await expect(
          publishCheckoutSparkSettledRecoveryHandoff(f.input)
        ).rejects.toThrow("relay ACK")
      } else {
        await publishCheckoutSparkSettledRecoveryHandoff(f.input)
      }
      const initial = listCheckoutSparkRecoveryDeliveries(f.storage)[0]!
      const state = f.credited()
      if (change === "expired") f.clock.now = f.identity.expiresAt
      await expect(
        acknowledgeCheckoutSparkSettledSnapshot({
          initialHandoffId: initial.record.handoffId,
          state,
          identity:
            change === "sender"
              ? { ...f.identity, pubkey: "a".repeat(64) }
              : f.identity,
          storage: f.storage,
          transport: f.input.transport,
          now: f.input.now,
        })
      ).rejects.toThrow()
      expect(f.calls.wraps).toBe(1)
      expect(f.calls.publishes).toBe(1)
    }
  )

  it("retries zero-ACK progress using its immutable wrap and never wraps it again", async () => {
    const f = fixture()
    const initial = await publishCheckoutSparkSettledRecoveryHandoff(f.input)
    f.clock.now += 100
    const input = {
      initialHandoffId: initial.handoffId,
      state: f.credited(),
      identity: f.identity,
      storage: f.storage,
      transport: f.input.transport,
      now: f.input.now,
      requireCrossTabLock: false,
    }
    f.relay.ack = false
    await expect(
      acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    ).rejects.toThrow("relay ACK")
    f.relay.ack = true
    const result = await acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    expect(result.mode).toBe("retried")
    expect(f.calls.wraps).toBe(2)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(2)
  })
})
