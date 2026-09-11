import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  __resetOwnerRelayListEvidenceForTests,
  config,
  createInMemoryAccountNetworkLocalStateRepository,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  createRelaySettingsFromPreferences,
  DEFAULT_READ_FANOUT,
  getAccountRelayScope,
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  getPublishableRelaySettingsEntries,
  loadRelaySettings,
  hydrateAccountNetworkPreferences,
  getRelaySettingsStorageKey,
  getSignedInRelayScope,
  loadRelaySettingsForPlan,
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

  it("emits account settings notifications without persisting unsigned membership", () => {
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
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
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
      declaration: inboxResolution({
        cutoverRecoveryRelayUrls: ["wss://signed.example"],
      }),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(inboxPlan.relayUrls).toEqual(["wss://signed.example"])
    expect(inboxPlan.relaySources).toEqual({
      "wss://signed.example": "cutover_recovery",
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
      declaration: inboxResolution({
        cutoverRecoveryRelayUrls: ["wss://signed-read.example"],
      }),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(afterRecovery.relayUrls).toEqual(["wss://signed-read.example"])
    expect(afterRecovery.relaySources).toEqual({
      "wss://signed-read.example": "cutover_recovery",
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
    await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
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
    let ownerCalls = 0
    let inboxCalls = 0
    const inboxFreshness: Array<number | undefined> = []
    const ownerSignals: Array<AbortSignal | undefined> = []
    const inboxSignals: Array<AbortSignal | undefined> = []
    const ownerAuthorityPredicates: Array<(() => boolean) | undefined> = []
    const inboxAuthorityPredicates: Array<(() => boolean) | undefined> = []
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
      ownerAuthorityPredicates.push(options.shouldContinue)
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
      inboxAuthorityPredicates.push(options.shouldContinue)
      inboxFreshness.push(options.freshnessMs)
      inboxAccountContexts.push({
        requestingAccountPubkey: options.requestingAccountPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
      })
      relayPlans.push([...(options.relayUrls ?? [])])
      return inboxResolution()
    }

    const signal = new AbortController().signal
    const shouldContinue = () => true
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: ["wss://shared.example"],
        resolveOwner,
        resolveInbox,
        requestingAccountPubkey: OWNER,
        authenticatedPubkey: OTHER,
        signal,
        shouldContinue,
      })
    }
    expect(ownerCalls).toBe(2)
    expect(inboxCalls).toBe(2)
    expect(inboxFreshness).toEqual([0, 0])
    expect(ownerSignals).toEqual([signal, signal])
    expect(inboxSignals).toEqual([signal, signal])
    expect(ownerAuthorityPredicates).toEqual([shouldContinue, shouldContinue])
    expect(inboxAuthorityPredicates).toEqual([shouldContinue, shouldContinue])
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

  it("routes only durable signed membership while ignoring stale unsigned account bytes", async () => {
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
    storage.setItem(
      getRelaySettingsStorageKey(ACCOUNT_SCOPE),
      JSON.stringify(draft)
    )
    expect(loadRelaySettings(ACCOUNT_SCOPE).entries).toEqual([])
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
    expect(loadRelaySettings(ACCOUNT_SCOPE).entries).toEqual([])
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

    expect(loadRelaySettings(ACCOUNT_SCOPE).entries).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])

    storage.setItem(
      draftKey,
      JSON.stringify({ version: 1, updatedAt: 1, entries: [] })
    )
    expect(loadRelaySettings(ACCOUNT_SCOPE).entries).toEqual([])
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
