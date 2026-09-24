import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  resolveEventMarketAuthorization,
  type ParsedEventMarketAuthorization,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair`

function transition(
  state: "active" | "revoked",
  parents: ParsedEventMarketAuthorization[] = [],
  createdAt = 100,
  repairs: { deletionId: string; targetEventId: string }[] = []
): SignedPublicNostrEvent {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state,
    parents,
    repairs,
  })
  return finalizeEvent({ ...draft, created_at: createdAt }, organizerSecret)
}

function parsed(event: SignedPublicNostrEvent): ParsedEventMarketAuthorization {
  const result = parseEventMarketAuthorizationEvent(event)
  if (!result) throw new Error("Invalid fixture")
  return result
}

function reduce(
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

function deletion(target: SignedPublicNostrEvent, createdAt = 110) {
  return finalizeEvent(
    {
      kind: 5,
      tags: [
        ["e", target.id],
        ["a", marketCoordinate],
        ["p", merchant],
      ],
      content: "",
      created_at: createdAt,
    },
    organizerSecret
  )
}

describe("Event Market causal authorization", () => {
  it("emits a canonical grant and rejects forged scope and duplicate singleton tags", () => {
    const root = transition("active")
    expect(parsed(root)).toMatchObject({
      marketCoordinate,
      merchantPubkey: merchant,
      state: "active",
      sequence: 0,
      parentIds: [],
    })
    const duplicate = finalizeEvent(
      {
        kind: 3841,
        tags: [...root.tags, ["state", "revoked"]],
        content: "",
        created_at: 101,
      },
      organizerSecret
    )
    expect(parseEventMarketAuthorizationEvent(duplicate)).toBeNull()
    const wrongAuthor = finalizeEvent(
      {
        kind: 3841,
        tags: root.tags,
        content: "",
        created_at: 101,
      },
      generateSecretKey()
    )
    expect(parseEventMarketAuthorizationEvent(wrongAuthor)).toBeNull()
  })

  it("requires a descendant for regrant and validates required ancestry", () => {
    const grant = transition("active")
    const revoke = transition("revoked", [parsed(grant)], 101)
    const regrant = transition("active", [parsed(revoke)], 102)
    expect(reduce([grant, revoke])).toMatchObject({
      state: "revoked",
      tip: { eventId: revoke.id },
    })
    expect(reduce([grant, revoke, regrant])).toMatchObject({
      state: "active",
      tip: { eventId: regrant.id },
      ancestry: expect.arrayContaining([grant, revoke, regrant]),
    })
    expect(reduce([grant, regrant])).toMatchObject({
      state: "missing_parent",
      missingParentIds: [revoke.id],
    })
  })

  it("blocks equal-state siblings until a multi-parent reconciliation", () => {
    const grant = transition("active")
    const one = transition("active", [parsed(grant)], 101)
    const two = transition("active", [parsed(grant)], 102)
    expect(reduce([grant, one, two])).toMatchObject({ state: "conflicting" })
    const reconcile = transition("active", [parsed(one), parsed(two)], 103)
    expect(parsed(reconcile).sequence).toBe(2)
    expect(reduce([grant, one, two, reconcile])).toMatchObject({
      state: "active",
      tip: { eventId: reconcile.id },
    })
  })

  it("retains deletion of a revoke until an exact descendant repair", () => {
    const grant = transition("active")
    const revoke = transition("revoked", [parsed(grant)], 101)
    const erased = deletion(revoke)
    expect(reduce([grant, revoke], [erased])).toMatchObject({
      state: "deleted",
      tip: { eventId: revoke.id },
    })
    expect(reduce([grant], [erased])).toMatchObject({ state: "deleted" })
    const unrepaired = transition("active", [parsed(revoke)], 111)
    expect(reduce([grant, revoke, unrepaired], [erased])).toMatchObject({
      state: "deleted",
    })
    const repaired = transition("active", [parsed(revoke)], 112, [
      { deletionId: erased.id, targetEventId: revoke.id },
    ])
    expect(reduce([grant, revoke, repaired], [erased])).toMatchObject({
      state: "active",
      tip: { eventId: repaired.id },
    })
  })

  it("rejects invalid sequence and parent payload", () => {
    const root = transition("active")
    const badSequence = finalizeEvent(
      {
        kind: 3841,
        tags: root.tags.map((tag) => (tag[0] === "seq" ? ["seq", "1"] : tag)),
        content: "",
        created_at: 101,
      },
      organizerSecret
    )
    expect(parseEventMarketAuthorizationEvent(badSequence)).toBeNull()
    const child = transition("revoked", [parsed(root)], 102)
    const forgedSequence = finalizeEvent(
      {
        kind: 3841,
        tags: child.tags.map((tag) => (tag[0] === "seq" ? ["seq", "2"] : tag)),
        content: "",
        created_at: 103,
      },
      organizerSecret
    )
    expect(reduce([root, forgedSequence])).toMatchObject({ state: "malformed" })
  })
})
