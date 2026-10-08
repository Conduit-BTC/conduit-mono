import { describe, expect, it } from "bun:test"
import {
  classifyAccountNetworkReadback,
  compareAccountNetworkRevisions,
  interpretAccountNetworkInboxRecovery,
  interpretAccountNetworkPreference,
  interpretAccountNetworkRead,
  mergeAccountNetworkLookup,
  summarizeAccountNetworkReadback,
} from "@conduit/core/protocol/account-network-evidence"
import { applyNetworkPreferenceDistributionOutcomes } from "@conduit/core/protocol/network-preference-delivery"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { admitFixture } from "./helpers/public-event"

const relay = "wss://evidence.synthetic.example"
const peer = "wss://peer.synthetic.example"

describe("canonical Account Network evidence", () => {
  it.each([
    ["auth_required", "auth_required"],
    ["timeout", "timed_out"],
    ["connect_timeout", "timed_out"],
    ["verification_failed", "verification_unavailable"],
    ["connect_error", "unavailable"],
    ["cancelled", "cancelled"],
  ] as const)(
    "preserves %s without inventing protocol absence",
    async (outcome, availability) => {
      const result = {
        events: [],
        attemptedRelayUrls: [relay],
        successfulRelayUrls: [],
        failedRelayUrls: [relay],
        relays: [
          {
            relayUrl: relay,
            status: "failed" as const,
            outcome,
            elapsedMs: 1,
            eventCount: 0,
          },
        ],
      }
      const read = interpretAccountNetworkRead([relay], result as never)
      expect(read.coverage).toBe("unavailable")
      expect(read.sources[0]?.availability).toBe(availability)
      const signedEvent = await admitFixture(
        finalizeEvent(
          { kind: 10050, created_at: 1, tags: [], content: "" },
          generateSecretKey()
        )
      )
      expect(
        classifyAccountNetworkReadback({
          relayUrl: relay,
          signedEvent,
          result: result as never,
        })
      ).toBe(availability)
      expect(
        interpretAccountNetworkPreference({
          lookup: { coverage: read.coverage, hadEvent: false },
        }).scopedAbsent
      ).toBe(false)
    }
  )

  it("only derives absence from a completed verified bounded query", () => {
    const complete = interpretAccountNetworkRead([relay], {
      events: [],
      successfulRelayUrls: [relay],
      failedRelayUrls: [],
    })
    expect(complete.coverage).toBe("complete")
    expect(
      interpretAccountNetworkPreference({
        lookup: { coverage: complete.coverage, hadEvent: false },
      }).scopedAbsent
    ).toBe(true)
    for (const observation of [
      { events: [], successfulRelayUrls: [relay], failedRelayUrls: [peer] },
      {
        events: [],
        successfulRelayUrls: [relay],
        failedRelayUrls: [],
        cappedRelayUrls: [relay],
      },
    ])
      expect(
        interpretAccountNetworkPreference({
          lookup: {
            coverage: interpretAccountNetworkRead([relay, peer], observation)
              .coverage,
            hadEvent: false,
          },
        }).scopedAbsent
      ).toBe(false)
    expect(
      interpretAccountNetworkRead(
        [relay],
        { events: [], successfulRelayUrls: [relay] },
        false
      ).coverage
    ).toBe("unavailable")
  })

  it("keeps explicit policy-blocked sources outside the completed admitted scope", () => {
    const read = interpretAccountNetworkRead([relay, peer], {
      events: [],
      admittedRelayUrls: [relay],
      successfulRelayUrls: [relay],
    })
    expect(read.coverage).toBe("complete")
    expect(read.scopeRelayUrls).toEqual([relay])
    expect(read.sources).toContainEqual({
      relayUrl: peer,
      availability: "policy_blocked",
    })
    expect(
      interpretAccountNetworkRead([peer], { events: [], admittedRelayUrls: [] })
        .coverage
    ).toBe("unavailable")
  })

  it("separates pending distribution from current, retained and freshness facts", () => {
    for (const coverage of ["complete", "partial", "unavailable"] as const) {
      const facts = interpretAccountNetworkPreference({
        current: { eventId: "current", state: "declared" },
        lastUsableEventId: "current",
        pendingEventId: "current",
        lookup: { coverage, hadEvent: false },
      })
      expect(facts.state).toBe("declared")
      expect(facts.currentUsable).toBe(true)
      expect(facts.retainedUsable).toBe(true)
      expect(facts.distributionPending).toBe(true)
      expect(facts.scopedAbsent).toBe(false)
      expect(facts.stale).toBe(true)
    }
  })

  it("preserves exact observation independently from a sibling transport outage", async () => {
    const event = await admitFixture(
      finalizeEvent(
        { kind: 10050, created_at: 1, tags: [["relay", relay]], content: "" },
        generateSecretKey()
      )
    )
    const result = {
      events: [event],
      successfulRelayUrls: [],
      failedRelayUrls: [relay],
      eventSourceRelayUrls: { [event.id]: [relay] },
    }
    expect(
      classifyAccountNetworkReadback({
        relayUrl: relay,
        signedEvent: event,
        result,
      })
    ).toBe("observed")
    expect(
      classifyAccountNetworkReadback({
        relayUrl: peer,
        signedEvent: event,
        result,
      })
    ).toBe("unavailable")
  })

  it("does not confuse distribution coverage with inbox count or require every target to store the event", () => {
    const outcomes = Array.from({ length: 7 }, (_, i) => ({
      relayUrl: `wss://target${i}.example`,
      readbackStatus:
        i < 6 ? ("observed" as const) : ("auth_required" as const),
    }))
    expect(summarizeAccountNetworkReadback(outcomes)).toMatchObject({
      exactReadbackCount: 6,
      unresolvedCount: 1,
      eligibleTargetCount: 7,
      authRequiredCount: 1,
      confirmed: false,
    })
    outcomes[6]!.readbackStatus = "absent" as never
    expect(summarizeAccountNetworkReadback(outcomes)).toMatchObject({
      absentCount: 1,
      unresolvedCount: 0,
      confirmed: true,
    })
    expect(
      summarizeAccountNetworkReadback(outcomes, [outcomes[6]!.relayUrl])
        .confirmed
    ).toBe(false)
  })

  it("keeps exact evidence monotonic while allowing an inconclusive reason to change on retry", () => {
    const initial = [
      {
        relayUrl: relay,
        publishStatus: "acked" as const,
        publishAttemptCount: 1,
        readbackStatus: "auth_required" as const,
        readbackAttemptCount: 1,
      },
    ]
    const retried = applyNetworkPreferenceDistributionOutcomes(initial, {
      observedAt: 10,
      readback: [{ relayUrl: relay, status: "timed_out" }],
    })
    expect(retried[0]?.publishStatus).toBe("acked")
    expect(retried[0]?.readbackStatus).toBe("timed_out")
    const exact = applyNetworkPreferenceDistributionOutcomes(retried, {
      observedAt: 11,
      readback: [{ relayUrl: relay, status: "observed" }],
    })
    expect(
      applyNetworkPreferenceDistributionOutcomes(exact, {
        observedAt: 12,
        readback: [{ relayUrl: relay, status: "verification_unavailable" }],
      })[0]?.readbackStatus
    ).toBe("observed")
  })

  it("chooses the same replaceable frontier and conservative concurrent lookup in either order", () => {
    expect(
      compareAccountNetworkRevisions(
        { created_at: 2, id: "z" },
        { created_at: 1, id: "a" }
      )
    ).toBe(1)
    expect(
      compareAccountNetworkRevisions(
        { created_at: 2, id: "a" },
        { created_at: 2, id: "z" }
      )
    ).toBe(1)
    const exact = {
      observedAt: 10,
      coverage: "complete" as const,
      hadEvent: true,
      eventId: "current",
    }
    const outage = {
      observedAt: 10,
      coverage: "unavailable" as const,
      hadEvent: false,
    }
    expect(mergeAccountNetworkLookup(exact, outage, "current")).toEqual(
      mergeAccountNetworkLookup(outage, exact, "current")
    )
    expect(mergeAccountNetworkLookup(exact, outage, "current").coverage).toBe(
      "unavailable"
    )
  })

  it("starts recovery language only from actual independent batch clocks", () => {
    expect(interpretAccountNetworkInboxRecovery([], 100)).toEqual([])
    expect(
      interpretAccountNetworkInboxRecovery([{ relayUrls: [relay] }], 100)
    ).toEqual([{ relayUrl: relay, phase: "awaiting_confirmation" }])
    expect(
      interpretAccountNetworkInboxRecovery(
        [{ relayUrls: [relay], readbackObservedAt: 90, expiresAt: 200 }],
        100
      )
    ).toEqual([{ relayUrl: relay, phase: "grace", expiresAt: 200 }])
    expect(
      interpretAccountNetworkInboxRecovery(
        [
          { relayUrls: [relay], readbackObservedAt: 90, expiresAt: 200 },
          { relayUrls: [relay] },
        ],
        100
      )[0]?.phase
    ).toBe("awaiting_confirmation")
    expect(
      interpretAccountNetworkInboxRecovery(
        [{ relayUrls: [relay], readbackObservedAt: 90, expiresAt: 200 }],
        200
      )
    ).toEqual([])
  })

  it("retains distinguishable concurrent read failures in either completion order", () => {
    const auth = {
      observedAt: 10,
      coverage: "unavailable" as const,
      hadEvent: false,
      sources: [{ relayUrl: relay, availability: "auth_required" as const }],
    }
    const offline = {
      observedAt: 10,
      coverage: "unavailable" as const,
      hadEvent: false,
      sources: [
        { relayUrl: relay, availability: "unavailable" as const },
        { relayUrl: peer, availability: "timed_out" as const },
      ],
    }
    const merged = mergeAccountNetworkLookup(auth, offline)
    expect(merged).toEqual(mergeAccountNetworkLookup(offline, auth))
    expect(merged.sources).toContainEqual({
      relayUrl: relay,
      availability: "auth_required",
    })
    expect(merged.sources).toContainEqual({
      relayUrl: peer,
      availability: "timed_out",
    })
  })
})
