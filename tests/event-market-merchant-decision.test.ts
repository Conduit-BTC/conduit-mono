import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  publishEventMarketMerchantDecision,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair`
const calendarCoordinate = `31923:${organizer}:calendar`
const firstDraft = buildEventMarketRosterDraft({
  dTag: "fair",
  organizerPubkey: organizer,
  calendarCoordinate,
  state: "open",
  merchants: [],
})
const first = finalizeEvent({ ...firstDraft, created_at: 100 }, secret)
const delivery = { successfulRelayUrls: ["wss://example.com"] } as never

describe("paired Event Market merchant decisions", () => {
  it("saves both exact signatures before publishing approval in safe order", async () => {
    const order: string[] = []
    const result = await publishEventMarketMerchantDecision(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "fair",
        calendarCoordinate,
        merchantPubkey: merchant,
        action: "approve",
        row: {
          pubkey: merchant,
          mode: "merchant_present",
          assignment: "Booth 12",
        },
        expectedPreviousEventId: first.id,
        expectedAuthorizationTipIds: [],
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
          observedRelayUrls: [],
        }),
        readAuthorization: async () => ({
          marketCoordinate,
          merchantPubkey: merchant,
          resolution: { state: "missing" },
          coverage: "complete",
          retained: true,
          actionable: false,
          observedEvidence: [],
        }),
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        persist: async () => {
          order.push("persist")
        },
        load: async () => undefined,
        acknowledge: async () => {
          order.push("ack")
        },
        publish: async (event: SignedPublicNostrEvent) => {
          order.push(event.kind === 30409 ? "roster" : "grant")
          return delivery
        },
      }
    )
    expect(order).toEqual(["persist", "roster", "grant", "ack"])
    expect(result.signed.roster.kind).toBe(30409)
    expect(result.signed.authorization.kind).toBe(3841)
  })

  it("attempts the second signature after the first relay attempt fails", async () => {
    const order: string[] = []
    await expect(
      publishEventMarketMerchantDecision(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair",
          calendarCoordinate,
          merchantPubkey: merchant,
          action: "approve",
          row: {
            pubkey: merchant,
            mode: "merchant_present",
            assignment: "Booth 12",
          },
          expectedPreviousEventId: first.id,
          expectedAuthorizationTipIds: [],
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
            observedRelayUrls: [],
          }),
          readAuthorization: async () => ({
            marketCoordinate,
            merchantPubkey: merchant,
            resolution: { state: "missing" },
            coverage: "complete",
            retained: true,
            actionable: false,
            observedEvidence: [],
          }),
          sign: async ({ draft, createdAt }) =>
            finalizeEvent({ ...draft, created_at: createdAt }, secret),
          persist: async () => {
            order.push("persist")
          },
          load: async () => undefined,
          acknowledge: async () => {
            order.push("ack")
          },
          publish: async (event: SignedPublicNostrEvent) => {
            order.push(event.kind === 30409 ? "roster" : "grant")
            if (event.kind === 30409) throw new Error("relay unavailable")
            return delivery
          },
        }
      )
    ).rejects.toThrow("saved for retry")
    expect(order).toEqual(["persist", "roster", "grant"])
  })

  it("does not sign a first grant over an observed deletion with missing target", async () => {
    const target = "a".repeat(64)
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 101,
        content: "",
        tags: [
          ["e", target],
          ["a", marketCoordinate],
          ["p", merchant],
        ],
      },
      secret
    )
    let signed = false
    await expect(
      publishEventMarketMerchantDecision(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair",
          calendarCoordinate,
          merchantPubkey: merchant,
          action: "approve",
          row: {
            pubkey: merchant,
            mode: "merchant_present",
            assignment: "Booth 12",
          },
          expectedPreviousEventId: first.id,
          expectedAuthorizationTipIds: [],
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
            observedRelayUrls: [],
          }),
          readAuthorization: async () => ({
            marketCoordinate,
            merchantPubkey: merchant,
            resolution: {
              state: "deleted_unknown",
              deletions: [deletion],
              missingTargetIds: [target],
            },
            coverage: "complete",
            retained: true,
            actionable: false,
            observedEvidence: [deletion],
          }),
          sign: async () => {
            signed = true
            return first
          },
          persist: async () => undefined,
          load: async () => undefined,
          acknowledge: async () => undefined,
          publish: async () => delivery,
        }
      )
    ).rejects.toThrow("organizer review")
    expect(signed).toBe(false)
  })
})
