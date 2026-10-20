import { describe, expect, it } from "bun:test"
import { matchFilter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  isEventMarketAuthorizationWriteReady,
  isEventMarketCalendarWriteReady,
  isEventMarketRosterWriteReady,
  publishEventMarketMerchantDecision,
  publishEventMarketRoster,
  readEventMarketAuthorization,
  readEventMarketRoster,
  type SignedPublicNostrEvent,
} from "@conduit/core"

function fixture(initiallyApproved = true) {
  const secret = generateSecretKey()
  const organizer = getPublicKey(secret)
  const merchant = getPublicKey(generateSecretKey())
  const marketCoordinate = `30409:${organizer}:optional-peer-market`
  const calendarCoordinate = `31923:${organizer}:optional-peer-date`
  const row = {
    pubkey: merchant,
    mode: "merchant_present" as const,
    assignment: "Booth 1",
  }
  const roster = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "optional-peer-market",
        organizerPubkey: organizer,
        calendarCoordinate,
        state: "open",
        merchants: initiallyApproved ? [row] : [],
      }),
      created_at: 100,
    },
    secret
  )
  const grant = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "active",
        sequence: 0,
        parentIds: [],
      }),
      created_at: 100,
    },
    secret
  )
  const calendar = finalizeEvent(
    {
      kind: 31923,
      created_at: 100,
      content: "",
      tags: [
        ["d", "optional-peer-date"],
        ["title", "Optional peer fair"],
        ["start", "1900000000"],
        ["end", "1900003600"],
        ["D", String(Math.floor(1_900_000_000 / 86_400))],
      ],
    },
    secret
  )
  const live = initiallyApproved
    ? [roster, grant, calendar]
    : [roster, calendar]
  const retained = new Map<string, SignedPublicNostrEvent>()
  const state: {
    optionalFailed: boolean
    truncated: boolean
    retentionFailed: boolean
    failedScope?:
      | "roster deletion"
      | "calendar deletion"
      | "authorization deletion"
      | "authorization exact deletion"
  } = { optionalFailed: true, truncated: false, retentionFailed: false }
  const dependencies: NonNullable<Parameters<typeof readEventMarketRoster>[1]> =
    {
      plan: async () => ({
        relayUrls: ["wss://ready.example", "wss://optional.example"],
        candidateRelayUrls: ["wss://ready.example", "wss://optional.example"],
        ownerSelectedRelayUrls: [],
        appRelayUrls: ["wss://ready.example"],
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayListState: "missing",
        relayHintTruncated: state.truncated,
      }),
      fetch: async (filter) => {
        const scope =
          filter.kinds?.[0] !== 5
            ? undefined
            : filter["#e"]
              ? filter["#e"].includes(grant.id)
                ? "authorization exact deletion"
                : undefined
              : filter["#p"]
                ? "authorization deletion"
                : filter["#a"]?.includes(calendarCoordinate)
                  ? "calendar deletion"
                  : "roster deletion"
        const failed = !!state.failedScope && scope === state.failedScope
        return {
          events: failed
            ? []
            : live.filter((event) => matchFilter(filter, event)),
          relays: [
            {
              relayUrl: "wss://ready.example",
              status: failed ? "failed" : "success",
            },
            {
              relayUrl: "wss://optional.example",
              status: state.optionalFailed || failed ? "failed" : "success",
            },
          ],
        }
      },
      load: async () => [...retained.values()],
      retain: async (_coordinate, events) => {
        if (state.retentionFailed)
          throw new Error("Controlled retention failure")
        for (const event of events) retained.set(event.id, event)
      },
    }
  const read = (query: Parameters<typeof readEventMarketRoster>[0]) =>
    readEventMarketRoster(query, dependencies)
  const readAuthorization = (
    query: Parameters<typeof readEventMarketAuthorization>[0]
  ) => readEventMarketAuthorization(query, dependencies)
  const effects: string[] = []
  const decide = (shouldContinue = () => true) =>
    publishEventMarketMerchantDecision(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "optional-peer-market",
        calendarCoordinate,
        merchantPubkey: merchant,
        action: initiallyApproved ? "revoke" : "approve",
        ...(!initiallyApproved ? { row } : {}),
        expectedPreviousEventId: roster.id,
        expectedAuthorizationTipIds: initiallyApproved ? [grant.id] : [],
        shouldContinue,
      },
      {
        read,
        readAuthorization,
        sign: async ({ draft, createdAt }) => {
          effects.push("sign")
          return finalizeEvent({ ...draft, created_at: createdAt }, secret)
        },
        publish: async (event) => {
          effects.push(event.kind === 3841 ? "revoke" : "remove")
          return { successfulRelayUrls: ["wss://ready.example"] } as never
        },
        persist: async () => {
          effects.push("save")
        },
        load: async () => undefined,
        acknowledge: async () => {
          effects.push("ack")
        },
      }
    )
  return {
    live,
    retained,
    state,
    dependencies,
    read,
    readAuthorization,
    decide,
    effects,
    roster,
    grant,
    calendar,
    marketCoordinate,
    calendarCoordinate,
    merchant,
    organizer,
    secret,
  }
}

describe("Event Market organizer write readiness", () => {
  it("publishes the same current causal decision when an optional peer fails", async () => {
    const f = fixture()
    const roster = await f.read({ reference: f.marketCoordinate })
    const authorization = await f.readAuthorization({
      marketCoordinate: f.marketCoordinate,
      merchantPubkey: f.merchant,
    })
    expect(roster.coverage).toBe("partial")
    expect(authorization.coverage).toBe("partial")
    expect(authorization.actionable).toBe(true)
    expect(isEventMarketRosterWriteReady(roster)).toBe(true)
    expect(isEventMarketCalendarWriteReady(roster)).toBe(true)
    expect(isEventMarketAuthorizationWriteReady(authorization)).toBe(true)
    const result = await f.decide()
    expect(result.signed.action).toBe("revoke")
    expect(f.effects).toEqual([
      "sign",
      "sign",
      "save",
      "revoke",
      "remove",
      "ack",
    ])
  })

  it("keeps fee editing available through the same checked optional-peer readiness", async () => {
    const f = fixture()
    const input = {
      organizerPubkey: f.organizer,
      authenticatedPubkey: f.organizer,
      dTag: "optional-peer-market",
      calendarCoordinate: f.calendarCoordinate,
      state: "open" as const,
      merchants: [
        {
          pubkey: f.merchant,
          mode: "merchant_present" as const,
          assignment: "Booth 1",
        },
      ],
      organizerFee: { state: "disabled" as const },
      expectedPreviousEventId: f.roster.id,
      onSignedLocal: async () => {
        f.effects.push("save")
      },
    }
    const dependencies = {
      read: f.read,
      sign: async ({
        draft,
        createdAt,
      }: Parameters<
        NonNullable<Parameters<typeof publishEventMarketRoster>[1]>["sign"]
      >[0]) => {
        f.effects.push("sign")
        return finalizeEvent({ ...draft, created_at: createdAt }, f.secret)
      },
      publish: async () => {
        f.effects.push("publish")
        return { successfulRelayUrls: ["wss://ready.example"] } as never
      },
    }
    const result = await publishEventMarketRoster(input, dependencies)
    expect(
      result.signedEvent.tags.some(
        (tag) => tag[0] === "conduit_event_fee" && tag[2] === "disabled"
      )
    ).toBe(true)
    expect(f.effects).toEqual(["sign", "save", "publish"])
    f.effects.length = 0
    f.state.truncated = true
    await expect(publishEventMarketRoster(input, dependencies)).rejects.toThrow(
      "needs organizer review"
    )
    expect(f.effects).toEqual([])
  })

  it.each([
    "roster deletion",
    "authorization deletion",
    "authorization exact deletion",
  ] as const)(
    "does not sign when the required %s scope has no completed source",
    async (scope) => {
      const f = fixture()
      f.state.failedScope = scope
      await expect(f.decide()).rejects.toThrow("needs organizer review")
      expect(f.effects).toEqual([])
    }
  )

  it("keeps calendar controls unavailable if its deletion scope has no completed source", async () => {
    const f = fixture()
    f.state.failedScope = "calendar deletion"
    const read = await f.read({ reference: f.marketCoordinate })
    expect(isEventMarketRosterWriteReady(read)).toBe(true)
    expect(isEventMarketCalendarWriteReady(read)).toBe(false)
  })

  it.each(["roster", "calendar"] as const)(
    "does not use a saturated %s deletion query as write-ready evidence",
    async (target) => {
      const f = fixture()
      for (let index = 1; index <= 64; index++)
        f.live.push(
          finalizeEvent(
            {
              kind: 5,
              created_at: index,
              content: "",
              tags: [
                [
                  "a",
                  target === "roster"
                    ? f.marketCoordinate
                    : f.calendarCoordinate,
                ],
              ],
            },
            f.secret
          )
        )
      const read = await f.read({ reference: f.marketCoordinate })
      expect(read.resolution.state).toBe("current")
      if (target === "roster") {
        expect(read.writeObservation?.limited).toBe(true)
        expect(isEventMarketRosterWriteReady(read)).toBe(false)
        expect(f.effects).toEqual([])
      } else {
        expect(read.calendar).not.toBeNull()
        expect(read.calendarWriteObservation?.limited).toBe(true)
        expect(isEventMarketCalendarWriteReady(read)).toBe(false)
      }
    }
  )

  it("keeps a stale or deleted calendar unavailable without erasing its signed evidence", async () => {
    const f = fixture()
    f.retained.set(f.calendar.id, f.calendar)
    f.live.splice(f.live.indexOf(f.calendar), 1)
    const stale = await f.read({ reference: f.marketCoordinate })
    expect(stale.calendarCoverage).toBe("stale")
    expect(isEventMarketCalendarWriteReady(stale)).toBe(false)
    f.live.push(
      f.calendar,
      finalizeEvent(
        {
          kind: 5,
          created_at: 101,
          content: "",
          tags: [["a", f.calendarCoordinate]],
        },
        f.secret
      )
    )
    f.state.optionalFailed = false
    const deleted = await f.read({ reference: f.marketCoordinate })
    expect(deleted.calendar).toBeNull()
    expect(isEventMarketCalendarWriteReady(deleted)).toBe(false)
  })

  it("does not treat unclassified partial coverage as permission to write", async () => {
    const f = fixture()
    const roster = await f.read({ reference: f.marketCoordinate })
    const authorization = await f.readAuthorization({
      marketCoordinate: f.marketCoordinate,
      merchantPubkey: f.merchant,
    })
    expect(
      isEventMarketRosterWriteReady({ ...roster, writeObservation: undefined })
    ).toBe(false)
    expect(
      isEventMarketCalendarWriteReady({
        ...roster,
        calendarWriteObservation: undefined,
      })
    ).toBe(false)
    expect(
      isEventMarketAuthorizationWriteReady({
        ...authorization,
        writeObservation: undefined,
      })
    ).toBe(false)
  })

  it.each([
    "truncation",
    "retention",
    "stale roster",
    "known roster deletion",
    "missing authorization parent",
    "conflicting authorization",
    "known revocation",
  ] as const)(
    "blocks %s before requesting any signature or write",
    async (failure) => {
      const f = fixture()
      if (failure === "truncation") f.state.truncated = true
      if (failure === "retention") f.state.retentionFailed = true
      if (failure === "stale roster") {
        f.retained.set(f.roster.id, f.roster)
        f.live.splice(f.live.indexOf(f.roster), 1)
      }
      if (failure === "known roster deletion")
        f.retained.set(
          "deletion",
          finalizeEvent(
            {
              kind: 5,
              created_at: 101,
              content: "",
              tags: [["a", f.marketCoordinate]],
            },
            f.secret
          )
        )
      if (failure === "missing authorization parent") {
        const parent = finalizeEvent(
          { kind: 1, created_at: 99, content: "missing", tags: [] },
          f.secret
        )
        f.live.splice(
          f.live.indexOf(f.grant),
          1,
          finalizeEvent(
            {
              ...buildEventMarketAuthorizationDraft({
                marketCoordinate: f.marketCoordinate,
                merchantPubkey: f.merchant,
                state: "active",
                sequence: 1,
                parentIds: [parent.id],
              }),
              created_at: 101,
            },
            f.secret
          )
        )
      }
      if (failure === "conflicting authorization")
        f.live.push(finalizeEvent({ ...f.grant, created_at: 101 }, f.secret))
      if (failure === "known revocation")
        f.retained.set(
          "revoke",
          finalizeEvent(
            {
              ...buildEventMarketAuthorizationDraft({
                marketCoordinate: f.marketCoordinate,
                merchantPubkey: f.merchant,
                state: "revoked",
                sequence: 1,
                parentIds: [f.grant.id],
              }),
              created_at: 101,
            },
            f.secret
          )
        )
      await expect(f.decide()).rejects.toThrow()
      expect(f.effects).toEqual([])
    }
  )

  it("does not promote missing authorization under partial coverage into a new root grant", async () => {
    const f = fixture(false)
    const read = await f.readAuthorization({
      marketCoordinate: f.marketCoordinate,
      merchantPubkey: f.merchant,
    })
    expect(read.resolution.state).toBe("missing")
    expect(read.coverage).toBe("partial")
    expect(isEventMarketAuthorizationWriteReady(read)).toBe(false)
    await expect(f.decide()).rejects.toThrow("needs organizer review")
    expect(f.effects).toEqual([])
    f.state.optionalFailed = false
    expect((await f.decide()).signed.action).toBe("approve")
  })

  it("does not ask a signer after the organizer session is cancelled", async () => {
    const f = fixture()
    let current = true
    const fetch = f.dependencies.fetch
    f.dependencies.fetch = async (filter, options) => {
      const result = await fetch(filter, options)
      current = false
      return result
    }
    await expect(f.decide(() => current)).rejects.toThrow("session changed")
    expect(f.effects).toEqual([])
  })
})
