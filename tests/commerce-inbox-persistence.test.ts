import { afterEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { wrapEvent } from "nostr-tools/nip59"
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
