import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  assertCurrentEventMarketOrganizerFeeTerms,
  buildEventMarketOrganizerFeeTags,
  calculateEventMarketOrganizerFeeSats,
  EVENT_MARKET_ORGANIZER_FEE_TAG,
  parseEventMarketOrganizerFeeTerms,
} from "@conduit/core/protocol/event-market-organizer-fee"
import { parseEventMarketRosterEvent } from "@conduit/core/protocol/event-market-roster"
import {
  admitPublicEvent,
  type VerifiedNostrEvent,
} from "@conduit/core/protocol/verified-public-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const marketCoordinate = `30409:${organizer}:fair`
const receiver = "organizer@example.com"
const tag = EVENT_MARKET_ORGANIZER_FEE_TAG

function market(feeTags: string[][] = [], createdAt = 100) {
  return finalizeEvent(
    {
      kind: 30_409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "fair"],
        ["a", `31923:${organizer}:fair-day`],
        ["event_market", "2", "open"],
        ...feeTags,
      ],
    },
    secret
  )
}

function parse(feeTags: string[][] = [], createdAt = 100) {
  return parseEventMarketOrganizerFeeTerms({
    marketCoordinate,
    event: market(feeTags, createdAt),
  })
}

const active = (expiry?: string) => [
  tag,
  "1",
  "active",
  "250",
  "5",
  receiver,
  ...(expiry ? [expiry] : []),
]

describe("Conduit Event Market organizer fee extension", () => {
  it("keeps an existing signed roster without fee terms free of organizer obligations", () => {
    const event = market()
    expect(
      parseEventMarketOrganizerFeeTerms({ marketCoordinate, event })
    ).toEqual({
      state: "absent",
      marketCoordinate,
      organizerPubkey: organizer,
      eventId: event.id,
      createdAt: 100,
    })
  })

  it("builds canonical normalized public fee tags without signing", () => {
    expect(
      buildEventMarketOrganizerFeeTags({
        state: "active",
        basisPoints: 250,
        minimumSats: 5,
        lightningAddress: " Organizer@Example.com ",
        expiresAt: 200,
      })
    ).toEqual([active("200")])
    expect(
      buildEventMarketOrganizerFeeTags({
        state: "active",
        basisPoints: 0,
        minimumSats: 0,
        lightningAddress: "",
      })
    ).toEqual([[tag, "1", "disabled"]])
    expect(buildEventMarketOrganizerFeeTags({ state: "disabled" })).toEqual([
      [tag, "1", "disabled"],
    ])
    expect(buildEventMarketOrganizerFeeTags({ state: "revoked" })).toEqual([
      [tag, "1", "revoked"],
    ])
  })

  it("retains the exact signed fee revision, author, destination and optional expiry", () => {
    const event = market([active("200")])
    expect(
      parseEventMarketOrganizerFeeTerms({ marketCoordinate, event })
    ).toEqual({
      state: "active",
      marketCoordinate,
      organizerPubkey: organizer,
      eventId: event.id,
      createdAt: 100,
      basisPoints: 250,
      minimumSats: 5,
      lightningAddress: receiver,
      expiresAt: 200,
    })
    expect(parse([active()])).not.toHaveProperty("expiresAt")
    expect(Object.isFrozen(parse([active()]))).toBe(true)
  })

  it("accepts an opaque admitted event without changing its signed identity", async () => {
    const event = market([active()])
    const admitted = await admitPublicEvent(event)
    expect(admitted.status).toBe("verified")
    if (admitted.status !== "verified")
      throw new Error("Expected verified fixture.")
    expect(
      parseEventMarketOrganizerFeeTerms({
        marketCoordinate,
        event: admitted.event,
      })
    ).toEqual(parseEventMarketOrganizerFeeTerms({ marketCoordinate, event }))
  })

  it("represents explicit disabled/revoked and economically zero terms without a payout", () => {
    expect(parse([[tag, "1", "disabled"]]).state).toBe("disabled")
    expect(parse([[tag, "1", "revoked"]]).state).toBe("revoked")
    expect(parse([[tag, "1", "active", "0", "0", receiver]]).state).toBe(
      "disabled"
    )
    expect(parse([[tag, "1", "active", "0", "10", receiver]]).state).toBe(
      "active"
    )
  })

  it.each([
    [[tag, "2", "active", "250", "5", receiver]],
    [[tag, "1", "unknown"]],
    [[tag, "1", "disabled", "extra"]],
    [[tag, "1", "revoked", "extra"]],
    [[tag, "1", "active", "250", "5"]],
    [[...active(), "200", "extra"]],
    [[tag, "1", "active", "-1", "5", receiver]],
    [[tag, "1", "active", "2.5", "5", receiver]],
    [[tag, "1", "active", "0250", "5", receiver]],
    [[tag, "1", "active", "250", "05", receiver]],
    [[tag, "1", "active", "250", "5", "not-an-address"]],
    [[tag, "1", "active", "250", "5", "Organizer@example.com"]],
    [[tag, "1", "active", "250", "5", receiver, ""]],
    [[tag, "1", "active", "250", "5", receiver, "100"]],
    [[tag, "1", "active", "250", "5", receiver, "99"]],
    [[tag, "1", "active", "250", "5", receiver, "0200"]],
    [[tag, "1", "active", "9007199254740992", "5", receiver]],
    [[tag, "1", "active", "250", "9007199254741", receiver]],
    [[tag, "1", "active", "250", "5", receiver, "9007199254741"]],
    [active(), active()],
    [active(), [tag, "1", "disabled"]],
  ])(
    "rejects malformed financial terms rather than dropping the fee (%#)",
    (...feeTags) => {
      expect(parse(feeTags)).toEqual({ state: "invalid" })
    }
  )

  it("does not hide an otherwise valid roster when its financial extension is malformed", async () => {
    const event = market([[tag, "1", "active", "bad", "5", receiver]])
    const admitted = await admitPublicEvent(event)
    expect(admitted.status).toBe("verified")
    expect(
      parseEventMarketRosterEvent(
        (admitted as { event: VerifiedNostrEvent }).event
      )
    ).not.toBeNull()
    expect(
      parseEventMarketOrganizerFeeTerms({ marketCoordinate, event })
    ).toEqual({ state: "invalid" })
  })

  it("rejects cross-market, cross-author, altered, duplicate-coordinate and wrong-kind evidence", () => {
    const event = market([active()])
    const otherSecret = generateSecretKey()
    const otherAuthor = getPublicKey(otherSecret)
    const reSign = (tags: string[][], kind = 30_409) =>
      finalizeEvent({ kind, created_at: 100, content: "", tags }, secret)
    for (const input of [
      { marketCoordinate: `30409:${organizer}:other`, event },
      { marketCoordinate: `30409:${otherAuthor}:fair`, event },
      { marketCoordinate: `30405:${organizer}:fair`, event },
      { marketCoordinate, event: { ...event, content: "altered" } },
      { marketCoordinate, event: { ...event, sig: "0".repeat(128) } },
      { marketCoordinate, event: reSign([...event.tags, ["d", "fair"]]) },
      { marketCoordinate, event: reSign(event.tags, 30_405) },
    ])
      expect(parseEventMarketOrganizerFeeTerms(input)).toEqual({
        state: "invalid",
      })
  })

  it("rejects unsafe signed timestamps and over-budget fee records", () => {
    expect(parse([active()], 9_007_199_254_741).state).toBe("invalid")
    expect(parse([active(), ["summary", "x".repeat(65_536)]]).state).toBe(
      "invalid"
    )
  })

  it("uses half-open fee validity for new financial admission, not historical parsing", () => {
    const terms = parse([active("200")])
    expect(() =>
      assertCurrentEventMarketOrganizerFeeTerms(terms, 99_999)
    ).toThrow()
    expect(assertCurrentEventMarketOrganizerFeeTerms(terms, 100_000)).toBe(
      terms
    )
    expect(assertCurrentEventMarketOrganizerFeeTerms(terms, 199_999)).toBe(
      terms
    )
    expect(() =>
      assertCurrentEventMarketOrganizerFeeTerms(terms, 200_000)
    ).toThrow()
    expect(() =>
      assertCurrentEventMarketOrganizerFeeTerms(terms, Number.NaN)
    ).toThrow()
    expect(() =>
      assertCurrentEventMarketOrganizerFeeTerms({ state: "invalid" }, 150_000)
    ).toThrow()
    // A saved original revision is still parseable years after its expiry.
    expect(parse([active("200")]).state).toBe("active")
    expect(
      assertCurrentEventMarketOrganizerFeeTerms(parse(), 150_000).state
    ).toBe("absent")
  })

  it.each([
    { basisPoints: -1, minimumSats: 5, lightningAddress: receiver },
    { basisPoints: 2.5, minimumSats: 5, lightningAddress: receiver },
    { basisPoints: 250, minimumSats: Number.NaN, lightningAddress: receiver },
    { basisPoints: 250, minimumSats: 5, lightningAddress: "invalid" },
    {
      basisPoints: 250,
      minimumSats: 5,
      lightningAddress: receiver,
      expiresAt: 2.5,
    },
  ])("rejects invalid unsigned authoring input (%#)", (terms) => {
    expect(() =>
      buildEventMarketOrganizerFeeTags({ state: "active", ...terms })
    ).toThrow()
  })
})

describe("Event Market organizer fee arithmetic", () => {
  it.each([
    [1_000, 250, 0, 25],
    [1_001, 250, 0, 26],
    [1, 1, 0, 1],
    [1_000, 250, 111, 111],
    [1_000, 0, 0, 0],
    [1_000, 0, 7, 7],
    [0, 250, 0, 0],
    [0, 250, 7, 7],
    [1_000, 20_000, 0, 2_000],
  ])(
    "rounds once on the final commerce base (%#)",
    (commerceTotalSats, basisPoints, minimumSats, expected) => {
      expect(
        calculateEventMarketOrganizerFeeSats({
          commerceTotalSats,
          basisPoints,
          minimumSats,
        })
      ).toBe(expected)
    }
  )

  it("uses integer arithmetic without charging organizer or Conduit fee-on-fee", () => {
    // The caller supplies product plus shipping, not the 111-sat Conduit fee.
    expect(
      calculateEventMarketOrganizerFeeSats({
        commerceTotalSats: 1_100,
        basisPoints: 1_000,
        minimumSats: 0,
      })
    ).toBe(110)
    const commerceTotalSats = 100_000_000
    const basisPoints = 123_456_789
    const expected = Number(
      (BigInt(commerceTotalSats) * BigInt(basisPoints) + 9_999n) / 10_000n
    )
    expect(
      calculateEventMarketOrganizerFeeSats({
        commerceTotalSats,
        basisPoints,
        minimumSats: 0,
      })
    ).toBe(expected)
  })

  it.each([
    [-1, 250, 0],
    [1.5, 250, 0],
    [1_000, -1, 0],
    [1_000, Number.POSITIVE_INFINITY, 0],
    [1_000, 250, -1],
    [9_007_199_254_740, 1, 0],
    [1_000, Number.MAX_SAFE_INTEGER, 0],
  ])(
    "rejects unsafe sats, fees and resulting millisatoshis (%#)",
    (commerceTotalSats, basisPoints, minimumSats) => {
      expect(() =>
        calculateEventMarketOrganizerFeeSats({
          commerceTotalSats,
          basisPoints,
          minimumSats,
        })
      ).toThrow()
    }
  )
})
