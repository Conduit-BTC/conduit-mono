import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  __resetOwnerRelayListEvidenceForTests,
  clearLegacyRelayReadRecovery,
  config,
  createInMemoryAccountNetworkLocalStateRepository,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  createRelaySettingsFromPreferences,
  DEFAULT_READ_FANOUT,
  getAccountRelayScope,
  getCommittedLegacyRelayReadRecovery,
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  getPublishableRelaySettingsEntries,
  hasRelaySettingsDraft,
  hydrateAccountNetworkPreferences,
  getRelaySettingsStorageKey,
  getSignedInRelayScope,
  loadRelaySettingsForPlan,
  migrateLegacyRelaySettingsDraft,
  normalizeOwnerRelayListPubkey,
  planInboxReadRelays,
  planRelayReads,
  planRelayWrites,
  planRelaysWithSnapshot,
  prepareAccountNetworkPreferencesPresentation,
  projectAccountNetworkPreferences,
  readDurableAccountRelaySettingsPlanningSnapshot,
  reconcileAccountNetworkPreferences,
  reconcileOwnerRelayListEvidence,
  resolveConduitSession,
  saveRelaySettings,
  serializeNip65RelayTags,
  setActiveRelaySettingsScope,
  subscribeRelaySettingsChanges,
  type InboxDeclarationResolution,
  type OwnerRelayListEvidenceRecord,
  type OwnerRelayListEvidenceRepository,
  type OwnerRelayListResolution,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = getPublicKey(generateSecretKey())
const ACCOUNT_SCOPE = `account:${OWNER}`

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  entries(): Array<[string, string]> {
    return Array.from(this.values.entries())
  }
}

type StorageFault = {
  operation: "set" | "remove"
  call: number
}

class FaultInjectingStorage extends MemoryStorage {
  private fault: StorageFault | null = null
  private setCalls = 0
  private removeCalls = 0

  arm(fault: StorageFault): void {
    this.fault = fault
    this.setCalls = 0
    this.removeCalls = 0
  }

  clearFault(): void {
    this.fault = null
    this.setCalls = 0
    this.removeCalls = 0
  }

  override setItem(key: string, value: string): void {
    this.setCalls += 1
    if (this.fault?.operation === "set" && this.fault.call === this.setCalls) {
      this.fault = null
      return
    }
    super.setItem(key, value)
  }

  override removeItem(key: string): void {
    this.removeCalls += 1
    if (
      this.fault?.operation === "remove" &&
      this.fault.call === this.removeCalls
    ) {
      this.fault = null
      return
    }
    super.removeItem(key)
  }
}

function seedLegacyRelaySettings(storage: MemoryStorage): string {
  const legacyKey = getRelaySettingsStorageKey(`market:${OWNER}`)
  storage.setItem(
    legacyKey,
    JSON.stringify({
      ...createRelaySettingsFromPreferences(
        [
          {
            url: "wss://legacy-read.example",
            readEnabled: true,
            writeEnabled: true,
          },
          {
            url: "wss://legacy-write-only.example",
            readEnabled: false,
            writeEnabled: true,
          },
        ],
        "manual"
      ),
      updatedAt: 42,
    })
  )
  return legacyKey
}

function storageValueFingerprint(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let hash = 14_695_981_039_346_656_037n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return `fnv1a64:${bytes.length}:${hash.toString(16).padStart(16, "0")}`
}

function seedCommittedLegacyCompatibility(storage: MemoryStorage): string {
  const draftKey = getRelaySettingsStorageKey(ACCOUNT_SCOPE)
  const draftRaw = JSON.stringify(
    createRelaySettingsFromPreferences(
      [
        {
          url: "wss://legacy-read.example",
          readEnabled: true,
          writeEnabled: true,
        },
      ],
      "manual"
    )
  )
  const recoveryRaw = JSON.stringify({
    version: 1,
    readRelayUrls: ["wss://legacy-read.example"],
  })
  storage.setItem(draftKey, draftRaw)
  storage.setItem(
    `conduit:network-legacy-read-recovery:v1:${OWNER}`,
    recoveryRaw
  )
  storage.setItem(
    `conduit:network-legacy-migration:v1:${OWNER}`,
    JSON.stringify({
      version: 1,
      phase: "complete",
      draftFingerprint: storageValueFingerprint(draftRaw),
      recoveryFingerprint: storageValueFingerprint(recoveryRaw),
    })
  )
  return draftKey
}

function relayEvent(
  createdAt = 100,
  tags: string[][] = [["r", "wss://signed.example"]]
): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: createdAt,
      tags,
      content: "",
    },
    OWNER_SECRET
  )
  return { ...event, tags: event.tags.map((tag) => [...tag]) }
}

function ownerResolution(
  overrides: Partial<OwnerRelayListResolution> = {}
): OwnerRelayListResolution {
  const pubkey = normalizeOwnerRelayListPubkey(OWNER)!
  return {
    pubkey,
    state: "not_observed",
    preferences: [],
    stale: false,
    lookup: {
      observedAt: 1_000,
      coverage: "complete",
      hadEvent: false,
    },
    observation: {
      coverage: "complete",
      attemptedRelayUrls: ["wss://discovery.example"],
      successfulRelayUrls: ["wss://discovery.example"],
      failedRelayUrls: [],
      cappedRelayUrls: [],
      eventSourceRelayUrls: [],
    },
    ...overrides,
  }
}

function signedRelayListResolution(input: {
  state: "declared" | "signed_empty" | "malformed"
  tags: string[][]
  preferences: OwnerRelayListResolution["preferences"]
}): OwnerRelayListResolution {
  const signedEvent = relayEvent(100, input.tags)
  return ownerResolution({
    state: input.state,
    preferences: input.preferences,
    current: {
      state: input.state,
      signedEvent,
      preferences: input.preferences,
      sourceRelayUrls: ["wss://discovery.example"],
      observedAt: 1_000,
      completeObservedAt: 1_000,
      invalidRelayTagCount: 0,
      duplicateRelayTagCount: 0,
    },
    lookup: {
      observedAt: 1_000,
      coverage: "complete",
      hadEvent: true,
      eventId: signedEvent.id,
    },
  })
}

function signedOwnerResolution(): OwnerRelayListResolution {
  return signedRelayListResolution({
    state: "declared",
    tags: [["r", "wss://signed.example"]],
    preferences: [
      {
        url: "wss://signed.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ],
  })
}

async function retainOwnerResolution(
  resolution: OwnerRelayListResolution
): Promise<OwnerRelayListEvidenceRepository> {
  const repository = createInMemoryOwnerRelayListEvidenceRepository()
  const eventEvidence = [resolution.lastUsable, resolution.current].filter(
    (evidence): evidence is NonNullable<OwnerRelayListResolution["current"]> =>
      Boolean(evidence)
  )
  await reconcileOwnerRelayListEvidence(
    {
      pubkey: OWNER,
      observations: eventEvidence.map((evidence) => ({
        signedEvent: evidence.signedEvent,
        sourceRelayUrls: evidence.sourceRelayUrls,
        observedAt: evidence.observedAt,
        completeObservedAt: evidence.completeObservedAt,
      })),
      lookup: resolution.lookup,
    },
    repository
  )
  return repository
}

function inboxResolution(
  overrides: Partial<InboxDeclarationResolution> = {}
): InboxDeclarationResolution {
  return {
    pubkey: OWNER,
    state: "not_observed",
    relayUrls: [],
    stale: false,
    fetchedAt: 1_000,
    ...overrides,
  }
}

const originalWindow = globalThis.window

beforeEach(() => {
  __resetInboxDeclarationCache()
  __resetOwnerRelayListEvidenceForTests()
  setActiveRelaySettingsScope(null)
})

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  })
  __resetInboxDeclarationCache()
  __resetOwnerRelayListEvidenceForTests()
  setActiveRelaySettingsScope(null)
})

describe("account Network preferences", () => {
  it("returns canonical committed exclusions and refreshes them after authoritative re-adds", async () => {
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    await localStateRepository.update(OWNER, (current) => ({
      ...current,
      exclusions: [
        {
          relayUrl: "wss://signed.example",
          committedAt: 2,
          relayListFrontier: { eventId: null, createdAt: null },
          inboxDeclarationFrontier: { eventId: null, createdAt: null },
        },
        {
          relayUrl: "wss://another-removed.example",
          committedAt: 1,
          relayListFrontier: { eventId: null, createdAt: null },
          inboxDeclarationFrontier: { eventId: null, createdAt: null },
        },
      ],
    }))

    const hydrated = await hydrateAccountNetworkPreferences(OWNER, {
      storage: new MemoryStorage(),
      localStateRepository,
    })
    expect(hydrated.localExcludedRelayUrls).toEqual([
      "wss://another-removed.example",
      "wss://signed.example",
    ])

    const signedOwner = signedOwnerResolution()
    const observedSignedOwner: OwnerRelayListResolution = {
      ...signedOwner,
      observation: {
        coverage: "complete",
        attemptedRelayUrls: ["wss://discovery.example"],
        successfulRelayUrls: ["wss://discovery.example"],
        failedRelayUrls: [],
        cappedRelayUrls: [],
        eventId: signedOwner.current!.signedEvent.id,
        eventSourceRelayUrls: ["wss://discovery.example"],
      },
    }
    const ownerEvidence: OwnerRelayListEvidenceRecord = {
      pubkey: normalizeOwnerRelayListPubkey(OWNER)!,
      current: signedOwner.current!,
      lastUsable: signedOwner.current!,
      latestLookup: signedOwner.lookup,
      cachedAt: 1_000,
    }
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      storage: new MemoryStorage(),
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository([
          ownerEvidence,
        ]),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => observedSignedOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(reconciliation.localExcludedRelayUrls).toEqual([
      "wss://another-removed.example",
    ])
  })

  it("uses one signed-in scope for Market and Merchant", () => {
    const market = resolveConduitSession({ appId: "market", pubkey: OWNER })
    const merchant = resolveConduitSession({ appId: "merchant", pubkey: OWNER })
    expect(market.relayScope).toBe(ACCOUNT_SCOPE)
    expect(merchant.relayScope).toBe(ACCOUNT_SCOPE)
    expect(market.relayScope).toBe(merchant.relayScope)
    expect(getAccountRelayScope(OWNER)).toBe(ACCOUNT_SCOPE)
    expect(getSignedInRelayScope("market", OWNER)).toBe(
      getSignedInRelayScope("merchant", OWNER)
    )
  })

  it("emits account draft notifications without granting runtime authority", () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const changes: Array<string | null> = []
    const unsubscribe = subscribeRelaySettingsChanges((scope) => {
      changes.push(scope)
    })

    try {
      const settings = createRelaySettingsFromPreferences(
        [
          {
            url: "wss://draft.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ],
        "manual"
      )
      saveRelaySettings(settings, ACCOUNT_SCOPE)
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([ACCOUNT_SCOPE])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
  })

  it("defers legacy cleanup on partial evidence and leaves complete-absence roles at their sole source", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const marketKey = getRelaySettingsStorageKey(`market:${OWNER}`)
    const merchantKey = getRelaySettingsStorageKey(`merchant:${OWNER}`)
    storage.setItem(
      marketKey,
      JSON.stringify({
        version: 1,
        updatedAt: 10,
        entries: createRelaySettingsFromPreferences(
          [
            {
              url: "wss://market-legacy.example",
              readEnabled: true,
              writeEnabled: false,
            },
          ],
          "manual"
        ).entries,
      })
    )
    storage.setItem(
      merchantKey,
      JSON.stringify({
        version: 1,
        updatedAt: 20,
        entries: createRelaySettingsFromPreferences(
          [
            {
              url: "wss://merchant-legacy.example",
              readEnabled: false,
              writeEnabled: true,
            },
          ],
          "manual"
        ).entries,
      })
    )

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution({
          state: "lookup_partial",
          lookup: {
            observedAt: 1,
            coverage: "partial",
            hadEvent: false,
          },
        }),
        storage,
        localStateRepository,
      })
    ).toBe("deferred")
    expect(storage.getItem(marketKey)).not.toBeNull()
    expect(storage.getItem(merchantKey)).not.toBeNull()

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
        localStateRepository,
      })
    ).toBe("review_required")
    expect(storage.getItem(marketKey)).not.toBeNull()
    expect(storage.getItem(merchantKey)).not.toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
        localStateRepository,
      })
    ).toBe("review_required")
  })

  it("does not retire legacy settings for a malformed frontier without usable signed evidence", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const legacyKey = seedLegacyRelaySettings(storage)
    const malformed = signedRelayListResolution({
      state: "malformed",
      tags: [["r", "not a relay"]],
      preferences: [],
    })

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: malformed,
        storage,
        localStateRepository,
      })
    ).toBe("deferred")
    expect(storage.getItem(legacyKey)).not.toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
  })

  it("retires legacy keys without letting unsigned state override signed evidence", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const signedOwner = signedOwnerResolution()
    const legacyKey = getRelaySettingsStorageKey(`market:${OWNER}`)
    storage.setItem(
      legacyKey,
      JSON.stringify(
        createRelaySettingsFromPreferences(
          [
            {
              url: "wss://legacy.example",
              readEnabled: true,
              writeEnabled: true,
            },
          ],
          "manual"
        )
      )
    )
    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: signedOwner,
        durableOwnerRelayList: signedOwner,
        storage,
        localStateRepository,
      })
    ).toBe("retired_signed_wins")
    expect(storage.getItem(legacyKey)).toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
  })

  it("returns a legacy review candidate from the same injected storage seam", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    storage.setItem(
      getRelaySettingsStorageKey(`market:${OWNER}`),
      JSON.stringify(
        createRelaySettingsFromPreferences(
          [
            {
              url: "wss://legacy-draft.example",
              readEnabled: true,
              writeEnabled: false,
            },
          ],
          "manual"
        )
      )
    )
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })
    expect(reconciliation.legacyMigration).toBe("review_required")
    expect(reconciliation.projection.rows).toEqual([])
    expect(
      reconciliation.legacyReviewCandidate?.draft.entries.map(
        (entry) => entry.url
      )
    ).toEqual(["wss://legacy-draft.example"])
    expect(reconciliation.legacyInboxRecoveryRelayUrls).toEqual([])
  })

  it("does not reinterpret untouched NIP-65 roles as inbox recovery", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    seedLegacyRelaySettings(storage)
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })

    expect(
      reconciliation.projection.rows.every(
        (row) => row.read !== "published" && row.write !== "published"
      )
    ).toBe(true)
    expect(
      getGeneralReadRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    const plan = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(plan.relayUrls).toEqual([])
    expect(plan.relaySources).toEqual({})
  })

  for (const lookup of [
    { state: "lookup_partial", coverage: "partial" },
    { state: "lookup_unavailable", coverage: "unavailable" },
  ] as const) {
    it(`preserves legacy source bytes while kind-10002 lookup is ${lookup.coverage}`, async () => {
      const storage = new MemoryStorage()
      const localStateRepository =
        createInMemoryAccountNetworkLocalStateRepository()
      const legacyKey = seedLegacyRelaySettings(storage)
      const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: ["wss://shared.example"],
        storage,
        localStateRepository,
        ownerRelayList: {
          evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
        },
        inboxDeclaration: {
          evidenceRepository:
            createInMemoryInboxDeclarationEvidenceRepository(),
        },
        resolveOwner: async () =>
          ownerResolution({
            state: lookup.state,
            lookup: {
              observedAt: 1_000,
              coverage: lookup.coverage,
              hadEvent: false,
            },
          }),
        resolveInbox: async () => inboxResolution(),
      })

      expect(reconciliation.legacyMigration).toBe("deferred")
      expect(storage.getItem(legacyKey)).not.toBeNull()
      expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
      expect(reconciliation.projection.rows).toEqual([])
      expect(reconciliation.legacyInboxRecoveryRelayUrls).toEqual([])
      expect(
        planInboxReadRelays({
          declaration: inboxResolution(),
          authenticatedPubkey: OWNER,
          compatibilityRelayUrls: [],
        }).relayUrls
      ).toEqual([])
    })
  }

  it("keeps an explicit recovery clear tombstoned across partial reconciliation", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const legacyKey = seedLegacyRelaySettings(storage)
    const partialOwner = async () =>
      ownerResolution({
        state: "lookup_partial",
        lookup: {
          observedAt: 1_000,
          coverage: "partial",
          hadEvent: false,
        },
      })

    const deferred = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: partialOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(deferred.legacyMigration).toBe("deferred")
    expect(deferred.legacyInboxRecoveryRelayUrls).toEqual([])

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(legacyKey)).toBeNull()

    const afterClear = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: partialOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(afterClear.legacyMigration).toBe("already_complete")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(afterClear.legacyInboxRecoveryRelayUrls).toEqual([])
    expect(
      planInboxReadRelays({
        declaration: inboxResolution(),
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      }).relayUrls
    ).toEqual([])
  })

  it("retires and ignores an app-scoped legacy key rewritten after recovery was cleared", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const legacyKey = seedLegacyRelaySettings(storage)
    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(legacyKey)).toBeNull()

    seedLegacyRelaySettings(storage)
    expect(storage.getItem(legacyKey)).not.toBeNull()
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () =>
        ownerResolution({
          state: "lookup_unavailable",
          lookup: {
            observedAt: 1_000,
            coverage: "unavailable",
            hadEvent: false,
          },
        }),
      resolveInbox: async () => inboxResolution(),
    })

    expect(reconciliation.legacyMigration).toBe("already_complete")
    expect(storage.getItem(legacyKey)).toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(reconciliation.legacyInboxRecoveryRelayUrls).toEqual([])
  })

  it("lets signed state supersede an uncommitted legacy review candidate", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const inboxRepository = createInMemoryInboxDeclarationEvidenceRepository()
    seedLegacyRelaySettings(storage)
    const first = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: { evidenceRepository: inboxRepository },
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })
    expect(first.legacyMigration).toBe("review_required")
    expect(first.legacyReviewCandidate).not.toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()

    const signedOwner = signedOwnerResolution()
    const ownerRepository = createInMemoryOwnerRelayListEvidenceRepository()
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [
          {
            signedEvent: signedOwner.current!.signedEvent,
            sourceRelayUrls: signedOwner.current!.sourceRelayUrls,
            observedAt: signedOwner.current!.observedAt,
            completeObservedAt: signedOwner.current!.completeObservedAt,
          },
        ],
        lookup: signedOwner.lookup,
      },
      ownerRepository
    )
    const signed = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      localStateRepository,
      ownerRelayList: { evidenceRepository: ownerRepository },
      inboxDeclaration: { evidenceRepository: inboxRepository },
      resolveOwner: async () => signedOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(signed.legacyMigration).toBe("retired_signed_wins")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(signed.projection.rows.map((row) => row.url)).toEqual([
      "wss://signed.example",
    ])
    expect(signed.legacyInboxRecoveryRelayUrls).toEqual([])
    expect(
      planInboxReadRelays({
        declaration: inboxResolution(),
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      }).relaySources
    ).toEqual({})
  })

  it("keeps legacy relay state until fresh owner evidence survives a durable reread", async () => {
    const storage = new MemoryStorage()
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const inboxRepository = createInMemoryInboxDeclarationEvidenceRepository()
    const legacyKey = seedLegacyRelaySettings(storage)
    const discoveryRelayUrl = "wss://nos.lol"
    const signedEvent = relayEvent(200, [["r", "wss://signed-b.example"]])
    const writeFailingRepository: OwnerRelayListEvidenceRepository = {
      get: async () => undefined,
      reconcile: async () => {
        throw new Error("owner evidence storage unavailable")
      },
    }
    const signedRead = {
      events: [signedEvent as never],
      attemptedRelayUrls: [discoveryRelayUrl],
      successfulRelayUrls: [discoveryRelayUrl],
      failedRelayUrls: [],
    }

    const processOnly = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [discoveryRelayUrl],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: writeFailingRepository,
        now: () => 2_000,
        fetchEventsWithDiagnostics: async () => signedRead,
      },
      inboxDeclaration: { evidenceRepository: inboxRepository },
      resolveInbox: async () => inboxResolution(),
    })

    expect(processOnly.ownerRelayList.preferences).toEqual([
      {
        url: "wss://signed-b.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ])
    expect(processOnly.legacyMigration).toBe("deferred")
    expect(storage.getItem(legacyKey)).not.toBeNull()

    __resetOwnerRelayListEvidenceForTests()
    const afterRestart = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [discoveryRelayUrl],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: writeFailingRepository,
        now: () => 3_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: [discoveryRelayUrl],
          successfulRelayUrls: [],
          failedRelayUrls: [discoveryRelayUrl],
        }),
      },
      inboxDeclaration: { evidenceRepository: inboxRepository },
      resolveInbox: async () => inboxResolution(),
    })

    expect(afterRestart.ownerRelayList.state).toBe("lookup_unavailable")
    expect(storage.getItem(legacyKey)).not.toBeNull()

    const durableRepository = createInMemoryOwnerRelayListEvidenceRepository()
    const durable = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [discoveryRelayUrl],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: durableRepository,
        now: () => 4_000,
        fetchEventsWithDiagnostics: async () => signedRead,
      },
      inboxDeclaration: { evidenceRepository: inboxRepository },
      resolveInbox: async () => inboxResolution(),
    })

    expect(durable.legacyMigration).toBe("retired_signed_wins")
    expect(storage.getItem(legacyKey)).toBeNull()
  })

  it("keeps a signed Write-only overlap visible while inbox recovery adds only private Read", () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const base = signedOwnerResolution()
    const preference = {
      url: "wss://signed.example",
      readEnabled: false,
      writeEnabled: true,
    }
    const ownerRelayList: OwnerRelayListResolution = {
      ...base,
      preferences: [preference],
      current: { ...base.current!, preferences: [preference] },
    }
    const projection = projectAccountNetworkPreferences({
      pubkey: OWNER,
      relayScope: ACCOUNT_SCOPE,
      ownerRelayList,
      inboxDeclaration: inboxResolution(),
    })
    const signedSettings = createRelaySettingsFromPreferences(
      ownerRelayList.preferences,
      "published"
    )

    expect(projection.rows).toEqual([
      expect.objectContaining({
        url: "wss://signed.example",
        read: null,
        write: "published",
      }),
    ])
    expect(
      getGeneralReadRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    const publishable = getPublishableRelaySettingsEntries(
      signedSettings.entries
    )
    expect(publishable).toEqual([
      expect.objectContaining({
        url: "wss://signed.example",
        readEnabled: false,
        writeEnabled: true,
      }),
    ])
    expect(serializeNip65RelayTags(publishable)).toEqual([
      ["r", "wss://signed.example", "write"],
    ])
    const inboxPlan = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      migrationRecoveryRelayUrls: ["wss://signed.example"],
      compatibilityRelayUrls: [],
    })
    expect(inboxPlan.relayUrls).toEqual(["wss://signed.example"])
    expect(inboxPlan.relaySources).toEqual({
      "wss://signed.example": "migration_recovery",
    })
  })

  it("does not infer an inbox route from a signed NIP-65 Read relay", async () => {
    const signedRead = signedRelayListResolution({
      state: "declared",
      tags: [["r", "wss://signed-read.example", "read"]],
      preferences: [
        {
          url: "wss://signed-read.example",
          readEnabled: true,
          writeEnabled: false,
        },
      ],
    })
    const settingsSnapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: await retainOwnerResolution(signedRead),
      })
    expect(settingsSnapshot.settings.entries.map((entry) => entry.url)).toEqual(
      ["wss://signed-read.example"]
    )
    setActiveRelaySettingsScope(ACCOUNT_SCOPE)
    expect(getGeneralReadRelayUrls({ fallbackRelayUrls: [] })).toEqual([])

    const beforeRecovery = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(beforeRecovery.relayUrls).toEqual([])

    const afterRecovery = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      migrationRecoveryRelayUrls: ["wss://signed-read.example"],
      compatibilityRelayUrls: [],
    })
    expect(afterRecovery.relayUrls).toEqual(["wss://signed-read.example"])
    expect(afterRecovery.relaySources).toEqual({
      "wss://signed-read.example": "migration_recovery",
    })
  })

  it("keeps signed-empty account reads empty while public commerce discovery remains available", async () => {
    const signedEmpty = signedRelayListResolution({
      state: "signed_empty",
      tags: [],
      preferences: [],
    })
    const settingsSnapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: await retainOwnerResolution(signedEmpty),
      })

    const fallback = ["wss://bootstrap.example"]
    expect(
      getGeneralReadRelayUrls({
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        fallbackRelayUrls: fallback,
      })
    ).toEqual([])
    expect(
      getCommerceReadRelayUrls({
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        fallbackRelayUrls: fallback,
      })
    ).toEqual([])
    expect(
      planRelayReads({
        intent: "general",
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        skipHealthFilter: true,
      }).relayUrls
    ).toEqual([])
    expect(
      planRelayReads({
        intent: "commerce_products",
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        skipHealthFilter: true,
      }).relayUrls
    ).toContain(config.commerceDiscoveryRelayUrls[0])
    expect(
      planRelayReads({
        intent: "commerce_products",
        skipHealthFilter: true,
      }).relayUrls
    ).toContain(config.commerceDiscoveryRelayUrls[0])
  })

  it("keeps a signed Write-only relay list empty for generic reads", async () => {
    const writeOnlyUrl = "wss://write-only.example"
    const writeOnly = signedRelayListResolution({
      state: "declared",
      tags: [["r", writeOnlyUrl, "write"]],
      preferences: [
        {
          url: writeOnlyUrl,
          readEnabled: false,
          writeEnabled: true,
        },
      ],
    })
    const settingsSnapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: await retainOwnerResolution(writeOnly),
      })

    expect(
      getGeneralReadRelayUrls({
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        fallbackRelayUrls: ["wss://bootstrap.example"],
      })
    ).toEqual([])
    expect(
      getGeneralWriteRelayUrls({
        settings: settingsSnapshot.settings,
        fallbackRelayUrls: [],
      })
    ).toEqual([writeOnlyUrl])
    const commerceRelayUrls = planRelayReads({
      intent: "commerce_products",
      settings: settingsSnapshot.settings,
      signedRelayListAuthoritative:
        settingsSnapshot.signedRelayListAuthoritative,
      skipHealthFilter: true,
    }).relayUrls
    expect(commerceRelayUrls).toContain(config.commerceDiscoveryRelayUrls[0])
    expect(commerceRelayUrls).not.toContain(writeOnlyUrl)
    const activeCommerceRelayUrls = planRelayReads({
      intent: "commerce_products",
      skipHealthFilter: true,
    }).relayUrls
    expect(activeCommerceRelayUrls).toContain(
      config.commerceDiscoveryRelayUrls[0]
    )
    expect(activeCommerceRelayUrls).not.toContain(writeOnlyUrl)
  })

  it("uses bounded bootstrap reads when no signed relay-list evidence exists", async () => {
    const storage = new MemoryStorage()
    await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })

    expect(
      getGeneralReadRelayUrls({
        scope: ACCOUNT_SCOPE,
        fallbackRelayUrls: ["wss://bootstrap.example"],
      })
    ).toEqual(["wss://bootstrap.example"])
    const plan = planRelaysWithSnapshot(ACCOUNT_SCOPE).planReads({
      intent: "general",
      skipHealthFilter: true,
    })
    expect(plan.relayUrls.length).toBeGreaterThan(0)
    expect(plan.relayUrls.length).toBeLessThanOrEqual(DEFAULT_READ_FANOUT)
  })

  it("projects a malformed frontier from its retained last-usable signed preferences", async () => {
    const storage = new MemoryStorage()
    const declared = signedOwnerResolution()
    const malformedEvent = relayEvent(101, [["r", "not a relay"]])
    const malformed = ownerResolution({
      state: "malformed",
      preferences: declared.preferences,
      stale: true,
      current: {
        state: "malformed",
        signedEvent: malformedEvent,
        preferences: [],
        sourceRelayUrls: ["wss://discovery.example"],
        observedAt: 2_000,
        completeObservedAt: 2_000,
        invalidRelayTagCount: 1,
        duplicateRelayTagCount: 0,
      },
      lastUsable: declared.current,
      lookup: {
        observedAt: 2_000,
        coverage: "complete",
        hadEvent: true,
        eventId: malformedEvent.id,
      },
    })
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://discovery.example"],
      storage,
      resolveOwner: async () => malformed,
      resolveInbox: async () => inboxResolution(),
    })
    const settingsSnapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: await retainOwnerResolution(malformed),
      })

    expect(reconciliation.projection.relayListState).toBe("malformed")
    expect(reconciliation.projection.relayListStale).toBe(true)
    expect(settingsSnapshot.settings.entries.map((entry) => entry.url)).toEqual(
      ["wss://signed.example"]
    )
    expect(
      getGeneralReadRelayUrls({
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        fallbackRelayUrls: ["wss://bootstrap.example"],
      })
    ).toEqual(["wss://signed.example"])
    expect(
      planRelayWrites({
        intent: "author_event",
        authorPubkey: OWNER,
        authenticatedPubkey: OWNER,
        settings: settingsSnapshot.settings,
        signedRelayListAuthoritative:
          settingsSnapshot.signedRelayListAuthoritative,
        relayLists: new Map([
          [
            OWNER,
            {
              pubkey: OWNER,
              readRelayUrls: [],
              writeRelayUrls: ["wss://stale-cache.example"],
              eventCreatedAt: 1,
              cachedAt: 1,
            },
          ],
        ]),
        skipHealthFilter: true,
      }).primaryRelayUrls
    ).toEqual(["wss://signed.example"])
  })

  it("clears recovery idempotently and preserves a user-edited draft unless explicitly discarded", () => {
    const storage = new MemoryStorage()
    const draftKey = seedCommittedLegacyCompatibility(storage)
    const userDraftRaw = JSON.stringify(
      createRelaySettingsFromPreferences(
        [
          {
            url: "wss://user-draft.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ],
        "manual"
      )
    )
    storage.setItem(draftKey, userDraftRaw)

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(draftKey)).toBe(userDraftRaw)
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("already_clear")

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
        discardMigratedDraft: true,
      })
    ).toBe("cleared")
    expect(storage.getItem(draftKey)).toBeNull()
    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
        discardMigratedDraft: true,
      })
    ).toBe("already_clear")
  })

  it("keeps the recovery lane active until its clear tombstone is verified", () => {
    const storage = new FaultInjectingStorage()
    const draftKey = seedCommittedLegacyCompatibility(storage)
    storage.arm({ operation: "set", call: 1 })

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("retryable")
    expect(storage.getItem(draftKey)).toBeNull()
    expect(
      getCommittedLegacyRelayReadRecovery(OWNER, storage)?.readRelayUrls
    ).toEqual(["wss://legacy-read.example"])

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(draftKey)).toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
  })

  it("drops durable recovery once the tombstone commits even if legacy cleanup retries", () => {
    const storage = new FaultInjectingStorage()
    const draftKey = seedCommittedLegacyCompatibility(storage)
    storage.setItem(
      draftKey,
      JSON.stringify(
        createRelaySettingsFromPreferences(
          [
            {
              url: "wss://user-draft.example",
              readEnabled: true,
              writeEnabled: false,
            },
          ],
          "manual"
        )
      )
    )
    seedLegacyRelaySettings(storage)
    storage.arm({ operation: "remove", call: 2 })

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("retryable")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(storage.getItem(draftKey)).not.toBeNull()

    storage.clearFault()
    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
  })

  it("projects public and private roles in one deterministic flat list", () => {
    const projection = projectAccountNetworkPreferences({
      pubkey: OWNER,
      relayScope: ACCOUNT_SCOPE,
      ownerRelayList: signedOwnerResolution(),
      inboxDeclaration: inboxResolution({
        state: "distribution_pending",
        pendingRelayUrls: ["wss://signed.example", "wss://inbox.example"],
      }),
    })
    expect(projection.rows).toEqual([
      {
        url: "wss://signed.example",
        position: 0,
        read: "published",
        write: "published",
        privateInbox: "pending",
      },
      {
        url: "wss://inbox.example",
        position: 1,
        read: null,
        write: null,
        privateInbox: "pending",
      },
    ])
  })

  it("reconciles both frontiers on every invocation and forces a fresh kind-10050 read", async () => {
    const storage = new MemoryStorage()
    let ownerCalls = 0
    let inboxCalls = 0
    const inboxFreshness: Array<number | undefined> = []
    const ownerSignals: Array<AbortSignal | undefined> = []
    const inboxSignals: Array<AbortSignal | undefined> = []
    const inboxAccountContexts: Array<{
      requestingAccountPubkey?: string | null
      authenticatedPubkey?: string | null
    }> = []
    const ownerAccountContexts: Array<{
      requestingAccountPubkey?: string | null
      authenticatedPubkey?: string | null
      ownerSelectedRelayUrls: string[]
    }> = []
    const relayPlans: string[][] = []
    const resolveOwner: NonNullable<
      Parameters<typeof reconcileAccountNetworkPreferences>[1]
    >["resolveOwner"] = async (_pubkey, options) => {
      ownerCalls += 1
      ownerSignals.push(options.signal)
      ownerAccountContexts.push({
        requestingAccountPubkey: options.requestingAccountPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
        ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
      })
      relayPlans.push([...(options.relayUrls ?? [])])
      return signedOwnerResolution()
    }
    const resolveInbox: NonNullable<
      Parameters<typeof reconcileAccountNetworkPreferences>[1]
    >["resolveInbox"] = async (_pubkey, options) => {
      inboxCalls += 1
      inboxSignals.push(options.signal)
      inboxFreshness.push(options.freshnessMs)
      inboxAccountContexts.push({
        requestingAccountPubkey: options.requestingAccountPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
      })
      relayPlans.push([...(options.relayUrls ?? [])])
      return inboxResolution()
    }

    const signal = new AbortController().signal
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: ["wss://shared.example"],
        storage,
        resolveOwner,
        resolveInbox,
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
        signal,
      })
    }
    expect(ownerCalls).toBe(2)
    expect(inboxCalls).toBe(2)
    expect(inboxFreshness).toEqual([0, 0])
    expect(ownerSignals).toEqual([signal, signal])
    expect(inboxSignals).toEqual([signal, signal])
    expect(ownerAccountContexts).toEqual([
      {
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
        ownerSelectedRelayUrls: [],
      },
      {
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
        ownerSelectedRelayUrls: [],
      },
    ])
    expect(inboxAccountContexts).toEqual([
      {
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
      },
      {
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
      },
    ])
    expect(relayPlans).toEqual([
      ["wss://shared.example"],
      ["wss://shared.example"],
      ["wss://shared.example"],
      ["wss://shared.example"],
    ])
  })

  it("routes only durable signed membership while keeping account drafts presentation-only", async () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const draft = createRelaySettingsFromPreferences(
      [
        {
          url: "wss://draft.example",
          readEnabled: true,
          writeEnabled: true,
        },
      ],
      "manual"
    )
    saveRelaySettings(draft, ACCOUNT_SCOPE)
    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(true)
    expect(loadRelaySettingsForPlan(ACCOUNT_SCOPE).entries).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])

    const withoutEvidence =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      })
    expect(withoutEvidence.settings.entries).toEqual([])
    expect(withoutEvidence.signedRelayListAuthoritative).toBe(false)

    const signed = signedOwnerResolution()
    const signedSnapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(OWNER, {
        evidenceRepository: await retainOwnerResolution(signed),
      })
    expect(signedSnapshot.settings.entries.map((entry) => entry.url)).toEqual([
      "wss://signed.example",
    ])
    expect(signedSnapshot.signedRelayListAuthoritative).toBe(true)
    expect(
      getGeneralWriteRelayUrls({
        settings: signedSnapshot.settings,
        fallbackRelayUrls: [],
      })
    ).toEqual(["wss://signed.example"])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])

    storage.removeItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(false)
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()

    saveRelaySettings(draft, "market:guest")
    expect(loadRelaySettingsForPlan("market:guest").entries[0]?.url).toBe(
      "wss://draft.example"
    )
  })

  it("treats malformed account drafts as neither presentation nor routing state", () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const draftKey = getRelaySettingsStorageKey(ACCOUNT_SCOPE)
    storage.setItem(
      draftKey,
      JSON.stringify({
        entries: [
          {
            url: "not a relay",
            readEnabled: true,
            writeEnabled: false,
          },
        ],
      })
    )

    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(false)
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])

    storage.setItem(
      draftKey,
      JSON.stringify({ version: 1, updatedAt: 1, entries: [] })
    )
    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(true)
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
  })

  it("never exposes account A readiness during an A-to-B render transition", () => {
    const accountAState = {
      contextKey: OWNER,
      status: "ready" as const,
      localReady: true,
      reconciliation: {} as never,
      error: null,
    }
    expect(
      prepareAccountNetworkPreferencesPresentation(
        "b".repeat(64),
        accountAState
      )
    ).toEqual({
      status: "reconciling",
      localReady: false,
      reconciliation: null,
      error: null,
    })
    expect(
      prepareAccountNetworkPreferencesPresentation(null, accountAState)
    ).toEqual({
      status: "idle",
      localReady: false,
      reconciliation: null,
      error: null,
    })
  })
})
