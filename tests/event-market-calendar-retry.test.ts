import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { retryEventMarketCalendarDelivery } from "../packages/core/src/protocol/event-market-calendar-retry"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const otherOrganizer = getPublicKey(generateSecretKey())
const relay = "wss://relay.example"
function calendar(kind: 31922 | 31923 = 31923): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      ...buildEventMarketCalendarDraft({
        kind,
        dTag: "fair-calendar",
        title: "Public fair",
        locations: ["Public square"],
        start: kind === 31922 ? "2099-01-01" : 4_070_952_000,
      }),
      created_at: 100,
    },
    secret
  )
}
function delivery(acknowledged: boolean): PublishWithPlannerResult {
  return {
    plan: {} as never,
    attemptedRelayUrls: [relay],
    successfulRelayUrls: acknowledged ? [relay] : [],
    failedRelayUrls: acknowledged ? [] : [relay],
    relayFailureMessages: acknowledged ? {} : { [relay]: "relay timeout" },
  }
}

describe("current calendar exact retry", () => {
  it.each([31922, 31923] as const)(
    "retries kind %i with the same signature and no draft signing",
    async (kind) => {
      const signed = calendar(kind)
      let submitted: SignedPublicNostrEvent | undefined
      const result = await retryEventMarketCalendarDelivery(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          signedEvent: signed,
        },
        {
          publish: async (event, author) => {
            expect(author).toBe(organizer)
            submitted = event
            return delivery(true)
          },
        }
      )
      expect(submitted).toBe(signed)
      expect(result.successfulRelayUrls).toEqual([relay])
    }
  )
  it.each([30405, 30406, 30409])(
    "rejects retired or non-calendar kind %i before publication",
    async (kind) => {
      const signed = finalizeEvent({ ...calendar(), kind }, secret)
      let calls = 0
      await expect(
        retryEventMarketCalendarDelivery(
          {
            organizerPubkey: organizer,
            authenticatedPubkey: organizer,
            signedEvent: signed,
          },
          {
            publish: async () => {
              calls++
              return delivery(true)
            },
          }
        )
      ).rejects.toThrow("signed organizer calendar")
      expect(calls).toBe(0)
    }
  )
  it("rejects altered signature, different owner, different signer and cancelled session", async () => {
    const signed = calendar()
    const inputs = [
      { signedEvent: { ...signed, content: "altered" } },
      { organizerPubkey: otherOrganizer },
      { authenticatedPubkey: otherOrganizer },
      { shouldContinue: () => false },
    ]
    let calls = 0
    for (const override of inputs)
      await expect(
        retryEventMarketCalendarDelivery(
          {
            organizerPubkey: organizer,
            authenticatedPubkey: organizer,
            signedEvent: signed,
            ...override,
          },
          {
            publish: async () => {
              calls++
              return delivery(true)
            },
          }
        )
      ).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it("preserves zero ACK as retryable delivery evidence and propagates transport interruption", async () => {
    const input = {
      organizerPubkey: organizer,
      authenticatedPubkey: organizer,
      signedEvent: calendar(),
    }
    expect(
      (
        await retryEventMarketCalendarDelivery(input, {
          publish: async () => delivery(false),
        })
      ).successfulRelayUrls
    ).toEqual([])
    await expect(
      retryEventMarketCalendarDelivery(input, {
        publish: async () => {
          throw new Error("Connection interrupted")
        },
      })
    ).rejects.toThrow("Connection interrupted")
  })
  it("stops after a session change during delivery", async () => {
    let active = true
    await expect(
      retryEventMarketCalendarDelivery(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          signedEvent: calendar(),
          shouldContinue: () => active,
        },
        {
          publish: async () => {
            active = false
            return delivery(true)
          },
        }
      )
    ).rejects.toThrow("session changed")
  })
})
