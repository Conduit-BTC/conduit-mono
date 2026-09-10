import { describe, expect, it } from "bun:test"
import { schnorr } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  applyInboxDeclarationCutoverExclusions,
  applyInboxDeclarationCutoverRecoveryReadback,
  applyInboxDeclarationDistributionOutcomes,
  applyInboxDeclarationDistributionRestage,
  applyInboxDeclarationDistributionStage,
  applyInboxDeclarationEvidenceMerge,
  cloneInboxDeclarationEventEvidence,
  cloneInboxDeclarationEvidenceRecord,
  createInMemoryInboxDeclarationEvidenceRepository,
  getInboxDeclarationEvidence,
  getActiveInboxCutoverRecoveryRelayUrls,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
  mergeInboxDeclarationEvidence,
  recordInboxDeclarationCutoverRecoveryReadback,
  stageInboxDeclarationDistribution,
  type NetworkPreferenceRelayOutcome,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import { readRetainedInboxDeclaration } from "@conduit/core/protocol/private-message-routing"
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

function pendingRelayOutcome(relayUrl: string): NetworkPreferenceRelayOutcome {
  return {
    relayUrl,
    publishStatus: "pending",
    publishAttemptCount: 0,
    readbackStatus: "pending",
    readbackAttemptCount: 0,
  }
}

describe("durable inbox declaration evidence", () => {
  it("keeps exact per-relay outcomes immutable while retrying only unresolved work", () => {
    const signedEvent = declarationEvent({ createdAt: 100 })
    const exactSignedBytes = structuredClone(signedEvent)
    const relayOutcomes = [
      pendingRelayOutcome("wss://relay.damus.io"),
      pendingRelayOutcome("wss://nos.lol"),
    ]
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent,
      publishRelayUrls: ["wss://relay.damus.io", "wss://nos.lol"],
      relayOutcomes,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    signedEvent.tags[0]![1] = "wss://caller-mutation.example"
    relayOutcomes[0]!.publishStatus = "rejected"
    expect(staged.pendingDistribution).toEqual({
      signedEvent: exactSignedBytes,
      publishRelayUrls: ["wss://relay.damus.io", "wss://nos.lol"],
      relayOutcomes: [
        pendingRelayOutcome("wss://relay.damus.io"),
        pendingRelayOutcome("wss://nos.lol"),
      ],
      stagedAt: 1_000,
    })

    const firstAttempt = applyInboxDeclarationDistributionOutcomes(staged, {
      publish: [
        { relayUrl: "wss://nos.lol", status: "timed_out" },
        { relayUrl: "wss://relay.damus.io", status: "acked" },
      ],
      observedAt: 1_100,
    })
    expect(firstAttempt.current.signedEvent).toEqual(exactSignedBytes)
    expect(firstAttempt.pendingDistribution).toEqual({
      signedEvent: exactSignedBytes,
      publishRelayUrls: ["wss://relay.damus.io", "wss://nos.lol"],
      relayOutcomes: [
        {
          relayUrl: "wss://relay.damus.io",
          publishStatus: "acked",
          publishAttemptCount: 1,
          publishAttemptedAt: 1_100,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
        {
          relayUrl: "wss://nos.lol",
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
      pendingRelayOutcome("wss://relay.damus.io"),
      pendingRelayOutcome("wss://nos.lol"),
    ])

    const retried = applyInboxDeclarationDistributionOutcomes(firstAttempt, {
      publish: [
        { relayUrl: "wss://relay.damus.io", status: "rejected" },
        { relayUrl: "wss://nos.lol", status: "acked" },
      ],
      observedAt: 1_200,
    })
    expect(retried.current.signedEvent).toEqual(exactSignedBytes)
    expect(retried.pendingDistribution?.signedEvent).toEqual(exactSignedBytes)
    expect(retried.pendingDistribution?.publishRelayUrls).toEqual(
      staged.pendingDistribution?.publishRelayUrls
    )
    expect(retried.pendingDistribution?.stagedAt).toBe(1_000)
    expect(retried.pendingDistribution?.relayOutcomes).toEqual([
      {
        relayUrl: "wss://relay.damus.io",
        publishStatus: "acked",
        publishAttemptCount: 1,
        publishAttemptedAt: 1_100,
        readbackStatus: "pending",
        readbackAttemptCount: 0,
      },
      {
        relayUrl: "wss://nos.lol",
        publishStatus: "acked",
        publishAttemptCount: 2,
        publishAttemptedAt: 1_200,
        readbackStatus: "pending",
        readbackAttemptCount: 0,
      },
    ])
  })

  it("starts the seven-day cutover only when exact shared-set readback completes", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://relay.ditto.pub"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://relay.damus.io", "wss://nos.lol"],
      relayOutcomes: [
        pendingRelayOutcome("wss://relay.damus.io"),
        pendingRelayOutcome("wss://nos.lol"),
      ],
      previousRelayUrls: ["wss://relay.primal.net", "wss://relay.ditto.pub"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    expect(staged.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: replacement.id,
        relayUrls: ["wss://relay.primal.net"],
        replacementEventSig: replacement.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
            stagedAt: 1_000,
          },
        ],
      },
    ])
    expect(Object.hasOwn(staged.cutoverRecoveries![0]!, "graceMs")).toBe(false)

    const partiallyReadBack = applyInboxDeclarationDistributionOutcomes(
      staged,
      {
        readback: [{ relayUrl: "wss://relay.damus.io", status: "observed" }],
        observedAt: 2_000,
      }
    )
    expect(partiallyReadBack.pendingDistribution?.relayOutcomes).toEqual([
      {
        relayUrl: "wss://relay.damus.io",
        publishStatus: "pending",
        publishAttemptCount: 0,
        readbackStatus: "observed",
        readbackAttemptCount: 1,
        readbackAttemptedAt: 2_000,
        observedAt: 2_000,
      },
      pendingRelayOutcome("wss://nos.lol"),
    ])
    expect(partiallyReadBack.cutoverRecoveries).toEqual([
      {
        ...staged.cutoverRecoveries![0]!,
        confirmationAttempts: [
          {
            relayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
            completedRelayUrls: ["wss://relay.damus.io"],
            observedRelayUrls: ["wss://relay.damus.io"],
            stagedAt: 1_000,
          },
        ],
      },
    ])

    const nonRegressed = applyInboxDeclarationDistributionOutcomes(
      partiallyReadBack,
      {
        readback: [{ relayUrl: "wss://relay.damus.io", status: "absent" }],
        observedAt: 2_500,
      }
    )
    expect(nonRegressed.pendingDistribution?.relayOutcomes?.[0]).toEqual(
      partiallyReadBack.pendingDistribution?.relayOutcomes?.[0]
    )
    expect(nonRegressed.cutoverRecoveries).toEqual(
      partiallyReadBack.cutoverRecoveries
    )

    const confirmed = applyInboxDeclarationDistributionOutcomes(nonRegressed, {
      readback: [{ relayUrl: "wss://nos.lol", status: "absent" }],
      observedAt: 3_000,
    })
    expect(confirmed.current.signedEvent).toEqual(replacement)
    expect(confirmed.pendingDistribution).toBeUndefined()
    expect(confirmed.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: replacement.id,
        relayUrls: ["wss://relay.primal.net"],
        replacementEventSig: replacement.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
            completedRelayUrls: ["wss://nos.lol", "wss://relay.damus.io"],
            observedRelayUrls: ["wss://relay.damus.io"],
            stagedAt: 1_000,
          },
        ],
        readbackObservedAt: 3_000,
        expiresAt: 3_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ])
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        confirmed,
        3_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS - 1
      )
    ).toEqual(["wss://relay.primal.net"])
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        confirmed,
        3_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS
      )
    ).toEqual([])

    const excluded = applyInboxDeclarationCutoverExclusions(confirmed, [
      "wss://relay.primal.net/",
    ])
    expect(excluded.cutoverRecoveries).toEqual([
      {
        ...confirmed.cutoverRecoveries![0]!,
        policyBlockedRelayUrls: ["wss://relay.primal.net"],
      },
    ])
    expect(getActiveInboxCutoverRecoveryRelayUrls(excluded, 3_001)).toEqual([])
  })

  it("lets stronger same-kind evidence supersede pending authority without erasing recovery", () => {
    const pending = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://relay.ditto.pub"]],
    })
    const stronger = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://relay.primal.net"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: pending,
      publishRelayUrls: ["wss://nos.lol"],
      relayOutcomes: [pendingRelayOutcome("wss://nos.lol")],
      previousRelayUrls: ["wss://relay.damus.io"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    const superseded = applyInboxDeclarationEvidenceMerge(staged, {
      pubkey: ACCOUNT_A,
      signedEvent: stronger,
      sourceRelayUrls: ["wss://nos.lol"],
      sharedSourceRelayUrls: ["wss://nos.lol"],
      observedAt: 2_000,
    })

    expect(superseded.current.signedEvent).toEqual(stronger)
    expect(superseded.pendingDistribution).toBeUndefined()
    expect(superseded.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: pending.id,
        relayUrls: ["wss://relay.damus.io"],
        replacementEventSig: pending.sig,
        confirmationAttempts: [
          { relayUrls: ["wss://nos.lol"], stagedAt: 1_000 },
        ],
      },
    ])
    expect(
      superseded.cutoverRecoveries?.some(
        (recovery) => recovery.replacementEventId === stronger.id
      )
    ).toBe(false)
    expect(getActiveInboxCutoverRecoveryRelayUrls(superseded, 2_000)).toEqual([
      "wss://relay.damus.io",
    ])
  })

  it("preserves immutable confirmation evidence when whole removal policy-blocks a target", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://replacement.example"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
      relayOutcomes: [
        pendingRelayOutcome("wss://shared-a.example"),
        pendingRelayOutcome("wss://shared-b.example"),
      ],
      previousRelayUrls: ["wss://previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const partiallyReadBack = applyInboxDeclarationDistributionOutcomes(
      staged,
      {
        readback: [{ relayUrl: "wss://shared-a.example", status: "observed" }],
        observedAt: 2_000,
      }
    )

    const excluded = applyInboxDeclarationCutoverExclusions(
      partiallyReadBack,
      ["wss://shared-b.example"],
      3_000
    )

    expect(excluded.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: replacement.id,
        relayUrls: ["wss://previous.example"],
        replacementEventSig: replacement.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
            completedRelayUrls: ["wss://shared-a.example"],
            observedRelayUrls: ["wss://shared-a.example"],
            stagedAt: 1_000,
          },
        ],
        policyBlockedRelayUrls: ["wss://shared-b.example"],
      },
    ])
    expect(excluded.pendingDistribution?.publishRelayUrls).toEqual([
      "wss://shared-a.example",
      "wss://shared-b.example",
    ])
  })

  it("retains a previous inbox as blocked history when removal is committed with its replacement", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://replacement.example"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://shared.example"],
      confirmationRelayUrls: ["wss://shared.example"],
      previousRelayUrls: ["wss://removed-previous.example"],
      excludedRelayUrls: ["wss://removed-previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    expect(staged.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: replacement.id,
        relayUrls: ["wss://removed-previous.example"],
        replacementEventSig: replacement.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://shared.example"],
            stagedAt: 1_000,
          },
        ],
        policyBlockedRelayUrls: ["wss://removed-previous.example"],
      },
    ])
    expect(getActiveInboxCutoverRecoveryRelayUrls(staged, 1_000)).toEqual([])
  })

  it("confirms a locally planned recovery batch after its pending authority is superseded", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://relay.ditto.pub"]],
    })
    const stronger = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://relay.primal.net"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
      relayOutcomes: [
        pendingRelayOutcome("wss://shared-a.example"),
        pendingRelayOutcome("wss://shared-b.example"),
      ],
      previousRelayUrls: ["wss://previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const superseded = applyInboxDeclarationEvidenceMerge(staged, {
      pubkey: ACCOUNT_A,
      signedEvent: stronger,
      sourceRelayUrls: ["wss://shared-a.example"],
      sharedSourceRelayUrls: ["wss://shared-a.example"],
      observedAt: 2_000,
    })

    const partial = applyInboxDeclarationCutoverRecoveryReadback(superseded, {
      replacementEventId: replacement.id,
      replacementEventSig: replacement.sig,
      readback: [{ relayUrl: "wss://shared-a.example", status: "observed" }],
      observedAt: 3_000,
    })
    expect(partial.current.signedEvent).toEqual(stronger)
    expect(partial.pendingDistribution).toBeUndefined()
    expect(
      partial.cutoverRecoveries?.[0]?.confirmationAttempts?.[0]
    ).toMatchObject({
      completedRelayUrls: ["wss://shared-a.example"],
      observedRelayUrls: ["wss://shared-a.example"],
    })
    expect(partial.cutoverRecoveries?.[0]?.readbackObservedAt).toBeUndefined()

    const confirmed = applyInboxDeclarationCutoverRecoveryReadback(partial, {
      replacementEventId: replacement.id,
      replacementEventSig: replacement.sig,
      readback: [{ relayUrl: "wss://shared-b.example", status: "absent" }],
      observedAt: 4_000,
    })
    expect(confirmed.current.signedEvent).toEqual(stronger)
    expect(confirmed.cutoverRecoveries?.[0]).toMatchObject({
      confirmationAttempts: [
        {
          completedRelayUrls: [
            "wss://shared-a.example",
            "wss://shared-b.example",
          ],
          observedRelayUrls: ["wss://shared-a.example"],
        },
      ],
      readbackObservedAt: 4_000,
      expiresAt: 4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
  })

  it("uses a fresh immutable same-event attempt without completing a policy-blocked plan", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://replacement.example"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: [
        "wss://old-shared-a.example",
        "wss://old-shared-b.example",
      ],
      relayOutcomes: [
        pendingRelayOutcome("wss://old-shared-a.example"),
        pendingRelayOutcome("wss://old-shared-b.example"),
      ],
      previousRelayUrls: ["wss://previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const partiallyReadBack = applyInboxDeclarationDistributionOutcomes(
      staged,
      {
        readback: [
          { relayUrl: "wss://old-shared-a.example", status: "observed" },
        ],
        observedAt: 2_000,
      }
    )
    const policyBlocked = applyInboxDeclarationCutoverExclusions(
      partiallyReadBack,
      ["wss://old-shared-b.example"],
      2_500
    )
    expect(
      policyBlocked.cutoverRecoveries?.[0]?.readbackObservedAt
    ).toBeUndefined()

    const restaged = applyInboxDeclarationDistributionRestage(policyBlocked, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      expectedPublishRelayUrls: [
        "wss://old-shared-a.example",
        "wss://old-shared-b.example",
      ],
      publishRelayUrls: [
        "wss://new-shared-a.example",
        "wss://new-shared-b.example",
      ],
      stagedAt: 3_000,
    })
    expect(restaged.cutoverRecoveries?.[0]).toMatchObject({
      policyBlockedRelayUrls: ["wss://old-shared-b.example"],
      confirmationAttempts: [
        {
          relayUrls: [
            "wss://old-shared-a.example",
            "wss://old-shared-b.example",
          ],
          completedRelayUrls: ["wss://old-shared-a.example"],
          observedRelayUrls: ["wss://old-shared-a.example"],
          stagedAt: 1_000,
        },
        {
          relayUrls: [
            "wss://new-shared-a.example",
            "wss://new-shared-b.example",
          ],
          stagedAt: 3_000,
        },
      ],
    })

    const confirmed = applyInboxDeclarationDistributionOutcomes(restaged, {
      readback: [
        { relayUrl: "wss://new-shared-a.example", status: "observed" },
        { relayUrl: "wss://new-shared-b.example", status: "absent" },
      ],
      observedAt: 4_000,
    })
    expect(confirmed.cutoverRecoveries?.[0]).toMatchObject({
      readbackObservedAt: 4_000,
      expiresAt: 4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
    const later = applyInboxDeclarationCutoverRecoveryReadback(confirmed, {
      replacementEventId: replacement.id,
      replacementEventSig: replacement.sig,
      readback: [
        { relayUrl: "wss://new-shared-a.example", status: "observed" },
      ],
      observedAt: 5_000,
    })
    expect(later.cutoverRecoveries?.[0]?.readbackObservedAt).toBe(4_000)
    expect(later.cutoverRecoveries?.[0]?.expiresAt).toBe(
      4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS
    )
  })

  it("does not let repository readback mint an external recovery batch", async () => {
    const replacement = declarationEvent({ createdAt: 200 })
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent: replacement,
        sourceRelayUrls: ["wss://shared.example"],
        sharedSourceRelayUrls: ["wss://shared.example"],
        observedAt: 1_000,
      },
      repository
    )

    await expect(
      recordInboxDeclarationCutoverRecoveryReadback(
        {
          pubkey: ACCOUNT_A,
          replacementEventId: replacement.id,
          replacementEventSig: replacement.sig,
          readback: [{ relayUrl: "wss://shared.example", status: "observed" }],
          observedAt: 2_000,
        },
        repository
      )
    ).rejects.toThrow("locally planned replacement")
    expect((await repository.get(ACCOUNT_A))?.cutoverRecoveries).toBeUndefined()
  })

  it("keeps sequential cutover windows independent with distinct deadlines", () => {
    const first = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://relay.ditto.pub"]],
    })
    const second = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://relay.primal.net"]],
    })
    const firstStaged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: first,
      publishRelayUrls: ["wss://nos.lol"],
      relayOutcomes: [pendingRelayOutcome("wss://nos.lol")],
      previousRelayUrls: ["wss://relay.damus.io"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const firstConfirmed = applyInboxDeclarationDistributionOutcomes(
      firstStaged,
      {
        readback: [{ relayUrl: "wss://nos.lol", status: "observed" }],
        observedAt: 2_000,
      }
    )
    const secondStaged = applyInboxDeclarationDistributionStage(
      firstConfirmed,
      {
        pubkey: ACCOUNT_A,
        signedEvent: second,
        publishRelayUrls: ["wss://nos.lol"],
        relayOutcomes: [pendingRelayOutcome("wss://nos.lol")],
        previousRelayUrls: ["wss://relay.ditto.pub"],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: first.id,
        stagedAt: 3_000,
      }
    )

    expect(secondStaged.cutoverRecoveries).toHaveLength(2)
    expect(
      secondStaged.cutoverRecoveries?.find(
        (recovery) => recovery.replacementEventId === first.id
      )
    ).toMatchObject({
      relayUrls: ["wss://relay.damus.io"],
      readbackObservedAt: 2_000,
      expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
    expect(
      secondStaged.cutoverRecoveries?.find(
        (recovery) => recovery.replacementEventId === second.id
      )
    ).toEqual({
      policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      replacementEventId: second.id,
      relayUrls: ["wss://relay.ditto.pub"],
      replacementEventSig: second.sig,
      confirmationAttempts: [{ relayUrls: ["wss://nos.lol"], stagedAt: 3_000 }],
    })

    const secondConfirmed = applyInboxDeclarationDistributionOutcomes(
      secondStaged,
      {
        readback: [{ relayUrl: "wss://nos.lol", status: "observed" }],
        observedAt: 4_000,
      }
    )
    expect(
      secondConfirmed.cutoverRecoveries?.find(
        (recovery) => recovery.replacementEventId === first.id
      )
    ).toMatchObject({
      readbackObservedAt: 2_000,
      expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
    expect(
      secondConfirmed.cutoverRecoveries?.find(
        (recovery) => recovery.replacementEventId === second.id
      )
    ).toMatchObject({
      readbackObservedAt: 4_000,
      expiresAt: 4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    })
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        secondConfirmed,
        2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS - 1
      ).sort()
    ).toEqual(["wss://relay.damus.io", "wss://relay.ditto.pub"].sort())
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        secondConfirmed,
        2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS
      )
    ).toEqual(["wss://relay.ditto.pub"])
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        secondConfirmed,
        4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS
      )
    ).toEqual([])
  })

  it("preserves an unexpired cutover when a stronger external event wins", () => {
    const replacement = declarationEvent({
      createdAt: 200,
      tags: [["relay", "wss://relay.ditto.pub"]],
    })
    const stronger = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://relay.primal.net"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://nos.lol"],
      relayOutcomes: [pendingRelayOutcome("wss://nos.lol")],
      previousRelayUrls: ["wss://relay.damus.io"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const confirmed = applyInboxDeclarationDistributionOutcomes(staged, {
      readback: [{ relayUrl: "wss://nos.lol", status: "observed" }],
      observedAt: 2_000,
    })

    const superseded = applyInboxDeclarationEvidenceMerge(confirmed, {
      pubkey: ACCOUNT_A,
      signedEvent: stronger,
      sourceRelayUrls: ["wss://nos.lol"],
      sharedSourceRelayUrls: ["wss://nos.lol"],
      observedAt: 3_000,
    })

    expect(superseded.current.signedEvent).toEqual(stronger)
    expect(superseded.cutoverRecoveries).toEqual(confirmed.cutoverRecoveries)
    expect(
      superseded.cutoverRecoveries?.some(
        (recovery) => recovery.replacementEventId === stronger.id
      )
    ).toBe(false)
  })

  it("up-converts a legacy singleton without changing its recovery clock", async () => {
    const replacement = declarationEvent({ createdAt: 200 })
    const canonical = applyInboxDeclarationDistributionOutcomes(
      applyInboxDeclarationDistributionStage(undefined, {
        pubkey: ACCOUNT_A,
        signedEvent: replacement,
        publishRelayUrls: ["wss://nos.lol"],
        relayOutcomes: [pendingRelayOutcome("wss://nos.lol")],
        previousRelayUrls: ["wss://previous.example"],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
        expectedCurrentEventId: null,
        stagedAt: 1_000,
      }),
      {
        readback: [{ relayUrl: "wss://nos.lol", status: "observed" }],
        observedAt: 2_000,
      }
    )
    const legacy = structuredClone(canonical)
    legacy.cutoverRecovery = {
      policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      replacementEventId: replacement.id,
      relayUrls: ["wss://previous.example"],
      replacementEventSig: replacement.sig,
      confirmationRelayUrls: ["wss://nos.lol"],
      completedRelayUrls: ["wss://nos.lol"],
      observedRelayUrls: ["wss://nos.lol"],
      readbackObservedAt: 2_000,
      expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
    }
    delete legacy.cutoverRecoveries
    const repository = createInMemoryInboxDeclarationEvidenceRepository([
      legacy,
    ])

    const migrated = await getInboxDeclarationEvidence(ACCOUNT_A, repository)

    expect(migrated?.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: replacement.id,
        relayUrls: ["wss://previous.example"],
        replacementEventSig: replacement.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://nos.lol"],
            completedRelayUrls: ["wss://nos.lol"],
            observedRelayUrls: ["wss://nos.lol"],
          },
        ],
        readbackObservedAt: 2_000,
        expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ])
    expect(Object.hasOwn(migrated!, "cutoverRecovery")).toBe(false)
    expect((await repository.get(ACCOUNT_A))?.cutoverRecoveries).toEqual(
      migrated?.cutoverRecoveries
    )
  })

  it("deduplicates overlapping reads and filters whole removals from every batch", () => {
    const first = declarationEvent({ createdAt: 200 })
    const current = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://current.example"]],
    })
    const evidence = applyInboxDeclarationEvidenceMerge(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: current,
      sourceRelayUrls: ["wss://nos.lol"],
      sharedSourceRelayUrls: ["wss://nos.lol"],
      observedAt: 1_000,
    })
    evidence.cutoverRecoveries = [
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: first.id,
        relayUrls: ["wss://shared.example", "wss://first-only.example"],
        readbackObservedAt: 2_000,
        expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: current.id,
        relayUrls: ["wss://shared.example", "wss://second-only.example"],
        readbackObservedAt: 4_000,
        expiresAt: 4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ]

    expect(
      getActiveInboxCutoverRecoveryRelayUrls(evidence, 4_500).sort()
    ).toEqual(
      [
        "wss://first-only.example",
        "wss://second-only.example",
        "wss://shared.example",
      ].sort()
    )
    expect(
      getActiveInboxCutoverRecoveryRelayUrls(
        evidence,
        2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS
      ).sort()
    ).toEqual(["wss://second-only.example", "wss://shared.example"].sort())

    const filtered = applyInboxDeclarationCutoverExclusions(
      evidence,
      ["wss://shared.example/", "wss://first-only.example"],
      5_000
    )
    expect(filtered.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: first.id,
        relayUrls: ["wss://first-only.example", "wss://shared.example"],
        policyBlockedRelayUrls: [
          "wss://first-only.example",
          "wss://shared.example",
        ],
        readbackObservedAt: 2_000,
        expiresAt: 2_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: current.id,
        relayUrls: ["wss://second-only.example", "wss://shared.example"],
        policyBlockedRelayUrls: ["wss://shared.example"],
        readbackObservedAt: 4_000,
        expiresAt: 4_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ])
    const fullyBlocked = applyInboxDeclarationCutoverExclusions(
      filtered,
      ["wss://second-only.example"],
      6_000
    )
    expect(fullyBlocked.cutoverRecoveries).toHaveLength(2)
    expect(fullyBlocked.cutoverRecoveries?.[1]).toMatchObject({
      relayUrls: ["wss://second-only.example", "wss://shared.example"],
      policyBlockedRelayUrls: [
        "wss://second-only.example",
        "wss://shared.example",
      ],
    })
    expect(getActiveInboxCutoverRecoveryRelayUrls(fullyBlocked, 6_000)).toEqual(
      []
    )
  })

  it("projects recovery-only relays separately from reintroduced current inboxes", async () => {
    const current = declarationEvent({
      createdAt: 201,
      tags: [["relay", "wss://reintroduced.example"]],
    })
    const evidence = applyInboxDeclarationEvidenceMerge(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: current,
      sourceRelayUrls: ["wss://nos.lol"],
      sharedSourceRelayUrls: ["wss://nos.lol"],
      observedAt: 1_000,
      completeObservedAt: 1_000,
    })
    evidence.cutoverRecoveries = [
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: declarationEvent({ createdAt: 200 }).id,
        relayUrls: [
          "wss://reintroduced.example",
          "wss://recovery-only.example",
        ],
        readbackObservedAt: 500,
        expiresAt: 500 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ]
    const repository = createInMemoryInboxDeclarationEvidenceRepository([
      evidence,
    ])

    const resolution = await readRetainedInboxDeclaration(ACCOUNT_A, {
      evidenceRepository: repository,
      now: () => 1_500,
    })

    expect(resolution?.relayUrls).toEqual(["wss://reintroduced.example"])
    expect(resolution?.cutoverRecoveryRelayUrls).toEqual([
      "wss://recovery-only.example",
    ])
  })

  it("keeps staged bytes and cutover pending until exact shared-set confirmation", async () => {
    const repository = createInMemoryInboxDeclarationEvidenceRepository()
    const signedEvent = declarationEvent({ createdAt: 100 })

    const staged = await stageInboxDeclarationDistribution(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        publishRelayUrls: ["wss://shared-b.example", "wss://shared-a.example"],
        previousRelayUrls: ["wss://previous.example"],
        cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
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
      confirmationRelayUrls: [
        "wss://shared-a.example",
        "wss://shared-b.example",
      ],
      stagedAt: 1_000,
    })

    const partiallyObserved = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        sourceRelayUrls: ["wss://shared-a.example"],
        sharedSourceRelayUrls: ["wss://shared-a.example"],
        observedAt: 2_000,
        lookup: {
          observedAt: 2_000,
          coverage: "partial",
          hadEvent: true,
          eventId: signedEvent.id,
        },
      },
      repository
    )

    expect(partiallyObserved.pendingDistribution).toBeDefined()
    expect(partiallyObserved.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: signedEvent.id,
        relayUrls: ["wss://previous.example"],
        replacementEventSig: signedEvent.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
            completedRelayUrls: ["wss://shared-a.example"],
            observedRelayUrls: ["wss://shared-a.example"],
            stagedAt: 1_000,
          },
        ],
      },
    ])

    const confirmed = await mergeInboxDeclarationEvidence(
      {
        pubkey: ACCOUNT_A,
        signedEvent,
        sourceRelayUrls: ["wss://shared-b.example", "wss://shared-a.example"],
        sharedSourceRelayUrls: [
          "wss://shared-b.example",
          "wss://shared-a.example",
        ],
        observedAt: 3_000,
        completeObservedAt: 3_000,
        lookup: {
          observedAt: 3_000,
          coverage: "complete",
          hadEvent: true,
          eventId: signedEvent.id,
        },
      },
      repository
    )

    expect(confirmed.pendingDistribution).toBeUndefined()
    expect(confirmed.current.sharedSourceRelayUrls).toEqual([
      "wss://shared-a.example",
      "wss://shared-b.example",
    ])
    expect(confirmed.lastUsable?.signedEvent).toEqual(signedEvent)
    expect(confirmed.cutoverRecoveries).toEqual([
      {
        policyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
        replacementEventId: signedEvent.id,
        relayUrls: ["wss://previous.example"],
        replacementEventSig: signedEvent.sig,
        confirmationAttempts: [
          {
            relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
            completedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            observedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            stagedAt: 1_000,
          },
        ],
        readbackObservedAt: 3_000,
        expiresAt: 3_000 + INBOX_DECLARATION_CUTOVER_GRACE_MS,
      },
    ])
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

    const stagedCutover = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: stagedEvent,
      publishRelayUrls: ["wss://shared-a.example"],
      relayOutcomes: [pendingRelayOutcome("wss://shared-a.example")],
      previousRelayUrls: ["wss://previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const alternateObserved = applyInboxDeclarationEvidenceMerge(
      stagedCutover,
      {
        pubkey: ACCOUNT_A,
        signedEvent: processEvent,
        sourceRelayUrls: ["wss://shared-a.example"],
        sharedSourceRelayUrls: ["wss://shared-a.example"],
        observedAt: 2_000,
        completeObservedAt: 2_000,
      }
    )
    expect(alternateObserved.pendingDistribution?.signedEvent).toEqual(
      stagedEvent
    )
    expect(
      alternateObserved.cutoverRecoveries?.[0]?.confirmationAttempts?.[0]
        ?.completedRelayUrls
    ).toBeUndefined()
    expect(
      alternateObserved.cutoverRecoveries?.[0]?.readbackObservedAt
    ).toBeUndefined()
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
      createInMemoryInboxDeclarationEvidenceRepository([mutatedBytes]).get(
        ACCOUNT_A
      )
    ).rejects.toThrow("must match its signed frontier")

    const mutatedTargets = cloneInboxDeclarationEvidenceRecord(staged)
    mutatedTargets.pendingDistribution!.publishRelayUrls = [
      "wss://shared-a.example",
      "wss://shared-a.example",
    ]
    await expect(
      createInMemoryInboxDeclarationEvidenceRepository([mutatedTargets]).get(
        ACCOUNT_A
      )
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
      "ws://insecure.example",
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
      tags: [["relay", "ftp://not-a-relay.example"], ["relay"]],
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

  it("retains owner-selected ws targets as evidence without treating them as shared confirmation", () => {
    const replacement = declarationEvent({
      createdAt: 250,
      tags: [["relay", "ws://owner-inbox.example"]],
    })
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: ACCOUNT_A,
      signedEvent: replacement,
      publishRelayUrls: ["wss://shared.example", "ws://owner-publish.example"],
      confirmationRelayUrls: ["wss://shared.example"],
      relayOutcomes: [
        pendingRelayOutcome("wss://shared.example"),
        pendingRelayOutcome("ws://owner-publish.example"),
      ],
      previousRelayUrls: ["ws://owner-previous.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })

    expect(staged.current).toMatchObject({
      state: "declared",
      secureRelayUrls: ["ws://owner-inbox.example"],
    })
    expect(staged.pendingDistribution).toMatchObject({
      publishRelayUrls: ["wss://shared.example", "ws://owner-publish.example"],
      confirmationRelayUrls: ["wss://shared.example"],
    })
    expect(staged.cutoverRecoveries).toEqual([
      expect.objectContaining({
        relayUrls: ["ws://owner-previous.example"],
        confirmationAttempts: [
          expect.objectContaining({ relayUrls: ["wss://shared.example"] }),
        ],
      }),
    ])
    expect(getActiveInboxCutoverRecoveryRelayUrls(staged, 1_000)).toEqual([
      "ws://owner-previous.example",
    ])

    const removed = applyInboxDeclarationCutoverExclusions(
      staged,
      ["ws://owner-previous.example"],
      1_100
    )
    expect(getActiveInboxCutoverRecoveryRelayUrls(removed, 1_100)).toEqual([])
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
      "ws://unsafe.example",
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
