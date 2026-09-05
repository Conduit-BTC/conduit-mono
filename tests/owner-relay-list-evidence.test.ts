import { createHash } from "node:crypto"

import { beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetOwnerRelayListEvidenceForTests,
  applyOwnerRelayListEvidenceReconciliation,
  createInMemoryOwnerRelayListEvidenceRepository,
  getOwnerRelayListEvidence,
  reconcileOwnerRelayListEvidence,
  resolveOwnerRelayList,
  type OwnerRelayListEvidenceRepository,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const OWNER_SECRET = new Uint8Array(
  createHash("sha256")
    .update("conduit-owner-relay-list-evidence-fixture", "utf8")
    .digest()
)
const OWNER = getPublicKey(OWNER_SECRET)

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

let repository: OwnerRelayListEvidenceRepository

beforeEach(() => {
  __resetOwnerRelayListEvidenceForTests()
  repository = createInMemoryOwnerRelayListEvidenceRepository()
})

describe("owner kind-10002 evidence", () => {
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
