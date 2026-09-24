import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  publishEventMarketRoster,
  retryEventMarketRosterDelivery,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair-market`
const calendarCoordinate = `31923:${organizer}:fair`
const firstDraft = buildEventMarketRosterDraft({
  dTag: "fair-market",
  organizerPubkey: organizer,
  calendarCoordinate,
  state: "open",
  merchants: [],
})
const first = finalizeEvent({ ...firstDraft, created_at: 100 }, secret)
const delivery = {
  plan: {} as never,
  attemptedRelayUrls: ["wss://example.com"],
  successfulRelayUrls: ["wss://example.com"],
  failedRelayUrls: [],
  relayFailureMessages: {},
}

describe("future Event Market organizer updates", () => {
  it("rejects a stale roster parent before asking the signer", async () => {
    let signed = false
    await expect(
      publishEventMarketRoster(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair-market",
          calendarCoordinate,
          state: "open",
          merchants: [
            {
              pubkey: merchant,
              mode: "merchant_present",
              assignment: "Booth 12",
            },
          ],
          expectedPreviousEventId: "a".repeat(64),
          onSignedLocal: async () => undefined,
        },
        {
          read: async () => ({
            coordinate: marketCoordinate,
            resolution: {
              state: "current",
              market: parseEventMarketRosterEvent(first)!,
            },
            coverage: "complete",
            retained: true,
            observedRelayUrls: ["wss://example.com"],
          }),
          sign: async () => {
            signed = true
            return first
          },
          publish: async () => delivery,
        }
      )
    ).rejects.toThrow("changed")
    expect(signed).toBe(false)
  })

  it("saves the exact signed revision before relay delivery and retries those bytes", async () => {
    const order: string[] = []
    let saved: SignedPublicNostrEvent | undefined
    const result = await publishEventMarketRoster(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "fair-market",
        calendarCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: merchant,
            mode: "merchant_present",
            assignment: "Booth 12",
          },
        ],
        expectedPreviousEventId: first.id,
        onSignedLocal: async (event) => {
          order.push("saved")
          saved = event
        },
      },
      {
        read: async () => ({
          coordinate: marketCoordinate,
          resolution: {
            state: "current",
            market: parseEventMarketRosterEvent(first)!,
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: ["wss://example.com"],
        }),
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        publish: async (event) => {
          order.push("published")
          expect(event.id).toBe(saved?.id)
          return delivery
        },
      }
    )
    expect(order).toEqual(["saved", "published"])
    expect(result.signedEvent.id).toBe(saved?.id)
    expect(
      parseEventMarketRosterEvent(result.signedEvent)?.previousEventId
    ).toBe(first.id)
    const retry = await retryEventMarketRosterDelivery(
      {
        signedEvent: result.signedEvent,
        authenticatedPubkey: organizer,
      },
      {
        read: async () => ({
          coordinate: marketCoordinate,
          resolution: {
            state: "current",
            market: parseEventMarketRosterEvent(result.signedEvent)!,
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: ["wss://example.com"],
        }),
        publish: async (event) => {
          expect(event).toEqual(saved)
          return delivery
        },
      }
    )
    expect(retry.successfulRelayUrls).toEqual(["wss://example.com"])
    const laterDraft = buildEventMarketRosterDraft({
      dTag: "fair-market",
      organizerPubkey: organizer,
      calendarCoordinate,
      state: "closed",
      merchants: [],
      previousEventId: result.signedEvent.id,
    })
    const later = finalizeEvent(
      { ...laterDraft, created_at: result.signedEvent.created_at + 1 },
      secret
    )
    let retriedOld = false
    await expect(
      retryEventMarketRosterDelivery(
        {
          signedEvent: result.signedEvent,
          authenticatedPubkey: organizer,
        },
        {
          read: async () => ({
            coordinate: marketCoordinate,
            resolution: {
              state: "current",
              market: parseEventMarketRosterEvent(later)!,
            },
            coverage: "complete",
            retained: true,
            observedRelayUrls: ["wss://example.com"],
          }),
          publish: async () => {
            retriedOld = true
            return delivery
          },
        }
      )
    ).rejects.toThrow("superseded")
    expect(retriedOld).toBe(false)
  })
})
