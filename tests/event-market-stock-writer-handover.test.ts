import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  beginOrganizerStockWriterHandover,
  parseOrganizerStockWriterHandoverRumor,
  prepareOrganizerStockWriterTarget,
  publishOrganizerStockWriterHandover,
  registerOrganizerStockWriterDevice,
  restoreOrganizerStockWriterHandover,
  readOrganizerStockWriterHandovers,
  disposeOrganizerStockWriterHandoverCursor,
  type OrganizerStockWriterHandoverCursor,
} from "@conduit/core/protocol/event-market-stock-writer-handover"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { parseStockWriterPacket } from "@conduit/core/protocol/event-market-stock-writer-packets"
import {
  beginOrganizerStockClose,
  commitOrganizerStockOrder,
  installOrganizerStockHandover,
  prepareOrganizerStockEnvelopes,
} from "@conduit/core/protocol/event-market-stock-journal"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
  openCheckoutSparkOrganizerRecoveryAuthority,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { createEventMarketStockAuthorityRumor } from "@conduit/core/protocol/event-market-stock-authority"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import {
  createPrivateMessageRumor,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  __resetProtectedReadSigner()
  for (const db of databases.splice(0)) await db.delete()
})
function freshDb() {
  const db = new ConduitDB(`writer-handover-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  return db
}
async function failure(operation: Promise<unknown>) {
  let error: unknown
  try {
    await operation
  } catch (cause) {
    error = cause
  }
  expect(error).toBeInstanceOf(Error)
}
async function fixture(stockQuantity?: number) {
  const f = await checkoutSparkOrganizerFixture({ stockQuantity })
  databases.push(f.database)
  const session = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  const marketCoordinate = f.eventMarket.marketCoordinate
  const poolId = f.stockGrant!.id
  await registerOrganizerStockWriterDevice({
    ...session,
    marketCoordinate,
    writerId: f.writerId,
    deviceId: f.writerId,
    expectedPoolIds: [poolId],
  })
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
  const acceptance = {
    ...session,
    writerId: f.writerId,
    orderId: f.plan.orderId,
    identityBinding: purchase.orderBinding.identityHash,
    termsBinding: purchase.orderBinding.termsHash,
    claimRef: purchase.claimRef,
    entries: purchase.writerBindings,
    evidence: JSON.stringify({
      handoffId: purchase.handoffId,
      planDigest: f.plan.planDigest,
      orderBinding: purchase.orderBinding,
    }),
    nowMs: f.clock.now,
  }
  await commitOrganizerStockOrder(acceptance)
  const targetDeviceId = crypto.randomUUID()
  const target = freshDb()
  const targetSession = { ...session, db: target }
  const key = `${f.organizerPubkey}:${marketCoordinate}`
  return {
    ...f,
    session,
    marketCoordinate,
    poolId,
    purchase,
    acceptance,
    targetDeviceId,
    target,
    targetSession,
    key,
  }
}
function transport(sends: string[], accepted = true) {
  const relay = "wss://relay.conduit.market"
  return {
    resolveInboxRelays: async () => [relay],
    accountNetworkLocalStateRepository: { get: async () => undefined },
    publishFn: async (event: { id: string }) => {
      sends.push(event.id)
      return {
        attemptedRelayUrls: [relay],
        successfulRelayUrls: accepted ? [relay] : [],
        failedRelayUrls: accepted ? [] : [relay],
        relayFailureMessages: {},
      }
    },
  }
}
async function freeze(f: Awaited<ReturnType<typeof fixture>>) {
  return beginOrganizerStockWriterHandover({
    ...f.session,
    marketCoordinate: f.marketCoordinate,
    writerId: f.writerId,
    targetDeviceId: f.targetDeviceId,
    nowMs: f.clock.now + 10,
  })
}

describe("explicit complete Organizer stock-writer device handover", () => {
  it("freezes the source before signing, restores the exact logical writer and continues the old frozen purchase without another debit", async () => {
    const f = await fixture()
    await prepareOrganizerStockWriterTarget({
      ...f.targetSession,
      marketCoordinate: f.marketCoordinate,
      targetDeviceId: f.targetDeviceId,
    })
    const before = await f.database.eventMarketOrganizerStockEntries.toArray()
    const saved = await freeze(f)
    expect(saved.state).toBe("retired")
    expect(saved.outgoing!.envelope).toBeUndefined()
    const payload = parseOrganizerStockWriterHandoverRumor(
      saved.outgoing!.rumor
    )
    expect(payload.snapshot.entries).toEqual(before)
    expect(payload.writerId).toBe(f.writerId)
    expect(payload.targetDeviceId).not.toBe(f.writerId)
    const sends: string[] = []
    const published = await publishOrganizerStockWriterHandover({
      ...f.session,
      marketCoordinate: f.marketCoordinate,
      delivery: transport(sends),
    })
    expect(published.relayAccepted).toBe(true)
    const restored = await restoreOrganizerStockWriterHandover({
      ...f.targetSession,
      envelope: published.envelope,
      expectedTargetDeviceId: f.targetDeviceId,
      nowMs: f.clock.now + 20,
    })
    expect(restored.writerId).toBe(f.writerId)
    expect(restored.poolIds).toEqual([f.poolId])
    expect(await f.target.eventMarketOrganizerStockEntries.toArray()).toEqual(
      before
    )
    const authority = await openCheckoutSparkOrganizerRecoveryAuthority({
      ...f.authorityInput,
      db: f.target,
    })
    await assertCheckoutSparkOrganizerRecoveryWriterCurrent(authority)
    expect(
      assertCheckoutSparkOrganizerRecoveryAuthority(authority).writerBindings
    ).toEqual(f.purchase.writerBindings)
    expect(
      (await commitOrganizerStockOrder({ ...f.acceptance, db: f.target }))
        .replayed
    ).toBe(true)
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(1)
    // Both exact retries use the originally saved gift wrap, never a new seal.
    const again = await publishOrganizerStockWriterHandover({
      ...f.session,
      marketCoordinate: f.marketCoordinate,
      delivery: transport(sends),
    })
    expect(again.envelope.id).toBe(published.envelope.id)
    expect(new Set(sends).size).toBe(1)
    f.clock.now += 20
    await commitOrganizerStockOrder({
      ...f.acceptance,
      db: f.target,
      orderId: crypto.randomUUID(),
      claimRef: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      evidence: "next original terms",
      nowMs: f.clock.now,
    })
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(2)
    await restoreOrganizerStockWriterHandover({
      ...f.targetSession,
      envelope: published.envelope,
      expectedTargetDeviceId: f.targetDeviceId,
      nowMs: f.clock.now,
    })
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(2)
  })

  it("fences source exact replay, cached wraps, future grant install, close and an already-open financial capability", async () => {
    const f = await fixture()
    await prepareOrganizerStockEnvelopes({
      ...f.session,
      poolId: f.poolId,
      work: {
        entryId: (
          await f.database.eventMarketOrganizerStockEntries.toArray()
        )[0]!.rumor.id,
      },
    })
    await freeze(f)
    await failure(commitOrganizerStockOrder(f.acceptance))
    await failure(
      prepareOrganizerStockEnvelopes({
        ...f.session,
        poolId: f.poolId,
        work: {
          entryId: (
            await f.database.eventMarketOrganizerStockEntries.toArray()
          )[0]!.rumor.id,
        },
      })
    )
    await failure(
      beginOrganizerStockClose({
        ...f.session,
        poolId: f.poolId,
        writerId: f.writerId,
        nowMs: f.clock.now + 20,
      })
    )
    await failure(
      installOrganizerStockHandover({
        ...f.session,
        writerId: f.writerId,
        grantRumor: f.stockGrant!,
        committedAssignmentEvent: f.events.assignment,
        nowMs: f.clock.now + 20,
      })
    )
    await failure(
      assertCheckoutSparkOrganizerRecoveryWriterCurrent(f.authority)
    )
    expect(
      (await f.database.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(1)
  })

  it("requires a preexisting exact target, rejects partial/tampered history, and cannot clear readonly recovery", async () => {
    const f = await fixture(),
      saved = await freeze(f)
    const envelope = await wrapPrivateMessage(
      saved.outgoing!.rumor,
      { pubkey: f.organizerPubkey },
      f.organizerSigner
    )
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope,
        expectedTargetDeviceId: f.targetDeviceId,
        nowMs: f.clock.now + 20,
      })
    )
    await prepareOrganizerStockWriterTarget({
      ...f.targetSession,
      marketCoordinate: f.marketCoordinate,
      targetDeviceId: f.targetDeviceId,
    })
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope,
        expectedTargetDeviceId: crypto.randomUUID(),
        nowMs: f.clock.now + 20,
      })
    )
    const payload = parseOrganizerStockWriterHandoverRumor(
      saved.outgoing!.rumor
    )
    payload.snapshot.entries = []
    const malformed = createPrivateMessageRumor({
      ...saved.outgoing!.rumor,
      content: JSON.stringify(payload),
    })
    const partial = await wrapPrivateMessage(
      malformed,
      { pubkey: f.organizerPubkey },
      f.organizerSigner
    )
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope: partial,
        expectedTargetDeviceId: f.targetDeviceId,
        nowMs: f.clock.now + 20,
      })
    )
    expect(await f.target.eventMarketOrganizerStockEntries.count()).toBe(0)
    const readonly = {
      ...(await f.database.eventMarketOrganizerStockPools.toArray())[0]!,
      readOnlyRecovery: true as const,
    }
    await f.target.eventMarketOrganizerStockPools.put(readonly)
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope,
        expectedTargetDeviceId: f.targetDeviceId,
        nowMs: f.clock.now + 20,
      })
    )
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .readOnlyRecovery
    ).toBe(true)
    expect(
      (await f.target.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("target")
  })

  it("retains a committed unsigned handout and an unhanded order as distinct once-only decisions", async () => {
    const f = await fixture()
    const entry = (
      await f.database.eventMarketOrganizerStockEntries.toArray()
    )[0]!
    const handout = createEventMarketStockAuthorityRumor({
      createdAt: Math.floor((f.clock.now + 1) / 1000),
      payload: {
        version: 1,
        type: "handed_out",
        merchantPubkey: f.merchantPubkey,
        organizerPubkey: f.organizerPubkey,
        writerId: f.writerId,
        orderId: entry.orderId,
        identityBinding: f.purchase.orderBinding.identityHash,
        termsBinding: f.purchase.orderBinding.termsHash,
        claimRef: entry.claimRef,
        entries: [
          {
            poolId: f.poolId,
            acceptedId: entry.rumor.id,
            quantity: entry.quantity,
          },
        ],
        handedOutAtMs: f.clock.now + 1,
      },
    })
    await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
      handout: { rumor: handout },
    })
    await commitOrganizerStockOrder({
      ...f.acceptance,
      orderId: crypto.randomUUID(),
      claimRef: "a".repeat(64),
      evidence: "second exact terms",
      nowMs: f.clock.now + 2,
    })
    await prepareOrganizerStockWriterTarget({
      ...f.targetSession,
      marketCoordinate: f.marketCoordinate,
      targetDeviceId: f.targetDeviceId,
    })
    const saved = await freeze(f)
    const envelope = await wrapPrivateMessage(
      saved.outgoing!.rumor,
      { pubkey: f.organizerPubkey },
      f.organizerSigner
    )
    await restoreOrganizerStockWriterHandover({
      ...f.targetSession,
      envelope,
      expectedTargetDeviceId: f.targetDeviceId,
      nowMs: f.clock.now + 20,
    })
    const restored = await f.target.eventMarketOrganizerStockEntries.toArray()
    expect(restored.find((row) => row.id === entry.id)!.handout!.rumor.id).toBe(
      handout.id
    )
    expect(restored.find((row) => row.id !== entry.id)!.handout).toBeUndefined()
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(2)
  })

  it("bounds the complete snapshot before freeze and rolls back an aborted durable retirement", async () => {
    const f = await fixture(),
      entry = (await f.database.eventMarketOrganizerStockEntries.toArray())[0]!
    await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
      evidence: "x".repeat(8 * 1024 * 1024),
    })
    await failure(freeze(f))
    expect(
      (await f.database.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("active")
    await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
      evidence: entry.evidence,
    })
    const put = spyOn(
      f.database.eventMarketOrganizerStockWriters,
      "put"
    ).mockImplementationOnce(async () => {
      throw new Error("Controlled quota failure")
    })
    await failure(freeze(f))
    put.mockRestore()
    expect(
      (await f.database.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("active")
    expect((await commitOrganizerStockOrder(f.acceptance)).replayed).toBe(true)
  })

  it("does not strand an intact source as a target and quarantines valid or malformed/future transfer packets", async () => {
    const f = await fixture()
    await failure(
      prepareOrganizerStockWriterTarget({
        ...f.session,
        marketCoordinate: f.marketCoordinate,
        targetDeviceId: f.targetDeviceId,
      })
    )
    const saved = await freeze(f),
      rumor = saved.outgoing!.rumor
    expect(decodeCommerceMessageRumor(rumor).category).toBe("machine")
    expect(
      decodeCommerceMessageRumor({ ...rumor, content: "not json" }).category
    ).toBe("machine")
    expect(
      decodeCommerceMessageRumor({
        ...rumor,
        tags: [["conduit", "event-stock-handover", "99"]],
      }).category
    ).toBe("machine")
    expect(
      JSON.stringify(parseOrganizerStockWriterHandoverRumor(rumor))
    ).not.toContain(f.initial.wallet.mnemonic)
  })

  it("transfers thirty actual prepared acceptance/handout orders as an all-required chunk bundle, retries only unacknowledged exact packets and never partially activates", async () => {
    const f = await fixture(40)
    for (let index = 0; index < 30; index++) {
      const orderId = index === 0 ? f.plan.orderId : crypto.randomUUID()
      const claimRef =
        index === 0 ? f.purchase.claimRef : index.toString(16).padStart(64, "0")
      const acceptedAtMs = f.clock.now + index
      const result = await commitOrganizerStockOrder({
        ...f.acceptance,
        orderId,
        claimRef,
        evidence:
          index === 0
            ? f.acceptance.evidence
            : `retained bounded original terms ${index}`,
        nowMs: acceptedAtMs,
      })
      const entry = result.entries[0]!
      await prepareOrganizerStockEnvelopes({
        ...f.session,
        poolId: f.poolId,
        work: { entryId: entry.rumor.id },
      })
      const handout = createEventMarketStockAuthorityRumor({
        createdAt: Math.floor(acceptedAtMs / 1000),
        payload: {
          version: 1,
          type: "handed_out",
          merchantPubkey: f.merchantPubkey,
          organizerPubkey: f.organizerPubkey,
          writerId: f.writerId,
          orderId,
          identityBinding: f.purchase.orderBinding.identityHash,
          termsBinding: f.purchase.orderBinding.termsHash,
          claimRef,
          entries: [
            {
              poolId: f.poolId,
              acceptedId: entry.rumor.id,
              quantity: entry.quantity,
            },
          ],
          handedOutAtMs: acceptedAtMs,
        },
      })
      const recipient = await wrapPrivateMessage(
        handout,
        { pubkey: f.merchantPubkey },
        f.organizerSigner
      )
      const self = await wrapPrivateMessage(
        handout,
        { pubkey: f.organizerPubkey },
        f.organizerSigner
      )
      await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
        handout: { rumor: handout, wraps: { recipient, self } },
      })
    }
    const expected = await f.database.eventMarketOrganizerStockEntries.toArray()
    const saved = await beginOrganizerStockWriterHandover({
      ...f.session,
      marketCoordinate: f.marketCoordinate,
      writerId: f.writerId,
      targetDeviceId: f.targetDeviceId,
      nowMs: f.clock.now + 40,
    })
    expect(
      new TextEncoder().encode(saved.outgoing!.rumor.content).length
    ).toBeGreaterThan(500_000)
    expect(saved.outgoing!.packets!.length).toBeGreaterThan(8)
    expect(
      parseStockWriterPacket(saved.outgoing!.packets![0]!.rumor).type
    ).toBe("manifest")
    let attempts = 0
    const partialSends: string[] = []
    const delivery = transport(partialSends)
    await failure(
      publishOrganizerStockWriterHandover({
        ...f.session,
        marketCoordinate: f.marketCoordinate,
        delivery: {
          ...delivery,
          publishFn: async (event) => {
            const current =
              await f.database.eventMarketOrganizerStockWriters.get(f.key)
            expect(
              current!.outgoing!.packets!.every((packet) => packet.envelope)
            ).toBe(true)
            if (++attempts === 3)
              throw new Error("Controlled interrupted part delivery")
            return delivery.publishFn(event)
          },
        },
      })
    )
    const staged = (await f.database.eventMarketOrganizerStockWriters.get(
      f.key
    ))!.outgoing!
    expect(
      staged.packets!.slice(0, 2).every((part) => part.relayAccepted)
    ).toBe(true)
    const exactIds = staged.packets!.map((part) => part.envelope!.id)
    f.database.close()
    await f.database.open()
    const retrySends: string[] = []
    const complete = await publishOrganizerStockWriterHandover({
      ...f.session,
      marketCoordinate: f.marketCoordinate,
      delivery: transport(retrySends),
    })
    expect(complete.relayAccepted).toBe(true)
    expect(complete.envelopes.map((envelope) => envelope.id)).toEqual(exactIds)
    expect(retrySends).not.toContain(exactIds[0]!)
    expect(retrySends).not.toContain(exactIds[1]!)
    await prepareOrganizerStockWriterTarget({
      ...f.targetSession,
      marketCoordinate: f.marketCoordinate,
      targetDeviceId: f.targetDeviceId,
    })
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope: complete.envelope,
        envelopes: complete.envelopes.slice(0, -1),
        expectedTargetDeviceId: f.targetDeviceId,
        nowMs: f.clock.now + 50,
      })
    )
    expect(await f.target.eventMarketOrganizerStockPools.count()).toBe(0)
    expect(
      (await f.target.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("target")
    const part = staged.packets![1]!.rumor
    const altered = JSON.parse(part.content)
    altered.data = altered.data.slice(0, -4) + "AAAA"
    const alteredRumor = createPrivateMessageRumor({
      ...part,
      content: JSON.stringify(altered),
    })
    const alteredEnvelope = await wrapPrivateMessage(
      alteredRumor,
      { pubkey: f.organizerPubkey },
      f.organizerSigner
    )
    await failure(
      restoreOrganizerStockWriterHandover({
        ...f.targetSession,
        envelope: complete.envelope,
        envelopes: [
          complete.envelope,
          alteredEnvelope,
          ...complete.envelopes.slice(2),
        ],
        expectedTargetDeviceId: f.targetDeviceId,
        nowMs: f.clock.now + 50,
      })
    )
    await restoreOrganizerStockWriterHandover({
      ...f.targetSession,
      envelope: complete.envelope,
      envelopes: [...complete.envelopes]
        .reverse()
        .concat(complete.envelopes[1]!),
      expectedTargetDeviceId: f.targetDeviceId,
      nowMs: f.clock.now + 50,
    })
    expect(await f.target.eventMarketOrganizerStockEntries.toArray()).toEqual(
      expected
    )
    expect(
      (await f.target.eventMarketOrganizerStockPools.toArray())[0]!
        .acceptedQuantity
    ).toBe(30)
  }, 30_000)

  it("rejects a positively installed missing pool or orphaned accepted entry before source freeze", async () => {
    const f = await fixture()
    const original = (
      await f.database.eventMarketOrganizerStockPools.toArray()
    )[0]!
    await f.database.eventMarketOrganizerStockPools.delete(original.id)
    await failure(freeze(f))
    expect(
      (await f.database.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("active")
    await f.database.eventMarketOrganizerStockPools.put(original)
    await f.database.eventMarketOrganizerStockWriters.update(f.key, {
      installedPoolIds: [original.poolId, "f".repeat(64)],
    })
    await failure(freeze(f))
    expect(
      (await f.database.eventMarketOrganizerStockWriters.get(f.key))!.state
    ).toBe("active")
  })

  it("pages beyond4096 retained unrelated wrappers, accumulates authentic chunks across calls and revokes a cross-scope/disposed cursor", async () => {
    const f = await fixture()
    const entry = (
      await f.database.eventMarketOrganizerStockEntries.toArray()
    )[0]!
    await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
      evidence: "retained exact original terms ".repeat(2200),
    })
    await prepareOrganizerStockEnvelopes({
      ...f.session,
      poolId: f.poolId,
      work: { entryId: entry.rumor.id },
    })
    await freeze(f)
    const bundle = await publishOrganizerStockWriterHandover({
      ...f.session,
      marketCoordinate: f.marketCoordinate,
      delivery: transport([]),
    })
    expect(bundle.envelopes.length).toBeGreaterThan(1)
    installProtectedReadSigner(
      f.organizerSigner,
      f.organizerPubkey,
      () => f.clock.active
    )
    const store = new CommerceInboxStore(
      getProtectedReadAuthorization(f.organizerPubkey)!,
      f.target
    )
    // These unrelated legacy rows are inert bookkeeping, never authority. Every
    // transfer candidate below is a genuine runtime-key NIP-59 envelope.
    await f.target.commerceInboxWrappers.bulkPut(
      Array.from({ length: 4097 }, (_, index) => ({
        id: store.key(index.toString(16).padStart(64, "0")),
        accountPubkey: f.organizerPubkey,
        event: bundle.envelope,
        sources: [],
        observedAt: 0,
        state: "unrelated" as const,
        rulesVersion: 1,
        attempts: 0,
      }))
    )
    for (const envelope of bundle.envelopes) await store.receive(envelope)
    let cursor: OrganizerStockWriterHandoverCursor | undefined
    let calls = 0,
      found = false,
      hasMore = true
    while (hasMore && calls++ < 40) {
      const page = await readOrganizerStockWriterHandovers({
        ...f.targetSession,
        store,
        marketCoordinate: f.marketCoordinate,
        targetDeviceId: f.targetDeviceId,
        cursor,
      })
      cursor = page.cursor
      hasMore = page.hasMore
      expect(page.capped).toBe(false)
      if (page.selections.length) {
        found = true
        expect(
          page.selections[0]!.envelopes.map((envelope) => envelope.id).sort()
        ).toEqual(bundle.envelopes.map((envelope) => envelope.id).sort())
      }
    }
    expect(calls).toBeGreaterThan(32)
    expect(hasMore).toBe(false)
    expect(found).toBe(true)
    await failure(
      readOrganizerStockWriterHandovers({
        ...f.targetSession,
        store,
        marketCoordinate: f.marketCoordinate,
        targetDeviceId: crypto.randomUUID(),
        cursor,
      })
    )
    const restarted = await readOrganizerStockWriterHandovers({
      ...f.targetSession,
      store,
      marketCoordinate: f.marketCoordinate,
      targetDeviceId: f.targetDeviceId,
    })
    disposeOrganizerStockWriterHandoverCursor(restarted.cursor)
    await failure(
      readOrganizerStockWriterHandovers({
        ...f.targetSession,
        store,
        marketCoordinate: f.marketCoordinate,
        targetDeviceId: f.targetDeviceId,
        cursor: restarted.cursor,
      })
    )
  }, 15_000)

  it("keeps retained primary-key pages account-scoped, stable and bounded", async () => {
    const f = await fixture()
    installProtectedReadSigner(
      f.organizerSigner,
      f.organizerPubkey,
      () => f.clock.active
    )
    const store = new CommerceInboxStore(
      getProtectedReadAuthorization(f.organizerPubkey)!,
      f.target
    )
    const base = {
      event: f.stockEnvelope,
      sources: [],
      observedAt: 1,
      state: "unrelated" as const,
      rulesVersion: 1,
      attempts: 0,
    }
    const first = store.key("1".repeat(64)),
      second = store.key("2".repeat(64))
    await f.target.commerceInboxWrappers.bulkPut([
      { ...base, id: first, accountPubkey: f.organizerPubkey },
      { ...base, id: second, accountPubkey: f.organizerPubkey },
      {
        ...base,
        id: store.key("0".repeat(64)),
        accountPubkey: f.merchantPubkey,
      },
      {
        ...base,
        id: `${f.merchantPubkey}:${"3".repeat(64)}`,
        accountPubkey: f.merchantPubkey,
      },
    ])
    const page = await store.wrappersPage({ limit: 1 })
    expect(page.rows.map((row) => row.id)).toEqual([first])
    expect(page.hasMore).toBe(true)
    const next = await store.wrappersPage({ afterId: first, limit: 1 })
    expect(next.rows.map((row) => row.id)).toEqual([second])
    expect(next.hasMore).toBe(false)
    expect(
      (await store.wrappersPage({ afterId: second, limit: 1 })).rows
    ).toHaveLength(0)
    await failure(
      store.wrappersPage({ afterId: `${f.merchantPubkey}:other`, limit: 1 })
    )
    await failure(store.wrappersPage({ limit: 129 }))
  })
})
