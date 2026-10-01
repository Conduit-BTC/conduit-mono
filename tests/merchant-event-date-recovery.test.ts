import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketSeriesDraft,
  parseEventMarketSeriesEvent,
  publishFutureEventMarketSeries,
  retryEventMarketCalendarDelivery,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  getMatchingSavedSeriesDateEvents,
  getSavedDateRecoveryAction,
} from "../apps/merchant/src/lib/event-market-date-recovery"

function delivery(acknowledged: boolean): PublishWithPlannerResult {
  return {
    plan: {} as never,
    attemptedRelayUrls: ["wss://example.com"],
    successfulRelayUrls: acknowledged ? ["wss://example.com"] : [],
    failedRelayUrls: acknowledged ? [] : ["wss://example.com"],
    relayFailureMessages: acknowledged
      ? {}
      : { "wss://example.com": "timeout" },
  }
}

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const drafts = [
  {
    label: "single calendar",
    draft: buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "single",
      title: "Single date",
      start: 1_900_000_000,
      end: 1_900_003_600,
    }),
  },
  {
    label: "series occurrence",
    draft: buildEventMarketCalendarDraft({
      kind: 31922,
      dTag: "occurrence",
      title: "Series date",
      start: "2030-03-01",
      end: "2030-03-02",
    }),
  },
  {
    label: "series schedule",
    draft: buildEventMarketSeriesDraft({
      dTag: "schedule",
      organizerPubkey: organizer,
      title: "Series",
      memberCoordinates: [`31922:${organizer}:occurrence`],
    }),
  },
] as const

describe("host date publication recovery after reload", () => {
  it("retries a same-clock new occurrence while requiring the new schedule to advance", async () => {
    const fixedClock = 1_900_000_000
    const restoreNow = Date.now
    Date.now = () => fixedClock * 1_000
    try {
      const marketCoordinate = `30409:${organizer}:market`
      const scheduleCoordinate = `31924:${organizer}:weekly`
      const oldCoordinate = `31923:${organizer}:old-date`
      const occurrenceInput = {
        kind: 31923,
        dTag: "new-date",
        title: "Weekly fair",
        start: 2_000_000_000,
        end: 2_000_003_600,
      } as const
      const occurrence = buildEventMarketCalendarDraft(occurrenceInput)
      const previousScheduleDraft = buildEventMarketSeriesDraft({
        dTag: "weekly",
        organizerPubkey: organizer,
        title: "Weekly fair",
        memberCoordinates: [oldCoordinate],
      })
      const previousSchedule = finalizeEvent(
        { ...previousScheduleDraft, created_at: fixedClock },
        secret
      )
      const sameClockOccurrence = finalizeEvent(
        { ...occurrence, created_at: fixedClock },
        secret
      )
      const wrongOccurrence = finalizeEvent(
        {
          ...buildEventMarketCalendarDraft({
            kind: 31923,
            dTag: "different-date",
            title: "Weekly fair",
            start: 2_000_000_000,
            end: 2_000_003_600,
          }),
          created_at: fixedClock,
        },
        secret
      )
      const expectedSchedule = buildEventMarketSeriesDraft({
        dTag: "weekly",
        organizerPubkey: organizer,
        title: "Weekly fair",
        memberCoordinates: [oldCoordinate, `31923:${organizer}:new-date`],
      })
      const staleMatchingSchedule = finalizeEvent(
        { ...expectedSchedule, created_at: fixedClock },
        secret
      )
      const expectedOccurrences = [
        { coordinate: `31923:${organizer}:new-date`, draft: occurrence },
      ]
      const matches = getMatchingSavedSeriesDateEvents({
        signedEvents: [
          previousSchedule,
          staleMatchingSchedule,
          sameClockOccurrence,
          wrongOccurrence,
        ],
        scheduleCoordinate,
        expectedSchedule,
        expectedOccurrences,
        expectedPreviousCreatedAt: fixedClock * 1_000,
      })
      expect(matches.map((event) => event.id)).toEqual([sameClockOccurrence.id])
      expect(
        [previousSchedule, sameClockOccurrence, wrongOccurrence].filter(
          (event) => event.created_at > fixedClock
        )
      ).toHaveLength(0)

      const previous = parseEventMarketSeriesEvent(previousSchedule)!
      const retained: SignedPublicNostrEvent[] = []
      const signed: SignedPublicNostrEvent[] = []
      const attempts: SignedPublicNostrEvent[] = []
      let failOccurrence = true
      const dependencies = {
        read: async () =>
          ({
            resolution: {
              state: "current",
              market: {
                organizerPubkey: organizer,
                calendarCoordinate: scheduleCoordinate,
              },
            },
            schedule: {
              kind: "series",
              series: previous,
              occurrences: [
                {
                  occurrence: { coordinate: oldCoordinate, end: 2_100_000_000 },
                },
              ],
            },
            calendarCoverage: "complete",
          }) as never,
        sign: async ({
          draft,
          createdAt,
        }: {
          draft: { kind: number; tags: string[][]; content: string }
          createdAt: number
        }) => {
          const event = finalizeEvent(
            { ...draft, created_at: createdAt },
            secret
          )
          signed.push(event)
          return event
        },
        publish: async (event: SignedPublicNostrEvent) => {
          attempts.push(event)
          if (event.kind === 31923 && failOccurrence) {
            failOccurrence = false
            return delivery(false)
          }
          return delivery(true)
        },
      }
      const input = {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        marketCoordinate,
        expectedPreviousEventId: previousSchedule.id,
        scheduleDTag: "weekly",
        title: "Weekly fair",
        retainedMemberCoordinates: [oldCoordinate],
        removedMemberCoordinates: [],
        newOccurrences: [occurrenceInput],
        onSignedLocal: async (event: SignedPublicNostrEvent) => {
          retained.push(event)
        },
      }
      await expect(
        publishFutureEventMarketSeries(input, dependencies as never)
      ).rejects.toThrow("saved for exact retry")
      const afterReload = getMatchingSavedSeriesDateEvents({
        signedEvents: [previousSchedule, staleMatchingSchedule, ...retained],
        scheduleCoordinate,
        expectedSchedule,
        expectedOccurrences,
        expectedPreviousCreatedAt: fixedClock * 1_000,
      })
      expect(afterReload.map((event) => event.id)).toEqual([
        sameClockOccurrence.id,
      ])
      const result = await publishFutureEventMarketSeries(
        { ...input, savedSignedEvents: afterReload },
        dependencies as never
      )
      const occurrenceAttempts = attempts.filter(
        (event) => event.kind === 31923
      )
      expect(occurrenceAttempts).toHaveLength(2)
      expect(occurrenceAttempts[0]).toBe(retained[0])
      expect(occurrenceAttempts[1]).toBe(retained[0])
      expect(signed.filter((event) => event.kind === 31923)).toHaveLength(1)
      expect(result.schedule.signedEvent.id).not.toBe(previousSchedule.id)
      expect(result.schedule.signedEvent.id).not.toBe(staleMatchingSchedule.id)
      expect(result.schedule.signedEvent.created_at).toBeGreaterThan(fixedClock)
    } finally {
      Date.now = restoreNow
    }
  })

  it.each(drafts)(
    "retries the exact saved $label when its retained revision is absent from relays",
    async ({ draft }) => {
      const signed = finalizeEvent({ ...draft, created_at: 100 }, secret)
      expect(
        getSavedDateRecoveryAction({
          savedEventId: signed.id,
          observedEventId: signed.id,
          coverage: "stale",
          canEdit: false,
        })
      ).toBe("retry_saved")
      const published: string[] = []
      await retryEventMarketCalendarDelivery(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          signedEvent: signed,
        },
        {
          publish: async (event) => {
            published.push(event.id)
            return {
              plan: {} as never,
              attemptedRelayUrls: ["wss://example.com"],
              successfulRelayUrls: ["wss://example.com"],
              failedRelayUrls: [],
              relayFailureMessages: {},
            }
          },
        }
      )
      expect(published).toEqual([signed.id])
    }
  )

  it("finishes only when the saved revision is observed live", () => {
    expect(
      getSavedDateRecoveryAction({
        savedEventId: "saved",
        observedEventId: "saved",
        coverage: "complete",
        canEdit: false,
      })
    ).toBe("already_live")
  })

  it("does not request a new signature without current edit authority", () => {
    expect(
      getSavedDateRecoveryAction({
        savedEventId: null,
        observedEventId: "previous",
        coverage: "stale",
        canEdit: false,
      })
    ).toBe("blocked")
  })
})
