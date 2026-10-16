import { afterEach, describe, expect, it } from "bun:test"
import Dexie from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import {
  SPARK_RECOVERY_KIND,
  SPARK_RECOVERY_PREFIX,
} from "../packages/core/src/wallets/spark-recovery-contract"
import {
  SPARK_RECOVERY_RENDEZVOUS,
  type SparkRecoveryRecord,
  type SparkRecoveryState,
} from "../packages/core/src/wallets/spark-recovery-service"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
function newStore() {
  const database = new ConduitDB(
    "spark-store-boundary-" + crypto.randomUUID(),
    { indexedDB, IDBKeyRange }
  )
  databases.push(database)
  return { database, store: new DexieSparkRecoveryStore(database) }
}
function signedRecord(secret = generateSecretKey()) {
  const owner = getPublicKey(secret)
  const signed = finalizeEvent(
    {
      kind: SPARK_RECOVERY_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", SPARK_RECOVERY_PREFIX + crypto.randomUUID()]],
      // A disposable encrypted probe, not a wallet credential or recovery seed.
      content: v2.encrypt(
        "conduit.spark.store-boundary.v1:" + crypto.randomUUID(),
        v2.utils.getConversationKey(secret, owner)
      ),
    },
    secret
  )
  const event = {
    id: signed.id,
    pubkey: signed.pubkey,
    kind: signed.kind,
    created_at: signed.created_at,
    tags: signed.tags.map((tag) => [...tag]),
    content: signed.content,
    sig: signed.sig,
  }
  const targets = SPARK_RECOVERY_RENDEZVOUS.map((target) => ({ ...target }))
  const record: SparkRecoveryRecord = {
    event,
    targets,
    delivery: targets.map((target) => ({
      url: target.url,
      status: "pending",
      accepted: false,
      readBack: false,
      lastRead: "not_queried",
      checkedAt: 0,
    })),
    exported: false,
  }
  return { owner, record, event }
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Spark recovery store public trust boundary", () => {
  it("rejects a non-string relay target instead of treating disabled isolation as an exception", async () => {
    const { store } = newStore()
    const { owner, record } = signedRecord()
    record.targets[0].url = null as unknown as string
    record.delivery[0].url = record.targets[0].url
    await expect(store.retain(owner, [record])).rejects.toMatchObject({
      code: "invalid_record",
    })
    expect((await store.load(owner)).records.length).toBe(0)
  })

  it("rejects duplicate relay targets even after the URL was validated", async () => {
    const { store } = newStore()
    const { owner, record } = signedRecord()
    await store.retain(owner, [record])
    const before = await store.load(owner)
    const duplicate = structuredClone(record)
    duplicate.targets[1].url = duplicate.targets[0].url
    duplicate.delivery[1].url = duplicate.targets[0].url
    await expect(store.retain(owner, [duplicate])).rejects.toMatchObject({
      code: "invalid_record",
    })
    expect(
      JSON.stringify(await store.load(owner)) === JSON.stringify(before)
    ).toBe(true)
  })

  it("preserves distinct raw relay spellings and their curated operator bindings", async () => {
    const { store } = newStore()
    const { owner, record } = signedRecord()
    const raw = record.targets[0].url + "/"
    record.targets[1].url = raw
    record.targets[1].operator = record.targets[0].operator
    record.delivery[1].url = raw
    await store.retain(owner, [record])
    const saved = await store.load(owner)
    expect(saved.records[0].targets[0].url === record.targets[0].url).toBe(true)
    expect(saved.records[0].targets[1].url === raw).toBe(true)
    expect(
      saved.records[0].targets[0].operator === record.targets[0].operator
    ).toBe(true)
    expect(saved.records[0].targets[1].operator).toBeNull()
  })

  it("checks every record sharing relay targets and normalizes operator labels", async () => {
    const { store } = newStore()
    const secret = generateSecretKey()
    const first = signedRecord(secret)
    const second = signedRecord(secret)
    await store.retain(first.owner, [first.record])
    const before = await store.load(first.owner)
    for (const target of second.record.targets) target.operator = "untrusted"
    second.record.delivery[0].checkedAt = -1
    await expect(
      store.retain(first.owner, [first.record, second.record])
    ).rejects.toMatchObject({ code: "invalid_record" })
    expect(
      JSON.stringify(await store.load(first.owner)) === JSON.stringify(before)
    ).toBe(true)

    second.record.delivery[0].checkedAt = 0
    await store.retain(first.owner, [first.record, second.record])
    const saved = await store.load(first.owner)
    expect(saved.records.length).toBe(2)
    expect(
      saved.records.every((record) =>
        record.targets.every(
          (target) =>
            target.operator ===
            SPARK_RECOVERY_RENDEZVOUS.find((known) => known.url === target.url)
              ?.operator
        )
      )
    ).toBe(true)
  })

  it("rejects an otherwise valid foreign-owner row before any write", async () => {
    const { database, store } = newStore()
    const requested = signedRecord()
    const foreign = signedRecord()
    await store.retain(requested.owner, [requested.record])
    await store.retain(foreign.owner, [foreign.record])
    const requestedBefore = await store.load(requested.owner)
    const foreignBefore = await store.load(foreign.owner)
    const substitute = (state: SparkRecoveryState | undefined) =>
      state?.ownerPubkey === requested.owner
        ? structuredClone(foreignBefore)
        : state
    let writes = 0
    const countWrite = () => {
      writes++
    }
    database.sparkRecoveryEvidence.hook("reading", substitute)
    database.sparkRecoveryEvidence.hook("creating", countWrite)
    database.sparkRecoveryEvidence.hook("updating", countWrite)
    try {
      await expect(store.load(requested.owner)).rejects.toMatchObject({
        code: "invalid_record",
      })
      // Empty incoming records allow the foreign state to pass merge validation
      // if the explicit requested-owner check is accidentally removed.
      await expect(
        store.retain(requested.owner, [], true)
      ).rejects.toMatchObject({
        code: "invalid_record",
      })
      expect(writes).toBe(0)
    } finally {
      database.sparkRecoveryEvidence.hook("reading").unsubscribe(substitute)
      database.sparkRecoveryEvidence.hook("creating").unsubscribe(countWrite)
      database.sparkRecoveryEvidence.hook("updating").unsubscribe(countWrite)
    }
    // Boolean comparisons keep generated identities and ciphertext out of failures.
    expect(
      JSON.stringify(await store.load(requested.owner)) ===
        JSON.stringify(requestedBefore)
    ).toBe(true)
    expect(
      JSON.stringify(await store.load(foreign.owner)) ===
        JSON.stringify(foreignBefore)
    ).toBe(true)
  })

  for (const [fault, code] of [
    ["signed_bytes", "invalid_record"],
    ["valid_metadata", "storage_unavailable"],
  ] as const) {
    it("rolls back a corrupt read-back: " + fault, async () => {
      const { database, store } = newStore()
      const { owner, record } = signedRecord()
      await store.retain(owner, [record])
      const before = await store.load(owner)
      const incoming = structuredClone(record)
      incoming.exported = true
      let injected = false
      const corruptReadBack = (state: SparkRecoveryState | undefined) => {
        if (
          state?.ownerPubkey !== owner ||
          !state.records.some((saved) => saved.exported)
        )
          return state
        injected = true
        const corrupted = structuredClone(state)
        if (fault === "signed_bytes") corrupted.records[0].event.created_at++
        else corrupted.unresolvedObserved = !corrupted.unresolvedObserved
        return corrupted
      }
      database.sparkRecoveryEvidence.hook("reading", corruptReadBack)
      try {
        await expect(store.retain(owner, [incoming])).rejects.toMatchObject({
          code,
        })
        expect(injected).toBe(true)
      } finally {
        database.sparkRecoveryEvidence
          .hook("reading")
          .unsubscribe(corruptReadBack)
      }
      expect(
        JSON.stringify(await database.sparkRecoveryEvidence.get(owner)) ===
          JSON.stringify(before)
      ).toBe(true)
    })
  }

  it("snapshots incoming records before waiting for the journal transaction", async () => {
    const { database, store } = newStore()
    const { owner, record, event } = signedRecord()
    const expected = structuredClone(record)
    const incoming = [record]
    const entered = gate()
    const release = gate()
    const holding = database.transaction(
      "rw",
      database.sparkRecoveryEvidence,
      async () => {
        await database.sparkRecoveryEvidence.get(owner)
        entered.resolve()
        // Keep the actual IndexedDB transaction alive until the caller releases it.
        await Dexie.waitFor(release.promise)
      }
    )
    let retaining: Promise<void> | undefined
    try {
      await entered.promise
      // Model another caller, not a nested transaction inherited from the holder.
      retaining = Dexie.ignoreTransaction(() => store.retain(owner, incoming))
      event.tags[0][1] = SPARK_RECOVERY_PREFIX + crypto.randomUUID()
      record.targets[0].url = "wss://mutation.invalid"
      record.delivery[0].accepted = true
      record.exported = true
      incoming.length = 0
      release.resolve()
      await holding
      await retaining
      const saved = await Dexie.ignoreTransaction(() => store.load(owner))
      expect(saved.records.length).toBe(1)
      expect(
        JSON.stringify(saved.records[0]) === JSON.stringify(expected)
      ).toBe(true)
      expect(saved.unresolvedObserved).toBe(false)
    } finally {
      release.resolve()
      await holding
      await retaining?.catch(() => {})
    }
  })
})
