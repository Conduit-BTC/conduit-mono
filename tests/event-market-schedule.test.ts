import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketSeriesDraft,
  parseEventMarketSeriesEvent,
  resolveEventMarketOccurrence,
  resolveEventMarketSeries,
  publishFutureEventMarketSeries,
  buildEventMarketRosterDraft,
  readEventMarketRoster,
} from "@conduit/core"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const otherSecret = generateSecretKey()
const other = getPublicKey(otherSecret)
const masterCoordinate = `31924:${organizer}:weekly`
const first = `31923:${organizer}:first`
const second = `31923:${organizer}:second`

function sign(kind: number, tags: string[][], createdAt: number) {
  return finalizeEvent(
    { kind, tags, content: "", created_at: createdAt },
    secret
  )
}

function master(members: string[], createdAt: number) {
  const draft = buildEventMarketSeriesDraft({
    dTag: "weekly",
    organizerPubkey: organizer,
    title: "Weekly market",
    memberCoordinates: members,
  })
  return sign(draft.kind, draft.tags, createdAt)
}

function occurrence(dTag: string, createdAt: number) {
  return sign(
    31923,
    [
      ["d", dTag],
      ["title", "Weekly market"],
      ["start", String(1_800_000_000 + createdAt * 86_400)],
      ["end", String(1_800_003_600 + createdAt * 86_400)],
      ["D", String(Math.floor((1_800_000_000 + createdAt * 86_400) / 86_400))],
    ],
    createdAt
  )
}

describe("finite Event Market schedule", () => {
  it("accepts one organizer-authored 31924 with unique full member coordinates", () => {
    const signed = master([first, second], 10)
    expect(parseEventMarketSeriesEvent(signed)).toMatchObject({
      coordinate: masterCoordinate,
      memberCoordinates: [first, second],
    })
    expect(() => master([first, first], 11)).toThrow()
    expect(() => master([`31923:${other}:foreign`], 11)).toThrow()
    expect(() => master([], 11)).toThrow()
  })

  it("takes membership only from the current signed master revision", () => {
    const original = master([first, second], 10)
    const reduced = master([second], 11)
    const resolved = resolveEventMarketSeries({
      coordinate: masterCoordinate,
      organizerPubkey: organizer,
      revisions: [original, reduced],
    })
    expect(resolved.state).toBe("current")
    if (resolved.state === "current") {
      expect(resolved.series.eventId).toBe(reduced.id)
      expect(resolved.series.memberCoordinates).toEqual([second])
    }
    const childRequest = sign(
      31923,
      [
        ["d", "first"],
        ["a", masterCoordinate],
      ],
      12
    )
    expect(parseEventMarketSeriesEvent(childRequest)).toBeNull()
  })

  it("preserves a verified sibling when another member is absent", () => {
    const signed = occurrence("first", 10)
    expect(
      resolveEventMarketOccurrence({
        coordinate: first,
        organizerPubkey: organizer,
        revisions: [signed],
      })?.signedEvent.id
    ).toBe(signed.id)
    expect(
      resolveEventMarketOccurrence({
        coordinate: second,
        organizerPubkey: organizer,
        revisions: [signed],
      })
    ).toBeNull()
  })

  it("rejects a signed deletion of the current master", () => {
    const signed = master([first], 10)
    const deletion = sign(5, [["e", signed.id]], 11)
    expect(
      resolveEventMarketSeries({
        coordinate: masterCoordinate,
        organizerPubkey: organizer,
        revisions: [signed],
        deletions: [deletion],
      }).state
    ).toBe("deleted")
  })

  it("saves and publishes occurrences before the schedule, then resumes identical signatures", async () => {
    const saved: ReturnType<typeof sign>[] = []
    const sequence: string[] = []
    const outcomes: string[] = []
    let failSecond = true
    let signCount = 0
    const dependencies = {
      read: async () => {
        throw new Error("An initial schedule must not read a market.")
      },
      sign: async ({
        draft,
        createdAt,
      }: {
        draft: { kind: number; tags: string[][]; content: string }
        createdAt: number
      }) => {
        signCount += 1
        return finalizeEvent({ ...draft, created_at: createdAt }, secret)
      },
      publish: async (event: ReturnType<typeof sign>) => {
        sequence.push(
          `publish:${event.kind}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
        )
        const failed =
          event.kind === 31922 &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === "second") &&
          failSecond
        return {
          plan: {} as never,
          attemptedRelayUrls: ["wss://example.com"],
          successfulRelayUrls: failed ? [] : ["wss://example.com"],
          failedRelayUrls: failed ? ["wss://example.com"] : [],
          relayFailureMessages: failed
            ? { "wss://example.com": "No acknowledgement before timeout" }
            : {},
        }
      },
    }
    const input = {
      organizerPubkey: organizer,
      authenticatedPubkey: organizer,
      scheduleDTag: "weekly",
      title: "Weekly market",
      newOccurrences: [
        {
          kind: 31922 as const,
          dTag: "first",
          title: "First",
          start: "2030-01-01",
        },
        {
          kind: 31922 as const,
          dTag: "second",
          title: "Second",
          start: "2030-01-08",
        },
      ],
      onSignedLocal: async (event: ReturnType<typeof sign>) => {
        sequence.push(
          `save:${event.kind}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
        )
        saved.push(event)
      },
      onDelivery: ({
        record,
        index,
        delivery,
      }: {
        record: "occurrence" | "schedule"
        index?: number
        delivery: { acknowledged: number; timedOut: number }
      }) =>
        outcomes.push(
          `${record}:${index ?? 0}:${delivery.acknowledged}:${delivery.timedOut}`
        ),
    }
    await expect(
      publishFutureEventMarketSeries(input, dependencies as never)
    ).rejects.toThrow("saved for exact retry")
    expect(signCount).toBe(2)
    expect(outcomes).toEqual(["occurrence:1:1:0", "occurrence:2:0:1"])
    expect(sequence).toEqual([
      "save:31922:first",
      "publish:31922:first",
      "save:31922:second",
      "publish:31922:second",
    ])
    failSecond = false
    sequence.length = 0
    const resumed = await publishFutureEventMarketSeries(
      { ...input, savedSignedEvents: saved },
      dependencies as never
    )
    expect(resumed.occurrences.map((entry) => entry.signedEvent.id)).toEqual(
      saved.slice(0, 2).map((event) => event.id)
    )
    expect(signCount).toBe(3)
    expect(outcomes.slice(2)).toEqual([
      "occurrence:1:1:0",
      "occurrence:2:1:0",
      "schedule:0:1:0",
    ])
    expect(sequence).toEqual([
      "publish:31922:first",
      "publish:31922:second",
      "save:31924:weekly",
      "publish:31924:weekly",
    ])
  })

  it("keeps one verified date when a sibling is missing from a bounded read", async () => {
    const rosterDraft = buildEventMarketRosterDraft({
      dTag: "market",
      organizerPubkey: organizer,
      calendarCoordinate: masterCoordinate,
      state: "open",
      merchants: [],
    })
    const market = sign(rosterDraft.kind, rosterDraft.tags, 20)
    const schedule = master([first, second], 21)
    const found = occurrence("first", 22)
    const events = [market, schedule, found]
    const read = await readEventMarketRoster(
      { reference: `30409:${organizer}:market` },
      {
        plan: async () => ({
          candidateRelayUrls: ["wss://example.com"],
          maxRelayAttempts: 1,
          relayHintTruncated: false,
        }),
        fetch: async (filter: {
          kinds?: number[]
          authors?: string[]
          "#d"?: string[]
          "#a"?: string[]
          "#e"?: string[]
        }) => ({
          events: events.filter(
            (event) =>
              filter.kinds?.includes(event.kind) &&
              filter.authors?.includes(event.pubkey) &&
              (!filter["#d"] ||
                event.tags.some(
                  (tag) => tag[0] === "d" && filter["#d"]!.includes(tag[1]!)
                )) &&
              (!filter["#a"] ||
                event.tags.some(
                  (tag) => tag[0] === "a" && filter["#a"]!.includes(tag[1]!)
                )) &&
              (!filter["#e"] ||
                event.tags.some(
                  (tag) => tag[0] === "e" && filter["#e"]!.includes(tag[1]!)
                ))
          ),
          relays: [
            { relayUrl: "wss://example.com", status: "success" as const },
          ],
        }),
        load: async () => [],
        retain: async () => undefined,
      } as never
    )
    expect(read.schedule?.kind).toBe("series")
    if (read.schedule?.kind === "series") {
      expect(
        read.schedule.occurrences.map((entry) => entry.occurrence.coordinate)
      ).toEqual([first])
      expect(read.schedule.unresolvedCoordinates).toEqual([second])
      expect(read.schedule.occurrences[0]?.coverage).toBe("complete")
    }
    expect(read.calendarCoverage).toBe("complete")
    expect(read.scheduleCoverage).toBe("partial")
  })
})
