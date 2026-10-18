import { afterEach, expect, test } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import {
  ACCOUNT_STORAGE_RELAYS,
  LEGACY_ACCOUNT_STORAGE_RELAYS,
} from "../packages/core/src/config"
import { migrateAccountStorageRelayState } from "../packages/core/src/wallets/account-storage-relay-migration"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  accountRegistryReadiness,
  mergeSparkRecoveryRecords,
  type SparkRecoveryState,
} from "../packages/core/src/wallets/spark-recovery-service"
import { DexieWalletNameStore } from "../packages/core/src/wallets/wallet-name-store"
import { DexieAddressRequestStore } from "../packages/core/src/wallets/address-request-store"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
function fixture() {
  const secret = generateSecretKey(),
    owner = getPublicKey(secret)
  const event = finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "conduit:spark:wallet:v1:" + crypto.randomUUID()]],
      content: v2.encrypt(
        "opaque migration fixture",
        v2.utils.getConversationKey(secret, owner)
      ),
    },
    secret
  )
  const targets = LEGACY_ACCOUNT_STORAGE_RELAYS.map((target) => ({ ...target }))
  const state: SparkRecoveryState = {
    ownerPubkey: owner,
    unresolvedObserved: true,
    removedWalletIds: [crypto.randomUUID()],
    registryExcludedWalletIds: [crypto.randomUUID()],
    records: [
      {
        event,
        targets,
        exported: true,
        delivery: targets.map(({ url }) => ({
          url,
          status: "acked",
          accepted: true,
          readBack: true,
          lastRead: "present",
          checkedAt: Date.now(),
        })),
      },
    ],
  }
  return { owner, state, secret }
}

test("installed delivery plans retain original bytes, receipts and removals without inventing new proof", () => {
  const { state } = fixture(),
    before = structuredClone(state)
  const next = migrateAccountStorageRelayState(state)
  expect(JSON.stringify(state) === JSON.stringify(before)).toBe(true)
  expect(next.records[0].event).toEqual(before.records[0].event)
  expect(next.records[0].targets).toEqual(before.records[0].targets)
  expect(next.records[0].delivery).toEqual(before.records[0].delivery)
  expect(next.removedWalletIds).toEqual(before.removedWalletIds)
  expect(next.registryExcludedWalletIds).toEqual(
    before.registryExcludedWalletIds
  )
  expect(next.unresolvedObserved).toBe(true)
  expect(next.records[0].exported).toBe(true)
  const active = next.records[0].activeRelayPolicy!
  expect(active.targets).toEqual(ACCOUNT_STORAGE_RELAYS)
  expect(active.delivery[0]).toEqual(before.records[0].delivery[0])
  expect(active.delivery[1].accepted).toBe(false)
  expect(active.delivery[1].readBack).toBe(false)
  expect(accountRegistryReadiness(next.records[0]).ready).toBe(false)
  expect(migrateAccountStorageRelayState(next)).toEqual(next)
})

test("migration validates without persisting the normal compact choice projection", async () => {
  const { owner, state, secret } = fixture()
  const original = state.records[0]
  const time = original.event.created_at
  state.records = [time - 1, time].map((created_at) => ({
    ...structuredClone(original),
    event: finalizeEvent(
      {
        kind: 30078,
        created_at,
        tags: [["d", "conduit:spark:primary:v1:mainnet"]],
        content: original.event.content,
      },
      secret
    ),
  }))
  const events = state.records.map(({ event }) =>
    JSON.parse(JSON.stringify(event))
  )
  const db = new ConduitDB("storage-relay-history-" + crypto.randomUUID(), {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  await db.sparkRecoveryEvidence.put(state)
  const store = new DexieSparkRecoveryStore(db)
  expect((await store.load(owner)).records).toHaveLength(1)
  await store.migrateRelayPolicy(owner, () => true)
  const persisted = (await db.sparkRecoveryEvidence.get(owner))!
  expect(persisted.records.map(({ event }) => event)).toEqual(events)
  expect(
    persisted.records.every(
      (record) =>
        record.activeRelayPolicy?.targets.length ===
        ACCOUNT_STORAGE_RELAYS.length
    )
  ).toBe(true)
})

test("stale writers merge historical receipts without erasing the new plan", () => {
  const { state } = fixture()
  const migrated = migrateAccountStorageRelayState(state)
  migrated.records[0].activeRelayPolicy!.delivery[1] = {
    ...migrated.records[0].activeRelayPolicy!.delivery[1],
    accepted: true,
    readBack: true,
    lastRead: "present",
    checkedAt: Date.now(),
  }
  const merged = mergeSparkRecoveryRecords(migrated, state.records)
  expect(merged.records[0].activeRelayPolicy).toEqual(
    migrated.records[0].activeRelayPolicy
  )
  expect(merged.records[0].event).toEqual(
    JSON.parse(JSON.stringify(state.records[0].event))
  )
})

test("unrecognized and caller-selected target plans are retained unchanged", () => {
  const { state } = fixture()
  state.records[0].targets[0].url = "wss://relay.primal.net"
  state.records[0].delivery[0].url = "wss://relay.primal.net"
  expect(
    migrateAccountStorageRelayState(state).records[0].activeRelayPolicy
  ).toBeUndefined()
})

test("transactional transition rolls back on account replacement and survives reopen", async () => {
  const { owner, state } = fixture()
  const db = new ConduitDB("storage-relay-upgrade-" + crypto.randomUUID(), {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  await db.sparkRecoveryEvidence.put(state)
  const store = new DexieSparkRecoveryStore(db)
  let checks = 0
  await expect(
    store.migrateRelayPolicy(owner, () => ++checks < 3)
  ).rejects.toMatchObject({ code: "conflict" })
  expect(await store.load(owner)).toEqual(JSON.parse(JSON.stringify(state)))
  await store.migrateRelayPolicy(owner, () => true)
  expect(
    (await new DexieSparkRecoveryStore(db).load(owner)).records[0]
      .activeRelayPolicy?.targets
  ).toEqual(ACCOUNT_STORAGE_RELAYS)
  await store.retain(owner, state.records)
  expect(
    (await store.load(owner)).records[0].activeRelayPolicy?.targets
  ).toEqual(ACCOUNT_STORAGE_RELAYS)
})

test("optional journal owners migrate pending targets without changing events, tokens or recovery state", async () => {
  const secret = generateSecretKey(),
    owner = getPublicKey(secret)
  const event = (coordinate: string) =>
    finalizeEvent(
      {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", coordinate]],
        content: v2.encrypt(
          "opaque optional migration fixture",
          v2.utils.getConversationKey(secret, owner)
        ),
      },
      secret
    )
  const namesEvent = event("conduit:wallet-names:v1:mainnet")
  const requestEvent = event("conduit:address-requests:v1:mainnet")
  const walletId = crypto.randomUUID(),
    token = crypto.randomUUID()
  const targets = LEGACY_ACCOUNT_STORAGE_RELAYS.map(({ url }) => url)
  const db = new ConduitDB("optional-relay-upgrade-" + crypto.randomUUID(), {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  const row: SparkRecoveryState = {
    ownerPubkey: owner,
    records: [],
    unresolvedObserved: true,
    removedWalletIds: [crypto.randomUUID()],
    walletNameSync: {
      mainnet: {
        pending: { [walletId]: { name: "Pending name", token } },
        operation: {
          event: namesEvent,
          targets,
          intents: { [walletId]: token },
        },
      },
    },
    addressRequestSync: {
      mainnet: { operation: { event: requestEvent, targets } },
    },
  }
  await db.sparkRecoveryEvidence.put(row)
  const names = await new DexieWalletNameStore(db).load(owner, "mainnet")
  const requests = await new DexieAddressRequestStore(db).load(owner, "mainnet")
  expect(names.operation?.event).toEqual(JSON.parse(JSON.stringify(namesEvent)))
  expect(requests.operation?.event).toEqual(
    JSON.parse(JSON.stringify(requestEvent))
  )
  expect(names.pending[walletId].token).toBe(token)
  expect(names.operation?.intents[walletId]).toBe(token)
  expect(names.operation?.targets).toEqual(targets)
  expect(requests.operation?.targets).toEqual(targets)
  const current = ACCOUNT_STORAGE_RELAYS.map(({ url }) => url)
  expect(names.operation?.relayPolicyTargets).toEqual(current)
  expect(requests.operation?.relayPolicyTargets).toEqual(current)
  const saved = (await db.sparkRecoveryEvidence.get(owner))!
  expect(saved.removedWalletIds).toEqual(row.removedWalletIds)
  expect(saved.unresolvedObserved).toBe(true)
  expect(await new DexieWalletNameStore(db).load(owner, "mainnet")).toEqual(
    names
  )
})
