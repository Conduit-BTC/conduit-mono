import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  parseEventMarketAuthorizationEvent,
  parseEventMarketRosterEvent,
  publishEventMarketMerchantDecision,
  publishEventMarketRoster,
  retryEventMarketMerchantDecisionDelivery,
  retryEventMarketRosterDelivery,
  type SignedEventMarketMerchantDecision,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair-market`
const calendarCoordinate = `31923:${organizer}:fair`
const initialRow = {
  pubkey: merchant,
  mode: "merchant_present" as const,
  assignment: "Booth 11",
}
const firstDraft = buildEventMarketRosterDraft({
  dTag: "fair-market",
  organizerPubkey: organizer,
  calendarCoordinate,
  state: "open",
  merchants: [initialRow],
})
const first = finalizeEvent({ ...firstDraft, created_at: 100 }, secret)
const emptyDraft = buildEventMarketRosterDraft({
  dTag: "fair-market",
  organizerPubkey: organizer,
  calendarCoordinate,
  state: "open",
  merchants: [],
})
const empty = finalizeEvent({ ...emptyDraft, created_at: 100 }, secret)
const delivery = {
  plan: {} as never,
  attemptedRelayUrls: ["wss://example.com"],
  successfulRelayUrls: ["wss://example.com"],
  failedRelayUrls: [],
  relayFailureMessages: {},
}

function decisionStorage() {
  const jobs = new Map<
    string,
    {
      id: string
      marketCoordinate: string
      merchantPubkey: string
      action: "approve" | "revoke"
      roster: SignedPublicNostrEvent
      authorization: SignedPublicNostrEvent
      status: "pending" | "acknowledged"
      createdAt: number
      updatedAt: number
    }
  >()
  return {
    jobs,
    persist: async (signed: SignedEventMarketMerchantDecision) => {
      jobs.set(signed.authorization.id, {
        id: signed.authorization.id,
        marketCoordinate,
        merchantPubkey: merchant,
        ...signed,
        status: "pending",
        createdAt: 0,
        updatedAt: 0,
      })
    },
    load: async (id: string) => jobs.get(id),
    acknowledge: async (id: string) => {
      const job = jobs.get(id)
      if (job) job.status = "acknowledged"
    },
  }
}

const storage = decisionStorage()

describe("future Event Market organizer updates", () => {
  it("requires the paired decision for membership changes", async () => {
    let signed = false
    await expect(
      publishEventMarketRoster(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair-market",
          calendarCoordinate,
          state: "open",
          merchants: [],
          expectedPreviousEventId: first.id,
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
            observedRelayUrls: [],
          }),
          sign: async () => {
            signed = true
            return first
          },
          publish: async () => delivery,
        }
      )
    ).rejects.toThrow("causal authorization")
    expect(signed).toBe(false)
  })

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

  it.each(["malformed", "deleted"] as const)(
    "does not retry when newer roster evidence is %s",
    async (state) => {
      let published = false
      await expect(
        retryEventMarketRosterDelivery(
          { signedEvent: first, authenticatedPubkey: organizer },
          {
            read: async () => ({
              coordinate: marketCoordinate,
              resolution: { state, eventId: "b".repeat(64) },
              coverage: "partial",
              retained: true,
              observedRelayUrls: ["wss://example.com"],
            }),
            publish: async () => {
              published = true
              return delivery
            },
          }
        )
      ).rejects.toThrow()
      expect(published).toBe(false)
    }
  )

  it("saves approval bytes before publishing the row and active grant", async () => {
    const order: string[] = []
    let saved:
      | {
          roster: SignedPublicNostrEvent
          authorization: SignedPublicNostrEvent
        }
      | undefined
    const result = await publishEventMarketMerchantDecision(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "fair-market",
        calendarCoordinate,
        merchantPubkey: merchant,
        action: "approve",
        row: { ...initialRow, assignment: "Booth 12" },
        expectedPreviousEventId: empty.id,
        expectedAuthorizationTipIds: [],
        onSignedLocal: async (decision) => {
          saved = decision
          order.push("saved")
        },
      },
      {
        ...storage,
        persist: async (signed) => {
          order.push("persisted")
          await storage.persist(signed)
        },
        read: async () => ({
          coordinate: marketCoordinate,
          resolution: {
            state: "current",
            market: parseEventMarketRosterEvent(empty)!,
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        readAuthorization: async () => ({
          resolution: { state: "missing" },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        publish: async (event) => {
          order.push(event.kind === 30409 ? "row" : "grant")
          expect([saved?.roster.id, saved?.authorization.id]).toContain(
            event.id
          )
          return delivery
        },
      }
    )
    expect(order).toEqual(["persisted", "saved", "row", "grant"])
    expect(result.signed).toEqual(saved)
    expect(
      parseEventMarketAuthorizationEvent(result.signed.authorization)
    ).toMatchObject({
      state: "active",
      sequence: 0,
      parentIds: [],
    })
  })

  it("does not sign a first approval when a scoped deletion target is unavailable", async () => {
    let signed = false
    const deletedTarget = "a".repeat(64)
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 101,
        tags: [
          ["e", deletedTarget],
          ["a", marketCoordinate],
          ["p", merchant],
        ],
        content: "",
      },
      secret
    )
    await expect(
      publishEventMarketMerchantDecision(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair-market",
          calendarCoordinate,
          merchantPubkey: merchant,
          action: "approve",
          row: initialRow,
          expectedPreviousEventId: empty.id,
          expectedAuthorizationTipIds: [],
        },
        {
          ...storage,
          read: async () => ({
            coordinate: marketCoordinate,
            resolution: {
              state: "current",
              market: parseEventMarketRosterEvent(empty)!,
            },
            coverage: "complete",
            retained: true,
            observedRelayUrls: [],
          }),
          readAuthorization: async () => ({
            resolution: {
              state: "deleted_unknown",
              deletions: [deletion],
              missingTargetIds: [deletedTarget],
            },
            coverage: "partial",
            retained: true,
            observedRelayUrls: [],
          }),
          sign: async () => {
            signed = true
            return empty
          },
          publish: async () => delivery,
        }
      )
    ).rejects.toThrow("organizer review")
    expect(signed).toBe(false)
  })

  it("signs a descendant revoke and publishes it before row removal", async () => {
    const activeDraft = buildEventMarketAuthorizationDraft({
      marketCoordinate,
      merchantPubkey: merchant,
      state: "active",
      sequence: 0,
      parentIds: [],
    })
    const active = finalizeEvent({ ...activeDraft, created_at: 101 }, secret)
    const order: string[] = []
    const result = await publishEventMarketMerchantDecision(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "fair-market",
        calendarCoordinate,
        merchantPubkey: merchant,
        action: "revoke",
        expectedPreviousEventId: first.id,
        expectedAuthorizationTipIds: [active.id],
        onSignedLocal: async () => order.push("saved"),
      },
      {
        ...storage,
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
          resolution: {
            state: "active",
            tip: parseEventMarketAuthorizationEvent(active)!,
            ancestry: [active],
            deletions: [],
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        publish: async (event) => {
          order.push(event.kind === 3841 ? "revoke" : "remove-row")
          return delivery
        },
      }
    )
    expect(order).toEqual(["saved", "revoke", "remove-row"])
    expect(
      parseEventMarketAuthorizationEvent(result.signed.authorization)
    ).toMatchObject({
      state: "revoked",
      sequence: 1,
      parentIds: [active.id],
    })
    expect(
      parseEventMarketRosterEvent(result.signed.roster)?.merchants
    ).toEqual([])
  })

  it("keeps an interrupted approval as a saved row-only state and retries the exact grant", async () => {
    let saved: SignedEventMarketMerchantDecision | undefined
    const current = () => ({
      coordinate: marketCoordinate,
      resolution: {
        state: "current" as const,
        market: parseEventMarketRosterEvent(saved?.roster ?? empty)!,
      },
      coverage: "complete" as const,
      retained: true,
      observedRelayUrls: [] as string[],
    })
    await expect(
      publishEventMarketMerchantDecision(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair-market",
          calendarCoordinate,
          merchantPubkey: merchant,
          action: "approve",
          row: initialRow,
          expectedPreviousEventId: empty.id,
          expectedAuthorizationTipIds: [],
          onSignedLocal: async (decision) => {
            saved = decision
          },
        },
        {
          ...storage,
          read: async () => ({
            ...current(),
            resolution: {
              state: "current",
              market: parseEventMarketRosterEvent(empty)!,
            },
          }),
          readAuthorization: async () => ({
            resolution: { state: "missing" },
            coverage: "complete",
            retained: true,
            observedRelayUrls: [],
          }),
          sign: async ({ draft, createdAt }) =>
            finalizeEvent({ ...draft, created_at: createdAt }, secret),
          publish: async (event) =>
            event.kind === 30409
              ? delivery
              : { ...delivery, successfulRelayUrls: [] },
        }
      )
    ).rejects.toThrow("saved for retry")
    expect(saved).toBeDefined()
    const retryEvents: string[] = []
    await retryEventMarketMerchantDecisionDelivery(
      { decisionId: saved!.authorization.id, authenticatedPubkey: organizer },
      {
        ...storage,
        read: async () => current(),
        readAuthorization: async () => ({
          resolution: { state: "missing" },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        publish: async (event) => {
          retryEvents.push(event.id)
          return delivery
        },
      }
    )
    expect(retryEvents).toEqual([saved!.roster.id, saved!.authorization.id])
  })

  it("makes reapproval descend from the observed revoke", async () => {
    const active = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          sequence: 0,
          parentIds: [],
        }),
        created_at: 101,
      },
      secret
    )
    const revoked = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "revoked",
          sequence: 1,
          parentIds: [active.id],
        }),
        created_at: 102,
      },
      secret
    )
    const result = await publishEventMarketMerchantDecision(
      {
        organizerPubkey: organizer,
        authenticatedPubkey: organizer,
        dTag: "fair-market",
        calendarCoordinate,
        merchantPubkey: merchant,
        action: "approve",
        row: initialRow,
        expectedPreviousEventId: empty.id,
        expectedAuthorizationTipIds: [revoked.id],
        onSignedLocal: async () => undefined,
      },
      {
        ...storage,
        read: async () => ({
          coordinate: marketCoordinate,
          resolution: {
            state: "current",
            market: parseEventMarketRosterEvent(empty)!,
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        readAuthorization: async () => ({
          resolution: {
            state: "revoked",
            tip: parseEventMarketAuthorizationEvent(revoked)!,
            ancestry: [active, revoked],
            deletions: [],
          },
          coverage: "complete",
          retained: true,
          observedRelayUrls: [],
        }),
        sign: async ({ draft, createdAt }) =>
          finalizeEvent({ ...draft, created_at: createdAt }, secret),
        publish: async () => delivery,
      }
    )
    expect(
      parseEventMarketAuthorizationEvent(result.signed.authorization)
    ).toMatchObject({
      state: "active",
      sequence: 2,
      parentIds: [revoked.id],
    })
  })

  it("still removes the row when revoke delivery fails", async () => {
    const active = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          sequence: 0,
          parentIds: [],
        }),
        created_at: 101,
      },
      secret
    )
    let saved: SignedEventMarketMerchantDecision | undefined
    const published: number[] = []
    await expect(
      publishEventMarketMerchantDecision(
        {
          organizerPubkey: organizer,
          authenticatedPubkey: organizer,
          dTag: "fair-market",
          calendarCoordinate,
          merchantPubkey: merchant,
          action: "revoke",
          expectedPreviousEventId: first.id,
          expectedAuthorizationTipIds: [active.id],
          onSignedLocal: async (decision) => {
            saved = decision
          },
        },
        {
          ...storage,
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
            resolution: {
              state: "active",
              tip: parseEventMarketAuthorizationEvent(active)!,
              ancestry: [active],
              deletions: [],
            },
            coverage: "complete",
            retained: true,
            observedRelayUrls: [],
          }),
          sign: async ({ draft, createdAt }) =>
            finalizeEvent({ ...draft, created_at: createdAt }, secret),
          publish: async (event) => {
            published.push(event.kind)
            return event.kind === 3841
              ? { ...delivery, successfulRelayUrls: [] }
              : delivery
          },
        }
      )
    ).rejects.toThrow("saved for retry")
    expect(saved).toBeDefined()
    expect(published).toEqual([3841, 30409])
    expect(parseEventMarketRosterEvent(saved!.roster)?.merchants).toEqual([])
  })
})
