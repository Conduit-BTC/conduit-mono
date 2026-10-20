import { describe, expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import {
  createEventMarketStockAuthorityRumor,
  EVENT_MARKET_STOCK_AUTHORITY_SUBJECT,
  isEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockAcceptance,
  type EventMarketStockAuthorityPayload,
  type EventMarketStockClose,
  type EventMarketStockGrant,
} from "@conduit/core/protocol/event-market-stock-authority"
import {
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
  type PrivateMessageEvent,
} from "@conduit/core/protocol/private-message-primitives"
import type { NostrKeySigner } from "@conduit/core/protocol/nostr-event-signer"

const merchantSecret = generateSecretKey()
const organizerSecret = generateSecretKey()
const merchantPubkey = getPublicKey(merchantSecret)
const organizerPubkey = getPublicKey(organizerSecret)
const writerId = crypto.randomUUID()
const hash = () => getPublicKey(generateSecretKey())
const at = 100
const grant: EventMarketStockGrant = {
  type: "grant",
  version: 1,
  merchantPubkey,
  organizerPubkey,
  writerId,
  nonce: crypto.randomUUID(),
  productCoordinate: `30402:${merchantPubkey}:soap`,
  assignmentCoordinate: `30410:${merchantPubkey}:assignment`,
  marketCoordinate: `30409:${organizerPubkey}:market`,
  occurrenceCoordinate: `31923:${organizerPubkey}:day`,
  productEventId: hash(),
  assignmentEventId: hash(),
  marketEventId: hash(),
  occurrenceEventId: hash(),
  grantEventId: hash(),
  scheduleEventId: hash(),
  quantity: 5,
  expiresAtMs: 200_000,
}
const grantRumor = createEventMarketStockAuthorityRumor({
  payload: grant,
  createdAt: at,
})
const accepted: EventMarketStockAcceptance = {
  type: "accepted",
  version: 1,
  merchantPubkey,
  organizerPubkey,
  writerId,
  poolId: grantRumor.id,
  sequence: 1,
  previousId: grantRumor.id,
  orderId: crypto.randomUUID(),
  identityBinding: hash(),
  termsBinding: hash(),
  claimRef: hash(),
  quantity: 2,
  acceptedAtMs: 110_123,
}
const acceptedRumor = createEventMarketStockAuthorityRumor({
  payload: accepted,
  createdAt: 110,
})
const closed: EventMarketStockClose = {
  type: "closed",
  version: 1,
  merchantPubkey,
  organizerPubkey,
  writerId,
  poolId: grantRumor.id,
  sequence: 1,
  lastAcceptedId: acceptedRumor.id,
  acceptedQuantity: 2,
}

function rehash(
  rumor: PrivateMessageEvent,
  change: Partial<PrivateMessageEvent>
) {
  const result = { ...rumor, ...change }
  return {
    ...result,
    id: getEventHash({
      pubkey: result.pubkey,
      created_at: result.created_at!,
      kind: result.kind,
      tags: result.tags,
      content: result.content,
    }),
  }
}

function keySigner(secret: Uint8Array): NostrKeySigner {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
    encryptNip44: async (peer, plaintext) =>
      v2.encrypt(plaintext, v2.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      v2.decrypt(ciphertext, v2.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => "",
  }
}

describe("private Event Market stock authority codec", () => {
  it.each([grant, accepted, closed])(
    "builds deterministic unsigned $type rumors with exact roles and tags",
    (payload) => {
      const createdAt = payload.type === "accepted" ? 110 : at
      const rumor = createEventMarketStockAuthorityRumor({ payload, createdAt })
      expect(rumor).not.toHaveProperty("sig")
      expect(rumor.kind).toBe(14)
      expect(rumor.pubkey).toBe(
        payload.type === "grant" ? merchantPubkey : organizerPubkey
      )
      expect(rumor.tags).toEqual([
        ["p", payload.type === "grant" ? organizerPubkey : merchantPubkey],
        ["subject", EVENT_MARKET_STOCK_AUTHORITY_SUBJECT],
        ["conduit", "event-stock", "1"],
      ])
      expect(parseEventMarketStockAuthorityRumor(rumor)).toEqual(payload)
      expect(
        createEventMarketStockAuthorityRumor({
          payload: structuredClone(payload),
          createdAt,
        }).id
      ).toBe(rumor.id)
      expect(Object.isFrozen(parseEventMarketStockAuthorityRumor(rumor))).toBe(
        true
      )
    }
  )

  it("handles the optional schedule without inventing a current revision", () => {
    const { scheduleEventId: unused, ...singleDate } = grant
    void unused
    const rumor = createEventMarketStockAuthorityRumor({
      payload: singleDate,
      createdAt: at,
    })
    expect(parseEventMarketStockAuthorityRumor(rumor)).not.toHaveProperty(
      "scheduleEventId"
    )
  })

  it("admits an unused close and the next immutable acceptance link", () => {
    const unused: EventMarketStockClose = {
      ...closed,
      sequence: 0,
      lastAcceptedId: grantRumor.id,
      acceptedQuantity: 0,
    }
    expect(
      parseEventMarketStockAuthorityRumor(
        createEventMarketStockAuthorityRumor({
          payload: unused,
          createdAt: 120,
        })
      )
    ).toEqual(unused)
    const next = { ...accepted, sequence: 2, previousId: acceptedRumor.id }
    expect(
      parseEventMarketStockAuthorityRumor(
        createEventMarketStockAuthorityRumor({ payload: next, createdAt: 110 })
      )
    ).toEqual(next)
  })

  it("changes pool identity for every nonce and freezes a grant before its public commitment", () => {
    const next = createEventMarketStockAuthorityRumor({
      payload: { ...grant, nonce: crypto.randomUUID() },
      createdAt: at,
    })
    expect(next.id).not.toBe(grantRumor.id)
    expect(grantRumor.id).toHaveLength(64)
  })

  it.each([
    { ...grant, version: 2 },
    { ...grant, type: "unknown" },
    { ...grant, extra: true },
    { ...grant, nonce: "not-a-uuid" },
    { ...grant, writerId: "not-a-uuid" },
    { ...grant, merchantPubkey: organizerPubkey },
    { ...grant, merchantPubkey: merchantPubkey.toUpperCase() },
    { ...grant, productCoordinate: `30402:${organizerPubkey}:soap` },
    { ...grant, assignmentCoordinate: `30406:${merchantPubkey}:assignment` },
    { ...grant, marketCoordinate: `30409:${merchantPubkey}:market` },
    { ...grant, occurrenceCoordinate: `31924:${organizerPubkey}:schedule` },
    { ...grant, occurrenceCoordinate: `31923:${merchantPubkey}:day` },
    { ...grant, productEventId: "bad" },
    { ...grant, scheduleEventId: undefined },
    { ...grant, quantity: 0 },
    { ...grant, quantity: 2_147_483_648 },
    { ...grant, quantity: 1.5 },
    { ...grant, expiresAtMs: 100_000 },
    { ...grant, expiresAtMs: 99_999 },
    { ...grant, expiresAtMs: Number.NaN },
    { ...accepted, sequence: 0 },
    { ...accepted, sequence: 2, previousId: grantRumor.id },
    { ...accepted, sequence: 1, previousId: acceptedRumor.id },
    { ...accepted, quantity: 0 },
    { ...accepted, orderId: " " },
    { ...accepted, orderId: "private\norder" },
    { ...accepted, orderId: "x".repeat(513) },
    { ...accepted, identityBinding: "bad" },
    { ...accepted, acceptedAtMs: 111_000 },
    { ...closed, acceptedQuantity: 0 },
    { ...closed, sequence: 0 },
    {
      ...closed,
      sequence: 0,
      lastAcceptedId: grantRumor.id,
      acceptedQuantity: 1,
    },
    { ...closed, lastAcceptedId: grantRumor.id },
    { ...closed, sequence: 3, acceptedQuantity: 2 },
  ])("rejects malformed or misbound authoring input (%#)", (payload) => {
    const createdAt = payload.type === "accepted" ? 110 : at
    expect(() =>
      createEventMarketStockAuthorityRumor({
        payload: payload as EventMarketStockAuthorityPayload,
        createdAt,
      })
    ).toThrow()
  })

  it("accepts maximum bounded stock and rejects unsafe rumor time", () => {
    expect(
      parseEventMarketStockAuthorityRumor(
        createEventMarketStockAuthorityRumor({
          payload: { ...grant, quantity: 2_147_483_647 },
          createdAt: at,
        })
      )
    ).toMatchObject({ quantity: 2_147_483_647 })
    for (const createdAt of [-1, 1.5, Number.NaN, 9_007_199_254_741])
      expect(() =>
        createEventMarketStockAuthorityRumor({ payload: grant, createdAt })
      ).toThrow()
  })

  it.each([
    (rumor: PrivateMessageEvent) => ({ ...rumor, id: hash() }),
    (rumor: PrivateMessageEvent) => ({ ...rumor, content: "{}" }),
    (rumor: PrivateMessageEvent) => ({ ...rumor, sig: "not-permitted" }),
    (rumor: PrivateMessageEvent) => ({ ...rumor, extra: "not-permitted" }),
    (rumor: PrivateMessageEvent) => rehash(rumor, { kind: 16 }),
    (rumor: PrivateMessageEvent) => rehash(rumor, { pubkey: organizerPubkey }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, { tags: [["p", merchantPubkey], ...rumor.tags.slice(1)] }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, { tags: [...rumor.tags, ["p", organizerPubkey]] }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, {
        tags: [rumor.tags[0]!, ["subject", "other"], rumor.tags[2]!],
      }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, {
        tags: [rumor.tags[0]!, rumor.tags[1]!, ["conduit", "event-stock", "2"]],
      }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, { tags: [rumor.tags[1]!, rumor.tags[0]!, rumor.tags[2]!] }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, {
        content: JSON.stringify(JSON.parse(rumor.content), null, 2),
      }),
    (rumor: PrivateMessageEvent) =>
      rehash(rumor, { content: "x".repeat(16_385) }),
  ])(
    "rejects tampered/ambiguous rumor envelopes without accepting signatures (%#)",
    (change) => {
      expect(() =>
        parseEventMarketStockAuthorityRumor(change(grantRumor))
      ).toThrow()
    }
  )

  it("validates maliciously rehashed payload changes as well as the outer rumor hash", () => {
    for (const change of [
      { version: 2 },
      { quantity: -1 },
      { extra: true },
      { organizerPubkey: merchantPubkey },
    ]) {
      const payload = { ...JSON.parse(grantRumor.content), ...change }
      expect(() =>
        parseEventMarketStockAuthorityRumor(
          rehash(grantRumor, { content: JSON.stringify(payload) })
        )
      ).toThrow()
    }
  })

  it("quarantines reserved markers even for malformed/unknown kind or version", () => {
    expect(isEventMarketStockAuthorityRumor(grantRumor)).toBe(true)
    expect(
      isEventMarketStockAuthorityRumor({
        tags: [["subject", EVENT_MARKET_STOCK_AUTHORITY_SUBJECT]],
      })
    ).toBe(true)
    expect(
      isEventMarketStockAuthorityRumor({
        tags: [["conduit", "event-stock", "unknown", "malformed"]],
      })
    ).toBe(true)
    expect(
      isEventMarketStockAuthorityRumor({
        tags: [["conduit", "unrelated", "1"]],
      })
    ).toBe(false)
    expect(isEventMarketStockAuthorityRumor({ tags: "malformed" })).toBe(false)
    expect(isEventMarketStockAuthorityRumor({ tags: [null, 12, []] })).toBe(
      false
    )
  })

  it("does not mistake a syntactically reconstructed rumor for authenticated origin", () => {
    const forged = createPrivateMessageRumor({
      kind: grantRumor.kind,
      pubkey: grantRumor.pubkey,
      created_at: grantRumor.created_at,
      tags: grantRumor.tags,
      content: grantRumor.content,
    })
    // Deliberately demonstrates why callers MUST authenticate the signed seal.
    expect(parseEventMarketStockAuthorityRumor(forged)).toEqual(grant)
  })

  it("uses genuine NIP-59 seals for cold Merchant grant and organizer journal verification", async () => {
    const merchant = keySigner(merchantSecret)
    const organizer = keySigner(organizerSecret)
    const merchantSelfWrap = await wrapPrivateMessage(
      grantRumor,
      { pubkey: merchantPubkey },
      merchant
    )
    const recoveredGrant = await unwrapPrivateMessageEnvelope(
      merchantSelfWrap,
      merchant
    )
    expect(recoveredGrant.id).toBe(grantRumor.id)
    expect(parseEventMarketStockAuthorityRumor(recoveredGrant)).toEqual(grant)
    const organizerGrantWrap = await wrapPrivateMessage(
      grantRumor,
      { pubkey: organizerPubkey },
      merchant
    )
    expect(
      parseEventMarketStockAuthorityRumor(
        await unwrapPrivateMessageEnvelope(organizerGrantWrap, organizer)
      )
    ).toEqual(grant)
    const organizerJournalWrap = await wrapPrivateMessage(
      acceptedRumor,
      { pubkey: merchantPubkey },
      organizer
    )
    expect(
      parseEventMarketStockAuthorityRumor(
        await unwrapPrivateMessageEnvelope(organizerJournalWrap, merchant)
      )
    ).toEqual(accepted)
    let rejected = false
    try {
      await unwrapPrivateMessageEnvelope(
        organizerJournalWrap,
        keySigner(generateSecretKey())
      )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    rejected = false
    try {
      await wrapPrivateMessage(
        acceptedRumor,
        { pubkey: merchantPubkey },
        merchant
      )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})
