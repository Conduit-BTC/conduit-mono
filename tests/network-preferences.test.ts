import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetAccountRelaySettingsProjectionsForTests,
  __resetInboxDeclarationCache,
  canRelaySettingsChangeControlRuntime,
  clearLegacyRelayReadRecovery,
  createRelaySettingsFromPreferences,
  DEFAULT_READ_FANOUT,
  getAccountRelayScope,
  getAccountRelaySettingsProjection,
  getCommittedLegacyRelayReadRecovery,
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  getInboxMigrationRecoveryRelayUrls,
  getPublishableRelaySettingsEntries,
  hasRelaySettingsDraft,
  getRelaySettingsStorageKey,
  getSignedInRelayScope,
  loadRelaySettingsForPlan,
  loadRelaySettingsPresentation,
  MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS,
  migrateLegacyRelaySettingsDraft,
  normalizeOwnerRelayListPubkey,
  planInboxReadRelays,
  planRelaysWithSnapshot,
  prepareAccountNetworkPreferencesPresentation,
  projectAccountNetworkPreferences,
  reconcileAccountNetworkPreferences,
  resolveConduitSession,
  saveRelaySettings,
  serializeNip65RelayTags,
  setActiveRelaySettingsScope,
  setAccountRelaySettingsProjection,
  setInboxMigrationRecoveryRelayUrls,
  subscribeRelaySettingsChanges,
  type InboxDeclarationResolution,
  type OwnerRelayListResolution,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = new Uint8Array(
  createHash("sha256")
    .update("conduit-network-preferences-owner-fixture", "utf8")
    .digest()
)
const OWNER = getPublicKey(OWNER_SECRET)
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
  __resetAccountRelaySettingsProjectionsForTests()
  __resetInboxDeclarationCache()
  setActiveRelaySettingsScope(null)
})

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  })
  __resetAccountRelaySettingsProjectionsForTests()
  __resetInboxDeclarationCache()
  setActiveRelaySettingsScope(null)
})

describe("account Network preferences", () => {
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

  it("keeps account drafts presentation-only for live relay connections", () => {
    expect(
      canRelaySettingsChangeControlRuntime(ACCOUNT_SCOPE, "local_draft")
    ).toBe(false)
    expect(
      canRelaySettingsChangeControlRuntime(ACCOUNT_SCOPE, "signed_projection")
    ).toBe(true)
    expect(
      canRelaySettingsChangeControlRuntime("market:guest", "local_draft")
    ).toBe(true)
    expect(canRelaySettingsChangeControlRuntime(null, "local_draft")).toBe(true)
  })

  it("distinguishes account draft notifications from signed runtime projections", () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const changes: Array<[string | null, string]> = []
    const unsubscribe = subscribeRelaySettingsChanges((scope, source) => {
      changes.push([scope, source])
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
      setAccountRelaySettingsProjection(ACCOUNT_SCOPE, settings)
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      [ACCOUNT_SCOPE, "local_draft"],
      [ACCOUNT_SCOPE, "signed_projection"],
    ])
  })

  it("keeps exact signed membership re-observation silent while notifying on a role change", () => {
    const changes: Array<[string | null, string]> = []
    const unsubscribe = subscribeRelaySettingsChanges((scope, source) => {
      changes.push([scope, source])
    })
    const initial = {
      ...createRelaySettingsFromPreferences(
        [
          {
            url: "wss://signed.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ],
        "published"
      ),
      updatedAt: 100,
    }

    try {
      setAccountRelaySettingsProjection(ACCOUNT_SCOPE, initial)
      setAccountRelaySettingsProjection(ACCOUNT_SCOPE, {
        ...initial,
        updatedAt: 200,
      })
      expect(getAccountRelaySettingsProjection(ACCOUNT_SCOPE)?.updatedAt).toBe(
        200
      )
      setAccountRelaySettingsProjection(
        ACCOUNT_SCOPE,
        createRelaySettingsFromPreferences(
          [
            {
              url: "wss://signed.example",
              readEnabled: false,
              writeEnabled: true,
            },
          ],
          "published"
        )
      )
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      [ACCOUNT_SCOPE, "signed_projection"],
      [ACCOUNT_SCOPE, "signed_projection"],
    ])
  })

  it("notifies when an empty account projection gains signed authority", () => {
    const changes: string[] = []
    const unsubscribe = subscribeRelaySettingsChanges((_scope, source) => {
      changes.push(source)
    })
    const empty = createRelaySettingsFromPreferences([], "published")

    try {
      setAccountRelaySettingsProjection(ACCOUNT_SCOPE, empty, {
        signedRelayListAuthoritative: false,
      })
      setAccountRelaySettingsProjection(
        ACCOUNT_SCOPE,
        { ...empty, updatedAt: empty.updatedAt + 1 },
        { signedRelayListAuthoritative: false }
      )
      setAccountRelaySettingsProjection(
        ACCOUNT_SCOPE,
        { ...empty, updatedAt: empty.updatedAt + 2 },
        { signedRelayListAuthoritative: true }
      )
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual(["signed_projection", "signed_projection"])
  })

  it("defers legacy cleanup on partial evidence, then seeds one account draft after complete absence", () => {
    const storage = new MemoryStorage()
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
      migrateLegacyRelaySettingsDraft({
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
      })
    ).toBe("deferred")
    expect(storage.getItem(marketKey)).not.toBeNull()
    expect(storage.getItem(merchantKey)).not.toBeNull()

    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("seeded_draft")
    expect(storage.getItem(marketKey)).toBeNull()
    expect(storage.getItem(merchantKey)).toBeNull()
    const seeded = JSON.parse(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE)) ?? "{}"
    ) as { entries?: Array<{ url: string; source?: string }> }
    expect(seeded.entries?.map((entry) => entry.url)).toEqual([
      "wss://market-legacy.example",
      "wss://merchant-legacy.example",
    ])
    expect(seeded.entries?.every((entry) => entry.source === "manual")).toBe(
      true
    )
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: ["wss://market-legacy.example"],
    })
    const recoveryEntry = storage
      .entries()
      .find(([key]) => key.includes("network-legacy-read-recovery"))
    expect(recoveryEntry).toBeDefined()
    expect(Object.keys(JSON.parse(recoveryEntry?.[1] ?? "{}"))).toEqual([
      "version",
      "readRelayUrls",
    ])
    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("already_complete")
  })

  for (const scenario of [
    { name: "draft persistence", fault: { operation: "set", call: 1 } },
    { name: "recovery persistence", fault: { operation: "set", call: 2 } },
    { name: "prepared marker", fault: { operation: "set", call: 3 } },
    { name: "legacy retirement", fault: { operation: "remove", call: 1 } },
    { name: "complete marker", fault: { operation: "set", call: 4 } },
  ] as const) {
    it(`keeps legacy reads recoverable and retries after ${scenario.name} fails`, () => {
      const storage = new FaultInjectingStorage()
      const legacyKey = seedLegacyRelaySettings(storage)
      storage.arm(scenario.fault)

      expect(
        migrateLegacyRelaySettingsDraft({
          pubkey: OWNER,
          accountScope: ACCOUNT_SCOPE,
          ownerRelayList: ownerResolution(),
          storage,
        })
      ).toBe("retryable")

      const prepared =
        scenario.name === "legacy retirement" ||
        scenario.name === "complete marker"
      if (prepared) {
        expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
          version: 1,
          readRelayUrls: ["wss://legacy-read.example"],
        })
      } else {
        expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
        expect(storage.getItem(legacyKey)).not.toBeNull()
      }

      storage.clearFault()
      expect(
        migrateLegacyRelaySettingsDraft({
          pubkey: OWNER,
          accountScope: ACCOUNT_SCOPE,
          ownerRelayList: ownerResolution(),
          storage,
        })
      ).toBe("seeded_draft")
      expect(storage.getItem(legacyKey)).toBeNull()
      expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
        version: 1,
        readRelayUrls: ["wss://legacy-read.example"],
      })
    })
  }

  it("keeps an uncommitted recovery record inert", () => {
    const storage = new FaultInjectingStorage()
    seedLegacyRelaySettings(storage)
    storage.arm({ operation: "set", call: 3 })

    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("retryable")
    expect(
      storage
        .entries()
        .some(([key]) => key.includes("network-legacy-read-recovery"))
    ).toBe(true)
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
  })

  it("bounds recovery deterministically while reserving required compatibility reads", () => {
    const storage = new MemoryStorage()
    const legacyReadRelayUrls = Array.from(
      { length: MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS + 4 },
      (_, index) => `wss://legacy-${String(index).padStart(2, "0")}.example`
    )
    storage.setItem(
      getRelaySettingsStorageKey(`market:${OWNER}`),
      JSON.stringify(
        createRelaySettingsFromPreferences(
          legacyReadRelayUrls.map((url) => ({
            url,
            readEnabled: true,
            writeEnabled: false,
          })),
          "manual"
        )
      )
    )

    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("seeded_draft")
    const recovery = getCommittedLegacyRelayReadRecovery(OWNER, storage)
    expect(recovery?.readRelayUrls).toEqual(
      legacyReadRelayUrls.slice(0, MAX_LEGACY_INBOX_READ_RECOVERY_RELAYS)
    )
    setInboxMigrationRecoveryRelayUrls(OWNER, recovery?.readRelayUrls ?? [])
    const required = "wss://commerce.conduit.market"
    const plan = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [required],
      requiredCompatibilityRelayUrls: [required],
      maxRelays: 3,
    })
    expect(plan.relayUrls).toEqual([
      required,
      legacyReadRelayUrls[0],
      legacyReadRelayUrls[1],
    ])
    expect(plan.relaySources[required]).toBe("compatibility")
  })

  it("retires legacy keys without letting unsigned state override signed evidence", () => {
    const storage = new MemoryStorage()
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
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: signedOwnerResolution(),
        storage,
      })
    ).toBe("retired_signed_wins")
    expect(storage.getItem(legacyKey)).toBeNull()
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: ["wss://legacy.example"],
    })
  })

  it("returns a seeded legacy draft from the same injected storage seam", async () => {
    const storage = new MemoryStorage()
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
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })
    expect(reconciliation.legacyMigration).toBe("seeded_draft")
    expect(reconciliation.projection.rows).toContainEqual({
      url: "wss://legacy-draft.example",
      position: 0,
      read: "draft",
      write: null,
      privateInbox: null,
      draftRead: true,
      draftWrite: false,
    })
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      "wss://legacy-draft.example",
    ])
  })

  it("uses committed recovery only for inbox reads without claiming membership or creating a write target", async () => {
    const storage = new MemoryStorage()
    seedLegacyRelaySettings(storage)
    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })

    expect(
      reconciliation.projection.rows.every(
        (row) => row.read !== "published" && row.write !== "published"
      )
    ).toBe(true)
    expect(reconciliation.projection.runtimeRelaySettings.entries).toEqual([])
    expect(
      getGeneralReadRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual([])
    expect(
      getPublishableRelaySettingsEntries(
        reconciliation.projection.runtimeRelaySettings.entries
      )
    ).toEqual([])
    const plan = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(plan.relayUrls).toEqual(["wss://legacy-read.example"])
    expect(plan.relaySources).toEqual({
      "wss://legacy-read.example": "migration_recovery",
    })
    expect(plan.source).toBe("migration_recovery")
  })

  it("recovers the old read path when migration storage fails before commit", async () => {
    const storage = new FaultInjectingStorage()
    seedLegacyRelaySettings(storage)
    storage.arm({ operation: "set", call: 3 })

    const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })

    expect(reconciliation.legacyMigration).toBe("retryable")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(reconciliation.projection.runtimeRelaySettings.entries).toEqual([])
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      "wss://legacy-read.example",
    ])
    expect(
      planInboxReadRelays({
        declaration: inboxResolution(),
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      }).relaySources
    ).toEqual({ "wss://legacy-read.example": "migration_recovery" })
  })

  for (const lookup of [
    { state: "lookup_partial", coverage: "partial" },
    { state: "lookup_unavailable", coverage: "unavailable" },
  ] as const) {
    it(`preserves old read routes while kind-10002 lookup is ${lookup.coverage}`, async () => {
      const storage = new MemoryStorage()
      const legacyKey = seedLegacyRelaySettings(storage)
      const reconciliation = await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: ["wss://shared.example"],
        storage,
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
      expect(reconciliation.projection.runtimeRelaySettings.entries).toEqual([])
      expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
        "wss://legacy-read.example",
      ])
      expect(
        planInboxReadRelays({
          declaration: inboxResolution(),
          authenticatedPubkey: OWNER,
          compatibilityRelayUrls: [],
        }).relayUrls
      ).toEqual(["wss://legacy-read.example"])
    })
  }

  it("keeps an explicit recovery clear tombstoned across partial reconciliation", async () => {
    const storage = new MemoryStorage()
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
      resolveOwner: partialOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(deferred.legacyMigration).toBe("deferred")
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      "wss://legacy-read.example",
    ])

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(legacyKey)).toBeNull()
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])

    const afterClear = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: partialOwner,
      resolveInbox: async () => inboxResolution(),
    })
    expect(afterClear.legacyMigration).toBe("already_complete")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toBeNull()
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])
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
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])
  })

  it("lets signed state supersede the migrated draft while retaining inbox read recovery", async () => {
    const storage = new MemoryStorage()
    seedLegacyRelaySettings(storage)
    const first = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () => ownerResolution(),
      resolveInbox: async () => inboxResolution(),
    })
    expect(first.legacyMigration).toBe("seeded_draft")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).not.toBeNull()

    const signed = await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () => signedOwnerResolution(),
      resolveInbox: async () => inboxResolution(),
    })
    expect(signed.legacyMigration).toBe("retired_signed_wins")
    expect(getCommittedLegacyRelayReadRecovery(OWNER, storage)).toEqual({
      version: 1,
      readRelayUrls: ["wss://legacy-read.example"],
    })
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()
    expect(
      signed.projection.runtimeRelaySettings.entries.map((entry) => entry.url)
    ).toEqual(["wss://signed.example"])
    expect(signed.projection.rows.map((row) => row.url)).toEqual([
      "wss://signed.example",
    ])
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      "wss://legacy-read.example",
    ])
    expect(
      planInboxReadRelays({
        declaration: inboxResolution(),
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
      }).relaySources
    ).toEqual({ "wss://legacy-read.example": "migration_recovery" })
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
    setInboxMigrationRecoveryRelayUrls(OWNER, ["wss://signed.example"])
    setAccountRelaySettingsProjection(
      ACCOUNT_SCOPE,
      projection.runtimeRelaySettings
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
    ).toEqual(["wss://signed.example"])
    expect(loadRelaySettingsPresentation(ACCOUNT_SCOPE).entries).toEqual([
      expect.objectContaining({
        url: "wss://signed.example",
        readEnabled: false,
        writeEnabled: true,
      }),
    ])
    const publishable = getPublishableRelaySettingsEntries(
      projection.runtimeRelaySettings.entries
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
      compatibilityRelayUrls: [],
    })
    expect(inboxPlan.relayUrls).toEqual(["wss://signed.example"])
    expect(inboxPlan.relaySources).toEqual({
      "wss://signed.example": "migration_recovery",
    })
  })

  it("does not infer an inbox route from a signed NIP-65 Read relay", () => {
    const signedRead = createRelaySettingsFromPreferences(
      [
        {
          url: "wss://signed-read.example",
          readEnabled: true,
          writeEnabled: false,
        },
      ],
      "published"
    )
    setAccountRelaySettingsProjection(ACCOUNT_SCOPE, signedRead)
    setActiveRelaySettingsScope(ACCOUNT_SCOPE)
    expect(getGeneralReadRelayUrls({ fallbackRelayUrls: [] })).toEqual([
      "wss://signed-read.example",
    ])

    const beforeRecovery = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(beforeRecovery.relayUrls).toEqual([])

    setInboxMigrationRecoveryRelayUrls(OWNER, ["wss://signed-read.example"])
    const afterRecovery = planInboxReadRelays({
      declaration: inboxResolution(),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })
    expect(afterRecovery.relayUrls).toEqual(["wss://signed-read.example"])
    expect(afterRecovery.relaySources).toEqual({
      "wss://signed-read.example": "migration_recovery",
    })
  })

  it("keeps a signed-empty relay list authoritative for generic read planning", async () => {
    const storage = new MemoryStorage()
    await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () =>
        signedRelayListResolution({
          state: "signed_empty",
          tags: [],
          preferences: [],
        }),
      resolveInbox: async () => inboxResolution(),
    })

    const fallback = ["wss://bootstrap.example"]
    expect(
      getGeneralReadRelayUrls({
        scope: ACCOUNT_SCOPE,
        fallbackRelayUrls: fallback,
      })
    ).toEqual([])
    expect(
      getCommerceReadRelayUrls({
        scope: ACCOUNT_SCOPE,
        fallbackRelayUrls: fallback,
      })
    ).toEqual([])
    expect(
      planRelaysWithSnapshot(ACCOUNT_SCOPE).planReads({
        intent: "general",
        skipHealthFilter: true,
      }).relayUrls
    ).toEqual([])
  })

  it("keeps a signed Write-only relay list empty for generic reads", async () => {
    const storage = new MemoryStorage()
    const writeOnlyUrl = "wss://write-only.example"
    await reconcileAccountNetworkPreferences(OWNER, {
      relayUrls: ["wss://shared.example"],
      storage,
      resolveOwner: async () =>
        signedRelayListResolution({
          state: "declared",
          tags: [["r", writeOnlyUrl, "write"]],
          preferences: [
            {
              url: writeOnlyUrl,
              readEnabled: false,
              writeEnabled: true,
            },
          ],
        }),
      resolveInbox: async () => inboxResolution(),
    })

    expect(
      getGeneralReadRelayUrls({
        scope: ACCOUNT_SCOPE,
        fallbackRelayUrls: ["wss://bootstrap.example"],
      })
    ).toEqual([])
    expect(
      getGeneralWriteRelayUrls({
        scope: ACCOUNT_SCOPE,
        fallbackRelayUrls: [],
      })
    ).toEqual([writeOnlyUrl])
    expect(
      planRelaysWithSnapshot(ACCOUNT_SCOPE).planReads({
        intent: "commerce_products",
        skipHealthFilter: true,
      }).relayUrls
    ).toEqual([])
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

  it("clears recovery idempotently and preserves a user-edited draft unless explicitly discarded", () => {
    const storage = new MemoryStorage()
    seedLegacyRelaySettings(storage)
    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("seeded_draft")

    const draftKey = getRelaySettingsStorageKey(ACCOUNT_SCOPE)
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
    const legacyKey = seedLegacyRelaySettings(storage)
    setInboxMigrationRecoveryRelayUrls(OWNER, ["wss://legacy-read.example"])
    storage.arm({ operation: "set", call: 1 })

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("retryable")
    expect(storage.getItem(legacyKey)).not.toBeNull()
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      "wss://legacy-read.example",
    ])

    expect(
      clearLegacyRelayReadRecovery({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        storage,
      })
    ).toBe("cleared")
    expect(storage.getItem(legacyKey)).toBeNull()
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])
  })

  it("drops the process recovery lane once the tombstone commits even if legacy cleanup retries", () => {
    const storage = new FaultInjectingStorage()
    seedLegacyRelaySettings(storage)
    expect(
      migrateLegacyRelaySettingsDraft({
        pubkey: OWNER,
        accountScope: ACCOUNT_SCOPE,
        ownerRelayList: ownerResolution(),
        storage,
      })
    ).toBe("seeded_draft")
    const draftKey = getRelaySettingsStorageKey(ACCOUNT_SCOPE)
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
    setInboxMigrationRecoveryRelayUrls(OWNER, ["wss://legacy-read.example"])
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
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])
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
      draft: createRelaySettingsFromPreferences(
        [
          {
            url: "wss://draft.example",
            readEnabled: true,
            writeEnabled: false,
          },
        ],
        "manual"
      ),
    })
    expect(projection.rows).toEqual([
      {
        url: "wss://signed.example",
        position: 0,
        read: "published",
        write: "published",
        privateInbox: "pending",
        draftRead: false,
        draftWrite: false,
      },
      {
        url: "wss://inbox.example",
        position: 1,
        read: null,
        write: null,
        privateInbox: "pending",
        draftRead: false,
        draftWrite: false,
      },
      {
        url: "wss://draft.example",
        position: 2,
        read: "draft",
        write: null,
        privateInbox: null,
        draftRead: true,
        draftWrite: false,
      },
    ])
  })

  it("reconciles both frontiers on every invocation and forces a fresh kind-10050 read", async () => {
    const storage = new MemoryStorage()
    let ownerCalls = 0
    let inboxCalls = 0
    const inboxFreshness: Array<number | undefined> = []
    const relayPlans: string[][] = []
    const resolveOwner: NonNullable<
      Parameters<typeof reconcileAccountNetworkPreferences>[1]
    >["resolveOwner"] = async (_pubkey, options) => {
      ownerCalls += 1
      relayPlans.push([...(options.relayUrls ?? [])])
      return signedOwnerResolution()
    }
    const resolveInbox: NonNullable<
      Parameters<typeof reconcileAccountNetworkPreferences>[1]
    >["resolveInbox"] = async (_pubkey, options) => {
      inboxCalls += 1
      inboxFreshness.push(options.freshnessMs)
      relayPlans.push([...(options.relayUrls ?? [])])
      return inboxResolution()
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reconcileAccountNetworkPreferences(OWNER, {
        relayUrls: ["wss://shared.example"],
        storage,
        resolveOwner,
        resolveInbox,
      })
    }
    expect(ownerCalls).toBe(2)
    expect(inboxCalls).toBe(2)
    expect(inboxFreshness).toEqual([0, 0])
    expect(relayPlans).toEqual([
      ["wss://shared.example"],
      ["wss://shared.example"],
      ["wss://shared.example"],
      ["wss://shared.example"],
    ])
  })

  it("keeps unsigned account drafts out of runtime while bridging signed state into the existing page", () => {
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

    const signed = createRelaySettingsFromPreferences(
      [
        {
          url: "wss://signed.example",
          readEnabled: true,
          writeEnabled: true,
        },
      ],
      "published"
    )
    setAccountRelaySettingsProjection(ACCOUNT_SCOPE, signed)
    expect(getAccountRelaySettingsProjection(ACCOUNT_SCOPE)?.entries).toEqual(
      signed.entries
    )
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual(["wss://signed.example"])
    expect(loadRelaySettingsPresentation(ACCOUNT_SCOPE).entries[0]?.url).toBe(
      "wss://draft.example"
    )

    storage.removeItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(false)
    expect(loadRelaySettingsPresentation(ACCOUNT_SCOPE).entries[0]?.url).toBe(
      "wss://signed.example"
    )
    expect(
      storage.getItem(getRelaySettingsStorageKey(ACCOUNT_SCOPE))
    ).toBeNull()

    saveRelaySettings(draft, "market:guest")
    expect(loadRelaySettingsForPlan("market:guest").entries[0]?.url).toBe(
      "wss://draft.example"
    )
  })

  it("does not let a malformed local draft hide a signed projection", () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
    })
    const signed = createRelaySettingsFromPreferences(
      [
        {
          url: "wss://signed.example",
          readEnabled: false,
          writeEnabled: true,
        },
      ],
      "published"
    )
    setAccountRelaySettingsProjection(ACCOUNT_SCOPE, signed)
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
    expect(loadRelaySettingsPresentation(ACCOUNT_SCOPE).entries).toEqual(
      signed.entries
    )
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual(["wss://signed.example"])

    storage.setItem(
      draftKey,
      JSON.stringify({ version: 1, updatedAt: 1, entries: [] })
    )
    expect(hasRelaySettingsDraft(ACCOUNT_SCOPE)).toBe(true)
    expect(loadRelaySettingsPresentation(ACCOUNT_SCOPE).entries).toEqual([])
    expect(
      getGeneralWriteRelayUrls({ scope: ACCOUNT_SCOPE, fallbackRelayUrls: [] })
    ).toEqual(["wss://signed.example"])
  })

  it("never exposes account A readiness during an A-to-B render transition", () => {
    const accountAState = {
      contextKey: OWNER,
      status: "ready" as const,
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
      reconciliation: null,
      error: null,
    })
    expect(
      prepareAccountNetworkPreferencesPresentation(null, accountAState)
    ).toEqual({ status: "idle", reconciliation: null, error: null })
  })
})
