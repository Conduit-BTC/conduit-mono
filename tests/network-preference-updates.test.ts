import { createHash } from "node:crypto"

import { beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetAccountNetworkPreferenceUpdateLocksForTests,
  __resetAccountRelaySettingsProjectionsForTests,
  __resetInboxDeclarationCache,
  accountNetworkPreferenceCheckpointSharedSetConfirmed,
  applyAccountNetworkPreferenceUpdateOutcomes,
  applyAccountNetworkPreferenceUpdateStage,
  applyAccountNetworkPreferenceUpdateSupersession,
  applyInboxDeclarationEvidenceMerge,
  applyOwnerRelayListEvidenceReconciliation,
  createInMemoryInboxDeclarationEvidenceRepository,
  createRelaySettingsFromPreferences,
  getAccountRelayScope,
  getAccountRelaySettingsProjection,
  getInboxExplicitRemovalRelayUrls,
  getInboxMigrationRecoveryRelayUrls,
  NETWORK_PREFERENCE_CUTOVER_GRACE_MS,
  normalizeInboxDeclarationEvidencePubkey,
  normalizeOwnerRelayListPubkey,
  parseNip65RelayTags,
  planInboxReadRelays,
  publishAccountNetworkPreferenceUpdate,
  readRetainedInboxDeclaration,
  reconcileAccountNetworkPreferences,
  resumeAccountNetworkPreferenceUpdate,
  retryAccountNetworkPreferenceUpdate,
  reviewAccountNetworkPreferences,
  selectPrivateMessageDeliveryRoute,
  setInboxMigrationRecoveryRelayUrls,
  stageInboxDeclarationDistribution,
  type AccountNetworkPreferenceAction,
  type AccountNetworkPreferenceDurableFrontiers,
  type AccountNetworkPreferenceUpdateDependencies,
  type AccountNetworkPreferenceUpdateRecord,
  type AccountNetworkPreferenceUpdateRepository,
  type AccountNetworkPreferencesReconciliation,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceRepository,
  type NostrEventSigner,
  type OwnerRelayListEvidenceRecord,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { NostrSignerError } from "@conduit/core/protocol/nostr-event-signer"

const OWNER_SECRET = new Uint8Array(
  createHash("sha256")
    .update("network-preference-update-owner", "utf8")
    .digest()
)
const OWNER = getPublicKey(OWNER_SECRET)
const NOW = 1_700_000_000_000
const PLAN = ["wss://relay.conduit.market", "wss://relay.primal.net"]
const PUBLIC_A = "wss://public-a.example"
const PUBLIC_B = "wss://public-b.example"
const PUBLIC_C = "wss://public-c.example"
const INBOX_A = "wss://inbox-a.example"
const INBOX_B = "wss://inbox-b.example"
const REMOVED = "wss://removed.example"

function signedEvent(
  kind: 10002 | 10050,
  tags: string[][],
  createdAt = 100
): SignedPublicNostrEvent {
  const event = finalizeEvent(
    { kind, tags, created_at: createdAt, content: "" },
    OWNER_SECRET
  )
  return { ...event, tags: event.tags.map((tag) => [...tag]) }
}

function ownerEvidence(
  event: SignedPublicNostrEvent
): OwnerRelayListEvidenceRecord {
  return applyOwnerRelayListEvidenceReconciliation(undefined, {
    pubkey: OWNER,
    observations: [
      {
        signedEvent: event,
        sourceRelayUrls: [...PLAN],
        observedAt: 1_000,
        completeObservedAt: 1_000,
      },
    ],
    lookup: {
      observedAt: 1_000,
      coverage: "complete",
      hadEvent: true,
      eventId: event.id,
    },
    cachedAt: 1_000,
  })
}

function inboxEvidence(
  event: SignedPublicNostrEvent
): InboxDeclarationEvidenceRecord {
  return applyInboxDeclarationEvidenceMerge(undefined, {
    pubkey: OWNER,
    signedEvent: event,
    sourceRelayUrls: [...PLAN],
    sharedSourceRelayUrls: [...PLAN],
    observedAt: 1_000,
    completeObservedAt: 1_000,
    cachedAt: 1_000,
    lookup: {
      observedAt: 1_000,
      coverage: "complete",
      hadEvent: true,
      eventId: event.id,
    },
  })
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

class MemoryNetworkUpdateRepository implements AccountNetworkPreferenceUpdateRepository {
  update: AccountNetworkPreferenceUpdateRecord | null
  owner: OwnerRelayListEvidenceRecord | undefined
  inbox: InboxDeclarationEvidenceRecord | undefined
  failStage = false
  stageCalls = 0
  durableReadCalls = 0
  onDurableRead?: (repository: MemoryNetworkUpdateRepository) => void

  constructor(input: {
    update?: AccountNetworkPreferenceUpdateRecord | null
    owner?: OwnerRelayListEvidenceRecord
    inbox?: InboxDeclarationEvidenceRecord
  }) {
    this.update = input.update ? clone(input.update) : null
    this.owner = input.owner ? clone(input.owner) : undefined
    this.inbox = input.inbox ? clone(input.inbox) : undefined
  }

  snapshot(): MemoryNetworkUpdateRepository {
    return new MemoryNetworkUpdateRepository({
      update: this.update,
      owner: this.owner,
      inbox: this.inbox,
    })
  }

  private frontiers(): AccountNetworkPreferenceDurableFrontiers {
    return {
      relayList: this.owner?.current?.signedEvent
        ? clone(this.owner.current.signedEvent)
        : null,
      relayListObserved: Boolean(this.owner?.current?.sourceRelayUrls.length),
      inboxDeclaration: this.inbox?.current.signedEvent
        ? clone(this.inbox.current.signedEvent)
        : null,
      inboxDeclarationObserved: Boolean(
        this.inbox?.current.sourceRelayUrls.length
      ),
    }
  }

  async get(): Promise<AccountNetworkPreferenceUpdateRecord | null> {
    return this.update ? clone(this.update) : null
  }

  async getDurableFrontiers(): Promise<AccountNetworkPreferenceDurableFrontiers> {
    this.durableReadCalls += 1
    this.onDurableRead?.(this)
    return this.frontiers()
  }

  async stage(input: {
    record: AccountNetworkPreferenceUpdateRecord
    expectedUpdateId: string | null
  }) {
    this.stageCalls += 1
    if (this.failStage) throw new Error("durable stage failed")
    const staged = applyAccountNetworkPreferenceUpdateStage({
      existingUpdate: this.update ?? undefined,
      ownerEvidence: this.owner,
      inboxEvidence: this.inbox,
      ...input,
    })
    this.update = clone(staged.record)
    this.inbox = staged.inboxEvidence ? clone(staged.inboxEvidence) : undefined
    return clone(staged)
  }

  async recordOutcomes(
    mutation: Parameters<
      AccountNetworkPreferenceUpdateRepository["recordOutcomes"]
    >[0]
  ) {
    const updated = applyAccountNetworkPreferenceUpdateOutcomes({
      existingUpdate: this.update ?? undefined,
      ownerEvidence: this.owner,
      inboxEvidence: this.inbox,
      mutation,
    })
    this.update = clone(updated.record)
    this.owner = updated.ownerEvidence
      ? clone(updated.ownerEvidence)
      : undefined
    this.inbox = updated.inboxEvidence
      ? clone(updated.inboxEvidence)
      : undefined
    return {
      record: clone(updated.record),
      inboxEvidence: updated.inboxEvidence
        ? clone(updated.inboxEvidence)
        : null,
      frontiers: this.frontiers(),
    }
  }

  async reconcileSupersession(input: {
    pubkey: string
    updateId: string
    observedAt: number
  }) {
    if (!this.update || this.update.updateId !== input.updateId) {
      throw new Error("missing update")
    }
    this.update = applyAccountNetworkPreferenceUpdateSupersession({
      record: this.update,
      frontiers: this.frontiers(),
      observedAt: input.observedAt,
    })
    return {
      record: clone(this.update),
      inboxEvidence: this.inbox ? clone(this.inbox) : null,
      frontiers: this.frontiers(),
    }
  }
}

function reconciliation(input: {
  relayList: SignedPublicNostrEvent
  inbox: SignedPublicNostrEvent
}): AccountNetworkPreferencesReconciliation {
  const ownerRecord = ownerEvidence(input.relayList)
  const inboxRecord = inboxEvidence(input.inbox)
  const preferences = parseNip65RelayTags(input.relayList.tags)
  const inboxRelayUrls = input.inbox.tags
    .filter((tag) => tag[0] === "relay")
    .map((tag) => tag[1]!)
  const ownerState = preferences.length > 0 ? "declared" : "signed_empty"
  const inboxState = inboxRelayUrls.length > 0 ? "declared" : "signed_empty"
  const ownerPubkey = normalizeOwnerRelayListPubkey(OWNER)!
  const inboxPubkey = normalizeInboxDeclarationEvidencePubkey(OWNER)!
  return {
    ownerRelayList: {
      pubkey: ownerPubkey,
      state: ownerState,
      preferences,
      stale: false,
      current: ownerRecord.current,
      lookup: ownerRecord.latestLookup,
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [...PLAN],
        successfulRelayUrls: [...PLAN],
        failedRelayUrls: [],
        cappedRelayUrls: [],
        eventId: input.relayList.id,
        eventSourceRelayUrls: [...PLAN],
      },
    },
    inboxDeclaration: {
      pubkey: inboxPubkey,
      state: inboxState,
      relayUrls: inboxRelayUrls,
      stale: false,
      fetchedAt: 1_000,
      eventId: input.inbox.id,
      eventCreatedAt: input.inbox.created_at,
      sourceRelayUrls: [...PLAN],
      sharedSourceRelayUrls: [...PLAN],
      observation: {
        coverage: "complete",
        attemptedRelayUrls: [...PLAN],
        successfulRelayUrls: [...PLAN],
        failedRelayUrls: [],
        eventId: input.inbox.id,
        eventSourceRelayUrls: [...PLAN],
      },
    },
    projection: {
      pubkey: OWNER,
      relayScope: getAccountRelayScope(OWNER),
      rows: [],
      relayListState: ownerState,
      relayListStale: false,
      inboxState,
      inboxStale: false,
      runtimeRelaySettings: createRelaySettingsFromPreferences(
        preferences,
        "published"
      ),
    },
    legacyMigration: "not_applicable",
    pendingUpdate: null,
    pendingUpdateStatus: "none",
  }
}

function baseFixture(
  input: {
    nip65Urls?: readonly string[]
    inboxUrls?: readonly string[]
  } = {}
) {
  const nip65Urls = input.nip65Urls ?? [PUBLIC_A, PUBLIC_B]
  const inboxUrls = input.inboxUrls ?? [INBOX_A]
  const relayList = signedEvent(
    10002,
    nip65Urls.map((url) => ["r", url])
  )
  const inbox = signedEvent(
    10050,
    inboxUrls.map((url) => ["relay", url])
  )
  const current = reconciliation({ relayList, inbox })
  const repository = new MemoryNetworkUpdateRepository({
    owner: ownerEvidence(relayList),
    inbox: inboxEvidence(inbox),
  })
  return { relayList, inbox, current, repository }
}

function unusableInboxFixture(state: "signed_empty" | "malformed") {
  const relayList = signedEvent(
    10002,
    [REMOVED, PUBLIC_A, PUBLIC_B].map((url) => ["r", url])
  )
  const lastUsableInbox = signedEvent(
    10050,
    [REMOVED, INBOX_A].map((url) => ["relay", url]),
    100
  )
  const inbox = signedEvent(
    10050,
    state === "signed_empty" ? [] : [["relay", "not-a-relay"]],
    101
  )
  const retainedInbox = applyInboxDeclarationEvidenceMerge(
    inboxEvidence(lastUsableInbox),
    {
      pubkey: OWNER,
      signedEvent: inbox,
      sourceRelayUrls: [...PLAN],
      sharedSourceRelayUrls: [...PLAN],
      observedAt: 2_000,
      completeObservedAt: 2_000,
      cachedAt: 2_000,
      lookup: {
        observedAt: 2_000,
        coverage: "complete",
        hadEvent: true,
        eventId: inbox.id,
      },
    }
  )
  const current = reconciliation({ relayList, inbox })
  current.inboxDeclaration = {
    ...current.inboxDeclaration,
    state,
    relayUrls: [],
    retainedReadRelayUrls: [REMOVED, INBOX_A],
  }
  current.projection = {
    ...current.projection,
    inboxState: state,
  }
  const repository = new MemoryNetworkUpdateRepository({
    owner: ownerEvidence(relayList),
    inbox: retainedInbox,
  })
  return { relayList, inbox, lastUsableInbox, current, repository }
}

function signer(
  input: {
    signedKinds?: number[]
    failAt?: number
    failure?: Error
    invalidAt?: number
    shouldContinueAfterSign?: () => void
  } = {}
): NostrEventSigner {
  let signCalls = 0
  return {
    authMethod: "nip07",
    getPublicKey: async () => OWNER,
    signEvent: async (unsigned) => {
      signCalls += 1
      input.signedKinds?.push(unsigned.kind)
      if (input.failAt === signCalls) {
        throw input.failure ?? new Error("signer refused")
      }
      const signed = finalizeEvent(unsigned, OWNER_SECRET)
      input.shouldContinueAfterSign?.()
      return input.invalidAt === signCalls
        ? { ...signed, sig: "0".repeat(128) }
        : signed
    },
  }
}

function exactReadResult(
  relayUrl: string,
  event: SignedPublicNostrEvent,
  status: "observed" | "absent" | "timed_out"
) {
  return {
    events: status === "observed" ? [clone(event)] : [],
    eventSourceRelayUrls:
      status === "observed" ? { [event.id]: [relayUrl] } : {},
    relays: [
      {
        relayUrl,
        status:
          status === "timed_out" ? ("failed" as const) : ("success" as const),
        eventCount: status === "observed" ? 1 : 0,
        rejectedEventCount: 0,
      },
    ],
    eventsVerified: true,
  }
}

function dependencies(
  repository: MemoryNetworkUpdateRepository,
  current: AccountNetworkPreferencesReconciliation,
  overrides: Partial<AccountNetworkPreferenceUpdateDependencies> = {}
): AccountNetworkPreferenceUpdateDependencies {
  return {
    repository,
    reconcile: async () => clone(current),
    resolveRelayPlan: () => PLAN,
    now: () => NOW,
    publishToRelay: async () => "acked",
    fetchEvents: async (_filter, options) => {
      const record = (await repository.get())!
      const relayUrl = options.relayUrls[0]!
      const event = record.checkpoints.find(
        (checkpoint) => checkpoint.signedEvent.id === _filter.ids?.[0]
      )!.signedEvent
      return exactReadResult(relayUrl, event, "observed")
    },
    ...overrides,
  }
}

function setRolesAction(
  input: {
    nip65Urls?: readonly string[]
    inboxUrls?: readonly string[]
  } = {}
): AccountNetworkPreferenceAction {
  return {
    type: "set_roles",
    nip65Preferences: (input.nip65Urls ?? [PUBLIC_A, PUBLIC_B]).map((url) => ({
      url,
      readEnabled: true,
      writeEnabled: true,
    })),
    inboxRelayUrls: input.inboxUrls ?? [INBOX_A],
  }
}

function inboxRepository(
  repository: MemoryNetworkUpdateRepository
): InboxDeclarationEvidenceRepository {
  return {
    get: async () => (repository.inbox ? clone(repository.inbox) : undefined),
    reconcile: async () => {
      throw new Error("read-only test repository")
    },
  }
}

beforeEach(() => {
  __resetAccountNetworkPreferenceUpdateLocksForTests()
  __resetAccountRelaySettingsProjectionsForTests()
  __resetInboxDeclarationCache()
})

describe("coordinated account Network updates", () => {
  it("ordinary edits sign only the normalized event kinds that changed", async () => {
    const one = baseFixture()
    const oneKinds: number[] = []
    const oneResult = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
      }),
      signer: signer({ signedKinds: oneKinds }),
      reviewed: reviewAccountNetworkPreferences(one.current),
      dependencies: dependencies(one.repository, one.current),
    })
    expect(oneKinds).toEqual([10002])
    expect(oneResult.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
      10002,
    ])

    const both = baseFixture()
    const bothKinds: number[] = []
    const bothResult = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer({ signedKinds: bothKinds }),
      reviewed: reviewAccountNetworkPreferences(both.current),
      dependencies: dependencies(both.repository, both.current),
    })
    expect(bothKinds).toEqual([10002, 10050])
    expect(bothResult.checkpoints).toHaveLength(2)
    expect(
      bothResult.update!.checkpoints.find(
        (checkpoint) => checkpoint.kind === 10002
      )!.signedEvent.created_at
    ).toBeGreaterThan(both.relayList.created_at)
    expect(
      bothResult.update!.checkpoints.find(
        (checkpoint) => checkpoint.kind === 10050
      )!.signedEvent.created_at
    ).toBeGreaterThan(both.inbox.created_at)
  })

  for (const [label, inNip65, inInbox] of [
    ["both kinds", true, true],
    ["only kind 10002", true, false],
    ["only kind 10050", false, true],
    ["neither kind", false, false],
  ] as const) {
    it(`whole removal signs and stages both replacements from ${label}`, async () => {
      const fixture = baseFixture({
        nip65Urls: inNip65
          ? [REMOVED, PUBLIC_A, PUBLIC_B]
          : [PUBLIC_A, PUBLIC_B],
        inboxUrls: inInbox ? [REMOVED, INBOX_A] : [INBOX_A],
      })
      const signedKinds: number[] = []
      const result = await publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: { type: "remove_relay", relayUrl: REMOVED },
        signer: signer({ signedKinds }),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current),
      })

      expect(signedKinds).toEqual([10002, 10050])
      expect(result.update?.action).toBe("whole_relay_removal")
      expect(result.update?.checkpoints).toHaveLength(2)
      for (const checkpoint of result.update?.checkpoints ?? []) {
        expect(checkpoint.signedEvent.tags.flat()).not.toContain(REMOVED)
      }
    })
  }

  it("never uses a removed URL from the immutable publish plans", async () => {
    const removedSharedRelay = PLAN[0]
    const fixture = baseFixture({
      nip65Urls: [removedSharedRelay, PUBLIC_A, PUBLIC_B],
      inboxUrls: [removedSharedRelay, INBOX_A],
    })
    const attempted: string[] = []
    const result = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: { type: "remove_relay", relayUrl: removedSharedRelay },
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ relayUrl }) => {
          attempted.push(relayUrl)
          return "acked"
        },
      }),
    })
    expect(attempted).toEqual([PLAN[1], PLAN[1]])
    expect(
      result.update!.checkpoints.every(
        (checkpoint) => !checkpoint.relayPlan.includes(removedSharedRelay)
      )
    ).toBe(true)
  })

  it("aborts a whole removal atomically when either reviewed frontier changes during signing", async () => {
    const fixture = baseFixture({
      nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
      inboxUrls: [REMOVED, INBOX_A],
    })
    fixture.repository.onDurableRead = (repository) => {
      if (repository.durableReadCalls !== 2) return
      repository.owner = ownerEvidence(
        signedEvent(10002, [["r", PUBLIC_C]], NOW / 1_000 + 10)
      )
    }
    let networkCalls = 0

    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: { type: "remove_relay", relayUrl: REMOVED },
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
          fetchEvents: async () => {
            networkCalls += 1
            throw new Error("must not read")
          },
        }),
      })
    ).rejects.toMatchObject({ code: "evidence_changed" })
    expect(fixture.repository.stageCalls).toBe(0)
    expect(fixture.repository.update).toBeNull()
    expect(networkCalls).toBe(0)
    expect(getInboxExplicitRemovalRelayUrls(OWNER)).toEqual([])
  })

  it("aborts the whole-removal transaction when a frontier changes during staging", async () => {
    const fixture = baseFixture({
      nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
      inboxUrls: [REMOVED, INBOX_A],
    })
    const originalStage = fixture.repository.stage.bind(fixture.repository)
    fixture.repository.stage = async (input) => {
      fixture.repository.inbox = inboxEvidence(
        signedEvent(10050, [["relay", INBOX_A]], NOW / 1_000 + 10)
      )
      return await originalStage(input)
    }
    let networkCalls = 0

    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: { type: "remove_relay", relayUrl: REMOVED },
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
          fetchEvents: async () => {
            networkCalls += 1
            throw new Error("must not read")
          },
        }),
      })
    ).rejects.toMatchObject({ code: "update_changed" })
    expect(fixture.repository.update).toBeNull()
    expect(networkCalls).toBe(0)
    expect(getInboxExplicitRemovalRelayUrls(OWNER)).toEqual([])
  })

  for (const failure of [
    {
      label: "cancellation",
      signer: () =>
        signer({
          failAt: 1,
          failure: new NostrSignerError("authorization_denied"),
        }),
    },
    {
      label: "second-signature refusal",
      signer: () => signer({ failAt: 2 }),
    },
    {
      label: "invalid second signature",
      signer: () => signer({ invalidAt: 2 }),
    },
  ]) {
    it(`${failure.label} leaves no stage, network call, or cutover`, async () => {
      const fixture = baseFixture()
      let networkCalls = 0
      await expect(
        publishAccountNetworkPreferenceUpdate({
          pubkey: OWNER,
          action: setRolesAction({
            nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
            inboxUrls: [INBOX_B],
          }),
          signer: failure.signer(),
          reviewed: reviewAccountNetworkPreferences(fixture.current),
          dependencies: dependencies(fixture.repository, fixture.current, {
            publishToRelay: async () => {
              networkCalls += 1
              return "acked"
            },
          }),
        })
      ).rejects.toBeInstanceOf(Error)
      expect(fixture.repository.stageCalls).toBe(0)
      expect(networkCalls).toBe(0)
      expect(await fixture.repository.get()).toBeNull()
    })
  }

  it("durable staging failure prevents all network I/O", async () => {
    const fixture = baseFixture({
      nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
      inboxUrls: [REMOVED, INBOX_A],
    })
    fixture.repository.failStage = true
    let networkCalls = 0
    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: { type: "remove_relay", relayUrl: REMOVED },
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
          fetchEvents: async () => {
            networkCalls += 1
            throw new Error("must not read")
          },
        }),
      })
    ).rejects.toThrow("durable stage failed")
    expect(fixture.repository.stageCalls).toBe(1)
    expect(networkCalls).toBe(0)
    expect(getInboxExplicitRemovalRelayUrls(OWNER)).toEqual([])
  })

  it("stages exact events before the first publish or readback", async () => {
    const fixture = baseFixture()
    const ordering: string[] = []
    const originalStage = fixture.repository.stage.bind(fixture.repository)
    fixture.repository.stage = async (input) => {
      const result = await originalStage(input)
      ordering.push("staged")
      return result
    }
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => {
          expect(fixture.repository.update).not.toBeNull()
          ordering.push("publish")
          return "acked"
        },
        fetchEvents: async (filter, options) => {
          ordering.push("readback")
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "observed")
        },
      }),
    })
    expect(ordering[0]).toBe("staged")
  })

  it("persists independent ACK, reject, timeout, and exact readback outcomes", async () => {
    const fixture = baseFixture()
    const result = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ signedEvent, relayUrl }) => {
          if (signedEvent.kind === 10002) {
            return relayUrl === PLAN[0] ? "acked" : "rejected"
          }
          if (relayUrl === PLAN[0]) throw new Error("timeout")
          return "acked"
        },
        fetchEvents: async (filter, options) => {
          const checkpoint = fixture.repository.update!.checkpoints.find(
            (candidate) => candidate.signedEvent.id === filter.ids?.[0]
          )!
          const relayUrl = options.relayUrls[0]!
          const readStatus =
            checkpoint.kind === 10002
              ? relayUrl === PLAN[0]
                ? "observed"
                : "absent"
              : relayUrl === PLAN[0]
                ? "timed_out"
                : "observed"
          return exactReadResult(relayUrl, checkpoint.signedEvent, readStatus)
        },
      }),
    })

    const relayList = result.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10002
    )!
    const inbox = result.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!
    expect(
      relayList.relayOutcomes.map((outcome) => outcome.publishStatus)
    ).toEqual(["acked", "rejected"])
    expect(
      relayList.relayOutcomes.map((outcome) => outcome.readbackStatus)
    ).toEqual(["observed", "absent"])
    expect(
      accountNetworkPreferenceCheckpointSharedSetConfirmed(relayList)
    ).toBe(true)
    expect(inbox.relayOutcomes.map((outcome) => outcome.publishStatus)).toEqual(
      ["timed_out", "acked"]
    )
    expect(
      inbox.relayOutcomes.map((outcome) => outcome.readbackStatus)
    ).toEqual(["timed_out", "observed"])
    expect(accountNetworkPreferenceCheckpointSharedSetConfirmed(inbox)).toBe(
      false
    )
  })

  it("retries only unresolved destinations with exact staged bytes and no signer", async () => {
    const fixture = baseFixture()
    const firstAttempts: string[] = []
    const first = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ relayUrl }) => {
          firstAttempts.push(relayUrl)
          return relayUrl === PLAN[0] ? "acked" : "timed_out"
        },
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(
            options.relayUrls[0]!,
            event,
            options.relayUrls[0] === PLAN[0] ? "observed" : "timed_out"
          )
        },
      }),
    })
    const exactId = first.update!.checkpoints[0]!.signedEvent.id
    const retryAttempts: Array<{ relayUrl: string; eventId: string }> = []
    const retried = await retryAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ relayUrl, signedEvent }) => {
          retryAttempts.push({ relayUrl, eventId: signedEvent.id })
          return "acked"
        },
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "observed")
        },
      }),
    })
    expect(firstAttempts).toEqual(PLAN)
    expect(retryAttempts).toEqual([{ relayUrl: PLAN[1], eventId: exactId }])
    expect(retried.update!.checkpoints[0]!.signedEvent.id).toBe(exactId)
  })

  it("allows a successor after an exact pending checkpoint becomes the observed durable frontier", async () => {
    const fixture = baseFixture()
    const first = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => "timed_out",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const firstCheckpoint = first.update!.checkpoints[0]!
    expect(
      firstCheckpoint.relayOutcomes.every(
        (outcome) =>
          outcome.publishStatus === "timed_out" &&
          outcome.readbackStatus === "timed_out"
      )
    ).toBe(true)
    fixture.repository.owner = ownerEvidence(firstCheckpoint.signedEvent)
    const current = reconciliation({
      relayList: firstCheckpoint.signedEvent,
      inbox: fixture.inbox,
    })
    const signedKinds: number[] = []

    const successor = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B] }),
      signer: signer({ signedKinds }),
      reviewed: reviewAccountNetworkPreferences(current),
      dependencies: dependencies(fixture.repository, current),
    })

    expect(signedKinds).toEqual([10002])
    expect(successor.update?.updateId).not.toBe(first.update?.updateId)
  })

  it("carries an observed unchanged checkpoint and its pending inbox authority into a one-kind successor", async () => {
    const fixture = baseFixture()
    let clock = NOW
    const first = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        now: () => clock,
        publishToRelay: async ({ relayUrl }) =>
          relayUrl === PLAN[0] ? "acked" : "rejected",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          const relayUrl = options.relayUrls[0]!
          return exactReadResult(
            relayUrl,
            event,
            relayUrl === PLAN[0] ? "observed" : "timed_out"
          )
        },
      }),
    })
    const firstInbox = clone(
      first.update!.checkpoints.find((checkpoint) => checkpoint.kind === 10050)!
    )
    const firstPending = clone(fixture.repository.inbox!.pendingDistribution!)
    const firstCutover = clone(fixture.repository.inbox!.cutoverRecovery)
    const currentRelay = first.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10002
    )!.signedEvent
    const current = reconciliation({
      relayList: currentRelay,
      inbox: firstInbox.signedEvent,
    })
    const signedKinds: number[] = []
    const retriedPublishes: Array<{
      kind: number
      relayUrl: string
      eventId: string
    }> = []
    const retriedReads: Array<{
      kind: number
      relayUrl: string
      eventId: string
    }> = []
    clock += 1_000

    const successor = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B],
        inboxUrls: [INBOX_B],
      }),
      signer: signer({ signedKinds }),
      reviewed: reviewAccountNetworkPreferences(current),
      dependencies: dependencies(fixture.repository, current, {
        now: () => clock,
        publishToRelay: async ({ signedEvent, relayUrl }) => {
          retriedPublishes.push({
            kind: signedEvent.kind,
            relayUrl,
            eventId: signedEvent.id,
          })
          return "acked"
        },
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          const relayUrl = options.relayUrls[0]!
          retriedReads.push({
            kind: event.kind,
            relayUrl,
            eventId: event.id,
          })
          return exactReadResult(
            relayUrl,
            event,
            event.kind === 10050 ? "timed_out" : "observed"
          )
        },
      }),
    })

    expect(signedKinds).toEqual([10002])
    const carried = successor.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!
    expect(carried.signedEvent).toEqual(firstInbox.signedEvent)
    expect(carried.relayPlan).toEqual(firstInbox.relayPlan)
    expect(carried.stagedAt).toBe(firstInbox.stagedAt)
    expect(carried.relayOutcomes[0]).toEqual(firstInbox.relayOutcomes[0])
    expect(carried.relayOutcomes[1]).toMatchObject({
      publishStatus: "acked",
      publishAttemptCount: 2,
      readbackStatus: "timed_out",
      readbackAttemptCount: 2,
    })
    expect(
      retriedPublishes.filter((attempt) => attempt.kind === 10050)
    ).toEqual([
      { kind: 10050, relayUrl: PLAN[1], eventId: firstInbox.signedEvent.id },
    ])
    expect(retriedReads.filter((attempt) => attempt.kind === 10050)).toEqual([
      { kind: 10050, relayUrl: PLAN[1], eventId: firstInbox.signedEvent.id },
    ])
    expect(fixture.repository.inbox?.pendingDistribution).toMatchObject({
      signedEvent: firstPending.signedEvent,
      publishRelayUrls: firstPending.publishRelayUrls,
      stagedAt: firstPending.stagedAt,
      coordinatedUpdateId: successor.update!.updateId,
    })
    expect(fixture.repository.inbox?.cutoverRecovery).toEqual(firstCutover)
    const retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => clock,
    })
    expect(retained).toMatchObject({
      state: "distribution_pending",
      pendingWriteAuthorized: true,
    })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: retained!,
        rumorKind: 14,
        validatedOrder: false,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })
  })

  it("blocks a successor while another active kind lacks observed exact durable evidence", async () => {
    const fixture = baseFixture()
    const first = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => "timed_out",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const relayList = first.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10002
    )!
    const inbox = first.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!
    fixture.repository.owner = ownerEvidence(relayList.signedEvent)
    const current = reconciliation({
      relayList: relayList.signedEvent,
      inbox: inbox.signedEvent,
    })
    const signedKinds: number[] = []

    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B] }),
        signer: signer({ signedKinds }),
        reviewed: reviewAccountNetworkPreferences(current),
        dependencies: dependencies(fixture.repository, current),
      })
    ).rejects.toMatchObject({ code: "pending_update" })
    expect(signedKinds).toEqual([])
    expect(fixture.repository.update?.updateId).toBe(first.update?.updateId)
  })

  it("supersedes only the kind whose durable frontier changes during signing", async () => {
    const fixture = baseFixture()
    fixture.repository.onDurableRead = (repository) => {
      if (repository.durableReadCalls !== 2) return
      repository.owner = ownerEvidence(
        signedEvent(
          10002,
          [
            ["r", PUBLIC_B],
            ["r", PUBLIC_C],
          ],
          NOW / 1_000 + 10
        )
      )
    }
    const publishedKinds: number[] = []
    const result = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ signedEvent }) => {
          publishedKinds.push(signedEvent.kind)
          return "timed_out"
        },
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    expect(
      result.update!.checkpoints.find((checkpoint) => checkpoint.kind === 10002)
        ?.state
    ).toBe("superseded")
    expect(
      result.update!.checkpoints.find((checkpoint) => checkpoint.kind === 10050)
        ?.state
    ).toBe("active")
    expect(new Set(publishedKinds)).toEqual(new Set([10050]))
    expect(
      getAccountRelaySettingsProjection(
        getAccountRelayScope(OWNER)
      )?.entries.map((entry) => entry.url)
    ).toEqual([PUBLIC_B, PUBLIC_C])
    expect(
      result.update!.checkpoints.find((checkpoint) => checkpoint.kind === 10050)
        ?.relayOutcomes
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publishStatus: "timed_out",
          readbackStatus: "timed_out",
        }),
      ])
    )
  })

  it("does not retire legacy recovery when the signed inbox intent is stale before staging", async () => {
    const fixture = baseFixture()
    setInboxMigrationRecoveryRelayUrls(OWNER, [INBOX_A])
    fixture.repository.onDurableRead = (repository) => {
      if (repository.durableReadCalls !== 2) return
      repository.inbox = inboxEvidence(
        signedEvent(10050, [["relay", INBOX_A]], NOW / 1_000 + 10)
      )
    }

    const result = await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current),
    })

    expect(result.update?.checkpoints[0]?.state).toBe("superseded")
    expect(result.update?.legacyRecoveryDiscarded).toBe(false)
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([INBOX_A])
  })

  it("restores the pending runtime overlay after restart", async () => {
    const fixture = baseFixture()
    let firstEvent: SignedPublicNostrEvent | null = null
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async ({ signedEvent }) => {
          firstEvent = clone(signedEvent)
          return "timed_out"
        },
        fetchEvents: async (_filter, options) =>
          exactReadResult(options.relayUrls[0]!, firstEvent!, "timed_out"),
      }),
    })
    const restarted = fixture.repository.snapshot()
    __resetAccountRelaySettingsProjectionsForTests()
    __resetInboxDeclarationCache()

    const resumed = await resumeAccountNetworkPreferenceUpdate(
      OWNER,
      restarted,
      () => NOW + 1
    )
    expect(resumed?.checkpoints[0]?.signedEvent.id).toBe(firstEvent!.id)
    expect(
      getAccountRelaySettingsProjection(
        getAccountRelayScope(OWNER)
      )?.entries.map((entry) => entry.url)
    ).toEqual([PUBLIC_A, PUBLIC_B, PUBLIC_C])
  })

  for (const [label, strongerTags] of [
    ["signed-empty", []],
    ["malformed", [["r", PUBLIC_B, "sideways"]]],
  ] satisfies Array<[string, string[][]]>) {
    it(`replaces an older pending projection with a stronger ${label} kind 10002 on resume`, async () => {
      const fixture = baseFixture()
      const pending = await publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        }),
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          publishToRelay: async () => "timed_out",
          fetchEvents: async (filter, options) => {
            const event = fixture.repository.update!.checkpoints.find(
              (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
            )!.signedEvent
            return exactReadResult(options.relayUrls[0]!, event, "timed_out")
          },
        }),
      })
      expect(
        getAccountRelaySettingsProjection(
          getAccountRelayScope(OWNER)
        )?.entries.map((entry) => entry.url)
      ).toEqual([PUBLIC_A, PUBLIC_B, PUBLIC_C])
      fixture.repository.owner = ownerEvidence(
        signedEvent(10002, strongerTags, NOW / 1_000 + 10)
      )

      const resumed = await resumeAccountNetworkPreferenceUpdate(
        OWNER,
        fixture.repository,
        () => NOW + 1
      )

      expect(resumed?.updateId).toBe(pending.update?.updateId)
      expect(resumed?.checkpoints[0]?.state).toBe("superseded")
      expect(
        getAccountRelaySettingsProjection(getAccountRelayScope(OWNER))?.entries
      ).toEqual([])
      __resetAccountRelaySettingsProjectionsForTests()
    })
  }

  it("clears stale pending inbox authorization when a stronger durable kind 10050 wins", async () => {
    const fixture = baseFixture()
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => "timed_out",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const stalePending = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => NOW,
    })
    expect(stalePending?.pendingWriteAuthorized).toBe(true)
    const stronger = signedEvent(10050, [["relay", INBOX_A]], NOW / 1_000 + 10)
    fixture.repository.inbox = inboxEvidence(stronger)

    const resumed = await resumeAccountNetworkPreferenceUpdate(
      OWNER,
      fixture.repository,
      () => NOW + 1
    )

    expect(resumed?.checkpoints[0]?.state).toBe("superseded")
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: stalePending!,
        rumorKind: 14,
        validatedOrder: false,
      })
    ).toMatchObject({
      route: "blocked",
      blockedReason: "declaration_distribution_pending",
    })
    const current = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => NOW + 1,
    })
    expect(current).toMatchObject({ state: "declared", relayUrls: [INBOX_A] })
  })

  it("rejects forged or structurally tampered durable rows before runtime projection", async () => {
    const fixture = baseFixture()
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [INBOX_B],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => "timed_out",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const valid = clone(fixture.repository.update!)
    const tamperCases: Array<{
      label: string
      mutate(record: AccountNetworkPreferenceUpdateRecord): void
    }> = [
      {
        label: "forged event",
        mutate: (record) => {
          record.checkpoints[0]!.signedEvent.sig = "0".repeat(128)
        },
      },
      {
        label: "mismatched desired roles",
        mutate: (record) => {
          record.nip65Preferences[0]!.readEnabled = false
        },
      },
      {
        label: "malformed immutable plan",
        mutate: (record) => {
          record.checkpoints[0]!.relayPlan = [PLAN[0], PLAN[0]]
        },
      },
      {
        label: "mismatched relay outcomes",
        mutate: (record) => {
          record.checkpoints[0]!.relayOutcomes[0]!.relayUrl = PLAN[1]
        },
      },
    ]

    for (const tamperCase of tamperCases) {
      const tampered = clone(valid)
      tamperCase.mutate(tampered)
      const repository = new MemoryNetworkUpdateRepository({
        update: tampered,
        owner: fixture.repository.owner,
        inbox: fixture.repository.inbox,
      })
      __resetAccountRelaySettingsProjectionsForTests()
      __resetInboxDeclarationCache()
      await expect(
        resumeAccountNetworkPreferenceUpdate(OWNER, repository, () => NOW + 1)
      ).rejects.toThrow("Stored Network preference update is invalid")
      expect(
        getAccountRelaySettingsProjection(getAccountRelayScope(OWNER))
      ).toBeNull()
    }
  })

  it("resumes the durable checkpoint during a fresh account reconciliation", async () => {
    const fixture = baseFixture()
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => "timed_out",
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const restarted = fixture.repository.snapshot()
    __resetAccountRelaySettingsProjectionsForTests()
    __resetInboxDeclarationCache()

    const connected = await reconcileAccountNetworkPreferences(OWNER, {
      resolveOwner: async () => clone(fixture.current.ownerRelayList),
      resolveInbox: async () => clone(fixture.current.inboxDeclaration),
      networkPreferenceUpdateRepository: restarted,
    })
    expect(connected.pendingUpdate?.updateId).toBe(restarted.update?.updateId)
    expect(connected.pendingUpdateStatus).toBe("ready")
    expect(
      getAccountRelaySettingsProjection(
        getAccountRelayScope(OWNER)
      )?.entries.map((entry) => entry.url)
    ).toEqual([PUBLIC_A, PUBLIC_B, PUBLIC_C])
  })

  it("reports durable pending state as unavailable without exposing an error", async () => {
    const fixture = baseFixture()
    fixture.repository.get = async () => {
      throw new Error("private storage failure detail")
    }

    const connected = await reconcileAccountNetworkPreferences(OWNER, {
      resolveOwner: async () => clone(fixture.current.ownerRelayList),
      resolveInbox: async () => clone(fixture.current.inboxDeclaration),
      networkPreferenceUpdateRepository: fixture.repository,
    })

    expect(connected.pendingUpdate).toBeNull()
    expect(connected.pendingUpdateStatus).toBe("unavailable")
    expect(JSON.stringify(connected)).not.toContain("private storage failure")
  })

  for (const state of ["signed_empty", "malformed"] as const) {
    it(`repairs a ${state} inbox while retaining the last usable signed read lane`, async () => {
      const fixture = unusableInboxFixture(state)
      await publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
          inboxUrls: [INBOX_B],
        }),
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          fetchEvents: async (filter, options) => {
            const event = fixture.repository.update!.checkpoints.find(
              (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
            )!.signedEvent
            return exactReadResult(options.relayUrls[0]!, event, "timed_out")
          },
        }),
      })

      expect(fixture.repository.update?.previousInboxRelayUrls).toEqual([
        REMOVED,
        INBOX_A,
      ])
      expect(fixture.repository.inbox?.cutoverRecovery?.relayUrls).toEqual([
        REMOVED,
        INBOX_A,
      ])
      const retained = await readRetainedInboxDeclaration(OWNER, {
        evidenceRepository: inboxRepository(fixture.repository),
        now: () => NOW,
      })
      expect(retained?.state).toBe("distribution_pending")
      expect(
        selectPrivateMessageDeliveryRoute({
          declaration: retained!,
          rumorKind: 14,
        })
      ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })
      const readPlan = planInboxReadRelays({
        declaration: retained!,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
        requiredCompatibilityRelayUrls: [],
      })
      expect(readPlan.relayUrls).toContain(REMOVED)
      expect(readPlan.relayUrls).toContain(INBOX_A)
    })

    it(`removes only the named relay from ${state} last-usable inbox recovery`, async () => {
      const fixture = unusableInboxFixture(state)
      await publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: { type: "remove_relay", relayUrl: REMOVED },
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          fetchEvents: async (filter, options) => {
            const event = fixture.repository.update!.checkpoints.find(
              (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
            )!.signedEvent
            return exactReadResult(options.relayUrls[0]!, event, "timed_out")
          },
        }),
      })

      const inboxCheckpoint = fixture.repository.update?.checkpoints.find(
        (checkpoint) => checkpoint.kind === 10050
      )
      expect(inboxCheckpoint?.signedEvent.tags).toEqual([])
      expect(fixture.repository.update?.previousInboxRelayUrls).toEqual([
        REMOVED,
        INBOX_A,
      ])
      expect(fixture.repository.inbox?.cutoverRecovery?.relayUrls).toEqual([
        INBOX_A,
      ])
      const retained = await readRetainedInboxDeclaration(OWNER, {
        evidenceRepository: inboxRepository(fixture.repository),
        now: () => NOW,
      })
      const readPlan = planInboxReadRelays({
        declaration: retained!,
        authenticatedPubkey: OWNER,
        localReadRelayUrls: [REMOVED],
        compatibilityRelayUrls: [REMOVED],
        requiredCompatibilityRelayUrls: [REMOVED],
      })
      expect(readPlan.relayUrls).toEqual([INBOX_A])
    })
  }

  it("starts ordinary inbox grace only after completed exact shared-set readback", async () => {
    const fixture = baseFixture({ inboxUrls: [INBOX_A] })
    let clock = NOW
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        now: () => clock,
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          const relayUrl = options.relayUrls[0]!
          return exactReadResult(
            relayUrl,
            event,
            relayUrl === PLAN[0] ? "observed" : "timed_out"
          )
        },
      }),
    })

    expect(fixture.repository.inbox?.current.observedAt).toBe(clock)
    expect(fixture.repository.inbox?.current.completeObservedAt).toBeUndefined()
    expect(fixture.repository.inbox?.cutoverRecovery).toMatchObject({
      relayUrls: [INBOX_A],
      readbackObservedAt: undefined,
      expiresAt: undefined,
    })
    let retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => clock,
    })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: retained!,
        rumorKind: 14,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })
    expect(
      planInboxReadRelays({
        declaration: retained!,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
        requiredCompatibilityRelayUrls: [],
      }).relayUrls
    ).toContain(INBOX_A)

    clock += 5_000
    await retryAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      dependencies: dependencies(fixture.repository, fixture.current, {
        now: () => clock,
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          const relayUrl = options.relayUrls[0]!
          expect(relayUrl).toBe(PLAN[1])
          return exactReadResult(relayUrl, event, "absent")
        },
      }),
    })
    const cutover = fixture.repository.inbox?.cutoverRecovery
    expect(fixture.repository.inbox?.current.observedAt).toBe(NOW)
    expect(fixture.repository.inbox?.current.completeObservedAt).toBe(clock)
    expect(cutover?.readbackObservedAt).toBe(clock)
    expect(cutover?.expiresAt).toBe(clock + cutover!.graceMs)

    const confirmedFetchedAt = clock
    clock = cutover!.expiresAt! + 1
    retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => clock,
    })
    expect(retained?.fetchedAt).toBe(confirmedFetchedAt)
    expect(retained?.cutoverRecoveryRelayUrls).toEqual([])
    expect(
      planInboxReadRelays({
        declaration: retained!,
        authenticatedPubkey: OWNER,
        compatibilityRelayUrls: [],
        requiredCompatibilityRelayUrls: [],
      }).relayUrls
    ).not.toContain(INBOX_A)
  })

  it("keeps coordinated pending state through a partial general shared-relay observation", async () => {
    const fixture = baseFixture({ inboxUrls: [INBOX_A] })
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const pendingEvent = fixture.repository.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!.signedEvent
    const partialAt = NOW + 1_000
    fixture.repository.inbox = applyInboxDeclarationEvidenceMerge(
      fixture.repository.inbox,
      {
        pubkey: OWNER,
        signedEvent: pendingEvent,
        sourceRelayUrls: [PLAN[0]],
        sharedSourceRelayUrls: [PLAN[0]],
        observedAt: partialAt,
        cachedAt: partialAt,
        lookup: {
          observedAt: partialAt,
          coverage: "partial",
          hadEvent: true,
          eventId: pendingEvent.id,
        },
      }
    )

    expect(fixture.repository.inbox.pendingDistribution).toBeDefined()
    expect(fixture.repository.inbox.cutoverRecovery).toMatchObject({
      readbackObservedAt: undefined,
      expiresAt: undefined,
    })
    let retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => partialAt,
    })
    expect(retained?.state).toBe("distribution_pending")
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: retained!,
        rumorKind: 14,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })

    const completeAt = partialAt + 1_000
    fixture.repository.inbox = applyInboxDeclarationEvidenceMerge(
      fixture.repository.inbox,
      {
        pubkey: OWNER,
        signedEvent: pendingEvent,
        sourceRelayUrls: [PLAN[0]],
        sharedSourceRelayUrls: [PLAN[0]],
        observedAt: completeAt,
        completeObservedAt: completeAt,
        cachedAt: completeAt,
        lookup: {
          observedAt: completeAt,
          coverage: "complete",
          hadEvent: true,
          eventId: pendingEvent.id,
        },
      }
    )

    expect(fixture.repository.inbox.pendingDistribution).toBeUndefined()
    expect(fixture.repository.inbox.cutoverRecovery).toMatchObject({
      readbackObservedAt: completeAt,
      expiresAt: completeAt + NETWORK_PREFERENCE_CUTOVER_GRACE_MS,
    })
    __resetInboxDeclarationCache()
    retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => completeAt,
    })
    expect(retained?.state).toBe("declared")
  })

  it("keeps legacy pending rows blocked but authorizes an atomic coordinator pending route", async () => {
    const standaloneEvent = signedEvent(10050, [["relay", INBOX_B]], 200)
    const standaloneRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const stagedStandalone = await stageInboxDeclarationDistribution(
      {
        pubkey: OWNER,
        signedEvent: standaloneEvent,
        publishRelayUrls: [...PLAN],
        expectedCurrentEventId: null,
        stagedAt: NOW,
      },
      standaloneRepository
    )
    expect(stagedStandalone.pendingDistribution).toBeDefined()
    const legacyPending = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: standaloneRepository,
      now: () => NOW,
    })
    expect(legacyPending?.state).toBe("distribution_pending")
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: legacyPending!,
        rumorKind: 14,
      }).route
    ).toBe("blocked")
    __resetInboxDeclarationCache()

    const fixture = baseFixture()
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    const coordinated = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => NOW,
    })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: coordinated!,
        rumorKind: 14,
      }).route
    ).toBe("declared_inbox")
    __resetInboxDeclarationCache()
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: coordinated!,
        rumorKind: 14,
      }).route
    ).toBe("blocked")
  })

  it("whole removal cuts off only the named URL immediately and after restart", async () => {
    const fixture = baseFixture({
      nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
      inboxUrls: [REMOVED],
    })
    setInboxMigrationRecoveryRelayUrls(OWNER, [REMOVED, INBOX_B])
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: { type: "remove_relay", relayUrl: REMOVED },
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current, {
        publishToRelay: async () => {
          expect(getInboxExplicitRemovalRelayUrls(OWNER)).toEqual([REMOVED])
          return "acked"
        },
        fetchEvents: async (filter, options) => {
          const event = fixture.repository.update!.checkpoints.find(
            (checkpoint) => checkpoint.signedEvent.id === filter.ids?.[0]
          )!.signedEvent
          return exactReadResult(options.relayUrls[0]!, event, "timed_out")
        },
      }),
    })
    let retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(fixture.repository),
      now: () => NOW,
    })
    let readPlan = planInboxReadRelays({
      declaration: retained!,
      authenticatedPubkey: OWNER,
      localReadRelayUrls: [REMOVED, PUBLIC_C],
      compatibilityRelayUrls: [REMOVED, INBOX_B],
      requiredCompatibilityRelayUrls: [REMOVED, INBOX_B],
    })
    expect(readPlan.relayUrls).not.toContain(REMOVED)
    expect(readPlan.relayUrls).toContain(INBOX_B)
    expect(readPlan.relayUrls).toContain(PUBLIC_C)
    const removalEventId = fixture.repository.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!.signedEvent.id
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "declared",
          relayUrls: [REMOVED, INBOX_B],
        },
        rumorKind: 14,
        validatedOrder: false,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "distribution_pending",
          eventId: removalEventId,
          pendingRelayUrls: [REMOVED, INBOX_B],
          pendingWriteAuthorized: true,
        },
        rumorKind: 14,
        validatedOrder: false,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_B] })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "not_observed",
          relayUrls: [],
        },
        rumorKind: 16,
        validatedOrder: true,
        compatibilityEnabled: true,
        compatibilityRelayUrls: [REMOVED, INBOX_B],
        recipientReadRelayUrls: [REMOVED, INBOX_B],
      })
    ).toMatchObject({ route: "compatibility_order", relayUrls: [INBOX_B] })
    expect(fixture.repository.update?.legacyRecoveryRemovedRelayUrls).toEqual([
      REMOVED,
    ])

    const restarted = fixture.repository.snapshot()
    __resetInboxDeclarationCache()
    setInboxMigrationRecoveryRelayUrls(OWNER, [REMOVED, INBOX_B])
    await resumeAccountNetworkPreferenceUpdate(OWNER, restarted, () => NOW + 1)
    retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(restarted),
      now: () => NOW + 1,
    })
    readPlan = planInboxReadRelays({
      declaration: retained!,
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
      requiredCompatibilityRelayUrls: [],
    })
    expect(readPlan.relayUrls).not.toContain(REMOVED)
    expect(readPlan.relayUrls).toContain(INBOX_B)
  })

  it("retains a completed whole-removal tombstone through a relay-list-only successor", async () => {
    const fixture = baseFixture({
      nip65Urls: [REMOVED, PUBLIC_A, PUBLIC_B],
      inboxUrls: [REMOVED],
    })
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: { type: "remove_relay", relayUrl: REMOVED },
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(fixture.current),
      dependencies: dependencies(fixture.repository, fixture.current),
    })
    const removedRelayList = fixture.repository.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10002
    )!.signedEvent
    const removedInbox = fixture.repository.update!.checkpoints.find(
      (checkpoint) => checkpoint.kind === 10050
    )!.signedEvent
    expect(removedInbox.tags).toEqual([])

    const successorCurrent = reconciliation({
      relayList: removedRelayList,
      inbox: removedInbox,
    })
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({
        nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        inboxUrls: [],
      }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(successorCurrent),
      dependencies: dependencies(fixture.repository, successorCurrent),
    })
    expect(
      fixture.repository.update?.checkpoints.map(
        (checkpoint) => checkpoint.kind
      )
    ).toEqual([10002])
    expect(fixture.repository.update?.legacyRecoveryRemovedRelayUrls).toEqual([
      REMOVED,
    ])

    const restarted = fixture.repository.snapshot()
    __resetInboxDeclarationCache()
    setInboxMigrationRecoveryRelayUrls(OWNER, [REMOVED, PUBLIC_B])
    await resumeAccountNetworkPreferenceUpdate(OWNER, restarted, () => NOW + 1)
    expect(getInboxExplicitRemovalRelayUrls(OWNER)).toEqual([REMOVED])
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([
      REMOVED,
      PUBLIC_B,
    ])
    const retained = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: inboxRepository(restarted),
      now: () => NOW + 1,
    })
    const readPlan = planInboxReadRelays({
      declaration: {
        ...retained!,
        state: "declared",
        relayUrls: [REMOVED, INBOX_A],
        retainedReadRelayUrls: [REMOVED, INBOX_B],
      },
      authenticatedPubkey: OWNER,
      localReadRelayUrls: [REMOVED, PUBLIC_C],
      compatibilityRelayUrls: [REMOVED, PLAN[1]],
      requiredCompatibilityRelayUrls: [REMOVED, PLAN[1]],
    })
    expect(readPlan.relayUrls).not.toContain(REMOVED)
    expect(readPlan.relayUrls).toEqual(
      expect.arrayContaining([INBOX_A, INBOX_B, PUBLIC_B, PUBLIC_C, PLAN[1]])
    )

    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "declared",
          relayUrls: [REMOVED, INBOX_A],
        },
        rumorKind: 14,
      })
    ).toMatchObject({ route: "declared_inbox", relayUrls: [INBOX_A] })
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "distribution_pending",
          eventId: removedInbox.id,
          pendingRelayUrls: [REMOVED, INBOX_A],
          pendingWriteAuthorized: true,
        },
        rumorKind: 14,
      }).relayUrls
    ).not.toContain(REMOVED)
    expect(
      selectPrivateMessageDeliveryRoute({
        declaration: {
          ...retained!,
          state: "not_observed",
          relayUrls: [],
        },
        rumorKind: 16,
        validatedOrder: true,
        compatibilityEnabled: true,
        compatibilityRelayUrls: [REMOVED, INBOX_B],
        recipientReadRelayUrls: [REMOVED, INBOX_B],
      })
    ).toMatchObject({ route: "compatibility_order", relayUrls: [INBOX_B] })
  })

  it("kind 10002 alone never ends legacy recovery; a staged usable kind 10050 does", async () => {
    const relayOnly = baseFixture()
    setInboxMigrationRecoveryRelayUrls(OWNER, [INBOX_A])
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(relayOnly.current),
      dependencies: dependencies(relayOnly.repository, relayOnly.current),
    })
    expect(relayOnly.repository.update?.legacyRecoveryDiscarded).toBe(false)
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([INBOX_A])

    const inboxChange = baseFixture()
    setInboxMigrationRecoveryRelayUrls(OWNER, [INBOX_A])
    await publishAccountNetworkPreferenceUpdate({
      pubkey: OWNER,
      action: setRolesAction({ inboxUrls: [INBOX_B] }),
      signer: signer(),
      reviewed: reviewAccountNetworkPreferences(inboxChange.current),
      dependencies: dependencies(inboxChange.repository, inboxChange.current),
    })
    expect(inboxChange.repository.update?.legacyRecoveryDiscarded).toBe(true)
    expect(getInboxMigrationRecoveryRelayUrls(OWNER)).toEqual([])
  })

  for (const [label, inboxUrls] of [
    [
      "more than three relays",
      [
        "wss://inbox-1.example",
        "wss://inbox-2.example",
        "wss://inbox-3.example",
        "wss://inbox-4.example",
      ],
    ],
    ["an insecure relay", ["ws://insecure.example"]],
  ] as const) {
    it(`rejects kind 10050 with ${label} before signing`, async () => {
      const fixture = baseFixture()
      const signedKinds: number[] = []
      await expect(
        publishAccountNetworkPreferenceUpdate({
          pubkey: OWNER,
          action: setRolesAction({ inboxUrls }),
          signer: signer({ signedKinds }),
          reviewed: reviewAccountNetworkPreferences(fixture.current),
          dependencies: dependencies(fixture.repository, fixture.current),
        })
      ).rejects.toMatchObject({ code: "invalid_preferences" })
      expect(signedKinds).toEqual([])
      expect(fixture.repository.stageCalls).toBe(0)
    })
  }

  it("serializes account mutations across a delayed signer", async () => {
    const fixture = baseFixture()
    let releaseSignature!: () => void
    let signalSignatureStarted!: () => void
    const signatureGate = new Promise<void>((resolve) => {
      releaseSignature = resolve
    })
    const signatureStarted = new Promise<void>((resolve) => {
      signalSignatureStarted = resolve
    })
    let reconcileCalls = 0
    const reconcile = async () => {
      reconcileCalls += 1
      return clone(fixture.current)
    }
    const delayedSigner: NostrEventSigner = {
      authMethod: "nip07",
      getPublicKey: async () => OWNER,
      signEvent: async (unsigned) => {
        signalSignatureStarted()
        await signatureGate
        return finalizeEvent(unsigned, OWNER_SECRET)
      },
    }
    const request = () =>
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        }),
        signer: delayedSigner,
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          reconcile,
        }),
      })
    const first = request()
    await signatureStarted
    const second = request()
    await Promise.resolve()
    await Promise.resolve()
    expect(reconcileCalls).toBe(1)
    releaseSignature()
    const firstResult = await first
    expect(fixture.repository.owner?.current?.signedEvent).toEqual(
      firstResult.update?.checkpoints[0]?.signedEvent
    )
    expect(fixture.repository.owner?.current?.sourceRelayUrls).toEqual(PLAN)
    await expect(second).rejects.toMatchObject({ code: "evidence_changed" })
    expect(reconcileCalls).toBe(2)
  })

  it("rechecks the session after the staging callback before durable mutation", async () => {
    const fixture = baseFixture()
    let currentSession = true
    let networkCalls = 0

    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        }),
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          shouldContinue: () => currentSession,
          onPhase: (phase) => {
            if (phase === "staging") currentSession = false
          },
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
        }),
      })
    ).rejects.toMatchObject({ code: "authority_changed" })

    expect(fixture.repository.stageCalls).toBe(0)
    expect(fixture.repository.update).toBeNull()
    expect(networkCalls).toBe(0)
  })

  it("retains an exact staged retry but applies no runtime or network work after the session changes", async () => {
    const fixture = baseFixture()
    let currentSession = true
    let networkCalls = 0
    const stage = fixture.repository.stage.bind(fixture.repository)
    fixture.repository.stage = async (input) => {
      const staged = await stage(input)
      currentSession = false
      return staged
    }

    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
        }),
        signer: signer(),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          shouldContinue: () => currentSession,
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
        }),
      })
    ).rejects.toMatchObject({ code: "authority_changed" })

    expect(fixture.repository.stageCalls).toBe(1)
    expect(fixture.repository.update?.checkpoints).toHaveLength(1)
    expect(
      fixture.repository.update?.checkpoints[0]?.relayOutcomes.every(
        (outcome) =>
          outcome.publishStatus === "pending" &&
          outcome.readbackStatus === "pending"
      )
    ).toBe(true)
    expect(
      getAccountRelaySettingsProjection(getAccountRelayScope(OWNER))
    ).toBeNull()
    expect(networkCalls).toBe(0)
  })

  it("session fencing after a signer delay stages nothing", async () => {
    const fixture = baseFixture()
    let currentSession = true
    let networkCalls = 0
    await expect(
      publishAccountNetworkPreferenceUpdate({
        pubkey: OWNER,
        action: setRolesAction({
          nip65Urls: [PUBLIC_A, PUBLIC_B, PUBLIC_C],
          inboxUrls: [INBOX_B],
        }),
        signer: signer({
          shouldContinueAfterSign: () => {
            currentSession = false
          },
        }),
        reviewed: reviewAccountNetworkPreferences(fixture.current),
        dependencies: dependencies(fixture.repository, fixture.current, {
          shouldContinue: () => currentSession,
          publishToRelay: async () => {
            networkCalls += 1
            return "acked"
          },
        }),
      })
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(fixture.repository.stageCalls).toBe(0)
    expect(networkCalls).toBe(0)
  })
})
