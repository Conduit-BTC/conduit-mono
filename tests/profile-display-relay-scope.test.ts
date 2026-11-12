import { getPublicFeedReadPlan } from "../packages/core/src/protocol/public-feed-read-scope"
import { fetchSignedEventsFanoutDetailed } from "../packages/core/src/protocol/relay-reader"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { resolveCheckoutSparkRecipientPayoutAddress } from "../packages/core/src/protocol/checkout-spark-recipient-profile"
import { searchNetworkProfiles } from "../packages/core/src/protocol/profile-search"
import { readLatestFollowLists } from "../packages/core/src/protocol/follows"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { config } from "../packages/core/src/config"
import type { CachedProfile, CachedProduct } from "../packages/core/src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getProfiles,
} from "../packages/core/src/protocol/commerce"
import { parseRelayListEvent } from "../packages/core/src/protocol/relay-list"
import {
  closePublicRelayConnections,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import { admitFixture } from "./helpers/public-event"

const fixtureKey = new Uint8Array(32).fill(7)
const merchant = getPublicKey(fixtureKey)
const relay = (label: string) => `wss://${label}.profile-scope-fixture.net`
const app = relay("app")
const author = relay("author-write")
const explicit = relay("current-product")
const historical = Array.from({ length: 105 }, (_, i) => relay(`old-${i}`))
const allowed = new Set([app, author, explicit, ...historical])
const originalConfig = { ...config }
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const attempted = new Set<string>()
const socketDestinations = new Set<string>()
const failedRelays = new Set<string>()
const heldRelays = new Set<string>()
const heldRequests = new Set<string>()
const replies: (() => void)[] = []
let blockedNetworkAttempts = 0
let cachedProfiles: CachedProfile[] = []
let profileEvent: ReturnType<typeof finalizeEvent> | undefined

class FixtureSocket implements PublicRelayReadSocket {
  readyState = 0
  onopen: PublicRelayReadSocket["onopen"] = null
  onmessage: PublicRelayReadSocket["onmessage"] = null
  onerror: PublicRelayReadSocket["onerror"] = null
  onclose: PublicRelayReadSocket["onclose"] = null
  constructor(readonly url: string) {
    socketDestinations.add(url)
    if (!allowed.has(url)) {
      blockedNetworkAttempts++
      throw new Error("Unexpected offline relay target")
    }
    queueMicrotask(() => {
      if (failedRelays.has(url)) {
        this.onerror?.(new Event("error"))
        this.close()
        return
      }
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const [type, subscription] = JSON.parse(payload)
    if (type === "CLOSE") heldRequests.delete(this.url)
    if (type !== "REQ") return
    attempted.add(this.url)
    queueMicrotask(() => {
      const reply = () => {
        if (profileEvent)
          this.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify(["EVENT", subscription, profileEvent]),
            })
          )
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify(["EOSE", subscription]),
          })
        )
      }
      if (heldRelays.has(this.url)) {
        heldRequests.add(this.url)
        replies.push(reply)
      } else reply()
    })
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new Event("close"))
  }
}

beforeEach(async () => {
  attempted.clear()
  socketDestinations.clear()
  failedRelays.clear()
  heldRelays.clear()
  heldRequests.clear()
  replies.length = 0
  blockedNetworkAttempts = 0
  cachedProfiles = []
  profileEvent = undefined
  Object.assign(config, {
    defaultRelays: [app],
    appReadRelayUrls: [app],
    corePublicFallbackRelayUrls: [app],
  })
  globalThis.fetch = (async () => {
    blockedNetworkAttempts++
    throw new Error("Real fetch forbidden in offline fixture")
  }) as typeof fetch
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
  const relayList = parseRelayListEvent(
    await admitFixture(
      finalizeEvent(
        {
          kind: 10002,
          created_at: 1,
          content: "",
          tags: [["r", author, "write"]],
        },
        fixtureKey
      )
    )
  )
  const cachedProducts: CachedProduct[] = historical.map((url, i) => ({
    id: `fixture-${i}`,
    pubkey: merchant,
    title: "Fixture",
    price: 1,
    currency: "SATS",
    images: [],
    tags: [],
    sourceRelayUrls: [url],
    cachedAt: 1,
  }))
  __setCommerceTestOverrides({
    getCachedProfiles: async (pubkeys) =>
      pubkeys.map((pubkey) =>
        cachedProfiles.find((row) => row.pubkey === pubkey)
      ),
    putCachedProfiles: async (rows) => {
      cachedProfiles = rows
    },
    getCachedProducts: async () => cachedProducts,
    getRelayLists: async () => new Map([[merchant, relayList]]),
    getRelayListsDetailed: async () => ({
      relayLists: new Map([[merchant, relayList]]),
      resolutionStates: new Map([[merchant, "network" as const]]),
    }),
  })
})

afterEach(() => {
  closePublicRelayConnections()
  __resetCommerceTestOverrides()
  Object.assign(config, originalConfig)
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  expect(blockedNetworkAttempts).toBe(0)
})

test.each([undefined, "full_profile"] as const)(
  "ordinary display (%s) keeps current hints without historical product sources",
  async (evidenceScope) => {
    const result = await getProfiles({
      pubkeys: [merchant],
      evidenceScope,
      relayHintsByPubkey: { [merchant]: [explicit, historical[0]!] },
      onProgress: () => {},
    })
    expect(attempted).toEqual(new Set([app, author, explicit, historical[0]!]))
    expect(result.profileContexts[merchant]?.readComplete).toBe(false)
  }
)

test.each(["full_profile", "profile_edit", "payment"] as const)(
  "complete-evidence %s discovery keeps its existing relay sources",
  async (evidenceScope) => {
    await getProfiles({
      pubkeys: [merchant],
      evidenceScope,
      requireCompleteEvidence: true,
      authorRelayPaymentPolicy: evidenceScope === "payment",
      relayHintsByPubkey: { [merchant]: [explicit, historical[0]!] },
    })
    expect(attempted).toEqual(
      evidenceScope === "payment"
        ? new Set([app, author, explicit, historical[0]!])
        : allowed
    )
  }
)

test("a narrower display read retains a newer cached profile frontier", async () => {
  profileEvent = finalizeEvent(
    {
      kind: 0,
      created_at: 1,
      tags: [],
      content: JSON.stringify({ name: "Older" }),
    },
    fixtureKey
  )
  const newer = finalizeEvent(
    {
      kind: 0,
      created_at: 2,
      tags: [],
      content: JSON.stringify({ name: "Retained" }),
    },
    fixtureKey
  )
  cachedProfiles = [
    {
      pubkey: merchant,
      name: "Retained",
      rawContent: newer.content,
      eventId: newer.id,
      eventCreatedAt: newer.created_at,
      cachedAt: 0,
    },
  ]
  const result = await getProfiles({
    pubkeys: [merchant],
    onProgress: () => {},
  })
  expect(result.data[merchant]?.name).toBe("Retained")
  expect(result.profileContexts[merchant]?.frontier?.eventId).toBe(newer.id)
  expect(result.profileContexts[merchant]?.readComplete).toBe(false)
})

test("public feed profiles ignore advertised and cached relay destinations", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  let relayListLookups = 0
  __setCommerceTestOverrides({
    getRelayLists: async () => {
      relayListLookups++
      return new Map()
    },
    getRelayListsDetailed: async () => {
      relayListLookups++
      return { relayLists: new Map(), resolutionStates: new Map() }
    },
  })
  await getProfiles({
    pubkeys: [merchant],
    readScope: "public_feed",
    relayHintsByPubkey: { [merchant]: [explicit, ...historical] },
    requireCompleteEvidence: true,
  })
  expect(attempted).toEqual(new Set([app]))
  expect(relayListLookups).toBe(0)
})

test("public feed follow support does not discover author relay lists", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  let relayListLookups = 0
  const result = await readLatestFollowLists(
    { pubkeys: [merchant] },
    {
      readScope: "public_feed",
      resolveRelayLists: async () => {
        relayListLookups++
        return new Map()
      },
    }
  )
  expect(attempted).toEqual(new Set([app]))
  expect(relayListLookups).toBe(0)
  expect(result.authors[0]?.coverage).toBe("complete")
})

test("public feed seller search bypasses account search destinations", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  let genericPlans = 0
  await searchNetworkProfiles(
    { query: "fixture", readScope: "public_feed" },
    {
      planSearchRelayTargets: () => {
        genericPlans++
        return []
      },
    }
  )
  expect(attempted).toEqual(new Set([app]))
  expect(genericPlans).toBe(0)
})

test("a feed display profile cannot authorize a recipient payout", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  profileEvent = finalizeEvent(
    {
      kind: 0,
      created_at: 1,
      tags: [],
      content: JSON.stringify({
        name: "Fixture",
        lud16: "fixture@profile-scope-fixture.net",
      }),
    },
    fixtureKey
  )
  const result = await getProfiles({
    pubkeys: [merchant],
    readScope: "public_feed",
    skipCache: true,
    requireCompleteEvidence: true,
  })
  expect(result.data[merchant]?.name).toBe("Fixture")
  expect(
    resolveCheckoutSparkRecipientPayoutAddress({
      recipientPubkey: merchant,
      context: result.profileContexts[merchant],
      readMeta: result.meta,
    }).state
  ).toBe("unavailable")
  expect(result.profileContexts[merchant]?.freshness).not.toBe("observed")
})

test.each(["payment", "profile_edit"] as const)(
  "feed reads reject incompatible %s authority requests before I/O",
  async (evidenceScope) => {
    await expect(
      getProfiles({
        pubkeys: [merchant],
        readScope: "public_feed",
        evidenceScope,
        skipCache: true,
        requireCompleteEvidence: true,
      })
    ).rejects.toThrow("cannot supply")
    expect(attempted.size).toBe(0)
  }
)

test("feed profile total outage is degraded without a broader fallback", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  failedRelays.add(app)
  const result = await getProfiles({
    pubkeys: [merchant],
    readScope: "public_feed",
    skipCache: true,
  })
  expect(result.meta.degraded).toBe(true)
  expect(result.profileContexts[merchant]?.readComplete).toBe(false)
  expect(blockedNetworkAttempts).toBe(0)
})

test("feed app grants honor the account's disabled app layer before opening sockets", async () => {
  Object.assign(config, {
    appCommerceRelayUrls: [app],
    commerceDiscoveryRelayUrls: [app],
  })
  const state = emptyAccountNetworkLocalState(merchant)
  state.routingPolicy.appRelaysEnabled = false
  let relayListLookups = 0
  __setCommerceTestOverrides({
    accountNetworkLocalStateRepository: { get: async () => state },
    getRelayLists: async () => {
      relayListLookups++
      return new Map()
    },
  })
  const result = await getProfiles({
    pubkeys: [merchant],
    accountPubkey: merchant,
    readScope: "public_feed",
    skipCache: true,
  })
  expect(result.meta.degraded).toBe(true)
  expect(socketDestinations.size).toBe(0)
  expect(relayListLookups).toBe(0)
})

test("repeated feed profile reads retain configured-peer coverage through cooldown", async () => {
  const failingPeer = relay("feed-b")
  allowed.add(failingPeer)
  Object.assign(config, {
    appCommerceRelayUrls: [app, failingPeer],
    commerceDiscoveryRelayUrls: [app, failingPeer],
  })
  failedRelays.add(failingPeer)
  for (let round = 0; round < 4; round++) {
    closePublicRelayConnections()
    const result = await getProfiles({
      pubkeys: [merchant],
      readScope: "public_feed",
      skipCache: true,
    })
    expect(result.meta.degraded).toBe(true)
  }
})

test("a denied configured peer stays incomplete without being counted as an I/O attempt", async () => {
  const excludedPeer = relay("excluded")
  allowed.add(excludedPeer)
  Object.assign(config, {
    appCommerceRelayUrls: [app, excludedPeer],
    commerceDiscoveryRelayUrls: [app, excludedPeer],
  })
  const state = emptyAccountNetworkLocalState(merchant)
  state.exclusions = [
    {
      relayUrl: excludedPeer,
      committedAt: 1,
      relayListFrontier: { eventId: null, createdAt: null },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
    },
  ]
  const plan = getPublicFeedReadPlan()
  const result = await fetchSignedEventsFanoutDetailed(
    { kinds: [0], authors: [merchant] },
    {
      relayUrls: plan.candidateRelayUrls,
      relayTargets: plan.relayTargets,
      requireAllRequestedRelays: true,
      accountPubkey: merchant,
      accountNetworkLocalStateRepository: { get: async () => state },
    }
  )
  expect(result.readCoverage).toBe("partial")
  expect(result.attemptedRelayUrls).toEqual([app])
  expect(result.admittedRelayUrls).toEqual([app])
  expect(socketDestinations).toEqual(new Set([app]))
  expect(
    result.relays.find((row) => row.relayUrl === excludedPeer)
  ).toMatchObject({ status: "failed", attempted: false })
})

test("feed profile progress paints before a second peer finishes", async () => {
  const heldPeer = relay("held")
  allowed.add(heldPeer)
  Object.assign(config, {
    appCommerceRelayUrls: [app, heldPeer],
    commerceDiscoveryRelayUrls: [app, heldPeer],
  })
  heldRelays.add(heldPeer)
  profileEvent = finalizeEvent(
    {
      kind: 0,
      created_at: 1,
      tags: [],
      content: JSON.stringify({ name: "Early fixture" }),
    },
    fixtureKey
  )
  let observed!: () => void
  const progress = new Promise<void>((resolve) => {
    observed = resolve
  })
  const reading = getProfiles({
    pubkeys: [merchant],
    readScope: "public_feed",
    skipCache: true,
    onProgress: (result) => {
      if (result.data[merchant]?.name === "Early fixture") observed()
    },
  })
  try {
    await progress
    expect(heldRequests.has(heldPeer)).toBe(true)
  } finally {
    for (const reply of replies.splice(0)) reply()
    await reading
  }
})
