import { afterEach, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  beginOrganizerStockWriterHandover,
  prepareOrganizerStockWriterTarget,
  registerOrganizerStockWriterDevice,
  restoreOrganizerStockWriterHandover,
} from "@conduit/core/protocol/event-market-stock-writer-handover"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import {
  confirmOrganizerStockDeviceRegistration,
  createOrganizerStockDevice,
  organizerStockDeviceId,
  prepareOrganizerStockTargetDevice,
  readOrganizerStockDevice,
  reserveOrganizerStockInstallation,
} from "../apps/merchant/src/lib/event-market-stock-handover"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}
async function rejects(operation: Promise<unknown>) {
  let rejected = false
  try {
    await operation
  } catch {
    rejected = true
  }
  expect(rejected).toBe(true)
}
async function fixture() {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  const market = f.plan.eventMarket!.marketCoordinate
  const storage = memoryStorage()
  const pool = (await f.database.eventMarketOrganizerStockPools.toArray())[0]!
  storage.setItem(
    `conduit:event-stock-device:1:${f.organizerPubkey}:${market}`,
    JSON.stringify({
      version: 1,
      writerId: f.writerId,
      installedPoolIds: [pool.poolId],
    })
  )
  const session = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  const projection = {
    db: f.database,
    storage,
    account: f.organizerPubkey,
    market,
    expectedDeviceId: f.writerId,
    shouldContinue: () => f.clock.active,
  }
  return { ...f, market, storage, pool, session, projection }
}

it("migrates an original v1 device only after exact intact local cohort registration", async () => {
  const f = await fixture()
  expect(
    readOrganizerStockDevice(f.storage, f.organizerPubkey, f.market)?.version
  ).toBe(1)
  await rejects(confirmOrganizerStockDeviceRegistration(f.projection))
  await rejects(
    registerOrganizerStockWriterDevice({
      ...f.session,
      marketCoordinate: f.market,
      writerId: f.writerId,
      deviceId: f.writerId,
      expectedPoolIds: [],
    })
  )
  await registerOrganizerStockWriterDevice({
    ...f.session,
    marketCoordinate: f.market,
    writerId: f.writerId,
    deviceId: f.writerId,
    expectedPoolIds: [f.pool.poolId],
  })
  const confirmed = await confirmOrganizerStockDeviceRegistration(f.projection)
  expect(confirmed.version).toBe(2)
  expect(organizerStockDeviceId(confirmed)).toBe(f.writerId)
  expect(confirmed.installedPoolIds).toEqual([f.pool.poolId])
  expect(confirmed.mode).toBe("writer")
})

it("prepares a fresh stable replacement ID without adopting a relay writer or enabling stock", async () => {
  const f = await fixture()
  const storage = memoryStorage()
  const target = prepareOrganizerStockTargetDevice({
    storage,
    account: f.organizerPubkey,
    market: f.market,
    hasRetainedPools: false,
  })
  expect(target.mode).toBe("target")
  expect(target.writerId).toBe(organizerStockDeviceId(target))
  expect(target.writerId === f.writerId).toBe(false)
  expect(
    prepareOrganizerStockTargetDevice({
      storage,
      account: f.organizerPubkey,
      market: f.market,
      hasRetainedPools: false,
    }).deviceId
  ).toBe(target.deviceId)
  expect(() =>
    createOrganizerStockDevice({
      storage,
      account: f.organizerPubkey,
      market: f.market,
      hasRetainedPools: false,
    })
  ).toThrow()
  expect(() =>
    reserveOrganizerStockInstallation({
      storage,
      account: f.organizerPubkey,
      market: f.market,
      poolId: f.pool.poolId,
      writerId: target.writerId,
    })
  ).toThrow()
  expect(() =>
    prepareOrganizerStockTargetDevice({
      storage: f.storage,
      account: f.organizerPubkey,
      market: f.market,
      hasRetainedPools: true,
    })
  ).toThrow()
  await rejects(
    confirmOrganizerStockDeviceRegistration({
      ...f.projection,
      storage,
      expectedDeviceId: target.deviceId!,
    })
  )
})

it("adopts the original logical writer only after an authenticated complete handover to the preselected target", async () => {
  const f = await fixture()
  await registerOrganizerStockWriterDevice({
    ...f.session,
    marketCoordinate: f.market,
    writerId: f.writerId,
    deviceId: f.writerId,
    expectedPoolIds: [f.pool.poolId],
  })
  const targetDb = new ConduitDB(`stock-device-target-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(targetDb)
  const storage = memoryStorage()
  const target = prepareOrganizerStockTargetDevice({
    storage,
    account: f.organizerPubkey,
    market: f.market,
    hasRetainedPools: false,
  })
  const targetSession = { ...f.session, db: targetDb }
  await prepareOrganizerStockWriterTarget({
    ...targetSession,
    marketCoordinate: f.market,
    targetDeviceId: target.deviceId!,
  })
  const targetProjection = {
    ...f.projection,
    db: targetDb,
    storage,
    expectedDeviceId: target.deviceId!,
  }
  await rejects(confirmOrganizerStockDeviceRegistration(targetProjection))
  const frozen = await beginOrganizerStockWriterHandover({
    ...f.session,
    marketCoordinate: f.market,
    writerId: f.writerId,
    targetDeviceId: target.deviceId!,
    nowMs: f.clock.now,
  })
  expect(frozen.state).toBe("retired")
  await rejects(confirmOrganizerStockDeviceRegistration(f.projection))
  const envelope = await wrapPrivateMessage(
    frozen.outgoing!.rumor,
    { pubkey: f.organizerPubkey },
    f.organizerSigner,
    { rumorKind: 14 }
  )
  const restored = await restoreOrganizerStockWriterHandover({
    ...targetSession,
    envelope,
    expectedTargetDeviceId: target.deviceId!,
    nowMs: f.clock.now,
  })
  await rejects(
    confirmOrganizerStockDeviceRegistration({
      ...targetProjection,
      restored: {
        ...restored,
        transferId: f.initial.handoffId,
      },
    })
  )
  const confirmed = await confirmOrganizerStockDeviceRegistration({
    ...targetProjection,
    restored,
  })
  expect(confirmed.writerId).toBe(f.writerId)
  expect(confirmed.deviceId).toBe(target.deviceId)
  expect(confirmed.writerId === confirmed.deviceId).toBe(false)
  expect(confirmed.installedPoolIds).toEqual([f.pool.poolId])
  expect(confirmed.transferId).toBe(restored.transferId)
  expect(confirmed.generation).toBe(1)
  const current = await targetDb.eventMarketOrganizerStockPools.get(f.pool.id)
  expect(current?.writerId).toBe(f.writerId)
  expect(() =>
    reserveOrganizerStockInstallation({
      storage,
      account: f.organizerPubkey,
      market: f.market,
      poolId: f.pool.poolId,
      writerId: f.writerId,
    })
  ).toThrow("journal is missing")
  expect(
    reserveOrganizerStockInstallation({
      storage,
      account: f.organizerPubkey,
      market: f.market,
      poolId: f.pool.poolId,
      writerId: f.writerId,
      existingPool: current!,
    }).writerId
  ).toBe(f.writerId)
  f.clock.active = false
  await rejects(
    confirmOrganizerStockDeviceRegistration({ ...targetProjection, restored })
  )
})
