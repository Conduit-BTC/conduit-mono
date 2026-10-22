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
  archiveCompletedCheckoutSparkRecovery,
  getArchivedCheckoutSparkRecoveryDeliveries,
  retryPendingCompletedCheckoutSparkRecovery,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function publicationGate() {
  const ack = deferred<ReturnType<typeof delivery>>()
  const entered = deferred<void>()
  const ids: string[] = []
  return {
    ack,
    entered,
    ids,
    publishFn: async (event: { id: string }) => {
      ids.push(event.id)
      entered.resolve()
      return ack.promise
    },
  }
}

async function pendingOrganizerProgress() {
  const f = fixture()
  const transport = {
    recipientInboxRelays: relays,
    publishFn: async () => delivery(),
  }
  const initial = await publishCheckoutSparkEventRecoveryHandoff({
    ...f.input,
    transport,
    organizerTransport: transport,
  })
  await expect(
    acknowledgeOrRetryCheckoutSparkSettledSnapshot({
      initialHandoffId: initial.handoffId,
      state: { ...f.input.state, updatedAt: AT + 2_000 },
      identity: f.identity,
      preparedAt: AT + 2_000,
      now: () => AT + 2_000,
      storage: f.storage,
      transport,
      organizerTransport: {
        ...transport,
        publishFn: async () => delivery(false),
      },
      requireCrossTabLock: false,
    })
  ).rejects.toThrow("relay ACK")
  const progress = (await listCheckoutSparkRecoveryDeliveries(f.storage)).find(
    (item) => item.record.handoffId !== initial.handoffId
  )!
  expect(progress.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
  expect(progress.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(0)
  return {
    ...f,
    initial,
    progress,
    scope: {
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      orderId: f.plan.orderId,
      walletId: f.plan.walletId,
      merchantPubkey: f.plan.merchantPubkey,
      senderPubkey: f.identity.pubkey,
    },
  }
}

describe("atomic Merchant and organizer checkout recovery handoff", () => {
  it("retains terminal Event recovery until the exact pending Organizer wrap receives an ACK", async () => {
    const f = await pendingOrganizerProgress()
    const before = await listCheckoutSparkRecoveryDeliveries(f.storage)
    const retriesKey = "conduit:checkout-spark-recovery-snapshot-retries:v1"
    const retries = f.storage.getItem(retriesKey)
    const archive = () =>
      archiveCompletedCheckoutSparkRecovery({
        scope: f.scope,
        initialHandoffId: f.initial.handoffId,
        storage: f.storage,
      })
    expect(await archive()).toBe("delivery_pending")
    expect(
      JSON.stringify(await listCheckoutSparkRecoveryDeliveries(f.storage)) ===
        JSON.stringify(before)
    ).toBe(true)
    expect(f.storage.getItem(retriesKey) === retries).toBe(true)
    const archived = await getArchivedCheckoutSparkRecoveryDeliveries(
      f.scope,
      f.storage
    )
    expect(archived).toHaveLength(2)
    expect(
      archived.find(
        (item) => item.record.handoffId === f.progress.record.handoffId
      )!.organizerDelivery!.acknowledgedRelayRefs
    ).toHaveLength(0)
    const published: string[] = []
    for (const acknowledged of [false, true]) {
      await retryPendingCompletedCheckoutSparkRecovery({
        scope: f.scope,
        storage: f.storage,
        assertTerminalCurrent: async () => {},
        transport: {
          recipientInboxRelays: relays,
          publishFn: async () => {
            throw new Error("Acknowledged Merchant must not be republished")
          },
        },
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: async (event) => {
            published.push(event.id)
            return delivery(acknowledged)
          },
        },
      })
      expect(
        published.every(
          (id) => id === f.progress.organizerDelivery!.signedRecipientWrap.id
        )
      ).toBe(true)
      expect(published).toHaveLength(acknowledged ? 2 : 1)
      const latest = (await getCheckoutSparkRecoveryDelivery(
        f.progress.record.handoffId,
        f.storage
      ))!
      expect(
        JSON.stringify(latest.record) === JSON.stringify(f.progress.record)
      ).toBe(true)
      expect(
        JSON.stringify(latest.organizerDelivery!.signedRecipientWrap) ===
          JSON.stringify(f.progress.organizerDelivery!.signedRecipientWrap)
      ).toBe(true)
      expect(latest.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(
        acknowledged ? 1 : 0
      )
      expect(await archive()).toBe(
        acknowledged ? "cleaned" : "delivery_pending"
      )
      expect(await listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(
        acknowledged ? 0 : 2
      )
      if (!acknowledged)
        expect(f.storage.getItem(retriesKey) === retries).toBe(true)
    }
    const completed = await getArchivedCheckoutSparkRecoveryDeliveries(
      f.scope,
      f.storage
    )
    expect(completed).toHaveLength(2)
    expect(
      completed.every(
        (item) => item.organizerDelivery!.acknowledgedRelayRefs.length > 0
      )
    ).toBe(true)
    expect(f.storage.getItem(retriesKey)).toBe("{}")
  })

  it("does not checkpoint an Organizer retry after its terminal binding changes", async () => {
    const f = await pendingOrganizerProgress()
    const before = f.storage.getItem(outboxKey)
    let terminal = true
    let sends = 0
    await expect(
      retryPendingCompletedCheckoutSparkRecovery({
        scope: f.scope,
        storage: f.storage,
        assertTerminalCurrent: async () => {
          if (!terminal) throw new Error("Terminal binding changed")
        },
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: async () => {
            sends++
            terminal = false
            return delivery()
          },
        },
      })
    ).rejects.toThrow("Terminal binding changed")
    expect(sends).toBe(1)
    expect(f.storage.getItem(outboxKey) === before).toBe(true)
  })

  it("surfaces an Organizer ACK persistence failure and retains its exact pending wrap", async () => {
    const f = await pendingOrganizerProgress()
    const before = f.storage.getItem(outboxKey)
    await expect(
      retryPendingCompletedCheckoutSparkRecovery({
        scope: f.scope,
        storage: f.storage,
        assertTerminalCurrent: async () => {},
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: async () => {
            f.storage.failWrites = true
            return delivery()
          },
        },
      })
    ).rejects.toThrow("Controlled storage failure")
    expect(f.storage.getItem(outboxKey) === before).toBe(true)
    expect(
      (await getCheckoutSparkRecoveryDelivery(
        f.progress.record.handoffId,
        f.storage
      ))!.organizerDelivery!.acknowledgedRelayRefs.length
    ).toBe(0)
  })

  it("preserves exact organizer evidence and snapshot mapping when interrupted archive cleanup resumes", async () => {
    const f = fixture()
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
      state: { ...f.input.state, updatedAt: AT + 2_000 },
      identity: f.identity,
      preparedAt: AT + 2_000,
      now: () => AT + 2_000,
      storage: f.storage,
      transport,
      organizerTransport: transport,
      requireCrossTabLock: false,
    })
    const scope = {
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      orderId: f.plan.orderId,
      walletId: f.plan.walletId,
      merchantPubkey: f.plan.merchantPubkey,
      senderPubkey: f.identity.pubkey,
    }
    let checks = 0
    await expect(
      archiveCompletedCheckoutSparkRecovery({
        scope,
        initialHandoffId: initial.handoffId,
        storage: f.storage,
        verifyBeforeCommit: async () => {
          if (++checks === 3)
            throw new Error("Interrupted before active queue cleanup")
        },
      })
    ).rejects.toThrow("Interrupted before active queue cleanup")
    expect(await listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(2)
    const retained = (await getCheckoutSparkRecoveryDelivery(
      progress.handoffId,
      f.storage
    ))!
    const latest = await saveCheckoutSparkRecoveryDelivery(
      retained.record,
      retained.deliveryProgress,
      f.storage,
      AT + 3_000,
      undefined,
      undefined,
      {
        ...retained.organizerDelivery!,
        acknowledgedRelayRefs: [
          ...retained.organizerDelivery!.acknowledgedRelayRefs,
          "a".repeat(64),
        ],
      },
      retained.snapshotKey
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await archiveCompletedCheckoutSparkRecovery({
          scope,
          initialHandoffId: initial.handoffId,
          storage: f.storage,
        })
      ).toBe("cleaned")
      const archived = (
        await getArchivedCheckoutSparkRecoveryDeliveries(scope, f.storage)
      ).find((item) => item.record.handoffId === progress.handoffId)!
      expect(archived.snapshotKey === latest.snapshotKey).toBe(true)
      expect(
        JSON.stringify(archived.organizerDelivery) ===
          JSON.stringify(latest.organizerDelivery)
      ).toBe(true)
      expect(
        JSON.stringify(archived.record) === JSON.stringify(latest.record)
      ).toBe(true)
      expect(await listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(
        0
      )
    }
  })

  it("overlaps both durable recovery publications but waits for both relay ACKs", async () => {
    const f = fixture()
    const merchantEntered = deferred<void>()
    const merchantAck = deferred<ReturnType<typeof delivery>>()
    const organizerAck = deferred<ReturnType<typeof delivery>>()
    let organizerEntered = false
    let completed = false
    const assertDurablePair = async () => {
      const saved = await listCheckoutSparkRecoveryDeliveries(f.storage)
      expect(saved).toHaveLength(1)
      expect(!!saved[0]!.organizerDelivery).toBe(true)
      expect(saved[0]!.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      expect(saved[0]!.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(0)
    }
    const pending = publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: {
        recipientInboxRelays: relays,
        publishFn: async () => {
          await assertDurablePair()
          merchantEntered.resolve()
          return merchantAck.promise
        },
      },
      organizerTransport: {
        recipientInboxRelays: relays,
        publishFn: async () => {
          await assertDurablePair()
          organizerEntered = true
          return organizerAck.promise
        },
      },
    }).finally(() => {
      completed = true
    })
    try {
      await merchantEntered.promise
      await nextTurn()
      expect(organizerEntered).toBe(true)
      expect(completed).toBe(false)
      merchantAck.resolve(delivery())
      await nextTurn()
      expect(completed).toBe(false)
      const saved = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
      expect(saved.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
      expect(saved.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(0)
      organizerAck.resolve(delivery())
      expect((await pending).canExposeFundingInvoice).toBe(true)
    } finally {
      merchantAck.resolve(delivery())
      organizerAck.resolve(delivery())
      await pending.catch(() => {})
    }
  })

  for (const failedRole of ["merchant", "organizer"] as const) {
    it(`drains and retains the other ACK when ${failedRole} fails, then retries only the missing exact wrap`, async () => {
      const f = fixture()
      if (f.identity.kind !== "signed_in")
        throw new Error("Expected account fixture")
      let signs = 0
      const signEvent = f.identity.signer.signEvent
      f.identity.signer.signEvent = async (draft) => {
        signs++
        return signEvent(draft)
      }
      const merchant = publicationGate()
      const organizer = publicationGate()
      const failed = failedRole === "merchant" ? merchant : organizer
      const successful = failedRole === "merchant" ? organizer : merchant
      const cause = new Error(`Controlled ${failedRole} publication failure`)
      let completed = false
      const pending = publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        transport: {
          recipientInboxRelays: relays,
          publishFn: merchant.publishFn,
        },
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: organizer.publishFn,
        },
      })
        .then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error })
        )
        .finally(() => {
          completed = true
        })
      try {
        await merchant.entered.promise
        await nextTurn()
        expect(organizer.ids).toHaveLength(1)
        const signedCount = signs
        const original = (
          await listCheckoutSparkRecoveryDeliveries(f.storage)
        )[0]!
        failed.ack.reject(cause)
        await nextTurn()
        expect(completed).toBe(false)
        successful.ack.resolve(delivery())
        const outcome = await pending
        expect(outcome.result).toBeNull()
        expect(outcome.error).toBe(cause)
        const saved = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
        expect(saved.deliveryProgress.acknowledgedRelayRefs).toHaveLength(
          failedRole === "merchant" ? 0 : 1
        )
        expect(saved.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(
          failedRole === "organizer" ? 0 : 1
        )
        const retriedIds: string[] = []
        const retried = await retryStoredCheckoutSparkRecoveryHandoff({
          handoffId: saved.record.handoffId,
          storage: f.storage,
          now: f.input.now,
          recipientInboxRelays: relays,
          organizerTransport: { recipientInboxRelays: relays },
          publishFn: async (event) => {
            retriedIds.push(event.id)
            return delivery()
          },
        })
        expect(retried.canExposeFundingInvoice).toBe(true)
        expect(retriedIds.length === 1 && retriedIds[0] === failed.ids[0]).toBe(
          true
        )
        expect(signs).toBe(signedCount)
        const complete = (
          await listCheckoutSparkRecoveryDeliveries(f.storage)
        )[0]!
        expect(complete.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
        expect(complete.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(
          1
        )
        expect(
          JSON.stringify(complete.record) === JSON.stringify(original.record)
        ).toBe(true)
        expect(
          JSON.stringify(complete.organizerDelivery!.signedRecipientWrap) ===
            JSON.stringify(original.organizerDelivery!.signedRecipientWrap)
        ).toBe(true)
      } finally {
        merchant.ack.resolve(delivery())
        organizer.ack.resolve(delivery())
        await pending
      }
    })
  }

  it("preserves both ACKs when the Organizer publication finishes first", async () => {
    const f = fixture()
    const merchant = publicationGate()
    const organizer = publicationGate()
    let completed = false
    const pending = publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: {
        recipientInboxRelays: relays,
        publishFn: merchant.publishFn,
      },
      organizerTransport: {
        recipientInboxRelays: relays,
        publishFn: organizer.publishFn,
      },
    }).finally(() => {
      completed = true
    })
    try {
      await merchant.entered.promise
      await nextTurn()
      expect(organizer.ids).toHaveLength(1)
      organizer.ack.resolve(delivery())
      await nextTurn()
      expect(completed).toBe(false)
      const partial = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
      expect(partial.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      expect(partial.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(1)
      merchant.ack.resolve(delivery())
      expect((await pending).canExposeFundingInvoice).toBe(true)
      const complete = (
        await listCheckoutSparkRecoveryDeliveries(f.storage)
      )[0]!
      expect(complete.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
      expect(complete.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(1)
    } finally {
      merchant.ack.resolve(delivery())
      organizer.ack.resolve(delivery())
      await pending.catch(() => {})
    }
  })

  it("drains both failed publications and reports the Merchant failure regardless of completion order", async () => {
    const f = fixture()
    const merchant = publicationGate()
    const organizer = publicationGate()
    const merchantFailure = new Error("Controlled Merchant failure")
    const organizerFailure = new Error("Controlled Organizer failure")
    let completed = false
    const pending = publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: {
        recipientInboxRelays: relays,
        publishFn: merchant.publishFn,
      },
      organizerTransport: {
        recipientInboxRelays: relays,
        publishFn: organizer.publishFn,
      },
    })
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error })
      )
      .finally(() => {
        completed = true
      })
    try {
      await merchant.entered.promise
      await nextTurn()
      expect(organizer.ids).toHaveLength(1)
      organizer.ack.reject(organizerFailure)
      await nextTurn()
      expect(completed).toBe(false)
      merchant.ack.reject(merchantFailure)
      const outcome = await pending
      expect(outcome.result).toBeNull()
      expect(outcome.error).toBe(merchantFailure)
      const saved = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
      expect(saved.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      expect(saved.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(0)
    } finally {
      merchant.ack.resolve(delivery())
      organizer.ack.resolve(delivery())
      await pending
    }
  })

  it("retains both real ACKs but rejects exposure when the session changes after both sends start", async () => {
    const f = fixture()
    const merchant = publicationGate()
    const organizer = publicationGate()
    let current = true
    let completed = false
    const pending = publishCheckoutSparkEventRecoveryHandoff({
      ...f.input,
      transport: {
        recipientInboxRelays: relays,
        publishFn: merchant.publishFn,
        shouldContinue: () => current,
      },
      organizerTransport: {
        recipientInboxRelays: relays,
        publishFn: organizer.publishFn,
        shouldContinue: () => current,
      },
    })
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error })
      )
      .finally(() => {
        completed = true
      })
    try {
      await merchant.entered.promise
      await nextTurn()
      expect(organizer.ids).toHaveLength(1)
      current = false
      organizer.ack.resolve(delivery())
      await nextTurn()
      expect(completed).toBe(false)
      merchant.ack.resolve(delivery())
      const outcome = await pending
      expect(outcome.result).toBeNull()
      expect(outcome.error instanceof Error).toBe(true)
      const saved = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
      expect(saved.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
      expect(saved.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(1)
    } finally {
      merchant.ack.resolve(delivery())
      organizer.ack.resolve(delivery())
      await pending
    }
  })

  for (const missingRole of ["merchant", "organizer"] as const) {
    it(`requires a fresh ${missingRole} ACK during explicit replay despite both saved ACKs`, async () => {
      const f = fixture()
      const transport = {
        recipientInboxRelays: relays,
        publishFn: async () => delivery(),
      }
      const initial = await publishCheckoutSparkEventRecoveryHandoff({
        ...f.input,
        transport,
        organizerTransport: transport,
      })
      const original = (await getCheckoutSparkRecoveryDelivery(
        initial.handoffId,
        f.storage
      ))!
      const merchant = publicationGate()
      const organizer = publicationGate()
      const missing = missingRole === "merchant" ? merchant : organizer
      const successful = missingRole === "merchant" ? organizer : merchant
      let completed = false
      const pending = retryStoredCheckoutSparkRecoveryHandoff({
        handoffId: initial.handoffId,
        storage: f.storage,
        now: f.input.now,
        replayAcknowledged: true,
        recipientInboxRelays: relays,
        publishFn: merchant.publishFn,
        organizerTransport: {
          recipientInboxRelays: relays,
          publishFn: organizer.publishFn,
        },
      })
        .then(
          (result) => ({ result, error: null }),
          (error: unknown) => ({ result: null, error })
        )
        .finally(() => {
          completed = true
        })
      try {
        await merchant.entered.promise
        await nextTurn()
        expect(organizer.ids).toHaveLength(1)
        expect(merchant.ids[0] === original.record.signedRecipientWrap.id).toBe(
          true
        )
        expect(
          organizer.ids[0] ===
            original.organizerDelivery!.signedRecipientWrap.id
        ).toBe(true)
        missing.ack.resolve(delivery(false))
        await nextTurn()
        expect(completed).toBe(false)
        successful.ack.resolve(delivery())
        const outcome = await pending
        expect(outcome.result).toBeNull()
        expect(outcome.error instanceof Error).toBe(true)
        const retained = (await getCheckoutSparkRecoveryDelivery(
          initial.handoffId,
          f.storage
        ))!
        expect(retained.deliveryProgress.acknowledgedRelayRefs).toHaveLength(1)
        expect(retained.organizerDelivery!.acknowledgedRelayRefs).toHaveLength(
          1
        )
        expect(
          JSON.stringify(retained.record) === JSON.stringify(original.record)
        ).toBe(true)
      } finally {
        merchant.ack.resolve(delivery())
        organizer.ack.resolve(delivery())
        await pending
      }
    })
  }

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
    const saved = (await getCheckoutSparkRecoveryDelivery(
      progress.handoffId,
      f.storage
    ))!
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
      const stored = await listCheckoutSparkRecoveryDeliveries(f.storage)
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
    const row = (await getCheckoutSparkRecoveryDelivery(
      result.handoffId,
      f.storage
    ))!
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
      expect(await listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(
        0
      )
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
      expect(await listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(
        0
      )
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
    expect((await listCheckoutSparkRecoveryDeliveries(f.storage)).length).toBe(
      1
    )
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
    const saved = (await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
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
    const completed = (await listCheckoutSparkRecoveryDeliveries(reload))[0]!
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
    const saved = (await getCheckoutSparkRecoveryDelivery(
      result.handoffId,
      f.storage
    ))!
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
    const unchanged = (await getCheckoutSparkRecoveryDelivery(
      result.handoffId,
      f.storage
    ))!
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
      (await getCheckoutSparkRecoveryDelivery(result.handoffId, f.storage))!
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
    expect((await listCheckoutSparkRecoveryDeliveries(f.storage)).length).toBe(
      1
    )
    expect(
      !!(await listCheckoutSparkRecoveryDeliveries(f.storage))[0]!
        .organizerDelivery
    ).toBe(true)
  })
})
