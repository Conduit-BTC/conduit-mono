import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools"
import {
  __resetOwnerRelayListEvidenceForTests,
  createInMemoryOwnerRelayListEvidenceRepository,
  readRetainedOwnerRelayList,
  reconcileOwnerRelayListEvidence,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import {
  __resetInboxDeclarationCache,
  primeInboxDeclarationEvidence,
  readRetainedInboxDeclarationEvidence,
} from "../packages/core/src/protocol/private-message-routing"
import {
  createInMemoryInboxDeclarationEvidenceRepository,
  mergeInboxDeclarationEvidence,
} from "../packages/core/src/protocol/inbox-declaration-evidence"
import { admitPublicEvent } from "../packages/core/src/protocol/verified-public-event"

const firstRelay = "wss://first.retained-evidence.test"
const nextRelay = "wss://next.retained-evidence.test"
const now = () => 30_000

async function signed(kind: number, createdAt: number, relays: string[]) {
  const wire = finalizeEvent(
    {
      kind,
      content: "",
      created_at: createdAt,
      tags: relays.map((r) => [kind === 10002 ? "r" : "relay", r]),
    },
    new Uint8Array(32).fill(23)
  )
  const admission = await admitPublicEvent(wire)
  if (admission.status !== "verified")
    throw new Error("Fixture admission failed")
  return admission.event
}

async function ownerFixture(createdAt: number, relays: string[]) {
  const event = await signed(10002, createdAt, relays)
  const repository = createInMemoryOwnerRelayListEvidenceRepository()
  const record = await repository.reconcile({
    pubkey: event.pubkey,
    observations: [
      { signedEvent: event, sourceRelayUrls: [firstRelay], observedAt: now() },
    ],
    lookup: {
      coverage: "complete",
      observedAt: now(),
      hadEvent: true,
      eventId: event.id,
    },
    cachedAt: now(),
  })
  return { event, repository, record }
}

async function inboxFixture(createdAt: number, relays: string[]) {
  const event = await signed(10050, createdAt, relays)
  const repository = createInMemoryInboxDeclarationEvidenceRepository([], now)
  const record = await mergeInboxDeclarationEvidence(
    {
      pubkey: event.pubkey,
      signedEvent: event,
      sourceRelayUrls: [firstRelay],
      sharedSourceRelayUrls: [firstRelay],
      observedAt: now(),
      cachedAt: now(),
    },
    repository
  )
  return { event, repository, record }
}

afterEach(() => {
  __resetOwnerRelayListEvidenceForTests()
  __resetInboxDeclarationCache()
})

describe("retained account evidence preserves durable and process authority", () => {
  it("keeps a newer durable signed-empty owner declaration authoritative", async () => {
    const older = await ownerFixture(10, [firstRelay])
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: older.event.pubkey,
        observations: [
          {
            signedEvent: older.event,
            sourceRelayUrls: [firstRelay],
            observedAt: now(),
          },
        ],
        lookup: {
          coverage: "complete",
          observedAt: now(),
          hadEvent: true,
          eventId: older.event.id,
        },
      },
      older.repository
    )
    const newer = await ownerFixture(11, [])
    const retained = await readRetainedOwnerRelayList(newer.event.pubkey, {
      durableOnly: true,
      evidenceRepository: newer.repository,
    })
    expect(retained?.current?.signedEvent.id).toBe(newer.event.id)
    expect(retained?.state).toBe("signed_empty")
    expect(retained?.preferences).toEqual([])
    expect(retained?.stale).toBe(true)
  })

  it("uses already admitted owner process evidence only for an unreadable durable source", async () => {
    const fixture = await ownerFixture(10, [firstRelay])
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: fixture.event.pubkey,
        observations: [
          {
            signedEvent: fixture.event,
            sourceRelayUrls: [firstRelay],
            observedAt: now(),
          },
        ],
        lookup: {
          coverage: "complete",
          observedAt: now(),
          hadEvent: true,
          eventId: fixture.event.id,
        },
      },
      fixture.repository
    )
    const retained = await readRetainedOwnerRelayList(fixture.event.pubkey, {
      durableOnly: true,
      durableEvidenceRepository: {
        get: async () => {
          throw new Error("storage unavailable")
        },
      },
    })
    expect(retained?.current?.signedEvent.id).toBe(fixture.event.id)
    expect(retained?.preferences.map((p) => p.url)).toEqual([firstRelay])
  })

  it("does not substitute process owner evidence for a readable malformed durable record", async () => {
    const fixture = await ownerFixture(10, [firstRelay])
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: fixture.event.pubkey,
        observations: [{ signedEvent: fixture.event, observedAt: now() }],
        lookup: {
          coverage: "complete",
          observedAt: now(),
          hadEvent: true,
          eventId: fixture.event.id,
        },
      },
      fixture.repository
    )
    await expect(
      readRetainedOwnerRelayList(fixture.event.pubkey, {
        durableOnly: true,
        durableEvidenceRepository: {
          get: async () => ({
            ...fixture.record,
            pubkey: "invalid" as typeof fixture.record.pubkey,
          }),
        },
      })
    ).rejects.toThrow()
  })

  it("fails closed when another process frontier is newer than readable durable inbox evidence", async () => {
    const older = await inboxFixture(10, [firstRelay])
    const newer = await inboxFixture(11, [nextRelay])
    primeInboxDeclarationEvidence(newer.record, now)
    const retained = await readRetainedInboxDeclarationEvidence(
      older.event.pubkey,
      {
        evidenceRepository: older.repository,
        now,
      }
    )
    expect(retained).toBeNull()
  })

  it("reads a newer durable inbox frontier without replacing it with older process state", async () => {
    const older = await inboxFixture(10, [firstRelay])
    const newer = await inboxFixture(11, [nextRelay])
    primeInboxDeclarationEvidence(older.record, now)
    const retained = await readRetainedInboxDeclarationEvidence(
      newer.event.pubkey,
      {
        evidenceRepository: newer.repository,
        now,
      }
    )
    expect(retained?.current.signedEvent.id).toBe(newer.event.id)
    expect(retained?.current.secureRelayUrls).toEqual([nextRelay])
  })

  it("retains validated inbox process evidence on storage failure but refuses malformed readable evidence", async () => {
    const fixture = await inboxFixture(10, [firstRelay])
    primeInboxDeclarationEvidence(fixture.record, now)
    const retained = await readRetainedInboxDeclarationEvidence(
      fixture.event.pubkey,
      {
        durableEvidenceRepository: {
          get: async () => {
            throw new Error("storage unavailable")
          },
        },
        now,
      }
    )
    expect(retained?.current.signedEvent.id).toBe(fixture.event.id)
    await expect(
      readRetainedInboxDeclarationEvidence(fixture.event.pubkey, {
        durableEvidenceRepository: {
          get: async () => ({
            ...fixture.record,
            current: {
              ...fixture.record.current,
              signedEvent: { ...fixture.event, content: "tampered" },
            },
          }),
        },
        now,
      })
    ).rejects.toThrow()
  })
})
