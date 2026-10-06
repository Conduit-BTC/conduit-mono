import { projectCommerceInbox } from "../packages/core/src/protocol/commerce"
import { deriveProtectedReadPresentationState } from "@conduit/core"
import { NostrSignerError } from "../packages/core/src/protocol/nostr-event-signer"
import { resolveInboxDeclaration } from "../packages/core/src/protocol/private-message-routing"
import { createInMemoryInboxDeclarationEvidenceRepository } from "../packages/core/src/protocol/inbox-declaration-evidence"
import type { ProtectedInboxReadResult } from "../packages/core/src/protocol/protected-inbox-read"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { createRumor, createSeal, wrapEvent } from "nostr-tools/nip59"
import { ConduitDB } from "../packages/core/src/db"
import { unwrapPrivateMessageEnvelope } from "../packages/core/src/protocol/messaging"
import {
  stagePrivateDelivery,
  recordPrivateDelivery,
  holdPrivateDeliveryClaim,
  retryPrivateDeliveries,
  type PrivateDeliveryJob,
} from "../packages/core/src/protocol/private-message-delivery"
import {
  CommerceInbox,
  exportCommerceInboxDiagnostics,
  readRetainedCommerceInbox,
} from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import {
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"

const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
function setup() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  let decrypts = 0
  const signer: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (e) => finalizeEvent(e, secret),
    encryptNip44: async (p, text) =>
      v2.encrypt(text, v2.utils.getConversationKey(secret, p)),
    decryptNip44: async (p, text) => {
      decrypts++
      return v2.decrypt(text, v2.utils.getConversationKey(secret, p))
    },
    decryptLegacy: async () => "",
  }
  installProtectedReadSigner(signer, pubkey, () => true)
  const authorization = getProtectedReadAuthorization(pubkey)!
  const database = new ConduitDB(`inbox-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const store = new CommerceInboxStore(authorization, database)
  const owner = new CommerceInbox(authorization, signer, store)
  owners.push(owner)
  const sender = generateSecretKey()
  const wrapper = (index = 0, kind = 14, tags: string[][] = []) =>
    wrapEvent(
      {
        kind,
        pubkey: getPublicKey(sender),
        created_at: 1_700_000_000 + index,
        tags: [["p", pubkey], ...tags],
        content: kind === 14 ? `private-synthetic-${index}` : '{"version":99}',
      },
      sender,
      pubkey
    )
  return {
    owner,
    store,
    database,
    signer,
    pubkey,
    secret,
    wrapper,
    decrypts: () => decrypts,
  }
}
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const db of databases.splice(0)) await db.delete()
})

describe("durable account-owned commerce inbox", () => {
  it("opens retained encrypted views after signer loss without restoring write authority", async () => {
    const { owner, database, store, pubkey, wrapper } = setup()
    await owner.ingest(wrapper())
    const message = (await owner.waitForDecode()).directMessages[0]!
    __resetProtectedReadSigner()
    let current = true
    const cached = await readRetainedCommerceInbox(
      pubkey,
      () => current,
      database
    )
    expect(cached.directMessages).toEqual([message])
    expect(cached.diagnostics.coverage).toBe("unavailable")
    expect(projectCommerceInbox(cached, pubkey).direct.meta.stale).toBe(true)
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    await expect(
      store.putProjection({ kind: "direct", message })
    ).rejects.toThrow()
    expect(
      (await readRetainedCommerceInbox("f".repeat(64), () => true, database))
        .directMessages
    ).toEqual([])
    current = false
    await expect(
      readRetainedCommerceInbox(pubkey, () => current, database)
    ).rejects.toThrow("Inbox account session ended")
  })

  it("fences retained reads across account loss during device decryption", async () => {
    const { owner, database, pubkey, wrapper } = setup()
    await owner.ingest(wrapper())
    await owner.waitForDecode()
    __resetProtectedReadSigner()
    let current = true
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    const probe = spyOn(crypto.subtle, "decrypt").mockImplementation(
      async (...args: Parameters<typeof decrypt>) => {
        const bytes = await decrypt(...args)
        current = false
        return bytes
      }
    )
    try {
      await expect(
        readRetainedCommerceInbox(pubkey, () => current, database)
      ).rejects.toThrow("Inbox account session ended")
    } finally {
      probe.mockRestore()
    }
  })

  it("keeps deletion and expiration suppression when reading retained views", async () => {
    const { owner, database, pubkey, wrapper } = setup()
    for (let index = 0; index < 3; index++) await owner.ingest(wrapper(index))
    await owner.waitForDecode()
    const rows = await database.commerceInboxRecords.toArray()
    await database.commerceInboxRecords.update(rows[0]!.id, { deleted: true })
    await database.commerceInboxRecords.update(rows[1]!.id, {
      expiresAt: Date.now() - 1,
    })
    __resetProtectedReadSigner()
    const cached = await readRetainedCommerceInbox(pubkey, () => true, database)
    expect(cached.directMessages.map((message) => message.id)).toEqual([
      rows[2]!.logicalId,
    ])
  })

  it("preserves a long authenticated conversation through encrypted reload", async () => {
    const { owner, database, pubkey, signer } = setup()
    const sender = generateSecretKey()
    const content = "synthetic long conversation ".repeat(240)
    await owner.ingest(
      wrapEvent(
        {
          kind: 14,
          pubkey: getPublicKey(sender),
          created_at: 1_700_000_000,
          tags: [["p", pubkey]],
          content,
        },
        sender,
        pubkey
      )
    )
    expect((await owner.waitForDecode()).directMessages[0]?.content).toBe(
      content
    )
    owner.stop()
    const authorization = getProtectedReadAuthorization(pubkey)!
    const reloaded = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, database)
    )
    owners.push(reloaded)
    await reloaded.initialize()
    expect(reloaded.getSnapshot().directMessages[0]?.content).toBe(content)
  })

  it("stores opened projections encrypted with a nonextractable device key and does not decrypt duplicates again", async () => {
    const { owner, database, wrapper, decrypts } = setup()
    const wrap = wrapper()
    await owner.ingest(wrap, ["wss://synthetic.example"])
    const first = await owner.waitForDecode()
    expect(first.directMessages).toHaveLength(1)
    expect(decrypts()).toBe(2)
    await owner.ingest(wrap)
    await owner.waitForDecode()
    expect(decrypts()).toBe(2)
    const row = (await database.commerceInboxRecords.toArray())[0]!
    expect(JSON.stringify(row)).not.toContain("private-synthetic")
    expect(
      (await database.commerceInboxKeys.toArray())[0]!.key.extractable
    ).toBe(false)
    owner.stop()
  })

  it("retains unsupported authenticated commerce for local search without creating an order", async () => {
    const { owner, wrapper } = setup()
    await owner.ingest(
      wrapper(1, 16, [
        ["type", "future-commerce"],
        ["order", "synthetic-correlation"],
      ])
    )
    const result = await owner.waitForDecode()
    expect(result.orderMessages).toHaveLength(0)
    expect(result.externalRecords).toHaveLength(1)
    expect(await owner.search("synthetic-correlation")).toHaveLength(1)
    expect(result.diagnostics.states.unsupported).toBe(1)
    owner.stop()
  })

  it("keeps expiry and authenticated wrapper provenance when associating external commerce", async () => {
    const { owner, store, database, wrapper } = setup()
    const expiresAt = (Math.floor(Date.now() / 1000) + 3600) * 1000
    const wrap = wrapper(2, 16, [
      ["type", "future-commerce"],
      ["order", "synthetic-correlation"],
      ["expiration", String(expiresAt / 1000)],
    ])
    await owner.ingest(wrap)
    const record = (await owner.waitForDecode()).externalRecords[0]!
    await owner.associate(record, "synthetic-local-order")
    const row = (await database.commerceInboxRecords.toArray())[0]!
    expect(row.wrapId).toBe(wrap.id)
    expect(row.expiresAt).toBe(expiresAt)
    // Simulate elapsed retention without sleeping or changing global time.
    await database.commerceInboxRecords.update(row.id, {
      expiresAt: Date.now() - 1,
    })
    await owner.associate(record, "synthetic-later-association")
    expect(await store.projections()).toHaveLength(0)
    expect(await owner.search("synthetic-correlation")).toHaveLength(0)
  })

  it("separates transport failures and exports source freshness without identifiers", async () => {
    const { owner, database, store, wrapper } = setup()
    const wrap = wrapper()
    await owner.ingest(wrap, ["wss://private-source.synthetic.example"])
    await owner.waitForDecode()
    await database.commerceInboxWrappers.put({
      id: store.key("synthetic-legacy"),
      accountPubkey: store.principal,
      event: finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", store.principal]],
          content: "permission refused before decryption",
        },
        generateSecretKey()
      ),
      sources: [],
      observedAt: Date.now(),
      state: "permission_declined",
      rulesVersion: 1,
      attempts: 1,
    })
    await database.commerceInboxRanges.put({
      id: store.key("wss://private-source.synthetic.example:nip17"),
      accountPubkey: store.principal,
      relayUrl: "wss://private-source.synthetic.example",
      status: "partial",
      observedAt: Date.now(),
      observedCount: 1,
    })
    await owner.refresh()
    let reads = 0
    await owner.syncRecent({
      includeLegacy: false,
      declaration: {
        pubkey: store.principal,
        state: "declared",
        relayUrls: ["wss://private-source.synthetic.example"],
        stale: false,
        fetchedAt: Date.now(),
      },
      read: async () => {
        reads++
        return {
          events: [],
          coverage: "complete",
          auth: {
            state: "not_challenged",
            challengedCount: 0,
            succeededCount: 0,
            failedCount: 0,
          },
          relayResult: {
            status: "success",
            observations: [{ type: "eose", relayIndex: 0 }],
            relays: [
              {
                relayIndex: 0,
                status: "success",
                auth: "not_challenged",
                eventCount: 0,
                duplicateCount: 0,
                malformedCount: 0,
                unusableCount: 0,
              },
            ],
            attemptedCount: 1,
            completedCount: 1,
            failedCount: 0,
            authoritativeEmpty: true,
          },
        }
      },
    })
    const view = owner.getSnapshot()
    const diagnostic = exportCommerceInboxDiagnostics(view)
    expect(diagnostic.sources).toHaveLength(reads)
    expect(reads).toBeGreaterThan(0)
    expect(diagnostic.sources[0]).toMatchObject({
      sourceIndex: 1,
      transport: "nip17",
      coverage: "complete",
      received: 0,
    })
    expect(diagnostic.sources[0]!.observedAt).toBeGreaterThan(0)
    expect(diagnostic.transportStates.nip17.opened).toBe(1)
    expect(diagnostic.transportStates.nip04.permission_declined).toBe(1)
    expect(diagnostic.transportStates.nip17.permission_declined).toBeUndefined()
    expect(diagnostic.historyRanges[0]).toMatchObject({
      status: "partial",
      observedCount: 1,
    })
    expect(view.sourceRelays[0]?.relayUrl).toBe(
      "wss://private-source.synthetic.example"
    )
    const exported = JSON.stringify(diagnostic)
    for (const privateValue of [
      store.principal,
      wrap.id,
      wrap.content,
      "wss://private-source.synthetic.example",
    ])
      expect(exported).not.toContain(privateValue)
  })

  it("preserves histories beyond 400 wrappers and incremental successes", async () => {
    const { owner, wrapper } = setup()
    const paints: number[] = []
    const stop = owner.subscribe(() =>
      paints.push(owner.getSnapshot().directMessages.length)
    )
    for (let i = 0; i < 405; i++) await owner.ingest(wrapper(i))
    const result = await owner.waitForDecode()
    expect(result.directMessages).toHaveLength(405)
    expect(paints.some((count) => count > 0 && count < 405)).toBe(true)
    stop()
    owner.stop()
  }, 60_000)

  it("migrates legacy plaintext rows atomically and preserves read markers after reload", async () => {
    const { owner, database, pubkey, store } = setup()
    const peer = getPublicKey(generateSecretKey())
    await database.messages.put({
      id: "legacy-id",
      senderPubkey: peer,
      recipientPubkey: pubkey,
      content: "legacy private synthetic",
      kind: 14,
      createdAt: 12,
      read: 1,
    })
    await owner.initialize()
    expect(await database.messages.count()).toBe(0)
    expect(await database.commerceInboxRecords.count()).toBe(2)
    expect((await store.projections())[0]!.row.read).toBe(1)
    expect(owner.getSnapshot().directMessages[0]!.content).toBe(
      "legacy private synthetic"
    )
    await store.migrateLegacy()
    expect(await database.commerceInboxRecords.count()).toBe(2)
    owner.stop()
  })

  it("fences old-account reads and late decrypt commits", async () => {
    const { owner, store, signer, wrapper } = setup()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const decrypt = signer.decryptNip44
    signer.decryptNip44 = async (...args) => {
      await blocked
      return await decrypt(...args)
    }
    await owner.ingest(wrapper())
    __resetProtectedReadSigner()
    release()
    await expect(owner.waitForDecode()).rejects.toBeDefined()
    await expect(store.projections()).rejects.toBeDefined()
    owner.stop()
  })
  it("keeps deletion tombstones effective before a late wrapper arrives and applies inner expiry", async () => {
    const { owner, store, signer, wrapper } = setup()
    const late = wrapper(30)
    const rumor = await unwrapPrivateMessageEnvelope(late, signer)
    await store.deleteRecords([rumor.id], rumor.pubkey)
    await owner.ingest(late)
    await owner.ingest(
      wrapper(31, 14, [
        ["expiration", String(Math.floor(Date.now() / 1000) - 1)],
      ])
    )
    const snapshot = await owner.waitForDecode()
    expect(snapshot.directMessages).toHaveLength(0)
    expect(snapshot.diagnostics.states.expired).toBe(1)
    expect(await store.database.commerceInboxDeletions.count()).toBe(1)
  })

  it("claims one decrypt across concurrent tabs and restores the committed encrypted view after reload", async () => {
    const { owner, store, signer, wrapper, decrypts } = setup()
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const decrypt = signer.decryptNip44
    signer.decryptNip44 = async (...args) => {
      await hold
      return await decrypt(...args)
    }
    const peerOwner = new CommerceInbox(owner.authorization, signer, store)
    owners.push(peerOwner)
    const event = wrapper(40)
    await owner.ingest(event)
    await peerOwner.ingest(event)
    release()
    await Promise.all([owner.waitForDecode(), peerOwner.waitForDecode()])
    await peerOwner.refresh()
    expect(decrypts()).toBe(2)
    expect(peerOwner.getSnapshot().directMessages).toHaveLength(1)
    owner.stop()
    peerOwner.stop()
    const reloaded = new CommerceInbox(
      store.authorization,
      signer,
      new CommerceInboxStore(store.authorization, store.database)
    )
    owners.push(reloaded)
    await reloaded.waitForDecode()
    expect(reloaded.getSnapshot().directMessages).toHaveLength(1)
    expect(decrypts()).toBe(2)
  })

  it("encrypts malformed and machine legacy rows before deleting their plaintext representation", async () => {
    const { owner, database, pubkey } = setup()
    const peer = getPublicKey(generateSecretKey())
    await database.messages.put({
      id: "legacy-machine",
      senderPubkey: peer,
      recipientPubkey: pubkey,
      content: JSON.stringify({
        type: "checkout_spark_recovery",
        wallet: { mnemonic: crypto.randomUUID() },
      }),
      kind: 14,
      createdAt: 12,
      read: 0,
    })
    await database.orderMessages.put({
      id: "legacy-corrupt",
      senderPubkey: peer,
      recipientPubkey: pubkey,
      rawContent: "corrupt synthetic private data",
      orderId: "historical",
      type: "order",
      createdAt: 12,
      cachedAt: 12,
    })
    await owner.initialize()
    expect(await database.messages.count()).toBe(0)
    expect(await database.orderMessages.count()).toBe(0)
    expect(await database.commerceInboxRecords.count()).toBe(4)
    expect(
      JSON.stringify(await database.commerceInboxRecords.toArray())
    ).not.toContain("synthetic recovery material")
    expect(owner.getSnapshot().directMessages).toHaveLength(0)
    expect(owner.getSnapshot().externalRecords).toHaveLength(0)
  })

  it("merges concurrent recipient and self-copy acknowledgements without losing either", async () => {
    const { store, pubkey, secret } = setup()
    const peer = getPublicKey(generateSecretKey())
    const rumor = {
      kind: 14,
      pubkey,
      created_at: 1_700_000_000,
      tags: [["p", peer]],
      content: "synthetic concurrent delivery",
    }
    const legs = [peer, pubkey].map((recipientPubkey) => ({
      recipientPubkey,
      event: wrapEvent(rumor, secret, recipientPubkey),
      relayUrls: ["wss://delivery.synthetic.example"],
      ownerSelectedRelayUrls: [],
      compatibility: false,
      acknowledged: [],
      failed: [],
    }))
    const id = await stagePrivateDelivery(store, {
      senderPubkey: pubkey,
      rumorId: "concurrent-delivery",
      createdAt: Date.now(),
      legs,
    })
    await Promise.all(
      legs.map((leg) =>
        recordPrivateDelivery(store, id, leg.event.id, {
          successfulRelayUrls: leg.relayUrls,
        } as never)
      )
    )
    const row = (await store.database.commerceInboxDeliveries.toArray())[0]!
    const restored = await store.open<PrivateDeliveryJob>(row.value, id)
    expect(restored.legs.every((leg) => leg.acknowledged.length === 1)).toBe(
      true
    )
    expect(row.state).toBe("accepted")
    expect(restored.legs.map((leg) => JSON.stringify(leg.event))).toEqual(
      legs.map((leg) => JSON.stringify(leg.event))
    )
  })

  it("recovers exact staged recipient and self bytes after a crash and retries only unaccepted targets", async () => {
    const { store, pubkey, secret: author } = setup()
    const peer = getPublicKey(generateSecretKey())
    const rumor = {
      kind: 14,
      pubkey: getPublicKey(author),
      created_at: 1_700_000_000,
      tags: [["p", peer]],
      content: "staged synthetic text",
    }
    const recipient = structuredClone(wrapEvent(rumor, author, peer))
    const self = structuredClone(wrapEvent(rumor, author, pubkey))
    const targets = [
      "wss://one.synthetic.example",
      "wss://two.synthetic.example",
    ]
    const id = await stagePrivateDelivery(store, {
      senderPubkey: pubkey,
      rumorId: "saved-logical-id",
      createdAt: Date.now(),
      legs: [recipient, self].map((event, i) => ({
        recipientPubkey: i ? pubkey : peer,
        event,
        relayUrls: [...targets],
        ownerSelectedRelayUrls: i ? [...targets] : [],
        compatibility: false,
        acknowledged: [],
        failed: [],
      })),
    })
    const before = (await store.database.commerceInboxDeliveries.toArray())[0]!
    expect(JSON.stringify(before)).not.toContain("staged synthetic text")
    const outcome = (successfulRelayUrls: string[]) =>
      ({
        successfulRelayUrls,
        attemptedRelayUrls: targets,
        failedRelayUrls: targets.filter(
          (url) => !successfulRelayUrls.includes(url)
        ),
        rejectedRelayUrls: [],
      }) as never
    await recordPrivateDelivery(store, id, recipient.id, outcome([targets[0]!]))
    await recordPrivateDelivery(store, id, self.id, null)
    const writes: Array<{ event: unknown; targets: string[] }> = []
    await retryPrivateDeliveries(
      pubkey,
      (async (event, options) => {
        writes.push({
          event: structuredClone(event),
          targets: [...options.exclusiveRelayUrls!],
        })
        return outcome([...options.exclusiveRelayUrls!])
      }) as never,
      id,
      store,
      (async (recipientPubkey) => ({
        pubkey: recipientPubkey,
        state: "declared",
        relayUrls: targets,
        stale: false,
        fetchedAt: Date.now(),
      })) as never
    )
    expect(writes).toEqual([
      { event: recipient, targets: [targets[1]!] },
      { event: self, targets },
    ])
    const row = await store.database.commerceInboxDeliveries.get(store.key(id))
    expect(row?.state).toBe("accepted")
    const restored = await store.open<PrivateDeliveryJob>(row!.value, id)
    expect(restored.legs.map((leg) => leg.event)).toEqual([recipient, self])
    let retryWrites = 0
    await retryPrivateDeliveries(
      pubkey,
      (async () => {
        retryWrites++
        return outcome(targets)
      }) as never,
      id,
      store
    )
    expect(retryWrites).toBe(0)
  })

  it("holds the retry claim across a failed recipient leg and an unresolved self-copy", async () => {
    const { store, pubkey, secret } = setup()
    const peer = getPublicKey(generateSecretKey())
    const relay = "wss://claim.synthetic.example"
    const rumor = {
      kind: 14,
      pubkey,
      created_at: 1_700_000_000,
      tags: [["p", peer]],
      content: "synthetic claim replay",
    }
    const legs = [peer, pubkey].map((recipientPubkey) => ({
      recipientPubkey,
      event: wrapEvent(rumor, secret, recipientPubkey),
      relayUrls: [relay],
      ownerSelectedRelayUrls: [],
      compatibility: false,
      acknowledged: [],
      failed: [],
    }))
    const id = await stagePrivateDelivery(store, {
      senderPubkey: pubkey,
      rumorId: "claim-replay",
      createdAt: Date.now(),
      legs,
    })
    // Simulate a worker that exited after staging and released its lease.
    await store.database.commerceInboxDeliveries.update(store.key(id), {
      claim: undefined,
    })
    let held!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      held = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const declaration = (async (recipientPubkey: string) => ({
      pubkey: recipientPubkey,
      state: "declared",
      relayUrls: [relay],
      stale: false,
      fetchedAt: Date.now(),
    })) as never
    const first = retryPrivateDeliveries(
      pubkey,
      (async (event) => {
        if (event.id === legs[0]!.event.id) return { successfulRelayUrls: [] }
        held()
        await pending
        return { successfulRelayUrls: [relay] }
      }) as never,
      id,
      store,
      declaration
    )
    await entered
    let overlappingWrites = 0
    try {
      await retryPrivateDeliveries(
        pubkey,
        (async () => {
          overlappingWrites++
          return { successfulRelayUrls: [relay] }
        }) as never,
        id,
        store,
        declaration
      )
      expect(overlappingWrites).toBe(0)
    } finally {
      release()
      await first
    }
    expect(
      (await store.database.commerceInboxDeliveries.get(store.key(id)))?.claim
    ).toBeUndefined()
  })

  it("does not let another tab retry an initial send while its remaining legs are owned", async () => {
    const { store, pubkey, secret } = setup()
    const peer = getPublicKey(generateSecretKey())
    const relay = "wss://initial-claim.synthetic.example"
    const rumor = {
      kind: 14,
      pubkey,
      created_at: 1_700_000_000,
      tags: [["p", peer]],
      content: "synthetic initial send",
    }
    const legs = [peer, pubkey].map((recipientPubkey) => ({
      recipientPubkey,
      event: wrapEvent(rumor, secret, recipientPubkey),
      relayUrls: [relay],
      ownerSelectedRelayUrls: [],
      compatibility: false,
      acknowledged: [],
      failed: [],
    }))
    const id = await stagePrivateDelivery(store, {
      senderPubkey: pubkey,
      rumorId: "initial-claim",
      createdAt: Date.now(),
      legs,
    })
    const claim = await holdPrivateDeliveryClaim(store, id)
    try {
      await recordPrivateDelivery(store, id, legs[0]!.event.id, null, {
        holdClaim: true,
      })
      let writes = 0
      await retryPrivateDeliveries(
        pubkey,
        (async () => {
          writes++
          return { successfulRelayUrls: [relay] }
        }) as never,
        id,
        store
      )
      expect(writes).toBe(0)
      claim.assertCurrent()
    } finally {
      await claim.release()
    }
    expect(
      (await store.database.commerceInboxDeliveries.get(store.key(id)))?.claim
    ).toBeUndefined()
  })
})

function completeRead(
  events: ProtectedInboxReadResult["events"] = []
): ProtectedInboxReadResult {
  return {
    events,
    coverage: "complete",
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: "success",
      observations: [],
      relays: [],
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      authoritativeEmpty: !events.length,
    },
  }
}

it.each([
  "permission_declined",
  "provider_unavailable",
  "decrypt_failed",
] as const)(
  "keeps %s wrappers degraded through complete EOSE and clears them after retry",
  async (reason) => {
    const { owner, pubkey, signer, wrapper } = setup()
    const decrypt = signer.decryptNip44!
    signer.decryptNip44 = async () => {
      throw new NostrSignerError(reason)
    }
    const wrap = wrapper()
    const declaration = {
      pubkey,
      state: "declared" as const,
      relayUrls: ["wss://recovery.synthetic.example"],
      stale: false,
      fetchedAt: Date.now(),
    }
    const snapshot = await owner.syncRecent({
      declaration,
      includeLegacy: false,
      read: async () => completeRead([wrap]),
    })
    expect(snapshot.diagnostics.coverage).toBe("complete")
    for (const result of Object.values(
      projectCommerceInbox(snapshot, pubkey)
    )) {
      expect(result.data).toHaveLength(0)
      expect(result.meta.degraded).toBe(true)
      expect(result.meta.decryptFailures).toEqual([
        { wrapId: wrap.id, reason: "nip44_failed" },
      ])
      expect(
        deriveProtectedReadPresentationState({
          visibleCount: 0,
          meta: result.meta,
        })
      ).not.toBe("complete")
    }
    expect(
      JSON.stringify(exportCommerceInboxDiagnostics(snapshot))
    ).not.toContain(wrap.id)
    signer.decryptNip44 = decrypt
    const recovered = await owner.retryDecode()
    expect(recovered.directMessages).toHaveLength(1)
    expect(projectCommerceInbox(recovered, pubkey).direct.meta.degraded).toBe(
      false
    )
  }
)

it("retires successful coverage after a refresh throws while retaining opened messages", async () => {
  const { owner, pubkey, wrapper } = setup()
  const declaration = {
    pubkey,
    state: "declared" as const,
    relayUrls: ["wss://recovery.synthetic.example"],
    stale: false,
    fetchedAt: Date.now(),
  }
  await owner.syncRecent({
    declaration,
    includeLegacy: false,
    read: async () => completeRead([wrapper()]),
  })
  await expect(
    owner.syncRecent({
      declaration,
      includeLegacy: false,
      read: async () => {
        throw new Error("transport failed")
      },
    })
  ).rejects.toThrow("transport failed")
  const result = projectCommerceInbox(owner.getSnapshot(), pubkey).direct
  expect(result.data).toHaveLength(1)
  expect(result.meta.inbox?.coverage).toBe("unavailable")
  expect(result.meta.degraded).toBe(true)
})

it("retries exact owner-local self bytes while rejecting the same remote-local declaration", async () => {
  const { store, pubkey, secret } = setup()
  const peerSecret = generateSecretKey()
  const peer = getPublicKey(peerSecret)
  const relay = "ws://owner-relay.synthetic.example"
  const rumor = {
    kind: 14,
    pubkey,
    created_at: 100,
    tags: [["p", peer]],
    content: "synthetic local delivery",
  }
  const legs = [peer, pubkey].map((recipientPubkey) => ({
    recipientPubkey,
    event: wrapEvent(rumor, secret, recipientPubkey),
    relayUrls: [relay],
    ownerSelectedRelayUrls: recipientPubkey === pubkey ? [relay] : [],
    compatibility: false,
    acknowledged: [],
    failed: [],
  }))
  const id = await stagePrivateDelivery(store, {
    senderPubkey: pubkey,
    rumorId: "owner-local",
    createdAt: Date.now(),
    legs,
  })
  await store.database.commerceInboxDeliveries.update(store.key(id), {
    claim: undefined,
  })
  const evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
  const declarations = new Map(
    [
      [peer, peerSecret],
      [pubkey, secret],
    ].map(([principal, key]) => [
      principal,
      finalizeEvent(
        { kind: 10050, created_at: 100, tags: [["relay", relay]], content: "" },
        key as Uint8Array
      ),
    ])
  )
  const writes: unknown[] = []
  await retryPrivateDeliveries(
    pubkey,
    async (event, options) => {
      expect(options.shouldContinue?.()).toBe(true)
      writes.push({
        event,
        targets: options.exclusiveRelayUrls,
        owned: options.ownerSelectedRelayUrls,
      })
      return { successfulRelayUrls: [relay] } as never
    },
    id,
    store,
    async (recipient, options) => {
      const resolution = await resolveInboxDeclaration(recipient, {
        ...options,
        relayUrls: ["wss://discovery.relay.dev"],
        evidenceRepository,
        fetchEventsWithDiagnostics: async () => ({
          events: [declarations.get(recipient)!],
          attemptedRelayUrls: ["wss://discovery.relay.dev"],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: [],
          cappedRelayUrls: [],
        }),
      })
      return resolution
    }
  )
  expect(writes).toEqual([
    {
      event: JSON.parse(JSON.stringify(legs[1]!.event)),
      targets: [relay],
      owned: [relay],
    },
  ])
})

it.each([false, true])(
  "reads the current claimed delivery after a concurrent acknowledgement (complete=%s)",
  async (complete) => {
    const { store, pubkey, secret } = setup()
    const peer = getPublicKey(generateSecretKey())
    const targets = [
      "wss://one.synthetic.example",
      "wss://two.synthetic.example",
    ]
    const event = wrapEvent(
      {
        kind: 14,
        pubkey,
        created_at: 100,
        tags: [["p", peer]],
        content: "synthetic race",
      },
      secret,
      peer
    )
    const id = await stagePrivateDelivery(store, {
      senderPubkey: pubkey,
      rumorId: "race",
      createdAt: Date.now(),
      legs: [
        {
          recipientPubkey: peer,
          event,
          relayUrls: targets,
          ownerSelectedRelayUrls: [],
          compatibility: false,
          acknowledged: [],
          failed: [],
        },
      ],
    })
    await store.database.commerceInboxDeliveries.update(store.key(id), {
      claim: undefined,
    })
    const table = store.database.commerceInboxDeliveries
    const where = table.where.bind(table)
    const intercept = spyOn(table, "where").mockImplementation(
      (index: string) => {
        const clause = where(index)
        const equals = clause.equals.bind(clause)
        clause.equals = (key) => {
          const collection = equals(key)
          const toArray = collection.toArray.bind(collection)
          collection.toArray = (async () => {
            const rows = await toArray()
            await recordPrivateDelivery(store, id, event.id, {
              successfulRelayUrls: complete ? targets : [targets[0]!],
            } as never)
            return rows
          }) as typeof collection.toArray
          return collection
        }
        return clause
      }
    )
    const writes: string[][] = []
    try {
      await retryPrivateDeliveries(
        pubkey,
        async (_event, options) => {
          writes.push([...options.exclusiveRelayUrls!])
          return { successfulRelayUrls: options.exclusiveRelayUrls } as never
        },
        id,
        store,
        async () => ({
          pubkey: peer,
          state: "declared",
          relayUrls: targets,
          stale: false,
          fetchedAt: Date.now(),
        })
      )
    } finally {
      intercept.mockRestore()
    }
    expect(writes).toEqual(complete ? [] : [[targets[1]!]])
  }
)

it("keeps legacy recent and history reads on their own bounded relay plan", async () => {
  const { owner, pubkey, signer } = setup()
  signer.decryptLegacy = async () => "retained legacy conversation"
  const legacyEvent = finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000) - 10,
      tags: [["p", pubkey]],
      content: "synthetic ciphertext",
    },
    generateSecretKey()
  )
  const secureUrl = "wss://secure.relay.dev"
  const legacyUrl = "wss://legacy.relay.dev"
  const calls: Array<{ transport: string; url: string; personal: boolean }> = []
  const options = {
    declaration: {
      pubkey,
      state: "declared" as const,
      relayUrls: [secureUrl],
      stale: false,
      fetchedAt: Date.now(),
    },
    legacyRelayPlan: {
      relayUrls: [legacyUrl],
      ownerSelectedRelayUrls: [legacyUrl],
      appRelayUrls: [],
      personalRelayUrls: [legacyUrl],
    },
    read: async (
      input: import("../packages/core/src/protocol/protected-inbox-read").ReadProtectedInboxOptions
    ) => {
      calls.push({
        transport: input.transport!,
        url: input.relayUrls[0]!,
        personal: input.personalRelayUrls?.includes(legacyUrl) ?? false,
      })
      return completeRead(
        input.transport === "nip04_incoming" &&
          input.relayUrls.includes(legacyUrl)
          ? [legacyEvent]
          : []
      )
    },
  }
  const snapshot = await owner.syncRecent(options)
  expect(snapshot.directMessages.map((message) => message.transport)).toEqual([
    "nip04",
  ])
  const recentCalls = [...calls]
  expect(
    calls
      .filter((call) => call.transport === "nip17")
      .some((call) => call.url === secureUrl)
  ).toBe(true)
  expect(
    calls
      .filter((call) => call.transport === "nip17")
      .every((call) => call.url !== legacyUrl)
  ).toBe(true)
  expect(calls.filter((call) => call.transport !== "nip17")).toEqual([
    { transport: "nip04_incoming", url: legacyUrl, personal: true },
    { transport: "nip04_outgoing", url: legacyUrl, personal: true },
  ])
  calls.length = 0
  await owner.loadOlder(options)
  expect(calls).toEqual(recentCalls)
})

function historyRecoveryFixture() {
  const fixture = setup()
  // Retention must work even while the user has paused signer opening.
  fixture.signer.decryptNip44 = async () => {
    throw new NostrSignerError("authorization_denied")
  }
  const sender = generateSecretKey()
  const wrapKey = generateSecretKey()
  const relayUrl = "wss://history.synthetic.example"
  const events: ProtectedInboxReadResult["events"] = []
  const append = (count: number, timestamp?: number) => {
    for (let index = 0; index < count; index++) {
      const createdAt = timestamp ?? 1_700_000_000 + events.length
      const rumor = createRumor(
        {
          kind: 14,
          created_at: createdAt,
          tags: [["p", fixture.pubkey]],
          content: `synthetic-history-${events.length}`,
        },
        sender
      )
      const seal = createSeal(rumor, sender, fixture.pubkey)
      events.push(
        finalizeEvent(
          {
            kind: 1059,
            created_at: createdAt,
            tags: [["p", fixture.pubkey]],
            content: v2.encrypt(
              JSON.stringify(seal),
              v2.utils.getConversationKey(wrapKey, fixture.pubkey)
            ),
          },
          wrapKey
        )
      )
    }
  }
  const calls: import("../packages/core/src/protocol/protected-inbox-read").ReadProtectedInboxOptions[] =
    []
  const read = async (
    input: (typeof calls)[number]
  ): Promise<ProtectedInboxReadResult> => {
    calls.push(input)
    const selected = events
      .filter(
        (event) =>
          (input.until === undefined || event.created_at <= input.until) &&
          (input.since === undefined || event.created_at >= input.since)
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, input.limit)
    const result = completeRead(selected)
    result.relayResult.observations = [{ type: "eose", relayIndex: 0 }]
    result.relayResult.relays = [
      {
        relayIndex: 0,
        status: "success",
        auth: "not_challenged",
        eventCount: selected.length,
        duplicateCount: 0,
        malformedCount: 0,
        unusableCount: 0,
      },
    ]
    return result
  }
  return {
    ...fixture,
    append,
    events,
    calls,
    read,
    rangeId: fixture.store.key(`${relayUrl}:nip17`),
    options: {
      includeLegacy: false,
      declaration: {
        pubkey: fixture.pubkey,
        state: "declared" as const,
        relayUrls: [relayUrl],
        stale: false,
        fetchedAt: Date.now(),
      },
      read,
    },
  }
}

it("reconciles a newer saturated window before resuming saved history after reload", async () => {
  const f = historyRecoveryFixture()
  f.append(60)
  await f.owner.syncRecent(f.options)
  await f.owner.loadOlder(f.options)
  const prior = await f.database.commerceInboxRanges.get(f.rangeId)
  expect(f.owner.getSnapshot().diagnostics.states.permission_declined).toBe(1)
  expect(prior?.until).toBe(1_700_000_009)
  f.append(80)
  await f.owner.syncRecent(f.options)
  f.owner.stop()
  const reloaded = new CommerceInbox(f.owner.authorization, f.signer, f.store)
  owners.push(reloaded)
  // A repeated unchanged recent window must not keep resetting history work.
  for (let page = 0; page < 4; page++) {
    await reloaded.loadOlder(f.options)
    await reloaded.syncRecent(f.options)
    if (
      (await f.database.commerceInboxRanges.get(f.rangeId))?.status ===
      "source_eose"
    )
      break
  }
  const retained = await f.store.wrappers()
  expect(retained.length).toBe(f.events.length)
  expect(
    f.events.every((event) => retained.some((row) => row.event.id === event.id))
  ).toBe(true)
  expect((await f.database.commerceInboxRanges.get(f.rangeId))?.status).toBe(
    "source_eose"
  )
}, 60_000)

it.each(["partial", "capped"] as const)(
  "does not advance reopened history through a %s page",
  async (status: "partial" | "capped") => {
    const f = historyRecoveryFixture()
    f.append(60)
    await f.owner.syncRecent(f.options)
    await f.owner.loadOlder(f.options)
    if (status === "capped") f.append(512, 1_700_001_000)
    else f.append(80)
    await f.owner.syncRecent(f.options)
    await f.owner.loadOlder({
      ...f.options,
      read: async (input) => {
        const result = await f.read(input)
        if (status === "partial") {
          result.coverage = "partial"
          result.relayResult.status = "partial"
        }
        return result
      },
    })
    const range = await f.database.commerceInboxRanges.get(f.rangeId)
    expect(range?.status).toBe(status)
    expect(range?.until).toBeUndefined()
    expect(range?.pageCount).toBe(0)
    expect((await f.store.wrappers()).length).toBe(
      status === "capped" ? 562 : 100
    )
  },
  60_000
)

it("does not let an in-flight history page overwrite a newer recent-window reset", async () => {
  const f = historyRecoveryFixture()
  f.append(60)
  await f.owner.syncRecent(f.options)
  await f.owner.loadOlder(f.options)
  f.append(80)
  let release!: () => void
  let started!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  const page = f.owner.loadOlder({
    ...f.options,
    read: async (input) => {
      const result = await f.read(input)
      started()
      await hold
      return result
    },
  })
  await reading
  try {
    await f.owner.syncRecent(f.options)
  } finally {
    release()
  }
  const reset = await f.database.commerceInboxRanges.get(f.rangeId)
  await page
  expect(await f.database.commerceInboxRanges.get(f.rangeId)).toEqual(reset)
  expect(reset?.status).toBe("partial")
  expect(reset?.until).toBeUndefined()
  await f.owner.loadOlder(f.options)
  const resumed = await f.database.commerceInboxRanges.get(f.rangeId)
  expect(resumed?.until).toBe(1_700_000_089)
  expect(resumed?.status).toBe("advanced")
}, 60_000)
