import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import {
  createCheckoutSparkSettledReconciliation,
  type NostrKeySigner,
  openCheckoutSparkOrganizerRecoveryMessage,
} from "@conduit/core"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import {
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  isCheckoutSparkRecoveryPrePersistenceFailure,
  publishCheckoutSparkEventRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
  saveCheckoutSparkRecoveryDelivery,
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  clearSessionGuestOrderSigningIdentity,
  createGuestCheckoutSparkRecoverySigner,
  createSessionGuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const relays = ["wss://relay.conduit.market"]
const outboxKey = "conduit:checkout-spark-recovery-outbox:v1"
const guestScopes: { orderId: string; storage: MemoryStorage }[] = []

class MemoryStorage {
  readonly values = new Map<string, string>()
  failWrites = false
  corruptWrites = false
  writes = 0
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.writes++
    if (this.failWrites) throw new Error("Controlled storage failure")
    this.values.set(key, this.corruptWrites ? "[]" : value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

afterEach(() => {
  for (const scope of guestScopes.splice(0))
    clearSessionGuestOrderSigningIdentity(scope.orderId, scope.storage)
})

function signer(): NostrKeySigner {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (peer, value) =>
      nip44.encrypt(value, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, value) =>
      nip44.decrypt(value, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy is outside this fixture")
    },
  }
}

function fixture(guest = false) {
  const event = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
  const storage = new MemoryStorage()
  const buyer = signer()
  const guestStorage = new MemoryStorage()
  const identity = guest
    ? createSessionGuestOrderSigningIdentity(
        event.plan.orderId,
        event.merchantPubkey,
        { storage: guestStorage, nowMs: AT - 1_000 }
      )
    : { kind: "signed_in" as const, pubkey: buyer.pubkey, signer: buyer }
  if (guest)
    guestScopes.push({ orderId: event.plan.orderId, storage: guestStorage })
  const order = createCheckoutSparkEventMarketFixtureOrder(
    event,
    identity.pubkey
  )
  const recovery = {
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 1,
    network: "mainnet" as const,
  }
  const input = {
    state: createCheckoutSparkSettledReconciliation(event.plan),
    sourceEvents: event.sourceEvents,
    recovery,
    identity,
    order,
    preparedAt: AT + 1_000,
    storage,
    now: () => AT + 1_000,
  }
  return { ...event, storage, input, recovery, identity }
}

function delivery(success = true) {
  return {
    attemptedRelayUrls: relays,
    successfulRelayUrls: success ? relays : [],
    failedRelayUrls: success ? [] : relays,
    relayFailureMessages: {},
  }
}

describe("atomic Merchant and organizer checkout recovery handoff", () => {
  it("wraps state-only organizer progress for a bounded guest without adding wallet material or a generic signing scope", async () => {
    const f = fixture(true)
    const transport = {
      recipientInboxRelays: relays,
      publishFn: async () => delivery(),
    }
    const initial = await publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport,
      organizerTransport: transport,
    })
    const progress = await acknowledgeOrRetryCheckoutSparkSettledSnapshot({
      initialHandoffId: initial.handoffId,
      state: f.input.state,
      identity: f.identity,
      storage: f.storage,
      preparedAt: AT + 2_000,
      now: () => AT + 2_000,
      transport,
      organizerTransport: transport,
      requireCrossTabLock: false,
    })
    const saved = getCheckoutSparkRecoveryDelivery(
      progress.handoffId,
      f.storage
    )!
    expect(saved.organizerDelivery?.acknowledgedRelayRefs.length).toBe(1)
    const opened = await openCheckoutSparkOrganizerRecoveryMessage({
      signedRecipientWrap: saved.organizerDelivery!.signedRecipientWrap,
      signer: f.organizerSigner,
      shouldContinue: () => true,
    })
    expect(opened.payload.schemaVersion).toBe(5)
    expect(Object.hasOwn(opened.payload, "wallet")).toBe(false)
    expect(Object.hasOwn(opened.payload, "sourceEvents")).toBe(false)
    await expect(
      openCheckoutSparkOrganizerRecoveryMessage({
        signedRecipientWrap: saved.organizerDelivery!.signedRecipientWrap,
        signer: f.merchantSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
  })
  it("saves both distinct recipient ciphertexts in one row before the first relay send", async () => {
    const f = fixture()
    const publishedIds: string[] = []
    const publishFn = async (event: { id: string }) => {
      const stored = listCheckoutSparkRecoveryDeliveries(f.storage)
      expect(stored.length).toBe(1)
      const row = stored[0]!
      expect(!!row.organizerDelivery).toBe(true)
      expect(row.record.signedRecipientWrap.id).not.toBe(
        row.organizerDelivery!.signedRecipientWrap.id
      )
      expect(
        row.record.signedRecipientWrap.tags.some(
          (tag) => tag[0] === "p" && tag[1] === f.merchantPubkey
        )
      ).toBe(true)
      expect(
        row.organizerDelivery!.signedRecipientWrap.tags.some(
          (tag) => tag[0] === "p" && tag[1] === f.organizerPubkey
        )
      ).toBe(true)
      expect(
        [
          row.record.signedRecipientWrap.id,
          row.organizerDelivery!.signedRecipientWrap.id,
        ].includes(event.id)
      ).toBe(true)
      expect(
        (f.storage.getItem(outboxKey) ?? "").includes(f.recovery.mnemonic)
      ).toBe(false)
      publishedIds.push(event.id)
      return delivery()
    }
    const result = await publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: { recipientInboxRelays: relays, publishFn },
      organizerTransport: { recipientInboxRelays: relays, publishFn },
    })
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(publishedIds).toHaveLength(2)
    const row = getCheckoutSparkRecoveryDelivery(result.handoffId, f.storage)!
    expect(row.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
    expect(row.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(1)
    expect(row.organizerDelivery!.merchantHandoffId).toBe(row.record.handoffId)
  })

  for (const failPosition of [1, 2]) {
    it(`does not persist or send anything when recipient wrapping ${failPosition} fails`, async () => {
      const f = fixture()
      let wraps = 0
      let sends = 0
      const giftWrapFn = async (
        ...args: Parameters<typeof wrapPrivateMessage>
      ) => {
        wraps++
        if (wraps === failPosition)
          throw new Error("Controlled signing failure")
        return wrapPrivateMessage(...args)
      }
      const transport = {
        recipientInboxRelays: relays,
        giftWrapFn,
        publishFn: async () => {
          sends++
          return delivery()
        },
      }
      await expect(
        publishCheckoutSparkEventRecoveryHandoff({
          ...f.input,
          transport,
          organizerTransport: transport,
        })
      ).rejects.toThrow()
      expect(wraps).toBe(failPosition)
      expect(sends).toBe(0)
      expect(f.storage.writes).toBe(0)
      expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(0)
    })
  }

  for (const corruption of [false, true]) {
    it(`does not send unless the atomic ${corruption ? "readback" : "write"} succeeds`, async () => {
      const f = fixture()
      f.storage.failWrites = !corruption
      f.storage.corruptWrites = corruption
      let sends = 0
      const transport = {
        recipientInboxRelays: relays,
        publishFn: async () => {
          sends++
          return delivery()
        },
      }
      await expect(
        publishCheckoutSparkEventRecoveryHandoff({
          ...f.input,
          transport,
          organizerTransport: transport,
        })
      ).rejects.toThrow()
      expect(sends).toBe(0)
      expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(0)
    })
  }

  it("does not label an ambiguously committed ciphertext bundle as a pre-persistence failure", async () => {
    const f = fixture()
    const storage = {
      getItem: (key: string) => f.storage.getItem(key),
      removeItem: (key: string) => f.storage.removeItem(key),
      setItem: (key: string, value: string) => {
        f.storage.setItem(key, value)
        throw new Error("Controlled failure after storage write")
      },
    }
    let sends = 0
    let failure: unknown
    const transport = {
      recipientInboxRelays: relays,
      publishFn: async () => {
        sends++
        return delivery()
      },
    }
    try {
      await publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        storage,
        transport,
        organizerTransport: transport,
      })
    } catch (cause) {
      failure = cause
    }
    expect(failure instanceof Error).toBe(true)
    expect(sends).toBe(0)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage).length).toBe(1)
    expect(isCheckoutSparkRecoveryPrePersistenceFailure(failure)).toBe(false)
  })

  it("retains an ACK-less organizer copy across reload and retries the same ciphertext without a signer", async () => {
    const f = fixture()
    await expect(
      publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        transport: {
          recipientInboxRelays: relays,
          publishFn: async () => delivery(),
        },
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: async () => delivery(false),
        },
      })
    ).rejects.toThrow()
    const saved = listCheckoutSparkRecoveryDeliveries(f.storage)[0]!
    expect(saved.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
    expect(saved.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(0)
    const reload = new MemoryStorage()
    for (const [key, value] of f.storage.values) reload.values.set(key, value)
    const ids: string[] = []
    const retried = await retryStoredCheckoutSparkRecoveryHandoff({
      handoffId: saved.record.handoffId,
      storage: reload,
      recipientInboxRelays: relays,
      now: () => AT + 1_100,
      organizerTransport: { recipientInboxRelays: relays },
      publishFn: async (event) => {
        ids.push(event.id)
        return delivery()
      },
    })
    expect(ids).toEqual([saved.organizerDelivery!.signedRecipientWrap.id])
    expect(retried.canExposeFundingInvoice).toBe(true)
    const completed = listCheckoutSparkRecoveryDeliveries(reload)[0]!
    expect(completed.record.signedRecipientWrap.id).toBe(
      saved.record.signedRecipientWrap.id
    )
    expect(completed.organizerDelivery!.signedRecipientWrap.id).toBe(
      saved.organizerDelivery!.signedRecipientWrap.id
    )
    expect(completed.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(1)
  })

  it("rejects a changed organizer recipient or cross-checkout metadata rather than attaching another recovery", async () => {
    const f = fixture()
    const publishFn = async () => delivery()
    const result = await publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: { recipientInboxRelays: relays, publishFn },
      organizerTransport: { recipientInboxRelays: relays, publishFn },
    })
    const saved = getCheckoutSparkRecoveryDelivery(result.handoffId, f.storage)!
    const child = saved.organizerDelivery!
    for (const changed of [
      { ...child, checkoutId: crypto.randomUUID() },
      { ...child, orderId: crypto.randomUUID() },
      { ...child, merchantHandoffId: child.handoffId },
      { ...child, organizerPubkey: f.merchantPubkey },
      { ...child, planDigest: child.handoffId },
    ]) {
      await expect(
        saveCheckoutSparkRecoveryDelivery(
          saved.record,
          saved.deliveryProgress,
          f.storage,
          AT + 1_200,
          undefined,
          undefined,
          changed
        )
      ).rejects.toThrow()
    }
    const unchanged = getCheckoutSparkRecoveryDelivery(
      result.handoffId,
      f.storage
    )!
    expect(unchanged.organizerDelivery!.signedRecipientWrap.id).toBe(
      child.signedRecipientWrap.id
    )
    await saveCheckoutSparkRecoveryDelivery(
      saved.record,
      saved.deliveryProgress,
      f.storage,
      AT + 1_300
    )
    expect(
      getCheckoutSparkRecoveryDelivery(result.handoffId, f.storage)!
        .organizerDelivery!.signedRecipientWrap.id
    ).toBe(child.signedRecipientWrap.id)
  })

  it("allows only the exact guest checkout's separate organizer wrapping capability", async () => {
    const f = fixture(true)
    const publishFn = async () => delivery()
    const result = await publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: { recipientInboxRelays: relays, publishFn },
      organizerTransport: { recipientInboxRelays: relays, publishFn },
    })
    expect(result.canExposeFundingInvoice).toBe(true)
    if (f.identity.kind !== "guest_ephemeral")
      throw new Error("Guest fixture required")
    const scoped = createGuestCheckoutSparkRecoverySigner(f.identity, {
      now: () => AT + 1_000,
      organizerRecovery: {
        organizerPubkey: f.organizerPubkey,
        checkoutId: f.plan.checkoutId,
        planDigest: f.plan.planDigest,
      },
    })
    await expect(
      scoped.encryptNip44(f.merchantPubkey, "not an organizer recovery")
    ).rejects.toThrow()
    await expect(
      scoped.signEvent({
        kind: 0,
        pubkey: f.identity.pubkey,
        created_at: AT / 1_000,
        tags: [],
        content: "outside scope",
      })
    ).rejects.toThrow()
    await expect(
      scoped.decryptNip44(f.organizerPubkey, "outside scope")
    ).rejects.toThrow()
  })

  it("stops before persistence when session authority changes between recipient wraps", async () => {
    const f = fixture()
    let current = true
    let sends = 0
    const transport = {
      recipientInboxRelays: relays,
      shouldContinue: () => current,
      giftWrapFn: async (...args: Parameters<typeof wrapPrivateMessage>) => {
        const wrap = await wrapPrivateMessage(...args)
        current = false
        return wrap
      },
      publishFn: async () => {
        sends++
        return delivery()
      },
    }
    await expect(
      publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        transport,
        organizerTransport: transport,
      })
    ).rejects.toThrow()
    expect(sends).toBe(0)
    expect(f.storage.writes).toBe(0)
  })

  it("keeps both saved envelopes but stops the second send when authority changes after the first ACK", async () => {
    const f = fixture()
    let current = true
    let sends = 0
    const transport = {
      recipientInboxRelays: relays,
      shouldContinue: () => current,
      publishFn: async () => {
        sends++
        current = false
        return delivery()
      },
    }
    await expect(
      publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        transport,
        organizerTransport: transport,
      })
    ).rejects.toThrow()
    expect(sends).toBe(1)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage).length).toBe(1)
    expect(
      !!listCheckoutSparkRecoveryDeliveries(f.storage)[0]!.organizerDelivery
    ).toBe(true)
  })
})
