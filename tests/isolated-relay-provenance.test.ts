import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  applyE2eRelayIsolation,
  config,
  getRelayListsDetailed,
  planRelayReads,
  type CachedProfile,
  type CachedRelayList,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type VerifiedEvent,
} from "nostr-tools"
import { readCheckoutSparkRecipientPayoutAddress } from "../apps/market/src/lib/checkout-spark-recipient-profile"

const ISOLATED_RELAY = "ws://127.0.0.1:7777"
const originalConfig = structuredClone(config)
const authorSecret = generateSecretKey()
const authorPubkey = getPublicKey(authorSecret)
const buyerPubkey = getPublicKey(generateSecretKey())

function signedRelayList(tags: string[][]): VerifiedEvent {
  return finalizeEvent(
    { kind: 10002, created_at: 1_790_000_000, tags, content: "" },
    authorSecret
  )
}

async function readAuthorPlan(
  events: VerifiedEvent[],
  options: {
    authenticatedPubkey?: string
    relayUrl?: string
    transportStatus?: "success" | "partial"
  } = {}
) {
  const cache = new Map<string, CachedRelayList>()
  __setRelayListTestOverrides({
    loadCached: async (pubkey) => cache.get(pubkey),
    putCached: async (entry) => {
      cache.set(entry.pubkey, entry)
    },
    fetchSignedEventsFanoutDetailed: async (_filter, fetchOptions) => ({
      events: events.map((event) => structuredClone(event)),
      eventsVerified: events.every((event) =>
        verifyEvent(structuredClone(event))
      ),
      admittedRelayUrls: [...fetchOptions.relayUrls],
      relays: fetchOptions.relayUrls.map((relayUrl) => ({
        relayUrl,
        status: options.transportStatus ?? "success",
        eventCount: events.length,
      })),
    }),
  })
  const lookup = await getRelayListsDetailed([authorPubkey], {
    skipCache: true,
    requireAllRequestedRelays: true,
    relayUrls: [options.relayUrl ?? ISOLATED_RELAY],
    authenticatedPubkey: options.authenticatedPubkey ?? buyerPubkey,
  })
  return {
    lookup,
    plan: planRelayReads({
      intent: "profiles",
      authors: [authorPubkey],
      authenticatedPubkey: options.authenticatedPubkey ?? buyerPubkey,
      relayLists: lookup.relayLists,
    }),
  }
}

describe("isolated signed author relay provenance", () => {
  beforeEach(() => {
    Object.assign(config, applyE2eRelayIsolation(config, [ISOLATED_RELAY]))
  })

  afterEach(() => {
    __resetCommerceTestOverrides()
    __resetRelayListTestOverrides()
    Object.assign(config, structuredClone(originalConfig))
  })

  it("preserves the author's declared write relay through lookup and profile planning", async () => {
    const event = signedRelayList([["r", ISOLATED_RELAY, "write"]])
    const { lookup, plan } = await readAuthorPlan([event])

    expect(lookup.resolutionStates.get(authorPubkey)).toBe("network")
    expect(lookup.relayLists.get(authorPubkey)?.eventId).toBe(event.id)
    expect(lookup.relayLists.get(authorPubkey)?.writeRelayUrls).toEqual([
      ISOLATED_RELAY,
    ])
    expect(plan.relayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.hintRelayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.independentRelayUrls).toEqual([ISOLATED_RELAY])
  })

  it.each([
    { name: "read-only declaration", tags: [["r", ISOLATED_RELAY, "read"]] },
    { name: "empty declaration", tags: [] },
    {
      name: "another loopback port",
      tags: [["r", "ws://127.0.0.1:7778", "write"]],
    },
    {
      name: "a public relay",
      tags: [["r", "wss://relay.conduit.market", "write"]],
    },
  ])("does not turn $name into author write provenance", async ({ tags }) => {
    const { lookup, plan } = await readAuthorPlan([signedRelayList(tags)])

    expect(lookup.resolutionStates.get(authorPubkey)).toBe("network")
    expect(lookup.relayLists.get(authorPubkey)?.writeRelayUrls).toEqual([])
    expect(plan.relayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.hintRelayUrls).toEqual([])
    expect(plan.independentRelayUrls).toEqual([])
  })

  it("keeps a missing signed declaration missing despite configured transport", async () => {
    const { lookup, plan } = await readAuthorPlan([])

    expect(lookup.resolutionStates.get(authorPubkey)).toBe("missing")
    expect(lookup.relayLists.has(authorPubkey)).toBe(false)
    expect(plan.relayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.hintRelayUrls).toEqual([])
    expect(plan.independentRelayUrls).toEqual([])
  })

  it("preserves partial lookup evidence instead of upgrading signed hints to readiness", async () => {
    const { lookup, plan } = await readAuthorPlan(
      [signedRelayList([["r", ISOLATED_RELAY, "write"]])],
      { transportStatus: "partial" }
    )

    expect(lookup.resolutionStates.get(authorPubkey)).toBe("partial-network")
    expect(plan.hintRelayUrls).toEqual([ISOLATED_RELAY])
  })

  it("retains an unmarked read/write declaration without calling it third-party when self-authenticated", async () => {
    const { lookup, plan } = await readAuthorPlan(
      [signedRelayList([["r", ISOLATED_RELAY]])],
      { authenticatedPubkey: authorPubkey }
    )

    expect(lookup.relayLists.get(authorPubkey)?.readRelayUrls).toEqual([
      ISOLATED_RELAY,
    ])
    expect(plan.hintRelayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.personalRelayUrls).toEqual([ISOLATED_RELAY])
    expect(plan.independentRelayUrls).toEqual([])
  })

  it("keeps public-mode remote hints public even for a genuinely signed loopback declaration", async () => {
    Object.assign(config, structuredClone(originalConfig), {
      e2eRelayIsolationEnabled: false,
    })
    const publicRelay = "wss://relay.conduit.market"
    const { lookup, plan } = await readAuthorPlan(
      [
        signedRelayList([
          ["r", ISOLATED_RELAY, "write"],
          ["r", publicRelay, "write"],
        ]),
      ],
      { relayUrl: publicRelay }
    )

    expect(lookup.relayLists.get(authorPubkey)?.writeRelayUrls).toEqual([
      publicRelay,
    ])
    expect(plan.hintRelayUrls).toEqual([publicRelay])
    expect(plan.candidateRelayUrls).not.toContain(ISOLATED_RELAY)
  })

  it.each([
    {
      name: "write declaration",
      tags: [["r", ISOLATED_RELAY, "write"]],
      declaredWriteRelay: true,
    },
    {
      name: "read-only declaration",
      tags: [["r", ISOLATED_RELAY, "read"]],
      declaredWriteRelay: false,
    },
    { name: "no declaration", tags: null, declaredWriteRelay: false },
    {
      name: "another loopback",
      tags: [["r", "ws://127.0.0.1:7778", "write"]],
      declaredWriteRelay: false,
    },
  ])(
    "keeps $name provenance separate from observed signed checkout profile authority",
    async ({ tags, declaredWriteRelay }) => {
      await readAuthorPlan(tags ? [signedRelayList(tags)] : [])
      const profile = finalizeEvent(
        {
          kind: 0,
          created_at: 1_790_000_000,
          tags: [],
          content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
        },
        authorSecret
      )
      const profiles = new Map<string, CachedProfile>()
      __setCommerceTestOverrides({
        getCachedProfiles: async (pubkeys) =>
          pubkeys.map((key) => profiles.get(key)),
        putCachedProfiles: async (rows) => {
          for (const row of rows) profiles.set(row.pubkey, row)
        },
        fetchSignedEventsFanoutDetailed: async (_filter, options) => {
          expect(options?.relayUrls).toEqual([ISOLATED_RELAY])
          expect(options?.independentRelayUrls).toEqual(
            declaredWriteRelay ? [ISOLATED_RELAY] : []
          )
          expect(verifyEvent(structuredClone(profile))).toBe(true)
          return {
            events: [structuredClone(profile)],
            eventsVerified: true,
            admittedRelayUrls: [ISOLATED_RELAY],
            relays: [
              { relayUrl: ISOLATED_RELAY, status: "success", eventCount: 1 },
            ],
          }
        },
      })

      const result = await readCheckoutSparkRecipientPayoutAddress({
        recipientPubkey: authorPubkey,
        accountPubkey: null,
        authenticatedPubkey: null,
        shouldContinue: () => true,
      })

      expect(result).toEqual({
        state: "ready",
        recipientPubkey: authorPubkey,
        lud16: "merchant@wallet.conduit.market",
        profileEventId: profile.id,
        profileEventCreatedAt: profile.created_at,
        signedEvent: structuredClone(profile),
      })
    }
  )
})
