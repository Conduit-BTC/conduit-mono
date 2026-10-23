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
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  getEventMarketDiscoveryReadPlan,
  getEventMarketReadPlan,
} from "../packages/core/src/protocol/event-market"
import {
  __resetRelayHealth,
  recordRelayFailure,
} from "../packages/core/src/protocol/relay-health"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"

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

async function expectFeeWriteBlocked(
  f: ReturnType<typeof fixture>,
  current: Awaited<ReturnType<typeof readEventMarketRoster>>,
  reason: string
) {
  await expect(
    publishEventMarketRoster(
      {
        organizerPubkey: f.organizer,
        authenticatedPubkey: f.organizer,
        dTag: "optional-peer-market",
        calendarCoordinate: f.calendarCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: f.merchant,
            mode: "merchant_present",
            assignment: "Booth 1",
          },
        ],
        organizerFee: {
          state: "active",
          basisPoints: 500,
          minimumSats: 0,
          lightningAddress: "organizer@example.com",
        },
        expectedPreviousEventId: f.roster.id,
        onSignedLocal: async () => {
          f.effects.push("save")
        },
      },
      {
        read: async () => current,
        sign: async () => {
          f.effects.push("sign")
          throw new Error("Unexpected signing")
        },
        publish: async () => {
          f.effects.push("publish")
          throw new Error("Unexpected publication")
        },
      }
    )
  ).rejects.toThrow(
    `Current signed Event Market authority needs organizer review. ${reason}`
  )
  expect(f.effects).toEqual([])
}

describe("Event Market organizer write readiness", () => {
  it("keeps a fully observed nine-source roster writable beyond the eight-source prefix", async () => {
    const f = fixture()
    const organizerHints = Array.from(
      { length: 9 },
      (_, index) => `wss://organizer-source-${index}.relay.dev`
    )
    const observed: Awaited<
      ReturnType<typeof fetchSignedEventsFanoutDetailed>
    >[] = []
    __resetRelayHealth()
    __setEventMarketTestOverrides({
      getRelayListsDetailed: async () => ({
        relayLists: new Map([
          [
            f.organizer,
            {
              pubkey: f.organizer,
              writeRelayUrls: organizerHints,
              readRelayUrls: [],
              eventCreatedAt: 100,
              cachedAt: Date.now(),
            },
          ],
        ]),
        resolutionStates: new Map([[f.organizer, "network"]]),
      }),
    })
    try {
      const plan = await getEventMarketReadPlan({
        organizerPubkey: f.organizer,
      })
      expect(plan.relayUrls).toHaveLength(8)
      expect(plan.maxRelayAttempts).toBe(8)
      expect(plan.candidateRelayUrls).toEqual(
        expect.arrayContaining(organizerHints)
      )
      const discoveryPlan = await getEventMarketDiscoveryReadPlan({
        organizerPubkeys: [f.organizer],
      })
      expect(discoveryPlan.candidateRelayUrls).toEqual(
        expect.arrayContaining(organizerHints)
      )
      expect(discoveryPlan.maxRelayAttempts).toBe(8)
      expect(discoveryPlan.relayHintTruncated).toBe(false)
      f.dependencies.plan = async () => plan
      f.dependencies.fetch = async (filter, options) => {
        const result = await fetchSignedEventsFanoutDetailed(filter, {
          ...options,
          reuseRelayConnections: false,
          connectTimeoutMs: 100,
          fetchTimeoutMs: 100,
          socketScope: {
            createWebSocket: () => {
              const socket: PublicRelayReadSocket = {
                readyState: 0,
                onopen: null,
                onmessage: null,
                onerror: null,
                onclose: null,
                send: (payload) => {
                  const [type, id] = JSON.parse(payload)
                  if (type !== "REQ") return
                  queueMicrotask(() => {
                    for (const event of f.live)
                      if (matchFilter(filter, event))
                        socket.onmessage?.({
                          data: JSON.stringify(["EVENT", id, event]),
                        } as MessageEvent<string>)
                    socket.onmessage?.({
                      data: JSON.stringify(["EOSE", id]),
                    } as MessageEvent<string>)
                  })
                },
                close: () => {
                  socket.readyState = 3
                },
              }
              queueMicrotask(() => {
                socket.readyState = 1
                socket.onopen?.(new Event("open"))
              })
              return socket
            },
          },
        })
        observed.push(result)
        return result
      }
      const read = await f.read({ reference: f.marketCoordinate })
      expect(observed).toHaveLength(6)
      for (const result of observed) {
        expect(result.admittedRelayUrls).toEqual(
          expect.arrayContaining(organizerHints)
        )
        expect(result.attemptedRelayUrls).toEqual(
          expect.arrayContaining(organizerHints)
        )
        expect(result.readCoverage).toBe("complete")
      }
      expect(read.resolution.state).toBe("current")
      expect(read.retained).toBe(true)
      expect(read.writeObservation?.selectedLive).toBe(true)
      expect(read.writeObservation?.scopesChecked).toBe(true)
      expect({
        relayHintTruncated: plan.relayHintTruncated,
        limited: read.writeObservation?.limited,
        writeReady: isEventMarketRosterWriteReady(read),
      }).toEqual({
        relayHintTruncated: false,
        limited: false,
        writeReady: true,
      })
    } finally {
      __resetEventMarketTestOverrides()
      __resetPublicReaderTestState()
      __resetRelayHealth()
    }
  })

  it("keeps a genuinely excluded organizer source limited in both plans", async () => {
    const f = fixture()
    const healthy = "wss://healthy-organizer.relay.dev"
    const parked = "wss://parked-organizer.relay.dev"
    __resetRelayHealth()
    recordRelayFailure(parked)
    recordRelayFailure(parked)
    __setEventMarketTestOverrides({
      getRelayListsDetailed: async () => ({
        relayLists: new Map([
          [
            f.organizer,
            {
              pubkey: f.organizer,
              writeRelayUrls: [healthy, parked],
              readRelayUrls: [],
              eventCreatedAt: 100,
              cachedAt: Date.now(),
            },
          ],
        ]),
        resolutionStates: new Map([[f.organizer, "network"]]),
      }),
    })
    try {
      const plan = await getEventMarketReadPlan({
        organizerPubkey: f.organizer,
      })
      const discoveryPlan = await getEventMarketDiscoveryReadPlan({
        organizerPubkeys: [f.organizer],
      })
      for (const selected of [plan, discoveryPlan]) {
        expect(selected.candidateRelayUrls).toContain(healthy)
        expect(selected.candidateRelayUrls).not.toContain(parked)
        expect(selected.relayHintTruncated).toBe(true)
      }
      f.dependencies.plan = async () => plan
      const read = await f.read({ reference: f.marketCoordinate })
      expect(read.writeObservation?.selectedLive).toBe(true)
      expect(read.writeObservation?.scopesChecked).toBe(true)
      expect(read.writeObservation?.limited).toBe(true)
      expect(isEventMarketRosterWriteReady(read)).toBe(false)
    } finally {
      __resetEventMarketTestOverrides()
      __resetRelayHealth()
    }
  })

  it("explains failed local retention before signing a fee change", async () => {
    const f = fixture()
    const current = await f.read({ reference: f.marketCoordinate })
    current.retained = false
    await expectFeeWriteBlocked(
      f,
      current,
      "This browser could not read or save the signed event records. No new change was signed. Check browser storage, then refresh event records before trying again."
    )
  })

  it.each([
    [
      "conflicting",
      "Conflicting signed event revisions need review. No new change was signed. Refresh event records and review those revisions before trying again.",
    ],
    [
      "malformed",
      "The current signed event record has invalid details. No new change was signed. Refresh event records and review the organizer's event before trying again.",
    ],
    [
      "deleted",
      "The current event has a signed deletion. No new change was signed. Refresh event records and review that deletion before making another change.",
    ],
  ] as const)(
    "explains %s signed authority without signing a fee change",
    async (state, reason) => {
      const f = fixture()
      const current = await f.read({ reference: f.marketCoordinate })
      current.resolution = { state, eventId: f.roster.id }
      await expectFeeWriteBlocked(f, current, reason)
    }
  )

  it.each([
    [
      "limited history or sources",
      {
        writeObservation: {
          selectedLive: true,
          limited: true,
          scopesChecked: true,
        },
      },
      "The event check reached its history or source limit. No new change was signed. Refresh event records and review the latest signed event before trying again.",
    ],
    [
      "stale selected revision",
      {
        coverage: "stale",
        writeObservation: {
          selectedLive: false,
          limited: false,
          scopesChecked: true,
        },
      },
      "The latest signed event revision was not observed in the current check. No new change was signed. Refresh event records; if offered, retry signed market delivery before trying again.",
    ],
    [
      "selected revision not observed live",
      {
        writeObservation: {
          selectedLive: false,
          limited: false,
          scopesChecked: true,
        },
      },
      "The latest signed event revision was not observed in the current check. No new change was signed. Refresh event records; if offered, retry signed market delivery before trying again.",
    ],
    [
      "required scope unchecked",
      {
        writeObservation: {
          selectedLive: true,
          limited: false,
          scopesChecked: false,
        },
      },
      "A required signed-event check could not complete. No new change was signed. Refresh event records before trying again.",
    ],
    [
      "unavailable sources",
      {
        coverage: "unavailable",
        writeObservation: {
          selectedLive: false,
          limited: false,
          scopesChecked: false,
        },
      },
      "A required signed-event check could not complete. No new change was signed. Refresh event records before trying again.",
    ],
    [
      "unclassified partial coverage",
      { writeObservation: undefined },
      "A required signed-event check could not complete. No new change was signed. Refresh event records before trying again.",
    ],
  ] as const)(
    "explains %s without signing a fee change",
    async (_condition, observed, reason) => {
      const f = fixture()
      const current = await f.read({ reference: f.marketCoordinate })
      await expectFeeWriteBlocked(f, { ...current, ...observed }, reason)
    }
  )

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

  it("keeps history beyond the exact-deletion revision budget limited", async () => {
    const f = fixture()
    let previous = f.roster
    for (let index = 1; index <= 32; index++) {
      previous = finalizeEvent(
        {
          ...f.roster,
          created_at: 100 + index,
          tags: [...f.roster.tags, ["prev", previous.id]],
        },
        f.secret
      )
      f.live.push(previous)
    }
    const read = await f.read({ reference: f.marketCoordinate })
    expect(read.resolution.state).toBe("current")
    expect(read.writeObservation?.selectedLive).toBe(true)
    expect(read.writeObservation?.scopesChecked).toBe(true)
    expect(read.writeObservation?.limited).toBe(true)
    expect(isEventMarketRosterWriteReady(read)).toBe(false)
    expect(f.effects).toEqual([])
  })

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
