import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  applyE2eRelayIsolation,
  config,
  getEventMarketReadPlan,
  resolveEventMarketPerspectiveAuthorPubkeys,
} from "@conduit/core"

const organizer = "a".repeat(64)
const owner = "b".repeat(64)
const followed = "c".repeat(64)
const originalConfig = structuredClone(config)
afterEach(() => {
  __resetEventMarketTestOverrides()
  Object.assign(config, structuredClone(originalConfig))
})

describe("current event discovery perspective boundary", () => {
  it("uses current followed authors instead of widening an explicit empty result to stale seeds", () => {
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        usesPerspectiveGraph: true,
        perspectivePubkey: owner,
        refreshedAuthorPubkeys: [],
        seedAuthorPubkeys: [followed],
        cachedAuthorPubkeys: [organizer],
      })
    ).toEqual({ authorPubkeys: [], source: "none" })
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        usesPerspectiveGraph: true,
        perspectivePubkey: owner,
        refreshedAuthorPubkeys: [
          owner,
          followed.toUpperCase(),
          followed,
          "bad",
        ],
        seedAuthorPubkeys: [organizer],
      })
    ).toEqual({ authorPubkeys: [followed], source: "refreshed" })
  })

  it("keeps following, configured and combined audiences distinct and normalizes identity", () => {
    const input = {
      usesPerspectiveGraph: true,
      perspectivePubkey: owner,
      refreshedAuthorPubkeys: [followed],
      seedAuthorPubkeys: [organizer],
      fallbackAuthorPubkeys: [organizer],
    }
    expect(resolveEventMarketPerspectiveAuthorPubkeys(input)).toEqual({
      authorPubkeys: [followed],
      source: "refreshed",
    })
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        ...input,
        sourceMode: "conduit",
      })
    ).toEqual({ authorPubkeys: [organizer], source: "seed" })
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        ...input,
        sourceMode: "combined",
      })
    ).toEqual({
      authorPubkeys: [organizer, owner, followed].sort(),
      source: "combined",
    })
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        usesPerspectiveGraph: false,
      })
    ).toEqual({ authorPubkeys: undefined, source: "none" })
    expect(
      resolveEventMarketPerspectiveAuthorPubkeys({
        usesPerspectiveGraph: true,
        followLookupSettled: true,
      })
    ).toEqual({ authorPubkeys: [], source: "none" })
  })
})

describe("current event owner-aware bounded relay plan", () => {
  it("threads live owner authority while refusing remote insecure or loopback hints", async () => {
    const ownerRelay = "ws://owner-network.example:4848"
    const shouldContinue = () => true
    let lookupOptions: Record<string, unknown> = {}
    __setEventMarketTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: [
            {
              url: ownerRelay,
              readEnabled: true,
              writeEnabled: false,
              section: "public",
              capabilities: {
                nip11: false,
                search: false,
                dm: false,
                auth: false,
                commerce: false,
              },
              warnings: {
                dmWithoutAuth: false,
                staleRelayInfo: false,
                unreachable: false,
                commercePartialSupport: false,
              },
            },
          ],
        },
        signedRelayListAuthoritative: true,
      }),
      getRelayListsDetailed: async (_pubkeys, options = {}) => {
        lookupOptions = options
        return {
          relayLists: new Map(),
          resolutionStates: new Map([[organizer, "missing" as const]]),
        }
      },
    })
    const plan = await getEventMarketReadPlan({
      organizerPubkey: organizer,
      authenticatedPubkey: owner,
      shouldContinue,
      relayHints: [
        "ws://127.0.0.1:4789",
        "ws://remote.example:4848",
        "wss://source.relay.dev",
      ],
    })
    expect(lookupOptions.authenticatedPubkey).toBe(owner)
    expect(lookupOptions.accountPubkey).toBe(owner)
    expect(lookupOptions.shouldContinue).toBe(shouldContinue)
    expect(plan.ownerSelectedRelayUrls).toEqual([ownerRelay])
    expect(plan.candidateRelayUrls).toContain(ownerRelay)
    expect(plan.candidateRelayUrls).toContain("wss://source.relay.dev")
    expect(plan.candidateRelayUrls).not.toContain("ws://remote.example:4848")
    expect(plan.candidateRelayUrls).not.toContain("ws://127.0.0.1:4789")
    const guest = await getEventMarketReadPlan({
      organizerPubkey: organizer,
      relayHints: [ownerRelay],
    })
    expect(guest.ownerSelectedRelayUrls).toEqual([])
    expect(guest.candidateRelayUrls).not.toContain(ownerRelay)
  })

  it("permits only the explicitly isolated E2E loopback", async () => {
    Object.assign(
      config,
      applyE2eRelayIsolation(config, ["ws://127.0.0.1:7777"])
    )
    __setEventMarketTestOverrides({ getRelayLists: async () => new Map() })
    const plan = await getEventMarketReadPlan({
      organizerPubkey: organizer,
      relayHints: [
        "ws://127.0.0.1:7777",
        "ws://127.0.0.1:7788",
        ...Array.from(
          { length: 12 },
          (_, index) => `wss://hint-${index}.example`
        ),
      ],
    })
    expect(plan.candidateRelayUrls).toContain("ws://127.0.0.1:7777")
    expect(plan.candidateRelayUrls).not.toContain("ws://127.0.0.1:7788")
    expect(plan.relayUrls.length).toBeLessThanOrEqual(8)
  })
})
