import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  publishEventMarketMerchantDecision,
  retryEventMarketMerchantDecisionDelivery,
} from "@conduit/core"
import { retainEventMarketMerchantDecision } from "../apps/merchant/src/lib/event-market-merchant-decision"
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

for (const action of ["approve", "revoke"] as const) {
  for (const coverage of ["stale", "partial", "unavailable"] as const) {
    it(`rejects ${action} with ${coverage} authorization before signing or publishing`, async () => {
      const tip = finalizeEvent(
        {
          ...buildEventMarketAuthorizationDraft({
            marketCoordinate,
            merchantPubkey: merchant,
            state: action === "approve" ? "revoked" : "active",
            sequence: 0,
            parentIds: [],
          }),
          created_at: 99,
        },
        secret
      )
      const calls: string[] = []
      await expect(
        publishEventMarketMerchantDecision(
          {
            organizerPubkey: organizer,
            authenticatedPubkey: organizer,
            dTag: "fair",
            calendarCoordinate,
            merchantPubkey: merchant,
            action,
            ...(action === "approve"
              ? {
                  row: {
                    pubkey: merchant,
                    mode: "merchant_present" as const,
                    assignment: "Booth 12",
                  },
                }
              : {}),
            expectedPreviousEventId: first.id,
            expectedAuthorizationTipIds: [tip.id],
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
                state: action === "approve" ? "revoked" : "active",
                tip: parseEventMarketAuthorizationEvent(tip)!,
              },
              coverage,
              retained: true,
              actionable: false,
              observedEvidence: [tip],
            }),
            sign: async ({ draft, createdAt }) => {
              calls.push("sign")
              return finalizeEvent({ ...draft, created_at: createdAt }, secret)
            },
            persist: async () => {
              calls.push("persist")
            },
            load: async () => undefined,
            acknowledge: async () => {
              calls.push("ack")
            },
            publish: async () => {
              calls.push("publish")
              return delivery
            },
          }
        )
      ).rejects.toThrow("organizer review")
      expect(calls).toEqual([])
    })
  }
}

function approvalInput() {
  return {
    organizerPubkey: organizer,
    authenticatedPubkey: organizer,
    dTag: "fair",
    calendarCoordinate,
    merchantPubkey: merchant,
    action: "approve" as const,
    row: {
      pubkey: merchant,
      mode: "merchant_present" as const,
      assignment: "Booth 12",
    },
    expectedPreviousEventId: first.id,
    expectedAuthorizationTipIds: [],
  }
}

function approvalDependencies(calls: string[]) {
  return {
    read: async () => ({
      coordinate: marketCoordinate,
      resolution: {
        state: "current" as const,
        market: parseEventMarketRosterEvent(first)!,
      },
      coverage: "complete" as const,
      retained: true,
      observedRelayUrls: [],
    }),
    readAuthorization: async () => ({
      marketCoordinate,
      merchantPubkey: merchant,
      resolution: { state: "missing" as const },
      coverage: "complete" as const,
      retained: true,
      actionable: false,
      observedEvidence: [],
    }),
    sign: async ({
      draft,
      createdAt,
    }: {
      draft: ReturnType<typeof buildEventMarketRosterDraft>
      createdAt: number
    }) => finalizeEvent({ ...draft, created_at: createdAt }, secret),
    persist: async () => {
      calls.push("persist")
    },
    load: async () => undefined,
    acknowledge: async () => {
      calls.push("ack")
    },
    publish: async () => {
      calls.push("publish")
      return delivery
    },
  }
}

it("manager save waits for both exact evidence writes before publishing or acknowledging", async () => {
  const calls: string[] = []
  const rosterWrite = Promise.withResolvers<void>()
  const authorizationWrite = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const operation = publishEventMarketMerchantDecision(
    {
      ...approvalInput(),
      onSignedLocal: (decision) =>
        retainEventMarketMerchantDecision(
          marketCoordinate,
          decision,
          async (coordinate, event) => {
            expect(coordinate).toBe(marketCoordinate)
            expect(event).toBe(
              event.kind === 30409 ? decision.roster : decision.authorization
            )
            calls.push(`retain:${event.kind}`)
            if (event.kind === 3841) started.resolve()
            await (event.kind === 30409
              ? rosterWrite.promise
              : authorizationWrite.promise)
            calls.push(`retained:${event.kind}`)
          }
        ),
    },
    approvalDependencies(calls)
  )
  await started.promise
  expect(calls).toEqual(["persist", "retain:30409", "retain:3841"])
  rosterWrite.resolve()
  await rosterWrite.promise
  await Promise.resolve()
  expect(calls).not.toContain("publish")
  expect(calls).not.toContain("ack")
  authorizationWrite.resolve()
  await operation
  expect(calls).toEqual([
    "persist",
    "retain:30409",
    "retain:3841",
    "retained:30409",
    "retained:3841",
    "publish",
    "publish",
    "ack",
  ])
})

for (const rejectedKind of [30409, 3841]) {
  it(`manager save propagates kind ${rejectedKind} retention failure without delivery`, async () => {
    const calls: string[] = []
    await expect(
      publishEventMarketMerchantDecision(
        {
          ...approvalInput(),
          onSignedLocal: (decision) =>
            retainEventMarketMerchantDecision(
              marketCoordinate,
              decision,
              async (_coordinate, event) => {
                calls.push(`retain:${event.kind}`)
                if (event.kind === rejectedKind)
                  throw new Error("evidence storage failed")
              }
            ),
        },
        approvalDependencies(calls)
      )
    ).rejects.toThrow("evidence storage failed")
    expect(calls).toEqual(["persist", "retain:30409", "retain:3841"])
  })
}

it("retries both evidence writes before delivering the saved pair after storage recovery", async () => {
  const calls: string[] = []
  let saved:
    | Awaited<ReturnType<typeof publishEventMarketMerchantDecision>>["signed"]
    | undefined
  const dependencies = {
    ...approvalDependencies(calls),
    persist: async (decision: NonNullable<typeof saved>) => {
      saved = decision
    },
  }
  await expect(
    publishEventMarketMerchantDecision(
      {
        ...approvalInput(),
        onSignedLocal: (decision) =>
          retainEventMarketMerchantDecision(
            marketCoordinate,
            decision,
            async () => {
              throw new Error("storage unavailable")
            }
          ),
      },
      dependencies
    )
  ).rejects.toThrow("storage unavailable")
  expect(calls).toEqual([])
  const decision = saved!
  const retryDependencies = {
    ...dependencies,
    load: async () => ({
      id: decision.authorization.id,
      marketCoordinate,
      merchantPubkey: merchant,
      ...decision,
      status: "pending" as const,
      createdAt: 0,
      updatedAt: 0,
    }),
    sign: async () => {
      throw new Error("Retry must not sign")
    },
    publish: async (event: SignedPublicNostrEvent) => {
      expect(event).toBe(
        event.kind === 30409 ? decision.roster : decision.authorization
      )
      calls.push("publish")
      return delivery
    },
  }
  const retryInput = {
    decisionId: decision.authorization.id,
    authenticatedPubkey: organizer,
  }
  await expect(
    retryEventMarketMerchantDecisionDelivery(
      {
        ...retryInput,
        onSignedLocal: (pair) =>
          retainEventMarketMerchantDecision(
            marketCoordinate,
            pair,
            async () => {
              throw new Error("storage still unavailable")
            }
          ),
      },
      retryDependencies
    )
  ).rejects.toThrow("storage still unavailable")
  expect(calls).toEqual([])
  await retryEventMarketMerchantDecisionDelivery(
    {
      ...retryInput,
      onSignedLocal: (pair) =>
        retainEventMarketMerchantDecision(
          marketCoordinate,
          pair,
          async (_coordinate, event) => {
            calls.push(`retain:${event.kind}`)
          }
        ),
    },
    retryDependencies
  )
  expect(calls).toEqual([
    "retain:30409",
    "retain:3841",
    "publish",
    "publish",
    "ack",
  ])
})
