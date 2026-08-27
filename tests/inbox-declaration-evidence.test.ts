import { describe, expect, it } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  applyInboxDeclarationEvidenceMerge,
  cloneInboxDeclarationEventEvidence,
  cloneInboxDeclarationEvidenceRecord,
  createInMemoryInboxDeclarationEvidenceRepository,
  getInboxDeclarationEvidence,
  mergeInboxDeclarationEvidence,
  stageInboxDeclarationDistribution,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import { readRetainedInboxDeclarationEvidence } from "@conduit/core/protocol/private-message-routing"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ACCOUNT_A_SECRET = new Uint8Array(32).fill(1)
const ACCOUNT_B_SECRET = new Uint8Array(32).fill(2)
const ACCOUNT_A = getPublicKey(ACCOUNT_A_SECRET)
const ACCOUNT_B = getPublicKey(ACCOUNT_B_SECRET)

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
  )
}

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
  it("keeps staged bytes pending until exact shared-source confirmation", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const signedEvent = declarationEvent({ createdAt: 100 })

    const staged = await stageInboxDeclarationDistribution(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        publishRelayUrls: ["wss://shared-b.example", "wss://shared-a.example"],
        expectedCurrentEventId: null,
        stagedAt: 1_000,
      },
      repository
    )

    expect(staged.current.signedEvent).toEqual(signedEvent)
    expect(staged.lastUsable).toBeUndefined()
    expect(staged.pendingDistribution).toEqual({
      signedEvent,
      publishRelayUrls: ["wss://shared-b.example", "wss://shared-a.example"],
      stagedAt: 1_000,
    })

    const confirmed = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        sourceRelayUrls: ["wss://shared-a.example"],
        sharedSourceRelayUrls: ["wss://shared-a.example"],
        observedAt: 2_000,
      },
      repository
    )

    expect(confirmed.pendingDistribution).toBeUndefined()
    expect(confirmed.current.sharedSourceRelayUrls).toEqual([
      "wss://shared-a.example",
    ])
    expect(confirmed.lastUsable?.signedEvent).toEqual(signedEvent)
  })

  it("rejects a same-id stage with different signed bytes or targets", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const first = declarationEvent({ createdAt: 100 })
    const second = {
      ...first,
      sig: bytesToHex(
        schnorr.sign(
          hexToBytes(first.id),
          ACCOUNT_A_SECRET,
          new Uint8Array(32).fill(9)
        )
      ),
    }
    expect(second.id).toBe(first.id)
    expect(second.sig).not.toBe(first.sig)

    await stageInboxDeclarationDistribution(
      {
        pubkey: ACCOUNT_A,
        signedEvent: first,
        publishRelayUrls: ["wss://shared-a.example"],
        expectedCurrentEventId: null,
      },
      repository
    )
    await expect(
      stageInboxDeclarationDistribution(
        {
          pubkey: ACCOUNT_A,
          signedEvent: second,
          publishRelayUrls: ["wss://shared-b.example"],
          expectedCurrentEventId: first.id,
        },
        repository
      )
    ).rejects.toMatchObject({ code: "staged_event_lost_frontier" })

    const retained = await getInboxDeclarationEvidence(ACCOUNT_A, repository)
    expect(retained?.pendingDistribution?.signedEvent).toEqual(first)
    expect(retained?.pendingDistribution?.publishRelayUrls).toEqual([
      "wss://shared-a.example",
    ])
  })

  it("keeps staged bytes canonical when same-id evidence has another valid signature", () => {
    const stagedEvent = declarationEvent({ createdAt: 100 })
    const processEvent = {
      ...stagedEvent,
      sig: bytesToHex(
        schnorr.sign(
          hexToBytes(stagedEvent.id),
          ACCOUNT_A_SECRET,
          new Uint8Array(32).fill(8)
        )
      ),
    }
    expect(processEvent.id).toBe(stagedEvent.id)
    expect(processEvent.sig).not.toBe(stagedEvent.sig)

    const processRecord = applyInboxDeclarationEvidenceMerge(
      undefined,
      {
        pubkey: ACCOUNT_A,
        signedEvent: processEvent,
        observedAt: 2_000,
      },
      () => 2_000
    )
    const merged = applyInboxDeclarationEvidenceMerge(
      processRecord,
      {
        pubkey: ACCOUNT_A,
        signedEvent: stagedEvent,
        pendingDistribution: {
          signedEvent: stagedEvent,
          publishRelayUrls: ["wss://shared-a.example"],
          stagedAt: 1_000,
        },
        observedAt: 1_000,
      },
      () => 2_000
    )

    expect(merged.current.signedEvent).toEqual(stagedEvent)
    expect(merged.pendingDistribution?.signedEvent).toEqual(stagedEvent)
  })

  it("rejects mutated retained pending bytes and target plans", async () => {
    const seed = createInMemoryInboxDeclarationEvidenceRepository()
    const signedEvent = declarationEvent({ createdAt: 100 })
    const staged = await stageInboxDeclarationDistribution(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        publishRelayUrls: ["wss://shared-a.example"],
        expectedCurrentEventId: null,
      },
      seed
    )
    const alternateSignature = bytesToHex(
      schnorr.sign(
        hexToBytes(signedEvent.id),
        ACCOUNT_A_SECRET,
        new Uint8Array(32).fill(7)
      )
    )
    expect(alternateSignature).not.toBe(signedEvent.sig)

    const mutatedBytes = cloneInboxDeclarationEvidenceRecord(staged)
    mutatedBytes.pendingDistribution!.signedEvent.sig = alternateSignature
    await expect(
      readRetainedInboxDeclarationEvidence(ACCOUNT_A, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          mutatedBytes,
        ]),
      })
    ).rejects.toThrow("must match its signed frontier")

    const mutatedTargets = cloneInboxDeclarationEvidenceRecord(staged)
    mutatedTargets.pendingDistribution!.publishRelayUrls = [
      "wss://shared-a.example",
      "wss://shared-a.example",
    ]
    await expect(
      readRetainedInboxDeclarationEvidence(ACCOUNT_A, {
        evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository([
          mutatedTargets,
        ]),
      })
    ).rejects.toThrow("canonical and ordered")
  })

  it("retains an older usable route behind a newer pending declaration", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const pending = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://new-inbox.example"]],
    })
    const prior = declarationEvent({
      createdAt: 100,
      tags: [["relay", "wss://prior-inbox.example"]],
    })

    await stageInboxDeclarationDistribution(
      {
        pubkey: ACCOUNT_A,
        signedEvent: pending,
        publishRelayUrls: ["wss://shared.example"],
        expectedCurrentEventId: null,
      },
      repository
    )
    const merged = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent: prior,
        sourceRelayUrls: ["wss://shared.example"],
        sharedSourceRelayUrls: ["wss://shared.example"],
      },
      repository
    )

    expect(merged.current.signedEvent.id).toBe(pending.id)
    expect(merged.pendingDistribution?.signedEvent.id).toBe(pending.id)
    expect(merged.lastUsable?.signedEvent.id).toBe(prior.id)
  })

  it("retains exactly one prior usable route across declared rotations", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const first = declarationEvent({
      createdAt: 100,
      tags: [["relay", "wss://inbox-one.example"]],
    })
    const second = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://inbox-two.example"]],
    })
    const third = declarationEvent({
      createdAt: 300,
      tags: [["relay", "wss://inbox-three.example"]],
    })

    await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: first },
      repository
    )
    const afterSecond = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: second },
      repository
    )
    expect(afterSecond.current.signedEvent.id).toBe(second.id)
    expect(afterSecond.lastUsable?.signedEvent.id).toBe(first.id)

    const afterThird = await mergeInboxDeclarationEvidence(
      { pubkey: ACCOUNT_A, signedEvent: third },
      repository
    )
    expect(afterThird.current.signedEvent.id).toBe(third.id)
    expect(afterThird.lastUsable?.signedEvent.id).toBe(second.id)
    expect(afterThird.lastUsable?.secureRelayUrls).toEqual([
      "wss://inbox-two.example",
    ])
  })

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
