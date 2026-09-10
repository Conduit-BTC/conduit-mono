import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
  __resetInboxDeclarationCache,
  applyAccountNetworkRelayExclusion,
  applyInboxDeclarationDistributionOutcomes,
  applyInboxDeclarationDistributionStage,
  completeLegacyRelaySettingsDraftMigration,
  createInMemoryAccountNetworkLocalStateRepository,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  createRelaySettingsFromPreferences,
  emptyAccountNetworkLocalState,
  getAccountRelayScope,
  getCommittedLegacyRelayReadRecovery,
  getRelaySettingsStorageKey,
  hydrateAccountNetworkPreferences,
  migrateLegacyRelaySettingsDraft,
  normalizeInboxDeclarationEvidencePubkey,
  normalizeOwnerRelayListPubkey,
  planInboxReadRelays,
  reconcileAccountNetworkPreferences,
  removeLegacyRelayReadRecoveryRelayUrls,
  sharedInboxDiscoveryRelayUrls,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationResolution,
  type LegacyRelaySettingsReviewCandidate,
  type OwnerRelayListEvidenceRecord,
  type OwnerRelayListResolution,
  type RelaySettingsState,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const ACCOUNT_SCOPE = getAccountRelayScope(OWNER)
const RELAY_A = "wss://relay-a.example.com"
const RELAY_B = "wss://relay-b.example.com"
const DISCOVERY_RELAY = "wss://discovery.example.com"
const SHARED_INBOX_RELAY_URLS = sharedInboxDiscoveryRelayUrls()

beforeEach(() => {
  __resetInboxDeclarationCache()
})

class MemoryStorage {
  private readonly values = new Map<string, string>()

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

class OneRemoveFailureStorage extends MemoryStorage {
  private shouldFail = true

  override removeItem(key: string): void {
    if (this.shouldFail) {
      this.shouldFail = false
      return
    }
    super.removeItem(key)
  }
}

class OneMigrationMarkerWriteFailureStorage extends MemoryStorage {
  private armed = false

  arm(): void {
    this.armed = true
  }

  override setItem(key: string, value: string): void {
    if (this.armed && key === `conduit:network-legacy-migration:v1:${OWNER}`) {
      this.armed = false
      return
    }
    super.setItem(key, value)
  }
}

function signedEvent(
  kind: 10002 | 10050,
  createdAt: number,
  tags: string[][]
): SignedPublicNostrEvent {
  const event = finalizeEvent(
    { kind, created_at: createdAt, tags, content: "" },
    OWNER_SECRET
  )
  return { ...event, tags: event.tags.map((tag) => [...tag]) }
}

function completeAbsence(): OwnerRelayListResolution {
  return {
    pubkey: normalizeOwnerRelayListPubkey(OWNER)!,
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
      attemptedRelayUrls: [DISCOVERY_RELAY],
      successfulRelayUrls: [DISCOVERY_RELAY],
      failedRelayUrls: [],
      cappedRelayUrls: [],
      eventSourceRelayUrls: [],
    },
  }
}

function unavailableOwner(): OwnerRelayListResolution {
  return {
    ...completeAbsence(),
    state: "lookup_unavailable",
    lookup: {
      observedAt: 1_000,
      coverage: "unavailable",
      hadEvent: false,
    },
    observation: {
      coverage: "unavailable",
      attemptedRelayUrls: [DISCOVERY_RELAY],
      successfulRelayUrls: [],
      failedRelayUrls: [DISCOVERY_RELAY],
      cappedRelayUrls: [],
      eventSourceRelayUrls: [],
    },
  }
}

function resolvedOwnerRelayList(
  event: SignedPublicNostrEvent,
  input: {
    stale?: boolean
    observed?: boolean
    coverage?: "complete" | "partial" | "unavailable"
  } = {}
): OwnerRelayListResolution {
  const preferences = event.tags.flatMap((tag) => {
    if (tag[0] !== "r" || !tag[1]) return []
    return [
      {
        url: tag[1],
        readEnabled: tag[2] !== "write",
        writeEnabled: tag[2] !== "read",
      },
    ]
  })
  const coverage = input.coverage ?? "complete"
  const observed = input.observed ?? true
  return {
    pubkey: normalizeOwnerRelayListPubkey(OWNER)!,
    state: preferences.length === 0 ? "signed_empty" : "declared",
    preferences,
    stale: input.stale ?? false,
    current: {
      state: preferences.length === 0 ? "signed_empty" : "declared",
      signedEvent: event,
      preferences,
      sourceRelayUrls: observed ? [DISCOVERY_RELAY] : [],
      observedAt: 1_000,
      ...(coverage === "complete" && observed
        ? { completeObservedAt: 1_000 }
        : {}),
      invalidRelayTagCount: 0,
      duplicateRelayTagCount: 0,
    },
    lookup: {
      observedAt: 1_000,
      coverage,
      hadEvent: observed,
      ...(observed ? { eventId: event.id } : {}),
    },
    observation: {
      coverage,
      attemptedRelayUrls: [DISCOVERY_RELAY],
      successfulRelayUrls: observed ? [DISCOVERY_RELAY] : [],
      failedRelayUrls: observed ? [] : [DISCOVERY_RELAY],
      cappedRelayUrls: [],
      ...(observed ? { eventId: event.id } : {}),
      eventSourceRelayUrls: observed ? [DISCOVERY_RELAY] : [],
    },
  }
}

function noInbox(): InboxDeclarationResolution {
  return {
    pubkey: OWNER,
    state: "not_observed",
    relayUrls: [],
    stale: false,
    fetchedAt: 1_000,
  }
}

function legacySettings(): RelaySettingsState {
  const settings = createRelaySettingsFromPreferences(
    [
      { url: RELAY_A, readEnabled: true, writeEnabled: false },
      { url: RELAY_B, readEnabled: false, writeEnabled: true },
    ],
    "manual"
  )
  const first = settings.entries[0]!
  settings.entries[0] = {
    ...first,
    relayName: "Relay A",
    scannedAt: 900,
    capabilities: { ...first.capabilities, search: true },
    observations: {
      ...first.observations!,
      search: { status: "passed", observedAt: 900 },
    },
  }
  settings.updatedAt = 900
  return settings
}

function seedLegacy(storage: MemoryStorage): string {
  const key = getRelaySettingsStorageKey(`market:${OWNER}`)
  storage.setItem(key, JSON.stringify(legacySettings()))
  return key
}

function fingerprint(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let hash = 14_695_981_039_346_656_037n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return `fnv1a64:${bytes.length}:${hash.toString(16).padStart(16, "0")}`
}

function seedCommittedCompatibility(
  storage: MemoryStorage,
  readRelayUrls: readonly string[] = [RELAY_A]
): void {
  const draftRaw = JSON.stringify(legacySettings())
  const recoveryRaw = JSON.stringify({
    version: 1,
    readRelayUrls: [...readRelayUrls].sort(),
  })
  storage.setItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE), draftRaw)
  storage.setItem(
    `conduit:network-legacy-read-recovery:v1:${OWNER}`,
    recoveryRaw
  )
  storage.setItem(
    `conduit:network-legacy-migration:v1:${OWNER}`,
    JSON.stringify({
      version: 1,
      phase: "complete",
      draftFingerprint: fingerprint(draftRaw),
      recoveryFingerprint: fingerprint(recoveryRaw),
    })
  )
}

async function prepareCandidate(input?: {
  storage?: MemoryStorage
  localStateRepository?: ReturnType<
    typeof createInMemoryAccountNetworkLocalStateRepository
  >
}): Promise<{
  storage: MemoryStorage
  localStateRepository: ReturnType<
    typeof createInMemoryAccountNetworkLocalStateRepository
  >
  legacyKey: string
  candidate: LegacyRelaySettingsReviewCandidate
}> {
  const storage = input?.storage ?? new MemoryStorage()
  const localStateRepository =
    input?.localStateRepository ??
    createInMemoryAccountNetworkLocalStateRepository()
  const legacyKey = seedLegacy(storage)
  const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
    relayUrls: [DISCOVERY_RELAY],
    storage,
    localStateRepository,
    ownerRelayList: {
      evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
    },
    inboxDeclaration: {
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
    },
    resolveOwner: async () => completeAbsence(),
    resolveInbox: async () => noInbox(),
  })
  expect(reconciliation.legacyMigration).toBe("review_required")
  expect(reconciliation.legacyReviewCandidate).not.toBeNull()
  return {
    storage,
    localStateRepository,
    legacyKey,
    candidate: reconciliation.legacyReviewCandidate!,
  }
}

describe("legacy account Network migration", () => {
  it("surfaces complete-absence roles only as an ephemeral review candidate", async () => {
    const { storage, localStateRepository, legacyKey, candidate } =
      await prepareCandidate()

    expect(candidate.draft.entries.map((entry) => entry.url)).toEqual([
      RELAY_A,
      RELAY_B,
    ])
    expect(storage.getItem(legacyKey)).not.toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(await localStateRepository.get(OWNER)).toBeUndefined()
    expect(
      storage
        .entries()
        .some(([key]) => key.includes("network-legacy-read-recovery"))
    ).toBe(false)
  })

  for (const disposition of ["publish_staged", "discarded"] as const) {
    it(`commits local ordering and scan evidence after ${disposition}`, async () => {
      const { storage, localStateRepository, legacyKey, candidate } =
        await prepareCandidate()

      expect(
        await completeLegacyRelaySettingsDraftMigration({
          candidate,
          disposition,
          storage,
          localStateRepository,
          now: () => 2_000,
        })
      ).toBe("completed")

      const localState = await localStateRepository.get(OWNER)
      expect(localState?.migrationVersion).toBe(
        ACCOUNT_NETWORK_LOCAL_STATE_MIGRATION_VERSION
      )
      expect(localState?.preferredRelayOrder).toEqual([RELAY_A, RELAY_B])
      expect(localState?.relayScans).toHaveLength(1)
      expect(localState?.relayScans[0]).toMatchObject({
        url: RELAY_A,
        relayName: "Relay A",
        scannedAt: 900,
        reachable: true,
      })
      expect(JSON.stringify(localState)).not.toContain("readEnabled")
      expect(JSON.stringify(localState)).not.toContain("writeEnabled")
      expect(storage.getItem(legacyKey)).toBeNull()
      expect(
        await completeLegacyRelaySettingsDraftMigration({
          candidate,
          disposition,
          storage,
          localStateRepository,
        })
      ).toBe("already_complete")
    })
  }

  it("keeps a changed legacy source and rejects the stale review candidate", async () => {
    const { storage, localStateRepository, legacyKey, candidate } =
      await prepareCandidate()
    storage.setItem(
      legacyKey,
      JSON.stringify(
        createRelaySettingsFromPreferences(
          [{ url: RELAY_B, readEnabled: true, writeEnabled: true }],
          "manual"
        )
      )
    )

    expect(
      await completeLegacyRelaySettingsDraftMigration({
        candidate,
        disposition: "discarded",
        storage,
        localStateRepository,
      })
    ).toBe("source_changed")
    expect(storage.getItem(legacyKey)).not.toBeNull()
    expect(await localStateRepository.get(OWNER)).toBeUndefined()
  })

  it("keeps source bytes changed while the local migration marker commits", async () => {
    const { storage, localStateRepository, legacyKey, candidate } =
      await prepareCandidate()
    const changedRaw = JSON.stringify(
      createRelaySettingsFromPreferences(
        [{ url: RELAY_B, readEnabled: true, writeEnabled: true }],
        "manual"
      )
    )
    const changingRepository = {
      get: localStateRepository.get,
      replace: localStateRepository.replace,
      async update(
        pubkey: string,
        updater: Parameters<typeof localStateRepository.update>[1]
      ) {
        const updated = await localStateRepository.update(pubkey, updater)
        storage.setItem(legacyKey, changedRaw)
        return updated
      },
    }

    expect(
      await completeLegacyRelaySettingsDraftMigration({
        candidate,
        disposition: "publish_staged",
        storage,
        localStateRepository: changingRepository,
      })
    ).toBe("source_changed")
    expect(storage.getItem(legacyKey)).toBe(changedRaw)
    expect((await localStateRepository.get(OWNER))?.migrationVersion).toBe(1)

    expect(
      await completeLegacyRelaySettingsDraftMigration({
        candidate,
        disposition: "publish_staged",
        storage,
        localStateRepository,
      })
    ).toBe("source_changed")
    expect(storage.getItem(legacyKey)).toBe(changedRaw)

    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [DISCOVERY_RELAY],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => completeAbsence(),
      resolveInbox: async () => noInbox(),
    })
    expect(reconciliation.legacyMigration).toBe("retryable")
    expect(storage.getItem(legacyKey)).toBe(changedRaw)
  })

  it("defers every undecidable frontier without touching legacy or local state", async () => {
    const scenarios: OwnerRelayListResolution[] = [
      unavailableOwner(),
      {
        ...unavailableOwner(),
        state: "lookup_partial",
        lookup: {
          observedAt: 1_000,
          coverage: "partial",
          hadEvent: false,
        },
        observation: {
          ...unavailableOwner().observation,
          coverage: "partial",
        },
      },
      {
        ...completeAbsence(),
        state: "malformed",
        stale: true,
        lookup: {
          observedAt: 1_000,
          coverage: "complete",
          hadEvent: true,
        },
      },
    ]

    for (const ownerRelayList of scenarios) {
      const storage = new MemoryStorage()
      const legacyKey = seedLegacy(storage)
      const localStateRepository =
        createInMemoryAccountNetworkLocalStateRepository()
      expect(
        await migrateLegacyRelaySettingsDraft({
          pubkey: OWNER,
          accountScope: ACCOUNT_SCOPE,
          ownerRelayList,
          storage,
          localStateRepository,
        })
      ).toBe("deferred")
      expect(storage.getItem(legacyKey)).not.toBeNull()
      expect(await localStateRepository.get(OWNER)).toBeUndefined()
    }
  })

  it("lets fresh durable signed kind-10002 retire roles but preserves only local preference evidence", async () => {
    const storage = new MemoryStorage()
    const legacyKey = seedLegacy(storage)
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const event = signedEvent(10002, 100, [
      ["r", RELAY_B],
      ["r", "wss://signed-only.example.com", "write"],
    ])
    const resolution = resolvedOwnerRelayList(event)

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: resolution,
        durableOwnerRelayList: resolution,
        storage,
        localStateRepository,
        now: () => 2_000,
      })
    ).toBe("retired_signed_wins")
    expect(storage.getItem(legacyKey)).toBeNull()
    const localState = await localStateRepository.get(OWNER)
    expect(localState?.preferredRelayOrder).toEqual([RELAY_A, RELAY_B])
    expect(localState?.relayScans).toHaveLength(1)
    expect(JSON.stringify(localState)).not.toContain("readEnabled")
    expect(JSON.stringify(localState)).not.toContain("writeEnabled")
  })

  it("accepts an exact pending signed kind-10002 but not unrelated stale evidence", async () => {
    const event = signedEvent(10002, 100, [["r", RELAY_B]])
    const stale = resolvedOwnerRelayList(event, {
      stale: true,
      observed: false,
      coverage: "unavailable",
    })

    for (const pendingEventId of [null, event.id] as const) {
      const storage = new MemoryStorage()
      const legacyKey = seedLegacy(storage)
      const localStateRepository =
        createInMemoryAccountNetworkLocalStateRepository()
      const status = await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: stale,
        durableOwnerRelayList: stale,
        pendingOwnerRelayListEventId: pendingEventId,
        storage,
        localStateRepository,
      })
      expect(status).toBe(
        pendingEventId === event.id ? "retired_signed_wins" : "deferred"
      )
      expect(storage.getItem(legacyKey) === null).toBe(
        pendingEventId === event.id
      )
    }
  })

  it("recovers cleanup after the local migration marker commits first", async () => {
    const storage = new OneRemoveFailureStorage()
    const legacyKey = seedLegacy(storage)
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()
    const event = signedEvent(10002, 100, [["r", RELAY_B]])
    const signed = resolvedOwnerRelayList(event)

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: signed,
        durableOwnerRelayList: signed,
        storage,
        localStateRepository,
        now: () => 2_000,
      })
    ).toBe("retryable")
    expect(storage.getItem(legacyKey)).not.toBeNull()
    expect((await localStateRepository.get(OWNER))?.migrationVersion).toBe(1)

    expect(
      await migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: unavailableOwner(),
        storage,
        localStateRepository,
      })
    ).toBe("already_complete")
    expect(storage.getItem(legacyKey)).toBeNull()
  })

  it("clears causal exclusions only for newly observed stronger own events", async () => {
    const oldOwner = signedEvent(10002, 100, [["r", RELAY_A]])
    const newOwner = signedEvent(10002, 101, [["r", RELAY_A]])
    const oldInbox = signedEvent(10050, 100, [["relay", RELAY_B]])
    const newInbox = signedEvent(10050, 101, [["relay", RELAY_B]])
    let localState = emptyAccountNetworkLocalState(OWNER, () => 100)
    localState = applyAccountNetworkRelayExclusion(localState, {
      relayUrl: RELAY_A,
      relayListFrontier: {
        eventId: oldOwner.id,
        createdAt: oldOwner.created_at,
      },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
      committedAt: 100,
    })
    localState = applyAccountNetworkRelayExclusion(localState, {
      relayUrl: RELAY_B,
      relayListFrontier: { eventId: null, createdAt: null },
      inboxDeclarationFrontier: {
        eventId: oldInbox.id,
        createdAt: oldInbox.created_at,
      },
      committedAt: 100,
    })
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository([localState])
    const ownerResolution = resolvedOwnerRelayList(newOwner, {
      coverage: "partial",
    })
    const ownerEvidence: OwnerRelayListEvidenceRecord = {
      pubkey: normalizeOwnerRelayListPubkey(OWNER)!,
      current: ownerResolution.current!,
      lastUsable: ownerResolution.current!,
      latestLookup: ownerResolution.lookup,
      cachedAt: 1_000,
    }
    const inboxEvidence: InboxDeclarationEvidenceRecord = {
      pubkey: normalizeInboxDeclarationEvidencePubkey(OWNER)!,
      current: {
        state: "declared",
        signedEvent: newInbox,
        secureRelayUrls: [RELAY_B],
        sourceRelayUrls: [DISCOVERY_RELAY],
        sharedSourceRelayUrls: [DISCOVERY_RELAY],
        observedAt: 1_000,
      },
      latestLookup: {
        observedAt: 1_000,
        coverage: "partial",
        hadEvent: true,
        eventId: newInbox.id,
      },
      cachedAt: 1_000,
    }
    const inboxResolution: InboxDeclarationResolution = {
      pubkey: OWNER,
      state: "declared",
      relayUrls: [RELAY_B],
      stale: false,
      fetchedAt: 1_000,
      eventId: newInbox.id,
      eventCreatedAt: newInbox.created_at,
      sourceRelayUrls: [DISCOVERY_RELAY],
      observation: {
        coverage: "partial",
        attemptedRelayUrls: [DISCOVERY_RELAY],
        successfulRelayUrls: [DISCOVERY_RELAY],
        failedRelayUrls: [],
        eventId: newInbox.id,
        eventSourceRelayUrls: [DISCOVERY_RELAY],
      },
    }

    await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [DISCOVERY_RELAY],
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository([
          ownerEvidence,
        ]),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          inboxEvidence,
        ]),
      },
      resolveOwner: async () => ownerResolution,
      resolveInbox: async () => inboxResolution,
    })

    expect((await localStateRepository.get(OWNER))?.exclusions).toEqual([])
  })

  it("keeps legacy inbox recovery through restart and partial replacement coverage", async () => {
    const storage = new MemoryStorage()
    seedCommittedCompatibility(storage)
    const replacement = signedEvent(10050, 200, [["relay", RELAY_B]])
    const inboxRepository = createInMemoryInboxDeclarationEvidenceRepository()
    await inboxRepository.merge({
      pubkey: OWNER,
      signedEvent: replacement,
      sourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
      sharedSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
      observedAt: 1_000,
      completeObservedAt: 1_000,
      lookup: {
        observedAt: 1_000,
        coverage: "complete",
        hadEvent: true,
        eventId: replacement.id,
      },
    })

    __resetInboxDeclarationCache()
    const hydrated = await hydrateAccountNetworkPreferences(OWNER, {
      storage,
      localStateRepository: createInMemoryAccountNetworkLocalStateRepository(),
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
        now: () => 2_000,
      },
      inboxDeclaration: {
        evidenceRepository: inboxRepository,
        now: () => 2_000,
      },
    })

    expect(hydrated.inboxDeclaration.state).toBe("declared")
    expect(hydrated.legacyInboxRecoveryRelayUrls).toEqual([RELAY_A])
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_A],
    })
    expect(
      planInboxReadRelays({
        declaration: hydrated.inboxDeclaration,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
        migrationRecoveryRelayUrls: hydrated.legacyInboxRecoveryRelayUrls,
      }).relaySources[RELAY_A]
    ).toBe("migration_recovery")

    const partial = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: SHARED_INBOX_RELAY_URLS,
      storage,
      localStateRepository: createInMemoryAccountNetworkLocalStateRepository(),
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: inboxRepository,
        sharedConfirmationRelayUrls: SHARED_INBOX_RELAY_URLS,
      },
      resolveOwner: async () => unavailableOwner(),
      resolveInbox: async () => ({
        pubkey: OWNER,
        state: "declared",
        relayUrls: [RELAY_B],
        stale: true,
        fetchedAt: 2_500,
        eventId: replacement.id,
        eventCreatedAt: replacement.created_at,
        sourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        observation: {
          coverage: "partial",
          attemptedRelayUrls: SHARED_INBOX_RELAY_URLS,
          successfulRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          failedRelayUrls: SHARED_INBOX_RELAY_URLS.slice(1),
          eventId: replacement.id,
          eventSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        },
      }),
    })

    expect(partial.legacyInboxRecoveryRelayUrls).toEqual([RELAY_A])
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_A],
    })

    const completeWithoutCutoverMarker =
      await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: SHARED_INBOX_RELAY_URLS,
        storage,
        localStateRepository:
          createInMemoryAccountNetworkLocalStateRepository(),
        ownerRelayList: {
          evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
        },
        inboxDeclaration: {
          evidenceRepository: inboxRepository,
          sharedConfirmationRelayUrls: SHARED_INBOX_RELAY_URLS,
        },
        resolveOwner: async () => unavailableOwner(),
        resolveInbox: async () => ({
          pubkey: OWNER,
          state: "declared",
          relayUrls: [RELAY_B],
          stale: false,
          fetchedAt: 3_000,
          eventId: replacement.id,
          eventCreatedAt: replacement.created_at,
          sourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          sharedSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          observation: {
            coverage: "complete",
            attemptedRelayUrls: SHARED_INBOX_RELAY_URLS,
            successfulRelayUrls: SHARED_INBOX_RELAY_URLS,
            failedRelayUrls: [],
            eventId: replacement.id,
            eventSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          },
        }),
      })

    expect(completeWithoutCutoverMarker.legacyInboxRecoveryRelayUrls).toEqual([
      RELAY_A,
    ])
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_A],
    })
  })

  it("retires legacy recovery only after exact shared readback is durable", async () => {
    const storage = new MemoryStorage()
    seedCommittedCompatibility(storage)
    const replacement = signedEvent(10050, 200, [["relay", RELAY_B]])
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent: replacement,
      publishRelayUrls: SHARED_INBOX_RELAY_URLS,
      relayOutcomes: SHARED_INBOX_RELAY_URLS.map((relayUrl) => ({
        relayUrl,
        publishStatus: "pending" as const,
        publishAttemptCount: 0,
        readbackStatus: "pending" as const,
        readbackAttemptCount: 0,
      })),
      previousRelayUrls: [RELAY_A],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const confirmed = applyInboxDeclarationDistributionOutcomes(staged, {
      readback: SHARED_INBOX_RELAY_URLS.map((relayUrl, index) => ({
        relayUrl,
        status: index === 0 ? ("observed" as const) : ("absent" as const),
      })),
      observedAt: 2_000,
    })
    expect(confirmed.cutoverRecoveries?.[0]?.readbackObservedAt).toBe(2_000)
    const inboxRepository = createInMemoryInboxDeclarationEvidenceRepository([
      confirmed,
    ])

    const partialWithDurableMarker = await reconcileAccountNetworkPreferences(
      OWNER,
      {
        relayUrls: SHARED_INBOX_RELAY_URLS,
        storage,
        localStateRepository:
          createInMemoryAccountNetworkLocalStateRepository(),
        ownerRelayList: {
          evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
        },
        inboxDeclaration: {
          evidenceRepository: inboxRepository,
          sharedConfirmationRelayUrls: SHARED_INBOX_RELAY_URLS,
          now: () => 2_250,
        },
        resolveOwner: async () => unavailableOwner(),
        resolveInbox: async () => ({
          pubkey: OWNER,
          state: "declared",
          relayUrls: [RELAY_B],
          cutoverRecoveryRelayUrls: [RELAY_A],
          cutoverRecoveryReadbackObservedAt: 2_000,
          cutoverRecoveryExpiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
          stale: true,
          fetchedAt: 2_250,
          eventId: replacement.id,
          eventCreatedAt: replacement.created_at,
          sourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          sharedSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          observation: {
            coverage: "partial",
            attemptedRelayUrls: SHARED_INBOX_RELAY_URLS,
            successfulRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
            failedRelayUrls: SHARED_INBOX_RELAY_URLS.slice(1),
            eventId: replacement.id,
            eventSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
          },
        }),
      }
    )

    expect(partialWithDurableMarker.legacyInboxRecoveryRelayUrls).toEqual([
      RELAY_A,
    ])
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).not.toBeNull()

    const reconciled = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: SHARED_INBOX_RELAY_URLS,
      storage,
      localStateRepository: createInMemoryAccountNetworkLocalStateRepository(),
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: inboxRepository,
        sharedConfirmationRelayUrls: SHARED_INBOX_RELAY_URLS,
        now: () => 2_500,
      },
      resolveOwner: async () => unavailableOwner(),
      resolveInbox: async () => ({
        pubkey: OWNER,
        state: "declared",
        relayUrls: [RELAY_B],
        cutoverRecoveryRelayUrls: [RELAY_A],
        cutoverRecoveryReadbackObservedAt: 2_000,
        cutoverRecoveryExpiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
        stale: false,
        fetchedAt: 2_500,
        eventId: replacement.id,
        eventCreatedAt: replacement.created_at,
        sourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        sharedSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        observation: {
          coverage: "complete",
          attemptedRelayUrls: SHARED_INBOX_RELAY_URLS,
          successfulRelayUrls: SHARED_INBOX_RELAY_URLS,
          failedRelayUrls: [],
          eventId: replacement.id,
          eventSourceRelayUrls: [SHARED_INBOX_RELAY_URLS[0]!],
        },
      }),
    })

    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(reconciled.legacyInboxRecoveryRelayUrls).toEqual([])
    expect(
      planInboxReadRelays({
        declaration: reconciled.inboxDeclaration,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      })
    ).toMatchObject({
      relayUrls: [RELAY_B, RELAY_A],
      relaySources: {
        [RELAY_B]: "declared",
        [RELAY_A]: "cutover_recovery",
      },
    })
  })

  it("persistently prunes whole-removed relays from legacy recovery", () => {
    const storage = new MemoryStorage()
    seedCommittedCompatibility(storage, [RELAY_A, RELAY_B])

    expect(
      removeLegacyRelayReadRecoveryRelayUrls({
        pubkey: OWNER,
        relayUrls: [RELAY_A],
        storage,
      })
    ).toBe("updated")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_B],
    })
    const recoveryRaw = storage.getItem(
      `conduit:network-legacy-read-recovery:v1:${OWNER}`
    )!
    expect(
      JSON.parse(
        storage.getItem(`conduit:network-legacy-migration:v1:${OWNER}`)!
      ).recoveryFingerprint
    ).toBe(fingerprint(recoveryRaw))

    expect(
      removeLegacyRelayReadRecoveryRelayUrls({
        pubkey: OWNER,
        relayUrls: [RELAY_B],
        storage,
      })
    ).toBe("cleared")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).not.toBeNull()
  })

  it("keeps exclusions and filters final reads when durable legacy pruning retries", async () => {
    const storage = new OneMigrationMarkerWriteFailureStorage()
    seedCommittedCompatibility(storage, [RELAY_A, RELAY_B])
    const previousOwner = signedEvent(10002, 100, [["r", RELAY_B]])
    const replacementOwner = signedEvent(10002, 101, [["r", RELAY_A]])
    let localState = emptyAccountNetworkLocalState(OWNER, () => 100)
    localState = applyAccountNetworkRelayExclusion(localState, {
      relayUrl: RELAY_A,
      relayListFrontier: {
        eventId: previousOwner.id,
        createdAt: previousOwner.created_at,
      },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
      committedAt: 100,
    })
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository([localState])
    const ownerResolution = resolvedOwnerRelayList(replacementOwner)
    const ownerEvidence: OwnerRelayListEvidenceRecord = {
      pubkey: normalizeOwnerRelayListPubkey(OWNER)!,
      current: ownerResolution.current!,
      lastUsable: ownerResolution.current!,
      latestLookup: ownerResolution.lookup,
      cachedAt: 1_000,
    }
    const ownerRepository = createInMemoryOwnerRelayListEvidenceRepository([
      ownerEvidence,
    ])
    storage.arm()

    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [DISCOVERY_RELAY],
      storage,
      localStateRepository,
      ownerRelayList: { evidenceRepository: ownerRepository },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => ownerResolution,
      resolveInbox: async () => noInbox(),
    })

    expect(reconciliation.legacyMigration).toBe("retryable")
    expect(
      (await localStateRepository.get(OWNER))?.exclusions.map(
        (exclusion) => exclusion.relayUrl
      )
    ).toEqual([RELAY_A])
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_A, RELAY_B],
    })
    expect(reconciliation.legacyInboxRecoveryRelayUrls).toEqual([RELAY_B])
    expect(
      planInboxReadRelays({
        declaration: reconciliation.inboxDeclaration,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
        migrationRecoveryRelayUrls: reconciliation.legacyInboxRecoveryRelayUrls,
      })
    ).toMatchObject({
      relayUrls: [RELAY_B],
      relaySources: { [RELAY_B]: "migration_recovery" },
    })
  })

  it("reads only an already-committed NIP-17 compatibility marker during cleanup", async () => {
    const storage = new MemoryStorage()
    seedCommittedCompatibility(storage)
    const localStateRepository =
      createInMemoryAccountNetworkLocalStateRepository()

    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: [DISCOVERY_RELAY],
      storage,
      localStateRepository,
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
      inboxDeclaration: {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      },
      resolveOwner: async () => unavailableOwner(),
      resolveInbox: async () => noInbox(),
    })

    expect(reconciliation.legacyMigration).toBe("deferred")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: [RELAY_A],
    })
    expect(reconciliation.legacyInboxRecoveryRelayUrls).toEqual([RELAY_A])
  })
})
