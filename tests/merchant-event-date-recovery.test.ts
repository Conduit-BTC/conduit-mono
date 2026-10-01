import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketSeriesDraft,
  retryEventMarketCalendarDelivery,
} from "@conduit/core"
import { getSavedDateRecoveryAction } from "../apps/merchant/src/lib/event-market-date-recovery"

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
