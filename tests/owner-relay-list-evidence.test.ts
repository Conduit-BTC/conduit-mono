import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetOwnerRelayListEvidenceForTests,
  applyOwnerRelayListDistributionOutcomes,
  applyOwnerRelayListDistributionStage,
  applyOwnerRelayListEvidenceReconciliation,
  createInMemoryOwnerRelayListEvidenceRepository,
  getOwnerRelayListEvidence,
  reconcileOwnerRelayListEvidence,
  resolveOwnerRelayList,
  type NetworkPreferenceRelayOutcome,
  type OwnerRelayListEvidenceRepository,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = generateSecretKey()
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = getPublicKey(generateSecretKey())

function relayEvent(input: {
  createdAt: number
  tags?: string[][]
}): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: input.createdAt,
      tags: input.tags ?? [["r", "wss://relay.example"]],
      content: "",
    },
    OWNER_SECRET
  )
  return {
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  }
}

function lookup(input: {
  observedAt: number
  coverage?: "complete" | "partial" | "unavailable"
  event?: SignedPublicNostrEvent
}) {
  return {
    observedAt: input.observedAt,
    coverage: input.coverage ?? "complete",
    hadEvent: Boolean(input.event),
    eventId: input.event?.id,
  }
}

function pendingRelayOutcome(relayUrl: string): NetworkPreferenceRelayOutcome {
  return {
    relayUrl,
    publishStatus: "pending",
    publishAttemptCount: 0,
    readbackStatus: "pending",
    readbackAttemptCount: 0,
  }
}

let repository: OwnerRelayListEvidenceRepository

beforeEach(() => {
  __resetOwnerRelayListEvidenceForTests()
  repository = createInMemoryOwnerRelayListEvidenceRepository()
})

describe("owner kind-10002 evidence", () => {
  it("admits only the exact authenticated owner's selected ws lookup target", async () => {
    const ownerWsRelay = "ws://owner-selected.example"
    const remoteWsRelay = "ws://remote-derived.example"
    const secureRelay = "wss://relay.damus.io"
    const calls: Array<{
      relayUrls: string[]
      accountPubkey?: string | null
      authenticatedPubkey?: string | null
      ownerSelectedRelayUrls: string[]
    }> = []
    const fetchEventsWithDiagnostics = async (
      _filter: unknown,
      options: {
        relayUrls: string[]
        accountPubkey?: string | null
        authenticatedPubkey?: string | null
        ownerSelectedRelayUrls?: readonly string[]
      }
    ) => {
      calls.push({
        relayUrls: [...options.relayUrls],
        accountPubkey: options.accountPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
        ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
      })
      return {
        events: [] as never,
        attemptedRelayUrls: [...options.relayUrls],
        successfulRelayUrls: [...options.relayUrls],
        failedRelayUrls: [],
      }
    }

    await resolveOwnerRelayList(OWNER, {
      relayUrls: [remoteWsRelay, ownerWsRelay, secureRelay],
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: [ownerWsRelay],
      evidenceRepository: repository,
      fetchEventsWithDiagnostics: fetchEventsWithDiagnostics as never,
    })
    await resolveOwnerRelayList(OTHER, {
      relayUrls: [remoteWsRelay, ownerWsRelay, secureRelay],
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: [ownerWsRelay],
      evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      fetchEventsWithDiagnostics: fetchEventsWithDiagnostics as never,
    })

    expect(calls).toEqual([
      {
        relayUrls: [ownerWsRelay, secureRelay],
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        ownerSelectedRelayUrls: [ownerWsRelay],
      },
      {
        relayUrls: [secureRelay],
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        ownerSelectedRelayUrls: [],
      },
    ])
  })

  it("preserves a live authority failure from the final owner lookup seam", async () => {
    let authorityCurrent = true
    const shouldContinue = () => authorityCurrent
    const authorityError = new Error("authority changed")
    let fetchCalls = 0

    const lookup = resolveOwnerRelayList(OWNER, {
      relayUrls: ["ws://owner-selected.example"],
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: ["ws://owner-selected.example"],
      shouldContinue,
      evidenceRepository: repository,
      fetchEventsWithDiagnostics: (async (_filter, options) => {
        fetchCalls += 1
        expect(options.shouldContinue).toBe(shouldContinue)
        authorityCurrent = false
        expect(options.shouldContinue?.()).toBe(false)
        throw authorityError
      }) as never,
    })

    await expect(lookup).rejects.toBe(authorityError)
    expect(fetchCalls).toBe(1)
  })

  it("retains ws distribution only when the exact owner event selected it", () => {
    const ownerWs = "ws://owner-selected.example"
    const remoteWs = "ws://remote-derived.example"
    const signedEvent = relayEvent({
      createdAt: 100,
      tags: [["r", ownerWs, "write"]],
    })

    const staged = applyOwnerRelayListDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent,
      publishRelayUrls: [ownerWs, "wss://relay.damus.io"],
      relayOutcomes: [
        pendingRelayOutcome(ownerWs),
        pendingRelayOutcome("wss://relay.damus.io"),
      ],
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    expect(staged.pendingDistribution?.publishRelayUrls).toEqual([
      ownerWs,
      "wss://relay.damus.io",
    ])

    expect(() =>
      applyOwnerRelayListDistributionStage(undefined, {
        pubkey: OWNER,
        signedEvent,
        publishRelayUrls: [remoteWs],
        relayOutcomes: [pendingRelayOutcome(remoteWs)],
        expectedCurrentEventId: null,
        stagedAt: 1_000,
      })
    ).toThrow("requires publish targets")
  })

  it("keeps exact per-relay outcomes immutable while retrying only unresolved work", () => {
    const signedEvent = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://owner.example"]],
    })
    const exactSignedBytes = structuredClone(signedEvent)
    const relayOutcomes = [
      pendingRelayOutcome("wss://nos.lol"),
      pendingRelayOutcome("wss://relay.damus.io"),
    ]
    const staged = applyOwnerRelayListDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent,
      publishRelayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
      relayOutcomes,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    signedEvent.tags[0]![1] = "wss://caller-mutation.example"
    relayOutcomes[0]!.publishStatus = "rejected"
    expect(staged.pendingDistribution).toEqual({
      signedEvent: exactSignedBytes,
      publishRelayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
      relayOutcomes: [
        pendingRelayOutcome("wss://nos.lol"),
        pendingRelayOutcome("wss://relay.damus.io"),
      ],
      stagedAt: 1_000,
    })

    const firstAttempt = applyOwnerRelayListDistributionOutcomes(staged, {
      publish: [
        { relayUrl: "wss://relay.damus.io", status: "timed_out" },
        { relayUrl: "wss://nos.lol", status: "acked" },
      ],
      observedAt: 1_100,
    })
    expect(firstAttempt.current?.signedEvent).toEqual(exactSignedBytes)
    expect(firstAttempt.pendingDistribution).toEqual({
      signedEvent: exactSignedBytes,
      publishRelayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
      relayOutcomes: [
        {
          relayUrl: "wss://nos.lol",
          publishStatus: "acked",
          publishAttemptCount: 1,
          publishAttemptedAt: 1_100,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
        {
          relayUrl: "wss://relay.damus.io",
          publishStatus: "timed_out",
          publishAttemptCount: 1,
          publishAttemptedAt: 1_100,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
      ],
      stagedAt: 1_000,
    })
    expect(staged.pendingDistribution?.relayOutcomes).toEqual([
      pendingRelayOutcome("wss://nos.lol"),
      pendingRelayOutcome("wss://relay.damus.io"),
    ])

    const retried = applyOwnerRelayListDistributionOutcomes(firstAttempt, {
      publish: [
        { relayUrl: "wss://nos.lol", status: "rejected" },
        { relayUrl: "wss://relay.damus.io", status: "acked" },
      ],
      observedAt: 1_200,
    })
    expect(retried.current?.signedEvent).toEqual(exactSignedBytes)
    expect(retried.pendingDistribution?.signedEvent).toEqual(exactSignedBytes)
    expect(retried.pendingDistribution?.publishRelayUrls).toEqual(
      staged.pendingDistribution?.publishRelayUrls
    )
    expect(retried.pendingDistribution?.stagedAt).toBe(1_000)
    expect(retried.pendingDistribution?.relayOutcomes).toEqual([
      {
        relayUrl: "wss://nos.lol",
        publishStatus: "acked",
        publishAttemptCount: 1,
        publishAttemptedAt: 1_100,
        readbackStatus: "pending",
        readbackAttemptCount: 0,
      },
      {
        relayUrl: "wss://relay.damus.io",
        publishStatus: "acked",
        publishAttemptCount: 2,
        publishAttemptedAt: 1_200,
        readbackStatus: "pending",
        readbackAttemptCount: 0,
      },
    ])
  })

  it("clears exact pending bytes after shared-target readback", () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const exactSignedBytes = structuredClone(signedEvent)
    const staged = applyOwnerRelayListDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent,
      publishRelayUrls: ["wss://relay.primal.net"],
      relayOutcomes: [pendingRelayOutcome("wss://relay.primal.net")],
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    const confirmed = applyOwnerRelayListDistributionOutcomes(staged, {
      readback: [
        {
          relayUrl: "wss://relay.primal.net",
          status: "observed",
        },
      ],
      observedAt: 2_000,
    })

    expect(confirmed.current?.signedEvent).toEqual(exactSignedBytes)
    expect(confirmed.pendingDistribution).toBeUndefined()
  })

  it("retains exact pending bytes when durable evidence is reloaded after restart", async () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const staged = applyOwnerRelayListDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent,
      publishRelayUrls: ["wss://relay.primal.net"],
      relayOutcomes: [pendingRelayOutcome("wss://relay.primal.net")],
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    repository = createInMemoryOwnerRelayListEvidenceRepository([staged])
    __resetOwnerRelayListEvidenceForTests()

    const retained = await getOwnerRelayListEvidence(OWNER, repository)

    expect(retained?.pendingDistribution).toEqual(staged.pendingDistribution)
    expect(retained?.current?.signedEvent).toEqual(structuredClone(signedEvent))
  })

  it("lets stronger same-kind evidence supersede pending distribution", () => {
    const pending = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://pending.example"]],
    })
    const stronger = relayEvent({
      createdAt: 101,
      tags: [["r", "wss://stronger.example"]],
    })
    const exactStrongerBytes = structuredClone(stronger)
    const staged = applyOwnerRelayListDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent: pending,
      publishRelayUrls: ["wss://relay.primal.net"],
      relayOutcomes: [pendingRelayOutcome("wss://relay.primal.net")],
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    const superseded = applyOwnerRelayListEvidenceReconciliation(staged, {
      pubkey: OWNER,
      observations: [
        {
          signedEvent: stronger,
          sourceRelayUrls: ["wss://relay.primal.net"],
          observedAt: 2_000,
        },
      ],
      lookup: lookup({ observedAt: 2_000, event: stronger }),
    })

    expect(superseded.current?.signedEvent).toEqual(exactStrongerBytes)
    expect(superseded.pendingDistribution).toBeUndefined()
  })

  it("retains exact signed bytes and applies the NIP-01 frontier tie-break", async () => {
    const first = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://z.example"]],
    })
    const second = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://a.example"]],
    })
    const winner = first.id < second.id ? first : second

    await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [
          {
            signedEvent: first,
            sourceRelayUrls: ["wss://source-b.example"],
            observedAt: 1_000,
          },
          {
            signedEvent: second,
            sourceRelayUrls: ["wss://source-a.example"],
            observedAt: 1_000,
            completeObservedAt: 1_000,
          },
        ],
        lookup: lookup({ observedAt: 1_000, event: winner }),
      },
      repository
    )

    const retained = await getOwnerRelayListEvidence(OWNER, repository)
    expect(retained?.current?.signedEvent).toMatchObject({
      id: winner.id,
      pubkey: winner.pubkey,
      created_at: winner.created_at,
      kind: winner.kind,
      tags: winner.tags,
      content: winner.content,
      sig: winner.sig,
    })
    expect(retained?.current?.signedEvent.sig).toBe(winner.sig)

    const older = relayEvent({
      createdAt: 99,
      tags: [["r", "wss://older.example"]],
    })
    const afterOlderRead = await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [{ signedEvent: older, observedAt: 2_000 }],
        lookup: lookup({
          observedAt: 2_000,
          coverage: "partial",
          event: older,
        }),
      },
      repository
    )
    expect(afterOlderRead.current?.signedEvent).toMatchObject({
      id: winner.id,
      sig: winner.sig,
      tags: winner.tags,
    })
    expect(afterOlderRead.latestLookup).toMatchObject({
      coverage: "partial",
      eventId: older.id,
    })

    const newer = relayEvent({
      createdAt: 101,
      tags: [["r", "wss://newer.example"]],
    })
    const afterNewerRead = await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [
          {
            signedEvent: newer,
            observedAt: 3_000,
            completeObservedAt: 3_000,
          },
        ],
        lookup: lookup({ observedAt: 3_000, event: newer }),
      },
      repository
    )
    expect(afterNewerRead.current?.signedEvent.id).toBe(newer.id)
    expect(afterNewerRead.current?.preferences[0]?.url).toBe(
      "wss://newer.example"
    )
  })

  it("classifies signed-empty, malformed, duplicate, and invalid relay tags", () => {
    const empty = relayEvent({ createdAt: 1, tags: [] })
    const emptyRecord = applyOwnerRelayListEvidenceReconciliation(undefined, {
      pubkey: OWNER,
      observations: [{ signedEvent: empty, observedAt: 1 }],
      lookup: lookup({ observedAt: 1, event: empty }),
    })
    expect(emptyRecord.current?.state).toBe("signed_empty")

    const malformed = relayEvent({
      createdAt: 2,
      tags: [
        ["r", "not a relay"],
        ["r", "wss://relay.example", "sideways"],
      ],
    })
    const malformedRecord = applyOwnerRelayListEvidenceReconciliation(
      undefined,
      {
        pubkey: OWNER,
        observations: [{ signedEvent: malformed, observedAt: 2 }],
        lookup: lookup({ observedAt: 2, event: malformed }),
      }
    )
    expect(malformedRecord.current).toMatchObject({
      state: "malformed",
      invalidRelayTagCount: 2,
      duplicateRelayTagCount: 0,
      preferences: [],
    })

    const mixed = relayEvent({
      createdAt: 3,
      tags: [
        ["r", "wss://Relay.Example/", "read"],
        ["r", "wss://relay.example", "write"],
        ["r", "not a relay"],
      ],
    })
    const mixedRecord = applyOwnerRelayListEvidenceReconciliation(undefined, {
      pubkey: OWNER,
      observations: [{ signedEvent: mixed, observedAt: 3 }],
      lookup: lookup({ observedAt: 3, event: mixed }),
    })
    expect(mixedRecord.current).toMatchObject({
      state: "declared",
      invalidRelayTagCount: 1,
      duplicateRelayTagCount: 1,
      preferences: [
        {
          url: "wss://relay.example",
          readEnabled: true,
          writeEnabled: true,
        },
      ],
    })
  })

  it("retains the last usable declaration across a newer malformed frontier and restart", async () => {
    const declared = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://usable.example"]],
    })
    const malformed = relayEvent({
      createdAt: 101,
      tags: [["r", "not a relay"]],
    })
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [{ signedEvent: declared, observedAt: 1_000 }],
        lookup: lookup({ observedAt: 1_000, event: declared }),
      },
      repository
    )
    const replaced = await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [{ signedEvent: malformed, observedAt: 2_000 }],
        lookup: lookup({ observedAt: 2_000, event: malformed }),
      },
      repository
    )

    expect(replaced.current?.signedEvent.id).toBe(malformed.id)
    expect(replaced.current?.state).toBe("malformed")
    expect(replaced.lastUsable?.signedEvent.id).toBe(declared.id)
    expect(replaced.lastUsable?.preferences).toEqual([
      {
        url: "wss://usable.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ])

    __resetOwnerRelayListEvidenceForTests()
    const afterRestart = await resolveOwnerRelayList(OWNER, {
      relayUrls: ["wss://discovery.example"],
      evidenceRepository: repository,
      now: () => 3_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://discovery.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://discovery.example"],
      }),
    })

    expect(afterRestart.state).toBe("malformed")
    expect(afterRestart.current?.signedEvent.id).toBe(malformed.id)
    expect(afterRestart.lastUsable?.signedEvent.id).toBe(declared.id)
    expect(afterRestart.preferences).toEqual([
      {
        url: "wss://usable.example",
        readEnabled: true,
        writeEnabled: true,
      },
    ])
    expect(afterRestart.stale).toBe(true)
  })

  it("does not resurrect relays cleared by signed-empty when a newer event is malformed", async () => {
    const declared = relayEvent({
      createdAt: 100,
      tags: [["r", "wss://cleared.example"]],
    })
    const signedEmpty = relayEvent({ createdAt: 101, tags: [] })
    const malformed = relayEvent({
      createdAt: 102,
      tags: [["r", "not a relay"]],
    })

    for (const [index, event] of [declared, signedEmpty, malformed].entries()) {
      await reconcileOwnerRelayListEvidence(
        {
          pubkey: OWNER,
          observations: [{ signedEvent: event, observedAt: 1_000 + index }],
          lookup: lookup({ observedAt: 1_000 + index, event }),
        },
        repository
      )
    }

    const retained = await getOwnerRelayListEvidence(OWNER, repository)
    expect(retained?.current?.signedEvent.id).toBe(malformed.id)
    expect(retained?.current?.state).toBe("malformed")
    expect(retained?.lastUsable?.signedEvent.id).toBe(signedEmpty.id)
    expect(retained?.lastUsable?.state).toBe("signed_empty")
    expect(retained?.lastUsable?.preferences).toEqual([])

    __resetOwnerRelayListEvidenceForTests()
    const afterRestart = await resolveOwnerRelayList(OWNER, {
      relayUrls: ["wss://discovery.example"],
      evidenceRepository: repository,
      now: () => 3_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: ["wss://discovery.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://discovery.example"],
      }),
    })

    expect(afterRestart.state).toBe("malformed")
    expect(afterRestart.lastUsable?.signedEvent.id).toBe(signedEmpty.id)
    expect(afterRestart.preferences).toEqual([])
    expect(afterRestart.stale).toBe(true)
  })

  it("distinguishes complete absence, partial lookup, and unavailable lookup", async () => {
    const relays = ["wss://nos.lol", "wss://relay.ditto.pub"]
    const complete = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 1_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    expect(complete.state).toBe("not_observed")
    expect(complete.lookup.coverage).toBe("complete")

    repository = createInMemoryOwnerRelayListEvidenceRepository()
    __resetOwnerRelayListEvidenceForTests()
    const partial = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 2_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: [relays[0]!],
        failedRelayUrls: [relays[1]!],
      }),
    })
    expect(partial.state).toBe("lookup_partial")
    expect(partial.lookup.coverage).toBe("partial")

    repository = createInMemoryOwnerRelayListEvidenceRepository()
    __resetOwnerRelayListEvidenceForTests()
    const unavailable = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 3_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: [],
        failedRelayUrls: relays,
      }),
    })
    expect(unavailable.state).toBe("lookup_unavailable")
    expect(unavailable.lookup.coverage).toBe("unavailable")
  })

  it("ignores invalid forged candidates without downgrading complete coverage", async () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const relays = ["wss://nos.lol", "wss://relay.ditto.pub"]
    const current = signedEvent as never
    attachEventSourceRelayUrl(current, relays[0]!)
    await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 1_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [current],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    const forged = {
      ...signedEvent,
      id: "f".repeat(64),
      sig: "0".repeat(128),
    } as never

    const confirmed = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 2_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [current, forged],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    expect(confirmed.current?.signedEvent.id).toBe(signedEvent.id)
    expect(confirmed.current?.completeObservedAt).toBe(2_000)
    expect(confirmed.lookup).toMatchObject({
      coverage: "complete",
      hadEvent: true,
      eventId: signedEvent.id,
    })
    expect(confirmed.stale).toBe(false)

    __resetOwnerRelayListEvidenceForTests()
    repository = createInMemoryOwnerRelayListEvidenceRepository()
    const forgedOnly = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 3_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [forged],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    expect(forgedOnly.state).toBe("not_observed")
    expect(forgedOnly.lookup).toMatchObject({
      coverage: "complete",
      hadEvent: false,
    })
    expect(forgedOnly.current).toBeUndefined()
  })

  it("retains readable durable evidence when reconciliation writes fail after restart", async () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const relays = ["wss://nos.lol", "wss://relay.ditto.pub"]
    await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 1_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [signedEvent as never],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    __resetOwnerRelayListEvidenceForTests()
    const readableRepository = repository
    const writeFailingRepository: OwnerRelayListEvidenceRepository = {
      get: async (pubkey) => await readableRepository.get(pubkey),
      reconcile: async () => {
        throw new Error("transaction unavailable")
      },
    }

    const degraded = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: writeFailingRepository,
      now: () => 2_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: [],
        failedRelayUrls: relays,
      }),
    })
    expect(degraded.state).toBe("declared")
    expect(degraded.current?.signedEvent).toMatchObject({
      id: signedEvent.id,
      sig: signedEvent.sig,
      tags: signedEvent.tags,
    })
    expect(degraded.lookup.coverage).toBe("unavailable")
    expect(degraded.stale).toBe(true)
  })

  it("does not let malformed readable durable data become a fallback frontier", async () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const relays = ["wss://nos.lol"]
    const malformedRecord = {
      pubkey: OWNER,
      current: {
        state: "declared",
        signedEvent: { ...signedEvent, sig: "0".repeat(128) },
        preferences: [
          {
            url: "wss://relay.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ],
        sourceRelayUrls: relays,
        observedAt: 1_000,
        completeObservedAt: 1_000,
        invalidRelayTagCount: 0,
        duplicateRelayTagCount: 0,
      },
      latestLookup: lookup({ observedAt: 1_000, event: signedEvent }),
      cachedAt: 1_000,
    }
    const writeFailingRepository: OwnerRelayListEvidenceRepository = {
      get: async () => malformedRecord as never,
      reconcile: async () => {
        throw new Error("transaction unavailable")
      },
    }

    const degraded = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: writeFailingRepository,
      now: () => 2_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: [],
        failedRelayUrls: relays,
      }),
    })
    expect(degraded.state).toBe("lookup_unavailable")
    expect(degraded.current).toBeUndefined()
  })

  it("keeps stronger retained evidence through a later partial omission", async () => {
    const signedEvent = relayEvent({ createdAt: 100 })
    const eventWithSource = signedEvent as never
    attachEventSourceRelayUrl(eventWithSource, "wss://nos.lol")
    const relays = ["wss://nos.lol", "wss://relay.ditto.pub"]
    const fresh = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 1_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [eventWithSource],
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
      }),
    })
    expect(fresh.state).toBe("declared")
    expect(fresh.stale).toBe(false)
    expect(fresh.current?.sourceRelayUrls).toEqual(["wss://nos.lol"])

    const partial = await resolveOwnerRelayList(OWNER, {
      relayUrls: relays,
      evidenceRepository: repository,
      now: () => 2_000,
      fetchEventsWithDiagnostics: async () => ({
        events: [],
        attemptedRelayUrls: relays,
        successfulRelayUrls: [relays[0]!],
        failedRelayUrls: [relays[1]!],
      }),
    })
    expect(partial.state).toBe("declared")
    expect(partial.stale).toBe(true)
    expect(partial.current?.signedEvent).toMatchObject({
      id: signedEvent.id,
      sig: signedEvent.sig,
      tags: signedEvent.tags,
    })
    expect(partial.lookup).toMatchObject({
      coverage: "partial",
      hadEvent: false,
    })
  })
})
