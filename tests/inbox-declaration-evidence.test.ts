import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  cloneInboxDeclarationEventEvidence,
  cloneInboxDeclarationEvidenceRecord,
  createInMemoryInboxDeclarationEvidenceRepository,
  getInboxDeclarationEvidence,
  mergeInboxDeclarationEvidence,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ACCOUNT_A_SECRET = new Uint8Array(32).fill(1)
const ACCOUNT_B_SECRET = new Uint8Array(32).fill(2)
const ACCOUNT_A = getPublicKey(ACCOUNT_A_SECRET)
const ACCOUNT_B = getPublicKey(ACCOUNT_B_SECRET)

function declarationEvent(input: {
  secret?: Uint8Array
  createdAt: number
  tags?: string[][]
  kind?: number
}): SignedPublicNostrEvent {
  const event = finalizeEvent(
    {
      kind: input.kind ?? 10050,
      created_at: input.createdAt,
      tags: input.tags ?? [["relay", "wss://inbox.example"]],
      content: "",
    },
    input.secret ?? ACCOUNT_A_SECRET
  )
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

describe("durable inbox declaration evidence", () => {
  it("rejects invalid signatures, kinds, and cross-account authors", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const valid = declarationEvent({ createdAt: 100 })
    const invalidSignature = { ...valid, sig: "0".repeat(128) }

    await expect(
      mergeInboxDeclarationEvidence(
        { pubkey: ACCOUNT_A, signedEvent: invalidSignature },
        repository
      )
    ).rejects.toThrow("valid signed event")

    await expect(
      mergeInboxDeclarationEvidence(
        {
          pubkey: ACCOUNT_A,
          signedEvent: declarationEvent({ createdAt: 101, kind: 10002 }),
        },
        repository
      )
    ).rejects.toThrow("kind-10050")

    await expect(
      mergeInboxDeclarationEvidence(
        {
          pubkey: ACCOUNT_A,
          signedEvent: declarationEvent({
            secret: ACCOUNT_B_SECRET,
            createdAt: 102,
          }),
        },
        repository
      )
    ).rejects.toThrow("author does not match")
  })

  it("retains the last usable declaration behind a newer signed empty event", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const declared = declarationEvent({
      createdAt: 100,
      tags: [
        ["relay", "wss://inbox-a.example/"],
        ["relay", "ws://insecure.example"],
      ],
    })
    const signedEmpty = declarationEvent({ createdAt: 101, tags: [] })

    await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A.toUpperCase(),
        signedEvent: declared,
        sourceRelayUrls: ["wss://source-a.example"],
        observedAt: 1_000,
        cachedAt: 1_001,
      },
      repository
    )
    const result = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent: signedEmpty,
        sourceRelayUrls: ["wss://source-b.example"],
        observedAt: 2_000,
        cachedAt: 2_001,
      },
      repository
    )

    expect(result.pubkey).toBe(ACCOUNT_A)
    expect(result.current.state).toBe("signed_empty")
    expect(result.current.signedEvent).toEqual(signedEmpty)
    expect(result.current.secureRelayUrls).toEqual([])
    expect(result.lastUsable?.state).toBe("declared")
    expect(result.lastUsable?.signedEvent).toEqual(declared)
    expect(result.lastUsable?.secureRelayUrls).toEqual([
      "wss://inbox-a.example",
    ])
  })

  it("retains the last usable declaration behind a newer malformed event", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const declared = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://inbox.example"]],
    })
    const malformed = declarationEvent({
      createdAt: 201,
      tags: [["relay", "ws://insecure.example"], ["relay"]],
    })

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: declared },
      repository
    )
    const result = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: malformed },
      repository
    )

    expect(result.current.state).toBe("malformed")
    expect(result.current.signedEvent).toEqual(malformed)
    expect(result.lastUsable?.signedEvent).toEqual(declared)
  })

  it("backfills the newest usable predecessor discovered after the current blocker", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const signedEmpty = declarationEvent({ createdAt: 303, tags: [] })
    const olderDeclared = declarationEvent({
      createdAt: 301,
      tags: [["relay", "wss://older.example"]],
    })
    const latestDeclaredPredecessor = declarationEvent({
      createdAt: 302,
      tags: [["relay", "wss://latest-predecessor.example"]],
    })

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: signedEmpty },
      repository
    )
    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: olderDeclared },
      repository
    )
    const result = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: latestDeclaredPredecessor },
      repository
    )

    expect(result.current.signedEvent.id).toBe(signedEmpty.id)
    expect(result.current.state).toBe("signed_empty")
    expect(result.lastUsable?.signedEvent.id).toBe(latestDeclaredPredecessor.id)
    expect(result.lastUsable?.secureRelayUrls).toEqual([
      "wss://latest-predecessor.example",
    ])
  })

  it("retains a usable lower-frontier declaration across an equal-time tie", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const blocker = declarationEvent({ createdAt: 350, tags: [] })
    const declared = Array.from({ length: 64 }, (_, index) =>
      declarationEvent({
        createdAt: 350,
        tags: [["relay", `wss://tie-${index}.example`]],
      })
    ).find((candidate) => candidate.id > blocker.id)
    expect(declared).toBeDefined()

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: blocker },
      repository
    )
    const result = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: declared! },
      repository
    )

    expect(result.current.signedEvent.id).toBe(blocker.id)
    expect(result.current.state).toBe("signed_empty")
    expect(result.lastUsable?.signedEvent.id).toBe(declared!.id)
    expect(result.lastUsable?.secureRelayUrls).toEqual([declared!.tags[0]![1]])
  })

  it("never regresses the NIP-01 replaceable frontier", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const newest = declarationEvent({
      createdAt: 301,
      tags: [["relay", "wss://newest.example"]],
    })
    const older = declarationEvent({
      createdAt: 300,
      tags: [["relay", "wss://older.example"]],
    })

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: newest },
      repository
    )
    const afterOlder = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: older },
      repository
    )
    expect(afterOlder.current.signedEvent.id).toBe(newest.id)

    const tied = [
      declarationEvent({
        createdAt: 302,
        tags: [["relay", "wss://tie-a.example"]],
      }),
      declarationEvent({
        createdAt: 302,
        tags: [["relay", "wss://tie-b.example"]],
      }),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const lowerId = tied[0]!
    const higherId = tied[1]!

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: higherId },
      repository
    )
    const afterLowerTie = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: lowerId },
      repository
    )
    expect(afterLowerTie.current.signedEvent.id).toBe(lowerId.id)

    const afterHigherTie = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: higherId },
      repository
    )
    expect(afterHigherTie.current.signedEvent.id).toBe(lowerId.id)
  })

  it("unions safe provenance and refreshes times for the same exact event", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const event = declarationEvent({ createdAt: 400 })

    await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent: event,
        sourceRelayUrls: ["wss://source-b.example/", "ws://unsafe.example"],
        observedAt: 4_000,
        cachedAt: 4_001,
      },
      repository
    )
    const result = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent: event,
        sourceRelayUrls: ["wss://source-a.example", "wss://source-b.example"],
        observedAt: 5_000,
        cachedAt: 5_001,
      },
      repository
    )

    expect(result.current.signedEvent).toEqual(event)
    expect(result.current.sourceRelayUrls).toEqual([
      "wss://source-a.example",
      "wss://source-b.example",
    ])
    expect(result.current.observedAt).toBe(5_000)
    expect(result.lastUsable?.sourceRelayUrls).toEqual(
      result.current.sourceRelayUrls
    )
    expect(result.cachedAt).toBe(5_001)
  })

  it("returns structured-clone-safe records across repository consumers", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const event = declarationEvent({ createdAt: 500 })
    const firstProcessResult = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: event },
      repository
    )

    firstProcessResult.current.secureRelayUrls.push("wss://mutation.example")
    firstProcessResult.current.signedEvent.tags.push([
      "relay",
      "wss://mutation.example",
    ])

    // A separate consumer reads a fresh structured clone from the repository.
    const restored = await getInboxDeclarationEvidence(ACCOUNT_A, repository)
    expect(restored?.current.signedEvent).toEqual(event)
    expect(restored?.current.secureRelayUrls).toEqual(["wss://inbox.example"])
  })

  it("preserves and isolates nested evidence fields as the schema evolves", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const event = declarationEvent({ createdAt: 501 })
    const record = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: event },
      repository
    )
    const evidenceWithExtension = {
      ...record.current,
      transportEvidence: {
        relayGroups: [["wss://inbox.example"]],
      },
    }
    const recordWithExtension = {
      ...record,
      current: evidenceWithExtension,
      transportEvidence: {
        relayGroups: [["wss://source.example"]],
      },
    }

    const evidenceClone = cloneInboxDeclarationEventEvidence(
      evidenceWithExtension
    )
    const recordClone = cloneInboxDeclarationEvidenceRecord(recordWithExtension)
    evidenceClone.transportEvidence.relayGroups[0]!.push(
      "wss://mutated.example"
    )
    recordClone.transportEvidence.relayGroups[0]!.push("wss://mutated.example")
    recordClone.current.signedEvent.tags[0]!.push("mutated")

    expect(evidenceWithExtension.transportEvidence.relayGroups).toEqual([
      ["wss://inbox.example"],
    ])
    expect(recordWithExtension.transportEvidence.relayGroups).toEqual([
      ["wss://source.example"],
    ])
    expect(recordWithExtension.current.signedEvent.tags).toEqual(event.tags)
  })

  it("isolates evidence by normalized account pubkey", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const accountAEvent = declarationEvent({ createdAt: 600 })
    const accountBEvent = declarationEvent({
      secret: ACCOUNT_B_SECRET,
      createdAt: 601,
      tags: [["relay", "wss://account-b.example"]],
    })

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: accountAEvent },
      repository
    )
    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_B, signedEvent: accountBEvent },
      repository
    )

    const accountA = await getInboxDeclarationEvidence(ACCOUNT_A, repository)
    const accountB = await getInboxDeclarationEvidence(ACCOUNT_B, repository)
    expect(accountA?.current.signedEvent.id).toBe(accountAEvent.id)
    expect(accountB?.current.signedEvent.id).toBe(accountBEvent.id)
    expect(accountA?.current.secureRelayUrls).not.toEqual(
      accountB?.current.secureRelayUrls
    )
  })
})
