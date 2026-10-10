import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import type {
  AccountSigner,
  NostrKeySigner,
} from "../packages/core/src/protocol/nostr-event-signer"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  SparkRecoveryService,
  SPARK_RECOVERY_RENDEZVOUS,
  recoveryReadiness,
  type SparkRecoveryTransport,
  type SparkRecoveryRead,
} from "../packages/core/src/wallets/spark-recovery-service"
import {
  generateSparkMnemonic,
  parseAddySparkMnemonic,
  proveSparkRecoveryCapability,
  validateSparkRecoveryEvent,
  SPARK_RECOVERY_PREFIX,
  parseSparkRecoveryEnvelope,
} from "../packages/core/src/wallets/spark-recovery-contract"
import { assertWalletCreationDiscovery } from "../packages/core/src/wallets/account-spark-recovery"
import { deriveSparkRecoveryIdentity } from "../packages/core/src/wallets/spark-sdk"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
function storage() {
  const db = new ConduitDB(`spark-recovery-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  return { db, store: new DexieSparkRecoveryStore(db) }
}
function fixture(
  options: {
    method?: "nip07" | "nip46"
    nip44?: boolean
    encrypt?: NostrKeySigner["encryptNip44"]
    timeoutMs?: number
    conformingReplacement?: boolean
  } = {}
) {
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const conversation = v2.utils.getConversationKey(secret, owner)
  let encryptCalls = 0,
    signCalls = 0,
    decryptCalls = 0
  const provider: NostrKeySigner = {
    pubkey: owner,
    getPublicKey: async () => owner,
    signEvent: async (draft) => {
      signCalls++
      return finalizeEvent(draft, secret)
    },
    encryptNip44:
      options.encrypt ??
      (async (_peer, plaintext) => {
        encryptCalls++
        return v2.encrypt(plaintext, conversation)
      }),
    decryptNip44: async (_peer, ciphertext) => {
      decryptCalls++
      return v2.decrypt(ciphertext, conversation)
    },
    decryptLegacy: async () => {
      throw new Error("unused")
    },
  }
  let current: AccountSigner | undefined
  const signer = new SessionSigner(provider, {
    expectedPubkey: owner,
    revision: crypto.randomUUID(),
    authMethod: options.method ?? "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: options.nip44 !== false,
      nip04Decrypt: false,
    }),
    hasAuthority: () => current === signer,
    operationTimeoutMs: options.timeoutMs ?? 1000,
  })
  current = signer
  const relays = new Map<
    string,
    Map<string, ReturnType<typeof finalizeEvent>>
  >()
  const unavailable = new Set<string>()
  let afterRead: (() => void) | undefined
  const frames: string[] = []
  const transport: SparkRecoveryTransport = {
    publish: async (url, event, shouldContinue) => {
      if (!shouldContinue()) return "cancelled"
      if (unavailable.has(url)) return "timed_out"
      frames.push(JSON.stringify(event))
      const events = relays.get(url) ?? new Map()
      if (options.conformingReplacement) {
        const coordinate = event.tags.find((tag) => tag[0] === "d")?.[1]
        for (const previous of events.values()) {
          if (
            previous.pubkey !== event.pubkey ||
            previous.kind !== event.kind ||
            previous.tags.find((tag) => tag[0] === "d")?.[1] !== coordinate
          )
            continue
          if (
            previous.created_at > event.created_at ||
            (previous.created_at === event.created_at && previous.id < event.id)
          )
            return "acked"
          events.delete(previous.id)
        }
      }
      events.set(event.id, structuredClone(event))
      relays.set(url, events)
      return "acked"
    },
    read: async (
      url,
      _owner,
      id,
      _continue,
      dTag
    ): Promise<SparkRecoveryRead> => {
      afterRead?.()
      return unavailable.has(url)
        ? { status: "unavailable", events: [] }
        : {
            status: "complete",
            events: [...(relays.get(url)?.values() ?? [])].filter(
              (e) =>
                (!id || e.id === id) &&
                (!dTag || e.tags.some((t) => t[0] === "d" && t[1] === dTag))
            ),
          }
    },
  }
  const local = storage()
  const service = (store = local.store) =>
    new SparkRecoveryService({
      signer,
      currentSigner: () => current,
      store,
      transport,
      deriveIdentity: deriveSparkRecoveryIdentity,
    })
  return {
    signer,
    owner,
    service,
    transport,
    relays,
    unavailable,
    frames,
    ...local,
    setAfterRead: (fn: () => void) => {
      afterRead = fn
    },
    switchAccount: () => {
      current = undefined
    },
    counts: () => ({ encryptCalls, signCalls, decryptCalls }),
    current: () => current,
    sign: (draft: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent(draft, secret),
    encrypt: (plaintext: string) => v2.encrypt(plaintext, conversation),
  }
}
function bundle() {
  return {
    mnemonic: generateSparkMnemonic(),
    network: "mainnet" as const,
    accountNumber: 1,
  }
}

describe("signer-backed Spark recovery composed foundations", () => {
  it("keeps foreign recovery evidence while deciding creation only for the active network", async () => {
    const f = fixture()
    const foreign = await f
      .service()
      .prepare({ ...bundle(), network: "regtest", accountNumber: 7 })
    await f.service().preparePrimary(foreign)
    const mainnet = await f.service().discover(false, "mainnet")
    expect(mainnet.state).toBe("absent_within_scope")
    expect(mainnet.creationEligible).toBe(true)
    expect(mainnet.candidates).toHaveLength(0)
    expect(mainnet.otherNetworkCandidates).toHaveLength(1)
    expect(mainnet.primary).toBeUndefined()
    expect(() => assertWalletCreationDiscovery(mainnet)).not.toThrow()
    const active = await f.service().prepare(bundle())
    const additional = await f
      .service()
      .prepare(bundle(), crypto.randomUUID(), active.eventId)
    const mixed = await f.service().discover(false, "mainnet")
    expect(mixed.state).toBe("recoverable") // The signed root backup verifies the common lineage.
    await f.service().preparePrimary(active)
    const resolved = await f.service().discover(false, "mainnet")
    expect(resolved.state).toBe("recoverable")
    expect(resolved.candidates.map((c) => c.eventId).sort()).toEqual(
      [active.eventId, additional.eventId].sort()
    )
    expect(resolved.otherNetworkCandidates).toHaveLength(1)
    expect((await f.store.load(f.owner)).records).toHaveLength(5)
    f.unavailable.add(SPARK_RECOVERY_RENDEZVOUS[0].url)
    expect(() => assertWalletCreationDiscovery(resolved)).not.toThrow()
    const partial = await f.service().discover(false, "mainnet")
    expect(() => assertWalletCreationDiscovery(partial)).toThrow()
  })
  it("recovers a verified active lineage from a fresh store while the latest primary is on another network", async () => {
    const f = fixture()
    const a = await f.service().prepare(bundle())
    const b = await f
      .service()
      .prepare(bundle(), crypto.randomUUID(), a.eventId)
    const foreign = await f
      .service()
      .prepare({ ...bundle(), network: "regtest" })
    const pointer = await f.service().preparePrimary(foreign)
    const records = (await f.store.load(f.owner)).records
    for (const target of SPARK_RECOVERY_RENDEZVOUS)
      f.relays.set(
        target.url,
        new Map(
          records
            .filter((r) =>
              [a.eventId, b.eventId, foreign.eventId, pointer].includes(
                r.event.id
              )
            )
            .map((r) => [r.event.id, r.event])
        )
      )
    const service = f.service(storage().store)
    const found = await service.discover(false, "mainnet")
    expect(found.state).toBe("recoverable")
    expect(found.candidates).toHaveLength(2)
    expect(found.otherNetworkCandidates).toHaveLength(1)
    expect(found.primaryPointerEventId).toBeUndefined()
    expect(service.getVerifiedPrimaryPointerEventId("mainnet")).toBeUndefined()
    expect(() => assertWalletCreationDiscovery(found)).not.toThrow()
    for (const candidate of found.candidates)
      expect((await service.restore(candidate)).network).toBe("mainnet")
  })
  it("retains unknown positive pointer evidence even when known backups are on another network", async () => {
    const f = fixture()
    const foreign = await f
      .service()
      .prepare({ ...bundle(), network: "regtest" })
    const pointerId = await f.service().preparePrimary(foreign)
    const pointer = (await f.store.load(f.owner)).records.find(
      (r) => r.event.id === pointerId
    )!
    const target = f.service(storage().store)
    f.relays.set(
      SPARK_RECOVERY_RENDEZVOUS[0].url,
      new Map([[pointer.event.id, pointer.event]])
    )
    const unknown = await target.discover(false, "mainnet")
    expect(unknown.state).toBe("unresolved")
    expect(() => assertWalletCreationDiscovery(unknown)).toThrow()
  })
  it("blocks a valid Addy backup until explicit source import produces a verified Conduit backup", async () => {
    const f = fixture()
    const source = { ...bundle(), accountNumber: 7 }
    const event = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [["d", "spark-wallet-backup"]],
      content: f.encrypt(source.mnemonic),
    })
    f.relays.set(SPARK_RECOVERY_RENDEZVOUS[0].url, new Map([[event.id, event]]))
    const before = await f.service().discover(false, "mainnet")
    expect(before.state).toBe("recoverable")
    expect(() => assertWalletCreationDiscovery(before)).toThrow("Addy")
    const imported = await f
      .service()
      .restore(before.candidates[0]!, { network: "mainnet", accountNumber: 7 })
    expect(imported.accountNumber).toBe(7)
    expect(imported.mnemonic === source.mnemonic).toBe(true)
    expect(() =>
      assertWalletCreationDiscovery(before, [event.id])
    ).not.toThrow()
    const candidate = await f.service().prepare(imported)
    await f.service().preparePrimary(candidate)
    const after = await f.service().discover(false, "mainnet")
    expect(after.state).toBe("recoverable")
    expect(after.candidates.find((c) => c.source === "addy")?.resolved).toBe(
      true
    )
    expect(() => assertWalletCreationDiscovery(after)).not.toThrow()
    const otherNetwork = await f.service().discover(false, "regtest")
    expect(() => assertWalletCreationDiscovery(otherNetwork)).toThrow("Addy")
  })
  it("preserves account-local device removal through recovery writes and transactional rollback", async () => {
    const f = fixture()
    const c = await f.service().prepare(bundle())
    await f.store.setDeviceRemoved(f.owner, c.walletId!, true)
    await f.service().preparePrimary(c)
    await f.service().discover()
    expect((await f.store.load(f.owner)).removedWalletIds).toEqual([
      c.walletId!,
    ])
    const other = fixture()
    expect((await f.store.load(other.owner)).removedWalletIds).toBeUndefined()
    await expect(
      Promise.resolve(
        f.db.transaction("rw", f.db.sparkRecoveryEvidence, async () => {
          await f.store.setDeviceRemoved(f.owner, c.walletId!, false)
          throw new Error("Removal rollback")
        })
      )
    ).rejects.toThrow("Removal rollback")
    expect((await f.store.load(f.owner)).removedWalletIds).toEqual([
      c.walletId!,
    ])
    await f.store.setDeviceRemoved(f.owner, c.walletId!, false)
    expect((await f.store.load(f.owner)).removedWalletIds).toEqual([])
    expect((await f.store.load(f.owner)).records).toHaveLength(2)
  })
  it("restores the latest explicit main choice without changing backup lineage", async () => {
    const f = fixture()
    const a = await f.service().prepare(bundle())
    const primary = await f.service().preparePrimary(a)
    const b = await f
      .service()
      .prepare(bundle(), crypto.randomUUID(), a.eventId)
    for (const id of [a.eventId, b.eventId, primary])
      await f.service().deliver(id)
    const first = await f.service().prepareMain(a)
    await f.service().deliver(first)
    const latest = await f.service().prepareMain(b)
    await f.service().deliver(latest)
    const fresh = f.service(storage().store)
    const found = await fresh.discover()
    expect(found.state).toBe("recoverable")
    expect(found.primary?.eventId === a.eventId).toBe(true)
    expect(found.main?.eventId === b.eventId).toBe(true)
    expect(found.candidates).toHaveLength(2)
    expect(
      (await f.store.load(f.owner)).records.some((r) => r.event.id === first)
    ).toBe(true)
    expect((await fresh.restore(found.main!)).accountNumber).toBe(1)
  })
  for (const source of [
    "exact",
    "broad",
    "retained",
    "retained-with-malformed-copy",
  ] as const) {
    it(`follows ${source} primary evidence across split relay views without authorizing creation`, async () => {
      const f = fixture()
      const candidate = await f.service().prepare(bundle())
      const pointerId = await f.service().preparePrimary(candidate)
      const journal = await f.store.load(f.owner)
      const pointer = journal.records.find((r) => r.event.id === pointerId)!
      const backup = journal.records.find(
        (r) => r.event.id === candidate.eventId
      )!
      const [a, b] = SPARK_RECOVERY_RENDEZVOUS
      const targetStore = storage().store
      if (source.startsWith("retained"))
        await targetStore.retain(f.owner, [pointer])
      const reads: Array<{ url: string; id?: string }> = []
      const target = new SparkRecoveryService({
        signer: f.signer,
        currentSigner: f.current,
        store: targetStore,
        deriveIdentity: deriveSparkRecoveryIdentity,
        transport: {
          ...f.transport,
          read: async (url, _owner, id, _continue, dTag) => {
            reads.push({ url, id })
            if (id)
              return {
                status: "complete",
                events:
                  url === b.url && id === candidate.eventId
                    ? [backup.event]
                    : [],
              }
            if (
              url === a.url &&
              source !== "retained" &&
              (source === "broad" ? !dTag : !!dTag)
            )
              return {
                status: "partial",
                events: [
                  source === "retained-with-malformed-copy"
                    ? { ...pointer.event, content: "invalid" }
                    : pointer.event,
                ],
              }
            return { status: "partial", events: [] }
          },
        },
      })
      const discovered = await target.discover()
      expect(discovered.primary?.eventId).toBe(candidate.eventId)
      expect(discovered.coverage).toBe("partial")
      expect(discovered.creationEligible).toBe(false)
      expect(reads.filter((r) => r.id === candidate.eventId)).toHaveLength(3)
      const restored = await target.restore(discovered.primary!)
      expect("walletId" in restored && restored.walletId).toBe(
        candidate.walletId
      )
    })
  }
  it("restores an older exact primary and referenced backup beyond 128 unrelated records without authorizing new creation", async () => {
    const f = fixture()
    const candidate = await f.service().prepare(bundle())
    const pointer = await f.service().preparePrimary(candidate)
    await f.service().deliver(candidate.eventId)
    await f.service().deliver(pointer)
    const unrelated = Array.from({ length: 129 }, (_, index) =>
      f.sign({
        kind: 30078,
        created_at: 2000000000 + index,
        tags: [["d", `other-app:${index}`]],
        content: "unrelated",
      })
    )
    for (const events of f.relays.values())
      for (const event of unrelated) events.set(event.id, event)
    const reads: Array<{ id?: string; dTag?: string }> = []
    const transport: SparkRecoveryTransport = {
      ...f.transport,
      read: async (url, owner, id, cont, dTag) => {
        reads.push({ id, dTag })
        const read = await f.transport.read(url, owner, id, cont, dTag)
        return {
          ...read,
          events: read.events
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, id || dTag ? 1 : 128),
        }
      },
    }
    const target = new SparkRecoveryService({
      signer: f.signer,
      currentSigner: f.current,
      store: storage().store,
      transport,
      deriveIdentity: deriveSparkRecoveryIdentity,
    })
    const discovery = await target.discover()
    expect(discovery.primary?.eventId).toBe(candidate.eventId)
    expect(discovery.coverage).toBe("partial")
    expect(discovery.creationEligible).toBe(false)
    expect(reads.some((read) => read.dTag === "conduit:spark:primary:v1")).toBe(
      true
    )
    expect(reads.some((read) => read.id === candidate.eventId)).toBe(true)
    const restored = await target.restore(discovery.primary!)
    expect(
      "walletId" in restored && restored.walletId === candidate.walletId
    ).toBe(true)
  })
  it("retains positive backups but blocks setup when the primary references a missing backup", async () => {
    const f = fixture()
    const visible = await f.service().prepare(bundle())
    const missing = await f
      .service()
      .prepare(bundle(), undefined, visible.eventId)
    const pointer = await f.service().preparePrimary(missing)
    await f.service().deliver(visible.eventId)
    await f.service().deliver(pointer)
    const target = f.service(storage().store)
    const discovery = await target.discover()
    expect(discovery.candidates.map((candidate) => candidate.eventId)).toEqual([
      visible.eventId,
    ])
    expect(discovery.primary).toBeUndefined()
    expect(discovery.state).toBe("unresolved")
    expect(discovery.creationEligible).toBe(false)
    expect("walletId" in (await target.restore(discovery.candidates[0]!))).toBe(
      true
    )
  })
  it("an unavailable exact primary lookup cannot authorize creation despite an empty broad read", async () => {
    const f = fixture()
    const transport: SparkRecoveryTransport = {
      ...f.transport,
      read: async (_url, _owner, _id, _cont, dTag) => ({
        status: dTag ? "unavailable" : "complete",
        events: [],
      }),
    }
    const target = new SparkRecoveryService({
      signer: f.signer,
      currentSigner: f.current,
      store: storage().store,
      transport,
      deriveIdentity: deriveSparkRecoveryIdentity,
    })
    const discovery = await target.discover()
    expect(discovery.creationEligible).toBe(false)
    expect(discovery.coverage).toBe("partial")
  })

  for (const method of ["nip07", "nip46"] as const)
    it(`proves actual NIP-44 v2 and signatures through the ${method} session owner`, async () => {
      const f = fixture({ method })
      await proveSparkRecoveryCapability(f.signer, f.current)
      expect(f.counts()).toEqual({
        encryptCalls: 1,
        signCalls: 1,
        decryptCalls: 1,
      })
      expect((await f.store.load(f.owner)).records.length).toBe(0)
    })
  it("rejects advertised-only, denied and timed-out operations without a recovery record", async () => {
    for (const [f, code] of [
      [fixture({ nip44: false }), "unsupported_operation"],
      [
        fixture({
          encrypt: async () => {
            throw { code: "authorization_denied" }
          },
        }),
        "authorization_denied",
      ],
      [
        fixture({ encrypt: () => new Promise(() => {}), timeoutMs: 5 }),
        "timeout",
      ],
    ] as const) {
      await expect(f.service().prepare(bundle())).rejects.toMatchObject({
        code,
      })
      expect((await f.store.load(f.owner)).records.length).toBe(0)
    }
  })
  it("backs up, retries unchanged bytes, and restores the same real SDK identity into fresh storage with one relay unavailable", async () => {
    const f = fixture()
    const recovery = bundle()
    const sourceIdentity = await deriveSparkRecoveryIdentity(recovery)
    const candidate = await f.service().prepare(recovery)
    const primaryId = await f.service().preparePrimary(candidate)
    // First delivery is interrupted/unavailable at two operators; one ACK alone is insufficient.
    f.unavailable.add(SPARK_RECOVERY_RENDEZVOUS[1].url)
    f.unavailable.add(SPARK_RECOVERY_RENDEZVOUS[2].url)
    expect(await f.service().deliver(candidate.eventId)).toEqual({
      ready: false,
      independentCopies: 1,
    })
    const before = f.counts()
    f.unavailable.delete(SPARK_RECOVERY_RENDEZVOUS[1].url)
    // New service reads the durable journal as on reopen.
    expect(await f.service().deliver(candidate.eventId)).toEqual({
      ready: true,
      independentCopies: 2,
    })
    expect(f.counts()).toEqual(before)
    expect(new Set(f.frames).size).toBe(1)
    await f.service().deliver(primaryId)
    const fresh = storage()
    const discovered = await f.service(fresh.store).discover()
    expect(discovered.coverage).toBe("partial")
    expect(discovered.creationEligible).toBe(false)
    expect(discovered.primary?.eventId === candidate.eventId).toBe(true)
    const restored = await f.service(fresh.store).restore(discovered.primary!)
    expect(
      (await deriveSparkRecoveryIdentity(restored)) === sourceIdentity
    ).toBe(true)
    expect(
      (await deriveSparkRecoveryIdentity({ ...restored, accountNumber: 0 })) ===
        sourceIdentity
    ).toBe(false)
    const serialized = JSON.stringify(
      await fresh.db.sparkRecoveryEvidence.toArray()
    )
    expect(serialized.includes(recovery.mnemonic)).toBe(false)
    expect(serialized.includes(sourceIdentity)).toBe(false)
  })
  it("preserves conflicting candidates and pointers, and retains evidence through later omissions", async () => {
    const f = fixture()
    const a = await f.service().prepare(bundle())
    const b = await f.service().prepare(bundle())
    await f.service().preparePrimary(a)
    await f.service().preparePrimary(b)
    const first = await f.service().discover()
    expect(first.state).toBe("conflict")
    expect(first.candidates.length).toBe(2)
    expect(first.primary).toBeUndefined()
    for (const target of SPARK_RECOVERY_RENDEZVOUS)
      f.unavailable.add(target.url)
    const second = await f.service().discover()
    expect(second.state).toBe("conflict")
    expect(second.coverage).toBe("unavailable")
    expect(second.candidates.length).toBe(2)
    expect(second.creationEligible).toBe(false)
  })
  it("never turns partial or local-wallet evidence into permission to create", async () => {
    const f = fixture()
    expect((await f.service().discover()).creationEligible).toBe(true)
    expect((await f.service().discover(true)).creationEligible).toBe(false)
    f.unavailable.add(SPARK_RECOVERY_RENDEZVOUS[0].url)
    expect((await f.service().discover()).creationEligible).toBe(false)
  })
  it("rejects old-account reads and restore after replacement", async () => {
    const f = fixture()
    const candidate = await f.service().prepare(bundle())
    const service = f.service()
    f.setAfterRead(f.switchAccount)
    await expect(service.discover()).rejects.toMatchObject({
      code: "authority_changed",
    })
    await expect(service.restore(candidate)).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(f.frames.length).toBe(0)
  })
  it("does not count unknown relay operators and requires explicit export fallback", async () => {
    const f = fixture()
    const c = await f.service().prepare(bundle())
    const state = await f.store.load(f.owner)
    expect(recoveryReadiness(state.records[0]).ready).toBe(false)
    const unknown = structuredClone(state.records[0])
    unknown.targets = [
      {
        url: "wss://unverified-relay.com",
        operator: "invented-independent-operator",
      },
    ]
    unknown.delivery = [
      {
        url: "wss://unverified-relay.com",
        status: "acked",
        accepted: true,
        readBack: true,
        lastRead: "present",
        checkedAt: Date.now(),
      },
    ]
    expect(recoveryReadiness(unknown)).toEqual({
      ready: false,
      independentCopies: 0,
    })
    await f.service().acknowledgeExport(c.eventId)
    expect(
      recoveryReadiness((await f.store.load(f.owner)).records[0]).ready
    ).toBe(true)
  })
  it("validates signatures before decrypting and validates owner/address/checksum/unknown fields", async () => {
    const f = fixture()
    const c = await f.service().prepare(bundle())
    const event = (await f.store.load(f.owner)).records[0].event
    expect(() =>
      validateSparkRecoveryEvent(
        { ...event, content: event.content.slice(0, -4) + "AAAA" },
        f.owner
      )
    ).toThrow()
    expect(() =>
      validateSparkRecoveryEvent(event, getPublicKey(generateSecretKey()))
    ).toThrow()
    const restored = await f.service().restore(c)
    expect(() =>
      parseSparkRecoveryEnvelope(
        JSON.stringify({ ...restored, version: 2 }),
        event
      )
    ).toThrow()
    expect(() =>
      parseSparkRecoveryEnvelope(
        JSON.stringify({ ...restored, unexpected: true }),
        event
      )
    ).toThrow()
    expect(() =>
      parseSparkRecoveryEnvelope(
        JSON.stringify({ ...restored, mnemonic: crypto.randomUUID() }),
        event
      )
    ).toThrow()
    expect(() =>
      parseSparkRecoveryEnvelope(JSON.stringify(restored), {
        ...event,
        tags: [["d", SPARK_RECOVERY_PREFIX + crypto.randomUUID()]],
      })
    ).toThrow()
  })
  it("supports bounded Addy bare-mnemonic reads only with explicit network/account", async () => {
    const f = fixture()
    const source = bundle()
    const event = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [
        ["d", "spark-wallet-backup"],
        ["client", "addy"],
        ["encryption", "nip44"],
      ],
      content: f.encrypt(source.mnemonic),
    })
    validateSparkRecoveryEvent(event, f.owner)
    expect(
      parseAddySparkMnemonic(source.mnemonic, event, source).accountNumber
    ).toBe(1)
    expect(() =>
      parseAddySparkMnemonic(
        source.mnemonic,
        { ...event, tags: [["d", "spark-wallet-backup:0000000000000000"]] },
        source
      )
    ).toThrow()
  })
  it("atomically preserves both backups under concurrent ciphertext journal writes", async () => {
    const f = fixture()
    await Promise.all([
      f.service().prepare(bundle()),
      f.service().prepare(bundle()),
    ])
    expect((await f.store.load(f.owner)).records.length).toBe(2)
  })
  it("keeps a usable backup when another signed candidate cannot decrypt", async () => {
    const f = fixture()
    await f.service().prepare(bundle())
    const other = fixture()
    const broken = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [["d", SPARK_RECOVERY_PREFIX + crypto.randomUUID()]],
      content: other.encrypt("not decryptable by this owner"),
    })
    f.relays.set(
      SPARK_RECOVERY_RENDEZVOUS[0].url,
      new Map([[broken.id, broken]])
    )
    const result = await f.service().discover()
    expect(result.candidates.length).toBe(1)
    expect(result.invalidCount).toBe(1)
    expect(result.creationEligible).toBe(false)
  })
  it("repairs an acknowledged copy that is now absent without new signatures", async () => {
    const f = fixture()
    const c = await f.service().prepare(bundle())
    await f.service().deliver(c.eventId)
    const count = f.counts()
    for (const events of f.relays.values()) events.clear()
    expect((await f.service().deliver(c.eventId)).ready).toBe(false)
    expect((await f.service().deliver(c.eventId)).independentCopies).toBe(3)
    expect(f.counts()).toEqual(count)
    expect(new Set(f.frames).size).toBe(1)
  })
  it("treats contradictory wallet bindings to the same backup as a conflict", async () => {
    const f = fixture()
    const c = await f.service().prepare(bundle())
    await f.service().preparePrimary(c)
    const pointer = {
      format: "conduit.spark.primary",
      version: 1,
      ownerPubkey: f.owner,
      walletId: crypto.randomUUID(),
      backupEventId: c.eventId,
      createdAt: 100,
    }
    const conflicting = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [["d", "conduit:spark:primary:v1"]],
      content: f.encrypt(JSON.stringify(pointer)),
    })
    f.relays.set(
      SPARK_RECOVERY_RENDEZVOUS[0].url,
      new Map([[conflicting.id, conflicting]])
    )
    const found = await f.service().discover()
    expect(found.state).toBe("conflict")
    expect(found.primary).toBeUndefined()
  })
  it("does not call an invalid Addy payload recoverable", async () => {
    const f = fixture()
    const event = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [["d", "spark-wallet-backup"]],
      content: f.encrypt("not a valid mnemonic"),
    })
    f.relays.set(SPARK_RECOVERY_RENDEZVOUS[0].url, new Map([[event.id, event]]))
    const result = await f.service().discover()
    expect(result.state).toBe("unresolved")
    expect(result.invalidCount).toBe(1)
    expect(result.creationEligible).toBe(false)
  })
  it("retains an unresolved discovery barrier without storing malformed plaintext", async () => {
    const f = fixture()
    const invalid = f.sign({
      kind: 30078,
      created_at: 100,
      tags: [["d", SPARK_RECOVERY_PREFIX + crypto.randomUUID()]],
      content: "synthetic-invalid-plaintext",
    })
    f.relays.set(
      SPARK_RECOVERY_RENDEZVOUS[0].url,
      new Map([[invalid.id, invalid]])
    )
    expect((await f.service().discover()).creationEligible).toBe(false)
    f.relays.clear()
    expect((await f.service().discover()).creationEligible).toBe(false)
    expect(
      JSON.stringify(await f.db.sparkRecoveryEvidence.toArray()).includes(
        invalid.content
      )
    ).toBe(false)
  })
})

it("fresh journals retain primary and main choices independently across network replacement", async () => {
  const f = fixture({ conformingReplacement: true })
  const service = f.service()
  const root = await service.prepare({
    mnemonic: generateSparkMnemonic(),
    network: "mainnet",
    accountNumber: 7,
  })
  const rootPointer = await service.preparePrimary(root)
  const preferred = await service.prepare(
    { mnemonic: generateSparkMnemonic(), network: "mainnet", accountNumber: 8 },
    undefined,
    root.eventId
  )
  const preferredMain = await service.prepareMain(preferred)
  const foreign = await service.prepare(
    { mnemonic: generateSparkMnemonic(), network: "regtest", accountNumber: 9 },
    undefined,
    root.eventId
  )
  const foreignPointer = await service.preparePrimary(foreign)
  const foreignMain = await service.prepareMain(foreign)
  for (const id of [
    root.eventId,
    rootPointer,
    preferred.eventId,
    preferredMain,
    foreign.eventId,
    foreignPointer,
    foreignMain,
  ])
    await service.deliver(id)
  const fresh = f.service(storage().store)
  const mainnet = await fresh.discover(false, "mainnet")
  expect(mainnet.invalidCount).toBe(0)
  expect(mainnet.primary?.walletId).toBe(root.walletId)
  expect(mainnet.main?.walletId).toBe(preferred.walletId)
  const regtest = await f.service(storage().store).discover(false, "regtest")
  expect(regtest.invalidCount).toBe(0)
  expect(regtest.primary?.walletId).toBe(foreign.walletId)
  expect(regtest.main?.walletId).toBe(foreign.walletId)
  expect(mainnet.otherNetworkCandidates.map((c) => c.walletId)).toEqual([
    foreign.walletId,
  ])
  expect(regtest.otherNetworkCandidates.map((c) => c.walletId).sort()).toEqual(
    [root.walletId, preferred.walletId].sort()
  )
})

it("fresh journals read legacy networkless choices using the verified backup network", async () => {
  const f = fixture({ conformingReplacement: true })
  const service = f.service()
  const root = await service.prepare(bundle())
  const primaryId = await service.preparePrimary(root)
  const mainId = await service.prepareMain(root)
  const records = (await f.store.load(f.owner)).records
  const events = records.map(({ event }) => {
    const type =
      event.id === primaryId
        ? "primary"
        : event.id === mainId
          ? "main"
          : undefined
    return type
      ? f.sign({ ...event, tags: [["d", `conduit:spark:${type}:v1`]] })
      : event
  })
  for (const target of SPARK_RECOVERY_RENDEZVOUS)
    f.relays.set(target.url, new Map(events.map((event) => [event.id, event])))
  const fresh = f.service(storage().store)
  const found = await fresh.discover(false, "mainnet")
  expect(found.invalidCount).toBe(0)
  expect(found.primary?.walletId).toBe(root.walletId)
  expect(found.main?.walletId).toBe(root.walletId)
  expect(fresh.getVerifiedPrimaryPointerEventId("mainnet")).toBe(
    events.find((event) => event.tags[0][1] === "conduit:spark:primary:v1")!.id
  )
  expect(fresh.getVerifiedMainChoiceEventId("mainnet")).toBe(
    events.find((event) => event.tags[0][1] === "conduit:spark:main:v1")!.id
  )
  expect((await fresh.restore(found.main!)).network).toBe("mainnet")
})

it("mismatched network choice coordinates retain evidence and block Create without selecting a wallet", async () => {
  const f = fixture()
  const service = f.service()
  const root = await service.prepare(bundle())
  const primaryId = await service.preparePrimary(root)
  const mainId = await service.prepareMain(root)
  const records = (await f.store.load(f.owner)).records
  const events = records.map(({ event }) => {
    const type =
      event.id === primaryId
        ? "primary"
        : event.id === mainId
          ? "main"
          : undefined
    return type
      ? f.sign({ ...event, tags: [["d", `conduit:spark:${type}:v1:regtest`]] })
      : event
  })
  for (const target of SPARK_RECOVERY_RENDEZVOUS)
    f.relays.set(target.url, new Map(events.map((event) => [event.id, event])))
  const local = storage()
  const fresh = f.service(local.store)
  const found = await fresh.discover(false, "mainnet")
  expect(found.invalidCount).toBe(2)
  expect(found.primary).toBeUndefined()
  expect(found.main).toBeUndefined()
  expect(found.creationEligible).toBe(false)
  expect(() => assertWalletCreationDiscovery(found)).toThrow()
  expect(
    (await local.store.load(f.owner)).records.map((r) => r.event.id).sort()
  ).toEqual(events.map((e) => e.id).sort())
  expect(fresh.getVerifiedMainChoiceEventId("mainnet")).toBeUndefined()
})
