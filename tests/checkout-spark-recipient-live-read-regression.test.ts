import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayHealth,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  config,
  admitPublicEvent,
  getProfiles,
  type CachedProfile,
  type CachedRelayList,
} from "@conduit/core"
import { readCheckoutSparkRecipientPayoutAddress } from "../apps/market/src/lib/checkout-spark-recipient-profile"

const NOW = 1_790_000_000_000
// Public-shaped URLs exercise ordinary hint admission; no transport is opened.
const AUTHOR_RELAY = "wss://author-write.conduit.market"
const originalConfig = structuredClone(config)
type SignedEvent = ReturnType<typeof finalizeEvent>

async function admitObservedEvents(events: SignedEvent[]) {
  const admissions = await Promise.all(
    events.map((event) => admitPublicEvent(structuredClone(event)))
  )
  return admissions.flatMap((admission) =>
    admission.status === "verified" ? [admission.event] : []
  )
}

function fixture(
  options: {
    discoveryTimeout?: boolean
    authorTimeout?: boolean
    optionalProfileTimeout?: boolean
    discoveryRelayCount?: number
    storageFailure?: "read" | "write"
    failInitialCacheRead?: boolean
  } = {}
) {
  if (options.discoveryRelayCount) {
    config.appReadRelayUrls = Array.from(
      { length: options.discoveryRelayCount },
      (_, index) => `wss://discovery-${index}.conduit.market`
    )
    config.corePublicFallbackRelayUrls = []
  }
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const signProfile = (content: string, createdAt = NOW / 1_000 - 10) =>
    finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content }, secret)
  const signRelayList = (tags: string[][], createdAt = NOW / 1_000 - 20) =>
    finalizeEvent(
      { kind: 10002, created_at: createdAt, tags, content: "" },
      secret
    )
  const profile = signProfile(
    JSON.stringify({ lud16: "recipient@wallet.example" })
  )
  const relayList = signRelayList([["r", AUTHOR_RELAY, "write"]])
  let observedProfiles = [profile]
  let observedRelayLists = [relayList]
  const profiles = new Map<string, CachedProfile>()
  const relayLists = new Map<string, CachedRelayList>()
  const profileResults: Awaited<ReturnType<typeof getProfiles>>[] = []
  let profileCacheReadCount = 0
  let nextFailedProfileCacheRead = options.failInitialCacheRead ? 1 : 0
  const observations = {
    discoveryRequested: 0,
    discoveryAdmitted: 0,
    discoverySuccess: 0,
    discoveryFailure: 0,
    authorReads: 0,
    profileRelayUrls: [] as string[],
    profileAdmittedRelayUrls: [] as string[],
  }

  __setRelayListTestOverrides({
    now: () => NOW,
    loadCached: async (key) => relayLists.get(key),
    putCached: async (row) => {
      relayLists.set(row.pubkey, row)
    },
    fetchSignedEventsFanoutDetailed: async (_filter, fetchOptions) => {
      const requestedRelayUrls = [...fetchOptions.relayUrls]
      const relayUrls = requestedRelayUrls.slice(
        0,
        fetchOptions.maxRelayAttempts
      )
      expect(relayUrls.length).toBeGreaterThan(1)
      observations.discoveryRequested = requestedRelayUrls.length
      observations.discoveryAdmitted = relayUrls.length
      const failedCount = options.discoveryTimeout ? 1 : 0
      observations.discoverySuccess += relayUrls.length - failedCount
      observations.discoveryFailure += failedCount
      const events = await admitObservedEvents(observedRelayLists)
      return {
        events,
        eventsVerified: true,
        admittedRelayUrls: relayUrls,
        relays: relayUrls.map((relayUrl, index) => ({
          relayUrl,
          status:
            options.discoveryTimeout && index === relayUrls.length - 1
              ? "failed"
              : "success",
          eventCount:
            options.discoveryTimeout && index === relayUrls.length - 1
              ? 0
              : events.length,
        })),
      }
    },
  })
  __setCommerceTestOverrides({
    now: () => NOW,
    getCachedProfiles: async (keys) => {
      profileCacheReadCount += 1
      if (
        options.storageFailure === "read" ||
        profileCacheReadCount === nextFailedProfileCacheRead
      )
        throw new Error("Synthetic profile storage read unavailable")
      return keys.map((key) => profiles.get(key))
    },
    putCachedProfiles: async (rows) => {
      if (options.storageFailure === "write") {
        throw new Error("Synthetic profile storage write unavailable")
      }
      for (const row of rows) profiles.set(row.pubkey, row)
    },
    fetchSignedEventsFanoutDetailed: async (_filter, fetchOptions) => {
      const requestedRelayUrls = [...(fetchOptions?.relayUrls ?? [])]
      const relayUrls = requestedRelayUrls.slice(
        0,
        fetchOptions?.maxRelayAttempts
      )
      observations.profileRelayUrls = requestedRelayUrls
      observations.profileAdmittedRelayUrls = relayUrls
      if (relayUrls.includes(AUTHOR_RELAY)) observations.authorReads += 1
      const events = await admitObservedEvents(observedProfiles)
      return {
        events,
        eventsVerified: true,
        admittedRelayUrls: relayUrls,
        relays: relayUrls.map((relayUrl) => {
          const failed =
            relayUrl === AUTHOR_RELAY
              ? options.authorTimeout === true
              : options.optionalProfileTimeout === true
          return {
            relayUrl,
            status: failed ? "failed" : "success",
            eventCount: failed ? 0 : events.length,
          }
        }),
      }
    },
  })
  return {
    observations,
    profile,
    relayList,
    profileResults,
    failNextProfileCacheRead: () => {
      nextFailedProfileCacheRead = profileCacheReadCount + 1
    },
    signProfile,
    signRelayList,
    observeProfiles: (events: SignedEvent[]) => {
      observedProfiles = events
    },
    observeRelayLists: (events: SignedEvent[]) => {
      observedRelayLists = events
    },
    read: () =>
      readCheckoutSparkRecipientPayoutAddress(
        {
          recipientPubkey: pubkey,
          accountPubkey: null,
          authenticatedPubkey: null,
          shouldContinue: () => true,
        },
        {
          // Observe the real read without replacing its planning, selection,
          // validation, or cache-retention behavior.
          readProfiles: async (query) => {
            const result = await getProfiles(query)
            profileResults.push(result)
            return result
          },
        }
      ),
  }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayHealth()
  Object.assign(config, structuredClone(originalConfig), {
    e2eRelayIsolationEnabled: false,
  })
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayHealth()
  Object.assign(config, structuredClone(originalConfig))
})

describe("checkout recipient ordinary live-read evidence", () => {
  it("accepts a freshly signed declaration and complete author profile despite an optional discovery timeout", async () => {
    const f = fixture({ discoveryTimeout: true })
    const result = await f.read()
    expect(f.observations.discoverySuccess).toBeGreaterThan(0)
    expect(f.observations.discoveryFailure).toBeGreaterThan(0)
    expect(f.observations.authorReads).toBe(1)
    expect(result.state).toBe("ready")
    expect(f.profileResults[0]!.meta.degraded).toBe(true)
    expect(
      f.profileResults[0]!.profileContexts[f.profile.pubkey]!.readComplete
    ).toBe(false)
    if (result.state === "ready") {
      expect(result.profileEventId).toBe(f.profile.id)
      expect(result.signedEvent).toEqual(structuredClone(f.profile))
    }
  })

  it("accepts a current signed destination when discovery requests eight relays but admits six", async () => {
    const f = fixture({ discoveryRelayCount: 8 })
    const result = await f.read()
    expect(f.observations.discoveryRequested).toBe(8)
    expect(f.observations.discoveryAdmitted).toBe(6)
    expect(f.observations.discoverySuccess).toBe(6)
    expect(f.observations.discoveryFailure).toBe(0)
    expect(f.observations.authorReads).toBe(1)
    expect(result.state).toBe("ready")
    expect(f.profileResults[0]!.meta.degraded).toBe(true)
    expect(
      f.profileResults[0]!.profileContexts[f.profile.pubkey]!.readComplete
    ).toBe(false)
  })

  it("accepts complete declared author evidence when optional profile relays time out", async () => {
    const f = fixture({ optionalProfileTimeout: true })
    const result = await f.read()
    expect(f.observations.discoveryFailure).toBe(0)
    expect(f.observations.authorReads).toBe(1)
    expect(result.state).toBe("ready")
    if (result.state === "ready") {
      expect(result.profileEventId).toBe(f.profile.id)
      expect(result.signedEvent).toEqual(structuredClone(f.profile))
    }
  })

  it("accepts the exact signed profile observed elsewhere while author coverage remains incomplete", async () => {
    const f = fixture({ authorTimeout: true })
    const result = await f.read()
    expect(result.state).toBe("ready")
    expect(f.observations.discoveryFailure).toBe(0)
    expect(f.observations.authorReads).toBe(1)
    expect(f.profileResults[0]!.meta.degraded).toBe(true)
    expect(
      f.profileResults[0]!.profileContexts[f.profile.pubkey]!.readComplete
    ).toBe(false)
  })

  it("accepts an observed signed profile without falsely completing a capped author-write set", async () => {
    const f = fixture()
    const authorRelays = Array.from(
      { length: 9 },
      (_, index) => `wss://author-${index}.conduit.market`
    )
    f.observeRelayLists([
      f.signRelayList(authorRelays.map((url) => ["r", url, "write"])),
    ])
    expect((await f.read()).state).toBe("ready")
    expect(f.observations.profileRelayUrls).toHaveLength(9)
    expect(f.observations.profileAdmittedRelayUrls).toHaveLength(8)
    expect(f.profileResults[0]!.meta.capped).toBe(true)
    expect(f.profileResults[0]!.meta.degraded).toBe(true)
    expect(
      f.profileResults[0]!.profileContexts[f.profile.pubkey]!.readComplete
    ).toBe(false)
  })

  for (const declaration of [
    "absent",
    "empty",
    "read-only",
    "malformed",
  ] as const) {
    it(`accepts a current signed profile when its routing declaration is ${declaration}`, async () => {
      const f = fixture()
      const tags =
        declaration === "read-only"
          ? [["r", AUTHOR_RELAY, "read"]]
          : declaration === "malformed"
            ? [["r", "not-a-relay", "write"]]
            : []
      f.observeRelayLists(
        declaration === "absent" ? [] : [f.signRelayList(tags)]
      )
      expect((await f.read()).state).toBe("ready")
      expect(f.profileResults[0]!.meta.degraded).toBe(true)
    })
  }

  it("does not treat a weaker live routing declaration as a replacement for retained routing evidence", async () => {
    const f = fixture()
    const newerRelay = "wss://newer-author-write.conduit.market"
    f.observeRelayLists([
      f.signRelayList([["r", newerRelay, "write"]], NOW / 1_000),
    ])
    expect((await f.read()).state).toBe("ready")
    f.observeRelayLists([f.relayList])
    expect((await f.read()).state).toBe("ready")
    expect(f.observations.profileRelayUrls).toContain(newerRelay)
    expect(f.observations.profileRelayUrls).not.toContain(AUTHOR_RELAY)
    expect(f.profileResults[1]!.meta.degraded).toBe(true)
  })

  it("does not replace a stronger retained profile with an older live destination", async () => {
    const f = fixture()
    const newer = f.signProfile(
      JSON.stringify({ lud16: "newer@wallet.example" }),
      NOW / 1_000
    )
    f.observeProfiles([newer])
    expect((await f.read()).state).toBe("ready")
    f.observeProfiles([f.profile])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_not_observed",
    })
  })

  it("does not authorize an absent profile or reauthorize a cache-only destination", async () => {
    const f = fixture()
    f.observeProfiles([])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_unavailable",
    })
    f.observeProfiles([f.profile])
    expect((await f.read()).state).toBe("ready")
    f.observeProfiles([])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_not_observed",
    })
  })

  it("does not authorize a signed but malformed replacement profile", async () => {
    const f = fixture()
    expect((await f.read()).state).toBe("ready")
    f.observeProfiles([f.signProfile("[]", NOW / 1_000)])
    expect(await f.read()).toEqual({
      state: "invalid",
      reason: "profile_frontier_invalid",
    })
  })

  it("does not resurrect a removed payout address from an older valid profile", async () => {
    const f = fixture()
    expect((await f.read()).state).toBe("ready")
    f.observeProfiles([f.profile, f.signProfile("{}", NOW / 1_000)])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "payment_address_missing",
    })
  })

  it("rejects a malformed payout address from a current signed profile", async () => {
    const f = fixture()
    f.observeProfiles([
      f.signProfile(JSON.stringify({ lud16: "not-an-address" })),
    ])
    expect(await f.read()).toEqual({
      state: "invalid",
      reason: "payment_address_invalid",
    })
  })

  it("does not authorize a profile with an invalid signature", async () => {
    const f = fixture()
    f.observeProfiles([{ ...f.profile, sig: "00".repeat(64) }])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_unavailable",
    })
    const context = f.profileResults.at(-1)?.profileContexts[f.profile.pubkey]
    expect(context?.signedEvent).toBeUndefined()
    expect(context?.frontier).toBeUndefined()
  })

  it("uses the canonical signed frontier when equal-timestamp profiles disagree", async () => {
    const f = fixture()
    const alternative = f.signProfile(
      JSON.stringify({ lud16: "other@wallet.example" })
    )
    const [winner, loser] = [f.profile, alternative].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
    f.observeProfiles([loser!, winner!])
    const first = await f.read()
    expect(first.state).toBe("ready")
    if (first.state === "ready") expect(first.profileEventId).toBe(winner!.id)
    f.observeProfiles([loser!])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_not_observed",
    })
  })

  for (const failure of ["read", "write"] as const) {
    it(`does not authorize a live destination when durable profile ${failure} fails`, async () => {
      const f = fixture({ storageFailure: failure })
      expect(await f.read()).toEqual({
        state: "unavailable",
        reason: "read_incomplete",
      })
      expect(
        f.profileResults[0]!.profileContexts[f.profile.pubkey]!.persistence
      ).not.toBe("durable")
    })
  }

  it("accepts the final durable selection after only the initial cache snapshot fails", async () => {
    const f = fixture({ failInitialCacheRead: true })
    expect((await f.read()).state).toBe("ready")
    expect(
      f.profileResults[0]!.profileContexts[f.profile.pubkey]!.persistence
    ).toBe("durable")
    expect(f.profileResults[0]!.meta.degraded).toBe(true)
  })

  it("still preserves a stronger durable frontier when the initial snapshot fails but retention can read it", async () => {
    const f = fixture()
    const newer = f.signProfile(
      JSON.stringify({ lud16: "newer@wallet.example" }),
      NOW / 1_000
    )
    f.observeProfiles([newer])
    expect((await f.read()).state).toBe("ready")
    f.failNextProfileCacheRead()
    f.observeProfiles([f.profile])
    expect(await f.read()).toEqual({
      state: "unavailable",
      reason: "profile_not_observed",
    })
    const context = f.profileResults[1]!.profileContexts[f.profile.pubkey]!
    expect(context.frontier?.eventId).toBe(newer.id)
    expect(context.freshness).toBe("retained")
    expect(context).not.toHaveProperty("signedEvent")
  })
})
