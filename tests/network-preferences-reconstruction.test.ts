import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  __resetOwnerRelayListEvidenceForTests,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
  applyAccountNetworkRelayExclusion,
  applyInboxDeclarationDistributionOutcomes,
  applyInboxDeclarationDistributionStage,
  createInMemoryAccountNetworkLocalStateRepository,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  createRelaySettingsFromPreferences,
  emptyAccountNetworkLocalState,
  getAccountRelayScope,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  getRelaySettingsStorageKey,
  hydrateAccountNetworkPreferences,
  loadRelaySettings,
  planInboxReadRelays,
  readDurableAccountRelaySettingsPlanningSnapshot,
  reconcileAccountNetworkPreferences,
  sharedInboxDiscoveryRelayUrls,
  type ResolveOwnerRelayListOptions,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const SECRET = generateSecretKey()
const OWNER = getPublicKey(SECRET)
const ACCOUNT_SCOPE = getAccountRelayScope(OWNER)
const READ = "wss://signed-read.example"
const WRITE = "wss://signed-write.example"
const INBOX = "wss://signed-inbox.example"
const LEGACY = "wss://unsigned-legacy.example"
const DISCOVERY = sharedInboxDiscoveryRelayUrls()[0]!
const originalWindow = globalThis.window

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function installStorage(storage: MemoryStorage | Storage): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
  })
}

// Exact old fingerprints make these otherwise-committed payloads credible fixtures.
function fingerprint(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let hash = 14_695_981_039_346_656_037n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return `fnv1a64:${bytes.length}:${hash.toString(16).padStart(16, "0")}`
}

function obsoleteStorage(phase: "prepared" | "complete"): MemoryStorage {
  const storage = new MemoryStorage()
  const draft = JSON.stringify(
    createRelaySettingsFromPreferences(
      [{ url: LEGACY, readEnabled: true, writeEnabled: true }],
      "manual"
    )
  )
  for (const scope of [ACCOUNT_SCOPE, `market:${OWNER}`, `merchant:${OWNER}`]) {
    storage.setItem(getRelaySettingsStorageKey(scope), draft)
  }
  const recovery = JSON.stringify({ version: 1, readRelayUrls: [LEGACY] })
  storage.setItem(`conduit:network-legacy-read-recovery:v1:${OWNER}`, recovery)
  storage.setItem(
    `conduit:network-legacy-migration:v1:${OWNER}`,
    JSON.stringify({
      version: 1,
      phase,
      draftFingerprint: fingerprint(draft),
      recoveryFingerprint: fingerprint(recovery),
    })
  )
  return storage
}

function signedEvent(
  kind: 10002 | 10050,
  createdAt: number,
  tags: string[][]
): SignedPublicNostrEvent {
  return finalizeEvent(
    { kind, created_at: createdAt, tags, content: "" },
    SECRET
  )
}

function fetchEvent(
  event?: SignedPublicNostrEvent
): NonNullable<ResolveOwnerRelayListOptions["fetchEventsWithDiagnostics"]> {
  if (event) attachEventSourceRelayUrl(event as never, DISCOVERY)
  return async () => ({
    events: event ? [event as never] : [],
    attemptedRelayUrls: [DISCOVERY],
    successfulRelayUrls: [DISCOVERY],
    failedRelayUrls: [],
  })
}

function repositories() {
  return {
    ownerRelayList: {
      evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      now: () => 3_000,
    },
    inboxDeclaration: {
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      now: () => 3_000,
    },
    localStateRepository: createInMemoryAccountNetworkLocalStateRepository(),
  }
}

beforeEach(() => {
  __resetInboxDeclarationCache()
  __resetOwnerRelayListEvidenceForTests()
})
afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  })
  __resetInboxDeclarationCache()
  __resetOwnerRelayListEvidenceForTests()
})

describe("signed account Network reconstruction", () => {
  for (const phase of ["prepared", "complete"] as const) {
    it(`ignores ${phase} legacy bytes through hydrate, real reconciliation, and planning without signed evidence`, async () => {
      const storage = obsoleteStorage(phase)
      installStorage(storage)
      const before = [...storage.values]
      const retained = repositories()
      const hydrated = await hydrateAccountNetworkPreferences(OWNER, retained)
      expect(hydrated.projection.rows).toEqual([])
      expect(hydrated.localExcludedRelayUrls).toEqual([])
      const reconciled = await reconcileAccountNetworkPreferences(OWNER, {
        ...retained,
        relayUrls: [DISCOVERY],
        authenticatedPubkey: OWNER,
        ownerRelayList: {
          ...retained.ownerRelayList,
          fetchEventsWithDiagnostics: fetchEvent(),
        },
        inboxDeclaration: {
          ...retained.inboxDeclaration,
          fetchEventsWithDiagnostics: fetchEvent(),
        },
      })
      expect(reconciled.projection.rows).toEqual([])
      expect(reconciled.ownerRelayList.state).toBe("not_observed")
      expect(reconciled.inboxDeclaration.state).toBe("not_observed")
      const snapshot = await readDurableAccountRelaySettingsPlanningSnapshot(
        OWNER,
        retained.ownerRelayList
      )
      expect(snapshot.signedRelayListAuthoritative).toBe(false)
      expect(snapshot.settings.entries).toEqual([])
      expect(
        getGeneralReadRelayUrls({ ...snapshot, fallbackRelayUrls: [DISCOVERY] })
      ).toEqual([DISCOVERY])
      expect(
        getGeneralWriteRelayUrls({ ...snapshot, fallbackRelayUrls: [] })
      ).toEqual([])
      expect(
        planInboxReadRelays({
          declaration: reconciled.inboxDeclaration,
          authenticatedPubkey: OWNER,
          compatibilityRelayUrls: [],
        }).relayUrls
      ).toEqual([])
      for (const scope of [
        ACCOUNT_SCOPE,
        `market:${OWNER}`,
        `merchant:${OWNER}`,
      ]) {
        expect(loadRelaySettings(scope).entries).toEqual([])
      }
      expect([...storage.values]).toEqual(before)
    })
  }

  it("keeps invalid signed evidence and unavailable durable evidence non-authoritative", async () => {
    installStorage(obsoleteStorage("complete"))
    const retained = repositories()
    const invalidOwner = {
      ...signedEvent(10002, 100, [["r", READ]]),
      sig: "0".repeat(128),
    }
    const invalidInbox = {
      ...signedEvent(10050, 100, [["relay", INBOX]]),
      sig: "0".repeat(128),
    }
    const reconciled = await reconcileAccountNetworkPreferences(OWNER, {
      ...retained,
      relayUrls: [DISCOVERY],
      authenticatedPubkey: OWNER,
      ownerRelayList: {
        ...retained.ownerRelayList,
        fetchEventsWithDiagnostics: fetchEvent(invalidOwner),
      },
      inboxDeclaration: {
        ...retained.inboxDeclaration,
        fetchEventsWithDiagnostics: fetchEvent(invalidInbox),
      },
    })
    expect(reconciled.projection.rows).toEqual([])
    expect(
      (
        await readDurableAccountRelaySettingsPlanningSnapshot(
          OWNER,
          retained.ownerRelayList
        )
      ).signedRelayListAuthoritative
    ).toBe(false)
    __resetInboxDeclarationCache()
    __resetOwnerRelayListEvidenceForTests()
    const unavailable = async () => {
      throw new Error("durable evidence unavailable")
    }
    const hydrated = await hydrateAccountNetworkPreferences(OWNER, {
      ...retained,
      ownerRelayList: {
        evidenceRepository: {
          ...retained.ownerRelayList.evidenceRepository,
          get: unavailable,
        },
      },
      inboxDeclaration: {
        evidenceRepository: {
          ...retained.inboxDeclaration.evidenceRepository,
          get: unavailable,
        },
      },
    })
    expect(hydrated.projection.rows).toEqual([])
    expect(hydrated.ownerRelayList.state).toBe("lookup_unavailable")
    expect(hydrated.inboxDeclaration.state).toBe("lookup_unavailable")
  })

  it("reconstructs Read, Write, and Private Inbox from signed events after all process caches reset", async () => {
    installStorage(obsoleteStorage("complete"))
    const retained = repositories()
    const ownerEvent = signedEvent(10002, 100, [
      ["r", READ, "read"],
      ["r", WRITE, "write"],
    ])
    const inboxEvent = signedEvent(10050, 100, [["relay", INBOX]])
    const fresh = await reconcileAccountNetworkPreferences(OWNER, {
      ...retained,
      relayUrls: [DISCOVERY],
      authenticatedPubkey: OWNER,
      ownerRelayList: {
        ...retained.ownerRelayList,
        fetchEventsWithDiagnostics: fetchEvent(ownerEvent),
      },
      inboxDeclaration: {
        ...retained.inboxDeclaration,
        fetchEventsWithDiagnostics: fetchEvent(inboxEvent),
      },
    })
    expect(fresh.projection.rows).toEqual([
      {
        url: READ,
        position: 0,
        read: "published",
        write: null,
        privateInbox: null,
      },
      {
        url: WRITE,
        position: 1,
        read: null,
        write: "published",
        privateInbox: null,
      },
      {
        url: INBOX,
        position: 2,
        read: null,
        write: null,
        privateInbox: "published",
      },
    ])
    __resetInboxDeclarationCache()
    __resetOwnerRelayListEvidenceForTests()
    const reloaded = await hydrateAccountNetworkPreferences(OWNER, retained)
    expect(reloaded.projection.rows).toEqual(fresh.projection.rows)
    expect(reloaded.ownerRelayList.current?.signedEvent.id).toBe(ownerEvent.id)
    expect(reloaded.inboxDeclaration.eventId).toBe(inboxEvent.id)
    const snapshot = await readDurableAccountRelaySettingsPlanningSnapshot(
      OWNER,
      retained.ownerRelayList
    )
    expect(snapshot.signedRelayListAuthoritative).toBe(true)
    expect(
      getGeneralReadRelayUrls({ ...snapshot, fallbackRelayUrls: [] })
    ).toEqual([READ])
    expect(
      getGeneralWriteRelayUrls({ ...snapshot, fallbackRelayUrls: [] })
    ).toEqual([WRITE])
    expect(
      planInboxReadRelays({
        declaration: reloaded.inboxDeclaration,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      }).relayUrls
    ).toEqual([INBOX])
  })

  for (const brokenStorage of [false, true]) {
    it(`clears only causally superseded exclusions with ${brokenStorage ? "throwing localStorage" : "stale legacy bytes"}`, async () => {
      installStorage(
        brokenStorage
          ? ({
              getItem() {
                throw new Error("storage unavailable")
              },
              setItem() {
                throw new Error("storage unavailable")
              },
              removeItem() {
                throw new Error("storage unavailable")
              },
            } as unknown as Storage)
          : obsoleteStorage("complete")
      )
      const oldOwner = signedEvent(10002, 100, [["r", READ]])
      const oldInbox = signedEvent(10050, 100, [["relay", INBOX]])
      const newOwner = signedEvent(10002, 101, [["r", READ]])
      const newInbox = signedEvent(10050, 101, [["relay", INBOX]])
      const retained = repositories()
      let local = emptyAccountNetworkLocalState(OWNER)
      for (const relayUrl of [READ, INBOX, LEGACY]) {
        local = applyAccountNetworkRelayExclusion(local, {
          relayUrl,
          committedAt: 200,
          relayListFrontier: { eventId: oldOwner.id, createdAt: 100 },
          inboxDeclarationFrontier: { eventId: oldInbox.id, createdAt: 100 },
        })
      }
      await retained.localStateRepository.update(OWNER, () => local)
      const reconcile = (
        owner: SignedPublicNostrEvent,
        inbox: SignedPublicNostrEvent
      ) =>
        reconcileAccountNetworkPreferences(OWNER, {
          ...retained,
          relayUrls: [DISCOVERY],
          authenticatedPubkey: OWNER,
          ownerRelayList: {
            ...retained.ownerRelayList,
            fetchEventsWithDiagnostics: fetchEvent(owner),
          },
          inboxDeclaration: {
            ...retained.inboxDeclaration,
            fetchEventsWithDiagnostics: fetchEvent(inbox),
          },
        })
      expect(
        (await reconcile(oldOwner, oldInbox)).localExcludedRelayUrls
      ).toEqual([INBOX, READ, LEGACY].sort())
      expect(
        (await reconcile(newOwner, oldInbox)).localExcludedRelayUrls
      ).toEqual([INBOX, LEGACY].sort())
      expect(
        (await reconcile(newOwner, newInbox)).localExcludedRelayUrls
      ).toEqual([LEGACY])
      __resetInboxDeclarationCache()
      __resetOwnerRelayListEvidenceForTests()
      expect(
        (await hydrateAccountNetworkPreferences(OWNER, retained))
          .localExcludedRelayUrls
      ).toEqual([LEGACY])
    })
  }

  it("retains current inbox cutover recovery across reload independently of obsolete recovery bytes", async () => {
    installStorage(obsoleteStorage("complete"))
    const event = signedEvent(10050, 200, [["relay", INBOX]])
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent: event,
      publishRelayUrls: [DISCOVERY],
      relayOutcomes: [
        {
          relayUrl: DISCOVERY,
          publishStatus: "pending",
          publishAttemptCount: 0,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
      ],
      previousRelayUrls: [READ],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const confirmed = applyInboxDeclarationDistributionOutcomes(staged, {
      readback: [{ relayUrl: DISCOVERY, status: "observed" }],
      observedAt: 2_000,
    })
    const retained = repositories()
    retained.inboxDeclaration.evidenceRepository =
      createInMemoryInboxDeclarationEvidenceRepository([confirmed])
    __resetInboxDeclarationCache()
    const reloaded = await hydrateAccountNetworkPreferences(OWNER, retained)
    expect(reloaded.inboxDeclaration.cutoverRecoveryRelayUrls).toEqual([READ])
    const plan = planInboxReadRelays({
      declaration: reloaded.inboxDeclaration,
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(plan.relayUrls).toEqual([INBOX, READ])
    expect(plan.relaySources[READ]).toBe("cutover_recovery")
    expect(plan.relayUrls).not.toContain(LEGACY)
  })
})
