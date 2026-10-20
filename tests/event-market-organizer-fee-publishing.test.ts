import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  parseEventMarketAuthorizationEvent,
} from "@conduit/core/protocol/event-market-authorization"
import {
  EVENT_MARKET_ORGANIZER_FEE_TAG,
  parseEventMarketOrganizerFeeTerms,
  type EventMarketOrganizerFeeAuthoring,
} from "@conduit/core/protocol/event-market-organizer-fee"
import {
  buildEventMarketRosterDraft,
  parseEventMarketRosterEvent,
  type EventMarketMerchantRow,
} from "@conduit/core/protocol/event-market-roster"
import {
  publishEventMarketMerchantDecision,
  publishEventMarketRoster,
  retryEventMarketRosterDelivery,
  type SignedEventMarketMerchantDecision,
} from "@conduit/core/protocol/event-market-roster-publish"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(generateSecretKey())
const dTag = "fee-publishing-market"
const marketCoordinate = `30409:${organizer}:${dTag}`
const calendarCoordinate = `31923:${organizer}:fee-publishing-date`
const row: EventMarketMerchantRow = {
  pubkey: merchant,
  mode: "merchant_present",
  assignment: "Booth 1",
}
const activeFee: EventMarketOrganizerFeeAuthoring = {
  state: "active",
  basisPoints: 150,
  minimumSats: 7,
  lightningAddress: "organizer@example.com",
}
const delivery = {
  plan: {} as never,
  attemptedRelayUrls: ["wss://example.com"],
  successfulRelayUrls: ["wss://example.com"],
  failedRelayUrls: [],
  relayFailureMessages: {},
}

async function admitted(event: SignedPublicNostrEvent) {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error(`Fixture admission failed: ${result.status}`)
  return result.event
}

function feeTags(event: SignedPublicNostrEvent) {
  return event.tags.filter((tag) => tag[0] === EVENT_MARKET_ORGANIZER_FEE_TAG)
}

async function roster(
  tags: string[][] = [],
  merchants: EventMarketMerchantRow[] = [row],
  createdAt = 100
) {
  const draft = buildEventMarketRosterDraft({
    dTag,
    organizerPubkey: organizer,
    calendarCoordinate,
    state: "open",
    merchants,
  })
  draft.tags.push(...tags.map((tag) => [...tag]))
  return admitted(
    finalizeEvent({ ...draft, created_at: createdAt }, organizerSecret)
  )
}

type RosterDependencies = NonNullable<
  Parameters<typeof publishEventMarketRoster>[1]
>

function dependencies(
  previous: Awaited<ReturnType<typeof roster>> | null,
  effects: string[] = []
): RosterDependencies {
  return {
    read: async () => ({
      coordinate: marketCoordinate,
      resolution: previous
        ? { state: "current", market: parseEventMarketRosterEvent(previous)! }
        : { state: "missing" },
      coverage: "complete",
      retained: true,
      observedRelayUrls: [],
    }),
    sign: async ({ draft, createdAt }) => {
      effects.push("sign")
      return finalizeEvent({ ...draft, created_at: createdAt }, organizerSecret)
    },
    publish: async () => {
      effects.push("publish")
      return delivery
    },
  }
}

function input(previous?: SignedPublicNostrEvent) {
  return {
    organizerPubkey: organizer,
    authenticatedPubkey: organizer,
    dTag,
    calendarCoordinate,
    state: "open" as const,
    merchants: [row],
    ...(previous ? { expectedPreviousEventId: previous.id } : {}),
    onSignedLocal: async () => undefined,
  }
}

async function expectRejected(operation: Promise<unknown>, message?: string) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (message) expect((failure as Error).message).toContain(message)
}

describe("organizer-signed Event Market fee publication", () => {
  it("publishes active terms bound to the exact signed market revision", async () => {
    const result = await publishEventMarketRoster(
      { ...input(), merchants: [], organizerFee: activeFee },
      dependencies(null)
    )
    expect(
      parseEventMarketOrganizerFeeTerms({
        marketCoordinate,
        event: result.signedEvent,
      })
    ).toEqual({
      ...activeFee,
      marketCoordinate,
      organizerPubkey: organizer,
      eventId: result.signedEvent.id,
      createdAt: result.signedEvent.created_at,
    })
    expect(
      parseEventMarketRosterEvent(await admitted(result.signedEvent))
    ).not.toBeNull()
  })

  it.each([
    {
      state: "active",
      basisPoints: 250,
      minimumSats: 11,
      lightningAddress: "updated@example.com",
    },
    { state: "disabled" },
    { state: "revoked" },
  ] satisfies EventMarketOrganizerFeeAuthoring[])(
    "replaces existing fee terms explicitly with $state",
    async (organizerFee) => {
      const previous = await roster([
        [
          EVENT_MARKET_ORGANIZER_FEE_TAG,
          "1",
          "active",
          "150",
          "7",
          "organizer@example.com",
        ],
      ])
      const result = await publishEventMarketRoster(
        { ...input(previous), organizerFee },
        dependencies(previous)
      )
      expect(feeTags(result.signedEvent)).toHaveLength(1)
      expect(
        parseEventMarketOrganizerFeeTerms({
          marketCoordinate,
          event: result.signedEvent,
        })
      ).toMatchObject(organizerFee)
      expect(
        parseEventMarketRosterEvent(await admitted(result.signedEvent))
          ?.previousEventId
      ).toBe(previous.id)
    }
  )

  it("publishes zero rate and minimum as an explicit disabled fee", async () => {
    const previous = await roster()
    const result = await publishEventMarketRoster(
      {
        ...input(previous),
        organizerFee: { ...activeFee, basisPoints: 0, minimumSats: 0 },
      },
      dependencies(previous)
    )
    expect(feeTags(result.signedEvent)).toEqual([
      [EVENT_MARKET_ORGANIZER_FEE_TAG, "1", "disabled"],
    ])
  })

  const retainedFees = [
    {
      name: "active",
      tags: [
        [
          EVENT_MARKET_ORGANIZER_FEE_TAG,
          "1",
          "active",
          "150",
          "7",
          "organizer@example.com",
        ],
      ],
    },
    {
      name: "expired",
      tags: [
        [
          EVENT_MARKET_ORGANIZER_FEE_TAG,
          "1",
          "active",
          "150",
          "7",
          "organizer@example.com",
          "101",
        ],
      ],
    },
    {
      name: "unknown-version",
      tags: [
        [
          EVENT_MARKET_ORGANIZER_FEE_TAG,
          "2",
          "future-policy",
          "opaque",
          "kept:exactly",
        ],
      ],
    },
    {
      name: "disabled",
      tags: [[EVENT_MARKET_ORGANIZER_FEE_TAG, "1", "disabled"]],
    },
    {
      name: "revoked",
      tags: [[EVENT_MARKET_ORGANIZER_FEE_TAG, "1", "revoked"]],
    },
    {
      name: "duplicate-malformed",
      tags: [
        [EVENT_MARKET_ORGANIZER_FEE_TAG, "1", "disabled"],
        [EVENT_MARKET_ORGANIZER_FEE_TAG, "1", "revoked"],
      ],
    },
  ]

  for (const retained of retainedFees) {
    it.each(["state", "booth"] as const)(
      `preserves ${retained.name} fee bytes on unrelated %s edits`,
      async (change) => {
        const previous = await roster(retained.tags)
        const result = await publishEventMarketRoster(
          {
            ...input(previous),
            ...(change === "state"
              ? { state: "closed" as const }
              : { merchants: [{ ...row, assignment: "Booth 2" }] }),
          },
          dependencies(previous)
        )
        expect(JSON.stringify(feeTags(result.signedEvent))).toBe(
          JSON.stringify(feeTags(previous))
        )
      }
    )

    it.each(["approve", "revoke"] as const)(
      `preserves ${retained.name} fee bytes through paired merchant %s`,
      async (action) => {
        const previous = await roster(
          retained.tags,
          action === "approve" ? [] : [row]
        )
        const authorization = await admitted(
          finalizeEvent(
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
            organizerSecret
          )
        )
        const tip = parseEventMarketAuthorizationEvent(authorization)!
        const effects: string[] = []
        let saved: SignedEventMarketMerchantDecision | undefined
        const result = await publishEventMarketMerchantDecision(
          {
            organizerPubkey: organizer,
            authenticatedPubkey: organizer,
            dTag,
            calendarCoordinate,
            merchantPubkey: merchant,
            action,
            ...(action === "approve" ? { row } : {}),
            expectedPreviousEventId: previous.id,
            expectedAuthorizationTipIds:
              action === "approve" ? [] : [tip.eventId],
          },
          {
            ...dependencies(previous),
            readAuthorization: async () => ({
              marketCoordinate,
              merchantPubkey: merchant,
              resolution:
                action === "approve"
                  ? { state: "missing" }
                  : { state: "active", tip },
              coverage: "complete",
              retained: true,
              actionable: action !== "approve",
              observedEvidence: action === "approve" ? [] : [authorization],
            }),
            persist: async (decision) => {
              saved = structuredClone(decision)
              effects.push("persist")
            },
            load: async () => undefined,
            acknowledge: async () => {
              effects.push("acknowledge")
            },
            publish: async (event) => {
              expect(saved).toBeDefined()
              expect(JSON.stringify(event)).toBe(
                JSON.stringify(
                  event.kind === 30409 ? saved!.roster : saved!.authorization
                )
              )
              effects.push("publish")
              return delivery
            },
          }
        )
        expect(effects).toEqual([
          "persist",
          "publish",
          "publish",
          "acknowledge",
        ])
        expect(JSON.stringify(feeTags(result.signed.roster))).toBe(
          JSON.stringify(feeTags(previous))
        )
      }
    )
  }

  it("persists fee-bearing signed bytes before delivery and retries the same event after ACK loss", async () => {
    const previous = await roster()
    const effects: string[] = []
    let saved: SignedPublicNostrEvent | undefined
    const deps = dependencies(previous, effects)
    await expectRejected(
      publishEventMarketRoster(
        {
          ...input(previous),
          organizerFee: activeFee,
          onSignedLocal: async (event) => {
            saved = structuredClone(event)
            effects.push("persist")
          },
        },
        {
          ...deps,
          publish: async (event) => {
            expect(JSON.stringify(event)).toBe(JSON.stringify(saved))
            effects.push("publish")
            return {
              ...delivery,
              successfulRelayUrls: [],
              failedRelayUrls: ["wss://example.com"],
              relayFailureMessages: {
                "wss://example.com": "acknowledgement timeout",
              },
            }
          },
        }
      ),
      "saved for retry"
    )
    expect(effects).toEqual(["sign", "persist", "publish"])
    await retryEventMarketRosterDelivery(
      { signedEvent: saved!, authenticatedPubkey: organizer },
      {
        read: deps.read,
        publish: async (event) => {
          expect(JSON.stringify(event)).toBe(JSON.stringify(saved))
          effects.push("retry")
          return delivery
        },
      }
    )
    expect(effects).toEqual(["sign", "persist", "publish", "retry"])
  })

  it.each(["cross-author", "fee-replacement"] as const)(
    "rejects a %s signer response before persistence or delivery",
    async (change) => {
      const previous = await roster()
      const effects: string[] = []
      await expectRejected(
        publishEventMarketRoster(
          {
            ...input(previous),
            organizerFee: activeFee,
            onSignedLocal: async () => {
              effects.push("persist")
            },
          },
          {
            ...dependencies(previous, effects),
            sign: async ({ draft, createdAt }) => {
              effects.push("sign")
              if (change === "fee-replacement") {
                const changed = draft.tags.map((tag) =>
                  tag[0] === EVENT_MARKET_ORGANIZER_FEE_TAG
                    ? [tag[0], "1", "disabled"]
                    : [...tag]
                )
                return finalizeEvent(
                  { ...draft, tags: changed, created_at: createdAt },
                  organizerSecret
                )
              }
              return finalizeEvent(
                { ...draft, created_at: createdAt },
                generateSecretKey()
              )
            },
          }
        ),
        "Signer changed"
      )
      expect(effects).toEqual(["sign"])
    }
  )

  it.each([
    { ...activeFee, basisPoints: -1 },
    { ...activeFee, basisPoints: 0.5 },
    { ...activeFee, minimumSats: -1 },
    { ...activeFee, lightningAddress: "not-an-address" },
    { ...activeFee, expiresAt: 0.5 },
  ])("rejects malformed fee inputs before signing", async (organizerFee) => {
    const previous = await roster()
    const effects: string[] = []
    await expectRejected(
      publishEventMarketRoster(
        {
          ...input(previous),
          organizerFee,
          onSignedLocal: async () => {
            effects.push("persist")
          },
        },
        dependencies(previous, effects)
      )
    )
    expect(effects).toEqual([])
  })

  it.each([0, -1])(
    "rejects fee expiry at/before the next signed revision (%s) without delivery",
    async (offset) => {
      const previous = await roster()
      const effects: string[] = []
      await expectRejected(
        publishEventMarketRoster(
          {
            ...input(previous),
            organizerFee: {
              ...activeFee,
              expiresAt: Math.floor(Date.now() / 1000) + offset,
            },
            onSignedLocal: async () => {
              effects.push("persist")
            },
          },
          dependencies(previous, effects)
        )
      )
      expect(effects).not.toContain("persist")
      expect(effects).not.toContain("publish")
    }
  )

  it("rejects a stale parent before signing a changed fee", async () => {
    const previous = await roster()
    const effects: string[] = []
    await expectRejected(
      publishEventMarketRoster(
        {
          ...input(previous),
          expectedPreviousEventId: getPublicKey(generateSecretKey()),
          organizerFee: activeFee,
        },
        dependencies(previous, effects)
      ),
      "changed"
    )
    expect(effects).toEqual([])
  })

  it("checks expiry against a future parent's next timestamp, not just the wall clock", async () => {
    const previous = await roster(
      [],
      [row],
      Math.floor(Date.now() / 1_000) + 100
    )
    const effects: string[] = []
    await expectRejected(
      publishEventMarketRoster(
        {
          ...input(previous),
          organizerFee: { ...activeFee, expiresAt: previous.created_at + 1 },
        },
        dependencies(previous, effects)
      ),
      "expired"
    )
    expect(effects).toEqual([])
  })
})
