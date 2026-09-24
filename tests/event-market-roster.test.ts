import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  buildEventMarketAuthorizationDraft,
  getEventMarketCandidateFilters,
  parseEventMarketRosterEvent,
  parseEventMarketCalendarEvent,
  resolveEventMarketCalendar,
  resolveEventMarketProduct,
  resolveEventMarketRoster,
  resolveEventMarketAuthorization,
  readEventMarketRoster,
  readEventMarketProduct,
  readEventMarketReapprovalPreview,
  readEventMarketCatalog,
  createEventMarketPickupSnapshot,
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

function grant(createdAt = 102): SignedPublicNostrEvent {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state: "active",
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

  it("accepts an observed A to C chain when B was pruned", () => {
    const initial = roster([merchantRow], 100)
    const middle = roster([], 101, initial.id)
    const latest = roster([merchantRow], 102, middle.id)
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial, latest],
      })
    ).toMatchObject({ state: "current", market: { eventId: latest.id } })
    const sibling = roster([], 103, middle.id)
    expect(
      resolveEventMarketRoster({
        coordinate: marketCoordinate,
        revisions: [initial, latest, sibling],
      })
    ).toMatchObject({ state: "conflicting" })
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

  it("retains a newer signed merchant removal when a lagging relay returns the old roster", async () => {
    const approved = roster([merchantRow], 100)
    const removed = roster([], 101, approved.id)
    const read = await readEventMarketRoster(
      { reference: marketCoordinate },
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
          events: filter.kinds?.includes(30409 as never) ? [approved] : [],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [removed],
        retain: async () => undefined,
      }
    )
    expect(read.resolution).toMatchObject({
      state: "current",
      market: { merchants: [] },
    })
    expect(read.coverage).toBe("stale")
  })

  it("uses the exact latest product revision when a lagging relay offers an old market tag", async () => {
    const approved = parseEventMarketRosterEvent(roster([merchantRow]))!
    const tagged = product(merchantSecret, merchant, "soap", 100)
    const untagged = product(merchantSecret, merchant, "soap", 101, false)
    const read = await readEventMarketProduct(
      {
        marketRead: {
          coordinate: marketCoordinate,
          resolution: { state: "current", market: approved },
          coverage: "complete",
          retained: true,
          observedRelayUrls: ["wss://example.com"],
          calendar: parseEventMarketCalendarEvent(
            sign(
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
          ),
          calendarCoverage: "complete",
        },
        productCoordinate,
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
          events: filter.kinds?.includes(30402 as never)
            ? [tagged]
            : filter.kinds?.includes(3841 as never)
              ? [grant()]
              : [],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [untagged],
        retain: async () => undefined,
      }
    )
    expect(read.resolution.state).toBe("untagged")
    expect(read.coverage).toBe("stale")
    expect(read.actionable).toBe(false)
  })

  it("discovers only approved candidates after the signed roster and resolves newer untagged evidence", async () => {
    const approved = roster([merchantRow])
    const calendar = sign(
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
    const tagged = product(merchantSecret, merchant, "soap", 100)
    const untagged = product(merchantSecret, merchant, "soap", 101, false)
    const spam = product(spammerSecret, spammer, "spam", 100)
    const calls: Array<{
      kinds: number[]
      authors: string[]
      eventTag?: string[]
    }> = []
    const read = await readEventMarketCatalog(
      { reference: marketCoordinate },
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
        fetch: async (filter) => {
          calls.push({
            kinds: (filter.kinds ?? []) as number[],
            authors: filter.authors ?? [],
            eventTag: filter["#a"],
          })
          let events: SignedPublicNostrEvent[] = []
          if (filter.kinds?.includes(30409 as never)) events = [approved]
          if (filter.kinds?.includes(31923 as never)) events = [calendar]
          if (filter.kinds?.includes(30402 as never)) events = [tagged, spam]
          if (filter.kinds?.includes(3841 as never)) events = [grant()]
          return {
            events,
            relays: [{ relayUrl: "wss://example.com", status: "success" }],
          }
        },
        load: async () => [untagged],
        retain: async () => undefined,
      }
    )
    expect(read.marketRead.resolution.state).toBe("current")
    expect(read.candidateCount).toBe(1)
    expect(read.products).toHaveLength(0)
    expect(read.coverage).toBe("partial")
    const candidateCall = calls.find(
      (call) =>
        call.kinds.includes(30402) && call.eventTag?.includes(marketCoordinate)
    )
    expect(candidateCall?.authors).toEqual([merchant])
    expect(calls[0]?.authors).toEqual([organizer])
  })

  it("freezes the signed roster row and product revision with the merchant as payee", () => {
    const currentMarket = parseEventMarketRosterEvent(roster([merchantRow]))!
    const signedProduct = product(merchantSecret, merchant, "soap", 100)
    const currentProduct = resolveEventMarketProduct({
      market: currentMarket,
      productCoordinate,
      revisions: [signedProduct],
    })
    const calendar = parseEventMarketCalendarEvent(
      sign(
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
    )!
    const marketRead = {
      coordinate: marketCoordinate,
      resolution: { state: "current" as const, market: currentMarket },
      coverage: "complete" as const,
      retained: true,
      observedRelayUrls: ["wss://example.com"],
      calendar,
      calendarCoverage: "complete" as const,
    }
    const productRead = {
      productCoordinate,
      resolution: currentProduct,
      coverage: "complete" as const,
      retained: true,
      actionable: true,
      authorization: {
        marketCoordinate,
        merchantPubkey: merchant,
        resolution: resolveEventMarketAuthorization({
          marketCoordinate,
          merchantPubkey: merchant,
          transitions: [grant()],
        }),
        coverage: "complete" as const,
        retained: true,
        observedRelayUrls: ["wss://example.com"],
      },
    }
    const snapshot = createEventMarketPickupSnapshot({
      marketRead,
      productRead,
    })
    expect(snapshot).toMatchObject({
      type: "event_market_pickup",
      payeePubkey: merchant,
      mode: "merchant_present",
      assignment: "Booth 12",
      market: { eventId: currentMarket.eventId },
      product: { eventId: signedProduct.id },
    })
    expect(snapshot).not.toHaveProperty("costSats")
    expect(() =>
      createEventMarketPickupSnapshot({
        marketRead,
        productRead: { ...productRead, actionable: false },
      })
    ).toThrow()
  })

  it("previews a removed merchant's current tagged products without granting admission", async () => {
    const removed = roster([], 100)
    const calendar = sign(
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
    const tagged = product(merchantSecret, merchant, "soap", 100)
    const dependencies = {
      plan: async () => ({
        relayUrls: ["wss://example.com"],
        candidateRelayUrls: ["wss://example.com"],
        maxRelayAttempts: 1,
        ownerSelectedRelayUrls: [],
        appRelayUrls: ["wss://example.com"],
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayListState: "missing" as const,
        relayHintTruncated: false,
      }),
      fetch: async (filter: { kinds?: number[] }) => ({
        events: filter.kinds?.includes(30409)
          ? [removed]
          : filter.kinds?.includes(31923)
            ? [calendar]
            : filter.kinds?.includes(30402)
              ? [tagged]
              : [],
        relays: [{ relayUrl: "wss://example.com", status: "success" as const }],
      }),
      load: async () => [] as SignedPublicNostrEvent[],
      retain: async () => undefined,
    }
    const preview = await readEventMarketReapprovalPreview(
      { marketCoordinate, merchantPubkey: merchant },
      dependencies
    )
    expect(preview.complete).toBe(true)
    expect(preview.products.map((entry) => entry.id)).toEqual([
      productCoordinate,
    ])
  })
})
