import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  readEventMarketAuthorization,
  resolveEventMarketAuthorization,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  admitPublicEvent,
  type VerifiedNostrEvent,
} from "@conduit/core/protocol/verified-public-event"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair`

function transition(
  state: "active" | "revoked",
  sequence: number,
  parents: SignedPublicNostrEvent[] = [],
  createdAt = sequence + 100
): SignedPublicNostrEvent {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state,
    sequence,
    parentIds: parents.map((event) => event.id),
  })
  return finalizeEvent({ ...draft, created_at: createdAt }, organizerSecret)
}
function resolution(
  transitions: SignedPublicNostrEvent[],
  deletions: SignedPublicNostrEvent[] = []
) {
  return resolveEventMarketAuthorization({
    marketCoordinate,
    merchantPubkey: merchant,
    transitions,
    deletions,
  })
}

async function admitted(
  event: SignedPublicNostrEvent
): Promise<VerifiedNostrEvent> {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error("Signed test fixture was rejected.")
  return result.event
}

async function admitMany(
  events: readonly SignedPublicNostrEvent[]
): Promise<void> {
  const admitted = await Promise.all(
    events.map((event) => admitPublicEvent(event))
  )
  if (admitted.some((result) => result.status !== "verified"))
    throw new Error("Signed test fixture was rejected.")
}

describe("Event Market causal merchant authorization", () => {
  it("requires a valid root, descends through revoke and deliberate regrant", async () => {
    const grant = await admitted(transition("active", 0))
    const revoke = await admitted(transition("revoked", 1, [grant]))
    const regrant = await admitted(transition("active", 2, [revoke]))
    await admitMany([grant, revoke, regrant])
    expect(parseEventMarketAuthorizationEvent(grant)?.parentIds).toEqual([])
    expect(resolution([grant]).state).toBe("active")
    expect(resolution([grant, revoke]).state).toBe("revoked")
    const current = resolution([grant, revoke, regrant])
    expect(current.state).toBe("active")
    if (current.state === "active")
      expect(current.ancestry.map((event) => event.eventId)).toEqual([
        grant.id,
        revoke.id,
        regrant.id,
      ])
  })

  it("blocks an identical-state fork until a descendant names both tips", async () => {
    const root = await admitted(transition("active", 0))
    const first = await admitted(transition("active", 1, [root], 101))
    const second = await admitted(transition("active", 1, [root], 102))
    await admitMany([root, first, second])
    expect(resolution([root, first, second]).state).toBe("conflicting")
    const reconcile = await admitted(
      transition("active", 2, [first, second], 103)
    )
    await admitMany([reconcile])
    expect(resolution([root, first, second, reconcile]).state).toBe("active")
    expect(resolution([reconcile]).state).toBe("missing_parent")
  })

  it("retains deletion as a blocker rather than restoring an old grant", async () => {
    const grant = await admitted(transition("active", 0))
    const revoke = await admitted(transition("revoked", 1, [grant]))
    const deletion = await admitted(
      finalizeEvent(
        {
          kind: 5,
          created_at: 103,
          content: "",
          tags: [
            ["e", revoke.id],
            ["a", marketCoordinate],
            ["p", merchant],
          ],
        },
        organizerSecret
      )
    )
    await admitMany([grant, revoke, deletion])
    expect(resolution([grant, revoke], [deletion]).state).toBe("deleted")
    expect(resolution([grant, revoke]).state).toBe("revoked")
    expect(resolution([grant], [deletion]).state).toBe("deleted")
    expect(resolution([], [deletion])).toMatchObject({
      state: "deleted_unknown",
      missingTargetIds: [revoke.id],
    })
  })

  it("requires an actual descendant repair for every observed deletion target", async () => {
    const grant = await admitted(transition("active", 0))
    const revoke = await admitted(transition("revoked", 1, [grant]))
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 103,
        content: "",
        tags: [
          ["e", grant.id],
          ["e", revoke.id],
          ["a", marketCoordinate],
          ["p", merchant],
        ],
      },
      organizerSecret
    )
    const repairDraft = buildEventMarketAuthorizationDraft({
      marketCoordinate,
      merchantPubkey: merchant,
      state: "active",
      sequence: 2,
      parentIds: [revoke.id],
      repairs: [
        { deletionId: deletion.id, targetId: grant.id },
        { deletionId: deletion.id, targetId: revoke.id },
      ],
    })
    const repair = finalizeEvent(
      { ...repairDraft, created_at: 104 },
      organizerSecret
    )
    const admittedDeletion = await admitted(deletion)
    const admittedRepair = await admitted(repair)
    await admitMany([grant, revoke, admittedDeletion, admittedRepair])
    expect(resolution([grant, revoke], [admittedDeletion]).state).toBe(
      "deleted"
    )
    expect(
      resolution([grant, revoke, admittedRepair], [admittedDeletion]).state
    ).toBe("active")
    const incompleteDraft = buildEventMarketAuthorizationDraft({
      marketCoordinate,
      merchantPubkey: merchant,
      state: "active",
      sequence: 2,
      parentIds: [revoke.id],
      repairs: [{ deletionId: deletion.id, targetId: revoke.id }],
    })
    const incomplete = finalizeEvent(
      { ...incompleteDraft, created_at: 105 },
      organizerSecret
    )
    const admittedIncomplete = await admitted(incomplete)
    await admitMany([admittedIncomplete])
    expect(
      resolution([grant, revoke, admittedIncomplete], [admittedDeletion]).state
    ).toBe("deleted")
  })

  it("rejects a wrong organizer, market, sequence, or malformed profile", async () => {
    const root = await admitted(transition("active", 0))
    const wrongSequence = await admitted(transition("revoked", 2, [root]))
    await admitMany([root, wrongSequence])
    expect(resolution([root, wrongSequence]).state).toBe("malformed")
    const forged = finalizeEvent(
      {
        kind: 3841,
        content: "",
        created_at: 110,
        tags: root.tags.map((tag) => [...tag]),
      },
      generateSecretKey()
    )
    const admittedForged = await admitted(forged)
    await admitMany([admittedForged])
    expect(parseEventMarketAuthorizationEvent(admittedForged)).toBeNull()
    const malformed = finalizeEvent(
      {
        kind: 3841,
        content: "",
        created_at: 111,
        tags: [...root.tags.map((tag) => [...tag]), ["state", "revoked"]],
      },
      organizerSecret
    )
    const admittedMalformed = await admitted(malformed)
    await admitMany([admittedMalformed])
    expect(resolution([root, admittedMalformed]).state).toBe("malformed")
  })

  it("keeps a retained revoke when a relay returns only an older grant", async () => {
    const grant = await admitted(transition("active", 0))
    const revoke = await admitted(transition("revoked", 1, [grant]))
    await admitMany([grant, revoke])
    const read = await readEventMarketAuthorization(
      {
        marketCoordinate,
        merchantPubkey: merchant,
      },
      {
        plan: async () => ({
          relayUrls: ["wss://example.com"],
          candidateRelayUrls: ["wss://example.com"],
          maxRelayAttempts: 1,
          ownerSelectedRelayUrls: [],
          appRelayUrls: ["wss://example.com"],
          personalRelayUrls: [],
          independentRelayUrls: [],
          relayListState: "missing",
          relayHintTruncated: false,
        }),
        fetch: async (filter) => ({
          events: filter.kinds?.includes(3841 as never) ? [grant] : [],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [grant, revoke],
        retain: async () => undefined,
      }
    )
    expect(read.resolution.state).toBe("revoked")
    expect(read.coverage).toBe("stale")
    expect(read.actionable).toBe(false)
  })

  it("blocks two live sibling grants even with full relay responses", async () => {
    const root = await admitted(transition("active", 0))
    const first = await admitted(transition("active", 1, [root], 101))
    const second = await admitted(transition("active", 1, [root], 102))
    await admitMany([root, first, second])
    const read = await readEventMarketAuthorization(
      {
        marketCoordinate,
        merchantPubkey: merchant,
      },
      {
        plan: async () => ({
          relayUrls: ["wss://example.com"],
          candidateRelayUrls: ["wss://example.com"],
          maxRelayAttempts: 1,
          ownerSelectedRelayUrls: [],
          appRelayUrls: ["wss://example.com"],
          personalRelayUrls: [],
          independentRelayUrls: [],
          relayListState: "missing",
          relayHintTruncated: false,
        }),
        fetch: async (filter) => ({
          events: filter.kinds?.includes(3841 as never)
            ? [root, first, second]
            : [],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [],
        retain: async () => undefined,
      }
    )
    expect(read.resolution.state).toBe("conflicting")
    expect(read.actionable).toBe(false)
  })

  it("permits a first grant only after complete empty scoped reads", async () => {
    const readEmpty = (status: "success" | "partial" | "failed") =>
      readEventMarketAuthorization(
        { marketCoordinate, merchantPubkey: merchant },
        {
          plan: async () => ({
            relayUrls: ["wss://example.com"],
            candidateRelayUrls: ["wss://example.com"],
            maxRelayAttempts: 1,
            ownerSelectedRelayUrls: [],
            appRelayUrls: ["wss://example.com"],
            personalRelayUrls: [],
            independentRelayUrls: [],
            relayListState: "missing",
            relayHintTruncated: false,
          }),
          fetch: async () => ({
            events: [],
            relays: [{ relayUrl: "wss://example.com", status }],
          }),
          load: async () => [],
          retain: async () => undefined,
        }
      )
    const complete = await readEmpty("success")
    expect(complete.resolution.state).toBe("missing")
    expect(complete.coverage).toBe("complete")
    const partial = await readEmpty("partial")
    expect(partial.resolution.state).toBe("missing")
    expect(partial.coverage).toBe("partial")
    const unavailable = await readEmpty("failed")
    expect(unavailable.resolution.state).toBe("missing")
    expect(unavailable.coverage).toBe("unavailable")
  })
})
