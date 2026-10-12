import { afterEach, describe, expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  SparkRecoveryService,
  type SparkRecoveryRecord,
  type SparkRecoveryTransport,
} from "../packages/core/src/wallets/spark-recovery-service"
import {
  generateSparkMnemonic,
  validateSparkRecoveryEvent,
  sparkRecoveryChoiceDTag,
  SPARK_MAIN_D_TAG,
  type SparkRecoveryCandidate,
} from "../packages/core/src/wallets/spark-recovery-contract"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
function newStore() {
  const db = new ConduitDB(`journal-compaction-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  return { db, store: new DexieSparkRecoveryStore(db) }
}
function fixture() {
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const conversation = v2.utils.getConversationKey(secret, owner)
  const encrypt = (plaintext: string) => v2.encrypt(plaintext, conversation)
  const provider: NostrKeySigner = {
    pubkey: owner,
    getPublicKey: async () => owner,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (_peer, plaintext) => encrypt(plaintext),
    decryptNip44: async (_peer, ciphertext) =>
      v2.decrypt(ciphertext, conversation),
    decryptLegacy: async () => {
      throw new Error("unused")
    },
  }
  let current = true
  const signer = new SessionSigner(provider, {
    expectedPubkey: owner,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
    hasAuthority: () => current,
  })
  const relays = new Map<string, Map<string, SignedNostrEvent>>()
  const transport: SparkRecoveryTransport = {
    publish: async (url, event, authorized) => {
      if (!authorized()) return "cancelled"
      const events = relays.get(url) ?? new Map()
      const d = event.tags.find((t) => t[0] === "d")?.[1]
      for (const previous of events.values()) {
        if (
          previous.kind !== event.kind ||
          previous.pubkey !== event.pubkey ||
          previous.tags.find((t) => t[0] === "d")?.[1] !== d
        )
          continue
        if (
          previous.created_at > event.created_at ||
          (previous.created_at === event.created_at && previous.id < event.id)
        )
          return "acked"
        events.delete(previous.id)
      }
      events.set(event.id, structuredClone(event))
      relays.set(url, events)
      return "acked"
    },
    read: async (url, _owner, id, _authorized, d) => ({
      status: "complete",
      events: [...(relays.get(url)?.values() ?? [])].filter(
        (event) =>
          (!id || event.id === id) &&
          (!d || event.tags.some((t) => t[0] === "d" && t[1] === d))
      ),
    }),
  }
  // Provider identities are controlled here; encryption/signatures, Dexie and
  // addressable relay replacement exercise their ordinary composed paths.
  const identities = new Map<string, string>()
  const deriveIdentity = async (bundle: {
    mnemonic: string
    network: string
    accountNumber: number
  }) => {
    const key = JSON.stringify([
      bundle.mnemonic,
      bundle.network,
      bundle.accountNumber,
    ])
    if (!identities.has(key))
      identities.set(key, "02" + getPublicKey(generateSecretKey()))
    return identities.get(key)!
  }
  const local = newStore()
  const service = (store = local.store) =>
    new SparkRecoveryService({
      signer,
      currentSigner: () => (current ? signer : undefined),
      deriveIdentity,
      store,
      transport,
    })
  const choice = (
    template: SparkRecoveryRecord,
    candidate: SparkRecoveryCandidate,
    createdAt: number,
    legacy = false
  ) => {
    const event = finalizeEvent(
      {
        kind: 30078,
        created_at: createdAt,
        tags: legacy ? [["d", SPARK_MAIN_D_TAG]] : template.event.tags,
        content: encrypt(
          JSON.stringify({
            format: "conduit.spark.main",
            version: 1,
            ownerPubkey: owner,
            walletId: candidate.walletId,
            backupEventId: candidate.eventId,
            createdAt,
          })
        ),
      },
      secret
    )
    return { ...structuredClone(template), event }
  }
  return {
    ...local,
    owner,
    signer,
    service,
    choice,
    relays,
    revoke: () => {
      current = false
    },
  }
}
async function prepared(f: ReturnType<typeof fixture>) {
  const service = f.service()
  const a = await service.prepare({
    mnemonic: generateSparkMnemonic(),
    network: "mainnet",
    accountNumber: 1,
  })
  const b = await service.prepare(
    { mnemonic: generateSparkMnemonic(), network: "mainnet", accountNumber: 7 },
    crypto.randomUUID(),
    a.eventId
  )
  const foreign = await service.prepare({
    mnemonic: generateSparkMnemonic(),
    network: "regtest",
    accountNumber: 2,
  })
  await service.preparePrimary(a)
  await service.preparePrimary(foreign)
  const first = await service.prepareMain(a)
  await service.prepareMain(foreign)
  const state = await f.store.load(f.owner)
  return {
    service,
    a,
    b,
    foreign,
    state,
    template: state.records.find((r) => r.event.id === first)!,
  }
}
describe("bounded Spark choice journal", () => {
  it("selects, delivers and recovers from a full journal without losing backups or the other network", async () => {
    const f = fixture()
    const p = await prepared(f)
    const history = Array.from({ length: 121 }, (_, i) =>
      f.choice(
        p.template,
        i % 2 ? p.a : p.b,
        p.template.event.created_at + i + 1
      )
    )
    const raw = {
      ...p.state,
      records: [...p.state.records, ...history],
      removedWalletIds: [crypto.randomUUID()],
    }
    await f.db.sparkRecoveryEvidence.put(raw)
    expect(
      (await f.db.sparkRecoveryEvidence.get(f.owner))!.records.length
    ).toBe(128)
    expect((await f.store.load(f.owner)).records.length).toBe(7)
    const before = p.state.records.filter(
      (r) =>
        !r.event.tags.some(
          (t) =>
            (t[0] === "d" && t[1]?.includes(":main:")) ||
            (t[0] === "d" && t[1]?.includes(":primary:"))
        )
    )
    const main = await p.service.prepareMain(p.a)
    const primary = await p.service.preparePrimary(p.b)
    for (const candidate of [p.a, p.b, p.foreign])
      expect((await p.service.deliver(candidate.eventId)).ready).toBe(true)
    expect((await p.service.deliver(main)).ready).toBe(true)
    expect((await p.service.deliver(primary)).ready).toBe(true)
    for (const record of (await f.store.load(f.owner)).records.filter((r) =>
      r.event.tags.some(
        (t) =>
          (t[0] === "d" &&
            t[1] === sparkRecoveryChoiceDTag("main", "regtest")) ||
          (t[0] === "d" &&
            t[1] === sparkRecoveryChoiceDTag("primary", "regtest"))
      )
    ))
      await p.service.deliver(record.event.id)
    const retained = await f.store.load(f.owner)
    expect(retained.removedWalletIds?.length).toBe(1)
    expect(
      before.every((old) =>
        retained.records.some(
          (r) =>
            r.event.id === old.event.id &&
            JSON.stringify(r.event) === JSON.stringify(old.event)
        )
      )
    ).toBe(true)
    const fresh = f.service(newStore().store)
    const active = await fresh.discover(false, "mainnet")
    expect(active.main?.eventId === p.a.eventId).toBe(true)
    expect(active.primary?.eventId === p.b.eventId).toBe(true)
    expect(active.candidates.length).toBe(2)
    expect((await fresh.restore(active.main!)).accountNumber).toBe(1)
    const other = await fresh.discover(false, "regtest")
    expect(other.main?.eventId === p.foreign.eventId).toBe(true)
    expect(other.primary?.eventId === p.foreign.eventId).toBe(true)
    // A late delivery/history writer cannot resurrect superseded active choices.
    await f.store.retain(f.owner, history)
    const final = await f.store.load(f.owner)
    expect(final.records.length).toBe(7)
    expect(
      final.records.some(
        (r) =>
          r.event.id === main &&
          r.delivery.every((d) => d.accepted && d.readBack)
      )
    ).toBe(true)
  })
  it("retains bounded legacy history while allowing new per-network choices", async () => {
    const f = fixture()
    const p = await prepared(f)
    const legacy = Array.from({ length: 123 }, (_, i) =>
      f.choice(
        p.template,
        i % 2 ? p.a : p.foreign,
        p.template.event.created_at + i + 1,
        true
      )
    )
    const records = p.state.records.filter(
      (r) => !r.event.tags.some((t) => t[0] === "d" && t[1]?.includes(":main:"))
    )
    await f.db.sparkRecoveryEvidence.put({
      ...p.state,
      records: [...records, ...legacy],
    })
    expect((await f.store.load(f.owner)).records.length).toBe(128)
    await p.service.prepareMain(p.b)
    await p.service.prepareMain(p.foreign)
    const retained = await f.store.load(f.owner)
    expect(retained.records.length).toBe(130)
    expect(
      legacy.every((old) =>
        retained.records.some((r) => r.event.id === old.event.id)
      )
    ).toBe(true)
  })
  it("keeps all 128 wallet backups while independently replacing active choices", async () => {
    const f = fixture()
    const p = await prepared(f)
    for (let accountNumber = 8; accountNumber < 133; accountNumber++)
      await p.service.prepare(
        {
          mnemonic: generateSparkMnemonic(),
          network: "mainnet",
          accountNumber,
        },
        crypto.randomUUID(),
        p.a.eventId
      )
    const before = (await f.store.load(f.owner)).records.filter((r) =>
      r.event.tags.some(
        (tag) => tag[0] === "d" && tag[1]?.startsWith("conduit:spark:wallet:")
      )
    )
    expect(before.length).toBe(128)
    await p.service.prepareMain(p.b)
    await p.service.preparePrimary(p.b)
    const after = (await f.store.load(f.owner)).records
    expect(
      before.every((old) =>
        after.some(
          (record) => JSON.stringify(record.event) === JSON.stringify(old.event)
        )
      )
    ).toBe(true)
    await expect(
      p.service.prepare(
        {
          mnemonic: generateSparkMnemonic(),
          network: "mainnet",
          accountNumber: 133,
        },
        crypto.randomUUID(),
        p.a.eventId
      )
    ).rejects.toThrow("invalid_record")
    expect((await f.store.load(f.owner)).records.length).toBe(132)
  })
  it("keeps an unresolved latest choice blocking creation instead of falling back to history", async () => {
    const f = fixture()
    const p = await prepared(f)
    const missing = {
      ...p.a,
      eventId: getPublicKey(generateSecretKey()),
      walletId: crypto.randomUUID(),
    }
    const latest = f.choice(
      p.template,
      missing,
      p.template.event.created_at + 1
    )
    await f.store.retain(f.owner, [latest])
    for (const record of (await f.store.load(f.owner)).records)
      await p.service.deliver(record.event.id)
    const found = await f.service(newStore().store).discover(false, "mainnet")
    expect(found.state).toBe("unresolved")
    expect(found.main === undefined).toBe(true)
    expect(found.creationEligible).toBe(false)
    expect(found.candidates.length).toBe(2)
  })
  it("rolls back compaction with a failed main activation transaction", async () => {
    const f = fixture()
    const p = await prepared(f)
    const before = await f.db.sparkRecoveryEvidence.get(f.owner)
    await expect(
      p.service.prepareMain(p.b, (retain) =>
        f.db.transaction("rw", f.db.sparkRecoveryEvidence, async () => {
          await retain()
          throw new Error("Synthetic main activation failure")
        })
      )
    ).rejects.toThrow("Synthetic main activation failure")
    expect(
      JSON.stringify(await f.db.sparkRecoveryEvidence.get(f.owner)) ===
        JSON.stringify(before)
    ).toBe(true)
    expect(
      p.service.getVerifiedMainChoiceEventId("mainnet") === p.template.event.id
    ).toBe(true)
  })
  it("uses canonical same-timestamp replacement and keeps signed winner bytes", async () => {
    const f = fixture()
    const p = await prepared(f)
    const one = f.choice(p.template, p.a, p.template.event.created_at + 1)
    const two = f.choice(p.template, p.b, p.template.event.created_at + 1)
    const winner = one.event.id < two.event.id ? one : two
    await Promise.all([
      f.store.retain(f.owner, [one]),
      f.store.retain(f.owner, [two]),
    ])
    const records = (await f.store.load(f.owner)).records.filter((r) =>
      r.event.tags.some(
        (t) =>
          t[0] === "d" && t[1] === sparkRecoveryChoiceDTag("main", "mainnet")
      )
    )
    expect(records.length).toBe(1)
    expect(
      JSON.stringify(records[0]!.event) ===
        JSON.stringify(validateSparkRecoveryEvent(winner.event, f.owner))
    ).toBe(true)
  })
})
