import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { matchFilter, type Filter } from "nostr-tools"
import {
  buildEventMarketRosterDraft,
  buildEventMarketAuthorizationDraft,
  resolveEventMarketAuthorization,
  getEventMarketCandidateFilters,
  parseEventMarketRosterEvent,
  parseEventMarketAuthorizationEvent,
  parseEventMarketCalendarEvent,
  resolveEventMarketCalendar,
  resolveEventMarketProduct,
  resolveEventMarketRoster,
  readEventMarketRoster,
  readEventMarketAuthorization,
  readEventMarketProduct,
  readEventMarketCatalog,
  readEventMarketOrderEvidenceByIds,
  previewEventMarketMerchantProducts,
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
    sequence: 0,
    parentIds: [],
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

const grantEvent = (() => {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state: "active",
    sequence: 0,
    parentIds: [],
  })
  return sign(organizerSecret, draft.kind, draft.tags, 99)
})()
const authorization = resolveEventMarketAuthorization({
  marketCoordinate,
  merchantPubkey: merchant,
  transitions: [grantEvent],
})
const authorizationRead = {
  marketCoordinate,
  merchantPubkey: merchant,
  resolution: authorization,
  coverage: "complete" as const,
  retained: true,
  actionable: true,
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
        authorization,
        market,
        productCoordinate,
        revisions: [first],
      }).state
    ).toBe("eligible")
    const spam = product(spammerSecret, spammer, "spam", 100)
    expect(
      resolveEventMarketProduct({
        authorization,
        market,
        productCoordinate: `30402:${spammer}:spam`,
        revisions: [spam],
      }).state
    ).toBe("unapproved")
    const hidden = product(merchantSecret, merchant, "soap", 101, true, true)
    expect(
      resolveEventMarketProduct({
        authorization,
        market,
        productCoordinate,
        revisions: [first, hidden],
      }).state
    ).toBe("hidden")
    const untagged = product(merchantSecret, merchant, "soap", 102, false)
    expect(
      resolveEventMarketProduct({
        authorization,
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
        authorization,
        market,
        productCoordinate,
        revisions: [first],
        deletions: [deleted],
      }).state
    ).toBe("deleted")
    const revoked = parseEventMarketRosterEvent(roster([], 103))!
    expect(
      resolveEventMarketProduct({
        authorization,
        market: revoked,
        productCoordinate,
        revisions: [first],
      }).state
    ).toBe("unapproved")
    const reapproved = parseEventMarketRosterEvent(roster([merchantRow], 104))!
    expect(
      resolveEventMarketProduct({
        authorization,
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
        authorization: async () => authorizationRead,
      }
    )
    expect(read.resolution.state).toBe("untagged")
    expect(read.coverage).toBe("stale")
    expect(read.actionable).toBe(false)
  })

  it("filters discovered candidates by the signed roster and known newer untagged evidence", async () => {
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
    expect(read.marketRead.calendarSignedEvent?.id).toBe(calendar.id)
    expect(read.candidateCount).toBe(1)
    expect(read.products).toHaveLength(0)
    expect(read.coverage).toBe("partial")
    const candidateCall = calls.find(
      (call) =>
        call.kinds.includes(30402) && call.eventTag?.includes(marketCoordinate)
    )
    expect(candidateCall?.authors).toEqual([])
    expect(calls.filter((call) => call.kinds.includes(30402))).toHaveLength(1)
    expect(calls.every((call) => !call.kinds.includes(3841))).toBe(true)
  })

  it("keeps a signed candidate visible without reading authorization", async () => {
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
    const active = grant()
    const read = await readEventMarketCatalog(
      { reference: marketCoordinate },
      {
        plan: async () => ({
          relayUrls: ["wss://example.com", "wss://fallback.example.com"],
          candidateRelayUrls: [
            "wss://example.com",
            "wss://fallback.example.com",
          ],
          maxRelayAttempts: 2,
          ownerSelectedRelayUrls: [],
          appRelayUrls: ["wss://example.com"],
          personalRelayUrls: [],
          independentRelayUrls: ["wss://fallback.example.com"],
          relayListState: "missing",
          relayHintTruncated: false,
        }),
        fetch: async (filter) => ({
          events: filter.kinds?.includes(30409 as never)
            ? [approved]
            : filter.kinds?.includes(31923 as never)
              ? [calendar]
              : filter.kinds?.includes(30402 as never)
                ? [tagged]
                : filter.kinds?.includes(3841 as never)
                  ? [active]
                  : [],
          relays: [
            { relayUrl: "wss://example.com", status: "success" },
            ...(filter.kinds?.includes(3841 as never)
              ? [
                  {
                    relayUrl: "wss://fallback.example.com",
                    status: "failed" as const,
                  },
                ]
              : []),
          ],
        }),
        load: async () => [],
        retain: async () => undefined,
      }
    )
    expect(read.products).toHaveLength(1)
    expect(read.products[0]?.resolution.state).toBe("candidate")
    expect(read.products[0]).not.toHaveProperty("authorization")
    expect(read.products[0]?.actionable).toBe(false)
    expect(read.coverage).toBe("complete")
  })

  for (const transitions of [128, 130]) {
    it(`preserves authorization coverage at ${transitions} parent transitions`, async () => {
      const history = [grant()]
      for (let index = 1; index <= transitions; index++) {
        const draft = buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: index % 2 === 0 ? "active" : "revoked",
          sequence:
            parseEventMarketAuthorizationEvent(history.at(-1)!)!.sequence + 1,
          parentIds: [history.at(-1)!.id],
        })
        history.push(sign(organizerSecret, draft.kind, draft.tags, 102 + index))
      }
      const byId = new Map(history.map((event) => [event.id, event]))
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
      let parentRequests = 0
      const dependencies: NonNullable<
        Parameters<typeof readEventMarketAuthorization>[1]
      > = {
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
          if (filter.ids) parentRequests++
          const events = filter.kinds?.includes(30409 as never)
            ? [approved]
            : filter.kinds?.includes(31923 as never)
              ? [calendar]
              : filter.kinds?.includes(30402 as never)
                ? [tagged]
                : filter.kinds?.includes(3841 as never)
                  ? filter.ids
                    ? filter.ids.flatMap((id) =>
                        byId.has(id) ? [byId.get(id)!] : []
                      )
                    : [history.at(-1)!]
                  : []
          return {
            events,
            relays: [{ relayUrl: "wss://example.com", status: "success" }],
          }
        },
        load: async () => [],
        retain: async () => undefined,
      }
      const authorization = await readEventMarketAuthorization(
        { marketCoordinate, merchantPubkey: merchant },
        dependencies
      )
      expect(parentRequests).toBe(128)
      expect(authorization.resolution.state).toBe(
        transitions === 128 ? "active" : "missing_parent"
      )
      expect(authorization.coverage).toBe(
        transitions === 128 ? "complete" : "partial"
      )
      const catalog = await readEventMarketCatalog(
        { reference: marketCoordinate },
        dependencies
      )
      expect(catalog.coverage).toBe("complete")
      expect(catalog.products).toHaveLength(1)
      expect(catalog.products[0]?.actionable).toBe(false)
      const exact = await readEventMarketProduct(
        { marketRead: catalog.marketRead, productCoordinate },
        dependencies
      )
      expect(exact.actionable).toBe(transitions === 128)
    })
  }

  it("freezes the signed roster row and product revision with the merchant as payee", () => {
    const currentMarket = parseEventMarketRosterEvent(roster([merchantRow]))!
    const signedProduct = product(merchantSecret, merchant, "soap", 100)
    const currentProduct = resolveEventMarketProduct({
      authorization,
      market: currentMarket,
      productCoordinate,
      revisions: [signedProduct],
    })
    const signedCalendar = sign(
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
    const calendar = parseEventMarketCalendarEvent(signedCalendar)!
    const marketRead = {
      coordinate: marketCoordinate,
      resolution: { state: "current" as const, market: currentMarket },
      coverage: "complete" as const,
      retained: true,
      observedRelayUrls: ["wss://example.com"],
      calendar,
      calendarSignedEvent: signedCalendar,
      calendarCoverage: "complete" as const,
    }
    const productRead = {
      productCoordinate,
      resolution: currentProduct,
      coverage: "complete" as const,
      retained: true,
      actionable: true,
      authorization: authorizationRead,
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

  it("retrieves the exact signed order record after a newer roster revision", async () => {
    const original = roster([merchantRow], 100)
    const newer = roster([], 101, original.id)
    const read = await readEventMarketOrderEvidenceByIds(
      {
        marketCoordinate,
        merchantPubkey: merchant,
        eventIds: [original.id],
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
        fetch: async () => ({
          events: [newer],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [original],
        retain: async () => undefined,
      }
    )
    expect(read.events.map((event) => event.id)).toEqual([original.id])
    expect(read.coverage).toBe("stale")
  })

  it("previews current tagged products before reapproval without admitting old revisions", async () => {
    const active = product(merchantSecret, merchant, "soap", 100)
    const oldTagged = product(merchantSecret, merchant, "jam", 100)
    const untagged = product(merchantSecret, merchant, "jam", 101, false)
    const preview = await previewEventMarketMerchantProducts(
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
          events: filter.kinds?.includes(30402 as never)
            ? "#a" in filter
              ? [active, oldTagged]
              : [active, oldTagged, untagged]
            : [],
          relays: [{ relayUrl: "wss://example.com", status: "success" }],
        }),
        load: async () => [],
        retain: async () => undefined,
      }
    )
    expect(preview.products.map((item) => item.coordinate)).toEqual([
      productCoordinate,
    ])
    expect(preview.candidateCount).toBe(2)
    expect(preview.coverage).toBe("complete")
  })
})

describe("retained future Event Market evidence", () => {
  function fixture(rows = [merchantRow]) {
    const live = [
      roster(rows),
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
      ),
      grant(),
    ]
    const retained = new Map<string, SignedPublicNostrEvent>()
    const dependencies: NonNullable<
      Parameters<typeof readEventMarketCatalog>[1]
    > = {
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
        events: live.filter((event) => matchFilter(filter as Filter, event)),
        relays: [{ relayUrl: "wss://example.com", status: "success" }],
      }),
      load: async () => [...retained.values()],
      retain: async (_coordinate, events) => {
        for (const event of events) retained.set(event.id, event)
      },
    }
    return { live, retained, dependencies }
  }

  function historyFixture(
    scope: "authorization" | "roster" | "calendar" | "product"
  ) {
    const state = fixture()
    const tagged = product(merchantSecret, merchant, "soap", 100)
    state.live.push(tagged)
    const kind = {
      authorization: 3841,
      roster: 30409,
      calendar: 31923,
      product: 30402,
    }[scope]
    const initial = state.live.find((event) => event.kind === kind)!
    let previous = initial
    if (scope === "authorization") {
      const draft = buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "revoked",
        sequence: parseEventMarketAuthorizationEvent(initial)!.sequence + 1,
        parentIds: [initial.id],
      })
      previous = sign(organizerSecret, draft.kind, draft.tags, 105)
      state.retained.set(initial.id, initial)
    }
    // An authorization deletion targets the regular transition by ID. An
    // addressable deletion covers old revisions only, through its timestamp.
    const coordinate = {
      authorization: marketCoordinate,
      roster: marketCoordinate,
      calendar: calendarCoordinate,
      product: productCoordinate,
    }[scope]
    const secret = scope === "product" ? merchantSecret : organizerSecret
    const erased = sign(
      secret,
      5,
      [
        ["e", previous.id],
        ["k", String(kind)],
        ...(scope === "authorization" ? [] : [["a", coordinate]]),
      ],
      110
    )
    let current: SignedPublicNostrEvent
    if (scope === "authorization") {
      const draft = buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "active",
        sequence: parseEventMarketAuthorizationEvent(previous)!.sequence + 1,
        parentIds: [previous.id],
        repairs: [{ deletionId: erased.id, targetId: previous.id }],
      })
      current = sign(organizerSecret, draft.kind, draft.tags, 112)
    } else if (scope === "roster") {
      current = roster([merchantRow], 112, previous.id)
    } else {
      current = sign(secret, kind, previous.tags, 112, previous.content)
    }
    for (const event of [previous, erased]) state.retained.set(event.id, event)
    state.live.splice(state.live.indexOf(initial), 1, current)
    return { ...state, initial, current, previous, erased, secret }
  }

  async function exactProduct(state: ReturnType<typeof fixture>) {
    const marketRead = await readEventMarketRoster(
      { reference: marketCoordinate },
      state.dependencies
    )
    const exact = await readEventMarketProduct(
      { marketRead, productCoordinate },
      state.dependencies
    )
    return { marketRead, exact }
  }

  for (const scope of [
    "authorization",
    "roster",
    "calendar",
    "product",
  ] as const) {
    it(`accepts a live current ${scope} with retained deleted history, whether the tombstone is redelivered or omitted`, async () => {
      for (const liveDeletion of [true, false]) {
        const state = historyFixture(scope)
        if (liveDeletion) state.live.push(state.erased)
        const catalog = await readEventMarketCatalog(
          { reference: marketCoordinate },
          state.dependencies
        )
        expect(catalog.coverage).toBe("complete")
        expect(catalog.marketRead.coverage).toBe("complete")
        expect(catalog.marketRead.calendarCoverage).toBe("complete")
        expect(catalog.products).toHaveLength(1)
        expect(catalog.products[0]).toMatchObject({
          coverage: "complete",
          resolution: { state: "candidate" },
          actionable: false,
        })
        const { exact } = await exactProduct(state)
        expect(exact.authorization?.resolution.state).toBe("active")
        expect(exact.authorization?.coverage).toBe("complete")
        expect(exact.actionable).toBe(true)
        expect(state.retained.has(state.erased.id)).toBe(true)
        expect(state.retained.has(state.previous.id)).toBe(true)
      }
    })

    it(`keeps an absent current ${scope} stale despite retained valid history`, async () => {
      const state = historyFixture(scope)
      state.retained.set(state.current.id, state.current)
      state.live.splice(state.live.indexOf(state.current), 1)
      const { marketRead, exact } = await exactProduct(state)
      const coverage =
        scope === "roster"
          ? marketRead.coverage
          : scope === "calendar"
            ? marketRead.calendarCoverage
            : scope === "authorization"
              ? exact.authorization?.coverage
              : exact.coverage
      expect(coverage).toBe("stale")
      expect(exact.resolution.state).toBe("eligible")
      expect(exact.actionable).toBe(false)
    })

    it(`keeps a retained deletion of the current ${scope} authoritative when live relays omit that tombstone`, async () => {
      const state = historyFixture(scope)
      const deletion = sign(
        state.secret,
        5,
        [
          ["e", state.current.id],
          ["k", String(state.current.kind)],
        ],
        113
      )
      state.retained.set(state.current.id, state.current)
      state.retained.set(deletion.id, deletion)
      const { marketRead, exact } = await exactProduct(state)
      if (scope === "roster")
        expect(marketRead.resolution.state).toBe("deleted")
      else if (scope === "calendar") expect(marketRead.calendar).toBeNull()
      else if (scope === "authorization")
        expect(exact.authorization?.resolution.state).toBe("deleted")
      else expect(exact.resolution.state).toBe("deleted")
      expect(exact.actionable).toBe(false)
      const catalog = await readEventMarketCatalog(
        { reference: marketCoordinate },
        state.dependencies
      )
      expect(catalog.products).toHaveLength(
        scope === "authorization" || scope === "calendar" ? 1 : 0
      )
      expect(catalog.products.every((entry) => !entry.actionable)).toBe(true)
    })
  }

  for (const defect of [
    "missing_parent",
    "unrepaired",
    "wrong_repair",
    "conflicting",
    "malformed",
  ] as const) {
    it(`denies a repaired authorization with ${defect} evidence at the product action gate`, async () => {
      const state = historyFixture("authorization")
      if (defect === "missing_parent") state.retained.delete(state.previous.id)
      else if (defect === "unrepaired" || defect === "wrong_repair") {
        const draft = buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          sequence:
            parseEventMarketAuthorizationEvent(state.previous)!.sequence + 1,
          parentIds: [state.previous.id],
          repairs:
            defect === "unrepaired"
              ? []
              : [
                  {
                    deletionId: state.erased.id,
                    targetId: state.initial.id,
                  },
                ],
        })
        state.live.splice(
          state.live.indexOf(state.current),
          1,
          sign(organizerSecret, draft.kind, draft.tags, 112)
        )
      } else if (defect === "conflicting") {
        const sibling = grant(114)
        state.retained.set(sibling.id, sibling)
      } else {
        const malformed = sign(
          organizerSecret,
          3841,
          [...state.current.tags, ["state", "revoked"]],
          114
        )
        state.retained.set(malformed.id, malformed)
      }
      const { exact } = await exactProduct(state)
      expect(exact.authorization?.resolution.state).toBe(
        defect === "unrepaired" || defect === "wrong_repair"
          ? "deleted"
          : defect
      )
      expect(exact.resolution.state).toBe("unauthorized")
      expect(exact.actionable).toBe(false)
    })
  }

  for (const failure of ["partial", "failed", "retention"] as const) {
    it(`separates ${failure} source coverage from retained repaired authority`, async () => {
      const state = historyFixture("authorization")
      if (failure === "retention") {
        state.dependencies.retain = async () => {
          throw new Error("unavailable")
        }
      } else {
        const fetch = state.dependencies.fetch
        state.dependencies.fetch = async (filter, options) => {
          const result = await fetch(filter, options)
          return {
            ...result,
            relays: [{ relayUrl: "wss://example.com", status: failure }],
          }
        }
      }
      const { exact } = await exactProduct(state)
      expect(exact.authorization?.resolution.state).toBe("active")
      expect(exact.authorization?.coverage).toBe(
        failure === "failed" ? "unavailable" : "partial"
      )
      expect(exact.actionable).toBe(failure === "partial")
    })
  }

  it("keeps another merchant's retained authorization deletion out of an active merchant read", async () => {
    const state = fixture([
      merchantRow,
      { ...merchantRow, pubkey: spammer, assignment: "Booth 14" },
    ])
    const otherDraft = buildEventMarketAuthorizationDraft({
      marketCoordinate,
      merchantPubkey: spammer,
      state: "active",
      sequence: 0,
      parentIds: [],
    })
    const otherGrant = sign(
      organizerSecret,
      otherDraft.kind,
      otherDraft.tags,
      102
    )
    const otherDeletion = sign(organizerSecret, 5, [["e", otherGrant.id]], 103)
    state.live.push(
      otherGrant,
      otherDeletion,
      product(merchantSecret, merchant, "soap", 100),
      product(spammerSecret, spammer, "soap", 100)
    )
    for (const event of [grant(), otherGrant, otherDeletion])
      state.retained.set(event.id, event)

    const other = await readEventMarketAuthorization(
      { marketCoordinate, merchantPubkey: spammer },
      state.dependencies
    )
    expect(other.resolution.state).toBe("deleted")
    expect(other.coverage).toBe("complete")
    const active = await readEventMarketAuthorization(
      { marketCoordinate, merchantPubkey: merchant },
      state.dependencies
    )
    expect(active.resolution.state).toBe("active")
    expect(active.coverage).toBe("complete")
    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(catalog.coverage).toBe("complete")
    expect(catalog.products.map((entry) => entry.productCoordinate)).toEqual([
      productCoordinate,
      `30402:${spammer}:soap`,
    ])
    expect(catalog.products.every((entry) => !entry.actionable)).toBe(true)
  })

  it("keeps a retained candidate visible but stale when live discovery omits it", async () => {
    const state = fixture()
    const tagged = product(merchantSecret, merchant, "soap", 100)
    state.live.push(tagged)
    const initial = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(initial.products[0]?.actionable).toBe(false)
    expect(state.retained.has(tagged.id)).toBe(true)
    state.live.splice(state.live.indexOf(tagged), 1)

    const later = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(later.coverage).toBe("partial")
    expect(later.products).toHaveLength(1)
    expect(later.products[0]).toMatchObject({
      productCoordinate,
      resolution: { state: "candidate", revision: { id: tagged.id } },
      coverage: "stale",
      actionable: false,
    })
  })

  it("marks cache-only discovery partial without an exact product refresh", async () => {
    const state = fixture()
    const tagged = product(merchantSecret, merchant, "soap", 100)
    state.live.push(tagged)
    state.retained.set(tagged.id, tagged)
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      return filter.kinds?.includes(30402 as never) && filter["#a"]
        ? { ...result, events: [] }
        : result
    }

    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(catalog.coverage).toBe("partial")
    expect(catalog.products).toHaveLength(1)
    expect(catalog.products[0]?.coverage).toBe("stale")
    expect(catalog.products[0]?.actionable).toBe(false)
  })

  it("does not seed retained candidates from merchants outside the current roster", async () => {
    const state = fixture([])
    const tagged = product(merchantSecret, merchant, "soap", 100)
    state.retained.set(tagged.id, tagged)

    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(catalog.candidateCount).toBe(0)
    expect(catalog.products).toHaveLength(0)
    expect(catalog.coverage).toBe("complete")
  })

  for (const change of ["untagged", "deleted"] as const) {
    it(`does not restore a retained tagged product after known signed ${change} evidence`, async () => {
      const state = fixture()
      const tagged = product(merchantSecret, merchant, "soap", 100)
      state.live.push(tagged)
      const initial = await readEventMarketCatalog(
        { reference: marketCoordinate },
        state.dependencies
      )
      expect(initial.products[0]?.actionable).toBe(false)
      state.live.splice(state.live.indexOf(tagged), 1)
      const negative =
        change === "untagged"
          ? product(merchantSecret, merchant, "soap", 101, false)
          : sign(merchantSecret, 5, [["e", tagged.id]], 101)
      state.retained.set(negative.id, negative)

      const later = await readEventMarketCatalog(
        { reference: marketCoordinate },
        state.dependencies
      )
      expect(later.candidateCount).toBe(1)
      expect(later.coverage).toBe("partial")
      expect(later.products).toHaveLength(0)
      const exact = await readEventMarketProduct(
        { marketRead: later.marketRead, productCoordinate },
        state.dependencies
      )
      expect(exact.resolution.state).toBe(change)
      expect(exact.actionable).toBe(false)
    })
  }
  it("uses one organizer plan and one plain candidate query regardless of roster size", async () => {
    const rows = [
      merchantRow,
      ...Array.from({ length: 31 }, (_, index) => ({
        ...merchantRow,
        pubkey: (index + 1).toString(16).padStart(64, "0"),
      })),
    ]
    const state = fixture(rows)
    state.live.push(product(merchantSecret, merchant, "soap", 100))
    const queries: Filter[] = []
    const authors: string[] = []
    const plan = state.dependencies.plan
    const fetch = state.dependencies.fetch
    state.dependencies.plan = async (input) => {
      authors.push(input.organizerPubkey)
      return plan(input)
    }
    state.dependencies.fetch = async (filter, options) => {
      queries.push(filter as Filter)
      return fetch(filter, options)
    }
    state.dependencies.authorization = async () => {
      throw new Error("Discovery must not authorize products")
    }
    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(authors).toEqual([organizer])
    expect(queries.filter((filter) => filter.kinds?.includes(30402))).toEqual([
      { kinds: [30402], "#a": [marketCoordinate], limit: 48 },
    ])
    expect(queries.some((filter) => filter.kinds?.includes(3841))).toBe(false)
    expect(catalog.products[0]?.resolution.state).toBe("candidate")
    expect(catalog.products[0]?.actionable).toBe(false)
  })

  it("emits cached signed cards before relay planning finishes", async () => {
    const state = fixture()
    const tagged = product(merchantSecret, merchant, "soap", 100)
    for (const event of [...state.live, tagged])
      state.retained.set(event.id, event)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let observed!: () => void
    const progress = new Promise<void>((resolve) => {
      observed = resolve
    })
    const plan = state.dependencies.plan
    let completed = false
    state.dependencies.plan = async (input) => {
      await blocked
      return plan(input)
    }
    const read = readEventMarketCatalog(
      {
        reference: marketCoordinate,
        onProgress: (catalog) => {
          if (!completed) {
            expect(catalog.marketRead.coverage).toBe("stale")
            expect(catalog.products[0]).toMatchObject({
              coverage: "stale",
              resolution: { state: "candidate" },
              actionable: false,
            })
            observed()
          }
        },
      },
      state.dependencies
    )
    await progress
    completed = true
    release()
    await read
  })

  it("preserves live result order, filters authors locally, then fills from cache", async () => {
    const state = fixture()
    const first = product(merchantSecret, merchant, "first", 100)
    const second = product(merchantSecret, merchant, "second", 101)
    const cached = product(merchantSecret, merchant, "cached", 102)
    const spam = product(spammerSecret, spammer, "spam", 104)
    const hidden = product(merchantSecret, merchant, "hidden", 104, true, true)
    const malformed = product(merchantSecret, merchant, "malformed", 104)
    const forged = { ...malformed, content: "forged content" }
    const untagged = product(merchantSecret, merchant, "untagged", 104, false)
    state.retained.set(cached.id, cached)
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      return filter.kinds?.includes(30402 as never)
        ? { ...result, events: [spam, second, hidden, forged, untagged, first] }
        : result
    }
    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate },
      state.dependencies
    )
    expect(catalog.products.map((entry) => entry.productCoordinate)).toEqual([
      `30402:${merchant}:second`,
      `30402:${merchant}:first`,
      `30402:${merchant}:cached`,
    ])
    expect(catalog.products.map((entry) => entry.coverage)).toEqual([
      "complete",
      "complete",
      "stale",
    ])
    expect(state.retained.has(first.id)).toBe(true)
    expect(state.retained.has(spam.id)).toBe(false)
  })

  it("preserves semantic live matches and only fills search gaps with matching cache", async () => {
    const state = fixture()
    const live = sign(
      merchantSecret,
      30402,
      [
        ["d", "candle"],
        ["title", "Wax candle"],
        ["price", "12", "USD"],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
      ],
      100,
      "Aromatic wax"
    )
    const matchingCache = product(merchantSecret, merchant, "soap", 101)
    const otherCache = sign(
      merchantSecret,
      30402,
      [
        ["d", "unrelated"],
        ["title", "Unrelated item"],
        ["price", "12", "USD"],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
      ],
      102,
      "Unrelated item"
    )
    state.retained.set(matchingCache.id, matchingCache)
    state.retained.set(otherCache.id, otherCache)
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      return filter.kinds?.includes(30402 as never)
        ? { ...result, events: [live] }
        : result
    }
    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate, search: "soap" },
      state.dependencies
    )
    expect(catalog.products.map((entry) => entry.productCoordinate)).toEqual([
      `30402:${merchant}:candle`,
      `30402:${merchant}:soap`,
    ])
  })

  it("bounds lazy requests and reports more raw candidates despite whitelist underfill", async () => {
    const state = fixture()
    const spam = product(spammerSecret, spammer, "spam", 100)
    const filters: Filter[] = []
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      if (!filter.kinds?.includes(30402 as never)) return result
      filters.push(filter as Filter)
      return { ...result, events: Array(filter.limit).fill(spam) }
    }
    const catalog = await readEventMarketCatalog(
      { reference: marketCoordinate, limit: 2, search: "  soap  " },
      state.dependencies
    )
    expect(filters[0]).toEqual({
      kinds: [30402],
      "#a": [marketCoordinate],
      limit: 2,
      search: "soap",
    })
    expect(catalog.products).toHaveLength(0)
    expect(catalog.hasMore).toBe(true)
    await readEventMarketCatalog(
      { reference: marketCoordinate, limit: 999, search: "   " },
      state.dependencies
    )
    expect(filters[1]?.limit).toBe(256)
    expect(filters[1]).not.toHaveProperty("search")
    await readEventMarketCatalog(
      { reference: marketCoordinate, limit: 0 },
      state.dependencies
    )
    expect(filters[2]?.limit).toBe(1)
  })

  for (const change of ["untagged", "hidden", "deleted"] as const) {
    it(`rechecks a signed ${change} learned while discovery is waiting`, async () => {
      const state = fixture()
      const tagged = product(merchantSecret, merchant, "soap", 100)
      const negative =
        change === "deleted"
          ? sign(merchantSecret, 5, [["e", tagged.id]], 101)
          : product(
              merchantSecret,
              merchant,
              "soap",
              101,
              change !== "untagged",
              change === "hidden"
            )
      const fetch = state.dependencies.fetch
      state.dependencies.fetch = async (filter, options) => {
        const result = await fetch(filter, options)
        if (!filter.kinds?.includes(30402 as never)) return result
        state.retained.set(negative.id, negative)
        return { ...result, events: [tagged] }
      }
      const catalog = await readEventMarketCatalog(
        { reference: marketCoordinate },
        state.dependencies
      )
      expect(catalog.products).toHaveLength(0)
    })
  }

  it("does not publish late candidate progress after the session is cancelled", async () => {
    const state = fixture()
    let current = true
    let progress = 0
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      if (filter.kinds?.includes(30402 as never)) current = false
      return result
    }
    await expect(
      readEventMarketCatalog(
        {
          reference: marketCoordinate,
          shouldContinue: () => current,
          onProgress: () => {
            progress++
          },
        },
        state.dependencies
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(progress).toBe(0)
  })
})
