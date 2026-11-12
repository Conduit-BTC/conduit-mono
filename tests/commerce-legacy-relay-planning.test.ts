import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { config } from "../packages/core/src/config"
import { ConduitDB } from "../packages/core/src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  planLegacyDirectMessageRead,
} from "../packages/core/src/protocol/commerce"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import {
  createInMemoryOwnerRelayListEvidenceRepository,
  __resetOwnerRelayListEvidenceForTests,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import {
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import type { InboxDeclarationResolution } from "../packages/core/src/protocol/private-message-routing"
import { admitPublicEvent } from "../packages/core/src/protocol/verified-public-event"
import { parseRelayListEvent } from "../packages/core/src/protocol/relay-list"

const secret = new Uint8Array(32).fill(25)
const principal = getPublicKey(secret)
const app = "wss://app.legacy-planning.test"
const personal = "wss://owner.legacy-planning.test"
const originalConfig = { ...config }
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const databases: ConduitDB[] = []
const inboxes: CommerceInbox[] = []

beforeEach(() => {
  Object.assign(config, {
    appReadRelayUrls: [app],
    appBackplaneRelayUrls: [app],
    commerceDmFallbackRelayUrls: [app],
    dmCompatibilityOrderRelayUrls: [],
    corePublicFallbackRelayUrls: ["wss://generic.legacy-planning.test"],
    e2eRelayIsolationEnabled: false,
  })
  globalThis.fetch = (async () => {
    throw new Error("External fetch forbidden")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("External socket forbidden")
    }
  } as unknown as typeof WebSocket
  __setCommerceTestOverrides({
    ownerRelayListEvidenceRepository:
      createInMemoryOwnerRelayListEvidenceRepository(),
    getRelayLists: async () => new Map(),
    fetchPublicEvents: async () => [],
  })
})

afterEach(async () => {
  for (const inbox of inboxes.splice(0)) inbox.stop()
  for (const database of databases.splice(0)) await database.delete()
  __resetCommerceTestOverrides()
  __resetOwnerRelayListEvidenceForTests()
  __resetProtectedReadSigner()
  Object.assign(config, originalConfig)
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
})

async function ownerEvidence(relays: string[]) {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: 1_800_000_000,
      tags: relays.map((url) => ["r", url]),
      content: "",
    },
    secret
  )
  const admitted = await admitPublicEvent(event)
  if (admitted.status !== "verified") throw new Error("Fixture refused")
  const repository = createInMemoryOwnerRelayListEvidenceRepository()
  await repository.reconcile({
    pubkey: principal,
    observations: [
      { signedEvent: admitted.event, sourceRelayUrls: [app], observedAt: 1 },
    ],
    lookup: { coverage: "complete", observedAt: 1, hadEvent: true },
  })
  return { repository, list: parseRelayListEvent(admitted.event) }
}

async function openInbox() {
  let active = true
  const signer: NostrKeySigner = {
    authMethod: "nip07",
    pubkey: principal,
    getPublicKey: async () => principal,
    signEvent: async (event) => finalizeEvent(event, secret),
    encryptNip44: async () => {
      throw new Error("Unexpected encryption")
    },
    decryptNip44: async () => {
      throw new Error("Unexpected decryption")
    },
    decryptLegacy: async () => {
      throw new Error("Unexpected decryption")
    },
  }
  installProtectedReadSigner(signer, principal, () => active)
  const authorization = getProtectedReadAuthorization(principal)
  if (!authorization) throw new Error("Fixture authority missing")
  const database = new ConduitDB(`legacy-plan-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  const inbox = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  inboxes.push(inbox)
  return { inbox, revoke: () => (active = false) }
}

const declaration: InboxDeclarationResolution = {
  pubkey: principal,
  state: "missing",
  relayUrls: [],
  stale: false,
  fetchedAt: 1,
}

describe("legacy inbox relay planner composition", () => {
  it("preserves bounded compatibility policy and partial facade overrides", async () => {
    let lookups = 0
    __setCommerceTestOverrides({
      getRelayLists: async (_pubkeys, options) => {
        lookups++
        expect(options?.cacheOnly).toBe(true)
        expect(options?.shouldContinue?.()).toBe(true)
        return new Map()
      },
    })
    __setCommerceTestOverrides({ now: () => 123 })
    const plan = await planLegacyDirectMessageRead(principal, () => true)
    expect(lookups).toBe(1)
    expect(plan.relayUrls).toContain(app)
    expect(plan.relayUrls).not.toContain("wss://generic.legacy-planning.test")
    expect(plan.maxRelayAttempts).toBe(24)
  })

  it("preserves durable signed owner selection and suppresses signed-empty owner hint lookup", async () => {
    const { repository } = await ownerEvidence([])
    let lookups = 0
    __setCommerceTestOverrides({
      ownerRelayListEvidenceRepository: repository,
      getRelayLists: async () => {
        lookups++
        return new Map()
      },
    })
    const plan = await planLegacyDirectMessageRead(principal, () => true)
    expect(lookups).toBe(0)
    expect(plan.ownerSelectedRelayUrls).toEqual([])
    expect(plan.relayUrls).not.toContain(personal)
  })

  it("reads effective facade overrides after an awaited durable snapshot, including reset", async () => {
    const fixture = await ownerEvidence([personal])
    let release!: () => void
    let entered!: () => void
    const observed = new Promise<void>((resolve) => (entered = resolve))
    const pending = new Promise<void>((resolve) => (release = resolve))
    const get = fixture.repository.get.bind(fixture.repository)
    fixture.repository.get = async (key) => {
      entered()
      await pending
      return get(key)
    }
    let oldLookups = 0
    let newLookups = 0
    __setCommerceTestOverrides({
      ownerRelayListEvidenceRepository: fixture.repository,
      getRelayLists: async () => {
        oldLookups++
        return new Map()
      },
    })
    const plan = planLegacyDirectMessageRead(principal, () => true)
    await observed
    __resetCommerceTestOverrides()
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => [],
      getRelayLists: async (_keys, options) => {
        newLookups++
        expect(options?.cacheOnly).toBe(true)
        return new Map([[principal, fixture.list]])
      },
    })
    release()
    expect((await plan).ownerSelectedRelayUrls).toContain(personal)
    expect(oldLookups).toBe(0)
    expect(newLookups).toBe(1)
  })

  it("skips default legacy planning for includeLegacy=false and an explicit plan", async () => {
    const { inbox } = await openInbox()
    let lookups = 0
    __setCommerceTestOverrides({
      getRelayLists: async () => {
        lookups++
        throw new Error("Default legacy planner must not run")
      },
    })
    await inbox.refreshRecent({
      declaration,
      includeLegacy: false,
      read: async () => {
        throw new Error("Unexpected secure transport")
      },
    })
    await inbox.refreshRecent({
      declaration,
      legacyRelayPlan: { relayTargets: [], relayUrls: [] },
    })
    expect(lookups).toBe(0)
  })

  it("rechecks inbox authority after default legacy planning awaits", async () => {
    const { inbox, revoke } = await openInbox()
    let reads = 0
    __setCommerceTestOverrides({
      getRelayLists: async (_keys, options) => {
        expect(options?.shouldContinue?.()).toBe(true)
        revoke()
        return new Map()
      },
    })
    await expect(
      inbox.refreshRecent({
        declaration,
        read: async () => {
          reads++
          throw new Error("Transport after revoked authority")
        },
      })
    ).rejects.toThrow("authority")
    expect(reads).toBe(0)
  })
})
