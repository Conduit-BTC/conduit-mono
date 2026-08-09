import { describe, expect, it } from "bun:test"
import type { NDKFilter } from "@nostr-dev-kit/ndk"
import {
  db,
  EVENT_KINDS,
  getShopperTrustEvidence,
  shopperTrustSnapshotIsExpired,
  SHOPPER_TRUST_SNAPSHOT_RETENTION_MS,
  SHOPPER_TRUST_CACHE_FRESH_MS,
  SHOPPER_TRUST_DEGRADED_CACHE_RETRY_MS,
  type CachedShopperTrustSnapshot,
  type ShopperTrustEvidenceCache,
  type ShopperTrustFetchEvents,
  type ShopperTrustResolveRelayLists,
} from "@conduit/core"
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const NOW_SECONDS = 1_800_000_000
const NOW_MS = NOW_SECONDS * 1_000
const MERCHANT_SECRET = new Uint8Array(32).fill(1)
const SHOPPER_SECRET = new Uint8Array(32).fill(2)
const MUTUAL_SECRET = new Uint8Array(32).fill(3)
const CURRENT_FOLLOWER_SECRET = new Uint8Array(32).fill(4)
const STALE_FOLLOWER_SECRET = new Uint8Array(32).fill(5)
const OUTSIDER_SECRET = new Uint8Array(32).fill(6)
const PROVIDER_SECRET = new Uint8Array(32).fill(7)
const SECOND_PROVIDER_SECRET = new Uint8Array(32).fill(8)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const SHOPPER_PUBKEY = getPublicKey(SHOPPER_SECRET)
const MUTUAL_PUBKEY = getPublicKey(MUTUAL_SECRET)
const CURRENT_FOLLOWER_PUBKEY = getPublicKey(CURRENT_FOLLOWER_SECRET)

function signedEvent(
  secretKey: Uint8Array,
  input: {
    kind: number
    createdAt: number
    tags?: string[][]
    content?: string
  }
): Event {
  return finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt,
      tags: input.tags ?? [],
      content: input.content ?? "",
    },
    secretKey
  )
}

function zapReceipt({
  senderSecret,
  recipientPubkey,
  createdAt,
  invoiceDescription,
  providerSecret = PROVIDER_SECRET,
  requestRelayUrls = ["wss://relay.example"],
  receiptReferenceTags = [],
}: {
  senderSecret: Uint8Array
  recipientPubkey: string
  createdAt: number
  invoiceDescription?: string
  providerSecret?: Uint8Array
  requestRelayUrls?: string[] | null
  receiptReferenceTags?: string[][]
}): Event {
  const request = signedEvent(senderSecret, {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt,
    tags: [
      ["p", recipientPubkey],
      ["amount", "21000"],
      ...(requestRelayUrls ? [["relays", ...requestRelayUrls]] : []),
    ],
    content: "fixture zap comment that must never be cached",
  })
  const description = JSON.stringify(request)
  const invoice = makeBolt11Fixture({
    hrp: "lnbc210n",
    createdAt,
    fields: [
      bolt11PaymentHashField(),
      bolt11DescriptionHashField(invoiceDescription ?? description),
    ],
  })

  return signedEvent(providerSecret, {
    kind: EVENT_KINDS.ZAP_RECEIPT,
    createdAt: createdAt + 2,
    tags: [
      ["p", recipientPubkey],
      ["P", request.pubkey],
      ["bolt11", invoice],
      ["description", description],
      ...receiptReferenceTags,
    ],
  })
}

function successfulRead(events: Event[] = []) {
  return {
    events: events as never[],
    relays: [
      {
        relayUrl: "wss://relay.example",
        status: "success" as const,
        eventCount: events.length,
      },
    ],
  }
}

function relayList(
  pubkey: string,
  {
    readRelayUrls = [],
    writeRelayUrls = [],
  }: {
    readRelayUrls?: string[]
    writeRelayUrls?: string[]
  }
) {
  return {
    pubkey,
    readRelayUrls,
    writeRelayUrls,
    eventCreatedAt: NOW_SECONDS - 1,
    cachedAt: NOW_MS,
  }
}

function filterHasKind(filter: NDKFilter, kind: number): boolean {
  return filter.kinds?.includes(kind) ?? false
}

function createCache(
  rows: CachedShopperTrustSnapshot[] = []
): ShopperTrustEvidenceCache & {
  rows: Map<string, CachedShopperTrustSnapshot>
} {
  const stored = new Map(rows.map((row) => [row.id, row]))
  return {
    rows: stored,
    get: async (id) => stored.get(id),
    put: async (row) => {
      stored.set(row.id, structuredClone(row))
    },
  }
}

describe("shopper trust evidence", () => {
  it("registers the combined post-v9 cache and deletion stores", () => {
    expect(db.verno).toBe(10)
    expect(db.tables.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["shopperTrustSnapshots", "productDeletionOutbox"])
    )
  })

  it("keeps both divergent version-9 stores in the upgrade history", async () => {
    const source = await Bun.file("packages/core/src/db/index.ts").text()
    const version9 = source.slice(
      source.indexOf("this.version(9).stores"),
      source.indexOf("this.version(10).stores")
    )

    expect(version9).toContain("shopperTrustSnapshots:")
    expect(version9).toContain("productDeletionOutbox:")
  })

  it("bounds persisted shopper trust snapshots by age", () => {
    expect(
      shopperTrustSnapshotIsExpired(
        NOW_MS - SHOPPER_TRUST_SNAPSHOT_RETENTION_MS - 1,
        NOW_MS
      )
    ).toBe(true)
    expect(
      shopperTrustSnapshotIsExpired(
        NOW_MS - SHOPPER_TRUST_SNAPSHOT_RETENTION_MS,
        NOW_MS
      )
    ).toBe(false)
  })

  it("assembles bounded standard signals without producing a score or retaining raw content", async () => {
    const cache = createCache()
    const merchantContacts = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 100,
      tags: [
        ["p", SHOPPER_PUBKEY],
        ["p", MUTUAL_PUBKEY],
      ],
    })
    const shopperContacts = signedEvent(SHOPPER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 90,
      tags: [["p", MUTUAL_PUBKEY]],
    })
    const currentFollowerCandidate = signedEvent(CURRENT_FOLLOWER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 80,
      tags: [["p", SHOPPER_PUBKEY]],
    })
    const staleFollowerCandidate = signedEvent(STALE_FOLLOWER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 80,
      tags: [["p", SHOPPER_PUBKEY]],
    })
    const staleFollowerLatest = signedEvent(STALE_FOLLOWER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 70,
      tags: [],
    })
    const earliestActivity = signedEvent(SHOPPER_SECRET, {
      kind: 1,
      createdAt: NOW_SECONDS - 365 * 24 * 60 * 60,
      content: "public activity content must not be cached",
    })
    const newerActivity = signedEvent(SHOPPER_SECRET, {
      kind: 1,
      createdAt: NOW_SECONDS - 60,
    })
    const receivedZap = zapReceipt({
      senderSecret: CURRENT_FOLLOWER_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 50,
    })
    const duplicateReceivedZap = zapReceipt({
      senderSecret: CURRENT_FOLLOWER_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 50,
      providerSecret: SECOND_PROVIDER_SECRET,
    })
    const sentZap = zapReceipt({
      senderSecret: SHOPPER_SECRET,
      recipientPubkey: MERCHANT_PUBKEY,
      createdAt: NOW_SECONDS - 40,
    })
    const merchantReport = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.REPORT,
      createdAt: NOW_SECONDS - 30,
      tags: [["p", SHOPPER_PUBKEY, "spam"]],
      content: "private-sounding report allegation must never be cached",
    })
    const mutualReport = signedEvent(MUTUAL_SECRET, {
      kind: EVENT_KINDS.REPORT,
      createdAt: NOW_SECONDS - 20,
      tags: [["p", SHOPPER_PUBKEY, "impersonation"]],
    })
    const outsiderReport = signedEvent(OUTSIDER_SECRET, {
      kind: EVENT_KINDS.REPORT,
      createdAt: NOW_SECONDS - 10,
      tags: [["p", SHOPPER_PUBKEY, "illegal"]],
    })
    const malformedProfileReport = signedEvent(MUTUAL_SECRET, {
      kind: EVENT_KINDS.REPORT,
      createdAt: NOW_SECONDS - 5,
      tags: [["p", SHOPPER_PUBKEY]],
    })
    const seenFilters: NDKFilter[] = []

    const fetchEvents: ShopperTrustFetchEvents = async (filter) => {
      seenFilters.push(filter)

      if (
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter.authors?.includes(MERCHANT_PUBKEY) &&
        filter.authors?.includes(SHOPPER_PUBKEY)
      ) {
        return successfulRead([merchantContacts, shopperContacts])
      }
      if (
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter["#p"]?.includes(SHOPPER_PUBKEY)
      ) {
        return successfulRead([
          currentFollowerCandidate,
          staleFollowerCandidate,
        ])
      }
      if (
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter.authors?.includes(CURRENT_FOLLOWER_PUBKEY)
      ) {
        return successfulRead([
          currentFollowerCandidate,
          staleFollowerCandidate,
          staleFollowerLatest,
        ])
      }
      if (
        filter.authors?.includes(SHOPPER_PUBKEY) &&
        filterHasKind(filter, 1)
      ) {
        return successfulRead([newerActivity, earliestActivity])
      }
      if (
        filterHasKind(filter, EVENT_KINDS.ZAP_RECEIPT) &&
        filter["#p"]?.includes(SHOPPER_PUBKEY)
      ) {
        return successfulRead([receivedZap, duplicateReceivedZap])
      }
      if (
        filterHasKind(filter, EVENT_KINDS.ZAP_RECEIPT) &&
        filter["#P"]?.includes(SHOPPER_PUBKEY)
      ) {
        return successfulRead([sentZap])
      }
      if (filterHasKind(filter, EVENT_KINDS.REPORT)) {
        return successfulRead([
          merchantReport,
          mutualReport,
          outsiderReport,
          malformedProfileReport,
        ])
      }

      return successfulRead()
    }

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents,
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.oldestEvent.value).toEqual({
      timestamp: earliestActivity.created_at,
    })
    expect(evidence.followersObserved.value).toEqual({ count: 1 })
    expect(evidence.followsInCommon.value).toEqual({ count: 1 })
    expect(evidence.zapsReceived.value).toEqual({ count: 1 })
    expect(evidence.zapsSent.value).toEqual({ count: 1 })
    expect(evidence.zapsReceived.state).toBe("partial")
    expect(evidence.zapsSent.state).toBe("partial")
    expect(evidence.reportsFromNetwork.value).toEqual({
      count: 2,
      reporterCount: 2,
      byType: { impersonation: 1, spam: 1 },
    })
    expect(
      seenFilters.some(
        (filter) =>
          filterHasKind(filter, EVENT_KINDS.REPORT) &&
          filter["#p"]?.includes(SHOPPER_PUBKEY) &&
          filter.authors === undefined
      )
    ).toBe(true)

    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain("report allegation")
    expect(serialized).not.toContain("fixture zap comment")
    expect(serialized).not.toContain("public activity content")
    expect(serialized.toLowerCase()).not.toContain("score")
    expect(serialized.toLowerCase()).not.toContain("trusted")

    const serializedCache = JSON.stringify([...cache.rows.values()])
    expect(serializedCache).not.toContain("report allegation")
    expect(serializedCache).not.toContain("fixture zap comment")
    expect(serializedCache).not.toContain("public activity content")
    expect(serializedCache).not.toContain("impersonation")
    expect(serializedCache).not.toContain("spam")
  })

  it("emits stale cached evidence first and preserves it when relay refreshes fail", async () => {
    const cache = createCache()
    const initial = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )
    expect(initial.followersObserved.value).toEqual({ count: 0 })

    const progress: string[] = []
    let fetchCount = 0
    const failedRead: ShopperTrustFetchEvents = async () => {
      fetchCount += 1
      return {
        events: [],
        relays: [
          {
            relayUrl: "wss://relay.example",
            status: "failed",
            eventCount: 0,
          },
        ],
      }
    }
    const refreshed = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: failedRead,
        now: () => NOW_MS + SHOPPER_TRUST_CACHE_FRESH_MS + 1,
        onProgress: (snapshot) => {
          progress.push(
            `${snapshot.source}:${snapshot.followersObserved.state}`
          )
        },
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(progress[0]).toBe("cache:stale")
    expect(fetchCount).toBeGreaterThan(0)
    expect(refreshed.followersObserved.state).toBe("stale")
    expect(refreshed.followersObserved.value).toEqual({ count: 0 })
    expect(refreshed.followersObserved.source).toBe("cache")
  })

  it("keeps the oldest observed activity across a narrower partial refresh", async () => {
    const cache = createCache()
    const olderActivity = signedEvent(SHOPPER_SECRET, {
      kind: 1,
      createdAt: NOW_SECONDS - 100_000,
    })
    const newerActivity = signedEvent(SHOPPER_SECRET, {
      kind: 1,
      createdAt: NOW_SECONDS - 1_000,
    })
    const activityRead =
      (event: Event): ShopperTrustFetchEvents =>
      async (filter) =>
        filter.authors?.includes(SHOPPER_PUBKEY) && filterHasKind(filter, 1)
          ? successfulRead([event])
          : successfulRead()

    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: activityRead(olderActivity),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    const partialRead: ShopperTrustFetchEvents = async (filter) => {
      const events =
        filter.authors?.includes(SHOPPER_PUBKEY) && filterHasKind(filter, 1)
          ? [newerActivity]
          : []
      return {
        events: events as never[],
        relays: [
          {
            relayUrl: "wss://one.example",
            status: "success",
            eventCount: events.length,
          },
          {
            relayUrl: "wss://two.example",
            status: "failed",
            eventCount: 0,
          },
        ],
      }
    }
    const refreshed = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: partialRead,
        now: () => NOW_MS + SHOPPER_TRUST_CACHE_FRESH_MS + 1,
        relayUrls: ["wss://one.example", "wss://two.example"],
      }
    )

    expect(refreshed.oldestEvent.value).toEqual({
      timestamp: olderActivity.created_at,
    })
    expect(refreshed.oldestEvent.state).toBe("partial")
    expect(refreshed.oldestEvent.source).toBe("cache")
  })

  it("retains stronger cached counts when a bounded refresh returns fewer observations", async () => {
    const completeCoverage = {
      attemptedRelays: 2,
      responsiveRelays: 2,
      transportComplete: true,
      completeForPlan: true,
      truncated: false,
    }
    const cache = createCache([
      {
        id: `v2:${MERCHANT_PUBKEY}:${SHOPPER_PUBKEY}`,
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
        oldestEvent: {
          state: "available",
          value: { timestamp: null },
          coverage: completeCoverage,
        },
        followersObserved: {
          state: "available",
          value: { count: 8 },
          coverage: completeCoverage,
        },
        followsInCommon: {
          state: "available",
          value: { count: 4 },
          coverage: completeCoverage,
        },
        zapsSent: {
          state: "partial",
          value: { count: 3 },
          coverage: completeCoverage,
        },
        zapsReceived: {
          state: "partial",
          value: { count: 5 },
          coverage: completeCoverage,
        },
        reportsFromNetwork: {
          state: "available",
          value: { count: 2, reporterCount: 2 },
          coverage: completeCoverage,
        },
        degraded: true,
        cachedAt: NOW_MS,
      },
    ])
    const boundedEmptyRead: ShopperTrustFetchEvents = async () => ({
      events: [],
      relays: [
        {
          relayUrl: "wss://one.example",
          status: "success",
          eventCount: 0,
        },
        {
          relayUrl: "wss://two.example",
          status: "success",
          eventCount: 0,
        },
      ],
    })

    const refreshed = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: boundedEmptyRead,
        now: () => NOW_MS + SHOPPER_TRUST_CACHE_FRESH_MS + 1,
        relayUrls: ["wss://one.example", "wss://two.example"],
      }
    )

    expect(refreshed.followersObserved.value).toEqual({ count: 8 })
    expect(refreshed.followsInCommon.value).toEqual({ count: 4 })
    expect(refreshed.zapsSent.value).toEqual({ count: 3 })
    expect(refreshed.zapsReceived.value).toEqual({ count: 5 })
    expect(refreshed.reportsFromNetwork.value).toEqual({
      count: 2,
      reporterCount: 2,
      byType: {},
    })
    for (const signal of [
      refreshed.followersObserved,
      refreshed.followsInCommon,
      refreshed.zapsSent,
      refreshed.zapsReceived,
      refreshed.reportsFromNetwork,
    ]) {
      expect(signal.state).toBe("stale")
      expect(signal.source).toBe("cache")
    }
  })

  it("distinguishes a completed zero observation from partial and unavailable reads", async () => {
    const partialRead: ShopperTrustFetchEvents = async () => ({
      events: [],
      relays: [
        {
          relayUrl: "wss://one.example",
          status: "success",
          eventCount: 0,
        },
        {
          relayUrl: "wss://two.example",
          status: "failed",
          eventCount: 0,
        },
      ],
    })
    const partial = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: partialRead,
        now: () => NOW_MS,
        relayUrls: ["wss://one.example", "wss://two.example"],
      }
    )

    expect(partial.followersObserved.state).toBe("partial")
    expect(partial.followersObserved.value).toEqual({ count: 0 })

    const unavailable = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async () => ({
          events: [],
          relays: [
            {
              relayUrl: "wss://relay.example",
              status: "failed",
              eventCount: 0,
            },
          ],
        }),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(unavailable.followersObserved.state).toBe("unavailable")
    expect(unavailable.followersObserved.value).toBeNull()
  })

  it("keeps the explicit relay plan intact and marks omitted relay results partial", async () => {
    const skipHealthFilterValues: Array<boolean | undefined> = []
    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (_filter, options) => {
          skipHealthFilterValues.push(options?.skipHealthFilter)
          return {
            events: [],
            relays: [
              {
                relayUrl: "wss://one.example",
                status: "success",
                eventCount: 0,
              },
            ],
          }
        },
        now: () => NOW_MS,
        relayUrls: ["wss://one.example", "wss://two.example"],
      }
    )

    expect(skipHealthFilterValues.length).toBeGreaterThan(0)
    expect(skipHealthFilterValues.every((value) => value === true)).toBe(true)
    expect(evidence.followersObserved.state).toBe("partial")
    expect(evidence.followersObserved.coverage).toMatchObject({
      attemptedRelays: 2,
      responsiveRelays: 1,
      transportComplete: false,
      completeForPlan: false,
    })
  })

  it("uses the lower event id to break equal-timestamp replaceable-event ties", async () => {
    const withMutual = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 10,
      tags: [["p", MUTUAL_PUBKEY]],
    })
    const withoutMutual = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 10,
      tags: [],
      content: "tie breaker",
    })
    const winningMerchantEvent =
      withMutual.id.localeCompare(withoutMutual.id) < 0
        ? withMutual
        : withoutMutual
    const shopperContacts = signedEvent(SHOPPER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 9,
      tags: [["p", MUTUAL_PUBKEY]],
    })

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) =>
          filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
          filter.authors?.includes(MERCHANT_PUBKEY) &&
          filter.authors?.includes(SHOPPER_PUBKEY)
            ? successfulRead([withMutual, withoutMutual, shopperContacts])
            : successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.followsInCommon.value).toEqual({
      count: winningMerchantEvent.id === withMutual.id ? 1 : 0,
    })
  })

  it("ignores far-future follow lists and qualifies capped reads as partial", async () => {
    const currentMerchantContacts = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 10,
      tags: [["p", MUTUAL_PUBKEY]],
    })
    const futureMerchantContacts = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS + 10 * 60,
      tags: [],
    })
    const shopperContacts = signedEvent(SHOPPER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 9,
      tags: [["p", MUTUAL_PUBKEY]],
    })
    const historicalContacts = Array.from({ length: 7 }, (_, index) =>
      signedEvent(MERCHANT_SECRET, {
        kind: EVENT_KINDS.CONTACT_LIST,
        createdAt: NOW_SECONDS - 100 - index,
        tags: [],
        content: `history-${index}`,
      })
    )
    const activity = Array.from({ length: 500 }, (_, index) =>
      signedEvent(SHOPPER_SECRET, {
        kind: 1,
        createdAt: NOW_SECONDS - 1_000 - index,
        content: `activity-${index}`,
      })
    )

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) => {
          if (
            filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
            filter.authors?.includes(MERCHANT_PUBKEY) &&
            filter.authors?.includes(SHOPPER_PUBKEY)
          ) {
            return successfulRead([
              currentMerchantContacts,
              futureMerchantContacts,
              shopperContacts,
              ...historicalContacts,
            ])
          }
          if (
            filter.authors?.includes(SHOPPER_PUBKEY) &&
            filterHasKind(filter, 1)
          ) {
            return successfulRead(activity)
          }
          return successfulRead()
        },
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.followsInCommon.value).toEqual({ count: 1 })
    expect(evidence.followsInCommon.state).toBe("partial")
    expect(evidence.oldestEvent.state).toBe("partial")
  }, 15_000)

  it("excludes reports withdrawn by the same reporter", async () => {
    const merchantContacts = signedEvent(MERCHANT_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 20,
      tags: [["p", MUTUAL_PUBKEY]],
    })
    const report = signedEvent(MUTUAL_SECRET, {
      kind: EVENT_KINDS.REPORT,
      createdAt: NOW_SECONDS - 10,
      tags: [["p", SHOPPER_PUBKEY, "spam"]],
    })
    const deletion = signedEvent(MUTUAL_SECRET, {
      kind: EVENT_KINDS.DELETION,
      createdAt: NOW_SECONDS - 5,
      tags: [["e", report.id]],
    })

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) => {
          if (
            filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
            filter.authors?.includes(MERCHANT_PUBKEY)
          ) {
            return successfulRead([merchantContacts])
          }
          if (filterHasKind(filter, EVENT_KINDS.REPORT)) {
            return successfulRead([report])
          }
          if (filterHasKind(filter, EVENT_KINDS.DELETION)) {
            return successfulRead([deletion])
          }
          return successfulRead()
        },
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.reportsFromNetwork.value).toEqual({
      count: 0,
      reporterCount: 0,
      byType: {},
    })
  })

  it("keeps shopper, merchant, and public relays in the bounded initial plan", async () => {
    const publicRelay = "wss://public-fallback.example"
    const merchantWriteRelays = [
      "wss://merchant-one.example",
      "wss://merchant-two.example",
      "wss://merchant-three.example",
      "wss://merchant-four.example",
    ]
    const shopperWriteRelays = [
      "wss://shopper-write-one.example",
      "wss://shopper-write-two.example",
    ]
    const shopperReadRelays = [
      "wss://shopper-read-one.example",
      "wss://shopper-read-two.example",
    ]
    const initialRelayAllowlist: Array<string | null | undefined> = []
    const resolveRelayLists: ShopperTrustResolveRelayLists = async (
      pubkeys,
      options
    ) => {
      if (
        pubkeys.includes(MERCHANT_PUBKEY) &&
        pubkeys.includes(SHOPPER_PUBKEY)
      ) {
        initialRelayAllowlist.push(options?.allowInsecureRelayUrlsForPubkey)
      }
      return new Map(
        pubkeys.flatMap((pubkey) => {
          if (pubkey === MERCHANT_PUBKEY) {
            return [
              [
                pubkey,
                relayList(pubkey, {
                  writeRelayUrls: merchantWriteRelays,
                }),
              ] as const,
            ]
          }
          if (pubkey === SHOPPER_PUBKEY) {
            return [
              [
                pubkey,
                relayList(pubkey, {
                  readRelayUrls: shopperReadRelays,
                  writeRelayUrls: shopperWriteRelays,
                }),
              ] as const,
            ]
          }
          return []
        })
      )
    }
    const reads: Array<{
      filter: NDKFilter
      relayUrls: string[]
    }> = []
    const fetchEvents: ShopperTrustFetchEvents = async (filter, options) => {
      const relayUrls = options?.relayUrls ?? []
      reads.push({ filter, relayUrls })
      return {
        events: [],
        relays: relayUrls.map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
      }
    }

    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents,
        now: () => NOW_MS,
        resolveRelayLists,
        baseRelayUrls: [publicRelay],
      }
    )

    const contactsRead = reads.find(
      ({ filter }) =>
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter.authors?.includes(MERCHANT_PUBKEY) &&
        filter.authors?.includes(SHOPPER_PUBKEY)
    )
    expect(contactsRead?.relayUrls.slice(0, 3)).toEqual([
      shopperWriteRelays[0],
      shopperReadRelays[0],
      merchantWriteRelays[0],
    ])
    expect(contactsRead?.relayUrls).toHaveLength(6)
    expect(contactsRead?.relayUrls).toContain(publicRelay)
    expect(contactsRead?.relayUrls).not.toContain(merchantWriteRelays[3])
    expect(initialRelayAllowlist).toEqual([MERCHANT_PUBKEY])
  })

  it("marks observations partial when NIP-65 routing falls back to stale hints", async () => {
    const staleRelay = "wss://stale-hint.example"
    const resolveRelayLists: ShopperTrustResolveRelayLists = async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            ...relayList(pubkey, { writeRelayUrls: [staleRelay] }),
            lookupState: "stale-cache" as const,
          },
        ])
      )

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        baseRelayUrls: ["wss://public.example"],
        cache: createCache(),
        fetchEvents: async (_filter, options) => ({
          events: [],
          relays: (options?.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
        }),
        now: () => NOW_MS,
        resolveRelayLists,
      }
    )

    expect(evidence.oldestEvent.state).toBe("partial")
    expect(evidence.followersObserved.state).toBe("partial")
    expect(evidence.followsInCommon.state).toBe("partial")
    expect(evidence.oldestEvent.coverage.truncated).toBe(true)
  })

  it("checks a reverse-follow candidate on the candidate author outbox", async () => {
    const candidateWriteRelay = "wss://candidate-write.example"
    const candidateFollow = signedEvent(CURRENT_FOLLOWER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 20,
      tags: [["p", SHOPPER_PUBKEY]],
    })
    const candidateUnfollow = signedEvent(CURRENT_FOLLOWER_SECRET, {
      kind: EVENT_KINDS.CONTACT_LIST,
      createdAt: NOW_SECONDS - 10,
      tags: [],
    })
    const resolveRelayLists: ShopperTrustResolveRelayLists = async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          relayList(pubkey, {
            writeRelayUrls:
              pubkey === CURRENT_FOLLOWER_PUBKEY
                ? [candidateWriteRelay]
                : [`wss://${pubkey.slice(0, 8)}.example`],
          }),
        ])
      )
    let confirmationRelayUrls: string[] = []
    const fetchEvents: ShopperTrustFetchEvents = async (filter, options) => {
      const relayUrls = options?.relayUrls ?? []
      let events: Event[] = []
      if (
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter["#p"]?.includes(SHOPPER_PUBKEY)
      ) {
        events = [candidateFollow]
      } else if (
        filterHasKind(filter, EVENT_KINDS.CONTACT_LIST) &&
        filter.authors?.includes(CURRENT_FOLLOWER_PUBKEY)
      ) {
        confirmationRelayUrls = relayUrls
        events = relayUrls.includes(candidateWriteRelay)
          ? [candidateFollow, candidateUnfollow]
          : [candidateFollow]
      }
      return {
        events: events as never[],
        relays: relayUrls.map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: events.length,
        })),
      }
    }

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents,
        now: () => NOW_MS,
        resolveRelayLists,
      }
    )

    expect(confirmationRelayUrls).toContain(candidateWriteRelay)
    expect(evidence.followersObserved.value).toEqual({ count: 0 })
  })

  it("retries partial observations on the short cache window", async () => {
    const cache = createCache()
    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    let fetchCount = 0
    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => {
          fetchCount += 1
          return successfulRead()
        },
        now: () => NOW_MS + SHOPPER_TRUST_DEGRADED_CACHE_RETRY_MS + 1,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(fetchCount).toBeGreaterThan(0)
    expect(evidence.degraded).toBe(true)
  })

  it("forces an explicit refresh even while a cached snapshot is fresh", async () => {
    const cache = createCache()
    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    let fetchCount = 0
    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => {
          fetchCount += 1
          return successfulRead()
        },
        forceRefresh: true,
        now: () => NOW_MS + 1,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(fetchCount).toBeGreaterThan(0)
  })

  it("retries transport-degraded cache rows after the short retry window", async () => {
    const cache = createCache()
    const partialRead: ShopperTrustFetchEvents = async () => ({
      events: [],
      relays: [
        {
          relayUrl: "wss://one.example",
          status: "success",
          eventCount: 0,
        },
        {
          relayUrl: "wss://two.example",
          status: "failed",
          eventCount: 0,
        },
      ],
    })
    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: partialRead,
        now: () => NOW_MS,
        relayUrls: ["wss://one.example", "wss://two.example"],
      }
    )

    let fetchCount = 0
    await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents: async () => {
          fetchCount += 1
          return successfulRead()
        },
        now: () => NOW_MS + SHOPPER_TRUST_DEGRADED_CACHE_RETRY_MS + 1,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(fetchCount).toBeGreaterThan(0)
  })

  it("cancels obsolete evidence reads without writing cache or progress", async () => {
    const cache = createCache()
    const controller = new AbortController()
    let fetchCount = 0
    let progressCount = 0
    let markInitialReadsStarted: (() => void) | undefined
    const initialReadsStarted = new Promise<void>((resolve) => {
      markInitialReadsStarted = resolve
    })
    const fetchEvents: ShopperTrustFetchEvents = async (_filter, options) => {
      expect(options?.signal).toBe(controller.signal)
      fetchCount += 1
      if (fetchCount === 5) markInitialReadsStarted?.()

      return await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("The operation was aborted.")
          error.name = "AbortError"
          reject(error)
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true })
      })
    }

    const read = getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache,
        fetchEvents,
        now: () => NOW_MS,
        onProgress: () => {
          progressCount += 1
        },
        relayUrls: ["wss://relay.example"],
        signal: controller.signal,
      }
    )

    await initialReadsStarted
    controller.abort()

    await expect(read).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchCount).toBe(5)
    expect(progressCount).toBe(0)
    expect(cache.rows.size).toBe(0)
  })

  it("rejects malformed zap receipt bindings instead of counting them", async () => {
    const valid = zapReceipt({
      senderSecret: MUTUAL_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 20,
    })
    const malformed = zapReceipt({
      senderSecret: MUTUAL_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 10,
      invoiceDescription: "{}",
    })
    const missingRelayTag = zapReceipt({
      senderSecret: MUTUAL_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 5,
      requestRelayUrls: null,
    })
    const duplicateEventReference = zapReceipt({
      senderSecret: MUTUAL_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 4,
      receiptReferenceTags: [
        ["e", "0".repeat(64)],
        ["e", "1".repeat(64)],
      ],
    })
    const malformedCoordinate = zapReceipt({
      senderSecret: MUTUAL_SECRET,
      recipientPubkey: SHOPPER_PUBKEY,
      createdAt: NOW_SECONDS - 3,
      receiptReferenceTags: [["a", "not-an-event-coordinate"]],
    })

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) =>
          filterHasKind(filter, EVENT_KINDS.ZAP_RECEIPT) &&
          filter["#p"]?.includes(SHOPPER_PUBKEY)
            ? successfulRead([
                valid,
                malformed,
                missingRelayTag,
                duplicateEventReference,
                malformedCoordinate,
              ])
            : successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.zapsReceived.value).toEqual({ count: 1 })
    expect(evidence.zapsReceived.state).toBe("partial")
  })

  it("rejects forged events returned by an injectable fetch seam", async () => {
    const signedActivity = signedEvent(SHOPPER_SECRET, {
      kind: 1,
      createdAt: NOW_SECONDS - 20,
      content: "signed content",
    })
    const forgedActivity = {
      ...signedActivity,
      content: "mutated after signing",
    }

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) =>
          filter.authors?.includes(SHOPPER_PUBKEY) && filterHasKind(filter, 1)
            ? {
                ...successfulRead([forgedActivity]),
                eventsVerified: true,
              }
            : successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.oldestEvent.value).toEqual({ timestamp: null })
  })

  it("caps embedded zap-request verification and reports truncation", async () => {
    const receipts = Array.from({ length: 129 }, (_, index) =>
      zapReceipt({
        senderSecret: CURRENT_FOLLOWER_SECRET,
        recipientPubkey: SHOPPER_PUBKEY,
        createdAt: NOW_SECONDS - 1_000 - index,
      })
    )

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) =>
          filterHasKind(filter, EVENT_KINDS.ZAP_RECEIPT) &&
          filter["#p"]?.includes(SHOPPER_PUBKEY)
            ? successfulRead(receipts)
            : successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.zapsReceived.value).toEqual({ count: 128 })
    expect(evidence.zapsReceived.coverage.truncated).toBe(true)
    expect(evidence.zapsReceived.state).toBe("partial")
  }, 20_000)

  it("skips oversized embedded zap payloads and reports truncation", async () => {
    const oversizedReceipt = signedEvent(PROVIDER_SECRET, {
      kind: EVENT_KINDS.ZAP_RECEIPT,
      createdAt: NOW_SECONDS - 10,
      tags: [
        ["p", SHOPPER_PUBKEY],
        ["bolt11", "lnbc1oversizedfixture"],
        ["description", "x".repeat(64 * 1024 + 1)],
      ],
    })

    const evidence = await getShopperTrustEvidence(
      {
        merchantPubkey: MERCHANT_PUBKEY,
        shopperPubkey: SHOPPER_PUBKEY,
      },
      {
        cache: createCache(),
        fetchEvents: async (filter) =>
          filterHasKind(filter, EVENT_KINDS.ZAP_RECEIPT) &&
          filter["#p"]?.includes(SHOPPER_PUBKEY)
            ? successfulRead([oversizedReceipt])
            : successfulRead(),
        now: () => NOW_MS,
        relayUrls: ["wss://relay.example"],
      }
    )

    expect(evidence.zapsReceived.value).toEqual({ count: 0 })
    expect(evidence.zapsReceived.coverage.truncated).toBe(true)
    expect(evidence.zapsReceived.state).toBe("partial")
  })
})
