import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  getEventMarketCandidateFilters,
  parseEventMarketRosterEvent,
  resolveEventMarketCalendar,
  resolveEventMarketProduct,
  resolveEventMarketRoster,
  type EventMarketMerchantRow,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const spammerSecret = generateSecretKey()
const spammer = getPublicKey(spammerSecret)
const marketCoordinate = `30409:${organizer}:fair-market`
const calendarCoordinate = `31923:${organizer}:fair`
const productCoordinate = `30402:${merchant}:soap`

function sign(
  secret: Uint8Array,
  kind: number,
  tags: string[][],
  createdAt: number,
  content = ""
): SignedPublicNostrEvent {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, secret)
}

function roster(
  rows: EventMarketMerchantRow[],
  createdAt = 100,
  previousEventId?: string
): SignedPublicNostrEvent {
  const draft = buildEventMarketRosterDraft({
    dTag: "fair-market",
    organizerPubkey: organizer,
    calendarCoordinate,
    state: "open",
    merchants: rows,
    previousEventId,
  })
  return sign(organizerSecret, draft.kind, draft.tags, createdAt)
}

function product(
  secret: Uint8Array,
  pubkey: string,
  dTag: string,
  createdAt: number,
  tagged = true,
  hidden = false
): SignedPublicNostrEvent {
  return sign(
    secret,
    30402,
    [
      ["d", dTag],
      ["title", "Handmade soap"],
      ["price", "12", "USD"],
      ["type", "simple", "physical"],
      ...(tagged ? [["a", marketCoordinate]] : []),
      ...(hidden ? [["visibility", "hidden"]] : []),
    ],
    createdAt,
    "Handmade soap"
  )
}

const merchantRow: EventMarketMerchantRow = {
  pubkey: merchant,
  mode: "merchant_present",
  assignment: "Booth 12",
}

describe("experimental Event Market roster", () => {
  it("parses one organizer-signed mode and assignment with a finite author filter", () => {
    const signed = roster([merchantRow])
    const parsed = parseEventMarketRosterEvent(signed)
    expect(parsed).toMatchObject({
      coordinate: marketCoordinate,
      organizerPubkey: organizer,
      calendarCoordinate,
      merchants: [merchantRow],
    })
    expect(getEventMarketCandidateFilters(parsed!)).toEqual([
      { kinds: [30402], authors: [merchant], "#a": [marketCoordinate] },
    ])
  })

  it("rejects duplicate or contradictory rows, forged organizer, and bad assignments", () => {
    expect(() =>
      roster([merchantRow, { ...merchantRow, mode: "organizer_handoff" }])
    ).toThrow()
    expect(() =>
      roster([{ ...merchantRow, assignment: "  Booth 12" }])
    ).toThrow()
    const signed = roster([merchantRow])
    const forged = sign(spammerSecret, 30409, signed.tags, 100)
    expect(parseEventMarketRosterEvent(forged)).toBeNull()
    const duplicated = sign(
      organizerSecret,
      30409,
      [...signed.tags, ["merchant", merchant, "organizer_handoff", "Desk"]],
      101
    )
    expect(parseEventMarketRosterEvent(duplicated)).toBeNull()
  })

  it("does not restore an older roster after removal and detects a known stale edit", () => {
    const initial = roster([merchantRow], 100)
    const removal = roster([], 101, initial.id)
    const staleEdit = roster(
      [{ ...merchantRow, assignment: "Booth 14" }],
      102,
      initial.id
    )
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial, removal],
      })
    ).toMatchObject({ state: "current", market: { merchants: [] } })
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial, removal, staleEdit],
      })
    ).toEqual({ state: "conflicting", eventId: staleEdit.id })
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial],
      })
    ).toMatchObject({ state: "current", market: { merchants: [merchantRow] } })
  })

  it("treats signed deletion and malformed newer evidence as stronger than an older approval", () => {
    const initial = roster([merchantRow], 100)
    const deletion = sign(
      organizerSecret,
      5,
      [
        ["a", marketCoordinate],
        ["k", "30409"],
      ],
      101
    )
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial],
        deletions: [deletion],
      })
    ).toMatchObject({ state: "deleted" })
    const malformed = sign(
      organizerSecret,
      30409,
      [...initial.tags, ["event_market", "1", "closed"]],
      102
    )
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial, malformed],
      })
    ).toEqual({ state: "malformed", eventId: malformed.id })
  })

  it("does not restore an older calendar when its newer signed revision is malformed", () => {
    const market = parseEventMarketRosterEvent(roster([merchantRow]))!
    const first = sign(
      organizerSecret,
      31923,
      [
        ["d", "fair"],
        ["title", "Fair"],
        ["start", "1790000000"],
        ["D", "20717"],
      ],
      100
    )
    const invalid = sign(
      organizerSecret,
      31923,
      [
        ["d", "fair"],
        ["title", "Fair"],
      ],
      101
    )
    expect(
      resolveEventMarketCalendar({ market, revisions: [first] })
    ).not.toBeNull()
    expect(
      resolveEventMarketCalendar({ market, revisions: [first, invalid] })
    ).toBeNull()
  })

  it("admits approved tagged products but not spam, hidden, untagged, or deleted revisions", () => {
    const market = parseEventMarketRosterEvent(roster([merchantRow]))!
    const first = product(merchantSecret, merchant, "soap", 100)
    expect(
      resolveEventMarketProduct({
        market,
        productCoordinate,
        revisions: [first],
      }).state
    ).toBe("eligible")
    const spam = product(spammerSecret, spammer, "spam", 100)
    expect(
      resolveEventMarketProduct({
        market,
        productCoordinate: `30402:${spammer}:spam`,
        revisions: [spam],
      }).state
    ).toBe("unapproved")
    const hidden = product(merchantSecret, merchant, "soap", 101, true, true)
    expect(
      resolveEventMarketProduct({
        market,
        productCoordinate,
        revisions: [first, hidden],
      }).state
    ).toBe("hidden")
    const untagged = product(merchantSecret, merchant, "soap", 102, false)
    expect(
      resolveEventMarketProduct({
        market,
        productCoordinate,
        revisions: [first, untagged],
      }).state
    ).toBe("untagged")
    const deleted = sign(
      merchantSecret,
      5,
      [
        ["a", productCoordinate],
        ["k", "30402"],
      ],
      103
    )
    expect(
      resolveEventMarketProduct({
        market,
        productCoordinate,
        revisions: [first],
        deletions: [deleted],
      }).state
    ).toBe("deleted")
    const revoked = parseEventMarketRosterEvent(roster([], 103))!
    expect(
      resolveEventMarketProduct({
        market: revoked,
        productCoordinate,
        revisions: [first],
      }).state
    ).toBe("unapproved")
    const reapproved = parseEventMarketRosterEvent(roster([merchantRow], 104))!
    expect(
      resolveEventMarketProduct({
        market: reapproved,
        productCoordinate,
        revisions: [first],
      }).state
    ).toBe("eligible")
  })
})
