import { afterEach, describe, expect, it, spyOn } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  commitOrganizerStockOrder,
  prepareOrganizerStockEnvelopes,
} from "@conduit/core/protocol/event-market-stock-journal"
import {
  beginOrganizerStockWriterHandover,
  registerOrganizerStockWriterDevice,
} from "@conduit/core/protocol/event-market-stock-writer-handover"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const current = await checkoutSparkOrganizerFixture()
  databases.push(current.database)
  const session = {
    db: current.database,
    signer: current.organizerSigner,
    authenticatedPubkey: current.organizerPubkey,
    shouldContinue: () => current.clock.active,
  }
  const marketCoordinate = current.eventMarket.marketCoordinate
  await registerOrganizerStockWriterDevice({
    ...session,
    marketCoordinate,
    writerId: current.writerId,
    deviceId: current.writerId,
    expectedPoolIds: [current.stockGrant!.id],
  })
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(
    current.authority
  )
  const accepted = await commitOrganizerStockOrder({
    ...session,
    writerId: current.writerId,
    orderId: current.plan.orderId,
    identityBinding: purchase.orderBinding.identityHash,
    termsBinding: purchase.orderBinding.termsHash,
    claimRef: purchase.claimRef,
    entries: purchase.writerBindings,
    evidence: JSON.stringify({
      handoffId: purchase.handoffId,
      planDigest: current.plan.planDigest,
      orderBinding: purchase.orderBinding,
    }),
    nowMs: current.clock.now,
  })
  const freeze = () =>
    beginOrganizerStockWriterHandover({
      ...session,
      marketCoordinate,
      writerId: current.writerId,
      targetDeviceId: crypto.randomUUID(),
      nowMs: current.clock.now + 10,
    })
  return { ...current, session, freeze, entryId: accepted.entries[0]!.rumor.id }
}

describe("organizer writer fences after external signer work", () => {
  it("rejects an existing financial capability when its grant unwrap finishes after retirement", async () => {
    const current = await fixture()
    const entered = deferred()
    const release = deferred()
    let paused = false
    const decrypt = current.organizerSigner.decryptNip44.bind(
      current.organizerSigner
    )
    const decryptSpy = spyOn(
      current.organizerSigner,
      "decryptNip44"
    ).mockImplementation(async (...args) => {
      if (!paused) {
        paused = true
        entered.resolve()
        await release.promise
      }
      return decrypt(...args)
    })
    const outcome = assertCheckoutSparkOrganizerRecoveryWriterCurrent(
      current.authority
    ).then(
      () => null,
      (error: unknown) => error
    )
    try {
      await entered.promise
      expect((await current.freeze()).state).toBe("retired")
      release.resolve()
      expect(await outcome).toBeInstanceOf(Error)
      expect(
        (await current.database.eventMarketOrganizerStockPools.toArray())[0]!
          .acceptedQuantity
      ).toBe(1)
    } finally {
      release.resolve()
      await outcome
      decryptSpy.mockRestore()
    }
  })

  it("does not return cached delivery bytes when identity confirmation finishes after retirement", async () => {
    const current = await fixture()
    await prepareOrganizerStockEnvelopes({
      ...current.session,
      poolId: current.stockGrant!.id,
      work: { entryId: current.entryId },
    })
    const before = await current.database.eventMarketOrganizerStockEntries.get(
      `${current.organizerPubkey}:${current.entryId}`
    )
    expect(Boolean(before?.wraps)).toBe(true)
    const entered = deferred()
    const release = deferred()
    const publicKey = current.organizerSigner.getPublicKey.bind(
      current.organizerSigner
    )
    let confirmations = 0
    const identitySpy = spyOn(
      current.organizerSigner,
      "getPublicKey"
    ).mockImplementation(async () => {
      // Initial session, selected work, then confirmation after the first
      // writer observation. The real account signer remains unchanged.
      if (++confirmations === 3) {
        entered.resolve()
        await release.promise
      }
      return publicKey()
    })
    const outcome = prepareOrganizerStockEnvelopes({
      ...current.session,
      poolId: current.stockGrant!.id,
      work: { entryId: current.entryId },
    }).then(
      () => null,
      (error: unknown) => error
    )
    try {
      await entered.promise
      expect((await current.freeze()).state).toBe("retired")
      release.resolve()
      expect(await outcome).toBeInstanceOf(Error)
      const after = await current.database.eventMarketOrganizerStockEntries.get(
        `${current.organizerPubkey}:${current.entryId}`
      )
      expect(
        JSON.stringify(after?.wraps) === JSON.stringify(before?.wraps)
      ).toBe(true)
    } finally {
      release.resolve()
      await outcome
      identitySpy.mockRestore()
    }
  })
})
